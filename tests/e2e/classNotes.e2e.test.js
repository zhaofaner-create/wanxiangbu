// 课堂笔记模块端到端测试：录音转文字、AI 整理笔记、多语言互译。
//
// 真实的语音识别（Web Speech API）和麦克风录音（MediaRecorder/getUserMedia）没法在
// 无网络、无麦克风的测试环境里跑，所以用 addInitScript 在页面自己的脚本跑之前，把
// window.SpeechRecognition / window.MediaRecorder / navigator.mediaDevices.getUserMedia
// 换成假实现——接口形状跟真实浏览器 API 一致（start/stop、onresult/onerror/onend、
// ondataavailable/onstop），测试代码通过 window.__fakeRecognitions 拿到最新创建的
// 那个识别器实例，手动触发 onresult 事件来模拟"用户说了一句话"。
//
// Claude API（多语言互译、AI 整理笔记两个功能用）用 page.route 拦截
// https://api.anthropic.com/v1/messages：这是真正的跨域请求，需要连预检的 OPTIONS
// 请求和正式响应都带上 CORS 头，浏览器才会把响应交给页面的 fetch()，不然会在
// aiClient.js 里被当成"网络请求失败"。
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { gotoApp, goToModule } from "./helpers.js";

let browser;
let context;
let page;

const FAKE_BROWSER_APIS_SCRIPT = `
  window.__fakeRecognitions = [];
  window.__fakeRecorders = [];

  class FakeSpeechRecognition {
    constructor() {
      this.lang = "";
      this.continuous = true;
      this.interimResults = true;
      this.onresult = null;
      this.onerror = null;
      this.onend = null;
      this.started = false;
      window.__fakeRecognitions.push(this);
    }
    start() { this.started = true; }
    stop() { this.started = false; }
  }
  window.SpeechRecognition = FakeSpeechRecognition;
  window.webkitSpeechRecognition = FakeSpeechRecognition;

  class FakeMediaRecorder {
    constructor(stream, opts) {
      this.stream = stream;
      this.opts = opts;
      this.state = "recording";
      this.ondataavailable = null;
      this.onstop = null;
      window.__fakeRecorders.push(this);
    }
    start() {}
    pause() { this.state = "paused"; }
    resume() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      if (this.ondataavailable) this.ondataavailable({ data: new Blob(["fake-audio"], { type: "audio/webm" }) });
      if (this.onstop) this.onstop();
    }
  }
  FakeMediaRecorder.isTypeSupported = (type) => type === "audio/webm;codecs=opus";
  window.MediaRecorder = FakeMediaRecorder;

  const fakeStream = { getTracks: () => [{ stop() {} }] };
  // 直接改原型上的 getter，而不是给 navigator 实例赋值：file:// 页面本身可能根本没有
  // mediaDevices（这个 API 通常要求"安全上下文"），改原型能保证不管原来有没有都生效。
  Object.defineProperty(window.Navigator.prototype, "mediaDevices", {
    configurable: true,
    get() { return { getUserMedia: async () => fakeStream }; },
  });

  // "整体重新识别"要用到 AudioContext.decodeAudioData() 把录音 Blob 解码成 PCM，
  // 测试环境里的"录音"只是 FakeMediaRecorder 编出来的几个假字节（"fake-audio"），
  // 真的 AudioContext 解不出来，所以这里也一并假掉：不管喂给它什么，都直接返回一份
  // 固定的、很短的单声道假音频数据，只测"识别流程走通了没有"，不测真实解码。
  class FakeAudioContext {
    decodeAudioData() {
      return Promise.resolve({
        numberOfChannels: 1,
        sampleRate: 16000,
        getChannelData: () => new Float32Array(16000).fill(0.05),
      });
    }
    close() {
      return Promise.resolve();
    }
  }
  window.AudioContext = FakeAudioContext;
  window.webkitAudioContext = FakeAudioContext;

  window.__emitTranscript = (text, isFinal) => {
    const rec = window.__fakeRecognitions[window.__fakeRecognitions.length - 1];
    if (!rec || !rec.onresult) return;
    const result = Object.assign([{ transcript: text }], { isFinal: isFinal !== false });
    rec.onresult({ resultIndex: 0, results: [result] });
  };

  // 模拟识别引擎报错（比如连续多次 "no-speech"，代表根本没收到麦克风声音）。
  window.__emitRecognitionError = (code) => {
    const rec = window.__fakeRecognitions[window.__fakeRecognitions.length - 1];
    if (!rec || !rec.onerror) return;
    rec.onerror({ error: code });
  };
`;

const UNSUPPORTED_BROWSER_SCRIPT = `
  window.SpeechRecognition = undefined;
  window.webkitSpeechRecognition = undefined;
`;

/** 拦截 Claude API：预检 OPTIONS 和正式 POST 都要带 CORS 头，浏览器才会放行跨域响应给 fetch()。 */
async function mockClaudeApi(page, replyText) {
  await page.route("https://api.anthropic.com/v1/messages", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access",
        },
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ content: [{ type: "text", text: replyText }] }),
    });
  });
}

async function setApiKey(page, key) {
  await goToModule(page, "数据与设置");
  const input = page.locator(".card", { hasText: "AI 服务密钥" }).locator("input[type=password]");
  await input.fill(key);
  await page.locator(".card", { hasText: "AI 服务密钥" }).locator("button", { hasText: "保存" }).click();
}

// 三家翻译服务的请求都带自定义请求头或 JSON content-type，属于"非简单请求"，
// 真实浏览器会先发一次 OPTIONS 预检，预检和正式响应都要带上 CORS 头，fetch() 才能
// 拿到响应内容——跟 mockClaudeApi 是同一个道理，只是每家允许的请求头不一样。
async function fulfillWithCors(route, body, extraHeaders) {
  if (route.request().method() === "OPTIONS") {
    await route.fulfill({
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type, ocp-apim-subscription-key, ocp-apim-subscription-region, authorization",
      },
    });
    return;
  }
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*", ...(extraHeaders || {}) },
    body: JSON.stringify(body),
  });
}

/** 拦截三家翻译服务里的一家；每家的真实 URL/方法都不一样，按 provider 分别处理。 */
async function mockTranslateApi(page, provider, translatedTexts) {
  const texts = Array.isArray(translatedTexts) ? translatedTexts : [translatedTexts];
  if (provider === "google") {
    await page.route("https://translation.googleapis.com/language/translate/v2**", (route) =>
      fulfillWithCors(route, { data: { translations: texts.map((t) => ({ translatedText: t })) } })
    );
    return;
  }
  if (provider === "azure") {
    await page.route("https://api.cognitive.microsofttranslator.com/translate**", (route) =>
      fulfillWithCors(route, texts.map((t) => ({ translations: [{ text: t, to: "en" }] })))
    );
    return;
  }
  if (provider === "deepl") {
    await page.route("https://api-free.deepl.com/v2/translate", (route) =>
      fulfillWithCors(route, { translations: texts.map((t) => ({ text: t })) })
    );
    return;
  }
  throw new Error("不认识的 provider: " + provider);
}

/** 在「数据与设置」的「多语言互译服务」卡片里，切到某一家并填好它要求的字段。 */
async function setTranslationProvider(page, provider, { apiKey, region } = {}) {
  await goToModule(page, "数据与设置");
  const providerLabels = { google: "Google 翻译", azure: "Azure Translator", deepl: "DeepL" };
  const card = page.locator(".card", { hasText: "多语言互译服务" });
  await card.locator(".tab-btn", { hasText: providerLabels[provider] }).click();
  const row = card.locator(`[data-provider="${provider}"]`);
  if (apiKey !== undefined) await row.locator("input[type=password]").fill(apiKey);
  if (region !== undefined) await row.locator("input[type=text]").fill(region);
  await row.locator("button", { hasText: "保存" }).click();
}

/** 在「数据与设置」的「语音转文字服务」卡片里，切到某一家并填好它要求的字段——
 * 跟 setTranslationProvider 是同一套写法，用于"整体重新识别"相关测试。 */
async function setSttProvider(page, provider, { apiKey, region } = {}) {
  await goToModule(page, "数据与设置");
  const providerLabels = { google: "Google Speech-to-Text", azure: "Azure AI Speech" };
  const card = page.locator(".card", { hasText: "语音转文字服务" });
  await card.locator(".tab-btn", { hasText: providerLabels[provider] }).click();
  const row = card.locator(`[data-provider="${provider}"]`);
  if (apiKey !== undefined) await row.locator("input[type=password]").fill(apiKey);
  if (region !== undefined) await row.locator("input[type=text]").fill(region);
  await row.locator("button", { hasText: "保存" }).click();
}

