const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { makeAudioKey } = require("../js/components/audioStore.js");

// audioStore.js 其余部分（saveAudio/loadAudio/deleteAudio）直接包了一层浏览器原生
// IndexedDB，跟项目里其它纯 DOM/浏览器 API 封装（modal.js、confirm.js、
// avatarCropper.js 等）一样不写单测，靠端到端测试在真实浏览器里验证；
// makeAudioKey 是纯函数，这里单独测一下。

describe("makeAudioKey", () => {
  test("包含笔记 id，前缀固定，方便识别", () => {
    const key = makeAudioKey("note-123");
    assert.match(key, /^classNote:note-123:\d+$/);
  });

  test("同一个笔记 id 连续调用两次也不会完全一样（带时间戳）", async () => {
    const key1 = makeAudioKey("note-123");
    await new Promise((resolve) => setTimeout(resolve, 2));
    const key2 = makeAudioKey("note-123");
    assert.notEqual(key1, key2);
  });
});
