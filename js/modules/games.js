(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.games = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  const { h, mount } = require("../components/dom.js");
  const { createSegmented } = require("../components/segmented.js");
  const { openFormModal } = require("../components/modal.js");
  const { openConfirm } = require("../components/confirm.js");
  const { todayStr } = require("../utils.js");

  const meta = { id: "games", label: "游戏娱乐", title: "游戏娱乐", subtitle: "游戏清单与游玩时长" };

  const STATUS_OPTIONS = ["想玩", "在玩", "已通关", "已弃坑"];
  let activeFilter = "全部";

  function render(container, store, ctx) {
    ctx.setTopbar(meta.title, meta.subtitle);
    function rerender() { render(container, store, ctx); }

    function openAddGameModal() {
      openFormModal({
        title: "添加游戏",
        fields: [
          { name: "name", label: "游戏名称", type: "text", required: true },
          { name: "status", label: "状态", type: "select", options: STATUS_OPTIONS },
          { name: "note", label: "备注（选填）", type: "text" },
        ],
        onSubmit: (v) => { store.addGame({ name: v.name, status: v.status, note: v.note || "" }); rerender(); },
      });
    }

    function openLogSessionModal() {
      const games = store.listGames();
      if (!games.length) return;
      openFormModal({
        title: "记一次游玩",
        fields: [
          { name: "gameId", label: "游戏", type: "select", options: games.map((g) => ({ value: g.id, label: g.name })) },
          { name: "date", label: "日期", type: "date", required: true },
          { name: "minutes", label: "时长（分钟）", type: "number", required: true },
        ],
        initialValues: { date: todayStr() },
        onSubmit: (v) => { store.addPlaySession({ gameId: v.gameId, date: v.date, minutes: v.minutes }); rerender(); },
      });
    }

    function openEditGameModal(game) {
      openFormModal({
        title: `编辑 · ${game.name}`,
        fields: [
          { name: "status", label: "状态", type: "select", options: STATUS_OPTIONS },
          { name: "note", label: "备注", type: "text" },
        ],
        initialValues: { status: game.status, note: game.note },
        onSubmit: (v) => { store.updateGame(game.id, { status: v.status, note: v.note }); rerender(); },
      });
    }

    const filters = ["全部", ...STATUS_OPTIONS];

    function renderGameCards() {
      const games = activeFilter === "全部" ? store.listGames() : store.listGames(activeFilter);
      const cards = games.map((g) => {
        const total = store.totalMinutesForGame(g.id);
        const hours = Math.floor(total / 60);
        const mins = total % 60;
        return h("div", { class: "card", style: "cursor:pointer;", onClick: () => openEditGameModal(g) }, [
          h("div", { class: "section-row", style: "justify-content:space-between;align-items:flex-start;" }, [
            h("div", { style: "font-size:14px;font-weight:600;" }, g.name),
            h("span", { class: "badge" + (g.status === "在玩" ? " badge-info" : g.status === "已通关" ? " badge-success" : "") }, g.status),
          ]),
          h("div", { class: "muted", style: "font-size:12px;margin-top:8px;" }, `累计时长 · ${hours} 小时 ${mins} 分钟`),
          g.note ? h("div", { class: "muted", style: "font-size:12px;margin-top:4px;" }, `备注：${g.note}`) : null,
          h("span", {
            class: "row-delete",
            style: "display:inline-block;margin-top:8px;",
            onClick: (e) => {
              e.stopPropagation();
              openConfirm({ message: `删除游戏「${g.name}」及其游玩记录？`, danger: true, confirmLabel: "删除", onConfirm: () => { store.removeGame(g.id); rerender(); } });
            },
          }, "删除"),
        ]);
      });
      return cards.length ? h("div", { class: "summary-grid" }, cards) : h("div", { class: "empty-hint" }, "还没有添加游戏");
    }

    // 筛选胶囊也是一个持续存在的分段控件：切换筛选条件时只刷新下面的游戏卡片
    // 插槽，胶囊轨道本身（含液态指示器）不会被整体重建。
    const cardsSlot = h("div", {});
    function refreshCards() { mount(cardsSlot, renderGameCards()); }
    refreshCards();

    const filterSeg = createSegmented({
      kind: "pill",
      options: filters.map((f) => ({ key: f, label: f })),
      activeKey: activeFilter,
      onSelect: (key) => { activeFilter = key; refreshCards(); },
    });

    mount(container, h("div", { style: "display:flex;flex-direction:column;gap:16px;" }, [
      h("div", { class: "section-row" }, [
        filterSeg.el,
        h("div", { class: "grow" }),
        h("button", { class: "btn btn-outline", type: "button", onClick: openLogSessionModal }, "记一次游玩"),
        h("button", { class: "btn btn-primary", type: "button", onClick: openAddGameModal }, "+ 添加游戏"),
      ]),
      cardsSlot,
    ]));
  }

  return { meta, render };
});
