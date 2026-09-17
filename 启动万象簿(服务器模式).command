#!/bin/bash
# 双击这个文件：用本地服务器模式打开万象簿（能安装到 Dock、支持离线缓存）。
# 双击 index.html 那种最简单的打开方式仍然完全可用，两者互不影响。
cd "$(dirname "$0")"
PORT=8420
node serve.js &
SERVER_PID=$!
sleep 1
open "http://localhost:${PORT}/index.html" 2>/dev/null || echo "请手动在浏览器打开 http://localhost:${PORT}/index.html"
echo "服务器正在运行，关闭这个窗口即可停止服务器。"
wait "$SERVER_PID"
