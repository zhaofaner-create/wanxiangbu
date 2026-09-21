(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var result = factory();
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.zipReader = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // 最小够用的只读 ZIP 解析器，原本是给 pptxText.js 一个人用的（.pptx 本质是 ZIP 包），
  // 现在 docxText.js（.docx 同样是 ZIP 包）也要用到同一套逻辑，所以拆成这个共享模块，
  // 两边都从这里 require，而不是各自维护一份几乎一样的代码。跟这个 app 一贯的做法一致，
  // 不依赖任何第三方库；解压用浏览器原生的 DecompressionStream("deflate-raw")
  // （ZIP 里最常见的压缩方式 method 8 就是不带 zlib 头的原始 deflate）。

  const EOCD_SIG = 0x06054b50;
  const CD_SIG = 0x02014b50;
  const LOCAL_SIG = 0x04034b50;

  /** 解析 ZIP 中央目录，返回 [{fileName, compressionMethod, compressedSize, localHeaderOffset}]。
   * notAZipMessage：文件根本不是合法 ZIP 时抛出的错误文案，各调用方按自己的文件类型定制
   * （"不是有效的 PPT 文件" / "不是有效的 Word 文档"），不写死在这个共享模块里。 */
  function listZipEntries(bytes, notAZipMessage) {
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
      throw new Error(notAZipMessage || "这不是一个有效的压缩文件");
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
  function readLocalFileData(bytes, entry, badStructureMessage) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const off = entry.localHeaderOffset;
    if (view.getUint32(off, true) !== LOCAL_SIG) {
      throw new Error(badStructureMessage || "文件内部结构异常，无法解析");
    }
    const fileNameLength = view.getUint16(off + 26, true);
    const extraFieldLength = view.getUint16(off + 28, true);
    const dataStart = off + 30 + fileNameLength + extraFieldLength;
    return bytes.subarray(dataStart, dataStart + entry.compressedSize);
  }

  async function defaultInflate(compressedBytes) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("当前浏览器不支持解压缩，无法解析这个文件");
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
   * 取出 ZIP 包里某一项文件的内容，解压好、按 UTF-8 解码成字符串——pptxText.js 按页处理
   * 幻灯片、docxText.js 只需要单独这一个 word/document.xml，所以两边都用得上这同一个
   * "拿出一项、解压、解码"的封装。找不到这一项时返回 null，交给调用方决定怎么处理
   * （通常是"这个文件里没有 xxx，可能不是有效的文档"）。
   */
  async function readZipEntryText(bytes, entries, fileName, { inflateImpl } = {}) {
    const entry = entries.find((e) => e.fileName === fileName);
    if (!entry) return null;
    const inflate = inflateImpl || defaultInflate;
    const raw = readLocalFileData(bytes, entry);
    let xmlBytes;
    if (entry.compressionMethod === 0) {
      xmlBytes = raw;
    } else if (entry.compressionMethod === 8) {
      xmlBytes = await inflate(raw);
    } else {
      return null; // 不支持的压缩方式（罕见）
    }
    return new TextDecoder("utf-8").decode(xmlBytes);
  }

  return { listZipEntries, readLocalFileData, defaultInflate, decodeXmlEntities, readZipEntryText };
});
