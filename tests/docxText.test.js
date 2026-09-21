const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { extractDocxText, extractDocumentText } = require("../js/components/docxText.js");

// ---------- 测试专用：手搓一个最小够用的 ZIP 写入器 ----------
// 跟 tests/pptxText.test.js 里的是同一套写法（docxText.js 和 pptxText.js 现在共用
// zipReader.js 同一套读取逻辑），这里为了造测试用的假 .docx 文件重复一份，不额外抽取
// 公共测试工具模块——两边各自独立、互不影响。

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

/** files: [{ name, data: Buffer, method: 0|8 }]（method 8 时 data 必须已经是 deflateRawSync 压缩过的） */
function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  files.forEach((f) => {
    const nameBuf = Buffer.from(f.name, "utf-8");
    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(f.method),
      u16(0), u16(0),
      u32(0),
      u32(f.data.length),
      u32(f.uncompressedSize != null ? f.uncompressedSize : f.data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
    ]);
    localParts.push(localHeader, f.data);

    const centralHeader = Buffer.concat([
      u32(0x02014b50),
      u16(20), u16(20),
      u16(0),
      u16(f.method),
      u16(0), u16(0),
      u32(0),
      u32(f.data.length),
      u32(f.uncompressedSize != null ? f.uncompressedSize : f.data.length),
      u16(nameBuf.length),
      u16(0), u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuf,
    ]);
    centralParts.push(centralHeader);
    offset += localHeader.length + f.data.length;
  });

  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0), u16(0),
    u16(files.length), u16(files.length),
    u32(centralBuf.length),
    u32(localBuf.length),
    u16(0),
  ]);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

/** paragraphs: [ [runText, ...] | {tab:true} | {br:true} ...] —— 简化写法，一个段落是一串
 * "run 文字" 或者特殊 token（制表符/换行）。 */
function documentXml(paragraphs) {
  const body = paragraphs
    .map((tokens) => {
      const inner = tokens
        .map((t) => {
          if (t === "\t") return `<w:r><w:tab/></w:r>`;
          if (t === "\n") return `<w:r><w:br/></w:r>`;
          return `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
        })
        .join("");
      return `<w:p>${inner}</w:p>`;
    })
    .join("");
  return `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`;
}

async function nodeInflate(compressed) {
  return zlib.inflateRawSync(compressed);
}

// ---------- extractDocumentText ----------

describe("extractDocumentText", () => {
  test("同一段落里多个 run 直接拼接，不加空格", () => {
    const xml = documentXml([["Bonjour ", "à tous"]]);
    assert.equal(extractDocumentText(xml), "Bonjour à tous");
  });

  test("不同段落换行分隔", () => {
    const xml = documentXml([["标题"], ["正文第一行"], ["正文第二行"]]);
    assert.equal(extractDocumentText(xml), "标题\n正文第一行\n正文第二行");
  });

  test("空段落（没有文字 run）被过滤掉，不产生空行", () => {
    const xml = documentXml([["有内容"], [], ["还有内容"]]);
    assert.equal(extractDocumentText(xml), "有内容\n还有内容");
  });

  test("段落内的制表符/换行符会按原本位置转换出来", () => {
    const xml = documentXml([["姓名", "\t", "张三"]]);
    assert.equal(extractDocumentText(xml), "姓名\t张三");
  });

  test("文字里的 XML 转义字符会被解码", () => {
    const xml = documentXml([["A &amp; B &lt; C"]]);
    assert.equal(extractDocumentText(xml), "A & B < C");
  });
});

// ---------- extractDocxText ----------

describe("extractDocxText", () => {
  test("stored（不压缩）方式：从 word/document.xml 里提取正文", async () => {
    const zip = buildZip([
      { name: "word/document.xml", data: Buffer.from(documentXml([["第一段"], ["第二段"]]), "utf-8"), method: 0 },
      { name: "[Content_Types].xml", data: Buffer.from("ct"), method: 0 }, // 非正文文件，应该被忽略
    ]);
    const text = await extractDocxText(new Uint8Array(zip).buffer);
    assert.equal(text, "第一段\n第二段");
  });

  test("deflate（method 8）压缩方式：借助注入的 inflateImpl 正常解出文字", async () => {
    const raw = Buffer.from(documentXml([["压缩过的内容"]]), "utf-8");
    const compressed = zlib.deflateRawSync(raw);
    const zip = buildZip([
      { name: "word/document.xml", data: compressed, method: 8, uncompressedSize: raw.length },
    ]);
    const text = await extractDocxText(new Uint8Array(zip).buffer, { inflateImpl: nodeInflate });
    assert.equal(text, "压缩过的内容");
  });

  test("没有 word/document.xml 时抛错，提示不是有效的 docx", async () => {
    const zip = buildZip([{ name: "[Content_Types].xml", data: Buffer.from("ct"), method: 0 }]);
    await assert.rejects(() => extractDocxText(new Uint8Array(zip).buffer));
  });

  test("不是有效 ZIP 文件时抛错", async () => {
    await assert.rejects(() => extractDocxText(new Uint8Array([1, 2, 3, 4]).buffer));
  });

  test("接受 Uint8Array 或 ArrayBuffer 两种入参形式", async () => {
    const zip = buildZip([{ name: "word/document.xml", data: Buffer.from(documentXml([["内容"]]), "utf-8"), method: 0 }]);
    const bytes = new Uint8Array(zip);
    const textFromBytes = await extractDocxText(bytes);
    const textFromBuffer = await extractDocxText(bytes.buffer);
    assert.equal(textFromBytes, textFromBuffer);
  });
});
