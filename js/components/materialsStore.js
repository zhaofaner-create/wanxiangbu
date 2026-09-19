(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var result = factory();
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.materialsStore = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // 课堂笔记上传的"拍照材料"（老师板书/讲义照片）用 IndexedDB 存图片 Blob——跟
  // audioStore.js 存录音的道理完全一样：localStorage 存不下图片这种体量的二进制数据。
  // store.js 里 classNotes 记录的 materials 数组只保存一个 storageKey 字符串当"指针"，
  // 真正的图片 Blob 存在这里，两边通过这个 key 对上。PPT 文件不走这里——PPT 在浏览器端
  // 解析成纯文本之后原文件就不留了，直接把 extractedText 存进 store.js（见 pptxText.js）。
  // indexedDBImpl 是测试用的注入点，不传就用浏览器全局的真实 indexedDB。

  const DB_NAME = "faner-app-materials";
  const DB_VERSION = 1;
  const STORE_NAME = "classNoteMaterials";

  function getGlobalIndexedDB() {
    return typeof indexedDB !== "undefined" ? indexedDB : null;
  }

  function openDb(indexedDBImpl) {
    const idb = indexedDBImpl || getGlobalIndexedDB();
    if (!idb) return Promise.reject(new Error("当前环境不支持本地图片存储"));
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = idb.open(DB_NAME, DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) {
          req.result.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("打开本地图片数据库失败"));
    });
  }

  /** 保存一张材料图片 Blob，key 建议用 makeMaterialKey() 生成。 */
  async function saveMaterialImage(key, blob, indexedDBImpl) {
    const db = await openDb(indexedDBImpl);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(blob, key);
      tx.oncomplete = () => resolve(key);
      tx.onerror = () => reject(tx.error || new Error("保存图片失败"));
    });
  }

  /** 按 key 读回图片 Blob；key 为空或找不到都返回 null，不算错误。 */
  async function loadMaterialImage(key, indexedDBImpl) {
    if (!key) return null;
    const db = await openDb(indexedDBImpl);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error("读取图片失败"));
    });
  }

  /** 删除一张材料图片；key 为空时什么也不做。 */
  async function deleteMaterialImage(key, indexedDBImpl) {
    if (!key) return;
    const db = await openDb(indexedDBImpl);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("删除图片失败"));
    });
  }

  function makeMaterialKey(noteId) {
    return `classNoteMaterial:${noteId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  }

  return { saveMaterialImage, loadMaterialImage, deleteMaterialImage, makeMaterialKey, DB_NAME, STORE_NAME };
});
