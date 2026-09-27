'use strict';

/**
 * 字幕时间避让（整体平移排程）。
 *
 * 以当前**未排版**输出字幕（remap 的 mappings，按输出顺序）为输入，为每条
 * 字幕求一个整数毫秒的整体平移量（起点、终点一起移动，时长不变），使得：
 *
 *   - 每条字幕的平移量绝对值不超过「最大平移量」maxShift（可正可负）；
 *   - 新起止不越出所属剪辑段**取整后**的输出区间
 *     [timeline[segOrder].outStart, timeline[segOrder].outEnd]；
 *   - 相邻输出字幕（含跨剪辑段）至少相隔「最小间隔」minGap：
 *     后一条新起点 − 前一条新终点 ≥ minGap（间隔为 0 时允许首尾相接）；
 *   - 正文、时长、编号、来源对应关系与原有顺序全部保持。
 *
 * 第 i 条新起点 s_i 的可行域为整数区间
 *   [ max(start_i − maxShift, 段outStart), min(start_i + maxShift, 段outEnd − 时长_i) ]
 * （remap 保证原起止本就在段区间内，故该域必含原起点，单条自身恒可行）。
 *
 * 择优：在全部可行排程中先最小化平移绝对值总和 Σ|s_i − start_i|；
 * 同分取新起点序列 (s_1, …, s_n) 字典序最小者。
 *
 * 算法：
 *   1) 最短不可行前缀：前向区间传播。前 i 条可行时第 i 条起点的可行集合
 *      必为连续区间 [p_i, hi_i]，且 p_i = max(lo_i, p_{i-1} + 时长_{i-1} + minGap)；
 *      p_i > hi_i 时前 i 条不可行，末条即最短不可行前缀的末条。
 *   2) 最小总平移：后缀 DP。g(i, s) = 第 i 条新起点取 s 时第 i..n 条的
 *      最小后缀代价 |s − a_i| + min g(i+1, s')（s' ≥ s + 时长_i + minGap），
 *      对下一行预处理后缀最小值，每条字幕 O(可行域宽度) 转移；
 *      可行域宽度 ≤ 2·maxShift + 1 ≤ 2001，n ≤ 200，总量约 40 万。
 *   3) 字典序最小重建：算出最小总代价 C* 后正向逐条取满足
 *      g(i, s) = C* − 已耗代价 的最小 s。
 *
 * 上限：输出字幕最多 MAX_CUES（200）条，超限不计算并提示。
 * 全部计算为纯整数（毫秒），Node/浏览器双端通用，不请求后端。
 */

const MAX_CUES = 200;
const MAX_GAP = 500;
const MAX_SHIFT = 1000;

/**
 * 校验避让参数。
 * @returns {{ok:boolean, error?:string}}
 */
function validateParams(minGap, maxShift) {
  if (!Number.isInteger(minGap) || minGap < 0 || minGap > MAX_GAP) {
    return { ok: false, error: `最小间隔必须是 0～${MAX_GAP} 的整数毫秒，实际为 ${minGap}` };
  }
  if (!Number.isInteger(maxShift) || maxShift < 0 || maxShift > MAX_SHIFT) {
    return { ok: false, error: `最大平移量必须是 0～${MAX_SHIFT} 的整数毫秒，实际为 ${maxShift}` };
  }
  return { ok: true };
}

/**
 * 计算避让排程。
 * @param {Array} mappings remap 输出（按输出顺序，含 newIndex/segOrder/start/end）
 * @param {Array} timeline remap 的剪辑段时间轴（含 outStart/outEnd 取整毫秒）
 * @param {number} minGap 最小间隔（0～500 整数毫秒）
 * @param {number} maxShift 最大平移量（0～1000 整数毫秒）
 * @returns {object}
 *   成功：{ ok:true, items:[{newIndex, segOrder, start, end, newStart, newEnd, shift}],
 *          totalAbsShift, maxAbsShift, shiftedCount, minGap, maxShift }
 *   失败：{ ok:false, code:'empty'|'too-many'|'bad-params'|'infeasible', message,
 *          count?（too-many）, failNewIndex?/failPosition?（infeasible） }
 */
