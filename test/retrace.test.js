'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Retrace = require('../src/retrace');
const { remap } = require('../src/remap');

/** 构造剪辑段时间轴条目（remap timeline 字段的最小子集），cursor 为精确起点（半毫秒）。 */
function tl(order, sourceStart, sourceEnd, speed, outStartHalf) {
  const outEndHalf = outStartHalf + (sourceEnd - sourceStart) * (2 / speed);
  return {
    order,
    line: order + 1,
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
/** 构造选段（parseSelections 输出字段的最小子集）。 */
function sel(start, end, line = 1) {
  return { start, end, line, raw: '' };
}

// ---------- 选段解析 ----------

test('选段解析：合法输入（注释/空行/逗号/CRLF/制表符）', () => {
  const { selections, errors } = Retrace.parseSelections(
    '# 起始ms 结束ms\n'
    + '0 1000        # 片头\n'
    + '\n'
    + '1000, 2000\r\n'
    + '2000\t3000\n'
    + '3000 , 4000\n',
    10000,
  );
  assert.equal(errors.length, 0);
  assert.deepEqual(
    selections.map((x) => [x.start, x.end, x.line]),
    [[0, 1000, 2], [1000, 2000, 4], [2000, 3000, 5], [3000, 4000, 6]],
  );
});

test('选段解析：字段数错误指出行号', () => {
  const { errors } = Retrace.parseSelections('0 1000\n1000\n2000 3000 5\n', 10000);
  assert.equal(errors.length, 2);
  assert.equal(errors[0].line, 2);
  assert.match(errors[0].message, /第 2 行/);
  assert.match(errors[0].message, /应有 2 个字段/);
  assert.equal(errors[1].line, 3);
  assert.match(errors[1].message, /实际 3 个/);
});

test('选段解析：非整数、负数、终点不晚于起点均指出行号', () => {
  const r1 = Retrace.parseSelections('0 1000\nabc 2000\n', 10000);
  assert.equal(r1.errors.length, 1);
  assert.equal(r1.errors[0].line, 2);
  assert.match(r1.errors[0].message, /起始时间必须是整数毫秒/);

  const r2 = Retrace.parseSelections('0 1000\n1000 1.5\n', 10000);
  assert.equal(r2.errors.length, 1);
  assert.match(r2.errors[0].message, /结束时间必须是整数毫秒/);

  const r3 = Retrace.parseSelections('0 1000\n-5 2000\n', 10000);
  assert.equal(r3.errors.length, 1);
  assert.equal(r3.errors[0].line, 2);
  assert.match(r3.errors[0].message, /起始时间不能为负数/);

  const r4 = Retrace.parseSelections('0 1000\n1000 -1\n', 10000);
  assert.equal(r4.errors.length, 1);
  assert.match(r4.errors[0].message, /结束时间不能为负数/);

  const r5 = Retrace.parseSelections('0 1000\n2000 2000\n', 10000);
  assert.equal(r5.errors.length, 1);
  assert.match(r5.errors[0].message, /结束时间（2000）必须晚于起始时间（2000）/);

  const r6 = Retrace.parseSelections('0 1000\n3000 2500\n', 10000);
  assert.equal(r6.errors.length, 1);
  assert.match(r6.errors[0].message, /必须晚于起始时间/);
});

test('选段解析：终点不得越过拼接时间轴精确末端（整数末端）', () => {
  const ok = Retrace.parseSelections('0 1000\n999 1000\n', 1000);
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.selections.length, 2);

  const over = Retrace.parseSelections('0 1000\n0 1001\n', 1000);
  assert.equal(over.errors.length, 1);
  assert.equal(over.errors[0].line, 2);
  assert.match(over.errors[0].message, /结束时间（1001）不得越过拼接时间轴精确末端（1000 ms）/);
});

test('选段解析：精确末端含半毫秒时按精确值判定（1000.5 允许 1000、拒绝 1001）', () => {
  const ok = Retrace.parseSelections('0 1000\n', 1000.5);
  assert.equal(ok.errors.length, 0);

  const over = Retrace.parseSelections('0 1001\n', 1000.5);
  assert.equal(over.errors.length, 1);
  assert.equal(over.errors[0].line, 1);
  assert.match(over.errors[0].message, /不得越过拼接时间轴精确末端（1000\.5 ms）/);
});

test('选段解析：数量限 1～20 个（空输入与超量均报第 0 行）', () => {
  const empty = Retrace.parseSelections('   \n# 只有注释\n', 10000);
  assert.equal(empty.errors.length, 1);
  assert.equal(empty.errors[0].line, 0);
  assert.match(empty.errors[0].message, /至少需要 1 个成片选段/);

  const tooMany = Retrace.parseSelections(
    Array.from({ length: 21 }, (_, i) => `${i} ${i + 1}`).join('\n'),
    10000,
  );
  assert.equal(tooMany.errors.length, 1);
  assert.equal(tooMany.errors[0].line, 0);
  assert.match(tooMany.errors[0].message, /最多 20 个（当前 21 个）/);

  const maxOk = Retrace.parseSelections(
    Array.from({ length: 20 }, (_, i) => `${i} ${i + 1}`).join('\n'),
    10000,
  );
  assert.equal(maxOk.errors.length, 0);
  assert.equal(maxOk.selections.length, 20);
});

// ---------- 回溯计算 ----------

test('回溯：跨三段拆分并依倍速反算（含乱序源段，按播放顺序列出）', () => {
  // 段0 [0,5000)@1 → 成片 0..5000；段1 [10000,13500)@2 → 5000..6750；段2 [3000,6000)@0.5 → 6750..12750
  const timeline = timelineOf([0, 5000, 1], [10000, 13500, 2], [3000, 6000, 0.5]);
  const r = Retrace.computeRetrace([sel(4000, 7000)], timeline);
  assert.equal(r.ok, true);
  assert.equal(r.rowCount, 3);
  assert.deepEqual(r.rows.map((x) => x.segOrder), [0, 1, 2]);
  assert.deepEqual(r.rows.map((x) => x.speed), [1, 2, 0.5]);
  // 成片子区间（半毫秒单位）
  assert.deepEqual(r.rows.map((x) => [x.outStartHalf, x.outEndHalf]),
    [[8000, 10000], [10000, 13500], [13500, 14000]]);
  // 源区间（¼毫秒单位）：[4000,5000) / [10000,13500) / [3000,3125)
  assert.deepEqual(r.rows.map((x) => [x.srcStartQuarter, x.srcEndQuarter]),
    [[16000, 20000], [40000, 54000], [12000, 12500]]);
  assert.deepEqual(r.rows.map((x) => x.line), [1, 1, 1]);
});

test('回溯：切点恰为选段端点时相邻段不产生空行', () => {
  const timeline = timelineOf([0, 5000, 1], [10000, 13500, 2], [3000, 6000, 0.5]);
  // 选段端点 5000/6750 恰为段0终点/段2起点的精确拼接边界
  const r = Retrace.computeRetrace([sel(5000, 6750)], timeline);
  assert.equal(r.ok, true);
  assert.equal(r.rowCount, 1); // 段0、段2 均为零长交集，不产生空行
  assert.equal(r.rows[0].segOrder, 1);
  assert.deepEqual([r.rows[0].outStartHalf, r.rows[0].outEndHalf], [10000, 13500]);
  assert.deepEqual([r.rows[0].srcStartQuarter, r.rows[0].srcEndQuarter], [40000, 54000]);
});

test('回溯：同一源段重复使用时各次记录均保留', () => {
  const timeline = timelineOf([0, 2000, 1], [0, 2000, 1]); // 同一源段播放两次
  const r = Retrace.computeRetrace([sel(500, 3500)], timeline);
  assert.equal(r.ok, true);
  assert.equal(r.rowCount, 2);
  assert.deepEqual(r.rows.map((x) => x.segOrder), [0, 1]);
  // 第一次：成片 [500,2000) ← 源 [500,2000)；第二次：成片 [2000,3500) ← 源 [0,1500)
  assert.deepEqual(r.rows.map((x) => [x.srcStartQuarter, x.srcEndQuarter]),
    [[2000, 8000], [0, 6000]]);
});

test('回溯：源端点保留至四分之一毫秒（半毫秒切点 × 0.5 倍速）', () => {
  // 段0 [0,1)@2 → 成片 0..0.5；段1 [0,1000)@0.5 → 0.5..2000.5（精确末端 2000.5）
  const timeline = timelineOf([0, 1, 2], [0, 1000, 0.5]);
  const r = Retrace.computeRetrace([sel(0, 1)], timeline);
  assert.equal(r.ok, true);
  assert.equal(r.rowCount, 2);
  // 段0：成片 [0,0.5) ← 源 [0,1)；段1：成片 [0.5,1) ← 源 [0,0.25)（0.5ms × 0.5 倍速）
  assert.deepEqual(r.rows.map((x) => [x.srcStartQuarter, x.srcEndQuarter]),
    [[0, 4], [0, 1]]);
  assert.equal(Retrace.formatQuarterMs(r.rows[1].srcStartQuarter), '0');
  assert.equal(Retrace.formatQuarterMs(r.rows[1].srcEndQuarter), '0.25');
  assert.equal(Retrace.formatHalfMs(r.rows[0].outEndHalf), '0.5');
});

test('回溯：选段覆盖整个拼接时间轴（含全部剪辑段）', () => {
  const timeline = timelineOf([0, 5000, 1], [10000, 13500, 2], [3000, 6000, 0.5]);
  const r = Retrace.computeRetrace([sel(0, 12750)], timeline);
  assert.equal(r.ok, true);
  assert.equal(r.rowCount, 3);
  assert.deepEqual(r.rows.map((x) => [x.outStartHalf, x.outEndHalf]),
    [[0, 10000], [10000, 13500], [13500, 25500]]);
  // 各段源区间完整反算
  assert.deepEqual(r.rows.map((x) => [x.srcStartQuarter, x.srcEndQuarter]),
    [[0, 20000], [40000, 54000], [12000, 24000]]);
});

test('回溯：多个选段按输入行及播放顺序排列（允许重叠、乱序）', () => {
  const timeline = timelineOf([0, 2000, 1], [0, 2000, 1]);
  const r = Retrace.computeRetrace([sel(3000, 4000, 5), sel(0, 1000, 2)], timeline);
  assert.equal(r.ok, true);
  assert.equal(r.rowCount, 2);
  // 先输入行（第 5 行）的记录在前，即使其成片区间更靠后
  assert.deepEqual(r.rows.map((x) => [x.selIndex, x.line]), [[0, 5], [1, 2]]);
  assert.deepEqual(r.rows.map((x) => x.segOrder), [1, 0]);
  assert.deepEqual(r.selections, [
    { line: 5, start: 3000, end: 4000 },
    { line: 2, start: 0, end: 1000 },
  ]);
});

test('回溯：空选段或空时间轴返回失败（防御）', () => {
  const timeline = timelineOf([0, 1000, 1]);
  const r1 = Retrace.computeRetrace([], timeline);
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'empty');
  const r2 = Retrace.computeRetrace([sel(0, 1)], []);
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'bad-timeline');
});

