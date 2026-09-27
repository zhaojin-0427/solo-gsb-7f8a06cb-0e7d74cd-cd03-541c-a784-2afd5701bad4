'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Avoid = require('../src/avoid');
const { remap } = require('../src/remap');
const { serializeSrt, parseSrt } = require('../src/srt');

/** 构造一条重排输出（remap mappings 字段的最小子集）。 */
function pm(newIndex, segOrder, start, end, text = `t${newIndex}`) {
  return { newIndex, segOrder, start, end, cueIndex: newIndex - 1, seq: newIndex, text };
}
/** 构造剪辑段时间轴（取整后的输出区间）。 */
function tl(outStart, outEnd) {
  return { outStart, outEnd };
}

test('避让参数校验：整数与范围', () => {
  assert.equal(Avoid.validateParams(0, 0).ok, true);
  assert.equal(Avoid.validateParams(500, 1000).ok, true);
  assert.equal(Avoid.validateParams(-1, 0).ok, false);
  assert.equal(Avoid.validateParams(501, 0).ok, false);
  assert.equal(Avoid.validateParams(0, 1001).ok, false);
  assert.equal(Avoid.validateParams(0, -5).ok, false);
  assert.equal(Avoid.validateParams(1.5, 0).ok, false);
  assert.equal(Avoid.validateParams(0, NaN).ok, false);
});

test('避让：空输出与超 200 条上限', () => {
  const empty = Avoid.computeAvoidance([], [], 0, 100);
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'empty');

  const many = [];
  for (let i = 0; i < 201; i++) many.push(pm(i + 1, 0, i * 2000, i * 2000 + 1000));
  const r = Avoid.computeAvoidance(many, [tl(0, 10 ** 9)], 0, 100);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'too-many');
  assert.equal(r.count, 201);
  assert.match(r.message, /200/);

  // 恰好 200 条可以计算
  const ok = Avoid.computeAvoidance(many.slice(0, 200), [tl(0, 10 ** 9)], 0, 100);
  assert.equal(ok.ok, true);
  assert.equal(ok.items.length, 200);
});

test('避让：原本已满足间隔时全部不动（总平移 0）', () => {
  const mappings = [pm(1, 0, 0, 1000), pm(2, 0, 1500, 2500), pm(3, 0, 3000, 4000)];
  const r = Avoid.computeAvoidance(mappings, [tl(0, 5000)], 500, 1000);
  assert.equal(r.ok, true);
  assert.equal(r.totalAbsShift, 0);
  assert.equal(r.shiftedCount, 0);
  assert.deepEqual(r.items.map((it) => [it.newStart, it.newEnd]),
    [[0, 1000], [1500, 2500], [3000, 4000]]);
});

test('避让：重叠字幕整体后移，时长与顺序保持', () => {
  // 两条同起点（重复段常见），间隔 0（允许首尾相接）：第二条须后移 1000
  const mappings = [pm(1, 0, 0, 1000), pm(2, 0, 0, 1000)];
  const r = Avoid.computeAvoidance(mappings, [tl(0, 5000)], 0, 1000);
  assert.equal(r.ok, true);
  assert.deepEqual(r.items.map((it) => [it.newStart, it.newEnd, it.shift]),
    [[0, 1000, 0], [1000, 2000, 1000]]);
  assert.equal(r.totalAbsShift, 1000);
  // 间隔恰好 0（首尾相接）
  assert.equal(r.items[1].newStart - r.items[0].newEnd, 0);
});

test('避让：允许前移（负平移），同分时字典序最小优先前移靠前条目', () => {
  // 两条 [1000,2000) [2000,3000)，间隔 500，段区间 [0,5000]，上限 1000
  // 缺口 500：#1 前移 500（s1=500）或 #2 后移 500（s2=2500）或分摊，代价均 500；
  // 字典序最小的新起点序列是 (500, 2000)：#1 前移、#2 不动
  const mappings = [pm(1, 0, 1000, 2000), pm(2, 0, 2000, 3000)];
  const r = Avoid.computeAvoidance(mappings, [tl(0, 5000)], 500, 1000);
  assert.equal(r.ok, true);
  assert.equal(r.totalAbsShift, 500);
  assert.deepEqual(r.items.map((it) => [it.newStart, it.shift]),
    [[500, -500], [2000, 0]]);
  // 新起点不得越出段区间下界
  assert.ok(r.items[0].newStart >= 0);
});

