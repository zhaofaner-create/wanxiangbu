(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.classNotes = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  const { h, mount } = require("../components/dom.js");
  const { openConfirm } = require("../components/confirm.js");
  const { createSegmented } = require("../components/segmented.js");
  const { openFormModal } = require("../components/modal.js");
  const { createSpeechRecorder } = require("../components/speechRecorder.js");
  const { saveAudio, loadAudio, deleteAudio, makeAudioKey } = require("../components/audioStore.js");
  const { saveMaterialImage, loadMaterialImage, deleteMaterialImage, makeMaterialKey } = require("../components/materialsStore.js");
  const { extractPptxText } = require("../components/pptxText.js");
  const { extractDocxText } = require("../components/docxText.js");
  const { renderMindMapSvg } = require("../components/mindMap.js");
  const { parseMarkdownBlocks, parseInlineSegments } = require("../components/markdown.js");
  const aiClient = require("../aiClient.js");
  const translationProviders = require("../translationProviders.js");
  const speechToTextProviders = require("../components/speechToTextProviders.js");

  const meta = { id: "classNotes", label: "课堂笔记", title: "课堂笔记", subtitle: "录音转文字 · 多语言互译 · AI整理笔记" };

  // 录音转文字这一步走的是浏览器自带的 Web Speech API，免费、不需要密钥，但要联网
  // （语音识别在云端做），目前只有 Chrome / Edge 等 Chromium 内核浏览器支持得比较好；
  // "整理笔记"用的是用户自己在「数据与设置」填的 Claude API 密钥；"翻译"用的是用户在
  // 「数据与设置」的「多语言互译服务」里选中的那一家（Google 翻译/Azure Translator/
  // DeepL）的密钥——两者都是直接从浏览器调用官方接口，不经过我们自己的任何服务器。
  // 这些都是本模块特有的联网点，跟 App 其它模块的"完全离线"不一样，README 里有对应说明。

  // Web Speech API 认的是 BCP-47 语言标签（比如 "fr-FR"），跟 store.js 里
  // CLASS_NOTE_LANGUAGES 用的两位 ISO 代码不是一回事，这个映射表跟"整体重新识别"
  // 用的云端语音识别接口是同一份，统一维护在 speechToTextProviders.js 里。
  const SPEECH_LANG_TAGS = speechToTextProviders.SPEECH_LANG_TAGS;

  // ---------- 模块级状态：跟 readingNotes.js 的 activeFilter、todayPlan.js 的
  // completedOpen/tickTimer 是一回事，靠闭包跨多次 render 保持住，不存进 store。 ----------
  let view = { mode: "list" }; // {mode:"list"}（课程总览） | {mode:"courseNotes", courseId:string|null}（某门课/"未分类"的笔记列表） | {mode:"record", noteId:string} | {mode:"detail", noteId:string}
  let detailTab = "notes"; // "notes" | "transcript"（"转录" tab 现在原文+译文一起显示，不再单独分"翻译" tab）
  let activeTranslationLang = null;
  const NOTES_SOURCE_KEY = "__source__"; // "笔记"tab 语言切换里代表"原文"（sourceLang）的那个选项，不是真的语言代码
  let activeNotesLang = NOTES_SOURCE_KEY; // "笔记"tab 当前查看的是原文还是翻译成了哪个目标语言
  let flashcardIndex = 0; // "闪卡"tab 当前看到第几张（下标）
  let flashcardFlipped = false; // 当前这张卡片是不是已经翻到答案那面
  let qaBusy = false; // "提问"tab 上一次提问是不是还没等到 AI 回复
  let qaError = null; // "提问"tab 上一次提问失败的提示（成功一次或换问题重新问都会清空）
  let transcriptViewMode = "live"; // "转录"tab 里"实时识别"/"重新识别"两份内容当前切换看的是哪个
  let retranscriptActiveLang = null; // "重新识别"这份内容当前查看哪个目标语言译文（跟实时识别的 activeTranslationLang 分开存）
  let retranscribeBusy = false; // 上一次"整体重新识别"是不是还没跑完
  let retranscribeProgress = null; // 整体重新识别进行中的进度 {index, total}（按音频切出来的段数算）
  let retranscribeError = null; // 上一次整体重新识别失败的提示，重新点一次就会清空
  let recorder = null; // 当前活跃的 speechRecorder 实例；非空表示正在录音（含暂停）
  let recordingNoteId = null; // recorder 对应的笔记 id
  let recordStartError = null; // 启动失败（不支持/没权限）时的提示
  let liveError = null; // 录音过程中识别引擎报错的提示（不会强行中断录音）
  let silenceHint = null; // 连续好几次都没检测到声音时的提示（很可能是麦克风权限/设备问题），一收到语音就消失
  const SILENCE_HINT_STREAK = 2; // 连续几次 no-speech 才提示，避免正常讲课停顿被当成"没声音"
  let watchdogTimer = null; // 录音页专用的"每秒刷新计时+离开页面自动收尾"定时器，同 todayPlan.js 的 tickTimer
  // ---------- 录音过程中的自动翻译：不需要用户点按钮，每隔一段时间自动把"新增的那一小段
  // 转录"发去翻译、追加到已有翻译后面。三小时的课如果每次都整段重新翻译会越来越慢，
  // 所以只翻译"还没翻译过的尾部"（见下面 translateNewSegments）。 ----------
  let liveTranslateLang = null; // 录音页"实时翻译"面板当前显示哪个目标语言（多个目标语言时可切换）
  let autoTranslateBusy = false; // 上一次自动翻译请求是否还没返回，避免同时发出好几个重叠的请求
  let autoTranslateErrors = {}; // 每个目标语言最近一次自动翻译失败的提示，成功一次就会清空
  let lastAutoTranslateAt = 0; // 上一次自动翻译发生的时间戳（毫秒），配合下面的间隔做节流
  const AUTO_TRANSLATE_INTERVAL_MS = 6000; // 每隔几秒批量翻译一次新增内容，不是每秒都联网

  function checkBrowserSupport() {
    const hasRecognition = typeof window !== "undefined" && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
    const hasMediaRecorder = typeof MediaRecorder !== "undefined";
    const hasGetUserMedia = typeof navigator !== "undefined" && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function";
    return hasRecognition && hasMediaRecorder && hasGetUserMedia;
  }

  function langLabel(store, code) {
    const item = store.CLASS_NOTE_LANGUAGES.find((l) => l.code === code);
    return item ? item.label : code;
  }

  function providerLabel(store, code) {
    const item = store.TRANSLATION_PROVIDER_OPTIONS.find((p) => p.code === code);
    return item ? item.label : code;
  }

  function sttProviderLabel(store, code) {
    const item = store.STT_PROVIDER_OPTIONS.find((p) => p.code === code);
    return item ? item.label : code;
  }

  function materialIcon(kind) {
    if (kind === "pptx") return "📑";
    if (kind === "docx") return "📄";
    return "🖼️";
  }

  /** 把 settings 里三家翻译服务各自的字段收拢成 translationProviders.js 认的 keys 形状。 */
  function translationKeysFromSettings(settings) {
    return {
      googleApiKey: settings.googleTranslateApiKey,
      azureApiKey: settings.azureTranslatorApiKey,
      azureRegion: settings.azureTranslatorRegion,
      deeplApiKey: settings.deeplApiKey,
    };
  }

  /**
   * 只翻译"还没翻译过的那一段"（转录数组里超出已翻译长度的尾部），翻译完直接追加到
   * 已有翻译后面，而不是每次都把从头到尾整段重新翻译一遍——这样不管是录音过程中的
   * 自动翻译，还是详情页手动点"翻译"，花费都只取决于新增了多少内容，跟这堂课已经
   * 录了多长时间无关（否则录到后面，每隔几秒重新翻译一次全部转录，会越来越慢）。
   * 返回这次新翻译出来的那一小段（没有新内容则返回空数组）。
   */
  async function translateNewSegments(store, note, lang) {
    const settings = store.getSettings();
    const existing = note.translations[lang] || [];
    const pending = note.transcriptSegments.slice(existing.length);
    if (!pending.length) return [];
    const translated = await translationProviders.translateSegments({
      provider: settings.translationProvider,
      segments: pending,
      targetLangCode: lang,
      keys: translationKeysFromSettings(settings),
    });
    store.appendClassNoteTranslation(note.id, lang, translated);
    return translated;
  }

  /**
   * 录音过程中的一次自动翻译：依次给每个目标语言追赶"还没翻译的新内容"。
   * - 没配置当前翻译服务的密钥、或者所有目标语言都已经追上转录进度，直接跳过，不联网。
   * - onSegments(lang, segments) 在某个语言翻译出新内容时调用，调用方用它直接改对应"译文
   *   格子"的 DOM 文字，不需要（也不应该）整页重新渲染——理由同"实时转录"segmentListEl。
   * - onTick() 在开始、每处理完一个语言、以及全部结束时都会调用一次，方便调用方刷新
   *   "翻译中…"这类状态文字。
   */
  async function runAutoTranslateTick(store, note, { onSegments, onTick } = {}) {
    if (autoTranslateBusy) return;
    const settings = store.getSettings();
    const hasKey = translationProviders.isProviderConfigured(settings.translationProvider, translationKeysFromSettings(settings));
    if (!hasKey) return;
    const pendingLangs = note.targetLangs.filter((lang) => (note.translations[lang] || []).length < note.transcriptSegments.length);
    if (!pendingLangs.length) return;
    autoTranslateBusy = true;
    if (onTick) onTick();
    for (const lang of pendingLangs) {
      try {
        const translated = await translateNewSegments(store, note, lang);
        autoTranslateErrors[lang] = null;
        if (translated.length && onSegments) onSegments(lang, translated);
      } catch (err) {
        autoTranslateErrors[lang] = err.message || "翻译失败";
      }
      if (onTick) onTick();
    }
    autoTranslateBusy = false;
    if (onTick) onTick();
  }

  function statusLabel(note) {
    if (note.status === "recording") return "录音中";
    if (note.status === "recorded") return "待生成笔记";
    if (note.status === "notes_ready") return "笔记已生成";
    return note.status;
  }

  function statusBadgeClass(note) {
    if (note.status === "recording") return "badge badge-warning";
    if (note.status === "notes_ready") return "badge badge-success";
    return "badge badge-info";
  }

  function stopWatchdog() {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  }

  // ---------- Markdown 渲染（纯解析逻辑在 markdown.js 里，这里只管转成 DOM 节点） ----------

  function renderInline(text) {
    return parseInlineSegments(text).map((seg) => {
      if (seg.bold) return h("strong", {}, seg.text);
      if (seg.code) return h("code", {}, seg.text);
      return seg.text;
    });
  }

  function renderMarkdownBlock(block) {
    if (block.type === "heading") {
      const tag = "h" + Math.min(6, Math.max(3, block.level + 2)); // 笔记内部的标题层级不跟页面自身的标题抢视觉层级
      return h(tag, { class: "note-md-heading" }, renderInline(block.text));
    }
    if (block.type === "list") {
      return h("ul", { class: "note-md-list" }, block.items.map((item) => h("li", {}, renderInline(item))));
    }
    if (block.type === "quote") {
      return h("blockquote", { class: "note-md-quote" }, renderInline(block.text));
    }
    if (block.type === "table") {
      return h("div", { class: "table-scroll" }, [
        h("table", { class: "data-table" }, [
          h("thead", {}, [h("tr", {}, block.header.map((c) => h("th", {}, renderInline(c))))]),
          h("tbody", {}, block.rows.map((row) => h("tr", {}, row.map((c) => h("td", {}, renderInline(c)))))),
        ]),
      ]);
    }
    return h("p", { class: "note-md-paragraph" }, renderInline(block.text));
  }

  function renderMarkdown(markdown) {
    const blocks = parseMarkdownBlocks(markdown);
    if (!blocks.length) return h("div", { class: "empty-hint" }, "还没有生成笔记");
    return h("div", { class: "note-markdown" }, blocks.map(renderMarkdownBlock));
  }

  function renderTranscriptRow(seg) {
    return h("div", { class: "list-row", style: "align-items:flex-start;" }, [
      h("span", { class: "muted", style: "font-size:11px;min-width:44px;" }, aiClient.formatSeconds(seg.start)),
      h("span", { style: "flex:1;" }, seg.text),
    ]);
  }

  /**
   * 原文 + 译文一起显示成"一格"，而不是分开两个列表——用户明确要求"一句话的原文和翻译
   * 应该在同一个格子里，下一句再另起一格"。没有互译语言时（showTranslation=false）直接
   * 退化成原来的纯原文一行，不额外包一层，视觉上零变化。
   * 返回 { block, translationEl }：translationEl 是译文那一格的 DOM 节点引用，
   * 录音过程中译文异步到达时直接改它的 textContent，不用整个列表重新渲染。
   */
  function buildSegmentBlock(seg, translatedText, showTranslation) {
    if (!showTranslation) {
      return { block: renderTranscriptRow(seg), translationEl: null };
    }
    const translationEl = h("div", { class: "segment-translation" }, translatedText || "");
    const block = h("div", { class: "list-row-block" }, [
      h("div", { class: "list-row", style: "align-items:flex-start;" }, [
        h("span", { class: "muted", style: "font-size:11px;min-width:44px;" }, aiClient.formatSeconds(seg.start)),
        h("span", { style: "flex:1;" }, seg.text),
      ]),
      translationEl,
    ]);
    return { block, translationEl };
  }

  // 录音页"实时转录"面板固定了高度、超出会滚动（见 style.css .record-transcript-list），
  // 但内容一直往后加时浏览器不会自己跟着滚下去——用户反馈"一直停在最上面不动"就是这个。
  // 这两个小工具：只有用户本来就停留在（接近）底部时才自动帮他滚到新内容，如果他特意往上
  // 滚去看前面讲的内容，就不要每来一句新的就把他强行拽回底部。
  const SCROLL_NEAR_BOTTOM_PX = 48;

  function isScrollNearBottom(el) {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_NEAR_BOTTOM_PX;
  }

  function scrollToBottom(el) {
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  /** 把 base64 数据从 Blob 里读出来（去掉 "data:image/png;base64," 这个前缀，只留
   * Anthropic API 要的纯 base64 正文）。 */
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result || "";
        const commaIndex = result.indexOf(",");
        resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
      };
      reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
      reader.readAsDataURL(blob);
    });
  }

  /**
   * 把一条笔记上传的材料整理成"整理笔记"提示词能用的形状：PPT 已经在上传时解析成了
   * 纯文本，直接拼进 materialsText；拍照图片这时候才从 IndexedDB 里读出 Blob 转成
   * base64，作为 images 传给 callClaude，让 Claude 用视觉能力直接读图（不用自己先做
   * OCR）。单张图片读取失败不影响其它材料和正常生成笔记，直接跳过那一张。
   */
  async function collectMaterialsForPrompt(note) {
    const materials = note.materials || [];
    const textParts = [];
    const images = [];
    for (const m of materials) {
      if (m.kind === "pptx") {
        if (m.extractedText) textParts.push(`【PPT：${m.name || "未命名"}】\n${m.extractedText}`);
      } else if (m.kind === "docx") {
        if (m.extractedText) textParts.push(`【Word 文档：${m.name || "未命名"}】\n${m.extractedText}`);
      } else if (m.kind === "image" && m.storageKey) {
        try {
          const blob = await loadMaterialImage(m.storageKey);
          if (blob) {
            const base64Data = await blobToBase64(blob);
            images.push({ base64Data, mediaType: blob.type || "image/jpeg" });
          }
        } catch {
          // 图片读取失败就跳过，不阻塞整体生成
        }
      }
    }
    return { materialsText: textParts.join("\n\n"), images };
  }

  /** 删除一条笔记时，把它上传的图片材料在 IndexedDB 里的 Blob 也一起清掉（PPT 材料只存了
   * 文字、随 store.js 的笔记记录一起删就行，不用额外处理）。单张删除失败不影响其它张。 */
  function deleteNoteMaterialImages(note) {
    (note.materials || []).forEach((m) => {
      if (m.kind === "image" && m.storageKey) {
        deleteMaterialImage(m.storageKey).catch(() => {});
      }
    });
  }

  // ---------- 新建课堂笔记：标题 + 讲课语言 + 互译语言多选，跟 modal.js 的单表单弹窗
  // 字段类型不够用（要多选），所以跟 readingNotes.js 的 openNotesModal 一样手搭一个。 ----------

  function openNewNoteModal(store, defaultCourseId, onStart) {
    let overlay;
    let sourceLang = "fr";
    let courseId = defaultCourseId || null;
    const targetSet = new Set();
    // 录音还没开始、笔记还没建出来，这时候选的材料先留在内存里：图片留着原始 File
    // （等笔记有 id 了才批量存进 IndexedDB），PPT 不依赖笔记 id、可以立刻在客户端解析
    // 成文字直接存文字。跟"笔记详情页随时上传"（renderMaterialsCard）是同一套逻辑，
    // 只是这里推迟到点"开始录音"那一刻才真正落盘。
    let pendingMaterials = []; // [{kind:"image", name, file} | {kind:"pptx", name, extractedText}]
    let materialsBusy = false;
    let materialsStatus = "";

    function box() {
      const titleInput = h("input", { class: "field-input", type: "text", placeholder: "标题（选填，比如“经济学导论 第3讲”）" });

      const sourceSelect = h(
        "select",
        { class: "field-input" },
        store.CLASS_NOTE_LANGUAGES.map((l) => h("option", { value: l.code }, l.label))
      );
      sourceSelect.value = sourceLang;
      sourceSelect.addEventListener("change", (e) => {
        sourceLang = e.target.value;
        targetSet.delete(sourceLang);
        rerenderBox(titleInput.value);
      });

      const targetChecks = store.CLASS_NOTE_LANGUAGES.filter((l) => l.code !== sourceLang).map((l) =>
        h("label", { class: "toggle-row" }, [
          h("input", {
            type: "checkbox",
            checked: targetSet.has(l.code) || undefined,
            onChange: (e) => {
              if (e.target.checked) targetSet.add(l.code);
              else targetSet.delete(l.code);
            },
          }),
          h("span", {}, l.label),
        ])
      );

      // 所属课程：默认带出打开这个弹窗时所在的课程（从某门课的笔记列表里点"+新建这门课的
      // 笔记"进来的话），也可以在这里改成别的课程或者"未分类"——不想在这一步纠结课程归属
      // 的话，之后随时能在笔记详情页里改（见 setClassNoteCourseId）。
      const courses = store.listClassNoteCourses();
      const courseSelect = h(
        "select",
        { class: "field-input" },
        [h("option", { value: "" }, "未分类"), ...courses.map((c) => h("option", { value: c.id }, c.name))]
      );
      courseSelect.value = courseId || "";
      courseSelect.addEventListener("change", (e) => {
        courseId = e.target.value || null;
      });

      const photoInput = h("input", { type: "file", accept: "image/*", multiple: true, style: "display:none;" });
      const pptxInput = h("input", {
        type: "file",
        accept: ".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation",
        style: "display:none;",
      });
      const docxInput = h("input", {
        type: "file",
        accept: ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        style: "display:none;",
      });

      photoInput.addEventListener("change", () => {
        const files = Array.from(photoInput.files || []);
        photoInput.value = "";
        if (!files.length) return;
        files.forEach((file) => pendingMaterials.push({ kind: "image", name: file.name, file }));
        rerenderBox(titleInput.value);
      });

      pptxInput.addEventListener("change", async () => {
        const files = Array.from(pptxInput.files || []);
        pptxInput.value = "";
        if (!files.length) return;
        const keepTitle = titleInput.value;
        materialsBusy = true;
        for (const file of files) {
          materialsStatus = `正在解析 PPT「${file.name}」…`;
          rerenderBox(keepTitle);
          try {
            const buffer = await file.arrayBuffer();
            const extractedText = await extractPptxText(buffer);
            pendingMaterials.push({ kind: "pptx", name: file.name, extractedText });
            materialsStatus = "";
          } catch (err) {
            materialsStatus = `解析 PPT「${file.name}」失败：${(err && err.message) || "请确认是有效的 .pptx 文件"}`;
          }
        }
        materialsBusy = false;
        rerenderBox(keepTitle);
      });

      docxInput.addEventListener("change", async () => {
        const files = Array.from(docxInput.files || []);
        docxInput.value = "";
        if (!files.length) return;
        const keepTitle = titleInput.value;
        materialsBusy = true;
        for (const file of files) {
          materialsStatus = `正在解析 Word 文档「${file.name}」…`;
          rerenderBox(keepTitle);
          try {
            const buffer = await file.arrayBuffer();
            const extractedText = await extractDocxText(buffer);
            pendingMaterials.push({ kind: "docx", name: file.name, extractedText });
            materialsStatus = "";
          } catch (err) {
            materialsStatus = `解析 Word 文档「${file.name}」失败：${(err && err.message) || "请确认是有效的 .docx 文件"}`;
          }
        }
        materialsBusy = false;
        rerenderBox(keepTitle);
      });

      const materialsListEl = pendingMaterials.length
        ? h(
            "div", { style: "display:flex;flex-direction:column;gap:6px;margin-top:6px;" },
            pendingMaterials.map((m, idx) =>
              h("div", { class: "list-row", style: "align-items:center;" }, [
                h("span", { style: "flex:1;font-size:12px;" }, `${materialIcon(m.kind)} ${m.name}`),
                h(
                  "span",
                  {
                    class: "row-delete",
                    onClick: () => {
                      pendingMaterials.splice(idx, 1);
                      rerenderBox(titleInput.value);
                    },
                  },
                  "删除"
                ),
              ])
            )
          )
        : null;

      return h("div", {}, [
        h("div", { class: "modal-title" }, "新建课堂笔记"),
        h("label", { class: "field-row" }, [h("span", { class: "field-label" }, "标题"), titleInput]),
        h("label", { class: "field-row" }, [h("span", { class: "field-label" }, "讲课语言"), sourceSelect]),
        courses.length ? h("label", { class: "field-row" }, [h("span", { class: "field-label" }, "所属课程"), courseSelect]) : null,
        h("div", { class: "field-label", style: "margin:10px 0 4px;" }, "需要互译成哪些语言（可多选，可以不选）"),
        h("div", { class: "toggle-grid" }, targetChecks),
        h("div", { class: "field-label", style: "margin:10px 0 4px;" }, "上传材料（选填，之后也能随时在笔记详情页里补充）"),
        h("div", { class: "section-row", style: "gap:8px;" }, [
          h("button", { type: "button", class: "btn btn-outline btn-sm", onClick: () => photoInput.click() }, "+ 上传照片"),
          h("button", { type: "button", class: "btn btn-outline btn-sm", onClick: () => pptxInput.click() }, "+ 上传 PPT"),
          h("button", { type: "button", class: "btn btn-outline btn-sm", onClick: () => docxInput.click() }, "+ 上传 Word"),
          photoInput,
          pptxInput,
          docxInput,
        ]),
        materialsListEl,
        materialsStatus ? h("div", { class: "muted", style: "font-size:12px;margin-top:4px;" }, materialsStatus) : null,
        h("div", { class: "modal-actions" }, [
          h("button", { type: "button", class: "btn btn-ghost", onClick: () => overlay.remove() }, "取消"),
          h(
            "button",
            {
              type: "button",
              class: "btn btn-primary",
              disabled: materialsBusy || undefined,
              onClick: async (e) => {
                const title = titleInput.value.trim();
                const startBtn = e.currentTarget;
                startBtn.disabled = true;
                startBtn.textContent = "创建中…";
                const note = store.addClassNote({ title, sourceLang, targetLangs: [...targetSet], courseId });
                for (const m of pendingMaterials) {
                  try {
                    if (m.kind === "image") {
                      const key = makeMaterialKey(note.id);
                      await saveMaterialImage(key, m.file);
                      store.addClassNoteMaterial(note.id, { kind: "image", name: m.name, storageKey: key });
                    } else {
                      store.addClassNoteMaterial(note.id, { kind: m.kind, name: m.name, extractedText: m.extractedText });
                    }
                  } catch {
                    // 单条材料保存失败不阻塞开始录音，笔记本身已经建好了
                  }
                }
                overlay.remove();
                onStart(note);
              },
            },
            "开始录音"
          ),
        ]),
      ]);
    }

    function rerenderBox(keepTitle) {
      mount(overlay.querySelector(".modal-box"), box());
      if (keepTitle) overlay.querySelector(".modal-box input[type=text]").value = keepTitle;
    }

    overlay = h("div", { class: "modal-overlay" }, [h("div", { class: "modal-box" }, [box()])]);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
  }

  // ---------- 上传一份已经录好的录音文件，生成一条笔记：不是现场录音，没有"实时识别"
  // 这一步，转录内容要靠「数据与设置」里配置的云端语音识别服务生成——跟"整体重新识别"
  // 是同一套底层逻辑（speechToTextProviders.transcribeAudioBlob），复用 renderTranscriptTab
  // 里"重新识别"那一栏：这条笔记天生没有"实时识别"内容（hasLive 为 false），转录 tab
  // 会自动停在"重新识别"栏，用户在那里点"开始整体重新识别"就行，这里不用重复实现一遍
  // 识别流程，只管把笔记和音频文件建好。 ----------

  function openUploadAudioModal(store, defaultCourseId, onCreated) {
    let overlay;
    let sourceLang = "fr";
    let courseId = defaultCourseId || null;
    let audioFile = null;
    const targetSet = new Set();
    let busy = false;
    let statusText = "";

    function box() {
      const titleInput = h("input", { class: "field-input", type: "text", placeholder: "标题（选填，比如“外部录音·经济学讲座”）" });

      const sourceSelect = h(
        "select",
        { class: "field-input" },
        store.CLASS_NOTE_LANGUAGES.map((l) => h("option", { value: l.code }, l.label))
      );
      sourceSelect.value = sourceLang;
      sourceSelect.addEventListener("change", (e) => {
        sourceLang = e.target.value;
        targetSet.delete(sourceLang);
        rerenderBox(titleInput.value);
      });

      const targetChecks = store.CLASS_NOTE_LANGUAGES.filter((l) => l.code !== sourceLang).map((l) =>
        h("label", { class: "toggle-row" }, [
          h("input", {
            type: "checkbox",
            checked: targetSet.has(l.code) || undefined,
            onChange: (e) => {
              if (e.target.checked) targetSet.add(l.code);
              else targetSet.delete(l.code);
            },
          }),
          h("span", {}, l.label),
        ])
      );

      const courses = store.listClassNoteCourses();
      const courseSelect = h(
        "select",
        { class: "field-input" },
        [h("option", { value: "" }, "未分类"), ...courses.map((c) => h("option", { value: c.id }, c.name))]
      );
      courseSelect.value = courseId || "";
      courseSelect.addEventListener("change", (e) => {
        courseId = e.target.value || null;
      });

      const audioInput = h("input", { type: "file", accept: "audio/*", style: "display:none;" });
      const audioBtn = h(
        "button",
        { type: "button", class: "btn btn-outline btn-sm", onClick: () => audioInput.click() },
        audioFile ? `已选择：${audioFile.name}` : "+ 选择录音文件"
      );
      audioInput.addEventListener("change", () => {
        const files = Array.from(audioInput.files || []);
        audioFile = files[0] || null;
        rerenderBox(titleInput.value);
      });

      return h("div", {}, [
        h("div", { class: "modal-title" }, "上传录音文件生成笔记"),
        h(
          "div", { class: "muted", style: "font-size:12px;margin-bottom:8px;" },
          "适合在别的地方（比如手机备忘录、录音笔）已经录好的音频，比如没赶上用这个 App 现场录的课，或者会议、讲座录音。上传之后需要在「数据与设置」配置好语音识别服务的密钥，才能在笔记详情页里生成转录文字。"
        ),
        h("label", { class: "field-row" }, [h("span", { class: "field-label" }, "标题"), titleInput]),
        h("label", { class: "field-row" }, [h("span", { class: "field-label" }, "音频里说的语言"), sourceSelect]),
        courses.length ? h("label", { class: "field-row" }, [h("span", { class: "field-label" }, "所属课程"), courseSelect]) : null,
        h("div", { class: "field-label", style: "margin:10px 0 4px;" }, "需要互译成哪些语言（可多选，可以不选，之后随时能改）"),
        h("div", { class: "toggle-grid" }, targetChecks),
        h("div", { class: "field-label", style: "margin:10px 0 4px;" }, "录音文件"),
        h("div", { class: "section-row", style: "gap:8px;" }, [audioBtn, audioInput]),
        statusText ? h("div", { class: "muted", style: "font-size:12px;margin-top:8px;" }, statusText) : null,
        h("div", { class: "modal-actions" }, [
          h("button", { type: "button", class: "btn btn-ghost", onClick: () => overlay.remove() }, "取消"),
          h(
            "button",
            {
              type: "button",
              class: "btn btn-primary",
              disabled: busy || !audioFile || undefined,
              onClick: async (e) => {
                if (!audioFile) return;
                busy = true;
                const btn = e.currentTarget;
                btn.disabled = true;
                btn.textContent = "创建中…";
                const title = titleInput.value.trim();
                const note = store.addClassNote({
                  title, sourceLang, targetLangs: [...targetSet], courseId, sourceType: "uploaded",
                });
                let audioKey = null;
                try {
                  audioKey = makeAudioKey(note.id);
                  await saveAudio(audioKey, audioFile);
                } catch {
                  audioKey = null;
                }
                store.finishClassNoteRecording(note.id, { durationSeconds: 0, audioKey });
                overlay.remove();
                onCreated(note, { audioSaved: Boolean(audioKey) });
              },
            },
            "生成笔记"
          ),
        ]),
      ]);
    }

    function rerenderBox(keepTitle) {
      mount(overlay.querySelector(".modal-box"), box());
      if (keepTitle) overlay.querySelector(".modal-box input[type=text]").value = keepTitle;
    }

    overlay = h("div", { class: "modal-overlay" }, [h("div", { class: "modal-box" }, [box()])]);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
  }

  // ---------- 互译语言随时可改：录音页和详情页共用同一个弹窗。讲课语言（sourceLang）
  // 建好笔记之后不能再改——它绑定的是语音识别引擎的识别语种，中途换会打断正在进行的
  // 识别；但互译目标语言只是"转录完之后再翻译成什么"，随时改都不影响转录本身，改完后
  // 新增的语言会在下一次翻译时（自动翻译轮询，或详情页手动点"翻译"）把已有的转录内容
  // 一起补上，不需要额外的"补翻译"入口。 ----------
  function openTargetLangsModal(store, note, onSaved) {
    let overlay;
    const targetSet = new Set(note.targetLangs);

    function box() {
      const checks = store.CLASS_NOTE_LANGUAGES.filter((l) => l.code !== note.sourceLang).map((l) =>
        h("label", { class: "toggle-row" }, [
          h("input", {
            type: "checkbox",
            checked: targetSet.has(l.code) || undefined,
            onChange: (e) => {
              if (e.target.checked) targetSet.add(l.code);
              else targetSet.delete(l.code);
            },
          }),
          h("span", {}, l.label),
        ])
      );
      return h("div", {}, [
        h("div", { class: "modal-title" }, "互译语言"),
        h(
          "div", { class: "muted", style: "font-size:12px;margin-bottom:8px;" },
          "随时可以增加或去掉互译语言；新增的语言会在下一次翻译时自动把已经转录的内容一起补上。"
        ),
        h("div", { class: "toggle-grid" }, checks),
        h("div", { class: "modal-actions" }, [
          h("button", { type: "button", class: "btn btn-ghost", onClick: () => overlay.remove() }, "取消"),
          h(
            "button",
            {
              type: "button", class: "btn btn-primary",
              onClick: () => {
                store.setClassNoteTargetLangs(note.id, [...targetSet]);
                overlay.remove();
                onSaved();
              },
            },
            "保存"
          ),
        ]),
      ]);
    }

    overlay = h("div", { class: "modal-overlay" }, [h("div", { class: "modal-box" }, [box()])]);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
  }

  // ---------- 录音页：开始/暂停/继续/结束，实时转录逐行展示 ----------

  function startRecordingSession(store, note, rerender) {
    recordStartError = null;
    liveError = null;
    silenceHint = null;
    recordingNoteId = note.id;
    liveTranslateLang = note.targetLangs[0] || null;
    autoTranslateBusy = false;
    autoTranslateErrors = {};
    // 从"现在"开始算第一个间隔，而不是从0开始（那样第一次 watchdog tick 就会立刻触发翻译）：
    // 先攒一小段转录内容再翻译，跟用户要的"录一小段后统一翻译比较精准"是一回事。
    lastAutoTranslateAt = Date.now();
    const langTag = SPEECH_LANG_TAGS[note.sourceLang] || "en-US";

    const instance = createSpeechRecorder({
      lang: langTag,
      onTranscriptSegment: (seg) => {
        if (!recordingRefs || recordingNoteId !== note.id) return;
        if (seg.isFinal) {
          store.appendClassNoteTranscript(note.id, { start: seg.start, end: seg.end, text: seg.text });
          recordingRefs.captionEl.textContent = "";
          // 新这一句刚存进去，它在 transcriptSegments 里的下标就是当前长度-1；如果这个
          // 下标之前已经有翻译过（比如暂停又继续、这句其实是重新渲染前就有的），直接带出来，
          // 不用等下一次自动翻译轮询。
          const index = note.transcriptSegments.length - 1;
          const existing = liveTranslateLang ? (note.translations[liveTranslateLang] || [])[index] : null;
          const { block, translationEl } = buildSegmentBlock(
            { start: seg.start, text: seg.text },
            existing ? existing.text : null,
            note.targetLangs.length > 0
          );
          const wasNearBottom = isScrollNearBottom(recordingRefs.segmentListEl);
          recordingRefs.segmentListEl.appendChild(block);
          recordingRefs.segmentSlots.push(translationEl);
          if (wasNearBottom) scrollToBottom(recordingRefs.segmentListEl);
        } else {
          recordingRefs.captionEl.textContent = seg.text;
        }
      },
      onStateChange: () => rerender(),
      onError: (err) => {
        liveError = err.message;
        rerender();
      },
      onSilence: (streak) => {
        if (streak === 0) {
          if (!silenceHint) return; // 本来就没提示，不用白白触发一次重渲染
          silenceHint = null;
          rerender();
          return;
        }
        if (streak < SILENCE_HINT_STREAK) return;
        if (silenceHint) return; // 已经在提示了，避免每次 no-speech 都重渲染一次
        silenceHint =
          "已经有一段时间没检测到声音了：检查一下麦克风有没有被静音、Mac 的「系统设置→隐私与安全性→麦克风」里有没有给这个浏览器开权限，或者是不是有别的软件正占用麦克风；转录和录音还在继续，声音恢复后这条提示会自动消失。";
        rerender();
      },
    });
    recorder = instance;
    instance.start().catch((err) => {
      recorder = null;
      recordingNoteId = null;
      recordStartError = err.message;
      rerender();
    });
  }

  async function finishRecording(store, note, rerender) {
    stopWatchdog();
    const activeRecorder = recorder;
    recorder = null;
    recordingNoteId = null;
    // 这几行必须在真正 await activeRecorder.stop() 之前就把 view 切到"详情页"：
    // activeRecorder.stop() 内部会同步触发一次 onStateChange（这次状态变化是"停止"），
    // 而 onStateChange 又会调用 rerender()——如果这时候 view.mode 还停在 "record"，
    // 就会撞上 renderRecordView 里"recorder 为空就自动开始录音"的逻辑（那段逻辑是给
    // "刚打开录音页、还没真正开始录"这种情况设计的），结果凭空又拉起一次全新的录音，
    // 而用户其实已经点了"结束录音"——造成一个"僵尸录音"：界面看着已经停在详情页，
    // 后台却又在悄悄录一条没人知道的新音频，"+新建笔记"相关按钮也会一直被"有笔记
    // 正在录音"误锁住，直到手动刷新页面才能解除。
    view = { mode: "detail", noteId: note.id };
    detailTab = "transcript";
    activeTranslationLang = note.targetLangs[0] || null;
    activeNotesLang = NOTES_SOURCE_KEY;
    flashcardIndex = 0;
    flashcardFlipped = false;
    qaBusy = false;
    qaError = null;
    transcriptViewMode = "live";
    retranscriptActiveLang = null;
    retranscribeBusy = false;
    retranscribeProgress = null;
    retranscribeError = null;
    if (!activeRecorder) {
      rerender();
      return;
    }
    let result;
    try {
      result = await activeRecorder.stop();
    } catch {
      result = { audioBlob: null, durationSeconds: note.audioDurationSeconds || 0 };
    }
    let audioKey = null;
    if (result.audioBlob) {
      audioKey = makeAudioKey(note.id);
      try {
        await saveAudio(audioKey, result.audioBlob);
      } catch {
        audioKey = null;
      }
    }
    store.finishClassNoteRecording(note.id, { durationSeconds: result.durationSeconds, audioKey });
    // 停止录音时，识别引擎可能还有几句"最终结果"是在 stop() 之后才通过 onTranscriptSegment
    // 落到 note.transcriptSegments 里的；这里补翻译一次，追上最后这一小段。注意：故意不
    // await 它——翻译服务可能很慢、也可能因为网络问题一直不返回，"结束录音"这个操作不应该
    // 因为翻译卡住而迟迟不能跳转（用户可能已经赶时间去下一节课了）。翻译在后台完成后直接
    // 写进 store；详情页"转录"tab 现在是原文+译文合并静态渲染的（不像录音页那样有定时器
    // 会自己去改DOM），所以这里翻完之后主动 rerender() 一次，用户不用自己切走再切回来
    // 才能看到刚补上的译文——前提是这时候还停在这条笔记的详情页（万一用户已经点开了别的
    // 笔记，就不要凭空把界面切走）。没赶上/失败了也没关系，"转录"tab 里随时能手动点
    // "翻译"补上。
    if (note.targetLangs.length) {
      runAutoTranslateTick(store, note, {})
        .catch(() => {})
        .then(() => {
          if (view.mode === "detail" && view.noteId === note.id) rerender();
        });
    }
    rerender();
  }

  let recordingRefs = null; // { captionEl, segmentListEl, segmentSlots } —— 给 startRecordingSession
  // 的回调和自动翻译的 tick 直接改 DOM 用，不走整页重渲染；segmentSlots 是"译文那一格"DOM节点
  // 的数组，下标跟 note.transcriptSegments 一一对应，译文异步到达/切换显示语言时按下标去改。

  function renderRecordView(container, store, ctx, rerender) {
    const note = store.findClassNote(view.noteId);
    if (!note) {
      view = { mode: "list" };
      rerender();
      return;
    }

    if (!recorder && !recordStartError) {
      startRecordingSession(store, note, rerender);
    }

    const isReady = Boolean(recorder) && recorder.getState() !== "idle";
    const isPaused = Boolean(recorder) && recorder.getState() === "paused";

    const elapsedEl = h("div", { style: "font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;" }, "00:00");
    const stateLabelEl = h("div", { class: "muted", style: "font-size:12px;" },
      recordStartError ? "" : !recorder ? "正在准备录音…" : !isReady ? "正在连接麦克风…" : isPaused ? "已暂停" : "录音中…");
    const captionEl = h("div", { class: "record-caption" }, "");

    // ---------- 原文+译文合并成一个列表：只有这条笔记选了互译语言时，每一行才会多出下面
    // 缩进的译文那一格；没选互译语言就是原来纯原文的样子，没有任何变化。多个目标语言时用
    // 胶囊切换显示哪一种，切换只是把每一格译文的文字换掉，不重新发翻译请求。 ----------
    const hasTargetLangs = note.targetLangs.length > 0;
    const settings = store.getSettings();
    const hasTranslationKey = translationProviders.isProviderConfigured(settings.translationProvider, translationKeysFromSettings(settings));
    const translationStatusEl = h("div", { class: "muted", style: "font-size:12px;margin-top:6px;" }, "");

    if (hasTargetLangs && (!liveTranslateLang || !note.targetLangs.includes(liveTranslateLang))) {
      liveTranslateLang = note.targetLangs[0];
    }

    function refreshTranslationStatus() {
      if (autoTranslateBusy) {
        translationStatusEl.textContent = "翻译中…";
        return;
      }
      translationStatusEl.textContent = autoTranslateErrors[liveTranslateLang] || "";
    }

    const segmentSlots = [];
    const segmentListEl = h(
      "div", { class: "record-transcript-list" },
      note.transcriptSegments.map((seg, i) => {
        const existing = hasTargetLangs && liveTranslateLang ? (note.translations[liveTranslateLang] || [])[i] : null;
        const { block, translationEl } = buildSegmentBlock(seg, existing ? existing.text : null, hasTargetLangs);
        segmentSlots.push(translationEl);
        return block;
      })
    );
    recordingRefs = { captionEl, segmentListEl, segmentSlots };

    let langSwitcher = null;
    if (hasTargetLangs && note.targetLangs.length > 1) {
      langSwitcher = createSegmented({
        kind: "pill",
        options: note.targetLangs.map((code) => ({ key: code, label: langLabel(store, code) })),
        activeKey: liveTranslateLang,
        onSelect: (key) => {
          liveTranslateLang = key;
          const arr = note.translations[key] || [];
          recordingRefs.segmentSlots.forEach((el, i) => {
            if (el) el.textContent = (arr[i] && arr[i].text) || "";
          });
          refreshTranslationStatus();
        },
      });
    }
    if (hasTargetLangs) refreshTranslationStatus();

    const pauseBtn = h(
      "button",
      {
        class: "btn btn-outline", type: "button", disabled: !isReady || undefined,
        onClick: () => {
          if (!recorder) return;
          if (recorder.getState() === "paused") recorder.resume();
          else recorder.pause();
        },
      },
      isPaused ? "继续" : "暂停"
    );
    const stopBtn = h(
      "button",
      { class: "btn btn-danger", type: "button", onClick: () => finishRecording(store, note, rerender) },
      "结束录音"
    );

    mount(
      container,
      h("div", { style: "display:flex;flex-direction:column;gap:14px;" }, [
        recordStartError
          ? h("div", { class: "card danger-card" }, [
              h("div", { class: "card-title" }, "没法开始录音"),
              h("div", { style: "margin-top:6px;" }, recordStartError),
              h(
                "button",
                {
                  class: "btn btn-outline", type: "button", style: "margin-top:10px;",
                  onClick: () => {
                    view = { mode: "detail", noteId: note.id };
                    recordStartError = null;
                    rerender();
                  },
                },
                "返回笔记"
              ),
            ])
          : h("div", { class: "card" }, [
              h("div", { class: "section-row", style: "justify-content:space-between;align-items:flex-start;" }, [
                h("div", {}, [
                  h("div", { class: "card-title" }, note.title || "未命名笔记"),
                  h("div", { class: "muted", style: "font-size:12px;margin-top:2px;" }, `讲课语言：${langLabel(store, note.sourceLang)}`),
                ]),
                h("div", { style: "text-align:right;" }, [elapsedEl, stateLabelEl]),
              ]),
              liveError ? h("div", { style: "margin-top:8px;color:hsl(4,70%,55%);font-size:12px;" }, liveError) : null,
              silenceHint
                ? h("div", { style: "margin-top:8px;color:hsl(35,80%,45%);font-size:12px;" }, silenceHint)
                : null,
              h("div", { class: "section-row", style: "margin-top:12px;" }, [pauseBtn, stopBtn]),
            ]),
        h("div", { class: "card" }, [
          h("div", { class: "section-row", style: "justify-content:space-between;align-items:center;" }, [
            h("div", { class: "card-title" }, "实时转录"),
            h(
              "button",
              {
                class: "btn btn-outline btn-sm", type: "button",
                onClick: () => openTargetLangsModal(store, note, () => rerender()),
              },
              hasTargetLangs ? "编辑互译语言" : "+ 互译语言"
            ),
          ]),
          hasTargetLangs && langSwitcher ? langSwitcher.el : null,
          hasTargetLangs && !hasTranslationKey
            ? h(
                "div", { class: "muted", style: "font-size:12px;margin-top:6px;" },
                `还没配置当前使用的翻译服务（${providerLabel(store, settings.translationProvider)}），去「数据与设置」的「多语言互译服务」里填一个才能自动翻译；转录内容还是会照常实时显示。`
              )
            : null,
          hasTargetLangs ? translationStatusEl : null,
          segmentListEl,
          captionEl,
        ]),
      ])
    );
    // 每次整页重新渲染（开始录音、暂停/继续、报错等触发的 rerender）都会把转录列表
    // 整个重新画一遍，这时候默认停在最底部（最新内容），而不是留在浏览器默认的顶部——
    // 正在录音时最新内容才是用户想看到的。
    scrollToBottom(segmentListEl);

    stopWatchdog();
    watchdogTimer = setInterval(() => {
      if (container.dataset.activeModuleId !== meta.id) {
        // 用户已经切到别的模块了：静默结束这次录音，不强行拉他回到这个页面。
        finishRecording(store, note, () => {});
        return;
      }
      if (recorder) elapsedEl.textContent = aiClient.formatSeconds(recorder.elapsedSeconds());
      // 自动翻译：每隔 AUTO_TRANSLATE_INTERVAL_MS 才检查一次，不是每秒都联网；只在
      // "正在录音"（不是暂停/还没连上）时触发，暂停时新内容也不会增加，没什么可翻的。
      if (hasTargetLangs && recorder && recorder.getState() === "recording") {
        const now = Date.now();
        if (now - lastAutoTranslateAt >= AUTO_TRANSLATE_INTERVAL_MS) {
          lastAutoTranslateAt = now;
          runAutoTranslateTick(store, note, {
            onSegments: (lang, segments) => {
              // 只更新当前正显示的这一种语言的格子；没在显示的语言其实也翻完了、已经写进
              // note.translations 了，只是不用现在改 DOM——等用户切过去那个语言时，
              // 上面胶囊的 onSelect 会直接从 note.translations 里读最新内容填进去。
              if (lang !== liveTranslateLang || !recordingRefs) return;
              const total = (note.translations[lang] || []).length;
              const startIndex = total - segments.length;
              const wasNearBottom = isScrollNearBottom(recordingRefs.segmentListEl);
              segments.forEach((seg, i) => {
                const el = recordingRefs.segmentSlots[startIndex + i];
                if (el) el.textContent = seg.text;
              });
              if (wasNearBottom) scrollToBottom(recordingRefs.segmentListEl);
            },
            onTick: refreshTranslationStatus,
          });
        }
      }
    }, 1000);
  }

  // ---------- 详情页：笔记 / 转录 / 翻译 三个 tab ----------

  function renderDetailView(container, store, ctx, rerender) {
    const note = store.findClassNote(view.noteId);
    if (!note) {
      view = { mode: "list" };
      rerender();
      return;
    }
    const settings = store.getSettings();
    const hasClaudeKey = Boolean(settings.claudeApiKey);
    const hasTranslationKey = translationProviders.isProviderConfigured(
      settings.translationProvider,
      translationKeysFromSettings(settings)
    );

    function openRenameModal() {
      openFormModal({
        title: "改标题",
        fields: [{ name: "title", label: "标题", type: "text" }],
        initialValues: { title: note.title },
        onSubmit: (v) => {
          store.renameClassNote(note.id, v.title.trim());
          rerender();
        },
      });
    }

    // 笔记随时可以改归属课程——不管建的时候有没有选，或者后来想把它挪到别的课程里。
    function openMoveCourseModal() {
      const courses = store.listClassNoteCourses();
      openFormModal({
        title: "移动到其它课程",
        fields: [
          {
            name: "courseId", label: "所属课程", type: "select",
            options: [{ value: "", label: "未分类" }, ...courses.map((c) => ({ value: c.id, label: c.name }))],
          },
        ],
        initialValues: { courseId: note.courseId || "" },
        onSubmit: (v) => {
          store.setClassNoteCourseId(note.id, v.courseId || null);
          rerender();
        },
      });
    }

    // ---------- 转录 tab：原文+译文合并显示（用户明确要求"一句话的原文和翻译在同一个
    // 格子里，下一句再另起一格"），不再单独分一个"翻译" tab。没选互译语言时就是纯原文。
    // "实时识别"（录音过程中 Web Speech API 现场转出来的）和"重新识别"（录音结束后
    // 用云端语音识别服务整体重新识别一遍，见下面 buildRetranscriptPane）保留两份，
    // 用户可以随时切换对比——这两份内容渲染逻辑几乎一样（都是"原文+译文合并显示、
    // 可选目标语言、可以点按钮翻译"），所以抽成 renderTranslatableTranscript 公用。 ----------

    /**
     * translateNew(lang)/translateAll(lang)：具体怎么翻译由调用方决定（实时转录是"只翻译
     * 还没翻译过的新增部分"，重新识别的内容不会再增长、两个回调做的是同一件事——整段翻译），
     * 这里只管通用的"选语言、点按钮、显示原文+译文"这套 UI 外壳。
     */
    function renderTranslatableTranscript({
      segments, translations, targetLangs, getActiveLang, setActiveLang,
      translateNew, translateAll, onChanged,
    }) {
      if (!targetLangs.length) {
        return h("div", { class: "card" }, segments.map(renderTranscriptRow));
      }
      let activeLang = getActiveLang();
      if (!activeLang || !targetLangs.includes(activeLang)) {
        activeLang = targetLangs[0];
        setActiveLang(activeLang);
      }

      const bodySlot = h("div", { style: "margin-top:12px;" });
      function refreshBody() {
        mount(bodySlot, buildBody());
      }

      function buildBody() {
        const translated = translations[activeLang] || [];
        const pendingCount = segments.length - translated.length;
        const currentProvider = store.getSettings().translationProvider;
        const statusEl = h(
          "div", { class: "muted", style: "font-size:12px;margin:6px 0 10px;" },
          hasTranslationKey ? "" : `还没配置当前使用的翻译服务（${providerLabel(store, currentProvider)}），去「数据与设置」的「多语言互译服务」里填一个才能翻译；原文还是会照常显示。`
        );

        async function doTranslateNew() {
          transBtn.disabled = true;
          const prevLabel = transBtn.textContent;
          transBtn.textContent = "翻译中…";
          statusEl.textContent = `${providerLabel(store, currentProvider)}正在翻译，可能需要几秒…`;
          try {
            await translateNew(activeLang);
            onChanged();
          } catch (err) {
            transBtn.disabled = false;
            transBtn.textContent = prevLabel;
            statusEl.textContent = err.message || "翻译失败";
          }
        }

        async function doTranslateAll() {
          redoBtn.disabled = true;
          transBtn.disabled = true;
          const prevLabel = redoBtn.textContent;
          redoBtn.textContent = "翻译中…";
          statusEl.textContent = `${providerLabel(store, currentProvider)}正在重新翻译全部内容，可能需要几秒…`;
          try {
            await translateAll(activeLang);
            onChanged();
          } catch (err) {
            redoBtn.disabled = false;
            redoBtn.textContent = prevLabel;
            transBtn.disabled = !hasTranslationKey || pendingCount <= 0 || undefined;
            statusEl.textContent = err.message || "翻译失败";
          }
        }

        const transBtn = h(
          "button",
          {
            class: "btn btn-outline btn-sm", type: "button",
            disabled: !hasTranslationKey || pendingCount <= 0 || undefined,
            onClick: doTranslateNew,
          },
          !translated.length ? `翻译成${langLabel(store, activeLang)}` : pendingCount > 0 ? `翻译新增的${pendingCount}句` : "已翻译到最新"
        );
        const redoBtn = translated.length
          ? h(
              "button",
              {
                class: "btn btn-ghost btn-sm", type: "button",
                disabled: !hasTranslationKey || !segments.length || undefined,
                onClick: doTranslateAll,
              },
              "全部重新翻译"
            )
          : null;

        return h("div", {}, [
          h("div", { class: "section-row", style: "justify-content:flex-end;gap:8px;" }, [redoBtn, transBtn]),
          statusEl,
          h(
            "div", { class: "card" },
            segments.map((seg, i) => buildSegmentBlock(seg, translated[i] ? translated[i].text : null, true).block)
          ),
        ]);
      }

      const langSeg = targetLangs.length > 1
        ? createSegmented({
            kind: "pill",
            options: targetLangs.map((code) => ({ key: code, label: langLabel(store, code) })),
            activeKey: activeLang,
            onSelect: (key) => {
              setActiveLang(key);
              refreshBody();
            },
          })
        : null;
      refreshBody();
      return h("div", {}, [langSeg ? langSeg.el : null, bodySlot]);
    }

    function buildLivePane() {
      return renderTranslatableTranscript({
        segments: note.transcriptSegments,
        translations: note.translations,
        targetLangs: note.targetLangs,
        getActiveLang: () => activeTranslationLang,
        setActiveLang: (lang) => { activeTranslationLang = lang; },
        // 录音过程中已经自动翻译过一部分（见 renderRecordView 的自动翻译），这里的"翻译"
        // 按钮只追赶还没翻译过的新内容，不会把已经翻译好的部分重新翻一遍多花一次请求。
        translateNew: (lang) => translateNewSegments(store, note, lang),
        translateAll: async (lang) => {
          const settings = store.getSettings();
          const segments = await translationProviders.translateSegments({
            provider: settings.translationProvider,
            segments: note.transcriptSegments,
            targetLangCode: lang,
            keys: translationKeysFromSettings(settings),
          });
          store.setClassNoteTranslation(note.id, lang, segments);
        },
        onChanged: rerender,
      });
    }

    /**
     * "重新识别"整段一次性生成、不会像实时转录那样持续增长，所以这里的两个回调做的其实是
     * 同一件事——整段翻译 note.retranscript.segments，写回 store.setClassNoteRetranscriptTranslation。
     */
    function buildRetranscribedPane() {
      return renderTranslatableTranscript({
        segments: note.retranscript.segments,
        translations: note.retranscript.translations || {},
        targetLangs: note.targetLangs,
        getActiveLang: () => retranscriptActiveLang,
        setActiveLang: (lang) => { retranscriptActiveLang = lang; },
        translateNew: (lang) => translateRetranscriptAll(lang),
        translateAll: (lang) => translateRetranscriptAll(lang),
        onChanged: rerender,
      });
    }

    async function translateRetranscriptAll(lang) {
      const settings = store.getSettings();
      const segments = await translationProviders.translateSegments({
        provider: settings.translationProvider,
        segments: note.retranscript.segments,
        targetLangCode: lang,
        keys: translationKeysFromSettings(settings),
      });
      store.setClassNoteRetranscriptTranslation(note.id, lang, segments);
    }

    // ---------- "整体重新识别"：录音结束后，把完整的录音文件重新整段识别一遍，弥补
    // Web Speech API 实时识别经常漏内容的问题（网络抖动、讲话太快跟不上、浏览器标签页
    // 切到后台等原因都可能让实时识别漏听一截）；用的是「数据与设置」里配置的 Google/Azure
    // 语音识别服务，需要用户自己的密钥、自己付费——跟"实时识别"免费但可能漏内容不一样，
    // 这是"更慢但更完整"的备选方案，两份都保留，可以随时切换对比。 ----------
    function buildRetranscribePrompt() {
      const settings = store.getSettings();
      const sttProvider = settings.sttProvider;
      const sttConfigured = speechToTextProviders.isSttProviderConfigured(sttProvider, settings);
      const hasAudio = Boolean(note.audioKey);
      const canRun = hasAudio && sttConfigured && !retranscribeBusy;

      const hintEl = h("div", { class: "muted", style: "font-size:12px;margin-top:8px;" }, [
        !hasAudio
          ? "这条笔记没有保存下录音文件（可能是很早之前的旧笔记，或者当时保存失败），没法整体重新识别。"
          : !sttConfigured
            ? `还没配置当前使用的语音识别服务（${sttProviderLabel(store, sttProvider)}），去「数据与设置」的「语音转文字服务」里填一个才能用这个功能。`
            : "整段音频会按大约 55 秒一段切开分批发送识别，一堂课可能需要几分钟，请不要中途离开这个页面。",
      ]);

      async function runRetranscribe() {
        retranscribeBusy = true;
        retranscribeError = null;
        retranscribeProgress = { index: 0, total: 0 };
        refreshTab();
        try {
          const blob = await loadAudio(note.audioKey);
          if (!blob) throw new Error("没有读取到这条笔记的录音文件，可能已经被清理了");
          const segments = await speechToTextProviders.transcribeAudioBlob({
            provider: sttProvider,
            keys: settings,
            blob,
            languageCode: SPEECH_LANG_TAGS[note.sourceLang] || "en-US",
            onProgress: (p) => {
              retranscribeProgress = p;
              refreshTab();
            },
          });
          if (!segments.length) throw new Error("没有从这段录音里识别出任何内容");
          store.setClassNoteRetranscript(note.id, { provider: sttProvider, segments });
          // "上传录音文件"这类笔记建笔记的时候还不知道音频有多长（没有现场录音的计时器），
          // 借这次识别结果顺便补上一个大概的时长——最后一段有内容的识别结果的结束时间。
          if (note.sourceType === "uploaded") {
            const lastEnd = segments[segments.length - 1].end || 0;
            store.finishClassNoteRecording(note.id, { durationSeconds: lastEnd, audioKey: note.audioKey });
          }
          retranscribeBusy = false;
          retranscribeProgress = null;
          transcriptViewMode = "retranscript";
          retranscriptActiveLang = null;
          rerender();
        } catch (err) {
          retranscribeBusy = false;
          retranscribeProgress = null;
          retranscribeError = err.message || "识别失败";
          refreshTab();
        }
      }

      const progressText = retranscribeProgress
        ? retranscribeProgress.total > 0
          ? `正在识别第 ${retranscribeProgress.index + 1}/${retranscribeProgress.total} 段…`
          : "正在准备音频…"
        : null;

      return h("div", { class: "card" }, [
        h("div", { class: "card-title" }, note.retranscript ? "重新生成整体识别结果" : "整体重新识别"),
        hintEl,
        note.retranscript
          ? h(
              "div", { class: "muted", style: "font-size:12px;margin-top:4px;" },
              `上一次是用${sttProviderLabel(store, note.retranscript.provider)}识别的，生成于 ${new Date(note.retranscript.generatedAt).toLocaleString("zh-CN")}；重新生成会覆盖掉这一份（连同已经翻译好的内容）。`
            )
          : null,
        h("div", { class: "section-row", style: "margin-top:10px;" }, [
          h(
            "button",
            { class: "btn btn-primary btn-sm", type: "button", disabled: !canRun || undefined, onClick: runRetranscribe },
            retranscribeBusy ? "识别中…" : note.retranscript ? "重新生成" : "开始整体重新识别"
          ),
        ]),
        progressText ? h("div", { class: "muted", style: "font-size:12px;margin-top:8px;" }, progressText) : null,
        retranscribeError ? h("div", { style: "color:hsl(4,70%,55%);font-size:12px;margin-top:8px;" }, retranscribeError) : null,
      ]);
    }

    function buildRetranscriptPane() {
      if (!note.retranscript) return buildRetranscribePrompt();
      return h("div", {}, [buildRetranscribePrompt(), buildRetranscribedPane()]);
    }

    let refreshTab = () => {};

    function renderTranscriptTab() {
      const hasLive = note.transcriptSegments.length > 0;
      const hasRetranscript = Boolean(note.retranscript);
      const hasAudio = Boolean(note.audioKey);
      // 真的什么都没有（没有实时转录、没有重新识别过、连录音文件都没有）才显示"还没有
      // 转录内容"——"上传录音文件生成笔记"刚建好时正是这种"有音频、但还没识别过"的
      // 状态（hasLive/hasRetranscript 都是 false，但 hasAudio 是 true），这时候应该让
      // 用户能看到"开始整体重新识别"的入口，而不是一个只会显示"没有内容"的死页面。
      if (!hasLive && !hasRetranscript && !hasAudio) {
        return h("div", { class: "empty-hint" }, "还没有转录内容");
      }
      // "上传录音文件生成笔记"（sourceType: "uploaded"）这类笔记压根没有"实时识别"这一份
      // （录音不是现场录的，谈不上实时），直接停在"重新识别"，不给一个空的"实时识别"可切。
      if (!hasLive) transcriptViewMode = "retranscript";

      const bodySlot = h("div", { style: "margin-top:12px;" });
      refreshTab = () => mount(bodySlot, transcriptViewMode === "retranscript" ? buildRetranscriptPane() : buildLivePane());

      const modeSeg = hasLive
        ? createSegmented({
            kind: "pill",
            options: [
              { key: "live", label: "实时识别" },
              { key: "retranscript", label: hasRetranscript ? "重新识别" : "重新识别（未生成）" },
            ],
            activeKey: transcriptViewMode,
            onSelect: (key) => {
              transcriptViewMode = key;
              refreshTab();
            },
          })
        : null;

      refreshTab();
      return h("div", {}, [modeSeg ? modeSeg.el : null, bodySlot]);
    }

    // ---------- 笔记 tab：原文（AI 整理出来的 Markdown）+ 可以再翻译成其它语言。
    // "整理笔记"本身只用 Claude、只会生成一份 sourceLang 语言的笔记；"把笔记翻译成
    // 别的语言"是另一步，复用跟转录一样的翻译服务（Google/Azure/DeepL 当前选中的那家），
    // 直接把整份 Markdown 文本当一段文本传过去翻译，格式标记（标题号、列表、表格）
    // 是普通字符，多数情况下译文里能原样保留，不需要额外处理。 ----------
    function renderNotesTab() {
      const langOptions = [
        { key: NOTES_SOURCE_KEY, label: "原文" },
        ...note.targetLangs.map((code) => ({ key: code, label: langLabel(store, code) })),
      ];
      if (!langOptions.some((o) => o.key === activeNotesLang)) {
        activeNotesLang = NOTES_SOURCE_KEY;
      }

      const bodySlot = h("div", { style: "margin-top:12px;" });
      function refreshBody() {
        mount(bodySlot, buildBody());
      }

      function buildSourceBody() {
        const statusEl = h(
          "div", { class: "muted", style: "font-size:12px;margin:6px 0 10px;" },
          hasClaudeKey ? "" : "还没设置 AI 服务密钥，去「数据与设置」填一个才能用这个功能"
        );

        async function generateNotes() {
          genBtn.disabled = true;
          const prevLabel = genBtn.textContent;
          genBtn.textContent = "整理中…";
          statusEl.textContent = (note.materials || []).length
            ? "AI 正在结合课件材料整理笔记，可能需要几秒到十几秒…"
            : "AI 正在整理笔记，可能需要几秒到十几秒…";
          try {
            const { materialsText, images } = await collectMaterialsForPrompt(note);
            const text = await aiClient.callClaude({
              apiKey: store.getSettings().claudeApiKey,
              system: "你是一个帮学生整理课堂笔记的助手，只输出笔记正文本身，不要输出任何多余的解释。",
              prompt: aiClient.buildNotesPrompt(note.transcriptSegments, note.sourceLang, materialsText),
              images,
            });
            store.setClassNoteMarkdown(note.id, text);
            rerender();
          } catch (err) {
            genBtn.disabled = false;
            genBtn.textContent = prevLabel;
            statusEl.textContent = err.message || "生成笔记失败";
          }
        }

        const genBtn = h(
          "button",
          {
            class: "btn btn-primary", type: "button",
            disabled: !hasClaudeKey || !note.transcriptSegments.length || undefined,
            onClick: generateNotes,
          },
          note.notesMarkdown ? "重新整理笔记" : "生成笔记"
        );

        return h("div", {}, [
          h("div", { class: "section-row", style: "justify-content:flex-end;" }, [genBtn]),
          statusEl,
          renderMarkdown(note.notesMarkdown),
        ]);
      }

      function buildTranslatedBody(lang) {
        const notesTranslations = note.notesTranslations || {};
        const translatedMarkdown = notesTranslations[lang] || "";
        const currentProvider = store.getSettings().translationProvider;
        const statusEl = h(
          "div", { class: "muted", style: "font-size:12px;margin:6px 0 10px;" },
          !note.notesMarkdown
            ? "先在「原文」里生成笔记，才能翻译成其它语言"
            : hasTranslationKey
              ? ""
              : `还没配置当前使用的翻译服务（${providerLabel(store, currentProvider)}），去「数据与设置」的「多语言互译服务」里填一个才能翻译`
        );

        async function translateNotesNow() {
          transBtn.disabled = true;
          const prevLabel = transBtn.textContent;
          transBtn.textContent = "翻译中…";
          statusEl.textContent = `${providerLabel(store, currentProvider)}正在翻译笔记，可能需要几秒…`;
          try {
            const settings = store.getSettings();
            const [translatedText] = await translationProviders.translateTexts({
              provider: settings.translationProvider,
              texts: [note.notesMarkdown],
              targetLangCode: lang,
              keys: translationKeysFromSettings(settings),
            });
            store.setClassNoteNotesTranslation(note.id, lang, translatedText || "");
            rerender();
          } catch (err) {
            transBtn.disabled = false;
            transBtn.textContent = prevLabel;
            statusEl.textContent = err.message || "翻译笔记失败";
          }
        }

        const transBtn = h(
          "button",
          {
            class: "btn btn-outline btn-sm", type: "button",
            disabled: !hasTranslationKey || !note.notesMarkdown || undefined,
            onClick: translateNotesNow,
          },
          translatedMarkdown ? `重新翻译成${langLabel(store, lang)}` : `翻译成${langLabel(store, lang)}`
        );

        return h("div", {}, [
          h("div", { class: "section-row", style: "justify-content:flex-end;" }, [transBtn]),
          statusEl,
          translatedMarkdown
            ? renderMarkdown(translatedMarkdown)
            : h("div", { class: "empty-hint" }, "还没有翻译"),
        ]);
      }

      function buildBody() {
        return activeNotesLang === NOTES_SOURCE_KEY ? buildSourceBody() : buildTranslatedBody(activeNotesLang);
      }

      const langSeg = langOptions.length > 1
        ? createSegmented({
            kind: "pill",
            options: langOptions,
            activeKey: activeNotesLang,
            onSelect: (key) => {
              activeNotesLang = key;
              refreshBody();
            },
          })
        : null;
      refreshBody();
      return h("div", {}, [langSeg ? langSeg.el : null, bodySlot]);
    }

    // ---------- 课件材料：不属于任何一个 tab，是"笔记"（以及思维导图）生成时会用到的
    // 共同输入，所以放在 tab 切换栏上面、详情页里始终可见的一张卡片，不管切到哪个 tab
    // 都能随时补充/删除——对应用户"两个时机都要"（开始录音前 + 之后随时）里"之后随时"
    // 这一半，"开始录音前"那一半在 openNewNoteModal 里。 ----------
    function renderMaterialsCard() {
      const materials = note.materials || [];
      const statusEl = h("div", { class: "muted", style: "font-size:12px;margin-top:8px;" }, "");

      const photoInput = h("input", { type: "file", accept: "image/*", multiple: true, style: "display:none;" });
      const pptxInput = h("input", {
        type: "file",
        accept: ".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation",
        style: "display:none;",
      });
      const docxInput = h("input", {
        type: "file",
        accept: ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        style: "display:none;",
      });

      function setBusy(busy) {
        photoBtn.disabled = busy || undefined;
        pptxBtn.disabled = busy || undefined;
        docxBtn.disabled = busy || undefined;
      }

      // 注意：只有真的成功存进至少一条材料时才 rerender()——rerender() 会把整个详情页
      // （包括这张材料卡片本身）重新渲染出一份全新的 DOM，这个函数里的 statusEl 也会被
      // 换成一个全新的、空文字的实例。如果某个文件失败了却仍然 rerender()，刚设置的错误
      // 提示文字会在浏览器还没来得及画出来之前就被这次 rerender() 冲掉，用户永远看不到。
      // 全部失败时干脆不 rerender()，让这次 mount 好的 statusEl 就地留着错误提示。
      photoInput.addEventListener("change", async () => {
        const files = Array.from(photoInput.files || []);
        photoInput.value = "";
        if (!files.length) return;
        setBusy(true);
        let anyAdded = false;
        for (const file of files) {
          statusEl.textContent = `正在保存照片「${file.name}」…`;
          try {
            const key = makeMaterialKey(note.id);
            await saveMaterialImage(key, file);
            store.addClassNoteMaterial(note.id, { kind: "image", name: file.name, storageKey: key });
            anyAdded = true;
            statusEl.textContent = "";
          } catch (err) {
            statusEl.textContent = `保存照片「${file.name}」失败：${(err && err.message) || "未知错误"}`;
          }
        }
        setBusy(false);
        if (anyAdded) rerender();
      });

      pptxInput.addEventListener("change", async () => {
        const files = Array.from(pptxInput.files || []);
        pptxInput.value = "";
        if (!files.length) return;
        setBusy(true);
        let anyAdded = false;
        for (const file of files) {
          statusEl.textContent = `正在解析 PPT「${file.name}」…`;
          try {
            const buffer = await file.arrayBuffer();
            const extractedText = await extractPptxText(buffer);
            store.addClassNoteMaterial(note.id, { kind: "pptx", name: file.name, extractedText });
            anyAdded = true;
            statusEl.textContent = "";
          } catch (err) {
            statusEl.textContent = `解析 PPT「${file.name}」失败：${(err && err.message) || "请确认是有效的 .pptx 文件"}`;
          }
        }
        setBusy(false);
        if (anyAdded) rerender();
      });

      docxInput.addEventListener("change", async () => {
        const files = Array.from(docxInput.files || []);
        docxInput.value = "";
        if (!files.length) return;
        setBusy(true);
        let anyAdded = false;
        for (const file of files) {
          statusEl.textContent = `正在解析 Word 文档「${file.name}」…`;
          try {
            const buffer = await file.arrayBuffer();
            const extractedText = await extractDocxText(buffer);
            store.addClassNoteMaterial(note.id, { kind: "docx", name: file.name, extractedText });
            anyAdded = true;
            statusEl.textContent = "";
          } catch (err) {
            statusEl.textContent = `解析 Word 文档「${file.name}」失败：${(err && err.message) || "请确认是有效的 .docx 文件"}`;
          }
        }
        setBusy(false);
        if (anyAdded) rerender();
      });

      const photoBtn = h("button", { type: "button", class: "btn btn-outline btn-sm", onClick: () => photoInput.click() }, "+ 上传照片");
      const pptxBtn = h("button", { type: "button", class: "btn btn-outline btn-sm", onClick: () => pptxInput.click() }, "+ 上传 PPT");
      const docxBtn = h("button", { type: "button", class: "btn btn-outline btn-sm", onClick: () => docxInput.click() }, "+ 上传 Word");

      function materialRow(m) {
        return h("div", { class: "list-row", style: "align-items:center;" }, [
          h("span", { style: "flex:1;font-size:13px;" }, `${materialIcon(m.kind)} ${m.name || "未命名"}`),
          h(
            "span",
            {
              class: "row-delete",
              onClick: () => {
                if (m.kind === "image" && m.storageKey) deleteMaterialImage(m.storageKey).catch(() => {});
                store.removeClassNoteMaterial(note.id, m.id);
                rerender();
              },
            },
            "删除"
          ),
        ]);
      }

      return h("div", { class: "card" }, [
        h("div", { class: "section-row", style: "justify-content:space-between;align-items:center;" }, [
          h("div", { class: "card-title" }, "课件材料"),
          h("div", { class: "section-row", style: "gap:8px;" }, [photoBtn, pptxBtn, docxBtn, photoInput, pptxInput, docxInput]),
        ]),
        materials.length
          ? h("div", { style: "margin-top:8px;display:flex;flex-direction:column;gap:6px;" }, materials.map(materialRow))
          : h(
              "div", { class: "muted", style: "font-size:12px;margin-top:8px;" },
              "还没有上传材料——可以上传老师的 PPT/Word 课件文字，或拍照的板书/讲义照片，生成笔记时会一并参考。"
            ),
        statusEl,
      ]);
    }

    // ---------- 闪卡 / 测验 / 提问 / 思维导图：都是在"笔记"tab 生成好的 notesMarkdown
    // 基础上再让 AI 加工一次，所以几个 tab 都要求先有 notesMarkdown，没有的话只显示提示，
    // 不出现"生成"按钮——跟"笔记"tab 里翻译子 tab 的 gating 是同一个道理。 ----------

    function renderFlashcardsTab() {
      const cards = note.flashcards || [];
      const statusEl = h(
        "div", { class: "muted", style: "font-size:12px;margin:6px 0 10px;" },
        !note.notesMarkdown
          ? "先在「笔记」tab 生成笔记，才能生成闪卡"
          : hasClaudeKey ? "" : "还没设置 AI 服务密钥，去「数据与设置」填一个才能用这个功能"
      );

      async function generateFlashcards() {
        genBtn.disabled = true;
        const prevLabel = genBtn.textContent;
        genBtn.textContent = "生成中…";
        statusEl.textContent = "AI 正在根据笔记生成闪卡，可能需要几秒到十几秒…";
        try {
          const text = await aiClient.callClaude({
            apiKey: store.getSettings().claudeApiKey,
            system: "你是一个帮学生制作复习闪卡的助手，只输出要求的 JSON，不要输出任何多余的解释。",
            prompt: aiClient.buildFlashcardsPrompt(note.notesMarkdown, note.sourceLang),
          });
          const parsed = aiClient.parseFlashcardsResponse(text);
          if (!parsed.length) throw aiClient.aiClientError("AI 没有生成出可用的闪卡，请重试一次", "empty_response");
          store.setClassNoteFlashcards(note.id, parsed);
          flashcardIndex = 0;
          flashcardFlipped = false;
          rerender();
        } catch (err) {
          genBtn.disabled = false;
          genBtn.textContent = prevLabel;
          statusEl.textContent = err.message || "生成闪卡失败";
        }
      }

      const genBtn = h(
        "button",
        {
          class: "btn btn-primary", type: "button",
          disabled: !hasClaudeKey || !note.notesMarkdown || undefined,
          onClick: generateFlashcards,
        },
        cards.length ? "重新生成闪卡" : "生成闪卡"
      );

      if (!cards.length) {
        return h("div", {}, [
          h("div", { class: "section-row", style: "justify-content:flex-end;" }, [genBtn]),
          statusEl,
          h("div", { class: "empty-hint" }, "还没有闪卡"),
        ]);
      }

      if (flashcardIndex >= cards.length) flashcardIndex = 0;
      const card = cards[flashcardIndex];

      return h("div", {}, [
        h("div", { class: "section-row", style: "justify-content:flex-end;" }, [genBtn]),
        statusEl,
        h(
          "div",
          {
            class: "card flashcard-card", style: "cursor:pointer;",
            onClick: () => { flashcardFlipped = !flashcardFlipped; rerender(); },
          },
          [
            h("div", { class: "muted", style: "font-size:11px;" }, "问题"),
            h("div", { style: "margin-top:8px;font-size:14px;font-weight:600;" }, card.question),
            flashcardFlipped
              ? h("div", { style: "margin-top:16px;padding-top:12px;border-top:1px dashed var(--g-hairline);" }, [
                  h("div", { class: "muted", style: "font-size:11px;" }, "答案"),
                  h("div", { style: "margin-top:8px;font-size:14px;" }, card.answer),
                ])
              : h("div", { class: "muted", style: "margin-top:16px;font-size:12px;" }, "点击卡片查看答案"),
          ]
        ),
        h("div", { class: "section-row", style: "justify-content:space-between;align-items:center;margin-top:10px;" }, [
          h(
            "button",
            {
              class: "btn btn-outline btn-sm", type: "button",
              disabled: flashcardIndex === 0 || undefined,
              onClick: (e) => { e.stopPropagation(); flashcardIndex -= 1; flashcardFlipped = false; rerender(); },
            },
            "← 上一张"
          ),
          h("span", { class: "muted", style: "font-size:12px;" }, `${flashcardIndex + 1} / ${cards.length}`),
          h(
            "button",
            {
              class: "btn btn-outline btn-sm", type: "button",
              disabled: flashcardIndex >= cards.length - 1 || undefined,
              onClick: (e) => { e.stopPropagation(); flashcardIndex += 1; flashcardFlipped = false; rerender(); },
            },
            "下一张 →"
          ),
        ]),
      ]);
    }

    function renderQuizTab() {
      const quiz = note.quiz || [];
      const statusEl = h(
        "div", { class: "muted", style: "font-size:12px;margin:6px 0 10px;" },
        !note.notesMarkdown
          ? "先在「笔记」tab 生成笔记，才能生成测验"
          : hasClaudeKey ? "" : "还没设置 AI 服务密钥，去「数据与设置」填一个才能用这个功能"
      );

      async function generateQuiz() {
        genBtn.disabled = true;
        const prevLabel = genBtn.textContent;
        genBtn.textContent = "生成中…";
        statusEl.textContent = "AI 正在根据笔记生成测验题，可能需要几秒到十几秒…";
        try {
          const text = await aiClient.callClaude({
            apiKey: store.getSettings().claudeApiKey,
            system: "你是一个帮学生出复习测验题的助手，只输出要求的 JSON，不要输出任何多余的解释。",
            prompt: aiClient.buildQuizPrompt(note.notesMarkdown, note.sourceLang),
          });
          const parsed = aiClient.parseQuizResponse(text);
          if (!parsed.length) throw aiClient.aiClientError("AI 没有生成出可用的测验题，请重试一次", "empty_response");
          store.setClassNoteQuiz(note.id, parsed);
          rerender();
        } catch (err) {
          genBtn.disabled = false;
          genBtn.textContent = prevLabel;
          statusEl.textContent = err.message || "生成测验失败";
        }
      }

      const genBtn = h(
        "button",
        {
          class: "btn btn-primary", type: "button",
          disabled: !hasClaudeKey || !note.notesMarkdown || undefined,
          onClick: generateQuiz,
        },
        quiz.length ? "重新生成测验" : "生成测验"
      );

      if (!quiz.length) {
        return h("div", {}, [
          h("div", { class: "section-row", style: "justify-content:flex-end;" }, [genBtn]),
          statusEl,
          h("div", { class: "empty-hint" }, "还没有测验题"),
        ]);
      }

      // 还没作答（selectedIndex 是 null）时选项都是普通样式；选完之后正确选项标绿、
      // 选错了的那个标红，其它选项（包括正确答案不是自己选的那个）保持普通样式不变，
      // 跟截图里参考应用的效果一致。允许重新点别的选项改答案，直接覆盖上一次的记录。
      function optionClass(q, optIndex) {
        if (q.selectedIndex === null || q.selectedIndex === undefined) return "quiz-option";
        if (optIndex === q.correctIndex) return "quiz-option quiz-option-correct";
        if (optIndex === q.selectedIndex) return "quiz-option quiz-option-wrong";
        return "quiz-option";
      }

      const questionCards = quiz.map((q, qi) =>
        h("div", { class: "card", style: "margin-bottom:10px;" }, [
          h("div", { style: "font-size:13.5px;font-weight:600;margin-bottom:10px;" }, `${qi + 1}. ${q.question}`),
          h(
            "div", { style: "display:flex;flex-direction:column;gap:8px;" },
            q.options.map((opt, oi) =>
              h(
                "button",
                {
                  type: "button",
                  class: optionClass(q, oi),
                  onClick: () => { store.setClassNoteQuizAnswer(note.id, qi, oi); rerender(); },
                },
                opt
              )
            )
          ),
        ])
      );

      return h("div", {}, [
        h("div", { class: "section-row", style: "justify-content:flex-end;" }, [genBtn]),
        statusEl,
        h("div", {}, questionCards),
      ]);
    }

    function renderQaTab() {
      const messages = note.qaMessages || [];
      const disabledReason = !note.notesMarkdown
        ? "先在「笔记」tab 生成笔记，才能提问"
        : hasClaudeKey ? "" : "还没设置 AI 服务密钥，去「数据与设置」填一个才能用这个功能";
      const statusEl = h("div", { class: "muted", style: "font-size:12px;margin:6px 0 10px;" }, disabledReason);
      const canAsk = Boolean(note.notesMarkdown) && hasClaudeKey;

      const inputEl = h("input", {
        class: "field-input", type: "text", placeholder: "问一个关于这条笔记的问题…",
        disabled: !canAsk || qaBusy || undefined,
      });

      async function sendQuestion() {
        const question = inputEl.value.trim();
        if (!question || qaBusy || !canAsk) return;
        inputEl.value = "";
        store.addClassNoteQaMessage(note.id, "user", question);
        qaBusy = true;
        qaError = null;
        rerender();
        try {
          // 不含刚存进去的这条提问本身——buildQaPrompt 会把它作为"新问题"单独放在
          // 提示词最后，这里的 history 只是"这条之前"的历史，避免重复出现两遍。
          const history = (note.qaMessages || []).slice(0, -1);
          const answer = await aiClient.callClaude({
            apiKey: store.getSettings().claudeApiKey,
            system: "你是一个帮学生复习课堂笔记的助手，只根据提供的课堂笔记内容回答问题，笔记里没有的内容要如实说没有提到，不要编造。",
            prompt: aiClient.buildQaPrompt(note.notesMarkdown, note.sourceLang, history, question),
          });
          store.addClassNoteQaMessage(note.id, "assistant", answer);
        } catch (err) {
          qaError = err.message || "提问失败";
        }
        qaBusy = false;
        rerender();
      }

      inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") sendQuestion();
      });

      const sendBtn = h(
        "button",
        { class: "btn btn-primary btn-sm", type: "button", disabled: !canAsk || qaBusy || undefined, onClick: sendQuestion },
        qaBusy ? "思考中…" : "发送"
      );

      return h("div", {}, [
        statusEl,
        h(
          "div", { class: "card qa-messages" },
          messages.length
            ? messages.map((m) =>
                h("div", { class: m.role === "user" ? "qa-bubble qa-bubble-user" : "qa-bubble qa-bubble-assistant" }, m.text)
              )
            : [h("div", { class: "empty-hint" }, "还没有提问，问一个关于这条笔记的问题试试")]
        ),
        qaError ? h("div", { style: "color:hsl(4,70%,55%);font-size:12px;margin-top:6px;" }, qaError) : null,
        h("div", { class: "section-row", style: "margin-top:10px;" }, [inputEl, sendBtn]),
      ]);
    }

    // ---------- 思维导图：图形化节点连线图，同样要求先有 notesMarkdown 才能生成；
    // 渲染部分（renderMindMapSvg）来自 mindMap.js，这里只管按钮/状态文字/gating。 ----------
    function renderMindMapTab() {
      const statusEl = h(
        "div", { class: "muted", style: "font-size:12px;margin:6px 0 10px;" },
        !note.notesMarkdown
          ? "先在「笔记」tab 生成笔记，才能生成思维导图"
          : hasClaudeKey ? "" : "还没设置 AI 服务密钥，去「数据与设置」填一个才能用这个功能"
      );

      async function generateMindMap() {
        genBtn.disabled = true;
        const prevLabel = genBtn.textContent;
        genBtn.textContent = "生成中…";
        statusEl.textContent = "AI 正在根据笔记生成思维导图，可能需要几秒到十几秒…";
        try {
          const text = await aiClient.callClaude({
            apiKey: store.getSettings().claudeApiKey,
            system: "你是一个帮学生整理思维导图的助手，只输出要求的 JSON，不要输出任何多余的解释。",
            prompt: aiClient.buildMindMapPrompt(note.notesMarkdown, note.sourceLang),
          });
          const parsed = aiClient.parseMindMapResponse(text);
          if (!parsed) throw aiClient.aiClientError("AI 没有生成出可用的思维导图，请重试一次", "empty_response");
          store.setClassNoteMindMap(note.id, parsed);
          rerender();
        } catch (err) {
          genBtn.disabled = false;
          genBtn.textContent = prevLabel;
          statusEl.textContent = err.message || "生成思维导图失败";
        }
      }

      const genBtn = h(
        "button",
        {
          class: "btn btn-primary", type: "button",
          disabled: !hasClaudeKey || !note.notesMarkdown || undefined,
          onClick: generateMindMap,
        },
        note.mindMap ? "重新生成思维导图" : "生成思维导图"
      );

      if (!note.mindMap) {
        return h("div", {}, [
          h("div", { class: "section-row", style: "justify-content:flex-end;" }, [genBtn]),
          statusEl,
          h("div", { class: "empty-hint" }, "还没有思维导图"),
        ]);
      }

      return h("div", {}, [
        h("div", { class: "section-row", style: "justify-content:flex-end;" }, [genBtn]),
        statusEl,
        h("div", { class: "card mindmap-container" }, [renderMindMapSvg(note.mindMap)]),
      ]);
    }

    const contentSlot = h("div", { style: "margin-top:14px;" });
    function buildTabContent() {
      if (detailTab === "transcript") return renderTranscriptTab();
      if (detailTab === "flashcards") return renderFlashcardsTab();
      if (detailTab === "quiz") return renderQuizTab();
      if (detailTab === "qa") return renderQaTab();
      if (detailTab === "mindmap") return renderMindMapTab();
      return renderNotesTab();
    }
    function refreshTabContent() {
      mount(contentSlot, buildTabContent());
    }
    refreshTabContent();

    const tabsSeg = createSegmented({
      kind: "tabs",
      options: [
        { key: "notes", label: "笔记" },
        { key: "transcript", label: "转录" },
        { key: "flashcards", label: "闪卡" },
        { key: "quiz", label: "测验" },
        { key: "qa", label: "提问" },
        { key: "mindmap", label: "思维导图" },
      ],
      activeKey: detailTab,
      onSelect: (key) => {
        detailTab = key;
        refreshTabContent();
      },
    });

    mount(
      container,
      h("div", { style: "display:flex;flex-direction:column;gap:14px;" }, [
        h(
          "button",
          {
            class: "btn btn-ghost", type: "button", style: "align-self:flex-start;",
            onClick: () => { view = { mode: "courseNotes", courseId: note.courseId || null }; rerender(); },
          },
          "← 返回列表"
        ),
        h("div", { class: "card" }, [
          h("div", { class: "section-row", style: "justify-content:space-between;align-items:flex-start;" }, [
            h("div", {}, [
              h("div", { class: "card-title" }, note.title || "未命名笔记"),
              h(
                "div", { class: "muted", style: "font-size:12px;margin-top:4px;" },
                `${langLabel(store, note.sourceLang)} → ${note.targetLangs.map((c) => langLabel(store, c)).join("、") || "（无）"} · ${aiClient.formatSeconds(note.audioDurationSeconds)}`
              ),
            ]),
            h("span", { class: statusBadgeClass(note) }, statusLabel(note)),
          ]),
          h("div", { class: "section-row", style: "margin-top:10px;" }, [
            h("button", { class: "btn btn-outline btn-sm", type: "button", onClick: openRenameModal }, "改标题"),
            h("button", { class: "btn btn-outline btn-sm", type: "button", onClick: openMoveCourseModal }, "移动到其它课程"),
            h(
              "button",
              {
                class: "btn btn-outline btn-sm", type: "button",
                onClick: () => openTargetLangsModal(store, note, () => rerender()),
              },
              "编辑互译语言"
            ),
            h(
              "span",
              {
                class: "row-delete",
                onClick: () => {
                  openConfirm({
                    message: `删除《${note.title || "未命名笔记"}》？转录、翻译和笔记都会一起删除。`,
                    danger: true,
                    confirmLabel: "删除",
                    onConfirm: () => {
                      const backToCourseId = note.courseId || null;
                      deleteAudio(note.audioKey).catch(() => {});
                      deleteNoteMaterialImages(note);
                      store.removeClassNote(note.id);
                      view = { mode: "courseNotes", courseId: backToCourseId };
                      rerender();
                    },
                  });
                },
              },
              "删除"
            ),
          ]),
          note.status === "recording"
            ? h("div", { class: "empty-hint", style: "margin-top:10px;" }, [
                "这条笔记的录音没有正常结束（可能是页面被刷新过）。",
                h(
                  "button",
                  {
                    class: "btn btn-outline btn-sm", type: "button", style: "margin-left:8px;",
                    onClick: () => {
                      store.finishClassNoteRecording(note.id, { durationSeconds: note.audioDurationSeconds, audioKey: note.audioKey });
                      rerender();
                    },
                  },
                  "标记为已结束"
                ),
              ])
            : null,
        ]),
        renderMaterialsCard(),
        tabsSeg.el,
        contentSlot,
      ])
    );
  }

  // ---------- 列表页：顶层是"课程"列表（每门课可能上很多次课），点进某门课/"未分类"
  // 之后才是具体的笔记卡片列表——用户明确要求"多次课可以放在同一个文件夹里面，归属于
  // 同一个课程"。原来直接铺全部笔记的那一层现在挪到了 renderCourseNotesView 里。 ----------

  function renderNoteCard(store, note, rerender) {
    return h(
      "div",
      {
        class: "card", style: "cursor:pointer;",
        onClick: () => {
          view = { mode: "detail", noteId: note.id };
          detailTab = "notes";
          activeTranslationLang = note.targetLangs[0] || null;
          activeNotesLang = NOTES_SOURCE_KEY;
          flashcardIndex = 0;
          flashcardFlipped = false;
          qaBusy = false;
          qaError = null;
          transcriptViewMode = "live";
          retranscriptActiveLang = null;
          retranscribeBusy = false;
          retranscribeProgress = null;
          retranscribeError = null;
          rerender();
        },
      },
      [
        h("div", { class: "section-row", style: "justify-content:space-between;align-items:flex-start;" }, [
          h("div", { style: "font-size:14px;font-weight:600;" }, `${note.sourceType === "uploaded" ? "📤 " : ""}${note.title || "未命名笔记"}`),
          h("span", { class: statusBadgeClass(note) }, statusLabel(note)),
        ]),
        h(
          "div", { class: "muted", style: "font-size:12px;margin-top:6px;" },
          `${langLabel(store, note.sourceLang)} → ${note.targetLangs.map((c) => langLabel(store, c)).join("、") || "（未选互译语言）"}`
        ),
        h(
          "div", { class: "muted", style: "font-size:12px;margin-top:4px;" },
          `${aiClient.formatSeconds(note.audioDurationSeconds)} · ${new Date(note.createdAt).toLocaleString("zh-CN")}`
        ),
        h("div", { class: "section-row", style: "justify-content:flex-end;margin-top:10px;" }, [
          h(
            "span",
            {
              class: "row-delete",
              onClick: (e) => {
                e.stopPropagation();
                openConfirm({
                  message: `删除《${note.title || "未命名笔记"}》？转录、翻译和笔记都会一起删除。`,
                  danger: true,
                  confirmLabel: "删除",
                  onConfirm: () => {
                    deleteAudio(note.audioKey).catch(() => {});
                    deleteNoteMaterialImages(note);
                    store.removeClassNote(note.id);
                    rerender();
                  },
                });
              },
            },
            "删除"
          ),
        ]),
      ]
    );
  }

  function renderActiveRecordingBanner(rerender) {
    if (!recorder || !recordingNoteId) return null;
    return h("div", { class: "card", style: "border-left:3px solid hsl(38,80%,55%);" }, [
      h("div", { class: "section-row", style: "justify-content:space-between;align-items:center;" }, [
        h("span", {}, "有一条课堂笔记正在录音中"),
        h(
          "button",
          { class: "btn btn-outline btn-sm", type: "button", onClick: () => { view = { mode: "record", noteId: recordingNoteId }; rerender(); } },
          "去看看"
        ),
      ]),
    ]);
  }

  function renderMissingKeyHints(store) {
    const settings = store.getSettings();
    const hasClaudeKey = Boolean(settings.claudeApiKey);
    const hasTranslationKey = translationProviders.isProviderConfigured(settings.translationProvider, translationKeysFromSettings(settings));
    const hints = [];
    if (!hasClaudeKey) hints.push("AI 整理笔记需要先填 Claude API 密钥");
    if (!hasTranslationKey) hints.push(`多语言互译需要先配置当前使用的翻译服务（${providerLabel(store, settings.translationProvider)}）密钥`);
    return hints.length
      ? h("div", { class: "empty-hint" }, `还没配置好 AI 相关功能：录音转文字不需要密钥；${hints.join("；")}，去「数据与设置」填一下。`)
      : null;
  }

  function openNewCourseModal(store, rerender) {
    openFormModal({
      title: "新建课程",
      fields: [{ name: "name", label: "课程名称", type: "text", placeholder: "比如「宏观经济学」", required: true }],
      onSubmit: (v) => {
        store.addClassNoteCourse(v.name);
        rerender();
      },
    });
  }

  function openRenameCourseModal(store, course, rerender) {
    openFormModal({
      title: "课程改名",
      fields: [{ name: "name", label: "课程名称", type: "text", required: true }],
      initialValues: { name: course.name },
      onSubmit: (v) => {
        store.renameClassNoteCourse(course.id, v.name);
        rerender();
      },
    });
  }

  function renderCoursesOverview(container, store, ctx, rerender) {
    const courses = store.listClassNoteCoursesWithStats();
    const uncategorizedCount = store.listClassNotes(null).length;
    const browserOk = checkBrowserSupport();

    function courseCard(course) {
      return h(
        "div",
        { class: "card", style: "cursor:pointer;", onClick: () => { view = { mode: "courseNotes", courseId: course.id }; rerender(); } },
        [
          h("div", { class: "section-row", style: "justify-content:space-between;align-items:flex-start;" }, [
            h("div", { style: "font-size:14px;font-weight:600;" }, course.name),
            h("span", { class: "badge badge-info" }, `${course.noteCount} 次课`),
          ]),
          h(
            "div", { class: "muted", style: "font-size:12px;margin-top:6px;" },
            course.lastUpdatedAt ? `最近更新：${new Date(course.lastUpdatedAt).toLocaleString("zh-CN")}` : "还没有课时"
          ),
          h("div", { class: "section-row", style: "justify-content:flex-end;gap:12px;margin-top:10px;" }, [
            h(
              "button",
              {
                class: "btn btn-outline btn-sm", type: "button",
                onClick: (e) => { e.stopPropagation(); openRenameCourseModal(store, course, rerender); },
              },
              "改名"
            ),
            h(
              "span",
              {
                class: "row-delete",
                onClick: (e) => {
                  e.stopPropagation();
                  openConfirm({
                    message: `删除课程《${course.name}》？课程下的笔记不会被删除，会变成"未分类"。`,
                    danger: true,
                    confirmLabel: "删除",
                    onConfirm: () => { store.removeClassNoteCourse(course.id); rerender(); },
                  });
                },
              },
              "删除"
            ),
          ]),
        ]
      );
    }

    const uncategorizedCard = h(
      "div",
      { class: "card", style: "cursor:pointer;", onClick: () => { view = { mode: "courseNotes", courseId: null }; rerender(); } },
      [
        h("div", { class: "section-row", style: "justify-content:space-between;align-items:flex-start;" }, [
          h("div", { style: "font-size:14px;font-weight:600;" }, "未分类"),
          h("span", { class: "badge badge-info" }, `${uncategorizedCount} 次课`),
        ]),
        h("div", { class: "muted", style: "font-size:12px;margin-top:6px;" }, "还没有归到任何课程的笔记"),
      ]
    );

    mount(
      container,
      h("div", { style: "display:flex;flex-direction:column;gap:14px;" }, [
        h("div", { class: "section-row", style: "gap:8px;" }, [
          h("div", { class: "grow" }),
          h("button", { class: "btn btn-outline", type: "button", onClick: () => openNewCourseModal(store, rerender) }, "+ 新建课程"),
          h(
            "button",
            {
              class: "btn btn-outline", type: "button",
              onClick: () => openUploadAudioModal(store, null, (note) => {
                view = { mode: "detail", noteId: note.id };
                detailTab = "transcript";
                rerender();
              }),
            },
            "+ 上传录音文件生成笔记"
          ),
          h(
            "button",
            {
              class: "btn btn-primary", type: "button",
              disabled: Boolean(recorder) || !browserOk || undefined,
              onClick: () => openNewNoteModal(store, null, (note) => {
                view = { mode: "record", noteId: note.id };
                rerender();
              }),
            },
            "+ 新建课堂笔记"
          ),
        ]),
        renderActiveRecordingBanner(rerender),
        browserOk ? null : h("div", { class: "empty-hint" }, "当前浏览器不支持录音转文字，建议换用最新版 Chrome 或 Edge 桌面浏览器；已有的笔记不受影响，仍然可以查看。"),
        renderMissingKeyHints(store),
        courses.length || uncategorizedCount
          ? h("div", { class: "summary-grid" }, [...courses.map(courseCard), uncategorizedCard])
          : h("div", { class: "empty-hint" }, "还没有课堂笔记，点右上角开始第一条录音吧（可以先建一个课程，把同一门课的多次课都归到一起）"),
      ])
    );
  }

  function renderCourseNotesView(container, store, ctx, rerender) {
    const courseId = view.courseId || null;
    const course = courseId ? store.listClassNoteCourses().find((c) => c.id === courseId) : null;
    if (courseId && !course) {
      // 课程已经不存在了（比如刚被删掉）：回到课程列表，不留一个指向不存在课程的死页面。
      view = { mode: "list" };
      rerender();
      return;
    }
    const notes = store.listClassNotes(courseId);
    const browserOk = checkBrowserSupport();

    mount(
      container,
      h("div", { style: "display:flex;flex-direction:column;gap:14px;" }, [
        h(
          "button",
          { class: "btn btn-ghost", type: "button", style: "align-self:flex-start;", onClick: () => { view = { mode: "list" }; rerender(); } },
          "← 返回课程列表"
        ),
        h("div", { class: "section-row", style: "justify-content:space-between;align-items:center;gap:8px;" }, [
          h("div", { class: "card-title", style: "font-size:16px;" }, course ? course.name : "未分类"),
          h("div", { class: "grow" }),
          h(
            "button",
            {
              class: "btn btn-outline btn-sm", type: "button",
              onClick: () => openUploadAudioModal(store, courseId, (note) => {
                view = { mode: "detail", noteId: note.id };
                detailTab = "transcript";
                rerender();
              }),
            },
            "+ 上传录音文件"
          ),
          h(
            "button",
            {
              class: "btn btn-primary btn-sm", type: "button",
              disabled: Boolean(recorder) || !browserOk || undefined,
              onClick: () => openNewNoteModal(store, courseId, (note) => {
                view = { mode: "record", noteId: note.id };
                rerender();
              }),
            },
            "+ 新建这门课的笔记"
          ),
        ]),
        renderActiveRecordingBanner(rerender),
        browserOk ? null : h("div", { class: "empty-hint" }, "当前浏览器不支持录音转文字，建议换用最新版 Chrome 或 Edge 桌面浏览器；已有的笔记不受影响，仍然可以查看。"),
        renderMissingKeyHints(store),
        notes.length
          ? h("div", { class: "summary-grid" }, notes.map((note) => renderNoteCard(store, note, rerender)))
          : h("div", { class: "empty-hint" }, "这里还没有笔记"),
      ])
    );
  }

  function render(container, store, ctx) {
    ctx.setTopbar(meta.title, meta.subtitle);
    function rerender() {
      render(container, store, ctx);
    }

    if (view.mode !== "record") stopWatchdog();

    if (view.mode === "record") {
      renderRecordView(container, store, ctx, rerender);
    } else if (view.mode === "detail") {
      renderDetailView(container, store, ctx, rerender);
    } else if (view.mode === "courseNotes") {
      renderCourseNotesView(container, store, ctx, rerender);
    } else {
      renderCoursesOverview(container, store, ctx, rerender);
    }
  }

  return { meta, render, statusLabel, checkBrowserSupport };
});
