(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.dom = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  // 极简的 DOM 构建辅助函数，避免每个模块都手写一大堆 document.createElement。

  /**
   * h('div', {class:'card', onclick: fn}, ['文本', otherElement])
   * - props 里以 'on' 开头的驼峰属性会被当成事件监听器绑定（onClick -> click）。
   * - class/className 都支持。
   * - children 可以是字符串、Node，或者它们的数组（支持嵌套数组）。
   */
  function h(tag, props = {}, children = []) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith("on") && typeof value === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === "class" || key === "className") {
        el.className = value;
      } else if (key === "dataset") {
        Object.entries(value).forEach(([dk, dv]) => (el.dataset[dk] = dv));
      } else if (key === "html") {
        el.innerHTML = value;
      } else {
        el.setAttribute(key, value);
      }
    }
    appendChildren(el, children);
    return el;
  }

  function appendChildren(el, children) {
    const flat = Array.isArray(children) ? children.flat(Infinity) : [children];
    flat.forEach((child) => {
      if (child === null || child === undefined || child === false) return;
      el.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
    });
  }

  /** 清空容器再挂载新内容，模块每次 render 都调用这个。 */
  function mount(container, node) {
    container.innerHTML = "";
    container.appendChild(node);
  }

  function formatMoney(n) {
    const sign = n < 0 ? "-" : "";
    return `${sign}¥${Math.abs(n).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
  }

  return { h, mount, formatMoney };
});
