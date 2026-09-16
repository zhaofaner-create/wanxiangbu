// 真机端到端测试：用 Playwright 启动一个真实的无头 Chromium，直接打开 index.html
// （file:// 协议，不经过任何服务器），像真人一样点按钮、填表单，验证界面和数据真的对得上。
// 这一层覆盖的是 store.js/derived.js 单元测试覆盖不到的部分：DOM 渲染、事件绑定、跨模块页面跳转。
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { gotoApp, goToModule, fillModal, submitModal } from "./helpers.js";

let browser;
let context;
let page;
let networkViolations;

before(async () => {
  // --no-sandbox：这个沙箱容器没有普通用户命名空间权限，Chromium 默认沙箱模式起不来。
  browser = await chromium.launch({ args: ["--no-sandbox"] });
});

after(async () => {
  await browser.close();
});

beforeEach(async () => {
  context = await browser.newContext({ acceptDownloads: true }); // 每个测试独立的存储分区，天然隔离 localStorage
  page = await context.newPage();
  networkViolations = await gotoApp(page);
});

afterEach(async () => {
  await context.close();
});

describe("整体框架", () => {
  test("加载后默认停在首页，导航栏有9个模块入口，且没有任何登录界面（PRD验收标准2：免登录）", async () => {
    await assert.doesNotReject(page.waitForSelector(".topbar-title"));
    const title = await page.locator("#topbar-title").innerText();
    assert.equal(title, "首页总览");
    const navCount = await page.locator(".nav-item").count();
    assert.equal(navCount, 9);
    assert.equal(await page.locator('input[type=password]').count(), 0);
    assert.equal(await page.locator("text=登录").count(), 0);
  });

  test("点击导航能正确切换页面标题", async () => {
    await goToModule(page, "个人记账");
    assert.equal(await page.locator("#topbar-title").innerText(), "个人记账");
    await goToModule(page, "游戏娱乐");
    assert.equal(await page.locator("#topbar-title").innerText(), "游戏娱乐");
  });

  test("侧边导航按'日常/学习/生活/系统'分组显示，每一项前面都有图标", async () => {
    const groups = page.locator(".nav-group");
    assert.equal(await groups.count(), 4);

    const expected = {
      "日常": ["首页总览", "今日计划"],
      "学习": ["学习任务", "提醒事项"],
      "生活": ["饮食计划", "库存管理", "个人记账", "游戏娱乐"],
      "系统": ["数据与设置"],
    };
    for (let i = 0; i < 4; i++) {
      const group = groups.nth(i);
      const groupTitle = await group.locator(".nav-group-title").innerText();
      assert.ok(expected[groupTitle], `出现了没预期到的分组：${groupTitle}`);
      const items = group.locator(".nav-item");
      assert.equal(await items.count(), expected[groupTitle].length);
      for (let j = 0; j < expected[groupTitle].length; j++) {
        assert.equal(await items.nth(j).innerText(), expected[groupTitle][j]);
        // 每一项都应该带一个图标，不是光秃秃的文字。
        assert.equal(await items.nth(j).locator("svg.nav-icon").count(), 1);
      }
    }
  });
});

describe("快速备忘（PRD验收标准12：任意页面看到的都是同一份）", () => {
  test("在首页添加的备忘，切换到其他模块页面仍能看到", async () => {
    await page.locator(".quick-memo-btn").click();
    await page.locator(".quick-memo-panel input[type=text]").fill("记得给护照续签预约");
    await page.locator(".quick-memo-panel button", { hasText: "添加" }).click();
    await assert.doesNotReject(page.locator(".quick-memo-item", { hasText: "记得给护照续签预约" }).waitFor());

    await goToModule(page, "游戏娱乐");
    await page.locator(".quick-memo-btn").click();
    await assert.doesNotReject(page.locator(".quick-memo-item", { hasText: "记得给护照续签预约" }).waitFor());
  });
});

