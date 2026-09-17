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
// 用 stale-while-revalidate：有缓存就先用缓存（快，离线也能用），同时在背后悄悄
// 拿网络上的最新版本更新缓存，下次打开就是新版本——比"缓存优先、永不更新"更不容易
// 让用户被卡在旧版本上出不来。

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
      cache.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    )
  );
});
