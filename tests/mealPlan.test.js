const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

// mealPlan.js 用的是浏览器端的 UMD-lite 写法：Node 环境下靠 global.__fanerRequire
// 兜底成普通 require。这里只测试它导出的两个纯函数（食材文本 <-> 结构化数据的互转），
// 不涉及任何 DOM 操作，所以不需要真的渲染页面。
global.__fanerRequire = global.__fanerRequire || require;
const mealPlan = require("../js/modules/mealPlan.js");

describe("饮食计划：菜谱食材文本解析（常用菜谱库功能的输入格式）", () => {
  test("解析「名称,数量,单位」格式，数量单位可以留空", () => {
    const parsed = mealPlan.parseIngredientsText("番茄,2,个\n鸡蛋,3,个\n盐,,少许");
    assert.deepEqual(parsed, [
      { name: "番茄", quantity: 2, unit: "个" },
      { name: "鸡蛋", quantity: 3, unit: "个" },
      { name: "盐", quantity: null, unit: "少许" },
    ]);
  });

  test("忽略空行和只有空白的行", () => {
    const parsed = mealPlan.parseIngredientsText("番茄,2,个\n\n   \n鸡蛋,3,个");
    assert.equal(parsed.length, 2);
  });

  test("完全没填数量和单位，只写名字也能解析", () => {
    const parsed = mealPlan.parseIngredientsText("葱");
    assert.deepEqual(parsed, [{ name: "葱", quantity: null, unit: "" }]);
  });

  test("非法数字的数量会被当成没填（null），不会存进 NaN", () => {
    const parsed = mealPlan.parseIngredientsText("番茄,abc,个");
    assert.equal(parsed[0].quantity, null);
  });

  test("空字符串解析为空数组", () => {
    assert.deepEqual(mealPlan.parseIngredientsText(""), []);
    assert.deepEqual(mealPlan.parseIngredientsText(null), []);
  });

  test("formatIngredientsText 和 parseIngredientsText 互为逆操作（往返不丢数据）", () => {
    const original = [
      { name: "番茄", quantity: 2, unit: "个" },
      { name: "盐", quantity: null, unit: "少许" },
    ];
    const roundTripped = mealPlan.parseIngredientsText(mealPlan.formatIngredientsText(original));
    assert.deepEqual(roundTripped, original);
  });
});
