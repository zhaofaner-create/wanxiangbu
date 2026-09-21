(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.pptxText = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  // 从 .pptx 文件里提取幻灯片文字，不依赖任何第三方库（跟这个 app "纯 vanilla JS、不搭
  // 构建流程"的一贯做法一致）。.pptx 本质是一个 ZIP 压缩包，每页幻灯片是里面的一个
  // ppt/slides/slideN.xml 文件，文字包在 <a:t>...</a:t> 标签里。
  //
  // ZIP 本身的读取（中央目录解析 + 单个文件解压）跟 docxText.js 是完全一样的一套逻辑，
  // 已经拆到 zipReader.js 里共用；这个文件只管"pptx 特有"的部分：按 ppt/slides/slideN.xml
  // 的命名规律找出所有幻灯片、按页码排序、从每页的 XML 里挑出 <a:t> 文字。

  const { listZipEntries, readLocalFileData, defaultInflate, decodeXmlEntities } = require("./zipReader.js");

  /**
   * 从一页幻灯片的 XML 里提取文字，按段落（<a:p>）分行——同一段落里的多个 <a:t> 文字
   * 直接拼接（它们是同一行文字被拆成的多个"运行片段"，中间不该有空格），不同段落换行。
   */
  function extractSlideText(xml) {
    const paragraphs = xml.match(/<a:p[ >][\s\S]*?<\/a:p>/g) || [];
    const source = paragraphs.length > 0 ? paragraphs : [xml];
    const lines = source
      .map((block) => {
        const runs = block.match(/<a:t>([\s\S]*?)<\/a:t>/g) || [];
        return runs
          .map((r) => decodeXmlEntities(r.slice("<a:t>".length, -"</a:t>".length)))
          .join("");
      })
      .filter((line) => line.trim() !== "");
    return lines.join("\n");
  }

  /**
   * 提取整个 .pptx 文件的文字内容，按页码顺序、每页前面标注"【第 N 页】"。
   * arrayBuffer：文件的 ArrayBuffer 或 Uint8Array。
   * inflateImpl：可选，测试环境注入用（浏览器不用传，用内置的 DecompressionStream）。
   */
  async function extractPptxText(arrayBuffer, { inflateImpl } = {}) {
    const inflate = inflateImpl || defaultInflate;
    const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    const entries = listZipEntries(bytes, "这个文件不是有效的 PPT (.pptx) 文件");
    const slideEntries = entries
      .map((e) => {
        const m = e.fileName.match(/^ppt\/slides\/slide(\d+)\.xml$/);
        return m ? { ...e, num: parseInt(m[1], 10) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.num - b.num);
    if (slideEntries.length === 0) {
      throw new Error("没有在这个文件里找到幻灯片内容，请确认上传的是 .pptx 文件");
    }
    const decoder = new TextDecoder("utf-8");
    const slideTexts = [];
    for (const entry of slideEntries) {
      const raw = readLocalFileData(bytes, entry, "PPT 文件内部结构异常，无法解析");
      let xmlBytes;
      if (entry.compressionMethod === 0) {
        xmlBytes = raw;
      } else if (entry.compressionMethod === 8) {
        xmlBytes = await inflate(raw);
      } else {
        continue; // 不支持的压缩方式（罕见），跳过这一页而不是整体失败
      }
      const text = extractSlideText(decoder.decode(xmlBytes));
      if (text) slideTexts.push({ num: entry.num, text });
    }
    return slideTexts.map((s) => `【第 ${s.num} 页】\n${s.text}`).join("\n\n");
  }

  return { extractPptxText, extractSlideText, decodeXmlEntities, listZipEntries };
});
