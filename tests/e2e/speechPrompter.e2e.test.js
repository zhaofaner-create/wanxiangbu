// 演讲提词模块端到端测试：新建/编辑演讲稿、全屏演讲模式的自动跟随语音 + 手动翻页 +
// 大纲/预览行跳转 + 长时间无声自动切手动 + 浏览器不支持时的兜底。
//
// 跟课堂笔记模块一样，真实的语音识别（Web Speech API）没法在无网络的测试环境里跑，
// 用 addInitScript 换成一个假的 SpeechRecognition 实现，测试代码通过
// window.__emitTranscript(text, isFinal) 手动模拟"用户说了一句话"。这个模块不需要
// 保存音频，所以不需要像课堂笔记那样再假 MediaRecorder/getUserMedia。
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { gotoApp, goToModule } from "./helpers.js";

let browser;
let context;
let page;

const FAKE_SPEECH_SCRIPT = `
  window.__fakeRecognitions = [];
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

  window.__emitTranscript = (text, isFinal) => {
    const rec = window.__fakeRecognitions[window.__fakeRecognitions.length - 1];
    if (!rec || !rec.onresult) return;
    const result = Object.assign([{ transcript: text }], { isFinal: isFinal !== false });
    rec.onresult({ resultIndex: 0, results: [result] });
  };

  window.__emitRecognitionError = (code) => {
    const rec = window.__fakeRecognitions[window.__fakeRecognitions.length - 1];
    if (!rec || !rec.onerror) return;
    rec.onerror({ error: code });
  };
`;

const UNSUPPORTED_SCRIPT = `
  window.SpeechRecognition = undefined;
  window.webkitSpeechRecognition = undefined;
`;

async function createScriptPrompter(targetPage, { title, text }) {
  await goToModule(targetPage, "演讲提词");
  await targetPage.locator("button", { hasText: "+ 新建演讲稿" }).click();
  await targetPage.locator('[name="title"]').fill(title);
  await targetPage.locator('[name="rawText"]').fill(text);
  await targetPage.locator("button", { hasText: "按标点拆分成句子列表" }).click();
  await targetPage.locator("button", { hasText: "保存" }).click();
}

async function createPromptsPrompter(targetPage, { title, text }) {
  await goToModule(targetPage, "演讲提词");
  await targetPage.locator("button", { hasText: "+ 新建演讲稿" }).click();
  await targetPage.locator(".tabs .tab-btn", { hasText: "提示词" }).click();
  await targetPage.locator('[name="title"]').fill(title);
  await targetPage.locator('[name="rawText"]').fill(text);
  await targetPage.locator("button", { hasText: "按每行拆分成提示词列表" }).click();
  await targetPage.locator("button", { hasText: "保存" }).click();
}

async function startPresenting(targetPage, title) {
  await targetPage.locator(".card", { hasText: title }).locator("button", { hasText: "开始演讲" }).click();
}

before(async () => {
  browser = await chromium.launch({ args: ["--no-sandbox"] });
});

after(async () => {
  await browser.close();
});

beforeEach(async () => {
  context = await browser.newContext();
  await context.addInitScript(FAKE_SPEECH_SCRIPT);
  page = await context.newPage();
  await gotoApp(page);
});

afterEach(async () => {
  await context.close();
});

