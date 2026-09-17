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

  test("绑定的是 0.0.0.0 而不是 127.0.0.1，这样手机/iPad同一个WiFi下才能连上", () => {
    const serveJs = fs.readFileSync(path.join(ROOT, "serve.js"), "utf8");
    assert.match(serveJs, /listen\(PORT,\s*"0\.0\.0\.0"/, "必须监听 0.0.0.0，只绑 127.0.0.1 的话局域网设备连不上");
  });
});

describe("PWA：serve.js 里 listLanAddresses（找出手机能连的局域网地址）", () => {
  const { listLanAddresses } = require(path.join(ROOT, "serve.js"));

  test("从网卡列表里挑出局域网 IPv4 地址，过滤掉回环地址和IPv6", () => {
    const fakeInterfaces = {
      lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
      en0: [
        { family: "IPv4", internal: false, address: "192.168.1.23" },
        { family: "IPv6", internal: false, address: "fe80::1" },
      ],
    };
    assert.deepEqual(listLanAddresses(fakeInterfaces), ["192.168.1.23"]);
  });

  test("同时连了多个网卡（比如WiFi+有线）时，两个地址都要列出来", () => {
    const fakeInterfaces = {
      en0: [{ family: "IPv4", internal: false, address: "192.168.1.23" }],
      en5: [{ family: "IPv4", internal: false, address: "10.0.0.5" }],
    };
    assert.deepEqual(listLanAddresses(fakeInterfaces), ["192.168.1.23", "10.0.0.5"]);
  });

  test("只有回环地址、没有真实局域网地址时返回空数组，不报错", () => {
    const fakeInterfaces = { lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }] };
    assert.deepEqual(listLanAddresses(fakeInterfaces), []);
  });

  test("不传参数时，会读真实的 os.networkInterfaces()，不报错也不返回 undefined", () => {
    assert.ok(Array.isArray(listLanAddresses()));
  });
});
