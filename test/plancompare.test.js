'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { comparePlans, HALF_UNITS_PER_MS } = require('../src/plancompare');
const { parseSegments } = require('../src/segments');
const { parseSrt } = require('../src/srt');
const { remap } = require('../src/remap');

const cue = (start, end) => ({ start, end });
const seg = (sourceStart, sourceEnd, speed) => ({ sourceStart, sourceEnd, speed });

test('方案对照：完全相同的方案无任何差异', () => {
  const cues = [cue(0, 3000), cue(3000, 7000), cue(8000, 10000)];
  const segs = [seg(0, 5000, 1), seg(10000, 13500, 2), seg(3000, 6000, 0.5), seg(0, 2000, 1)];
  const r = comparePlans(cues, segs, segs);
  assert.equal(r.cueCount, 3);
  assert.equal(r.diffCueCount, 0);
  assert.equal(r.diffIntervalCount, 0);
  assert.equal(r.diffHalf, 0);
  assert.ok(r.cueRows.every((c) => c.intervals.length === 0 && c.diffHalf === 0));
  // cue0 [0,3000)：段1 [0,5000]@1 → 3000ms；段3 [3000,6000] 端点相接（半开）不算；
  // 段4 [0,2000]@1 → 2000ms；合计 5000ms = 10000 半毫秒
  assert.equal(r.cueRows[0].totalHalfA, 10000);
  // cue1 [3000,7000)：段1 → 2000ms@1 = 4000；段3 → 3000ms@0.5 = 12000；合计 16000
  assert.equal(r.cueRows[1].totalHalfA, 16000);
  // cue2 [8000,10000)：无任何段命中 → 0
  assert.equal(r.cueRows[2].totalHalfA, 0);
  assert.equal(r.totalHalfA, 26000);
  assert.equal(r.totalHalfB, 26000);
});

test('方案对照：方案 B 未命中的源字幕计入差异（覆盖 1 vs 0）', () => {
  const r = comparePlans([cue(0, 2000)], [seg(0, 2000, 1)], [seg(5000, 8000, 1)]);
  assert.equal(r.diffCueCount, 1);
  assert.equal(r.diffIntervalCount, 1);
  const iv = r.cueRows[0].intervals[0];
  assert.deepEqual([iv.start, iv.end], [0, 2000]);
  assert.equal(iv.coverageA, 1);
  assert.equal(iv.coverageB, 0);
  assert.equal(iv.durHalfA, 4000);
  assert.equal(iv.durHalfB, 0);
  assert.equal(r.cueRows[0].totalHalfA, 4000);
  assert.equal(r.cueRows[0].totalHalfB, 0);
  assert.equal(r.cueRows[0].diffHalf, 4000);
  assert.equal(r.diffHalf, 4000);
});

test('方案对照：两方案都未命中时不算差异', () => {
  const r = comparePlans([cue(0, 2000)], [seg(5000, 8000, 1)], [seg(9000, 9100, 2)]);
  assert.equal(r.diffCueCount, 0);
  assert.equal(r.diffIntervalCount, 0);
  assert.equal(r.cueRows[0].intervals.length, 0);
  assert.equal(r.cueRows[0].totalHalfA, 0);
  assert.equal(r.cueRows[0].totalHalfB, 0);
});

test('方案对照：覆盖次数相同但倍速不同 → 播放时长差异', () => {
  const r = comparePlans([cue(0, 1000)], [seg(0, 1000, 1)], [seg(0, 1000, 2)]);
  assert.equal(r.diffCueCount, 1);
  const iv = r.cueRows[0].intervals[0];
  assert.equal(iv.coverageA, 1);
  assert.equal(iv.coverageB, 1);
  assert.equal(iv.durHalfA, 2000); // 1000ms @1x
  assert.equal(iv.durHalfB, 1000); // 1000ms @2x = 500ms
  assert.equal(r.diffHalf, 1000);
});

test('方案对照：精确播放时长以半毫秒计，不先取整', () => {
  // 1ms 源区间：2 倍速 → 0.5ms（1 个半毫秒单位）；0.5 倍速 → 2ms（4 个单位）
  const r = comparePlans([cue(0, 1)], [seg(0, 1, 2)], [seg(0, 1, 0.5)]);
  const iv = r.cueRows[0].intervals[0];
  assert.equal(iv.durHalfA, 1);
  assert.equal(iv.durHalfB, 4);
  assert.equal(r.cueRows[0].totalHalfA, 1);
  assert.equal(r.cueRows[0].totalHalfB, 4);
  assert.equal(r.diffHalf, -3);
});

