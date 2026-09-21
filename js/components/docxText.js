(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.docxText = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function (require) {
  "use strict";

  // 从 .docx 文件里提取正文文字，用法跟 pptxText.js 是同一个思路：.docx 本质也是一个
  // ZIP 压缩包（ZIP 读取/解压复用 zipReader.js），但跟 pptx 按页拆成多个 slideN.xml 不同，
  // .docx 的正文全部在一个 word/document.xml 文件里，文字包在 <w:t>...</w:t> 标签里，
  // 按段落（<w:p>）分行。

  const { listZipEntries, readZipEntryText, decodeXmlEntities } = require("./zipReader.js");

  /**
   * 从 document.xml 里提取正文文字，按段落（<w:p>）分行——Word 经常把同一句话拆成好几个
   * <w:r> 运行片段（拼写检查、修订标记等原因），同一段落里的多个 <w:t> 直接拼接、中间不
   * 加空格；段内的 <w:tab/> 转成制表符、<w:br/> 转成换行，不同段落之间再另起一行。
   */
  function extractDocumentText(xml) {
    const paragraphs = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
    const source = paragraphs.length > 0 ? paragraphs : [xml];
    const lines = source
      .map((block) => {
        // 统一按 <w:t>/<w:tab/>/<w:br/> 在段落里原本出现的先后顺序取出再拼接，不能分开
        // 三种标签各自 match 再 join，那样会打乱它们的相对顺序（比如"姓名[tab]张三"）。
        const tokens = block.match(/<w:t[ >][\s\S]*?<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g) || [];
        return tokens
          .map((token) => {
            if (token.startsWith("<w:tab")) return "\t";
            if (token.startsWith("<w:br")) return "\n";
            const inner = token.replace(/^<w:t[^>]*>/, "").replace(/<\/w:t>$/, "");
            return decodeXmlEntities(inner);
          })
          .join("");
      })
      .filter((line) => line.trim() !== "");
    return lines.join("\n");
  }

  /**
   * 提取整个 .docx 文件的正文文字。
   * arrayBuffer：文件的 ArrayBuffer 或 Uint8Array。
   * inflateImpl：可选，测试环境注入用（浏览器不用传，用内置的 DecompressionStream）。
   */
  async function extractDocxText(arrayBuffer, { inflateImpl } = {}) {
    const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    const entries = listZipEntries(bytes, "这个文件不是有效的 Word (.docx) 文档");
    const xml = await readZipEntryText(bytes, entries, "word/document.xml", { inflateImpl });
    if (!xml) {
      throw new Error("没有在这个文件里找到正文内容，请确认上传的是 .docx 文件");
    }
    const text = extractDocumentText(xml);
    if (!text) {
      throw new Error("没有从这个文档里提取到文字内容");
    }
    return text;
  }

  return { extractDocxText, extractDocumentText };
});
