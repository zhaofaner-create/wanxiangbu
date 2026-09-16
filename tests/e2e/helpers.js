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
