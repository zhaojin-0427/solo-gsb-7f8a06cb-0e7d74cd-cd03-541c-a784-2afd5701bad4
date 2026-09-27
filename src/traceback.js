'use strict';

/**
 * 成片选段回溯。
 *
 * 用户在结果页逐行输入**成片（拼接时间轴）**上的半开区间选段：
 *   起始毫秒 结束毫秒
 * （1～20 行；字段间用空白或逗号分隔，# 之后为注释，空行忽略；
 * 两端须为非负整数、起点严格小于终点，终点不得越过当前拼接时间轴的
 * 精确末端；解析错误指出行号。）
 *
 * 对每个选段，按现有剪辑段在拼接时间轴上的**精确拼接边界**（remap 的
 * timeline，半毫秒单位）逐个求半开交集，拆成成片子区间，再依各段倍速
 * 反算到源时间轴：
 *
 *   输出偏移（半毫秒）= 源偏移（毫秒）× k，k = 2 / 倍速
 *   故 源偏移（四分之一毫秒）= 输出偏移（半毫秒）× 4 / k
 *                            = 输出偏移（半毫秒）× 2 × 倍速
 *
 * 0.5 / 1 / 2 三档倍速下 2 × 倍速 ∈ {1, 2, 4}，全程整数运算：
 *   - 成片端点以半毫秒（0.5ms）为最小单位（选段输入为整数毫秒）；
 *   - 源端点保留到**四分之一毫秒（0.25ms）**，直接由精确拼接边界反算，
 *     **不从已四舍五入的输出字幕时间反推**；
 *   - 切点恰为选段端点时，与相邻段的交集为空（lo >= hi），不产生空行。
 *
 * 同一源段被多个剪辑段（含重复段）使用时，每次使用各自独立保留记录。
 *
 * 纯逻辑，Node/浏览器双端通用，不请求后端。
 */

const MAX_SELECTIONS = 20;

/**
 * 解析成片选段文本。每行一个半开区间：起始毫秒 结束毫秒。
 * 分隔符支持空白或逗号（可混用）；# 之后为注释，空行忽略。
 *
 * @returns {{ selections: Array<{start:number, end:number, line:number, raw:string}>,
 *             errors: Array<{line:number, message:string}> }}
 */
function parseSelections(input) {
  const errors = [];
  const selections = [];
  const rawLines = String(input ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  rawLines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) return;

    // 逗号/制表符/空白统一切分，过滤空字段
    const parts = line.split(/[\s,]+/).filter(Boolean);
    if (parts.length !== 2) {
      errors.push({
        line: lineNo,
        message: `第 ${lineNo} 行：应有 2 个字段（起始ms 结束ms），实际 ${parts.length} 个："${rawLine.trim()}"`,
      });
      return;
    }
    const [startRaw, endRaw] = parts;

    if (!/^-?\d+$/.test(startRaw)) {
      errors.push({ line: lineNo, message: `第 ${lineNo} 行：起始时间必须是整数毫秒，实际为 "${startRaw}"` });
      return;
    }
    if (!/^-?\d+$/.test(endRaw)) {
      errors.push({ line: lineNo, message: `第 ${lineNo} 行：结束时间必须是整数毫秒，实际为 "${endRaw}"` });
      return;
    }

    const start = Number(startRaw);
    const end = Number(endRaw);
    if (start < 0) {
      errors.push({ line: lineNo, message: `第 ${lineNo} 行：起始时间不能为负数（${start}）` });
      return;
    }
    if (end <= start) {
      errors.push({ line: lineNo, message: `第 ${lineNo} 行：结束时间（${end}）必须晚于起始时间（${start}）` });
      return;
    }

    selections.push({ start, end, line: lineNo, raw: rawLine.trim() });
  });

  if (errors.length === 0 && selections.length === 0) {
    errors.push({ line: 0, message: '至少需要一个成片选段（每行：起始ms 结束ms）' });
  }
  if (errors.length === 0 && selections.length > MAX_SELECTIONS) {
    errors.push({
      line: 0,
      message: `最多 ${MAX_SELECTIONS} 个成片选段，实际 ${selections.length} 个`,
    });
  }

  return { selections, errors };
}

/** 四分之一毫秒单位格式化为精确毫秒文本（仅保留必要的 .25 / .5 / .75 小数）。 */
function formatQuarterMs(quarter) {
  const q = Math.trunc(quarter);
  const whole = Math.floor(q / 4);
  switch (q % 4) {
    case 1: return `${whole}.25`;
    case 2: return `${whole}.5`;
    case 3: return `${whole}.75`;
    default: return String(whole);
  }
}

/**
 * 执行成片选段回溯。
 *
 * @param {Array} selections parseSelections 得到的选段（按输入顺序）
 * @param {Array} timeline remap 的剪辑段时间轴（按播放顺序，含
 *   order/line/sourceStart/sourceEnd/speed/outStartHalf/outEndHalf）
 * @returns {object}
 *   成功：{ ok:true, items:[...], selectionCount, totalEndHalf,
 *          totalEndMs, maxEndMs }
 *   失败：{ ok:false, code:'empty'|'bad-timeline'|'out-of-range',
 *          message, errors? }
 *
 * 每个 item：
 *   { selectionLine, selectionStart, selectionEnd, subIndex,
 *     segOrder, segLine, speed,
 *     outStartQ, outEndQ,       // 成片子区间（四分之一毫秒单位，精确到 0.5）
 *     srcStartQ, srcEndQ }      // 源区间（四分之一毫秒单位，精确到 0.25）
 */