describe("今日计划", () => {
  test("手动添加事项并勾选完成", async () => {
    await goToModule(page, "今日计划");
    await page.locator("button", { hasText: "+ 添加今日事项" }).click();
    await fillModal(page, { text: "去超市买米" });
    await submitModal(page);

    const row = page.locator(".check-row", { hasText: "去超市买米" });
    await assert.doesNotReject(row.waitFor());
    assert.equal(await row.evaluate((el) => el.classList.contains("done")), false);

    await row.locator("input[type=checkbox]").click();
    assert.equal(await row.evaluate((el) => el.classList.contains("done")), true);
  });

  test("添加事项时可以填写日期/预计用时/优先度/备注，之后可以编辑修改", async () => {
    await goToModule(page, "今日计划");
    await page.locator("button", { hasText: "+ 添加今日事项" }).click();
    await fillModal(page, { text: "写周报", estimatedMinutes: "30", priority: "高", note: "记得抄送经理" });
    await submitModal(page);

    const block = page.locator(".check-row-block", { hasText: "写周报" });
    await assert.doesNotReject(block.waitFor());
    assert.match(await block.innerText(), /预计 30 分钟/);
    assert.match(await block.innerText(), /记得抄送经理/);
    assert.equal(await block.locator(".check-row .badge").first().innerText(), "高");

    await block.locator(".row-edit").click();
    await fillModal(page, { priority: "低", note: "已经抄送过了" });
    await submitModal(page);

    const updatedBlock = page.locator(".check-row-block", { hasText: "写周报" });
    assert.equal(await updatedBlock.locator(".check-row .badge").first().innerText(), "低");
    assert.match(await updatedBlock.innerText(), /已经抄送过了/);
  });

  test("计时器：开始/暂停会累计用时并显示进度条，点完成后归档为已用时", async () => {
    await goToModule(page, "今日计划");
    await page.locator("button", { hasText: "+ 添加今日事项" }).click();
    await fillModal(page, { text: "深度工作", estimatedMinutes: "1" });
    await submitModal(page);

    const block = page.locator(".check-row-block", { hasText: "深度工作" });
    await assert.doesNotReject(block.waitFor());
    await assert.doesNotReject(block.locator(".progress-bar").waitFor()); // 填了预计用时才会显示进度条

    await block.locator("button", { hasText: "开始计时" }).click();
    await assert.doesNotReject(block.locator("button", { hasText: "暂停" }).waitFor());
    await new Promise((resolve) => setTimeout(resolve, 2200));
    await block.locator("button", { hasText: "暂停" }).click();

    const afterPause = await block.innerText();
    const firstRun = Number((afterPause.match(/已用时 (\d+)秒/) || [])[1] || 0);
    assert.ok(firstRun >= 1, `暂停后应该已经累计了至少1秒，实际读到：${afterPause}`);

    // 恢复计时再跑一段，验证多次开始/暂停是累加而不是被清零
    await block.locator("button", { hasText: "开始计时" }).click();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await block.locator("button", { hasText: "完成" }).click();

    // 完成之后会弹出满意度打分弹窗，选一个星级
    const satisfactionModal = page.locator(".modal-overlay", { hasText: "完成得怎么样" });
    await assert.doesNotReject(satisfactionModal.waitFor());
    await satisfactionModal.locator("button", { hasText: /^★{4}$/ }).click();
    await assert.doesNotReject(satisfactionModal.waitFor({ state: "detached" }));

    const doneBlock = page.locator(".check-row-block", { hasText: "深度工作" });
    await assert.doesNotReject(doneBlock.locator(".check-row.done").waitFor());
    assert.match(await doneBlock.innerText(), /用时/);
    assert.match(await doneBlock.innerText(), /★★★★☆/); // 4星：4个实心+1个空心
    // 完成之后不应该再出现开始/暂停/完成这些操作按钮了
    assert.equal(await doneBlock.locator("button", { hasText: "开始计时" }).count(), 0);
    assert.equal(await doneBlock.locator("button", { hasText: "完成" }).count(), 0);
  });
});

describe("学习任务 ↔ 今日计划 关联同步（PRD验收标准4）", () => {
  test("从今日计划关联一条作业并勾选完成，学习任务里的状态同步为已完成", async () => {
    await goToModule(page, "学习任务");
    await page.locator("button", { hasText: "+ 添加课程" }).click();
    await fillModal(page, { name: "微观经济学" });
    await submitModal(page);

    await page.locator(".collapsible-header", { hasText: "微观经济学" }).click();
    await page.locator("button", { hasText: "+ 添加作业/考试" }).click();
    await fillModal(page, { title: "第三章作业", type: "作业", dueDate: "2026-09-20" });
    await submitModal(page);
    // 注意：这条作业同时会出现在"最近到期"提醒卡片和课程自己的作业列表里
    // （两处都是有意的交叉展示，PRD要求首页/各模块能互相看到摘要），
    // 所以这里要精确限定到课程作业列表里的那一行，避免匹配到两个同名节点。
    await assert.doesNotReject(page.locator(".assignment-list .list-row", { hasText: "第三章作业" }).waitFor());

    await goToModule(page, "今日计划");
    await page.locator("button", { hasText: "关联事项" }).click();
    // 点击"+"关联后，面板会自动关闭并刷新今日计划（不需要再手动点"关闭"）。
    await page.locator(".modal-overlay .list-row", { hasText: "第三章作业" }).locator("button").click();
    await assert.doesNotReject(page.locator(".modal-overlay").waitFor({ state: "detached" }));

    const todayRow = page.locator(".check-row", { hasText: "第三章作业" });
    await assert.doesNotReject(todayRow.waitFor());
    assert.match(await todayRow.innerText(), /来自学习任务/);
    await todayRow.locator("input[type=checkbox]").click();

    // 勾选完成会弹出满意度打分弹窗，这里先跳过，免得挡住后面的导航点击
    await page.locator(".modal-overlay button", { hasText: "跳过" }).click();
    await assert.doesNotReject(page.locator(".modal-overlay").waitFor({ state: "detached" }));

    await goToModule(page, "学习任务");
    const assignmentRowVisible = await page.locator(".assignment-list .list-row", { hasText: "第三章作业" }).count();
    if (assignmentRowVisible === 0) {
      await page.locator(".collapsible-header", { hasText: "微观经济学" }).click();
    }
    const statusValue = await page.locator(".assignment-list .list-row", { hasText: "第三章作业" }).locator("select").inputValue();
    assert.equal(statusValue, "已完成");
    assert.deepEqual(networkViolations, []); // 全程也没有发起任何外部网络请求
  });

  test("反过来：直接在学习任务里把作业状态改成已完成，今日计划里关联的那一项自动显示为已完成", async () => {
    await goToModule(page, "学习任务");
    await page.locator("button", { hasText: "+ 添加课程" }).click();
    await fillModal(page, { name: "线性代数" });
    await submitModal(page);

    await page.locator(".collapsible-header", { hasText: "线性代数" }).click();
    await page.locator("button", { hasText: "+ 添加作业/考试" }).click();
    await fillModal(page, { title: "习题集第五章", type: "作业", dueDate: "2026-09-21" });
    await submitModal(page);
    await assert.doesNotReject(page.locator(".assignment-list .list-row", { hasText: "习题集第五章" }).waitFor());

    await goToModule(page, "今日计划");
    await page.locator("button", { hasText: "关联事项" }).click();
    await page.locator(".modal-overlay .list-row", { hasText: "习题集第五章" }).locator("button").click();
    await assert.doesNotReject(page.locator(".modal-overlay").waitFor({ state: "detached" }));

    const todayRow = page.locator(".check-row", { hasText: "习题集第五章" });
    await assert.doesNotReject(todayRow.waitFor());
    // 这里还没有勾选，今日计划这一项自己的 done 仍是 false。

    // 不在今日计划里操作，直接回到学习任务，用下拉框把作业状态改成"已完成"。
    await goToModule(page, "学习任务");
    await page.locator(".assignment-list .list-row", { hasText: "习题集第五章" }).locator("select").selectOption("已完成");

    // 回到今日计划：这一项应该自动跟着变成"已完成"状态（勾上、划线），即使从没手动点过它的复选框。
    // 它现在应该从"今天"待办列表里消失了（effectiveDone 让它归到已完成分组）。
    await goToModule(page, "今日计划");
    assert.equal(
      await page.locator(".card", { hasText: /^今天/ }).locator(".check-row", { hasText: "习题集第五章" }).count(),
      0
    );
    // "已完成"分组默认是折叠的，展开它才能看到这一项。
    const doneHeader = page.locator(".collapsible-header", { hasText: "已完成" });
    if (!/︿/.test(await doneHeader.innerText())) await doneHeader.click();
    const syncedRow = page.locator(".check-row.done", { hasText: "习题集第五章" });
    await assert.doesNotReject(syncedRow.waitFor());
    assert.equal(await syncedRow.locator("input[type=checkbox]").isChecked(), true);
  });
});

