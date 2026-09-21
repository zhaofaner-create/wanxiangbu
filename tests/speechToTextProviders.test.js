const { test, describe, mock } = require("node:test");
const assert = require("node:assert/strict");
const {
  downmixToMono, floatTo16BitPCM, chunkMonoSamples, pcmChunksFromChannels, decodeAudioToPcmChunks,
  bytesToBase64, buildWavBytes, isSttProviderConfigured,
  transcribeChunkWithGoogle, transcribeChunkWithAzure, buildAzureSttUrl, transcribeAudioBlob,
  SPEECH_LANG_TAGS, STT_PROVIDERS,
} = require("../js/components/speechToTextProviders.js");

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// ---------- downmixToMono / floatTo16BitPCM / chunkMonoSamples ----------

describe("downmixToMono", () => {
  test("单声道原样返回，不做多余处理", () => {
    const mono = new Float32Array([0.1, 0.2, 0.3]);
    assert.equal(downmixToMono([mono]), mono);
  });

  test("立体声按两声道平均值混成单声道", () => {
    const left = new Float32Array([1, 0.5, -1]);
    const right = new Float32Array([-1, 0.5, 1]);
    const mono = downmixToMono([left, right]);
    assert.deepEqual(Array.from(mono), [0, 0.5, 0]);
  });
});

describe("floatTo16BitPCM", () => {
  test("把 [-1,1] 浮点采样转成 16 位小端有符号整数字节", () => {
    const bytes = floatTo16BitPCM(new Float32Array([0, 1, -1]));
    const view = new DataView(bytes.buffer);
    assert.equal(bytes.length, 6);
    assert.equal(view.getInt16(0, true), 0);
    assert.equal(view.getInt16(2, true), 0x7fff);
    assert.equal(view.getInt16(4, true), -0x8000);
  });

  test("超出 [-1,1] 范围的采样值会被截断，不会溢出成错误的数值", () => {
    const bytes = floatTo16BitPCM(new Float32Array([2, -2]));
    const view = new DataView(bytes.buffer);
    assert.equal(view.getInt16(0, true), 0x7fff);
    assert.equal(view.getInt16(2, true), -0x8000);
  });
});

describe("chunkMonoSamples", () => {
  test("按秒数切段，每段附上起止时间", () => {
    // 采样率 10，切 1 秒一段：10 个采样点应该切成 [0..10) 一段
    const samples = new Float32Array(10).fill(0.1);
    const chunks = chunkMonoSamples(samples, 10, 1);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].startSeconds, 0);
    assert.equal(chunks[0].durationSeconds, 1);
    assert.equal(chunks[0].sampleRate, 10);
  });

  test("最后一段不足一个整段时按实际长度截断，不会补零凑整", () => {
    const samples = new Float32Array(25).fill(0.1); // 采样率 10，每段 10 个采样点：10+10+5
    const chunks = chunkMonoSamples(samples, 10, 1);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].durationSeconds, 1);
    assert.equal(chunks[1].durationSeconds, 1);
    assert.equal(chunks[1].startSeconds, 1);
    assert.equal(chunks[2].durationSeconds, 0.5);
    assert.equal(chunks[2].startSeconds, 2);
  });
});

describe("pcmChunksFromChannels / decodeAudioToPcmChunks", () => {
  test("pcmChunksFromChannels 把立体声混音 + 切段两步串起来", () => {
    const left = new Float32Array(20).fill(1);
    const right = new Float32Array(20).fill(-1);
    const chunks = pcmChunksFromChannels([left, right], 10, 1);
    assert.equal(chunks.length, 2);
    // 混音后每个采样值都是 0，转成 PCM 应该全是 0 字节
    assert.ok(chunks[0].pcm16.every((b) => b === 0));
  });

  test("decodeAudioToPcmChunks 通过 decodeImpl 注入测试环境的解码结果，不依赖真实 AudioContext", async () => {
    const fakeBlob = {};
    const decodeImpl = mock.fn(async (blob) => {
      assert.equal(blob, fakeBlob);
      return { channelsData: [new Float32Array(30).fill(0.2)], sampleRate: 10 };
    });
    const chunks = await decodeAudioToPcmChunks(fakeBlob, { chunkSeconds: 1, decodeImpl });
    assert.equal(decodeImpl.mock.calls.length, 1);
    assert.equal(chunks.length, 3);
  });

  test("既没有注入 decodeImpl、当前环境也没有 AudioContext 时，报「不支持的浏览器」错误", async () => {
    await assert.rejects(
      () => decodeAudioToPcmChunks({}, { chunkSeconds: 1 }),
      (err) => err.kind === "unsupported_browser"
    );
  });
});

