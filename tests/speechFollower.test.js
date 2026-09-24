const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { createSpeechFollower } = require("../js/components/speechFollower.js");

// ---------- 假的 SpeechRecognition + 可手动推进的假定时器 ----------

function makeResult(text, isFinal) {
  const arr = [{ transcript: text }];
  arr.isFinal = isFinal;
  return arr;
}

class FakeRecognition {
  constructor() {
    this.started = false;
    this.startCallCount = 0;
    FakeRecognition.instances.push(this);
  }
  start() {
    this.started = true;
    this.startCallCount += 1;
  }
  stop() {
    this.started = false;
  }
}

beforeEach(() => {
  FakeRecognition.instances = [];
});

/** 手动推进的假定时器：setTimeoutImpl 只是把回调记下来，fire() 手动触发、不依赖真实时间流逝。 */
function makeFakeTimers() {
  let idCounter = 0;
  const pending = new Map();
  return {
    setTimeoutImpl: (fn) => {
      const id = (idCounter += 1);
      pending.set(id, fn);
      return id;
    },
    clearTimeoutImpl: (id) => {
      pending.delete(id);
    },
    fireAll: () => {
      const fns = [...pending.values()];
      pending.clear();
      fns.forEach((fn) => fn());
    },
    pendingCount: () => pending.size,
  };
}

function makeFollower(overrides = {}) {
  const events = { statuses: [], transcripts: [], silenceTimeouts: 0, fatalErrors: [] };
  const timers = overrides.timers || makeFakeTimers();
  const follower = createSpeechFollower({
    lang: "zh-CN",
    SpeechRecognitionImpl: FakeRecognition,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    onStatusChange: (s) => events.statuses.push(s),
    onTranscriptUpdate: (text, meta) => events.transcripts.push({ text, meta }),
    onSilenceTimeout: () => { events.silenceTimeouts += 1; },
    onFatalError: (err) => events.fatalErrors.push(err),
    ...overrides,
  });
  return { follower, events, timers };
}

describe("isSupported", () => {
  test("没有注入/没有全局 SpeechRecognition 构造函数时返回 false", () => {
    const follower = createSpeechFollower({ SpeechRecognitionImpl: null });
    assert.equal(follower.isSupported(), false);
  });
  test("start() 在不支持时抛出 kind=unsupported 的错误", () => {
    const follower = createSpeechFollower({ SpeechRecognitionImpl: null });
    assert.throws(() => follower.start(), (err) => err.kind === "unsupported");
  });
});

describe("正常识别流程", () => {
  test("start() 会创建识别实例并进入 listening 状态", () => {
    const { follower, events } = makeFollower();
    follower.start();
    assert.equal(FakeRecognition.instances.length, 1);
    assert.ok(FakeRecognition.instances[0].started);
    assert.deepEqual(events.statuses, ["listening"]);
    assert.equal(follower.isRunning(), true);
  });

  test("最终结果会被累积进缓冲区，interim（未定稿）结果不会", () => {
    const { follower, events } = makeFollower();
    follower.start();
    const recognition = FakeRecognition.instances[0];
    recognition.onresult({ resultIndex: 0, results: [makeResult("大家好", false)] });
    assert.equal(follower.getRecentText(), "");
    assert.equal(events.transcripts.at(-1).meta.isFinal, false);

    recognition.onresult({ resultIndex: 0, results: [makeResult("大家好", true)] });
    assert.equal(follower.getRecentText(), "大家好");
    assert.equal(events.transcripts.at(-1).meta.isFinal, true);

    recognition.onresult({ resultIndex: 1, results: [makeResult("大家好", true), makeResult("欢迎收看", true)] });
    assert.equal(follower.getRecentText(), "大家好 欢迎收看");
  });

  test("stop() 之后不会再自动重启，也不会触发状态回调之外的重连", () => {
    const { follower, events } = makeFollower();
    follower.start();
    const recognition = FakeRecognition.instances[0];
    follower.stop();
    assert.equal(events.statuses.at(-1), "stopped");
    assert.equal(recognition.onend, null);
    assert.equal(follower.isRunning(), false);
  });

  test("clearBuffer() 手动清空累积的识别内容", () => {
    const { follower } = makeFollower();
    follower.start();
    const recognition = FakeRecognition.instances[0];
    recognition.onresult({ resultIndex: 0, results: [makeResult("你好", true)] });
    assert.equal(follower.getRecentText(), "你好");
    follower.clearBuffer();
    assert.equal(follower.getRecentText(), "");
  });
});