/** 拦截 Google/Azure 语音识别接口，跟 mockTranslateApi 是同一个道理：每次识别请求
 * 都回同一段固定文字，模拟"整段音频不管切成几段，全部识别成功"。 */
async function mockSttApi(page, provider, transcript) {
  if (provider === "google") {
    await page.route("https://speech.googleapis.com/v1/speech:recognize**", (route) =>
      fulfillWithCors(route, { results: [{ alternatives: [{ transcript }] }] })
    );
    return;
  }
  if (provider === "azure") {
    await page.route(/^https:\/\/[^/]+\.stt\.speech\.microsoft\.com\//, (route) =>
      fulfillWithCors(route, { RecognitionStatus: "Success", DisplayText: transcript })
    );
    return;
  }
  throw new Error("不认识的 provider: " + provider);
}

/** 拦截 Claude API，跟 mockClaudeApi 一样，但把每次真正发出的请求体记到 captured.body 里，
 * 用来验证"生成笔记时材料有没有被正确塞进提示词/图片内容块"这类需要检查请求内容的场景。 */
async function mockClaudeApiCapturing(page, replyText, captured) {
  await page.route("https://api.anthropic.com/v1/messages", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access",
        },
      });
      return;
    }
    captured.body = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ content: [{ type: "text", text: replyText }] }),
    });
  });
}

// ---------- 测试专用：手搓一个最小够用的 ZIP 打包器，造一份假 .pptx 文件用来测材料上传
// （跟 tests/pptxText.test.js 里的是同一套写法，这里只需要最简单的"不压缩"(method 0)
// 就够了，不需要再额外测一遍 deflate 解压——那部分 pptxText.test.js 已经单独覆盖过）。

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; }

function buildFakePptx(slidesText) {
  const files = slidesText.map((text, i) => ({
    name: `ppt/slides/slide${i + 1}.xml`,
    data: Buffer.from(
      `<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>`,
      "utf-8"
    ),
  }));

  const localParts = [];
  const centralParts = [];
  let offset = 0;
  files.forEach((f) => {
    const nameBuf = Buffer.from(f.name, "utf-8");
    const localHeader = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(f.data.length), u32(f.data.length),
      u16(nameBuf.length), u16(0), nameBuf,
    ]);
    localParts.push(localHeader, f.data);
    centralParts.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(f.data.length), u32(f.data.length),
      u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset), nameBuf,
    ]));
    offset += localHeader.length + f.data.length;
  });
  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralBuf.length), u32(localBuf.length), u16(0),
  ]);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

// 跟 buildFakePptx 是同一套最简单的"不压缩"ZIP 打包逻辑，只是换成 .docx 只有唯一一个
// word/document.xml 文件、内容按 <w:p>/<w:t> 段落包裹，用来测 Word 文档材料上传。
function buildFakeDocx(paragraphs) {
  const xml =
    `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>` +
    paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join("") +
    `</w:body></w:document>`;
  const files = [{ name: "word/document.xml", data: Buffer.from(xml, "utf-8") }];

  const localParts = [];
  const centralParts = [];
  let offset = 0;
  files.forEach((f) => {
    const nameBuf = Buffer.from(f.name, "utf-8");
    const localHeader = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(f.data.length), u32(f.data.length),
      u16(nameBuf.length), u16(0), nameBuf,
    ]);
    localParts.push(localHeader, f.data);
    centralParts.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(f.data.length), u32(f.data.length),
      u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset), nameBuf,
    ]));
    offset += localHeader.length + f.data.length;
  });
  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralBuf.length), u32(localBuf.length), u16(0),
  ]);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

// 1x1 透明像素的最小合法 PNG，用来测拍照材料上传，不需要真的截一张图。
const FAKE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function startNewRecording(page, { title = "", targetLangLabel } = {}) {
  await goToModule(page, "课堂笔记");
  await page.locator("button", { hasText: "+ 新建课堂笔记" }).click();
  if (title) await page.locator(".modal-box input[type=text]").fill(title);
  if (targetLangLabel) {
    await page.locator(".modal-box .toggle-row", { hasText: targetLangLabel }).locator("input").check();
  }
  await page.locator(".modal-box button", { hasText: "开始录音" }).click();
  await assert.doesNotReject(page.locator(".card-title", { hasText: title || "未命名笔记" }).waitFor());
}

