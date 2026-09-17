// 折线图组件的单元测试：坐标换算的纯函数 + SVG 字符串拼装的基本结构。
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { computeLineChartPoints, renderLineChartSvg } = require("../js/components/lineChart.js");

describe("computeLineChartPoints", () => {
  test("空数组返回空点位", () => {
    const { points, maxValue } = computeLineChartPoints([]);
    assert.deepEqual(points, []);
    assert.equal(maxValue, 0);
  });

  test("单个值：只有一个点，落在水平居中位置", () => {
    const { points } = computeLineChartPoints([10], { width: 100, height: 100, padX: 10, padY: 10 });
    assert.equal(points.length, 1);
    assert.equal(points[0].x, 10); // n=1时 stepX=0，落在起始padX处
  });

  test("最大值对应的点应该贴近顶部（y值最小），全0时贴近底部", () => {
    const { points } = computeLineChartPoints([0, 100], { width: 100, height: 100, padX: 0, padY: 0 });
    assert.ok(points[1].y < points[0].y, "值更大的点应该更靠上（y更小）");
  });

  test("maxValueOverride 可以强制用外部指定的最大值换算比例", () => {
    const { points: p1 } = computeLineChartPoints([50], { width: 100, height: 100, padX: 0, padY: 0, maxValueOverride: 50 });
    const { points: p2 } = computeLineChartPoints([50], { width: 100, height: 100, padX: 0, padY: 0, maxValueOverride: 100 });
    assert.ok(p2[0].y > p1[0].y, "同样的值在更大的maxValueOverride下应该画得更矮（y更大）");
  });

  test("负值被当作0处理，不会跑到坐标系外面", () => {
    const { points } = computeLineChartPoints([-5, 10], { width: 100, height: 100, padX: 0, padY: 0 });
    assert.equal(points[0].y, 100, "负值应该贴底，跟0一样");
  });
});

describe("renderLineChartSvg", () => {
  test("单条 series：输出一个 svg，一条 polyline，数值标签按 showValues 决定", () => {
    const svg = renderLineChartSvg([{ values: [1, 5, 3], color: "red", formatValue: (v) => `${v}本`, showValues: true }]);
    assert.match(svg, /<svg/);
    assert.equal((svg.match(/<polyline/g) || []).length, 1);
    assert.match(svg, /本/, "showValues为true时应该带上格式化后的数值文字");
  });

  test("多条 series：每条各画一条 polyline，共用同一把最大值尺子", () => {
    const svg = renderLineChartSvg([
      { values: [10, 20], color: "green" },
      { values: [100, 200], color: "blue" },
    ]);
    assert.equal((svg.match(/<polyline/g) || []).length, 2);
  });

  test("showValues为false时不应该出现数值文字标签", () => {
    const svg = renderLineChartSvg([{ values: [1, 2, 3], color: "red", showValues: false }]);
    assert.equal((svg.match(/<text/g) || []).length, 0);
  });

  test("空values数组不应该抛错", () => {
    assert.doesNotThrow(() => renderLineChartSvg([{ values: [], color: "red" }]));
  });
});
