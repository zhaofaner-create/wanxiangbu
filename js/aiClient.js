(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.aiClient = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // 封装"用用户自己的 Claude API 密钥，直接从浏览器调用 Anthropic 官方 API"这件事，
  // 给课堂笔记模块的"多语言互译"和"AI整理笔记"两个功能用。
  //
  // 用到的是 Anthropic 官方专门为纯前端应用加的 CORS 直连能力：请求头带上
  // anthropic-dangerous-direct-browser-access: true，浏览器就能跳过通常的 CORS 拦截、
  // 直接用用户自己的密钥请求 https://api.anthropic.com——不经过我们自己的任何服务器中转，
  // 密钥全程只在用户自己的浏览器和 Anthropic 之间传输，符合"不部署自己的服务器"这条
  // 硬性架构约束。名字里的"dangerous"是 Anthropic 提醒开发者"密钥会暴露在客户端代码里"
  // 的意思——这正是这个 App 想要的效果：密钥是用户自己申请、自己填、只存本机
  // localStorage，从来不会被塞进代码仓库或者发布到别处，每个人（包括分享这份 App 的
  // 朋友）都用自己的密钥、自己那份额度，互不占用、互不知道对方的密钥。
  //
  // 这一步会让转录出来的文字（不是原始音频）离开用户设备发给 Anthropic——这跟这个 App
  // 之前"打开就完全不联网"的承诺不一样，是本轮新加、用户已经确认接受的例外，README 里
  // 有对应的隐私说明。

  const API_URL = "https://api.anthropic.com/v1/messages";
  const API_VERSION = "2023-06-01";
  // 翻译和整理笔记都是"结构化文字处理"，不需要最强模型，用最便宜/最快的 Haiku 尽量
  // 省用户自己的账单。
  const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
  const MAX_TOKENS = 4096;

  /** 统一的错误：message 是给用户看的中文提示，kind 供调用方按类型做不同处理。 */
  function aiClientError(message, kind) {
    const err = new Error(message);
    err.kind = kind; // "no_key" | "network" | "auth" | "api" | "empty_response"
    return err;
  }

  /** 把纯文字 prompt 和（可选的）图片列表拼成 Messages API 的 content 字段。没有图片时
   * 直接用原来的纯字符串形式（保持跟以前完全一样，不给现有调用方增加负担）；有图片时
   * 拼成"图片在前、文字在后"的内容块数组——图片块用 Anthropic 原生的
   * {type:"image", source:{type:"base64", media_type, data}} 格式，这样 Claude 能直接用
   * 视觉能力读懂拍照笔记/板书照片的内容，不需要我们自己先做一遍 OCR。
   * images: [{ base64Data, mediaType }]，base64Data 不带 "data:image/...;base64," 前缀。 */
  function buildMessageContent(prompt, images) {
    const imageList = Array.isArray(images) ? images.filter((img) => img && img.base64Data) : [];
    if (imageList.length === 0) return prompt;
    return [
      ...imageList.map((img) => ({
        type: "image",
        source: { type: "base64", media_type: img.mediaType || "image/jpeg", data: img.base64Data },
      })),
      { type: "text", text: prompt },
    ];
  }

  /**
   * 调用 Claude API，返回模型输出的纯文字。
   * fetchImpl 是为了方便测试注入假的 fetch；不传的话用运行环境的全局 fetch。
   * images 可选：需要让模型"看图"时传（比如拍照笔记材料），见 buildMessageContent。
   */
  async function callClaude({ apiKey, system, prompt, images, model, maxTokens, fetchImpl } = {}) {
    const key = (apiKey || "").trim();
    if (!key) {
      throw aiClientError("还没有设置 AI 服务密钥，请先去「数据与设置」填一个", "no_key");
    }
    const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
    if (!doFetch) {
      throw aiClientError("当前环境不支持联网请求", "network");
    }

    let res;
    try {
      res = await doFetch(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": API_VERSION,
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: model || DEFAULT_MODEL,
          max_tokens: maxTokens || MAX_TOKENS,
          system,
          messages: [{ role: "user", content: buildMessageContent(prompt, images) }],
        }),
      });
    } catch {
      throw aiClientError("联网请求失败，请检查网络连接", "network");
    }

    if (res.status === 401 || res.status === 403) {
      throw aiClientError("密钥无效或没有权限，请检查「数据与设置」里填的密钥", "auth");
    }
    if (!res.ok) {
      let detail = "";
      try {
        const errBody = await res.json();
        detail = (errBody && errBody.error && errBody.error.message) || "";
      } catch {
        // 忽略解析失败，用不带详情的通用提示
      }
      throw aiClientError(`AI 服务返回错误（HTTP ${res.status}）${detail ? "：" + detail : ""}`, "api");
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw aiClientError("AI 服务返回的内容无法解析", "api");
    }
    const text = extractText(data);
    if (!text) {
      throw aiClientError("AI 服务没有返回任何内容", "empty_response");
    }
    return text;
  }

  /** 从 Anthropic Messages API 的响应体里取出纯文字（把多个 text 内容块拼起来）。 */
  function extractText(data) {
    if (!data || !Array.isArray(data.content)) return "";
    return data.content
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();
  }

  // ---------- 提示词构造 / 响应解析（纯函数，不涉及网络，方便单测） ----------

  const LANGUAGE_NAMES = {
    zh: "中文", en: "英语", fr: "法语", es: "西班牙语", de: "德语",
    ja: "日语", ko: "韩语", ru: "俄语", pt: "葡萄牙语", it: "意大利语",
  };

  function languageName(code) {
    return LANGUAGE_NAMES[code] || code;
  }

  function formatSeconds(totalSeconds) {
    const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  /** 把转录分段拼成"[开始→结束] 文字"这样的纯文本，供"整理笔记"的提示词用。 */
  function formatSegmentsForPrompt(segments) {
    return (segments || [])
      .map((seg) => `[${formatSeconds(seg.start)}→${formatSeconds(seg.end)}] ${seg.text}`)
      .join("\n");
  }

  /**
   * 构造"把转录逐行翻译成目标语言、且要求按编号一一对应输出"的提示词。
   * 用编号对应而不是直接整段翻译，是为了让翻译结果能重新对回原来的时间戳分段。
   */
  function buildTranslatePrompt(segments, targetLangCode) {
    const targetName = languageName(targetLangCode);
    const numbered = (segments || []).map((seg, i) => `${i}. ${seg.text}`).join("\n");
    return [
      `下面是一段课堂录音的转录文字，按行给出编号。请把每一行翻译成${targetName}，`,
      `严格按照"编号|翻译结果"的格式一行一个输出，不要输出任何其它解释或前后缀文字，`,
      "编号必须和原文一一对应，不能合并、拆分或跳过任何一行：",
      "",
      numbered,
    ].join("\n");
  }

  /** 把 buildTranslatePrompt 对应的模型回复解析回 [{start,end,text}]（时间戳沿用原分段；解析不到的行原样保留原文，不会丢内容）。 */
  function parseTranslateResponse(responseText, originalSegments) {
    const lines = (responseText || "").split("\n").map((l) => l.trim()).filter(Boolean);
    const byIndex = new Map();
    lines.forEach((line) => {
      const m = line.match(/^(\d+)\s*[|.．、:：]\s*(.+)$/);
      if (m) byIndex.set(Number(m[1]), m[2].trim());
    });
    return (originalSegments || []).map((seg, i) => ({
      start: seg.start,
      end: seg.end,
      text: byIndex.has(i) ? byIndex.get(i) : seg.text,
    }));
  }

  /** 构造"把整段转录整理成结构化 Markdown 笔记"的提示词。materialsText 可选：老师上传的
   * PPT 课件文字（已在客户端解析成纯文本）；拍照材料本身以图片形式通过 callClaude 的
   * images 参数单独传给模型，这里只在提示词里提一句"还有图片可以看"，不需要把图片内容
   * 转成文字塞进这段 prompt。 */
  function buildNotesPrompt(segments, noteLangCode, materialsText) {
    const langName = languageName(noteLangCode);
    const trimmedMaterials = (materialsText || "").trim();
    const materialsBlock = trimmedMaterials
      ? [
          "",
          "除了录音转录，老师还提供了以下课件材料，请结合这些材料一起整理笔记（如果材料和",
          "录音内容有重复，以更准确、更完整的一方为准；如果附带了图片，也请一并参考图片里的内容）：",
          "",
          "【课件材料】",
          trimmedMaterials,
          "",
        ].join("\n")
      : "";
    return [
      `下面是一段课堂录音的完整转录文字。请用${langName}把它整理成一份结构化的课堂笔记，`,
      "用 Markdown 格式：合理拆分小标题（用##）、要点用无序列表、有对照关系的内容用表格，",
      "保留重要的原文引用（可以用引用块），不要逐句翻译或复述，重点是提炼结构和要点。",
      "只输出笔记正文本身，不要输出额外的解释或\"好的，这是笔记\"这类前后缀：",
      materialsBlock,
      "",
      "【课堂转录】",
      formatSegmentsForPrompt(segments),
    ].join("\n");
  }

  // ---------- 闪卡 / 测验 / 提问：都是在"整理笔记"生成的 Markdown 正文基础上再让 AI
  // 做一次加工，所以三个功能在详情页里都要求先有 note.notesMarkdown 才能用。闪卡和
  // 测验要求模型直接输出 JSON（而不是像翻译那样"编号|文字"一行一行来），因为条目数量
  // 本来就不固定、还带着选项/正确下标这些结构化字段，JSON 更不容易解析错位。 ----------

  /** 从模型回复里找出第一个完整的 JSON 数组并解析；找不到或解析失败都返回 null，
   * 不抛错——调用方 (parseFlashcardsResponse/parseQuizResponse) 统一处理成"空列表"，
   * 上层再决定要不要提示用户重试，比在这里抛错更灵活。 */
  function extractJsonArray(text) {
    const raw = text || "";
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start === -1 || end === -1 || end < start) return null;
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** 构造"根据整理好的笔记正文生成问答闪卡"的提示词。 */
  function buildFlashcardsPrompt(notesMarkdown, langCode) {
    const langName = languageName(langCode);
    return [
      `下面是一份${langName}课堂笔记。请从中提炼出适合自测复习的问答闪卡，`,
      `数量根据内容多少自己判断（大约5~12张），问题和答案都用${langName}，答案要简洁但完整，不要只写一两个词。`,
      `严格只输出一个 JSON 数组，格式为 [{"q":"问题","a":"答案"}]，不要输出任何解释、`,
      "前后缀文字或 Markdown 代码块标记：",
      "",
      notesMarkdown,
    ].join("\n");
  }

  /** 把 buildFlashcardsPrompt 对应的模型回复解析成 [{question, answer}]；格式不对的条目
   * 直接丢弃，不让一张坏卡片拖累其它能用的卡片。 */
  function parseFlashcardsResponse(responseText) {
    const arr = extractJsonArray(responseText) || [];
    return arr
      .filter((it) => it && typeof it.q === "string" && it.q.trim() && typeof it.a === "string" && it.a.trim())
      .map((it) => ({ question: it.q.trim(), answer: it.a.trim() }));
  }

  /** 构造"根据整理好的笔记正文出一份单选题测验"的提示词。 */
  function buildQuizPrompt(notesMarkdown, langCode) {
    const langName = languageName(langCode);
    return [
      `下面是一份${langName}课堂笔记。请出一份单选题小测验来检验对这份笔记内容的掌握程度，`,
      `数量根据内容多少自己判断（大约5~10题），每题4个选项、只有一个正确答案，题目和选项都用${langName}。`,
      `严格只输出一个 JSON 数组，格式为 [{"question":"题目","options":["选项A","选项B","选项C","选项D"],"correctIndex":0}]，`,
      "correctIndex 是正确选项在 options 里的下标（从0开始），不要输出任何解释、前后缀文字或 Markdown 代码块标记：",
      "",
      notesMarkdown,
    ].join("\n");
  }

  /** 把 buildQuizPrompt 对应的模型回复解析成 [{question, options, correctIndex}]；
   * 校验 options 至少两项且都是非空字符串、correctIndex 是落在 options 范围内的整数，
   * 不满足就丢弃这一题，不影响其它题目正常显示。 */
  function parseQuizResponse(responseText) {
    const arr = extractJsonArray(responseText) || [];
    return arr
      .filter(
        (it) =>
          it &&
          typeof it.question === "string" &&
          it.question.trim() &&
          Array.isArray(it.options) &&
          it.options.length >= 2 &&
          it.options.every((o) => typeof o === "string" && o.trim()) &&
          Number.isInteger(it.correctIndex) &&
          it.correctIndex >= 0 &&
          it.correctIndex < it.options.length
      )
      .map((it) => ({
        question: it.question.trim(),
        options: it.options.map((o) => o.trim()),
        correctIndex: it.correctIndex,
      }));
  }

  /** 构造"针对这条笔记向 AI 提问"的提示词：只根据笔记正文回答，笔记里没有的内容要求
   * 如实说没提到而不是编造；history 是这条笔记之前的问答记录（不含刚问的这条），
   * 让多轮追问能带上下文。 */
  function buildQaPrompt(notesMarkdown, langCode, history, question) {
    const langName = languageName(langCode);
    const historyText = (history || [])
      .map((m) => `${m.role === "user" ? "学生" : "助手"}：${m.text}`)
      .join("\n");
    return [
      `下面是一份${langName}课堂笔记，请只根据这份笔记的内容回答学生的问题；如果问题超出笔记涉及的范围，`,
      `要如实说笔记里没有提到，不要编造内容。回答请直接、简洁，用${langName}。`,
      "",
      "【课堂笔记】",
      notesMarkdown,
      historyText ? "\n【之前的问答】\n" + historyText : "",
      "",
      `【学生的新问题】\n${question}`,
    ].join("\n");
  }

  // ---------- 思维导图：跟闪卡/测验一样基于 notesMarkdown 生成，输出是一个嵌套的
  // {title, children:[...]} 树形 JSON（对象而不是数组），所以需要一个跟 extractJsonArray
  // 对应的、按大括号取整个 JSON 对象的辅助函数。 ----------

  /** 从模型回复里找出第一个完整的 JSON 对象并解析；找不到、解析失败、或解析出来的不是
   * 对象（比如变成了数组）都返回 null，不抛错，处理方式跟 extractJsonArray 一致。 */
  function extractJsonObject(text) {
    const raw = text || "";
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) return null;
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** 构造"根据整理好的笔记正文生成思维导图"的提示词，要求输出嵌套树形 JSON。 */
  function buildMindMapPrompt(notesMarkdown, langCode) {
    const langName = languageName(langCode);
    return [
      `下面是一份${langName}课堂笔记。请把笔记内容整理成一张思维导图，用嵌套的树形结构`,
      "表示各级要点之间的层级关系：根节点是这份笔记的主题，往下每一级是更细的分支或要点。",
      `节点标题用${langName}，尽量精炼（几个字到一小句话，不要整段照抄原文）。`,
      "层级最多4层，每个节点下的子节点数量不要超过8个，避免图形过于复杂难以阅读。",
      '严格只输出一个 JSON 对象，格式为 {"title":"根节点标题","children":[{"title":"分支标题","children":[...]}]}，',
      "叶子节点的 children 是空数组 []，不要输出任何解释、前后缀文字或 Markdown 代码块标记：",
      "",
      notesMarkdown,
    ].join("\n");
  }

  /** 递归校验/清洗一个思维导图节点：title 必须是非空字符串，children 递归清洗、丢弃
   * 不合格的子节点；depth 防止（理论上不会出现的）异常深层结构把渲染卡死。整个节点
   * title 为空就返回 null，让调用方（parseMindMapResponse）能识别"这份回复不能用"。 */
  function sanitizeMindMapNode(node, depth) {
    if (!node || typeof node !== "object" || depth > 6) return null;
    const title = typeof node.title === "string" ? node.title.trim() : "";
    if (!title) return null;
    const childrenRaw = Array.isArray(node.children) ? node.children : [];
    const children = childrenRaw.map((c) => sanitizeMindMapNode(c, depth + 1)).filter(Boolean);
    return { title, children };
  }

  /** 把 buildMindMapPrompt 对应的模型回复解析成 {title, children:[...]} 树；解析失败或
   * 根节点本身不合格都返回 null，调用方按"生成失败，请重试"处理。 */
  function parseMindMapResponse(responseText) {
    const obj = extractJsonObject(responseText);
    return sanitizeMindMapNode(obj, 0);
  }

  return {
    callClaude, extractText, aiClientError, buildMessageContent,
    languageName, formatSeconds, formatSegmentsForPrompt,
    buildTranslatePrompt, parseTranslateResponse, buildNotesPrompt,
    buildFlashcardsPrompt, parseFlashcardsResponse,
    buildQuizPrompt, parseQuizResponse,
    buildQaPrompt,
    buildMindMapPrompt, parseMindMapResponse, extractJsonObject,
    DEFAULT_MODEL,
  };
});
