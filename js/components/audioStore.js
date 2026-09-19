(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var result = factory();
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.audioStore = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // 课堂笔记的录音音频用 IndexedDB 存（localStorage 存不下音频这种体量的二进制数据），
  // 跟 store.js 那套 localStorage 数据完全独立——store.js 里的 classNotes 记录只保存
  // 一个 audioKey 字符串当"指针"，真正的音频 Blob 存在这里，两边通过这个 key 对上。
  // indexedDBImpl 是测试用的注入点，不传就用浏览器全局的真实 indexedDB。

  const DB_NAME = "faner-app-audio";
  const DB_VERSION = 1;
  const STORE_NAME = "classNoteAudio";

  function getGlobalIndexedDB() {
    return typeof indexedDB !== "undefined" ? indexedDB : null;
  }

  function openDb(indexedDBImpl) {
    const idb = indexedDBImpl || getGlobalIndexedDB();
    if (!idb) return Promise.reject(new Error("当前环境不支持本地音频存储"));
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
      req.onerror = () => reject(req.error || new Error("打开本地音频数据库失败"));
    });
  }

  /** 保存一段录音 Blob，key 建议用 makeAudioKey() 生成。 */
  async function saveAudio(key, blob, indexedDBImpl) {
    const db = await openDb(indexedDBImpl);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(blob, key);
      tx.oncomplete = () => resolve(key);
      tx.onerror = () => reject(tx.error || new Error("保存录音失败"));
    });
  }

  /** 按 key 读回录音 Blob；key 为空或找不到都返回 null，不算错误。 */
  async function loadAudio(key, indexedDBImpl) {
    if (!key) return null;
    const db = await openDb(indexedDBImpl);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error("读取录音失败"));
    });
  }

  /** 删除一段录音；key 为空时什么也不做。 */
  async function deleteAudio(key, indexedDBImpl) {
    if (!key) return;
    const db = await openDb(indexedDBImpl);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("删除录音失败"));
    });
  }

  function makeAudioKey(noteId) {
    return `classNote:${noteId}:${Date.now()}`;
  }

  return { saveAudio, loadAudio, deleteAudio, makeAudioKey, DB_NAME, STORE_NAME };
});
