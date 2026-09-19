const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { createSpeechRecorder, STATES } = require("../js/components/speechRecorder.js");

// ---------- 假的浏览器 API，模拟 SpeechRecognition / MediaRecorder / getUserMedia ----------

function makeResult(text, isFinal) {
  const arr = [{ transcript: text }];
  arr.isFinal = isFinal;
  return arr;
}

class FakeStream {
  constructor() {
    this.tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  }
  getTracks() {
    return this.tracks;
  }
}

function makeGetUserMedia({ shouldFail = false } = {}) {
  return async () => {
    if (shouldFail) throw new Error("拒绝了权限");
    return new FakeStream();
  };
}

class FakeMediaRecorder {
  constructor(stream, opts) {
    this.stream = stream;
    this.opts = opts;
    this.state = "recording";
    this.ondataavailable = null;
    this.onstop = null;
    FakeMediaRecorder.instances.push(this);
  }
  start() {}
  pause() {
    this.state = "paused";
  }
  resume() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    if (this.ondataavailable) this.ondataavailable({ data: { size: 5, type: "audio/webm" } });
    if (this.onstop) this.onstop();
  }
}
FakeMediaRecorder.isTypeSupported = (type) => type === "audio/webm;codecs=opus";

class FakeRecognition {
  constructor() {
    this.started = false;
    FakeRecognition.instances.push(this);
  }
  start() {
    this.started = true;
  }
  stop() {
    this.started = false;
  }
}

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  FakeRecognition.instances = [];
});

function makeRecorder(overrides = {}) {
  const events = { states: [], segments: [], errors: [], silence: [] };
  const recorder = createSpeechRecorder({
    lang: "fr-FR",
    SpeechRecognitionImpl: FakeRecognition,
    MediaRecorderImpl: FakeMediaRecorder,
    getUserMediaImpl: makeGetUserMedia(),
    onStateChange: (s) => events.states.push(s),
    onTranscriptSegment: (seg) => events.segments.push(seg),
    onError: (err) => events.errors.push(err),
    onSilence: (streak) => events.silence.push(streak),
    ...overrides,
  });
  return { recorder, events };
}

// ---------- isSupported / 前置检查 ----------

describe("elapsedSeconds", () => {
  test("还没开始录音时是 0", () => {
    const { recorder } = makeRecorder();
    assert.equal(recorder.elapsedSeconds(), 0);
  });

  test("录音中是一个非负数", async () => {
    const { recorder } = makeRecorder();
    await recorder.start();
    assert.ok(recorder.elapsedSeconds() >= 0);
  });
});

describe("isSupported", () => {
  test("三个浏览器能力都具备时返回 true", () => {
    const { recorder } = makeRecorder();
    assert.equal(recorder.isSupported(), true);
  });

  test("缺少语音识别构造函数时返回 false", () => {
    const { recorder } = makeRecorder({ SpeechRecognitionImpl: null });
    assert.equal(recorder.isSupported(), false);
  });

  test("缺少 MediaRecorder 时返回 false", () => {
    const { recorder } = makeRecorder({ MediaRecorderImpl: null });
    assert.equal(recorder.isSupported(), false);
  });

  test("缺少 getUserMedia 时返回 false", () => {
    const { recorder } = makeRecorder({ getUserMediaImpl: null });
    assert.equal(recorder.isSupported(), false);
  });
});

