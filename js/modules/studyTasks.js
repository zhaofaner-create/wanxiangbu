(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.studyTasks = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  const { h, mount } = require("../components/dom.js");
  const { openFormModal } = require("../components/modal.js");
  const { openConfirm } = require("../components/confirm.js");
  const { todayStr, formatDateDisplay, daysUntil } = require("../utils.js");

  const meta = { id: "studyTasks", label: "学习任务", title: "学习任务", subtitle: "课程作业与学习目标" };

  let activeTab = "courses"; // 'courses' | 'goals'
  let expandedCourseId = null;

  const TYPE_OPTIONS = ["作业", "考试", "其他"];
  const STATUS_OPTIONS = ["未开始", "进行中", "已完成"];

  function render(container, store, ctx) {
    ctx.setTopbar(meta.title, meta.subtitle);
    function rerender() { render(container, store, ctx); }

    const tabs = h("div", { class: "tabs" }, [
      h("button", { class: "tab-btn" + (activeTab === "courses" ? " active" : ""), type: "button", onClick: () => { activeTab = "courses"; rerender(); } }, "课程作业"),
      h("button", { class: "tab-btn" + (activeTab === "goals" ? " active" : ""), type: "button", onClick: () => { activeTab = "goals"; rerender(); } }, "学习目标"),
    ]);

    mount(container, h("div", { style: "display:flex;flex-direction:column;gap:16px;" }, [
      h("div", { class: "section-row" }, [tabs, h("div", { class: "grow" }), activeTab === "courses" ? addCourseButton(store, rerender) : addGoalButton(store, rerender)]),
      activeTab === "courses" ? renderCoursesTab(store, rerender) : renderGoalsTab(store, rerender),
    ]));
  }

  function addCourseButton(store, rerender) {
    return h("button", { class: "btn btn-outline", type: "button", onClick: () => {
      openFormModal({
        title: "添加课程",
        fields: [{ name: "name", label: "课程名称", type: "text", required: true }],
        onSubmit: (v) => { store.addCourse(v.name); rerender(); },
      });
    } }, "+ 添加课程");
  }

  function addGoalButton(store, rerender) {
    return h("button", { class: "btn btn-outline", type: "button", onClick: () => {
      openFormModal({
        title: "添加学习目标",
        fields: [{ name: "name", label: "目标名称，如“每天学法语30分钟”", type: "text", required: true }],
        onSubmit: (v) => { store.addGoal(v.name); rerender(); },
      });
    } }, "+ 添加学习目标");
  }

  function renderCoursesTab(store, rerender) {
    const upcoming = store.listUpcomingAssignments(5);
    const upcomingCard = h("div", { class: "card" }, [
      h("div", { class: "card-title" }, "最近到期"),
      upcoming.length
        ? h("div", { class: "upcoming-list" }, upcoming.map((a) => {
            const d = daysUntil(a.dueDate);
            return h("div", { class: "list-row" }, [
              h("span", { class: "badge" }, a.type),
              h("span", {}, a.title),
              h("span", { class: "spacer muted" }, d < 0 ? `已过期 ${-d} 天` : d === 0 ? "今天截止" : `还剩 ${d} 天`),
            ]);
          }))
        : h("div", { class: "empty-hint" }, "暂无未完成的作业/考试"),
    ]);

    const courses = store.listCourses();
    const courseCards = courses.map((course) => renderCourseCard(store, rerender, course));

    return h("div", { style: "display:flex;flex-direction:column;gap:14px;" }, [upcomingCard, ...courseCards]);
  }

  function renderCourseCard(store, rerender, course) {
    const assignments = store.listAssignments(course.id);
    const doneCount = assignments.filter((a) => a.status === "已完成").length;
    const expanded = expandedCourseId === course.id;

    function openAddAssignmentModal() {
      openFormModal({
        title: `添加作业/考试 · ${course.name}`,
        fields: [
          { name: "title", label: "标题", type: "text", required: true },
          { name: "type", label: "类型", type: "select", options: TYPE_OPTIONS },
          { name: "dueDate", label: "截止日期", type: "date", required: true },
        ],
        onSubmit: (v) => {
          store.addAssignment({ courseId: course.id, title: v.title, type: v.type, dueDate: v.dueDate });
          rerender();
        },
      });
    }

    const header = h("div", { class: "collapsible-header", style: "font-size:13px;", onClick: () => { expandedCourseId = expanded ? null : course.id; rerender(); } }, [
      h("span", { style: "display:flex;align-items:center;gap:8px;color:#262626;font-weight:600;" }, [
        h("span", {}, expanded ? "﹀" : "›"),
        h("span", {}, course.name),
      ]),
      h("span", { class: "muted" }, `${doneCount} / ${assignments.length} 已完成`),
    ]);

    const body = expanded
      ? h("div", { style: "margin-top:10px; display:flex; flex-direction:column; gap:8px;" }, [
          assignments.length
            ? h("div", { class: "assignment-list" }, assignments.map((a) => renderAssignmentRow(store, rerender, a)))
            : h("div", { class: "empty-hint" }, "这门课还没有作业/考试"),
          h("div", { class: "section-row" }, [
            h("button", { class: "btn btn-sm btn-outline", type: "button", onClick: openAddAssignmentModal }, "+ 添加作业/考试"),
            h("button", {
              class: "btn btn-sm btn-ghost",
              type: "button",
              onClick: () => openConfirm({
                message: `删除课程「${course.name}」会同时删除它下面的所有作业/考试，确定吗？`,
                danger: true,
                confirmLabel: "删除",
                onConfirm: () => { store.removeCourse(course.id); rerender(); },
              }),
            }, "删除课程"),
          ]),
        ])
      : null;

    return h("div", { class: "card" }, [header, body]);
  }

  function renderAssignmentRow(store, rerender, a) {
    const statusSelect = h(
      "select",
      { class: "field-input", style: "width:auto;padding:4px 8px;font-size:12px;",
        onChange: (e) => { store.updateAssignment(a.id, { status: e.target.value }); rerender(); } },
      STATUS_OPTIONS.map((s) => {
        const opt = h("option", { value: s }, s);
        if (s === a.status) opt.setAttribute("selected", "selected");
        return opt;
      })
    );
    return h("div", { class: "list-row" }, [
      h("span", { class: "badge" }, a.type),
      h("span", {}, a.title),
      h("span", { class: "muted" }, formatDateDisplay(a.dueDate)),
      h("span", { class: "spacer" }, [statusSelect]),
      h("span", {
        class: "row-delete",
        onClick: () => { store.removeAssignment(a.id); rerender(); },
      }, "删除"),
    ]);
  }

  function renderGoalsTab(store, rerender) {
    const today = todayStr();
    const goals = store.listGoals();
    const goalCards = goals.map((g) => {
      const checkedIn = store.isCheckedIn(g.id, today);
      return h("div", { class: "list-row" }, [
        h("span", {}, g.name),
        h("span", { class: "muted" }, `累计打卡 ${store.countCheckins(g.id)} 次`),
        h("button", {
          class: "btn btn-sm spacer " + (checkedIn ? "btn-outline" : "btn-primary"),
          type: "button",
          disabled: checkedIn || undefined,
          onClick: () => { store.checkinGoal(g.id, today); rerender(); },
        }, checkedIn ? "今日已打卡" : "今日打卡"),
        h("span", {
          class: "row-delete",
          onClick: () => { store.removeGoal(g.id); rerender(); },
        }, "删除"),
      ]);
    });

    const goalsCard = h("div", { class: "card" }, [
      h("div", { class: "card-title" }, "学习目标"),
      goals.length ? h("div", {}, goalCards) : h("div", { class: "empty-hint" }, "还没有添加学习目标"),
    ]);

    const logInput = h("textarea", { class: "field-input", rows: 4, placeholder: "今天学了什么？" });
    logInput.value = store.getDailyLog(today);
    let saveTimer = null;
    logInput.addEventListener("input", () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => store.setDailyLog(today, logInput.value), 300);
    });
    const logCard = h("div", { class: "card" }, [
      h("div", { class: "card-title" }, `今日学习记录 · ${formatDateDisplay(today)}`),
      logInput,
    ]);

    return h("div", { style: "display:flex;flex-direction:column;gap:14px;" }, [goalsCard, logCard]);
  }

  return { meta, render };
});
