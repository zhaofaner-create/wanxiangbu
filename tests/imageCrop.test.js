const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { computeCoverCropRect, computeCropGeometry, computeCropSourceRect } = require("../js/components/imageCrop.js");

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

describe("头像交互式截取：computeCropGeometry（拖动+缩放的几何换算）", () => {
  test("zoom=1 且没有拖动偏移时，图片按'覆盖取景框'的最小比例居中显示", () => {
    // 400x200 的宽图，取景框 100x100：按短边(200)覆盖，scale = 100/200 = 0.5
    const geo = computeCropGeometry(400, 200, 100, 1, 0, 0);
    assert.equal(geo.scale, 0.5);
    assert.equal(geo.displayWidth, 200);
    assert.equal(geo.displayHeight, 100);
    assert.equal(geo.offsetX, 0);
    assert.equal(geo.offsetY, 0);
  });

  test("zoom越大，图片显示尺寸越大（放大细节）", () => {
    const g1 = computeCropGeometry(400, 200, 100, 1, 0, 0);
    const g2 = computeCropGeometry(400, 200, 100, 2, 0, 0);
    assert.ok(g2.displayWidth > g1.displayWidth);
    assert.equal(g2.scale, g1.scale * 2);
  });

  test("zoom小于1会被夹到最小值1（不允许缩小到比覆盖比例还小，否则会露出空白）", () => {
    const g = computeCropGeometry(400, 200, 100, 0.3, 0, 0);
    const gAtOne = computeCropGeometry(400, 200, 100, 1, 0, 0);
    assert.equal(g.scale, gAtOne.scale);
  });

  test("拖动偏移超出范围时会被夹住，取景框永远不会露出图片外的空白", () => {
    const geo = computeCropGeometry(400, 200, 100, 1, 9999, 9999);
    assert.equal(geo.offsetX, geo.maxOffsetX);
    assert.equal(geo.offsetY, geo.maxOffsetY);
    assert.ok(geo.offsetX <= geo.maxOffsetX && geo.offsetX >= -geo.maxOffsetX);
  });

  test("正方形图片在zoom=1时maxOffset应为0（横竖都刚好贴合取景框，没法拖动）", () => {
    const geo = computeCropGeometry(300, 300, 100, 1, 50, 50);
    assert.equal(geo.maxOffsetX, 0);
    assert.equal(geo.maxOffsetY, 0);
    assert.equal(geo.offsetX, 0);
    assert.equal(geo.offsetY, 0);
  });

  test("非法尺寸不报错，返回一个空几何结果", () => {
    const geo = computeCropGeometry(0, 100, 100, 1, 0, 0);
    assert.equal(geo.scale, 0);
  });
});

describe("头像交互式截取：computeCropSourceRect（反推原图截取区域）", () => {
  test("zoom=1、无偏移时，截取结果应该跟自动居中裁剪(computeCoverCropRect)一致", () => {
    const rect = computeCropSourceRect(400, 200, 100, 1, 0, 0);
    const legacy = computeCoverCropRect(400, 200);
    assert.ok(Math.abs(rect.sx - legacy.sx) < 0.001);
    assert.ok(Math.abs(rect.sy - legacy.sy) < 0.001);
    assert.ok(Math.abs(rect.size - legacy.size) < 0.001);
  });

  test("放大(zoom>1)后截取区域应该变小（截到的是原图更小的一块，也就是放大细节）", () => {
    const r1 = computeCropSourceRect(400, 400, 100, 1, 0, 0);
    const r2 = computeCropSourceRect(400, 400, 100, 2, 0, 0);
    assert.ok(r2.size < r1.size);
  });

  test("往右下拖动图片，取景框实际截到的应该是原图更靠左上的区域", () => {
    const centered = computeCropSourceRect(400, 400, 100, 2, 0, 0);
    const dragged = computeCropSourceRect(400, 400, 100, 2, 30, 30);
    assert.ok(dragged.sx < centered.sx);
    assert.ok(dragged.sy < centered.sy);
  });

  test("非法尺寸不报错，返回一个空区域", () => {
    assert.deepEqual(computeCropSourceRect(0, 100, 100, 1, 0, 0), { sx: 0, sy: 0, size: 0 });
  });
});