describe("学习任务：学习目标计时 + 今日学习报告", () => {
  test("给学习目标计时后，学习目标行和今日学习报告都会显示专注时长", async () => {
    await goToModule(page, "学习任务");
    await page.locator(".tab-btn", { hasText: "学习目标" }).click();
    await page.locator("button", { hasText: "+ 添加学习目标" }).click();
    await fillModal(page, { name: "每天学法语30分钟" });
    await submitModal(page);

    const goalBlock = page.locator(".list-row-block", { hasText: "每天学法语30分钟" });
    await assert.doesNotReject(goalBlock.waitFor());
    await assert.doesNotReject(goalBlock.locator("button", { hasText: "开始计时" }).waitFor());

    await goalBlock.locator("button", { hasText: "开始计时" }).click();
    await assert.doesNotReject(goalBlock.locator("button", { hasText: "暂停" }).waitFor());
    await new Promise((resolve) => setTimeout(resolve, 2200));
    await goalBlock.locator("button", { hasText: "暂停" }).click();

    const afterPause = await goalBlock.innerText();
    assert.match(afterPause, /今天已专注 \d+秒/);

    const reportCard = page.locator(".card", { hasText: "今日学习报告" });
    await assert.doesNotReject(reportCard.waitFor());
    assert.match(await reportCard.innerText(), /专注时长/);
    assert.match(await reportCard.innerText(), /专注度/);
    assert.match(await reportCard.innerText(), /效率/);
    assert.match(await reportCard.innerText(), /每天学法语30分钟/);
  });
});

describe("学习任务：学习时长可视化统计图表（开发计划第一版暂缓功能之一）", () => {
  test("给学习目标计时后，「学习时长趋势」图表会出现柱状图，且今天这一根有对应的分钟数", async () => {
    await goToModule(page, "学习任务");
    await page.locator(".tab-btn", { hasText: "学习目标" }).click();
    await page.locator("button", { hasText: "+ 添加学习目标" }).click();
    await fillModal(page, { name: "背单词" });
    await submitModal(page);

    const chartCard = page.locator(".card", { hasText: "学习时长趋势" });
    await assert.doesNotReject(chartCard.waitFor());
    // 还没开始计时之前，应该提示还没有数据
    assert.match(await chartCard.innerText(), /开始给学习目标计时后/);
    const barsBefore = await chartCard.locator(".chart-bar-col").count();
    assert.equal(barsBefore, 7, "应该固定展示最近7天，一天一根柱子");

    const goalBlock = page.locator(".list-row-block", { hasText: "背单词" });
    await goalBlock.locator("button", { hasText: "开始计时" }).click();
    await new Promise((resolve) => setTimeout(resolve, 2200));
    await goalBlock.locator("button", { hasText: "暂停" }).click();

    const afterText = await chartCard.innerText();
    assert.doesNotMatch(afterText, /开始给学习目标计时后/, "计时之后提示语应该消失");
    assert.match(afterText, /\d+分|0分/, "今天这根柱子上方应该显示分钟数（哪怕不到1分钟显示0分）");
  });
});

