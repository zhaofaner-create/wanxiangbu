(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.avatarCropper = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  const { h } = require("./dom.js");
  const { computeCropGeometry, computeCropSourceRect } = require("./imageCrop.js");

  // 取景框在弹窗里的显示尺寸（css像素），跟最终导出的头像分辨率（AVATAR_IMAGE_SIZE）
  // 是两码事——这个只影响弹窗好不好操作，太小了拖动、看细节都不方便。
  const VIEW_SIZE = 260;
  const MAX_ZOOM = 4;

  let currentOverlay = null;

  function closeAvatarCropper() {
    if (currentOverlay) {
      currentOverlay.remove();
      currentOverlay = null;
    }
  }

  /**
   * 打开"选取头像截取区域"弹窗：用户可以拖动图片调整位置、拉动滑块放大缩小，
   * 实时看到取景框里会截到哪一块，点"确认裁剪"后按 outputSize 压缩成正方形
   * JPEG 交给 onConfirm(dataUrl)。全程在本地 canvas 里完成，不涉及任何上传。
   *
   * 用 Pointer Events（pointerdown/move/up）而不是分开写 mouse/touch 事件：
   * 鼠标拖动和手指在触屏（手机/iPad）上拖动会自动统一成同一套事件，不用
   * 额外适配触屏交互。
   */
  function openAvatarCropper({ imageSrc, outputSize = 200, quality = 0.85, onConfirm, onCancel }) {
    closeAvatarCropper();

    let zoom = 1;
    let offsetX = 0;
    let offsetY = 0;
    let naturalWidth = 0;
    let naturalHeight = 0;

    const img = h("img", { class: "avatar-crop-img", alt: "" });
    const viewport = h("div", { class: "avatar-crop-viewport" }, [img]);
    const zoomSlider = h("input", {
      type: "range",
      class: "avatar-crop-zoom",
      min: "1",
      max: String(MAX_ZOOM),
      step: "0.01",
    });
    zoomSlider.value = "1";

    function applyGeometry() {
      if (!naturalWidth || !naturalHeight) return;
      const geo = computeCropGeometry(naturalWidth, naturalHeight, VIEW_SIZE, zoom, offsetX, offsetY);
      offsetX = geo.offsetX;
      offsetY = geo.offsetY;
      img.style.width = geo.displayWidth + "px";
      img.style.height = geo.displayHeight + "px";
      img.style.left = (VIEW_SIZE - geo.displayWidth) / 2 + offsetX + "px";
      img.style.top = (VIEW_SIZE - geo.displayHeight) / 2 + offsetY + "px";
    }

    img.addEventListener("load", () => {
      naturalWidth = img.naturalWidth;
      naturalHeight = img.naturalHeight;
      applyGeometry();
    });
    img.src = imageSrc;

    zoomSlider.addEventListener("input", () => {
      zoom = Number(zoomSlider.value) || 1;
      applyGeometry();
    });

    let dragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragOffsetStartX = 0;
    let dragOffsetStartY = 0;

    function onPointerDown(e) {
      dragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragOffsetStartX = offsetX;
      dragOffsetStartY = offsetY;
      if (viewport.setPointerCapture && e.pointerId != null) {
        try { viewport.setPointerCapture(e.pointerId); } catch (err) { /* 部分环境不支持，忽略 */ }
      }
      e.preventDefault();
    }
    function onPointerMove(e) {
      if (!dragging) return;
      offsetX = dragOffsetStartX + (e.clientX - dragStartX);
      offsetY = dragOffsetStartY + (e.clientY - dragStartY);
      applyGeometry();
    }
    function onPointerUp() {
      dragging = false;
    }
    viewport.addEventListener("pointerdown", onPointerDown);
    viewport.addEventListener("pointermove", onPointerMove);
    viewport.addEventListener("pointerup", onPointerUp);
    viewport.addEventListener("pointercancel", onPointerUp);
    viewport.addEventListener("pointerleave", onPointerUp);

    function confirm() {
      const rect = computeCropSourceRect(naturalWidth, naturalHeight, VIEW_SIZE, zoom, offsetX, offsetY);
      const canvas = document.createElement("canvas");
      canvas.width = outputSize;
      canvas.height = outputSize;
      const cx = canvas.getContext("2d");
      cx.drawImage(img, rect.sx, rect.sy, rect.size, rect.size, 0, 0, outputSize, outputSize);
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      closeAvatarCropper();
      if (onConfirm) onConfirm(dataUrl);
    }
    function cancel() {
      closeAvatarCropper();
      if (onCancel) onCancel();
    }

    const box = h("div", { class: "modal-box avatar-crop-box" }, [
      h("div", { class: "modal-title" }, "调整头像截取区域"),
      viewport,
      h("div", { class: "avatar-crop-zoom-row" }, [
        h("span", { class: "muted", style: "font-size:12px;" }, "缩放"),
        zoomSlider,
      ]),
      h("div", { class: "muted", style: "font-size:11.5px;" }, "拖动图片调整位置，拉动滑块放大或缩小，四个角都会被截掉，只保留取景框里的部分"),
      h("div", { class: "modal-actions" }, [
        h("button", { type: "button", class: "btn btn-ghost", onClick: cancel }, "取消"),
        h("button", { type: "button", class: "btn btn-primary", onClick: confirm }, "确认裁剪"),
      ]),
    ]);
    const overlay = h("div", { class: "modal-overlay" }, [box]);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cancel();
    });

    document.body.appendChild(overlay);
    currentOverlay = overlay;
  }

  return { openAvatarCropper, closeAvatarCropper, VIEW_SIZE, MAX_ZOOM };
});
