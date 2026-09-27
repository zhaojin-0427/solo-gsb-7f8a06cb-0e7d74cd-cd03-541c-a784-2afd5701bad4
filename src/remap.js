'use strict';

/**
 * 核心重排逻辑。
 *
 * 区间约定：字幕 [start, end) 与剪辑段 [sourceStart, sourceEnd) 均为半开区间，
 * 求交 lo = max(start, sourceStart)，hi = min(end, sourceEnd)，lo < hi 才命中。
 *
 * 倍速映射（speed = 播放倍速）：
 *   输出时长 = 源时长 / speed（2 倍速压缩一半，0.5 倍速拉长一倍）
 *
 * 精确累计：所有时间在内部以“半毫秒”为单位（1ms = 2 单位）。
 * 0.5 / 1 / 2 三档倍速下，偏移换算均为整数：
 *   speed 1   -> 单位 = 2 * offset
 *   speed 2   -> 单位 = offset
 *   speed 0.5 -> 单位 = 4 * offset
 * 所有输出边界最后四舍五入到毫秒；rounded 后起止相等的零长片段舍弃。
 */

// speed -> 每毫秒源时间对应的半毫秒单位数（2/speed）
const HALF_UNITS_PER_MS = {
  0.5: 4,
  1: 2,
  2: 1,
};

/** 半毫秒单位四舍五入为毫秒（整数运算，0.5 向上）。 */
function halfToMsRound(half) {
  return Math.floor((half + 1) / 2);
}

/**
 * 执行重排。
 * @param {Array} cues  parseSrt 得到的字幕
 * @param {Array} segments parseSegments 得到的剪辑段（按播放顺序）
 * @returns {{mappings, dropped, sourceRows, timeline, totalDurationMs}}
 */
function remap(cues, segments) {
  // 1) 计算每段在拼接时间轴上的精确起点/终点（半毫秒单位）
  let cursor = 0;
  const timeline = segments.map((seg) => {
    const outStartHalf = cursor;
    const outEndHalf = cursor + (seg.sourceEnd - seg.sourceStart) * HALF_UNITS_PER_MS[seg.speed];
    const row = {
      order: seg.order,
      line: seg.line,
      sourceStart: seg.sourceStart,
      sourceEnd: seg.sourceEnd,
      speed: seg.speed,
      outStartHalf,
      outEndHalf,
      outStart: halfToMsRound(outStartHalf),
      outEnd: halfToMsRound(outEndHalf),
      durationExactMs: (outEndHalf - outStartHalf) / 2,
    };
    cursor = outEndHalf;
    return row;
  });
  const totalHalf = cursor;

  // 2) 每段 × 每条字幕求交并映射
  const mappings = [];
  const dropped = []; // 有真实交集但四舍五入后零长
  // cueIndex -> 命中过的片段数（含被舍弃的）
  const hitCount = new Map();
  const usedCount = new Map();

  for (const seg of segments) {
    const tl = timeline[seg.order];
    const k = HALF_UNITS_PER_MS[seg.speed];

    for (const cue of cues) {
      const lo = Math.max(cue.start, seg.sourceStart);
      const hi = Math.min(cue.end, seg.sourceEnd);
      if (lo >= hi) continue; // 未命中（半开）

      hitCount.set(cue.index, (hitCount.get(cue.index) || 0) + 1);

      const startHalf = tl.outStartHalf + (lo - seg.sourceStart) * k;
      const endHalf = tl.outStartHalf + (hi - seg.sourceStart) * k;
      const outStart = halfToMsRound(startHalf);
      const outEnd = halfToMsRound(endHalf);

      if (outEnd === outStart) {
        // 零长片段（交集存在但映射后不足 1ms，四舍五入为同一点）→ 舍弃
        dropped.push({
          cueIndex: cue.index,
          seq: cue.seq,
          segOrder: seg.order,
          segLine: seg.line,
          speed: seg.speed,
          intersectStart: lo,
          intersectEnd: hi,
          exactStartMs: startHalf / 2,
          exactEndMs: endHalf / 2,
          reason: '映射并四舍五入后起止相同（零长片段）',
        });
        continue;
      }

      usedCount.set(cue.index, (usedCount.get(cue.index) || 0) + 1);
      mappings.push({
        cueIndex: cue.index,
        seq: cue.seq,
        sourceStart: cue.start,
        sourceEnd: cue.end,
        text: cue.text,
        segOrder: seg.order,
        segLine: seg.line,
        speed: seg.speed,
        intersectStart: lo,
        intersectEnd: hi,
        start: outStart,
        end: outEnd,
      });
    }
  }

  // 3) 排序：起点升序；同起点按剪辑段顺序，再按原字幕顺序
  mappings.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.segOrder !== b.segOrder) return a.segOrder - b.segOrder;
    if (a.cueIndex !== b.cueIndex) return a.cueIndex - b.cueIndex;
    return a.end - b.end;
  });

  // 4) 重新编号（从 1 开始）
  mappings.forEach((m, i) => {
    m.newIndex = i + 1;
  });

  // 5) 源字幕 -> 输出字幕 对应关系（每条源字幕一行）
  const sourceRows = cues.map((cue) => {
    const outputs = mappings
      .filter((m) => m.cueIndex === cue.index)
      .map((m) => m.newIndex);
    let status;
    if (outputs.length > 0) {
      status = 'used'; // 已采用
    } else if (hitCount.has(cue.index)) {
      status = 'zero-length'; // 命中但片段四舍五入后零长，全部舍弃
    } else {
      status = 'missed'; // 未命中任何剪辑段，丢弃
    }
    return {
      cueIndex: cue.index,
      seq: cue.seq,
      sourceStart: cue.start,
      sourceEnd: cue.end,
      text: cue.text,
      outputs,
      status,
    };
  });

  return {
    mappings,
    dropped,
    sourceRows,
    timeline,
    totalDurationMs: halfToMsRound(totalHalf),
    totalDurationExactMs: totalHalf / 2,
  };
}

module.exports = { remap, halfToMsRound };
