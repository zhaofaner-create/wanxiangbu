(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.settings = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  const { h, mount } = require("../components/dom.js");
  const { openConfirm } = require("../components/confirm.js");
  const { createSegmented } = require("../components/segmented.js");

  const meta = { id: "settings", label: "数据与设置", title: "数据与设置", subtitle: "备份恢复与基础设置" };

  const CARD_LABELS = {
    study: "学习任务", reminders: "提醒事项", meal: "饮食计划",
    inventory: "库存管理", finance: "个人记账", games: "游戏娱乐",
  };

  const FONT_SCALE_LABELS = [
    { key: "small", label: "小" },
    { key: "medium", label: "标准" },
    { key: "large", label: "大" },
    { key: "xlarge", label: "特大" },
  ];
  const THEME_LABELS = [
    { key: "day", label: "☀️ 白天" },
    { key: "night", label: "🌙 夜间" },
  ];

  // 每张卡片标题前的小图标，跟侧边导航一样用内联 SVG，不额外依赖图标字体/CDN；
  // 配色也跟侧边导航同一套"新鲜柔和渐变"语言，白色线条图标叠在色块上。
  const ICONS = {
    save: '<path d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/><path d="M8 4v5h7V4"/><path d="M7 14h10v6H7z"/>',
    backup: '<path d="M7 17a4 4 0 0 1-1-7.9 5 5 0 0 1 9.6-1.7A4.5 4.5 0 0 1 17 17H7Z"/><path d="M12 11v6M9.5 14.5 12 17l2.5-2.5"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1.2"/><rect x="13" y="4" width="7" height="7" rx="1.2"/><rect x="4" y="13" width="7" height="7" rx="1.2"/><rect x="13" y="13" width="7" height="7" rx="1.2"/>',
    warn: '<path d="M12 4 3 20h18L12 4Z"/><path d="M12 10.5v4M12 17h.01"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12 19 4M15 8l2.5 2.5M18 5l2.5 2.5"/>',
    globe: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 2.5 2.5 13 0 16M12 4c-2.5 2.5-2.5 13 0 16"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/>',
  };
  const ICON_COLORS = {
    save: ["hsl(206, 88%, 74%)", "hsl(206, 78%, 58%)"],
    backup: ["hsl(188, 70%, 66%)", "hsl(188, 60%, 50%)"],
    grid: ["hsl(248, 72%, 78%)", "hsl(248, 55%, 64%)"],
    warn: ["hsl(8, 88%, 74%)", "hsl(355, 70%, 62%)"],
    key: ["hsl(150, 55%, 70%)", "hsl(150, 45%, 52%)"],
    globe: ["hsl(202, 80%, 74%)", "hsl(202, 62%, 54%)"],
    mic: ["hsl(28, 88%, 74%)", "hsl(28, 70%, 56%)"],
  };
  // 生成备份文件名——不放在 render() 里面，是为了能被单元测试直接调用验证格式，
  // 不用真的跑一遍浏览器点击下载才能确认文件名对不对。
  function backupFilename(date) {
    const ts = date.toISOString().slice(0, 19).replace(/[:T]/g, "-");
    return `万象簿备份-${ts}.json`;
  }

  function iconSvg(name) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;
  }
  function cardHeading(iconName, title, warn) {
    const colors = ICON_COLORS[iconName] || ["hsl(210, 12%, 74%)", "hsl(210, 10%, 56%)"];
    return h("div", { class: "card-heading" }, [
      h("div", {
        class: "card-icon" + (warn ? " warn" : ""),
        style: `background:linear-gradient(135deg, ${colors[0]}, ${colors[1]})`,
        html: iconSvg(iconName),
      }),
      h("div", { class: "card-heading-title" }, title),
    ]);
  }

  function render(container, store, ctx) {
    ctx.setTopbar(meta.title, meta.subtitle);
    function rerender() { render(container, store, ctx); }

    // 生成这一次备份要用的文件内容和文件名——导出下载和分享用的是同一份，
    // 抽成一个函数避免两条路径的文件名格式不小心写岔了。
    function buildBackupFile() {
      const json = store.exportBackup();
      const filename = backupFilename(new Date());
      const blob = new Blob([json], { type: "application/json" });
      return { blob, filename };
    }

    // 传统下载方式：生成一个隐藏的 <a download> 触发浏览器下载，落到"下载"文件夹。
    // 在桌面浏览器上，或者手机浏览器不支持系统分享面板时，都退回用这条路。
    function downloadBackupFile(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }

    // 导出备份：手机上优先调起系统自带的分享面板（微信/隔空投送/邮件……装了什么就能
    // 分享到什么），不需要自己先找下载文件夹再手动传输；不支持分享文件的浏览器
    // （目前主要是桌面浏览器）自动退回成传统下载，行为跟以前完全一样。
    async function exportBackup() {
      const { blob, filename } = buildBackupFile();
      const canUseShareSheet =
        typeof navigator !== "undefined" &&
        typeof navigator.share === "function" &&
        typeof File === "function";
      if (canUseShareSheet) {
        try {
          const file = new File([blob], filename, { type: "application/json" });
          const shareData = { files: [file], title: "万象簿备份" };
          if (!navigator.canShare || navigator.canShare(shareData)) {
            await navigator.share(shareData);
            store.setLastBackupAt(new Date().toISOString());
            rerender();
            return;
          }
        } catch (err) {
          // AbortError：用户自己在分享面板里点了取消，这不算失败，什么都不用做，
          // 也不需要再退回下载（用户是主动放弃这次备份，不是分享功能坏了）。
          if (err && err.name === "AbortError") return;
          // 其它错误（比如某些浏览器"声称"支持分享文件，实际调用时才报错）才退回下载。
        }
      }
      downloadBackupFile(blob, filename);
      store.setLastBackupAt(new Date().toISOString());
      rerender();
    }

    const fileInput = h("input", { type: "file", accept: "application/json", style: "display:none;" });
    fileInput.addEventListener("change", () => {
      const file = fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result);
        openConfirm({
          message: "导入备份会用文件里的内容覆盖当前所有数据，确定要继续吗？",
          danger: true,
          confirmLabel: "覆盖导入",
          onConfirm: () => {
            try {
              store.importBackup(text);
              rerender();
            } catch (err) {
              alert("导入失败：" + err.message);
            }
          },
        });
        fileInput.value = "";
      };
      reader.readAsText(file);
    });

    const settings = store.getSettings();

    function doManualSave() {
      store.manualSave();
      rerender();
    }

    const manualSaveCard = h("div", { class: "card" }, [
      cardHeading("save", "手动保存"),
      h("div", { class: "settings-card-desc" }, "平时改动都会自动保存，这个按钮是留给你想主动确认一下的时候用的。"),
      h("div", { class: "settings-status-line" + (settings.lastManualSaveAt ? "" : " unsaved") },
        settings.lastManualSaveAt ? `上次手动保存：${new Date(settings.lastManualSaveAt).toLocaleString("zh-CN")}` : "还没有手动保存过"),
      h("button", { class: "btn btn-outline", type: "button", onClick: doManualSave }, "立即保存"),
    ]);

    const backupCard = h("div", { class: "card" }, [
      cardHeading("backup", "数据备份"),
      h("div", { class: "settings-card-desc" }, "导出成一个 JSON 文件存起来，换设备或者不小心清空数据时可以用它恢复；手机上会优先弹出系统分享面板，可以直接传给另一台设备。"),
      h("div", { class: "settings-status-line" + (settings.lastBackupAt ? "" : " unsaved") },
        settings.lastBackupAt ? `上次备份：${new Date(settings.lastBackupAt).toLocaleString("zh-CN")}` : "还没有备份过"),
      h("div", { class: "section-row" }, [
        h("button", { class: "btn btn-outline", type: "button", onClick: exportBackup }, "导出/分享备份"),
        h("button", { class: "btn btn-outline", type: "button", onClick: () => fileInput.click() }, "导入恢复"),
        fileInput,
      ]),
    ]);

    const appearanceCard = h("div", { class: "card" }, [
      cardHeading("grid", "外观"),
      h("div", { class: "settings-card-desc" }, "字体字号和白天/夜间模式；夜间模式在顶栏右上角也有个快捷按钮可以随时切换。"),
      h("div", { style: "display:flex;flex-direction:column;gap:12px;" }, [
        h("div", {}, [
          h("div", { class: "field-label", style: "margin-bottom:6px;" }, "字体字号"),
          createSegmented({
            kind: "tabs",
            options: FONT_SCALE_LABELS,
            activeKey: settings.fontScale,
            onSelect: (key) => { store.setFontScale(key); ctx.applyAppearance(); },
          }).el,
        ]),
        h("div", {}, [
          h("div", { class: "field-label", style: "margin-bottom:6px;" }, "主题模式"),
          createSegmented({
            kind: "tabs",
            options: THEME_LABELS,
            activeKey: settings.theme,
            onSelect: (key) => { store.setTheme(key); ctx.applyAppearance(); },
          }).el,
        ]),
      ]),
    ]);

    const homeCardsCard = h("div", { class: "card" }, [
      cardHeading("grid", "首页摘要显示"),
      h("div", { class: "settings-card-desc" }, "关掉不常看的模块，首页只留下你在意的摘要卡片。"),
      h("div", { class: "toggle-grid" }, Object.entries(CARD_LABELS).map(([key, label]) =>
        h("label", { class: "toggle-row" }, [
          h("input", {
            type: "checkbox",
            checked: settings.homeCards[key] || undefined,
            onChange: (e) => { store.updateHomeCardVisibility(key, e.target.checked); },
          }),
          h("span", {}, label),
        ])
      )),
    ]);

    // AI 服务密钥：只给"课堂笔记"模块的 AI 整理笔记这一个功能用（多语言互译已经改用
    // 下面「多语言互译服务」卡片里那三家专门的翻译服务），直接从浏览器用这把密钥请求
    // Anthropic 官方 Claude API，不经过我们自己的任何服务器。密钥只存在这台设备本地
    // （localStorage），不会写进代码、也不会上传到任何地方，分享这份 App 给别人用，
    // 对方要用这个功能就填自己申请的密钥，互不影响、互不花钱。
    const apiKeyInput = h("input", {
      class: "field-input",
      type: "password",
      autocomplete: "off",
      placeholder: settings.claudeApiKey ? "已设置，留空并保存可清除" : "粘贴你自己申请的 Claude API 密钥",
    });
    function saveClaudeApiKey() {
      store.setClaudeApiKey(apiKeyInput.value);
      rerender();
    }
    const translationCard = h("div", { class: "card" }, [
      cardHeading("key", "AI 服务密钥"),
      h("div", { class: "settings-card-desc" },
        "给「课堂笔记」模块的 AI 整理笔记功能用，去 Anthropic 官网申请一个属于你自己的 Claude API 密钥填在这里；密钥只存在这台设备本地，不会被公开或者传到别的地方；分享这个 App 给朋友，他要用这个功能得填他自己的密钥。"),
      h("div", { class: "settings-status-line" + (settings.claudeApiKey ? "" : " unsaved") },
        settings.claudeApiKey ? "已设置密钥" : "还没有设置密钥"),
      h("div", { class: "section-row" }, [
        apiKeyInput,
        h("button", { class: "btn btn-outline", type: "button", onClick: saveClaudeApiKey }, "保存"),
      ]),
    ]);

    // 多语言互译服务：Google 翻译 / Azure Translator / DeepL 三选一，各自的密钥分开填、
    // 分开存，"当前使用"选中哪一家，「课堂笔记」的翻译按钮就调用哪一家；换一家随时免费
    // 切换，不影响已经翻译好的内容，也不会多花钱。三家密钥同样只存在这台设备本地。
    function providerKeyField({ statusOk, inputs, saveFn }) {
      return h("div", { style: "display:flex;flex-direction:column;gap:6px;" }, [
        h("div", { class: "settings-status-line" + (statusOk ? "" : " unsaved") }, statusOk ? "已设置" : "还没有设置"),
        h("div", { class: "section-row" }, [
          ...inputs,
          h("button", { class: "btn btn-outline btn-sm", type: "button", onClick: saveFn }, "保存"),
        ]),
      ]);
    }

    const googleKeyInput = h("input", {
      class: "field-input", type: "password", autocomplete: "off",
      placeholder: settings.googleTranslateApiKey ? "已设置，留空并保存可清除" : "Google Cloud Translation API 密钥",
    });
    function saveGoogleKey() {
      store.setGoogleTranslateApiKey(googleKeyInput.value);
      rerender();
    }

    const azureKeyInput = h("input", {
      class: "field-input", type: "password", autocomplete: "off",
      placeholder: settings.azureTranslatorApiKey ? "已设置，留空并保存可清除" : "Azure Translator 密钥",
    });
    const azureRegionInput = h("input", {
      class: "field-input", type: "text", autocomplete: "off", style: "max-width:140px;",
      placeholder: settings.azureTranslatorRegion || "资源区域，如 eastasia",
      value: settings.azureTranslatorRegion || "",
    });
    function saveAzureKey() {
      store.setAzureTranslatorApiKey(azureKeyInput.value);
      store.setAzureTranslatorRegion(azureRegionInput.value);
      rerender();
    }

    const deeplKeyInput = h("input", {
      class: "field-input", type: "password", autocomplete: "off",
      placeholder: settings.deeplApiKey ? "已设置，留空并保存可清除" : "DeepL API 密钥",
    });
    function saveDeeplKey() {
      store.setDeeplApiKey(deeplKeyInput.value);
      rerender();
    }

    const providerLabels = { google: "Google 翻译", azure: "Azure Translator", deepl: "DeepL" };
    const translationProvidersCard = h("div", { class: "card" }, [
      cardHeading("globe", "多语言互译服务"),
      h("div", { class: "settings-card-desc" },
        "给「课堂笔记」模块的多语言互译功能用，三家可以都填，下面选一个「当前使用」，翻译按钮只会调用选中的这一家；随时可以切换，不影响已经翻译好的内容。每家都要去对应官网自己申请密钥。"),
      h("div", { class: "field-label", style: "margin:4px 0 6px;" }, "当前使用"),
      createSegmented({
        kind: "tabs",
        options: store.TRANSLATION_PROVIDER_OPTIONS.map((p) => ({ key: p.code, label: p.label })),
        activeKey: settings.translationProvider,
        onSelect: (key) => { store.setTranslationProvider(key); rerender(); },
      }).el,
      h("div", { style: "display:flex;flex-direction:column;gap:14px;margin-top:14px;" }, [
        h("div", { "data-provider": "google" }, [
          h("div", { class: "field-label", style: "margin-bottom:6px;" }, providerLabels.google),
          providerKeyField({ statusOk: Boolean(settings.googleTranslateApiKey), inputs: [googleKeyInput], saveFn: saveGoogleKey }),
        ]),
        h("div", { "data-provider": "azure" }, [
          h("div", { class: "field-label", style: "margin-bottom:6px;" }, providerLabels.azure),
          providerKeyField({
            statusOk: Boolean(settings.azureTranslatorApiKey && settings.azureTranslatorRegion),
            inputs: [azureKeyInput, azureRegionInput],
            saveFn: saveAzureKey,
          }),
        ]),
        h("div", { "data-provider": "deepl" }, [
          h("div", { class: "field-label", style: "margin-bottom:6px;" }, providerLabels.deepl),
          providerKeyField({ statusOk: Boolean(settings.deeplApiKey), inputs: [deeplKeyInput], saveFn: saveDeeplKey }),
        ]),
      ]),
    ]);

    // "整体重新识别"用的云端语音转文字服务：只有 Google / Azure 两家（没有免费的浏览器
    // 内置引擎能处理"已经录好的音频文件"，DeepL 也不做语音识别），跟上面「多语言互译
    // 服务」是同一套写法——两家密钥分开填、分开存，"当前使用"选中哪家就调用哪家。
    // Azure 这里要填的是专门的"语音"资源的密钥和区域，跟上面 Azure Translator 是两个
    // 不同的资源，需要在 Azure 门户里单独新建。
    const googleSpeechKeyInput = h("input", {
      class: "field-input", type: "password", autocomplete: "off",
      placeholder: settings.googleSpeechApiKey ? "已设置，留空并保存可清除" : "Google Cloud Speech-to-Text API 密钥",
    });
    function saveGoogleSpeechKey() {
      store.setGoogleSpeechApiKey(googleSpeechKeyInput.value);
      rerender();
    }

    const azureSpeechKeyInput = h("input", {
      class: "field-input", type: "password", autocomplete: "off",
      placeholder: settings.azureSpeechApiKey ? "已设置，留空并保存可清除" : "Azure AI Speech 密钥",
    });
    const azureSpeechRegionInput = h("input", {
      class: "field-input", type: "text", autocomplete: "off", style: "max-width:140px;",
      placeholder: settings.azureSpeechRegion || "资源区域，如 eastasia",
      value: settings.azureSpeechRegion || "",
    });
    function saveAzureSpeechKey() {
      store.setAzureSpeechApiKey(azureSpeechKeyInput.value);
      store.setAzureSpeechRegion(azureSpeechRegionInput.value);
      rerender();
    }

    const sttProviderLabels = { google: "Google Speech-to-Text", azure: "Azure AI Speech" };
    const sttProvidersCard = h("div", { class: "card" }, [
      cardHeading("mic", "语音转文字服务"),
      h("div", { class: "settings-card-desc" },
        "给「课堂笔记」模块的「整体重新识别」和「上传录音文件生成笔记」功能用，两家可以都填，下面选一个「当前使用」；这两个功能识别的是已经录好的音频文件，跟录音过程中实时显示的转录（浏览器自带、免费）是两套不同的技术，所以需要单独申请密钥。Azure 这里要填的是「语音」资源，跟上面翻译服务卡片里的 Azure Translator 资源不是同一个，需要单独新建。"),
      h("div", { class: "field-label", style: "margin:4px 0 6px;" }, "当前使用"),
      createSegmented({
        kind: "tabs",
        options: store.STT_PROVIDER_OPTIONS.map((p) => ({ key: p.code, label: p.label })),
        activeKey: settings.sttProvider,
        onSelect: (key) => { store.setSttProvider(key); rerender(); },
      }).el,
      h("div", { style: "display:flex;flex-direction:column;gap:14px;margin-top:14px;" }, [
        h("div", { "data-provider": "google" }, [
          h("div", { class: "field-label", style: "margin-bottom:6px;" }, sttProviderLabels.google),
          providerKeyField({ statusOk: Boolean(settings.googleSpeechApiKey), inputs: [googleSpeechKeyInput], saveFn: saveGoogleSpeechKey }),
        ]),
        h("div", { "data-provider": "azure" }, [
          h("div", { class: "field-label", style: "margin-bottom:6px;" }, sttProviderLabels.azure),
          providerKeyField({
            statusOk: Boolean(settings.azureSpeechApiKey && settings.azureSpeechRegion),
            inputs: [azureSpeechKeyInput, azureSpeechRegionInput],
            saveFn: saveAzureSpeechKey,
          }),
        ]),
      ]),
    ]);

    const dangerCard = h("div", { class: "card danger-card" }, [
      cardHeading("warn", "危险操作", true),
      h("div", { class: "settings-card-desc" }, "清空后所有模块的数据都将被删除，且无法恢复（除非你之前导出过备份）。"),
      h("button", {
        class: "btn btn-danger",
        type: "button",
        onClick: () => openConfirm({
          message: "确定要清空全部数据吗？这个操作无法撤销。",
          danger: true,
          confirmLabel: "清空全部数据",
          onConfirm: () => { store.resetAll(); rerender(); },
        }),
      }, "清空全部数据"),
    ]);

    mount(container, h("div", { class: "settings-page" }, [
      h("div", { class: "settings-grid" }, [
        h("div", { class: "settings-col" }, [
          h("div", { class: "settings-section-label" }, "数据管理"),
          manualSaveCard,
          backupCard,
        ]),
        h("div", { class: "settings-col" }, [
          h("div", { class: "settings-section-label" }, "偏好设置"),
          appearanceCard,
          homeCardsCard,
          translationProvidersCard,
          sttProvidersCard,
          translationCard,
        ]),
      ]),
      dangerCard,
    ]));
  }

  return { meta, render, backupFilename };
});
