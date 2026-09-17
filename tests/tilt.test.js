const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { computeTiltAngles } = require("../js/components/tilt.js");

describe("卡片3D倾斜：角度计算的纯数学部分", () => {
  test("指针在卡片正中心时，倾斜角度是0（不歪）", () => {
    const { rotateX, rotateY } = computeTiltAngles(0.5, 0.5, 6);
    assert.equal(rotateX, 0);
    assert.equal(rotateY, 0);
  });

  test("指针在最右边时，rotateY 达到最大正角度", () => {
    const { rotateY } = computeTiltAngles(1, 0.5, 6);
    assert.equal(rotateY, 6);
  });

  test("指针在最左边时，rotateY 达到最大负角度", () => {
    const { rotateY } = computeTiltAngles(0, 0.5, 6);
    assert.equal(rotateY, -6);
  });

  test("指针在最上边时，卡片顶部朝我们倾斜（rotateX 为正）", () => {
    const { rotateX } = computeTiltAngles(0.5, 0, 6);
    assert.equal(rotateX, 6);
  });

  test("指针在最下边时，rotateX 为负", () => {
    const { rotateX } = computeTiltAngles(0.5, 1, 6);
    assert.equal(rotateX, -6);
  });

  test("超出卡片范围的坐标（比如指针移动很快导致的负数或大于1）会被夹在0-1之间，不会算出超过maxTilt的角度", () => {
    const { rotateX, rotateY } = computeTiltAngles(-0.5, 1.8, 6);
    assert.ok(Math.abs(rotateX) <= 6);
    assert.ok(Math.abs(rotateY) <= 6);
  });

  test("maxTilt 参数决定了倾斜的最大幅度", () => {
    const { rotateY } = computeTiltAngles(1, 0.5, 10);
    assert.equal(rotateY, 10);
  });
});