describe("学习任务：看板视图拖拽改状态", () => {
  test("把卡片从'未开始'拖到'进行中'后，状态真的变了（列表视图的下拉框也会同步）", async () => {
    await goToModule(page, "学习任务");
    await page.locator("button", { hasText: "+ 添加课程" }).click();
    await fillModal(page, { name: "考试准备" });
    await submitModal(page);

    await page.locator(".collapsible-header", { hasText: "考试准备" }).click();
    await page.locator("button", { hasText: "+ 添加作业/考试" }).click();
    await fillModal(page, { title: "期末考试", type: "考试", dueDate: "2026-12-20" });
    await submitModal(page);

    await page.locator(".tab-btn", { hasText: "看板视图" }).click();
    const notStartedColumn = page.locator(".kanban-column", { hasText: "未开始" });
    const inProgressColumn = page.locator(".kanban-column", { hasText: "进行中" });
    const card = notStartedColumn.locator(".kanban-card", { hasText: "期末考试" });
    await assert.doesNotReject(card.waitFor());

    await card.dragTo(inProgressColumn);

    await assert.doesNotReject(inProgressColumn.locator(".kanban-card", { hasText: "期末考试" }).waitFor());
    assert.equal(await notStartedColumn.locator(".kanban-card", { hasText: "期末考试" }).count(), 0);

    // 切回列表视图，确认下拉框里的状态也确实同步变成了"进行中"（拖拽和下拉框改的是同一个字段）
    // 注意：课程卡片本来就还是展开状态（前面加作业时展开过，视图切换不会影响这个），
    // 这里不需要再点一次折叠头，点了反而会把它重新收起来。
    await page.locator(".tab-btn", { hasText: "列表视图" }).click();
    const assignmentRow = page.locator(".assignment-list .list-row", { hasText: "期末考试" });
    if ((await assignmentRow.count()) === 0) {
      await page.locator(".collapsible-header", { hasText: "考试准备" }).click();
    }
    const statusValue = await page.locator(".assignment-list .list-row", { hasText: "期末考试" }).locator("select").inputValue();
    assert.equal(statusValue, "进行中");
  });
});

describe("提醒事项（PRD验收标准5）", () => {
  test("一次性提醒可以标记已处理；周期性提醒展示下一次日期", async () => {
    await goToModule(page, "提醒事项");

    await page.locator("button", { hasText: "+ 添加提醒" }).click();
    await fillModal(page, { title: "缴手机话费", date: "2026-09-16", repeat: "none" });
    await submitModal(page);
    const oneTimeRow = page.locator(".list-row", { hasText: "缴手机话费" });
    await assert.doesNotReject(oneTimeRow.waitFor());
    await oneTimeRow.locator("button", { hasText: "标记已处理" }).click();
    await assert.doesNotReject(page.locator(".collapsible-header", { hasText: "已处理" }).waitFor());

    await page.locator("button", { hasText: "+ 添加提醒" }).click();
    await fillModal(page, { title: "每月固定缴费", date: "2026-09-16", repeat: "monthly" });
    await submitModal(page);
    const monthlyRow = page.locator(".list-row", { hasText: "每月固定缴费" });
    await assert.doesNotReject(monthlyRow.waitFor());
    assert.match(await monthlyRow.innerText(), /下次：/);
  });
});

describe("饮食计划（PRD验收标准9）", () => {
  test("复制上周计划后，本周对应格子内容与上周一致", async () => {
    await goToModule(page, "饮食计划");
    await page.locator("button", { hasText: "‹ 上一周" }).click();

    const lastWeekBreakfastMonday = page.locator("table.data-table tbody tr").first().locator("td.meal-cell").first();
    await lastWeekBreakfastMonday.click();
    await fillModal(page, { text: "豆浆油条" });
    await submitModal(page);

    await page.locator("button", { hasText: "下一周 ›" }).click();
    await page.locator("button", { hasText: "复制上周计划" }).click();

    const thisWeekBreakfastMonday = page.locator("table.data-table tbody tr").first().locator("td.meal-cell").first();
    assert.equal((await thisWeekBreakfastMonday.innerText()).trim(), "豆浆油条");
  });
});

describe("饮食计划：常用菜谱库 + 自动生成购物清单（开发计划第一版暂缓功能之一）", () => {
  test("添加菜谱后可以在三餐计划里直接选用，并且能一键生成购物清单", async () => {
    await goToModule(page, "饮食计划");

    // 切到菜谱库标签页，添加一个菜谱
    await page.locator(".tab-btn", { hasText: "菜谱库" }).click();
    await page.locator("button", { hasText: "+ 添加菜谱" }).click();
    await fillModal(page, { name: "番茄炒蛋" });
    await page.locator('.modal-box [name="ingredients"]').fill("番茄,2,个\n鸡蛋,3,个");
    await submitModal(page);

    const recipeCard = page.locator(".card", { hasText: "番茄炒蛋" });
    await assert.doesNotReject(recipeCard.waitFor());
    assert.match(await recipeCard.innerText(), /番茄 2个/);
    assert.match(await recipeCard.innerText(), /鸡蛋 3个/);

    // 切回本周计划，点第一个格子，从菜谱库里选刚才那个菜
    await page.locator(".tab-btn", { hasText: "本周计划" }).click();
    const firstCell = page.locator("table.data-table tbody tr").first().locator("td.meal-cell").first();
    await firstCell.click();
    await page.locator('.modal-box [name="recipeId"]').selectOption({ label: "番茄炒蛋" });
    await submitModal(page);

    assert.match(await firstCell.innerText(), /番茄炒蛋/);
    await assert.doesNotReject(firstCell.locator(".badge", { hasText: "菜谱" }).waitFor());

    // 生成购物清单
    await page.locator("button", { hasText: "根据本周计划生成购物清单" }).click();
    assert.match(await page.locator(".content-area").innerText(), /已生成购物清单，新增 2 项食材/);

    // 去库存管理页确认购物清单里确实多了这两种食材
    await goToModule(page, "库存管理");
    await assert.doesNotReject(page.locator(".split-side .check-row", { hasText: "番茄" }).waitFor());
    await assert.doesNotReject(page.locator(".split-side .check-row", { hasText: "鸡蛋" }).waitFor());
  });

  test("手动填写的三餐格子不受影响，仍然可以照常使用（没有菜谱库也不强制要求选菜谱）", async () => {
    await goToModule(page, "饮食计划");
    const secondCell = page.locator("table.data-table tbody tr").first().locator("td.meal-cell").nth(1);
    await secondCell.click();
    await fillModal(page, { text: "手动填写的午餐" });
    await submitModal(page);
    assert.equal((await secondCell.innerText()).trim(), "手动填写的午餐");
  });
});

