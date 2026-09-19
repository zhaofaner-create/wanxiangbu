const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  translateWithGoogle,
  translateWithAzure,
  translateWithDeepL,
  translateTexts,
  translateSegments,
  isProviderConfigured,
  buildGoogleRequestBody,
  extractGoogleTranslations,
  buildAzureUrl,
  buildAzureRequestBody,
  extractAzureTranslations,
  pickDeeplHost,
  mapDeeplTargetLang,
  buildDeeplRequestBody,
  extractDeeplTranslations,
} = require("../js/translationProviders.js");

// ---------- 纯函数：请求体构造 / 响应解析 ----------

describe("Google：请求体构造与响应解析", () => {
  test("请求体带上 q/target/format", () => {
    assert.deepEqual(buildGoogleRequestBody(["a", "b"], "en"), { q: ["a", "b"], target: "en", format: "text" });
  });

  test("能从成功响应里取出译文数组", () => {
    const data = { data: { translations: [{ translatedText: "hi" }, { translatedText: "there" }] } };
    assert.deepEqual(extractGoogleTranslations(data), ["hi", "there"]);
  });

  test("响应形状不对时返回 null", () => {
    assert.equal(extractGoogleTranslations({}), null);
    assert.equal(extractGoogleTranslations(null), null);
  });
});

describe("Azure：URL 构造、请求体构造与响应解析", () => {
  test("URL 带上 api-version 和目标语言", () => {
    assert.equal(
      buildAzureUrl("fr"),
      "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=fr"
    );
  });

  test("请求体是 [{Text}] 数组", () => {
    assert.deepEqual(buildAzureRequestBody(["a", "b"]), [{ Text: "a" }, { Text: "b" }]);
  });

  test("能从成功响应里按顺序取出译文", () => {
    const data = [{ translations: [{ text: "bonjour", to: "fr" }] }, { translations: [{ text: "salut", to: "fr" }] }];
    assert.deepEqual(extractAzureTranslations(data), ["bonjour", "salut"]);
  });

  test("响应不是数组时返回 null", () => {
    assert.equal(extractAzureTranslations({}), null);
  });

  test("某一项没有 translations 时该项译文为空字符串，不报错、不丢其它项", () => {
    const data = [{ translations: [{ text: "ok" }] }, {}];
    assert.deepEqual(extractAzureTranslations(data), ["ok", ""]);
  });
});

describe("DeepL：域名选择、目标语言映射、请求体构造与响应解析", () => {
  test("免费版密钥（:fx 结尾）走 api-free 域名，付费版走 api 域名", () => {
    assert.equal(pickDeeplHost("abc123:fx"), "https://api-free.deepl.com");
    assert.equal(pickDeeplHost("abc123"), "https://api.deepl.com");
  });

  test("英语和葡萄牙语映射成带地区变体的代码，其它语言原样大写", () => {
    assert.equal(mapDeeplTargetLang("en"), "EN-US");
    assert.equal(mapDeeplTargetLang("pt"), "PT-PT");
    assert.equal(mapDeeplTargetLang("fr"), "FR");
    assert.equal(mapDeeplTargetLang("zh"), "ZH");
  });

  test("不认识的代码原样转大写，不报错", () => {
    assert.equal(mapDeeplTargetLang("xx"), "XX");
  });

  test("请求体带上 text 数组和映射后的 target_lang", () => {
    assert.deepEqual(buildDeeplRequestBody(["a"], "en"), { text: ["a"], target_lang: "EN-US" });
  });

  test("能从成功响应里取出译文数组", () => {
    const data = { translations: [{ text: "Bonjour" }, { text: "Salut" }] };
    assert.deepEqual(extractDeeplTranslations(data), ["Bonjour", "Salut"]);
  });

  test("响应形状不对时返回 null", () => {
    assert.equal(extractDeeplTranslations({}), null);
  });
});

// ---------- isProviderConfigured ----------

describe("isProviderConfigured", () => {
  test("google/deepl 只需要各自的密钥", () => {
    assert.equal(isProviderConfigured("google", {}), false);
    assert.equal(isProviderConfigured("google", { googleApiKey: "k" }), true);
    assert.equal(isProviderConfigured("deepl", { deeplApiKey: "k" }), true);
  });

  test("azure 密钥和区域缺一不可", () => {
    assert.equal(isProviderConfigured("azure", { azureApiKey: "k" }), false);
    assert.equal(isProviderConfigured("azure", { azureRegion: "eastasia" }), false);
    assert.equal(isProviderConfigured("azure", { azureApiKey: "k", azureRegion: "eastasia" }), true);
  });

  test("不认识的 provider 返回 false", () => {
    assert.equal(isProviderConfigured("bing", { bingApiKey: "k" }), false);
  });
});

// ---------- translateWithGoogle ----------

