(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var result = factory();
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.imageCrop = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  /**
   * 头像上传要把用户选的任意尺寸/任意长宽比的照片，压缩裁剪成一张正方形小图再存起来
   * （不然原图直接塞进 localStorage，一张几MB的照片很快就把配额占满，也会让导出的
   * 备份文件变得很大）。这个函数只算"该从原图哪个矩形区域裁剪"这部分纯数学，不碰
   * Canvas/Image 这些浏览器专属 API，所以可以在 Node 测试里直接跑单元测试；真正
   * 调用 canvas.drawImage 画图压缩的部分留在 profile.js 里（那部分离不开真实浏览器）。
   *
   * 裁剪规则：以图片中心为基准，按目标正方形的比例，从原图里抠出一个居中的正方形区域
   * （长边裁掉多余部分，不拉伸变形——效果类似手机相册"裁切为1:1"）。
   */
  function computeCoverCropRect(srcWidth, srcHeight) {
    const w = Number(srcWidth) || 0;
    const h = Number(srcHeight) || 0;
    if (w <= 0 || h <= 0) return { sx: 0, sy: 0, size: 0 };
    const size = Math.min(w, h);
    const sx = (w - size) / 2;
    const sy = (h - size) / 2;
    return { sx, sy, size };
  }

  // 头像上传现在改成"用户手动选取截取区域"（拖动+缩放），不再自动居中裁剪，
  // computeCoverCropRect 保留作为纯数学工具函数（依然有单测覆盖），但下面这两个
  // 函数才是交互式裁剪弹窗（avatarCropper.js）实际用到的几何计算。

  const MIN_ZOOM = 1;

  /**
   * 计算图片在正方形取景框里的显示状态。zoom=1 时图片按"覆盖"取景框的最小比例
   * 显示（刚好铺满、不留空白，跟以前自动居中裁剪的画面一致），zoom 越大图片显示
   * 得越大（放大细节）。offsetX/offsetY 是用户拖动产生的偏移量（取景框像素为
   * 单位），会被夹在"取景框边缘不能超出图片范围"的区间内，保证任何时候取景框里
   * 都是图片内容、不会露出空白。纯数学，不碰 Canvas/Image，方便单测。
   */
  function computeCropGeometry(naturalWidth, naturalHeight, viewSize, zoom, offsetX, offsetY) {
    const iw = Number(naturalWidth) || 0;
    const ih = Number(naturalHeight) || 0;
    const view = Number(viewSize) || 0;
    const z = Math.max(MIN_ZOOM, Number(zoom) || MIN_ZOOM);
    if (iw <= 0 || ih <= 0 || view <= 0) {
      return { scale: 0, displayWidth: 0, displayHeight: 0, maxOffsetX: 0, maxOffsetY: 0, offsetX: 0, offsetY: 0 };
    }
    const baseScale = view / Math.min(iw, ih);
    const scale = baseScale * z;
    const displayWidth = iw * scale;
    const displayHeight = ih * scale;
    const maxOffsetX = Math.max(0, (displayWidth - view) / 2);
    const maxOffsetY = Math.max(0, (displayHeight - view) / 2);
    const clampedX = Math.min(maxOffsetX, Math.max(-maxOffsetX, Number(offsetX) || 0));
    const clampedY = Math.min(maxOffsetY, Math.max(-maxOffsetY, Number(offsetY) || 0));
    return { scale, displayWidth, displayHeight, maxOffsetX, maxOffsetY, offsetX: clampedX, offsetY: clampedY };
  }

  /**
   * 在上面几何计算基础上，反推出"最终应该从原图哪个正方形区域截取"（左上角
   * sx/sy + 边长 size，单位是原图像素），交给 canvas.drawImage 去真正裁剪压缩。
   */
  function computeCropSourceRect(naturalWidth, naturalHeight, viewSize, zoom, offsetX, offsetY) {
    const view = Number(viewSize) || 0;
    const geo = computeCropGeometry(naturalWidth, naturalHeight, view, zoom, offsetX, offsetY);
    if (!geo.scale) return { sx: 0, sy: 0, size: 0 };
    const imageLeft = (view - geo.displayWidth) / 2 + geo.offsetX;
    const imageTop = (view - geo.displayHeight) / 2 + geo.offsetY;
    return {
      sx: -imageLeft / geo.scale,
      sy: -imageTop / geo.scale,
      size: view / geo.scale,
    };
  }

  return { computeCoverCropRect, computeCropGeometry, computeCropSourceRect, MIN_ZOOM };
});
