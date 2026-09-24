(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var result = factory();
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.speechFollower = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // 给"演讲提词"模块用的持续语音监听封装——跟课堂笔记的 speechRecorder.js 是近亲
  // （都是包一层浏览器自带的 SpeechRecognition），但这里不需要 MediaRecorder/
  // getUserMedia 那一套（不需要保存音频，演讲提词只关心"刚才说的话大概是什么"，
  // 用完即丢），所以单独做一个更轻的封装，也不会牵动课堂笔记那边已经跑通的测试。
  //
  // 专门为这个场景加了几层容错（对应产品设计里"应对录音断断续续"那一节）：
  // 1. 识别引擎中途自己断开（Web Speech API 的已知毛病）就立刻自动重启，这点跟
  //    speechRecorder.js 一样；但这里额外做到"重启不清空最近识别到的内容"——
  //    getRecentText() 返回的是过去一小段时间（默认20秒）内所有识别结果拼起来的
  //    缓冲区，不会因为一次重启就把之前的内容全部丢掉、匹配算法失去上下文。
  // 2. 区分"没听到声音"（no-speech，很常见，比如演讲中间停顿几秒，交给自动重启
  //    处理就行）和"真故障"（没有麦克风权限/设备被占用，重试也没用）——真故障会
  //    立刻回调 onFatalError，调用方（speechPrompter.js）应该借此切到手动模式，
  //    而不是让它在那儿反复无效重试。
  // 3. 连续短时间内出很多次其它类型的错误（比如网络问题）也会触发同样的"放弃自动
  //    重启、切手动"，避免耗电空转。
  // 4. 长时间完全没有任何识别结果（真的安静太久，可能是没话讲，也可能是麦克风
  //    出了问题）会回调一次 onSilenceTimeout，调用方可以借此提示用户"已经切换到
  //    手动模式"——但这里本身不强制停止监听，是否真的切换由调用方决定。

  function getGlobalSpeechRecognitionCtor() {
    if (typeof window === "undefined") return null;
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function followerError(message, kind) {
    const err = new Error(message);
    err.kind = kind; // "unsupported" | "permission" | "fatal"
    return err;
  }

  /**
   * options:
   *   lang: 识别语言（BCP-47），默认 "zh-CN"
   *   silenceTimeoutMs: 连续多久完全没有识别到语音就触发 onSilenceTimeout，默认 8000
   *   maxRestartFailures / restartFailureWindowMs: 这段时间窗口内连续出错达到这个次数
   *     就放弃自动重启，默认 10 秒内 5 次
   *   bufferWindowMs: getRecentText() 保留最近多久的识别结果，默认 20000
   *   onTranscriptUpdate(recentText, {latest, isFinal}): 每次识别到新内容就回调一次，
   *     recentText 是累积缓冲区拼起来的文字（跨重启也不会清空）
   *   onStatusChange(status): "listening" | "reconnecting" | "stopped" | "error"
   *   onSilenceTimeout(): 长时间没识别到任何声音
   *   onFatalError(err): 权限/设备问题或连续出错太多次，这两种都意味着"不会再自动重试了"
   *   SpeechRecognitionImpl: 测试注入点，不传就用浏览器全局的真实实现
   *   now / setTimeoutImpl / clearTimeoutImpl: 测试注入点，用来控制时间相关的逻辑
   */
  function createSpeechFollower(options = {}) {
    const {
      lang = "zh-CN",
      silenceTimeoutMs = 8000,
      maxRestartFailures = 5,
      restartFailureWindowMs = 10000,
      bufferWindowMs = 20000,
      onTranscriptUpdate = () => {},
      onStatusChange = () => {},
      onSilenceTimeout = () => {},
      onFatalError = () => {},
      SpeechRecognitionImpl = getGlobalSpeechRecognitionCtor(),
      now = () => Date.now(),
      setTimeoutImpl = (fn, ms) => setTimeout(fn, ms),
      clearTimeoutImpl = (id) => clearTimeout(id),
    } = options;

    let recognition = null;
    let running = false;
    let bufferSegments = []; // [{text, ts}]，最近一段时间识别到的最终结果，跨重启不清空
    let silenceTimer = null;
    let restartFailTimestamps = [];

    function isSupported() {
      return Boolean(SpeechRecognitionImpl);
    }

    function clearSilenceTimer() {
      if (silenceTimer !== null) {
        clearTimeoutImpl(silenceTimer);
        silenceTimer = null;
      }
    }

    function resetSilenceTimer() {
      clearSilenceTimer();
      silenceTimer = setTimeoutImpl(() => {
        silenceTimer = null;
        onSilenceTimeout();
      }, silenceTimeoutMs);
    }

    function pushBuffer(text) {
      const ts = now();
      bufferSegments.push({ text, ts });
      bufferSegments = bufferSegments.filter((s) => ts - s.ts < bufferWindowMs);
    }

    function getRecentText() {
      return bufferSegments.map((s) => s.text).join(" ");
    }

    function clearBuffer() {
      bufferSegments = [];
    }

    /** 记一次"非 no-speech"的错误；短时间内攒够次数就彻底放弃、回调 onFatalError。
     * 返回 true 表示已经触发了放弃（调用方不需要再做别的事）。 */
    function registerRestartFailure() {
      const ts = now();
      restartFailTimestamps.push(ts);
      restartFailTimestamps = restartFailTimestamps.filter((t) => ts - t < restartFailureWindowMs);
      if (restartFailTimestamps.length >= maxRestartFailures) {
        running = false;
        clearSilenceTimer();
        onStatusChange("error");
        onFatalError(followerError("语音识别连续多次出错，已经切换为手动模式，请检查麦克风", "fatal"));
        return true;
      }
      return false;
    }

    function attachHandlers() {
      recognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          const text = result[0] && result[0].transcript ? result[0].transcript.trim() : "";
          if (!text) continue;
          resetSilenceTimer();
          const isFinal = Boolean(result.isFinal);
          if (isFinal) pushBuffer(text);
          onTranscriptUpdate(getRecentText(), { latest: text, isFinal });
        }
      };
      recognition.onerror = (event) => {
        const code = event && event.error;
        if (code === "not-allowed" || code === "service-not-allowed" || code === "audio-capture") {
          running = false;
          clearSilenceTimer();
          onStatusChange("error");
          onFatalError(followerError(
            code === "audio-capture" ? "麦克风不可用，已经切换为手动模式" : "没有获得麦克风权限，已经切换为手动模式",
            "permission"
          ));
          return;
        }
        if (code === "no-speech") return; // 很常见（比如停顿几秒），不算故障，交给 onend 自动重启
        registerRestartFailure();
      };
      recognition.onend = () => {
        if (!running) return;
        onStatusChange("reconnecting");
        try {
          recognition.start();
          onStatusChange("listening");
        } catch {
          registerRestartFailure();
        }
      };
    }

    function start() {
      if (running) return;
      if (!isSupported()) {
        throw followerError("当前浏览器不支持语音识别，建议换用最新版 Chrome 或 Edge", "unsupported");
      }
      running = true;
      restartFailTimestamps = [];
      clearBuffer();
      recognition = new SpeechRecognitionImpl();
      recognition.lang = lang;
      recognition.continuous = true;
      recognition.interimResults = true;
      attachHandlers();
      recognition.start();
      onStatusChange("listening");
      resetSilenceTimer();
    }

    function stop() {
      running = false;
      clearSilenceTimer();
      if (recognition) {
        recognition.onend = null; // 避免停止时触发自动重启逻辑（跟 speechRecorder.js 是同一处理）
        try {
          recognition.stop();
        } catch {
          // 忽略
        }
      }
      onStatusChange("stopped");
    }

    function isRunning() {
      return running;
    }

    return { start, stop, isSupported, isRunning, getRecentText, clearBuffer };
  }

  return { createSpeechFollower, followerError };
});
