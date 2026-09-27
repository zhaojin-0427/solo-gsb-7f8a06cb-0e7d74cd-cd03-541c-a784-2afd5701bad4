'use strict';

/**
 * 双语字幕配对。
 *
 * 译文 SRT 与主字幕在同一源时间轴上，双方都已经过同一组剪辑段、同样倍速重排
 * （remap），本模块只在重排结果（mappings）之间做配对：
 *
 *   - 仅在同一剪辑段（segOrder 相同）内配对；
 *   - 段内两侧均按“输出起点升序、同起点按原字幕顺序（cueIndex）”排序，
 *     在这两个有序序列之间做保持顺序的一对一配对；
 *   - 候选要求输出时间轴上存在正时长交集（半开区间，端点相接不算），
 *     交集权重 = 重合毫秒数；
 *   - 择优顺序：
 *       1) 配对交集毫秒总和最大；
 *       2) 总和相同取配对数最多；
 *       3) 仍相同时，取 (主字幕输出编号, 译文原序 cueIndex) 配对序列
 *          字典序最小者。
 *
 * DP：V(i,j) = 主序列后缀 i.. 与译文序列后缀 j.. 的最优 (交集毫秒, 配对数)，
 * 倒序填表；填完后从最前贪心重建字典序最小方案——
 * 固定当前主字幕时，在可达成最优的候选译文里取 cueIndex 最小者，
 * 没有任何最优方案使用当前主字幕时才跳过它。
 *
 * 双语 SRT 以主字幕的时间与编号为准：每条主字幕输出一行，配对成功的正文为
 * “主文\n译文”，未配对主字幕保留单语；未配对译文不进入文件（仅页面列出）。
 */

/** 两条重排结果在输出时间轴上的正时长交集（毫秒）；端点相接或无交集返回 0。 */
function overlapMs(a, b) {
  const lo = Math.max(a.start, b.start);
  const hi = Math.min(a.end, b.end);
  return hi > lo ? hi - lo : 0;
}

/** 段内排序：输出起点升序；同起点按原字幕顺序；再以终点兜底（同段同 cue 不会重复）。 */
function orderRows(rows) {
  return [...rows].sort((a, b) =>
    (a.start - b.start) || (a.cueIndex - b.cueIndex) || (a.end - b.end));
}

function groupBySegment(mappings) {
  const groups = new Map();
  for (const m of mappings) {
    let g = groups.get(m.segOrder);
    if (!g) {
      g = [];
      groups.set(m.segOrder, g);
    }
    g.push(m);
  }
  return groups;
}

/** 比较 (权重, 配对数)：先权重后数量，越大越优。 */
function better(w1, c1, w2, c2) {
  return w1 > w2 || (w1 === w2 && c1 > c2);
}

/**
 * 单个剪辑段内的保序配对。
 * @returns {{ pairs: Array, weight: number, count: number }}
 */
function pairGroup(A, B, segOrder) {
  const m = A.length;
  const n = B.length;
  // V(i,j) 展平为一维：行 i（0..m）× 列 j（0..n），边界行列均为 (0,0)
  const width = n + 1;
  const W = new Float64Array((m + 1) * width); // 最优交集毫秒总和
  const C = new Int32Array((m + 1) * width); // 最优配对数
  const at = (i, j) => i * width + j;

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      // 跳过主字幕 A[i]
      let bw = W[at(i + 1, j)];
      let bc = C[at(i + 1, j)];
      // 跳过译文 B[j]
      const sw = W[at(i, j + 1)];
      const sc = C[at(i, j + 1)];
      if (better(sw, sc, bw, bc)) {
        bw = sw;
        bc = sc;
      }
      // 配对 A[i] - B[j]（须正时长交集）
      const ov = overlapMs(A[i], B[j]);
      if (ov > 0) {
        const ew = W[at(i + 1, j + 1)] + ov;
        const ec = C[at(i + 1, j + 1)] + 1;
        if (better(ew, ec, bw, bc)) {
          bw = ew;
          bc = ec;
        }
      }
      W[at(i, j)] = bw;
      C[at(i, j)] = bc;
    }
  }

  // 贪心重建：按 (主编号, 译文原序) 字典序最小
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n && W[at(i, j)] > 0) {
    let chosen = -1;
    let chosenCueIndex = Number.POSITIVE_INFINITY;
    for (let k = j; k < n; k++) {
      const ov = overlapMs(A[i], B[k]);
      if (ov <= 0) continue;
      const tw = W[at(i + 1, k + 1)] + ov;
      const tc = C[at(i + 1, k + 1)] + 1;
      if (tw === W[at(i, j)] && tc === C[at(i, j)]) {
        // 可达成最优；同主字幕下取译文原序最小者
        if (B[k].cueIndex < chosenCueIndex) {
          chosen = k;
          chosenCueIndex = B[k].cueIndex;
        }
      }
    }
    if (chosen === -1) {
      // 任何最优方案都不配对 A[i] -> 跳过该主字幕（译文候选保留给后续主字幕）
      i++;
      continue;
    }
    const a = A[i];
    const b = B[chosen];
    pairs.push({
      segOrder,
      mainNewIndex: a.newIndex,
      transNewIndex: b.newIndex,
      transCueIndex: b.cueIndex,
      transSeq: b.seq,
      overlapMs: overlapMs(a, b),
    });
    i++;
    j = chosen + 1;
  }

  return { pairs, weight: W[at(0, 0)], count: C[at(0, 0)] };
}

