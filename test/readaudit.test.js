'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RA = require('../src/readaudit');

/** 构造一条输出字幕（remap mappings 字段的最小子集）。 */
function cue(newIndex, start, end, text) {
  return { newIndex, start, end, text };
}

/** 取审计结果中某编号条目的关键字段。 */
function item(r, n) {
  const it = r.items.find((x) => x.newIndex === n);
  assert.ok(it, `缺少输出 #${n}`);
  return it;
}

// ---------- 阅读量计量 ----------

test('阅读量：ASCII 字素簇计 1，其他计 2，空白不计', () => {
  assert.equal(RA.readingDemand('abc'), 3);
  assert.equal(RA.readingDemand('你好'), 4);
  assert.equal(RA.readingDemand('a 你 b'), 1 + 2 + 1); // 空格不计
  assert.equal(RA.readingDemand('a\t你\nb\r\n'), 1 + 2 + 1); // 制表/换行不计
  assert.equal(RA.readingDemand(''), 0);
  assert.equal(RA.readingDemand('   \n\t'), 0);
  assert.equal(RA.readingDemand('，！？'), 6); // 全角标点计 2
  assert.equal(RA.readingDemand('.,!?'), 4); // ASCII 标点计 1
  // emoji（含 ZWJ 组合）按字素簇，每簇 2
  const emojis = ['😀', '👨‍👩‍👧'];
  assert.equal(RA.readingDemand(emojis[0]), 2);
  assert.equal(RA.readingDemand(emojis[1]), 2); // ZWJ 组合是一个字素簇
  assert.equal(RA.readingDemand('a😀你'), 1 + 2 + 2);
});

test('阅读量：组合记号（e + 组合重音）作为一个字素簇，非 ASCII 计 2', () => {
  // 'é' 拆成 e + U+0301 两个码点但只有一个字素簇
  const s = 'é';
  assert.equal(RA.graphemes(s).length, 1);
  assert.equal(RA.readingDemand(s), 2);
});

// ---------- 速度校验 ----------

test('速度校验：仅 1～40 的整数合法', () => {
  for (const v of [1, 2, 20, 40]) assert.ok(RA.isValidSpeed(v));
  for (const v of [0, -1, 41, 1.5, 2.01, NaN, null, undefined, '10', 'abc']) {
    assert.ok(!RA.isValidSpeed(v), `应非法：${v}`);
  }
  assert.throws(() => RA.auditReading([cue(1, 0, 1000, 'a')], 0), /1～40/);
  assert.throws(() => RA.auditReading([cue(1, 0, 1000, 'a')], 41), /1～40/);
});

test('无效时间区间抛错（非正时长 / 非整数）', () => {
  assert.throws(() => RA.auditReading([cue(1, 1000, 1000, 'a')], 10), /无效/);
  assert.throws(() => RA.auditReading([cue(1, 1000, 900, 'a')], 10), /无效/);
});

// ---------- 基本调度 ----------

test('单条字幕：窗口足够则全部读完', () => {
  // 需求 10 单位，速度 10/s → 需要 1000 ms；区间 [0,1000) 恰好够
  const r = RA.auditReading([cue(1, 0, 1000, 'aaaaaaaaaa')], 10);
  assert.equal(item(r, 1).readMilli, 10000);
  assert.equal(item(r, 1).shortfallMilli, 0);
  assert.equal(item(r, 1).completed, true);
  assert.equal(r.firstMissMs, null);
  assert.equal(r.readMs, 1000);
  assert.equal(r.idleMs, 0);
});

test('单条字幕：窗口差 1ms 也产生欠量；半开区间终点不可读', () => {
  // 需求 10，速度 10/s → 需 1000ms；区间 [0,999) 只有 999ms
  const r = RA.auditReading([cue(1, 0, 999, 'aaaaaaaaaa')], 10);
  assert.equal(item(r, 1).readMilli, 9990);
  assert.equal(item(r, 1).shortfallMilli, 10); // 差 0.01 单位
  assert.equal(r.firstMissMs, 999);
  assert.deepEqual(r.missNewIndexes, [1]);
  assert.ok(item(r, 1).firstMiss);
});