before(async () => {
  browser = await chromium.launch({ args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
});

after(async () => {
  await browser.close();
});

beforeEach(async () => {
  context = await browser.newContext();
  await context.addInitScript(FAKE_BROWSER_APIS_SCRIPT);
  page = await context.newPage();
  await gotoApp(page);
});

afterEach(async () => {
  await context.close();
});

describe("课堂笔记：浏览器不支持时的提示", () => {
  test("没有语音识别能力时，提示不支持并禁用新建按钮", async () => {
    await context.addInitScript(UNSUPPORTED_BROWSER_SCRIPT);
    const page2 = await context.newPage();
    await gotoApp(page2);
    await goToModule(page2, "课堂笔记");
    await assert.doesNotReject(page2.locator(".empty-hint", { hasText: "当前浏览器不支持录音转文字" }).waitFor());
    await assert.equal(await page2.locator("button", { hasText: "+ 新建课堂笔记" }).isDisabled(), true);
  });
});

describe("课堂笔记：录音转文字", () => {
  test("新建笔记、说话产生转录、结束录音后转录内容保留在详情页", async () => {
    await startNewRecording(page, { title: "经济学导论 第3讲" });

    await page.evaluate((text) => window.__emitTranscript(text, true), "Bonjour à tous");
    await assert.doesNotReject(page.locator(".record-transcript-list", { hasText: "Bonjour à tous" }).waitFor());

    await page.evaluate((text) => window.__emitTranscript(text, true), "Aujourd'hui on va parler");
    await assert.doesNotReject(page.locator(".record-transcript-list", { hasText: "Aujourd'hui on va parler" }).waitFor());

    await page.locator("button", { hasText: "结束录音" }).click();
    await assert.doesNotReject(page.locator(".tabs", { hasText: "转录" }).waitFor());

    // 结束录音后默认跳到"转录" tab，两句话应该都还在。
    const transcriptCard = page.locator(".content-area .card").last();
    await assert.doesNotReject(page.locator("body", { hasText: "Bonjour à tous" }).waitFor());
    assert.match(await page.locator(".content-area").innerText(), /Bonjour à tous/);
    assert.match(await page.locator(".content-area").innerText(), /Aujourd'hui on va parler/);

    // 回列表页应该能看到这条笔记，状态是"待生成笔记"。
    await page.locator("button", { hasText: "← 返回列表" }).click();
    const card = page.locator(".card", { hasText: "经济学导论 第3讲" });
    await assert.doesNotReject(card.waitFor());
    assert.match(await card.innerText(), /待生成笔记/);
  });

  test("交替出现临时结果和最终结果时，只有最终结果会被记入转录列表", async () => {
    await startNewRecording(page);
    await page.evaluate(() => window.__emitTranscript("正在说的半句话", false));
    await assert.doesNotReject(page.locator(".record-caption", { hasText: "正在说的半句话" }).waitFor());
    assert.equal(await page.locator(".record-transcript-list .list-row").count(), 0);

    await page.evaluate(() => window.__emitTranscript("说完的一整句话", true));
    await assert.doesNotReject(page.locator(".record-transcript-list", { hasText: "说完的一整句话" }).waitFor());
    assert.equal(await page.locator(".record-transcript-list .list-row").count(), 1);
  });

  test("暂停后可以继续录音", async () => {
    await startNewRecording(page);
    await assert.doesNotReject(page.locator("button", { hasText: "暂停" }).waitFor());
    await page.locator("button", { hasText: "暂停" }).click();
    await assert.doesNotReject(page.locator("text=已暂停").waitFor());
    await page.locator("button", { hasText: "继续" }).click();
    await assert.doesNotReject(page.locator("text=录音中…").waitFor());
  });

  test("没有设置 AI 密钥时，没有转录内容也无法生成笔记/翻译", async () => {
    await startNewRecording(page, { title: "没有密钥的笔记" });
    await page.locator("button", { hasText: "结束录音" }).click();
    // 现场没识别到任何内容，但录音文件还在——这正是"整体重新识别"要救回来的场景
    // （见需求 #4），所以转录 tab 不应该是死路一条的"还没有转录内容"，而是给出
    // "整体重新识别"的入口（这里因为还没配置语音识别服务的 key，按钮是禁用的）。
    await assert.doesNotReject(page.locator(".card", { hasText: "整体重新识别" }).waitFor());
    await assert.doesNotReject(page.locator(".content-area", { hasText: "还没配置当前使用的语音识别服务" }).first().waitFor());
    assert.equal(await page.locator("button", { hasText: "开始整体重新识别" }).isDisabled(), true);

    await page.locator(".tabs .tab-btn", { hasText: "笔记" }).click();
    await assert.doesNotReject(page.locator(".content-area", { hasText: "还没设置 AI 服务密钥" }).first().waitFor());
    assert.equal(await page.locator("button", { hasText: "生成笔记" }).isDisabled(), true);
  });
});

describe("课堂笔记：完全没收到声音时的提示（连续 no-speech）", () => {
  test("连续两次 no-speech 会显示检查麦克风的提示，之后识别到真实语音会自动消失", async () => {
    await startNewRecording(page, { title: "静音测试" });

    await page.evaluate(() => window.__emitRecognitionError("no-speech"));
    assert.doesNotMatch(await page.locator(".content-area").innerText(), /检查一下麦克风/);

    await page.evaluate(() => window.__emitRecognitionError("no-speech"));
    await assert.doesNotReject(page.locator(".content-area", { hasText: "检查一下麦克风" }).waitFor());

    await page.evaluate(() => window.__emitTranscript("终于说话了", true));
    await assert.doesNotReject(page.locator(".record-transcript-list", { hasText: "终于说话了" }).waitFor());
    const text = await page.locator(".content-area").innerText();
    assert.doesNotMatch(text, /检查一下麦克风/);
  });

  test("单次 no-speech（正常讲课停顿）不会触发提示", async () => {
    await startNewRecording(page, { title: "偶尔停顿测试" });
    await page.evaluate(() => window.__emitRecognitionError("no-speech"));
    await page.evaluate(() => window.__emitTranscript("停顿之后继续说", true));
    await assert.doesNotReject(page.locator(".record-transcript-list", { hasText: "停顿之后继续说" }).waitFor());
    assert.doesNotMatch(await page.locator(".content-area").innerText(), /检查一下麦克风/);
  });
});

describe("课堂笔记：AI 整理笔记", () => {
  test("生成笔记后，笔记 tab 里正确渲染标题和列表", async () => {
    await setApiKey(page, "sk-test-key");
    await startNewRecording(page, { title: "AI整理笔记测试" });
    await page.evaluate(() => window.__emitTranscript("Bonjour à tous, aujourd'hui on parle d'économie.", true));
    await assert.doesNotReject(page.locator(".record-transcript-list", { hasText: "Bonjour" }).waitFor());
    await page.locator("button", { hasText: "结束录音" }).click();

    await mockClaudeApi(page, "## 课堂要点\n- 第一个要点\n- 第二个要点\n\n> Bonjour à tous");

    await page.locator(".tabs .tab-btn", { hasText: "笔记" }).click();
    await page.locator("button", { hasText: "生成笔记" }).click();

    await assert.doesNotReject(page.locator(".note-md-heading", { hasText: "课堂要点" }).waitFor());
    assert.match(await page.locator(".note-markdown").innerText(), /第一个要点/);
    assert.match(await page.locator(".note-markdown").innerText(), /第二个要点/);

    // 生成过一次之后，按钮文字应该变成"重新整理笔记"。
    await assert.doesNotReject(page.locator("button", { hasText: "重新整理笔记" }).waitFor());
  });

  test("AI 服务返回错误时，显示错误提示且不清空原有笔记", async () => {
    await setApiKey(page, "sk-test-key");
    await startNewRecording(page, { title: "AI报错测试" });
    await page.evaluate(() => window.__emitTranscript("一句话", true));
    await page.locator("button", { hasText: "结束录音" }).click();

    await page.route("https://api.anthropic.com/v1/messages", async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" } });
        return;
      }
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ error: { message: "invalid api key" } }),
      });
    });

    await page.locator(".tabs .tab-btn", { hasText: "笔记" }).click();
    await page.locator("button", { hasText: "生成笔记" }).click();
    await assert.doesNotReject(page.locator(".content-area", { hasText: "密钥无效或没有权限" }).first().waitFor());
  });
});

describe("课堂笔记：AI 整理出的笔记正文也能再翻译成其它语言", () => {
  test("没有目标互译语言时，笔记 tab 不出现语言切换胶囊", async () => {
    await setApiKey(page, "sk-test-key");
    await startNewRecording(page, { title: "没选互译语言的笔记" });
    await page.evaluate(() => window.__emitTranscript("一句话", true));
    await page.locator("button", { hasText: "结束录音" }).click();
    await mockClaudeApi(page, "# 笔记标题\n正文");
    await page.locator(".tabs .tab-btn", { hasText: "笔记" }).click();
    await page.locator("button", { hasText: "生成笔记" }).click();
    await assert.doesNotReject(page.locator(".note-markdown", { hasText: "笔记标题" }).waitFor());
    assert.equal(await page.locator(".content-area .pill-group").count(), 0);
  });

  test("还没生成原文笔记时，切到目标语言看到提示、翻译按钮禁用", async () => {
    await setApiKey(page, "sk-test-key");
    await startNewRecording(page, { title: "还没生成笔记", targetLangLabel: "中文" });
    await page.evaluate(() => window.__emitTranscript("一句话", true));
    await page.locator("button", { hasText: "结束录音" }).click();
    await page.locator(".tabs .tab-btn", { hasText: "笔记" }).click();
    await page.locator(".content-area .pill-group .pill", { hasText: "中文" }).click();
    await assert.doesNotReject(page.locator(".content-area", { hasText: "先在「原文」里生成笔记" }).waitFor());
    assert.equal(await page.locator("button", { hasText: "翻译成中文" }).isDisabled(), true);
  });

  test("生成原文笔记后，可以把笔记翻译成目标语言，原文和译文互不覆盖", async () => {
    await setApiKey(page, "sk-test-key");
    await setTranslationProvider(page, "google", { apiKey: "google-test-key" });
    await startNewRecording(page, { title: "笔记多语言测试", targetLangLabel: "中文" });
    await page.evaluate(() => window.__emitTranscript("一句话", true));
    await page.locator("button", { hasText: "结束录音" }).click();

    await mockClaudeApi(page, "# 课堂要点\n- 第一点");
    await page.locator(".tabs .tab-btn", { hasText: "笔记" }).click();
    await page.locator("button", { hasText: "生成笔记" }).click();
    await assert.doesNotReject(page.locator(".note-markdown", { hasText: "课堂要点" }).waitFor());

    await mockTranslateApi(page, "google", "# 课堂要点\n- 第一点（中文）");
    await page.locator(".content-area .pill-group .pill", { hasText: "中文" }).click();
    await page.locator("button", { hasText: "翻译成中文" }).click();
    await assert.doesNotReject(page.locator(".note-markdown", { hasText: "第一点（中文）" }).waitFor());

    // 切回原文，原文没有被译文覆盖。
    await page.locator(".content-area .pill-group .pill", { hasText: "原文" }).click();
    await assert.doesNotReject(page.locator(".note-markdown", { hasText: "课堂要点" }).waitFor());
    assert.doesNotMatch(await page.locator(".note-markdown").innerText(), /中文/);

    // 再切回中文，之前翻译好的内容还在（不用重新翻译），按钮文字变成"重新翻译"。
    await page.locator(".content-area .pill-group .pill", { hasText: "中文" }).click();
    await assert.doesNotReject(page.locator("button", { hasText: "重新翻译成中文" }).waitFor());
  });
});