test('避让：新起止不得越出所属剪辑段取整后的输出区间', () => {
  // #1 在段0 尾部 [1000,1900)（段0 输出 [0,2000]），#2 在段1 头部 [2000,2200)
  // （段1 输出 [2000,4000]）；间隔 500，缺口 400：
  // #1 前移 400 → [600,1500)（不越段0 下界），#2 不动；或 #2 后移 400，代价同 400；
  // 字典序最小取 (600, 2000)
  const mappings = [pm(1, 0, 1000, 1900), pm(2, 1, 2000, 2200)];
  const timeline = [tl(0, 2000), tl(2000, 4000)];
  const r = Avoid.computeAvoidance(mappings, timeline, 500, 1000);
  assert.equal(r.ok, true);
  assert.equal(r.totalAbsShift, 400);
  assert.deepEqual(r.items.map((it) => [it.newStart, it.newEnd]),
    [[600, 1500], [2000, 2200]]);
  for (const it of r.items) {
    const t = timeline[it.segOrder];
    assert.ok(it.newStart >= t.outStart && it.newEnd <= t.outEnd);
  }
});

test('避让：平移量不得超过上限', () => {
  const mappings = [pm(1, 0, 0, 300), pm(2, 0, 0, 300)];
  // 间隔 200：第二条需后移 500，上限 200 → 无解（最短不可行前缀末条 #2）
  const bad = Avoid.computeAvoidance(mappings, [tl(0, 5000)], 200, 200);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'infeasible');
  assert.equal(bad.failNewIndex, 2);
  // 上限 500：恰好可行，位移不超过上限
  const ok = Avoid.computeAvoidance(mappings, [tl(0, 5000)], 200, 500);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.items.map((it) => [it.newStart, it.shift]), [[0, 0], [500, 500]]);
  assert.ok(ok.items.every((it) => Math.abs(it.shift) <= 500));
});

test('避让：无解时指出最短不可行前缀的末条输出编号', () => {
  // 三条同起点 [0,400)，间隔 300：s2 ≥ 700，s3 ≥ 1400
  const mappings = [pm(1, 0, 0, 400), pm(2, 0, 0, 400), pm(3, 0, 0, 400)];
  // 上限 600：前 1 条可行，前 2 条不可行（s2 ≤ 600 < 700）
  const r2 = Avoid.computeAvoidance(mappings, [tl(0, 9000)], 300, 600);
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'infeasible');
  assert.equal(r2.failNewIndex, 2);
  assert.equal(r2.failPosition, 2);
  // 上限 1000：前 2 条可行（s2 = 700），前 3 条不可行（s3 ≥ 1400 > 1000）
  const r3 = Avoid.computeAvoidance(mappings, [tl(0, 9000)], 300, 1000);
  assert.equal(r3.ok, false);
  assert.equal(r3.failNewIndex, 3);
  assert.equal(r3.failPosition, 3);
});

test('避让：跨剪辑段相邻同样须满足间隔', () => {
  // #1 在段0 尾部 [900,2000)（段0 [0,2000]，时长 1100），#2 在段1 头部
  // [2000,2100)（段1 [2000,4000]）；间隔 300，缺口 300：
  // #1 前移 300（s1=600）或 #2 后移 300（s2=2300）或分摊，代价均 300；
  // 字典序最小取 (600, 2000)：#1 前移、#2 不动
  const mappings = [pm(1, 0, 900, 2000), pm(2, 1, 2000, 2100)];
  const timeline = [tl(0, 2000), tl(2000, 4000)];
  const r = Avoid.computeAvoidance(mappings, timeline, 300, 1000);
  assert.equal(r.ok, true);
  assert.equal(r.totalAbsShift, 300);
  assert.deepEqual(r.items.map((it) => [it.newStart, it.newEnd]),
    [[600, 1700], [2000, 2100]]);
  assert.ok(r.items[1].newStart - r.items[0].newEnd >= 300);
});

test('避让：同分时取新起点序列字典序最小（前移优先于后移）', () => {
  // 两条 [1000,2000) [2000,3000)，间隔 200，段区间 [0,5000]，上限 1000
  // 缺口 200。可行最优（总 200）的分配有：
  //   #1 前移 200 → (800, 2000)；#2 后移 200 → (1000, 2200)；各 100 → (900, 2100)
  // 字典序最小的新起点序列是 (800, 2000)：#1 前移、#2 不动
  const mappings = [pm(1, 0, 1000, 2000), pm(2, 0, 2000, 3000)];
  const r = Avoid.computeAvoidance(mappings, [tl(0, 5000)], 200, 1000);
  assert.equal(r.ok, true);
  assert.equal(r.totalAbsShift, 200);
  assert.deepEqual(r.items.map((it) => it.newStart), [800, 2000]);
});

