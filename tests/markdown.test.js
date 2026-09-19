const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { parseMarkdownBlocks, parseInlineSegments } = require("../js/components/markdown.js");

describe("parseMarkdownBlocks", () => {
  test("标题按 # 的个数得出 level", () => {
    const blocks = parseMarkdownBlocks("# 一级\n## 二级\n###### 六级");
    assert.deepEqual(blocks, [
      { type: "heading", level: 1, text: "一级" },
      { type: "heading", level: 2, text: "二级" },
      { type: "heading", level: 6, text: "六级" },
    ]);
  });

  test("连续的无序列表行合并成一个 list 块", () => {
    const blocks = parseMarkdownBlocks("- 第一点\n* 第二点\n- 第三点");
    assert.deepEqual(blocks, [{ type: "list", items: ["第一点", "第二点", "第三点"] }]);
  });

  test("连续的引用行合并成一个 quote 块", () => {
    const blocks = parseMarkdownBlocks("> 原文第一句\n> 原文第二句");
    assert.deepEqual(blocks, [{ type: "quote", text: "原文第一句\n原文第二句" }]);
  });

  test("表格：识别表头、跳过分隔行、收集数据行", () => {
    const blocks = parseMarkdownBlocks("| 术语 | 释义 |\n| --- | --- |\n| A | 甲 |\n| B | 乙 |");
    assert.deepEqual(blocks, [
      { type: "table", header: ["术语", "释义"], rows: [["A", "甲"], ["B", "乙"]] },
    ]);
  });

  test("连续的普通文本行合并成一个 paragraph 块，空行分段", () => {
    const blocks = parseMarkdownBlocks("第一段第一行\n第一段第二行\n\n第二段");
    assert.deepEqual(blocks, [
      { type: "paragraph", text: "第一段第一行 第一段第二行" },
      { type: "paragraph", text: "第二段" },
    ]);
  });

  test("标题、列表、段落混排，各自成块且顺序不变", () => {
    const blocks = parseMarkdownBlocks("## 要点\n- 第一\n- 第二\n\n补充说明文字");
    assert.deepEqual(blocks, [
      { type: "heading", level: 2, text: "要点" },
      { type: "list", items: ["第一", "第二"] },
      { type: "paragraph", text: "补充说明文字" },
    ]);
  });

  test("空字符串或 undefined 返回空数组", () => {
    assert.deepEqual(parseMarkdownBlocks(""), []);
    assert.deepEqual(parseMarkdownBlocks(undefined), []);
  });
});

describe("parseInlineSegments", () => {
  test("识别 **加粗** 片段", () => {
    assert.deepEqual(parseInlineSegments("这是**重点**内容"), [
      { text: "这是" },
      { text: "重点", bold: true },
      { text: "内容" },
    ]);
  });

  test("识别 `代码` 片段", () => {
    assert.deepEqual(parseInlineSegments("用 `git commit` 提交"), [
      { text: "用 " },
      { text: "git commit", code: true },
      { text: " 提交" },
    ]);
  });

  test("没有特殊标记时返回单个纯文本片段", () => {
    assert.deepEqual(parseInlineSegments("普通文字"), [{ text: "普通文字" }]);
  });

  test("空字符串返回单个空文本片段", () => {
    assert.deepEqual(parseInlineSegments(""), [{ text: "" }]);
  });
});