describe("课堂笔记：AI 根据笔记生成闪卡", () => {
  test("还没生成原文笔记时，闪卡 tab 显示提示、生成按钮禁用", async () => {
    await setApiKey(page, "sk-test-key");
    await startNewRecording(page, { title: "还没生成笔记-闪卡" });
    await page.evaluate(() => window.__emitTranscript("一句话", true));
    await page.locator("button", { hasText: "结束录音" }).click();
    await page.locator(".tabs .tab-btn", { hasText: "闪卡" }).click();
    await assert.doesNotReject(page.locator(".content-area", { hasText: "先在「笔记」tab 生成笔记" }).waitFor());
    assert.equal(await page.locator("button", { hasText: "生成闪卡" }).isDisabled(), true);
  });

  test("生成笔记后可以生成闪卡，能翻页、点击卡片查看答案", async () => {
    await setApiKey(page, "sk-test-key");
    await startNewRecording(page, { title: "闪卡测试" });
    await page.evaluate(() => window.__emitTranscript("一句话", true));
    await page.locator("button", { hasText: "结束录音" }).click();

    await mockClaudeApi(page, "# 课堂要点\n- 第一点");
    await page.locator(".tabs .tab-btn", { hasText: "笔记" }).click();
    await page.locator("button", { hasText: "生成笔记" }).click();
    await assert.doesNotReject(page.locator(".note-markdown", { hasText: "课堂要点" }).waitFor());

    await mockClaudeApi(page, JSON.stringify([
      { q: "第一题问题", a: "第一题答案" },
      { q: "第二题问题", a: "第二题答案" },
    ]));
    await page.locator(".tabs .tab-btn", { hasText: "闪卡" }).click();
    await page.locator("button", { hasText: "生成闪卡" }).click();
    await assert.doesNotReject(page.locator(".flashcard-card", { hasText: "第一题问题" }).waitFor());
    assert.doesNotMatch(await page.locator(".flashcard-card").innerText(), /第一题答案/);

    // 点击卡片翻到答案那一面
    await page.locator(".flashcard-card").click();
    await assert.doesNotReject(page.locator(".flashcard-card", { hasText: "第一题答案" }).waitFor());

    // 翻到下一张：换了新问题，且不会带着上一张"已翻开"的状态
    await page.locator("button", { hasText: "下一张" }).click();
    await assert.doesNotReject(page.locator(".flashcard-card", { hasText: "第二题问题" }).waitFor());
    assert.doesNotMatch(await page.locator(".flashcard-card").innerText(), /第二题答案/);

    await page.locator("button", { hasText: "上一张" }).click();
    await assert.doesNotReject(page.locator(".flashcard-card", { hasText: "第一题问题" }).waitFor());
  });

  test("AI 服务返回错误时，显示错误提示，按钮恢复可点", async () => {
    await setApiKey(page, "sk-test-key");
    await startNewRecording(page, { title: "闪卡报错测试" });
    await page.evaluate(() => window.__emitTranscript("一句话", true));
    await page.locator("button", { hasText: "结束录音" }).click();
    await mockClaudeApi(page, "# 笔记标题\n正文");
    await page.locator(".tabs .tab-btn", { hasText: "笔记" }).click();
    await page.locator("button", { hasText: "生成笔记" }).click();
    await assert.doesNotReject(page.locator(".note-markdown", { hasText: "笔记标题" }).waitFor());

    // 返回的不是合法 JSON，解析不出任何一张卡片。
    await mockClaudeApi(page, "抱歉，我没法生成闪卡。");
    await page.locator(".tabs .tab-btn", { hasText: "闪卡" }).click();
    await page.locator("button", { hasText: "生成闪卡" }).click();
    await assert.doesNotReject(page.locator(".content-area", { hasText: "没有生成出可用的闪卡" }).waitFor());
    assert.equal(await page.locator("button", { hasText: "生成闪卡" }).isDisabled(), false);
  });
});

describe("课堂笔记：AI 根据笔记生成测验", () => {
  test("还没生成原文笔记时，测验 tab 显示提示、生成按钮禁用", async () => {
    await setApiKey(page, "sk-test-key");
    await startNewRecording(page, { title: "还没生成笔记-测验" });
    await page.evaluate(() => window.__emitTranscript("一句话", true));
    await page.locator("button", { hasText: "结束录音" }).click();
    await page.locator(".tabs .tab-btn", { hasText: "测验" }).click();
    await assert.doesNotReject(page.locator(".content-area", { hasText: "先在「笔记」tab 生成笔记" }).waitFor());
    assert.equal(await page.locator("button", { hasText: "生成测验" }).isDisabled(), true);
  });

  test("生成测验后选对/选错分别标绿/标红，改选也会跟着更新", async () => {
    await setApiKey(page, "sk-test-key");
    await startNewRecording(page, { title: "测验测试" });
    await page.evaluate(() => window.__emitTranscript("一句话", true));
    await page.locator("button", { hasText: "结束录音" }).click();

    await mockClaudeApi(page, "# 课堂要点\n- 第一点");
    await page.locator(".tabs .tab-btn", { hasText: "笔记" }).click();
    await page.locator("button", { hasText: "生成笔记" }).click();
    await assert.doesNotReject(page.locator(".note-markdown", { hasText: "课堂要点" }).waitFor());

    await mockClaudeApi(page, JSON.stringify([
      { question: "1+1=?", options: ["1", "2", "3", "4"], correctIndex: 1 },
    ]));
    await page.locator(".tabs .tab-btn", { hasText: "测验" }).click();
    await page.locator("button", { hasText: "生成测验" }).click();
    await assert.doesNotReject(page.locator(".content-area", { hasText: "1+1=?" }).waitFor());

    const options = page.locator(".card .quiz-option");
    await assert.doesNotReject(options.nth(3).waitFor());

    // 选错误答案"1"（下标0）
    await options.nth(0).click();
    assert.match(await options.nth(0).getAttribute("class"), /quiz-option-wrong/);
    assert.match(await options.nth(1).getAttribute("class"), /quiz-option-correct/);

    // 改选正确答案"2"（下标1）：之前标红的选项恢复正常
    await options.nth(1).click();
    assert.match(await options.nth(1).getAttribute("class"), /quiz-option-correct/);
    assert.doesNotMatch(await options.nth(0).getAttribute("class"), /quiz-option-wrong/);
  });
});

describe("课堂笔记：针对笔记内容提问", () => {
  test("还没生成原文笔记时，提问框禁用、显示提示", async () => {
    await setApiKey(page, "sk-test-key");
    await startNewRecording(page, { title: "还没生成笔记-提问" });
    await page.evaluate(() => window.__emitTranscript("一句话", true));
    await page.locator("button", { hasText: "结束录音" }).click();
    await page.locator(".tabs .tab-btn", { hasText: "提问" }).click();
    await assert.doesNotReject(page.locator(".content-area", { hasText: "先在「笔记」tab 生成笔记" }).waitFor());
    assert.equal(await page.locator('input[placeholder="问一个关于这条笔记的问题…"]').isDisabled(), true);
  });

  test("生成笔记后可以提问，AI 根据笔记内容回答，多轮问答都保留在列表里", async () => {
    await setApiKey(page, "sk-test-key");
    await startNewRecording(page, { title: "提问测试" });
    await page.evaluate(() => window.__emitTranscript("一句话", true));
    await page.locator("button", { hasText: "结束录音" }).click();

    await mockClaudeApi(page, "# 课堂要点\n- 光合作用需要光照");
    await page.locator(".tabs .tab-btn", { hasText: "笔记" }).click();
    await page.locator("button", { hasText: "生成笔记" }).click();
    await assert.doesNotReject(page.locator(".note-markdown", { hasText: "光合作用" }).waitFor());

    await page.locator(".tabs .tab-btn", { hasText: "提问" }).click();
    const input = page.locator('input[placeholder="问一个关于这条笔记的问题…"]');

    await mockClaudeApi(page, "光合作用需要光照、水和二氧化碳。");
    await input.fill("光合作用需要什么？");
    await page.locator("button", { hasText: "发送" }).click();
    await assert.doesNotReject(page.locator(".qa-bubble-user", { hasText: "光合作用需要什么？" }).waitFor());
    await assert.doesNotReject(page.locator(".qa-bubble-assistant", { hasText: "光合作用需要光照" }).waitFor());

    // 追问一次，之前的问答记录还在（用来验证历史记录会带进下一次提问的上下文）。
    await mockClaudeApi(page, "水是必需的，缺水植物没法进行光合作用。");
    await input.fill("那水呢？");
    await page.locator("button", { hasText: "发送" }).click();
    await assert.doesNotReject(page.locator(".qa-bubble-user", { hasText: "那水呢？" }).waitFor());
    await assert.doesNotReject(page.locator(".qa-bubble-assistant", { hasText: "水是必需的" }).waitFor());
    assert.equal(await page.locator(".qa-bubble-user").count(), 2);
    assert.equal(await page.locator(".qa-bubble-assistant").count(), 2);
  });
});

