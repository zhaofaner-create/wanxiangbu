(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.translationProviders = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // 封装"课堂笔记·多语言互译"要用到的三家专门翻译服务：Google Cloud Translation、
  // Azure AI Translator、DeepL。跟 aiClient.js 里的 Claude 调用是同一个架构原则——
  // 用户自己申请、自己填的密钥，直接从浏览器发请求给对应服务商的官方接口，不经过
  // 我们自己的任何服务器；三家密钥分开存，互不影响，翻译按钮只会调用"当前生效"的
  // 那一家（存在 settings.translationProvider 里）。
  //
  // 这三家都是"专门做翻译"的接口，直接把一批文本传过去、按原样顺序拿回一批译文，
  // 不需要像 Claude 那样靠"编号|译文"这种提示词技巧去保证一一对应，更省心也更准确。
  // 整理笔记（AI 把转录整理成结构化 Markdown）不受这次改动影响，继续只用 Claude。

  /** 统一的错误：message 是给用户看的中文提示，kind 供调用方按类型做不同处理。 */
  function providerError(message, kind) {
    const err = new Error(message);
    err.kind = kind; // "no_key" | "network" | "auth" | "api" | "empty_response" | "unsupported_provider"
    return err;
  }

  function pickFetch(fetchImpl) {
    return fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  }

  // ---------- Google Cloud Translation API（v2 Basic 版，纯 API 密钥认证，最适合纯前端调用） ----------

  const GOOGLE_ENDPOINT = "https://translation.googleapis.com/language/translate/v2";

  /** Google 的语言代码和万象簿内部的两位 ISO 代码是同一套，不需要额外映射。 */
  function buildGoogleRequestBody(texts, targetLangCode) {
    return { q: texts, target: targetLangCode, format: "text" };
  }

  /** 成功响应形如 { data: { translations: [{ translatedText }, ...] } }。 */
  function extractGoogleTranslations(data) {
    const list = data && data.data && Array.isArray(data.data.translations) ? data.data.translations : null;
    if (!list) return null;
    return list.map((item) => (item && typeof item.translatedText === "string" ? item.translatedText : ""));
  }

  async function translateWithGoogle({ apiKey, texts, targetLangCode, fetchImpl } = {}) {
    const key = (apiKey || "").trim();
    if (!key) {
      throw providerError("还没有设置 Google 翻译密钥，请先去「数据与设置」填一个", "no_key");
    }
    const doFetch = pickFetch(fetchImpl);
    if (!doFetch) {
      throw providerError("当前环境不支持联网请求", "network");
    }

    let res;
    try {
      res = await doFetch(`${GOOGLE_ENDPOINT}?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildGoogleRequestBody(texts, targetLangCode)),
      });
    } catch {
      throw providerError("联网请求失败，请检查网络连接", "network");
    }

    if (res.status === 401 || res.status === 403) {
      throw providerError("Google 翻译密钥无效或没有权限，请检查「数据与设置」里填的密钥", "auth");
    }
    if (!res.ok) {
      const detail = await readErrorDetail(res, (body) => body && body.error && body.error.message);
      throw providerError(`Google 翻译服务返回错误（HTTP ${res.status}）${detail ? "：" + detail : ""}`, "api");
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw providerError("Google 翻译服务返回的内容无法解析", "api");
    }
    const translations = extractGoogleTranslations(data);
    if (!translations) {
      throw providerError("Google 翻译服务没有返回任何内容", "empty_response");
    }
    return translations;
  }

  // ---------- Azure AI Translator（v3.0，密钥 + 资源区域两者缺一不可） ----------

  const AZURE_ENDPOINT = "https://api.cognitive.microsofttranslator.com/translate";

  function buildAzureUrl(targetLangCode) {
    return `${AZURE_ENDPOINT}?api-version=3.0&to=${encodeURIComponent(targetLangCode)}`;
  }

  function buildAzureRequestBody(texts) {
    return texts.map((text) => ({ Text: text }));
  }

  /** 成功响应是个数组，跟输入顺序一一对应：[{ translations: [{ text, to }] }, ...]。 */
  function extractAzureTranslations(data) {
    if (!Array.isArray(data)) return null;
    return data.map((item) => {
      const t = item && Array.isArray(item.translations) ? item.translations[0] : null;
      return t && typeof t.text === "string" ? t.text : "";
    });
  }

  async function translateWithAzure({ apiKey, region, texts, targetLangCode, fetchImpl } = {}) {
    const key = (apiKey || "").trim();
    const rg = (region || "").trim();
    if (!key || !rg) {
      throw providerError("还没有设置 Azure Translator 密钥和区域，请先去「数据与设置」填好", "no_key");
    }
    const doFetch = pickFetch(fetchImpl);
    if (!doFetch) {
      throw providerError("当前环境不支持联网请求", "network");
    }

    let res;
    try {
      res = await doFetch(buildAzureUrl(targetLangCode), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Ocp-Apim-Subscription-Key": key,
          "Ocp-Apim-Subscription-Region": rg,
        },
        body: JSON.stringify(buildAzureRequestBody(texts)),
      });
    } catch {
      throw providerError("联网请求失败，请检查网络连接", "network");
    }

    if (res.status === 401 || res.status === 403) {
      throw providerError("Azure Translator 密钥或区域无效，请检查「数据与设置」里填的内容", "auth");
    }
    if (!res.ok) {
      const detail = await readErrorDetail(res, (body) => body && body.error && body.error.message);
      throw providerError(`Azure Translator 服务返回错误（HTTP ${res.status}）${detail ? "：" + detail : ""}`, "api");
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw providerError("Azure Translator 服务返回的内容无法解析", "api");
    }
    const translations = extractAzureTranslations(data);
    if (!translations) {
      throw providerError("Azure Translator 服务没有返回任何内容", "empty_response");
    }
    return translations;
  }

  // ---------- DeepL ----------

  // 免费版（Developer 免费额度）密钥固定以 ":fx" 结尾，跟付费版用的是两个不同的域名，
  // 传错域名会直接收到认证失败，所以要先看密钥后缀再决定请求哪个地址。
  function pickDeeplHost(apiKey) {
    return /:fx$/.test((apiKey || "").trim()) ? "https://api-free.deepl.com" : "https://api.deepl.com";
  }

  // DeepL 的目标语言里，英语和葡萄牙语必须带地区变体（不能只传 EN / PT），
  // 这里默认选最通用的 EN-US / PT-PT；其它语言直接用大写的两位代码即可。
  const DEEPL_TARGET_LANG = {
    zh: "ZH", en: "EN-US", fr: "FR", es: "ES", de: "DE",
    ja: "JA", ko: "KO", ru: "RU", pt: "PT-PT", it: "IT",
  };

  function mapDeeplTargetLang(code) {
    return DEEPL_TARGET_LANG[code] || String(code || "").toUpperCase();
  }

  function buildDeeplRequestBody(texts, targetLangCode) {
    return { text: texts, target_lang: mapDeeplTargetLang(targetLangCode) };
  }

  /** 成功响应形如 { translations: [{ text }, ...] }。 */
  function extractDeeplTranslations(data) {
    const list = data && Array.isArray(data.translations) ? data.translations : null;
    if (!list) return null;
    return list.map((item) => (item && typeof item.text === "string" ? item.text : ""));
  }

  async function translateWithDeepL({ apiKey, texts, targetLangCode, fetchImpl } = {}) {
    const key = (apiKey || "").trim();
    if (!key) {
      throw providerError("还没有设置 DeepL 密钥，请先去「数据与设置」填一个", "no_key");
    }
    const doFetch = pickFetch(fetchImpl);
    if (!doFetch) {
      throw providerError("当前环境不支持联网请求", "network");
    }

    let res;
    try {
      res = await doFetch(`${pickDeeplHost(key)}/v2/translate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `DeepL-Auth-Key ${key}`,
        },
        body: JSON.stringify(buildDeeplRequestBody(texts, targetLangCode)),
      });
    } catch {
      throw providerError("联网请求失败，请检查网络连接", "network");
    }

    if (res.status === 401 || res.status === 403) {
      throw providerError("DeepL 密钥无效或没有权限，请检查「数据与设置」里填的密钥", "auth");
    }
    if (!res.ok) {
      const detail = await readErrorDetail(res, (body) => body && body.message);
      throw providerError(`DeepL 服务返回错误（HTTP ${res.status}）${detail ? "：" + detail : ""}`, "api");
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw providerError("DeepL 服务返回的内容无法解析", "api");
    }
    const translations = extractDeeplTranslations(data);
    if (!translations) {
      throw providerError("DeepL 服务没有返回任何内容", "empty_response");
    }
    return translations;
  }

  /** 出错响应体一般是 JSON，尽量取出里面的说明文字；取不到就返回空字符串，调用方会退化成不带详情的通用提示。 */
  async function readErrorDetail(res, pick) {
    try {
      const body = await res.json();
      return pick(body) || "";
    } catch {
      return "";
    }
  }

  // ---------- 统一入口：按 provider 分发，供 classNotes.js 调用 ----------

  const PROVIDERS = ["google", "azure", "deepl"];

  /**
   * 翻译一批纯文本，返回顺序和输入完全一致的译文数组。
   * keys 形如 { googleApiKey, azureApiKey, azureRegion, deeplApiKey }，
   * 调用方（classNotes.js）直接把 store.getSettings() 里对应的字段传进来就行。
   */
  async function translateTexts({ provider, texts, targetLangCode, keys, fetchImpl } = {}) {
    const k = keys || {};
    if (provider === "google") {
      return translateWithGoogle({ apiKey: k.googleApiKey, texts, targetLangCode, fetchImpl });
    }
    if (provider === "azure") {
      return translateWithAzure({ apiKey: k.azureApiKey, region: k.azureRegion, texts, targetLangCode, fetchImpl });
    }
    if (provider === "deepl") {
      return translateWithDeepL({ apiKey: k.deeplApiKey, texts, targetLangCode, fetchImpl });
    }
    throw providerError("不认识的翻译服务", "unsupported_provider");
  }

  /**
   * 翻译课堂笔记的转录分段，时间戳沿用原分段；某一行译文缺失时原样保留原文，不会丢内容
   * （跟 aiClient.js 的 parseTranslateResponse 是同一个"绝不丢内容"的原则）。
   */
  async function translateSegments({ provider, segments, targetLangCode, keys, fetchImpl } = {}) {
    const list = segments || [];
    const texts = list.map((seg) => seg.text);
    const translated = await translateTexts({ provider, texts, targetLangCode, keys, fetchImpl });
    return list.map((seg, i) => ({
      start: seg.start,
      end: seg.end,
      text: translated[i] || seg.text,
    }));
  }

  /** 某个 provider 是否已经填好了它要求的全部密钥字段（Azure 需要密钥+区域两个都填）。 */
  function isProviderConfigured(provider, keys) {
    const k = keys || {};
    if (provider === "google") return Boolean((k.googleApiKey || "").trim());
    if (provider === "azure") return Boolean((k.azureApiKey || "").trim()) && Boolean((k.azureRegion || "").trim());
    if (provider === "deepl") return Boolean((k.deeplApiKey || "").trim());
    return false;
  }

  return {
    PROVIDERS, providerError, isProviderConfigured,
    translateTexts, translateSegments,
    translateWithGoogle, translateWithAzure, translateWithDeepL,
    buildGoogleRequestBody, extractGoogleTranslations,
    buildAzureUrl, buildAzureRequestBody, extractAzureTranslations,
    pickDeeplHost, mapDeeplTargetLang, buildDeeplRequestBody, extractDeeplTranslations,
  };
});
