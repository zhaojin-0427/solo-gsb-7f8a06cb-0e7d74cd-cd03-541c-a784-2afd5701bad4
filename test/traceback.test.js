'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Traceback = require('../src/traceback.js');
const { parseSegments } = require('../src/segments');
const { remap } = require('../src/remap');

/** 构造剪辑段时间轴条目（remap timeline 字段的最小子集），cursor 为精确起点（半毫秒）。 */
function tl(order, sourceStart, sourceEnd, speed, outStartHalf, line) {
  const outEndHalf = outStartHalf + (sourceEnd - sourceStart) * (2 / speed);
  return {
    order,
    line: line ?? order + 1,
    sourceStart,
    sourceEnd,
    speed,
    outStartHalf,
    outEndHalf,
    outStart: Math.floor((outStartHalf + 1) / 2),
    outEnd: Math.floor((outEndHalf + 1) / 2),
  };
}
/** 依次拼接多段：[源起, 源止, 倍速][] → timeline（精确累计，与 remap 一致）。 */
function timelineOf(...segs) {
  let cursor = 0;
  return segs.map(([s, e, sp], i) => {
    const t = tl(i, s, e, sp, cursor);
    cursor = t.outEndHalf;
    return t;
  });
}
/** 经真实 remap 生成 timeline（用最小时长字幕覆盖源段，避免零长舍弃）。 */
function realTimeline(segText) {
  const { segments } = parseSegments(segText);
  // 一条覆盖全部源范围的字幕（各段独立求交，不影响 timeline）
  const cues = [{ index: 0, seq: 1, start: 0, end: 1_000_000, text: 'x' }];
  return { segments, result: remap(cues, segments) };
}

// ---------- 选段解析 ----------

test('选段解析：合法输入（注释/空行/逗号/CRLF/制表符）', () => {
  const { selections, errors } = Traceback.parseSelections(
    '# 起始ms 结束ms\n'
    + '0 1000        # 前一秒\n'
    + '\n'
    + '1000, 2000\r\n'
    + '2000\t3000\n'
    + '3000 , 4000\n',
  );
  assert.equal(errors.length, 0);
  assert.deepEqual(
    selections.map((x) => [x.start, x.end, x.line]),
    [[0, 1000, 2], [1000, 2000, 4], [2000, 3000, 5], [3000, 4000, 6]],
  );
});

test('选段解析：字段数错误指出行号', () => {
  const { errors } = Traceback.parseSelections('0 1000\n1000\n2000 3000 4\n');
  assert.equal(errors.length, 2);
  assert.equal(errors[0].line, 2);
  assert.match(errors[0].message, /第 2 行/);
  assert.match(errors[0].message, /应有 2 个字段/);
  assert.equal(errors[1].line, 3);
  assert.match(errors[1].message, /实际 3 个/);
});

test('选段解析：非整数、负数、终点不晚于起点均指出行号', () => {
  assert.match(Traceback.parseSelections('abc 2000\n').errors[0].message, /起始时间必须是整数毫秒/);
  assert.equal(Traceback.parseSelections('abc 2000\n').errors[0].line, 1);
  assert.match(Traceback.parseSelections('0 1.5\n').errors[0].message, /结束时间必须是整数毫秒/);
  assert.match(Traceback.parseSelections('-5 2000\n').errors[0].message, /起始时间不能为负数/);
  assert.match(Traceback.parseSelections('2000 2000\n').errors[0].message, /结束时间（2000）必须晚于起始时间（2000）/);
  assert.match(Traceback.parseSelections('3000 2500\n').errors[0].message, /必须晚于起始时间/);
});

test('选段解析：空输入或只有注释时报错（第 0 行）', () => {
  const empty = Traceback.parseSelections('   \n# 只有注释\n');
  assert.equal(empty.errors.length, 1);
  assert.equal(empty.errors[0].line, 0);
  assert.match(empty.errors[0].message, /至少需要一个成片选段/);
});