test('避让：时长、编号、正文与来源对应关系保持', () => {
  const mappings = [
    pm(1, 0, 0, 300, '正文一'),
    pm(2, 0, 0, 300, '正文二\n第二行'),
    pm(3, 0, 5000, 5300, '正文三'),
  ];
  const r = Avoid.computeAvoidance(mappings, [tl(0, 9000)], 100, 1000);
  assert.equal(r.ok, true);
  r.items.forEach((it, i) => {
    assert.equal(it.newEnd - it.newStart, mappings[i].end - mappings[i].start); // 时长不变
    assert.equal(it.newIndex, mappings[i].newIndex); // 编号对应不变
  });
  // 原有顺序保持（间隔 ≥ 0 隐含起点单调）
  for (let i = 1; i < r.items.length; i++) {
    assert.ok(r.items[i].newStart >= r.items[i - 1].newEnd);
  }
  // 避让版条目正文取未排版原文
  const entries = Avoid.buildAvoidedEntries(mappings, r);
  assert.deepEqual(entries.map((e) => e.text), ['正文一', '正文二\n第二行', '正文三']);
  assert.deepEqual(entries.map((e) => [e.start, e.end]),
    r.items.map((it) => [it.newStart, it.newEnd]));
});

test('避让 + remap 串联：避让版 SRT 可解析且编号顺序一致', () => {
  const cue = (seq, start, end, text) =>
    ({ index: seq - 1, seq, seqText: String(seq), start, end, text, startLine: 1, endLine: 1 });
  const seg = (order, sourceStart, sourceEnd, speed) =>
    ({ order, line: order + 1, raw: '', sourceStart, sourceEnd, speed });
  // 重复段 + 段内重叠字幕：cue3 与 cue1 输出重叠，避让后须拉开间隔
  const cues = [
    cue(1, 0, 1000, '第一句'),
    cue(2, 2000, 3000, '第二句'),
    cue(3, 500, 1500, '第三句'),
  ];
  const segs = [seg(0, 0, 5000, 1), seg(1, 0, 5000, 1)];
  const remapped = remap(cues, segs);
  assert.equal(remapped.mappings.length, 6);
  const r = Avoid.computeAvoidance(remapped.mappings, remapped.timeline, 200, 1000);
  assert.equal(r.ok, true);
  // 校验全部约束
  for (const it of r.items) {
    const t = remapped.timeline[it.segOrder];
    assert.ok(Math.abs(it.shift) <= 1000);
    assert.ok(it.newStart >= t.outStart && it.newEnd <= t.outEnd);
  }
  for (let i = 1; i < r.items.length; i++) {
    assert.ok(r.items[i].newStart - r.items[i - 1].newEnd >= 200);
  }
  assert.ok(r.totalAbsShift > 0); // 确实有平移发生
  const srt = serializeSrt(Avoid.buildAvoidedEntries(remapped.mappings, r));
  const { cues: parsed, errors } = parseSrt(srt);
  assert.equal(errors.length, 0);
  assert.equal(parsed.length, remapped.mappings.length);
  parsed.forEach((c, i) => {
    assert.equal(c.seq, i + 1);
    assert.equal(c.start, r.items[i].newStart);
    assert.equal(c.end, r.items[i].newEnd);
    assert.equal(c.text, remapped.mappings[i].text);
  });
});

// ---------- 暴力枚举对照 ----------

function lexLess(x, y) {
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return x[i] < y[i];
  }
  return false;
}

/** 暴力枚举全部可行排程，返回 { cost, starts }（总平移最小、同分字典序最小）；无解返回 null。 */
function bruteForce(a, dur, lo, hi, gap) {
  const n = a.length;
  const cur = new Array(n);
  let best = null;
  (function dfs(i, bound, cost) {
    if (best && cost >= best.cost) return; // 平移绝对值非负，剪枝
    if (i === n) {
      if (!best || cost < best.cost || (cost === best.cost && lexLess(cur, best.starts))) {
        best = { cost, starts: cur.slice() };
      }
      return;
    }
    for (let s = Math.max(lo[i], bound); s <= hi[i]; s++) {
      cur[i] = s;
      dfs(i + 1, s + dur[i] + gap, cost + Math.abs(s - a[i]));
    }
  })(0, -Infinity, 0);
  return best;
}

