'use strict';

/**
 * 剪辑方案对照。
 *
 * 以已生成结果的源字幕与剪辑段为方案 A、用户另输入的一组剪辑段为方案 B。
 * 对每条源字幕（半开区间 [start, end)），把两套剪辑段与其半开源区间的交集
 * 端点合并排序，将源时间轴切成连续小区间；逐区间统计：
 *
 *   - 覆盖次数：该小区间被方案中多少条剪辑段覆盖（重叠、重复段各自计入）；
 *   - 精确播放时长：按各覆盖段倍速折算（源时长 / 倍速）后求和，
 *     以半毫秒为整数单位累计，不先取整（0.5 / 1 / 2 三档倍速下换算均为整数半毫秒）。
 *
 * 只保留覆盖次数或精确播放时长不同的小区间；并汇总每条源字幕的播放时长差
 * （未命中、重叠、重复源段均计入：未命中部分计 0，重叠/重复部分按段多次累计）。
 *
 * 纯逻辑，Node/浏览器双端通用，不请求后端。
 */

// speed -> 每毫秒源时间对应的半毫秒单位数（与 src/remap.js 一致：2/speed）
const HALF_UNITS_PER_MS = {
  0.5: 4,
  1: 2,
  2: 1,
};

/** 各剪辑段与源区间 [start, end) 的半开交集（lo < hi 才保留），重复段各自计入。 */
function collectIntersections(segments, start, end) {
  const list = [];
  for (const seg of segments) {
    const lo = Math.max(start, seg.sourceStart);
    const hi = Math.min(end, seg.sourceEnd);
    if (lo < hi) list.push({ lo, hi, speed: seg.speed });
  }
  return list;
}

/**
 * 对照两套剪辑方案在同一组源字幕上的覆盖与播放时长。
 * @param {Array} cues 源字幕 [{ start, end }]（整数毫秒，半开区间，按源顺序）
 * @param {Array} segmentsA 方案 A 剪辑段 [{ sourceStart, sourceEnd, speed }]（按播放顺序）
 * @param {Array} segmentsB 方案 B 剪辑段（同格式）
 * @returns {{
 *   cueRows: Array<{
 *     cueIndex: number,
 *     intervals: Array<{
 *       start: number, end: number,
 *       coverageA: number, coverageB: number,
 *       durHalfA: number, durHalfB: number,
 *     }>,
 *     totalHalfA: number, totalHalfB: number, diffHalf: number,
 *   }>,
 *   cueCount: number, diffCueCount: number, diffIntervalCount: number,
 *   totalHalfA: number, totalHalfB: number, diffHalf: number,
 * }}
 *   intervals 只含两方案覆盖次数或精确播放时长不同的小区间（按起点升序）；
 *   totalHalfA/totalHalfB/diffHalf 为整条源字幕的精确播放时长（半毫秒单位），diff = A − B。
 */
function comparePlans(cues, segmentsA, segmentsB) {
  const listA = Array.isArray(segmentsA) ? segmentsA : [];
  const listB = Array.isArray(segmentsB) ? segmentsB : [];

  let totalHalfA = 0;
  let totalHalfB = 0;
  let diffCueCount = 0;
  let diffIntervalCount = 0;

  const cueRows = (Array.isArray(cues) ? cues : []).map((cue, cueIndex) => {
    const intsA = collectIntersections(listA, cue.start, cue.end);
    const intsB = collectIntersections(listB, cue.start, cue.end);

    // 两套方案交集端点合并排序 → 源时间轴上的连续小区间
    const ptSet = new Set([cue.start, cue.end]);
    for (const { lo, hi } of intsA) { ptSet.add(lo); ptSet.add(hi); }
    for (const { lo, hi } of intsB) { ptSet.add(lo); ptSet.add(hi); }
    const pts = Array.from(ptSet).sort((a, b) => a - b);

    const intervals = [];
    let cueHalfA = 0;
    let cueHalfB = 0;

    for (let i = 0; i + 1 < pts.length; i++) {
      const start = pts[i];
      const end = pts[i + 1];
      if (start >= end) continue;
      const len = end - start;

      // 端点已对齐：交集 [lo, hi) 覆盖小区间 ⟺ lo <= start 且 hi >= end
      let coverageA = 0;
      let durHalfA = 0;
      for (const x of intsA) {
        if (x.lo <= start && x.hi >= end) {
          coverageA += 1;
          durHalfA += len * HALF_UNITS_PER_MS[x.speed];
        }
      }
      let coverageB = 0;
      let durHalfB = 0;
      for (const x of intsB) {
        if (x.lo <= start && x.hi >= end) {
          coverageB += 1;
          durHalfB += len * HALF_UNITS_PER_MS[x.speed];
        }
      }

      cueHalfA += durHalfA;
      cueHalfB += durHalfB;

      if (coverageA !== coverageB || durHalfA !== durHalfB) {
        intervals.push({ start, end, coverageA, coverageB, durHalfA, durHalfB });
      }
    }

    totalHalfA += cueHalfA;
    totalHalfB += cueHalfB;
    if (intervals.length > 0) {
      diffCueCount += 1;
      diffIntervalCount += intervals.length;
    }

    return {
      cueIndex,
      intervals,
      totalHalfA: cueHalfA,
      totalHalfB: cueHalfB,
      diffHalf: cueHalfA - cueHalfB,
    };
  });

  return {
    cueRows,
    cueCount: cueRows.length,
    diffCueCount,
    diffIntervalCount,
    totalHalfA,
    totalHalfB,
    diffHalf: totalHalfA - totalHalfB,
  };
}

const planCompareApi = { comparePlans, HALF_UNITS_PER_MS };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = planCompareApi;
}
if (typeof window !== 'undefined') {
  window.PlanCompare = planCompareApi;
}
