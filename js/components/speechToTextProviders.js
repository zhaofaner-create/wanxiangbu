(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var result = factory();
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.speechToTextProviders = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // "整体重新识别"功能：录音结束后，把完整的录音文件重新整段识别一遍（跟录音过程中
  // 实时显示的那份转录是两回事，实时那份用的是浏览器免费的 Web Speech API，只能听
  // 实时麦克风、没法喂给它一个已经录好的音频文件）。
  //
  // 浏览器自带的 Web Speech API 做不到"识别一个已经录好的文件"，能做到的免费引擎不存在，
  // 所以这里改用真正的云端语音转文字服务——挑了 Google Cloud Speech-to-Text 和
  // Azure AI Speech 这两家，原因是它们的 REST 接口能直接从浏览器发请求（用户自己的
  // API 密钥、自己付费，不经过我们自己的任何服务器），架构上跟已经接入的 Google/Azure
  // 翻译服务是同一套（OpenAI Whisper 虽然便宜，但它的接口不支持浏览器直接跨域调用，
  // 会需要我们自己搭一个服务器转发，跟这个 App"零自建服务器"的架构原则冲突，所以没选它）。
  //
  // 两家的单次请求都有音频时长上限（大约一分钟），一堂课的录音可能有一到三个小时，
  // 没法一次性整个发过去，所以要先切成一小段一小段：用 AudioContext.decodeAudioData()
  // 把整段录音（不管原始是 webm/opus 什么格式）解码成原始 PCM 采样数据，按大约 55 秒
  // 一段切开（留一点余量，不卡在 60 秒的上限上），每一段单独编码打包、单独发一次请求，
  // 识别结果按顺序拼起来。选择"解码成 PCM 再切"而不是直接在原始文件字节上切，是因为
  // webm/opus 这类压缩格式的内部是一帧一帧压缩过的，没法在任意字节位置切开还保持能播放/
  // 能识别，PCM 是无压缩的原始采样点，想在哪里切一刀都行，最简单可靠。

  /** 统一的错误：message 是给用户看的中文提示，kind 供调用方按类型做不同处理。
   * 跟 translationProviders.js 的 providerError 是同一个模式，两个文件不互相依赖、
   * 各自维护一份，避免"翻译报错"和"语音识别报错"意外共享同一个实现细节。 */
  function providerError(message, kind) {
    const err = new Error(message);
    err.kind = kind; // "no_key" | "network" | "auth" | "api" | "empty_response" | "unsupported_provider" | "unsupported_browser"
    return err;
  }

  function pickFetch(fetchImpl) {
    return fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  }

  /** 出错响应体一般是 JSON，尽量取出里面的说明文字；取不到就返回空字符串。 */
  async function readErrorDetail(res, pick) {
    try {
      const body = await res.json();
      return pick(body) || "";
    } catch {
      return "";
    }
  }

  // Web Speech API 认的是 BCP-47 语言标签（比如 "fr-FR"），Google/Azure 这两家云端语音
  // 识别接口认的也是同一套标签，所以整个 App 只需要维护这一份映射——classNotes.js 里
  // "实时转录"用它，这里"整体重新识别"也用它，跟 store.js 的两位 ISO 语言代码对应上。
  const SPEECH_LANG_TAGS = {
    zh: "zh-CN", en: "en-US", fr: "fr-FR", es: "es-ES", de: "de-DE",
    ja: "ja-JP", ko: "ko-KR", ru: "ru-RU", pt: "pt-PT", it: "it-IT",
  };

  // ---------- 第一步：把录音 Blob 解码成 PCM，按固定时长切成一小段一小段 ----------

  const DEFAULT_CHUNK_SECONDS = 55; // 留出余量，不卡在两家服务大约 60 秒的单次请求上限上

  /** 单声道也好、立体声也好，统一按各声道采样值求平均，混成一条单声道——识别文字内容
   * 不需要立体声信息，混成单声道能减少一半数据量，两家接口也都认单声道。 */
  function downmixToMono(channelsData) {
    if (!channelsData.length) return new Float32Array(0);
    if (channelsData.length === 1) return channelsData[0];
    const length = channelsData[0].length;
    const mono = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (let c = 0; c < channelsData.length; c++) sum += channelsData[c][i];
      mono[i] = sum / channelsData.length;
    }
    return mono;
  }

  /** [-1, 1] 范围的浮点采样值转成 16 位有符号整数 PCM 字节（小端序）——两家语音识别
   * 接口都认这种最通用的编码（LINEAR16 / audio/pcm）。 */
  function floatTo16BitPCM(floatSamples) {
    const out = new Uint8Array(floatSamples.length * 2);
    const view = new DataView(out.buffer);
    for (let i = 0; i < floatSamples.length; i++) {
      let s = Math.max(-1, Math.min(1, floatSamples[i]));
      s = s < 0 ? s * 0x8000 : s * 0x7fff;
      view.setInt16(i * 2, s, true);
    }
    return out;
  }

  /** 把混好的单声道采样按 chunkSeconds 切成若干段，每段转成 16 位 PCM 字节，
   * 附上这段在整条录音里的起止时间（秒），方便识别完之后按时间顺序拼回转录格式。 */
  function chunkMonoSamples(monoSamples, sampleRate, chunkSeconds) {
    const chunkSize = Math.max(1, Math.floor(chunkSeconds * sampleRate));
    const chunks = [];
    for (let start = 0; start < monoSamples.length; start += chunkSize) {
      const end = Math.min(start + chunkSize, monoSamples.length);
      chunks.push({
        pcm16: floatTo16BitPCM(monoSamples.subarray(start, end)),
        sampleRate,
        startSeconds: start / sampleRate,
        durationSeconds: (end - start) / sampleRate,
      });
    }
    return chunks;
  }

  /** channelsData：[Float32Array, ...]（每个声道一条，长度都一样，来自 AudioBuffer.getChannelData）。
   * 这一步是纯数据处理，不依赖任何浏览器 API，方便单元测试直接喂假数据进来验证。 */
  function pcmChunksFromChannels(channelsData, sampleRate, chunkSeconds = DEFAULT_CHUNK_SECONDS) {
    const mono = downmixToMono(channelsData);
    return chunkMonoSamples(mono, sampleRate, chunkSeconds);
  }

  /**
   * 把一整段录音 Blob 解码、切段——这一步要用到浏览器的 AudioContext，Node 测试环境里
   * 没有这个 API，所以测试环境通过 decodeImpl 直接注入"解码结果"（{channelsData, sampleRate}），
   * 跳过真正的 AudioContext.decodeAudioData，只测后面纯数据处理那部分逻辑。
   */
  async function decodeAudioToPcmChunks(audioBlob, { chunkSeconds = DEFAULT_CHUNK_SECONDS, audioContextImpl, decodeImpl } = {}) {
    if (decodeImpl) {
      const { channelsData, sampleRate } = await decodeImpl(audioBlob);
      return pcmChunksFromChannels(channelsData, sampleRate, chunkSeconds);
    }
    const Ctx = audioContextImpl || (typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext));
    if (!Ctx) {
      throw providerError("当前浏览器不支持音频解码，没法整体重新识别这段录音", "unsupported_browser");
    }
    const ctx = new Ctx();
    try {
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      const channelsData = [];
      for (let c = 0; c < audioBuffer.numberOfChannels; c++) channelsData.push(audioBuffer.getChannelData(c));
      return pcmChunksFromChannels(channelsData, audioBuffer.sampleRate, chunkSeconds);
    } finally {
      if (typeof ctx.close === "function") ctx.close().catch(() => {});
    }
  }

  // ---------- 第二步：给每一小段 PCM 打包/编码成两家接口各自认的格式 ----------

  /** Google 语音识别接口收纯 PCM 字节（base64编码），不需要 WAV 文件头——采样率、
   * 编码方式是通过请求里的 config 字段单独告诉它的，不是从文件头里读。 */
  function bytesToBase64(bytes) {
    if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64"); // Node 测试环境
    let binary = "";
    const chunkSize = 0x8000; // 一次性传太大的数组给 String.fromCharCode.apply 可能爆栈，分批拼
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  /** Azure 语音识别接口收一个完整的 WAV 文件（要有 RIFF/fmt/data 文件头），这里手搭
   * 一个最简单的 16 位单声道 PCM WAV 头，不需要任何第三方库。 */
  function buildWavBytes(pcm16Bytes, sampleRate) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const dataSize = pcm16Bytes.length;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    function writeString(offset, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }
    writeString(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true); // PCM fmt 子块长度
    view.setUint16(20, 1, true); // 音频格式 = 1（PCM，不压缩）
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeString(36, "data");
    view.setUint32(40, dataSize, true);
    new Uint8Array(buffer, 44).set(pcm16Bytes);
    return new Uint8Array(buffer);
  }

  // ---------- 第三步：把某一小段发给 Google / Azure，拿到这一段的识别文字 ----------

  const GOOGLE_STT_ENDPOINT = "https://speech.googleapis.com/v1/speech:recognize";

  /** 识别不出内容（比如这一段整段静音）时返回空字符串，不当成错误——三小时的课免不了
   * 会有停顿、切换话题的空白，调用方（transcribeAudioBlob）会跳过这种空段，不产生空行。 */
  async function transcribeChunkWithGoogle({ apiKey, pcm16, sampleRate, languageCode, fetchImpl } = {}) {
    const key = (apiKey || "").trim();
    if (!key) {
      throw providerError("还没有设置 Google 语音识别密钥，请先去「数据与设置」填一个", "no_key");
    }
    const doFetch = pickFetch(fetchImpl);
    if (!doFetch) {
      throw providerError("当前环境不支持联网请求", "network");
    }

    let res;
    try {
      res = await doFetch(`${GOOGLE_STT_ENDPOINT}?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          config: {
            encoding: "LINEAR16",
            sampleRateHertz: sampleRate,
            languageCode,
            enableAutomaticPunctuation: true,
          },
          audio: { content: bytesToBase64(pcm16) },
        }),
      });
    } catch {
      throw providerError("联网请求失败，请检查网络连接", "network");
    }

    if (res.status === 401 || res.status === 403) {
      throw providerError("Google 语音识别密钥无效或没有权限，请检查「数据与设置」里填的密钥", "auth");
    }
    if (!res.ok) {
      const detail = await readErrorDetail(res, (body) => body && body.error && body.error.message);
      throw providerError(`Google 语音识别服务返回错误（HTTP ${res.status}）${detail ? "：" + detail : ""}`, "api");
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw providerError("Google 语音识别服务返回的内容无法解析", "api");
    }
    const results = Array.isArray(data.results) ? data.results : [];
    return results
      .map((r) => (r.alternatives && r.alternatives[0] && r.alternatives[0].transcript) || "")
      .join(" ")
      .trim();
  }

  function buildAzureSttUrl(region, languageCode) {
    return `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(languageCode)}`;
  }

  async function transcribeChunkWithAzure({ apiKey, region, wavBytes, sampleRate, languageCode, fetchImpl } = {}) {
    const key = (apiKey || "").trim();
    const rg = (region || "").trim();
    if (!key || !rg) {
      throw providerError("还没有设置 Azure 语音识别密钥和区域，请先去「数据与设置」填好", "no_key");
    }
    const doFetch = pickFetch(fetchImpl);
    if (!doFetch) {
      throw providerError("当前环境不支持联网请求", "network");
    }

    let res;
    try {
      res = await doFetch(buildAzureSttUrl(rg, languageCode), {
        method: "POST",
        headers: {
          "content-type": `audio/wav; codecs=audio/pcm; samplerate=${sampleRate}`,
          "Ocp-Apim-Subscription-Key": key,
          accept: "application/json",
        },
        body: wavBytes,
      });
    } catch {
      throw providerError("联网请求失败，请检查网络连接", "network");
    }

    if (res.status === 401 || res.status === 403) {
      throw providerError("Azure 语音识别密钥或区域无效，请检查「数据与设置」里填的内容", "auth");
    }
    if (!res.ok) {
      const detail = await readErrorDetail(res, (body) => body && body.error && body.error.message);
      throw providerError(`Azure 语音识别服务返回错误（HTTP ${res.status}）${detail ? "：" + detail : ""}`, "api");
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw providerError("Azure 语音识别服务返回的内容无法解析", "api");
    }
    // RecognitionStatus 是 "Success" / "NoMatch"（没识别出内容，等同静音，不算错误）/
    // 其它值（比如 "Error"）才是真的失败。
    if (data.RecognitionStatus === "NoMatch") return "";
    if (data.RecognitionStatus && data.RecognitionStatus !== "Success") {
      throw providerError(`Azure 语音识别失败（${data.RecognitionStatus}）`, "api");
    }
    return (data.DisplayText || "").trim();
  }

  // ---------- 统一入口：切段 + 依次识别 + 拼回转录分段格式 ----------

  const STT_PROVIDERS = ["google", "azure"];

  /** 某个语音识别服务是否已经填好了它要求的全部密钥字段（Azure 需要密钥+区域两个都填）。 */
  function isSttProviderConfigured(provider, keys) {
    const k = keys || {};
    if (provider === "google") return Boolean((k.googleSpeechApiKey || "").trim());
    if (provider === "azure") return Boolean((k.azureSpeechApiKey || "").trim()) && Boolean((k.azureSpeechRegion || "").trim());
    return false;
  }

  /**
   * "整体重新识别"的主入口：把完整录音 Blob 解码切段、依次发给选中的服务识别、按时间顺序
   * 拼回转录分段（跟 store.js 里 transcriptSegments 一样的 {start, end, text} 形状）。
   * - onProgress({index, total}) 每处理完一段就调用一次（index 从 0 数到 total，最后
   *   再额外调用一次 index===total 表示全部完成），调用方用它刷新"正在识别第 x/共 y 段"。
   * - 某一段识别失败会让整体直接抛错中止（不是"跳过这一段继续"）——用户付费调用的接口，
   *   静默丢失中间几分钟内容比直接报错更糟，让用户看到出错、能重试更合适。
   * - 某一段是静音、识别不出内容（返回空字符串）时直接跳过，不产生空的转录行。
   */
  async function transcribeAudioBlob({
    provider, keys, blob, languageCode, chunkSeconds = DEFAULT_CHUNK_SECONDS,
    onProgress, fetchImpl, decodeImpl, audioContextImpl,
  } = {}) {
    const k = keys || {};
    if (!isSttProviderConfigured(provider, k)) {
      throw providerError("还没有配置语音识别服务的密钥", "no_key");
    }
    const chunks = await decodeAudioToPcmChunks(blob, { chunkSeconds, decodeImpl, audioContextImpl });
    if (!chunks.length) {
      throw providerError("没有从这段录音里解析出可用的音频内容", "empty_response");
    }
    const segments = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (onProgress) onProgress({ index: i, total: chunks.length });
      let text = "";
      if (provider === "google") {
        text = await transcribeChunkWithGoogle({
          apiKey: k.googleSpeechApiKey, pcm16: chunk.pcm16, sampleRate: chunk.sampleRate, languageCode, fetchImpl,
        });
      } else if (provider === "azure") {
        text = await transcribeChunkWithAzure({
          apiKey: k.azureSpeechApiKey, region: k.azureSpeechRegion,
          wavBytes: buildWavBytes(chunk.pcm16, chunk.sampleRate), sampleRate: chunk.sampleRate,
          languageCode, fetchImpl,
        });
      } else {
        throw providerError("不认识的语音识别服务", "unsupported_provider");
      }
      if (text) segments.push({ start: chunk.startSeconds, end: chunk.startSeconds + chunk.durationSeconds, text });
    }
    if (onProgress) onProgress({ index: chunks.length, total: chunks.length });
    return segments;
  }

  return {
    STT_PROVIDERS, SPEECH_LANG_TAGS, DEFAULT_CHUNK_SECONDS,
    providerError, isSttProviderConfigured,
    downmixToMono, floatTo16BitPCM, chunkMonoSamples, pcmChunksFromChannels, decodeAudioToPcmChunks,
    bytesToBase64, buildWavBytes,
    transcribeChunkWithGoogle, transcribeChunkWithAzure, buildAzureSttUrl,
    transcribeAudioBlob,
  };
});
