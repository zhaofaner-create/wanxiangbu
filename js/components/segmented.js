(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.segmented = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  /**
   * "液态玻璃"风格的分段控件/单选胶囊组：选中态是同一个持续存在的 DOM 节点
   * （.tab-indicator 或 .pill-indicator），点击切换时靠 CSS transform/width
   * 过渡从旧选项的位置"流动"到新选项的位置，而不是销毁旧高亮、在新位置重新
   * 创建一个高亮——这样两次点击之间才会有连贯的视觉运动，而不是突然跳变。
   *
   * 用法：
   *   const seg = createSegmented({
   *     options: [{key:'today', label:'今日'}, ...],
   *     activeKey: 'today',
   *     kind: 'tabs' | 'pill',
   *     onSelect: (key) => { ...更新这个 key 对应的内容区，通常只替换一个
   *                          单独的"内容插槽"节点，不要把 seg.el 本身也
   *                          重新创建，否则又变回了"旧元素消失/新元素出现"。 },
   *   });
   *   someContainer.appendChild(seg.el);
   *   // 之后如果要用代码而不是用户点击去改变选中项：
   *   seg.setActive('week');
   *
   * 只要调用方在"重新渲染"整个页面时复用同一个 seg.el（比如把它存在模块顶层
   * 的闭包变量里，只在真正需要"整块都换掉"的时候才重新 createSegmented），
   * 指示器的运动就是连续的；如果每次点击都整体重新创建，指示器会没有"起点"，
   * 只能瞬间出现在终点，就退化成了普通的"旧元素消失/新元素出现"。
   */
  function createSegmented({ options, activeKey, onSelect, kind = "tabs" }) {
    let active = activeKey;

    const wrap = document.createElement("div");
    wrap.className = kind === "pill" ? "pill-group" : "tabs";

    const indicator = document.createElement("div");
    indicator.className = kind === "pill" ? "pill-indicator" : "tab-indicator";
    indicator.setAttribute("aria-hidden", "true");
    wrap.appendChild(indicator);

    const buttons = options.map((opt) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = (kind === "pill" ? "pill" : "tab-btn") + (opt.key === active ? " active" : "");
      btn.textContent = opt.label;
      btn.dataset.key = opt.key;
      btn.addEventListener("click", () => {
        if (opt.key === active) return;
        setActive(opt.key);
        if (typeof onSelect === "function") onSelect(opt.key);
      });
      wrap.appendChild(btn);
      return btn;
    });

    function moveIndicatorTo(key, animate) {
      const btn = buttons.find((b) => b.dataset.key === key);
      if (!btn) return;
      const wrapRect = wrap.getBoundingClientRect();
      const btnRect = btn.getBoundingClientRect();
      if (wrapRect.width === 0 && wrapRect.height === 0) return; // 还没挂载到文档里，量不出尺寸
      const left = btnRect.left - wrapRect.left;
      const top = btnRect.top - wrapRect.top;
      if (!animate) indicator.style.transition = "none";
      indicator.style.width = `${btnRect.width}px`;
      indicator.style.height = `${btnRect.height}px`;
      indicator.style.transform = `translate(${left}px, ${top}px)`;
      if (!animate) {
        // 强制触发一次重排，再把 transition 恢复，避免"无动画"这次设置也被下次动画补上
        void indicator.offsetWidth;
        indicator.style.transition = "";
      }
    }

    function setActive(key) {
      if (!options.some((o) => o.key === key)) return;
      active = key;
      buttons.forEach((b) => b.classList.toggle("active", b.dataset.key === key));
      moveIndicatorTo(key, true);
    }

    // 首次挂载时还没有"旧位置"可言，不需要动画，直接对齐到当前选中项。
    // 用 requestAnimationFrame 是因为这时候 wrap 可能还没被插入文档、量不出尺寸。
    requestAnimationFrame(() => moveIndicatorTo(active, false));

    return {
      el: wrap,
      setActive,
      getActive: () => active,
      /** 容器尺寸变化后（比如窗口缩放）重新对齐一次指示器，不带动画。 */
      reposition: () => moveIndicatorTo(active, false),
    };
  }

  return { createSegmented };
});
