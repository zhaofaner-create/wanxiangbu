(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.reminders = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  const { h, mount } = require("../components/dom.js");
  const { openFormModal } = require("../components/modal.js");
  const { groupReminders } = require("../derived.js");
  const { todayStr, formatDateDisplay } = require("../utils.js");

  const meta = { id: "reminders", label: "提醒事项", title: "提醒事项", subtitle: "一次性 + 周期性提醒" };

  const REPEAT_OPTIONS = [
    { value: "none", label: "不重复（一次性）" },
    { value: "daily", label: "每天" },
    { value: "weekly", label: "每周" },
    { value: "monthly", label: "每月" },
    { value: "yearly", label: "每年" },
  ];

  let processedOpen = false;

  function render(container, store, ctx) {
    ctx.setTopbar(meta.title, meta.subtitle);
    function rerender() { render(container, store, ctx); }

    function openAddModal() {
      openFormModal({
        title: "添加提醒",
        fields: [
          { name: "title", label: "标题", type: "text", required: true },
          { name: "date", label: "日期", type: "date", required: true },
          { name: "repeat", label: "重复规则", type: "select", options: REPEAT_OPTIONS },
          { name: "note", label: "备注（选填）", type: "text" },
        ],
        onSubmit: (v) => {
          store.addReminder({ title: v.title, date: v.date, repeat: v.repeat, note: v.note || "" });
          rerender();
        },
      });
    }

    function renderRow(r) {
      return h("div", { class: "list-row" }, [
        h("span", {}, r.title),
        r.repeat !== "none" ? h("span", { class: "badge-info badge" }, repeatLabel(r.repeat)) : null,
        h("span", { class: "muted" }, formatDateDisplay(r.date)),
        r.repeat === "none"
          ? h("button", { class: "btn btn-sm spacer", type: "button", onClick: () => { store.markReminderDone(r.id); rerender(); } }, "标记已处理")
          : h("span", { class: "spacer muted" }, `下次：${formatDateDisplay(r.nextDate)}`),
        h("span", { class: "row-delete", onClick: () => { store.removeReminder(r.id); rerender(); } }, "删除"),
      ]);
    }

    const groups = groupReminders(store, todayStr());

    function groupCard(title, list) {
      return h("div", { class: "card" }, [
        h("div", { class: "card-title" }, title),
        list.length ? h("div", {}, list.map(renderRow)) : h("div", { class: "empty-hint" }, "暂无"),
      ]);
    }

    const processedCard = h("div", { class: "card" }, [
      h("div", { class: "collapsible-header", onClick: () => { processedOpen = !processedOpen; rerender(); } }, [
        h("span", {}, `已处理（${groups.processed.length}）`),
        h("span", {}, processedOpen ? "︿" : "﹀"),
      ]),
      processedOpen
        ? h("div", { style: "margin-top:10px;" }, groups.processed.map((r) =>
            h("div", { class: "list-row" }, [h("span", {}, r.title), h("span", { class: "spacer muted" }, formatDateDisplay(r.date))])
          ))
        : null,
    ]);

    mount(container, h("div", { style: "display:flex;flex-direction:column;gap:14px;" }, [
      h("div", { class: "section-row" }, [h("div", { class: "grow" }), h("button", { class: "btn btn-primary", type: "button", onClick: openAddModal }, "+ 添加提醒")]),
      groupCard("今天", groups.today),
      groupCard("即将到期", groups.upcoming),
      groupCard("更晚", groups.later),
      processedCard,
    ]));
  }

  function repeatLabel(repeat) {
    return { daily: "每天重复", weekly: "每周重复", monthly: "每月重复", yearly: "每年重复" }[repeat] || "";
  }

  return { meta, render };
});
