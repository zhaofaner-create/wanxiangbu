(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.home = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  const { h, mount, formatMoney } = require("../components/dom.js");
  const { homeSummary } = require("../derived.js");
  const { todayStr, formatDateDisplay, weekdayLabel } = require("../utils.js");

  const meta = { id: "home", label: "首页总览", title: "首页总览", subtitle: "" };

  function render(container, store, ctx) {
    meta.subtitle = `${formatDateDisplay(todayStr())} ${weekdayLabel(todayStr())}`;
    ctx.setTopbar(meta.title, meta.subtitle);

    const summary = homeSummary(store, todayStr());
    const homeCards = store.getSettings().homeCards;

    function rerender() {
      render(container, store, ctx);
    }

    const planCard = h("div", { class: "card" }, [
      h("div", { class: "card-title" }, [
        h("span", {}, "今日计划"),
        h("span", { class: "muted", style: "cursor:pointer;font-weight:400;", onClick: () => ctx.navigateTo("todayPlan") }, "查看全部 ›"),
      ]),
      summary.todayPlan.length === 0
        ? h("div", { class: "empty-hint" }, "今天还没有安排事项")
        : h(
            "div",
            {},
            summary.todayPlan.map((item) =>
              h("label", { class: "check-row" + (item.effectiveDone ? " done" : "") }, [
                h("input", {
                  type: "checkbox",
                  checked: item.effectiveDone || undefined,
                  onChange: () => {
                    store.toggleTodayPlanDone(item.id);
                    rerender();
                  },
                }),
                h("span", {}, item.text),
                item.source !== "manual"
                  ? h("span", { class: "badge spacer" }, item.source === "study" ? "来自学习任务" : "来自提醒事项")
                  : null,
              ])
            )
          ),
    ]);

    function summaryCard({ key, title, main, sub, warn, moduleId }) {
      if (!homeCards[key]) return null;
      return h(
        "button",
        { class: "summary-card", type: "button", onClick: () => ctx.navigateTo(moduleId) },
        [
          h("div", { class: "summary-card-title" }, title),
          h("div", { class: "summary-card-main" }, main),
          sub ? h("div", { class: "summary-card-sub" + (warn ? " warn" : "") }, sub) : null,
        ]
      );
    }

    const cards = [
      summaryCard({
        key: "study",
        title: "学习任务",
        main: summary.studyNearest ? summary.studyNearest.title : "暂无未完成的作业/考试",
        sub: summary.studyNearest ? `截止 ${formatDateDisplay(summary.studyNearest.dueDate)}` : "",
        moduleId: "studyTasks",
      }),
      summaryCard({
        key: "reminders",
        title: "提醒事项",
        main: summary.remindersToday.length ? summary.remindersToday.map((r) => r.title).join("、") : "今天没有提醒",
        sub: summary.remindersToday.length ? `共 ${summary.remindersToday.length} 条` : "",
        moduleId: "reminders",
      }),
      summaryCard({
        key: "meal",
        title: "饮食计划",
        main: `午餐：${summary.mealsToday.lunch || "未安排"}`,
        sub: `晚餐：${summary.mealsToday.dinner || "未安排"}`,
        moduleId: "mealPlan",
      }),
      summaryCard({
        key: "inventory",
        title: "生活用品库存",
        main: `${summary.lowStockCount} 件低库存`,
        sub: summary.expiringCount ? `${summary.expiringCount} 件即将过期` : "暂无临期物品",
        warn: summary.lowStockCount > 0 || summary.expiringCount > 0,
        moduleId: "inventory",
      }),
      summaryCard({
        key: "finance",
        title: "个人记账",
        main: `本月支出 ${formatMoney(summary.finance.expense)}`,
        sub: `结余 ${formatMoney(summary.finance.balance)}`,
        warn: summary.finance.balance < 0,
        moduleId: "finance",
      }),
      summaryCard({
        key: "games",
        title: "游戏娱乐",
        main: summary.gamesInProgress.length ? `在玩：${summary.gamesInProgress.map((g) => g.name).join("、")}` : "暂无在玩的游戏",
        sub: "",
        moduleId: "games",
      }),
    ].filter(Boolean);

    mount(container, h("div", { style: "display:flex;flex-direction:column;gap:16px;" }, [
      planCard,
      h("div", { class: "summary-grid" }, cards),
    ]));
  }

  return { meta, render };
});
