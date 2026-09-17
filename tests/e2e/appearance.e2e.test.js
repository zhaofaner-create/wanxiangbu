// 外观设置（字体字号 / 白天夜间模式）端到端测试：验证顶栏快捷按钮和"数据与设置"页面
// 里的控件都能真的改变页面呈现，而且改动会保存下来（刷新/重新打开也还在）。
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { gotoApp, goToModule } from "./helpers.js";

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
});

afterEach(async () => {
  await context.close();
});

describe("外观 · 白天/夜间模式", () => {
  test("默认是白天模式，顶栏按钮可以一键切到夜间，html 上的 data-theme 会跟着变", async () => {
    let theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    assert.equal(theme, "day");

    await page.locator("#theme-toggle").click();
    theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    assert.equal(theme, "night");

    await page.locator("#theme-toggle").click();
    theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    assert.equal(theme, "day");
  });

  test("切到夜间模式后刷新页面，设置还在（存进了本地数据里，不是临时的页面状态）", async () => {
    await page.locator("#theme-toggle").click();
    await page.reload();
    await page.waitForSelector(".nav-item");
    const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    assert.equal(theme, "night");
  });

  test("在'数据与设置'页面里切换主题，跟顶栏按钮改的是同一份设置", async () => {
    await goToModule(page, "数据与设置");
    await page.locator(".tab-btn", { hasText: "夜间" }).click();
    const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    assert.equal(theme, "night");
    // 顶栏按钮此时也应该处于"当前是夜间"的状态（图标已经切换）；用轮询等过渡播完，
    // 不用固定的 sleep 时长——多个测试文件并发跑的时候，系统繁忙会让过渡动画本身
    // 播放得更慢，固定等待时间在那种情况下不够用，会偶尔断言过早。
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector(".theme-toggle .icon-moon")).opacity === "1",
      { timeout: 5000 }
    );
    const moonOpacity = await page.locator(".theme-toggle .icon-moon").evaluate((el) => getComputedStyle(el).opacity);
    assert.equal(moonOpacity, "1");
  });
});

describe("外观 · 字体字号", () => {
  test("默认标准字号对应 zoom 为 1，切到'大'之后页面整体按比例放大", async () => {
    let zoom = await page.evaluate(() => document.documentElement.style.zoom);
    assert.equal(zoom, "1");

    await goToModule(page, "数据与设置");
    await page.locator(".tab-btn", { hasText: /^大$/ }).click(); // 精确匹配"大"，避免连带匹配到"特大"
    zoom = await page.evaluate(() => document.documentElement.style.zoom);
    assert.equal(zoom, "1.125");
  });

  test("切换字号之后刷新页面，字号设置还在", async () => {
    await goToModule(page, "数据与设置");
    await page.locator(".tab-btn", { hasText: "特大" }).click();
    await page.reload();
    await page.waitForSelector(".nav-item");
    const zoom = await page.evaluate(() => document.documentElement.style.zoom);
    assert.equal(zoom, "1.25");
  });
});
