// 响应式布局端到端测试：验证平板/手机宽度下的导航呈现方式（图标条 / 可滑出抽屉）
// 在不改变任何功能的前提下正常工作——点击依然能正确跳转模块，数据依然是同一份。
// 桌面宽度下的行为由 app.e2e.test.js 已经覆盖，这里只加"因为屏幕变窄而变化"的那部分。
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { gotoApp } from "./helpers.js";

const DESKTOP = { width: 1280, height: 800 };
const TABLET = { width: 820, height: 1180 };
const PHONE = { width: 390, height: 844 };

let browser;
let context;
let page;

before(async () => {
  browser = await chromium.launch({ args: ["--no-sandbox"] });
});

after(async () => {
  await browser.close();
});

afterEach(async () => {
  await context.close();
});

async function openAt(viewport) {
  context = await browser.newContext({ viewport });
  page = await context.newPage();
  await gotoApp(page);
  return page;
}

describe("响应式布局 · 桌面宽度（>1024px）", () => {
  test("侧边栏完整展示（带文字），汉堡菜单按钮不可见", async () => {
    await openAt(DESKTOP);
    const sidebarBox = await page.locator(".sidebar").boundingBox();
    assert.ok(sidebarBox && sidebarBox.width > 150, "桌面宽度下侧边栏应该是完整宽度（带文字）");
    await assert.doesNotReject((async () => {
      const visible = await page.locator("#menu-toggle").isVisible();
      assert.equal(visible, false);
    })());
    const labelDisplay = await page.locator(".nav-item span:not(.nav-icon-tile)").first().evaluate((el) => getComputedStyle(el).display);
    assert.notEqual(labelDisplay, "none");
  });
});

describe("响应式布局 · 平板宽度（641px–1024px）", () => {
  test("侧边栏收窄，图标下面配一行小字标签（不是彻底隐藏成纯图标），点击导航依然能正确跳转", async () => {
    await openAt(TABLET);
    const sidebarBox = await page.locator(".sidebar").boundingBox();
    assert.ok(sidebarBox && sidebarBox.width <= 100, `平板宽度下侧边栏应该收窄，实际宽度 ${sidebarBox && sidebarBox.width}`);
    // 早期版本在平板宽度下把文字名称整个隐藏、只剩图标，触屏平板没有鼠标悬浮，
    // 完全没法分辨图标对应哪个模块；改成图标上面配一行极小文字标签后，标签必须
    // 保持可见（只是字号变小），不能再是 display:none。
    const label = page.locator(".nav-item span:not(.nav-icon-tile)").first();
    const labelDisplay = await label.evaluate((el) => getComputedStyle(el).display);
    assert.notEqual(labelDisplay, "none", "平板下文字标签应该仍然可见（只是变小），不应该整个隐藏");
    const fontSize = await label.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    assert.ok(fontSize < 13, `平板下标签字号应该比桌面端小，实际 ${fontSize}px`);

    // 图标本身依然可点击，且能正确跳转到对应模块——这是"只变布局、不变功能"的核心验证点
    await page.locator(".nav-item", { hasText: "学习任务" }).click();
    const title = await page.locator("#topbar-title").innerText();
    assert.equal(title, "学习任务");
  });
});