/** 简单确定性伪随机（可复现）。 */
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

test('避让：随机小案例与暴力枚举对照（最优总平移 + 字典序）', () => {
  const rand = mulberry32(20260926);
  const ri = (n) => Math.floor(rand() * n);

  for (let round = 0; round < 300; round++) {
    const n = 1 + ri(5); // 1～5 条
    const segCount = 1 + ri(2); // 1～2 段
    // 随机段输出区间（升序拼接）
    const timeline = [];
    let cursor = 0;
    for (let s = 0; s < segCount; s++) {
      const len = 4 + ri(30);
      timeline.push(tl(cursor, cursor + len));
      cursor += len;
    }
    const mappings = [];
    for (let i = 0; i < n; i++) {
      const segOrder = ri(segCount);
      const t = timeline[segOrder];
      const span = t.outEnd - t.outStart;
      const d = 1 + ri(Math.max(1, Math.min(8, span - 1)));
      const start = t.outStart + ri(Math.max(1, span - d + 1));
      mappings.push(pm(i + 1, segOrder, start, start + d));
    }
    // 按 remap 的输出排序规则排序并重编号
    mappings.sort((x, y) => (x.start - y.start) || (x.segOrder - y.segOrder) || (x.cueIndex - y.cueIndex));
    mappings.forEach((m, i) => { m.newIndex = i + 1; });

    const gap = ri(4);
    const maxShift = ri(6);
    const r = Avoid.computeAvoidance(mappings, timeline, gap, maxShift);

    const a = mappings.map((m) => m.start);
    const dur = mappings.map((m) => m.end - m.start);
    const lo = mappings.map((m) => Math.max(m.start - maxShift, timeline[m.segOrder].outStart));
    const hi = mappings.map((m) => Math.min(m.start + maxShift, timeline[m.segOrder].outEnd - (m.end - m.start)));
    const bf = bruteForce(a, dur, lo, hi, gap);

    if (bf === null) {
      assert.equal(r.ok, false, `第 ${round} 轮应无解`);
      assert.equal(r.code, 'infeasible');
      // 最短不可行前缀：暴力确认前 k-1 可行、前 k 不可行
      const k = r.failPosition;
      const preOk = bruteForce(a.slice(0, k - 1), dur.slice(0, k - 1),
        lo.slice(0, k - 1), hi.slice(0, k - 1), gap);
      const preBad = bruteForce(a.slice(0, k), dur.slice(0, k),
        lo.slice(0, k), hi.slice(0, k), gap);
      assert.ok(preOk !== null, `第 ${round} 轮：前 ${k - 1} 条应可行`);
      assert.ok(preBad === null, `第 ${round} 轮：前 ${k} 条应不可行`);
      assert.equal(r.failNewIndex, mappings[k - 1].newIndex);
      continue;
    }

    assert.equal(r.ok, true, `第 ${round} 轮应有解`);
    assert.equal(r.totalAbsShift, bf.cost, `第 ${round} 轮总平移应与暴力一致`);
    assert.deepEqual(r.items.map((it) => it.newStart), bf.starts,
      `第 ${round} 轮新起点序列应为字典序最小`);
    // 约束校验
    r.items.forEach((it, i) => {
      assert.ok(Math.abs(it.shift) <= maxShift);
      assert.ok(it.newStart >= lo[i] && it.newStart <= hi[i]);
      assert.equal(it.newEnd - it.newStart, dur[i]);
    });
    for (let i = 1; i < n; i++) {
      assert.ok(r.items[i].newStart - r.items[i - 1].newEnd >= gap);
    }
  }
});

test('避让：大窗口性能冒烟（200 条 × 上限 1000）', () => {
  const mappings = [];
  for (let i = 0; i < 200; i++) {
    mappings.push(pm(i + 1, 0, i * 1500, i * 1500 + 1200));
  }
  const t0 = Date.now();
  const r = Avoid.computeAvoidance(mappings, [tl(0, 200 * 1500 + 1000)], 100, 1000);
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, true);
  assert.equal(r.totalAbsShift, 0); // 原本间隔 300 ≥ 100，无需平移
  assert.ok(elapsed < 2000, `耗时应远小于 2s，实际 ${elapsed}ms`);
});