// ---------- bytesToBase64 / buildWavBytes ----------

describe("bytesToBase64", () => {
  test("跟 Node Buffer 的 base64 编码结果一致", () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString("base64"));
  });
});

describe("buildWavBytes", () => {
  test("生成的文件带有正确的 RIFF/WAVE/fmt/data 头部字段", () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const wav = buildWavBytes(pcm, 16000);
    const view = new DataView(wav.buffer);
    const decoder = new TextDecoder("ascii");
    assert.equal(decoder.decode(wav.subarray(0, 4)), "RIFF");
    assert.equal(decoder.decode(wav.subarray(8, 12)), "WAVE");
    assert.equal(decoder.decode(wav.subarray(12, 16)), "fmt ");
    assert.equal(view.getUint16(20, true), 1); // PCM
    assert.equal(view.getUint16(22, true), 1); // 单声道
    assert.equal(view.getUint32(24, true), 16000); // 采样率
    assert.equal(view.getUint16(34, true), 16); // 位深
    assert.equal(decoder.decode(wav.subarray(36, 40)), "data");
    assert.equal(view.getUint32(40, true), 4); // data 长度
    assert.deepEqual(Array.from(wav.subarray(44)), [1, 2, 3, 4]);
    assert.equal(wav.length, 44 + 4);
  });
});

// ---------- isSttProviderConfigured ----------

describe("isSttProviderConfigured", () => {
  test("google 只需要密钥", () => {
    assert.equal(isSttProviderConfigured("google", {}), false);
    assert.equal(isSttProviderConfigured("google", { googleSpeechApiKey: "k" }), true);
  });

  test("azure 密钥和区域缺一不可", () => {
    assert.equal(isSttProviderConfigured("azure", { azureSpeechApiKey: "k" }), false);
    assert.equal(isSttProviderConfigured("azure", { azureSpeechRegion: "eastus" }), false);
    assert.equal(isSttProviderConfigured("azure", { azureSpeechApiKey: "k", azureSpeechRegion: "eastus" }), true);
  });

  test("不认识的 provider 一律 false", () => {
    assert.equal(isSttProviderConfigured("deepl", { deeplApiKey: "k" }), false);
  });
});

// ---------- transcribeChunkWithGoogle ----------