describe("响应式布局 · 手机宽度（≤640px）", () => {
  test("默认收起侧边栏，汉堡按钮可见，侧边栏在视口之外", async () => {
    await openAt(PHONE);
    const toggleVisible = await page.locator("#menu-toggle").isVisible();
    assert.equal(toggleVisible, true, "手机宽度下应该出现汉堡菜单按钮");
    const isOpen = await page.locator(".app-shell").evaluate((el) => el.classList.contains("nav-open"));
    assert.equal(isOpen, false, "初始状态抽屉应该是收起的");
    const sidebarBox = await page.locator(".sidebar").boundingBox();
    assert.ok(sidebarBox.x + sidebarBox.width <= 1, `收起状态下侧边栏应该完全滑出视口左侧，实际 x=${sidebarBox.x}`);
  });

  test("点击汉堡按钮滑出抽屉，点击遮罩层收起，不触发导航", async () => {
    await openAt(PHONE);
    await page.locator("#menu-toggle").click();
    let isOpen = await page.locator(".app-shell").evaluate((el) => el.classList.contains("nav-open"));
    assert.equal(isOpen, true, "点击汉堡按钮后抽屉应该展开");
    // 等滑出的弹簧过渡动画播放完，再读取最终位置——用轮询而不是固定时长，避免多个
    // 测试文件并发跑、系统繁忙导致动画变慢时固定等待不够用。
    await page.waitForFunction(() => {
      const box = document.querySelector(".sidebar").getBoundingClientRect();
      return box.x >= -1;
    }, { timeout: 5000 });
    let sidebarBox = await page.locator(".sidebar").boundingBox();
    assert.ok(sidebarBox.x >= -1, `展开状态下侧边栏应该滑入视口，实际 x=${sidebarBox.x}`);
    const titleBeforeClose = await page.locator("#topbar-title").innerText();

    // 遮罩层覆盖整个视口，但抽屉本身（240px宽）盖在它上面，要点在抽屉右侧空白处才是真的点在遮罩上
    await page.locator("#nav-backdrop").click({ position: { x: 320, y: 100 } });
    isOpen = await page.locator(".app-shell").evaluate((el) => el.classList.contains("nav-open"));
    assert.equal(isOpen, false, "点击遮罩层后抽屉应该收起");
    const titleAfterClose = await page.locator("#topbar-title").innerText();
    assert.equal(titleAfterClose, titleBeforeClose, "点击遮罩层只应该收起抽屉，不应该改变当前页面");
  });

  test("展开抽屉后点击某个模块，能正确跳转，并且抽屉自动收起", async () => {
    await openAt(PHONE);
    await page.locator("#menu-toggle").click();
    await page.locator(".nav-item", { hasText: "个人记账" }).click();

    const title = await page.locator("#topbar-title").innerText();
    assert.equal(title, "个人记账", "手机端抽屉里点击模块应该和桌面端一样正确跳转");
    const isOpen = await page.locator(".app-shell").evaluate((el) => el.classList.contains("nav-open"));
    assert.equal(isOpen, false, "选中模块后抽屉应该自动收起，不挡住内容");
  });

  test("功能一致性：手机宽度下依然可以正常添加一条今日计划（业务逻辑不受布局影响）", async () => {
    await openAt(PHONE);
    await page.locator("#menu-toggle").click();
    await page.locator(".nav-item", { hasText: "今日计划" }).click();
    await page.locator("button", { hasText: "+ 添加今日事项" }).click();
    await page.locator(".modal-box [name=text]").fill("手机端添加的计划");
    await page.locator(".modal-box [name=time]").fill("09:00");
    await page.locator(".modal-box button[type=submit]").click();
    const rowText = await page.locator(".timeline-row", { hasText: "手机端添加的计划" }).innerText();
    assert.ok(rowText.includes("手机端添加的计划"));
  });

  test("抽屉展开后，导航项是横向排列（图标+文字同一行），不应该被平板断点的纵向布局影响", async () => {
    // 平板断点把图标改成"上图标下文字"纵向排列；手机抽屉宽度足够，理应还是
    // 桌面那种"图标+文字同一行"。两个 max-width 断点在手机宽度下会同时生效，
    // 如果手机端的 CSS 没有显式把 flex-direction 改回 row，就会不小心沿用
    // 平板断点的纵向排列——这里专门锁定这一点，防止以后回归。
    await openAt(PHONE);
    await page.locator("#menu-toggle").click();
    const flexDirection = await page.locator(".nav-item").first().evaluate((el) => getComputedStyle(el).flexDirection);
    assert.equal(flexDirection, "row", "手机抽屉里的导航项应该是横向排列");
  });

  test("页面顶部操作按钮行不会挤成一整块乱序换行——翻页按钮和管理类按钮分成两组，各自整齐换行", async () => {
    await openAt(PHONE);
    await page.locator("#menu-toggle").click();
    await page.locator(".nav-item", { hasText: "个人记账" }).click();
    await page.waitForSelector(".section-row");

    const prevMonthBtn = page.locator("button", { hasText: "上一月" });
    const accountsBtn = page.locator("button", { hasText: "账户管理" });
    const prevBox = await prevMonthBtn.boundingBox();
    const accountsBox = await accountsBtn.boundingBox();
    assert.ok(prevBox && accountsBox, "翻页按钮和账户管理按钮都应该能找到");
    assert.ok(
      accountsBox.y > prevBox.y + prevBox.height - 2,
      "账户管理这组管理类按钮应该换到翻页按钮下面单独一行，而不是和翻页按钮挤在同一行里"
    );
  });
});