describe("课堂笔记：多语言互译（转录 tab 里原文+译文合并显示，不再单独分翻译 tab）", () => {
  test("没有配置当前使用的翻译服务时，翻译按钮禁用并提示去设置", async () => {
    await startNewRecording(page, { title: "没配置翻译服务的笔记", targetLangLabel: "中文" });
    await page.evaluate(() => window.__emitTranscript("Bonjour à tous", true));
    await page.locator("button", { hasText: "结束录音" }).click();
    // 结束录音后默认就停在"转录" tab，不需要再点别的 tab。
    await assert.doesNotReject(page.locator(".content-area", { hasText: "还没配置当前使用的翻译服务" }).first().waitFor());
    assert.match(await page.locator(".content-area").innerText(), /Google 翻译/);
    assert.equal(await page.locator("button", { hasText: "翻译成中文" }).isDisabled(), true);
  });

  test("默认用 Google 翻译：结束录音时会自动补翻还没翻译的内容，原文译文同一个格子里", async () => {
    await setTranslationProvider(page, "google", { apiKey: "google-test-key" });
    await startNewRecording(page, { title: "互译测试", targetLangLabel: "中文" });
    // 提前把接口挡住，避免"结束录音"触发的自动翻译请求真的发出去打到公网。
    await mockTranslateApi(page, "google", "大家好");
    await page.evaluate(() => window.__emitTranscript("Bonjour à tous", true));
    await assert.doesNotReject(page.locator(".record-transcript-list", { hasText: "Bonjour à tous" }).waitFor());
    await page.locator("button", { hasText: "结束录音" }).click();

    // 不点任何按钮：结束录音本身就会把还没翻译的内容自动补翻一次；原文和译文应该都在
    // 详情页"转录"tab 的同一个格子里，不需要切去别的地方看。
    await assert.doesNotReject(page.locator(".content-area", { hasText: "Bonjour à tous" }).waitFor());
    await assert.doesNotReject(page.locator(".content-area .segment-translation", { hasText: "大家好" }).waitFor());
    // 已经翻完了，按钮应该显示"已翻译到最新"并禁用，而不是还停在"翻译成中文"。
    await assert.doesNotReject(page.locator("button", { hasText: "已翻译到最新" }).waitFor());
  });

  test("切到 Azure Translator 之后，自动翻译改用 Azure 的接口；切换服务商后可以整段重新翻译", async () => {
    await setTranslationProvider(page, "azure", { apiKey: "azure-test-key", region: "eastasia" });
    await startNewRecording(page, { title: "Azure互译测试", targetLangLabel: "英语" });
    await mockTranslateApi(page, "azure", "Hello everyone");
    await page.evaluate(() => window.__emitTranscript("你好，大家好", true));
    await assert.doesNotReject(page.locator(".record-transcript-list", { hasText: "你好，大家好" }).waitFor());
    await page.locator("button", { hasText: "结束录音" }).click();

    await assert.doesNotReject(page.locator(".content-area .segment-translation", { hasText: "Hello everyone" }).waitFor());

    // 换一家服务商之后，点"全部重新翻译"应该整段重新翻译（走 setClassNoteTranslation 整段替换）。
    await mockTranslateApi(page, "azure", "Hi everyone (redo)");
    await page.locator("button", { hasText: "全部重新翻译" }).click();
    await assert.doesNotReject(page.locator(".content-area .segment-translation", { hasText: "Hi everyone (redo)" }).waitFor());
  });

  test("切到 DeepL 之后翻译报错（密钥无效）时，显示错误提示且不清空原有内容", async () => {
    await setTranslationProvider(page, "deepl", { apiKey: "deepl-key:fx" });
    await startNewRecording(page, { title: "DeepL报错测试", targetLangLabel: "英语" });
    await page.evaluate(() => window.__emitTranscript("你好", true));
    await page.locator("button", { hasText: "结束录音" }).click();

    await page.route("https://api-free.deepl.com/v2/translate", async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({
          status: 204,
          headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization" },
        });
        return;
      }
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ message: "Invalid auth key" }),
      });
    });

    await page.locator("button", { hasText: "翻译成英语" }).click();
    await assert.doesNotReject(page.locator(".content-area", { hasText: "DeepL 密钥无效或没有权限" }).first().waitFor());
  });

  test("创建时没选互译语言，转录 tab 只显示原文，没有任何翻译相关的按钮或格子", async () => {
    await startNewRecording(page, { title: "没选语言测试" });
    await page.evaluate(() => window.__emitTranscript("Bonjour", true));
    await page.locator("button", { hasText: "结束录音" }).click();
    await assert.doesNotReject(page.locator(".content-area", { hasText: "Bonjour" }).waitFor());
    assert.equal(await page.locator(".segment-translation").count(), 0);
    assert.equal(await page.locator("button", { hasText: "翻译" }).count(), 0);
  });

  test("创建时没选互译语言，录音过程中可以随时补上——之前已经转录的内容会一起补翻", async () => {
    await setTranslationProvider(page, "google", { apiKey: "google-test-key" });
    await startNewRecording(page, { title: "中途加语言测试" });
    await page.evaluate(() => window.__emitTranscript("Bonjour à tous", true));
    await assert.doesNotReject(page.locator(".record-transcript-list", { hasText: "Bonjour à tous" }).waitFor());

    // 还没选互译语言时，录音页"实时转录"卡片上的按钮显示"+ 互译语言"。
    await page.locator("button", { hasText: "+ 互译语言" }).click();
    await page.locator(".modal-box .toggle-row", { hasText: "中文" }).locator("input").check();
    await page.locator(".modal-box button", { hasText: "保存" }).click();
    // 保存后按钮应该变成"编辑互译语言"，说明语言已经生效。
    await assert.doesNotReject(page.locator("button", { hasText: "编辑互译语言" }).waitFor());

    await mockTranslateApi(page, "google", "大家好");
    await page.locator("button", { hasText: "结束录音" }).click();

    // 中途才选的语言，之前（选语言之前）已经转录的那句话也应该被一起补翻，不会漏掉。
    await assert.doesNotReject(page.locator(".content-area", { hasText: "Bonjour à tous" }).waitFor());
    await assert.doesNotReject(page.locator(".content-area .segment-translation", { hasText: "大家好" }).waitFor());
  });

  test("笔记详情页（录音已结束）里也能随时补上/修改互译语言", async () => {
    await setTranslationProvider(page, "google", { apiKey: "google-test-key" });
    await startNewRecording(page, { title: "详情页加语言测试" });
    await page.evaluate(() => window.__emitTranscript("Guten Tag", true));
    await page.locator("button", { hasText: "结束录音" }).click();
    await assert.doesNotReject(page.locator(".content-area", { hasText: "Guten Tag" }).waitFor());
    assert.equal(await page.locator("button", { hasText: "翻译" }).count(), 0);

    await page.locator("button", { hasText: "编辑互译语言" }).click();
    await page.locator(".modal-box .toggle-row", { hasText: "英语" }).locator("input").check();
    await page.locator(".modal-box button", { hasText: "保存" }).click();

    await mockTranslateApi(page, "google", "Good day");
    await page.locator("button", { hasText: "翻译成英语" }).click();
    await assert.doesNotReject(page.locator(".content-area .segment-translation", { hasText: "Good day" }).waitFor());
  });
});

// 这是给"上课用"这个场景设计的核心功能：老师讲课的三小时里，用户不应该需要一直手动点
// 翻译按钮——每隔几秒会自动把新说的这一小段发去翻译，直接接在原文那一格下面显示（用户
// 明确要求原文和译文"在同一个格子里"，不要分成两块并排的区域）。
describe("课堂笔记：录音过程中自动实时翻译（不需要手动点按钮）", () => {
  test("配置好翻译服务、选了互译语言时，录音过程中新增的转录会自动翻译并接在原文下面同一格里", async () => {
    await setTranslationProvider(page, "google", { apiKey: "google-test-key" });
    await mockTranslateApi(page, "google", "大家好");
    await startNewRecording(page, { title: "自动翻译课堂测试", targetLangLabel: "中文" });

    await page.evaluate(() => window.__emitTranscript("Bonjour à tous", true));
    await assert.doesNotReject(page.locator(".record-transcript-list", { hasText: "Bonjour à tous" }).waitFor());

    // 全程不点任何按钮——只是等待自动翻译的间隔过去，译文应该直接出现在原文那一格下面。
    await assert.doesNotReject(
      page.locator(".record-transcript-list .segment-translation", { hasText: "大家好" }).waitFor({ timeout: 15000 })
    );

    // 结束录音后，详情页也应该已经是最新的，不需要再手动翻一次。
    await page.locator("button", { hasText: "结束录音" }).click();
    await assert.doesNotReject(page.locator(".content-area", { hasText: "大家好" }).waitFor());
  });

  test("选了互译语言但还没配置翻译服务时，录音页照常显示实时转录，提示去配置、不会报错", async () => {
    await startNewRecording(page, { title: "没配置服务的自动翻译测试", targetLangLabel: "英语" });
    await page.evaluate(() => window.__emitTranscript("你好，大家好", true));
    await assert.doesNotReject(page.locator(".record-transcript-list", { hasText: "你好，大家好" }).waitFor());

    const recordCard = page.locator(".card", { hasText: "实时转录" });
    await assert.doesNotReject(recordCard.waitFor());
    assert.match(await recordCard.innerText(), /还没配置当前使用的翻译服务/);

    await page.locator("button", { hasText: "结束录音" }).click();
    await assert.doesNotReject(page.locator(".tabs", { hasText: "转录" }).waitFor());
  });
});