describe("transcribeChunkWithGoogle", () => {
  test("没填密钥直接报 no_key，不发请求", async () => {
    const fetchImpl = mock.fn();
    await assert.rejects(
      () => transcribeChunkWithGoogle({ apiKey: "", pcm16: new Uint8Array(), sampleRate: 16000, languageCode: "fr-FR", fetchImpl }),
      (err) => err.kind === "no_key"
    );
    assert.equal(fetchImpl.mock.calls.length, 0);
  });

  test("正常识别：把多个 alternatives[0].transcript 拼接起来", async () => {
    const fetchImpl = mock.fn(async () =>
      jsonResponse(200, { results: [{ alternatives: [{ transcript: "Bonjour" }] }, { alternatives: [{ transcript: "à tous" }] }] })
    );
    const text = await transcribeChunkWithGoogle({ apiKey: "k", pcm16: new Uint8Array([1, 2]), sampleRate: 16000, languageCode: "fr-FR", fetchImpl });
    assert.equal(text, "Bonjour à tous");
    const [url, options] = fetchImpl.mock.calls[0].arguments;
    assert.match(url, /^https:\/\/speech\.googleapis\.com\/v1\/speech:recognize\?key=k$/);
    const body = JSON.parse(options.body);
    assert.equal(body.config.encoding, "LINEAR16");
    assert.equal(body.config.sampleRateHertz, 16000);
    assert.equal(body.config.languageCode, "fr-FR");
    assert.equal(typeof body.audio.content, "string");
  });

  test("整段静音（没有 results）返回空字符串，不算错误", async () => {
    const fetchImpl = mock.fn(async () => jsonResponse(200, {}));
    const text = await transcribeChunkWithGoogle({ apiKey: "k", pcm16: new Uint8Array(), sampleRate: 16000, languageCode: "fr-FR", fetchImpl });
    assert.equal(text, "");
  });

  test("401/403 报 auth 错误", async () => {
    const fetchImpl = mock.fn(async () => jsonResponse(403, { error: { message: "denied" } }));
    await assert.rejects(
      () => transcribeChunkWithGoogle({ apiKey: "bad", pcm16: new Uint8Array(), sampleRate: 16000, languageCode: "fr-FR", fetchImpl }),
      (err) => err.kind === "auth"
    );
  });

  test("网络请求失败报 network 错误", async () => {
    const fetchImpl = mock.fn(async () => { throw new Error("boom"); });
    await assert.rejects(
      () => transcribeChunkWithGoogle({ apiKey: "k", pcm16: new Uint8Array(), sampleRate: 16000, languageCode: "fr-FR", fetchImpl }),
      (err) => err.kind === "network"
    );
  });
});

// ---------- transcribeChunkWithAzure ----------

describe("transcribeChunkWithAzure", () => {
  test("没填密钥或区域直接报 no_key", async () => {
    const fetchImpl = mock.fn();
    await assert.rejects(
      () => transcribeChunkWithAzure({ apiKey: "", region: "", wavBytes: new Uint8Array(), sampleRate: 16000, languageCode: "fr-FR", fetchImpl }),
      (err) => err.kind === "no_key"
    );
    assert.equal(fetchImpl.mock.calls.length, 0);
  });

  test("正常识别：取 DisplayText", async () => {
    const fetchImpl = mock.fn(async () => jsonResponse(200, { RecognitionStatus: "Success", DisplayText: "Bonjour à tous." }));
    const text = await transcribeChunkWithAzure({
      apiKey: "k", region: "eastus", wavBytes: new Uint8Array([1, 2]), sampleRate: 16000, languageCode: "fr-FR", fetchImpl,
    });
    assert.equal(text, "Bonjour à tous.");
    const [url, options] = fetchImpl.mock.calls[0].arguments;
    assert.equal(url, buildAzureSttUrl("eastus", "fr-FR"));
    assert.equal(options.headers["Ocp-Apim-Subscription-Key"], "k");
    assert.match(options.headers["content-type"], /samplerate=16000/);
  });

  test("NoMatch（识别不出内容）返回空字符串，不算错误", async () => {
    const fetchImpl = mock.fn(async () => jsonResponse(200, { RecognitionStatus: "NoMatch" }));
    const text = await transcribeChunkWithAzure({
      apiKey: "k", region: "eastus", wavBytes: new Uint8Array(), sampleRate: 16000, languageCode: "fr-FR", fetchImpl,
    });
    assert.equal(text, "");
  });

  test("RecognitionStatus 是其它失败值时报 api 错误", async () => {
    const fetchImpl = mock.fn(async () => jsonResponse(200, { RecognitionStatus: "Error" }));
    await assert.rejects(
      () => transcribeChunkWithAzure({ apiKey: "k", region: "eastus", wavBytes: new Uint8Array(), sampleRate: 16000, languageCode: "fr-FR", fetchImpl }),
      (err) => err.kind === "api"
    );
  });

  test("401/403 报 auth 错误", async () => {
    const fetchImpl = mock.fn(async () => jsonResponse(401, {}));
    await assert.rejects(
      () => transcribeChunkWithAzure({ apiKey: "bad", region: "eastus", wavBytes: new Uint8Array(), sampleRate: 16000, languageCode: "fr-FR", fetchImpl }),
      (err) => err.kind === "auth"
    );
  });
});

// ---------- transcribeAudioBlob（整体流程：切段 + 依次识别 + 拼回转录格式） ----------

