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
  let detailTab = "notes"; // "notes" | "transcript" | "translation"
  let activeTranslationLang = null;
  let recorder = null; // 当前活跃的 speechRecorder 实例；非空表示正在录音（含暂停）
  let recordingNoteId = null; // recorder 对应的笔记 id
  let recordStartError = null; // 启动失败（不支持/没权限）时的提示
  let liveError = null; // 录音过程中识别引擎报错的提示（不会强行中断录音）
  let watchdogTimer = null; // 录音页专用的"每秒刷新计时+离开页面自动收尾"定时器，同 todayPlan.js 的 tickTimer

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
    recordingNoteId = note.id;
    const langTag = SPEECH_LANG_TAGS[note.sourceLang] || "en-US";

    const instance = createSpeechRecorder({
      lang: langTag,
      onTranscriptSegment: (seg) => {
        if (!recordingRefs || recordingNoteId !== note.id) return;
        if (seg.isFinal) {
          store.appendClassNoteTranscript(note.id, { start: seg.start, end: seg.end, text: seg.text });
          recordingRefs.captionEl.textContent = "";
          recordingRefs.listEl.appendChild(renderTranscriptRow({ start: seg.start, text: seg.text }));
        } else {
          recordingRefs.captionEl.textContent = seg.text;
        }
      },
      onStateChange: () => rerender(),
      onError: (err) => {
        liveError = err.message;
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
    view = { mode: "detail", noteId: note.id };
    detailTab = "transcript";
    activeTranslationLang = note.targetLangs[0] || null;
    rerender();
  }

  let recordingRefs = null; // { captionEl, listEl } —— 给 startRecordingSession 的回调直接改 DOM 用，不走整页重渲染

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
    const listEl = h("div", { class: "record-transcript-list" }, note.transcriptSegments.map(renderTranscriptRow));
    recordingRefs = { captionEl, listEl };

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
              h("div", { class: "section-row", style: "margin-top:12px;" }, [pauseBtn, stopBtn]),
            ]),
        h("div", { class: "card" }, [h("div", { class: "card-title" }, "实时转录"), listEl, captionEl]),
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

    function renderTranscriptTab() {
      return note.transcriptSegments.length
        ? h("div", { class: "card" }, note.transcriptSegments.map(renderTranscriptRow))
        : h("div", { class: "empty-hint" }, "还没有转录内容");
    }

    function renderNotesTab() {
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

    function renderTranslationTab() {
      if (!note.targetLangs.length) {
        return h("div", { class: "empty-hint" }, "这条笔记创建时没有选择需要互译的语言");
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
        const currentProvider = store.getSettings().translationProvider;
        const statusEl = h(
          "div", { class: "muted", style: "font-size:12px;margin:6px 0 10px;" },
          hasTranslationKey ? "" : `还没配置当前使用的翻译服务（${providerLabel(store, currentProvider)}），去「数据与设置」的「多语言互译服务」里填一个才能用这个功能`
        );

        async function translateNow() {
          transBtn.disabled = true;
          const prevLabel = transBtn.textContent;
          transBtn.textContent = "翻译中…";
          statusEl.textContent = `${providerLabel(store, currentProvider)}正在翻译，可能需要几秒…`;
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
            transBtn.disabled = false;
            transBtn.textContent = prevLabel;
            statusEl.textContent = err.message || "翻译失败";
          }
        }

        const transBtn = h(
          "button",
          {
            class: "btn btn-outline", type: "button",
            disabled: !hasTranslationKey || !note.transcriptSegments.length || undefined,
            onClick: translateNow,
          },
          translated.length ? "重新翻译" : `翻译成${langLabel(store, activeTranslationLang)}`
        );

        return h("div", {}, [
          h("div", { class: "section-row", style: "justify-content:flex-end;" }, [transBtn]),
          statusEl,
          translated.length
            ? h("div", { class: "card" }, translated.map(renderTranscriptRow))
            : h("div", { class: "empty-hint" }, "还没有翻译"),
        ]);
      }

      const langSeg = createSegmented({
        kind: "pill",
        options: note.targetLangs.map((code) => ({ key: code, label: langLabel(store, code) })),
        activeKey: activeTranslationLang,
        onSelect: (key) => {
          activeTranslationLang = key;
          refreshBody();
        },
      });
      refreshBody();
      return h("div", {}, [langSeg.el, bodySlot]);
    }

    const contentSlot = h("div", { style: "margin-top:14px;" });
    function buildTabContent() {
      if (detailTab === "transcript") return renderTranscriptTab();
      if (detailTab === "translation") return renderTranslationTab();
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
        { key: "translation", label: "翻译" },
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