// ---------- 与 remap 串联 ----------

test('回溯 + remap 串联：按精确边界反算，不从已取整的输出时间反推', () => {
  const cue = (seq, start, end, text) =>
    ({ index: seq - 1, seq, seqText: String(seq), start, end, text, startLine: 1, endLine: 1 });
  const seg = (order, sourceStart, sourceEnd, speed) =>
    ({ order, line: order + 1, raw: '', sourceStart, sourceEnd, speed });
  // 源 [0,3)@2：精确成片末端 1.5ms，输出字幕取整后为 [0,2)
  const remapped = remap([cue(1, 0, 3, 'a')], [seg(0, 0, 3, 2)]);
  assert.equal(remapped.totalDurationExactMs, 1.5);
  assert.equal(remapped.totalDurationMs, 2); // 取整后总时长为 2
  assert.deepEqual([remapped.mappings[0].start, remapped.mappings[0].end], [0, 2]);

  // 终点 2 虽等于取整后总时长，但越过精确末端 1.5 → 拒绝
  const over = Retrace.parseSelections('0 2\n', remapped.totalDurationExactMs);
  assert.equal(over.errors.length, 1);
  assert.match(over.errors[0].message, /不得越过拼接时间轴精确末端（1\.5 ms）/);

  // 选段 [0,1)：按精确边界反算为源 [0,2)，而非按取整输出时间推算
  const { selections, errors } = Retrace.parseSelections('0 1\n', remapped.totalDurationExactMs);
  assert.equal(errors.length, 0);
  const r = Retrace.computeRetrace(selections, remapped.timeline);
  assert.equal(r.ok, true);
  assert.equal(r.rowCount, 1);
  assert.deepEqual([r.rows[0].outStartHalf, r.rows[0].outEndHalf], [0, 2]);
  assert.deepEqual([r.rows[0].srcStartQuarter, r.rows[0].srcEndQuarter], [0, 8]);
});

