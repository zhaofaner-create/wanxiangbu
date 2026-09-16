// 供测试使用的内存版 localStorage 替代品，实现 getItem/setItem 接口即可。
function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
  };
}

module.exports = { createMemoryStorage };
