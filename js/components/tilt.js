(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.tilt = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // 卡片跟随鼠标位置的3D透视倾斜：鼠标在卡片上移动，卡片跟着朝对应方向轻轻倾斜，
  // 像是真的被"托"在指尖上一样；鼠标离开时用弹簧曲线弹回摊平。只对鼠标生效（跳过
  // 触屏），因为触屏上没有"悬停/指针位置"这个概念，硬套只会让点击变得奇怪。

  /**
   * 纯函数，方便单测：根据指针在卡片内的相对位置（0~1）算出应该倾斜多少度。
   * px/py 是指针相对卡片左上角的比例坐标，maxTilt 是最大倾斜角度（度）。
   */
  function computeTiltAngles(px, py, maxTilt) {
    const clampedX = Math.max(0, Math.min(1, px));
    const clampedY = Math.max(0, Math.min(1, py));
    return {
      rotateY: (clampedX - 0.5) * maxTilt * 2,
      rotateX: (0.5 - clampedY) * maxTilt * 2,
    };
  }

  function initCardTilt({ selector = ".card", maxTilt = 6, perspective = 700 } = {}) {
    if (typeof document === "undefined") return;
    let activeEl = null;

    function applyTilt(el, clientX, clientY) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const { rotateX, rotateY } = computeTiltAngles(
        (clientX - rect.left) / rect.width,
        (clientY - rect.top) / rect.height,
        maxTilt
      );
      el.style.transition = "transform 0.06s linear";
      el.style.transform = `perspective(${perspective}px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg)`;
    }

    function resetTilt(el) {
      el.style.transition = "transform 0.5s var(--spring-ease, cubic-bezier(0.34, 1.56, 0.64, 1))";
      el.style.transform = "perspective(" + perspective + "px) rotateX(0deg) rotateY(0deg)";
    }

    document.addEventListener("pointermove", (e) => {
      if (e.pointerType && e.pointerType !== "mouse") return;
      const card = e.target.closest ? e.target.closest(selector) : null;
      if (!card) {
        if (activeEl) { resetTilt(activeEl); activeEl = null; }
        return;
      }
      if (activeEl && activeEl !== card) resetTilt(activeEl);
      activeEl = card;
      applyTilt(card, e.clientX, e.clientY);
    });

    document.addEventListener("pointerleave", () => {
      if (activeEl) { resetTilt(activeEl); activeEl = null; }
    }, true);
  }

  return { computeTiltAngles, initCardTilt };
});
