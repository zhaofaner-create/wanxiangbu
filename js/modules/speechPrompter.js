(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.speechPrompter = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  const { h, mount } = require("../components/dom.js");
  const { openConfirm } = require("../components/confirm.js");
  const { createSegmented } = require("../components/segmented.js");
  const { createSpeechFollower } = require("../components/speechFollower.js");
  const { findBestMatchIndex, buildPreviewWindow } = require("../components/textMatch.js");
  const { SPEECH_LANG_TAGS } = require("../components/speechToTextProviders.js");

  const meta = {
    id: "speechPrompter",
    label: "演讲提词",
    title: "演讲提词",
    subtitle: "全屏大字提词 · 跟着语音自动/手动翻页",
  };

  // 演讲用的是浏览器自带的 Web Speech API（免费、不需要密钥），跟课堂笔记的录音转文字
  // 是同一套底层能力，但这里只需要"实时听、判断讲到哪了"，不需要保存音频，所以用的是
  // 更轻的 speechFollower.js（不含 MediaRecorder/getUserMedia 录音那部分）。同样只有
  // Chrome / Edge 等 Chromium 内核浏览器支持得比较好，不支持时会直接退化成纯手动翻页，
  // 不会假装能自动、也不影响手动模式正常使用。

  // ---------- 模块级状态：view 决定当前显示总览/编辑器/全屏演讲哪一个，
  // 其它变量是每个视图各自的草稿/运行时状态，靠闭包跨多次 render 保持住，不存进 store。 ----------
  let view = { mode: "list" }; // {mode:"list"} | {mode:"editor", id:string|null} | {mode:"present", id:string}

  // 编辑器草稿：打开编辑器时从对应记录（或空白）初始化，保存/取消时清空使用意义不大，
  // 不特意清空也没关系——下次打开编辑器一定会先重新初始化一遍。
  let editorSentences = [];
  let editorMode = "script";
  let editorLang = "zh";
  let editorTitleValue = "";
  let editorRawText = "";

  // 全屏演讲模式的运行时状态。
  let presentId = null; // 当前演讲的是哪份稿子，用来判断"是不是刚切换到一份新稿子"
  let presentIndex = 0;
  let presentAutoMode = true; // true=自动跟随，false=手动翻页（麦克风依然在听，只是不自动跳）
  let presentFollower = null; // 当前活跃的 speechFollower 实例，null 表示没有在监听
  let presentRefs = null; // 当前这次挂载的关键 DOM 节点引用，供各个事件处理函数直接操作
  let presentWakeLock = null;
  let presentWatchdogTimer = null;
  let presentVisibilityHandler = null;
  let presentToastTimer = null;
  let presentDragStartY = null;
  let presentDragAccum = 0;

  function checkSpeechSupport() {
    return typeof window !== "undefined" && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  /** 完整稿：按中文/英文常见的句末标点拆句，标点保留在前一句末尾。 */
  function splitScriptText(raw) {
    return String(raw || "")
      .split(/(?<=[。！？!?])/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** 提示词：一行当一条，不做标点拆分（提示词本来就是短语，不是完整句子）。 */
  function splitPromptsText(raw) {
    return String(raw || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function openEditorFor(item, rerender) {
    editorSentences = item ? [...item.sentences] : [];
    editorMode = item ? item.mode : "script";
    editorLang = item ? item.lang || "zh" : "zh";
    editorTitleValue = item ? item.title : "";
    editorRawText = item ? item.sentences.join("\n") : "";
    view = { mode: "editor", id: item ? item.id : null };
    rerender();
  }

  // ---------- 全屏演讲模式：停止监听 + 释放屏幕常亮 + 清理定时器/监听器 ----------
  function stopPresentWatchdog() {
    if (presentWatchdogTimer) {
      clearInterval(presentWatchdogTimer);
      presentWatchdogTimer = null;
    }
  }

  function releaseWakeLock() {
    if (presentWakeLock) {
      try {
        presentWakeLock.release();
      } catch {
        // 忽略
      }
      presentWakeLock = null;
    }
  }

  async function acquireWakeLock() {
    try {
      if (typeof navigator !== "undefined" && navigator.wakeLock && typeof navigator.wakeLock.request === "function") {
        presentWakeLock = await navigator.wakeLock.request("screen");
      }
    } catch {
      // 拿不到屏幕常亮就算了（比如设备不支持、或者不在前台），不影响提词功能本身
      presentWakeLock = null;
    }
  }

  /** 离开演讲模式（点"结束演讲"，或者用户切到了别的模块）都要调用这个，
   * 停掉麦克风监听、放开屏幕常亮、清掉各种定时器/事件监听——不这样做的话，
   * 用户以为已经退出了，麦克风其实还在后台悄悄录着，既费电也不尊重隐私。 */
  function stopPresenting() {
    stopPresentWatchdog();
    if (presentFollower) {
      presentFollower.stop();
      presentFollower = null;
    }
    releaseWakeLock();
    if (presentVisibilityHandler) {
      document.removeEventListener("visibilitychange", presentVisibilityHandler);
      presentVisibilityHandler = null;
    }
    if (presentToastTimer) {
      clearTimeout(presentToastTimer);
      presentToastTimer = null;
    }
    presentRefs = null;
  }

  function startPresentWatchdog(container) {
    stopPresentWatchdog();
    presentWatchdogTimer = setInterval(() => {
      if (container.dataset.activeModuleId !== meta.id) {
        // 用户已经切到别的模块了：静默停掉监听，不强行拉他回到这个页面
        // （跟课堂笔记录音页离开自动收尾是同一处理）。
        stopPresenting();
      }
    }, 1000);
  }

  function render(container, store, ctx) {
    ctx.setTopbar(meta.title, meta.subtitle);
    function rerender() {
      render(container, store, ctx);
    }
    if (view.mode === "editor") {
      renderEditorView(container, store, ctx, rerender);
    } else if (view.mode === "present") {
      renderPresentView(container, store, ctx, rerender);
    } else {
      renderListView(container, store, ctx, rerender);
    }
  }

  // ---------- 总览 ----------
  function renderListView(container, store, ctx, rerender) {
    const items = store.listSpeechPrompters();
    mount(
      container,
      h("div", { style: "display:flex;flex-direction:column;gap:14px;" }, [
        h("div", { class: "section-row", style: "justify-content:flex-end;" }, [
          h(
            "button",
            { type: "button", class: "btn btn-primary btn-sm", onClick: () => openEditorFor(null, rerender) },
            "+ 新建演讲稿"
          ),
        ]),
        items.length
          ? h("div", { class: "summary-grid" }, items.map((item) => renderPrompterCard(store, item, rerender)))
          : h(
              "div",
              { class: "empty-hint" },
              "还没有演讲稿，点上面新建一份——把完整逐字稿或者简短提示词录进去，上台前随时能打开全屏提词，忘词的时候瞄一眼手机就知道下一句该讲什么。"
            ),
      ])
    );
  }

  function renderPrompterCard(store, item, rerender) {
    const modeLabel = item.mode === "prompts" ? "提示词" : "完整稿";
    const unitLabel = item.mode === "prompts" ? "条" : "句";
    return h("div", { class: "card" }, [
      h("div", { class: "card-title" }, [item.title, h("span", { class: "badge badge-info" }, modeLabel)]),
      h(
        "div",
        { class: "muted", style: "font-size:12.5px;margin-bottom:10px;" },
        `共 ${item.sentences.length} ${unitLabel} · 最近更新：${new Date(item.updatedAt).toLocaleString("zh-CN")}`
      ),
      h("div", { class: "section-row" }, [
        h("button", { type: "button", class: "btn btn-outline btn-sm", onClick: () => openEditorFor(item, rerender) }, "编辑"),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-primary btn-sm",
            disabled: item.sentences.length === 0 || undefined,
            onClick: () => {
              view = { mode: "present", id: item.id };
              rerender();
            },
          },
          "开始演讲"
        ),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-danger btn-sm",
            onClick: () => {
              openConfirm({
                message: `确定删除演讲稿「${item.title}」吗？`,
                danger: true,
                confirmLabel: "删除",
                onConfirm: () => {
                  store.removeSpeechPrompter(item.id);
                  rerender();
                },
              });
            },
          },
          "删除"
        ),
      ]),
    ]);
  }

  // ---------- 编辑器 ----------
  function renderEditorView(container, store, ctx, rerender) {
    const isNew = !view.id;

    // 标题/文本框的值要实时同步回模块变量：合并/插入/删除某一行、切换完整稿/提示词
    // 都会调用 rerender() 整块重新渲染编辑器（包括重新创建这两个输入框），如果不在
    // 每次输入时就同步回去，用户刚打的字会在这些操作发生的一瞬间被悄悄冲掉。
    const titleInputEl = h("input", { class: "field-input", type: "text", name: "title", placeholder: "给这份演讲稿起个名字" });
    titleInputEl.value = editorTitleValue;
    titleInputEl.addEventListener("input", (e) => {
      editorTitleValue = e.target.value;
    });

    const textareaEl = h("textarea", {
      class: "field-input prompter-raw-textarea",
      name: "rawText",
      rows: "6",
      placeholder: editorMode === "prompts" ? "每行输入一条提示词/关键词" : "粘贴或输入完整演讲稿，会按句号/问号/感叹号自动拆句",
    });
    textareaEl.value = editorRawText;
    textareaEl.addEventListener("input", (e) => {
      editorRawText = e.target.value;
    });

    const modeToggle = createSegmented({
      kind: "tabs",
      options: [
        { key: "script", label: "完整稿" },
        { key: "prompts", label: "提示词" },
      ],
      activeKey: editorMode,
      onSelect: (key) => {
        editorMode = key;
        rerender();
      },
    });

    const langSelect = h(
      "select",
      { class: "field-input", name: "lang", style: "max-width:160px;" },
      store.CLASS_NOTE_LANGUAGES.map((l) => {
        const opt = h("option", { value: l.code }, l.label);
        if (l.code === editorLang) opt.setAttribute("selected", "selected");
        return opt;
      })
    );
    langSelect.addEventListener("change", (e) => {
      editorLang = e.target.value;
    });

    function doSplit() {
      const raw = textareaEl.value;
      editorRawText = raw;
      editorSentences = editorMode === "prompts" ? splitPromptsText(raw) : splitScriptText(raw);
      rerender();
    }

    const splitBtn = h(
      "button",
      {
        type: "button",
        class: "btn btn-outline btn-sm",
        onClick: () => {
          if (editorSentences.length) {
            openConfirm({
              message: "这会覆盖下面已经调整好的列表，确定吗？",
              danger: true,
              confirmLabel: "覆盖",
              onConfirm: doSplit,
            });
          } else {
            doSplit();
          }
        },
      },
      editorMode === "prompts" ? "按每行拆分成提示词列表" : "按标点拆分成句子列表"
    );

    const rows = editorSentences.map((text, i) => renderEditorRow(text, i, rerender));

    const errorEl = h("div", { style: "color:var(--danger);font-size:12.5px;min-height:16px;" }, "");

    const saveBtn = h(
      "button",
      {
        type: "button",
        class: "btn btn-primary",
        onClick: () => {
          const sentences = editorSentences.map((s) => s.trim()).filter(Boolean);
          if (!sentences.length) {
            errorEl.textContent = "至少要有一条内容才能保存";
            return;
          }
          const title = titleInputEl.value;
          if (view.id) {
            store.updateSpeechPrompter(view.id, { title, mode: editorMode, lang: editorLang, sentences });
          } else {
            store.addSpeechPrompter({ title, mode: editorMode, lang: editorLang, sentences });
          }
          view = { mode: "list" };
          rerender();
        },
      },
      "保存"
    );
    const cancelBtn = h(
      "button",
      {
        type: "button",
        class: "btn btn-ghost",
        onClick: () => {
          view = { mode: "list" };
          rerender();
        },
      },
      "取消"
    );

    mount(
      container,
      h("div", { style: "display:flex;flex-direction:column;gap:14px;" }, [
        h("div", { class: "card" }, [
          h("div", { class: "card-title" }, isNew ? "新建演讲稿" : "编辑演讲稿"),
          h("label", { class: "field-row" }, [h("span", { class: "field-label" }, "标题"), titleInputEl]),
          h("div", { class: "section-row", style: "margin:10px 0;" }, [modeToggle.el, langSelect]),
          h("label", { class: "field-row" }, [
            h("span", { class: "field-label" }, editorMode === "prompts" ? "提示词内容" : "演讲稿内容"),
            textareaEl,
          ]),
          h("div", { class: "section-row", style: "justify-content:flex-end;margin-top:8px;" }, [splitBtn]),
        ]),
        h("div", { class: "card" }, [
          h("div", { class: "card-title" }, `列表预览（共 ${editorSentences.length} ${editorMode === "prompts" ? "条" : "句"}，可以逐条调整）`),
          editorSentences.length
            ? h("div", { class: "prompter-editor-rows" }, rows)
            : h("div", { class: "empty-hint" }, "先在上面粘贴内容并点「生成列表」，或者直接点下面「添加一条」手动一条条写。"),
          h(
            "button",
            {
              type: "button",
              class: "btn btn-outline btn-sm",
              style: "margin-top:10px;",
              onClick: () => {
                editorSentences.push("");
                rerender();
              },
            },
            "+ 添加一条"
          ),
        ]),
        errorEl,
        h("div", { class: "section-row" }, [saveBtn, cancelBtn]),
      ])
    );
  }

  function renderEditorRow(text, i, rerender) {
    const input = h("input", { class: "field-input", type: "text" });
    input.value = text;
    input.addEventListener("input", (e) => {
      editorSentences[i] = e.target.value;
    });
    const isLast = i >= editorSentences.length - 1;
    return h("div", { class: "prompter-row" }, [
      h("span", { class: "prompter-row-index" }, String(i + 1)),
      input,
      h("div", { class: "prompter-row-actions" }, [
        h(
          "button",
          {
            type: "button",
            class: "btn btn-ghost btn-sm",
            disabled: i === 0 || undefined,
            title: "跟上一条合并成一条",
            onClick: () => {
              if (i === 0) return;
              editorSentences[i - 1] = `${editorSentences[i - 1]} ${editorSentences[i]}`.trim();
              editorSentences.splice(i, 1);
              rerender();
            },
          },
          "↑合并"
        ),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-ghost btn-sm",
            disabled: i === 0 || undefined,
            title: "跟上一条交换顺序",
            onClick: () => {
              if (i === 0) return;
              const tmp = editorSentences[i - 1];
              editorSentences[i - 1] = editorSentences[i];
              editorSentences[i] = tmp;
              rerender();
            },
          },
          "▲"
        ),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-ghost btn-sm",
            disabled: isLast || undefined,
            title: "跟下一条交换顺序",
            onClick: () => {
              if (isLast) return;
              const tmp = editorSentences[i + 1];
              editorSentences[i + 1] = editorSentences[i];
              editorSentences[i] = tmp;
              rerender();
            },
          },
          "▼"
        ),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-ghost btn-sm",
            title: "在下面插入一条空白",
            onClick: () => {
              editorSentences.splice(i + 1, 0, "");
              rerender();
            },
          },
          "+插入"
        ),
        h(
          "button",
          {
            type: "button",
            class: "btn btn-danger btn-sm",
            onClick: () => {
              const doDelete = () => {
                editorSentences.splice(i, 1);
                rerender();
              };
              if ((text || "").trim()) {
                openConfirm({ message: "删除这一条？", danger: true, confirmLabel: "删除", onConfirm: doDelete });
              } else {
                doDelete();
              }
            },
          },
          "删除"
        ),
      ]),
    ]);
  }

  // ---------- 全屏演讲模式 ----------
  function renderPresentView(container, store, ctx, rerender) {
    const note = store.findSpeechPrompter(view.id);
    if (!note || !note.sentences.length) {
      view = { mode: "list" };
      rerender();
      return;
    }

    const supported = checkSpeechSupport();

    if (presentId !== note.id) {
      // 切到了一份新稿子（或者第一次进来）：先把上一份的监听/资源清干净，再从头开始。
      stopPresenting();
      presentId = note.id;
      presentIndex = 0;
      presentAutoMode = supported;
      presentDragStartY = null;
      presentDragAccum = 0;
    }

    const statusDotEl = h("span", { class: "prompter-status-dot" });
    const statusLabelEl = h("span", { class: "prompter-status-label" }, "");
    const progressEl = h("div", { class: "prompter-progress" }, "");
    const toastEl = h("div", { class: "prompter-toast" }, "");
    const linesEl = h("div", { class: "prompter-lines" }, []);

    presentRefs = { linesEl, statusDotEl, statusLabelEl, toastEl, progressEl, modeToggle: null };

    function applyIndex(newIndex) {
      const clamped = Math.max(0, Math.min(newIndex, note.sentences.length - 1));
      presentIndex = clamped;
      renderLines();
      updateProgress();
    }

    function renderLines() {
      const win = buildPreviewWindow(note.sentences, presentIndex, 2);
      linesEl.innerHTML = "";
      win.forEach(({ index, text, offset }) => {
        const cls =
          "prompter-line" +
          (offset === 0 ? " prompter-line-current" : " prompter-line-context") +
          (Math.abs(offset) === 2 ? " prompter-line-far" : "");
        linesEl.appendChild(
          h(
            "div",
            {
              class: cls,
              onClick: () => {
                applyIndex(index);
                if (presentFollower) presentFollower.clearBuffer();
              },
            },
            text || "（空）"
          )
        );
      });
    }

    function updateProgress() {
      const unit = note.mode === "prompts" ? "条" : "句";
      progressEl.textContent = `第 ${presentIndex + 1} / 共 ${note.sentences.length} ${unit}`;
    }

    function setMicStatus(rawStatus) {
      if (!presentRefs) return;
      const dot = presentRefs.statusDotEl;
      const label = presentRefs.statusLabelEl;
      dot.className = "prompter-status-dot";
      if (!presentAutoMode) {
        dot.classList.add("prompter-status-dot-manual");
        label.textContent = "手动模式";
        return;
      }
      if (rawStatus === "listening") {
        dot.classList.add("prompter-status-dot-live");
        label.textContent = "正在听";
      } else if (rawStatus === "reconnecting") {
        dot.classList.add("prompter-status-dot-reconnect");
        label.textContent = "重新连接中…";
      } else {
        dot.classList.add("prompter-status-dot-manual");
        label.textContent = "手动模式";
      }
    }

    function showToast(message) {
      if (!presentRefs) return;
      presentRefs.toastEl.textContent = message;
      presentRefs.toastEl.classList.add("visible");
      if (presentToastTimer) clearTimeout(presentToastTimer);
      presentToastTimer = setTimeout(() => {
        if (presentRefs) presentRefs.toastEl.classList.remove("visible");
      }, 3000);
    }

    function ensureFollowerRunning() {
      if (presentFollower && presentFollower.isRunning()) return;
      if (!checkSpeechSupport()) return;
      const langTag = SPEECH_LANG_TAGS[note.lang] || "zh-CN";
      presentFollower = createSpeechFollower({
        lang: langTag,
        onStatusChange: (status) => setMicStatus(status),
        onTranscriptUpdate: (recentText) => {
          if (!presentAutoMode) return;
          const matched = findBestMatchIndex({
            recentText,
            sentences: note.sentences,
            currentIndex: presentIndex,
            mode: note.mode,
            lookahead: 2,
          });
          if (matched !== null) {
            presentFollower.clearBuffer();
            applyIndex(matched + 1);
          }
        },
        onSilenceTimeout: () => {
          if (presentAutoMode) {
            presentAutoMode = false;
            if (presentRefs && presentRefs.modeToggle) presentRefs.modeToggle.setActive("manual");
            setMicStatus("manual");
            showToast("已切换到手动模式——麦克风长时间没收到声音");
          }
        },
        onFatalError: (err) => {
          presentAutoMode = false;
          if (presentRefs && presentRefs.modeToggle) presentRefs.modeToggle.setActive("manual");
          setMicStatus("manual");
          showToast(err.message);
        },
      });
      try {
        presentFollower.start();
      } catch {
        presentFollower = null;
        presentAutoMode = false;
        setMicStatus("manual");
      }
    }

    function stepManual(direction) {
      if (direction > 0) {
        let target = presentIndex + 1;
        if (presentFollower) {
          const recent = presentFollower.getRecentText();
          const matched = findBestMatchIndex({
            recentText: recent,
            sentences: note.sentences,
            currentIndex: presentIndex,
            mode: note.mode,
            lookahead: 4,
          });
          if (matched !== null) target = matched + 1;
          presentFollower.clearBuffer();
        }
        applyIndex(target);
      } else {
        if (presentFollower) presentFollower.clearBuffer();
        applyIndex(presentIndex - 1);
      }
    }

    function openOutline() {
      const overlay = h("div", { class: "modal-overlay" }, [
        h("div", { class: "modal-box prompter-outline-box" }, [
          h("div", { class: "modal-title" }, "跳到…"),
          h(
            "div",
            { class: "prompter-outline-list" },
            note.sentences.map((text, i) =>
              h(
                "button",
                {
                  type: "button",
                  class: "prompter-outline-item" + (i === presentIndex ? " active" : ""),
                  onClick: () => {
                    applyIndex(i);
                    if (presentFollower) presentFollower.clearBuffer();
                    overlay.remove();
                  },
                },
                `${i + 1}. ${text || "（空）"}`
              )
            )
          ),
          h("div", { class: "modal-actions" }, [
            h("button", { type: "button", class: "btn btn-ghost", onClick: () => overlay.remove() }, "关闭"),
          ]),
        ]),
      ]);
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) overlay.remove();
      });
      document.body.appendChild(overlay);
    }

    let modeToggleWidget = null;
    if (supported) {
      modeToggleWidget = createSegmented({
        kind: "pill",
        options: [
          { key: "auto", label: "自动跟随" },
          { key: "manual", label: "手动翻页" },
        ],
        activeKey: presentAutoMode ? "auto" : "manual",
        onSelect: (key) => {
          if (key === "auto") {
            if (!checkSpeechSupport()) {
              showToast("当前浏览器不支持语音识别，无法使用自动跟随");
              if (presentRefs && presentRefs.modeToggle) presentRefs.modeToggle.setActive("manual");
              return;
            }
            presentAutoMode = true;
            ensureFollowerRunning();
            setMicStatus(presentFollower ? "listening" : "manual");
          } else {
            presentAutoMode = false;
            setMicStatus("manual");
          }
        },
      });
      presentRefs.modeToggle = modeToggleWidget;
    }

    const backBtn = h(
      "button",
      {
        type: "button",
        class: "btn btn-ghost btn-sm",
        onClick: () => {
          stopPresenting();
          presentId = null;
          view = { mode: "list" };
          rerender();
        },
      },
      "← 结束演讲"
    );
    const outlineBtn = h("button", { type: "button", class: "btn btn-outline btn-sm", onClick: () => openOutline() }, "大纲");
    // 不根据 presentIndex 设置 disabled：翻到下一句/大纲跳转等操作都只更新 linesEl/progressEl，
    // 不会重新创建这个按钮，如果这里读 presentIndex 算 disabled，算出来的状态会一直停在
    // "刚挂载那一刻"、后续再也不会更新。直接依赖 applyIndex 内部的夹逼（不会小于0）就够了，
    // 停在第一句时再点"上一句"只是安全地什么都不做。
    const prevBtn = h(
      "button",
      { type: "button", class: "btn btn-outline prompter-nav-btn", onClick: () => stepManual(-1) },
      "上一句"
    );
    const nextBtn = h("button", { type: "button", class: "btn btn-primary prompter-nav-btn", onClick: () => stepManual(1) }, "下一句");

    mount(
      container,
      h("div", { class: "prompter-stage" }, [
        h("div", { class: "prompter-topbar" }, [backBtn, h("div", { class: "prompter-title" }, note.title), outlineBtn]),
        h("div", { class: "prompter-meta-row" }, [
          progressEl,
          supported
            ? modeToggleWidget.el
            : h("span", { class: "muted", style: "font-size:12px;" }, "当前浏览器不支持语音跟随，仅手动翻页"),
          h("span", { class: "prompter-status" }, [statusDotEl, statusLabelEl]),
        ]),
        toastEl,
        linesEl,
        h("div", { class: "prompter-controls" }, [prevBtn, nextBtn]),
      ])
    );

    linesEl.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        presentDragAccum += e.deltaY;
        const STEP = 60;
        while (Math.abs(presentDragAccum) >= STEP) {
          const dir = presentDragAccum > 0 ? 1 : -1;
          applyIndex(presentIndex + dir);
          if (presentFollower) presentFollower.clearBuffer();
          presentDragAccum -= dir * STEP;
        }
      },
      { passive: false }
    );
    linesEl.addEventListener(
      "touchstart",
      (e) => {
        presentDragStartY = e.touches[0].clientY;
      },
      { passive: true }
    );
    linesEl.addEventListener(
      "touchmove",
      (e) => {
        if (presentDragStartY === null) return;
        const y = e.touches[0].clientY;
        const delta = presentDragStartY - y;
        const STEP = 50;
        if (Math.abs(delta) >= STEP) {
          const dir = delta > 0 ? 1 : -1;
          applyIndex(presentIndex + dir);
          if (presentFollower) presentFollower.clearBuffer();
          presentDragStartY = y;
        }
      },
      { passive: true }
    );
    linesEl.addEventListener("touchend", () => {
      presentDragStartY = null;
    });

    renderLines();
    updateProgress();
    setMicStatus(presentAutoMode ? "listening" : "manual");

    if (presentAutoMode) ensureFollowerRunning();
    // 手动模式下也尝试起一份后台监听，用来给"手动点按也能大概匹配当前内容"提供辅助信号；
    // 拿不到就算了（比如权限被拒绝过），不影响手动翻页本身。
    else if (supported) ensureFollowerRunning();

    startPresentWatchdog(container);

    if (!presentVisibilityHandler) {
      presentVisibilityHandler = () => {
        if (document.visibilityState === "visible" && view.mode === "present") acquireWakeLock();
      };
      document.addEventListener("visibilitychange", presentVisibilityHandler);
    }
    acquireWakeLock();
  }

  return { meta, render };
});
