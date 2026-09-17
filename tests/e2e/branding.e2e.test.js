// 品牌与个人信息端到端测试：软件改名后的图标/名字展示，以及"个人信息"页面
// 里编辑昵称/头像之后，侧边栏底部的小卡片能不能立刻同步、刷新页面后还在。
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

describe("品牌：软件名字与图标", () => {
  test("左上角显示的是新软件名字（不是'凡尔的APP'），并且带一个图标", async () => {
    const brandName = await page.locator(".app-brand-name").innerText();
    assert.equal(brandName, "万象簿");
    assert.equal(await page.locator(".app-brand-icon svg").count(), 1, "品牌区应该有一个图标");
    assert.equal(await page.locator(".sidebar", { hasText: "凡尔的APP" }).count(), 0, "不应该再出现老名字");
  });
});

describe("个人信息：昵称与头像", () => {
  test("默认侧边栏底部显示占位文案和默认头像", async () => {
    const name = await page.locator("#sidebar-profile-name").innerText();
    assert.equal(name, "设置昵称");
    const avatar = await page.locator("#sidebar-profile-avatar").innerText();
    assert.equal(avatar, "🙂");
  });

  test("点击侧边栏底部的头像条会跳转到'个人信息'页面", async () => {
    await page.locator("#sidebar-profile").click();
    assert.equal(await page.locator("#topbar-title").innerText(), "个人信息");
  });

  test("在个人信息页改昵称和头像，侧边栏底部立刻同步更新，不用手动刷新", async () => {
    await goToModule(page, "个人信息");
    const nameInput = page.locator(".field-input[type=text]");
    await nameInput.fill("阿凡");
    await nameInput.blur();
    assert.equal(await page.locator("#sidebar-profile-name").innerText(), "阿凡");

    await page.locator(".avatar-option", { hasText: "🐼" }).click();
    assert.equal(await page.locator("#sidebar-profile-avatar").innerText(), "🐼");
  });

  test("改完昵称头像刷新页面，设置还在", async () => {
    await goToModule(page, "个人信息");
    const nameInput = page.locator(".field-input[type=text]");
    await nameInput.fill("小明");
    await nameInput.blur();
    await page.locator(".avatar-option", { hasText: "🦊" }).click();

    await page.reload();
    await page.waitForSelector(".nav-item");
    assert.equal(await page.locator("#sidebar-profile-name").innerText(), "小明");
    assert.equal(await page.locator("#sidebar-profile-avatar").innerText(), "🦊");
  });
});

describe("个人信息：上传相册照片当头像", () => {
  // 一张 1x1 的最小合法 PNG（红色像素），不需要真实文件落盘，Playwright 的
  // setInputFiles 支持直接传 buffer——够用来验证"选文件→压缩编码→存起来→显示"
  // 这一整条链路，不需要图片内容本身有意义。
  const TINY_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

  test("上传照片后，个人信息页大头像和侧边栏头像都变成图片，并且能持久化到刷新之后", async () => {
    await goToModule(page, "个人信息");
    await page.locator(".avatar-file-input").setInputFiles({
      name: "avatar.png",
      mimeType: "image/png",
      buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
    });

    // 选好文件后会先弹出截取弹窗（拖动/缩放选区域），确认裁剪之后才真正保存头像。
    await page.waitForSelector(".avatar-crop-box", { timeout: 5000 });
    await page.locator(".avatar-crop-box .btn-primary").click();

    // 压缩编码是异步的（FileReader + Image + canvas），轮询等大头像预览里出现 <img>
    await page.waitForSelector(".profile-avatar-large img", { timeout: 5000 });
    const largeSrc = await page.locator(".profile-avatar-large img").getAttribute("src");
    assert.ok(largeSrc && largeSrc.startsWith("data:image/jpeg"), "应该被重新编码成压缩过的 JPEG data URL");

    await page.waitForSelector("#sidebar-profile-avatar img", { timeout: 5000 });
    assert.equal(await page.locator("#sidebar-profile-avatar img").getAttribute("src"), largeSrc, "侧边栏头像应该和大预览用同一张压缩后的图");

    await page.reload();
    await page.waitForSelector(".nav-item");
    await page.waitForSelector("#sidebar-profile-avatar img", { timeout: 5000 });
    assert.equal(await page.locator("#sidebar-profile-avatar img").getAttribute("src"), largeSrc, "刷新页面后照片头像应该还在（已经持久化）");
  });

  test("上传照片之后点'移除照片，换回表情'，能正确退回之前选的 emoji", async () => {
    await goToModule(page, "个人信息");
    await page.locator(".avatar-option", { hasText: "🐨" }).click();
    await page.locator(".avatar-file-input").setInputFiles({
      name: "avatar.png",
      mimeType: "image/png",
      buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
    });
    await page.waitForSelector(".avatar-crop-box", { timeout: 5000 });
    await page.locator(".avatar-crop-box .btn-primary").click();
    await page.waitForSelector(".profile-avatar-large img", { timeout: 5000 });

    await page.locator("button", { hasText: "移除照片，换回表情" }).click();
    await page.waitForFunction(() => !document.querySelector(".profile-avatar-large img"), { timeout: 3000 });
    const avatarText = await page.locator(".profile-avatar-large").innerText();
    assert.equal(avatarText, "🐨", "移除照片后应该退回上传之前选的那个 emoji，而不是默认表情");
    assert.equal(await page.locator("#sidebar-profile-avatar").innerText(), "🐨");
  });

  test("选文件时选了非图片文件，应该提示错误，不会崩溃也不会存进设置", async () => {
    await goToModule(page, "个人信息");
    await page.locator(".avatar-file-input").setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("这不是图片", "utf-8"),
    });
    await page.waitForFunction(
      () => document.body.innerText.includes("请选择一张图片文件"),
      { timeout: 3000 }
    );
    assert.equal(await page.locator(".profile-avatar-large img").count(), 0, "选错文件类型不应该出现图片头像");
  });
});