describe("生活用品库存管理（PRD验收标准6）", () => {
  test("数量低于阈值自动标记低库存，并自动出现在购物清单里", async () => {
    await goToModule(page, "库存管理");
    await page.locator("button", { hasText: "+ 添加物品" }).click();
    await fillModal(page, { name: "纸巾", quantity: "2", unit: "包", lowThreshold: "3" });
    await submitModal(page);

    const row = page.locator("table.data-table tbody tr", { hasText: "纸巾" });
    await assert.doesNotReject(row.locator(".badge-warning", { hasText: "低库存" }).waitFor());
    await assert.doesNotReject(page.locator(".split-side .check-row", { hasText: "纸巾" }).waitFor());
  });
});

describe("库存管理：购物清单勾选自动更新库存 + 消耗趋势（开发计划第一版暂缓功能之一）", () => {
  test("购物清单点「买到了」并填购买数量后，库存数量自动增加，条目从清单消失", async () => {
    await goToModule(page, "库存管理");
    await page.locator("button", { hasText: "+ 添加物品" }).click();
    await fillModal(page, { name: "纸巾", quantity: "1", unit: "包", lowThreshold: "3" });
    await submitModal(page);

    const shoppingRow = page.locator(".split-side .check-row", { hasText: "纸巾" });
    await assert.doesNotReject(shoppingRow.waitFor());
    await shoppingRow.locator("button", { hasText: "买到了" }).click();
    await fillModal(page, { quantity: "5" });
    await submitModal(page);

    // 购物清单里这一条消失了
    assert.equal(await page.locator(".split-side .check-row", { hasText: "纸巾" }).count(), 0);
    // 库存数量变成 1 + 5 = 6
    const invRow = page.locator("table.data-table tbody tr", { hasText: "纸巾" });
    assert.match(await invRow.innerText(), /6 包/);
  });

  test("记一次消耗后，库存数量减少，且「消耗趋势」出现这个物品", async () => {
    await goToModule(page, "库存管理");
    await page.locator("button", { hasText: "+ 添加物品" }).click();
    await fillModal(page, { name: "洗手液", quantity: "5", unit: "瓶", lowThreshold: "0" });
    await submitModal(page);

    const invRow = page.locator("table.data-table tbody tr", { hasText: "洗手液" });
    await invRow.locator("span", { hasText: "记一次消耗" }).click();
    await fillModal(page, { amount: "2" });
    await submitModal(page);

    assert.match(await invRow.innerText(), /3 瓶/); // 5 - 2 = 3

    const trendCard = page.locator(".card", { hasText: "消耗趋势" });
    await assert.doesNotReject(trendCard.waitFor());
    assert.match(await trendCard.innerText(), /洗手液/);
    assert.match(await trendCard.innerText(), /2瓶/);
  });

  test("购物清单点「移除」不会影响库存数量（和「买到了」是两种不同的操作）", async () => {
    await goToModule(page, "库存管理");
    await page.locator("button", { hasText: "+ 添加物品" }).click();
    await fillModal(page, { name: "洗衣液", quantity: "1", unit: "瓶", lowThreshold: "3" });
    await submitModal(page);

    const shoppingRow = page.locator(".split-side .check-row", { hasText: "洗衣液" });
    await shoppingRow.locator("span", { hasText: "移除" }).click();

    assert.equal(await page.locator(".split-side .check-row", { hasText: "洗衣液" }).count(), 0);
    const invRow = page.locator("table.data-table tbody tr", { hasText: "洗衣液" });
    assert.match(await invRow.innerText(), /1 瓶/); // 数量没变
  });
});