describe("课堂笔记：整体重新识别（录音结束后用云端语音识别服务重新整段识别一遍）", () => {
  test("没有配置语音识别密钥时，「重新识别」栏显示提示、按钮禁用", async () => {
    await startNewRecording(page, { title: "还没配置识别服务的课" });
    await page.evaluate(() => window.__emitTranscript("实时识别的内容", true));
    await page.locator("button", { hasText: "结束录音" }).click();

    await page.locator(".tabs .tab-btn", { hasText: "转录" }).click();
    await page.locator(".content-area .pill-group .pill", { hasText: "重新识别" }).click();
    await assert.doesNotReject(page.locator(".content-area", { hasText: "还没配置当前使用的语音识别服务" }).waitFor());
    await assert.equal(await page.locator("button", { hasText: "开始整体重新识别" }).isDisabled(), true);
  });

  test("配置好 Google 语音识别密钥后，能生成重新识别结果，并且能跟实时识别切换对比", async () => {
    await mockSttApi(page, "google", "整体重新识别出来的完整内容。");
    await setSttProvider(page, "google", { apiKey: "fake-google-speech-key" });

    await startNewRecording(page, { title: "重新识别课" });
    await page.evaluate(() => window.__emitTranscript("实时识别的内容", true));
    await page.locator("button", { hasText: "结束录音" }).click();

    await page.locator(".tabs .tab-btn", { hasText: "转录" }).click();
    await assert.doesNotReject(page.locator(".content-area", { hasText: "实时识别的内容" }).waitFor());

    await page.locator(".content-area .pill-group .pill", { hasText: "重新识别" }).click();
    await page.locator("button", { hasText: "开始整体重新识别" }).click();
    await assert.doesNotReject(
      page.locator(".content-area", { hasText: "整体重新识别出来的完整内容。" }).waitFor({ timeout: 10000 })
    );

    // 切回"实时识别"，原来那份内容还在、没有被覆盖掉。
    await page.locator(".content-area .pill-group .pill", { hasText: "实时识别" }).click();
    await assert.doesNotReject(page.locator(".content-area", { hasText: "实时识别的内容" }).waitFor());
    assert.equal(await page.locator(".content-area", { hasText: "整体重新识别出来的完整内容。" }).count(), 0);

    // 再切回"重新识别"，结果还保留着，不需要重新生成。
    await page.locator(".content-area .pill-group .pill", { hasText: "重新识别" }).click();
    await assert.doesNotReject(page.locator(".content-area", { hasText: "整体重新识别出来的完整内容。" }).waitFor());
    await assert.doesNotReject(page.locator("button", { hasText: "重新生成" }).waitFor());
  });

  test("识别服务返回错误时，显示错误提示，按钮恢复可点，不会污染已有内容", async () => {
    await page.route("https://speech.googleapis.com/v1/speech:recognize**", async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "POST, OPTIONS",
            "access-control-allow-headers": "content-type",
          },
        });
        return;
      }
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ error: { message: "密钥无效" } }),
      });
    });
    await setSttProvider(page, "google", { apiKey: "bad-key" });

    await startNewRecording(page, { title: "识别失败的课" });
    await page.evaluate(() => window.__emitTranscript("实时识别的内容", true));
    await page.locator("button", { hasText: "结束录音" }).click();

    await page.locator(".tabs .tab-btn", { hasText: "转录" }).click();
    await page.locator(".content-area .pill-group .pill", { hasText: "重新识别" }).click();
    await page.locator("button", { hasText: "开始整体重新识别" }).click();

    await assert.doesNotReject(page.locator(".content-area", { hasText: "密钥无效" }).waitFor());
    await assert.equal(await page.locator("button", { hasText: "开始整体重新识别" }).isDisabled(), false);
  });

  test("重新识别出的内容也能翻译成目标语言，用的是同一套多语言互译服务", async () => {
    await mockSttApi(page, "google", "Bonjour à tous.");
    await setSttProvider(page, "google", { apiKey: "fake-google-speech-key" });
    await setTranslationProvider(page, "google", { apiKey: "fake-translate-key" });
    await mockTranslateApi(page, "google", "大家好。");

    await startNewRecording(page, { title: "重新识别+翻译课", targetLangLabel: "中文" });
    await page.evaluate(() => window.__emitTranscript("实时识别内容", true));
    await page.locator("button", { hasText: "结束录音" }).click();

    await page.locator(".tabs .tab-btn", { hasText: "转录" }).click();
    await page.locator(".content-area .pill-group .pill", { hasText: "重新识别" }).click();
    await page.locator("button", { hasText: "开始整体重新识别" }).click();
    await assert.doesNotReject(page.locator(".content-area", { hasText: "Bonjour à tous." }).waitFor({ timeout: 10000 }));

    await page.locator(".content-area button", { hasText: "翻译成中文" }).click();
    await assert.doesNotReject(page.locator(".content-area", { hasText: "大家好。" }).waitFor());
  });
});

// 新功能：上传一份已经在别的地方录好的音频文件（比如手机备忘录、会议/讲座录音），
// 不走"现场录音+实时识别"这条路，直接生成一条笔记、之后靠"整体重新识别"（复用同一套
// 云端语音识别服务）转出文字——这条笔记天生没有"实时识别"内容，转录 tab 应该直接停在
// "重新识别"栏，不应该出现一个空的"实时识别"可切换。
describe("课堂笔记：上传录音文件生成笔记（不现场录音，走整体识别流程）", () => {
  test("上传录音文件后直接进入详情页的转录 tab，只有「重新识别」一栏，没有「实时识别」", async () => {
    await goToModule(page, "课堂笔记");
    await page.locator("button", { hasText: "+ 上传录音文件生成笔记" }).click();
    await page.locator(".modal-box input[type=text]").fill("会议录音");
    await page.locator(".modal-box input[type=file]").setInputFiles({
      name: "meeting.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("fake-audio-bytes"),
    });
    await page.locator(".modal-box button", { hasText: "生成笔记" }).click();

    // 应该直接落在这条笔记的详情页，转录 tab 是当前激活的 tab。
    await assert.doesNotReject(page.locator(".card-title", { hasText: "会议录音" }).waitFor());
    await assert.doesNotReject(page.locator(".tabs .tab-btn.active", { hasText: "转录" }).waitFor());
    // 没有"实时识别"/"重新识别"这个切换胶囊——因为压根没有实时识别内容可切。
    assert.equal(await page.locator(".content-area .pill-group .pill", { hasText: "实时识别" }).count(), 0);
    await assert.doesNotReject(page.locator("button", { hasText: "开始整体重新识别" }).waitFor());
  });

  test("配置好语音识别密钥后，可以在详情页里把上传的录音识别成文字", async () => {
    await mockSttApi(page, "google", "这是一段上传的录音识别出来的内容。");
    await setSttProvider(page, "google", { apiKey: "fake-google-speech-key" });

    await goToModule(page, "课堂笔记");
    await page.locator("button", { hasText: "+ 上传录音文件生成笔记" }).click();
    await page.locator(".modal-box input[type=text]").fill("讲座录音");
    await page.locator(".modal-box input[type=file]").setInputFiles({
      name: "lecture.m4a", mimeType: "audio/mp4", buffer: Buffer.from("fake-audio-bytes"),
    });
    await page.locator(".modal-box button", { hasText: "生成笔记" }).click();

    await page.locator("button", { hasText: "开始整体重新识别" }).click();
    await assert.doesNotReject(
      page.locator(".content-area", { hasText: "这是一段上传的录音识别出来的内容。" }).waitFor({ timeout: 10000 })
    );
  });

  test("课程笔记列表里，上传生成的笔记带有区分标记，且能正常归到指定课程", async () => {
    await goToModule(page, "课堂笔记");
    await page.locator("button", { hasText: "+ 新建课程" }).click();
    await page.locator(".modal-box input[name=name]").fill("外部录音归档");
    await page.locator(".modal-box button[type=submit]").click();
    await page.locator(".card", { hasText: "外部录音归档" }).click();

    await page.locator("button", { hasText: "+ 上传录音文件" }).click();
    await page.locator(".modal-box input[type=text]").fill("归档录音");
    await page.locator(".modal-box input[type=file]").setInputFiles({
      name: "archive.wav", mimeType: "audio/wav", buffer: Buffer.from("fake-audio-bytes"),
    });
    await page.locator(".modal-box button", { hasText: "生成笔记" }).click();

    await page.locator("button", { hasText: "← 返回列表" }).click();
    await assert.doesNotReject(page.locator(".card-title", { hasText: "外部录音归档" }).waitFor());
    await assert.doesNotReject(page.locator(".card", { hasText: "📤" }).filter({ hasText: "归档录音" }).waitFor());
  });
});

