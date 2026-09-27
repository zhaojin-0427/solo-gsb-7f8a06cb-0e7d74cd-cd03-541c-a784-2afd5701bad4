'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Sync = require('../src/sync');
const { remap } = require('../src/remap');
const { serializeSrt, parseSrt } = require('../src/srt');

/** 构造一条重排输出（remap mappings 字段的最小子集）。 */
function pm(newIndex, segOrder, start, end, text = `t${newIndex}`) {
  return { newIndex, segOrder, start, end, cueIndex: newIndex - 1, seq: newIndex, text };
}
/** 构造锚点（parseAnchors 输出字段的最小子集）。 */
function ak(oldMs, newMs) {
  return { oldMs, newMs, line: 0 };
}

// ---------- 锚点解析 ----------

test('锚点解析：合法输入（注释/空行/逗号/CRLF/混用分隔符）', () => {
  const { anchors, errors } = Sync.parseAnchors(
    '# 旧ms 新ms\n'
    + '0 100        # 片头对齐\n'
    + '\n'
    + '1000, 1500\r\n'
    + '2000\t2500\n'
    + '3000 , 3600\n',
  );
  assert.equal(errors.length, 0);
  assert.deepEqual(anchors, [
    { oldMs: 0, newMs: 100, line: 2 },
    { oldMs: 1000, newMs: 1500, line: 4 },
    { oldMs: 2000, newMs: 2500, line: 5 },
    { oldMs: 3000, newMs: 3600, line: 6 },
  ]);
});

test('锚点解析：字段数错误指出行号', () => {
  const { errors } = Sync.parseAnchors('0 100\n1000\n2000 2500 99\n');
  assert.equal(errors.length, 2);
  assert.equal(errors[0].line, 2);
  assert.match(errors[0].message, /第 2 行/);
  assert.match(errors[0].message, /应有 2 个字段/);
  assert.equal(errors[1].line, 3);
  assert.match(errors[1].message, /实际 3 个/);
});

test('锚点解析：非整数与负数指出行号与列', () => {
  const r1 = Sync.parseAnchors('0 100\nabc 200\n');
  assert.equal(r1.errors.length, 1);
  assert.equal(r1.errors[0].line, 2);
  assert.match(r1.errors[0].message, /旧毫秒必须是整数/);

  const r2 = Sync.parseAnchors('0 100\n100 1.5\n');
  assert.equal(r2.errors.length, 1);
  assert.match(r2.errors[0].message, /新毫秒必须是整数/);

  const r3 = Sync.parseAnchors('0 100\n-5 200\n');
  assert.equal(r3.errors.length, 1);
  assert.equal(r3.errors[0].line, 2);
  assert.match(r3.errors[0].message, /旧毫秒不能为负数/);

  const r4 = Sync.parseAnchors('0 100\n100 -1\n');
  assert.equal(r4.errors.length, 1);
  assert.match(r4.errors[0].message, /新毫秒不能为负数/);
});

test('锚点解析：两列均须严格递增（相等或倒退均报错并指出行号）', () => {
  // 旧列倒退
  const r1 = Sync.parseAnchors('0 100\n1000 1500\n500 2000\n');
  assert.equal(r1.errors.length, 1);
  assert.equal(r1.errors[0].line, 3);
  assert.match(r1.errors[0].message, /第 3 行/);
  assert.match(r1.errors[0].message, /旧毫秒（500）必须大于前一锚点的旧毫秒（1000，第 2 行）/);
  // 旧列相等也不算严格递增
  const r2 = Sync.parseAnchors('0 100\n0 200\n');
  assert.equal(r2.errors.length, 1);
  assert.equal(r2.errors[0].line, 2);
  assert.match(r2.errors[0].message, /旧毫秒（0）必须大于/);
  // 新列倒退
  const r3 = Sync.parseAnchors('0 500\n1000 400\n');
  assert.equal(r3.errors.length, 1);
  assert.equal(r3.errors[0].line, 2);
  assert.match(r3.errors[0].message, /新毫秒（400）必须大于前一锚点的新毫秒（500，第 1 行）/);
  // 新列相等
  const r4 = Sync.parseAnchors('0 100\n1000 100\n');
  assert.equal(r4.errors.length, 1);
  assert.match(r4.errors[0].message, /新毫秒（100）必须大于/);
});

