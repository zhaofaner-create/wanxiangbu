(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var result = factory();
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.textMatch = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // 给"演讲提词"模块用的纯文本相似度匹配——判断"麦克风刚听到的这段话，大概讲到
  // 演讲稿/提示词列表里的第几条了"。这里刻意不追求精确的语音语义理解（那需要联网
  // 接大模型，这个 App 的原则是能离线/免费做的绝不额外花钱联网），用的是一种很朴素
  // 但对中文口语场景足够管用的"字符级重叠度"算法：把两段文字都当成"字符出现次数
  // 的多重集合"，看候选句子里的字有多少比例在刚才说的话里也出现过——不要求语序
  // 完全一致（说话难免语序、用词跟稿子有出入，或者夹了几个语气词/口误），只要覆盖了
  // 候选句子足够多的字就算"大概讲过了"。

  /** 去掉标点、空白、大小写差异，只留下真正的文字内容用来比较。 */
  function normalizeForMatch(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[\s，。！？、；：""''「」『』（）()\-—·,.!?;:'"…　]/g, "")
      .trim();
  }

  /** candidate 里的字有多少比例（0~1）在 spoken 里也出现过（按字符计数，不看顺序）。 */
  function charOverlapRatio(spokenNormalized, candidateNormalized) {
    if (!candidateNormalized || !spokenNormalized) return 0;
    const counts = {};
    for (const ch of spokenNormalized) counts[ch] = (counts[ch] || 0) + 1;
    let overlap = 0;
    for (const ch of candidateNormalized) {
      if (counts[ch] > 0) {
        overlap += 1;
        counts[ch] -= 1;
      }
    }
    return overlap / candidateNormalized.length;
  }

  /**
   * 两段已经 normalize 过的文字之间的"匹配分数"（0~1）。
   * - 候选句子很短（≤2个字，常见于"提示词模式"里的短提要）时，字符重叠这种算法
   *   几乎逮到哪个字都能凑够比例、太容易误判，所以短句子只认"完整出现在刚才说的
   *   话里"这一种更严格的判定方式。
   * - 提示词模式下，如果候选提示词整个作为子串出现在刚才说的话里（比如提示词是
   *   "预算"，你确实说到了"这部分我们再谈谈预算"），直接给满分——提示词本来就是
   *   关键字，不要求前后语境也对得上。
   * - 其它情况统一用字符重叠度。
   */
  function candidateMatchRatio(spokenNormalized, candidateNormalized, mode) {
    if (!candidateNormalized || !spokenNormalized) return 0;
    if (candidateNormalized.length <= 2) {
      return spokenNormalized.includes(candidateNormalized) ? 1 : 0;
    }
    if (mode === "prompts" && spokenNormalized.includes(candidateNormalized)) return 1;
    return charOverlapRatio(spokenNormalized, candidateNormalized);
  }

  // 完整稿模式要求更高的覆盖度才认定"这句真的讲过了"（毕竟稿子上的话大概率会被
  // 照着念出来，识别质量正常的话应该能对上大部分字）；提示词模式门槛低一些——
  // 提示词本来就不是会被逐字念出来的内容，能命中关键字就已经算不错的信号了。
  const DEFAULT_THRESHOLDS = { script: 0.6, prompts: 0.45 };

  /**
   * 在"当前这句"到"当前这句往后数 lookahead 句"的窗口里，找出刚才那段话最可能已经
   * 讲到了哪一句——如果窗口里有好几句都过了门槛，优先选最靠后的那句（允许一次跳过
   * 好几句，比如你临场跳着讲、或者中间有几句没被识别到）。找不到任何一句达到门槛
   * 就返回 null（调用方应该按"没有把握，不要瞎跳"处理——自动模式下就先不动，
   * 手动模式下就退回最简单的"+1"）。
   *
   * options:
   *   recentText: 最近识别到的一段话（原始文字，未 normalize）
   *   sentences: 完整的句子/提示词列表（字符串数组）
   *   currentIndex: 当前停在第几句（下标）
   *   mode: "script" | "prompts"，决定用哪套门槛和短句判定规则
   *   lookahead: 往后最多看几句，默认2（对应产品设计里"上下各留两句做容错"）
   *   threshold: 覆盖率门槛，不传则按 mode 用默认值
   */
  function findBestMatchIndex({ recentText, sentences, currentIndex, mode = "script", lookahead = 2, threshold } = {}) {
    if (!Array.isArray(sentences) || sentences.length === 0) return null;
    if (typeof currentIndex !== "number" || currentIndex < 0 || currentIndex >= sentences.length) return null;
    const spokenNormalized = normalizeForMatch(recentText);
    if (!spokenNormalized) return null;
    const th = typeof threshold === "number" ? threshold : DEFAULT_THRESHOLDS[mode] || DEFAULT_THRESHOLDS.script;
    const maxIndex = Math.min(sentences.length - 1, currentIndex + lookahead);
    for (let i = maxIndex; i >= currentIndex; i -= 1) {
      const candidateNormalized = normalizeForMatch(sentences[i]);
      if (!candidateNormalized) continue;
      const ratio = candidateMatchRatio(spokenNormalized, candidateNormalized, mode);
      if (ratio >= th) return i;
    }
    return null;
  }

  /**
   * 把"当前句 + 前后各 radius 句"取出来，标好每一条相对当前句的位置，方便界面渲染
   * 大字当前句、上下小字灰色预览。超出列表范围的位置直接跳过，不会出现空洞。
   * 返回 [{ index, text, offset }]，offset 是相对 currentIndex 的偏移（0=当前句）。
   */
  function buildPreviewWindow(sentences, currentIndex, radius = 2) {
    if (!Array.isArray(sentences) || sentences.length === 0) return [];
    const clamped = Math.max(0, Math.min(currentIndex, sentences.length - 1));
    const out = [];
    for (let offset = -radius; offset <= radius; offset += 1) {
      const index = clamped + offset;
      if (index < 0 || index >= sentences.length) continue;
      out.push({ index, text: sentences[index], offset });
    }
    return out;
  }

  return { normalizeForMatch, charOverlapRatio, candidateMatchRatio, findBestMatchIndex, buildPreviewWindow, DEFAULT_THRESHOLDS };
});
