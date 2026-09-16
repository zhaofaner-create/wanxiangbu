(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.settings = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  const { h, mount } = require("../components/dom.js");
  const { openConfirm } = require("../components/confirm.js");

  const meta = { id: "settings", label: "数据与设置", title: "数据与设置", subtitle: "备份恢复与基础设置" };

  const CARD_LABELS = {
    study: "学习任务", reminders: "提醒事项", meal: "饮食计划",
    inventory: "库存管理", finance: "个人记账", games: "游戏娱乐",
  };

  // 每张卡片标题前的小图标，跟侧边导航一样用内联 SVG，不额外依赖图标字体/CDN。
  const ICONS = {
    save: '<path d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/><path d="M8 4v5h7V4"/><path d="M7 14h10v6H7z"/>',
    backup: '<path d="M7 17a4 4 0 0 1-1-7.9 5 5 0 0 1 9.6-1.7A4.5 4.5 0 0 1 17 17H7Z"/><path d="M12 11v6M9.5 14.5 12 17l2.5-2.5"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1.2"/><rect x="13" y="4" width="7" height="7" rx="1.2"/><rect x="4" y="13" width="7" height="7" rx="1.2"/><rect x="13" y="13" width="7" height="7" rx="1.2"/>',
    warn: '<path d="M12 4 3 20h18L12 4Z"/><path d="M12 10.5v4M12 17h.01"/>',
  };
  function iconSvg(name) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;
  }
  function cardHeading(iconName, title, warn) {
    return h("div", { class: "card-heading" }, [
      h("div", { class: "card-icon" + (warn ? " warn" : ""), html: iconSvg(iconName) }),
      h("div", { class: "card-heading-title" }, title),
    ]);
  }

  function render(container, store, ctx) {
    ctx.setTopbar(meta.title, meta.subtitle);
    function rerender() { render(container, store, ctx); }

    function exportBackup() {
      const json = store.exportBackup();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const a = document.createElement("a");
      a.href = url;
      a.download = `faner-app-backup-${ts}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      store.setLastBackupAt(new Date().toISOString());
      rerender();
    }

    const fileInput = h("input", { type: "file", accept: "application/json", style: "display:none;" });
    fileInput.addEventListener("change", () => {
      const file = fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result);
        openConfirm({
          message: "导入备份会用文件里的内容覆盖当前所有数据，确定要继续吗？",
          danger: true,
          confirmLabel: "覆盖导入",
          onConfirm: () => {
            try {
              store.importBackup(text);
              rerender();
            } catch (err) {
              alert("导入失败：" + err.message);
            }
          },
        });
        fileInput.value = "";
      };
      reader.readAsText(file);
    });

    const settings = store.getSettings();

    function doManualSave() {
      store.manualSave();
      rerender();
    }

    const manualSaveCard = h("div", { class: "card" }, [
      cardHeading("save", "手动保存"),
      h("div", { class: "settings-card-desc" }, "平时改动都会自动保存，这个按钮是留给你想主动确认一下的时候用的。"),
      h("div", { class: "settings-status-line" + (settings.lastManualSaveAt ? "" : " unsaved") },
        settings.lastManualSaveAt ? `上次手动保存：${new Date(settings.lastManualSaveAt).toLocaleString("zh-CN")}` : "还没有手动保存过"),
      h("button", { class: "btn btn-outline", type: "button", onClick: doManualSave }, "立即保存"),
    ]);

    const backupCard = h("div", { class: "card" }, [
      cardHeading("backup", "数据备份"),
      h("div", { class: "settings-card-desc" }, "导出成一个 JSON 文件存起来，换电脑或者不小心清空数据时可以用它恢复。"),
      h("div", { class: "settings-status-line" + (settings.lastBackupAt ? "" : " unsaved") },
        settings.lastBackupAt ? `上次备份：${new Date(settings.lastBackupAt).toLocaleString("zh-CN")}` : "还没有备份过"),
      h("div", { class: "section-row" }, [
        h("button", { class: "btn btn-outline", type: "button", onClick: exportBackup }, "导出备份"),
        h("button", { class: "btn btn-outline", type: "button", onClick: () => fileInput.click() }, "导入恢复"),
        fileInput,
      ]),
    ]);

    const homeCardsCard = h("div", { class: "card" }, [
      cardHeading("grid", "首页摘要显示"),
      h("div", { class: "settings-card-desc" }, "关掉不常看的模块，首页只留下你在意的摘要卡片。"),
      h("div", { class: "toggle-grid" }, Object.entries(CARD_LABELS).map(([key, label]) =>
        h("label", { class: "toggle-row" }, [
          h("input", {
            type: "checkbox",
            checked: settings.homeCards[key] || undefined,
            onChange: (e) => { store.updateHomeCardVisibility(key, e.target.checked); },
          }),
          h("span", {}, label),
        ])
      )),
    ]);

    const dangerCard = h("div", { class: "card danger-card" }, [
      cardHeading("warn", "危险操作", true),
      h("div", { class: "settings-card-desc" }, "清空后所有模块的数据都将被删除，且无法恢复（除非你之前导出过备份）。"),
      h("button", {
        class: "btn btn-danger",
        type: "button",
        onClick: () => openConfirm({
          message: "确定要清空全部数据吗？这个操作无法撤销。",
          danger: true,
          confirmLabel: "清空全部数据",
          onConfirm: () => { store.resetAll(); rerender(); },
        }),
      }, "清空全部数据"),
    ]);

    mount(container, h("div", { class: "settings-page" }, [
      h("div", { class: "settings-grid" }, [
        h("div", { class: "settings-col" }, [
          h("div", { class: "settings-section-label" }, "数据管理"),
          manualSaveCard,
          backupCard,
        ]),
        h("div", { class: "settings-col" }, [
          h("div", { class: "settings-section-label" }, "偏好设置"),
          homeCardsCard,
        ]),
      ]),
      dangerCard,
    ]));
  }

  return { meta, render };
});
