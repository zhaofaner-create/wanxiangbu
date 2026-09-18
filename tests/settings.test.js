// "数据与设置"页面里可以脱离浏览器单独测的纯逻辑：目前只有备份文件名的生成规则。
// 分享/下载这两条路径本身要真的点按钮触发浏览器行为，这部分覆盖在
// tests/e2e/app.e2e.test.js 里；这里只测"文件名到底长什么样"，跑得快、不用开浏览器。
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { backupFilename } = require("../js/modules/settings.js");

describe("settings：backupFilename 备份文件名生成规则", () => {
  test("文件名以万象簿备份开头、.json 结尾，中间带上日期时间", () => {
    const name = backupFilename(new Date("2026-09-18T14:30:05Z"));
    assert.match(name, /^万象簿备份-.+\.json$/);
    assert.equal(name, "万象簿备份-2026-09-18-14-30-05.json");
  });

  test("不同时刻生成的文件名不一样，方便认出哪份是最新的", () => {
    const a = backupFilename(new Date("2026-09-18T09:00:00Z"));
    const b = backupFilename(new Date("2026-09-18T09:00:01Z"));
    assert.notEqual(a, b);
  });

  test("文件名里不含冒号等在 Windows/macOS 下不能直接用作文件名的字符", () => {
    const name = backupFilename(new Date("2026-09-18T14:30:05Z"));
    assert.doesNotMatch(name, /[:*?"<>|]/);
  });
});
