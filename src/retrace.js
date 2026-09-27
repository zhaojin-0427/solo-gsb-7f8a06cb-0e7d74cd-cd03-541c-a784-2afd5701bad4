'use strict';

/**
 * 成片选段回溯。
 *
 * 用户在结果页逐行输入 1～20 个**成片（拼接时间轴）**上的半开区间选段：
 *   起始毫秒 结束毫秒
 * （字段间用空白或逗号分隔，# 之后为注释，空行忽略；两端均须为非负整数、
 * 起点小于终点，终点不得越过当前拼接时间轴的**精确末端**；解析错误指出行号。）
 *
 * 回溯规则：
 *   1) 按现有剪辑段的**精确拼接边界**（半毫秒整数单位，与 src/remap.js 的
 *      outStartHalf/outEndHalf 一致）把每个选段拆成若干子区间：半开区间求交
 *      lo = max(选段起, 段起)、hi = min(选段止, 段止)，仅当 lo < hi 时保留——
 *      切点恰为选段端点时相邻段不会产生空行；
 *   2) 各子区间依所属剪辑段倍速**反算到源时间轴**：源偏移 = 成片偏移 × 倍速。
 *      成片边界为半毫秒精度、倍速为 0.5 / 1 / 2，故源端点以**四分之一毫秒**
 *      为最小单位精确保留（全程整数运算，**不从已取整的输出字幕时间反推**）；
 *   3) 结果按**输入行及播放顺序**排列；同一源段被重复使用（重复段）时
 *      每次各自保留一条记录。
 *
 * 纯逻辑，Node/浏览器双端通用，不请求后端。
 */

const MIN_SELECTIONS = 1;
const MAX_SELECTIONS = 20;

/** 半毫秒单位 → 规范毫秒文本（整数不带小数，奇数保留 .5）。 */
function formatHalfMs(half) {
  const h = Number(half);
  if (h % 2 === 0) return String(h / 2);
  return `${Math.floor(h / 2)}.5`;
}

/** 四分之一毫秒单位 → 规范毫秒文本（至多两位小数：.25 / .5 / .75，整数不带小数）。 */
function formatQuarterMs(quarter) {
  const q = Number(quarter);
  const rem = ((q % 4) + 4) % 4;
  const whole = (q - rem) / 4;
  if (rem === 0) return String(whole);
  return `${whole}.${['', '25', '5', '75'][rem]}`;
}

/**
 * 解析成片选段文本。每行一个半开区间：起始毫秒 结束毫秒。
 * 分隔符支持空白或逗号（可混用）；# 之后为注释，空行忽略。
 * 两端均须为非负整数且起点小于终点；终点不得越过拼接时间轴的精确末端
 * （totalExactMs，可含半毫秒，如 1000.5）；选段总数须为 1～20 个。
 *
 * @param {string} input 选段文本
 * @param {number} totalExactMs 当前拼接时间轴的精确末端（毫秒，可为 x.5）
 * @returns {{ selections: Array<{start:number, end:number, line:number, raw:string}>,
 *             errors: Array<{line:number, message:string}> }}
 */
