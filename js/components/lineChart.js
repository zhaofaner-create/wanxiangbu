(function (global, factory) {
  "use strict";
  var isNode = typeof module === "object" && module.exports;
  var req = isNode ? require : global.__fanerRequire;
  var result = factory(req);
  if (isNode) {
    module.exports = result;
  } else {
    global.FanerApp = global.FanerApp || {};
    global.FanerApp.lineChart = result;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  // 手绘 SVG 折线图组件：用户反馈"有些统计用折线图更直观"，把原来几个按天/按月
  // 展示"趋势"的手绘柱状图换成折线图（排行榜类的横向条形图不属于趋势展示，维持
  // 柱状/条形不变）。这里只用纯 SVG 字符串拼出来，不引入任何图表库，插入方式跟
  // 项目里已有的内联 SVG 图标（main.js 的 navIconSvg）一样，用 h(..., {html: svg})
  // 挂进 DOM，不走 h('svg', ...)（document.createElement 建不出真正的 SVG 元素，
  // 必须整段字符串塞进 innerHTML 或用 createElementNS，这里选前者，和现有代码风格一致）。

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  /**
   * 纯函数，方便单测：把一串数值换算成 SVG 坐标点。maxValueOverride 用于多条线
   * 共用同一把"最大值尺子"（比如收支图表的收入线和支出线要在同一个坐标系里比较）。
   */
  function computeLineChartPoints(values, options = {}) {
    const width = options.width || 280;
    const height = options.height || 120;
    const padX = options.padX != null ? options.padX : 14;
    const padY = options.padY != null ? options.padY : 18;
    const n = values.length;
    if (n === 0) return { points: [], maxValue: 0 };

    const maxValue = options.maxValueOverride != null ? Math.max(1, options.maxValueOverride) : Math.max(1, ...values);
    const innerWidth = Math.max(0, width - padX * 2);
    const innerHeight = Math.max(0, height - padY * 2);
    const stepX = n > 1 ? innerWidth / (n - 1) : 0;

    const points = values.map((v, i) => {
      const x = padX + stepX * i;
      const ratio = maxValue > 0 ? Math.max(0, v) / maxValue : 0;
      const y = padY + innerHeight * (1 - ratio);
      return { x: round2(x), y: round2(y) };
    });
    return { points, maxValue };
  }

  function escapeXml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
  }

  /**
   * seriesList: [{ values:[...], color:"#xxx", formatValue:(v)=>string, showValues:true }]
   * 多条 series 共用同一把最大值尺子，保证收入线/支出线这种对比场景不会各画各的比例。
   */
  function renderLineChartSvg(seriesList, options = {}) {
    const width = options.width || 320;
    const height = options.height || 140;
    const padX = options.padX != null ? options.padX : 16;
    const padY = options.padY != null ? options.padY : 22;
    const todayIndex = options.todayIndex;

    const allValues = seriesList.flatMap((s) => s.values);
    const sharedMax = Math.max(1, ...(allValues.length ? allValues : [0]));
    const baselineY = round2(padY + (height - padY * 2));

    const seriesSvgParts = seriesList.map((s) => {
      const { points } = computeLineChartPoints(s.values, { width, height, padX, padY, maxValueOverride: sharedMax });
      const color = s.color || "hsl(226, 72%, 60%)";
      const pointsAttr = points.map((p) => `${p.x},${p.y}`).join(" ");

      let areaPath = "";
      if (seriesList.length === 1 && points.length > 0) {
        const first = points[0];
        const last = points[points.length - 1];
        areaPath = `<path d="M${first.x},${baselineY} ${points.map((p) => `L${p.x},${p.y}`).join(" ")} L${last.x},${baselineY} Z" fill="${color}" opacity="0.12"/>`;
      }

      const dots = points
        .map((p, i) => {
          const isToday = todayIndex != null && i === todayIndex;
          const r = isToday ? 4.2 : 3;
          const dot = `<circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${isToday ? color : "var(--surface, #fff)"}" stroke="${color}" stroke-width="2"/>`;
          if (!s.showValues) return dot;
          const label = s.formatValue ? s.formatValue(s.values[i]) : String(s.values[i]);
          const labelY = Math.max(10, p.y - 8);
          return `${dot}<text x="${p.x}" y="${labelY}" text-anchor="middle" font-size="9.5" fill="${color}">${escapeXml(label)}</text>`;
        })
        .join("");

      return `${areaPath}<polyline points="${pointsAttr}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>${dots}`;
    });

    return (
      `<svg viewBox="0 0 ${width} ${height}" class="line-chart-svg" preserveAspectRatio="none" role="img" aria-hidden="true">` +
      `<line x1="${padX}" y1="${baselineY}" x2="${width - padX}" y2="${baselineY}" stroke="var(--border, #e2e2e2)" stroke-width="1"/>` +
      seriesSvgParts.join("") +
      `</svg>`
    );
  }

  return { computeLineChartPoints, renderLineChartSvg };
});