// ---------- CSV ----------

test('CSV：与清单同内容（表头、逐行记录、¼/半毫秒规范文本、末尾换行）', () => {
  const timeline = timelineOf([0, 1, 2], [0, 1000, 0.5]);
  const r = Retrace.computeRetrace([sel(0, 1, 3)], timeline);
  const csv = Retrace.buildRetraceCsv(r.rows);
  const lines = csv.split('\n');
  assert.equal(lines.length, 4); // 表头 + 2 行记录 + 末尾空串（结尾换行）
  assert.equal(lines[3], '');
  assert.equal(lines[0],
    '输入行,选段起(ms),选段止(ms),成片起(ms),成片止(ms),源起(ms),源止(ms),剪辑段序号,剪辑段输入行,倍速');
  assert.equal(lines[1], '3,0,1,0,0.5,0,1,1,1,2');
  assert.equal(lines[2], '3,0,1,0.5,1,0,0.25,2,2,0.5');
});

test('CSV：重复源段的各次记录均保留且顺序与清单一致', () => {
  const timeline = timelineOf([0, 2000, 1], [0, 2000, 1]);
  const r = Retrace.computeRetrace([sel(500, 3500, 1)], timeline);
  const csv = Retrace.buildRetraceCsv(r.rows);
  const lines = csv.split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[1], '1,500,3500,500,2000,500,2000,1,1,1');
  assert.equal(lines[2], '1,500,3500,2000,3500,0,1500,2,2,1');
});

// ---------- 格式化 ----------

test('格式化：半毫秒与四分之一毫秒的规范文本', () => {
  assert.equal(Retrace.formatHalfMs(0), '0');
  assert.equal(Retrace.formatHalfMs(1), '0.5');
  assert.equal(Retrace.formatHalfMs(2), '1');
  assert.equal(Retrace.formatHalfMs(13501), '6750.5');
  assert.equal(Retrace.formatHalfMs(25500), '12750');

  assert.equal(Retrace.formatQuarterMs(0), '0');
  assert.equal(Retrace.formatQuarterMs(1), '0.25');
  assert.equal(Retrace.formatQuarterMs(2), '0.5');
  assert.equal(Retrace.formatQuarterMs(3), '0.75');
  assert.equal(Retrace.formatQuarterMs(4), '1');
  assert.equal(Retrace.formatQuarterMs(12500), '3125');
  assert.equal(Retrace.formatQuarterMs(4001), '1000.25');
});
