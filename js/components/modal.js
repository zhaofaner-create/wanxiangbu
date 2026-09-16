(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.modal = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  const { h } = require("./dom.js");

  let currentOverlay = null;

  function closeModal() {
    if (currentOverlay) {
      currentOverlay.remove();
      currentOverlay = null;
    }
  }

  /**
   * 打开一个通用的表单弹窗。
   * fields: [{ name, label, type: 'text'|'number'|'date'|'select'|'textarea', options, placeholder, required, step }]
   * onSubmit(values) —— values 是 { [field.name]: 值 }，number 类型会被转成 Number。
   */
  function openFormModal({ title, fields, submitLabel = "保存", onSubmit, initialValues = {} }) {
    closeModal();

    const inputEls = {};
    const fieldRows = fields.map((f) => {
      let input;
      if (f.type === "select") {
        input = h(
          "select",
          { class: "field-input", name: f.name },
          (f.options || []).map((opt) => {
            const optValue = typeof opt === "string" ? opt : opt.value;
            const optLabel = typeof opt === "string" ? opt : opt.label;
            const option = h("option", { value: optValue }, optLabel);
            if (initialValues[f.name] === optValue) option.setAttribute("selected", "selected");
            return option;
          })
        );
      } else if (f.type === "textarea") {
        input = h("textarea", { class: "field-input", name: f.name, placeholder: f.placeholder || "" });
        input.value = initialValues[f.name] ?? "";
      } else {
        input = h("input", {
          class: "field-input",
          type: f.type || "text",
          name: f.name,
          placeholder: f.placeholder || "",
          step: f.step,
        });
        input.value = initialValues[f.name] ?? "";
      }
      inputEls[f.name] = input;
      return h("label", { class: "field-row" }, [h("span", { class: "field-label" }, f.label), input]);
    });

    const form = h("form", { class: "modal-form" }, [
      ...fieldRows,
      h("div", { class: "modal-actions" }, [
        h("button", { type: "button", class: "btn btn-ghost", onClick: () => closeModal() }, "取消"),
        h("button", { type: "submit", class: "btn btn-primary" }, submitLabel),
      ]),
    ]);

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const values = {};
      fields.forEach((f) => {
        let v = inputEls[f.name].value;
        if (f.type === "number") v = v === "" ? null : Number(v);
        values[f.name] = v;
      });
      for (const f of fields) {
        if (f.required && (values[f.name] === "" || values[f.name] === null || values[f.name] === undefined)) {
          inputEls[f.name].focus();
          return;
        }
      }
      closeModal();
      onSubmit(values);
    });

    const box = h("div", { class: "modal-box" }, [h("div", { class: "modal-title" }, title), form]);
    const overlay = h("div", { class: "modal-overlay" }, [box]);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal();
    });

    document.body.appendChild(overlay);
    currentOverlay = overlay;
    const firstInput = form.querySelector(".field-input");
    if (firstInput) firstInput.focus();
  }

  return { closeModal, openFormModal };
});
