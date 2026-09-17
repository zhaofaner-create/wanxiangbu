// 头像上传交互式截取弹窗的端到端测试：选好照片文件后不再自动居中裁剪，而是弹出
// 一个可以拖动图片、拉动滑块缩放的取景框，用户确认后才真正保存成头像。
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { gotoApp, goToModule } from "./helpers.js";

// 一张 40x20 的小 PNG（顶部一行绿色做标记），够用来测试"选中文件→弹窗出现→
// 图片渲染出来→可以拖动/缩放→确认后写入头像"整条链路，不需要真的很大的图。
const FIXTURE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAIAAABwJOjsAAAAK0lEQVR4nGNk+M8wIIDxRIDGgFjMNCC2jlo8avGoxaMWj1o8avGoxSPbYgBfMgJmYroBZQAAAABJRU5ErkJggg==";

let browser;
let context;
let page;
let fixturePath;

before(async () => {
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  fixturePath = path.join(os.tmpdir(), "faner-avatar-fixture.png");
  fs.writeFileSync(fixturePath, Buffer.from(FIXTURE_PNG_BASE64, "base64"));
});

after(async () => {
  await browser.close();
  fs.rmSync(fixturePath, { force: true });
});

beforeEach(async () => {
  context = await browser.newContext();
  page = await context.newPage();
  await gotoApp(page);
  await goToModule(page, "个人信息");
});

afterEach(async () => {
  await context.close();
});

describe("头像上传：交互式截取弹窗", () => {
  test("选好文件后会弹出截取弹窗，而不是直接自动保存头像", async () => {
    await page.setInputFiles(".avatar-file-input", fixturePath);
    const box = page.locator(".avatar-crop-box");
    await assert.doesNotReject(box.waitFor());
    await assert.doesNotReject(page.locator(".avatar-crop-viewport img").waitFor());
    // 弹窗还开着的时候，"移除照片"按钮不应该出现——说明这时候头像确实还没被保存。
    assert.equal(await page.locator("text=移除照片，换回表情").count(), 0);
  });

  test("拖动图片、拉动缩放滑块后点确认裁剪，头像会被保存并且弹窗关闭", async () => {
    await page.setInputFiles(".avatar-file-input", fixturePath);
    const viewport = page.locator(".avatar-crop-viewport");
    await viewport.waitFor();
    const box = await viewport.boundingBox();

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 25, box.y + box.height / 2 + 10, { steps: 5 });
    await page.mouse.up();

    await page.locator(".avatar-crop-zoom").evaluate((el) => {
      el.value = "2";
      el.dispatchEvent(new Event("input"));
    });

    await page.locator(".avatar-crop-box .btn-primary").click();
    await assert.doesNotReject(page.locator(".avatar-crop-box").waitFor({ state: "detached" }));

    // 确认之后：预览卡片和"移除照片"按钮都应该出现，且头像 img 的 src 是压缩后的 data URL。
    const avatarImg = page.locator(".profile-avatar-large img");
    await assert.doesNotReject(avatarImg.waitFor());
    const src = await avatarImg.getAttribute("src");
    assert.match(src, /^data:image\/jpeg;base64,/);
    assert.equal(await page.locator("text=移除照片，换回表情").count(), 1);
  });

  test("点取消不会保存头像，头像维持原来的 emoji", async () => {
    await page.setInputFiles(".avatar-file-input", fixturePath);
    await page.locator(".avatar-crop-box").waitFor();
    await page.locator(".avatar-crop-box .btn-ghost", { hasText: "取消" }).click();
    await assert.doesNotReject(page.locator(".avatar-crop-box").waitFor({ state: "detached" }));
    assert.equal(await page.locator(".profile-avatar-large img").count(), 0);
  });

  test("放大后，弹窗里的图片显示尺寸会变大（缩放滑块确实生效）", async () => {
    await page.setInputFiles(".avatar-file-input", fixturePath);
    const img = page.locator(".avatar-crop-viewport img");
    await img.waitFor();
    const widthBefore = await img.evaluate((el) => parseFloat(el.style.width));

    await page.locator(".avatar-crop-zoom").evaluate((el) => {
      el.value = "3";
      el.dispatchEvent(new Event("input"));
    });
    const widthAfter = await img.evaluate((el) => parseFloat(el.style.width));
    assert.ok(widthAfter > widthBefore, "放大后图片的显示宽度应该变大");
  });
});
