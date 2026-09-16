(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.quickMemo = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  const { h } = require("./dom.js");

  /**
   * 在 container 里渲染"快速备忘"入口按钮。点击后在按钮下方展开一个小面板
   * （输入框 + 已记录的备忘列表，每条可删除）。任何页面调用这个函数看到的都是同一份数据。
   */
  function renderQuickMemo(container, store) {
    let panel = null;

    function closePanel() {
      if (panel) {
        panel.remove();
        panel = null;
        document.removeEventListener("click", onDocClick, true);
      }
    }

    function onDocClick(e) {
      if (panel && !panel.contains(e.target) && e.target !== button) closePanel();
    }

    function renderPanelList() {
      const list = h(
        "div",
        { class: "quick-memo-list" },
        store.listQuickNotes().map((n) =>
          h("div", { class: "quick-memo-item" }, [
            h("span", {}, n.text),
            h("span", {
              class: "quick-memo-delete",
              title: "删除",
              onClick: () => {
                store.removeQuickNote(n.id);
                refreshPanel();
              },
            }, "×"),
          ])
        )
      );
      return list;
    }

    function refreshPanel() {
      if (!panel) return;
      const listSlot = panel.querySelector(".quick-memo-list");
      listSlot.replaceWith(renderPanelList());
    }

    function openPanel() {
      if (panel) {
        closePanel();
        return;
      }
      const input = h("input", { class: "field-input", type: "text", placeholder: "记点什么…" });
      const addBtn = h("button", { class: "btn btn-primary btn-sm", type: "button" }, "添加");
      const submit = () => {
        const text = input.value.trim();
        if (!text) return;
        store.addQuickNote(text);
        input.value = "";
        refreshPanel();
      };
      addBtn.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
      });

      panel = h("div", { class: "quick-memo-panel" }, [
        h("div", { class: "quick-memo-input-row" }, [input, addBtn]),
        renderPanelList(),
      ]);
      container.appendChild(panel);
      setTimeout(() => document.addEventListener("click", onDocClick, true), 0);
    }

    const button = h(
      "button",
      { class: "btn btn-outline quick-memo-btn", type: "button", onClick: openPanel },
      "快速备忘"
    );
    container.appendChild(button);
  }

  return { renderQuickMemo };
});
