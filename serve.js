#!/usr/bin/env node
"use strict";
// 万象簿本地服务器——零依赖，只用 Node 内置模块，不需要联网装任何东西。
// 用途：走"服务器模式"打开 App 时用（能装到桌面/离线缓存），双击 index.html
// 那条老路径完全不受影响，两种打开方式并存、互不冲突。

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8420;

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

const server = http.createServer((req, res) => {
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

server.listen(PORT, "127.0.0.1", () => {
  console.log("万象簿本地服务器已启动：http://localhost:" + PORT + "/");
  console.log("在浏览器里打开这个地址（不是双击 index.html），才能使用「安装到桌面」和离线缓存功能。");
  console.log("按 Ctrl+C 停止服务器。");
});
