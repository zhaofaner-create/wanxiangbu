(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.inventory = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  const { h, mount } = require("../components/dom.js");
  const { openFormModal } = require("../components/modal.js");
  const { openConfirm } = require("../components/confirm.js");
  const { isWithinDays, formatDateDisplay } = require("../utils.js");

  const meta = { id: "inventory", label: "库存管理", title: "库存管理", subtitle: "生活用品数量 · 低库存 · 保质期 · 购物清单" };

  function render(container, store, ctx) {
    ctx.setTopbar(meta.title, meta.subtitle);
    function rerender() { render(container, store, ctx); }

    function openAddModal() {
      openFormModal({
        title: "添加物品",
        fields: [
          { name: "name", label: "名称", type: "text", required: true },
          { name: "quantity", label: "数量", type: "number", step: "0.1", required: true },
          { name: "unit", label: "单位", type: "text", placeholder: "如：包 / 瓶 / kg" },
          { name: "lowThreshold", label: "低库存提醒阈值", type: "number", step: "0.1", required: true },
          { name: "expiryDate", label: "保质期（选填）", type: "date" },
        ],
        onSubmit: (v) => {
          store.addInventoryItem({
            name: v.name, quantity: v.quantity, unit: v.unit || "",
            lowThreshold: v.lowThreshold, expiryDate: v.expiryDate || null,
          });
          rerender();
        },
      });
    }

    function openEditModal(item) {
      openFormModal({
        title: `编辑 · ${item.name}`,
        fields: [
          { name: "quantity", label: "数量", type: "number", step: "0.1", required: true },
          { name: "lowThreshold", label: "低库存提醒阈值", type: "number", step: "0.1", required: true },
          { name: "expiryDate", label: "保质期（选填）", type: "date" },
        ],
        initialValues: { quantity: item.quantity, lowThreshold: item.lowThreshold, expiryDate: item.expiryDate || "" },
        onSubmit: (v) => {
          store.updateInventoryItem(item.id, { quantity: v.quantity, lowThreshold: v.lowThreshold, expiryDate: v.expiryDate || null });
          rerender();
        },
      });
    }

    /** "记一次消耗"：和上面的编辑（改成某个绝对数量，用于纠正）不一样，这里是记一次真实用掉的量，
     * 会累加进消耗记录，供下面的"消耗趋势"统计用。 */
    function openConsumeModal(item) {
      openFormModal({
        title: `记一次消耗 · ${item.name}`,
        fields: [{ name: "amount", label: `这次用掉了多少${item.unit ? "（" + item.unit + "）" : ""}`, type: "number", step: "0.1", required: true }],
        initialValues: { amount: 1 },
        submitLabel: "记录",
        onSubmit: (v) => { store.recordConsumption(item.id, v.amount); rerender(); },
      });
    }

    /** 购物清单勾选"买到了"：会自动把买到的数量加回对应库存，而不是只把这一条从清单里划掉了事。 */
    function openResolveShoppingModal(s) {
      openFormModal({
        title: `买到了 · ${s.name}`,
        fields: [{ name: "quantity", label: `实际购买数量${s.unit ? "（" + s.unit + "）" : ""}`, type: "number", step: "0.1", required: true }],
        initialValues: { quantity: s.quantity != null ? s.quantity : 1 },
        submitLabel: "确认入库",
        onSubmit: (v) => { store.resolveShoppingItem(s.id, v.quantity); rerender(); },
      });
    }

    const items = store.listInventoryItems();
    const rows = items.map((item) => {
      const low = store.isLowStock(item);
      const expiring = item.expiryDate && isWithinDays(item.expiryDate, 7);
      return h("tr", {}, [
        h("td", { onClick: () => openEditModal(item), style: "cursor:pointer;" }, item.name),
        h("td", {}, `${item.quantity} ${item.unit}`),
        h("td", {}, `${item.lowThreshold} ${item.unit}`),
        h("td", {}, item.expiryDate ? formatDateDisplay(item.expiryDate) : "—"),
        h("td", {}, [
          low ? h("span", { class: "badge badge-warning" }, "低库存") : null,
          expiring ? h("span", { class: "badge badge-warning", style: "margin-left:4px;" }, "临期") : null,
          !low && !expiring ? h("span", { class: "badge badge-success" }, "充足") : null,
        ]),
        h("td", {}, h("div", { class: "section-row", style: "gap:10px;flex-wrap:nowrap;" }, [
          h("span", { class: "muted", style: "cursor:pointer;white-space:nowrap;", onClick: () => openConsumeModal(item) }, "记一次消耗"),
          h("span", {
            class: "row-delete",
            onClick: () => openConfirm({
              message: `删除物品「${item.name}」？`,
              danger: true,
              confirmLabel: "删除",
              onConfirm: () => { store.removeInventoryItem(item.id); rerender(); },
            }),
          }, "删除"),
        ])),
      ]);
    });

    const table = h("table", { class: "data-table" }, [
      h("thead", {}, h("tr", {}, ["名称", "数量", "阈值", "保质期", "状态", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, rows.length ? rows : [h("tr", {}, h("td", { colspan: "6", class: "empty-hint" }, "还没有添加物品"))]),
    ]);

    const shoppingItems = store.listShoppingItems();
    const shoppingList = h("div", { class: "card" }, [
      h("div", { class: "card-title" }, [
        h("span", {}, "购物清单"),
        h("span", { class: "muted", style: "cursor:pointer;font-weight:400;", onClick: () => openAddShoppingModal() }, "+ 手动添加"),
      ]),
      shoppingItems.length
        ? h("div", {}, shoppingItems.map((s) =>
            h("div", { class: "check-row", style: "justify-content:space-between;" }, [
              h("span", {}, s.name + (s.quantity != null ? ` · 约${s.quantity}${s.unit || ""}` : "")),
              h("div", { class: "section-row", style: "gap:10px;" }, [
                h("button", { class: "btn btn-sm btn-primary", type: "button", onClick: () => openResolveShoppingModal(s) }, "买到了"),
                h("span", { class: "row-delete", onClick: () => { store.removeShoppingItem(s.id); rerender(); } }, "移除"),
              ]),
            ])
          ))
        : h("div", { class: "empty-hint" }, "购物清单是空的"),
    ]);

    function openAddShoppingModal() {
      openFormModal({
        title: "添加购物清单条目",
        fields: [{ name: "name", label: "名称", type: "text", required: true }],
        onSubmit: (v) => { store.addShoppingItem({ name: v.name }); rerender(); },
      });
    }

    const consumptionTrend = renderConsumptionTrend(store);

    mount(container, h("div", { class: "split-layout" }, [
      h("div", { class: "split-main" }, [
        h("div", { class: "section-row" }, [h("div", { class: "grow" }), h("button", { class: "btn btn-primary", type: "button", onClick: openAddModal }, "+ 添加物品")]),
        table,
      ]),
      h("div", { class: "split-side", style: "display:flex;flex-direction:column;gap:14px;" }, [shoppingList, consumptionTrend]),
    ]));
  }

  /** 手绘水平条形图：最近30天消耗最多的前5个物品排行，不依赖任何图表库。 */
  function renderConsumptionTrend(store) {
    const top = store.listTopConsumedItems(30);
    const maxAmount = Math.max(1, ...top.map((t) => t.totalAmount));
    return h("div", { class: "card" }, [
      h("div", { class: "card-title" }, "消耗趋势 · 最近30天"),
      top.length
        ? h("div", { style: "display:flex;flex-direction:column;gap:10px;" }, top.map((t) => h("div", {}, [
            h("div", { class: "section-row", style: "justify-content:space-between;font-size:12px;margin-bottom:4px;" }, [
              h("span", {}, t.name),
              h("span", { class: "muted" }, `${t.totalAmount}${t.unit || ""}`),
            ]),
            h("div", { class: "bar-track" }, h("div", { class: "bar-fill", style: `width:${Math.max(4, Math.round((t.totalAmount / maxAmount) * 100))}%` })),
          ])))
        : h("div", { class: "empty-hint" }, "还没有消耗记录，点物品行的“记一次消耗”记录用掉的数量后，这里会显示消耗最多的物品排行"),
    ]);
  }

  return { meta, render };
});
