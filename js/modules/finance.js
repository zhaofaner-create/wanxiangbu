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
  const { createSegmented } = require("../components/segmented.js");
  const { openFormModal } = require("../components/modal.js");
  const { openConfirm } = require("../components/confirm.js");
  const { financeMonthlySummary } = require("../derived.js");
  const { todayStr, formatDateDisplay, shiftMonth } = require("../utils.js");

  const meta = { id: "finance", label: "个人记账", title: "个人记账", subtitle: "" };

  const CURRENCY_LABELS = { CNY: "人民币 (CNY)", EUR: "欧元 (EUR)", USD: "美元 (USD)" };
  const CURRENCY_SYMBOLS = { CNY: "¥", EUR: "€", USD: "$" };

  /** 按币种格式化金额（不是人民币的话，记账列表里单独用这个，而不是只认 ¥ 的 formatMoney）。 */
  function formatByCurrency(amount, currency) {
    const sign = amount < 0 ? "-" : "";
    const symbol = CURRENCY_SYMBOLS[currency] || currency + " ";
    return `${sign}${symbol}${Math.abs(amount).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
  }

  let currentMonth = null;
  let currentAccountId = null; // null 表示"全部账户"

  function render(container, store, ctx) {
    if (!currentMonth) currentMonth = todayStr().slice(0, 7);
    meta.subtitle = monthLabel(currentMonth);
    ctx.setTopbar(meta.title, meta.subtitle);
    function rerender() { render(container, store, ctx); }

    function transactionFields(categories, accounts) {
      const fields = [
        { name: "type", label: "类型", type: "select", options: [{ value: "expense", label: "支出" }, { value: "income", label: "收入" }] },
        { name: "amount", label: "金额", type: "number", step: "0.01", required: true },
        { name: "currency", label: "货币单位", type: "select", options: store.CURRENCIES.map((c) => ({ value: c, label: CURRENCY_LABELS[c] })) },
        { name: "category", label: "分类", type: "select", options: categories },
        { name: "date", label: "日期", type: "date", required: true },
        { name: "note", label: "备注（选填）", type: "text" },
      ];
      if (accounts.length > 1) {
        fields.push({ name: "accountId", label: "账户", type: "select", options: accounts.map((a) => ({ value: a.id, label: a.name })) });
      }
      return fields;
    }

    function openAddModal() {
      const categories = store.listCategories();
      const accounts = store.listAccounts();
      openFormModal({
        title: "记一笔",
        fields: transactionFields(categories, accounts),
        initialValues: { date: todayStr(), currency: "CNY", accountId: currentAccountId || (accounts[0] && accounts[0].id) },
        onSubmit: (v) => {
          store.addTransaction({ amount: v.amount, currency: v.currency || "CNY", type: v.type, category: v.category, date: v.date, note: v.note || "", accountId: v.accountId || null });
          rerender();
        },
      });
    }

    /** 编辑一笔已有记录，不用删了重新录入。 */
    function openEditModal(t) {
      const categories = store.listCategories();
      const accounts = store.listAccounts();
      openFormModal({
        title: "编辑记录",
        submitLabel: "保存修改",
        fields: transactionFields(categories, accounts),
        initialValues: { type: t.type, amount: t.amount, currency: t.currency, category: t.category, date: t.date, note: t.note || "", accountId: t.accountId || (accounts[0] && accounts[0].id) },
        onSubmit: (v) => {
          store.updateTransaction(t.id, {
            amount: v.amount, currency: v.currency || "CNY", type: v.type, category: v.category, date: v.date, note: v.note || "", accountId: v.accountId || t.accountId,
          });
          rerender();
        },
      });
    }

    /** 预算设置：每个分类可以填一个月度预算上限，留空/填0表示不设预算（不参与超支提醒）。 */
    function openBudgetModal() {
      const categories = store.listCategories();
      const budgets = store.getBudgets();
      openFormModal({
        title: "设置每月预算",
        fields: categories.map((c) => ({ name: c, label: c, type: "number", step: "10", placeholder: "留空表示不设预算" })),
        initialValues: Object.fromEntries(categories.map((c) => [c, budgets[c] != null ? budgets[c] : ""])),
        submitLabel: "保存",
        onSubmit: (v) => {
          categories.forEach((c) => store.setBudget(c, v[c]));
          rerender();
        },
      });
    }

    /** 账户管理：新增/改名/删除账户。删除账户不会删掉它名下的记账记录，只是清空归属。 */
    function openAccountsModal() {
      function renderList() {
        return h("div", {}, store.listAccountsWithBalance().map((a) =>
          h("div", { class: "list-row" }, [
            h("span", {}, a.name),
            h("span", { class: "muted spacer" }, formatMoney(a.balance)),
            h("span", {
              class: "row-edit", title: "改名",
              onClick: () => openFormModal({
                title: `重命名账户 · ${a.name}`,
                fields: [{ name: "name", label: "账户名称", type: "text", required: true }],
                initialValues: { name: a.name },
                submitLabel: "保存",
                onSubmit: (v) => { store.updateAccount(a.id, { name: v.name }); refresh(); },
              }),
            }, "改名"),
            h("span", {
              class: "row-delete",
              onClick: () => openConfirm({
                message: `删除账户「${a.name}」？名下的记账记录不会被删除，只是不再归属任何账户。`,
                danger: true,
                confirmLabel: "删除",
                onConfirm: () => { store.removeAccount(a.id); refresh(); },
              }),
            }, "删除"),
          ])
        ));
      }
      const nameInput = h("input", { class: "field-input", type: "text", placeholder: "新账户名称" });
      const balanceInput = h("input", { class: "field-input", type: "number", step: "0.01", placeholder: "期初余额（选填，默认0）" });
      const addBtn = h("button", { class: "btn btn-sm btn-primary", type: "button", onClick: () => {
        if (nameInput.value.trim()) {
          store.addAccount({ name: nameInput.value.trim(), initialBalance: balanceInput.value || 0 });
          nameInput.value = ""; balanceInput.value = "";
          refresh();
        }
      } }, "添加");

      let listSlot = h("div", {}, [renderList()]);
      function refresh() { const next = h("div", {}, [renderList()]); listSlot.replaceWith(next); listSlot = next; }

      const overlay = h("div", { class: "modal-overlay" }, [
        h("div", { class: "modal-box" }, [
          h("div", { class: "modal-title" }, "账户管理"),
          h("div", { class: "section-row", style: "margin-bottom:10px;" }, [nameInput, balanceInput, addBtn]),
          listSlot,
          h("div", { class: "modal-actions" }, [h("button", { class: "btn btn-ghost", type: "button", onClick: () => { overlay.remove(); rerender(); } }, "关闭")]),
        ]),
      ]);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) { overlay.remove(); rerender(); } });
      document.body.appendChild(overlay);
    }

    function openExchangeRateModal() {
      const rates = store.getExchangeRates();
      const foreign = store.CURRENCIES.filter((c) => c !== "CNY");
      const inputs = {};
      const rows = foreign.map((c) => {
        const input = h("input", { class: "field-input", type: "number", step: "0.0001", value: String(rates[c]) });
        inputs[c] = input;
        return h("div", { class: "field-row" }, [
          h("label", { class: "field-label" }, `1 ${CURRENCY_LABELS[c]} = 多少人民币`),
          input,
        ]);
      });
      const overlay = h("div", { class: "modal-overlay" }, [
        h("div", { class: "modal-box" }, [
          h("div", { class: "modal-title" }, "汇率设置"),
          h("div", { class: "muted", style: "font-size:12px;margin-bottom:14px;" },
            "这个应用不联网，没法自动取实时汇率，这里按你手动填的汇率换算。记账时会按当时的汇率把外币换算成人民币等值用于统计，改了汇率不会影响已经记过的账。"),
          ...rows,
          h("div", { class: "modal-actions" }, [
            h("button", { class: "btn btn-ghost", type: "button", onClick: () => overlay.remove() }, "取消"),
            h("button", {
              class: "btn btn-primary", type: "button",
              onClick: () => {
                foreign.forEach((c) => store.setExchangeRate(c, inputs[c].value));
                overlay.remove();
                rerender();
              },
            }, "保存"),
          ]),
        ]),
      ]);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
      document.body.appendChild(overlay);
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

    function renderBody() {
      const summary = financeMonthlySummary(store, currentMonth, currentAccountId);

      const summaryCards = h("div", { class: "summary-grid" }, [
        h("div", { class: "card" }, [h("div", { class: "summary-card-title" }, "收入"), h("div", { style: "font-size:20px;font-weight:700;" }, formatMoney(summary.income))]),
        h("div", { class: "card" }, [h("div", { class: "summary-card-title" }, "支出"), h("div", { style: "font-size:20px;font-weight:700;" }, formatMoney(summary.expense))]),
        h("div", { class: "card" }, [h("div", { class: "summary-card-title" }, "结余"), h("div", { style: "font-size:20px;font-weight:700;" }, formatMoney(summary.balance))]),
      ]);

      const breakdownCard = h("div", { class: "card" }, [
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

      const budgetStatuses = store.getBudgetStatus(currentMonth);
      const budgetCard = h("div", { class: "card" }, [
        h("div", { class: "card-title" }, [
          h("span", {}, "预算超支提醒"),
          h("span", { class: "muted", style: "cursor:pointer;font-weight:400;", onClick: openBudgetModal }, "设置预算"),
        ]),
        budgetStatuses.length
          ? h("div", { style: "display:flex;flex-direction:column;gap:10px;" }, budgetStatuses.map((s) => h("div", {}, [
              h("div", { class: "section-row", style: "justify-content:space-between;font-size:12px;margin-bottom:4px;" }, [
                h("span", {}, s.category + (s.overspent ? " ⚠" : "")),
                h("span", { style: s.overspent ? "color:var(--danger);font-weight:600;" : "" }, `¥${s.spent} / ¥${s.budget}`),
              ]),
              h("div", { class: "bar-track" }, h("div", { class: "bar-fill" + (s.overspent ? " over" : ""), style: `width:${Math.min(100, s.percent)}%` })),
            ])))
          : h("div", { class: "empty-hint" }, "还没有设置预算，点上面“设置预算”给分类定一个月度上限，超支时会在这里提醒"),
      ]);

      const chartCard = renderIncomeExpenseChart(store, currentMonth);

      const txs = store.listTransactions({ month: currentMonth, accountId: currentAccountId }).sort((a, b) => (a.date < b.date ? 1 : -1));
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
                  h("span", { class: "spacer", style: "text-align:right;" }, [
                    h("div", {}, `${t.type === "expense" ? "-" : "+"}${formatByCurrency(t.amount, t.currency)}`),
                    t.currency !== "CNY"
                      ? h("div", { class: "muted", style: "font-size:11px;" }, `≈${formatMoney(t.type === "expense" ? -t.amountCNY : t.amountCNY)}`)
                      : null,
                  ]),
                  h("span", { class: "row-edit", title: "编辑", onClick: () => openEditModal(t) }, "编辑"),
                  h("span", { class: "row-delete", onClick: () => { store.removeTransaction(t.id); refreshBody(); } }, "删除"),
                ])),
              ])
            ))
          : h("div", { class: "empty-hint" }, "本月还没有记录"),
      ]);

      const sideColumn = h("div", { class: "split-side", style: "display:flex;flex-direction:column;gap:14px;" }, [breakdownCard, budgetCard]);

      return h("div", { style: "display:flex;flex-direction:column;gap:16px;" }, [
        summaryCards,
        chartCard,
        h("div", { class: "split-layout" }, [listCard, sideColumn]),
      ]);
    }

    // 账户筛选也是一个持续存在的分段控件（液态玻璃胶囊）：切换账户时只刷新下面的内容插槽，
    // 不会把胶囊轨道整体销毁重建。
    const bodySlot = h("div", {});
    function refreshBody() { mount(bodySlot, renderBody()); }
    refreshBody();

    const accounts = store.listAccounts();
    const accountFilterOptions = [{ key: "__all__", label: "全部账户" }, ...accounts.map((a) => ({ key: a.id, label: a.name }))];
    const accountFilterSeg = createSegmented({
      kind: "pill",
      options: accountFilterOptions,
      activeKey: currentAccountId || "__all__",
      onSelect: (key) => { currentAccountId = key === "__all__" ? null : key; refreshBody(); },
    });

    const nav = h("div", { class: "section-row" }, [
      h("button", { class: "btn", type: "button", onClick: () => { currentMonth = shiftMonth(currentMonth, -1); refreshBody(); } }, "‹ 上一月"),
      h("button", { class: "btn", type: "button", onClick: () => { currentMonth = shiftMonth(currentMonth, 1); refreshBody(); } }, "下一月 ›"),
      h("div", { class: "grow" }),
      h("button", { class: "btn btn-outline", type: "button", onClick: openAccountsModal }, "账户管理"),
      h("button", { class: "btn btn-outline", type: "button", onClick: openExchangeRateModal }, "汇率设置"),
      h("button", { class: "btn btn-outline", type: "button", onClick: openManageCategories }, "管理分类"),
      h("button", { class: "btn btn-primary", type: "button", onClick: openAddModal }, "+ 记一笔"),
    ]);

    mount(container, h("div", { style: "display:flex;flex-direction:column;gap:16px;" }, [
      nav,
      accountFilterSeg.el,
      bodySlot,
    ]));
  }

  /** 手绘竖向双柱状图：最近6个月，每个月并排两根柱子（收入/支出）。 */
  function renderIncomeExpenseChart(store, currentMonth) {
    const months = 6;
    const series = store.listMonthlyTotals(months, currentMonth);
    const maxAmount = Math.max(1, ...series.flatMap((m) => [m.income, m.expense]));
    const cols = series.map((m) => {
      const incomeHeight = m.income > 0 ? Math.max(4, Math.round((m.income / maxAmount) * 100)) : 0;
      const expenseHeight = m.expense > 0 ? Math.max(4, Math.round((m.expense / maxAmount) * 100)) : 0;
      return h("div", { class: "chart-bar-col" }, [
        h("div", { class: "chart-bar-track", style: "display:flex;gap:3px;align-items:flex-end;" }, [
          h("div", { class: "chart-bar income", style: `height:${incomeHeight}%;flex:1;` }),
          h("div", { class: "chart-bar expense", style: `height:${expenseHeight}%;flex:1;` }),
        ]),
        h("div", { class: "chart-bar-label" + (m.month === currentMonth ? " is-today" : "") }, monthLabel(m.month).replace("年", "/").replace("月", "")),
      ]);
    });

    return h("div", { class: "card" }, [
      h("div", { class: "card-title" }, [
        h("span", {}, "收支图表 · 最近6个月"),
        h("span", { class: "muted", style: "font-size:11px;font-weight:400;" }, [
          h("span", { class: "chart-legend-dot income" }), "收入",
          h("span", { class: "chart-legend-dot expense" }), "支出",
        ]),
      ]),
      h("div", { class: "chart-bars" }, cols),
    ]);
  }

  function monthLabel(month) {
    const [y, m] = month.split("-");
    return `${y}年${Number(m)}月`;
  }

  return { meta, render };
});
