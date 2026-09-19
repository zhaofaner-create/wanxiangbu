(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var result = factory();
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.markdown = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // 一个极简、无依赖的 Markdown 解析器，只覆盖课堂笔记模块用得到的这几种排版：
  // 标题（#~######）、无序列表（- / *）、引用块（>）、表格（| a | b |）、普通段落，
  // 以及行内的 **加粗** 和 `代码`——正好对应 aiClient.js 提示词里明确要求 AI 输出的
  // 那几种结构，不追求覆盖完整 Markdown 规范。解析结果是纯数据（一组"块"描述），
  // 不碰任何 DOM，方便单测；渲染成 DOM 节点的部分在 classNotes.js 里。

  function isTableRow(line) {
    return /^\s*\|.*\|\s*$/.test(line);
  }
  function isTableDivider(line) {
    return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");
  }
  function splitTableRow(line) {
    const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map((cell) => cell.trim());
  }

  /** 把一段 Markdown 文本解析成一组结构化的"块"：{type:"heading"|"list"|"quote"|"table"|"paragraph", ...}。 */
  function parseMarkdownBlocks(markdown) {
    const lines = (markdown || "").replace(/\r\n/g, "\n").split("\n");
    const blocks = [];
    let i = 0;
    let paragraphBuf = [];

    function flushParagraph() {
      if (paragraphBuf.length) {
        blocks.push({ type: "paragraph", text: paragraphBuf.join(" ").trim() });
        paragraphBuf = [];
      }
    }

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) {
        flushParagraph();
        i += 1;
        continue;
      }

      const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        flushParagraph();
        blocks.push({ type: "heading", level: headingMatch[1].length, text: headingMatch[2].trim() });
        i += 1;
        continue;
      }

      if (/^\s*[-*]\s+/.test(line)) {
        flushParagraph();
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*]\s+/, "").trim());
          i += 1;
        }
        blocks.push({ type: "list", items });
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        flushParagraph();
        const quoteLines = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
          i += 1;
        }
        blocks.push({ type: "quote", text: quoteLines.join("\n").trim() });
        continue;
      }

      if (isTableRow(line)) {
        flushParagraph();
        const header = splitTableRow(line);
        i += 1;
        if (i < lines.length && isTableDivider(lines[i])) i += 1; // 跳过 |---|---| 分隔行
        const rows = [];
        while (i < lines.length && isTableRow(lines[i])) {
          rows.push(splitTableRow(lines[i]));
          i += 1;
        }
        blocks.push({ type: "table", header, rows });
        continue;
      }

      paragraphBuf.push(line.trim());
      i += 1;
    }
    flushParagraph();
    return blocks;
  }

  /** 把一行文字里的 **加粗** 和 `代码` 切成 [{text, bold?, code?}] 片段，供渲染层逐段生成 DOM 节点。 */
  function parseInlineSegments(text) {
    const segments = [];
    const re = /(\*\*(.+?)\*\*|`(.+?)`)/g;
    let lastIndex = 0;
    let m;
    while ((m = re.exec(text || ""))) {
      if (m.index > lastIndex) segments.push({ text: text.slice(lastIndex, m.index) });
      if (m[2] !== undefined) segments.push({ text: m[2], bold: true });
      else segments.push({ text: m[3], code: true });
      lastIndex = re.lastIndex;
    }
    if (lastIndex < (text || "").length) segments.push({ text: text.slice(lastIndex) });
    return segments.length ? segments : [{ text: text || "" }];
  }

  return { parseMarkdownBlocks, parseInlineSegments };
});