function parseSelections(input, totalExactMs) {
  const errors = [];
  const selections = [];
  const rawLines = String(input ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const total = Number(totalExactMs);
  const totalText = formatHalfMs(Math.round(total * 2));

  rawLines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) return;

    // 逗号/制表符/空白统一切分，过滤空字段
    const parts = line.split(/[\s,]+/).filter(Boolean);
    if (parts.length !== 2) {
      errors.push({
        line: lineNo,
        message: `第 ${lineNo} 行：应有 2 个字段（起始毫秒 结束毫秒），实际 ${parts.length} 个："${rawLine.trim()}"`,
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
    if (end < 0) {
      errors.push({ line: lineNo, message: `第 ${lineNo} 行：结束时间不能为负数（${end}）` });
      return;
    }
    if (end <= start) {
      errors.push({ line: lineNo, message: `第 ${lineNo} 行：结束时间（${end}）必须晚于起始时间（${start}）` });
      return;
    }
    if (!(end <= total)) {
      errors.push({
        line: lineNo,
        message: `第 ${lineNo} 行：结束时间（${end}）不得越过拼接时间轴精确末端（${totalText} ms）`,
      });
      return;
    }

    selections.push({ start, end, line: lineNo, raw: rawLine.trim() });
  });

  if (errors.length === 0) {
    if (selections.length < MIN_SELECTIONS) {
      errors.push({ line: 0, message: `至少需要 ${MIN_SELECTIONS} 个成片选段（每行：起始毫秒 结束毫秒）` });
    } else if (selections.length > MAX_SELECTIONS) {
      errors.push({ line: 0, message: `成片选段最多 ${MAX_SELECTIONS} 个（当前 ${selections.length} 个）` });
    }
  }

  return { selections, errors };
}

/**
 * 把每个选段按剪辑段精确拼接边界拆开，并依倍速反算到源时间轴。
 * 选段端点为整数毫秒（×2 得半毫秒单位），与 timeline 的精确半毫秒边界求交；
 * 源端点以四分之一毫秒整数单位记录：
 *   源端点（¼ms） = 源段起点 × 4 + (成片端点半毫秒 − 段起点半毫秒) × 2 × 倍速
 * （2 × 倍速 ∈ {1, 2, 4}，全程整数运算）。
 *
 * @param {Array} selections parseSelections 得到的选段（按输入行顺序）
 * @param {Array} timeline remap 的剪辑段时间轴（含 order/line/sourceStart/speed/outStartHalf/outEndHalf）
 * @returns {object}
 *   成功：{ ok:true, rows:[{selIndex, line, selStart, selEnd, segOrder, segLine, speed,
 *          outStartHalf, outEndHalf, srcStartQuarter, srcEndQuarter}]
 *          （按输入行及播放顺序；同一源段重复使用时各次记录均保留）,
 *          selections（选段快照）, selectionCount, rowCount }
 *   失败：{ ok:false, code:'empty'|'bad-timeline', message }
 */
function computeRetrace(selections, timeline) {
  const sels = Array.isArray(selections) ? selections : [];
  if (sels.length === 0) {
    return { ok: false, code: 'empty', message: '没有可用的成片选段，无法回溯。' };
  }
  if (!Array.isArray(timeline) || timeline.length === 0) {
    return { ok: false, code: 'bad-timeline', message: '剪辑段时间轴无效，无法进行选段回溯。' };
  }

  const rows = [];
  sels.forEach((sel, selIndex) => {
    const selStartHalf = sel.start * 2;
    const selEndHalf = sel.end * 2;
    for (const tl of timeline) {
      const lo = Math.max(selStartHalf, tl.outStartHalf);
      const hi = Math.min(selEndHalf, tl.outEndHalf);
      if (lo >= hi) continue; // 半开区间：切点恰为选段端点时不产生相邻段的空行
      const perHalf = 2 * tl.speed; // 每半毫秒成片单位对应的源¼毫秒单位数（0.5→1、1→2、2→4）
      rows.push({
        selIndex,
        line: sel.line,
        selStart: sel.start,
        selEnd: sel.end,
        segOrder: tl.order,
        segLine: tl.line,
        speed: tl.speed,
        outStartHalf: lo,
        outEndHalf: hi,
        srcStartQuarter: tl.sourceStart * 4 + (lo - tl.outStartHalf) * perHalf,
        srcEndQuarter: tl.sourceStart * 4 + (hi - tl.outStartHalf) * perHalf,
      });
    }
  });

  return {
    ok: true,
    rows,
    selections: sels.map((s) => ({ line: s.line, start: s.start, end: s.end })),
    selectionCount: sels.length,
    rowCount: rows.length,
  };
}

/** CSV 单元格转义（含逗号/引号/换行时加引号，引号翻倍）。 */
function csvCell(v) {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_HEADER = [
  '输入行', '选段起(ms)', '选段止(ms)',
  '成片起(ms)', '成片止(ms)', '源起(ms)', '源止(ms)',
  '剪辑段序号', '剪辑段输入行', '倍速',
];

/**
 * 生成与页面清单同内容的 CSV 文本（每行一条子区间记录，顺序与清单一致；
 * 成片端点保留半毫秒、源端点保留四分之一毫秒的规范文本）。
 * @param {Array} rows computeRetrace 的 rows
 * @returns {string} CSV 文本（\n 分隔，末尾带换行）
 */
function buildRetraceCsv(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const lines = [CSV_HEADER.map(csvCell).join(',')];
  for (const r of list) {
    lines.push([
      r.line,
      r.selStart,
      r.selEnd,
      formatHalfMs(r.outStartHalf),
      formatHalfMs(r.outEndHalf),
      formatQuarterMs(r.srcStartQuarter),
      formatQuarterMs(r.srcEndQuarter),
      r.segOrder + 1,
      r.segLine,
      r.speed,
    ].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

const retraceApi = {
  MIN_SELECTIONS,
  MAX_SELECTIONS,
  parseSelections,
  computeRetrace,
  formatHalfMs,
  formatQuarterMs,
  buildRetraceCsv,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = retraceApi;
}
if (typeof window !== 'undefined') {
  window.Retrace = retraceApi;
}