test('不足一秒的字幕正确处理（500ms 窗口）', () => {
  // 需求 10，速度 10/s，窗口 500ms → 读 5 单位、欠 5 单位
  const r = RA.auditReading([cue(1, 250, 750, 'aaaaaaaaaa')], 10);
  assert.equal(item(r, 1).readMilli, 5000);
  assert.equal(item(r, 1).shortfallMilli, 5000);
  assert.equal(item(r, 1).durationMs, 500);
  assert.equal(r.firstMissMs, 750);
});

test('空需求字幕（纯空白/空文本）：零需求，立即完成，无欠量', () => {
  const r = RA.auditReading([cue(1, 0, 500, '   \n ')], 10);
  assert.equal(item(r, 1).demandMilli, 0);
  assert.equal(item(r, 1).readMilli, 0);
  assert.equal(item(r, 1).completed, true);
  assert.equal(r.firstMissMs, null);
  assert.equal(r.readMs, 0);
});

test('速度 1/s 与 40/s 边界值；毫单位为整数、无逐毫秒取整', () => {
  // 速度 1，需求 2 单位需 2000ms；区间 1500ms → 读 1.5 单位 = 1500 毫单位
  let r = RA.auditReading([cue(1, 0, 1500, 'aa')], 1);
  assert.equal(item(r, 1).readMilli, 1500);
  assert.equal(item(r, 1).shortfallMilli, 500);
  // 速度 40，需求 40 单位需 1000ms
  r = RA.auditReading([cue(1, 0, 1000, 'a'.repeat(40))], 40);
  assert.equal(item(r, 1).readMilli, 40000);
  assert.equal(item(r, 1).shortfallMilli, 0);
});

// ---------- EDF 与暂停/继续 ----------

test('EDF：不重叠顺序窗口逐条读完，含中间空闲', () => {
  // #1 [0,1000) 需 5；#2 [2000,4000) 需 10。速度 10/s。
  const r = RA.auditReading([
    cue(1, 0, 1000, 'aaaaa'),
    cue(2, 2000, 4000, 'aaaaaaaaaa'),
  ], 10);
  assert.equal(item(r, 1).shortfallMilli, 0);
  assert.equal(item(r, 2).shortfallMilli, 0);
  assert.equal(r.readMs, 1500); // 500 + 1000
  assert.equal(r.horizonMs, 4000);
  // 空闲间隙：#1 在 500 读完到 #2 在 2000 开始，共 1500ms 无可见未读任务
  // （#2 在 3000 读完后到 horizon 末 4000 的尾段不计）
  assert.equal(r.idleMs, 1500);
});

test('EDF：重叠时先读截止更早者，后者可暂停继续并无欠量', () => {
  // 速度 10/s：
  // #1 [0,2000) 需 10（1000ms 读完，截止 2000 更早）
  // #2 [0,3000) 需 15（1500ms）：#1 读的 1000ms 暂停 #2，之后 [1000,3000)
  //    有 2000ms 可读 #2，只需 1500ms → 读完
  const r = RA.auditReading([
    cue(1, 0, 2000, 'a'.repeat(10)),
    cue(2, 0, 3000, 'a'.repeat(15)),
  ], 10);
  assert.equal(item(r, 1).readMilli, 10000);
  assert.equal(item(r, 1).shortfallMilli, 0);
  assert.equal(item(r, 2).readMilli, 15000);
  assert.equal(item(r, 2).shortfallMilli, 0);
  assert.equal(r.firstMissMs, null);
});

test('EDF：为赶早截止暂停晚截止任务，早任务欠量但晚任务仍读完', () => {
  // 速度 10/s：
  // #1 [0,1000) 需 20（最多读 10，欠 10，失约时刻 1000）
  // #2 [0,3000) 需 20（前 1000ms 让给 #1；剩 [1000,3000) 2000ms 读 20 刚好）
  const r = RA.auditReading([
    cue(1, 0, 1000, 'a'.repeat(20)),
    cue(2, 0, 3000, 'a'.repeat(20)),
  ], 10);
  assert.equal(item(r, 1).readMilli, 10000);
  assert.equal(item(r, 1).shortfallMilli, 10000);
  assert.equal(item(r, 2).readMilli, 20000);
  assert.equal(item(r, 2).shortfallMilli, 0);
  assert.equal(r.firstMissMs, 1000);
  assert.deepEqual(r.missNewIndexes, [1]);
});

