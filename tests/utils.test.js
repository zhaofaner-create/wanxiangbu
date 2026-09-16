const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  uuid,
  parseDateStr,
  formatDateStr,
  todayStr,
  addDays,
  shiftMonth,
  compareDateStr,
  daysUntil,
  isWithinDays,
  isPast,
  startOfWeek,
  weekDates,
  weekdayLabel,
  computeNextOccurrence,
} = require("../js/utils.js");

describe("uuid", () => {
  test("生成非空且互不相同的ID", () => {
    const a = uuid();
    const b = uuid();
    assert.ok(typeof a === "string" && a.length > 0);
    assert.notEqual(a, b);
  });
});

describe("日期解析与格式化", () => {
  test("parseDateStr 对非法输入抛错", () => {
    assert.throws(() => parseDateStr("2026/09/16"));
    assert.throws(() => parseDateStr("not-a-date"));
  });

  test("formatDateStr 与 parseDateStr 互为逆运算", () => {
    const s = "2026-09-16";
    assert.equal(formatDateStr(parseDateStr(s)), s);
  });

  test("todayStr 根据传入的 now 计算日期（本地时区字段）", () => {
    const now = new Date(2026, 8, 16, 10, 30); // 2026-09-16 本地时间
    assert.equal(todayStr(now), "2026-09-16");
  });
});

describe("addDays / compareDateStr", () => {
  test("加正数天数，跨月正确进位", () => {
    assert.equal(addDays("2026-01-28", 5), "2026-02-02");
  });

  test("加负数天数，跨月正确退位", () => {
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  });

  test("闰年2月处理正确", () => {
    assert.equal(addDays("2024-02-28", 1), "2024-02-29"); // 2024是闰年
    assert.equal(addDays("2025-02-28", 1), "2025-03-01"); // 2025不是闰年
  });

  test("compareDateStr 大小关系", () => {
    assert.equal(compareDateStr("2026-01-01", "2026-01-02"), -1);
    assert.equal(compareDateStr("2026-01-02", "2026-01-01"), 1);
    assert.equal(compareDateStr("2026-01-01", "2026-01-01"), 0);
  });
});

describe("shiftMonth", () => {
  test("月内前进/后退", () => {
    assert.equal(shiftMonth("2026-09", 1), "2026-10");
    assert.equal(shiftMonth("2026-09", -1), "2026-08");
  });

  test("跨年正确进位/退位", () => {
    assert.equal(shiftMonth("2026-12", 1), "2027-01");
    assert.equal(shiftMonth("2026-01", -1), "2025-12");
  });

  test("跨多年", () => {
    assert.equal(shiftMonth("2026-06", 20), "2028-02");
  });
});

describe("daysUntil / isWithinDays / isPast", () => {
  const today = "2026-09-16";

  test("未来日期天数为正", () => {
    assert.equal(daysUntil("2026-09-20", today), 4);
  });

  test("过去日期天数为负", () => {
    assert.equal(daysUntil("2026-09-10", today), -6);
  });

  test("今天本身天数为0", () => {
    assert.equal(daysUntil(today, today), 0);
  });

  test("isWithinDays 判断7天内到期（含今天，不含超出范围）", () => {
    assert.equal(isWithinDays("2026-09-16", 7, today), true); // 今天
    assert.equal(isWithinDays("2026-09-23", 7, today), true); // 第7天
    assert.equal(isWithinDays("2026-09-24", 7, today), false); // 第8天，超出
    assert.equal(isWithinDays("2026-09-15", 7, today), false); // 已过期，不算"临期"
  });

  test("isPast 判断是否已过期", () => {
    assert.equal(isPast("2026-09-15", today), true);
    assert.equal(isPast("2026-09-16", today), false);
    assert.equal(isPast("2026-09-17", today), false);
  });
});

describe("startOfWeek / weekDates / weekdayLabel", () => {
  test("2026-09-16 是周三，对应周一是 2026-09-14（环境日期已知的基准事实）", () => {
    assert.equal(weekdayLabel("2026-09-16"), "周三");
    assert.equal(startOfWeek("2026-09-16"), "2026-09-14");
  });

  test("周一自身的 startOfWeek 是它本身", () => {
    assert.equal(startOfWeek("2026-09-14"), "2026-09-14");
  });

  test("周日的 startOfWeek 是上一个周一", () => {
    assert.equal(startOfWeek("2026-09-20"), "2026-09-14");
  });

  test("weekDates 返回从周一开始连续7天，且星期标签顺序固定", () => {
    const monday = startOfWeek("2026-09-16");
    const dates = weekDates(monday);
    assert.equal(dates.length, 7);
    assert.deepEqual(
      dates.map(weekdayLabel),
      ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    );
    assert.equal(dates[0], "2026-09-14");
    assert.equal(dates[6], "2026-09-20");
  });
});

describe("computeNextOccurrence", () => {
  test("repeat=none 时直接返回锚点日期", () => {
    assert.equal(computeNextOccurrence("2026-09-01", "none", "2026-09-16"), "2026-09-01");
  });

  test("锚点日期本身还没到，直接返回锚点日期", () => {
    assert.equal(computeNextOccurrence("2026-10-01", "monthly", "2026-09-16"), "2026-10-01");
  });

  test("daily：下一次就是参考日期当天", () => {
    assert.equal(computeNextOccurrence("2026-01-01", "daily", "2026-03-05"), "2026-03-05");
  });

  test("weekly：按7天周期滚动到参考日期之后最近一次", () => {
    // 锚点每周四发生一次；参考日期是下下周四之前一天
    assert.equal(computeNextOccurrence("2026-01-01", "weekly", "2026-01-10"), "2026-01-15");
  });

  test("monthly：按日期滚动，月末自动裁剪（1月31日 -> 2月28日 -> 3月31日）", () => {
    assert.equal(computeNextOccurrence("2026-01-31", "monthly", "2026-03-01"), "2026-03-31");
  });

  test("monthly：参考日期恰好落在某次发生日之后不久", () => {
    // 每月16日缴费，参考日期是9月17日 -> 下一次应该是10月16日
    assert.equal(computeNextOccurrence("2026-08-16", "monthly", "2026-09-17"), "2026-10-16");
  });

  test("yearly：闰年2月29日锚点，非闰年裁剪为2月28日", () => {
    assert.equal(computeNextOccurrence("2024-02-29", "yearly", "2026-01-01"), "2026-02-28");
  });

  test("未知重复规则抛错", () => {
    assert.throws(() => computeNextOccurrence("2026-01-01", "biweekly", "2026-02-01"));
  });
});
