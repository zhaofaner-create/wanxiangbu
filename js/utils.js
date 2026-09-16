(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.utils = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  // 工具函数：ID生成、日期处理、周期提醒计算。
  // 所有日期一律用 'YYYY-MM-DD' 字符串表示，内部用 UTC 的 Date 做计算，
  // 避免时区/夏令时导致「差一天」的问题——这里只关心日历日期，不关心具体时刻。

  const DAY_MS = 24 * 60 * 60 * 1000;
  const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  /** 生成唯一ID。优先用浏览器/Node内置的 crypto.randomUUID()。 */
  function uuid() {
    if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    // 兜底方案（理论上不会用到，现代浏览器和 Node 都支持 randomUUID）
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  /** 把一个 'YYYY-MM-DD' 字符串解析成 UTC 零点的 Date 对象。 */
  function parseDateStr(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
    if (!m) throw new Error(`非法日期字符串: ${dateStr}`);
    const [, y, mo, d] = m;
    return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  }

  /** 把一个 Date 对象格式化成 'YYYY-MM-DD'（按其 UTC 字段）。 */
  function formatDateStr(date) {
    return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
  }

  /** 今天的日期字符串（本机所在时区的"今天"，再转成 YYYY-MM-DD）。 */
  function todayStr(now = new Date()) {
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  }

  /** dateStr 加上 n 天（n 可为负数）。 */
  function addDays(dateStr, n) {
    const d = parseDateStr(dateStr);
    d.setUTCDate(d.getUTCDate() + n);
    return formatDateStr(d);
  }

  /** 比较两个日期字符串：负数表示 a 在 b 之前，0 相等，正数 a 在 b 之后。 */
  function compareDateStr(a, b) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }

  /** 从 dateStr 到今天的天数（today 可传参，默认真实今天）；未来为正数，过去为负数。 */
  function daysUntil(dateStr, today = todayStr()) {
    const d1 = parseDateStr(dateStr).getTime();
    const d2 = parseDateStr(today).getTime();
    return Math.round((d1 - d2) / DAY_MS);
  }

  /** dateStr 是否落在 [today, today+n天] 闭区间内（用于"N天内到期/临期"判断）。 */
  function isWithinDays(dateStr, n, today = todayStr()) {
    const diff = daysUntil(dateStr, today);
    return diff >= 0 && diff <= n;
  }

  /** dateStr 是否已经过去（早于 today）。 */
  function isPast(dateStr, today = todayStr()) {
    return compareDateStr(dateStr, today) < 0;
  }

  /** dateStr 所在自然周的周一日期。 */
  function startOfWeek(dateStr) {
    const d = parseDateStr(dateStr);
    const dow = d.getUTCDay(); // 0=周日 .. 6=周六
    const diffToMonday = (dow + 6) % 7; // 周一=0
    d.setUTCDate(d.getUTCDate() - diffToMonday);
    return formatDateStr(d);
  }

  /** 从某周周一开始的连续7天日期数组。 */
  function weekDates(mondayStr) {
    const out = [];
    for (let i = 0; i < 7; i++) out.push(addDays(mondayStr, i));
    return out;
  }

  /** month 是 'YYYY-MM'，返回加上/减去 delta 个月后的 'YYYY-MM'（跨年正确进位）。 */
  function shiftMonth(month, delta) {
    const [y, m] = month.split("-").map(Number);
    const total = y * 12 + (m - 1) + delta;
    const newY = Math.floor(total / 12);
    const newM = (total % 12) + 1;
    return `${newY}-${pad2(newM)}`;
  }

  /** 展示用的日期格式，如 "9月16日"。 */
  function formatDateDisplay(dateStr) {
    const d = parseDateStr(dateStr);
    return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
  }

  /** 展示用的星期几，如 "周三"。 */
  function weekdayLabel(dateStr) {
    return WEEKDAY_LABELS[parseDateStr(dateStr).getUTCDay()];
  }

  const MONTH_DAY_MAX = 2000000; // 循环保护上限，避免规则异常时死循环

  /**
   * 计算周期性提醒相对参考日期（默认今天）的"下一次"发生日期。
   * - repeat='none'：直接返回锚点日期本身（不存在"下一次"，调用方按一次性提醒处理）。
   * - 若锚点日期本身还没到（晚于参考日期），下一次就是锚点日期本身。
   * - 否则从锚点开始按周期滚动，找到第一个 >= 参考日期 的发生日。
   */
  function computeNextOccurrence(anchorDateStr, repeat, refDateStr = todayStr()) {
    if (repeat === "none") return anchorDateStr;
    if (compareDateStr(anchorDateStr, refDateStr) >= 0) return anchorDateStr;

    const anchor = parseDateStr(anchorDateStr);
    const ref = parseDateStr(refDateStr);
    let guard = 0;

    if (repeat === "daily") {
      const diffDays = Math.ceil((ref.getTime() - anchor.getTime()) / DAY_MS);
      return addDays(anchorDateStr, diffDays);
    }

    if (repeat === "weekly") {
      const diffDays = Math.ceil((ref.getTime() - anchor.getTime()) / DAY_MS);
      const weeks = Math.ceil(diffDays / 7);
      return addDays(anchorDateStr, weeks * 7);
    }

    if (repeat === "monthly") {
      const day = anchor.getUTCDate();
      let cursor = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), day));
      let monthsAdded = 0;
      while (cursor.getTime() < ref.getTime()) {
        monthsAdded += 1;
        cursor = addMonthsClamped(anchor, monthsAdded, day);
        guard += 1;
        if (guard > MONTH_DAY_MAX) throw new Error("computeNextOccurrence: monthly 循环超出保护上限");
      }
      return formatDateStr(cursor);
    }

    if (repeat === "yearly") {
      let yearsAdded = 0;
      let cursor = addYearsClamped(anchor, yearsAdded);
      while (cursor.getTime() < ref.getTime()) {
        yearsAdded += 1;
        cursor = addYearsClamped(anchor, yearsAdded);
        guard += 1;
        if (guard > MONTH_DAY_MAX) throw new Error("computeNextOccurrence: yearly 循环超出保护上限");
      }
      return formatDateStr(cursor);
    }

    throw new Error(`未知的重复规则: ${repeat}`);
  }

  function daysInMonth(year, monthIndex0) {
    // monthIndex0: 0-11；用下个月第0天技巧取当月天数
    return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
  }

  function addMonthsClamped(anchorDate, monthsToAdd, targetDay) {
    const totalMonth = anchorDate.getUTCMonth() + monthsToAdd;
    const year = anchorDate.getUTCFullYear() + Math.floor(totalMonth / 12);
    const monthIndex0 = ((totalMonth % 12) + 12) % 12;
    const clampedDay = Math.min(targetDay, daysInMonth(year, monthIndex0));
    return new Date(Date.UTC(year, monthIndex0, clampedDay));
  }

  function addYearsClamped(anchorDate, yearsToAdd) {
    const year = anchorDate.getUTCFullYear() + yearsToAdd;
    const monthIndex0 = anchorDate.getUTCMonth();
    const clampedDay = Math.min(anchorDate.getUTCDate(), daysInMonth(year, monthIndex0));
    return new Date(Date.UTC(year, monthIndex0, clampedDay));
  }

  return { uuid, parseDateStr, formatDateStr, todayStr, addDays, compareDateStr, daysUntil, isWithinDays, isPast, startOfWeek, weekDates, shiftMonth, formatDateDisplay, weekdayLabel, computeNextOccurrence };
});