describe("演讲提词：新建/编辑/删除", () => {
  test("列表为空时的提示文案", async () => {
    await goToModule(page, "演讲提词");
    await assert.doesNotReject(page.locator(".empty-hint", { hasText: "还没有演讲稿" }).waitFor());
  });

  test("新建完整稿：粘贴文本按标点拆句，保存后卡片显示正确统计", async () => {
    await createScriptPrompter(page, { title: "开题报告", text: "大家好。今天汇报我的研究方向。谢谢大家。" });
    const card = page.locator(".card", { hasText: "开题报告" });
    await assert.doesNotReject(card.waitFor());
    await assert.doesNotReject(card.locator(".badge", { hasText: "完整稿" }).waitFor());
    const meta = await card.locator(".muted").innerText();
    assert.match(meta, /共 3 句/);
  });

  test("新建完整稿：英文稿子（用「.」结尾，每句单独一行）也能正确按标点拆句（回归测试——之前拆句规则漏掉了英文句号「.」，导致整段英文稿子完全拆不开，全部粘成一句）", async () => {
    const text =
      "Hello everyone.\n" +
      "Now, I'm going to present the second question: Biocoop's stakeholders.\n" +
      "To understand Biocoop, we first need to remember one important thing:\n" +
      "Biocoop is a cooperative.\n" +
      "This means that some stakeholders are also members of the cooperative, called sociétaires, and they participate directly in the governance.";
    await createScriptPrompter(page, { title: "英文演讲稿", text });
    const card = page.locator(".card", { hasText: "英文演讲稿" });
    await assert.doesNotReject(card.waitFor());
    const meta = await card.locator(".muted").innerText();
    assert.match(meta, /共 5 句/);

    await card.locator("button", { hasText: "编辑" }).click();
    await assert.equal(await page.locator(".prompter-row").count(), 5);
    const values = await page.$$eval(".prompter-row input", (els) => els.map((el) => el.value));
    assert.deepEqual(values, [
      "Hello everyone.",
      "Now, I'm going to present the second question: Biocoop's stakeholders.",
      "To understand Biocoop, we first need to remember one important thing:",
      "Biocoop is a cooperative.",
      "This means that some stakeholders are also members of the cooperative, called sociétaires, and they participate directly in the governance.",
    ]);
  });

  test("新建提示词：按每行拆分（不按标点，不要求逐字念出来）", async () => {
    await createPromptsPrompter(page, { title: "答辩提要", text: "预算问题\n时间安排\n下一步计划" });
    const card = page.locator(".card", { hasText: "答辩提要" });
    await assert.doesNotReject(card.locator(".badge", { hasText: "提示词" }).waitFor());
    const meta = await card.locator(".muted").innerText();
    assert.match(meta, /共 3 条/);
  });

  test("编辑：合并/插入/删除/上下移动都生效，保存后持久化", async () => {
    await createScriptPrompter(page, { title: "编辑测试", text: "第一句。第二句。第三句。" });
    await page.locator(".card", { hasText: "编辑测试" }).locator("button", { hasText: "编辑" }).click();
    await assert.equal(await page.locator(".prompter-row").count(), 3);

    // 合并第2句到第1句
    await page.locator(".prompter-row").nth(1).locator("button", { hasText: "↑合并" }).click();
    await assert.equal(await page.locator(".prompter-row").count(), 2);
    assert.equal(await page.locator(".prompter-row").nth(0).locator("input").inputValue(), "第一句。 第二句。");

    // 在第1行下面插入一条新行并填内容
    await page.locator(".prompter-row").nth(0).locator("button", { hasText: "+插入" }).click();
    await assert.equal(await page.locator(".prompter-row").count(), 3);
    await page.locator(".prompter-row").nth(1).locator("input").fill("插入的新句子。");

    // 把新插入的这行往下移一位
    await page.locator(".prompter-row").nth(1).locator("button", { hasText: "▼" }).click();
    assert.equal(await page.locator(".prompter-row").nth(2).locator("input").inputValue(), "插入的新句子。");

    // 删除最后一行（有内容，会弹二次确认）
    await page.locator(".prompter-row").nth(2).locator("button", { hasText: "删除" }).click();
    await page.locator(".modal-box", { hasText: "删除这一条？" }).locator("button", { hasText: "删除" }).click();
    await assert.equal(await page.locator(".prompter-row").count(), 2);

    await page.locator("button", { hasText: "保存" }).click();
    await page.locator(".card", { hasText: "编辑测试" }).locator("button", { hasText: "编辑" }).click();
    const values = await page.$$eval(".prompter-row input", (els) => els.map((el) => el.value));
    assert.deepEqual(values, ["第一句。 第二句。", "第三句。"]);
  });

  test("删除演讲稿：确认后从列表消失", async () => {
    await createScriptPrompter(page, { title: "待删除", text: "内容。" });
    await assert.doesNotReject(page.locator(".card", { hasText: "待删除" }).waitFor());
    await page.locator(".card", { hasText: "待删除" }).locator("button", { hasText: "删除" }).click();
    await page.locator(".modal-box", { hasText: "确定删除演讲稿" }).locator("button", { hasText: "删除" }).click();
    await assert.equal(await page.locator(".card", { hasText: "待删除" }).count(), 0);
  });
});