describe("断线自动重启（应对录音断断续续）", () => {
  test("识别引擎自己触发 onend 时，只要还在运行就立刻自动重启，且不清空已有缓冲区", () => {
    const { follower, events } = makeFollower();
    follower.start();
    const recognition = FakeRecognition.instances[0];
    recognition.onresult({ resultIndex: 0, results: [makeResult("已经讲到这里了", true)] });
    assert.equal(recognition.startCallCount, 1);

    recognition.onend(); // 模拟引擎中途自己断开

    assert.equal(recognition.startCallCount, 2); // 立刻重启了
    assert.equal(follower.getRecentText(), "已经讲到这里了"); // 缓冲区没有被清空
    assert.deepEqual(events.statuses.slice(-2), ["reconnecting", "listening"]);
  });

  test("no-speech 错误不算故障，不会触发 onFatalError，交给 onend 自动重启", () => {
    const { follower, events } = makeFollower();
    follower.start();
    const recognition = FakeRecognition.instances[0];
    recognition.onerror({ error: "no-speech" });
    assert.equal(events.fatalErrors.length, 0);
    assert.equal(follower.isRunning(), true);
  });
});

describe("真故障：权限/设备问题，重试没用，直接切手动", () => {
  test("not-allowed 错误立刻停止并回调 onFatalError(kind=permission)", () => {
    const { follower, events } = makeFollower();
    follower.start();
    const recognition = FakeRecognition.instances[0];
    recognition.onerror({ error: "not-allowed" });
    assert.equal(follower.isRunning(), false);
    assert.equal(events.fatalErrors.length, 1);
    assert.equal(events.fatalErrors[0].kind, "permission");
    assert.equal(events.statuses.at(-1), "error");
  });

  test("audio-capture（麦克风不可用）同样立刻切手动", () => {
    const { follower, events } = makeFollower();
    follower.start();
    FakeRecognition.instances[0].onerror({ error: "audio-capture" });
    assert.equal(events.fatalErrors[0].kind, "permission");
    assert.match(events.fatalErrors[0].message, /麦克风不可用/);
  });

  test("停止后即使识别引擎又触发 onend 也不会再重启（running 已经是 false）", () => {
    const { follower } = makeFollower();
    follower.start();
    const recognition = FakeRecognition.instances[0];
    recognition.onerror({ error: "not-allowed" });
    const countBefore = recognition.startCallCount;
    recognition.onend();
    assert.equal(recognition.startCallCount, countBefore);
  });
});

describe("短时间连续出错限流：避免无限空转重启", () => {
  test("短时间内出错次数达到上限就放弃重试、回调 onFatalError(kind=fatal)", () => {
    const { follower, events } = makeFollower({ maxRestartFailures: 3, restartFailureWindowMs: 10000 });
    follower.start();
    const recognition = FakeRecognition.instances[0];
    recognition.onerror({ error: "network" });
    recognition.onerror({ error: "network" });
    assert.equal(events.fatalErrors.length, 0); // 还没到3次
    recognition.onerror({ error: "network" });
    assert.equal(events.fatalErrors.length, 1);
    assert.equal(events.fatalErrors[0].kind, "fatal");
    assert.equal(follower.isRunning(), false);
  });

  test("窗口过期后的旧失败不计入限流次数", () => {
    let currentTime = 0;
    const { follower, events } = makeFollower({
      maxRestartFailures: 2,
      restartFailureWindowMs: 5000,
      now: () => currentTime,
    });
    follower.start();
    const recognition = FakeRecognition.instances[0];
    currentTime = 0;
    recognition.onerror({ error: "network" }); // t=0，1次
    currentTime = 6000; // 超过5秒窗口，上一次失败已经过期
    recognition.onerror({ error: "network" }); // t=6000，重新算只有1次
    assert.equal(events.fatalErrors.length, 0);
  });
});

describe("长时间无声自动提醒（配合调用方切换到手动模式）", () => {
  test("连续这么久没有任何识别结果就触发 onSilenceTimeout", () => {
    const { follower, events, timers } = makeFollower({ silenceTimeoutMs: 8000 });
    follower.start();
    assert.equal(events.silenceTimeouts, 0);
    timers.fireAll(); // 手动推进到"静音超时"那一刻
    assert.equal(events.silenceTimeouts, 1);
  });

  test("期间只要识别到任何语音，旧的静音计时器就会被清掉、重新排一个新的，不会越攒越多", () => {
    const { follower, timers } = makeFollower({ silenceTimeoutMs: 8000 });
    follower.start();
    assert.equal(timers.pendingCount(), 1); // start() 排了第一个
    const recognition = FakeRecognition.instances[0];
    recognition.onresult({ resultIndex: 0, results: [makeResult("还在讲", true)] });
    recognition.onresult({ resultIndex: 0, results: [makeResult("接着讲", true)] });
    // 每次识别到语音都会清掉旧的、重新排一个新的，pending 里应该始终只有1个，不会累积
    assert.equal(timers.pendingCount(), 1);
  });

  test("stop() 之后不会再触发静音超时", () => {
    const { follower, events, timers } = makeFollower();
    follower.start();
    follower.stop();
    timers.fireAll();
    assert.equal(events.silenceTimeouts, 0);
  });
});
