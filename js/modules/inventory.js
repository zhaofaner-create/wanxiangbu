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

  const meta = { id: "inventory", label: "生活用品库存管理", title: "生活用品库存管理", subtitle: "数量 · 低库存 · 保质期 · 购物清单" };

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
        h("td", {}, h("span", {
          class: "row-delete",
          onClick: () => openConfirm({
            message: `删除物品「${item.name}」？`,
            danger: true,
            confirmLabel: "删除",
            onConfirm: () => { store.removeInventoryItem(item.id); rerender(); },
          }),
        }, "删除")),
      ]);
    });

    const table = h("table", { class: "data-table" }, [
      h("thead", {}, h("tr", {}, ["名称", "数量", "阈值", "保质期", "状态", ""].map((t) => h("th", {}, t)))),
      h("tbody", {}, rows.length ? rows : [h("tr", {}, h("td", { colspan: "6", class: "empty-hint" }, "还没有添加物品"))]),
    ]);

    const shoppingItems = store.listShoppingItems();
    const shoppingList = h("div", { class: "card split-side" }, [
      h("div", { class: "card-title" }, [
        h("span", {}, "购物清单"),
        h("span", { class: "muted", style: "cursor:pointer;font-weight:400;", onClick: () => openAddShoppingModal() }, "+ 手动添加"),
      ]),
      shoppingItems.length
        ? h("div", {}, shoppingItems.map((s) =>
            h("label", { class: "check-row" }, [
              h("input", { type: "checkbox", onChange: () => { store.removeShoppingItem(s.id); rerender(); } }),
              h("span", {}, s.name),
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

    mount(container, h("div", { class: "split-layout" }, [
      h("div", { class: "split-main" }, [
        h("div", { class: "section-row" }, [h("div", { class: "grow" }), h("button", { class: "btn btn-primary", type: "button", onClick: openAddModal }, "+ 添加物品")]),
        table,
      ]),
      shoppingList,
    ]));
  }

  return { meta, render };
});
