const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeForMatch,
  charOverlapRatio,
  candidateMatchRatio,
  findBestMatchIndex,
  buildPreviewWindow,
} = require("../js/components/textMatch.js");

describe("textMatch：演讲提词的语音-句子相似度匹配", () => {
  test("normalizeForMatch：去掉标点/空白，转小写", () => {
    assert.equal(normalizeForMatch("大家好，今天天气不错！"), "大家好今天天气不错");
    assert.equal(normalizeForMatch("Hello, World!"), "helloworld");
    assert.equal(normalizeForMatch("  多余空格  也  去掉 "), "多余空格也去掉");
    assert.equal(normalizeForMatch(""), "");
    assert.equal(normalizeForMatch(null), "");
  });

  test("charOverlapRatio：完全一致是1，完全不重叠是0", () => {
    assert.equal(charOverlapRatio("大家好", "大家好"), 1);
    assert.equal(charOverlapRatio("完全不同的内容", "大家好"), 0);
    assert.equal(charOverlapRatio("", "大家好"), 0);
    assert.equal(charOverlapRatio("大家好", ""), 0);
  });

  test("charOverlapRatio：部分重叠按候选句子的覆盖比例算，不看语序", () => {
    // "大家好"三个字都在"好大家"里出现过，语序不同也算满分
    assert.equal(charOverlapRatio("好大家", "大家好"), 1);
    // 候选句子4个字，只有2个字在 spoken 里出现过
    const ratio = charOverlapRatio("大家", "大家好呀");
    assert.equal(ratio, 0.5);
  });

  test("candidateMatchRatio：短候选（≤2字）必须完整出现才算数，不能靠字符重叠蒙对", () => {
    // "预算"整体出现在 spoken 里 -> 满分
    assert.equal(candidateMatchRatio("这部分我们再谈谈预算问题", "预算", "script"), 1);
    // 只是字符各自出现、但没有连续出现"预算"这个子串 -> 0（避免太容易误判）
    assert.equal(candidateMatchRatio("预备工作已经算完了", "预算", "script"), 0);
  });

  test("candidateMatchRatio：提示词模式下，候选整体作为子串命中直接给满分", () => {
    assert.equal(candidateMatchRatio("接下来我想聊聊团队协作这件事", "团队协作", "prompts"), 1);
  });

  test("candidateMatchRatio：非子串命中时退回字符重叠度", () => {
    const ratio = candidateMatchRatio("大家好呀朋友们", "大家好朋友", "script");
    assert.ok(ratio > 0 && ratio <= 1);
  });

  describe("findBestMatchIndex", () => {
    const sentences = [
      "大家好，欢迎来到今天的分享。",
      "我今天主要讲三个部分。",
      "第一部分是项目背景。",
      "第二部分是具体方案。",
      "谢谢大家。",
    ];

    test("讲完当前句，识别到跟当前句高度重合的内容 -> 匹配到当前句下标", () => {
      const idx = findBestMatchIndex({
        recentText: "大家好，欢迎来到今天的分享",
        sentences,
        currentIndex: 0,
        mode: "script",
      });
      assert.equal(idx, 0);
    });

    test("跳着讲，识别内容对上了往后第2句 -> 优先匹配最靠后能对上的那句", () => {
      const idx = findBestMatchIndex({
        recentText: "第一部分是项目背景",
        sentences,
        currentIndex: 0,
        mode: "script",
        lookahead: 2,
      });
      assert.equal(idx, 2);
    });

    test("完全没识别到相关内容 -> 返回 null，不瞎跳", () => {
      const idx = findBestMatchIndex({
        recentText: "呃…那个…嗯",
        sentences,
        currentIndex: 0,
        mode: "script",
      });
      assert.equal(idx, null);
    });

    test("recentText 为空 -> 返回 null", () => {
      const idx = findBestMatchIndex({ recentText: "", sentences, currentIndex: 0 });
      assert.equal(idx, null);
    });

    test("currentIndex 越界 -> 返回 null", () => {
      assert.equal(findBestMatchIndex({ recentText: "随便", sentences, currentIndex: -1 }), null);
      assert.equal(findBestMatchIndex({ recentText: "随便", sentences, currentIndex: 99 }), null);
    });

    test("sentences 为空数组 -> 返回 null", () => {
      assert.equal(findBestMatchIndex({ recentText: "随便", sentences: [], currentIndex: 0 }), null);
    });

    test("提示词模式：说到提示词里的关键字就能匹配上，即使原话跟提示词字面完全不同", () => {
      const prompts = ["预算问题", "时间安排", "下一步计划"];
      const idx = findBestMatchIndex({
        recentText: "关于这个项目啊，主要是预算问题比较紧张，我们得想想办法",
        sentences: prompts,
        currentIndex: 0,
        mode: "prompts",
      });
      assert.equal(idx, 0);
    });

    test("不会自动往回跳：窗口只往后看，不看 currentIndex 之前的句子", () => {
      const idx = findBestMatchIndex({
        recentText: "大家好，欢迎来到今天的分享",
        sentences,
        currentIndex: 2, // 已经在第2句了，就算说的话跟第0句很像也不会跳回去
        mode: "script",
        lookahead: 2,
      });
      assert.equal(idx, null);
    });
  });

  describe("buildPreviewWindow", () => {
    const sentences = ["A", "B", "C", "D", "E"];

    test("中间位置：前后各留 radius 条", () => {
      const win = buildPreviewWindow(sentences, 2, 2);
      assert.deepEqual(win.map((w) => w.text), ["A", "B", "C", "D", "E"]);
      assert.deepEqual(win.map((w) => w.offset), [-2, -1, 0, 1, 2]);
      assert.equal(win.find((w) => w.offset === 0).text, "C");
    });

    test("靠近开头：前面不够就跳过，不会出现空洞", () => {
      const win = buildPreviewWindow(sentences, 0, 2);
      assert.deepEqual(win.map((w) => w.text), ["A", "B", "C"]);
      assert.deepEqual(win.map((w) => w.offset), [0, 1, 2]);
    });

    test("靠近结尾：后面不够就跳过", () => {
      const win = buildPreviewWindow(sentences, 4, 2);
      assert.deepEqual(win.map((w) => w.text), ["C", "D", "E"]);
    });

    test("空列表返回空数组", () => {
      assert.deepEqual(buildPreviewWindow([], 0, 2), []);
    });

    test("currentIndex 越界会被夹住到有效范围", () => {
      const win = buildPreviewWindow(sentences, 99, 1);
      assert.deepEqual(win.map((w) => w.text), ["D", "E"]);
    });
  });
});