test('截止时间相同：按输出编号优先（小编号先读）', () => {
  // #1、#2 均 [0,1000)，各需 10，速度 10/s：只有编号小的 #1 读完，#2 全欠
  let r = RA.auditReading([
    cue(1, 0, 1000, 'a'.repeat(10)),
    cue(2, 0, 1000, 'a'.repeat(10)),
  ], 10);
  assert.equal(item(r, 1).shortfallMilli, 0);
  assert.equal(item(r, 2).readMilli, 0);
  assert.equal(item(r, 2).shortfallMilli, 10000);
  // 同时失约：firstMiss 两条都标记
  assert.ok(item(r, 1).firstMiss === false);
  assert.ok(item(r, 2).firstMiss);

  // 输入乱序也按输出编号裁决
  r = RA.auditReading([
    cue(5, 0, 1000, 'a'.repeat(10)),
    cue(3, 0, 1000, 'a'.repeat(10)),
  ], 10);
  assert.equal(item(r, 3).shortfallMilli, 0);
  assert.equal(item(r, 5).shortfallMilli, 10000);
});

test('晚到的更早截止任务抢占当前任务', () => {
  // 速度 10/s：
  // #1 [0,3000) 需 30（3000ms）；#2 [1000,2000) 需 10（1000ms，截止更早）。
  // [0,1000) 读 #1 得 10；[1000,2000) 被 #2 抢占读完；[2000,3000) 继续 #1 再得 10。
  // #1 共 20/30，欠 10（截止 3000）；#2 读完。
  const r = RA.auditReading([
    cue(1, 0, 3000, 'a'.repeat(30)),
    cue(2, 1000, 2000, 'a'.repeat(10)),
  ], 10);
  assert.equal(item(r, 2).readMilli, 10000);
  assert.equal(item(r, 2).shortfallMilli, 0);
  assert.equal(item(r, 1).readMilli, 20000);
  assert.equal(item(r, 1).shortfallMilli, 10000);
  assert.equal(r.firstMissMs, 3000);
});

// ---------- 边界：端点相接 / 重复剪辑 / 零碎片段 ----------

test('端点相接不算重叠：[0,1000) 与 [1000,2000) 各自独立可读', () => {
  // 速度 10/s，各需 10 → 各占满自己的 1000ms，均读完
  const r = RA.auditReading([
    cue(1, 0, 1000, 'a'.repeat(10)),
    cue(2, 1000, 2000, 'a'.repeat(10)),
  ], 10);
  assert.equal(item(r, 1).shortfallMilli, 0);
  assert.equal(item(r, 2).shortfallMilli, 0);
  assert.equal(r.readMs, 2000);
  assert.equal(r.idleMs, 0);
});

test('端点相接且总需求超载：相接点不共享容量', () => {
  // #1 [0,1000) 需 20（欠 10）；#2 [1000,2000) 需 5（读完，只用 500ms）
  const r = RA.auditReading([
    cue(1, 0, 1000, 'a'.repeat(20)),
    cue(2, 1000, 2000, 'a'.repeat(5)),
  ], 10);
  assert.equal(item(r, 1).readMilli, 10000);
  assert.equal(item(r, 1).shortfallMilli, 10000);
  assert.equal(item(r, 2).readMilli, 5000);
  assert.equal(item(r, 2).shortfallMilli, 0);
  assert.equal(r.firstMissMs, 1000);
});