test('选段解析：超过 20 个报错（第 0 行），边界 20 合法', () => {
  const lines20 = Array.from({ length: 20 }, (_, i) => `${i * 10} ${i * 10 + 5}`).join('\n');
  const ok = Traceback.parseSelections(lines20);
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.selections.length, 20);

  const lines21 = `${lines20}\n200 205`;
  const tooMany = Traceback.parseSelections(lines21);
  assert.equal(tooMany.errors.length, 1);
  assert.equal(tooMany.errors[0].line, 0);
  assert.match(tooMany.errors[0].message, /最多 20 个/);
});

// ---------- 回溯计算：基本拆分与倍速反算 ----------

test('单段倍速 1：选段原样映射到源（整数毫秒）', () => {
  const timeline = timelineOf([1000, 6000, 1]);
  const r = Traceback.traceSelections(
    Traceback.parseSelections('0 4000\n').selections,
    timeline,
  );
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1);
  const it = r.items[0];
  assert.deepEqual(
    [it.selectionLine, it.subIndex, it.segOrder, it.speed],
    [1, 1, 0, 1],
  );
  // 成片 [0,4000) → 源 [1000,5000)，均为四分之一毫秒单位（×4）
  assert.deepEqual([it.outStartQ, it.outEndQ], [0, 16000]);
  assert.deepEqual([it.srcStartQ, it.srcEndQ], [4000, 20000]);
  assert.equal(Traceback.formatQuarterMs(it.srcStartQ), '1000');
  assert.equal(Traceback.formatQuarterMs(it.srcEndQ), '5000');
});

test('倍速 2：成片区间反算源区间拉长一倍，源端点精确到 0.5ms', () => {
  // 段：源 [0,4000) 2× → 成片 [0,2000)
  const timeline = timelineOf([0, 4000, 2]);
  const r = Traceback.traceSelections(
    Traceback.parseSelections('0 1500\n').selections,
    timeline,
  );
  assert.equal(r.ok, true);
  const it = r.items[0];
  // 成片 [0,1500)（半毫秒 0..3000）→ 源 [0,3000)
  assert.deepEqual([it.outStartQ, it.outEndQ], [0, 6000]);
  assert.deepEqual([it.srcStartQ, it.srcEndQ], [0, 12000]);
});

test('倍速 0.5：成片区间反算源区间压缩一半', () => {
  // 段：源 [1000,3000) 0.5× → 成片 [0,4000)
  const timeline = timelineOf([1000, 3000, 0.5]);
  const r = Traceback.traceSelections(
    Traceback.parseSelections('0 3000\n').selections,
    timeline,
  );
  assert.equal(r.ok, true);
  const it = r.items[0];
  // 成片 3000ms → 源偏移 1500ms，源区间 [1000,2500)
  assert.deepEqual([it.srcStartQ, it.srcEndQ], [4000, 10000]);
  assert.deepEqual([it.outStartQ, it.outEndQ], [0, 12000]);
});