describe("start", () => {
  test("不支持时抛出 unsupported 错误", async () => {
    const { recorder } = makeRecorder({ SpeechRecognitionImpl: null });
    await assert.rejects(() => recorder.start(), (err) => {
      assert.equal(err.kind, "unsupported");
      return true;
    });
  });

  test("拿不到麦克风权限时抛出 permission 错误", async () => {
    const { recorder } = makeRecorder({ getUserMediaImpl: makeGetUserMedia({ shouldFail: true }) });
    await assert.rejects(() => recorder.start(), (err) => {
      assert.equal(err.kind, "permission");
      return true;
    });
  });

  test("成功时启动录音和语音识别，状态变为 recording", async () => {
    const { recorder, events } = makeRecorder();
    await recorder.start();
    assert.equal(recorder.getState(), STATES.RECORDING);
    assert.deepEqual(events.states, [STATES.RECORDING]);
    assert.equal(FakeRecognition.instances.length, 1);
    assert.equal(FakeRecognition.instances[0].started, true);
    assert.equal(FakeMediaRecorder.instances.length, 1);
  });

  test("识别语言透传给 SpeechRecognition 实例", async () => {
    const { recorder } = makeRecorder();
    await recorder.start();
    assert.equal(FakeRecognition.instances[0].lang, "fr-FR");
  });

  test("挑选浏览器支持的录音格式传给 MediaRecorder", async () => {
    const { recorder } = makeRecorder();
    await recorder.start();
    assert.equal(FakeMediaRecorder.instances[0].opts.mimeType, "audio/webm;codecs=opus");
  });

  test("已经在录音时再次 start 会报 state 错误", async () => {
    const { recorder } = makeRecorder();
    await recorder.start();
    await assert.rejects(() => recorder.start(), (err) => {
      assert.equal(err.kind, "state");
      return true;
    });
  });
});

describe("实时转录回调", () => {
  test("onresult 里的每个结果都会触发一次 onTranscriptSegment，带上 isFinal", async () => {
    const { recorder, events } = makeRecorder();
    await recorder.start();
    const recognition = FakeRecognition.instances[0];
    recognition.onresult({
      resultIndex: 0,
      results: [makeResult("Bonjour à tous", false)],
    });
    assert.equal(events.segments.length, 1);
    assert.equal(events.segments[0].text, "Bonjour à tous");
    assert.equal(events.segments[0].isFinal, false);
    assert.ok(typeof events.segments[0].start === "number");
    assert.ok(typeof events.segments[0].end === "number");
  });

  test("空文本的结果不会触发回调", async () => {
    const { recorder, events } = makeRecorder();
    await recorder.start();
    FakeRecognition.instances[0].onresult({
      resultIndex: 0,
      results: [makeResult("   ", true)],
    });
    assert.equal(events.segments.length, 0);
  });

  test("resultIndex 之后的多个结果都会各自触发一次回调", async () => {
    const { recorder, events } = makeRecorder();
    await recorder.start();
    FakeRecognition.instances[0].onresult({
      resultIndex: 1,
      results: [makeResult("忽略这条", true), makeResult("第一句", true), makeResult("第二句", false)],
    });
    assert.deepEqual(events.segments.map((s) => s.text), ["第一句", "第二句"]);
  });
});

