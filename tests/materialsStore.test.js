const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { makeMaterialKey } = require("../js/components/materialsStore.js");

// materialsStore.js 其余部分（saveMaterialImage/loadMaterialImage/deleteMaterialImage）
// 直接包了一层浏览器原生 IndexedDB，跟 audioStore.js 一样不写单测，靠端到端测试在真实
// 浏览器里验证；makeMaterialKey 是纯函数，这里单独测一下。

describe("makeMaterialKey", () => {
  test("包含笔记 id，前缀固定，方便识别", () => {
    const key = makeMaterialKey("note-123");
    assert.match(key, /^classNoteMaterial:note-123:\d+:[a-z0-9]+$/);
  });

  test("同一个笔记 id 连续调用两次也不会一样（同一毫秒内多张图片也不会撞 key）", () => {
    const key1 = makeMaterialKey("note-123");
    const key2 = makeMaterialKey("note-123");
    assert.notEqual(key1, key2);
  });
});