test('锚点解析：非法行被跳过，后续行与最近合法锚点比较', () => {
  const { anchors, errors } = Sync.parseAnchors(
    '0 0\n'
    + '50 x\n' // 第 2 行格式错误，跳过
    + '100 100\n'
    + '80 200\n' // 旧毫秒 80 ≤ 100（最近合法锚点），报错并跳过
    + '150 300\n', // 与 (100,100) 比较，合法
  );
  assert.equal(errors.length, 2);
  assert.equal(errors[0].line, 2);
  assert.equal(errors[1].line, 4);
  assert.match(errors[1].message, /旧毫秒（80）必须大于前一锚点的旧毫秒（100，第 3 行）/);
  assert.deepEqual(anchors.map((a) => [a.oldMs, a.newMs, a.line]),
    [[0, 0, 1], [100, 100, 3], [150, 300, 5]]);
});

test('锚点解析：总数须为 2～10 个', () => {
  const empty = Sync.parseAnchors('   \n# 只有注释\n');
  assert.equal(empty.errors.length, 1);
  assert.equal(empty.errors[0].line, 0);
  assert.match(empty.errors[0].message, /至少需要 2 个同步锚点（当前 0 个/);

  const one = Sync.parseAnchors('0 100\n');
  assert.equal(one.errors.length, 1);
  assert.match(one.errors[0].message, /至少需要 2 个同步锚点（当前 1 个/);

  const two = Sync.parseAnchors('0 100\n1000 2000\n');
  assert.equal(two.errors.length, 0);
  assert.equal(two.anchors.length, 2);

  const ten = Sync.parseAnchors(
    Array.from({ length: 10 }, (_, i) => `${i * 1000} ${i * 1000 + 50}`).join('\n'));
  assert.equal(ten.errors.length, 0);
  assert.equal(ten.anchors.length, 10);

  const eleven = Sync.parseAnchors(
    Array.from({ length: 11 }, (_, i) => `${i * 1000} ${i * 1000 + 50}`).join('\n'));
  assert.equal(eleven.errors.length, 1);
  assert.equal(eleven.errors[0].line, 0);
  assert.match(eleven.errors[0].message, /最多 10 个（当前 11 个）/);
});

test('锚点解析：超出安全整数范围时报错（不静默丢失精度）', () => {
  const { errors } = Sync.parseAnchors('0 0\n9007199254740993 1\n');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 2);
  assert.match(errors[0].message, /旧毫秒过大/);
});

// ---------- 精确映射与四舍五入 ----------

test('映射：首锚点之前与末锚点之后沿用最近锚点的固定偏移', () => {
  const anchors = [ak(100, 50), ak(200, 200)];
  // 首锚点偏移 = 50 − 100 = −50
  assert.deepEqual(Sync.mapTimeExact(anchors, 30), { num: -20n, den: 1n });
  assert.equal(Sync.mapTime(anchors, 30), -20);
  assert.equal(Sync.mapTime(anchors, 100), 50); // 首锚点处
  // 末锚点偏移 = 200 − 200 = 0
  assert.equal(Sync.mapTime(anchors, 200), 200); // 末锚点处
  assert.deepEqual(Sync.mapTimeExact(anchors, 250), { num: 250n, den: 1n });
  assert.equal(Sync.mapTime(anchors, 250), 250);
});