describe("课堂笔记：课程分组（同一门课的多次课归到一起）", () => {
  test("新建课程、把笔记归到课程里、课程改名、笔记之间可以互相移动、删除课程后笔记变成未分类", async () => {
    await goToModule(page, "课堂笔记");

    // 新建一门课，直接从这门课的笔记列表里建第一条笔记（course 会被自动带上）。
    await page.locator("button", { hasText: "+ 新建课程" }).click();
    await page.locator(".modal-box input[name=name]").fill("宏观经济学");
    await page.locator(".modal-box button[type=submit]").click();
    await assert.doesNotReject(page.locator(".card", { hasText: "宏观经济学" }).waitFor());
    assert.match(await page.locator(".card", { hasText: "宏观经济学" }).innerText(), /0 次课/);

    await page.locator(".card", { hasText: "宏观经济学" }).click();
    await assert.doesNotReject(page.locator(".card-title", { hasText: "宏观经济学" }).waitFor());
    await page.locator("button", { hasText: "+ 新建这门课的笔记" }).click();
    await page.locator(".modal-box input[type=text]").fill("第1讲：供需曲线");
    await page.locator(".modal-box button", { hasText: "开始录音" }).click();
    await page.locator("button", { hasText: "结束录音" }).click();

    // 结束录音后"← 返回列表"应该回到这门课的笔记列表（而不是顶层课程总览），能看到刚建的笔记。
    await page.locator("button", { hasText: "← 返回列表" }).click();
    await assert.doesNotReject(page.locator(".card-title", { hasText: "宏观经济学" }).waitFor());
    await assert.doesNotReject(page.locator(".card", { hasText: "第1讲：供需曲线" }).waitFor());

    // 课程改名：回顶层课程总览，改名后次数统计应该跟着课程走。
    await page.locator("button", { hasText: "← 返回课程列表" }).click();
    await assert.doesNotReject(page.locator(".card", { hasText: "宏观经济学" }).waitFor());
    assert.match(await page.locator(".card", { hasText: "宏观经济学" }).innerText(), /1 次课/);
    await page.locator(".card", { hasText: "宏观经济学" }).locator("button", { hasText: "改名" }).click();
    await page.locator(".modal-box input[name=name]").fill("宏观经济学（2026秋）");
    await page.locator(".modal-box button[type=submit]").click();
    await assert.doesNotReject(page.locator(".card", { hasText: "宏观经济学（2026秋）" }).waitFor());

    // 再建一条不属于任何课程的笔记（未分类），然后把它移动到刚才这门课里。
    await page.locator("button", { hasText: "+ 新建课堂笔记" }).click();
    await page.locator(".modal-box input[type=text]").fill("散装笔记");
    await page.locator(".modal-box button", { hasText: "开始录音" }).click();
    await page.locator("button", { hasText: "结束录音" }).click();
    await page.locator("button", { hasText: "移动到其它课程" }).click();
    await page.locator(".modal-box select[name=courseId]").selectOption({ label: "宏观经济学（2026秋）" });
    await page.locator(".modal-box button[type=submit]").click();

    await page.locator("button", { hasText: "← 返回列表" }).click();
    await assert.doesNotReject(page.locator(".card-title", { hasText: "宏观经济学（2026秋）" }).waitFor());
    await assert.doesNotReject(page.locator(".card", { hasText: "散装笔记" }).waitFor());
    assert.equal(await page.locator(".card", { hasText: "第1讲：供需曲线" }).count(), 1);

    // 删除这门课：课程消失，但两条笔记都应该变成"未分类"而不是被一起删掉。
    await page.locator("button", { hasText: "← 返回课程列表" }).click();
    await page.locator(".card", { hasText: "宏观经济学（2026秋）" }).locator(".row-delete").click();
    await page.locator(".modal-box button", { hasText: "删除" }).click();
    assert.equal(await page.locator(".card", { hasText: "宏观经济学（2026秋）" }).count(), 0);

    await page.locator(".card", { hasText: "未分类" }).click();
    await assert.doesNotReject(page.locator(".card", { hasText: "第1讲：供需曲线" }).waitFor());
    await assert.doesNotReject(page.locator(".card", { hasText: "散装笔记" }).waitFor());
  });
});

describe("课堂笔记：列表与删除", () => {
  test("删除一条笔记后，列表里不再显示", async () => {
    await startNewRecording(page, { title: "待删除的笔记" });
    await page.locator("button", { hasText: "结束录音" }).click();
    await page.locator("button", { hasText: "← 返回列表" }).click();

    const card = page.locator(".card", { hasText: "待删除的笔记" });
    await assert.doesNotReject(card.waitFor());
    await card.locator(".row-delete").click();
    await page.locator(".modal-box button", { hasText: "删除" }).click();

    assert.equal(await page.locator(".card", { hasText: "待删除的笔记" }).count(), 0);
  });

  test("改标题：详情页改完之后，列表里也跟着变", async () => {
    await startNewRecording(page, { title: "旧标题" });
    await page.locator("button", { hasText: "结束录音" }).click();
    await page.locator("button", { hasText: "改标题" }).click();
    await page.locator(".modal-box input[name=title]").fill("新标题");
    await page.locator(".modal-box button[type=submit]").click();
    await assert.doesNotReject(page.locator(".card-title", { hasText: "新标题" }).waitFor());

    await page.locator("button", { hasText: "← 返回列表" }).click();
    await assert.doesNotReject(page.locator(".card", { hasText: "新标题" }).waitFor());
  });
});

