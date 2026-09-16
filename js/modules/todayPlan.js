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

  const PRIORITY_BADGE_CLASS = { 高: "badge-warning", 中: "badge-info", 低: "" };

  let completedOpen = false;
  let tickTimer = null;

  /** 把秒数格式化成"12分34秒"这种展示形式；不到1分钟只显示秒数。 */
  function formatElapsed(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    if (m === 0) return `${s}秒`;
    return s === 0 ? `${m}分钟` : `${m}分${s}秒`;
  }

  /** 计算某一项当前实际已用的秒数：已累计的 + 如果正在计时，加上这一段正在跑的时间。 */
  function liveElapsedSeconds(item) {
    const running = item.timerStartedAt ? Math.max(0, Math.round((Date.now() - item.timerStartedAt) / 1000)) : 0;
    return (item.elapsedSeconds || 0) + running;
  }

  /** 事项标记完成后弹出的满意度小弹窗（1-5星），可以直接点"跳过"不评分。 */
  function openSatisfactionModal(store, item, rerender) {
    const overlay = h("div", { class: "modal-overlay" }, [
      h("div", { class: "modal-box" }, [
        h("div", { class: "modal-title" }, `「${item.text}」完成得怎么样？`),
        h("div", { class: "satisfaction-stars" }, [1, 2, 3, 4, 5].map((n) =>
          h("button", {
            class: "btn btn-sm btn-outline",
            type: "button",
            onClick: () => {
              store.setTodayPlanSatisfaction(item.id, n);
              overlay.remove();
              rerender();
            },
          }, "★".repeat(n))
        )),
        h("div", { class: "modal-actions" }, [
          h("button", { class: "btn btn-ghost", type: "button", onClick: () => overlay.remove() }, "跳过"),
        ]),
      ]),
    ]);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  function itemFormFields() {
    return [
      { name: "text", label: "事项内容", type: "text", required: true },
      { name: "date", label: "日期", type: "date", required: true },
      { name: "time", label: "开始时间（选填）", type: "time" },
      { name: "estimatedMinutes", label: "预计用时（分钟，选填）", type: "number" },
      { name: "priority", label: "优先度", type: "select", options: ["高", "中", "低"] },
      { name: "note", label: "备注（选填）", type: "textarea" },
    ];
  }

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
        fields: itemFormFields(),
        initialValues: { date: today, priority: "中" },
        onSubmit: (values) => {
          store.addTodayPlanItem({
            text: values.text, time: values.time || null, date: values.date || today,
            estimatedMinutes: values.estimatedMinutes || null, priority: values.priority, note: values.note || "",
          });
          rerender();
        },
      });
    }

    function openEditModal(item) {
      openFormModal({
        title: "编辑事项",
        submitLabel: "保存修改",
        fields: itemFormFields(),
        initialValues: {
          text: item.text, date: item.date, time: item.time || "",
          estimatedMinutes: item.estimatedMinutes || "", priority: item.priority, note: item.note || "",
        },
        onSubmit: (values) => {
          store.updateTodayPlanItem(item.id, {
            text: values.text, date: values.date, time: values.time || null,
            estimatedMinutes: values.estimatedMinutes || null, priority: values.priority, note: values.note || "",
          });
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

    function renderTimerWidget(item) {
      if (item.effectiveDone) {
        const elapsed = item.elapsedSeconds || 0;
        const bits = [];
        if (elapsed > 0) bits.push(`用时 ${formatElapsed(elapsed)}`);
        if (item.satisfaction) bits.push("★".repeat(item.satisfaction) + "☆".repeat(5 - item.satisfaction));
        return bits.length
          ? h("div", { class: "timer-widget muted", style: "font-size:12px;" }, bits.join(" · "))
          : null;
      }
      const running = !!item.timerStartedAt;
      const elapsed = liveElapsedSeconds(item);
      const pct = item.estimatedMinutes ? Math.min(100, Math.round((elapsed / (item.estimatedMinutes * 60)) * 100)) : null;
      return h("div", { class: "timer-widget" }, [
        h("div", { class: "section-row", style: "gap:8px;" }, [
          h("button", {
            class: "btn btn-sm " + (running ? "btn-outline" : "btn-primary"),
            type: "button",
            onClick: () => {
              if (running) store.pauseTodayPlanTimer(item.id);
              else store.startTodayPlanTimer(item.id);
              rerender();
            },
          }, running ? "暂停" : "开始计时"),
          h("button", {
            class: "btn btn-sm btn-outline",
            type: "button",
            onClick: () => {
              const wasDone = item.effectiveDone;
              const updated = store.finishTodayPlanItem(item.id);
              if (updated && updated.effectiveDone) {
                completedOpen = true;
                if (!wasDone) openSatisfactionModal(store, updated, rerender);
              }
              rerender();
            },
          }, "完成"),
          h("span", { class: "muted", style: "font-size:12px;" },
            `已用时 ${formatElapsed(elapsed)}` + (item.estimatedMinutes ? ` / 预计 ${item.estimatedMinutes} 分钟` : "")),
        ]),
        item.estimatedMinutes
          ? h("div", { class: "progress-bar" }, h("div", { class: "progress-bar-fill" + (pct >= 100 ? " over" : ""), style: `width:${pct}%;` }))
          : null,
      ]);
    }

    function renderRow(item) {
      const metaBits = [];
      if (item.time) metaBits.push(item.time);
      if (item.estimatedMinutes) metaBits.push(`预计 ${item.estimatedMinutes} 分钟`);
      return h("div", { class: "check-row-block" }, [
        h("label", { class: "check-row" + (item.effectiveDone ? " done" : "") }, [
          h("input", {
            type: "checkbox",
            checked: item.effectiveDone || undefined,
            onChange: () => {
              const wasDone = item.effectiveDone;
              const updated = store.toggleTodayPlanDone(item.id);
              // 勾选完成后自动展开"已完成"区域，让用户能立刻看到这一项带删除线移动过去了，
              // 而不是勾选之后这一行凭空消失、看起来像没生效。
              if (updated && updated.effectiveDone) {
                completedOpen = true;
                if (!wasDone) openSatisfactionModal(store, updated, rerender);
              }
              rerender();
            },
          }),
          h("span", { class: "badge " + PRIORITY_BADGE_CLASS[item.priority || "中"] }, item.priority || "中"),
          h("span", {}, item.text + (metaBits.length ? ` · ${metaBits.join(" · ")}` : "")),
          item.source !== "manual"
            ? h("span", { class: "badge" }, item.source === "study" ? "来自学习任务" : "来自提醒事项")
            : null,
          h("span", {
            class: "row-edit",
            title: "编辑",
            onClick: (e) => { e.preventDefault(); openEditModal(item); },
          }, "编辑"),
          h("span", {
            class: "row-delete",
            title: "删除",
            onClick: (e) => {
              e.preventDefault();
              store.removeTodayPlanItem(item.id);
              rerender();
            },
          }, "删除"),
        ]),
        renderTimerWidget(item),
        item.note ? h("div", { class: "muted", style: "font-size:12px;padding-left:28px;margin-top:-4px;" }, item.note) : null,
      ]);
    }

    function renderTimelineCard() {
      const timed = items.filter((i) => i.time).sort((a, b) => a.time.localeCompare(b.time));
      const untimed = items.filter((i) => !i.time);
      const ordered = [...timed, ...untimed];
      return h("div", { class: "card" }, [
        h("div", { class: "card-title" }, "今日时间线"),
        ordered.length
          ? h("div", { class: "timeline" }, ordered.map((item) => h("div", { class: "timeline-row" + (item.effectiveDone ? " done" : "") }, [
              h("span", { class: "timeline-dot priority-" + (item.priority || "中") }),
              h("span", { class: "timeline-time" }, item.time || "—"),
              h("span", { class: "timeline-text" }, item.text),
              h("span", { class: "badge " + PRIORITY_BADGE_CLASS[item.priority || "中"] }, item.priority || "中"),
            ])))
          : h("div", { class: "empty-hint" }, "今天还没有安排事项"),
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
      renderTimelineCard(),
      pendingCard,
      doneCard,
    ]));

    // 有计时器在跑的时候，每秒刷新一次页面让"已用时"和进度条动起来；
    // 一旦用户切到别的模块（contentEl 的 activeModuleId 变了），下一次 tick 就会自己停掉，
    // 不会在看不见的页面里一直偷偷重新渲染。
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    const anyRunning = items.some((i) => i.timerStartedAt);
    if (anyRunning) {
      tickTimer = setInterval(() => {
        if (container.dataset.activeModuleId !== meta.id) {
          clearInterval(tickTimer);
          tickTimer = null;
          return;
        }
        rerender();
      }, 1000);
    }
  }

  return { meta, render };
});
