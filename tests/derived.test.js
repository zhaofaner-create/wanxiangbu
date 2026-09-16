const { test, describe, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const { createStore } = require("../js/store.js");
const { createMemoryStorage } = require("./helpers/memoryStorage.js");
const { groupReminders, financeMonthlySummary, lowStockAndExpiringItems, homeSummary, linkCandidates, studyFocusReport } = require("../js/derived.js");

const TODAY = "2026-09-16";

let store;
beforeEach(() => {
  store = createStore(createMemoryStorage());
  store.init();
});

describe("groupReminders", () => {
  test("今天到期、即将到期（7天内）、更晚、已处理 分组正确", () => {
    store.addReminder({ title: "缴手机话费", date: TODAY, repeat: "none" }); // 今天
    store.addReminder({ title: "房租转账", date: "2026-09-20", repeat: "monthly" }); // 4天后，即将到期
    store.addReminder({ title: "很久以后的事", date: "2026-11-01", repeat: "none" }); // 更晚
    const doneOne = store.addReminder({ title: "已经办完的事", date: "2026-09-10", repeat: "none" });
    store.markReminderDone(doneOne.id);

    const groups = groupReminders(store, TODAY);
    assert.deepEqual(groups.today.map((r) => r.title), ["缴手机话费"]);
    assert.deepEqual(groups.upcoming.map((r) => r.title), ["房租转账"]);
    assert.deepEqual(groups.later.map((r) => r.title), ["很久以后的事"]);
    assert.deepEqual(groups.processed.map((r) => r.title), ["已经办完的事"]);
  });

  test("一次性提醒已过期但未处理，归入\"今天\"分组（PRD：今天到期或已过期）", () => {
    store.addReminder({ title: "护照续签预约", date: "2026-09-10", repeat: "none" }); // 已过期，还没标记完成
    const groups = groupReminders(store, TODAY);
    assert.deepEqual(groups.today.map((r) => r.title), ["护照续签预约"]);
  });

  test("周期性提醒即使锚点日期已过很久，也按下一次发生日期分组，不会被当成\"过期未处理\"", () => {
    store.addReminder({ title: "每月固定的事", date: "2026-01-16", repeat: "monthly" }); // 锚点很早
    const groups = groupReminders(store, TODAY);
    assert.deepEqual(groups.today.map((r) => r.title), ["每月固定的事"]); // 下一次刚好是今天
  });
});

describe("financeMonthlySummary", () => {
  test("收入支出结余与分类占比计算正确，且四舍五入到一位小数", () => {
    store.addTransaction({ amount: 60, type: "expense", category: "餐饮", date: "2026-09-01" });
    store.addTransaction({ amount: 30, type: "expense", category: "交通", date: "2026-09-02" });
    store.addTransaction({ amount: 10, type: "expense", category: "娱乐", date: "2026-09-03" });
    store.addTransaction({ amount: 500, type: "income", category: "其他", date: "2026-09-01" });

    const summary = financeMonthlySummary(store, "2026-09");
    assert.equal(summary.income, 500);
    assert.equal(summary.expense, 100);
    assert.equal(summary.balance, 400);

    const percents = summary.categoryBreakdown.map((c) => c.percent);
    const total = percents.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 100) < 0.2); // 四舍五入允许的合理误差
    assert.equal(summary.categoryBreakdown[0].category, "餐饮"); // 按金额降序
  });

  test("当月没有支出时不除以0，占比为空或0", () => {
    store.addTransaction({ amount: 500, type: "income", category: "其他", date: "2026-09-01" });
    const summary = financeMonthlySummary(store, "2026-09");
    assert.equal(summary.expense, 0);
    assert.deepEqual(summary.categoryBreakdown, []);
  });

  test("跨币种记账：按人民币等值汇总，不会把不同货币的数字直接相加", () => {
    store.setExchangeRate("EUR", 8);
    store.setExchangeRate("USD", 7);
    store.addTransaction({ amount: 60, currency: "CNY", type: "expense", category: "餐饮", date: "2026-09-01" });
    store.addTransaction({ amount: 10, currency: "EUR", type: "expense", category: "餐饮", date: "2026-09-02" }); // = 80 CNY
    store.addTransaction({ amount: 20, currency: "USD", type: "income", category: "其他", date: "2026-09-03" }); // = 140 CNY

    const summary = financeMonthlySummary(store, "2026-09");
    assert.equal(summary.expense, 140); // 60 + 80
    assert.equal(summary.income, 140);
    assert.equal(summary.categoryBreakdown.find((c) => c.category === "餐饮").amount, 140);
  });

  test("传 accountId 时只汇总这一个账户的收支（多账户功能）", () => {
    const accountA = store.addAccount({ name: "账户A" });
    const accountB = store.addAccount({ name: "账户B" });
    store.addTransaction({ amount: 100, type: "expense", category: "餐饮", date: "2026-09-01", accountId: accountA.id });
    store.addTransaction({ amount: 50, type: "expense", category: "餐饮", date: "2026-09-02", accountId: accountB.id });

    const summaryA = financeMonthlySummary(store, "2026-09", accountA.id);
    assert.equal(summaryA.expense, 100);
    const summaryAll = financeMonthlySummary(store, "2026-09");
    assert.equal(summaryAll.expense, 150); // 不传 accountId 就是所有账户合计
  });
});

