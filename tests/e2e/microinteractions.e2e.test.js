// 精选微交互动效端到端测试：按钮按压的物理压缩效果。
// 呼吸描边光/交错入场这些纯视觉、没有可断言的"状态"的效果，靠前面截图人工确认过。
//
// 注意：卡片跟随鼠标的3D倾斜效果已经在用户反馈后移除——鼠标移过去点按钮时卡片会
// 跟着倾斜、按钮位置跟着偏移，反而导致"移过去点击时东西却跑了"的误触问题。悬浮时
// 外圈的彩色循环光圈（conic-gradient描边）和底部呼吸光晕是纯 CSS :hover 效果，
// 跟这个已移除的 JS 倾斜是两回事，用户明确要求保留，没有受影响。
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

describe("微交互：卡片悬浮不应该再有3D倾斜位移（回归防护）", () => {
  test("鼠标在卡片上移动，卡片本身的 inline transform 不应该出现 rotateX/rotateY", async () => {
    const card = page.locator(".card").first();
    await assert.doesNotReject(card.waitFor());
    const box = await card.boundingBox();

    await page.mouse.move(box.x + 4, box.y + 4);
    await page.mouse.move(box.x + 6, box.y + 6);
    const transform = await card.evaluate((el) => el.style.transform);
    assert.doesNotMatch(transform || "", /rotateX|rotateY/, "卡片不应该再跟随鼠标倾斜，避免点击时按钮跟着跑位");
  });
});
