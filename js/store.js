(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.store = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  // 数据层：负责 localStorage 的读写持久化，以及所有模块数据的增删改查。
  // 其他模块（modules/*.js）只通过这里导出的函数操作数据，不直接碰 localStorage。
  //
  // 设计成 createStore(storage) 工厂函数而不是直接的单例，是为了方便测试：
  // 测试时可以注入一个内存里的假 storage，不依赖浏览器环境。
  // 应用运行时使用下面导出的默认单例 `store`，它使用 globalThis.localStorage。

  const { uuid, todayStr, computeNextOccurrence, addDays } = require("./utils.js");

  const STORAGE_KEY = "faner-app-data";
  const SCHEMA_VERSION = 1;

  function defaultState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      quickNotes: [],
      todayPlan: [],
      studyCourses: [],
      studyAssignments: [],
      studyGoals: [],
      studyCheckins: [],
      studyDailyLogs: [],
      reminders: [],
      mealPlanEntries: [],
      inventoryItems: [],
      shoppingListItems: [],
      financeTransactions: [],
      financeCategories: ["餐饮", "交通", "日用", "娱乐", "其他"],
      // 汇率表：1 单位该货币 = 多少人民币。应用本身不联网（"离线可用"是硬性要求），拿不到实时汇率，
      // 所以内置一份大致参考值，用户可以在"个人记账"里自己修改成当前的真实汇率。
      financeExchangeRates: { CNY: 1, EUR: 7.8, USD: 7.1 },
      games: [],
      gameSessions: [],
      settings: {
        homeCards: {
          study: true,
          reminders: true,
          meal: true,
          inventory: true,
          finance: true,
          games: true,
        },
        lastBackupAt: null,
      },
    };
  }

  /** 校验一份数据是否具备根结构要求的所有字段（导入备份时用）。 */
  function isValidDataShape(data) {
    if (!data || typeof data !== "object") return false;
    const required = [
      "quickNotes", "todayPlan", "studyCourses", "studyAssignments",
      "studyGoals", "studyCheckins", "studyDailyLogs", "reminders",
      "mealPlanEntries", "inventoryItems", "shoppingListItems",
      "financeTransactions", "financeCategories", "games", "gameSessions", "settings",
    ];
    return required.every((key) => Object.prototype.hasOwnProperty.call(data, key));
  }

  function createStore(storage) {
    let state = defaultState();

    function persist() {
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
    }

    function init() {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) {
        state = defaultState();
        persist();
        return state;
      }
      try {
        const parsed = JSON.parse(raw);
        if (isValidDataShape(parsed)) {
          state = { ...defaultState(), ...parsed };
        } else {
          state = defaultState();
          persist();
        }
      } catch {
        state = defaultState();
        persist();
      }
      return state;
    }

    function getState() {
      return structuredClone(state);
    }

    // ---------- 快速备忘 ----------
    function addQuickNote(text) {
      const note = { id: uuid(), text, createdAt: new Date().toISOString() };
      state.quickNotes.push(note);
      persist();
      return note;
    }
    function removeQuickNote(id) {
      state.quickNotes = state.quickNotes.filter((n) => n.id !== id);
      persist();
    }
    function listQuickNotes() {
      return [...state.quickNotes].sort((a, b) => a.createdAt < b.createdAt ? 1 : -1);
    }

    // ---------- 今日计划 ----------
    const PRIORITY_LEVELS = ["高", "中", "低"];

    function addTodayPlanItem({
      text, time = null, date = todayStr(), source = "manual", sourceId = null,
      estimatedMinutes = null, priority = "中", note = "",
    }) {
      const item = {
        id: uuid(), date, text, time, done: false, source, sourceId,
        estimatedMinutes: estimatedMinutes ? Number(estimatedMinutes) : null,
        priority: PRIORITY_LEVELS.includes(priority) ? priority : "中",
        note: note || "",
        // 计时相关（见 startTodayPlanTimer 等函数）：elapsedSeconds 是已累计的用时，
        // timerStartedAt 非空表示计时器当前正在跑（其值是本段计时开始的时间戳）。
        elapsedSeconds: 0,
        timerStartedAt: null,
        satisfaction: null,
        createdAt: new Date().toISOString(),
      };
      state.todayPlan.push(item);
      persist();
      return item;
    }

    function findTodayPlanItem(id) {
      return state.todayPlan.find((t) => t.id === id) || null;
    }

    /** 编辑今日计划某一项的基础字段（内容/日期/时间点/预计用时/优先度/备注）。 */
    function updateTodayPlanItem(id, patch) {
      const item = findTodayPlanItem(id);
      if (!item) return null;
      if (patch.text !== undefined) item.text = patch.text;
      if (patch.date !== undefined) item.date = patch.date;
      if (patch.time !== undefined) item.time = patch.time;
      if (patch.note !== undefined) item.note = patch.note;
      if (patch.estimatedMinutes !== undefined) {
        item.estimatedMinutes = patch.estimatedMinutes ? Number(patch.estimatedMinutes) : null;
      }
      if (patch.priority !== undefined && PRIORITY_LEVELS.includes(patch.priority)) {
        item.priority = patch.priority;
      }
      persist();
      return { ...item };
    }

    /** 判断某个关联条目对应的"源记录"当前是否已完成/已处理。 */
    function sourceIsComplete(item) {
      if (item.source === "study") {
        const a = state.studyAssignments.find((x) => x.id === item.sourceId);
        return !!a && a.status === "已完成";
      }
      if (item.source === "reminder") {
        const r = state.reminders.find((x) => x.id === item.sourceId);
        if (!r) return false;
        if (r.repeat !== "none") return false; // 周期性提醒没有"完成"概念
        return r.status === "done";
      }
      return false;
    }

    /** 给可能是旧数据（缺新字段）的今日计划条目补上默认值，避免界面读到 undefined。 */
    function withTodayPlanDefaults(t) {
      return {
        priority: "中", note: "", estimatedMinutes: null,
        elapsedSeconds: 0, timerStartedAt: null, satisfaction: null,
        ...t,
      };
    }

    function listTodayPlan(date = todayStr()) {
      return state.todayPlan
        .filter((t) => t.date === date)
        .map((t) => ({ ...withTodayPlanDefaults(t), effectiveDone: t.done || sourceIsComplete(t) }));
    }

    /** 列出一个日期范围内（含首尾）的今日计划条目，供首页"今日/本周/历史"切换视图使用。 */
    function listTodayPlanRange(startDate, endDate) {
      return state.todayPlan
        .filter((t) => t.date >= startDate && t.date <= endDate)
        .map((t) => ({ ...withTodayPlanDefaults(t), effectiveDone: t.done || sourceIsComplete(t) }))
        .sort((a, b) => (a.date + (a.time || "99:99")).localeCompare(b.date + (b.time || "99:99")));
    }

    /**
     * 勾选/取消勾选今日计划中的一项。
     * 从"未完成"变为"完成"时，如果这一项是关联进来的，同步把源记录（学习任务的作业/一次性提醒）也标记完成。
     * 从"完成"变为"未完成"时，只改这一项本身，不回退源记录的完成状态。
     */
    /** 一项今日计划第一次变成"完成"时，顺带把它关联的源记录（作业/一次性提醒）也标记完成。 */
    function applyTodayPlanDoneSideEffects(item) {
      if (item.source === "study") {
        const a = state.studyAssignments.find((x) => x.id === item.sourceId);
        if (a) a.status = "已完成";
      } else if (item.source === "reminder") {
        const r = state.reminders.find((x) => x.id === item.sourceId);
        if (r && r.repeat === "none") r.status = "done";
      }
    }

    function toggleTodayPlanDone(id) {
      const item = findTodayPlanItem(id);
      if (!item) return null;
      const wasDone = item.done;
      item.done = !item.done;
      if (!wasDone && item.done) {
        applyTodayPlanDoneSideEffects(item);
      }
      persist();
      return { ...item, effectiveDone: item.done || sourceIsComplete(item) };
    }

    /** 累计一段已经在跑的计时到 elapsedSeconds 里，并清空 timerStartedAt（暂停/完成时都要做这一步）。 */
    function flushTodayPlanTimer(item) {
      if (item.timerStartedAt) {
        item.elapsedSeconds = (item.elapsedSeconds || 0) + Math.max(0, Math.round((Date.now() - item.timerStartedAt) / 1000));
        item.timerStartedAt = null;
      }
    }

    /** 开始（或继续）给一条今日计划计时。 */
    function startTodayPlanTimer(id) {
      const item = findTodayPlanItem(id);
      if (!item) return null;
      if (!item.timerStartedAt) {
        item.timerStartedAt = Date.now();
        persist();
      }
      return { ...item };
    }

    /** 暂停计时，把已经跑的这一段累计进 elapsedSeconds。 */
    function pauseTodayPlanTimer(id) {
      const item = findTodayPlanItem(id);
      if (!item) return null;
      flushTodayPlanTimer(item);
      persist();
      return { ...item };
    }

    /** 计时组件的"完成"按钮：先把正在跑的计时累计进去，再标记这一项完成（幂等，可重复调用）。 */
    function finishTodayPlanItem(id) {
      const item = findTodayPlanItem(id);
      if (!item) return null;
      flushTodayPlanTimer(item);
      if (!item.done) {
        item.done = true;
        applyTodayPlanDoneSideEffects(item);
      }
      persist();
      return { ...item, effectiveDone: item.done || sourceIsComplete(item) };
    }

    /** 给已完成的今日计划事项打一个满意度分（1-5星）；传 null 可以清掉。 */
    function setTodayPlanSatisfaction(id, value) {
      const item = findTodayPlanItem(id);
      if (!item) return null;
      item.satisfaction = value === null ? null : Math.min(5, Math.max(1, Math.round(Number(value))));
      persist();
      return { ...item };
    }

    function removeTodayPlanItem(id) {
      state.todayPlan = state.todayPlan.filter((t) => t.id !== id);
      persist();
    }

    /** 把某个学习任务的作业/考试关联进指定日期的今日计划。 */
    function linkAssignmentToToday(assignmentId, date = todayStr()) {
      const a = state.studyAssignments.find((x) => x.id === assignmentId);
      if (!a) return null;
      const already = state.todayPlan.find((t) => t.date === date && t.source === "study" && t.sourceId === assignmentId);
      if (already) return already;
      return addTodayPlanItem({ text: a.title, date, source: "study", sourceId: assignmentId });
    }

    /** 把某条提醒关联进指定日期的今日计划。 */
    function linkReminderToToday(reminderId, date = todayStr()) {
      const r = state.reminders.find((x) => x.id === reminderId);
      if (!r) return null;
      const already = state.todayPlan.find((t) => t.date === date && t.source === "reminder" && t.sourceId === reminderId);
      if (already) return already;
      return addTodayPlanItem({ text: r.title, date, source: "reminder", sourceId: reminderId });
    }

    // ---------- 学习任务：课程 / 作业考试 ----------
    function addCourse(name) {
      const c = { id: uuid(), name, createdAt: new Date().toISOString() };
      state.studyCourses.push(c);
      persist();
      return c;
    }
    function removeCourse(id) {
      state.studyCourses = state.studyCourses.filter((c) => c.id !== id);
      state.studyAssignments = state.studyAssignments.filter((a) => a.courseId !== id);
      persist();
    }
    function listCourses() {
      return [...state.studyCourses];
    }

    function addAssignment({ courseId, title, type = "作业", dueDate, status = "未开始" }) {
      const a = { id: uuid(), courseId, title, type, dueDate, status, createdAt: new Date().toISOString() };
      state.studyAssignments.push(a);
      persist();
      return a;
    }
    function updateAssignment(id, patch) {
      const a = state.studyAssignments.find((x) => x.id === id);
      if (!a) return null;
      Object.assign(a, patch);
      persist();
      return { ...a };
    }
    function removeAssignment(id) {
      state.studyAssignments = state.studyAssignments.filter((a) => a.id !== id);
      persist();
    }
    function listAssignments(courseId = null) {
      const all = state.studyAssignments;
      return courseId ? all.filter((a) => a.courseId === courseId) : [...all];
    }
    /** 跨课程按截止日期排序的未完成条目，供"最近到期"展示。 */
    function listUpcomingAssignments(limit = 5) {
      return state.studyAssignments
        .filter((a) => a.status !== "已完成")
        .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0))
        .slice(0, limit);
    }

    // ---------- 学习任务：学习目标 / 打卡 / 学习记录 ----------
    function addGoal(name) {
      const g = { id: uuid(), name, createdAt: new Date().toISOString(), timerStartedAt: null, todayFocus: null };
      state.studyGoals.push(g);
      persist();
      return g;
    }
    function removeGoal(id) {
      state.studyGoals = state.studyGoals.filter((g) => g.id !== id);
      state.studyCheckins = state.studyCheckins.filter((c) => c.goalId !== id);
      persist();
    }
    function listGoals() {
      return [...state.studyGoals];
    }
    function findGoal(id) {
      return state.studyGoals.find((g) => g.id === id) || null;
    }

    /** 拿到（必要时新建）某个学习目标"今天"的专注计时统计；跨天了会自动清零重新开始统计。 */
    function ensureGoalTodayFocus(goal, date = todayStr()) {
      if (!goal.todayFocus || goal.todayFocus.date !== date) {
        goal.todayFocus = { date, elapsedSeconds: 0, pauseCount: 0, firstStartAt: null, lastStopAt: null };
      }
      return goal.todayFocus;
    }

    /** 开始（或继续）给一个学习目标计时，用于统计今天在它上面花的专注时间。 */
    function startGoalTimer(id) {
      const goal = findGoal(id);
      if (!goal) return null;
      const focus = ensureGoalTodayFocus(goal);
      if (!goal.timerStartedAt) {
        goal.timerStartedAt = Date.now();
        if (!focus.firstStartAt) focus.firstStartAt = goal.timerStartedAt;
        persist();
      }
      return { ...goal };
    }

    /** 暂停学习目标的计时：累计这一段用时，并记一次"暂停"（用于后面算专注度）。 */
    function pauseGoalTimer(id) {
      const goal = findGoal(id);
      if (!goal) return null;
      const focus = ensureGoalTodayFocus(goal);
      if (goal.timerStartedAt) {
        const segmentSeconds = Math.max(0, Math.round((Date.now() - goal.timerStartedAt) / 1000));
        focus.elapsedSeconds += segmentSeconds;
        focus.pauseCount += 1;
        focus.lastStopAt = Date.now();
        goal.timerStartedAt = null;
        persist();
      }
      return { ...goal };
    }

    /** 汇总"今天"所有学习目标的计时数据，供学习报告使用；不管计时器是不是还在跑，都会把正在跑的这一段也算进去。 */
    function listGoalsWithTodayFocus(date = todayStr()) {
      return state.studyGoals.map((g) => {
        const focus = g.todayFocus && g.todayFocus.date === date ? g.todayFocus : { date, elapsedSeconds: 0, pauseCount: 0, firstStartAt: null, lastStopAt: null };
        const running = g.timerStartedAt ? Math.max(0, Math.round((Date.now() - g.timerStartedAt) / 1000)) : 0;
        return {
          id: g.id, name: g.name,
          elapsedSeconds: focus.elapsedSeconds + running,
          pauseCount: focus.pauseCount,
          firstStartAt: focus.firstStartAt,
          lastStopAt: g.timerStartedAt ? Date.now() : focus.lastStopAt,
          running: !!g.timerStartedAt,
        };
      });
    }
    function checkinGoal(goalId, date = todayStr()) {
      const exists = state.studyCheckins.find((c) => c.goalId === goalId && c.date === date);
      if (exists) return exists;
      const c = { id: uuid(), goalId, date };
      state.studyCheckins.push(c);
      persist();
      return c;
    }
    function isCheckedIn(goalId, date = todayStr()) {
      return state.studyCheckins.some((c) => c.goalId === goalId && c.date === date);
    }
    function countCheckins(goalId) {
      return state.studyCheckins.filter((c) => c.goalId === goalId).length;
    }
    function setDailyLog(date, text) {
      const existing = state.studyDailyLogs.find((l) => l.date === date);
      if (existing) {
        existing.text = text;
      } else {
        state.studyDailyLogs.push({ id: uuid(), date, text });
      }
      persist();
    }
    function getDailyLog(date = todayStr()) {
      return state.studyDailyLogs.find((l) => l.date === date)?.text ?? "";
    }

    // ---------- 提醒事项 ----------
    function addReminder({ title, date, repeat = "none", note = "" }) {
      const r = { id: uuid(), title, date, repeat, note, status: "pending", createdAt: new Date().toISOString() };
      state.reminders.push(r);
      persist();
      return r;
    }
    function updateReminder(id, patch) {
      const r = state.reminders.find((x) => x.id === id);
      if (!r) return null;
      Object.assign(r, patch);
      persist();
      return { ...r };
    }
    function removeReminder(id) {
      state.reminders = state.reminders.filter((r) => r.id !== id);
      persist();
    }
    function markReminderDone(id) {
      const r = state.reminders.find((x) => x.id === id);
      if (!r || r.repeat !== "none") return null;
      r.status = "done";
      persist();
      return { ...r };
    }
    function listReminders() {
      return [...state.reminders];
    }
    /** 提醒的展示用视图：附上按参考日期算出的下一次发生日期。 */
    function listRemindersWithNextDate(refDate = todayStr()) {
      return state.reminders.map((r) => ({
        ...r,
        nextDate: computeNextOccurrence(r.date, r.repeat, refDate),
      }));
    }

    // ---------- 饮食计划 ----------
    function setMealEntry(date, slot, text) {
      const existing = state.mealPlanEntries.find((e) => e.date === date && e.slot === slot);
      if (existing) {
        existing.text = text;
      } else {
        state.mealPlanEntries.push({ id: uuid(), date, slot, text });
      }
      persist();
    }
    function getMealEntry(date, slot) {
      return state.mealPlanEntries.find((e) => e.date === date && e.slot === slot)?.text ?? "";
    }
    function listMealEntriesForWeek(mondayStr) {
      const dates = new Set([0, 1, 2, 3, 4, 5, 6].map((i) => addDays(mondayStr, i)));
      return state.mealPlanEntries.filter((e) => dates.has(e.date));
    }
    /** 把从 fromMonday 开始那一周的三餐安排，整体复制到 toMonday 开始的那一周（按相同偏移量）。 */
    function copyWeek(fromMonday, toMonday) {
      const offsetDays = Math.round(
        (Date.parse(toMonday) - Date.parse(fromMonday)) / (24 * 60 * 60 * 1000)
      );
      const entries = listMealEntriesForWeek(fromMonday);
      entries.forEach((e) => {
        const targetDate = addDays(e.date, offsetDays);
        setMealEntry(targetDate, e.slot, e.text);
      });
      return entries.length;
    }

    // ---------- 生活用品库存 / 购物清单 ----------
    function addInventoryItem({ name, quantity = 0, unit = "", lowThreshold = 0, expiryDate = null }) {
      const item = { id: uuid(), name, quantity, unit, lowThreshold, expiryDate, createdAt: new Date().toISOString() };
      state.inventoryItems.push(item);
      persist();
      syncShoppingListFromLowStock();
      return item;
    }
    function updateInventoryItem(id, patch) {
      const item = state.inventoryItems.find((x) => x.id === id);
      if (!item) return null;
      Object.assign(item, patch);
      persist();
      syncShoppingListFromLowStock();
      return { ...item };
    }
    function removeInventoryItem(id) {
      state.inventoryItems = state.inventoryItems.filter((x) => x.id !== id);
      state.shoppingListItems = state.shoppingListItems.filter((s) => s.linkedItemId !== id);
      persist();
    }
    function listInventoryItems() {
      return [...state.inventoryItems];
    }
    function isLowStock(item) {
      return item.quantity <= item.lowThreshold;
    }

    function addShoppingItem({ name, linkedItemId = null }) {
      const s = { id: uuid(), name, linkedItemId, createdAt: new Date().toISOString() };
      state.shoppingListItems.push(s);
      persist();
      return s;
    }
    function removeShoppingItem(id) {
      state.shoppingListItems = state.shoppingListItems.filter((s) => s.id !== id);
      persist();
    }
    function listShoppingItems() {
      return [...state.shoppingListItems];
    }
    /** 确保每个低库存物品在购物清单里都有对应条目（没有才补，不会重复添加）。 */
    function syncShoppingListFromLowStock() {
      const lowStockItems = state.inventoryItems.filter(isLowStock);
      lowStockItems.forEach((item) => {
        const alreadyListed = state.shoppingListItems.some((s) => s.linkedItemId === item.id);
        if (!alreadyListed) {
          state.shoppingListItems.push({ id: uuid(), name: item.name, linkedItemId: item.id, createdAt: new Date().toISOString() });
        }
      });
      persist();
    }

    // ---------- 个人记账 ----------
    const CURRENCIES = ["CNY", "EUR", "USD"];

    /** 汇率表（1 单位该货币 = 多少人民币），供界面展示和手动修改。 */
    function getExchangeRates() {
      return { ...state.financeExchangeRates };
    }
    /** 修改一种货币对人民币的汇率（不能改人民币自己的 1:1）。 */
    function setExchangeRate(currency, rate) {
      if (currency === "CNY") return getExchangeRates();
      const n = Number(rate);
      if (!Number.isFinite(n) || n <= 0) return getExchangeRates();
      state.financeExchangeRates = { ...state.financeExchangeRates, [currency]: n };
      persist();
      return getExchangeRates();
    }
    /** 按当前汇率表把一笔金额换算成人民币等值（用于汇总统计）。 */
    function convertToCNY(amount, currency) {
      const rate = state.financeExchangeRates[currency] ?? 1;
      return Math.round(amount * rate * 100) / 100;
    }

    function addTransaction({ amount, currency = "CNY", type, category, date = todayStr(), note = "" }) {
      const amountCNY = convertToCNY(amount, currency);
      const t = { id: uuid(), amount, currency, amountCNY, type, category, date, note, createdAt: new Date().toISOString() };
      state.financeTransactions.push(t);
      persist();
      return t;
    }
    /** 修改一笔已有记录（金额/币种/分类/日期/备注等），不需要删除重新录入。金额或币种变了就重新按当前汇率换算成人民币等值。 */
    function updateTransaction(id, patch) {
      const t = state.financeTransactions.find((x) => x.id === id);
      if (!t) return null;
      Object.assign(t, patch);
      if (!CURRENCIES.includes(t.currency)) t.currency = "CNY";
      t.amountCNY = convertToCNY(t.amount, t.currency);
      persist();
      return { ...t };
    }
    function removeTransaction(id) {
      state.financeTransactions = state.financeTransactions.filter((t) => t.id !== id);
      persist();
    }
    function listTransactions({ month = null } = {}) {
      const all = state.financeTransactions.map((t) => ({ currency: "CNY", amountCNY: t.amount, ...t }));
      if (!month) return all;
      return all.filter((t) => t.date.startsWith(month)); // month: 'YYYY-MM'
    }
    function addCategory(name) {
      if (!state.financeCategories.includes(name)) {
        state.financeCategories.push(name);
        persist();
      }
    }
    function removeCategory(name) {
      state.financeCategories = state.financeCategories.filter((c) => c !== name);
      persist();
    }
    function listCategories() {
      return [...state.financeCategories];
    }

    // ---------- 游戏娱乐 ----------
    function addGame({ name, status = "想玩", note = "" }) {
      const g = { id: uuid(), name, status, note, createdAt: new Date().toISOString() };
      state.games.push(g);
      persist();
      return g;
    }
    function updateGame(id, patch) {
      const g = state.games.find((x) => x.id === id);
      if (!g) return null;
      Object.assign(g, patch);
      persist();
      return { ...g };
    }
    function removeGame(id) {
      state.games = state.games.filter((g) => g.id !== id);
      state.gameSessions = state.gameSessions.filter((s) => s.gameId !== id);
      persist();
    }
    function listGames(status = null) {
      const all = state.games;
      return status ? all.filter((g) => g.status === status) : [...all];
    }
    function addPlaySession({ gameId, date = todayStr(), minutes }) {
      const s = { id: uuid(), gameId, date, minutes, createdAt: new Date().toISOString() };
      state.gameSessions.push(s);
      persist();
      return s;
    }
    function listSessions(gameId) {
      return state.gameSessions.filter((s) => s.gameId === gameId);
    }
    function totalMinutesForGame(gameId) {
      return state.gameSessions
        .filter((s) => s.gameId === gameId)
        .reduce((sum, s) => sum + s.minutes, 0);
    }

    // ---------- 设置 ----------
    function getSettings() {
      return { ...state.settings, homeCards: { ...state.settings.homeCards } };
    }
    function updateHomeCardVisibility(key, visible) {
      state.settings.homeCards[key] = visible;
      persist();
    }
    function setLastBackupAt(iso) {
      state.settings.lastBackupAt = iso;
      persist();
    }

    // ---------- 备份 / 恢复 / 清空 ----------
    function exportBackup() {
      return JSON.stringify({ schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), data: state });
    }
    function importBackup(jsonString) {
      let parsed;
      try {
        parsed = JSON.parse(jsonString);
      } catch {
        throw new Error("备份文件不是合法的 JSON");
      }
      if (!parsed || typeof parsed !== "object" || !("data" in parsed) || !("schemaVersion" in parsed)) {
        throw new Error("备份文件缺少必要字段（schemaVersion / data）");
      }
      if (!isValidDataShape(parsed.data)) {
        throw new Error("备份文件的数据结构不完整");
      }
      state = { ...defaultState(), ...parsed.data };
      setLastBackupAt(new Date().toISOString());
      persist();
    }
    function resetAll() {
      state = defaultState();
      persist();
    }

    return {
      init, getState, persist,
      addQuickNote, removeQuickNote, listQuickNotes,
      addTodayPlanItem, toggleTodayPlanDone, removeTodayPlanItem, listTodayPlan, updateTodayPlanItem, listTodayPlanRange,
      startTodayPlanTimer, pauseTodayPlanTimer, finishTodayPlanItem, setTodayPlanSatisfaction,
      linkAssignmentToToday, linkReminderToToday,
      addCourse, removeCourse, listCourses,
      addAssignment, updateAssignment, removeAssignment, listAssignments, listUpcomingAssignments,
      addGoal, removeGoal, listGoals, checkinGoal, isCheckedIn, countCheckins, setDailyLog, getDailyLog,
      startGoalTimer, pauseGoalTimer, listGoalsWithTodayFocus,
      addReminder, updateReminder, removeReminder, markReminderDone, listReminders, listRemindersWithNextDate,
      setMealEntry, getMealEntry, listMealEntriesForWeek, copyWeek,
      addInventoryItem, updateInventoryItem, removeInventoryItem, listInventoryItems, isLowStock,
      addShoppingItem, removeShoppingItem, listShoppingItems, syncShoppingListFromLowStock,
      addTransaction, updateTransaction, removeTransaction, listTransactions, addCategory, removeCategory, listCategories,
      getExchangeRates, setExchangeRate, CURRENCIES,
      addGame, updateGame, removeGame, listGames, addPlaySession, listSessions, totalMinutesForGame,
      getSettings, updateHomeCardVisibility, setLastBackupAt,
      exportBackup, importBackup, resetAll,
    };
  }

  function browserLocalStorageAdapter() {
    return {
      getItem: (k) => globalThis.localStorage.getItem(k),
      setItem: (k, v) => globalThis.localStorage.setItem(k, v),
    };
  }

  /** 应用运行时使用的默认单例，基于浏览器的 localStorage。 */
  const store = createStore(browserLocalStorageAdapter());

  return { STORAGE_KEY, SCHEMA_VERSION, createStore, store };
});