describe("lowStockAndExpiringItems", () => {
  test("低库存和临期分别识别，两者可以同时成立", () => {
    store.addInventoryItem({ name: "牛奶", quantity: 1, unit: "盒", lowThreshold: 1, expiryDate: "2026-09-19" });
    store.addInventoryItem({ name: "大米", quantity: 8, unit: "kg", lowThreshold: 2, expiryDate: null });

    const { lowStock, expiring } = lowStockAndExpiringItems(store, TODAY, 7);
    assert.equal(lowStock.length, 1);
    assert.equal(lowStock[0].name, "牛奶");
    assert.equal(expiring.length, 1);
    assert.equal(expiring[0].name, "牛奶");
  });
});

describe("linkCandidates（今日计划关联面板）", () => {
  test("候选项包含未完成作业和今天到期/已过期未处理的提醒，不包含已完成/已处理的", () => {
    const course = store.addCourse("微观经济学");
    store.addAssignment({ courseId: course.id, title: "未完成作业", dueDate: "2026-09-20" });
    store.addAssignment({ courseId: course.id, title: "已完成作业", dueDate: "2026-09-10", status: "已完成" });
    store.addReminder({ title: "今天的提醒", date: TODAY, repeat: "none" });
    store.addReminder({ title: "过期未处理", date: "2026-09-01", repeat: "none" });
    const doneReminder = store.addReminder({ title: "已处理", date: "2026-09-01", repeat: "none" });
    store.markReminderDone(doneReminder.id);
    store.addReminder({ title: "还没到期", date: "2026-10-01", repeat: "none" });

    const candidates = linkCandidates(store, TODAY);
    assert.deepEqual(candidates.assignments.map((a) => a.title), ["未完成作业"]);
    assert.deepEqual(
      candidates.reminders.map((r) => r.title).sort(),
      ["今天的提醒", "过期未处理"].sort()
    );
  });
});

