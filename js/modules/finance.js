(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.finance = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  const { h, mount, formatMoney } = require("../components/dom.js");
  const { openFormModal } = require("../components/modal.js");
  const { openConfirm } = require("../components/confirm.js");
  const { financeMonthlySummary } = require("../derived.js");
  const { todayStr, formatDateDisplay, shiftMonth } = require("../utils.js");

  const meta = { id: "finance", label: "个人记账", title: "个人记账", subtitle: "" };

  let currentMonth = null;

  function render(container, store, ctx) {
    if (!currentMonth) currentMonth = todayStr().slice(0, 7);
    meta.subtitle = monthLabel(currentMonth);
    ctx.setTopbar(meta.title, meta.subtitle);
    function rerender() { render(container, store, ctx); }

    function openAddModal() {
      const categories = store.listCategories();
      openFormModal({
        title: "记一笔",
        fields: [
          { name: "type", label: "类型", type: "select", options: [{ value: "expense", label: "支出" }, { value: "income", label: "收入" }] },
          { name: "amount", label: "金额", type: "number", step: "0.01", required: true },
          { name: "category", label: "分类", type: "select", options: categories },
          { name: "date", label: "日期", type: "date", required: true },
          { name: "note", label: "备注（选填）", type: "text" },
        ],
        initialValues: { date: todayStr() },
        onSubmit: (v) => {
          store.addTransaction({ amount: v.amount, type: v.type, category: v.category, date: v.date, note: v.note || "" });
          rerender();
        },
      });
    }

    function openManageCategories() {
      function renderList() {
        return h("div", {}, store.listCategories().map((c) =>
          h("div", { class: "list-row" }, [
            h("span", {}, c),
            h("span", {
              class: "row-delete spacer",
              onClick: () => { store.removeCategory(c); refresh(); },
            }, "删除"),
          ])
        ));
      }
      const input = h("input", { class: "field-input", type: "text", placeholder: "新分类名称" });
      const addBtn = h("button", { class: "btn btn-sm btn-primary", type: "button", onClick: () => {
        if (input.value.trim()) { store.addCategory(input.value.trim()); input.value = ""; refresh(); }
      } }, "添加");

      const listSlot = h("div", {}, [renderList()]);
      function refresh() { listSlot.replaceWith(h("div", {}, [renderList()])); }

      const overlay = h("div", { class: "modal-overlay" }, [
        h("div", { class: "modal-box" }, [
          h("div", { class: "modal-title" }, "管理分类"),
          h("div", { class: "section-row", style: "margin-bottom:10px;" }, [input, addBtn]),
          listSlot,
          h("div", { class: "modal-actions" }, [h("button", { class: "btn btn-ghost", type: "button", onClick: () => { overlay.remove(); rerender(); } }, "关闭")]),
        ]),
      ]);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) { overlay.remove(); rerender(); } });
      document.body.appendChild(overlay);
    }

    const summary = financeMonthlySummary(store, currentMonth);

    const summaryCards = h("div", { class: "summary-grid" }, [
      h("div", { class: "card" }, [h("div", { class: "summary-card-title" }, "收入"), h("div", { style: "font-size:20px;font-weight:700;" }, formatMoney(summary.income))]),
      h("div", { class: "card" }, [h("div", { class: "summary-card-title" }, "支出"), h("div", { style: "font-size:20px;font-weight:700;" }, formatMoney(summary.expense))]),
      h("div", { class: "card" }, [h("div", { class: "summary-card-title" }, "结余"), h("div", { style: "font-size:20px;font-weight:700;" }, formatMoney(summary.balance))]),
    ]);

    const breakdownCard = h("div", { class: "card split-side" }, [
      h("div", { class: "card-title" }, "分类占比（支出）"),
      summary.categoryBreakdown.length
        ? h("div", { style: "display:flex;flex-direction:column;gap:10px;" }, summary.categoryBreakdown.map((c) =>
            h("div", {}, [
              h("div", { class: "section-row", style: "justify-content:space-between;font-size:12px;margin-bottom:4px;" }, [h("span", {}, c.category), h("span", {}, `${c.percent}%`)]),
              h("div", { class: "bar-track" }, h("div", { class: "bar-fill", style: `width:${c.percent}%` })),
            ])
          ))
        : h("div", { class: "empty-hint" }, "本月还没有支出记录"),
    ]);

    const txs = store.listTransactions({ month: currentMonth }).sort((a, b) => (a.date < b.date ? 1 : -1));
    const byDate = new Map();
    txs.forEach((t) => {
      if (!byDate.has(t.date)) byDate.set(t.date, []);
      byDate.get(t.date).push(t);
    });

    const listCard = h("div", { class: "card split-main" }, [
      h("div", { class: "card-title" }, "流水"),
      txs.length
        ? h("div", {}, [...byDate.entries()].map(([date, list]) =>
            h("div", {}, [
              h("div", { class: "muted", style: "font-size:11px;margin:8px 0 4px 0;" }, formatDateDisplay(date)),
              ...list.map((t) => h("div", { class: "list-row" }, [
                h("span", { class: "badge" }, t.category),
                h("span", {}, t.note || t.category),
                h("span", { class: "spacer" }, `${t.type === "expense" ? "-" : "+"}${formatMoney(t.amount)}`),
                h("span", { class: "row-delete", onClick: () => { store.removeTransaction(t.id); rerender(); } }, "删除"),
              ])),
            ])
          ))
        : h("div", { class: "empty-hint" }, "本月还没有记录"),
    ]);

    const nav = h("div", { class: "section-row" }, [
      h("button", { class: "btn", type: "button", onClick: () => { currentMonth = shiftMonth(currentMonth, -1); rerender(); } }, "‹ 上一月"),
      h("button", { class: "btn", type: "button", onClick: () => { currentMonth = shiftMonth(currentMonth, 1); rerender(); } }, "下一月 ›"),
      h("div", { class: "grow" }),
      h("button", { class: "btn btn-outline", type: "button", onClick: openManageCategories }, "管理分类"),
      h("button", { class: "btn btn-primary", type: "button", onClick: openAddModal }, "+ 记一笔"),
    ]);

    mount(container, h("div", { style: "display:flex;flex-direction:column;gap:16px;" }, [
      nav,
      summaryCards,
      h("div", { class: "split-layout" }, [listCard, breakdownCard]),
    ]));
  }

  function monthLabel(month) {
    const [y, m] = month.split("-");
    return `${y}年${Number(m)}月`;
  }

  return { meta, render };
});
