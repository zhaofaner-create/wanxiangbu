(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.odometer = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // 数字滚动计数器（Odometer / Ticker）：数值变化时不是瞬间跳变，而是像老式里程表
  // 一样平滑滚动过去，末尾带一点缓出（越接近目标值滚动越慢），用在记账收入/支出/
  // 结余这类"一眼就要看到变化"的关键数字上。

  /** 三次缓出曲线：开始快、结尾慢，是"滚动到目标值刚好停住"的手感，不是线性匀速。 */
  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  /** 纯函数，方便单测：progress 是 0~1 之间的播放进度，返回此刻应该显示的插值。 */
  function interpolateCount(from, to, progress) {
    const t = Math.max(0, Math.min(1, progress));
    return from + (to - from) * easeOutCubic(t);
  }

  /**
   * 让一个 DOM 节点的文字内容从 from 平滑滚动到 to。
   * formatter(value) 负责把数字格式化成最终展示的文字（比如加上¥符号、千分位）。
   */
  function animateCount(el, to, { from = 0, duration = 700, formatter = (n) => String(Math.round(n)) } = {}) {
    if (!el) return;
    const start = (typeof performance !== "undefined" ? performance : Date).now();
    function frame(nowArg) {
      const now = typeof nowArg === "number" ? nowArg : (typeof performance !== "undefined" ? performance : Date).now();
      const progress = duration <= 0 ? 1 : (now - start) / duration;
      el.textContent = formatter(interpolateCount(from, to, progress));
      if (progress < 1) {
        requestAnimationFrame(frame);
      } else {
        el.textContent = formatter(to);
      }
    }
    requestAnimationFrame(frame);
  }

  return { easeOutCubic, interpolateCount, animateCount };
});
