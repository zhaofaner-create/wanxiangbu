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

  /**
   * 某个月的收支汇总：收入、支出、结余，以及按分类的支出占比。
   * 记录可能是不同币种记的（人民币/欧元/美元），这里统一按 amountCNY（记录时汇率换算成的人民币等值）汇总，
   * 保证跨币种也能加总，不会把 58 元和 58 欧元直接相加。
   * accountId 传了就只统计这一个账户（多账户功能：切到某个具体账户时看这个账户自己的月度收支）；
   * 不传（默认）就是所有账户合计，和多账户功能加入之前的行为完全一样。
   */
  function financeMonthlySummary(store, month, accountId = null) {
    const txs = store.listTransactions({ month, accountId });
    const income = txs.filter((t) => t.type === "income").reduce((s, t) => s + t.amountCNY, 0);
    const expense = txs.filter((t) => t.type === "expense").reduce((s, t) => s + t.amountCNY, 0);

    const byCategory = new Map();
    txs.filter((t) => t.type === "expense").forEach((t) => {
      byCategory.set(t.category, (byCategory.get(t.category) || 0) + t.amountCNY);
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

  /**
   * 今日学习报告：汇总所有学习目标"今天"的计时数据，算出专注度和效率。
   * - 专注度（focusScore）：暂停次数越多，专注度越低（每次暂停扣5分，最低0分）。
   * - 效率（efficiency）：实际专注时长 占 从第一次开始计时到最后一次停止（或现在）这段总时间跨度 的比例——
   *   同样是学了1小时，如果中间断断续续拖了3小时才做完，效率就会比一口气学完低。
   * 两者在完全没有计时数据时都是 null，界面据此显示"今天还没有计时记录"而不是显示"0分"。
   */
  function studyFocusReport(store, refDate = todayStr()) {
    const goals = store.listGoalsWithTodayFocus(refDate).filter((g) => g.elapsedSeconds > 0 || g.firstStartAt);
    const totalSeconds = goals.reduce((sum, g) => sum + g.elapsedSeconds, 0);
    const totalPauses = goals.reduce((sum, g) => sum + g.pauseCount, 0);
    const totalSpanMs = goals.reduce((sum, g) => {
      if (!g.firstStartAt) return sum;
      const end = g.lastStopAt || Date.now();
      return sum + Math.max(0, end - g.firstStartAt);
    }, 0);
    return {
      totalSeconds,
      totalMinutes: Math.round(totalSeconds / 60),
      totalPauses,
      focusScore: totalSeconds > 0 ? Math.max(0, 100 - totalPauses * 5) : null,
      efficiency: totalSpanMs > 0 ? Math.min(100, Math.round(((totalSeconds * 1000) / totalSpanMs) * 100)) : null,
      goals: goals.map((g) => ({ id: g.id, name: g.name, minutes: Math.round(g.elapsedSeconds / 60), pauseCount: g.pauseCount })),
    };
  }

  return { groupReminders, financeMonthlySummary, lowStockAndExpiringItems, linkCandidates, homeSummary, studyFocusReport };
});
