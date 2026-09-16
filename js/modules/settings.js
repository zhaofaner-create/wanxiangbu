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
      h("div", { class: "card-title" }, "手动保存"),
      h("div", { class: "muted", style: "font-size:12px;margin-bottom:6px;" },
        "平时改动都会自动保存，这个按钮是留给你想主动确认一下的时候用的。"),
      h("div", { class: "muted", style: "font-size:12px;margin-bottom:14px;" },
        settings.lastManualSaveAt ? `上次手动保存：${new Date(settings.lastManualSaveAt).toLocaleString("zh-CN")}` : "还没有手动保存过"),
      h("button", { class: "btn btn-outline", type: "button", onClick: doManualSave }, "立即保存"),
    ]);

    const backupCard = h("div", { class: "card" }, [
      h("div", { class: "card-title" }, "数据备份"),
      h("div", { class: "muted", style: "font-size:12px;margin-bottom:14px;" },
        settings.lastBackupAt ? `上次备份：${new Date(settings.lastBackupAt).toLocaleString("zh-CN")}` : "还没有备份过"),
      h("div", { class: "section-row" }, [
        h("button", { class: "btn btn-outline", type: "button", onClick: exportBackup }, "导出备份"),
        h("button", { class: "btn btn-outline", type: "button", onClick: () => fileInput.click() }, "导入恢复"),
        fileInput,
      ]),
    ]);

    const homeCardsCard = h("div", { class: "card" }, [
      h("div", { class: "card-title" }, "首页摘要显示"),
      h("div", { style: "display:flex;flex-direction:column;gap:10px;" }, Object.entries(CARD_LABELS).map(([key, label]) =>
        h("label", { style: "display:flex;align-items:center;gap:10px;font-size:13px;" }, [
          h("input", {
            type: "checkbox",
            checked: settings.homeCards[key] || undefined,
            onChange: (e) => { store.updateHomeCardVisibility(key, e.target.checked); },
          }),
          h("span", {}, label),
        ])
      )),
    ]);

    const dangerCard = h("div", { class: "card", style: "border-color:#fecaca;background:#fef2f2;" }, [
      h("div", { style: "font-size:14px;font-weight:600;margin-bottom:4px;color:#b91c1c;" }, "危险操作"),
      h("div", { class: "muted", style: "font-size:12px;margin-bottom:14px;" }, "清空后所有模块的数据都将被删除，且无法恢复（除非你之前导出过备份）"),
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

    mount(container, h("div", { style: "display:flex;flex-direction:column;gap:16px;max-width:640px;" }, [manualSaveCard, backupCard, homeCardsCard, dangerCard]));
  }

  return { meta, render };
});
