"use strict";
// 万象簿 Service Worker——只服务于"通过本地服务器打开"的场景。
// 直接双击 index.html（file:// 协议）时，浏览器根本不允许注册 Service Worker
// （必须是 http(s) 或 localhost 这种"安全上下文"），index.html 里的注册脚本也
// 已经做了 file:// 判断守卫、会直接跳过——所以这个文件的存在完全不影响"双击打开"
// 这条老路径，只有走 serve.js 起的本地服务器时才会真正生效。
//
// 缓存策略：不写死具体文件名单，而是"访问过什么就缓存什么"。这个 App 所有模块的
// JS 文件都是 index.html 里一次性用 <script> 标签加载的（不是按需懒加载），所以
// 第一次联网打开时会自然而然地把 index.html/css/全部 js 模块/manifest/图标都请求
// 一遍、顺手缓存下来——以后新增模块文件也完全不用回来改这个 sw.js，不存在"忘记
// 同步缓存清单导致离线后某个新模块加载不出来"这种维护负担。
//
// 用"网络优先、离线兜底"：每次都先尝试拿网络上此刻真正在跑的版本，只有网络请求
// 失败（真的离线）时才退回缓存里最后一次成功缓存的版本。
// 之前用的是 stale-while-revalidate（有缓存就先返回缓存，同时在背后悄悄拿网络新版本
// 更新缓存，下次打开才是新版本）——这在"服务器代码会变、但访问地址不变"的场景下有个
// 坑：本地开发时经常会把同一个 8420 端口先后指向不同的分支/文件夹（比如从旧分支切到
// 修完 bug 的新分支），但浏览器的 Service Worker 缓存是按"源"（http://localhost:8420）
// 存的，不知道背后换了文件夹——stale-while-revalidate 会先返回上一次缓存下来的旧版本
// （哪怕新文件夹里代码已经改好了），导致刷新甚至重启服务器都好像"改了没生效"。换成
// 网络优先后，只要服务器真的在跑（不管是哪个分支/文件夹），刷新页面看到的就一定是
// 它现在实际返回的内容；只有服务器完全连不上（离线）时才会退回缓存，离线可用性不受影响。

const CACHE_NAME = "wanxiangbu-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // 只处理同源 GET 请求，其他一律不拦截、走浏览器默认行为。
  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cache.match(req))
    )
  );
});
