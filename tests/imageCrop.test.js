const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { computeCoverCropRect } = require("../js/components/imageCrop.js");

describe("头像上传：居中正方形裁剪区域的纯数学计算", () => {
  test("宽图（横向长方形）：裁掉左右多余部分，取中间正方形", () => {
    const { sx, sy, size } = computeCoverCropRect(400, 200);
    assert.equal(size, 200);
    assert.equal(sx, 100);
    assert.equal(sy, 0);
  });

  test("高图（竖向长方形）：裁掉上下多余部分，取中间正方形", () => {
    const { sx, sy, size } = computeCoverCropRect(300, 900);
    assert.equal(size, 300);
    assert.equal(sx, 0);
    assert.equal(sy, 300);
  });

  test("本身就是正方形：整张图都要，不裁掉任何东西", () => {
    const { sx, sy, size } = computeCoverCropRect(500, 500);
    assert.equal(size, 500);
    assert.equal(sx, 0);
    assert.equal(sy, 0);
  });

  test("非法尺寸（0或负数）不报错，返回一个空区域", () => {
    assert.deepEqual(computeCoverCropRect(0, 100), { sx: 0, sy: 0, size: 0 });
    assert.deepEqual(computeCoverCropRect(100, -5), { sx: 0, sy: 0, size: 0 });
  });
});