/**
 * 对主字幕/译文的重排结果执行跨段配对。
 * @param {Array} mainMappings remap 主字幕结果
 * @param {Array} transMappings remap 译文结果（同一源时间轴、同一组剪辑段）
 * @returns {{ pairs: Array, pairCount:number, totalOverlapMs:number,
 *            unpairedMain: number[], unpairedTrans: number[] }}
 */
function buildPairs(mainMappings, transMappings) {
  const mainGroups = groupBySegment(mainMappings);
  const transGroups = groupBySegment(transMappings);

  const pairs = [];
  let totalOverlapMs = 0;
  const pairedMain = new Set();
  const pairedTrans = new Set();

  for (const [segOrder, mainRows] of mainGroups) {
    const transRows = transGroups.get(segOrder);
    if (!transRows || transRows.length === 0) continue;
    const g = pairGroup(orderRows(mainRows), orderRows(transRows), segOrder);
    for (const p of g.pairs) {
      pairs.push(p);
      pairedMain.add(p.mainNewIndex);
      pairedTrans.add(p.transNewIndex);
    }
    totalOverlapMs += g.weight;
  }

  pairs.sort((x, y) =>
    (x.mainNewIndex - y.mainNewIndex) || (x.transNewIndex - y.transNewIndex));

  return {
    pairs,
    pairCount: pairs.length,
    totalOverlapMs,
    unpairedMain: mainMappings
      .filter((m) => !pairedMain.has(m.newIndex))
      .map((m) => m.newIndex),
    unpairedTrans: transMappings
      .filter((m) => !pairedTrans.has(m.newIndex))
      .map((m) => m.newIndex),
  };
}

/**
 * 生成双语 SRT 条目：编号与时间完全以主字幕为准；配对条目正文先主文后译文，
 * 未配对主字幕保留单语；未配对译文不出现在结果中。
 *
 * @param {object} result buildPairs 的返回值
 * @param {{mainText?:(m)=>string, transText?:(m)=>string}} [options]
 *   可替换取文本方式（例如主文取自动排版后的 wrappedText）。
 * @returns {Array<{start:number,end:number,text:string}>}
 */
function buildBilingualEntries(mainMappings, transMappings, result, options = {}) {
  const mainText = options.mainText || ((m) => m.text);
  const transText = options.transText || ((m) => m.text);
  const transById = new Map(transMappings.map((t) => [t.newIndex, t]));
  const pairByMain = new Map(result.pairs.map((p) => [p.mainNewIndex, p]));

  return mainMappings.map((m) => {
    const p = pairByMain.get(m.newIndex);
    if (!p) return { start: m.start, end: m.end, text: mainText(m) };
    return {
      start: m.start,
      end: m.end,
      text: `${mainText(m)}\n${transText(transById.get(p.transNewIndex))}`,
    };
  });
}

const pairApi = {
  overlapMs,
  buildPairs,
  buildBilingualEntries,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = pairApi;
}
if (typeof window !== 'undefined') {
  window.Pair = pairApi;
}