describe("个人记账（PRD验收标准7）", () => {
  test("记一笔支出后，月度支出汇总和流水列表都正确显示", async () => {
    await goToModule(page, "个人记账");
    await page.locator("button", { hasText: "+ 记一笔" }).click();
    await fillModal(page, { type: "expense", amount: "58", category: "餐饮", date: "2026-09-16", note: "超市买菜" });
    await submitModal(page);

    const expenseCard = page.locator(".card", { hasText: "支出" }).first();
    assert.match(await expenseCard.innerText(), /¥58/);
    await assert.doesNotReject(page.locator(".list-row", { hasText: "超市买菜" }).waitFor());
  });

  test("多币种记账：改汇率后新记的欧元账会按新汇率换算成人民币计入月度汇总", async () => {
    await goToModule(page, "个人记账");

    await page.locator("button", { hasText: "+ 记一笔" }).click();
    await fillModal(page, { type: "expense", amount: "58", category: "餐饮", date: "2026-09-16", note: "超市买菜" });
    await submitModal(page);

    await page.locator("button", { hasText: "汇率设置" }).click();
    await page.locator(".modal-box").locator("input").first().fill("8"); // 第一行是欧元汇率
    await page.locator(".modal-box button", { hasText: "保存" }).click();
    await assert.doesNotReject(page.locator(".modal-overlay").waitFor({ state: "detached" }));

    await page.locator("button", { hasText: "+ 记一笔" }).click();
    await fillModal(page, { type: "expense", amount: "10", currency: "EUR", category: "餐饮", date: "2026-09-16", note: "巴黎买的面包" });
    await submitModal(page);

    // 流水行里应该同时看到原始的欧元金额和换算成人民币的等值。
    const row = page.locator(".list-row", { hasText: "巴黎买的面包" });
    await assert.doesNotReject(row.waitFor());
    assert.match(await row.innerText(), /€10/);
    assert.match(await row.innerText(), /≈-?¥80/);

    // 月度支出汇总应该把之前记的58元人民币和这次的80元人民币等值加在一起。
    const expenseCard = page.locator(".card", { hasText: "支出" }).first();
    assert.match(await expenseCard.innerText(), /¥138/);
    assert.deepEqual(networkViolations, []); // 全程没有为了"实时汇率"发起任何网络请求
  });

  test("编辑一笔记录：不用删除重新录入，改完金额和分类后流水和汇总都跟着更新", async () => {
    await goToModule(page, "个人记账");
    await page.locator("button", { hasText: "+ 记一笔" }).click();
    await fillModal(page, { type: "expense", amount: "58", category: "餐饮", date: "2026-09-16", note: "超市买菜" });
    await submitModal(page);

    const row = page.locator(".list-row", { hasText: "超市买菜" });
    await assert.doesNotReject(row.waitFor());
    await row.locator(".row-edit").click();

    await assert.doesNotReject(page.locator(".modal-title", { hasText: "编辑记录" }).waitFor());
    // 表单应该带出这笔记录原来的值。
    assert.equal(await page.locator('.modal-box [name="amount"]').inputValue(), "58");
    assert.equal(await page.locator('.modal-box [name="note"]').inputValue(), "超市买菜");

    await fillModal(page, { amount: "88", category: "日用", note: "超市买菜和日用品" });
    await page.locator(".modal-box button", { hasText: "保存修改" }).click();
    await assert.doesNotReject(page.locator(".modal-overlay").waitFor({ state: "detached" }));

    // 原来那一笔记录被就地改了，而不是变成了新的一行。
    assert.equal(await page.locator(".list-row", { hasText: "超市买菜和日用品" }).count(), 1);
    assert.equal(await page.locator(".list-row", { hasText: "超市买菜" }).count(), 1); // 备注是新文本的子串，只应该匹配到这一行
    assert.match(await page.locator(".list-row", { hasText: "超市买菜和日用品" }).innerText(), /¥88/);

    const expenseCard = page.locator(".card", { hasText: "支出" }).first();
    assert.match(await expenseCard.innerText(), /¥88/); // 汇总也应该反映改后的88元，而不是原来的58元
  });
});

describe("游戏娱乐（PRD验收标准8）", () => {
  test("记录一次游玩后，累计时长正确显示", async () => {
    await goToModule(page, "游戏娱乐");
    await page.locator("button", { hasText: "+ 添加游戏" }).click();
    await fillModal(page, { name: "塞尔达传说", status: "在玩" });
    await submitModal(page);

    await page.locator("button", { hasText: "记一次游玩" }).click();
    await fillModal(page, { gameId: await page.locator(".modal-box select[name=gameId] option").first().getAttribute("value"), date: "2026-09-16", minutes: "90" });
    await submitModal(page);

    const card = page.locator(".summary-card, .card", { hasText: "塞尔达传说" }).first();
    assert.match(await card.innerText(), /1 小时 30 分钟/);
  });
});

describe("首页联动（PRD验收标准11）", () => {
  test("在库存和游戏娱乐模块新增数据后，回到首页对应摘要卡片立即更新", async () => {
    await goToModule(page, "库存管理");
    await page.locator("button", { hasText: "+ 添加物品" }).click();
    await fillModal(page, { name: "洗手液", quantity: "1", unit: "瓶", lowThreshold: "2" });
    await submitModal(page);

    await goToModule(page, "游戏娱乐");
    await page.locator("button", { hasText: "+ 添加游戏" }).click();
    await fillModal(page, { name: "动物森友会", status: "在玩" });
    await submitModal(page);

    await goToModule(page, "首页总览");
    const inventoryCard = page.locator(".summary-card", { hasText: "库存管理" });
    await assert.doesNotReject(inventoryCard.waitFor());
    assert.match(await inventoryCard.innerText(), /1 件低库存/);

    const gamesCard = page.locator(".summary-card", { hasText: "游戏娱乐" });
    assert.match(await gamesCard.innerText(), /动物森友会/);
  });
});