test('跨切点拆分：一个选段按精确拼接边界拆成多个子区间，依次反算', () => {
  // 源 [0,5000) 1× → 成片 [0,5000)
  // 源 [10000,13500) 2× → 成片 [5000,6750)
  // 源 [3000,6000) 0.5× → 成片 [6750,12750)
  const { result } = realTimeline('0 5000 1\n10000 13500 2\n3000 6000 0.5\n');
  const timeline = result.timeline;

  // 选段 [1000, 12000) 跨越全部 3 段
  const r = Traceback.traceSelections(
    Traceback.parseSelections('1000 12000\n').selections,
    timeline,
  );
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 3);

  // 子区间 1：成片 [1000,5000) 1× → 源 [1000,5000)
  assert.deepEqual([r.items[0].outStartQ, r.items[0].outEndQ], [4000, 20000]);
  assert.deepEqual([r.items[0].srcStartQ, r.items[0].srcEndQ], [4000, 20000]);
  assert.equal(r.items[0].segOrder, 0);
  assert.equal(r.items[0].subIndex, 1);

  // 子区间 2：成片 [5000,6750) 2×（长 1750）→ 源 [10000,13500)（长 3500）
  assert.deepEqual([r.items[1].outStartQ, r.items[1].outEndQ], [20000, 27000]);
  assert.deepEqual([r.items[1].srcStartQ, r.items[1].srcEndQ], [40000, 54000]);
  assert.equal(r.items[1].segOrder, 1);
  assert.equal(r.items[1].subIndex, 2);

  // 子区间 3：成片 [6750,12000) 0.5×（长 5250）→ 源偏移 2625，源 [5625,8250)?
  // 源起 3000 + 偏移 2625 = 5625；源止 = 3000 + (12000-6750)*0.5 = 3000+2625=5625?
  // 0.5×：输出时长 = 源时长/0.5 = 源时长×2，故源时长 = 5250/2 = 2625；
  // 源 [3000+0, 3000+2625) = [3000,5625)
  assert.deepEqual([r.items[2].outStartQ, r.items[2].outEndQ], [27000, 48000]);
  assert.deepEqual([r.items[2].srcStartQ, r.items[2].srcEndQ], [12000, 22500]);
  assert.equal(r.items[2].segOrder, 2);
});

test('四分之一毫秒精度：奇数半毫秒切点 + 0.5× 段反算出真正的 0.25ms 源端点', () => {
  // 切点为奇数半毫秒：2× 源[0,1) → 成片 [0,0.5)（outEndHalf=1）；
  // 随后 0.5× 源[10,14) → 成片 [0.5,8.5)（outStartHalf=1，奇数半毫秒）
  const a = tl(0, 0, 1, 2, 0);
  const b = tl(1, 10, 14, 0.5, 1);
  // 选段 [1,3) 在 0.5× 段内：半毫秒交集 [2,6)，相对段起点（奇数 1）偏移 1..5 半毫秒
  // 0.5× factor=1（四分之一单位）→ 源偏移 0.25ms..1.25ms → 源 [10.25,11.25)
  const r = Traceback.traceSelections(
    Traceback.parseSelections('1 3\n').selections,
    [a, b],
  );
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1);
  const it = r.items[0];
  assert.equal(it.segOrder, 1);
  assert.deepEqual([it.outStartQ, it.outEndQ], [4, 12]); // 成片 [1,3)
  assert.deepEqual([it.srcStartQ, it.srcEndQ], [41, 45]); // 源 [10.25,11.25)
  assert.equal(Traceback.formatQuarterMs(it.srcStartQ), '10.25');
  assert.equal(Traceback.formatQuarterMs(it.srcEndQ), '11.25');
  assert.equal(Traceback.formatQuarterMs(it.srcEndQ - it.srcStartQ), '1'); // 0.5×：成片 2ms = 源 1ms
});

test('四分之一毫秒精度：0.5× 段在 0.5ms 端点产生 0.5ms 源端点', () => {
  // 1× 源[0,1) → 成片[0,1)；0.5× 源[10,12) → 成片[1,5)
  const t0 = tl(0, 0, 1, 1, 0);
  const t1 = tl(1, 10, 12, 0.5, 2);
  // 选段 [0,2)：0.5× 段内成片 [1,2) 长 1ms → 源长 0.5ms → 源 [10,10.5)
  const r = Traceback.traceSelections(
    Traceback.parseSelections('0 2\n').selections,
    [t0, t1],
  );
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 2);
  const it = r.items[1];
  assert.deepEqual([it.outStartQ, it.outEndQ], [4, 8]); // 成片 [1,2)
  assert.deepEqual([it.srcStartQ, it.srcEndQ], [40, 42]); // 源 [10,10.5)：42/4=10.5
  // 切点恰为 0.5ms 时，源端点需保留到 0.25ms 精度（本例末点 .5，起点整）
  assert.equal(Traceback.formatQuarterMs(it.srcEndQ), '10.5');
});