describe("演讲提词：全屏演讲——自动模式跟随语音", () => {
  test("默认自动模式；讲完一句自动跳下一句；跳着讲会一次跳过好几句", async () => {
    await createScriptPrompter(page, {
      title: "开场白",
      text: "大家好欢迎参加今天的分享。我们先聊聊背景。然后讲讲方案。最后是问答环节。",
    });
    await startPresenting(page, "开场白");
    await assert.doesNotReject(page.locator(".prompter-line-current").waitFor());
    assert.equal(await page.locator(".prompter-progress").innerText(), "第 1 / 共 4 句");
    assert.equal(await page.locator(".prompter-status-label").innerText(), "正在听");

    await page.evaluate(() => window.__emitTranscript("大家好欢迎参加今天的分享", true));
    await page.waitForFunction(() => document.querySelector(".prompter-progress")?.textContent === "第 2 / 共 4 句");

    // 跳着讲，直接说到了最后一句的内容 -> 应该一次跳到最后一句（在 lookahead 窗口内允许跳过中间几句）
    await page.evaluate(() => window.__emitTranscript("最后是问答环节", true));
    await page.waitForFunction(() => document.querySelector(".prompter-progress")?.textContent === "第 4 / 共 4 句");
  });

  test("完全没识别到相关内容时不会瞎跳", async () => {
    await createScriptPrompter(page, { title: "静默测试", text: "第一句内容。第二句内容。" });
    await startPresenting(page, "静默测试");
    await page.evaluate(() => window.__emitTranscript("呃这个那个", true));
    // 给一点时间让处理逻辑跑完，确认没有发生任何跳转
    await page.waitForTimeout(100);
    assert.equal(await page.locator(".prompter-progress").innerText(), "第 1 / 共 2 句");
  });
});

describe("演讲提词：全屏演讲——手动模式", () => {
  test("没有语音时点下一句只是简单+1；有匹配语音时点下一句会智能跳过好几句；上一句能退回去", async () => {
    await createScriptPrompter(page, {
      title: "手动测试",
      text: "开场白介绍环节。背景情况说明。具体技术方案。预算时间安排。总结感谢环节。",
    });
    await startPresenting(page, "手动测试");
    await page.locator(".pill", { hasText: "手动翻页" }).click();
    assert.equal(await page.locator(".prompter-status-label").innerText(), "手动模式");

    await page.locator("button", { hasText: "下一句" }).click();
    assert.equal(await page.locator(".prompter-progress").innerText(), "第 2 / 共 5 句");

    await page.evaluate(() => window.__emitTranscript("预算时间安排", true));
    await page.locator("button", { hasText: "下一句" }).click();
    assert.equal(await page.locator(".prompter-progress").innerText(), "第 5 / 共 5 句");

    await page.locator("button", { hasText: "上一句" }).click();
    assert.equal(await page.locator(".prompter-progress").innerText(), "第 4 / 共 5 句");
  });
});

describe("演讲提词：大纲 / 点击预览行跳转", () => {
  test("大纲面板和点击上下文预览行都能直接跳到任意一句", async () => {
    await createScriptPrompter(page, { title: "大纲测试", text: "第一段内容。第二段内容。第三段内容。第四段内容。" });
    await startPresenting(page, "大纲测试");

    await page.locator("button", { hasText: "大纲" }).click();
    await page.locator(".prompter-outline-item", { hasText: "3. 第三段内容。" }).click();
    assert.equal(await page.locator(".prompter-progress").innerText(), "第 3 / 共 4 句");

    await page.locator(".prompter-line-context", { hasText: "第四段内容。" }).click();
    assert.equal(await page.locator(".prompter-progress").innerText(), "第 4 / 共 4 句");
  });
});

describe("演讲提词：长时间无声自动切换到手动模式", () => {
  test("自动模式下超过默认阈值没收到任何声音，会自动切手动并弹提示", async () => {
    await page.clock.install();
    await createScriptPrompter(page, { title: "安静测试", text: "第一句内容。第二句内容。" });
    await startPresenting(page, "安静测试");
    assert.equal(await page.locator(".prompter-status-label").innerText(), "正在听");

    await page.clock.fastForward(9000);

    assert.equal(await page.locator(".prompter-status-label").innerText(), "手动模式");
    await assert.doesNotReject(page.locator(".pill.active", { hasText: "手动翻页" }).waitFor());
    await assert.doesNotReject(page.locator(".prompter-toast", { hasText: "已切换到手动模式" }).waitFor());
  });
});

describe("演讲提词：浏览器不支持语音识别时的兜底", () => {
  test("不显示自动/手动切换控件，全程手动翻页也能正常用", async () => {
    await createScriptPrompter(page, { title: "不支持测试", text: "第一句。第二句。" });
    await context.addInitScript(UNSUPPORTED_SCRIPT);
    const page2 = await context.newPage();
    await gotoApp(page2);
    await goToModule(page2, "演讲提词");
    await startPresenting(page2, "不支持测试");

    await assert.equal(await page2.locator(".pill-group").count(), 0);
    await assert.doesNotReject(page2.locator(".prompter-meta-row", { hasText: "当前浏览器不支持语音跟随" }).waitFor());
    await page2.locator("button", { hasText: "下一句" }).click();
    assert.equal(await page2.locator(".prompter-progress").innerText(), "第 2 / 共 2 句");
    await page2.close();
  });
});
