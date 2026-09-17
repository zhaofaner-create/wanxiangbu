// PWA 端到端测试，覆盖两条完全独立的打开路径：
//   1) 双击 index.html（file:// 协议）——必须和以前一模一样，Service Worker
//      绝对不能尝试注册（这个协议下浏览器本来就不允许，注册脚本也做了判断守卫）。
//   2) 走 serve.js 起的本地服务器（http://127.0.0.1:<port>/）——Service Worker
//      要能成功注册，manifest 要能被浏览器读到，而且"先联网访问一次、再切到
//      离线状态刷新"页面依然能正常打开（离线缓存真的生效了）。
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gotoApp } from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const PORT = 8934; // 用一个测试专属端口，避免和用户手动启动的 8420 撞车

let browser;

before(async () => {
  browser = await chromium.launch({ args: ["--no-sandbox"] });
});

after(async () => {
  await browser.close();
});

describe("PWA：file:// 直接双击打开——完全不受影响", () => {
  test("不会尝试注册 Service Worker，也不会多发任何网络请求", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const violations = await gotoApp(page); // 断言过程中没有 http(s) 请求
    assert.equal(violations.length, 0, "file:// 模式下不应该有任何 http(s) 请求");

    // file:// 不是"安全上下文"，Chrome 在这种页面上调用
    // navigator.serviceWorker.getRegistrations() 本身就会直接抛
    // InvalidStateError（连查都查不了）——这恰好从另一个角度证明了这里不可能
    // 注册成功任何 Service Worker，把这个异常也当作"没有注册"来断言。
    const registrations = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return 0;
      try {
        return (await navigator.serviceWorker.getRegistrations()).length;
      } catch (e) {
        return 0;
      }
    });
    assert.equal(registrations, 0, "file:// 模式下不应该注册任何 Service Worker");
    await context.close();
  });
});

describe("PWA：本地服务器模式——真正的安装/离线能力", () => {
  let serverProcess;
  const baseUrl = `http://127.0.0.1:${PORT}`;

  before(async () => {
    serverProcess = spawn(process.execPath, ["serve.js"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: "pipe",
    });
    // 等服务器真正准备好再往下走，而不是瞎等固定的毫秒数。
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("serve.js 启动超时")), 8000);
      serverProcess.stdout.on("data", (chunk) => {
        if (chunk.toString().includes("已启动")) {
          clearTimeout(timer);
          resolve();
        }
      });
      serverProcess.on("error", reject);
    });
  });

  after(async () => {
    if (serverProcess) serverProcess.kill();
  });

  test("manifest.json 能被正常访问到，字段齐全", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const res = await page.goto(`${baseUrl}/manifest.json`);
    assert.equal(res.status(), 200);
    const manifest = await res.json();
    assert.equal(manifest.name, "万象簿");
    await context.close();
  });

  test("Service Worker 能成功注册并进入 activated 状态", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".nav-item");

    const state = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return reg.active ? reg.active.state : null;
    });
    assert.equal(state, "activated", "Service Worker 应该进入 activated 状态");
    await context.close();
  });

  test("联网访问一次、缓存建立后，切到离线状态刷新页面依然能打开", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();

    // 第一次联网打开，让 Service Worker 有机会把 index.html/css/js 都缓存下来。
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".nav-item");
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    // 缓存写入是 fetch 拦截里"顺手"做的，给它一点时间落盘，轮询直到缓存里真的有内容。
    await page.waitForFunction(
      async () => {
        const keys = await caches.keys();
        if (keys.length === 0) return false;
        const cache = await caches.open(keys[0]);
        const requests = await cache.keys();
        return requests.some((r) => r.url.endsWith("/index.html")) && requests.some((r) => r.url.endsWith(".js"));
      },
      { timeout: 5000 }
    );

    // 切到离线状态，模拟"没有网络"，再刷新一次。
    await context.setOffline(true);
    await page.reload();
    await page.waitForSelector(".nav-item", { timeout: 5000 });
    const title = await page.title();
    assert.equal(title, "万象簿", "离线状态下刷新页面，App 依然应该能正常打开");

    await context.setOffline(false);
    await context.close();
  });
});