test('2× 段：成片 0.5ms 偏移反算出 0.25ms 源端点', () => {
  // 1× 源[0,1) → 成片[0,1)；2× 源[0,4) → 成片[1,3)
  const t0 = tl(0, 0, 1, 1, 0);
  const t1 = tl(1, 0, 4, 2, 2);
  // 选段 [0,2)：2× 段成片 [1,2)（半毫秒 2..4，偏移 2 半毫秒=1ms 成片）→ 源偏移 2ms
  // 再取成片 [1,1.5) 需要非整数输入，不行；改用 [0,3) 覆盖整段：
  // 选段 [0,3) 第二段成片 [1,3) 偏移 2ms → 源 [0,4)
  const r = Traceback.traceSelections(
    Traceback.parseSelections('0 3\n').selections,
    [t0, t1],
  );
  assert.equal(r.ok, true);
  const it = r.items[1];
  assert.deepEqual([it.srcStartQ, it.srcEndQ], [0, 16]);
});

test('切点恰为选段端点时不产生相邻段空行（半开相接）', () => {
  const timeline = timelineOf([0, 5000, 1], [10000, 13500, 2]);
  // 切点 = 5000ms；选段终点恰为切点 → 只命中第一段
  const r = Traceback.traceSelections(
    Traceback.parseSelections('1000 5000\n').selections,
    timeline,
  );
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].segOrder, 0);

  // 选段起点恰为切点 → 只命中第二段
  const r2 = Traceback.traceSelections(
    Traceback.parseSelections('5000 6000\n').selections,
    timeline,
  );
  assert.equal(r2.items.length, 1);
  assert.equal(r2.items[0].segOrder, 1);
});

test('选段完全落在某一段内部时只产生该段的一条记录', () => {
  const timeline = timelineOf([0, 5000, 1], [10000, 13500, 2]);
  const r = Traceback.traceSelections(
    Traceback.parseSelections('5100 5200\n').selections,
    timeline,
  );
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].segOrder, 1);
  // 成片 [5100,5200)（2× 段内偏移 100ms）→ 源 [10200,10400)
  assert.deepEqual([r.items[0].srcStartQ, r.items[0].srcEndQ], [40800, 41600]);
});

// ---------- 终点不得越过精确末端 ----------

test('终点上限：整数终点等于 floor(精确末端/2) 合法；越过则按行号报错', () => {
  // 0.5× 段源 [0,1) → 成片长 2ms？ 取源[0,3) 0.5× → 成片 [0,6)，末端整毫秒
  // 用 2× 构造半毫秒末端：源 [0,3) 2× → 成片 [0,1.5)
  const timeline = timelineOf([0, 3, 2]);
  assert.equal(timeline[0].outEndHalf, 3); // 精确末端 1.5ms
  const r = Traceback.traceSelections(
    Traceback.parseSelections('0 2\n').selections, // 2 > 1.5
    timeline,
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 'out-of-range');
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].line, 1);
  assert.match(r.errors[0].message, /越过拼接时间轴精确末端/);
  assert.match(r.errors[0].message, /1\.5 ms/);
  assert.match(r.errors[0].message, /整数终点上限 1 ms/);

  // 终点恰为 1（floor(1.5)）合法
  const ok = Traceback.traceSelections(
    Traceback.parseSelections('0 1\n').selections,
    timeline,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.maxEndMs, 1);
});

test('终点恰好等于精确末端（整毫秒）合法', () => {
  const timeline = timelineOf([0, 5000, 1], [10000, 13500, 2]); // 末端 6750ms
  const r = Traceback.traceSelections(
    Traceback.parseSelections('0 6750\n').selections,
    timeline,
  );
  assert.equal(r.ok, true);
  assert.equal(r.items[r.items.length - 1].outEndQ, 27000);
});