function computeAvoidance(mappings, timeline, minGap, maxShift) {
  const list = Array.isArray(mappings) ? mappings : [];
  const n = list.length;
  if (n === 0) {
    return { ok: false, code: 'empty', message: '当前没有输出字幕，无法计算时间避让。' };
  }
  if (n > MAX_CUES) {
    return {
      ok: false,
      code: 'too-many',
      count: n,
      message: `输出字幕共 ${n} 条，超过 ${MAX_CUES} 条上限，未计算时间避让。`,
    };
  }
  const param = validateParams(minGap, maxShift);
  if (!param.ok) {
    return { ok: false, code: 'bad-params', message: param.error };
  }

  // 每条新起点的可行域 [lo, hi]（整数毫秒，闭区间）
  const a = new Array(n); // 原起点
  const dur = new Array(n); // 时长（平移不变）
  const lo = new Array(n);
  const hi = new Array(n);
  for (let i = 0; i < n; i++) {
    const m = list[i];
    const tl = timeline[m.segOrder];
    const d = m.end - m.start;
    a[i] = m.start;
    dur[i] = d;
    lo[i] = Math.max(m.start - maxShift, tl.outStart);
    hi[i] = Math.min(m.start + maxShift, tl.outEnd - d);
  }

  // 1) 最短不可行前缀：pMin 为前 i 条可行时第 i 条起点的最小可行值
  let pMin = lo[0];
  let failAt = pMin > hi[0] ? 0 : -1;
  for (let i = 1; i < n && failAt === -1; i++) {
    pMin = Math.max(lo[i], pMin + dur[i - 1] + minGap);
    if (pMin > hi[i]) failAt = i;
  }
  if (failAt !== -1) {
    return {
      ok: false,
      code: 'infeasible',
      failNewIndex: list[failAt].newIndex,
      failPosition: failAt + 1,
      message: `无可行排程：最短不可行前缀的末条为输出 #${list[failAt].newIndex}`
        + `（前 ${failAt + 1} 条在当前间隔与平移上限下无法排入）。`,
    };
  }

  // 2) 后缀 DP：rows[i][v] = 第 i 条新起点 lo[i]+v 时第 i..n-1 条的最小代价
  const lens = new Array(n);
  const rows = new Array(n);
  let nextSuff = null; // 下一行（i+1）的后缀最小值
  for (let i = n - 1; i >= 0; i--) {
    const len = hi[i] - lo[i] + 1;
    lens[i] = len;
    const g = new Float64Array(len);
    for (let v = 0; v < len; v++) {
      const s = lo[i] + v;
      let tail = 0;
      if (i < n - 1) {
        const idx = s + dur[i] + minGap - lo[i + 1]; // 下一条新起点的最小下标
        tail = idx >= lens[i + 1] ? Infinity : nextSuff[Math.max(0, idx)];
      }
      g[v] = Math.abs(s - a[i]) + tail;
    }
    rows[i] = g;
    const suff = new Float64Array(len);
    let run = Infinity;
    for (let v = len - 1; v >= 0; v--) {
      if (g[v] < run) run = g[v];
      suff[v] = run;
    }
    nextSuff = suff;
  }

  let best = Infinity;
  for (let v = 0; v < lens[0]; v++) {
    if (rows[0][v] < best) best = rows[0][v];
  }
  if (!Number.isFinite(best)) {
    // 理论上已被前向传播排除；防御性返回
    return {
      ok: false,
      code: 'infeasible',
      failNewIndex: list[n - 1].newIndex,
      failPosition: n,
      message: `无可行排程：最短不可行前缀的末条为输出 #${list[n - 1].newIndex}。`,
    };
  }

  // 3) 字典序最小重建：逐条取仍可达最小总代价的最小新起点
  const starts = new Array(n);
  let spent = 0;
  let bound = -Infinity; // 前一条新终点 + 间隔
  for (let i = 0; i < n; i++) {
    const lb = Math.max(lo[i], bound);
    let chosen = -1;
    for (let v = lb - lo[i]; v < lens[i]; v++) {
      if (rows[i][v] === best - spent) {
        chosen = v;
        break;
      }
    }
    if (chosen === -1) {
      throw new Error(`避让重建失败：第 ${i + 1} 条无可达最优的新起点（内部错误）`);
    }
    const s = lo[i] + chosen;
    starts[i] = s;
    spent += Math.abs(s - a[i]);
    bound = s + dur[i] + minGap;
  }

  const items = list.map((m, i) => ({
    newIndex: m.newIndex,
    segOrder: m.segOrder,
    start: m.start,
    end: m.end,
    newStart: starts[i],
    newEnd: starts[i] + dur[i],
    shift: starts[i] - a[i],
  }));
  let maxAbsShift = 0;
  let shiftedCount = 0;
  for (const it of items) {
    if (it.shift !== 0) shiftedCount += 1;
    const abs = Math.abs(it.shift);
    if (abs > maxAbsShift) maxAbsShift = abs;
  }

  return {
    ok: true,
    items,
    totalAbsShift: spent,
    maxAbsShift,
    shiftedCount,
    minGap,
    maxShift,
  };
}

/**
 * 生成避让版 SRT 条目：编号与顺序不变（serializeSrt 按顺序从 1 重新编号，
 * 与原输出编号一致），时间取新起止，正文取未排版原文。
 * @param {Array} mappings remap 输出（与 computeAvoidance 同一输入，按输出顺序）
 * @param {object} result computeAvoidance 的成功结果
 * @returns {Array<{start:number, end:number, text:string}>}
 */
function buildAvoidedEntries(mappings, result) {
  return result.items.map((it, i) => ({
    start: it.newStart,
    end: it.newEnd,
    text: String(mappings[i].text ?? ''),
  }));
}

const avoidApi = {
  MAX_CUES,
  MAX_GAP,
  MAX_SHIFT,
  validateParams,
  computeAvoidance,
  buildAvoidedEntries,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = avoidApi;
}
if (typeof window !== 'undefined') {
  window.Avoid = avoidApi;
}
