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

  /**
   * 调用 Claude API，返回模型输出的纯文字。
   * fetchImpl 是为了方便测试注入假的 fetch；不传的话用运行环境的全局 fetch。
   */
  async function callClaude({ apiKey, system, prompt, model, maxTokens, fetchImpl } = {}) {
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
          messages: [{ role: "user", content: prompt }],
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

  /** 构造"把整段转录整理成结构化 Markdown 笔记"的提示词。 */
  function buildNotesPrompt(segments, noteLangCode) {
    const langName = languageName(noteLangCode);
    return [
      `下面是一段课堂录音的完整转录文字。请用${langName}把它整理成一份结构化的课堂笔记，`,
      "用 Markdown 格式：合理拆分小标题（用##）、要点用无序列表、有对照关系的内容用表格，",
      "保留重要的原文引用（可以用引用块），不要逐句翻译或复述，重点是提炼结构和要点。",
      "只输出笔记正文本身，不要输出额外的解释或\"好的，这是笔记\"这类前后缀：",
      "",
      formatSegmentsForPrompt(segments),
    ].join("\n");
  }

  return {
    callClaude, extractText, aiClientError,
    languageName, formatSeconds, formatSegmentsForPrompt,
    buildTranslatePrompt, parseTranslateResponse, buildNotesPrompt,
    DEFAULT_MODEL,
  };
});