describe("transcribeAudioBlob", () => {
  test("没配置密钥直接报 no_key，不解码音频", async () => {
    const decodeImpl = mock.fn();
    await assert.rejects(
      () => transcribeAudioBlob({ provider: "google", keys: {}, blob: {}, languageCode: "fr-FR", decodeImpl }),
      (err) => err.kind === "no_key"
    );
    assert.equal(decodeImpl.mock.calls.length, 0);
  });

  test("按顺序把每一段发给 google，拼回带时间戳的转录分段；空段自动跳过", async () => {
    const decodeImpl = async () => ({ channelsData: [new Float32Array(30).fill(0.1)], sampleRate: 10 });
    let call = 0;
    const fetchImpl = mock.fn(async () => {
      call += 1;
      // 第二段（call===2）识别不出内容，模拟中间有一段静音
      const transcript = call === 2 ? "" : `第${call}段`;
      return jsonResponse(200, { results: transcript ? [{ alternatives: [{ transcript }] }] : [] });
    });
    const progressCalls = [];
    const segments = await transcribeAudioBlob({
      provider: "google",
      keys: { googleSpeechApiKey: "k" },
      blob: {},
      languageCode: "fr-FR",
      chunkSeconds: 1,
      decodeImpl,
      fetchImpl,
      onProgress: (p) => progressCalls.push(p),
    });
    assert.equal(fetchImpl.mock.calls.length, 3); // 30 个采样点，采样率 10，每秒一段：切成 3 段
    assert.deepEqual(
      segments.map((s) => s.text),
      ["第1段", "第3段"] // 第 2 段静音被跳过
    );
    assert.equal(segments[0].start, 0);
    assert.equal(segments[1].start, 2);
    assert.deepEqual(progressCalls, [
      { index: 0, total: 3 }, { index: 1, total: 3 }, { index: 2, total: 3 }, { index: 3, total: 3 },
    ]);
  });

  test("某一段识别失败时整体直接抛错中止，不会静默丢内容", async () => {
    const decodeImpl = async () => ({ channelsData: [new Float32Array(20).fill(0.1)], sampleRate: 10 });
    let call = 0;
    const fetchImpl = mock.fn(async () => {
      call += 1;
      if (call === 2) return jsonResponse(403, {});
      return jsonResponse(200, { results: [{ alternatives: [{ transcript: "ok" }] }] });
    });
    await assert.rejects(
      () => transcribeAudioBlob({
        provider: "google", keys: { googleSpeechApiKey: "k" }, blob: {}, languageCode: "fr-FR",
        chunkSeconds: 1, decodeImpl, fetchImpl,
      }),
      (err) => err.kind === "auth"
    );
  });

  test("走 azure provider 时会把每一段包成 WAV 再发送", async () => {
    const decodeImpl = async () => ({ channelsData: [new Float32Array(10).fill(0.1)], sampleRate: 10 });
    const fetchImpl = mock.fn(async (url, options) => {
      assert.ok(options.body instanceof Uint8Array); // WAV 字节，不是 Google 那种 JSON body
      return jsonResponse(200, { RecognitionStatus: "Success", DisplayText: "Bonjour" });
    });
    const segments = await transcribeAudioBlob({
      provider: "azure",
      keys: { azureSpeechApiKey: "k", azureSpeechRegion: "eastus" },
      blob: {}, languageCode: "fr-FR", chunkSeconds: 1, decodeImpl, fetchImpl,
    });
    assert.deepEqual(segments.map((s) => s.text), ["Bonjour"]);
  });
});

// ---------- 常量 ----------

describe("常量", () => {
  test("STT_PROVIDERS 只有 google/azure 两家（DeepL 不做语音转文字）", () => {
    assert.deepEqual(STT_PROVIDERS, ["google", "azure"]);
  });

  test("SPEECH_LANG_TAGS 覆盖课堂笔记支持的讲课语言", () => {
    assert.equal(SPEECH_LANG_TAGS.fr, "fr-FR");
    assert.equal(SPEECH_LANG_TAGS.zh, "zh-CN");
  });
});
