(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.mealPlan = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  const { h, mount } = require("../components/dom.js");
  const { openFormModal } = require("../components/modal.js");
  const { todayStr, startOfWeek, weekDates, addDays, weekdayLabel, formatDateDisplay } = require("../utils.js");

  const meta = { id: "mealPlan", label: "饮食计划", title: "饮食计划", subtitle: "" };

  const SLOTS = [
    { key: "breakfast", label: "早" },
    { key: "lunch", label: "中" },
    { key: "dinner", label: "晚" },
  ];

  let currentMonday = null;

  function render(container, store, ctx) {
    if (!currentMonday) currentMonday = startOfWeek(todayStr());
    const today = todayStr();
    const dates = weekDates(currentMonday);
    meta.subtitle = `${formatDateDisplay(dates[0])} – ${formatDateDisplay(dates[6])}`;
    ctx.setTopbar(meta.title, meta.subtitle);

    function rerender() { render(container, store, ctx); }

    function openEditModal(date, slotKey, slotLabel) {
      openFormModal({
        title: `${formatDateDisplay(date)} · ${slotLabel}`,
        fields: [{ name: "text", label: "安排内容", type: "text", placeholder: "例如：番茄炒蛋 · 米饭" }],
        initialValues: { text: store.getMealEntry(date, slotKey) },
        submitLabel: "保存",
        onSubmit: (v) => { store.setMealEntry(date, slotKey, v.text); rerender(); },
      });
    }

    const headerRow = h("tr", {}, [
      h("th", {}, ""),
      ...dates.map((d) => h("th", { class: d === today ? "meal-cell today" : "" }, `${weekdayLabel(d)} ${formatDateDisplay(d)}`)),
    ]);

    const bodyRows = SLOTS.map((slot) =>
      h("tr", {}, [
        h("th", {}, slot.label),
        ...dates.map((d) => {
          const text = store.getMealEntry(d, slot.key);
          return h(
            "td",
            { class: "meal-cell" + (d === today ? " today" : ""), onClick: () => openEditModal(d, slot.key, slot.label) },
            text ? text : h("span", { class: "meal-cell-empty" }, "+")
          );
        }),
      ])
    );

    const table = h("table", { class: "data-table" }, [h("thead", {}, headerRow), h("tbody", {}, bodyRows)]);

    const nav = h("div", { class: "section-row" }, [
      h("button", { class: "btn", type: "button", onClick: () => { currentMonday = addDays(currentMonday, -7); rerender(); } }, "‹ 上一周"),
      h("button", { class: "btn", type: "button", onClick: () => { currentMonday = addDays(currentMonday, 7); rerender(); } }, "下一周 ›"),
      h("div", { class: "grow" }),
      h("button", {
        class: "btn btn-outline",
        type: "button",
        onClick: () => {
          const lastMonday = addDays(currentMonday, -7);
          store.copyWeek(lastMonday, currentMonday);
          rerender();
        },
      }, "复制上周计划"),
    ]);

    mount(container, h("div", { style: "display:flex;flex-direction:column;gap:14px;" }, [nav, table]));
  }

  return { meta, render };
});