describe("识别出错处理", () => {
  test("not-allowed 映射为 permission 错误", async () => {
    const { recorder, events } = makeRecorder();
    await recorder.start();
    FakeRecognition.instances[0].onerror({ error: "not-allowed" });
    assert.equal(events.errors.length, 1);
    assert.equal(events.errors[0].kind, "permission");
  });

  test("no-speech 静默忽略，不触发 onError", async () => {
    const { recorder, events } = makeRecorder();
    await recorder.start();
    FakeRecognition.instances[0].onerror({ error: "no-speech" });
    assert.equal(events.errors.length, 0);
  });

  test("no-speech 连续出现会通过 onSilence 报数，方便调用方判断是不是完全没收到声音", async () => {
    const { recorder, events } = makeRecorder();
    await recorder.start();
    FakeRecognition.instances[0].onerror({ error: "no-speech" });
    FakeRecognition.instances[0].onerror({ error: "no-speech" });
    FakeRecognition.instances[0].onerror({ error: "no-speech" });
    assert.deepEqual(events.silence, [1, 2, 3]);
  });

  test("再次识别到真实语音后，onSilence(0) 表示之前的静音计数解除", async () => {
    const { recorder, events } = makeRecorder();
    await recorder.start();
    FakeRecognition.instances[0].onerror({ error: "no-speech" });
    FakeRecognition.instances[0].onerror({ error: "no-speech" });
    FakeRecognition.instances[0].onresult({
      resultIndex: 0,
      results: [makeResult("终于说话了", true)],
    });
    assert.deepEqual(events.silence, [1, 2, 0]);
  });

  test("识别到空文本不会误判成\"说话了\"，不会清零静音计数", async () => {
    const { recorder, events } = makeRecorder();
    await recorder.start();
    FakeRecognition.instances[0].onerror({ error: "no-speech" });
    FakeRecognition.instances[0].onresult({
      resultIndex: 0,
      results: [makeResult("   ", true)],
    });
    assert.deepEqual(events.silence, [1]);
  });

  test("其它错误码映射为 recognition 错误", async () => {
    const { recorder, events } = makeRecorder();
    await recorder.start();
    FakeRecognition.instances[0].onerror({ error: "network" });
    assert.equal(events.errors.length, 1);
    assert.equal(events.errors[0].kind, "recognition");
  });

  test("识别引擎自己中途 onend 时，如果还在录音状态会自动重启", async () => {
    const { recorder } = makeRecorder();
    await recorder.start();
    const recognition = FakeRecognition.instances[0];
    recognition.started = false; // 模拟已经 end 了
    recognition.onend();
    assert.equal(recognition.started, true);
  });
});

describe("pause / resume", () => {
  test("pause 后状态变为 paused，且暂停了录音和识别", async () => {
    const { recorder, events } = makeRecorder();
    await recorder.start();
    recorder.pause();
    assert.equal(recorder.getState(), STATES.PAUSED);
    assert.equal(FakeMediaRecorder.instances[0].state, "paused");
    assert.equal(FakeRecognition.instances[0].started, false);
    assert.deepEqual(events.states, [STATES.RECORDING, STATES.PAUSED]);
  });

  test("resume 后状态恢复为 recording", async () => {
    const { recorder } = makeRecorder();
    await recorder.start();
    recorder.pause();
    recorder.resume();
    assert.equal(recorder.getState(), STATES.RECORDING);
    assert.equal(FakeMediaRecorder.instances[0].state, "recording");
    assert.equal(FakeRecognition.instances[0].started, true);
  });

  test("没在录音时调用 pause/resume 不会报错也不会有副作用", () => {
    const { recorder, events } = makeRecorder();
    recorder.pause();
    recorder.resume();
    assert.deepEqual(events.states, []);
  });
});

describe("stop", () => {
  test("没在录音时 stop 会报 state 错误", () => {
    const { recorder } = makeRecorder();
    assert.throws(() => recorder.stop(), (err) => {
      assert.equal(err.kind, "state");
      return true;
    });
  });

  test("正常停止后返回音频 Blob 和时长，状态变为 stopped，并关闭麦克风", async () => {
    const { recorder, events } = makeRecorder();
    await recorder.start();
    const result = await recorder.stop();
    assert.equal(recorder.getState(), STATES.STOPPED);
    assert.ok(result.audioBlob);
    assert.equal(result.audioBlob.type, "audio/webm");
    assert.ok(typeof result.durationSeconds === "number");
    assert.equal(FakeRecognition.instances[0].started, false);
    assert.deepEqual(events.states, [STATES.RECORDING, STATES.STOPPED]);
  });

  test("停止之后识别引擎的 onend 不会再触发自动重启", async () => {
    const { recorder } = makeRecorder();
    await recorder.start();
    const recognition = FakeRecognition.instances[0];
    await recorder.stop();
    assert.equal(recognition.onend, null);
  });

  test("暂停状态下也可以正常停止", async () => {
    const { recorder } = makeRecorder();
    await recorder.start();
    recorder.pause();
    const result = await recorder.stop();
    assert.equal(recorder.getState(), STATES.STOPPED);
    assert.ok(result.audioBlob);
  });
});
