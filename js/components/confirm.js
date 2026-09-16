(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.confirm = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  const { h } = require("./dom.js");

  /** 二次确认弹窗，供删除、导入覆盖、清空全部数据等危险操作复用。 */
  function openConfirm({ message, confirmLabel = "确认", danger = false, onConfirm }) {
    const overlay = h("div", { class: "modal-overlay" }, [
      h("div", { class: "modal-box modal-box-small" }, [
        h("div", { class: "confirm-message" }, message),
        h("div", { class: "modal-actions" }, [
          h("button", { type: "button", class: "btn btn-ghost", onClick: () => overlay.remove() }, "取消"),
          h(
            "button",
            {
              type: "button",
              class: danger ? "btn btn-danger" : "btn btn-primary",
              onClick: () => {
                overlay.remove();
                onConfirm();
              },
            },
            confirmLabel
          ),
        ]),
      ]),
    ]);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
  }

  return { openConfirm };
});
