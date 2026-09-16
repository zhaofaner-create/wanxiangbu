(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.todayPlan = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  const { h, mount } = require("../components/dom.js");
  const { openFormModal } = require("../components/modal.js");
  const { linkCandidates } = require("../derived.js");
  const { todayStr, formatDateDisplay } = require("../utils.js");

  const meta = { id: "todayPlan", label: "今日计划", title: "今日计划", subtitle: "" };

  let completedOpen = false;

  function render(container, store, ctx) {
    const today = todayStr();
    meta.subtitle = formatDateDisplay(today);
    ctx.setTopbar(meta.title, meta.subtitle);

    function rerender() {
      render(container, store, ctx);
    }

    const items = store.listTodayPlan(today);
    const pending = items.filter((i) => !i.effectiveDone);
    const done = items.filter((i) => i.effectiveDone);

    function openAddModal() {
      openFormModal({
        title: "添加今日事项",
        fields: [
          { name: "text", label: "事项内容", type: "text", required: true },
          { name: "time", label: "时间点（选填）", type: "time" },
        ],
        onSubmit: (values) => {
          store.addTodayPlanItem({ text: values.text, time: values.time || null, date: today });
          rerender();
        },
      });
    }

    function openLinkPanel() {
      const candidates = linkCandidates(store, today);
      const rows = [
        ...candidates.assignments.map((a) =>
          h("div", { class: "list-row" }, [
            h("span", {}, a.title),
            h("span", { class: "badge spacer" }, `截止 ${formatDateDisplay(a.dueDate)}`),
            h("button", {
              class: "btn btn-sm",
              type: "button",
              onClick: () => {
                store.linkAssignmentToToday(a.id, today);
                closeAndRerender();
              },
            }, "+"),
          ])
        ),
        ...candidates.reminders.map((r) =>
          h("div", { class: "list-row" }, [
            h("span", {}, r.title),
            h("span", { class: "badge spacer" }, "提醒事项"),
            h("button", {
              class: "btn btn-sm",
              type: "button",
              onClick: () => {
                store.linkReminderToToday(r.id, today);
                closeAndRerender();
              },
            }, "+"),
          ])
        ),
      ];

      function closeAndRerender() {
        overlay.remove();
        rerender();
      }

      const overlay = h("div", { class: "modal-overlay" }, [
        h("div", { class: "modal-box" }, [
          h("div", { class: "modal-title" }, "关联事项到今天"),
          rows.length ? h("div", {}, rows) : h("div", { class: "empty-hint" }, "没有可关联的未完成作业或今天到期的提醒"),
          h("div", { class: "modal-actions" }, [
            h("button", { class: "btn btn-ghost", type: "button", onClick: () => overlay.remove() }, "关闭"),
          ]),
        ]),
      ]);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
      document.body.appendChild(overlay);
    }

    function renderRow(item) {
      return h("label", { class: "check-row" + (item.effectiveDone ? " done" : "") }, [
        h("input", {
          type: "checkbox",
          checked: item.effectiveDone || undefined,
          onChange: () => {
            const updated = store.toggleTodayPlanDone(item.id);
            // 勾选完成后自动展开"已完成"区域，让用户能立刻看到这一项带删除线移动过去了，
            // 而不是勾选之后这一行凭空消失、看起来像没生效。
            if (updated && updated.effectiveDone) completedOpen = true;
            rerender();
          },
        }),
        h("span", {}, item.text + (item.time ? ` · ${item.time}` : "")),
        item.source !== "manual"
          ? h("span", { class: "badge" }, item.source === "study" ? "来自学习任务" : "来自提醒事项")
          : null,
        h("span", {
          class: "row-delete",
          title: "删除",
          onClick: (e) => {
            e.preventDefault();
            store.removeTodayPlanItem(item.id);
            rerender();
          },
        }, "删除"),
      ]);
    }

    const pendingCard = h("div", { class: "card" }, [
      h("div", { class: "card-title" }, `今天（${pending.length}）`),
      pending.length ? h("div", {}, pending.map(renderRow)) : h("div", { class: "empty-hint" }, "今天还没有安排事项"),
    ]);

    const doneCard = h("div", { class: "card" }, [
      h("div", { class: "collapsible-header", onClick: () => { completedOpen = !completedOpen; rerender(); } }, [
        h("span", {}, `已完成（${done.length}）`),
        h("span", {}, completedOpen ? "︿" : "﹀"),
      ]),
      completedOpen ? h("div", { style: "margin-top:10px;" }, done.map(renderRow)) : null,
    ]);

    const actions = h("div", { class: "section-row" }, [
      h("button", { class: "btn btn-outline", type: "button", onClick: openLinkPanel }, "关联事项"),
      h("button", { class: "btn btn-primary", type: "button", onClick: openAddModal }, "+ 添加今日事项"),
    ]);

    mount(container, h("div", { style: "display:flex;flex-direction:column;gap:14px;" }, [
      actions,
      pendingCard,
      doneCard,
    ]));
  }

  return { meta, render };
});
