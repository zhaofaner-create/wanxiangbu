const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { extractPptxText, extractSlideText, decodeXmlEntities, listZipEntries } = require("../js/components/pptxText.js");

// ---------- 测试专用：手搓一个最小够用的 ZIP 写入器 ----------
// pptxText.js 本身只读不写（.pptx 文件不需要我们自己生成），这里为了造测试用的假 .pptx
// 文件，手写一个简化版 ZIP 打包器（跟 pptxText.js 里的 listZipEntries/readLocalFileData
// 是同一套格式的另一半）。不校验 CRC-32（写 0），pptxText.js 的读取逻辑本来就不检查它。

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
      u16(20), // version needed
      u16(0), // flags
      u16(f.method),
      u16(0), u16(0), // time/date
      u32(0), // crc32（不校验）
      u32(f.data.length), // compressed size
      u32(f.uncompressedSize != null ? f.uncompressedSize : f.data.length),
      u16(nameBuf.length),
      u16(0), // extra length
      nameBuf,
    ]);
    localParts.push(localHeader, f.data);

    const centralHeader = Buffer.concat([
      u32(0x02014b50),
      u16(20), u16(20), // version made by / needed
      u16(0), // flags
      u16(f.method),
      u16(0), u16(0), // time/date
      u32(0), // crc32
      u32(f.data.length),
      u32(f.uncompressedSize != null ? f.uncompressedSize : f.data.length),
      u16(nameBuf.length),
      u16(0), u16(0), // extra/comment length
      u16(0), // disk number start
      u16(0), // internal attrs
      u32(0), // external attrs
      u32(offset), // local header offset
      nameBuf,
    ]);
    centralParts.push(centralHeader);
    offset += localHeader.length + f.data.length;
  });

  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0), u16(0), // disk numbers
    u16(files.length), u16(files.length),
    u32(centralBuf.length),
    u32(localBuf.length), // central directory offset
    u16(0), // comment length
  ]);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

function slideXml(paragraphs) {
  const body = paragraphs
    .map((runs) => {
      const runXml = runs.map((t) => `<a:r><a:t>${t}</a:t></a:r>`).join("");
      return `<a:p>${runXml}</a:p>`;
    })
    .join("");
  return `<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
}

async function nodeInflate(compressed) {
  return zlib.inflateRawSync(compressed);
}

// ---------- decodeXmlEntities ----------

describe("decodeXmlEntities", () => {
  test("解码常见的 XML 转义字符", () => {
    assert.equal(decodeXmlEntities("&lt;b&gt;&amp;&quot;&apos;"), "<b>&\"'");
  });

  test("数字字符引用（十进制和十六进制）", () => {
    assert.equal(decodeXmlEntities("&#20320;&#x597D;"), "你好");
  });

  test("双重转义的 &amp;lt; 只解一层，不会变成 <", () => {
    assert.equal(decodeXmlEntities("&amp;lt;"), "&lt;");
  });
});

// ---------- extractSlideText ----------

describe("extractSlideText", () => {
  test("同一段落里多个 run 直接拼接，不加空格", () => {
    const xml = slideXml([["Bonjour ", "à tous"]]);
    assert.equal(extractSlideText(xml), "Bonjour à tous");
  });

  test("不同段落换行分隔", () => {
    const xml = slideXml([["标题"], ["正文第一行"], ["正文第二行"]]);
    assert.equal(extractSlideText(xml), "标题\n正文第一行\n正文第二行");
  });

  test("空段落（没有文字 run）被过滤掉，不产生空行", () => {
    const xml = slideXml([["有内容"], [], ["还有内容"]]);
    assert.equal(extractSlideText(xml), "有内容\n还有内容");
  });

  test("文字里的 XML 转义字符会被解码", () => {
    const xml = slideXml([["A &amp; B &lt; C"]]);
    assert.equal(extractSlideText(xml), "A & B < C");
  });
});

// ---------- listZipEntries / extractPptxText ----------

describe("listZipEntries", () => {
  test("能解析出存进去的所有文件名和压缩方式", () => {
    const zip = buildZip([
      { name: "ppt/slides/slide1.xml", data: Buffer.from("hello"), method: 0 },
      { name: "[Content_Types].xml", data: Buffer.from("ct"), method: 0 },
    ]);
    const entries = listZipEntries(new Uint8Array(zip));
    assert.equal(entries.length, 2);
    assert.ok(entries.some((e) => e.fileName === "ppt/slides/slide1.xml" && e.compressionMethod === 0));
  });

  test("不是有效 ZIP 文件时抛错", () => {
    assert.throws(() => listZipEntries(new Uint8Array([1, 2, 3, 4])));
  });
});

describe("extractPptxText", () => {
  test("stored（不压缩）方式：按页码顺序拼出每页文字", async () => {
    const zip = buildZip([
      { name: "ppt/slides/slide2.xml", data: Buffer.from(slideXml([["第二页"]]), "utf-8"), method: 0 },
      { name: "ppt/slides/slide1.xml", data: Buffer.from(slideXml([["第一页"]]), "utf-8"), method: 0 },
      { name: "ppt/presentation.xml", data: Buffer.from("<p/>"), method: 0 }, // 非幻灯片文件，应该被忽略
    ]);
    const text = await extractPptxText(new Uint8Array(zip).buffer);
    const firstIdx = text.indexOf("第一页");
    const secondIdx = text.indexOf("第二页");
    assert.ok(firstIdx >= 0 && secondIdx >= 0);
    assert.ok(firstIdx < secondIdx, "应该按页码数字顺序排列，不是字符串顺序");
    assert.match(text, /【第 1 页】/);
    assert.match(text, /【第 2 页】/);
  });

  test("deflate（method 8）压缩方式：借助注入的 inflateImpl 正常解出文字", async () => {
    const raw = Buffer.from(slideXml([["压缩过的内容"]]), "utf-8");
    const compressed = zlib.deflateRawSync(raw);
    const zip = buildZip([
      { name: "ppt/slides/slide1.xml", data: compressed, method: 8, uncompressedSize: raw.length },
    ]);
    const text = await extractPptxText(new Uint8Array(zip).buffer, { inflateImpl: nodeInflate });
    assert.match(text, /压缩过的内容/);
  });

  test("页码是两位数以上时，按数字大小排序而不是字符串排序（slide10 排在 slide2 后面）", async () => {
    const zip = buildZip([
      { name: "ppt/slides/slide10.xml", data: Buffer.from(slideXml([["第十页"]]), "utf-8"), method: 0 },
      { name: "ppt/slides/slide2.xml", data: Buffer.from(slideXml([["第二页"]]), "utf-8"), method: 0 },
    ]);
    const text = await extractPptxText(new Uint8Array(zip).buffer);
    assert.ok(text.indexOf("第二页") < text.indexOf("第十页"));
  });

  test("没有任何幻灯片文件时抛错，提示不是有效的 pptx", async () => {
    const zip = buildZip([{ name: "[Content_Types].xml", data: Buffer.from("ct"), method: 0 }]);
    await assert.rejects(() => extractPptxText(new Uint8Array(zip).buffer));
  });

  test("接受 Uint8Array 或 ArrayBuffer 两种入参形式", async () => {
    const zip = buildZip([{ name: "ppt/slides/slide1.xml", data: Buffer.from(slideXml([["内容"]]), "utf-8"), method: 0 }]);
    const bytes = new Uint8Array(zip);
    const textFromBytes = await extractPptxText(bytes);
    const textFromBuffer = await extractPptxText(bytes.buffer);
    assert.equal(textFromBytes, textFromBuffer);
  });
});