test('方案对照：重叠与重复源段各自计入覆盖次数与播放时长', () => {
  // A：同一源段重复两次 + 一条后半重叠段；B：单段
  const r = comparePlans(
    [cue(0, 1000)],
    [seg(0, 1000, 1), seg(0, 1000, 1), seg(500, 1500, 2)],
    [seg(0, 1000, 1)],
  );
  const ivs = r.cueRows[0].intervals;
  assert.equal(ivs.length, 2);
  // [0,500)：A 覆盖 2（两条重复段），B 覆盖 1
  assert.deepEqual([ivs[0].start, ivs[0].end], [0, 500]);
  assert.equal(ivs[0].coverageA, 2);
  assert.equal(ivs[0].coverageB, 1);
  assert.equal(ivs[0].durHalfA, 2 * 500 * 2); // 两条 1x
  assert.equal(ivs[0].durHalfB, 500 * 2);
  // [500,1000)：A 覆盖 3（重复×2 + 重叠段），B 覆盖 1
  assert.deepEqual([ivs[1].start, ivs[1].end], [500, 1000]);
  assert.equal(ivs[1].coverageA, 3);
  assert.equal(ivs[1].coverageB, 1);
  assert.equal(ivs[1].durHalfA, 2 * 500 * 2 + 500 * 1); // 两条 1x + 一条 2x
  assert.equal(ivs[1].durHalfB, 500 * 2);
  assert.equal(r.cueRows[0].totalHalfA, 4500);
  assert.equal(r.cueRows[0].totalHalfB, 2000);
});

test('方案对照：两套方案端点合并排序切成连续小区间，仅列出不同者', () => {
  // cue [0,2000)；A [0,1000]@1；B [500,1500]@1
  // 原子区间：[0,500) 仅 A；[500,1000) 双方一致；[1000,1500) 仅 B；[1500,2000) 均无
  const r = comparePlans([cue(0, 2000)], [seg(0, 1000, 1)], [seg(500, 1500, 1)]);
  const ivs = r.cueRows[0].intervals;
  assert.deepEqual(ivs.map((iv) => [iv.start, iv.end]), [[0, 500], [1000, 1500]]);
  assert.deepEqual(ivs.map((iv) => [iv.coverageA, iv.coverageB]), [[1, 0], [0, 1]]);
  // 两区间时长差相互抵消：整条字幕差为 0，但差异区间仍须列出
  assert.equal(r.cueRows[0].diffHalf, 0);
  assert.equal(r.diffCueCount, 1);
  assert.equal(r.diffIntervalCount, 2);
  assert.equal(r.diffHalf, 0);
});

test('方案对照：与 remap 时间轴联动（方案 A 取自主结果 timeline）', () => {
  const srt = `1
00:00:00,000 --> 00:00:03,000
第一句

2
00:00:03,000 --> 00:00:07,000
第二句

3
00:00:08,000 --> 00:00:10,000
第三句
`;
  const segText = '0 5000 1\n10000 13500 2\n3000 6000 0.5\n0 2000 1\n';
  const { cues, errors: srtErrors } = parseSrt(srt);
  const { segments, errors: segErrors } = parseSegments(segText);
  assert.equal(srtErrors.length, 0);
  assert.equal(segErrors.length, 0);
  const result = remap(cues, segments);
  // 前端用法：方案 A 的剪辑段取自主结果 timeline
  const segsA = result.timeline.map((t) => ({
    sourceStart: t.sourceStart,
    sourceEnd: t.sourceEnd,
    speed: t.speed,
  }));
  const cuesArg = result.sourceRows.map((row) => ({ start: row.sourceStart, end: row.sourceEnd }));
  const viaTimeline = comparePlans(cuesArg, segsA, segments);
  const direct = comparePlans(cues, segments, segments);
  assert.deepEqual(viaTimeline, direct);
  assert.equal(viaTimeline.diffCueCount, 0);
});

test('方案对照：空输入健壮性', () => {
  const r = comparePlans([], [seg(0, 1000, 1)], [seg(0, 1000, 1)]);
  assert.equal(r.cueCount, 0);
  assert.equal(r.diffCueCount, 0);
  assert.equal(r.totalHalfA, 0);
  const r2 = comparePlans(null, null, undefined);
  assert.equal(r2.cueCount, 0);
  assert.equal(r2.diffHalf, 0);
});

// ---- 随机暴力对照 ----

function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

