const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  callClaude,
  extractText,
  buildMessageContent,
  languageName,
  formatSeconds,
  formatSegmentsForPrompt,
  buildTranslatePrompt,
  parseTranslateResponse,
  buildNotesPrompt,
  buildFlashcardsPrompt,
  parseFlashcardsResponse,
  buildQuizPrompt,
  parseQuizResponse,
  buildQaPrompt,
  buildMindMapPrompt,
  parseMindMapResponse,
  extractJsonObject,
  DEFAULT_MODEL,
} = require("../js/aiClient.js");

// ---------- 纯函数：语言名 / 时间格式 ----------

describe("languageName", () => {
  test("认识的语言代码返回中文名", () => {
    assert.equal(languageName("fr"), "法语");
    assert.equal(languageName("zh"), "中文");
  });

  test("不认识的代码原样返回", () => {
    assert.equal(languageName("xx"), "xx");
  });
});

describe("formatSeconds", () => {
  test("正常秒数格式化为 mm:ss", () => {
    assert.equal(formatSeconds(0), "00:00");
    assert.equal(formatSeconds(65), "01:05");
    assert.equal(formatSeconds(600), "10:00");
  });

  test("负数和非数字都当作 0 处理，不报错", () => {
    assert.equal(formatSeconds(-5), "00:00");
    assert.equal(formatSeconds(NaN), "00:00");
    assert.equal(formatSeconds(undefined), "00:00");
  });

  test("四舍五入到秒", () => {
    assert.equal(formatSeconds(65.6), "01:06");
  });
});

// ---------- 提示词构造 / 响应解析 ----------

describe("formatSegmentsForPrompt", () => {
  test("把分段拼成带时间戳的多行文本", () => {
    const text = formatSegmentsForPrompt([
      { start: 0, end: 5, text: "Bonjour" },
      { start: 5, end: 10, text: "à tous" },
    ]);
    assert.equal(text, "[00:00→00:05] Bonjour\n[00:05→00:10] à tous");
  });

  test("空数组或 undefined 返回空字符串", () => {
    assert.equal(formatSegmentsForPrompt([]), "");
    assert.equal(formatSegmentsForPrompt(undefined), "");
  });
});

describe("buildTranslatePrompt", () => {
  test("包含目标语言名称和按编号排列的原文", () => {
    const prompt = buildTranslatePrompt(
      [{ text: "Bonjour" }, { text: "à tous" }],
      "zh"
    );
    assert.match(prompt, /中文/);
    assert.match(prompt, /0\. Bonjour/);
    assert.match(prompt, /1\. à tous/);
  });
});

describe("parseTranslateResponse", () => {
  test("按「编号|译文」解析，时间戳沿用原分段", () => {
    const original = [
      { start: 0, end: 5, text: "Bonjour" },
      { start: 5, end: 10, text: "à tous" },
    ];
    const result = parseTranslateResponse("0|你好\n1|大家好", original);
    assert.deepEqual(result, [
      { start: 0, end: 5, text: "你好" },
      { start: 5, end: 10, text: "大家好" },
    ]);
  });

  test("支持多种分隔符：点号、顿号、中英文冒号", () => {
    const original = [{ start: 0, end: 1, text: "a" }, { start: 1, end: 2, text: "b" }, { start: 2, end: 3, text: "c" }, { start: 3, end: 4, text: "d" }];
    const result = parseTranslateResponse("0.译a\n1、译b\n2:译c\n3：译d", original);
    assert.deepEqual(result.map((s) => s.text), ["译a", "译b", "译c", "译d"]);
  });

  test("解析不到的行，原样保留原文，不丢内容", () => {
    const original = [
      { start: 0, end: 5, text: "Bonjour" },
      { start: 5, end: 10, text: "à tous" },
    ];
    // 只给出第 0 行的翻译，第 1 行格式不对/缺失
    const result = parseTranslateResponse("0|你好\n这一行没有编号", original);
    assert.deepEqual(result, [
      { start: 0, end: 5, text: "你好" },
      { start: 5, end: 10, text: "à tous" },
    ]);
  });

  test("响应为空字符串时，全部原样保留", () => {
    const original = [{ start: 0, end: 1, text: "hi" }];
    const result = parseTranslateResponse("", original);
    assert.deepEqual(result, [{ start: 0, end: 1, text: "hi" }]);
  });

  test("原分段为空数组时返回空数组", () => {
    assert.deepEqual(parseTranslateResponse("0|你好", []), []);
  });
});

