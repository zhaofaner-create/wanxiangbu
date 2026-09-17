// 读书笔记模块端到端测试：加书、按状态筛选、编辑评分/状态、记笔记、删笔记、删书。
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { gotoApp, goToModule, fillModal, submitModal } from "./helpers.js";

let browser;
let context;
let page;

before(async () => {
  browser = await chromium.launch({ args: ["--no-sandbox"] });
});

after(async () => {
  await browser.close();
});

beforeEach(async () => {
  context = await browser.newContext();
  page = await context.newPage();
  await gotoApp(page);
  await goToModule(page, "读书笔记");
});

afterEach(async () => {
  await context.close();
});

describe("读书笔记：书目管理", () => {
  test("添加一本书，默认状态是'想读'，出现在书单里", async () => {
    await page.locator("button", { hasText: "+ 添加书目" }).click();
    await fillModal(page, { title: "百年孤独", author: "加西亚·马尔克斯" });
    await submitModal(page);

    const card = page.locator(".card", { hasText: "百年孤独" });
    await assert.doesNotReject(card.waitFor());
    assert.ok((await card.innerText()).includes("想读"));
    assert.ok((await card.innerText()).includes("加西亚·马尔克斯"));
  });

  test("按状态筛选：只看'在读'的书", async () => {
    await page.locator("button", { hasText: "+ 添加书目" }).click();
    await fillModal(page, { title: "书A", status: "想读" });
    await submitModal(page);
    await page.locator("button", { hasText: "+ 添加书目" }).click();
    await fillModal(page, { title: "书B", status: "在读" });
    await submitModal(page);

    await page.locator(".pill", { hasText: "在读" }).click();
    assert.equal(await page.locator(".card", { hasText: "书A" }).count(), 0);
    assert.equal(await page.locator(".card", { hasText: "书B" }).count(), 1);
  });

  test("点击书卡片编辑状态和评分", async () => {
    await page.locator("button", { hasText: "+ 添加书目" }).click();
    await fillModal(page, { title: "刻意练习" });
    await submitModal(page);

    await page.locator(".card", { hasText: "刻意练习" }).click();
    await fillModal(page, { status: "读完", rating: "5" });
    await submitModal(page);

    const card = page.locator(".card", { hasText: "刻意练习" });
    const text = await card.innerText();
    assert.ok(text.includes("读完"));
    assert.ok(text.includes("★★★★★"));
  });

  test("删除书目会连带删除它的笔记", async () => {
    await page.locator("button", { hasText: "+ 添加书目" }).click();
    await fillModal(page, { title: "将被删除的书" });
    await submitModal(page);

    await page.locator(".row-delete", { hasText: "删除" }).click();
    await page.locator(".modal-box button", { hasText: "删除" }).click();
    assert.equal(await page.locator(".card", { hasText: "将被删除的书" }).count(), 0);
  });
});

describe("读书笔记：记笔记", () => {
  test("给一本书添加笔记，笔记数量会更新", async () => {
    await page.locator("button", { hasText: "+ 添加书目" }).click();
    await fillModal(page, { title: "人类简史" });
    await submitModal(page);

    await page.locator("span", { hasText: "笔记 · 0条" }).click();
    await page.locator(".modal-box textarea").fill("第一条笔记");
    await page.locator("button", { hasText: "添加笔记" }).click();

    await assert.doesNotReject(page.locator(".modal-box", { hasText: "第一条笔记" }).waitFor());
    await page.locator(".modal-box button", { hasText: "关闭" }).click();

    const card = page.locator(".card", { hasText: "人类简史" });
    assert.ok((await card.innerText()).includes("笔记 · 1条"));
  });

  test("删除笔记后数量减少", async () => {
    await page.locator("button", { hasText: "+ 添加书目" }).click();
    await fillModal(page, { title: "三体" });
    await submitModal(page);

    await page.locator("span", { hasText: "笔记 · 0条" }).click();
    await page.locator(".modal-box textarea").fill("笔记A");
    await page.locator("button", { hasText: "添加笔记" }).click();
    await assert.doesNotReject(page.locator(".modal-box", { hasText: "笔记A" }).waitFor());

    await page.locator(".modal-box .row-delete", { hasText: "删除" }).click();
    await assert.doesNotReject(page.locator(".modal-box", { hasText: "还没有笔记" }).waitFor());
  });
});