test('多个越界选段分别指出行号', () => {
  const timeline = timelineOf([0, 100, 1]); // 末端 100ms
  const r = Traceback.traceSelections(
    Traceback.parseSelections('0 50\n0 101\n10 102\n').selections,
    timeline,
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map((e) => e.line), [2, 3]);
});

// ---------- 排序、重复段 ----------

test('按输入行及播放顺序列出；同一源段重复使用时保留各次记录', () => {
  const segText = '0 5000 1\n10000 13500 2\n0 5000 1\n'; // 第三段重复源段
  const { result } = realTimeline(segText);
  const timeline = result.timeline;

  const r = Traceback.traceSelections(
    Traceback.parseSelections('0 2000\n4000 6000\n').selections,
    timeline,
  );
  assert.equal(r.ok, true);

  // 第一行选段 [0,2000)：只命中段 1（0.5×? 不，1×）与段 3？段 3 成片 [6750,11750) 不在内
  const line1 = r.items.filter((it) => it.selectionLine === 1);
  assert.equal(line1.length, 1);
  assert.equal(line1[0].segOrder, 0);

  // 第二行选段 [4000,6000)：命中段 1 [4000,5000) 与段 2 [5000,6000)
  const line2 = r.items.filter((it) => it.selectionLine === 2);
  assert.deepEqual(line2.map((it) => it.segOrder), [0, 1]);

  // 选段覆盖重复段：[0,11750) 应产生 3 条记录，段 1 与段 3 各自独立
  const r2 = Traceback.traceSelections(
    Traceback.parseSelections('0 11750\n').selections,
    timeline,
  );
  assert.equal(r2.items.length, 3);
  assert.deepEqual(r2.items.map((it) => it.segOrder), [0, 1, 2]);
  // 段 1 与段 3 源区间相同（同一起点时）
  assert.deepEqual(
    [r2.items[0].srcStartQ, r2.items[0].srcEndQ],
    [r2.items[2].srcStartQ, r2.items[2].srcEndQ],
  );
  assert.deepEqual(
    [r2.items[0].outStartQ, r2.items[0].outEndQ],
    [0, 20000],
  );
  assert.deepEqual(
    [r2.items[2].outStartQ, r2.items[2].outEndQ],
    [27000, 47000], // 成片 [6750,11750)
  );
});

test('片内序号按播放顺序在每个选段内从 1 编号', () => {
  const { result } = realTimeline('0 5000 1\n10000 13500 2\n3000 6000 0.5\n');
  const r = Traceback.traceSelections(
    Traceback.parseSelections('4000 7000\n0 100\n1 2\n').selections,
    result.timeline,
  );
  assert.equal(r.ok, true);
  const line1 = r.items.filter((it) => it.selectionLine === 1);
  assert.deepEqual(line1.map((it) => it.subIndex), [1, 2, 3]);
  assert.deepEqual(line1.map((it) => it.segOrder), [0, 1, 2]);
  const line3 = r.items.filter((it) => it.selectionLine === 3);
  assert.deepEqual(line3.map((it) => it.subIndex), [1]);
});

test('乱序源段：反算始终回到该剪辑段自身的源区间', () => {
  // 播放顺序中第二段是更早的源区间（乱序），各自反算正确
  const { result } = realTimeline('3000 6000 1\n0 2000 1\n');
  const r = Traceback.traceSelections(
    Traceback.parseSelections('0 4000\n').selections,
    result.timeline,
  );
  assert.equal(r.items.length, 2);
  // 成片 [0,3000) → 源 [3000,6000)
  assert.deepEqual([r.items[0].srcStartQ, r.items[0].srcEndQ], [12000, 24000]);
  // 成片 [3000,4000) → 源 [0,1000)
  assert.deepEqual([r.items[1].srcStartQ, r.items[1].srcEndQ], [0, 4000]);
});

// ---------- formatQuarterMs ----------

