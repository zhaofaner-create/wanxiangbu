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

  return { computeCoverCropRect };
});
