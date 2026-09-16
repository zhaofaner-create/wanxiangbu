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
    MODULES.forEach((mod) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "nav-item" + (mod.meta.id === activeId ? " active" : "");
      btn.innerHTML = `<span class="nav-dot"></span><span>${mod.meta.label}</span>`;
      btn.addEventListener("click", () => navigateTo(mod.meta.id));
      navListEl.appendChild(btn);
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
