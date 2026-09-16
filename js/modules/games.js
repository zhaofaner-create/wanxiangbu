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
  const { todayStr, weekdayLabel } = require("../utils.js");

  const meta = { id: "games", label: "游戏娱乐", title: "游戏娱乐", subtitle: "游戏清单与游玩时长" };

  const STATUS_OPTIONS = ["想玩", "在玩", "已通关", "已弃坑"];
  const RATING_OPTIONS = [
    { value: "", label: "不评分" },
    { value: "1", label: "★☆☆☆☆ 1星" },
    { value: "2", label: "★★☆☆☆ 2星" },
    { value: "3", label: "★★★☆☆ 3星" },
    { value: "4", label: "★★★★☆ 4星" },
    { value: "5", label: "★★★★★ 5星" },
  ];
  let activeFilter = "全部";

  /** 把 1-5 的评分格式化成"★★★☆☆"这种星星展示，没评分显示提示文字。 */
  function formatStars(rating) {
    if (!rating) return null;
    return "★".repeat(rating) + "☆".repeat(5 - rating);
  }

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
          { name: "rating", label: "评分", type: "select", options: RATING_OPTIONS },
          { name: "review", label: "评价（选填）", type: "textarea", placeholder: "这游戏怎么样？" },
        ],
        initialValues: { status: game.status, note: game.note, rating: game.rating ? String(game.rating) : "", review: game.review || "" },
        onSubmit: (v) => {
          store.updateGame(game.id, { status: v.status, note: v.note, rating: v.rating ? Number(v.rating) : null, review: v.review || "" });
          rerender();
        },
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
          formatStars(g.rating) ? h("div", { style: "font-size:13px;margin-top:4px;color:hsl(38,75%,48%);" }, formatStars(g.rating)) : h("div", { class: "muted", style: "font-size:12px;margin-top:4px;" }, "还没有评分"),
          g.review ? h("div", { class: "muted", style: "font-size:12px;margin-top:4px;" }, `评价：${g.review}`) : null,
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

    const statsPanel = h("div", { class: "split-layout" }, [
      renderPlaytimeChart(store),
      renderTopPlayedRanking(store),
    ]);

    mount(container, h("div", { style: "display:flex;flex-direction:column;gap:16px;" }, [
      h("div", { class: "section-row" }, [
        filterSeg.el,
        h("div", { class: "grow" }),
        h("button", { class: "btn btn-outline", type: "button", onClick: openLogSessionModal }, "记一次游玩"),
        h("button", { class: "btn btn-primary", type: "button", onClick: openAddGameModal }, "+ 添加游戏"),
      ]),
      cardsSlot,
      statsPanel,
    ]));
  }

  /** 手绘竖向柱状图：最近7天每天的总游玩时长（跨所有游戏汇总）。 */
  function renderPlaytimeChart(store) {
    const today = todayStr();
    const days = 7;
    const series = store.listGamePlaytimeSeries(days, today);
    const maxMinutes = Math.max(1, ...series.map((d) => d.totalMinutes));
    const hasAny = series.some((d) => d.totalMinutes > 0);

    const bars = series.map((d) => {
      const heightPct = d.totalMinutes > 0 ? Math.max(6, Math.round((d.totalMinutes / maxMinutes) * 100)) : 4;
      return h("div", { class: "chart-bar-col" }, [
        h("div", { class: "chart-bar-value" }, d.totalMinutes > 0 ? `${d.totalMinutes}分钟` : ""),
        h("div", { class: "chart-bar-track" }, [
          h("div", { class: "chart-bar" + (d.totalMinutes > 0 ? "" : " is-empty"), style: `height:${heightPct}%;` }),
        ]),
        h("div", { class: "chart-bar-label" + (d.date === today ? " is-today" : "") }, weekdayLabel(d.date)),
      ]);
    });

    return h("div", { class: "card split-main" }, [
      h("div", { class: "card-title" }, "游玩时长趋势 · 最近7天"),
      h("div", { class: "chart-bars" }, bars),
      hasAny ? null : h("div", { class: "empty-hint", style: "margin-top:8px;" }, "记一次游玩后，这里会自动画出每天的游玩时长趋势"),
    ]);
  }

  /** 手绘水平条形图：最近30天游玩时长最多的游戏排行。 */
  function renderTopPlayedRanking(store) {
    const top = store.listTopPlayedGames(30);
    const maxMinutes = Math.max(1, ...top.map((t) => t.totalMinutes));
    return h("div", { class: "card split-side" }, [
      h("div", { class: "card-title" }, "游玩排行 · 最近30天"),
      top.length
        ? h("div", { style: "display:flex;flex-direction:column;gap:10px;" }, top.map((t) => h("div", {}, [
            h("div", { class: "section-row", style: "justify-content:space-between;font-size:12px;margin-bottom:4px;" }, [
              h("span", {}, t.name),
              h("span", { class: "muted" }, `${t.totalMinutes}分钟`),
            ]),
            h("div", { class: "bar-track" }, h("div", { class: "bar-fill", style: `width:${Math.max(4, Math.round((t.totalMinutes / maxMinutes) * 100))}%` })),
          ])))
        : h("div", { class: "empty-hint" }, "还没有游玩记录"),
    ]);
  }

  return { meta, render };
});
