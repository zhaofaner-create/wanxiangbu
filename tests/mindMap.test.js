const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { computeMindMapLayout, wrapTitleLines } = require("../js/components/mindMap.js");

// renderMindMapSvg 要建真正的 SVG DOM 元素，跟这个项目里其它纯 DOM 封装一样不写单测，
// 靠 Playwright 端到端测试在真实浏览器里验证；computeMindMapLayout 和 wrapTitleLines
// 都是纯函数，这里单独测。

describe("computeMindMapLayout", () => {
  test("空/非法输入返回空布局，不报错", () => {
    assert.deepEqual(computeMindMapLayout(null), { nodes: [], edges: [], width: 0, height: 0, nodeWidth: 160, nodeHeight: 52 });
    assert.deepEqual(computeMindMapLayout({}).nodes, []);
    assert.deepEqual(computeMindMapLayout({ title: "" }).nodes, []);
  });

  test("单个根节点：只有一个节点，没有边", () => {
    const layout = computeMindMapLayout({ title: "根节点", children: [] });
    assert.equal(layout.nodes.length, 1);
    assert.equal(layout.edges.length, 0);
    assert.equal(layout.nodes[0].title, "根节点");
    assert.equal(layout.nodes[0].depth, 0);
    assert.equal(layout.nodes[0].parentId, null);
  });

  test("多层树：节点数、边数正确，边都连接存在的父子节点", () => {
    const tree = {
      title: "根",
      children: [
        { title: "分支1", children: [{ title: "叶子1", children: [] }, { title: "叶子2", children: [] }] },
        { title: "分支2", children: [] },
      ],
    };
    const layout = computeMindMapLayout(tree);
    assert.equal(layout.nodes.length, 5); // 根 + 分支1 + 分支2 + 叶子1 + 叶子2
    assert.equal(layout.edges.length, 4);

    const nodeById = new Map(layout.nodes.map((n) => [n.id, n]));
    layout.edges.forEach((e) => {
      assert.ok(nodeById.has(e.from), "边的起点必须是存在的节点");
      assert.ok(nodeById.has(e.to), "边的终点必须是存在的节点");
    });

    // 深度按层级递增：根是0，分支是1，叶子是2。
    const root = layout.nodes.find((n) => n.title === "根");
    const branch1 = layout.nodes.find((n) => n.title === "分支1");
    const leaf1 = layout.nodes.find((n) => n.title === "叶子1");
    assert.equal(root.depth, 0);
    assert.equal(branch1.depth, 1);
    assert.equal(leaf1.depth, 2);
    assert.ok(leaf1.y > branch1.y);
    assert.ok(branch1.y > root.y);
  });

  test("叶子节点从左到右按原始顺序摆放，互不重叠", () => {
    const tree = {
      title: "根",
      children: [{ title: "a", children: [] }, { title: "b", children: [] }, { title: "c", children: [] }],
    };
    const layout = computeMindMapLayout(tree);
    const leaves = ["a", "b", "c"].map((t) => layout.nodes.find((n) => n.title === t));
    assert.ok(leaves[0].x < leaves[1].x);
    assert.ok(leaves[1].x < leaves[2].x);
  });

  test("非叶子节点的 x 坐标是自己所有子节点的正中间", () => {
    const tree = { title: "根", children: [{ title: "a", children: [] }, { title: "b", children: [] }] };
    const layout = computeMindMapLayout(tree);
    const root = layout.nodes.find((n) => n.title === "根");
    const a = layout.nodes.find((n) => n.title === "a");
    const b = layout.nodes.find((n) => n.title === "b");
    assert.equal(root.x, (a.x + b.x) / 2);
  });

  test("width/height 能覆盖所有节点，不会有节点跑到画布外面", () => {
    const tree = { title: "根", children: [{ title: "a", children: [] }, { title: "b", children: [] }] };
    const layout = computeMindMapLayout(tree);
    layout.nodes.forEach((n) => {
      assert.ok(n.x + layout.nodeWidth <= layout.width + 1); // +1 容忍浮点误差
      assert.ok(n.y + layout.nodeHeight <= layout.height + 1);
    });
  });
});

describe("wrapTitleLines", () => {
  test("短标题不用换行，只有一行", () => {
    assert.deepEqual(wrapTitleLines("短标题", 12, 2), ["短标题"]);
  });

  test("超过一行长度但两行放得下时，拆成两行", () => {
    const title = "一二三四五六七八九十一二三四"; // 14 个字，maxCharsPerLine=10 时刚好拆两行
    const lines = wrapTitleLines(title, 10, 2);
    assert.equal(lines.length, 2);
    assert.equal(lines[0], "一二三四五六七八九十");
    assert.equal(lines[1], "一二三四");
  });

  test("超过两行能放下的长度时，最后一行截断加省略号", () => {
    const title = "一二三四五六七八九十一二三四五六七八九十一二三四五";
    const lines = wrapTitleLines(title, 10, 2);
    assert.equal(lines.length, 2);
    assert.ok(lines[1].endsWith("…"));
    assert.equal(lines[1].length, 10); // 9个字 + 省略号
  });

  test("空字符串返回一个空字符串的数组，不报错", () => {
    assert.deepEqual(wrapTitleLines("", 12, 2), [""]);
    assert.deepEqual(wrapTitleLines(undefined, 12, 2), [""]);
  });
});
