'use strict';

/**
 * 成片同步校准（锚点线性映射）。
 *
 * 以当前**未排版**输出字幕的毫秒时间为旧轴，用户给出 2～10 个同步锚点
 * （每行：旧毫秒 新毫秒；两列均须为非负整数且各自严格递增），把每条输出字幕的
 * 起止时间映射到成片（新）时间轴：
 *
 *   - 相邻锚点之间按线性比例映射：
 *       t ∈ [old_i, old_{i+1}] 时
 *       f(t) = new_i + (t − old_i) · (new_{i+1} − new_i) / (old_{i+1} − old_i)；
 *   - 首锚点之前沿用首锚点的固定偏移：f(t) = t + (new_0 − old_0)；
 *   - 末锚点之后沿用末锚点的固定偏移：f(t) = t + (new_{k−1} − old_{k−1})。
 *
 * 锚点处两侧公式一致（f(old_i) = new_i），整条映射连续且单调不减。
 *
 * 精度：映射全程以**整数分子/分母**（BigInt 有理数）保留精确值，不做任何浮点
 * 近似；只在最后把每个边界分别**四舍五入**为整数毫秒（0.5 向上，与
 * src/remap.js 的 halfToMsRound 一致）。
 *
 * 正文、编号、顺序与来源对应关系完全不变。若校准后出现**负时刻**（精确值 < 0）
 * 或**取整后零长**（四舍五入后终点不晚于起点）的字幕，逐条指出输出编号并
 * 禁止校准版导出（主结果不受影响）。
 *
 * 纯逻辑，Node/浏览器双端通用，不请求后端。
 */

const MIN_ANCHORS = 2;
const MAX_ANCHORS = 10;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * 解析同步锚点文本。每行一个锚点：旧毫秒 新毫秒。
 * 分隔符支持空白或逗号（可混用）；# 之后为注释，空行忽略。
 * 两列均须为非负整数且各自严格递增；锚点总数须为 2～10 个。
 * 单调性与「最近一个合法锚点」比较；非法行被跳过（不计入锚点序列），
 * 后续行仍与最近合法锚点比较。
 *
 * @returns {{ anchors: Array<{oldMs:number, newMs:number, line:number}>,
 *             errors: Array<{line:number, message:string}> }}
 */
function parseAnchors(input) {
  const errors = [];
  const anchors = [];
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
        message: `第 ${lineNo} 行：应有 2 个字段（旧毫秒 新毫秒），实际 ${parts.length} 个："${rawLine.trim()}"`,
      });
      return;
    }
    const [oldRaw, newRaw] = parts;
    if (!/^-?\d+$/.test(oldRaw)) {
      errors.push({ line: lineNo, message: `第 ${lineNo} 行：旧毫秒必须是整数，实际为 "${oldRaw}"` });
      return;
    }
    if (!/^-?\d+$/.test(newRaw)) {
      errors.push({ line: lineNo, message: `第 ${lineNo} 行：新毫秒必须是整数，实际为 "${newRaw}"` });
      return;
    }

    // 用 BigInt 判定，避免超出安全整数范围时静默丢失精度
    const oldBig = BigInt(oldRaw);
    const newBig = BigInt(newRaw);
    if (oldBig < 0n) {
      errors.push({ line: lineNo, message: `第 ${lineNo} 行：旧毫秒不能为负数（${oldRaw}）` });
      return;
    }
    if (newBig < 0n) {
      errors.push({ line: lineNo, message: `第 ${lineNo} 行：新毫秒不能为负数（${newRaw}）` });
      return;
    }
    if (oldBig > MAX_SAFE) {
      errors.push({ line: lineNo, message: `第 ${lineNo} 行：旧毫秒过大，超出可精确表示的范围（最大 ${Number.MAX_SAFE_INTEGER}）` });
      return;
    }
    if (newBig > MAX_SAFE) {
      errors.push({ line: lineNo, message: `第 ${lineNo} 行：新毫秒过大，超出可精确表示的范围（最大 ${Number.MAX_SAFE_INTEGER}）` });
      return;
    }
    const oldMs = Number(oldBig);
    const newMs = Number(newBig);

    const prev = anchors[anchors.length - 1];
    if (prev && oldMs <= prev.oldMs) {
      errors.push({
        line: lineNo,
        message: `第 ${lineNo} 行：旧毫秒（${oldMs}）必须大于前一锚点的旧毫秒（${prev.oldMs}，第 ${prev.line} 行），两列均须严格递增`,
      });
      return;
    }
    if (prev && newMs <= prev.newMs) {
      errors.push({
        line: lineNo,
        message: `第 ${lineNo} 行：新毫秒（${newMs}）必须大于前一锚点的新毫秒（${prev.newMs}，第 ${prev.line} 行），两列均须严格递增`,
      });
      return;
    }

    anchors.push({ oldMs, newMs, line: lineNo });
  });

  if (errors.length === 0) {
    if (anchors.length < MIN_ANCHORS) {
      errors.push({ line: 0, message: `至少需要 ${MIN_ANCHORS} 个同步锚点（当前 ${anchors.length} 个；每行：旧毫秒 新毫秒）` });
    } else if (anchors.length > MAX_ANCHORS) {
      errors.push({ line: 0, message: `同步锚点最多 ${MAX_ANCHORS} 个（当前 ${anchors.length} 个）` });
    }
  }

  return { anchors, errors };
}