// 新功能：上传老师的 PPT 课件、拍照的板书/讲义照片，跟录音一起整理成笔记。用户明确
// 要求"两个时机都要"——开始录音前（新建笔记弹窗里）和之后随时（笔记详情页里）都能传。
describe("课堂笔记：课件材料上传（PPT + 拍照笔记）", () => {
  test("开始录音前的弹窗里先选好材料，开始录音后材料会出现在详情页", async () => {
    await goToModule(page, "课堂笔记");
    await page.locator("button", { hasText: "+ 新建课堂笔记" }).click();
    await page.locator(".modal-box input[type=text]").fill("材料预上传测试");

    await page.locator('.modal-box input[type="file"][accept="image/*"]').setInputFiles({
      name: "板书.png",
      mimeType: "image/png",
      buffer: Buffer.from(FAKE_PNG_BASE64, "base64"),
    });
    await assert.doesNotReject(page.locator(".modal-box", { hasText: "板书.png" }).waitFor());

    await page.locator('.modal-box input[type="file"][accept^=".pptx"]').setInputFiles({
      name: "第1讲.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: buildFakePptx(["课程简介"]),
    });
    await assert.doesNotReject(page.locator(".modal-box", { hasText: "第1讲.pptx" }).waitFor());

    await page.locator(".modal-box button", { hasText: "开始录音" }).click();
    await assert.doesNotReject(page.locator(".card-title", { hasText: "材料预上传测试" }).waitFor());
    await page.locator("button", { hasText: "结束录音" }).click();

    const materialsCard = page.locator(".card", { hasText: "课件材料" });
    await assert.doesNotReject(materialsCard.locator("text=板书.png").waitFor());
    await assert.doesNotReject(materialsCard.locator("text=第1讲.pptx").waitFor());
  });

  test("笔记详情页里随时可以补充/删除材料", async () => {
    await startNewRecording(page, { title: "详情页材料测试" });
    await page.locator("button", { hasText: "结束录音" }).click();

    const materialsCard = page.locator(".card", { hasText: "课件材料" });
    await assert.doesNotReject(materialsCard.locator("text=还没有上传材料").waitFor());

    await materialsCard.locator('input[type="file"][accept="image/*"]').setInputFiles({
      name: "笔记照片.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from(FAKE_PNG_BASE64, "base64"),
    });
    await assert.doesNotReject(materialsCard.locator("text=笔记照片.jpg").waitFor());

    await materialsCard.locator('input[type="file"][accept^=".pptx"]').setInputFiles({
      name: "课件.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: buildFakePptx(["第一页内容", "第二页内容"]),
    });
    await assert.doesNotReject(materialsCard.locator("text=课件.pptx").waitFor());

    // 删除照片材料，PPT 材料不受影响。
    await materialsCard.locator(".list-row", { hasText: "笔记照片.jpg" }).locator(".row-delete").click();
    assert.equal(await materialsCard.locator("text=笔记照片.jpg").count(), 0);
    await assert.doesNotReject(materialsCard.locator("text=课件.pptx").waitFor());
  });

  test("解析不出内容的 PPT 文件会提示失败，不影响已有材料", async () => {
    await startNewRecording(page, { title: "PPT解析失败测试" });
    await page.locator("button", { hasText: "结束录音" }).click();

    const materialsCard = page.locator(".card", { hasText: "课件材料" });
    await materialsCard.locator('input[type="file"][accept^=".pptx"]').setInputFiles({
      name: "坏文件.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: Buffer.from("这根本不是一个 ZIP 文件"),
    });
    await assert.doesNotReject(materialsCard.locator("text=解析 PPT「坏文件.pptx」失败").waitFor());
  });

  test("除了 PPT 和照片，也可以上传 Word (.docx) 文档作为课件材料", async () => {
    await startNewRecording(page, { title: "Word文档测试" });
    await page.locator("button", { hasText: "结束录音" }).click();

    const materialsCard = page.locator(".card", { hasText: "课件材料" });
    await materialsCard.locator('input[type="file"][accept^=".docx"]').setInputFiles({
      name: "讲义.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: buildFakeDocx(["第一段讲义内容", "第二段讲义内容"]),
    });
    await assert.doesNotReject(materialsCard.locator("text=讲义.docx").waitFor());
  });

  test("解析不出内容的 Word 文档会提示失败，不影响已有材料", async () => {
    await startNewRecording(page, { title: "Word解析失败测试" });
    await page.locator("button", { hasText: "结束录音" }).click();

    const materialsCard = page.locator(".card", { hasText: "课件材料" });
    await materialsCard.locator('input[type="file"][accept^=".docx"]').setInputFiles({
      name: "坏文件.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from("这根本不是一个 ZIP 文件"),
    });
    await assert.doesNotReject(materialsCard.locator("text=解析 Word 文档「坏文件.docx」失败").waitFor());
  });

  test("生成笔记时会把材料一并发给 AI：PPT 文字进提示词、照片作为图片内容块", async () => {
    await setApiKey(page, "sk-test-key");
    await startNewRecording(page, { title: "材料参与生成笔记测试" });
    await page.evaluate(() => window.__emitTranscript("Bonjour à tous", true));
    await page.locator("button", { hasText: "结束录音" }).click();

    const materialsCard = page.locator(".card", { hasText: "课件材料" });
    await materialsCard.locator('input[type="file"][accept^=".pptx"]').setInputFiles({
      name: "参考课件.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: buildFakePptx(["经济学基本概念"]),
    });
    await assert.doesNotReject(materialsCard.locator("text=参考课件.pptx").waitFor());

    await materialsCard.locator('input[type="file"][accept="image/*"]').setInputFiles({
      name: "板书照片.png",
      mimeType: "image/png",
      buffer: Buffer.from(FAKE_PNG_BASE64, "base64"),
    });
    await assert.doesNotReject(materialsCard.locator("text=板书照片.png").waitFor());

    const captured = {};
    await mockClaudeApiCapturing(page, "# 结合材料整理的笔记\n- 经济学基本概念", captured);
    await page.locator(".tabs .tab-btn", { hasText: "笔记" }).click();
    await page.locator("button", { hasText: "生成笔记" }).click();
    await assert.doesNotReject(page.locator(".note-markdown", { hasText: "结合材料整理的笔记" }).waitFor());

    const content = captured.body.messages[0].content;
    assert.ok(Array.isArray(content), "带了图片之后 content 应该是数组形式，不再是纯字符串");
    const imageBlocks = content.filter((b) => b.type === "image");
    const textBlock = content.find((b) => b.type === "text");
    assert.equal(imageBlocks.length, 1);
    assert.equal(imageBlocks[0].source.media_type, "image/png");
    assert.match(textBlock.text, /课件材料/);
    assert.match(textBlock.text, /经济学基本概念/);
  });
});

// 新功能：思维导图（图形化节点连线图），跟闪卡/测验一样基于已经生成好的笔记正文，
// 用同样的 gating 规则（先有 notesMarkdown 才能生成）。
describe("课堂笔记：AI 生成思维导图", () => {
  test("还没生成原文笔记时，思维导图 tab 显示提示、生成按钮禁用", async () => {
    await setApiKey(page, "sk-test-key");
    await startNewRecording(page, { title: "还没生成笔记-思维导图" });
    await page.evaluate(() => window.__emitTranscript("一句话", true));
    await page.locator("button", { hasText: "结束录音" }).click();
    await page.locator(".tabs .tab-btn", { hasText: "思维导图" }).click();
    await assert.doesNotReject(page.locator(".content-area", { hasText: "先在「笔记」tab 生成笔记" }).waitFor());
    assert.equal(await page.locator("button", { hasText: "生成思维导图" }).isDisabled(), true);
  });

  test("生成笔记后可以生成思维导图，图形化节点连线图正常渲染出根节点和分支", async () => {
    await setApiKey(page, "sk-test-key");
    await startNewRecording(page, { title: "思维导图测试" });
    await page.evaluate(() => window.__emitTranscript("一句话", true));
    await page.locator("button", { hasText: "结束录音" }).click();

    await mockClaudeApi(page, "# 课堂要点\n- 第一点\n- 第二点");
    await page.locator(".tabs .tab-btn", { hasText: "笔记" }).click();
    await page.locator("button", { hasText: "生成笔记" }).click();
    await assert.doesNotReject(page.locator(".note-markdown", { hasText: "课堂要点" }).waitFor());

    await mockClaudeApi(page, JSON.stringify({
      title: "课堂要点",
      children: [
        { title: "第一点", children: [{ title: "细节A", children: [] }] },
        { title: "第二点", children: [] },
      ],
    }));
    await page.locator(".tabs .tab-btn", { hasText: "思维导图" }).click();
    await page.locator("button", { hasText: "生成思维导图" }).click();

    await assert.doesNotReject(page.locator(".mindmap-svg").waitFor());
    // SVG 的 <text>/<tspan> 不是常规 DOM 文字排版，innerText 在不同浏览器上表现不一致，
    // 用 textContent 更可靠（拿到所有子节点文字拼起来，不受 tspan 拆行影响）。
    const svgText = await page.locator(".mindmap-svg").textContent();
    assert.match(svgText, /课堂要点/);
    assert.match(svgText, /第一点/);
    assert.match(svgText, /细节A/);
    assert.equal(await page.locator(".mindmap-node").count(), 4); // 根 + 第一点 + 细节A + 第二点
    assert.equal(await page.locator(".mindmap-edge").count(), 3);

    // 生成过一次之后，按钮文字应该变成"重新生成思维导图"。
    await assert.doesNotReject(page.locator("button", { hasText: "重新生成思维导图" }).waitFor());
  });

  test("AI 没有返回可用的思维导图（比如返回的不是合法 JSON）时，显示错误提示，按钮恢复可点", async () => {
    await setApiKey(page, "sk-test-key");
    await startNewRecording(page, { title: "思维导图报错测试" });
    await page.evaluate(() => window.__emitTranscript("一句话", true));
    await page.locator("button", { hasText: "结束录音" }).click();
    await mockClaudeApi(page, "# 笔记标题\n正文");
    await page.locator(".tabs .tab-btn", { hasText: "笔记" }).click();
    await page.locator("button", { hasText: "生成笔记" }).click();
    await assert.doesNotReject(page.locator(".note-markdown", { hasText: "笔记标题" }).waitFor());

    await mockClaudeApi(page, "抱歉，我没法生成思维导图。");
    await page.locator(".tabs .tab-btn", { hasText: "思维导图" }).click();
    await page.locator("button", { hasText: "生成思维导图" }).click();
    await assert.doesNotReject(page.locator(".content-area", { hasText: "没有生成出可用的思维导图" }).waitFor());
    assert.equal(await page.locator("button", { hasText: "生成思维导图" }).isDisabled(), false);
  });
});
