(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var result = factory();
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.mindMap = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // 思维导图：把 aiClient.js 的 parseMindMapResponse 解析出来的 {title, children:[...]}
  // 嵌套树，画成一张图形化的节点连线图。拆成两步、两个函数：
  // 1) computeMindMapLayout —— 纯函数，只算每个节点该摆在哪个坐标，不碰 DOM，方便单测；
  // 2) renderMindMapSvg —— 拿布局结果去建真正的 SVG 元素，这部分要有真实 DOM/SVG 环境
  //    才能跑，跟这个项目里其它纯 DOM 封装（audioStore.js 的 IndexedDB、markdown.js 的
  //    渲染部分）一样不写单测，靠 Playwright 端到端测试在真实浏览器里验证。

  /**
   * 计算树形布局：从上到下按层级摆放（第0层是根节点），同一层的节点在水平方向从左到右
   * 挨个排开；没有子节点的叶子节点各占一个"格子"，有子节点的节点摆在自己所有子节点的
   * 正中间——这是最经典的"倒着的家谱图"布局算法的简化版，不需要处理子树重叠（思维导图
   * 场景下节点数量有限，笔记正文生成的树深度也限制在4层以内，简化版足够用）。
   */
  function computeMindMapLayout(tree, opts = {}) {
    const nodeWidth = opts.nodeWidth || 160;
    const nodeHeight = opts.nodeHeight || 52;
    const hGap = opts.hGap != null ? opts.hGap : 20;
    const vGap = opts.vGap != null ? opts.vGap : 60;

    if (!tree || typeof tree.title !== "string" || !tree.title.trim()) {
      return { nodes: [], edges: [], width: 0, height: 0, nodeWidth, nodeHeight };
    }

    const nodes = [];
    const edges = [];
    let idCounter = 0;
    let slotCounter = 0;

    function visit(node, depth, parentId) {
      const id = idCounter++;
      const children = Array.isArray(node.children) ? node.children : [];
      let x;
      if (children.length === 0) {
        x = slotCounter * (nodeWidth + hGap);
        slotCounter += 1;
      } else {
        const childXs = children.map((child) => visit(child, depth + 1, id));
        x = (Math.min(...childXs) + Math.max(...childXs)) / 2;
      }
      nodes.push({
        id,
        title: node.title,
        depth,
        x,
        y: depth * (nodeHeight + vGap),
        parentId: parentId === undefined ? null : parentId,
      });
      if (parentId !== undefined && parentId !== null) {
        edges.push({ from: parentId, to: id });
      }
      return x;
    }

    visit(tree, 0, null);

    const maxX = nodes.reduce((m, n) => Math.max(m, n.x), 0);
    const maxY = nodes.reduce((m, n) => Math.max(m, n.y), 0);
    return {
      nodes,
      edges,
      width: maxX + nodeWidth,
      height: maxY + nodeHeight,
      nodeWidth,
      nodeHeight,
    };
  }

  /** 把标题拆成最多 maxLines 行，每行最多 maxCharsPerLine 个字符（按 Unicode 码位数，
   * 不是字节数，中文一个字算一个），超出的部分在最后一行截断加省略号——SVG 的 <text>
   * 不会自动换行，需要自己拆成 <tspan> 一行行摆。纯函数，方便单测。 */
  function wrapTitleLines(title, maxCharsPerLine = 12, maxLines = 2) {
    const chars = Array.from(title || "");
    if (chars.length === 0) return [""];
    const lines = [];
    let i = 0;
    while (i < chars.length && lines.length < maxLines) {
      const isLastAllowedLine = lines.length === maxLines - 1;
      if (isLastAllowedLine && i + maxCharsPerLine < chars.length) {
        lines.push(chars.slice(i, i + maxCharsPerLine - 1).join("") + "…");
        i = chars.length;
      } else {
        lines.push(chars.slice(i, i + maxCharsPerLine).join(""));
        i += maxCharsPerLine;
      }
    }
    return lines;
  }

  const SVG_NS = "http://www.w3.org/2000/svg";

  function svgEl(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined) continue;
      el.setAttribute(key, value);
    }
    return el;
  }

  /** 把 {title, children} 树渲染成一个可以直接插入页面的 <svg> 元素。 */
  function renderMindMapSvg(tree, opts = {}) {
    const padding = opts.padding != null ? opts.padding : 24;
    const layout = computeMindMapLayout(tree, opts);
    const totalWidth = layout.width + padding * 2;
    const totalHeight = layout.height + padding * 2;
    const svg = svgEl("svg", {
      class: "mindmap-svg",
      viewBox: `0 0 ${Math.max(totalWidth, 1)} ${Math.max(totalHeight, 1)}`,
    });
    if (layout.nodes.length === 0) return svg;

    const nodeById = new Map(layout.nodes.map((n) => [n.id, n]));

    const edgesGroup = svgEl("g", { class: "mindmap-edges" });
    layout.edges.forEach((edge) => {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (!from || !to) return;
      const x1 = from.x + layout.nodeWidth / 2 + padding;
      const y1 = from.y + layout.nodeHeight + padding;
      const x2 = to.x + layout.nodeWidth / 2 + padding;
      const y2 = to.y + padding;
      const midY = (y1 + y2) / 2;
      edgesGroup.appendChild(
        svgEl("path", {
          class: "mindmap-edge",
          d: `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`,
          fill: "none",
        })
      );
    });

    const nodesGroup = svgEl("g", { class: "mindmap-nodes" });
    layout.nodes.forEach((n) => {
      const g = svgEl("g", {
        class: `mindmap-node mindmap-node-depth-${n.depth}`,
        transform: `translate(${n.x + padding}, ${n.y + padding})`,
      });
      g.appendChild(
        svgEl("rect", {
          class: "mindmap-node-rect",
          width: layout.nodeWidth,
          height: layout.nodeHeight,
          rx: 12,
          ry: 12,
        })
      );
      const lines = wrapTitleLines(n.title, n.depth === 0 ? 10 : 12, 2);
      const text = svgEl("text", {
        class: "mindmap-node-text",
        x: layout.nodeWidth / 2,
        y: layout.nodeHeight / 2,
        "text-anchor": "middle",
        "dominant-baseline": "middle",
      });
      lines.forEach((line, idx) => {
        const dy = idx === 0 ? (lines.length > 1 ? "-0.4em" : "0.3em") : "1.2em";
        const tspan = svgEl("tspan", { x: layout.nodeWidth / 2, dy });
        tspan.textContent = line;
        text.appendChild(tspan);
      });
      g.appendChild(text);
      nodesGroup.appendChild(g);
    });

    svg.appendChild(edgesGroup);
    svg.appendChild(nodesGroup);
    return svg;
  }

  return { computeMindMapLayout, wrapTitleLines, renderMindMapSvg };
});