/** 直接求和：每条段与字幕的半开交集长度 × 倍速单位。 */
function bruteTotalHalf(c, segs) {
  let half = 0;
  for (const s of segs) {
    const lo = Math.max(c.start, s.sourceStart);
    const hi = Math.min(c.end, s.sourceEnd);
    if (lo < hi) half += (hi - lo) * HALF_UNITS_PER_MS[s.speed];
  }
  return half;
}

/** 单位区间 [k, k+1) 上的直接覆盖统计（次数与折算时长）。 */
function bruteUnitMetrics(c, segs, k) {
  let coverage = 0;
  let durHalf = 0;
  for (const s of segs) {
    const lo = Math.max(c.start, s.sourceStart);
    const hi = Math.min(c.end, s.sourceEnd);
    if (lo <= k && k < hi) {
      coverage += 1;
      durHalf += HALF_UNITS_PER_MS[s.speed];
    }
  }
  return { coverage, durHalf };
}

test('方案对照：随机输入与暴力统计一致', () => {
  const rand = lcg(20260926);
  const speeds = [0.5, 1, 2];
  for (let iter = 0; iter < 200; iter++) {
    const cueCount = 1 + Math.floor(rand() * 4);
    const cues = [];
    for (let i = 0; i < cueCount; i++) {
      const start = Math.floor(rand() * 50);
      const end = start + 1 + Math.floor(rand() * 30);
      cues.push(cue(start, end));
    }
    const mkSegs = () => {
      const n = 1 + Math.floor(rand() * 5);
      const out = [];
      for (let i = 0; i < n; i++) {
        const s = Math.floor(rand() * 60);
        out.push(seg(s, s + 1 + Math.floor(rand() * 40), speeds[Math.floor(rand() * 3)]));
      }
      return out;
    };
    const segsA = mkSegs();
    const segsB = mkSegs();
    const r = comparePlans(cues, segsA, segsB);

    let sumA = 0;
    let sumB = 0;
    r.cueRows.forEach((row, i) => {
      const c = cues[i];
      // 每条源字幕总时长 = 逐段直接求和（未命中/重叠/重复均计入）
      const expA = bruteTotalHalf(c, segsA);
      const expB = bruteTotalHalf(c, segsB);
      assert.equal(row.totalHalfA, expA, `iter ${iter} cue ${i} totalHalfA`);
      assert.equal(row.totalHalfB, expB, `iter ${iter} cue ${i} totalHalfB`);
      assert.equal(row.diffHalf, expA - expB);
      sumA += expA;
      sumB += expB;

      // 列出的区间：有序、互不重叠（可首尾相接）、落在字幕区间内，且确实存在差异
      let prevEnd = -1;
      for (const iv of row.intervals) {
        assert.ok(iv.start >= c.start && iv.end <= c.end && iv.start < iv.end);
        assert.ok(iv.start >= prevEnd);
        prevEnd = iv.end;
        assert.ok(iv.coverageA !== iv.coverageB || iv.durHalfA !== iv.durHalfB);
        // 区间数值与直接统计一致（区间内任取一点，覆盖恒定）
        const m = bruteUnitMetrics(c, segsA, iv.start);
        assert.equal(iv.coverageA, m.coverage);
        const mB = bruteUnitMetrics(c, segsB, iv.start);
        assert.equal(iv.coverageB, mB.coverage);
        assert.equal(iv.durHalfA, m.durHalf * (iv.end - iv.start));
        assert.equal(iv.durHalfB, mB.durHalf * (iv.end - iv.start));
      }

      // 完备性：每个单位小区间若有差异，必被某个列出区间覆盖
      for (let k = c.start; k < c.end; k++) {
        const a = bruteUnitMetrics(c, segsA, k);
        const b = bruteUnitMetrics(c, segsB, k);
        const differs = a.coverage !== b.coverage || a.durHalf !== b.durHalf;
        const listed = row.intervals.some((iv) => iv.start <= k && k < iv.end);
        assert.equal(listed, differs, `iter ${iter} cue ${i} unit ${k}`);
      }
      // 整条字幕有净时长差 ⇒ 必有列出区间（反之不必：差异可能相互抵消）
      if (row.diffHalf !== 0) assert.ok(row.intervals.length > 0);
    });

    // 汇总一致
    assert.equal(r.totalHalfA, sumA);
    assert.equal(r.totalHalfB, sumB);
    assert.equal(r.diffHalf, sumA - sumB);
    assert.equal(r.diffCueCount, r.cueRows.filter((x) => x.intervals.length > 0).length);
    assert.equal(r.diffIntervalCount, r.cueRows.reduce((s, x) => s + x.intervals.length, 0));
  }
});
