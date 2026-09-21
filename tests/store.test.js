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

describe("饮食计划：常用菜谱库 + 自动生成购物清单（开发计划第一版暂缓功能之一）", () => {
  test("添加、编辑、删除菜谱", () => {
    const recipe = store.addRecipe({ name: "番茄炒蛋", ingredients: [
      { name: "番茄", quantity: 2, unit: "个" },
      { name: "鸡蛋", quantity: 3, unit: "个" },
    ] });
    assert.equal(store.listRecipes().length, 1);
    assert.equal(store.findRecipe(recipe.id).ingredients.length, 2);

    store.updateRecipe(recipe.id, { name: "西红柿炒蛋" });
    assert.equal(store.findRecipe(recipe.id).name, "西红柿炒蛋");

    store.removeRecipe(recipe.id);
    assert.equal(store.listRecipes().length, 0);
  });

  test("把某一餐设置成菜谱库里的菜，会同时填好文字和菜谱关联", () => {
    const recipe = store.addRecipe({ name: "红烧肉", ingredients: [{ name: "五花肉", quantity: 500, unit: "克" }] });
    store.setMealEntryFromRecipe("2026-09-16", "dinner", recipe.id);
    assert.equal(store.getMealEntry("2026-09-16", "dinner"), "红烧肉");
    assert.equal(store.getMealEntryRecord("2026-09-16", "dinner").recipeId, recipe.id);
  });

  test("手动重新填写文字会清掉原来的菜谱关联", () => {
    const recipe = store.addRecipe({ name: "红烧肉", ingredients: [{ name: "五花肉", quantity: 500, unit: "克" }] });
    store.setMealEntryFromRecipe("2026-09-16", "dinner", recipe.id);
    store.setMealEntry("2026-09-16", "dinner", "点外卖");
    assert.equal(store.getMealEntryRecord("2026-09-16", "dinner").recipeId, null);
    assert.equal(store.getMealEntry("2026-09-16", "dinner"), "点外卖");
  });

  test("删除菜谱后，已经排进计划里的格子文字还在，只是不再关联菜谱", () => {
    const recipe = store.addRecipe({ name: "红烧肉", ingredients: [] });
    store.setMealEntryFromRecipe("2026-09-16", "dinner", recipe.id);
    store.removeRecipe(recipe.id);
    const record = store.getMealEntryRecord("2026-09-16", "dinner");
    assert.equal(record.text, "红烧肉");
    assert.equal(record.recipeId, null);
  });

  test("根据本周计划自动生成购物清单：汇总食材，同名同单位自动合并数量", () => {
    const tomato = store.addRecipe({ name: "番茄炒蛋", ingredients: [
      { name: "番茄", quantity: 2, unit: "个" }, { name: "鸡蛋", quantity: 3, unit: "个" },
    ] });
    const soup = store.addRecipe({ name: "番茄蛋汤", ingredients: [
      { name: "番茄", quantity: 1, unit: "个" }, { name: "鸡蛋", quantity: 1, unit: "个" },
    ] });
    store.setMealEntryFromRecipe("2026-09-14", "lunch", tomato.id); // 周一
    store.setMealEntryFromRecipe("2026-09-15", "dinner", soup.id); // 周二

    const addedCount = store.generateShoppingListFromMealPlan("2026-09-14");
    assert.equal(addedCount, 2); // 番茄、鸡蛋 两种食材

    const items = store.listShoppingItems();
    const tomatoItem = items.find((i) => i.name === "番茄");
    const eggItem = items.find((i) => i.name === "鸡蛋");
    assert.equal(tomatoItem.quantity, 3); // 2 + 1
    assert.equal(eggItem.quantity, 4); // 3 + 1
    assert.equal(tomatoItem.fromRecipe, true);
  });

  test("再次生成购物清单不会产生重复条目（同名同单位已存在就跳过）", () => {
    const recipe = store.addRecipe({ name: "番茄炒蛋", ingredients: [{ name: "番茄", quantity: 2, unit: "个" }] });
    store.setMealEntryFromRecipe("2026-09-14", "lunch", recipe.id);
    store.generateShoppingListFromMealPlan("2026-09-14");
    const countAfterFirst = store.listShoppingItems().length;
    store.generateShoppingListFromMealPlan("2026-09-14");
    assert.equal(store.listShoppingItems().length, countAfterFirst);
  });

  test("食材数量缺失时（没填数量），合并结果不确定数量就显示为空，而不是错误的具体数字", () => {
    const r1 = store.addRecipe({ name: "菜A", ingredients: [{ name: "盐", quantity: null, unit: "" }] });
    const r2 = store.addRecipe({ name: "菜B", ingredients: [{ name: "盐", quantity: 5, unit: "" }] });
    store.setMealEntryFromRecipe("2026-09-14", "lunch", r1.id);
    store.setMealEntryFromRecipe("2026-09-14", "dinner", r2.id);
    store.generateShoppingListFromMealPlan("2026-09-14");
    const salt = store.listShoppingItems().find((i) => i.name === "盐");
    assert.equal(salt.quantity, null);
  });

  test("手动填写文字的餐（没有关联菜谱）不会被计入自动生成的购物清单", () => {
    store.setMealEntry("2026-09-14", "breakfast", "豆浆油条"); // 纯手动文字，没有菜谱
    const addedCount = store.generateShoppingListFromMealPlan("2026-09-14");
    assert.equal(addedCount, 0);
    assert.equal(store.listShoppingItems().length, 0);
  });

  test("复制上周计划也会把菜谱关联一起复制过去", () => {
    const recipe = store.addRecipe({ name: "红烧肉", ingredients: [{ name: "五花肉", quantity: 500, unit: "克" }] });
    store.setMealEntryFromRecipe("2026-09-07", "dinner", recipe.id); // 上周一
    store.copyWeek("2026-09-07", "2026-09-14");
    assert.equal(store.getMealEntryRecord("2026-09-14", "dinner").recipeId, recipe.id);
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

describe("库存管理：购物清单勾选自动更新库存 + 消耗趋势（开发计划第一版暂缓功能之一）", () => {
  test("resolveShoppingItem：勾选低库存自动生成的条目，买到的数量会加回库存，条目从购物清单消失", () => {
    const item = store.addInventoryItem({ name: "纸巾", quantity: 1, unit: "包", lowThreshold: 3 });
    const [shoppingEntry] = store.listShoppingItems();
    store.resolveShoppingItem(shoppingEntry.id, 5);
    assert.equal(store.listInventoryItems().find((i) => i.id === item.id).quantity, 6); // 1 + 5
    assert.equal(store.listShoppingItems().length, 0);
  });

  test("resolveShoppingItem：手动添加、没有linkedItemId的条目，按名字匹配现有库存物品", () => {
    const item = store.addInventoryItem({ name: "酱油", quantity: 1, unit: "瓶", lowThreshold: 0 }); // 1 > 0，不是低库存，不会自动进购物清单
    assert.equal(store.listShoppingItems().length, 0);
    const manualEntry = store.addShoppingItem({ name: "酱油" });
    store.resolveShoppingItem(manualEntry.id, 2);
    assert.equal(store.listInventoryItems().find((i) => i.id === item.id).quantity, 3); // 1 + 2
  });

  test("resolveShoppingItem：名字在库存里完全找不到匹配时，会新建一个库存物品，不会丢失这次购买的数据", () => {
    const entry = store.addShoppingItem({ name: "新买的削皮器" });
    store.resolveShoppingItem(entry.id, 1);
    const created = store.listInventoryItems().find((i) => i.name === "新买的削皮器");
    assert.ok(created);
    assert.equal(created.quantity, 1);
  });

  test("resolveShoppingItem：不传购买数量时，优先用条目自带的建议数量（比如菜谱汇总的用量），没有就默认1", () => {
    const withSuggestion = store.addRecipe({ name: "菜A", ingredients: [{ name: "胡萝卜", quantity: 3, unit: "根" }] });
    store.setMealEntryFromRecipe("2026-09-14", "lunch", withSuggestion.id);
    store.generateShoppingListFromMealPlan("2026-09-14");
    const carrotEntry = store.listShoppingItems().find((s) => s.name === "胡萝卜");
    store.resolveShoppingItem(carrotEntry.id); // 不传数量
    const created = store.listInventoryItems().find((i) => i.name === "胡萝卜");
    assert.equal(created.quantity, 3); // 用了建议数量3，而不是默认的1

    const plainEntry = store.addShoppingItem({ name: "普通条目" });
    store.resolveShoppingItem(plainEntry.id); // 没有建议数量，也不传，默认按1
    assert.equal(store.listInventoryItems().find((i) => i.name === "普通条目").quantity, 1);
  });

  test("recordConsumption：消耗会扣减库存数量，且不会扣成负数", () => {
    const item = store.addInventoryItem({ name: "洗手液", quantity: 3, unit: "瓶", lowThreshold: 0 });
    const updated = store.recordConsumption(item.id, 2, "2026-09-16");
    assert.equal(updated.quantity, 1);
    const overConsumed = store.recordConsumption(item.id, 10, "2026-09-16");
    assert.equal(overConsumed.quantity, 0); // 不会变成负数
  });

  test("recordConsumption：消耗到低于阈值会自动触发低库存、补进购物清单", () => {
    const item = store.addInventoryItem({ name: "牙膏", quantity: 3, unit: "支", lowThreshold: 1 });
    assert.equal(store.listShoppingItems().length, 0);
    store.recordConsumption(item.id, 3, "2026-09-16");
    assert.equal(store.listShoppingItems().length, 1);
  });

  test("recordConsumption：对不存在的物品id返回null，不抛错", () => {
    assert.equal(store.recordConsumption("nope", 1), null);
  });

  test("listTopConsumedItems：按累计消耗量从高到低排序，只统计指定天数范围内的记录", () => {
    const a = store.addInventoryItem({ name: "牛奶", quantity: 20, unit: "盒", lowThreshold: 0 });
    const b = store.addInventoryItem({ name: "鸡蛋", quantity: 30, unit: "个", lowThreshold: 0 });
    store.recordConsumption(a.id, 5, "2026-09-16");
    store.recordConsumption(b.id, 8, "2026-09-15");
    store.recordConsumption(b.id, 2, "2026-08-01"); // 超出30天范围，不应计入

    const top = store.listTopConsumedItems(30, "2026-09-16");
    assert.equal(top.length, 2);
    assert.equal(top[0].name, "鸡蛋"); // 8 > 5
    assert.equal(top[0].totalAmount, 8); // 只统计范围内的那一次，不含8月那次
    assert.equal(top[1].name, "牛奶");
  });

  test("listTopConsumedItems：物品被删除后，历史消耗记录仍然保留在排行榜里（用记消耗时的名字快照）", () => {
    const item = store.addInventoryItem({ name: "临时物品", quantity: 5, unit: "个", lowThreshold: 0 });
    store.recordConsumption(item.id, 2, "2026-09-16");
    store.removeInventoryItem(item.id);
    const top = store.listTopConsumedItems(30, "2026-09-16");
    assert.equal(top.find((t) => t.name === "临时物品").totalAmount, 2);
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

  test("新增的几个常用币种（日元/英镑/港币）默认都有汇率、能正常记账换算", () => {
    assert.deepEqual(store.CURRENCIES, ["CNY", "EUR", "USD", "JPY", "GBP", "HKD"]);
    const rates = store.getExchangeRates();
    ["JPY", "GBP", "HKD"].forEach((c) => assert.ok(rates[c] > 0, `${c} 应该有一个正的默认汇率`));
    const t = store.addTransaction({ amount: 1000, currency: "JPY", type: "expense", category: "餐饮", date: "2026-09-16" });
    assert.equal(t.amountCNY, Math.round(1000 * rates.JPY * 100) / 100);
  });

  test("setExchangeRates：批量写入多个币种的汇率，记下这次刷新时间", () => {
    assert.equal(store.getExchangeRatesUpdatedAt(), null);
    const result = store.setExchangeRates({ EUR: 7.9, USD: 7.2, JPY: 0.048 });
    assert.equal(result.updated, 3);
    assert.equal(store.getExchangeRates().EUR, 7.9);
    assert.equal(store.getExchangeRates().USD, 7.2);
    assert.equal(store.getExchangeRates().JPY, 0.048);
    assert.ok(store.getExchangeRatesUpdatedAt(), "应该记下刷新时间");
  });

  test("setExchangeRates：忽略非法值（负数/非数字/CNY自己/不认识的币种），一个都没成功时不更新时间戳", () => {
    const before = store.getExchangeRates();
    const beforeUpdatedAt = store.getExchangeRatesUpdatedAt();
    const result = store.setExchangeRates({ CNY: 2, EUR: -1, USD: "abc", XYZ: 5 });
    assert.equal(result.updated, 0);
    assert.deepEqual(store.getExchangeRates(), before);
    assert.equal(store.getExchangeRatesUpdatedAt(), beforeUpdatedAt);
  });

  test("老存档（升级前）汇率表里只有 CNY/EUR/USD 三种，重新 init 应该自动补上新币种的默认汇率，同时保留老存档里已经手动改过的值", () => {
    storage.setItem("faner-app-data", JSON.stringify({
      schemaVersion: 1,
      quickNotes: [], todayPlan: [], studyCourses: [], studyAssignments: [],
      studyGoals: [], studyCheckins: [], studyDailyLogs: [], reminders: [],
      mealPlanEntries: [], inventoryItems: [], shoppingListItems: [],
      financeTransactions: [], financeCategories: ["餐饮"], games: [], gameSessions: [],
      financeExchangeRates: { CNY: 1, EUR: 9.9, USD: 7.1 }, // 老存档：EUR 被用户手动改过
      settings: { homeCards: {}, lastBackupAt: null, lastManualSaveAt: null },
    }));
    const s2 = createStore(storage);
    s2.init();
    const rates = s2.getExchangeRates();
    assert.equal(rates.EUR, 9.9, "老存档里用户已经手动改过的汇率不能被默认值覆盖");
    assert.ok(rates.JPY > 0 && rates.GBP > 0 && rates.HKD > 0, "老存档缺失的新币种要补上默认值，不能是 undefined");
  });
});

describe("个人记账：预算超支提醒（开发计划第一版暂缓功能之一）", () => {
  test("设置预算后，本月花费超过预算会被标记为超支", () => {
    store.setBudget("餐饮", 100);
    store.addTransaction({ amount: 120, type: "expense", category: "餐饮", date: "2026-09-16" });
    const [status] = store.getBudgetStatus("2026-09");
    assert.equal(status.category, "餐饮");
    assert.equal(status.spent, 120);
    assert.equal(status.remaining, -20);
    assert.equal(status.overspent, true);
  });

  test("没超支时 overspent 是 false，remaining 是正数", () => {
    store.setBudget("交通", 300);
    store.addTransaction({ amount: 60, type: "expense", category: "交通", date: "2026-09-16" });
    const [status] = store.getBudgetStatus("2026-09");
    assert.equal(status.overspent, false);
    assert.equal(status.remaining, 240);
  });

    test("没设置预算的分类不会出现在超支提醒里", () => {
    store.addTransaction({ amount: 500, type: "expense", category: "娱乐", date: "2026-09-16" });
    assert.equal(store.getBudgetStatus("2026-09").length, 0);
  });

  test("只统计支出，不统计收入；只统计指定月份", () => {
    store.setBudget("餐饮", 100);
    store.addTransaction({ amount: 1000, type: "income", category: "餐饮", date: "2026-09-16" }); // 收入不计入
    store.addTransaction({ amount: 50, type: "expense", category: "餐饮", date: "2026-08-16" }); // 上个月不计入
    const [status] = store.getBudgetStatus("2026-09");
    assert.equal(status.spent, 0);
  });

  test("清除预算（设为0或不传）后，这个分类就不再出现在超支提醒里", () => {
    store.setBudget("餐饮", 100);
    store.setBudget("餐饮", 0);
    assert.equal(store.getBudgetStatus("2026-09").length, 0);
    assert.deepEqual(store.getBudgets(), {});
  });
});

describe("个人记账：收支图表（开发计划第一版暂缓功能之一）", () => {
  test("listMonthlyTotals 按月汇总最近N个月的收入和支出", () => {
    store.addTransaction({ amount: 3000, type: "income", category: "其他", date: "2026-09-01" });
    store.addTransaction({ amount: 500, type: "expense", category: "餐饮", date: "2026-09-16" });
    store.addTransaction({ amount: 200, type: "expense", category: "交通", date: "2026-07-10" });

    const series = store.listMonthlyTotals(3, "2026-09"); // 2026-07, 08, 09
    assert.equal(series.length, 3);
    assert.equal(series[0].month, "2026-07");
    assert.equal(series[0].expense, 200);
    assert.equal(series[1].month, "2026-08");
    assert.equal(series[1].income, 0);
    assert.equal(series[1].expense, 0);
    assert.equal(series[2].month, "2026-09");
    assert.equal(series[2].income, 3000);
    assert.equal(series[2].expense, 500);
  });
});

describe("个人记账：多账户（开发计划第一版暂缓功能之一）", () => {
  test("init() 会自动建一个默认账户，老数据（没有账户概念）的记账记录都会归到它名下", () => {
    const accounts = store.listAccounts();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].name, "默认账户");

    const t = store.addTransaction({ amount: 50, type: "expense", category: "餐饮", date: "2026-09-16" });
    assert.equal(t.accountId, accounts[0].id); // 没指定账户时自动记到默认账户
  });

  test("新增账户、记账到指定账户、账户余额正确计算（期初余额 + 收入 - 支出）", () => {
    const account = store.addAccount({ name: "招商银行卡", initialBalance: 1000 });
    store.addTransaction({ amount: 500, type: "income", category: "其他", date: "2026-09-16", accountId: account.id });
    store.addTransaction({ amount: 200, type: "expense", category: "餐饮", date: "2026-09-16", accountId: account.id });
    assert.equal(store.getAccountBalance(account.id), 1300); // 1000 + 500 - 200
  });

  test("不同账户的交易互不影响余额计算", () => {
    const accountA = store.addAccount({ name: "账户A", initialBalance: 0 });
    const accountB = store.addAccount({ name: "账户B", initialBalance: 0 });
    store.addTransaction({ amount: 100, type: "income", category: "其他", date: "2026-09-16", accountId: accountA.id });
    store.addTransaction({ amount: 50, type: "income", category: "其他", date: "2026-09-16", accountId: accountB.id });
    assert.equal(store.getAccountBalance(accountA.id), 100);
    assert.equal(store.getAccountBalance(accountB.id), 50);
  });

  test("删除账户不会删除它名下的记账记录，只是清空账户归属", () => {
    const account = store.addAccount({ name: "临时账户", initialBalance: 0 });
    const t = store.addTransaction({ amount: 30, type: "expense", category: "餐饮", date: "2026-09-16", accountId: account.id });
    store.removeAccount(account.id);
    assert.equal(store.listAccounts().find((a) => a.id === account.id), undefined);
    const stillThere = store.listTransactions().find((x) => x.id === t.id);
    assert.ok(stillThere); // 记录还在
    assert.equal(stillThere.accountId, null); // 只是账户归属被清空
  });

  test("listTransactions 按账户过滤", () => {
    const account = store.addAccount({ name: "现金", initialBalance: 0 });
    store.addTransaction({ amount: 10, type: "expense", category: "餐饮", date: "2026-09-16", accountId: account.id });
    const defaultAccountId = store.listAccounts()[0].id;
    store.addTransaction({ amount: 20, type: "expense", category: "餐饮", date: "2026-09-16", accountId: defaultAccountId });
    assert.equal(store.listTransactions({ accountId: account.id }).length, 1);
  });

  test("listAccountsWithBalance 把每个账户的余额一起列出来", () => {
    store.addAccount({ name: "支付宝", initialBalance: 200 });
    const list = store.listAccountsWithBalance();
    const alipay = list.find((a) => a.name === "支付宝");
    assert.equal(alipay.balance, 200); // 没有交易，余额就是期初余额
  });

  test("对不存在的账户id调用 getAccountBalance 返回 null", () => {
    assert.equal(store.getAccountBalance("nope"), null);
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

describe("游戏娱乐：评分/评论（开发计划第一版暂缓功能之一）", () => {
  test("新添加的游戏默认没有评分，rating为null", () => {
    const game = store.addGame({ name: "新游戏" });
    assert.equal(game.rating, null);
    assert.equal(game.review, "");
  });

  test("updateGame 可以设置评分（1-5星）和文字评价", () => {
    const game = store.addGame({ name: "艾尔登法环" });
    const updated = store.updateGame(game.id, { rating: 5, review: "年度最佳" });
    assert.equal(updated.rating, 5);
    assert.equal(updated.review, "年度最佳");
  });

  test("评分会被夹到1-5之间，传null可以清除评分", () => {
    const game = store.addGame({ name: "测试游戏" });
    assert.equal(store.updateGame(game.id, { rating: 9 }).rating, 5);
    assert.equal(store.updateGame(game.id, { rating: 0 }).rating, 1);
    assert.equal(store.updateGame(game.id, { rating: null }).rating, null);
  });

  test("评分/评论不影响原有的状态和备注字段", () => {
    const game = store.addGame({ name: "只狼", status: "在玩", note: "剑仙难打" });
    const updated = store.updateGame(game.id, { rating: 4 });
    assert.equal(updated.status, "在玩");
    assert.equal(updated.note, "剑仙难打");
  });
});

describe("游戏娱乐：游玩数据统计图表（开发计划第一版暂缓功能之一）", () => {
  test("listGamePlaytimeSeries 按天汇总总游玩时长，并按游戏拆分明细", () => {
    const g1 = store.addGame({ name: "塞尔达传说" });
    const g2 = store.addGame({ name: "星露谷物语" });
    store.addPlaySession({ gameId: g1.id, date: "2026-09-16", minutes: 60 });
    store.addPlaySession({ gameId: g2.id, date: "2026-09-16", minutes: 30 });
    store.addPlaySession({ gameId: g1.id, date: "2026-09-14", minutes: 20 });

    const series = store.listGamePlaytimeSeries(3, "2026-09-16"); // 09-14, 15, 16
    assert.equal(series.length, 3);
    assert.equal(series[0].date, "2026-09-14");
    assert.equal(series[0].totalMinutes, 20);
    assert.equal(series[1].totalMinutes, 0);
    assert.deepEqual(series[1].byGame, []);
    assert.equal(series[2].totalMinutes, 90); // 60 + 30
    assert.equal(series[2].byGame.length, 2);
  });

  test("listTopPlayedGames 按累计游玩时长从高到低排序，只统计指定天数范围", () => {
    const g1 = store.addGame({ name: "游戏A" });
    const g2 = store.addGame({ name: "游戏B" });
    store.addPlaySession({ gameId: g1.id, date: "2026-09-16", minutes: 30 });
    store.addPlaySession({ gameId: g2.id, date: "2026-09-15", minutes: 90 });
    store.addPlaySession({ gameId: g2.id, date: "2026-08-01", minutes: 500 }); // 超出范围

    const top = store.listTopPlayedGames(30, "2026-09-16");
    assert.equal(top[0].name, "游戏B");
    assert.equal(top[0].totalMinutes, 90); // 不含8月那次
    assert.equal(top[1].name, "游戏A");
  });

  test("游戏被删除后，统计图表和排行榜都不再包含它（和\"删除游戏级联删除游玩记录\"的既有行为一致）", () => {
    const game = store.addGame({ name: "临时游戏" });
    store.addPlaySession({ gameId: game.id, date: "2026-09-16", minutes: 45 });
    store.removeGame(game.id);
    const series = store.listGamePlaytimeSeries(1, "2026-09-16");
    assert.equal(series[0].totalMinutes, 0);
    assert.equal(store.listTopPlayedGames(30, "2026-09-16").length, 0);
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

describe("设置：外观（字体字号 / 白天夜间主题）", () => {
  test("默认标准字号、白天模式", () => {
    assert.equal(store.getSettings().fontScale, "medium");
    assert.equal(store.getSettings().theme, "day");
  });

  test("setFontScale 只接受合法档位，非法值忽略", () => {
    store.setFontScale("large");
    assert.equal(store.getSettings().fontScale, "large");
    store.setFontScale("这是啥");
    assert.equal(store.getSettings().fontScale, "large", "非法值应该被忽略，不覆盖已有设置");
  });

  test("setTheme / toggleTheme", () => {
    store.setTheme("night");
    assert.equal(store.getSettings().theme, "night");
    const after = store.toggleTheme();
    assert.equal(after, "day");
    assert.equal(store.getSettings().theme, "day");
  });

  test("setClaudeApiKey：默认为空字符串，设置后能读回来，去掉首尾空格，传空字符串等于清除", () => {
    assert.equal(store.getSettings().claudeApiKey, "");
    store.setClaudeApiKey("  sk-test-12345  ");
    assert.equal(store.getSettings().claudeApiKey, "sk-test-12345");
    store.setClaudeApiKey("");
    assert.equal(store.getSettings().claudeApiKey, "");
  });

  test("老存档里只有 translationApiKey（早期版本翻译和整理笔记共用一把密钥）时，会自动迁移成 claudeApiKey", () => {
    const s = createStore(storage);
    storage.setItem("faner-app-data", JSON.stringify({
      schemaVersion: 1,
      quickNotes: [], todayPlan: [], studyCourses: [], studyAssignments: [],
      studyGoals: [], studyCheckins: [], studyDailyLogs: [], reminders: [],
      mealPlanEntries: [], inventoryItems: [], shoppingListItems: [],
      financeTransactions: [], financeCategories: ["餐饮"], games: [], gameSessions: [],
      settings: { translationApiKey: "sk-old-key" },
    }));
    s.init();
    assert.equal(s.getSettings().claudeApiKey, "sk-old-key");
  });

  test("翻译服务：默认 provider 是 google，三家密钥和 Azure 区域默认为空字符串", () => {
    const settings = store.getSettings();
    assert.equal(settings.translationProvider, "google");
    assert.equal(settings.googleTranslateApiKey, "");
    assert.equal(settings.azureTranslatorApiKey, "");
    assert.equal(settings.azureTranslatorRegion, "");
    assert.equal(settings.deeplApiKey, "");
  });

  test("setTranslationProvider：三选一，非法值忽略", () => {
    store.setTranslationProvider("azure");
    assert.equal(store.getSettings().translationProvider, "azure");
    store.setTranslationProvider("not-a-provider");
    assert.equal(store.getSettings().translationProvider, "azure", "非法值应该被忽略，不能覆盖已有值");
    store.setTranslationProvider("deepl");
    assert.equal(store.getSettings().translationProvider, "deepl");
  });

  test("三家翻译服务密钥各自独立存取，互不影响", () => {
    store.setGoogleTranslateApiKey("  google-key  ");
    store.setAzureTranslatorApiKey("azure-key");
    store.setAzureTranslatorRegion("  eastasia  ");
    store.setDeeplApiKey("deepl-key:fx");
    const settings = store.getSettings();
    assert.equal(settings.googleTranslateApiKey, "google-key");
    assert.equal(settings.azureTranslatorApiKey, "azure-key");
    assert.equal(settings.azureTranslatorRegion, "eastasia");
    assert.equal(settings.deeplApiKey, "deepl-key:fx");
  });

  test("老存档里 settings 没有 fontScale/theme/profile 字段时，重新 init 应该自动补上默认值（不能变成 undefined）", () => {
    storage.setItem("faner-app-data", JSON.stringify({
      schemaVersion: 1,
      quickNotes: [], todayPlan: [], studyCourses: [], studyAssignments: [],
      studyGoals: [], studyCheckins: [], studyDailyLogs: [], reminders: [],
      mealPlanEntries: [], inventoryItems: [], shoppingListItems: [],
      financeTransactions: [], financeCategories: ["餐饮"], games: [], gameSessions: [],
      settings: { homeCards: { study: false }, lastBackupAt: null, lastManualSaveAt: null }, // 模拟老版本存档
    }));
    const s = createStore(storage);
    s.init();
    const settings = s.getSettings();
    assert.equal(settings.fontScale, "medium", "老存档缺失的字段要补上默认值");
    assert.equal(settings.theme, "day");
    assert.deepEqual(settings.profile, { name: "", avatar: "🙂", avatarImage: null });
    assert.equal(settings.claudeApiKey, "", "老存档缺失的 AI 密钥字段也要补上默认空字符串，不能是 undefined");
    assert.equal(settings.homeCards.study, false, "老存档里已有的字段要保留，不能被默认值覆盖");
  });
});

describe("设置：个人资料（昵称/头像）", () => {
  test("默认昵称为空、默认头像是🙂、默认没有上传照片", () => {
    const profile = store.getSettings().profile;
    assert.equal(profile.name, "");
    assert.equal(profile.avatar, "🙂");
    assert.equal(profile.avatarImage, null);
  });

  test("updateProfile 只更新传入的字段", () => {
    store.updateProfile({ name: "阿凡" });
    assert.equal(store.getSettings().profile.name, "阿凡");
    assert.equal(store.getSettings().profile.avatar, "🙂", "没传的字段应该保持不变");
    store.updateProfile({ avatar: "🐼" });
    assert.equal(store.getSettings().profile.name, "阿凡", "改头像不应该把昵称清空");
    assert.equal(store.getSettings().profile.avatar, "🐼");
  });

  test("上传头像照片（avatarImage）会持久化，且不影响昵称", () => {
    store.updateProfile({ name: "小明" });
    store.updateProfile({ avatarImage: "data:image/jpeg;base64,FAKE" });
    const profile = store.getSettings().profile;
    assert.equal(profile.avatarImage, "data:image/jpeg;base64,FAKE");
    assert.equal(profile.name, "小明", "上传照片不应该影响已经填好的昵称");
  });

  test("移除头像照片（avatarImage 设为 null）之后能正确回到 emoji 头像", () => {
    store.updateProfile({ avatar: "🦊", avatarImage: "data:image/jpeg;base64,FAKE" });
    assert.equal(store.getSettings().profile.avatarImage, "data:image/jpeg;base64,FAKE");
    store.updateProfile({ avatarImage: null });
    const profile = store.getSettings().profile;
    assert.equal(profile.avatarImage, null);
    assert.equal(profile.avatar, "🦊", "移除照片不应该连带把之前选的 emoji 也清掉");
  });

  test("老存档里 settings.profile 完全没有 avatarImage 字段时，重新 init 应该自动补上默认值 null", () => {
    storage.setItem("faner-app-data", JSON.stringify({
      schemaVersion: 1,
      quickNotes: [], todayPlan: [], studyCourses: [], studyAssignments: [],
      studyGoals: [], studyCheckins: [], studyDailyLogs: [], reminders: [],
      mealPlanEntries: [], inventoryItems: [], shoppingListItems: [],
      financeTransactions: [], financeCategories: ["餐饮"], games: [], gameSessions: [],
      settings: { profile: { name: "老用户", avatar: "🐶" }, lastBackupAt: null, lastManualSaveAt: null }, // 模拟老版本存档，没有 avatarImage 字段
    }));
    const s = createStore(storage);
    s.init();
    const profile = s.getSettings().profile;
    assert.equal(profile.name, "老用户", "老存档里已有的字段要保留");
    assert.equal(profile.avatar, "🐶");
    assert.equal(profile.avatarImage, null, "老存档没有的新字段要补上默认值，不能是 undefined");
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

describe("读书笔记：书目管理", () => {
  test("添加书目默认状态是'想读'，评分默认为空", () => {
    const book = store.addBook({ title: "百年孤独", author: "加西亚·马尔克斯" });
    assert.equal(book.status, "想读");
    assert.equal(book.rating, null);
    assert.equal(store.listBooks().length, 1);
  });

  test("非法状态会被忽略，落回默认'想读'", () => {
    const book = store.addBook({ title: "测试书", status: "乱写的状态" });
    assert.equal(book.status, "想读");
  });

  test("按状态筛选书目", () => {
    store.addBook({ title: "书A", status: "想读" });
    store.addBook({ title: "书B", status: "在玩" }); // 非法状态 -> 落回想读
    store.addBook({ title: "书C", status: "在读" });
    assert.equal(store.listBooks("想读").length, 2);
    assert.equal(store.listBooks("在读").length, 1);
    assert.equal(store.listBooks("全部").length, 3);
    assert.equal(store.listBooks().length, 3);
  });

  test("updateBook 更新状态为'读完'时自动记录完成日期，评分被夹在 1-5 之间", () => {
    const book = store.addBook({ title: "刻意练习" });
    assert.equal(book.finishedAt, undefined);
    const updated = store.updateBook(book.id, { status: "读完", rating: 8 });
    assert.equal(updated.status, "读完");
    assert.ok(updated.finishedAt, "读完之后应该自动记一个完成日期");
    assert.equal(updated.rating, 5, "评分应该被夹到最大值5");
  });

  test("再次更新已经读完的书，不会覆盖第一次记录的完成日期", () => {
    const book = store.addBook({ title: "小王子" });
    const first = store.updateBook(book.id, { status: "读完" });
    const finishedAt = first.finishedAt;
    const second = store.updateBook(book.id, { status: "在读" });
    const third = store.updateBook(second.id, { status: "读完" });
    assert.equal(third.finishedAt, finishedAt, "完成日期应该保留第一次读完的记录");
  });

  test("删除书目时，挂在它下面的读书笔记也要一起删掉", () => {
    const book = store.addBook({ title: "将被删除的书" });
    store.addBookNote(book.id, "第一条笔记");
    store.addBookNote(book.id, "第二条笔记");
    assert.equal(store.listBookNotes(book.id).length, 2);
    store.removeBook(book.id);
    assert.equal(store.findBook(book.id), null);
    assert.equal(store.listBookNotes(book.id).length, 0, "书被删了，笔记不应该变成孤儿数据");
  });
});

describe("读书笔记：读书摘录/笔记", () => {
  test("给一本书添加多条笔记，按最新在前排序", () => {
    const book = store.addBook({ title: "人类简史" });
    store.addBookNote(book.id, "第一条笔记，第10页", 10);
    store.addBookNote(book.id, "第二条笔记，第20页", 20);
    const notes = store.listBookNotes(book.id);
    assert.equal(notes.length, 2);
    assert.equal(notes[0].text, "第二条笔记，第20页", "应该是最新添加的排在最前面");
    assert.equal(store.countBookNotes(book.id), 2);
  });

  test("删除单条笔记不影响其它笔记和书本身", () => {
    const book = store.addBook({ title: "三体" });
    const n1 = store.addBookNote(book.id, "笔记一");
    store.addBookNote(book.id, "笔记二");
    store.removeBookNote(n1.id);
    assert.equal(store.listBookNotes(book.id).length, 1);
    assert.ok(store.findBook(book.id));
  });

  test("不同书的笔记互不干扰", () => {
    const bookA = store.addBook({ title: "书A" });
    const bookB = store.addBook({ title: "书B" });
    store.addBookNote(bookA.id, "A的笔记");
    store.addBookNote(bookB.id, "B的笔记1");
    store.addBookNote(bookB.id, "B的笔记2");
    assert.equal(store.listBookNotes(bookA.id).length, 1);
    assert.equal(store.listBookNotes(bookB.id).length, 2);
  });
});

describe("读书笔记：最近读完趋势图数据", () => {
  test("按月份分桶统计读完数量，没有读完记录的月份是0", () => {
    const book1 = store.addBook({ title: "书1" });
    store.updateBook(book1.id, { status: "读完", finishedAt: "2026-08-05" });
    const book2 = store.addBook({ title: "书2" });
    store.updateBook(book2.id, { status: "读完", finishedAt: "2026-09-01" });

    const series = store.listBooksFinishedSeries(3, "2026-09-16");
    assert.equal(series.length, 3);
    assert.equal(series[series.length - 1].month, "2026-09");
    assert.equal(series[series.length - 1].count, 1);
    assert.equal(series[series.length - 2].month, "2026-08");
    assert.equal(series[series.length - 2].count, 1);
    assert.equal(series[0].count, 0);
  });
});

describe("课堂笔记：录音+转录+翻译+AI整理笔记的数据层", () => {
  test("新建笔记：默认状态是 recording，目标语言里自动去掉跟讲课语言重复的那个", () => {
    const note = store.addClassNote({ title: "战略课", sourceLang: "fr", targetLangs: ["zh", "fr", "en"] });
    assert.equal(note.status, "recording");
    assert.deepEqual(note.targetLangs, ["zh", "en"]);
    assert.deepEqual(note.transcriptSegments, []);
    assert.deepEqual(note.translations, {});
    assert.equal(note.notesMarkdown, "");
    assert.equal(note.audioKey, null);
    assert.deepEqual(note.materials, []);
    assert.equal(note.mindMap, null);
    assert.equal(note.courseId, null); // 默认"未分类"
    assert.equal(note.sourceType, "recorded"); // 默认是现场录音，不是上传的录音文件
    assert.equal(note.retranscript, null);
  });

  test("新建笔记：可以直接指定所属课程，sourceType 传 uploaded 就是上传的录音", () => {
    const course = store.addClassNoteCourse("宏观经济学");
    const note = store.addClassNote({ title: "第3讲", courseId: course.id, sourceType: "uploaded" });
    assert.equal(note.courseId, course.id);
    assert.equal(note.sourceType, "uploaded");
  });

  test("追加转录分段：空文字不追加，正常文字追加后 updatedAt 会更新", async () => {
    const note = store.addClassNote({ title: "课1" });
    const createdAt = note.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    store.appendClassNoteTranscript(note.id, { start: 0, end: 3, text: "  " });
    let found = store.findClassNote(note.id);
    assert.equal(found.transcriptSegments.length, 0, "空白文字不应该被追加");

    store.appendClassNoteTranscript(note.id, { start: 0, end: 3, text: "Bonjour à tous" });
    found = store.findClassNote(note.id);
    assert.equal(found.transcriptSegments.length, 1);
    assert.equal(found.transcriptSegments[0].text, "Bonjour à tous");
    assert.notEqual(found.updatedAt, createdAt);
  });

  test("结束录音：状态变成 recorded，记下时长和音频引用", () => {
    const note = store.addClassNote({ title: "课2" });
    const updated = store.finishClassNoteRecording(note.id, { durationSeconds: 66.7, audioKey: "audio-abc" });
    assert.equal(updated.status, "recorded");
    assert.equal(updated.audioDurationSeconds, 66.7);
    assert.equal(updated.audioKey, "audio-abc");
  });

  test("保存翻译结果：按语言代码分开存，重新生成会整段替换而不是追加", () => {
    const note = store.addClassNote({ title: "课3" });
    store.setClassNoteTranslation(note.id, "zh", [{ start: 0, end: 3, text: "大家好" }]);
    let found = store.findClassNote(note.id);
    assert.equal(found.translations.zh.length, 1);

    store.setClassNoteTranslation(note.id, "zh", [{ start: 0, end: 3, text: "大家好（重新翻译）" }]);
    found = store.findClassNote(note.id);
    assert.equal(found.translations.zh.length, 1);
    assert.equal(found.translations.zh[0].text, "大家好（重新翻译）");
  });

  test("追加翻译结果：接在已有翻译后面，不是整段替换（录音过程中的自动翻译用这个）", () => {
    const note = store.addClassNote({ title: "课3-追加" });
    store.appendClassNoteTranslation(note.id, "zh", [{ start: 0, end: 3, text: "第一句" }]);
    let found = store.findClassNote(note.id);
    assert.equal(found.translations.zh.length, 1);

    store.appendClassNoteTranslation(note.id, "zh", [{ start: 3, end: 6, text: "第二句" }, { start: 6, end: 9, text: "第三句" }]);
    found = store.findClassNote(note.id);
    assert.deepEqual(found.translations.zh.map((s) => s.text), ["第一句", "第二句", "第三句"]);

    // 追加空数组：安全地什么都不做，不会往数组里塞进空内容，updatedAt 也不应该被打扰。
    const beforeUpdatedAt = found.updatedAt;
    store.appendClassNoteTranslation(note.id, "zh", []);
    found = store.findClassNote(note.id);
    assert.equal(found.translations.zh.length, 3);
    assert.equal(found.updatedAt, beforeUpdatedAt);

    // 另一种语言的翻译互不影响。
    store.appendClassNoteTranslation(note.id, "en", [{ start: 0, end: 3, text: "hello" }]);
    found = store.findClassNote(note.id);
    assert.equal(found.translations.en.length, 1);
    assert.equal(found.translations.zh.length, 3);
  });

  test("保存 AI 整理出的笔记正文：状态变成 notes_ready", () => {
    const note = store.addClassNote({ title: "课4" });
    const updated = store.setClassNoteMarkdown(note.id, "# 课程结构\n- 三个模块");
    assert.equal(updated.status, "notes_ready");
    assert.equal(updated.notesMarkdown, "# 课程结构\n- 三个模块");
  });

  test("笔记正文可以再翻译成其它语言，跟原文/其它语言互不影响", () => {
    const note = store.addClassNote({ title: "课5" });
    store.setClassNoteMarkdown(note.id, "# 标题\n正文");
    const beforeUpdatedAt = store.findClassNote(note.id).updatedAt;

    const updated = store.setClassNoteNotesTranslation(note.id, "en", "# Title\nBody");
    assert.equal(updated.notesTranslations.en, "# Title\nBody");
    assert.equal(updated.notesMarkdown, "# 标题\n正文"); // 原文不受影响
    assert.ok(updated.updatedAt >= beforeUpdatedAt);

    store.setClassNoteNotesTranslation(note.id, "zh", "# 中文标题\n中文正文");
    const found = store.findClassNote(note.id);
    assert.equal(found.notesTranslations.en, "# Title\nBody"); // 另一种语言不受影响
    assert.equal(found.notesTranslations.zh, "# 中文标题\n中文正文");

    // 整段替换，不是追加。
    store.setClassNoteNotesTranslation(note.id, "en", "# New Title");
    assert.equal(store.findClassNote(note.id).notesTranslations.en, "# New Title");
  });

  test("保存 AI 生成的闪卡：整段替换，重新生成会覆盖上一批", () => {
    const note = store.addClassNote({ title: "课6" });
    store.setClassNoteMarkdown(note.id, "# 标题\n正文");
    const updated = store.setClassNoteFlashcards(note.id, [
      { question: "问题1", answer: "答案1" },
      { question: "问题2", answer: "答案2" },
    ]);
    assert.equal(updated.flashcards.length, 2);
    store.setClassNoteFlashcards(note.id, [{ question: "新问题", answer: "新答案" }]);
    const found = store.findClassNote(note.id);
    assert.deepEqual(found.flashcards, [{ question: "新问题", answer: "新答案" }]);
  });

  test("保存 AI 生成的测验题，每题自带 selectedIndex（初始是 null）", () => {
    const note = store.addClassNote({ title: "课7" });
    const updated = store.setClassNoteQuiz(note.id, [
      { question: "1+1=?", options: ["1", "2"], correctIndex: 1 },
    ]);
    assert.deepEqual(updated.quiz, [{ question: "1+1=?", options: ["1", "2"], correctIndex: 1, selectedIndex: null }]);
  });

  test("记录测验作答；重新生成测验会重置所有作答", () => {
    const note = store.addClassNote({ title: "课8" });
    store.setClassNoteQuiz(note.id, [
      { question: "q1", options: ["a", "b"], correctIndex: 0 },
      { question: "q2", options: ["a", "b"], correctIndex: 1 },
    ]);
    store.setClassNoteQuizAnswer(note.id, 0, 1);
    let found = store.findClassNote(note.id);
    assert.equal(found.quiz[0].selectedIndex, 1);
    assert.equal(found.quiz[1].selectedIndex, null); // 只影响第0题

    // 重新点其它选项：覆盖，不是追加
    store.setClassNoteQuizAnswer(note.id, 0, 0);
    assert.equal(store.findClassNote(note.id).quiz[0].selectedIndex, 0);

    // 对不存在的题目下标安全地什么都不做
    assert.equal(store.setClassNoteQuizAnswer(note.id, 99, 0), found);

    store.setClassNoteQuiz(note.id, [{ question: "q1新", options: ["a", "b"], correctIndex: 0 }]);
    found = store.findClassNote(note.id);
    assert.equal(found.quiz.length, 1);
    assert.equal(found.quiz[0].selectedIndex, null);
  });

  test("提问记录按顺序追加，用户和助手的消息都能存；空文本不追加", () => {
    const note = store.addClassNote({ title: "课9" });
    store.addClassNoteQaMessage(note.id, "user", "这是什么意思？");
    store.addClassNoteQaMessage(note.id, "assistant", "这是……的意思。");
    store.addClassNoteQaMessage(note.id, "user", "   "); // 空白文本不追加
    const found = store.findClassNote(note.id);
    assert.deepEqual(found.qaMessages, [
      { role: "user", text: "这是什么意思？" },
      { role: "assistant", text: "这是……的意思。" },
    ]);
  });

  test("上传材料：添加会自动生成 id/addedAt，图片和 PPT 两种 kind 都能存", () => {
    const note = store.addClassNote({ title: "材料课" });
    const img = store.addClassNoteMaterial(note.id, { kind: "image", name: "板书1.jpg", storageKey: "mat-key-1" });
    assert.ok(img.id);
    assert.equal(img.kind, "image");
    assert.equal(img.name, "板书1.jpg");
    assert.equal(img.storageKey, "mat-key-1");
    assert.equal(img.extractedText, "");

    const ppt = store.addClassNoteMaterial(note.id, { kind: "pptx", name: "第3讲.pptx", extractedText: "【第 1 页】\n标题" });
    assert.equal(ppt.kind, "pptx");
    assert.equal(ppt.extractedText, "【第 1 页】\n标题");
    assert.equal(ppt.storageKey, null);

    const found = store.findClassNote(note.id);
    assert.equal(found.materials.length, 2);

    // 不认识的 kind 一律当成 image 处理（防御性默认值，不会因为传参笔误就存出一条脏数据）。
    const fallback = store.addClassNoteMaterial(note.id, { name: "未知类型" });
    assert.equal(fallback.kind, "image");

    // Word 文档跟 PPT 一样，只保留解析出来的文字，不保留文件本身。
    const docx = store.addClassNoteMaterial(note.id, { kind: "docx", name: "讲义.docx", extractedText: "第一章 概述" });
    assert.equal(docx.kind, "docx");
    assert.equal(docx.extractedText, "第一章 概述");
    assert.equal(docx.storageKey, null);
  });

  test("上传材料：按 id 删除，不影响其它材料", () => {
    const note = store.addClassNote({ title: "材料课2" });
    const a = store.addClassNoteMaterial(note.id, { kind: "image", name: "a.jpg", storageKey: "k1" });
    const b = store.addClassNoteMaterial(note.id, { kind: "image", name: "b.jpg", storageKey: "k2" });
    store.removeClassNoteMaterial(note.id, a.id);
    const found = store.findClassNote(note.id);
    assert.equal(found.materials.length, 1);
    assert.equal(found.materials[0].id, b.id);
  });

  test("保存/覆盖思维导图：整段替换，非法值归一化成 null", () => {
    const note = store.addClassNote({ title: "导图课" });
    const tree = { title: "根节点", children: [{ title: "分支1", children: [] }] };
    const updated = store.setClassNoteMindMap(note.id, tree);
    assert.deepEqual(updated.mindMap, tree);

    const tree2 = { title: "新的根节点", children: [] };
    store.setClassNoteMindMap(note.id, tree2);
    assert.deepEqual(store.findClassNote(note.id).mindMap, tree2);

    store.setClassNoteMindMap(note.id, "不是对象");
    assert.equal(store.findClassNote(note.id).mindMap, null);
  });

  test("重命名和删除", () => {
    const note = store.addClassNote({ title: "原标题" });
    store.renameClassNote(note.id, "新标题");
    assert.equal(store.findClassNote(note.id).title, "新标题");
    store.removeClassNote(note.id);
    assert.equal(store.findClassNote(note.id), null);
  });

  test("列表按创建时间倒序", () => {
    store.addClassNote({ title: "第一条" });
    store.addClassNote({ title: "第二条" });
    const list = store.listClassNotes();
    assert.equal(list.length, 2);
    assert.equal(list[0].title, "第二条");
  });

  test("中途修改互译目标语言：整段替换，自动去重、去掉跟讲课语言重复的那个", () => {
    const note = store.addClassNote({ title: "语言课", sourceLang: "fr" });
    assert.deepEqual(note.targetLangs, []); // 一开始没选任何互译语言

    const updated = store.setClassNoteTargetLangs(note.id, ["zh", "en", "zh", "fr"]);
    assert.deepEqual(updated.targetLangs, ["zh", "en"]); // 去重 + 去掉跟讲课语言相同的 fr

    store.setClassNoteTargetLangs(note.id, ["ja"]);
    assert.deepEqual(store.findClassNote(note.id).targetLangs, ["ja"]); // 整段替换，不是追加
  });

  test("整体重新识别：保存结果、翻译，重新生成会清空上一次的翻译", () => {
    const note = store.addClassNote({ title: "重新识别课" });
    assert.equal(store.setClassNoteRetranscriptTranslation(note.id, "zh", [{ text: "你好" }]), null); // 还没生成过 retranscript

    const updated = store.setClassNoteRetranscript(note.id, { provider: "google", segments: [{ text: "Bonjour à tous" }] });
    assert.equal(updated.retranscript.provider, "google");
    assert.equal(updated.retranscript.segments.length, 1);
    assert.deepEqual(updated.retranscript.translations, {});
    assert.ok(updated.retranscript.generatedAt);

    store.setClassNoteRetranscriptTranslation(note.id, "zh", [{ text: "大家好" }]);
    let found = store.findClassNote(note.id);
    assert.deepEqual(found.retranscript.translations.zh, [{ text: "大家好" }]);

    // 重新识别一次：旧的翻译结果被清空（内容已经变了，旧翻译对不上）。
    store.setClassNoteRetranscript(note.id, { provider: "azure", segments: [{ text: "Bonjour" }] });
    found = store.findClassNote(note.id);
    assert.equal(found.retranscript.provider, "azure");
    assert.deepEqual(found.retranscript.translations, {});

    // 传 null 清空整个重新识别结果。
    store.setClassNoteRetranscript(note.id, null);
    assert.equal(store.findClassNote(note.id).retranscript, null);
  });

  test("对不存在的笔记 id 操作，安全返回 null 而不是抛错", () => {
    assert.equal(store.appendClassNoteTranscript("no-such-id", { text: "x" }), null);
    assert.equal(store.finishClassNoteRecording("no-such-id", {}), null);
    assert.equal(store.setClassNoteTranslation("no-such-id", "zh", []), null);
    assert.equal(store.appendClassNoteTranslation("no-such-id", "zh", []), null);
    assert.equal(store.setClassNoteMarkdown("no-such-id", "x"), null);
    assert.equal(store.setClassNoteNotesTranslation("no-such-id", "zh", "x"), null);
    assert.equal(store.setClassNoteFlashcards("no-such-id", []), null);
    assert.equal(store.setClassNoteQuiz("no-such-id", []), null);
    assert.equal(store.setClassNoteQuizAnswer("no-such-id", 0, 0), null);
    assert.equal(store.addClassNoteQaMessage("no-such-id", "user", "x"), null);
    assert.equal(store.renameClassNote("no-such-id", "x"), null);
    assert.equal(store.addClassNoteMaterial("no-such-id", { kind: "image" }), null);
    assert.equal(store.removeClassNoteMaterial("no-such-id", "m1"), null);
    assert.equal(store.setClassNoteMindMap("no-such-id", { title: "x", children: [] }), null);
    assert.equal(store.setClassNoteTargetLangs("no-such-id", ["zh"]), null);
    assert.equal(store.setClassNoteCourseId("no-such-id", "c1"), null);
    assert.equal(store.setClassNoteRetranscript("no-such-id", { segments: [] }), null);
  });

  test("老存档（没有 classNotes 字段）能正常兼容补上空数组", () => {
    const oldArchive = {
      quickNotes: [], todayPlan: [], studyCourses: [], studyAssignments: [],
      studyGoals: [], studyCheckins: [], studyDailyLogs: [], reminders: [],
      mealPlanEntries: [], inventoryItems: [], shoppingListItems: [],
      financeTransactions: [], financeCategories: ["餐饮"], games: [], gameSessions: [],
      settings: {},
    };
    storage.setItem("faner-app-data", JSON.stringify(oldArchive));
    const s = createStore(storage);
    s.init();
    assert.deepEqual(s.listClassNotes(), []);
    const note = s.addClassNote({ title: "新功能测试" });
    assert.ok(note.id);
  });
});

describe("课堂笔记：课程分组", () => {
  test("新建课程、改名、按课程筛选笔记列表", () => {
    const course = store.addClassNoteCourse("  宏观经济学  ");
    assert.equal(course.name, "宏观经济学"); // 自动去掉首尾空格

    const n1 = store.addClassNote({ title: "第1讲", courseId: course.id });
    const n2 = store.addClassNote({ title: "第2讲", courseId: course.id });
    store.addClassNote({ title: "别的课" }); // 未分类

    assert.deepEqual(store.listClassNotes(course.id).map((n) => n.id).sort(), [n1.id, n2.id].sort());
    assert.equal(store.listClassNotes(null).length, 1); // 未分类只有"别的课"这一条
    assert.equal(store.listClassNotes().length, 3); // 不传参数：老行为，返回全部

    store.renameClassNoteCourse(course.id, "宏观经济学（下）");
    assert.equal(store.listClassNoteCourses().find((c) => c.id === course.id).name, "宏观经济学（下）");

    // 空字符串改名：保留原名，不会被清空成空课程名。
    store.renameClassNoteCourse(course.id, "   ");
    assert.equal(store.listClassNoteCourses().find((c) => c.id === course.id).name, "宏观经济学（下）");
  });

  test("笔记可以随时改归属课程", () => {
    const courseA = store.addClassNoteCourse("A课");
    const courseB = store.addClassNoteCourse("B课");
    const note = store.addClassNote({ title: "笔记", courseId: courseA.id });
    store.setClassNoteCourseId(note.id, courseB.id);
    assert.equal(store.findClassNote(note.id).courseId, courseB.id);
    store.setClassNoteCourseId(note.id, null);
    assert.equal(store.findClassNote(note.id).courseId, null);
  });

  test("删除课程不会删掉笔记，笔记会归到「未分类」", () => {
    const course = store.addClassNoteCourse("要删除的课");
    const note = store.addClassNote({ title: "笔记", courseId: course.id });
    store.removeClassNoteCourse(course.id);
    assert.equal(store.listClassNoteCourses().some((c) => c.id === course.id), false);
    assert.equal(store.findClassNote(note.id).courseId, null); // 笔记还在，只是没归属了
  });

  test("带统计的课程列表：笔记数量、最近更新时间，按最近更新倒序", async () => {
    const courseA = store.addClassNoteCourse("A课");
    const courseB = store.addClassNoteCourse("B课");
    store.addClassNote({ title: "A课的笔记1", courseId: courseA.id });
    await new Promise((r) => setTimeout(r, 5));
    store.addClassNote({ title: "B课的笔记1", courseId: courseB.id });

    const list = store.listClassNoteCoursesWithStats();
    assert.equal(list.find((c) => c.id === courseA.id).noteCount, 1);
    assert.equal(list.find((c) => c.id === courseB.id).noteCount, 1);
    assert.equal(list[0].id, courseB.id); // B课更新更晚，排前面
  });
});