test('映射：相邻锚点间按线性比例映射，锚点处两侧一致', () => {
  const anchors = [ak(0, 0), ak(10, 5)];
  // 斜率 1/2：t=5 → 2.5（精确 25/10，不先取整）
  assert.deepEqual(Sync.mapTimeExact(anchors, 5), { num: 25n, den: 10n });
  assert.equal(Sync.mapTime(anchors, 5), 3); // 2.5 → 0.5 向上 → 3
  assert.equal(Sync.mapTime(anchors, 3), 2); // 1.5 → 2
  assert.equal(Sync.mapTime(anchors, 7), 4); // 3.5 → 4
  assert.equal(Sync.mapTime(anchors, 0), 0); // 锚点
  assert.equal(Sync.mapTime(anchors, 10), 5); // 锚点
  // 三锚点：两段斜率不同，连接处一致
  const a3 = [ak(0, 0), ak(1000, 2000), ak(3000, 4000)];
  assert.equal(Sync.mapTime(a3, 1000), 2000);
  assert.equal(Sync.mapTime(a3, 500), 1000); // 前段斜率 2
  assert.equal(Sync.mapTime(a3, 2000), 3000); // 后段斜率 1
});

test('映射：全程整数分子/分母，超出 2^53 的分子仍精确', () => {
  // 斜率 1/3：t = 1e14 → 精确 1e28/3e14 = 33333333333333.33…
  const anchors = [ak(0, 0), ak(300000000000000, 100000000000000)];
  const exact = Sync.mapTimeExact(anchors, 100000000000000);
  assert.equal(exact.num, 10000000000000000000000000000n); // 1e28，Number 无法精确表示
  assert.equal(exact.den, 300000000000000n);
  assert.equal(Sync.roundHalfUp(exact.num, exact.den), 33333333333333);
});

test('四舍五入：0.5 向上，负数同样成立', () => {
  assert.equal(Sync.roundHalfUp(1n, 2n), 1); // 0.5 → 1
  assert.equal(Sync.roundHalfUp(3n, 2n), 2); // 1.5 → 2
  assert.equal(Sync.roundHalfUp(5n, 2n), 3); // 2.5 → 3
  assert.equal(Sync.roundHalfUp(1n, 3n), 0); // 0.33… → 0
  assert.equal(Sync.roundHalfUp(2n, 3n), 1); // 0.66… → 1
  assert.equal(Sync.roundHalfUp(0n, 7n), 0);
  assert.equal(Sync.roundHalfUp(-1n, 2n), 0); // −0.5 → 0（与 halfToMsRound 一致）
  assert.equal(Sync.roundHalfUp(-3n, 2n), -1); // −1.5 → −1
  assert.equal(Sync.roundHalfUp(-5n, 2n), -2); // −2.5 → −2
  assert.equal(Sync.roundHalfUp(-7n, 4n), -2); // −1.75 → −2
  assert.equal(Sync.roundHalfUp(-1n, 3n), 0); // −0.33… → 0
});

// ---------- 逐条校准 ----------

test('校准：逐条映射起止，编号/顺序/正文/来源对应关系不变', () => {
  const mappings = [
    pm(1, 0, 0, 1000, '正文一'),
    pm(2, 0, 2000, 3000, '正文二\n第二行'),
    pm(3, 1, 4000, 4500, '正文三'),
  ];
  // 区间内斜率 1/2：f(t) = 100 + t/2（t ≤ 4000）；末锚点后偏移 2100 − 4000 = −1900
  const anchors = [ak(0, 100), ak(4000, 2100)];
  const r = Sync.computeSync(mappings, anchors);
  assert.equal(r.ok, true);
  assert.equal(r.exportable, true);
  assert.equal(r.problems.length, 0);
  assert.equal(r.anchorCount, 2);
  assert.deepEqual(r.items.map((it) => [it.newIndex, it.newStart, it.newEnd]),
    [[1, 100, 600], [2, 1100, 1600], [3, 2100, 2600]]);
  // 偏移量（起点/终点分别记录）
  assert.deepEqual(r.items.map((it) => [it.shiftStart, it.shiftEnd]),
    [[100, -400], [-900, -1400], [-1900, -1900]]);
  // 编号与顺序保持
  assert.deepEqual(r.items.map((it) => it.newIndex), [1, 2, 3]);
  // 校准版条目：正文取未排版原文，顺序不变
  const entries = Sync.buildSyncedEntries(mappings, r);
  assert.deepEqual(entries.map((e) => e.text), ['正文一', '正文二\n第二行', '正文三']);
  assert.deepEqual(entries.map((e) => [e.start, e.end]),
    [[100, 600], [1100, 1600], [2100, 2600]]);
});

