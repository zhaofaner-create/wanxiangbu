import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const INDEX_URL = "file://" + path.resolve(__dirname, "../../index.html");

export async function gotoApp(page) {
  const violations = [];
  page.on("request", (req) => {
    if (/^https?:/.test(req.url())) violations.push(req.url());
  });
  console.error("[debug] gotoApp: before goto");
  await page.goto(INDEX_URL);
  console.error("[debug] gotoApp: after goto, before waitForSelector");
  await page.waitForSelector(".nav-item");
  console.error("[debug] gotoApp: after waitForSelector");
  return violations; // 调用方可以在交互结束后断言这个数组是空的（PRD验收标准1：全程无网络请求）
}

export async function goToModule(page, label) {
  await page.locator(".nav-item", { hasText: label }).click();
}

export async function fillModal(page, values) {
  for (const [name, value] of Object.entries(values)) {
    const field = page.locator(`.modal-box [name="${name}"]`);
    const tag = await field.evaluate((el) => el.tagName.toLowerCase());
    if (tag === "select") {
      await field.selectOption(String(value));
    } else {
      await field.fill(String(value));
    }
  }
}

export async function submitModal(page) {
  await page.locator(".modal-box button[type=submit]").click();
}

/**
 * 等到某个 locator 的文字匹配上给定的正则，再往下走——用来读那些"数字会先滚动播放
 * 一小段动画才停在最终值"的地方（比如记账页收入/支出/结余的里程表效果），
 * 不能像普通文字那样点击完立刻同步读到最终结果，要轮询等它播完。
 */
export async function waitForText(locator, pattern, timeout = 3000) {
  const target = locator.first();
  await target.waitFor();
  const deadline = Date.now() + timeout;
  let lastText = "";
  while (Date.now() < deadline) {
    lastText = await target.innerText();
    if (pattern.test(lastText)) return lastText;
    await target.page().waitForTimeout(30);
  }
  throw new Error(`等待文字匹配 ${pattern} 超时，最后一次读到的内容是：${JSON.stringify(lastText)}`);
}