describe("首页：今日/本周/历史 计划切换视图", () => {
  test("三个标签分别只显示对应时间范围内的事项", async () => {
    await goToModule(page, "今日计划");

    await page.locator("button", { hasText: "+ 添加今日事项" }).click();
    await fillModal(page, { text: "今天要交的周报" });
    await submitModal(page);

    await page.locator("button", { hasText: "+ 添加今日事项" }).click();
    await fillModal(page, { text: "本周晚些要做的事", date: "2026-09-18" });
    await submitModal(page);

    await page.locator("button", { hasText: "+ 添加今日事项" }).click();
    await fillModal(page, { text: "上个月已经做过的事", date: "2026-08-20" });
    await submitModal(page);

    await goToModule(page, "首页总览");
    const planCard = page.locator(".card", { hasText: "今日计划" }).first();

    // 默认是"今日"标签，只应该看到今天的事项
    await assert.doesNotReject(planCard.locator("text=今天要交的周报").waitFor());
    assert.equal(await planCard.locator("text=本周晚些要做的事").count(), 0);
    assert.equal(await planCard.locator("text=上个月已经做过的事").count(), 0);

    await planCard.locator(".tab-btn", { hasText: "本周" }).click();
    await assert.doesNotReject(planCard.locator("text=本周晚些要做的事").waitFor());
    assert.equal(await planCard.locator("text=上个月已经做过的事").count(), 0);

    await planCard.locator(".tab-btn", { hasText: "历史" }).click();
    await assert.doesNotReject(planCard.locator("text=上个月已经做过的事").waitFor());
    assert.equal(await planCard.locator("text=本周晚些要做的事").count(), 0);
  });
});

describe("液态玻璃：分段控件/单选胶囊的连续形变切换", () => {
  test("标签页切换时，高亮指示器是同一个 DOM 节点在流动，不是消失重建；且用了弹簧曲线过渡", async () => {
    await goToModule(page, "首页总览");
    const planCard = page.locator(".card", { hasText: "今日计划" }).first();
    const tabsTrack = planCard.locator(".tabs").first();

    const indicatorBefore = await tabsTrack.locator(".tab-indicator").elementHandle();
    assert.ok(indicatorBefore, "切换前应该已经有一个 .tab-indicator 节点");

    // 过渡曲线必须是"弹簧"风格（cubic-bezier 且带一定过冲），不是普通的线性/ease
    const transition = await indicatorBefore.evaluate((el) => getComputedStyle(el).transitionTimingFunction);
    assert.match(transition, /cubic-bezier/, `transition-timing-function 应该是 cubic-bezier 弹簧曲线，实际是: ${transition}`);
    const duration = await indicatorBefore.evaluate((el) => getComputedStyle(el).transitionDuration);
    assert.notEqual(duration, "0s", "指示器切换应该有真实的过渡时长，不能是瞬间跳变");

    await tabsTrack.locator(".tab-btn", { hasText: "本周" }).click();
    await page.waitForTimeout(600); // 等弹簧过渡走完

    const indicatorAfter = await tabsTrack.locator(".tab-indicator").elementHandle();
    const isSameNode = await page.evaluate(([a, b]) => a === b, [indicatorBefore, indicatorAfter]);
    assert.ok(isSameNode, "点击切换标签后，指示器必须是同一个 DOM 节点，而不是销毁重建出的新节点");

    // 位置应该跟"本周"这个按钮对齐，说明流动结束后确实停在了新选项上
    const btnBox = await tabsTrack.locator(".tab-btn", { hasText: "本周" }).boundingBox();
    const indicatorBox = await indicatorAfter.boundingBox();
    assert.ok(Math.abs(btnBox.x - indicatorBox.x) < 2, `指示器应该对齐到"本周"按钮，按钮x=${btnBox.x}，指示器x=${indicatorBox.x}`);
  });

  test("学习任务的两组标签（课程作业/学习目标、列表/看板）各自独立形变切换，互不干扰", async () => {
    await goToModule(page, "学习任务");
    const topTabs = page.locator(".section-row").filter({ has: page.locator(".tab-btn", { hasText: "课程作业" }) }).locator(".tabs").first();

    const topIndicatorBefore = await topTabs.locator(".tab-indicator").elementHandle();
    await topTabs.locator(".tab-btn", { hasText: "学习目标" }).click();
    await page.waitForTimeout(200);
    await assert.doesNotReject(page.locator(".card-title", { hasText: "学习目标" }).waitFor());
    const topIndicatorAfter = await topTabs.locator(".tab-indicator").elementHandle();
    assert.ok(await page.evaluate(([a, b]) => a === b, [topIndicatorBefore, topIndicatorAfter]), "顶层标签切换后指示器应保持同一节点");

    // 切回"课程作业"后再测试内部的"列表视图/看板视图"二级切换
    await topTabs.locator(".tab-btn", { hasText: "课程作业" }).click();
    await page.waitForTimeout(200);
    const viewTabs = page.locator(".tabs").filter({ has: page.locator(".tab-btn", { hasText: "看板视图" }) });
    const viewIndicatorBefore = await viewTabs.locator(".tab-indicator").elementHandle();
    await viewTabs.locator(".tab-btn", { hasText: "看板视图" }).click();
    await page.waitForTimeout(200);
    await assert.doesNotReject(page.locator(".kanban-board").waitFor());
    const viewIndicatorAfter = await viewTabs.locator(".tab-indicator").elementHandle();
    assert.ok(await page.evaluate(([a, b]) => a === b, [viewIndicatorBefore, viewIndicatorAfter]), "列表/看板视图切换后指示器应保持同一节点");
  });

  test("游戏娱乐的状态筛选胶囊切换时，胶囊指示器同样是连续流动而不是跳变重建", async () => {
    await goToModule(page, "游戏娱乐");
    await page.locator("button", { hasText: "+ 添加游戏" }).click();
    await fillModal(page, { name: "塞尔达传说", status: "在玩" });
    await submitModal(page);

    const pillGroup = page.locator(".pill-group").first();
    const indicatorBefore = await pillGroup.locator(".pill-indicator").elementHandle();
    await pillGroup.locator(".pill", { hasText: "在玩" }).click();
    await page.waitForTimeout(600);
    await assert.doesNotReject(page.locator("text=塞尔达传说").waitFor());

    const indicatorAfter = await pillGroup.locator(".pill-indicator").elementHandle();
    assert.ok(await page.evaluate(([a, b]) => a === b, [indicatorBefore, indicatorAfter]), "筛选胶囊切换后指示器应保持同一节点");
    const btnBox = await pillGroup.locator(".pill", { hasText: "在玩" }).boundingBox();
    const indicatorBox = await indicatorAfter.boundingBox();
    assert.ok(Math.abs(btnBox.x - indicatorBox.x) < 2, "胶囊指示器应该对齐到当前选中的筛选项");
  });
});

