(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.profile = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  const { h, mount } = require("../components/dom.js");
  const { openAvatarCropper } = require("../components/avatarCropper.js");

  const meta = { id: "profile", label: "个人信息", title: "个人信息", subtitle: "你的昵称和头像，只保存在这台设备本地" };

  // 上传照片压缩成正方形小图时的目标边长和 JPEG 质量：200px 对头像这种最大也就
  // 56px 显示尺寸的场景绰绰有余（放大到特大字号也够用），JPEG 0.85 质量下一张
  // 通常只有几KB到十几KB，不会把 localStorage 配额或导出的备份文件明显撑大。
  const AVATAR_IMAGE_SIZE = 200;
  const AVATAR_IMAGE_QUALITY = 0.85;

  // 注意：这个变量要放在 render() 函数外面（模块级别），不能放里面。上传文件的
  // 处理是异步的（FileReader/Image 加载完才回调），回调里出错要 rerender() 才能
  // 让用户看到提示，而 rerender() 就是重新调用一次 render()——如果 uploadError
  // 是 render() 内部的局部变量，每次重新调用都会被重新初始化成空字符串，刚设置
  // 好的错误提示还没显示出来就被自己清掉了。这里参照 finance.js 里 currentMonth
  // 之类"跨重渲染要保留"的状态放在模块顶层的写法。
  let uploadError = "";

  /** 渲染头像：优先显示用户上传的照片，没有照片就退回 emoji。传 className 控制大小（圆点/大预览用不同尺寸）。 */
  function renderAvatarVisual(profile, className) {
    if (profile.avatarImage) {
      return h("span", { class: className }, [h("img", { src: profile.avatarImage, alt: "头像" })]);
    }
    return h("span", { class: className }, profile.avatar);
  }

  function render(container, store, ctx) {
    ctx.setTopbar(meta.title, meta.subtitle);
    function rerender() { render(container, store, ctx); }

    const profile = store.getSettings().profile;

    function saveName(value) {
      store.updateProfile({ name: value.trim() });
      if (ctx.refreshShell) ctx.refreshShell();
    }
    function saveAvatar(avatar) {
      // 选一个 emoji 相当于明确表示"不用照片了"，所以顺手把 avatarImage 清空，
      // 不然会出现"选了emoji但侧边栏还在显示之前那张照片"的诡异状态。
      store.updateProfile({ avatar, avatarImage: null });
      if (ctx.refreshShell) ctx.refreshShell();
      rerender();
    }
    function saveAvatarImage(dataUrl) {
      store.updateProfile({ avatarImage: dataUrl });
      if (ctx.refreshShell) ctx.refreshShell();
      rerender();
    }
    function removeAvatarImage() {
      store.updateProfile({ avatarImage: null });
      if (ctx.refreshShell) ctx.refreshShell();
      rerender();
    }

    /** 选好照片文件后：读成 data URL → 打开裁剪弹窗让用户自己拖动/缩放选取范围 → 确认后存下来。 */
    function handleFileSelected(file) {
      if (!file) return;
      if (!file.type || file.type.indexOf("image/") !== 0) {
        uploadError = "请选择一张图片文件";
        rerender();
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => { uploadError = "图片读取失败，换一张试试"; rerender(); };
      reader.onload = () => {
        uploadError = "";
        openAvatarCropper({
          imageSrc: reader.result,
          outputSize: AVATAR_IMAGE_SIZE,
          quality: AVATAR_IMAGE_QUALITY,
          onConfirm: (dataUrl) => saveAvatarImage(dataUrl),
        });
      };
      reader.readAsDataURL(file);
    }

    const nameInput = h("input", {
      class: "field-input",
      type: "text",
      placeholder: "给自己起个名字吧",
      style: "max-width:280px;",
    });
    nameInput.value = profile.name;
    nameInput.addEventListener("change", () => saveName(nameInput.value));

    const fileInput = h("input", {
      type: "file",
      accept: "image/*",
      class: "avatar-file-input",
      style: "display:none;",
      onChange: (e) => handleFileSelected(e.target.files && e.target.files[0]),
    });

    const uploadRow = h("div", { style: "display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px;" }, [
      h("button", { class: "btn btn-outline btn-sm", type: "button", onClick: () => fileInput.click() }, "上传相册照片"),
      profile.avatarImage
        ? h("button", { class: "btn btn-ghost btn-sm", type: "button", onClick: removeAvatarImage }, "移除照片，换回表情")
        : null,
      fileInput,
    ]);
    const uploadHint = h("div", { class: "muted", style: "font-size:11.5px;margin-top:6px;" },
      uploadError || "照片只会压缩后存在这台设备本地，不会上传到任何服务器");

    const avatarGrid = h(
      "div",
      { style: "display:flex;flex-wrap:wrap;gap:10px;margin-top:10px;" },
      store.AVATAR_OPTIONS.map((a) =>
        h(
          "button",
          {
            type: "button",
            class: "avatar-option" + (!profile.avatarImage && a === profile.avatar ? " active" : ""),
            onClick: () => saveAvatar(a),
          },
          a
        )
      )
    );

    const previewCard = h("div", { class: "card", style: "display:flex;align-items:center;gap:16px;" }, [
      renderAvatarVisual(profile, "profile-avatar-large"),
      h("div", {}, [
        h("div", { style: "font-size:16px;font-weight:700;" }, profile.name || "还没有起名字"),
        h("div", { class: "muted", style: "font-size:12px;margin-top:4px;" }, "这份资料只存在这台设备上，不会上传到任何地方"),
      ]),
    ]);

    const editCard = h("div", { class: "card" }, [
      h("div", { class: "card-title" }, "编辑资料"),
      h("label", { class: "field-row" }, [h("span", { class: "field-label" }, "昵称"), nameInput]),
      h("div", { class: "field-row", style: "align-items:flex-start;" }, [
        h("span", { class: "field-label" }, "头像"),
        h("div", {}, [avatarGrid, uploadRow, uploadHint]),
      ]),
    ]);

    mount(container, h("div", { style: "display:flex;flex-direction:column;gap:16px;max-width:640px;" }, [
      previewCard,
      editCard,
    ]));
  }

  return { meta, render, renderAvatarVisual };
});
