(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var result = factory();
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.pptxText = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // 从 .pptx 文件里提取幻灯片文字，不依赖任何第三方库（跟这个 app "纯 vanilla JS、不搭
  // 构建流程"的一贯做法一致）。.pptx 本质是一个 ZIP 压缩包，每页幻灯片是里面的一个
  // ppt/slides/slideN.xml 文件，文字包在 <a:t>...</a:t> 标签里。
  //
  // 这里自己写了一个最小够用的 ZIP 中央目录解析器（只读，不需要支持写入/加密/分卷这些），
  // 加上浏览器原生的 DecompressionStream("deflate-raw") 做解压——ZIP 里最常见的压缩方式
  // (method 8) 就是不带 zlib 头的原始 deflate，跟 DecompressionStream 的 "deflate-raw"
  // 完全对得上。inflateImpl 是测试用的注入点：Node 测试环境没有 DecompressionStream，
  // 传一个包了 zlib.inflateRawSync 的函数进来就行。

  const EOCD_SIG = 0x06054b50;
  const CD_SIG = 0x02014b50;
  const LOCAL_SIG = 0x04034b50;

  /** 解析 ZIP 中央目录，返回 [{fileName, compressionMethod, compressedSize, localHeaderOffset}]。 */
  function listZipEntries(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const maxBack = Math.min(bytes.length, 65557); // 22 字节的 EOCD 定长部分 + 最多 65535 字节的注释
    let eocdOffset = -1;
    for (let i = bytes.length - 22; i >= bytes.length - maxBack && i >= 0; i--) {
      if (view.getUint32(i, true) === EOCD_SIG) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset < 0) {
      throw new Error("这个文件不是有效的 PPT (.pptx) 文件");
    }
    const cdOffset = view.getUint32(eocdOffset + 16, true);
    const cdCount = view.getUint16(eocdOffset + 10, true);
    const decoder = new TextDecoder("utf-8");
    const entries = [];
    let offset = cdOffset;
    for (let i = 0; i < cdCount; i++) {
      if (view.getUint32(offset, true) !== CD_SIG) break;
      const compressionMethod = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const fileNameLength = view.getUint16(offset + 28, true);
      const extraFieldLength = view.getUint16(offset + 30, true);
      const fileCommentLength = view.getUint16(offset + 32, true);
      const localHeaderOffset = view.getUint32(offset + 42, true);
      const nameBytes = bytes.subarray(offset + 46, offset + 46 + fileNameLength);
      entries.push({
        fileName: decoder.decode(nameBytes),
        compressionMethod,
        compressedSize,
        localHeaderOffset,
      });
      offset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
    }
    return entries;
  }

  /** 按中央目录记录的 localHeaderOffset/compressedSize，从本地文件头后面取出这一项的原始（未解压）数据。 */
  function readLocalFileData(bytes, entry) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const off = entry.localHeaderOffset;
    if (view.getUint32(off, true) !== LOCAL_SIG) {
      throw new Error("PPT 文件内部结构异常，无法解析");
    }
    const fileNameLength = view.getUint16(off + 26, true);
    const extraFieldLength = view.getUint16(off + 28, true);
    const dataStart = off + 30 + fileNameLength + extraFieldLength;
    return bytes.subarray(dataStart, dataStart + entry.compressedSize);
  }

  async function defaultInflate(compressedBytes) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("当前浏览器不支持解压缩，无法解析 PPT 文件");
    }
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    writer.write(compressedBytes);
    writer.close();
    const chunks = [];
    const reader = ds.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }

  /** &amp; 放最后处理，避免把 "&amp;lt;" 这种双重转义的文本再错误地二次解码成 "<"。 */
  function decodeXmlEntities(text) {
    return text
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
      .replace(/&amp;/g, "&");
  }

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
    const entries = listZipEntries(bytes);
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
      const raw = readLocalFileData(bytes, entry);
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
