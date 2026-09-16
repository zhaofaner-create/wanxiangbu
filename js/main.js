(function (global) {
  "use strict";
  var require = global.__fanerRequire;

  var store = require("./store.js").store;
  var renderQuickMemo = require("./components/quickMemo.js").renderQuickMemo;

  var home = require("./modules/home.js");
  var todayPlan = require("./modules/todayPlan.js");
  var studyTasks = require("./modules/studyTasks.js");
  var reminders = require("./modules/reminders.js");
  var mealPlan = require("./modules/mealPlan.js");
  var inventory = require("./modules/inventory.js");
  var finance = require("./modules/finance.js");
  var games = require("./modules/games.js");
  var settings = require("./modules/settings.js");

  const MODULES = [home, todayPlan, studyTasks, reminders, mealPlan, inventory, finance, games, settings];

  // 侧边导航按"日常/学习/生活/系统"分组展示，比一长条平铺的列表更容易一眼找到东西。
  const NAV_GROUPS = [
    { title: "日常", moduleIds: ["home", "todayPlan"] },
    { title: "学习", moduleIds: ["studyTasks", "reminders"] },
    { title: "生活", moduleIds: ["mealPlan", "inventory", "finance", "games"] },
    { title: "系统", moduleIds: ["settings"] },
  ];

  // 每个模块前面的小图标，纯内联 SVG（线性图标风格，统一描边粗细），不依赖任何外部图标库/字体，
  // 保证离线打开也完全正常显示。
  const NAV_ICONS = {
    home: '<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h3v-6h4v6h3a1 1 0 0 0 1-1v-9"/>',
    todayPlan: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/><path d="m9 14.5 2 2 4-4"/>',
    studyTasks: '<path d="M12 6.5c-1.8-1.3-4.3-2-7-2v13c2.7 0 5.2.7 7 2 1.8-1.3 4.3-2 7-2v-13c-2.7 0-5.2.7-7 2Z"/><path d="M12 6.5v13"/>',
    reminders: '<path d="M7 9a5 5 0 0 1 10 0c0 4 1.5 5.5 1.5 5.5H5.5S7 13 7 9Z"/><path d="M10 17.5a2 2 0 0 0 4 0"/>',
    mealPlan: '<path d="M6 3v7a2 2 0 0 0 2 2v9M6 3v7M9 3v7"/><path d="M16 3c-1.5 0-2.5 1.8-2.5 4.5S14.5 11 16 11v10"/><path d="M16 3v8"/>',
    inventory: '<path d="M4 8.5 12 4l8 4.5-8 4.5-8-4.5Z"/><path d="M4 8.5V16l8 4.5 8-4.5V8.5"/><path d="M12 13v7.5"/>',
    finance: '<rect x="3.5" y="6.5" width="17" height="12" rx="2"/><path d="M3.5 10h17"/><circle cx="16.5" cy="14.5" r="1.4"/>',
    games: '<rect x="3" y="8" width="18" height="9" rx="4"/><path d="M8 10.5v4M6 12.5h4"/><circle cx="16" cy="11.5" r="1"/><circle cx="18.2" cy="13.7" r="1"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1h-.2a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.6v-.2a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6 1h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1Z"/>',
  };
  // 每个模块一个新鲜、柔和的渐变配色（天蓝/薄荷/薰衣草/珊瑚/杏橙/青绿/藕紫/浅灰蓝……），
  // 刻意避开偏黑、偏墨绿这类压抑的色调，整体感觉要清新、放松；"数据与设置"作为系统类
  // 页面保留中性灰蓝，其余模块各有自己的颜色但明度/饱和度统一在同一区间，不会杂乱。
  const NAV_ICON_COLORS = {
    home: ["hsl(206, 88%, 74%)", "hsl(206, 78%, 58%)"],
    todayPlan: ["hsl(160, 62%, 68%)", "hsl(162, 52%, 50%)"],
    studyTasks: ["hsl(248, 72%, 78%)", "hsl(248, 55%, 64%)"],
    reminders: ["hsl(18, 92%, 76%)", "hsl(8, 80%, 66%)"],
    mealPlan: ["hsl(38, 92%, 70%)", "hsl(30, 86%, 58%)"],
    inventory: ["hsl(188, 70%, 66%)", "hsl(188, 60%, 50%)"],
    finance: ["hsl(226, 72%, 76%)", "hsl(226, 60%, 60%)"],
    games: ["hsl(330, 76%, 78%)", "hsl(330, 60%, 64%)"],
    settings: ["hsl(215, 18%, 74%)", "hsl(215, 16%, 56%)"],
  };
  function navIconSvg(id) {
    const colors = NAV_ICON_COLORS[id] || ["hsl(210, 12%, 74%)", "hsl(210, 10%, 56%)"];
    const glyph = `<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${NAV_ICONS[id] || ""}</svg>`;
    return `<span class="nav-icon-tile" style="background:linear-gradient(135deg, ${colors[0]}, ${colors[1]})">${glyph}</span>`;
  }

  const navListEl = document.getElementById("nav-list");
  const contentEl = document.getElementById("content-area");
  const topbarTitleEl = document.getElementById("topbar-title");
  const topbarSubtitleEl = document.getElementById("topbar-subtitle");
  const topbarActionsEl = document.getElementById("topbar-actions");

  let activeId = "home";

  function setTopbar(title, subtitle) {
    topbarTitleEl.textContent = title;
    topbarSubtitleEl.textContent = subtitle || "";
  }

  function renderNav() {
    navListEl.innerHTML = "";
    NAV_GROUPS.forEach((group) => {
      const groupEl = document.createElement("div");
      groupEl.className = "nav-group";
      const titleEl = document.createElement("div");
      titleEl.className = "nav-group-title";
      titleEl.textContent = group.title;
      groupEl.appendChild(titleEl);

      group.moduleIds.forEach((id) => {
        const mod = MODULES.find((m) => m.meta.id === id);
        if (!mod) return;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "nav-item" + (mod.meta.id === activeId ? " active" : "");
        btn.innerHTML = `${navIconSvg(mod.meta.id)}<span>${mod.meta.label}</span>`;
        btn.addEventListener("click", () => navigateTo(mod.meta.id));
        groupEl.appendChild(btn);
      });

      navListEl.appendChild(groupEl);
    });
  }

  function renderTopbarActions() {
    topbarActionsEl.innerHTML = "";
    renderQuickMemo(topbarActionsEl, store);
  }

  function navigateTo(id) {
    activeId = id;
    const mod = MODULES.find((m) => m.meta.id === id) || home;
    renderNav();
    renderTopbarActions();
    // 标记当前活跃模块，供模块内部的计时器/轮询逻辑判断"用户是不是已经切换到别的页面了"，
    // 避免离开今日计划/学习任务页面之后，之前设的定时器还在后台偷偷刷新一个已经看不到的页面。
    contentEl.dataset.activeModuleId = mod.meta.id;
    mod.render(contentEl, store, { navigateTo, setTopbar });
  }

  store.init();
  navigateTo("home");
})(typeof window !== "undefined" ? window : globalThis);