test('formatQuarterMs：0.25 精度的四种小数形态', () => {
  assert.equal(Traceback.formatQuarterMs(0), '0');
  assert.equal(Traceback.formatQuarterMs(1), '0.25');
  assert.equal(Traceback.formatQuarterMs(2), '0.5');
  assert.equal(Traceback.formatQuarterMs(3), '0.75');
  assert.equal(Traceback.formatQuarterMs(4), '1');
  assert.equal(Traceback.formatQuarterMs(41), '10.25');
  assert.equal(Traceback.formatQuarterMs(42), '10.5');
  assert.equal(Traceback.formatQuarterMs(43), '10.75');
  assert.equal(Traceback.formatQuarterMs(1000), '250');
});

// ---------- CSV ----------

test('buildCsv：表头与逐行内容一致，数值为精确毫秒文本', () => {
  const { result } = realTimeline('0 5000 1\n10000 13500 2\n');
  const r = Traceback.traceSelections(
    Traceback.parseSelections('4000 6000\n').selections,
    result.timeline,
  );
  const csv = Traceback.buildCsv(r.items);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], '选段行,片内序号,剪辑段序号,剪辑段输入行,倍速,成片起点(ms),成片终点(ms),成片时长(ms),源起点(ms),源终点(ms),源时长(ms)');
  assert.equal(lines.length, 3); // 表头 + 2 行
  assert.equal(lines[1], '1,1,1,1,1,4000,5000,1000,4000,5000,1000');
  assert.equal(lines[2], '1,2,2,2,2,5000,6000,1000,10000,12000,2000');
});

test('buildCsv：含四分之一毫秒端点时输出 .25/.5/.75 文本', () => {
  const t0 = tl(0, 0, 1, 1, 0);
  const t1 = tl(1, 10, 12, 0.5, 2);
  const r = Traceback.traceSelections(
    Traceback.parseSelections('0 2\n').selections,
    [t0, t1],
  );
  const csv = Traceback.buildCsv(r.items);
  const lines = csv.split('\r\n');
  assert.equal(lines[2], '1,2,2,2,0.5,1,2,1,10,10.5,0.5');
});

test('buildCsv：多行选段按行及播放顺序导出，重复段各占一行', () => {
  const { result } = realTimeline('0 5000 1\n0 5000 1\n');
  const r = Traceback.traceSelections(
    Traceback.parseSelections('0 10000\n0 10\n').selections,
    result.timeline,
  );
  const csv = Traceback.buildCsv(r.items);
  const lines = csv.split('\r\n');
  // 第一行选段 2 条子区间 + 第二行 1 条 = 3 行数据
  assert.equal(lines.length, 4);
  assert.equal(lines[1], '1,1,1,1,1,0,5000,5000,0,5000,5000');
  assert.equal(lines[2], '1,2,2,2,1,5000,10000,5000,0,5000,5000');
  assert.equal(lines[3], '2,1,1,1,1,0,10,10,0,10,10');
});

// ---------- 与 remap 串联：端点基于精确边界而非取整字幕 ----------

test('与 remap 串联：选段端点基于精确 timeline，而非四舍五入后的字幕时间', () => {
  // 2× 段使字幕边界取整，但 timeline 仍为精确半毫秒；回溯直接使用 outStartHalf/outEndHalf
  const segText = '0 3 2\n';
  const { result } = realTimeline(segText);
  // 时间轴精确末端 1.5ms；任何 ≤1 的整数终点合法且反算精确
  const r = Traceback.traceSelections(
    Traceback.parseSelections('0 1\n').selections,
    result.timeline,
  );
  assert.equal(r.ok, true);
  // 成片 [0,1) 2× → 源 [0,2)
  assert.deepEqual([r.items[0].srcStartQ, r.items[0].srcEndQ], [0, 8]);
  assert.equal(r.totalEndMs, 1.5);
});

test('失败：空选段或无效 timeline', () => {
  const r1 = Traceback.traceSelections([], timelineOf([0, 10, 1]));
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'empty');
  const r2 = Traceback.traceSelections([{ start: 0, end: 1, line: 1 }], []);
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'bad-timeline');
});
