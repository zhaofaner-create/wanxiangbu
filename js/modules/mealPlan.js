(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.mealPlan = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  const { h, mount } = require("../components/dom.js");
  const { createSegmented } = require("../components/segmented.js");
  const { openFormModal } = require("../components/modal.js");
  const { openConfirm } = require("../components/confirm.js");
  const { todayStr, startOfWeek, weekDates, addDays, weekdayLabel, formatDateDisplay } = require("../utils.js");

  const meta = { id: "mealPlan", label: "饮食计划", title: "饮食计划", subtitle: "" };

  const SLOTS = [
    { key: "breakfast", label: "早" },
    { key: "lunch", label: "中" },
    { key: "dinner", label: "晚" },
  ];

  let currentMonday = null;
  let activeTab = "plan"; // 'plan' | 'recipes'
  let generateMessage = "";

  /** 把"名称,数量,单位"每行一条的文本解析成结构化食材列表；数量/单位可以留空。 */
  function parseIngredientsText(text) {
    return (text || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(",").map((p) => p.trim());
        const name = parts[0] || "";
        const qtyRaw = parts[1];
        const quantity = qtyRaw ? Number(qtyRaw) : null;
        const unit = parts[2] || "";
        return { name, quantity: Number.isFinite(quantity) ? quantity : null, unit };
      })
      .filter((i) => i.name);
  }

  /** parseIngredientsText 的逆操作：把结构化食材列表格式化回文本，供编辑菜谱时回填到文本框。 */
  function formatIngredientsText(ingredients) {
    return (ingredients || []).map((i) => `${i.name},${i.quantity ?? ""},${i.unit || ""}`).join("\n");
  }

  function openEditModal(store, rerender, date, slotKey, slotLabel) {
    const recipes = store.listRecipes();
    const record = store.getMealEntryRecord(date, slotKey);
    const recipeOptions = [{ value: "", label: "—— 不选，直接手动填写 ——" }, ...recipes.map((r) => ({ value: r.id, label: r.name }))];
    const fields = recipes.length
      ? [
          { name: "recipeId", label: "从菜谱库选择（可选）", type: "select", options: recipeOptions },
          { name: "text", label: "或者手动填写安排内容", type: "text", placeholder: "例如：番茄炒蛋 · 米饭" },
        ]
      : [{ name: "text", label: "安排内容", type: "text", placeholder: "例如：番茄炒蛋 · 米饭" }];
    openFormModal({
      title: `${formatDateDisplay(date)} · ${slotLabel}`,
      fields,
      initialValues: { text: record.text, recipeId: record.recipeId || "" },
      submitLabel: "保存",
      onSubmit: (v) => {
        if (v.recipeId) store.setMealEntryFromRecipe(date, slotKey, v.recipeId);
        else store.setMealEntry(date, slotKey, v.text);
        rerender();
      },
    });
  }

  function renderPlanTab(store, rerender) {
    const today = todayStr();
    const dates = weekDates(currentMonday);

    const headerRow = h("tr", {}, [
      h("th", {}, ""),
      ...dates.map((d) => h("th", { class: d === today ? "meal-cell today" : "" }, `${weekdayLabel(d)} ${formatDateDisplay(d)}`)),
    ]);

    const bodyRows = SLOTS.map((slot) =>
      h("tr", {}, [
        h("th", {}, slot.label),
        ...dates.map((d) => {
          const record = store.getMealEntryRecord(d, slot.key);
          const content = record.text
            ? h("span", {}, [record.text, record.recipeId ? h("span", { class: "badge", style: "margin-left:6px;" }, "菜谱") : null])
            : h("span", { class: "meal-cell-empty" }, "+");
          return h(
            "td",
            { class: "meal-cell" + (d === today ? " today" : ""), onClick: () => openEditModal(store, rerender, d, slot.key, slot.label) },
            content
          );
        }),
      ])
    );

    const table = h("table", { class: "data-table" }, [h("thead", {}, headerRow), h("tbody", {}, bodyRows)]);

    const nav = h("div", { class: "section-row" }, [
      h("button", { class: "btn", type: "button", onClick: () => { currentMonday = addDays(currentMonday, -7); generateMessage = ""; rerender(); } }, "‹ 上一周"),
      h("button", { class: "btn", type: "button", onClick: () => { currentMonday = addDays(currentMonday, 7); generateMessage = ""; rerender(); } }, "下一周 ›"),
      h("div", { class: "grow" }),
      h("button", {
        class: "btn btn-outline",
        type: "button",
        onClick: () => {
          const lastMonday = addDays(currentMonday, -7);
          store.copyWeek(lastMonday, currentMonday);
          rerender();
        },
      }, "复制上周计划"),
      h("button", {
        class: "btn btn-primary",
        type: "button",
        onClick: () => {
          const count = store.generateShoppingListFromMealPlan(currentMonday);
          generateMessage = count > 0 ? `已生成购物清单，新增 ${count} 项食材` : "本周没有选用菜谱库里的菜，或者食材已经都在购物清单里了";
          rerender();
        },
      }, "根据本周计划生成购物清单"),
    ]);

    return h("div", { style: "display:flex;flex-direction:column;gap:14px;" }, [
      nav,
      generateMessage ? h("div", { class: "empty-hint", style: "text-align:left;" }, generateMessage) : null,
      h("div", { class: "table-scroll" }, table),
    ]);
  }

  function openRecipeModal(store, rerender, recipe) {
    openFormModal({
      title: recipe ? `编辑菜谱 · ${recipe.name}` : "添加菜谱",
      fields: [
        { name: "name", label: "菜谱名称", type: "text", required: true },
        { name: "ingredients", label: "食材（每行一种，格式：名称,数量,单位；数量单位可留空）", type: "textarea",
          placeholder: "番茄,2,个\n鸡蛋,3,个\n盐,,少许" },
      ],
      initialValues: recipe ? { name: recipe.name, ingredients: formatIngredientsText(recipe.ingredients) } : {},
      submitLabel: "保存",
      onSubmit: (v) => {
        const ingredients = parseIngredientsText(v.ingredients);
        if (recipe) store.updateRecipe(recipe.id, { name: v.name, ingredients });
        else store.addRecipe({ name: v.name, ingredients });
        rerender();
      },
    });
  }

  function renderRecipesTab(store, rerender) {
    const recipes = store.listRecipes();
    const cards = recipes.map((r) => h("div", { class: "card" }, [
      h("div", { class: "section-row", style: "justify-content:space-between;align-items:flex-start;" }, [
        h("div", { style: "font-size:14px;font-weight:600;" }, r.name),
        h("div", { class: "section-row", style: "gap:8px;" }, [
          h("button", { class: "btn btn-sm btn-outline", type: "button", onClick: () => openRecipeModal(store, rerender, r) }, "编辑"),
          h("span", {
            class: "row-delete",
            onClick: () => openConfirm({
              message: `删除菜谱「${r.name}」？已经排进三餐计划里的格子不会被删除，只是不再关联这个菜谱。`,
              danger: true,
              confirmLabel: "删除",
              onConfirm: () => { store.removeRecipe(r.id); rerender(); },
            }),
          }, "删除"),
        ]),
      ]),
      r.ingredients.length
        ? h("div", { class: "muted", style: "font-size:12px;margin-top:8px;" },
            r.ingredients.map((i) => `${i.name}${i.quantity != null ? ` ${i.quantity}` : ""}${i.unit || ""}`).join(" · "))
        : h("div", { class: "muted", style: "font-size:12px;margin-top:8px;" }, "还没有填写食材"),
    ]));

    return h("div", { style: "display:flex;flex-direction:column;gap:14px;" }, [
      h("div", { class: "section-row" }, [
        h("div", { class: "grow" }),
        h("button", { class: "btn btn-primary", type: "button", onClick: () => openRecipeModal(store, rerender, null) }, "+ 添加菜谱"),
      ]),
      recipes.length ? h("div", { style: "display:flex;flex-direction:column;gap:10px;" }, cards) : h("div", { class: "empty-hint" }, "还没有添加菜谱，添加后可以直接选用到三餐计划里，还能一键生成购物清单"),
    ]);
  }

  function render(container, store, ctx) {
    if (!currentMonday) currentMonday = startOfWeek(todayStr());
    const dates = weekDates(currentMonday);
    meta.subtitle = activeTab === "plan" ? `${formatDateDisplay(dates[0])} – ${formatDateDisplay(dates[6])}` : "常用菜谱库";
    ctx.setTopbar(meta.title, meta.subtitle);

    function rerender() { render(container, store, ctx); }

    // 标签页轨道本身是一个持续存在的分段控件实例，切换时只刷新下面的内容插槽，
    // 液态玻璃指示器才能从"本周计划"流动过渡到"菜谱库"，而不是瞬间跳变重建。
    const bodySlot = h("div", {});
    function refreshBody() {
      mount(bodySlot, activeTab === "plan" ? renderPlanTab(store, rerender) : renderRecipesTab(store, rerender));
    }

    const topTabsSeg = createSegmented({
      options: [{ key: "plan", label: "本周计划" }, { key: "recipes", label: "菜谱库" }],
      activeKey: activeTab,
      onSelect: (key) => { activeTab = key; generateMessage = ""; ctx.setTopbar(meta.title, key === "plan" ? `${formatDateDisplay(dates[0])} – ${formatDateDisplay(dates[6])}` : "常用菜谱库"); refreshBody(); },
    });

    refreshBody();

    mount(container, h("div", { style: "display:flex;flex-direction:column;gap:16px;" }, [topTabsSeg.el, bodySlot]));
  }

  return { meta, render, parseIngredientsText, formatIngredientsText };
});