/**
 * 把旧轴时刻 t（非负整数毫秒）映射到成片时间轴，返回精确有理数。
 * @param {Array} anchors 已校验锚点（parseAnchors 通过后的 anchors）
 * @param {number} t 旧轴毫秒（非负整数）
 * @returns {{num: bigint, den: bigint}} 精确校准时刻 num/den（毫秒，den > 0）
 */
function mapTimeExact(anchors, t) {
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (t <= first.oldMs) {
    // 首锚点之前（含首锚点）：沿用首锚点的固定偏移
    return { num: BigInt(t) + BigInt(first.newMs) - BigInt(first.oldMs), den: 1n };
  }
  if (t >= last.oldMs) {
    // 末锚点之后（含末锚点）：沿用末锚点的固定偏移
    return { num: BigInt(t) + BigInt(last.newMs) - BigInt(last.oldMs), den: 1n };
  }
  for (let i = 0; i + 1 < anchors.length; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (t < b.oldMs) {
      // a.oldMs ≤ t < b.oldMs：相邻锚点间线性比例映射（整数分子/分母）
      const oldSpan = BigInt(b.oldMs - a.oldMs);
      const num = BigInt(a.newMs) * oldSpan
        + BigInt(t - a.oldMs) * BigInt(b.newMs - a.newMs);
      return { num, den: oldSpan };
    }
  }
  // 单调递增锚点下不可达（t 必落入某一区间）；防御性返回恒等映射
  return { num: BigInt(t), den: 1n };
}

/**
 * 有理数四舍五入为整数（0.5 向上，与 remap 的 halfToMsRound 一致）。
 * 纯整数运算：round(num/den) = floor((2·num + den) / (2·den))。
 * @param {bigint} num 分子（可负）
 * @param {bigint} den 分母（必须 > 0）
 * @returns {number} 四舍五入后的整数毫秒
 */
function roundHalfUp(num, den) {
  const n = 2n * BigInt(num) + BigInt(den);
  const d = 2n * BigInt(den);
  let q = n / d; // BigInt 整除向零截断
  if (n % d !== 0n && n < 0n) q -= 1n; // 修正为向下取整
  return Number(q);
}

/** 映射并四舍五入：旧轴毫秒 → 校准后的整数毫秒。 */
function mapTime(anchors, t) {
  const r = mapTimeExact(anchors, t);
  return roundHalfUp(r.num, r.den);
}

