#!/usr/bin/env node
"use strict";
// 万象簿本地服务器——零依赖，只用 Node 内置模块，不需要联网装任何东西。
// 用途：走"服务器模式"打开 App 时用（能装到桌面/离线缓存），双击 index.html
// 那条老路径完全不受影响，两种打开方式并存、互不冲突。

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8420;

/**
 * 找出这台电脑在局域网里的 IPv4 地址（可能不止一个，比如同时连了Wi-Fi和有线网）。
 * 用来在启动日志里告诉用户"手机/iPad在同一个WiFi下，打开这个地址就能用"——
 * 光绑定 0.0.0.0 监听所有网卡还不够，用户不知道该在手机浏览器里敲哪个地址。
 * 只挑局域网常见网段（不是 127.0.0.1 这种回环地址，也不是 IPv6），没有的话返回空数组。
 *
 * interfaces 参数可选，默认读真实的 os.networkInterfaces()；测试的时候可以传一份
 * 假数据进来，不用依赖跑测试这台机器实际连了什么网。
 */
function listLanAddresses(interfaces) {
  const ifaces = interfaces || os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function createServer() {
  return http.createServer((req, res) => {
    let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = path.normalize(path.join(ROOT, urlPath));

    // 防止 URL 里带 ../ 之类的路径穿越到项目目录之外。
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found: " + urlPath);
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      res.end(data);
    });
  });
}

// require.main === module：只有直接 `node serve.js` 启动时才真的去监听端口、
// 打印日志；被 tests/pwa-manifest.test.js 之类当模块 require 进去做纯函数单测
// 时不会占用端口、也不会打印一堆日志。
if (require.main === module) {
  const server = createServer();
  // 绑定 0.0.0.0（而不是只绑 127.0.0.1）：这样同一个 WiFi/局域网下的手机、iPad
  // 也能连上这台电脑的服务器，不再局限于"只能在这台电脑自己的浏览器里打开"。
  server.listen(PORT, "0.0.0.0", () => {
    console.log("万象簿本地服务器已启动：http://localhost:" + PORT + "/");
    console.log("在浏览器里打开这个地址（不是双击 index.html），才能使用「安装到桌面」和离线缓存功能。");

    const lanAddresses = listLanAddresses();
    if (lanAddresses.length > 0) {
      console.log("");
      console.log("手机/iPad 想用的话：确保它和这台电脑连的是同一个 WiFi，然后在手机浏览器里打开：");
      lanAddresses.forEach((addr) => console.log("  http://" + addr + ":" + PORT + "/"));
      console.log("（Safari 打开后可以点「分享」→「添加到主屏幕」，就会有个能全屏打开的图标，跟装了App一样）");
      console.log("注意：服务器开着的时候，同一个WiFi下的其他人理论上也能访问到这个地址，用完记得 Ctrl+C 关掉。");
    }
    console.log("");
    console.log("按 Ctrl+C 停止服务器。");
  });
}

module.exports = { listLanAddresses, createServer };
