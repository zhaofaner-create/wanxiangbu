(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.derived = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  // 跨模块的只读派生计算：分组、汇总、首页摘要。
  // 这些函数不修改数据，只是把 store 里的原始记录加工成页面/首页更容易直接展示的形状。
  // 全部是纯函数（只依赖传入的 store 和参考日期），方便单元测试。

  const { todayStr, daysUntil, isWithinDays, compareDateStr } = require("./utils.js");

  /** 把提醒事项分组为 今天(含已过期) / 即将到期(7天内) / 更晚 / 已处理。 */
  function groupReminders(store, refDate = todayStr(), upcomingWindowDays = 7) {
    const all = store.listReminders();
    const processed = all
      .filter((r) => r.repeat === "none" && r.status === "done")
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    const pending = all.filter((r) => !(r.repeat === "none" && r.status === "done"));
    const withNext = store
      .listRemindersWithNextDate(refDate)
      .filter((r) => pending.some((p) => p.id === r.id));

    const today = [];
    const upcoming = [];
    const later = [];

    withNext.forEach((r) => {
      const overdueOneTime = r.repeat === "none" && compareDateStr(r.nextDate, refDate) < 0;
      if (r.nextDate === refDate || overdueOneTime) {
        today.push(r);
      } else if (daysUntil(r.nextDate, refDate) <= upcomingWindowDays) {
        upcoming.push(r);
      } else {
        later.push(r);
      }
    });

    const byNextDate = (a, b) => (a.nextDate < b.nextDate ? -1 : a.nextDate > b.nextDate ? 1 : 0);
    return {
      today: today.sort(byNextDate),
      upcoming: upcoming.sort(byNextDate),
      later: later.sort(byNextDate),
      processed,
    };
  }

  /** 某个月的收支汇总：收入、支出、结余，以及按分类的支出占比。 */
  function financeMonthlySummary(store, month) {
    const txs = store.listTransactions({ month });
    const income = txs.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
    const expense = txs.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);

    const byCategory = new Map();
    txs.filter((t) => t.type === "expense").forEach((t) => {
      byCategory.set(t.category, (byCategory.get(t.category) || 0) + t.amount);
    });
    const categoryBreakdown = [...byCategory.entries()]
      .map(([category, amount]) => ({
        category,
        amount,
        percent: expense > 0 ? Math.round((amount / expense) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.amount - a.amount);

    return { month, income, expense, balance: income - expense, categoryBreakdown };
  }

  /** 低库存 / 保质期临近的物品列表。 */
  function lowStockAndExpiringItems(store, refDate = todayStr(), expiryWindowDays = 7) {
    const items = store.listInventoryItems();
    return {
      lowStock: items.filter((i) => store.isLowStock(i)),
      expiring: items.filter((i) => i.expiryDate && isWithinDays(i.expiryDate, expiryWindowDays, refDate)),
    };
  }

  /** 今日计划"关联"面板可选的候选项：未完成的作业/考试 + 今天到期或已过期且未处理的提醒。 */
  function linkCandidates(store, refDate = todayStr()) {
    return {
      assignments: store.listAssignments().filter((a) => a.status !== "已完成"),
      reminders: groupReminders(store, refDate).today,
    };
  }

  /** 首页需要的全部摘要数据，一次性算好。 */
  function homeSummary(store, refDate = todayStr()) {
    const reminders = groupReminders(store, refDate);
    const { lowStock, expiring } = lowStockAndExpiringItems(store, refDate);
    const slots = ["breakfast", "lunch", "dinner"];
    const meals = Object.fromEntries(slots.map((s) => [s, store.getMealEntry(refDate, s)]));

    return {
      todayPlan: store.listTodayPlan(refDate),
      studyNearest: store.listUpcomingAssignments(1)[0] || null,
      remindersToday: reminders.today,
      mealsToday: meals,
      lowStockCount: lowStock.length,
      expiringCount: expiring.length,
      finance: financeMonthlySummary(store, refDate.slice(0, 7)),
      gamesInProgress: store.listGames("在玩"),
    };
  }

  return { groupReminders, financeMonthlySummary, lowStockAndExpiringItems, linkCandidates, homeSummary };
});