describe("homeSummary", () => {
  test("汇总首页需要的各模块数据", () => {
    store.addTodayPlanItem({ text: "去超市买米", date: TODAY });
    const course = store.addCourse("微观经济学");
    store.addAssignment({ courseId: course.id, title: "第三章作业", dueDate: "2026-09-18" });
    store.addReminder({ title: "缴手机话费", date: TODAY, repeat: "none" });
    store.setMealEntry(TODAY, "lunch", "番茄炒蛋 · 米饭");
    store.addInventoryItem({ name: "纸巾", quantity: 1, unit: "包", lowThreshold: 3 });
    store.addTransaction({ amount: 58, type: "expense", category: "餐饮", date: TODAY });
    store.addGame({ name: "塞尔达传说", status: "在玩" });

    const summary = homeSummary(store, TODAY);
    assert.equal(summary.todayPlan.length, 1);
    assert.equal(summary.studyNearest.title, "第三章作业");
    assert.equal(summary.remindersToday.length, 1);
    assert.equal(summary.mealsToday.lunch, "番茄炒蛋 · 米饭");
    assert.equal(summary.mealsToday.dinner, "");
    assert.equal(summary.lowStockCount, 1);
    assert.equal(summary.finance.expense, 58);
    assert.equal(summary.gamesInProgress.length, 1);
  });

  test("首页摘要在任意模块改动数据后重新计算即可反映最新状态（不存在\"没同步\"，PRD验收标准11）", () => {
    const item = store.addInventoryItem({ name: "洗发水", quantity: 5, unit: "瓶", lowThreshold: 1 });
    assert.equal(homeSummary(store, TODAY).lowStockCount, 0);
    store.updateInventoryItem(item.id, { quantity: 1 });
    assert.equal(homeSummary(store, TODAY).lowStockCount, 1); // 重新调用即可拿到最新结果
  });
});

describe("studyFocusReport（今日学习报告：专注度/效率）", () => {
  const realNow = Date.now;
  let fakeNow;
  function mockNow(ms) { fakeNow = ms; Date.now = () => fakeNow; }
  function advance(ms) { fakeNow += ms; }

  beforeEach(() => { mockNow(1_700_000_000_000); });
  after(() => { Date.now = realNow; });

  test("完全没有计时记录时，专注度和效率都是 null，而不是 0", () => {
    store.addGoal("每天学法语30分钟");
    const report = studyFocusReport(store);
    assert.equal(report.focusScore, null);
    assert.equal(report.efficiency, null);
    assert.equal(report.totalMinutes, 0);
  });

  test("一口气学完（没有暂停、没有空档）：专注度满分，效率接近100", () => {
    const goal = store.addGoal("背单词");
    store.startGoalTimer(goal.id);
    advance(600_000); // 10分钟
    store.pauseGoalTimer(goal.id);

    const report = studyFocusReport(store);
    assert.equal(report.totalMinutes, 10);
    assert.equal(report.focusScore, 95); // 暂停了1次（点了"暂停"按钮结束这次计时），扣5分
    assert.equal(report.efficiency, 100); // 全程都在专注时间里，没有额外空档
  });

  test("同样学了10分钟，但中间断断续续拖了很久才做完：效率明显更低，专注度也更低", () => {
    const goal = store.addGoal("复习财务模型");
    store.startGoalTimer(goal.id);
    advance(300_000); // 专注5分钟
    store.pauseGoalTimer(goal.id);
    advance(3_600_000); // 中间隔了1小时才回来
    store.startGoalTimer(goal.id);
    advance(300_000); // 再专注5分钟
    store.pauseGoalTimer(goal.id);

    const report = studyFocusReport(store);
    assert.equal(report.totalMinutes, 10); // 专注时长总数一样
    assert.equal(report.focusScore, 90); // 暂停了2次
    assert.ok(report.efficiency < 20, `断断续续应该拉低效率，实际是 ${report.efficiency}`);
  });

  test("多个学习目标会汇总到一份报告里，goals 明细按目标分别列出", () => {
    const g1 = store.addGoal("法语");
    const g2 = store.addGoal("金融建模");
    store.startGoalTimer(g1.id);
    advance(120_000);
    store.pauseGoalTimer(g1.id);
    store.startGoalTimer(g2.id);
    advance(180_000);
    store.pauseGoalTimer(g2.id);

    const report = studyFocusReport(store);
    assert.equal(report.totalMinutes, 5);
    assert.equal(report.goals.length, 2);
    assert.deepEqual(report.goals.map((g) => g.name).sort(), ["法语", "金融建模"]);
  });
});