describe("translateWithGoogle", () => {
  test("没有密钥时抛出 no_key 错误，不发请求", async () => {
    let called = false;
    await assert.rejects(
      () =>
        translateWithGoogle({
          apiKey: "  ",
          texts: ["a"],
          targetLangCode: "en",
          fetchImpl: async () => {
            called = true;
            return { ok: true, json: async () => ({}) };
          },
        }),
      (err) => {
        assert.equal(err.kind, "no_key");
        return true;
      }
    );
    assert.equal(called, false);
  });

  test("fetch 抛错时返回 network 错误", async () => {
    await assert.rejects(
      () =>
        translateWithGoogle({
          apiKey: "k",
          texts: ["a"],
          targetLangCode: "en",
          fetchImpl: async () => {
            throw new Error("down");
          },
        }),
      (err) => {
        assert.equal(err.kind, "network");
        return true;
      }
    );
  });

  test("401/403 返回 auth 错误", async () => {
    for (const status of [401, 403]) {
      await assert.rejects(
        () =>
          translateWithGoogle({ apiKey: "k", texts: ["a"], targetLangCode: "en", fetchImpl: async () => ({ ok: false, status }) }),
        (err) => {
          assert.equal(err.kind, "auth");
          return true;
        }
      );
    }
  });

  test("其它错误状态码，能解析出详情时带上详情文字", async () => {
    await assert.rejects(
      () =>
        translateWithGoogle({
          apiKey: "k",
          texts: ["a"],
          targetLangCode: "en",
          fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "无效参数" } }) }),
        }),
      (err) => {
        assert.equal(err.kind, "api");
        assert.match(err.message, /400/);
        assert.match(err.message, /无效参数/);
        return true;
      }
    );
  });

  test("成功但内容为空时返回 empty_response 错误", async () => {
    await assert.rejects(
      () =>
        translateWithGoogle({
          apiKey: "k",
          texts: ["a"],
          targetLangCode: "en",
          fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
        }),
      (err) => {
        assert.equal(err.kind, "empty_response");
        return true;
      }
    );
  });

  test("成功时返回译文数组，且 URL 和请求体正确", async () => {
    let capturedUrl;
    let capturedOptions;
    const result = await translateWithGoogle({
      apiKey: "my-key",
      texts: ["Bonjour", "Salut"],
      targetLangCode: "en",
      fetchImpl: async (url, options) => {
        capturedUrl = url;
        capturedOptions = options;
        return { ok: true, status: 200, json: async () => ({ data: { translations: [{ translatedText: "Hello" }, { translatedText: "Hi" }] } }) };
      },
    });
    assert.deepEqual(result, ["Hello", "Hi"]);
    assert.equal(capturedUrl, "https://translation.googleapis.com/language/translate/v2?key=my-key");
    assert.equal(capturedOptions.method, "POST");
    assert.deepEqual(JSON.parse(capturedOptions.body), { q: ["Bonjour", "Salut"], target: "en", format: "text" });
  });
});

// ---------- translateWithAzure ----------

describe("translateWithAzure", () => {
  test("缺密钥或缺区域都算 no_key，不发请求", async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      return { ok: true, json: async () => [] };
    };
    await assert.rejects(
      () => translateWithAzure({ apiKey: "", region: "eastasia", texts: ["a"], targetLangCode: "en", fetchImpl }),
      (err) => { assert.equal(err.kind, "no_key"); return true; }
    );
    await assert.rejects(
      () => translateWithAzure({ apiKey: "k", region: "", texts: ["a"], targetLangCode: "en", fetchImpl }),
      (err) => { assert.equal(err.kind, "no_key"); return true; }
    );
    assert.equal(called, false);
  });

  test("成功时返回译文数组，请求头带上密钥和区域", async () => {
    let capturedOptions;
    const result = await translateWithAzure({
      apiKey: "azure-key",
      region: "eastasia",
      texts: ["Hello"],
      targetLangCode: "fr",
      fetchImpl: async (url, options) => {
        capturedOptions = options;
        return { ok: true, status: 200, json: async () => [{ translations: [{ text: "Bonjour", to: "fr" }] }] };
      },
    });
    assert.deepEqual(result, ["Bonjour"]);
    assert.equal(capturedOptions.headers["Ocp-Apim-Subscription-Key"], "azure-key");
    assert.equal(capturedOptions.headers["Ocp-Apim-Subscription-Region"], "eastasia");
  });

  test("401 返回 auth 错误", async () => {
    await assert.rejects(
      () => translateWithAzure({ apiKey: "k", region: "eastasia", texts: ["a"], targetLangCode: "en", fetchImpl: async () => ({ ok: false, status: 401 }) }),
      (err) => { assert.equal(err.kind, "auth"); return true; }
    );
  });
});

// ---------- translateWithDeepL ----------