test('重复剪辑：同文同区间的多条输出各自独立计量与调度', () => {
  // 两条完全相同窗口 [0,1000) 各需 10，速度 10/s：#1 读完 #2 全欠
  const r = RA.auditReading([
    cue(1, 0, 1000, '你好'), // 需 4
    cue(2, 0, 1000, '你好'),
  ], 4); // 速度 4/s：恰好够一条
  assert.equal(item(r, 1).demandMilli, 4000);
  assert.equal(item(r, 1).readMilli, 4000);
  assert.equal(item(r, 2).readMilli, 0);
  assert.equal(item(r, 2).shortfallMilli, 4000);
});

test('极短不足一秒且重叠：窗口只有个位数毫秒', () => {
  // #1 [0,5) 需 1；#2 [3,9) 需 1；速度 10/s（10 毫单位/ms）。
  // [0,3) 读 #1 30；[3,5) #1 截止更早继续读 20 → #1 仅得 50/1000，欠 950；
  // [5,9) 读 #2 40 → 欠 960。
  const r = RA.auditReading([
    cue(1, 0, 5, 'a'),
    cue(2, 3, 9, 'a'),
  ], 10);
  assert.equal(item(r, 1).readMilli, 50);
  assert.equal(item(r, 1).shortfallMilli, 950);
  assert.equal(item(r, 2).readMilli, 40);
  assert.equal(item(r, 2).shortfallMilli, 960);
  assert.equal(r.firstMissMs, 5);
});

// ---------- 汇总 ----------

test('汇总字段：总需求/已读/欠量与失约编号', () => {
  const r = RA.auditReading([
    cue(1, 0, 1000, 'a'.repeat(20)), // 读 10 欠 10
    cue(2, 0, 3000, 'b'.repeat(10)), // #1 占前 1000ms；#2 截止晚，在 [1000,3000) 读完
  ], 10);
  assert.equal(r.cueCount, 2);
  assert.equal(r.totalDemandMilli, 30000);
  assert.equal(r.totalReadMilli, 20000);
  assert.equal(r.totalShortfallMilli, 10000);
  assert.equal(r.firstMissMs, 1000);
  assert.deepEqual(r.missNewIndexes, [1]);
  assert.equal(item(r, 1).firstMiss, true);
  assert.equal(item(r, 2).firstMiss, false);
});

test('多条欠量：最早失约时刻取最早截止，同刻多号都标记', () => {
  const r = RA.auditReading([
    cue(1, 0, 2000, 'a'.repeat(100)),
    cue(2, 0, 1000, 'b'.repeat(100)),
    cue(3, 0, 1000, 'c'.repeat(100)),
  ], 10);
  // #2 编号最小且截止 1000，占满 [0,1000)；#3 在 1000 全欠；#1 在 2000 欠
  assert.equal(r.firstMissMs, 1000);
  assert.deepEqual(r.missNewIndexes, [2, 3, 1]); // 按 (截止, 编号)
  assert.equal(item(r, 2).readMilli, 10000);
  assert.equal(item(r, 3).readMilli, 0);
  assert.ok(item(r, 2).firstMiss);
  assert.ok(item(r, 3).firstMiss);
  assert.ok(!item(r, 1).firstMiss);
});

test('空输入：零条字幕', () => {
  const r = RA.auditReading([], 10);
  assert.equal(r.cueCount, 0);
  assert.equal(r.totalDemandMilli, 0);
  assert.equal(r.firstMissMs, null);
  assert.deepEqual(r.missNewIndexes, []);
});

// ---------- formatMilli ----------

test('formatMilli：毫单位三位小数，不补抓、不取整', () => {
  assert.equal(RA.formatMilli(0), '0.000');
  assert.equal(RA.formatMilli(1000), '1.000');
  assert.equal(RA.formatMilli(1500), '1.500');
  assert.equal(RA.formatMilli(10), '0.010');
  assert.equal(RA.formatMilli(12345), '12.345');
});

// ---------- 随机暴力对照：毫秒级参考实现 ----------

/**
 * 参考调度：连续时间 EDF，整数毫单位、不逐毫秒取整。
 * 在相邻“起点/截止”事件之间，可见任务集合与优先级顺序不变；整数毫秒
 * 长度 dt 的容量 speed·dt（整数毫单位）按 (end,newIndex) 顺序依次填满各任务
 * （读完一个继续下一个——可暂停/继续的单读者）；容量与需求都是整数毫单位，
 * 切分不产生取整误差。到期任务在区间终点即移出（半开）。
 */
