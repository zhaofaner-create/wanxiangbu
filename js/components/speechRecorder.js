(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var result = factory();
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.speechRecorder = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // 封装"一边录音一边实时转文字"这件事，给课堂笔记模块用。
  //
  // 转文字用的是浏览器自带的 Web Speech API（SpeechRecognition /
  // webkitSpeechRecognition）——完全免费、不需要密钥、不经过我们自己的任何服务器，
  // 但目前只有 Chrome / Edge 等 Chromium 内核浏览器支持得比较好，Safari / iOS 支持
  // 有限甚至完全不支持，isSupported() 就是用来提前检测、给用户一个明确提示的。
  //
  // 录音本体（用来保存、之后可以回放）用的是浏览器自带的 MediaRecorder，产出一个
  // 音频 Blob，由调用方（classNotes 模块）存进 IndexedDB——这个文件本身不碰存储。
  //
  // 所有浏览器 API（SpeechRecognition 构造函数、getUserMedia、MediaRecorder 构造函数）
  // 都做成可选注入参数，不注入就用全局的真实实现；这样单元测试可以注入假的实现，
  // 不需要真的浏览器环境，跟 aiClient.js 里 fetchImpl 注入是同一个思路。

  const STATES = { IDLE: "idle", RECORDING: "recording", PAUSED: "paused", STOPPED: "stopped", ERROR: "error" };

  /** 统一的错误：message 是给用户看的中文提示，kind 供调用方按类型做不同处理。 */
  function recorderError(message, kind) {
    const err = new Error(message);
    err.kind = kind; // "unsupported" | "permission" | "no_speech" | "recognition" | "state"
    return err;
  }

  function getGlobalSpeechRecognitionCtor() {
    if (typeof window === "undefined") return null;
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function getGlobalMediaRecorderCtor() {
    return typeof MediaRecorder !== "undefined" ? MediaRecorder : null;
  }

  function getGlobalGetUserMedia() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return null;
    return navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  }

  /** 挑一个浏览器支持的录音格式；都不支持时返回空字符串，交给 MediaRecorder 用默认值。 */
  function pickMimeType(MediaRecorderImpl) {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    if (!MediaRecorderImpl || typeof MediaRecorderImpl.isTypeSupported !== "function") return "";
    return candidates.find((type) => MediaRecorderImpl.isTypeSupported(type)) || "";
  }

  /**
   * 创建一个录音+实时转录器。
   *
   * options:
   *   lang: 识别语言（BCP-47，如 "fr-FR"、"zh-CN"），默认 "fr-FR"
   *   onTranscriptSegment({ start, end, text, isFinal }): 每识别出一段就回调一次；
   *     isFinal=false 是"正在说、还可能改"的临时结果，isFinal=true 是确定下来的一段
   *   onStateChange(state): 状态变化时回调（STATES 里的值）
   *   onError(err): 出错时回调（err.kind 见上）
   *   SpeechRecognitionImpl / MediaRecorderImpl / getUserMediaImpl: 测试用的注入点，
   *     不传就用浏览器全局的真实实现
   */
  function createSpeechRecorder(options = {}) {
    const {
      lang = "fr-FR",
      onTranscriptSegment = () => {},
      onStateChange = () => {},
      onError = () => {},
      SpeechRecognitionImpl = getGlobalSpeechRecognitionCtor(),
      MediaRecorderImpl = getGlobalMediaRecorderCtor(),
      getUserMediaImpl = getGlobalGetUserMedia(),
    } = options;

    let state = STATES.IDLE;
    let recognition = null;
    let mediaRecorder = null;
    let mediaStream = null;
    let audioChunks = [];
    let startedAt = 0;
    let pausedAccumMs = 0; // 暂停累计时长，用于给分段算出正确的相对秒数
    let pausedAt = 0;

    function setState(next) {
      state = next;
      onStateChange(state);
    }

    function elapsedSeconds() {
      if (!startedAt) return 0;
      const now = state === STATES.PAUSED ? pausedAt : Date.now();
      return Math.max(0, (now - startedAt - pausedAccumMs) / 1000);
    }

    function isSupported() {
      return Boolean(SpeechRecognitionImpl) && Boolean(MediaRecorderImpl) && Boolean(getUserMediaImpl);
    }

    function attachRecognitionHandlers() {
      recognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          const text = result[0] && result[0].transcript ? result[0].transcript.trim() : "";
          if (!text) continue;
          const end = elapsedSeconds();
          onTranscriptSegment({ start: end, end, text, isFinal: Boolean(result.isFinal) });
        }
      };
      recognition.onerror = (event) => {
        const code = event && event.error;
        if (code === "not-allowed" || code === "service-not-allowed") {
          onError(recorderError("没有获得麦克风权限，请在浏览器设置里允许后重试", "permission"));
        } else if (code === "no-speech") {
          // 一段时间没检测到说话，不算致命错误，静默忽略，识别引擎通常会自动继续
          return;
        } else {
          onError(recorderError(`语音识别出错（${code || "未知错误"}）`, "recognition"));
        }
      };
      recognition.onend = () => {
        // Web Speech API 的识别经常在长时间录音中自己中途结束，只要还在录音状态就自动重启，
        // 避免用户讲着讲着转录就默默停了
        if (state === STATES.RECORDING) {
          try {
            recognition.start();
          } catch {
            // 已经在跑了或者刚被 stop，忽略
          }
        }
      };
    }

    async function start() {
      if (state === STATES.RECORDING) {
        throw recorderError("已经在录音了", "state");
      }
      if (!isSupported()) {
        throw recorderError("当前浏览器不支持录音转文字，建议换用最新版 Chrome 或 Edge", "unsupported");
      }

      try {
        mediaStream = await getUserMediaImpl({ audio: true });
      } catch {
        throw recorderError("没有获得麦克风权限，请在浏览器设置里允许后重试", "permission");
      }

      audioChunks = [];
      const mimeType = pickMimeType(MediaRecorderImpl);
      mediaRecorder = mimeType ? new MediaRecorderImpl(mediaStream, { mimeType }) : new MediaRecorderImpl(mediaStream);
      mediaRecorder.ondataavailable = (event) => {
        if (event && event.data && event.data.size > 0) audioChunks.push(event.data);
      };
      mediaRecorder.start();

      recognition = new SpeechRecognitionImpl();
      recognition.lang = lang;
      recognition.continuous = true;
      recognition.interimResults = true;
      attachRecognitionHandlers();
      recognition.start();

      startedAt = Date.now();
      pausedAccumMs = 0;
      pausedAt = 0;
      setState(STATES.RECORDING);
    }

    function pause() {
      if (state !== STATES.RECORDING) return;
      pausedAt = Date.now();
      if (mediaRecorder && typeof mediaRecorder.pause === "function") mediaRecorder.pause();
      if (recognition) {
        try {
          recognition.stop();
        } catch {
          // 忽略
        }
      }
      setState(STATES.PAUSED);
    }

    function resume() {
      if (state !== STATES.PAUSED) return;
      pausedAccumMs += Date.now() - pausedAt;
      pausedAt = 0;
      if (mediaRecorder && typeof mediaRecorder.resume === "function") mediaRecorder.resume();
      if (recognition) {
        try {
          recognition.start();
        } catch {
          // 忽略
        }
      }
      setState(STATES.RECORDING);
    }

    /** 停止录音，返回 { audioBlob, durationSeconds }；durationSeconds 不含暂停时间。 */
    function stop() {
      if (state !== STATES.RECORDING && state !== STATES.PAUSED) {
        throw recorderError("现在没有在录音", "state");
      }
      const durationSeconds = elapsedSeconds();

      if (recognition) {
        recognition.onend = null; // 避免停止时触发自动重启逻辑
        try {
          recognition.stop();
        } catch {
          // 忽略
        }
      }

      return new Promise((resolve) => {
        const finish = () => {
          if (mediaStream) {
            mediaStream.getTracks().forEach((track) => track.stop());
          }
          const audioBlob = audioChunks.length
            ? new Blob(audioChunks, { type: audioChunks[0].type || "audio/webm" })
            : null;
          audioChunks = [];
          setState(STATES.STOPPED);
          resolve({ audioBlob, durationSeconds });
        };
        if (mediaRecorder && mediaRecorder.state !== "inactive") {
          mediaRecorder.onstop = finish;
          mediaRecorder.stop();
        } else {
          finish();
        }
      });
    }

    function getState() {
      return state;
    }

    return { start, pause, resume, stop, isSupported, getState, elapsedSeconds, STATES };
  }

  return { createSpeechRecorder, recorderError, STATES };
});