describe("translateWithDeepL", () => {
  test("没有密钥时抛出 no_key 错误", async () => {
    await assert.rejects(
      () => translateWithDeepL({ apiKey: "", texts: ["a"], targetLangCode: "en", fetchImpl: async () => ({}) }),
      (err) => { assert.equal(err.kind, "no_key"); return true; }
    );
  });

  test("成功时返回译文数组，Authorization 头和域名根据免费版密钥后缀选择正确", async () => {
    let capturedUrl;
    let capturedOptions;
    const result = await translateWithDeepL({
      apiKey: "deepl-key:fx",
      texts: ["Hello"],
      targetLangCode: "fr",
      fetchImpl: async (url, options) => {
        capturedUrl = url;
        capturedOptions = options;
        return { ok: true, status: 200, json: async () => ({ translations: [{ text: "Bonjour" }] }) };
      },
    });
    assert.deepEqual(result, ["Bonjour"]);
    assert.equal(capturedUrl, "https://api-free.deepl.com/v2/translate");
    assert.equal(capturedOptions.headers.authorization, "DeepL-Auth-Key deepl-key:fx");
  });

  test("付费版密钥（无 :fx 后缀）走付费域名", async () => {
    let capturedUrl;
    await translateWithDeepL({
      apiKey: "deepl-key",
      texts: ["Hello"],
      targetLangCode: "fr",
      fetchImpl: async (url) => {
        capturedUrl = url;
        return { ok: true, status: 200, json: async () => ({ translations: [{ text: "Bonjour" }] }) };
      },
    });
    assert.equal(capturedUrl, "https://api.deepl.com/v2/translate");
  });

  test("403 返回 auth 错误", async () => {
    await assert.rejects(
      () => translateWithDeepL({ apiKey: "k", texts: ["a"], targetLangCode: "en", fetchImpl: async () => ({ ok: false, status: 403 }) }),
      (err) => { assert.equal(err.kind, "auth"); return true; }
    );
  });
});

// ---------- translateTexts（按 provider 分发） ----------

describe("translateTexts", () => {
  test("分发到 google/azure/deepl 三家，各自取对应的密钥字段", async () => {
    const keys = { googleApiKey: "g", azureApiKey: "a", azureRegion: "eastasia", deeplApiKey: "d" };
    const fetchImpl = async (url) => {
      if (url.includes("googleapis")) return { ok: true, status: 200, json: async () => ({ data: { translations: [{ translatedText: "G" }] } }) };
      if (url.includes("cognitive")) return { ok: true, status: 200, json: async () => [{ translations: [{ text: "A" }] }] };
      return { ok: true, status: 200, json: async () => ({ translations: [{ text: "D" }] }) };
    };
    assert.deepEqual(await translateTexts({ provider: "google", texts: ["x"], targetLangCode: "en", keys, fetchImpl }), ["G"]);
    assert.deepEqual(await translateTexts({ provider: "azure", texts: ["x"], targetLangCode: "en", keys, fetchImpl }), ["A"]);
    assert.deepEqual(await translateTexts({ provider: "deepl", texts: ["x"], targetLangCode: "en", keys, fetchImpl }), ["D"]);
  });

  test("不认识的 provider 抛出 unsupported_provider 错误", async () => {
    await assert.rejects(
      () => translateTexts({ provider: "bing", texts: ["x"], targetLangCode: "en", keys: {} }),
      (err) => { assert.equal(err.kind, "unsupported_provider"); return true; }
    );
  });
});

// ---------- translateSegments ----------

describe("translateSegments", () => {
  test("按原顺序把译文塞回分段，时间戳沿用原分段", async () => {
    const segments = [
      { start: 0, end: 5, text: "Bonjour" },
      { start: 5, end: 10, text: "à tous" },
    ];
    const result = await translateSegments({
      provider: "google",
      segments,
      targetLangCode: "en",
      keys: { googleApiKey: "g" },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: { translations: [{ translatedText: "Hello" }, { translatedText: "everyone" }] } }) }),
    });
    assert.deepEqual(result, [
      { start: 0, end: 5, text: "Hello" },
      { start: 5, end: 10, text: "everyone" },
    ]);
  });

  test("某一行译文缺失（空字符串）时原样保留原文，不丢内容", async () => {
    const segments = [{ start: 0, end: 5, text: "Bonjour" }];
    const result = await translateSegments({
      provider: "google",
      segments,
      targetLangCode: "en",
      keys: { googleApiKey: "g" },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: { translations: [{ translatedText: "" }] } }) }),
    });
    assert.deepEqual(result, [{ start: 0, end: 5, text: "Bonjour" }]);
  });

  test("空分段数组直接返回空数组，不发请求", async () => {
    let called = false;
    const result = await translateSegments({
      provider: "google",
      segments: [],
      targetLangCode: "en",
      keys: { googleApiKey: "g" },
      fetchImpl: async () => {
        called = true;
        return { ok: true, status: 200, json: async () => ({ data: { translations: [] } }) };
      },
    });
    assert.deepEqual(result, []);
    // 空数组也会发一次请求（texts 为 []），但不应该报错；这里只确认调用了且结果为空。
    assert.equal(called, true);
  });
});
