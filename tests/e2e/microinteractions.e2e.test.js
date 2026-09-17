// 精选微交互动效端到端测试：按钮按压的物理压缩效果、卡片跟随鼠标的3D倾斜。
// 呼吸描边光/交错入场这些纯视觉、没有可断言的"状态"的效果，靠前面截图人工确认过，
// 这里只测试有确定行为可以断言的两个：按压时的 scale、鼠标移动时的 rotate。
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { gotoApp } from "./helpers.js";

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

describe("微交互：按钮按压物理效果", () => {
  test("鼠标按住按钮时会压缩（scale变小），松开后恢复正常大小", async () => {
    const btn = page.locator(".quick-memo-btn .btn, .btn").first();
    const box = await btn.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();

    const pressedTransform = await btn.evaluate((el) => getComputedStyle(el).transform);
    assert.notEqual(pressedTransform, "none", "按下时应该有一个 scale 变换");

    await page.mouse.up();
    // 松手之后有一段弹簧回弹动画，最终应该稳定回到"没有额外缩放"（matrix 单位矩阵或 none）
    await page.waitForFunction(() => {
      const btn = document.querySelector(".btn");
      const t = getComputedStyle(btn).transform;
      if (t === "none") return true;
      // matrix(a,b,c,d,e,f)：a≈1 且 d≈1 说明缩放已经回到1（允许一点误差，因为可能还在回弹路上）
      const m = t.match(/matrix\(([^)]+)\)/);
      if (!m) return false;
      const [a, , , d] = m[1].split(",").map(Number);
      return Math.abs(a - 1) < 0.01 && Math.abs(d - 1) < 0.01;
    }, { timeout: 3000 });
  });
});

describe("微交互：卡片3D倾斜", () => {
  test("鼠标在卡片上移动时卡片会跟着倾斜，移开后弹簧回正", async () => {
    const card = page.locator(".card").first();
    await assert.doesNotReject(card.waitFor());
    const box = await card.boundingBox();

    // 移到卡片的左上角附近（明显偏离中心），应该产生看得见的旋转
    await page.mouse.move(box.x + 4, box.y + 4);
    await page.mouse.move(box.x + 6, box.y + 6); // 多移动一次，确保触发 pointermove
    const tiltedTransform = await card.evaluate((el) => el.style.transform);
    assert.match(tiltedTransform, /rotateX/);
    assert.match(tiltedTransform, /rotateY/);

    // 移到卡片范围外，应该弹簧回正到 rotateX(0deg) rotateY(0deg)
    await page.mouse.move(box.x + box.width + 100, box.y + box.height + 100);
    await page.waitForFunction((selector) => {
      const el = document.querySelector(selector);
      return el && /rotateX\(0(\.0+)?deg\)\s*rotateY\(0(\.0+)?deg\)/.test(el.style.transform);
    }, ".card", { timeout: 3000 });
  });
});
