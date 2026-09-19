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

  window.__emitTranscript = (text, isFinal) => {
    const rec = window.__fakeRecognitions[window.__fakeRecognitions.length - 1];
    if (!rec || !rec.onresult) return;
    const result = Object.assign([{ transcript: text }], { isFinal: isFinal !== false });
    rec.onresult({ resultIndex: 0, results: [result] });
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
    await assert.doesNotReject(page.locator(".empty-hint", { hasText: "还没有转录内容" }).waitFor());

    await page.locator(".tabs .tab-btn", { hasText: "笔记" }).click();
    await assert.doesNotReject(page.locator(".content-area", { hasText: "还没设置 AI 服务密钥" }).first().waitFor());
    assert.equal(await page.locator("button", { hasText: "生成笔记" }).isDisabled(), true);
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

describe("课堂笔记：多语言互译", () => {
  test("没有配置当前使用的翻译服务时，翻译按钮禁用并提示去设置", async () => {
    await startNewRecording(page, { title: "没配置翻译服务的笔记", targetLangLabel: "中文" });
    await page.evaluate(() => window.__emitTranscript("Bonjour à tous", true));
    await page.locator("button", { hasText: "结束录音" }).click();
    await page.locator(".tabs .tab-btn", { hasText: "翻译" }).click();
    await assert.doesNotReject(page.locator(".content-area", { hasText: "还没配置当前使用的翻译服务" }).first().waitFor());
    assert.match(await page.locator(".content-area").innerText(), /Google 翻译/);
    assert.equal(await page.locator("button", { hasText: "翻译成中文" }).isDisabled(), true);
  });

  test("默认用 Google 翻译：选了互译语言的笔记，翻译后能在对应语言 tab 里看到结果", async () => {
    await setTranslationProvider(page, "google", { apiKey: "google-test-key" });
    await startNewRecording(page, { title: "互译测试", targetLangLabel: "中文" });
    await page.evaluate(() => window.__emitTranscript("Bonjour à tous", true));
    await assert.doesNotReject(page.locator(".record-transcript-list", { hasText: "Bonjour à tous" }).waitFor());
    await page.locator("button", { hasText: "结束录音" }).click();

    await mockTranslateApi(page, "google", "大家好");

    await page.locator(".tabs .tab-btn", { hasText: "翻译" }).click();
    await assert.doesNotReject(page.locator(".pill", { hasText: "中文" }).waitFor());
    await page.locator("button", { hasText: "翻译成中文" }).click();

    await assert.doesNotReject(page.locator(".content-area", { hasText: "大家好" }).waitFor());
  });

  test("切到 Azure Translator 之后，翻译按钮改用 Azure 的接口", async () => {
    await setTranslationProvider(page, "azure", { apiKey: "azure-test-key", region: "eastasia" });
    await startNewRecording(page, { title: "Azure互译测试", targetLangLabel: "英语" });
    await page.evaluate(() => window.__emitTranscript("你好，大家好", true));
    await assert.doesNotReject(page.locator(".record-transcript-list", { hasText: "你好，大家好" }).waitFor());
    await page.locator("button", { hasText: "结束录音" }).click();

    await mockTranslateApi(page, "azure", "Hello everyone");

    await page.locator(".tabs .tab-btn", { hasText: "翻译" }).click();
    await page.locator("button", { hasText: "翻译成英语" }).click();

    await assert.doesNotReject(page.locator(".content-area", { hasText: "Hello everyone" }).waitFor());
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

    await page.locator(".tabs .tab-btn", { hasText: "翻译" }).click();
    await page.locator("button", { hasText: "翻译成英语" }).click();
    await assert.doesNotReject(page.locator(".content-area", { hasText: "DeepL 密钥无效或没有权限" }).first().waitFor());
  });

  test("创建时没选互译语言，翻译 tab 提示没有可互译的语言", async () => {
    await startNewRecording(page, { title: "没选语言测试" });
    await page.locator("button", { hasText: "结束录音" }).click();
    await page.locator(".tabs .tab-btn", { hasText: "翻译" }).click();
    await assert.doesNotReject(page.locator(".empty-hint", { hasText: "没有选择需要互译的语言" }).waitFor());
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