describe("数据持久性（PRD验收标准3）", () => {
  test("刷新页面后数据仍在", async () => {
    await goToModule(page, "游戏娱乐");
    await page.locator("button", { hasText: "+ 添加游戏" }).click();
    await fillModal(page, { name: "星露谷物语", status: "想玩" });
    await submitModal(page);

    await page.reload();
    await page.waitForSelector(".nav-item");
    await goToModule(page, "游戏娱乐");
    await assert.doesNotReject(page.locator("text=星露谷物语").waitFor());
  });
});

describe("数据与设置：导出备份 / 导入恢复（PRD验收标准10）", () => {
  test("导出备份 -> 清空全部数据 -> 导入刚才的备份，数据完全恢复", async () => {
    await goToModule(page, "今日计划");
    await page.locator("button", { hasText: "+ 添加今日事项" }).click();
    await fillModal(page, { text: "需要被备份的事项" });
    await submitModal(page);

    await goToModule(page, "数据与设置");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.locator("button", { hasText: "导出备份" }).click(),
    ]);
    const backupPath = await download.path();
    assert.ok(backupPath);

    page.once("dialog", (d) => d.accept()); // 万一导入失败弹出的 alert，避免卡住测试
    await page.locator("button", { hasText: "清空全部数据" }).click();
    await page.locator(".modal-overlay button", { hasText: "清空全部数据" }).click();

    await goToModule(page, "今日计划");
    assert.equal(await page.locator(".check-row").count(), 0);

    await goToModule(page, "数据与设置");
    await page.locator('input[type=file]').setInputFiles(backupPath);
    await page.locator(".modal-overlay button", { hasText: "覆盖导入" }).click();

    await goToModule(page, "今日计划");
    await assert.doesNotReject(page.locator(".check-row", { hasText: "需要被备份的事项" }).waitFor());
    assert.deepEqual(networkViolations, []);
  });
});

describe("数据与设置：手动保存", () => {
  test("平时自动保存之外，也提供一个手动保存按钮，点了会记下保存时间", async () => {
    await goToModule(page, "数据与设置");
    const saveCard = page.locator(".card", { hasText: "手动保存" });
    await assert.doesNotReject(saveCard.waitFor());
    assert.match(await saveCard.innerText(), /还没有手动保存过/);

    await saveCard.locator("button", { hasText: "立即保存" }).click();
    assert.match(await saveCard.innerText(), /上次手动保存：/);
    assert.doesNotMatch(await saveCard.innerText(), /还没有手动保存过/);

    // 刷新页面后这个保存时间还在（是真的存进了 localStorage，不是只改了内存里的界面状态）。
    await page.reload();
    await page.waitForSelector(".nav-item");
    await goToModule(page, "数据与设置");
    assert.match(await page.locator(".card", { hasText: "手动保存" }).innerText(), /上次手动保存：/);
    assert.deepEqual(networkViolations, []);
  });
});

describe("数据与设置：页面重新设计", () => {
  test("按'数据管理/偏好设置'分两栏展示，每张卡片前面都有图标，危险操作单独一块", async () => {
    await goToModule(page, "数据与设置");

    const sectionLabels = await page.locator(".settings-section-label").allInnerTexts();
    assert.deepEqual(sectionLabels, ["数据管理", "偏好设置"]);

    // 手动保存、数据备份两张卡片在"数据管理"这一栏；首页摘要显示在"偏好设置"那一栏。
    const dataCol = page.locator(".settings-col", { hasText: "数据管理" });
    await assert.doesNotReject(dataCol.locator(".card", { hasText: "手动保存" }).waitFor());
    await assert.doesNotReject(dataCol.locator(".card", { hasText: "数据备份" }).waitFor());
    const prefCol = page.locator(".settings-col", { hasText: "偏好设置" });
    await assert.doesNotReject(prefCol.locator(".card", { hasText: "首页摘要显示" }).waitFor());

    // 每张卡片标题前都应该有一个图标，不再是光秃秃的纯文字标题。
    const cardCount = await page.locator(".settings-page .card").count();
    const iconCount = await page.locator(".settings-page .card-icon").count();
    assert.equal(iconCount, cardCount);

    // 危险操作单独成一块，视觉上和其他设置区分开（红色调），而不是混在普通卡片列表里。
    await assert.doesNotReject(page.locator(".danger-card", { hasText: "危险操作" }).waitFor());
  });
});

describe("离线可用（PRD验收标准1）", () => {
  test("整个测试过程中，浏览器没有对外发起任何 http(s) 网络请求", () => {
    assert.deepEqual(networkViolations, []);
  });
});
