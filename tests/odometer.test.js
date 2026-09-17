const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { easeOutCubic, interpolateCount } = require("../js/components/odometer.js");

describe("odometer：数字滚动计数器的插值数学", () => {
  test("easeOutCubic：起点是0，终点是1，过程单调递增", () => {
    assert.equal(easeOutCubic(0), 0);
    assert.equal(easeOutCubic(1), 1);
    assert.ok(easeOutCubic(0.5) > easeOutCubic(0.2));
    assert.ok(easeOutCubic(0.9) > easeOutCubic(0.5));
  });

  test("easeOutCubic：前段比匀速快（缓出曲线的定义）", () => {
    // 缓出：开始阶段的推进速度应该比线性快，即 easeOutCubic(0.3) > 0.3
    assert.ok(easeOutCubic(0.3) > 0.3);
  });

  test("interpolateCount：progress=0 时等于起点，progress=1 时等于终点", () => {
    assert.equal(interpolateCount(0, 100, 0), 0);
    assert.equal(interpolateCount(0, 100, 1), 100);
    assert.equal(interpolateCount(50, 150, 1), 150);
  });

  test("interpolateCount：中间值落在起点和终点之间", () => {
    const mid = interpolateCount(0, 100, 0.5);
    assert.ok(mid > 0 && mid < 100);
  });

  test("interpolateCount：progress 超出 0-1 范围会被夹住，不会滚过头或倒退", () => {
    assert.equal(interpolateCount(0, 100, 1.5), 100);
    assert.equal(interpolateCount(0, 100, -0.5), 0);
  });

  test("interpolateCount：支持从负数到正数（比如结余从负转正）", () => {
    assert.equal(interpolateCount(-50, 50, 0), -50);
    assert.equal(interpolateCount(-50, 50, 1), 50);
  });
});