/**
 * 逐条校准输出字幕的起止时间（顺序、编号、正文与来源对应关系不变）。
 * @param {Array} mappings remap 输出（按输出顺序，含 newIndex/segOrder/start/end）
 * @param {Array} anchors 已校验锚点（2～10 个，两列非负整数且严格递增）
 * @returns {object}
 *   成功：{ ok:true, items:[{newIndex, segOrder, start, end, newStart, newEnd,
 *          shiftStart, shiftEnd}], problems:[{newIndex, kind}], exportable,
 *          anchorCount, message?（problems 非空时） }
 *   失败：{ ok:false, code:'empty'|'bad-anchors', message }
 */
function computeSync(mappings, anchors) {
  const list = Array.isArray(mappings) ? mappings : [];
  if (list.length === 0) {
    return { ok: false, code: 'empty', message: '当前没有输出字幕，无法进行同步校准。' };
  }
  if (!Array.isArray(anchors) || anchors.length < MIN_ANCHORS || anchors.length > MAX_ANCHORS) {
    return { ok: false, code: 'bad-anchors', message: `同步锚点无效：需要 ${MIN_ANCHORS}～${MAX_ANCHORS} 个合法锚点。` };
  }

  const items = [];
  const problems = [];
  for (const m of list) {
    const exactStart = mapTimeExact(anchors, m.start);
    const exactEnd = mapTimeExact(anchors, m.end);
    const newStart = roundHalfUp(exactStart.num, exactStart.den);
    const newEnd = roundHalfUp(exactEnd.num, exactEnd.den);
    items.push({
      newIndex: m.newIndex,
      segOrder: m.segOrder,
      start: m.start,
      end: m.end,
      newStart,
      newEnd,
      shiftStart: newStart - m.start,
      shiftEnd: newEnd - m.end,
    });
    if (exactStart.num < 0n || exactEnd.num < 0n) {
      problems.push({ newIndex: m.newIndex, kind: 'negative' });
    } else if (newEnd <= newStart) {
      problems.push({ newIndex: m.newIndex, kind: 'zero-length' });
    }
  }

  const result = {
    ok: true,
    items,
    problems,
    exportable: problems.length === 0,
    anchorCount: anchors.length,
  };
  if (problems.length > 0) {
    const neg = problems.filter((p) => p.kind === 'negative').map((p) => `#${p.newIndex}`);
    const zero = problems.filter((p) => p.kind === 'zero-length').map((p) => `#${p.newIndex}`);
    const parts = [];
    if (neg.length) parts.push(`输出 ${neg.join('、')} 校准后出现负时刻`);
    if (zero.length) parts.push(`输出 ${zero.join('、')} 校准取整后零长（终点不晚于起点）`);
    result.message = `${parts.join('；')}，已禁止校准版导出（主结果不受影响）。`;
  }
  return result;
}

/**
 * 生成校准版 SRT 条目：编号与顺序不变（serializeSrt 按顺序从 1 重新编号，
 * 与原输出编号一致），时间取校准后起止，正文取未排版原文。
 * 仅在 result.exportable 时用于导出。
 * @param {Array} mappings remap 输出（与 computeSync 同一输入，按输出顺序）
 * @param {object} result computeSync 的成功结果
 * @returns {Array<{start:number, end:number, text:string}>}
 */
function buildSyncedEntries(mappings, result) {
  return result.items.map((it, i) => ({
    start: it.newStart,
    end: it.newEnd,
    text: String(mappings[i].text ?? ''),
  }));
}

const syncApi = {
  MIN_ANCHORS,
  MAX_ANCHORS,
  parseAnchors,
  mapTimeExact,
  roundHalfUp,
  mapTime,
  computeSync,
  buildSyncedEntries,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = syncApi;
}
if (typeof window !== 'undefined') {
  window.Sync = syncApi;
}