function referenceAudit(mappings, speed) {
  const jobs = mappings.map((m) => ({
    newIndex: m.newIndex, start: m.start, end: m.end,
    remaining: RA.readingDemand(m.text) * 1000, read: 0,
  }));
  const events = Array.from(new Set(
    jobs.flatMap((j) => (j.remaining > 0 ? [j.start, j.end] : [])),
  )).sort((a, b) => a - b);

  for (let k = 0; k + 1 < events.length; k += 1) {
    const t0 = events[k];
    const t1 = events[k + 1];
    const dt = t1 - t0;
    if (dt <= 0) continue;
    // 本区间可见（半开：start ≤ t0 且 t1 ≤ end）且未读完，按 EDF 排序
    const vis = jobs
      .filter((j) => j.remaining > 0 && j.start <= t0 && t1 <= j.end)
      .sort((a, b) => (a.end - b.end) || (a.newIndex - b.newIndex));
    let cap = speed * dt;
    for (const j of vis) {
      if (cap <= 0) break;
      const amt = Math.min(cap, j.remaining);
      j.read += amt;
      j.remaining -= amt;
      cap -= amt;
    }
  }
  return jobs.map((j) => ({
    newIndex: j.newIndex, readMilli: j.read, shortfallMilli: j.remaining,
  })).sort((a, b) => a.newIndex - b.newIndex);
}

/** 简易可复现随机数（LCG）。 */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('随机对照：事件扫描与逐毫秒参考实现在大量实例上完全一致', () => {
  const rng = makeRng(20260926);
  for (let iter = 0; iter < 400; iter += 1) {
    const n = 1 + Math.floor(rng() * 6);
    const speed = 1 + Math.floor(rng() * 40);
    const mappings = [];
    for (let i = 1; i <= n; i += 1) {
      const a = Math.floor(rng() * 1000);
      const len = 1 + Math.floor(rng() * 800); // 含不足一秒
      const chars = rng() < 0.5
        ? 'a'.repeat(1 + Math.floor(rng() * 40))
        : '你好世界abc！';
      const text = chars.slice(0, 1 + Math.floor(rng() * chars.length));
      mappings.push(cue(i, a, a + len, text));
    }
    // 同截止注入
    if (rng() < 0.3 && mappings.length >= 2) {
      mappings[1].start = mappings[0].start;
      mappings[1].end = mappings[0].end;
    }
    const got = RA.auditReading(mappings, speed).items
      .map((it) => ({ newIndex: it.newIndex, readMilli: it.readMilli, shortfallMilli: it.shortfallMilli }));
    const want = referenceAudit(mappings, speed);
    assert.deepEqual(got, want, `iter=${iter} speed=${speed}`);
  }
});

test('守恒：已读 + 欠量 = 需求；已读/欠量均为整数毫单位；阅读毫秒 × 速度 = 总已读量', () => {
  const rng = makeRng(7);
  const mappings = [];
  for (let i = 1; i <= 12; i += 1) {
    const a = Math.floor(rng() * 2000);
    mappings.push(cue(i, a, a + 1 + Math.floor(rng() * 1200),
      rng() < 0.5 ? 'a'.repeat(1 + Math.floor(rng() * 30)) : '你好abc'));
  }
  const speed = 3 + Math.floor(rng() * 20);
  const r = RA.auditReading(mappings, speed);
  for (const it of r.items) {
    assert.equal(it.readMilli + it.shortfallMilli, it.demandMilli);
    // 以整数记录千分之一单位，不逐毫秒取整
    assert.ok(Number.isInteger(it.readMilli));
    assert.ok(Number.isInteger(it.shortfallMilli));
  }
  assert.equal(r.totalReadMilli + r.totalShortfallMilli, r.totalDemandMilli);
  // 连续时间下 readMs 可为分数毫秒，但容量乘积恒等于整数总已读量
  assert.ok(Math.abs(r.readMs * speed - r.totalReadMilli) < 1e-9);
});
