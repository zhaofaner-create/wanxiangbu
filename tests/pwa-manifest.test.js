// PWA 配置的静态检查：manifest.json 格式对不对、引用的图标文件是不是真的存在、
// index.html 有没有正确接上 manifest/图标/Service Worker 注册脚本。纯文件系统
// 检查，不需要启动浏览器，跑得快，用来防止以后手滑改坏这几个文件。
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

describe("PWA：manifest.json", () => {
  const manifestPath = path.join(ROOT, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  test("包含安装横幅/桌面图标需要的关键字段", () => {
    assert.equal(manifest.name, "万象簿");
    assert.equal(manifest.short_name, "万象簿");
    assert.equal(manifest.display, "standalone");
    assert.ok(manifest.start_url, "需要 start_url");
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, "至少要有2个尺寸的图标");
  });

  test("manifest 里引用的每一个图标文件都真实存在", () => {
    for (const icon of manifest.icons) {
      const iconPath = path.join(ROOT, icon.src);
      assert.ok(fs.existsSync(iconPath), `图标文件不存在：${icon.src}`);
      assert.ok(fs.statSync(iconPath).size > 0, `图标文件是空的：${icon.src}`);
    }
  });

  test("图标尺寸至少覆盖 192 和 512（安装横幅/应用商店常见要求）", () => {
    const sizes = manifest.icons.map((i) => i.sizes);
    assert.ok(sizes.includes("192x192"), "缺 192x192 图标");
    assert.ok(sizes.includes("512x512"), "缺 512x512 图标");
  });
});

describe("PWA：index.html 接线", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

  test("引用了 manifest.json", () => {
    assert.match(html, /<link[^>]+rel="manifest"[^>]+href="manifest\.json"/);
  });

  test("Service Worker 注册脚本有 file:// 判断守卫（不能在双击打开时也尝试注册）", () => {
    assert.match(html, /serviceWorker/);
    assert.match(html, /window\.location\.protocol\s*!==\s*["']file:["']/, "必须显式排除 file:// 协议，否则双击打开会报错/行为不一致");
  });
});

describe("PWA：sw.js 本身", () => {
  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");

  test("监听了 install/activate/fetch 三个生命周期事件", () => {
    assert.match(sw, /addEventListener\(\s*["']install["']/);
    assert.match(sw, /addEventListener\(\s*["']activate["']/);
    assert.match(sw, /addEventListener\(\s*["']fetch["']/);
  });

  test("fetch 处理只拦截同源请求（不会把跨域请求也代理缓存）", () => {
    assert.match(sw, /origin\s*!==\s*self\.location\.origin/);
  });
});

describe("PWA：本地服务器脚本 serve.js", () => {
  test("存在且没有把路径穿越到项目目录之外的漏洞防护缺失", () => {
    const serveJs = fs.readFileSync(path.join(ROOT, "serve.js"), "utf8");
    assert.match(serveJs, /startsWith\(ROOT\)/, "必须校验最终文件路径仍在项目目录内");
  });
});