test('校准：出现负时刻时指出输出编号并禁止导出（主结果不受影响）', () => {
  const mappings = [pm(1, 0, 0, 50), pm(2, 0, 200, 300), pm(3, 0, 900, 950)];
  // 首锚点偏移 −100：#1 [0,50) → [−100,−50) 负时刻；#2 → [100,200)；#3 → [800,850)
  const anchors = [ak(100, 0), ak(1000, 900)];
  const r = Sync.computeSync(mappings, anchors);
  assert.equal(r.ok, true);
  assert.equal(r.exportable, false);
  assert.deepEqual(r.problems, [{ newIndex: 1, kind: 'negative' }]);
  assert.match(r.message, /输出 #1 校准后出现负时刻/);
  assert.match(r.message, /已禁止校准版导出/);
  assert.match(r.message, /主结果不受影响/);
  // 其余条目仍正常映射（对照页照常展示）
  assert.deepEqual(r.items.map((it) => [it.newStart, it.newEnd]),
    [[-100, -50], [100, 200], [800, 850]]);
});

test('校准：取整后零长字幕指出输出编号并禁止导出', () => {
  const mappings = [pm(1, 0, 100, 400), pm(2, 0, 600, 900), pm(3, 0, 0, 600)];
  // 斜率 1/1000：#1 [0.1,0.4) → [0,0]；#2 [0.6,0.9) → [1,1]；#3 [0,0.6) → [0,1]
  const anchors = [ak(0, 0), ak(1000, 1)];
  const r = Sync.computeSync(mappings, anchors);
  assert.equal(r.ok, true);
  assert.equal(r.exportable, false);
  assert.deepEqual(r.problems, [
    { newIndex: 1, kind: 'zero-length' },
    { newIndex: 2, kind: 'zero-length' },
  ]);
  assert.match(r.message, /输出 #1、#2 校准取整后零长/);
  // #3 正常
  assert.deepEqual([r.items[2].newStart, r.items[2].newEnd], [0, 1]);
});

test('校准：负时刻与零长同时出现时合并报告', () => {
  const mappings = [pm(1, 0, 0, 50), pm(2, 0, 100, 400)];
  // 首锚点偏移 −50：#1 → [−50,0) 负时刻；区间内斜率 1/1000：#2 [0.05,0.35) → [0,0] 零长
  const anchors = [ak(50, 0), ak(1050, 1)];
  const r = Sync.computeSync(mappings, anchors);
  assert.equal(r.exportable, false);
  assert.deepEqual(r.problems, [
    { newIndex: 1, kind: 'negative' },
    { newIndex: 2, kind: 'zero-length' },
  ]);
  assert.match(r.message, /输出 #1 校准后出现负时刻/);
  assert.match(r.message, /输出 #2 校准取整后零长/);
});

test('校准：空输出与非法锚点的防御返回', () => {
  const empty = Sync.computeSync([], [ak(0, 0), ak(1, 1)]);
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'empty');

  const bad = Sync.computeSync([pm(1, 0, 0, 100)], [ak(0, 0)]);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad-anchors');

  const tooMany = Sync.computeSync([pm(1, 0, 0, 100)],
    Array.from({ length: 11 }, (_, i) => ak(i * 1000, i * 1000)));
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.code, 'bad-anchors');
});

test('校准 + remap 串联：校准版 SRT 可解析且编号顺序一致', () => {
  const cue = (seq, start, end, text) =>
    ({ index: seq - 1, seq, seqText: String(seq), start, end, text, startLine: 1, endLine: 1 });
  const seg = (order, sourceStart, sourceEnd, speed) =>
    ({ order, line: order + 1, raw: '', sourceStart, sourceEnd, speed });
  const cues = [
    cue(1, 0, 1000, '第一句'),
    cue(2, 2000, 3000, '第二句'),
    cue(3, 500, 1500, '第三句（跨切点）'),
  ];
  const segs = [seg(0, 0, 5000, 1), seg(1, 0, 2000, 2)];
  const remapped = remap(cues, segs);
  assert.ok(remapped.mappings.length > 0);

  const anchors = [ak(0, 500), ak(4000, 2500)];
  const r = Sync.computeSync(remapped.mappings, anchors);
  assert.equal(r.ok, true);
  assert.equal(r.exportable, true);
  // 映射单调：校准后起点序列不减
  for (let i = 1; i < r.items.length; i++) {
    assert.ok(r.items[i].newStart >= r.items[i - 1].newStart);
  }
  const srt = serializeSrt(Sync.buildSyncedEntries(remapped.mappings, r));
  const { cues: parsed, errors } = parseSrt(srt);
  assert.equal(errors.length, 0);
  assert.equal(parsed.length, remapped.mappings.length);
  parsed.forEach((c, i) => {
    assert.equal(c.seq, i + 1); // 编号顺序不变
    assert.equal(c.start, r.items[i].newStart);
    assert.equal(c.end, r.items[i].newEnd);
    assert.equal(c.text, remapped.mappings[i].text); // 正文不变
    assert.ok(c.end > c.start); // 可导出时无零长
    assert.ok(c.start >= 0); // 可导出时无负时刻
  });
});

// ---------- 随机性质 ----------

/** 简单确定性伪随机（可复现）。 */
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (t >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

test('映射性质：锚点处精确命中，整体单调不减（随机锚点）', () => {
  const rand = mulberry32(20260926);
  const ri = (n) => Math.floor(rand() * n);

  for (let round = 0; round < 200; round++) {
    const k = 2 + ri(9); // 2～10 个锚点
    const oldSet = new Set();
    while (oldSet.size < k) oldSet.add(ri(100000));
    const newSet = new Set();
    while (newSet.size < k) newSet.add(ri(100000));
    const olds = Array.from(oldSet).sort((a, b) => a - b);
    const news = Array.from(newSet).sort((a, b) => a - b);
    const anchors = olds.map((o, i) => ak(o, news[i]));

    // 锚点处精确命中（首/末走偏移分支，中间走线性分支，结果一致）
    for (const a of anchors) {
      const exact = Sync.mapTimeExact(anchors, a.oldMs);
      assert.equal(exact.num % exact.den, 0n, `第 ${round} 轮：锚点 ${a.oldMs} 应映射为整数`);
      assert.equal(Sync.mapTime(anchors, a.oldMs), a.newMs,
        `第 ${round} 轮：锚点 ${a.oldMs} → ${a.newMs}`);
    }

    // 随机时刻序列取整后单调不减
    const ts = Array.from({ length: 60 }, () => ri(120000)).sort((a, b) => a - b);
    let prev = -Infinity;
    for (const t of ts) {
      const v = Sync.mapTime(anchors, t);
      assert.ok(v >= prev, `第 ${round} 轮：映射应单调不减（t=${t}）`);
      prev = v;
    }

    // 首锚点之前/末锚点之后：固定偏移（精确为整数）
    const first = anchors[0];
    const last = anchors[anchors.length - 1];
    const before = Sync.mapTimeExact(anchors, Math.max(0, first.oldMs - 1 - ri(5000)));
    assert.equal(before.den, 1n);
    const after = Sync.mapTimeExact(anchors, last.oldMs + ri(5000));
    assert.equal(after.den, 1n);
  }
});
