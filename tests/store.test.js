const { test, describe, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const { createStore } = require("../js/store.js");
const { createMemoryStorage } = require("./helpers/memoryStorage.js");

let storage;
let store;

beforeEach(() => {
  storage = createMemoryStorage();
  store = createStore(storage);
  store.init();
});

describe("初始化与持久化", () => {
  test("init 在没有历史数据时写入默认空结构", () => {
    const state = store.getState();
    assert.deepEqual(state.quickNotes, []);
    assert.deepEqual(state.financeCategories, ["餐饮", "交通", "日用", "娱乐", "其他"]);
    assert.ok(storage.getItem("faner-app-data"));
  });

  test("修改数据后重新 init（模拟刷新页面）能读回同样的数据", () => {
    store.addQuickNote("记得买牛奶");
    const store2 = createStore(storage);
    store2.init();
    assert.equal(store2.listQuickNotes().length, 1);
    assert.equal(store2.listQuickNotes()[0].text, "记得买牛奶");
  });

  test("localStorage 里是损坏的 JSON 时，init 不崩溃，回退到默认结构", () => {
    storage.setItem("faner-app-data", "{not-json");
    const s = createStore(storage);
    const state = s.init();
    assert.deepEqual(state.quickNotes, []);
  });
});

describe("快速备忘", () => {
  test("添加和删除", () => {
    const note = store.addQuickNote("买洗发水");
    assert.equal(store.listQuickNotes().length, 1);
    store.removeQuickNote(note.id);
    assert.equal(store.listQuickNotes().length, 0);
  });
});

describe("今日计划与关联同步（PRD验收标准4）", () => {
  test("手动添加、勾选完成、删除", () => {
    const item = store.addTodayPlanItem({ text: "去超市买米", date: "2026-09-16" });
    assert.equal(store.listTodayPlan("2026-09-16")[0].effectiveDone, false);
    store.toggleTodayPlanDone(item.id);
    assert.equal(store.listTodayPlan("2026-09-16")[0].effectiveDone, true);
    store.removeTodayPlanItem(item.id);
    assert.equal(store.listTodayPlan("2026-09-16").length, 0);
  });

  test("关联学习任务作业后勾选完成，作业状态同步为已完成", () => {
    const course = store.addCourse("微观经济学");
    const assignment = store.addAssignment({ courseId: course.id, title: "第三章作业", dueDate: "2026-09-18" });
    const linked = store.linkAssignmentToToday(assignment.id, "2026-09-16");
    assert.equal(linked.source, "study");

    store.toggleTodayPlanDone(linked.id);

    const updatedAssignment = store.listAssignments(course.id)[0];
    assert.equal(updatedAssignment.status, "已完成");
  });

  test("重复关联同一条作业不会产生两条今日计划记录", () => {
    const course = store.addCourse("金融风险管理");
    const assignment = store.addAssignment({ courseId: course.id, title: "期末复习", dueDate: "2026-09-20" });
    store.linkAssignmentToToday(assignment.id, "2026-09-16");
    store.linkAssignmentToToday(assignment.id, "2026-09-16");
    assert.equal(store.listTodayPlan("2026-09-16").length, 1);
  });

  test("关联一次性提醒后勾选完成，提醒状态同步为已处理", () => {
    const reminder = store.addReminder({ title: "缴手机话费", date: "2026-09-16", repeat: "none" });
    const linked = store.linkReminderToToday(reminder.id, "2026-09-16");

    store.toggleTodayPlanDone(linked.id);

    const updated = store.listReminders().find((r) => r.id === reminder.id);
    assert.equal(updated.status, "done");
  });

  test("反向同步：直接在学习任务模块把作业标记完成后，今日计划里关联项显示为完成（不需要用户在今日计划再点一次）", () => {
    const course = store.addCourse("供应链管理");
    const assignment = store.addAssignment({ courseId: course.id, title: "小组报告", dueDate: "2026-09-25" });
    const linked = store.linkAssignmentToToday(assignment.id, "2026-09-16");

    // 不在今日计划里操作，而是直接在学习任务模块改状态
    store.updateAssignment(assignment.id, { status: "已完成" });

    const todayItem = store.listTodayPlan("2026-09-16").find((t) => t.id === linked.id);
    assert.equal(todayItem.effectiveDone, true);
    assert.equal(todayItem.done, false); // 本地字段没变，是通过源记录状态推导出的显示态
  });

  test("周期性提醒关联进今日计划勾选完成，不影响提醒本身（周期性提醒没有完成状态）", () => {
    const reminder = store.addReminder({ title: "房租转账", date: "2026-09-01", repeat: "monthly" });
    const linked = store.linkReminderToToday(reminder.id, "2026-09-16");
    store.toggleTodayPlanDone(linked.id);
    const updated = store.listReminders().find((r) => r.id === reminder.id);
    assert.equal(updated.status, "pending"); // 周期性提醒不会被改成 done
    assert.equal(store.listTodayPlan("2026-09-16")[0].effectiveDone, true); // 但今日计划这一条本身已勾选完成
  });

  test("新增字段：预计用时/优先度/备注 能正常保存，优先度非法值回退为默认的'中'", () => {
    const item = store.addTodayPlanItem({
      text: "写论文大纲", date: "2026-09-16", estimatedMinutes: "45", priority: "高", note: "先列提纲",
    });
    assert.equal(item.estimatedMinutes, 45);
    assert.equal(item.priority, "高");
    assert.equal(item.note, "先列提纲");

    const bad = store.addTodayPlanItem({ text: "乱填优先度", date: "2026-09-16", priority: "特急" });
    assert.equal(bad.priority, "中");

    const noEstimate = store.addTodayPlanItem({ text: "没填预计用时", date: "2026-09-16" });
    assert.equal(noEstimate.estimatedMinutes, null);
    assert.equal(noEstimate.priority, "中");
  });

  test("updateTodayPlanItem 能修改日期/时间/预计用时/优先度/备注，且不影响完成状态", () => {
    const item = store.addTodayPlanItem({ text: "复习财务", date: "2026-09-16", priority: "中" });
    const updated = store.updateTodayPlanItem(item.id, {
      date: "2026-09-17", time: "14:00", estimatedMinutes: 60, priority: "低", note: "带上笔记本",
    });
    assert.equal(updated.date, "2026-09-17");
    assert.equal(updated.time, "14:00");
    assert.equal(updated.estimatedMinutes, 60);
    assert.equal(updated.priority, "低");
    assert.equal(updated.note, "带上笔记本");
    // 改到了17号之后，16号的列表里不应该再有它
    assert.equal(store.listTodayPlan("2026-09-16").length, 0);
    assert.equal(store.listTodayPlan("2026-09-17").length, 1);
  });

  test("updateTodayPlanItem 对不存在的id返回null", () => {
    assert.equal(store.updateTodayPlanItem("not-exist-id", { text: "x" }), null);
  });

  test("listTodayPlanRange 按日期+时间排序返回一个区间内的所有条目（供首页本周/历史视图使用）", () => {
    store.addTodayPlanItem({ text: "周一的事", date: "2026-09-14", time: "09:00" });
    store.addTodayPlanItem({ text: "周三下午", date: "2026-09-16", time: "15:00" });
    store.addTodayPlanItem({ text: "周三上午", date: "2026-09-16", time: "08:00" });
    store.addTodayPlanItem({ text: "区间外", date: "2026-09-01" });

    const range = store.listTodayPlanRange("2026-09-14", "2026-09-20");
    assert.deepEqual(range.map((t) => t.text), ["周一的事", "周三上午", "周三下午"]);
  });
});

describe("今日计划：计时器（开始/暂停/完成）", () => {
  const realNow = Date.now;
  let fakeNow;
  function mockNow(ms) { fakeNow = ms; Date.now = () => fakeNow; }
  function advance(ms) { fakeNow += ms; }

  beforeEach(() => { mockNow(1_700_000_000_000); });
  after(() => { Date.now = realNow; }); // 恢复真实的 Date.now，避免影响这个文件里其它的测试

  test("开始计时后暂停，elapsedSeconds 按经过的时间累计", () => {
    const item = store.addTodayPlanItem({ text: "写论文", date: "2026-09-16", estimatedMinutes: 30 });
    const started = store.startTodayPlanTimer(item.id);
    assert.ok(started.timerStartedAt);

    advance(65_000); // 过了65秒
    const paused = store.pauseTodayPlanTimer(item.id);
    assert.equal(paused.timerStartedAt, null);
    assert.equal(paused.elapsedSeconds, 65);
  });

  test("多次开始/暂停会累加，不会覆盖之前的用时", () => {
    const item = store.addTodayPlanItem({ text: "复习", date: "2026-09-16" });
    store.startTodayPlanTimer(item.id);
    advance(30_000);
    store.pauseTodayPlanTimer(item.id);
    store.startTodayPlanTimer(item.id);
    advance(40_000);
    const paused = store.pauseTodayPlanTimer(item.id);
    assert.equal(paused.elapsedSeconds, 70);
  });

  test("对不存在的id调用计时函数返回null，不抛错", () => {
    assert.equal(store.startTodayPlanTimer("nope"), null);
    assert.equal(store.pauseTodayPlanTimer("nope"), null);
    assert.equal(store.finishTodayPlanItem("nope"), null);
  });

  test("finishTodayPlanItem：计时中直接点完成，会先累计用时再标记完成，且和学习任务的联动同样生效", () => {
    const course = store.addCourse("宏观经济学");
    const assignment = store.addAssignment({ courseId: course.id, title: "第五章作业", dueDate: "2026-09-20" });
    const linked = store.linkAssignmentToToday(assignment.id, "2026-09-16");

    store.startTodayPlanTimer(linked.id);
    advance(120_000); // 2分钟

    const finished = store.finishTodayPlanItem(linked.id);
    assert.equal(finished.elapsedSeconds, 120);
    assert.equal(finished.timerStartedAt, null);
    assert.equal(finished.effectiveDone, true);

    const updatedAssignment = store.listAssignments(course.id)[0];
    assert.equal(updatedAssignment.status, "已完成"); // 联动没有被计时功能破坏

    // 再点一次完成应该是幂等的，不会报错，也不会重复叠加副作用
    const finishedAgain = store.finishTodayPlanItem(linked.id);
    assert.equal(finishedAgain.effectiveDone, true);
  });

  test("已经暂停的情况下点完成，不会再多算时间", () => {
    const item = store.addTodayPlanItem({ text: "看书", date: "2026-09-16" });
    store.startTodayPlanTimer(item.id);
    advance(50_000);
    store.pauseTodayPlanTimer(item.id);
    advance(999_000); // 暂停之后过了很久，不应该被算进去
    const finished = store.finishTodayPlanItem(item.id);
    assert.equal(finished.elapsedSeconds, 50);
  });

  test("setTodayPlanSatisfaction 保存1-5星满意度，超出范围会被夹到1-5之间，传null可以清除", () => {
    const item = store.addTodayPlanItem({ text: "写周报", date: "2026-09-16" });
    assert.equal(store.listTodayPlan("2026-09-16")[0].satisfaction, null); // 默认没有评分

    let updated = store.setTodayPlanSatisfaction(item.id, 4);
    assert.equal(updated.satisfaction, 4);

    updated = store.setTodayPlanSatisfaction(item.id, 9); // 超出范围夹到5
    assert.equal(updated.satisfaction, 5);

    updated = store.setTodayPlanSatisfaction(item.id, 0); // 低于1夹到1
    assert.equal(updated.satisfaction, 1);

    updated = store.setTodayPlanSatisfaction(item.id, null);
    assert.equal(updated.satisfaction, null);
  });

  test("对不存在的id调用setTodayPlanSatisfaction返回null", () => {
    assert.equal(store.setTodayPlanSatisfaction("nope", 5), null);
  });
});

describe("学习任务：课程与作业", () => {
  test("最近到期列表按截止日期跨课程排序，且排除已完成", () => {
    const c1 = store.addCourse("微观经济学");
    const c2 = store.addCourse("金融风险管理");
    store.addAssignment({ courseId: c1.id, title: "作业A", dueDate: "2026-09-20" });
    store.addAssignment({ courseId: c2.id, title: "考试B", dueDate: "2026-09-18", type: "考试" });
    const done = store.addAssignment({ courseId: c1.id, title: "已完成的", dueDate: "2026-09-10", status: "已完成" });

    const upcoming = store.listUpcomingAssignments(10);
    assert.deepEqual(upcoming.map((a) => a.title), ["考试B", "作业A"]);
    assert.ok(!upcoming.some((a) => a.id === done.id));
  });

  test("删除课程会级联删除该课程下的作业", () => {
    const course = store.addCourse("测试课程");
    store.addAssignment({ courseId: course.id, title: "作业", dueDate: "2026-09-20" });
    store.removeCourse(course.id);
    assert.equal(store.listAssignments(course.id).length, 0);
  });
});

describe("学习任务：学习目标打卡", () => {
  test("同一目标同一天只记一次打卡", () => {
    const goal = store.addGoal("每天学法语30分钟");
    store.checkinGoal(goal.id, "2026-09-16");
    store.checkinGoal(goal.id, "2026-09-16");
    assert.equal(store.countCheckins(goal.id), 1);
    store.checkinGoal(goal.id, "2026-09-17");
    assert.equal(store.countCheckins(goal.id), 2);
  });

  test("当日学习记录同一天保存是覆盖而不是新增", () => {
    store.setDailyLog("2026-09-16", "复习了金融风险管理");
    store.setDailyLog("2026-09-16", "复习了金融风险管理 + 法语听力");
    assert.equal(store.getDailyLog("2026-09-16"), "复习了金融风险管理 + 法语听力");
  });
});

describe("学习任务：学习目标计时（专注度/效率统计的数据来源）", () => {
  const realNow = Date.now;
  let fakeNow;
  function mockNow(ms) { fakeNow = ms; Date.now = () => fakeNow; }
  function advance(ms) { fakeNow += ms; }

  beforeEach(() => { mockNow(1_700_000_000_000); });
  after(() => { Date.now = realNow; });

  test("开始/暂停会累计 elapsedSeconds 并记一次 pauseCount", () => {
    const goal = store.addGoal("每天学法语30分钟");
    store.startGoalTimer(goal.id);
    advance(60_000);
    const paused = store.pauseGoalTimer(goal.id);
    assert.equal(paused.timerStartedAt, null);

    const [focus] = store.listGoalsWithTodayFocus();
    assert.equal(focus.elapsedSeconds, 60);
    assert.equal(focus.pauseCount, 1);
  });

  test("对不存在的id调用计时函数返回null", () => {
    assert.equal(store.startGoalTimer("nope"), null);
    assert.equal(store.pauseGoalTimer("nope"), null);
  });

  test("listGoalsWithTodayFocus 在计时器还在跑的时候，会把正在跑的这一段也实时算进去", () => {
    const goal = store.addGoal("背单词");
    store.startGoalTimer(goal.id);
    advance(45_000);
    const [focus] = store.listGoalsWithTodayFocus();
    assert.equal(focus.elapsedSeconds, 45);
    assert.equal(focus.running, true);
  });
});

describe("学习任务：学习时长可视化统计图表（开发计划第一版暂缓功能之一）", () => {
  const realNow = Date.now;
  let fakeNow;
  function mockNow(ms) { fakeNow = ms; Date.now = () => fakeNow; }
  function advance(ms) { fakeNow += ms; }

  beforeEach(() => { mockNow(1_700_000_000_000); });
  after(() => { Date.now = realNow; });

  test("暂停计时后，这一段用时会被记进 listStudyTimeSeries 里对应那一天", () => {
    const goal = store.addGoal("每天学法语30分钟");
    store.startGoalTimer(goal.id, "2026-09-16");
    advance(90_000); // 90秒
    store.pauseGoalTimer(goal.id, "2026-09-16");

    const series = store.listStudyTimeSeries(3, "2026-09-16");
    assert.equal(series.length, 3);
    assert.equal(series[2].date, "2026-09-16"); // 最后一项是参考日期当天
    assert.equal(series[2].totalSeconds, 90);
    assert.equal(series[2].byGoal.length, 1);
    assert.equal(series[2].byGoal[0].name, "每天学法语30分钟");
    assert.equal(series[2].byGoal[0].seconds, 90);
    // 前面没有记录的日子应该是 0，而不是缺失或报错
    assert.equal(series[0].totalSeconds, 0);
    assert.deepEqual(series[0].byGoal, []);
  });

  test("同一天多次开始/暂停会累加，不会互相覆盖", () => {
    const goal = store.addGoal("背单词");
    store.startGoalTimer(goal.id, "2026-09-16");
    advance(30_000);
    store.pauseGoalTimer(goal.id, "2026-09-16");
    store.startGoalTimer(goal.id, "2026-09-16");
    advance(20_000);
    store.pauseGoalTimer(goal.id, "2026-09-16");

    const [today] = store.listStudyTimeSeries(1, "2026-09-16");
    assert.equal(today.totalSeconds, 50);
  });

  test("多个目标同一天都学习过，按目标拆分明细，总时长是各目标之和", () => {
    const g1 = store.addGoal("法语");
    const g2 = store.addGoal("日语");
    store.startGoalTimer(g1.id, "2026-09-16");
    advance(40_000);
    store.pauseGoalTimer(g1.id, "2026-09-16");
    store.startGoalTimer(g2.id, "2026-09-16");
    advance(25_000);
    store.pauseGoalTimer(g2.id, "2026-09-16");

    const [today] = store.listStudyTimeSeries(1, "2026-09-16");
    assert.equal(today.totalSeconds, 65);
    assert.equal(today.byGoal.length, 2);
    const names = today.byGoal.map((b) => b.name).sort();
    assert.deepEqual(names, ["日语", "法语"]);
  });

  test("没有开始过就暂停，不会产生任何学习时长记录（避免脏数据）", () => {
    const goal = store.addGoal("从没开始过的目标");
    store.pauseGoalTimer(goal.id, "2026-09-16");
    const [today] = store.listStudyTimeSeries(1, "2026-09-16");
    assert.equal(today.totalSeconds, 0);
  });

  test("不同天的学习记录互不影响，按天分别累计", () => {
    const goal = store.addGoal("阅读");
    store.startGoalTimer(goal.id, "2026-09-14");
    advance(60_000);
    store.pauseGoalTimer(goal.id, "2026-09-14");
    store.startGoalTimer(goal.id, "2026-09-16");
    advance(120_000);
    store.pauseGoalTimer(goal.id, "2026-09-16");

    const series = store.listStudyTimeSeries(3, "2026-09-16"); // 09-14, 09-15, 09-16
    assert.equal(series[0].date, "2026-09-14");
    assert.equal(series[0].totalSeconds, 60);
    assert.equal(series[1].totalSeconds, 0);
    assert.equal(series[2].totalSeconds, 120);
  });

  test("目标被删除后，历史学习时长记录仍然保留（不因为删除目标而丢失统计数据），只是显示为已删除", () => {
    const goal = store.addGoal("临时目标");
    store.startGoalTimer(goal.id, "2026-09-16");
    advance(30_000);
    store.pauseGoalTimer(goal.id, "2026-09-16");
    store.removeGoal(goal.id);

    const [today] = store.listStudyTimeSeries(1, "2026-09-16");
    assert.equal(today.totalSeconds, 30);
    assert.equal(today.byGoal[0].name, "（已删除的目标）");
  });
});

describe("提醒事项（PRD验收标准5）", () => {
  test("一次性提醒标记已处理", () => {
    const r = store.addReminder({ title: "护照续签预约", date: "2026-09-16", repeat: "none" });
    assert.equal(store.listReminders()[0].status, "pending");
    store.markReminderDone(r.id);
    assert.equal(store.listReminders()[0].status, "done");
  });

  test("周期性提醒不能被标记已处理", () => {
    const r = store.addReminder({ title: "每月缴费", date: "2026-09-16", repeat: "monthly" });
    const result = store.markReminderDone(r.id);
    assert.equal(result, null);
    assert.equal(store.listReminders()[0].status, "pending");
  });

  test("每月重复提醒的下一次日期，比参考日期晚一个月内", () => {
    store.addReminder({ title: "缴手机话费", date: "2026-09-16", repeat: "monthly" });
    const [withNextDate] = store.listRemindersWithNextDate("2026-09-16");
    assert.equal(withNextDate.nextDate, "2026-09-16");
    const [afterAMonth] = store.listRemindersWithNextDate("2026-09-17");
    assert.equal(afterAMonth.nextDate, "2026-10-16");
  });
});

describe("饮食计划（PRD验收标准9）", () => {
  test("填写和读取某天某餐", () => {
    store.setMealEntry("2026-09-16", "lunch", "番茄炒蛋 · 米饭");
    assert.equal(store.getMealEntry("2026-09-16", "lunch"), "番茄炒蛋 · 米饭");
    assert.equal(store.getMealEntry("2026-09-16", "dinner"), "");
  });

  test("复制上周计划：本周内容与上周一致，且互不影响", () => {
    store.setMealEntry("2026-09-07", "breakfast", "豆浆油条"); // 上周一
    store.setMealEntry("2026-09-08", "lunch", "牛肉面");
    const copiedCount = store.copyWeek("2026-09-07", "2026-09-14"); // 复制到本周一
    assert.equal(copiedCount, 2);
    assert.equal(store.getMealEntry("2026-09-14", "breakfast"), "豆浆油条");
    assert.equal(store.getMealEntry("2026-09-15", "lunch"), "牛肉面");

    // 修改本周不影响上周
    store.setMealEntry("2026-09-14", "breakfast", "牛奶麦片");
    assert.equal(store.getMealEntry("2026-09-07", "breakfast"), "豆浆油条");
  });
});

describe("生活用品库存管理（PRD验收标准6）", () => {
  test("数量低于阈值自动进入购物清单", () => {
    const item = store.addInventoryItem({ name: "纸巾", quantity: 2, unit: "包", lowThreshold: 3 });
    assert.equal(store.isLowStock(item), true);
    const shopping = store.listShoppingItems();
    assert.equal(shopping.length, 1);
    assert.equal(shopping[0].linkedItemId, item.id);
  });

  test("数量充足不会进入购物清单；改到低于阈值后自动补上，且不重复", () => {
    const item = store.addInventoryItem({ name: "大米", quantity: 8, unit: "kg", lowThreshold: 2 });
    assert.equal(store.listShoppingItems().length, 0);
    store.updateInventoryItem(item.id, { quantity: 1 });
    assert.equal(store.listShoppingItems().length, 1);
    store.updateInventoryItem(item.id, { quantity: 0.5 });
    assert.equal(store.listShoppingItems().length, 1); // 不重复添加
  });

  test("购物清单勾除（删除）不影响库存数量", () => {
    const item = store.addInventoryItem({ name: "洗发水", quantity: 1, unit: "瓶", lowThreshold: 1 });
    const [shoppingEntry] = store.listShoppingItems();
    store.removeShoppingItem(shoppingEntry.id);
    assert.equal(store.listShoppingItems().length, 0);
    assert.equal(store.listInventoryItems().find((i) => i.id === item.id).quantity, 1); // 数量不变
  });

  test("删除物品会同时清掉购物清单里对应的联动条目", () => {
    const item = store.addInventoryItem({ name: "洗衣液", quantity: 0, unit: "瓶", lowThreshold: 1 });
    assert.equal(store.listShoppingItems().length, 1);
    store.removeInventoryItem(item.id);
    assert.equal(store.listShoppingItems().length, 0);
  });
});

describe("个人记账（PRD验收标准7）", () => {
  test("按月过滤流水，月度收支结余计算准确", () => {
    store.addTransaction({ amount: 58, type: "expense", category: "餐饮", date: "2026-09-16" });
    store.addTransaction({ amount: 60, type: "expense", category: "交通", date: "2026-09-15" });
    store.addTransaction({ amount: 3000, type: "income", category: "其他", date: "2026-09-01" });
    store.addTransaction({ amount: 100, type: "expense", category: "餐饮", date: "2026-08-20" }); // 上个月，不应计入

    const septTx = store.listTransactions({ month: "2026-09" });
    assert.equal(septTx.length, 3);

    const income = septTx.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
    const expense = septTx.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
    assert.equal(income, 3000);
    assert.equal(expense, 118);
    assert.equal(income - expense, 2882);
  });

  test("自定义分类的增删", () => {
    store.addCategory("学习用品");
    assert.ok(store.listCategories().includes("学习用品"));
    store.addCategory("学习用品"); // 重复添加不产生重复项
    assert.equal(store.listCategories().filter((c) => c === "学习用品").length, 1);
    store.removeCategory("学习用品");
    assert.ok(!store.listCategories().includes("学习用品"));
  });
});

describe("个人记账：多币种 + 汇率换算", () => {
  test("默认汇率表：人民币记录 amountCNY 就等于原金额", () => {
    const t = store.addTransaction({ amount: 100, type: "expense", category: "餐饮", date: "2026-09-16" });
    assert.equal(t.currency, "CNY");
    assert.equal(t.amountCNY, 100);
  });

  test("按当前汇率把外币记录换算成人民币等值", () => {
    store.setExchangeRate("EUR", 8);
    const t = store.addTransaction({ amount: 50, currency: "EUR", type: "expense", category: "餐饮", date: "2026-09-16" });
    assert.equal(t.currency, "EUR");
    assert.equal(t.amountCNY, 400); // 50 * 8
  });

  test("改汇率不会影响已经记过的账（只影响之后新记的）", () => {
    store.setExchangeRate("USD", 7);
    const t1 = store.addTransaction({ amount: 10, currency: "USD", type: "expense", category: "其他", date: "2026-09-16" });
    assert.equal(t1.amountCNY, 70);
    store.setExchangeRate("USD", 7.5);
    assert.equal(store.listTransactions().find((t) => t.id === t1.id).amountCNY, 70); // 老记录不变
    const t2 = store.addTransaction({ amount: 10, currency: "USD", type: "expense", category: "其他", date: "2026-09-16" });
    assert.equal(t2.amountCNY, 75); // 新记录按新汇率
  });

  test("汇率必须是正数，非法值不生效；人民币自己的汇率不能被改", () => {
    const before = store.getExchangeRates();
    store.setExchangeRate("EUR", -5);
    store.setExchangeRate("EUR", "abc");
    assert.equal(store.getExchangeRates().EUR, before.EUR);
    store.setExchangeRate("CNY", 2);
    assert.equal(store.getExchangeRates().CNY, 1);
  });

  test("编辑一笔记录：改金额/币种后，人民币等值重新计算", () => {
    const t = store.addTransaction({ amount: 100, type: "expense", category: "餐饮", date: "2026-09-16" });
    const updated = store.updateTransaction(t.id, { amount: 20, currency: "EUR" });
    assert.equal(updated.amount, 20);
    assert.equal(updated.currency, "EUR");
    assert.equal(updated.amountCNY, 20 * store.getExchangeRates().EUR);
  });

  test("编辑不存在的记录返回 null", () => {
    assert.equal(store.updateTransaction("no-such-id", { amount: 1 }), null);
  });
});

describe("游戏娱乐（PRD验收标准8）", () => {
  test("多次游玩时长累加，等于各次之和", () => {
    const game = store.addGame({ name: "塞尔达传说", status: "在玩" });
    store.addPlaySession({ gameId: game.id, date: "2026-09-14", minutes: 120 });
    store.addPlaySession({ gameId: game.id, date: "2026-09-15", minutes: 45 });
    assert.equal(store.totalMinutesForGame(game.id), 165);
  });

  test("按状态筛选游戏列表", () => {
    store.addGame({ name: "星露谷物语", status: "想玩" });
    store.addGame({ name: "艾尔登法环", status: "已通关" });
    assert.equal(store.listGames("想玩").length, 1);
    assert.equal(store.listGames().length, 2);
  });

  test("删除游戏会级联删除它的游玩记录", () => {
    const game = store.addGame({ name: "只是测试", status: "想玩" });
    store.addPlaySession({ gameId: game.id, date: "2026-09-14", minutes: 30 });
    store.removeGame(game.id);
    assert.equal(store.listSessions(game.id).length, 0);
  });
});

describe("数据与设置：备份 / 恢复 / 清空（PRD验收标准10）", () => {
  test("导出后再导入，能完整恢复数据，包括今日计划关联关系和提醒锚点", () => {
    const course = store.addCourse("微观经济学");
    const assignment = store.addAssignment({ courseId: course.id, title: "第三章作业", dueDate: "2026-09-18" });
    store.linkAssignmentToToday(assignment.id, "2026-09-16");
    store.addReminder({ title: "每月缴费", date: "2026-09-16", repeat: "monthly" });
    store.addInventoryItem({ name: "纸巾", quantity: 1, unit: "包", lowThreshold: 3 });

    const backupJson = store.exportBackup();

    store.resetAll();
    assert.equal(store.listCourses().length, 0);

    store.importBackup(backupJson);
    assert.equal(store.listCourses().length, 1);
    assert.equal(store.listTodayPlan("2026-09-16")[0].sourceId, assignment.id);
    assert.equal(store.listReminders()[0].repeat, "monthly");
    assert.equal(store.listShoppingItems().length, 1); // 库存联动关系也恢复了
  });

  test("导入格式不正确的备份会抛出明确错误，不破坏现有数据", () => {
    store.addQuickNote("不应该丢失");
    assert.throws(() => store.importBackup("不是JSON"));
    assert.throws(() => store.importBackup(JSON.stringify({ foo: "bar" })));
    assert.throws(() => store.importBackup(JSON.stringify({ schemaVersion: 1, data: { onlyOneField: [] } })));
    assert.equal(store.listQuickNotes().length, 1); // 现有数据没被破坏
  });

  test("清空全部数据后恢复到初始空状态", () => {
    store.addQuickNote("测试");
    store.addGame({ name: "测试游戏" });
    store.resetAll();
    assert.equal(store.listQuickNotes().length, 0);
    assert.equal(store.listGames().length, 0);
    assert.deepEqual(store.listCategories(), ["餐饮", "交通", "日用", "娱乐", "其他"]);
  });
});

describe("设置：首页摘要卡片显示开关", () => {
  test("默认全部开启，可单独关闭", () => {
    assert.equal(store.getSettings().homeCards.inventory, true);
    store.updateHomeCardVisibility("inventory", false);
    assert.equal(store.getSettings().homeCards.inventory, false);
    assert.equal(store.getSettings().homeCards.finance, true); // 其他开关不受影响
  });
});

describe("设置：手动保存", () => {
  test("默认还没有手动保存过；调用后记录下保存时间", () => {
    assert.equal(store.getSettings().lastManualSaveAt, null);
    const before = Date.now();
    const ts = store.manualSave();
    assert.ok(ts);
    assert.equal(store.getSettings().lastManualSaveAt, ts);
    assert.ok(new Date(ts).getTime() >= before);
  });

  test("手动保存不影响其他数据（只是再存一次 + 记录时间）", () => {
    store.addQuickNote("测试备忘");
    store.manualSave();
    assert.equal(store.listQuickNotes().length, 1);
    assert.equal(store.listQuickNotes()[0].text, "测试备忘");
  });
});

describe("今日计划：昨天未完成事项自动滚动到今天", () => {
  test("过去日期、未完成的手动事项会被滚动到参考日期，并记下原始日期", () => {
    const item = store.addTodayPlanItem({ text: "写周报", date: "2026-09-14" });
    const count = store.rolloverUnfinishedTodayPlan("2026-09-16");
    assert.equal(count, 1);
    const rolled = store.listTodayPlan("2026-09-16").find((t) => t.id === item.id);
    assert.ok(rolled, "应该出现在参考日期这一天");
    assert.equal(rolled.rolledFrom, "2026-09-14");
    assert.equal(store.listTodayPlan("2026-09-14").length, 0, "原来的日期下不应该还留着");
  });

  test("已完成的过去事项不会被滚动，留在原来的日期", () => {
    const item = store.addTodayPlanItem({ text: "交房租", date: "2026-09-10" });
    store.toggleTodayPlanDone(item.id);
    const count = store.rolloverUnfinishedTodayPlan("2026-09-16");
    assert.equal(count, 0);
    assert.equal(store.listTodayPlan("2026-09-10").length, 1);
    assert.equal(store.listTodayPlan("2026-09-16").length, 0);
  });

  test("关联的学习任务/提醒已经通过源记录完成的，不会被滚动", () => {
    const course = store.addCourse("统计学");
    const assignment = store.addAssignment({ courseId: course.id, title: "作业一", dueDate: "2026-09-12" });
    const linked = store.linkAssignmentToToday(assignment.id, "2026-09-10");
    store.updateAssignment(assignment.id, { status: "已完成" }); // 通过源记录标记完成，不是 today-plan 自己的 done 字段

    const count = store.rolloverUnfinishedTodayPlan("2026-09-16");
    assert.equal(count, 0);
    const stillThere = store.listTodayPlan("2026-09-10").find((t) => t.id === linked.id);
    assert.ok(stillThere, "源记录已完成的事项应该留在原来的日期");
  });

  test("今天及以后日期的事项不受影响", () => {
    const item = store.addTodayPlanItem({ text: "今天的任务", date: "2026-09-16" });
    const future = store.addTodayPlanItem({ text: "以后的任务", date: "2026-09-20" });
    const count = store.rolloverUnfinishedTodayPlan("2026-09-16");
    assert.equal(count, 0);
    assert.equal(store.listTodayPlan("2026-09-16").find((t) => t.id === item.id).rolledFrom, null);
    assert.equal(store.listTodayPlan("2026-09-20").find((t) => t.id === future.id).rolledFrom, null);
  });

  test("连续多天没打开，多次滚动只保留最早一次的原始日期", () => {
    const item = store.addTodayPlanItem({ text: "还没做的事", date: "2026-09-10" });
    store.rolloverUnfinishedTodayPlan("2026-09-12"); // 第一次滚动：09-10 -> 09-12
    store.rolloverUnfinishedTodayPlan("2026-09-16"); // 第二次滚动：09-12 -> 09-16
    const rolled = store.listTodayPlan("2026-09-16").find((t) => t.id === item.id);
    assert.equal(rolled.rolledFrom, "2026-09-10", "rolledFrom 应该一直是最早那次，不会被后面的滚动覆盖");
  });

  test("store.init() 加载已有数据时会自动触发一次滚动", () => {
    store.addTodayPlanItem({ text: "过期事项", date: "2020-01-01" });

    const store2 = createStore(storage);
    const state2 = store2.init();
    const item2 = state2.todayPlan[0];
    assert.notEqual(item2.date, "2020-01-01", "重新 init 后应该已经被自动滚动到今天");
    assert.equal(item2.rolledFrom, "2020-01-01");
  });

  test("没有过期未完成事项时，滚动次数为 0，不会误伤其它数据", () => {
    store.addTodayPlanItem({ text: "今天的事", date: "2026-09-16" });
    const count = store.rolloverUnfinishedTodayPlan("2026-09-16");
    assert.equal(count, 0);
    assert.equal(store.listTodayPlan("2026-09-16").length, 1);
  });
});
