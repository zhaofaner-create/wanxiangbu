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
  const { saveAudio, deleteAudio, makeAudioKey } = require("../components/audioStore.js");
  const { parseMarkdownBlocks, parseInlineSegments } = require("../components/markdown.js");
  const aiClient = require("../aiClient.js");
  const translationProviders = require("../translationProviders.js");

  const meta = { id: "classNotes", label: "课堂笔记", title: "课堂笔记", subtitle: "录音转文字 · 多语言互译 · AI整理笔记" };

  // 录音转文字这一步走的是浏览器自带的 Web Speech API，免费、不需要密钥，但要联网
  // （语音识别在云端做），目前只有 Chrome / Edge 等 Chromium 内核浏览器支持得比较好；
  // "整理笔记"用的是用户自己在「数据与设置」填的 Claude API 密钥；"翻译"用的是用户在
  // 「数据与设置」的「多语言互译服务」里选中的那一家（Google 翻译/Azure Translator/
  // DeepL）的密钥——两者都是直接从浏览器调用官方接口，不经过我们自己的任何服务器。
  // 这些都是本模块特有的联网点，跟 App 其它模块的"完全离线"不一样，README 里有对应说明。

  // Web Speech API 认的是 BCP-47 语言标签（比如 "fr-FR"），跟 store.js 里
  // CLASS_NOTE_LANGUAGES 用的两位 ISO 代码不是一回事，这里做个映射。
  const SPEECH_LANG_TAGS = {
    zh: "zh-CN", en: "en-US", fr: "fr-FR", es: "es-ES", de: "de-DE",
    ja: "ja-JP", ko: "ko-KR", ru: "ru-RU", pt: "pt-PT", it: "it-IT",
  };

  // ---------- 模块级状态：跟 readingNotes.js 的 activeFilter、todayPlan.js 的
  // completedOpen/tickTimer 是一回事，靠闭包跨多次 render 保持住，不存进 store。 ----------
  let view = { mode: "list" }; // {mode:"list"} | {mode:"record", noteId:string} | {mode:"detail", noteId:string}
  let detailTab = "notes"; // "notes" | "transcript"（"转录" tab 现在原文+译文一起显示，不再单独分"翻译" tab）
  let activeTranslationLang = null;
  const NOTES_SOURCE_KEY = "__source__"; // "笔记"tab 语言切换里代表"原文"（sourceLang）的那个选项，不是真的语言代码
  let activeNotesLang = NOTES_SOURCE_KEY; // "笔记"tab 当前查看的是原文还是翻译成了哪个目标语言
  let flashcardIndex = 0; // "闪卡"tab 当前看到第几张（下标）
  let flashcardFlipped = false; // 当前这张卡片是不是已经翻到答案那面
  let qaBusy = false; // "提问"tab 上一次提问是不是还没等到 AI 回复
  let qaError = null; // "提问"tab 上一次提问失败的提示（成功一次或换问题重新问都会清空）
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

  // ---------- 新建课堂笔记：标题 + 讲课语言 + 互译语言多选，跟 modal.js 的单表单弹窗
  // 字段类型不够用（要多选），所以跟 readingNotes.js 的 openNotesModal 一样手搭一个。 ----------

  function openNewNoteModal(store, onStart) {
    let overlay;
    let sourceLang = "fr";
    const targetSet = new Set();

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

      return h("div", {}, [
        h("div", { class: "modal-title" }, "新建课堂笔记"),
        h("label", { class: "field-row" }, [h("span", { class: "field-label" }, "标题"), titleInput]),
        h("label", { class: "field-row" }, [h("span", { class: "field-label" }, "讲课语言"), sourceSelect]),
        h("div", { class: "field-label", style: "margin:10px 0 4px;" }, "需要互译成哪些语言（可多选，可以不选）"),
        h("div", { class: "toggle-grid" }, targetChecks),
        h("div", { class: "modal-actions" }, [
          h("button", { type: "button", class: "btn btn-ghost", onClick: () => overlay.remove() }, "取消"),
          h(
            "button",
            {
              type: "button",
              class: "btn btn-primary",
              onClick: () => {
                const title = titleInput.value.trim();
                overlay.remove();
                const note = store.addClassNote({ title, sourceLang, targetLangs: [...targetSet] });
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
          recordingRefs.segmentListEl.appendChild(block);
          recordingRefs.segmentSlots.push(translationEl);
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
    if (!activeRecorder) {
      view = { mode: "detail", noteId: note.id };
      detailTab = "transcript";
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
    view = { mode: "detail", noteId: note.id };
    detailTab = "transcript";
    activeTranslationLang = note.targetLangs[0] || null;
    activeNotesLang = NOTES_SOURCE_KEY;
    flashcardIndex = 0;
    flashcardFlipped = false;
    qaBusy = false;
    qaError = null;
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
          h("div", { class: "card-title" }, "实时转录"),
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
              segments.forEach((seg, i) => {
                const el = recordingRefs.segmentSlots[startIndex + i];
                if (el) el.textContent = seg.text;
              });
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

    // ---------- 转录 tab：原文+译文合并显示（用户明确要求"一句话的原文和翻译在同一个
    // 格子里，下一句再另起一格"），不再单独分一个"翻译" tab。没选互译语言时就是纯原文。 ----------
    function renderTranscriptTab() {
      if (!note.transcriptSegments.length) {
        return h("div", { class: "empty-hint" }, "还没有转录内容");
      }
      if (!note.targetLangs.length) {
        return h("div", { class: "card" }, note.transcriptSegments.map(renderTranscriptRow));
      }
      if (!activeTranslationLang || !note.targetLangs.includes(activeTranslationLang)) {
        activeTranslationLang = note.targetLangs[0];
      }

      const bodySlot = h("div", { style: "margin-top:12px;" });
      function refreshBody() {
        mount(bodySlot, buildBody());
      }

      function buildBody() {
        const translated = note.translations[activeTranslationLang] || [];
        const pendingCount = note.transcriptSegments.length - translated.length;
        const currentProvider = store.getSettings().translationProvider;
        const statusEl = h(
          "div", { class: "muted", style: "font-size:12px;margin:6px 0 10px;" },
          hasTranslationKey ? "" : `还没配置当前使用的翻译服务（${providerLabel(store, currentProvider)}），去「数据与设置」的「多语言互译服务」里填一个才能翻译；原文还是会照常显示。`
        );

        // 录音过程中已经自动翻译过一部分（见 renderRecordView 的自动翻译），这里的"翻译"
        // 按钮只追赶还没翻译过的新内容，不会把已经翻译好的部分重新翻一遍多花一次请求；
        // 如果想换一家服务商之后整段重新来一遍，用旁边的"全部重新翻译"。
        async function translateNow() {
          transBtn.disabled = true;
          const prevLabel = transBtn.textContent;
          transBtn.textContent = "翻译中…";
          statusEl.textContent = `${providerLabel(store, currentProvider)}正在翻译，可能需要几秒…`;
          try {
            await translateNewSegments(store, note, activeTranslationLang);
            rerender();
          } catch (err) {
            transBtn.disabled = false;
            transBtn.textContent = prevLabel;
            statusEl.textContent = err.message || "翻译失败";
          }
        }

        async function retranslateAll() {
          redoBtn.disabled = true;
          transBtn.disabled = true;
          const prevLabel = redoBtn.textContent;
          redoBtn.textContent = "翻译中…";
          statusEl.textContent = `${providerLabel(store, currentProvider)}正在重新翻译全部内容，可能需要几秒…`;
          try {
            const settings = store.getSettings();
            const segments = await translationProviders.translateSegments({
              provider: settings.translationProvider,
              segments: note.transcriptSegments,
              targetLangCode: activeTranslationLang,
              keys: translationKeysFromSettings(settings),
            });
            store.setClassNoteTranslation(note.id, activeTranslationLang, segments);
            rerender();
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
            onClick: translateNow,
          },
          !translated.length ? `翻译成${langLabel(store, activeTranslationLang)}` : pendingCount > 0 ? `翻译新增的${pendingCount}句` : "已翻译到最新"
        );
        const redoBtn = translated.length
          ? h(
              "button",
              {
                class: "btn btn-ghost btn-sm", type: "button",
                disabled: !hasTranslationKey || !note.transcriptSegments.length || undefined,
                onClick: retranslateAll,
              },
              "全部重新翻译"
            )
          : null;

        return h("div", {}, [
          h("div", { class: "section-row", style: "justify-content:flex-end;gap:8px;" }, [redoBtn, transBtn]),
          statusEl,
          h(
            "div", { class: "card" },
            note.transcriptSegments.map((seg, i) => buildSegmentBlock(seg, translated[i] ? translated[i].text : null, true).block)
          ),
        ]);
      }

      const langSeg = note.targetLangs.length > 1
        ? createSegmented({
            kind: "pill",
            options: note.targetLangs.map((code) => ({ key: code, label: langLabel(store, code) })),
            activeKey: activeTranslationLang,
            onSelect: (key) => {
              activeTranslationLang = key;
              refreshBody();
            },
          })
        : null;
      refreshBody();
      return h("div", {}, [langSeg ? langSeg.el : null, bodySlot]);
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
          statusEl.textContent = "AI 正在整理笔记，可能需要几秒到十几秒…";
          try {
            const text = await aiClient.callClaude({
              apiKey: store.getSettings().claudeApiKey,
              system: "你是一个帮学生整理课堂笔记的助手，只输出笔记正文本身，不要输出任何多余的解释。",
              prompt: aiClient.buildNotesPrompt(note.transcriptSegments, note.sourceLang),
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

    // ---------- 闪卡 / 测验 / 提问：都是在"笔记"tab 生成好的 notesMarkdown 基础上
    // 再让 AI 加工一次，所以三个 tab 都要求先有 notesMarkdown，没有的话只显示提示，
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

    const contentSlot = h("div", { style: "margin-top:14px;" });
    function buildTabContent() {
      if (detailTab === "transcript") return renderTranscriptTab();
      if (detailTab === "flashcards") return renderFlashcardsTab();
      if (detailTab === "quiz") return renderQuizTab();
      if (detailTab === "qa") return renderQaTab();
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
        h("button", { class: "btn btn-ghost", type: "button", style: "align-self:flex-start;", onClick: () => { view = { mode: "list" }; rerender(); } }, "← 返回列表"),
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
                      deleteAudio(note.audioKey).catch(() => {});
                      store.removeClassNote(note.id);
                      view = { mode: "list" };
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
        tabsSeg.el,
        contentSlot,
      ])
    );
  }

  // ---------- 列表页 ----------

  function renderListView(container, store, ctx, rerender) {
    const notes = store.listClassNotes();
    const settings = store.getSettings();
    const hasClaudeKey = Boolean(settings.claudeApiKey);
    const hasTranslationKey = translationProviders.isProviderConfigured(
      settings.translationProvider,
      translationKeysFromSettings(settings)
    );
    const missingKeyHints = [];
    if (!hasClaudeKey) missingKeyHints.push("AI 整理笔记需要先填 Claude API 密钥");
    if (!hasTranslationKey) missingKeyHints.push(`多语言互译需要先配置当前使用的翻译服务（${providerLabel(store, settings.translationProvider)}）密钥`);
    const browserOk = checkBrowserSupport();

    function renderNoteCard(note) {
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
            rerender();
          },
        },
        [
          h("div", { class: "section-row", style: "justify-content:space-between;align-items:flex-start;" }, [
            h("div", { style: "font-size:14px;font-weight:600;" }, note.title || "未命名笔记"),
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

    const activeBanner =
      recorder && recordingNoteId
        ? h("div", { class: "card", style: "border-left:3px solid hsl(38,80%,55%);" }, [
            h("div", { class: "section-row", style: "justify-content:space-between;align-items:center;" }, [
              h("span", {}, "有一条课堂笔记正在录音中"),
              h(
                "button",
                { class: "btn btn-outline btn-sm", type: "button", onClick: () => { view = { mode: "record", noteId: recordingNoteId }; rerender(); } },
                "去看看"
              ),
            ]),
          ])
        : null;

    mount(
      container,
      h("div", { style: "display:flex;flex-direction:column;gap:14px;" }, [
        h("div", { class: "section-row" }, [
          h("div", { class: "grow" }),
          h(
            "button",
            {
              class: "btn btn-primary", type: "button",
              disabled: Boolean(recorder) || !browserOk || undefined,
              onClick: () => openNewNoteModal(store, (note) => {
                view = { mode: "record", noteId: note.id };
                rerender();
              }),
            },
            "+ 新建课堂笔记"
          ),
        ]),
        activeBanner,
        browserOk ? null : h("div", { class: "empty-hint" }, "当前浏览器不支持录音转文字，建议换用最新版 Chrome 或 Edge 桌面浏览器；已有的笔记不受影响，仍然可以查看。"),
        missingKeyHints.length
          ? h("div", { class: "empty-hint" }, `还没配置好 AI 相关功能：录音转文字不需要密钥；${missingKeyHints.join("；")}，去「数据与设置」填一下。`)
          : null,
        notes.length ? h("div", { class: "summary-grid" }, notes.map(renderNoteCard)) : h("div", { class: "empty-hint" }, "还没有课堂笔记，点右上角开始第一条录音吧"),
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
    } else {
      renderListView(container, store, ctx, rerender);
    }
  }

  return { meta, render, statusLabel, checkBrowserSupport };
});