function traceSelections(selections, timeline) {
  if (!Array.isArray(selections) || selections.length === 0) {
    return { ok: false, code: 'empty', message: '成片选段无效：至少需要一个合法选段。' };
  }
  if (!Array.isArray(timeline) || timeline.length === 0) {
    return { ok: false, code: 'bad-timeline', message: '剪辑段时间轴无效，无法进行选段回溯。' };
  }

  // 拼接时间轴精确末端（半毫秒单位）：直接取最后一段的精确输出终点，
  // 不使用四舍五入后的字幕/总时长。
  const totalEndHalf = timeline[timeline.length - 1].outEndHalf;
  const totalEndMs = totalEndHalf / 2;
  // 整数毫秒终点不得越过精确末端（精确末端为半毫秒时向下取整）
  const maxEndMs = Math.floor(totalEndHalf / 2);

  const rangeErrors = [];
  selections.forEach((sel) => {
    if (sel.end > maxEndMs) {
      rangeErrors.push({
        line: sel.line,
        message: `第 ${sel.line} 行：结束时间（${sel.end}）越过拼接时间轴精确末端（${totalEndMs} ms，整数终点上限 ${maxEndMs} ms）`,
      });
    }
  });
  if (rangeErrors.length > 0) {
    return {
      ok: false,
      code: 'out-of-range',
      message: '存在越过拼接时间轴精确末端的选段。',
      errors: rangeErrors,
      totalEndHalf,
      totalEndMs,
      maxEndMs,
    };
  }

  const items = [];
  selections.forEach((sel) => {
    // 选段端点为整数毫秒 → 半毫秒单位（×2）；剪辑段边界同样为半毫秒单位
    const selStartHalf = sel.start * 2;
    const selEndHalf = sel.end * 2;
    let subIndex = 0;

    timeline.forEach((tl) => {
      const loHalf = Math.max(selStartHalf, tl.outStartHalf);
      const hiHalf = Math.min(selEndHalf, tl.outEndHalf);
      if (loHalf >= hiHalf) return; // 半开区间：端点相接/不相交均不产生记录（无空行）
      subIndex += 1;

      // 成片端点：半毫秒（×2 转为四分之一毫秒单位）
      const outStartQ = loHalf * 2;
      const outEndQ = hiHalf * 2;
      // 源端点：源偏移（四分之一毫秒）= 输出偏移（半毫秒）× 2 × 倍速
      // 倍速 0.5 / 1 / 2 下系数 2 × 倍速 ∈ {1, 2, 4}，全程整数运算
      const factor = 2 * tl.speed;
      const srcStartQ = tl.sourceStart * 4 + (loHalf - tl.outStartHalf) * factor;
      const srcEndQ = tl.sourceStart * 4 + (hiHalf - tl.outStartHalf) * factor;

      items.push({
        selectionLine: sel.line,
        selectionStart: sel.start,
        selectionEnd: sel.end,
        subIndex,
        segOrder: tl.order,
        segLine: tl.line,
        speed: tl.speed,
        outStartQ,
        outEndQ,
        srcStartQ,
        srcEndQ,
      });
    });
  });

  return {
    ok: true,
    items,
    selectionCount: selections.length,
    totalEndHalf,
    totalEndMs,
    maxEndMs,
  };
}

/** CSV 字段转义：含逗号、引号、换行时用双引号包裹并把引号翻倍。 */
function csvCell(value) {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 生成与页面清单同内容的 CSV 文本（不含 BOM；下载时由前端加 UTF-8 BOM）。
 * 列：选段行、片内序号、剪辑段序号、剪辑段输入行、倍速、
 *     成片起点/终点/时长(ms)、源起点/终点/时长(ms)。
 */
function buildCsv(items) {
  const header = [
    '选段行', '片内序号', '剪辑段序号', '剪辑段输入行', '倍速',
    '成片起点(ms)', '成片终点(ms)', '成片时长(ms)',
    '源起点(ms)', '源终点(ms)', '源时长(ms)',
  ];
  const rows = items.map((it) => [
    it.selectionLine,
    it.subIndex,
    it.segOrder + 1,
    it.segLine,
    it.speed,
    formatQuarterMs(it.outStartQ),
    formatQuarterMs(it.outEndQ),
    formatQuarterMs(it.outEndQ - it.outStartQ),
    formatQuarterMs(it.srcStartQ),
    formatQuarterMs(it.srcEndQ),
    formatQuarterMs(it.srcEndQ - it.srcStartQ),
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

const tracebackApi = {
  MAX_SELECTIONS,
  parseSelections,
  formatQuarterMs,
  traceSelections,
  buildCsv,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = tracebackApi;
}
if (typeof window !== 'undefined') {
  window.Traceback = tracebackApi;
}
