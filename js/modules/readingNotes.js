(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.readingNotes = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  const { h, mount } = require("../components/dom.js");
  const { createSegmented } = require("../components/segmented.js");
  const { openFormModal } = require("../components/modal.js");
  const { openConfirm } = require("../components/confirm.js");

  const meta = { id: "readingNotes", label: "读书笔记", title: "读书笔记", subtitle: "书单、进度与读书笔记" };

  const RATING_OPTIONS = [
    { value: "", label: "不评分" },
    { value: "1", label: "★☆☆☆☆ 1星" },
    { value: "2", label: "★★☆☆☆ 2星" },
    { value: "3", label: "★★★☆☆ 3星" },
    { value: "4", label: "★★★★☆ 4星" },
    { value: "5", label: "★★★★★ 5星" },
  ];
  let activeFilter = "全部";

  function formatStars(rating) {
    if (!rating) return null;
    return "★".repeat(rating) + "☆".repeat(5 - rating);
  }

  /** 笔记弹窗：列表 + 添加表单在同一个弹窗里，跟 modal.js 的单表单弹窗不是一回事，
   * 所以不走 openFormModal，直接用同一套 .modal-overlay/.modal-box 手搭一个。 */
  function openNotesModal(store, book, onChange) {
    let overlay;

    function renderNotesList() {
      const notes = store.listBookNotes(book.id);
      return notes.length
        ? h("div", { style: "display:flex;flex-direction:column;gap:8px;max-height:260px;overflow-y:auto;" }, notes.map((n) =>
            h("div", { class: "list-row", style: "align-items:flex-start;" }, [
              h("div", { style: "flex:1;" }, [
                h("div", {}, n.text),
                h("div", { class: "muted", style: "font-size:11px;margin-top:2px;" },
                  (n.page ? `第${n.page}页 · ` : "") + new Date(n.createdAt).toLocaleDateString("zh-CN")),
              ]),
              h("span", {
                class: "row-delete",
                onClick: () => { store.removeBookNote(n.id); onChange(); rerenderModal(); },
              }, "删除"),
            ])
          ))
        : h("div", { class: "empty-hint" }, "还没有笔记，写下第一条摘录或感想吧");
    }

    function rerenderModal() {
      const box = overlay.querySelector(".modal-box");
      mount(box, buildBoxContent());
    }

    function buildBoxContent() {
      const textInput = h("textarea", { class: "field-input", placeholder: "摘录、感想都可以……" });
      const pageInput = h("input", { class: "field-input", type: "number", placeholder: "页码（选填）", style: "max-width:140px;" });
      return h("div", {}, [
        h("div", { class: "modal-title" }, `《${book.title}》· 笔记`),
        renderNotesList(),
        h("div", { style: "display:flex;gap:8px;margin-top:14px;" }, [
          textInput,
          pageInput,
        ]),
        h("div", { class: "modal-actions" }, [
          h("button", { type: "button", class: "btn btn-ghost", onClick: () => overlay.remove() }, "关闭"),
          h("button", {
            type: "button",
            class: "btn btn-primary",
            onClick: () => {
              const text = textInput.value.trim();
              if (!text) return;
              store.addBookNote(book.id, text, pageInput.value ? Number(pageInput.value) : null);
              onChange();
              rerenderModal();
            },
          }, "添加笔记"),
        ]),
      ]);
    }

    overlay = h("div", { class: "modal-overlay" }, [h("div", { class: "modal-box" }, [])]);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    rerenderModal();
  }

  function render(container, store, ctx) {
    ctx.setTopbar(meta.title, meta.subtitle);
    function rerender() { render(container, store, ctx); }

    function openAddBookModal() {
      openFormModal({
        title: "添加书目",
        fields: [
          { name: "title", label: "书名", type: "text", required: true },
          { name: "author", label: "作者（选填）", type: "text" },
          { name: "status", label: "状态", type: "select", options: store.BOOK_STATUSES },
        ],
        onSubmit: (v) => { store.addBook({ title: v.title, author: v.author, status: v.status }); rerender(); },
      });
    }

    function openEditBookModal(book) {
      openFormModal({
        title: `编辑 · ${book.title}`,
        fields: [
          { name: "status", label: "状态", type: "select", options: store.BOOK_STATUSES },
          { name: "rating", label: "评分", type: "select", options: RATING_OPTIONS },
        ],
        initialValues: { status: book.status, rating: book.rating ? String(book.rating) : "" },
        onSubmit: (v) => {
          store.updateBook(book.id, { status: v.status, rating: v.rating ? Number(v.rating) : null });
          rerender();
        },
      });
    }

    const filters = ["全部", ...store.BOOK_STATUSES];

    function renderBookCards() {
      const books = store.listBooks(activeFilter);
      const cards = books.map((b) => {
        const noteCount = store.countBookNotes(b.id);
        return h("div", { class: "card", style: "cursor:pointer;", onClick: () => openEditBookModal(b) }, [
          h("div", { class: "section-row", style: "justify-content:space-between;align-items:flex-start;" }, [
            h("div", { style: "font-size:14px;font-weight:600;" }, b.title),
            h("span", { class: "badge" + (b.status === "在读" ? " badge-info" : b.status === "读完" ? " badge-success" : "") }, b.status),
          ]),
          b.author ? h("div", { class: "muted", style: "font-size:12px;margin-top:6px;" }, b.author) : null,
          formatStars(b.rating) ? h("div", { style: "font-size:13px;margin-top:6px;color:hsl(38,75%,48%);" }, formatStars(b.rating)) : null,
          h("div", { class: "section-row", style: "justify-content:space-between;margin-top:10px;" }, [
            h("span", {
              class: "muted", style: "cursor:pointer;font-size:12px;",
              onClick: (e) => { e.stopPropagation(); openNotesModal(store, b, rerender); },
            }, `笔记 · ${noteCount}条`),
            h("span", {
              class: "row-delete",
              onClick: (e) => {
                e.stopPropagation();
                openConfirm({ message: `删除《${b.title}》及其所有笔记？`, danger: true, confirmLabel: "删除", onConfirm: () => { store.removeBook(b.id); rerender(); } });
              },
            }, "删除"),
          ]),
        ]);
      });
      return cards.length ? h("div", { class: "summary-grid" }, cards) : h("div", { class: "empty-hint" }, "还没有添加书目");
    }

    const cardsSlot = h("div", {});
    function refreshCards() { mount(cardsSlot, renderBookCards()); }
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
        h("button", { class: "btn btn-primary", type: "button", onClick: openAddBookModal }, "+ 添加书目"),
      ]),
      cardsSlot,
      renderFinishedChart(store),
    ]));
  }

  /** 手绘竖向柱状图：最近6个月每月读完的书籍数量。 */
  function renderFinishedChart(store) {
    const series = store.listBooksFinishedSeries(6);
    const maxCount = Math.max(1, ...series.map((d) => d.count));
    const hasAny = series.some((d) => d.count > 0);
    const bars = series.map((d) => {
      const heightPct = d.count > 0 ? Math.max(6, Math.round((d.count / maxCount) * 100)) : 4;
      return h("div", { class: "chart-bar-col" }, [
        h("div", { class: "chart-bar-value" }, d.count > 0 ? `${d.count}本` : ""),
        h("div", { class: "chart-bar-track" }, [
          h("div", { class: "chart-bar" + (d.count > 0 ? "" : " is-empty"), style: `height:${heightPct}%;` }),
        ]),
        h("div", { class: "chart-bar-label" }, d.month.slice(5)),
      ]);
    });
    return h("div", { class: "card" }, [
      h("div", { class: "card-title" }, "读完趋势 · 最近6个月"),
      h("div", { class: "chart-bars" }, bars),
      hasAny ? null : h("div", { class: "empty-hint", style: "margin-top:8px;" }, "把一本书标记成「读完」后，这里会自动画出每月读完数量"),
    ]);
  }

  return { meta, render };
});