describe("buildNotesPrompt", () => {
  test("包含笔记语言名称和格式化后的转录全文", () => {
    const prompt = buildNotesPrompt(
      [{ start: 0, end: 5, text: "Bonjour à tous" }],
      "zh"
    );
    assert.match(prompt, /中文/);
    assert.match(prompt, /\[00:00→00:05\] Bonjour à tous/);
    assert.match(prompt, /Markdown/);
    assert.doesNotMatch(prompt, /课件材料/);
  });

  test("传了 materialsText 时，会拼进「课件材料」段落；没传/空字符串则不出现", () => {
    const withMaterials = buildNotesPrompt(
      [{ start: 0, end: 5, text: "Bonjour" }],
      "zh",
      "【PPT：第3讲.pptx】\n标题页"
    );
    assert.match(withMaterials, /课件材料/);
    assert.match(withMaterials, /标题页/);

    const withBlank = buildNotesPrompt([{ start: 0, end: 5, text: "Bonjour" }], "zh", "   ");
    assert.doesNotMatch(withBlank, /课件材料/);
  });
});

describe("buildFlashcardsPrompt", () => {
  test("包含笔记语言名称、笔记正文，并要求输出 JSON", () => {
    const prompt = buildFlashcardsPrompt("# 标题\n正文内容", "zh");
    assert.match(prompt, /中文/);
    assert.match(prompt, /# 标题\n正文内容/);
    assert.match(prompt, /JSON/);
  });
});

describe("parseFlashcardsResponse", () => {
  test("正常解析出 JSON 数组里的问答对", () => {
    const cards = parseFlashcardsResponse('[{"q":"问题1","a":"答案1"},{"q":"问题2","a":"答案2"}]');
    assert.deepEqual(cards, [
      { question: "问题1", answer: "答案1" },
      { question: "问题2", answer: "答案2" },
    ]);
  });

  test("模型在 JSON 前后夹带解释文字，也能提取出中间的数组", () => {
    const cards = parseFlashcardsResponse('好的，这是闪卡：\n[{"q":"问题","a":"答案"}]\n希望有帮助。');
    assert.deepEqual(cards, [{ question: "问题", answer: "答案" }]);
  });

  test("过滤掉缺少 q 或 a、或者是空字符串的条目，不影响其它能用的条目", () => {
    const cards = parseFlashcardsResponse('[{"q":"","a":"答案"},{"q":"问题"},{"q":"好的","a":"OK"}]');
    assert.deepEqual(cards, [{ question: "好的", answer: "OK" }]);
  });

  test("完全不是 JSON、或者解析失败时返回空数组，不抛错", () => {
    assert.deepEqual(parseFlashcardsResponse("这不是JSON"), []);
    assert.deepEqual(parseFlashcardsResponse(""), []);
    assert.deepEqual(parseFlashcardsResponse(undefined), []);
  });
});

describe("buildQuizPrompt", () => {
  test("包含笔记语言名称、笔记正文，并要求输出 JSON", () => {
    const prompt = buildQuizPrompt("# 标题\n正文内容", "fr");
    assert.match(prompt, /法语/);
    assert.match(prompt, /# 标题\n正文内容/);
    assert.match(prompt, /correctIndex/);
  });
});

describe("parseQuizResponse", () => {
  test("正常解析出题目、选项和正确下标", () => {
    const quiz = parseQuizResponse('[{"question":"1+1=?","options":["1","2","3","4"],"correctIndex":1}]');
    assert.deepEqual(quiz, [{ question: "1+1=?", options: ["1", "2", "3", "4"], correctIndex: 1 }]);
  });

  test("correctIndex 超出 options 范围、不是整数、或 options 少于两项，都丢弃这一题", () => {
    const quiz = parseQuizResponse(JSON.stringify([
      { question: "q1", options: ["a", "b"], correctIndex: 5 },
      { question: "q2", options: ["a", "b"], correctIndex: 0.5 },
      { question: "q3", options: ["a"], correctIndex: 0 },
      { question: "q4", options: ["a", "b"], correctIndex: 1 },
    ]));
    assert.deepEqual(quiz, [{ question: "q4", options: ["a", "b"], correctIndex: 1 }]);
  });

  test("options 里有非字符串或空字符串也丢弃这一题", () => {
    const quiz = parseQuizResponse(JSON.stringify([{ question: "q1", options: ["a", ""], correctIndex: 0 }]));
    assert.deepEqual(quiz, []);
  });

  test("完全不是 JSON 时返回空数组，不抛错", () => {
    assert.deepEqual(parseQuizResponse("不是JSON"), []);
  });
});

describe("buildQaPrompt", () => {
  test("包含笔记正文、新问题，没有历史记录时不出现「之前的问答」段落", () => {
    const prompt = buildQaPrompt("笔记正文", "zh", [], "这是什么意思？");
    assert.match(prompt, /笔记正文/);
    assert.match(prompt, /这是什么意思？/);
    assert.doesNotMatch(prompt, /之前的问答/);
  });

  test("带历史记录时，按学生/助手拼接进提示词", () => {
    const prompt = buildQaPrompt("笔记正文", "zh", [
      { role: "user", text: "第一个问题" },
      { role: "assistant", text: "第一个回答" },
    ], "追问一下");
    assert.match(prompt, /之前的问答/);
    assert.match(prompt, /学生：第一个问题/);
    assert.match(prompt, /助手：第一个回答/);
    assert.match(prompt, /追问一下/);
  });
});

describe("buildMindMapPrompt", () => {
  test("包含笔记语言名称、笔记正文，并要求输出嵌套 JSON 对象", () => {
    const prompt = buildMindMapPrompt("# 标题\n正文内容", "zh");
    assert.match(prompt, /中文/);
    assert.match(prompt, /# 标题\n正文内容/);
    assert.match(prompt, /children/);
    assert.match(prompt, /JSON/);
  });
});

describe("extractJsonObject", () => {
  test("从文字里提取第一个完整的 JSON 对象", () => {
    const obj = extractJsonObject('好的：\n{"a":1,"b":{"c":2}}\n供参考。');
    assert.deepEqual(obj, { a: 1, b: { c: 2 } });
  });

  test("解析出来是数组（不是对象）时返回 null", () => {
    assert.equal(extractJsonObject("[1,2,3]"), null);
  });

  test("找不到大括号或解析失败都返回 null，不抛错", () => {
    assert.equal(extractJsonObject("没有 JSON"), null);
    assert.equal(extractJsonObject("{坏掉的json"), null);
    assert.equal(extractJsonObject(""), null);
    assert.equal(extractJsonObject(undefined), null);
  });
});

describe("parseMindMapResponse", () => {
  test("正常解析出嵌套树，递归保留 title 和 children", () => {
    const tree = parseMindMapResponse(JSON.stringify({
      title: "根节点",
      children: [
        { title: "分支1", children: [{ title: "叶子1", children: [] }] },
        { title: "分支2", children: [] },
      ],
    }));
    assert.equal(tree.title, "根节点");
    assert.equal(tree.children.length, 2);
    assert.equal(tree.children[0].children[0].title, "叶子1");
  });

  test("丢弃 title 为空或缺失的子节点，不影响其它兄弟节点", () => {
    const tree = parseMindMapResponse(JSON.stringify({
      title: "根节点",
      children: [{ title: "" }, { children: [] }, { title: "有效分支", children: [] }],
    }));
    assert.equal(tree.children.length, 1);
    assert.equal(tree.children[0].title, "有效分支");
  });

  test("children 缺失或不是数组时当成没有子节点，不报错", () => {
    const tree = parseMindMapResponse(JSON.stringify({ title: "孤立根节点" }));
    assert.deepEqual(tree, { title: "孤立根节点", children: [] });
  });

  test("根节点本身 title 为空、解析失败、或整体不是对象，都返回 null", () => {
    assert.equal(parseMindMapResponse(JSON.stringify({ title: "" })), null);
    assert.equal(parseMindMapResponse("不是JSON"), null);
    assert.equal(parseMindMapResponse(JSON.stringify([1, 2])), null);
  });
});

// ---------- extractText ----------

describe("extractText", () => {
  test("拼接多个 text 内容块", () => {
    const text = extractText({
      content: [
        { type: "text", text: "第一段" },
        { type: "text", text: "第二段" },
      ],
    });
    assert.equal(text, "第一段\n第二段");
  });

  test("过滤掉非 text 类型的内容块", () => {
    const text = extractText({
      content: [
        { type: "tool_use", text: "不应该出现" },
        { type: "text", text: "真正的回复" },
      ],
    });
    assert.equal(text, "真正的回复");
  });

  test("content 缺失或不是数组时返回空字符串", () => {
    assert.equal(extractText({}), "");
    assert.equal(extractText(null), "");
    assert.equal(extractText({ content: "oops" }), "");
  });
});

describe("buildMessageContent", () => {
  test("没有图片时，原样返回纯文字（跟以前完全一样，不给现有调用方增加负担）", () => {
    assert.equal(buildMessageContent("你好", undefined), "你好");
    assert.equal(buildMessageContent("你好", []), "你好");
  });

  test("有图片时，拼成「图片在前、文字在后」的内容块数组", () => {
    const content = buildMessageContent("请看图回答", [
      { base64Data: "AAAA", mediaType: "image/png" },
    ]);
    assert.deepEqual(content, [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "请看图回答" },
    ]);
  });

  test("多张图片按顺序排列；没有 mediaType 时默认 image/jpeg；没有 base64Data 的条目被过滤掉", () => {
    const content = buildMessageContent("文字", [
      { base64Data: "BBBB" },
      { base64Data: "" },
      null,
      { base64Data: "CCCC", mediaType: "image/webp" },
    ]);
    assert.equal(content.length, 3); // 2张有效图片 + 1段文字
    assert.equal(content[0].source.media_type, "image/jpeg");
    assert.equal(content[1].source.media_type, "image/webp");
    assert.equal(content[2].text, "文字");
  });
});

// ---------- callClaude ----------

describe("callClaude", () => {
  test("没有密钥时抛出 no_key 错误，不发请求", async () => {
    let called = false;
    await assert.rejects(
      () =>
        callClaude({
          apiKey: "  ",
          prompt: "hi",
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

  test("fetch 本身抛错（断网）时，返回 network 错误", async () => {
    await assert.rejects(
      () =>
        callClaude({
          apiKey: "sk-test",
          prompt: "hi",
          fetchImpl: async () => {
            throw new Error("network down");
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
          callClaude({
            apiKey: "sk-test",
            prompt: "hi",
            fetchImpl: async () => ({ ok: false, status }),
          }),
        (err) => {
          assert.equal(err.kind, "auth");
          return true;
        }
      );
    }
  });

  test("其它错误状态码，能解析出错误详情时带上详情文字", async () => {
    await assert.rejects(
      () =>
        callClaude({
          apiKey: "sk-test",
          prompt: "hi",
          fetchImpl: async () => ({
            ok: false,
            status: 500,
            json: async () => ({ error: { message: "内部错误" } }),
          }),
        }),
      (err) => {
        assert.equal(err.kind, "api");
        assert.match(err.message, /500/);
        assert.match(err.message, /内部错误/);
        return true;
      }
    );
  });

  test("错误状态码但响应体无法解析时，仍然给出不带详情的通用提示", async () => {
    await assert.rejects(
      () =>
        callClaude({
          apiKey: "sk-test",
          prompt: "hi",
          fetchImpl: async () => ({
            ok: false,
            status: 429,
            json: async () => {
              throw new Error("bad json");
            },
          }),
        }),
      (err) => {
        assert.equal(err.kind, "api");
        assert.match(err.message, /429/);
        return true;
      }
    );
  });

  test("成功响应体无法解析为 JSON 时，返回 api 错误", async () => {
    await assert.rejects(
      () =>
        callClaude({
          apiKey: "sk-test",
          prompt: "hi",
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            json: async () => {
              throw new Error("bad json");
            },
          }),
        }),
      (err) => {
        assert.equal(err.kind, "api");
        return true;
      }
    );
  });

  test("成功但内容为空时，返回 empty_response 错误", async () => {
    await assert.rejects(
      () =>
        callClaude({
          apiKey: "sk-test",
          prompt: "hi",
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            json: async () => ({ content: [] }),
          }),
        }),
      (err) => {
        assert.equal(err.kind, "empty_response");
        return true;
      }
    );
  });

  test("成功时返回解析出的纯文字", async () => {
    const text = await callClaude({
      apiKey: "sk-test",
      prompt: "hi",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: "text", text: "你好呀" }] }),
      }),
    });
    assert.equal(text, "你好呀");
  });

  test("请求体和请求头带上密钥、默认模型、系统提示词、用户提示词", async () => {
    let capturedUrl;
    let capturedOptions;
    await callClaude({
      apiKey: "sk-test-key",
      system: "你是助手",
      prompt: "翻译这段话",
      fetchImpl: async (url, options) => {
        capturedUrl = url;
        capturedOptions = options;
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: [{ type: "text", text: "ok" }] }),
        };
      },
    });
    assert.equal(capturedUrl, "https://api.anthropic.com/v1/messages");
    assert.equal(capturedOptions.method, "POST");
    assert.equal(capturedOptions.headers["x-api-key"], "sk-test-key");
    assert.equal(
      capturedOptions.headers["anthropic-dangerous-direct-browser-access"],
      "true"
    );
    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.model, DEFAULT_MODEL);
    assert.equal(body.system, "你是助手");
    assert.deepEqual(body.messages, [{ role: "user", content: "翻译这段话" }]);
  });

  test("可以指定自定义模型和 maxTokens", async () => {
    let capturedBody;
    await callClaude({
      apiKey: "sk-test",
      prompt: "hi",
      model: "claude-opus-5",
      maxTokens: 100,
      fetchImpl: async (url, options) => {
        capturedBody = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: [{ type: "text", text: "ok" }] }),
        };
      },
    });
    assert.equal(capturedBody.model, "claude-opus-5");
    assert.equal(capturedBody.max_tokens, 100);
  });

  test("传了 images 时，请求体里的 content 是图片+文字的内容块数组", async () => {
    let capturedBody;
    await callClaude({
      apiKey: "sk-test",
      prompt: "这张图里写了什么？",
      images: [{ base64Data: "AAAA", mediaType: "image/jpeg" }],
      fetchImpl: async (url, options) => {
        capturedBody = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: [{ type: "text", text: "ok" }] }),
        };
      },
    });
    assert.deepEqual(capturedBody.messages[0].content, [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
      { type: "text", text: "这张图里写了什么？" },
    ]);
  });
});
