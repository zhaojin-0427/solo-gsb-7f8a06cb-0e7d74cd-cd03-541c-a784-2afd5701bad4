'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Speaker = require('../src/speaker');
const { remap } = require('../src/remap');
const { serializeSrt, parseSrt } = require('../src/srt');

/** 构造一条重排输出（remap mappings 字段的最小子集）。 */
function pm(newIndex, segOrder, start, end, text = `t${newIndex}`) {
  return { newIndex, segOrder, start, end, cueIndex: newIndex - 1, seq: newIndex, text };
}
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
/** 构造标注时段（parseSpeakerIntervals 输出字段的最小子集）。 */
function iv(start, end, speaker, line = 1) {
  return { start, end, speaker, line, raw: '' };
}

// ---------- 标注解析 ----------

test('标注解析：合法输入（注释/空行/逗号/CRLF/制表符/合法 ID 字符）', () => {
  const { intervals, errors } = Speaker.parseSpeakerIntervals(
    '# 起始ms 结束ms 说话人ID\n'
    + '0 1000 alice      # 旁白\n'
    + '\n'
    + '1000, 2000 bob_2\r\n'
    + '2000\t3000 c-3\n'
    + '3000 , 4000 Z9\n',
  );
  assert.equal(errors.length, 0);
  assert.deepEqual(
    intervals.map((x) => [x.start, x.end, x.speaker, x.line]),
    [[0, 1000, 'alice', 2], [1000, 2000, 'bob_2', 4], [2000, 3000, 'c-3', 5], [3000, 4000, 'Z9', 6]],
  );
});

test('标注解析：字段数错误指出行号', () => {
  const { errors } = Speaker.parseSpeakerIntervals('0 1000 alice\n1000\n2000 3000 a b\n');
  assert.equal(errors.length, 2);
  assert.equal(errors[0].line, 2);
  assert.match(errors[0].message, /第 2 行/);
  assert.match(errors[0].message, /应有 3 个字段/);
  assert.equal(errors[1].line, 3);
  assert.match(errors[1].message, /实际 4 个/);
});

test('标注解析：非整数、负数、终点不晚于起点均指出行号', () => {
  const r1 = Speaker.parseSpeakerIntervals('0 1000 a\nabc 2000 b\n');
  assert.equal(r1.errors.length, 1);
  assert.equal(r1.errors[0].line, 2);
  assert.match(r1.errors[0].message, /起始时间必须是整数毫秒/);

  const r2 = Speaker.parseSpeakerIntervals('0 1000 a\n1000 1.5 b\n');
  assert.equal(r2.errors.length, 1);
  assert.match(r2.errors[0].message, /结束时间必须是整数毫秒/);

  const r3 = Speaker.parseSpeakerIntervals('0 1000 a\n-5 2000 b\n');
  assert.equal(r3.errors.length, 1);
  assert.equal(r3.errors[0].line, 2);
  assert.match(r3.errors[0].message, /起始时间不能为负数/);

  const r4 = Speaker.parseSpeakerIntervals('0 1000 a\n2000 2000 b\n');
  assert.equal(r4.errors.length, 1);
  assert.match(r4.errors[0].message, /结束时间（2000）必须晚于起始时间（2000）/);

  const r5 = Speaker.parseSpeakerIntervals('0 1000 a\n3000 2500 b\n');
  assert.equal(r5.errors.length, 1);
  assert.match(r5.errors[0].message, /必须晚于起始时间/);
});

test('标注解析：说话人ID 仅限 1～20 位 ASCII 字母数字下划线连字符', () => {
  // 边界：1 与 20 个字符均合法
  const ok = Speaker.parseSpeakerIntervals(`0 1 a\n0 1 ${'x'.repeat(20)}\n`);
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.intervals.length, 2);

  // 21 个字符超长
  const tooLong = Speaker.parseSpeakerIntervals(`0 1 ${'x'.repeat(21)}\n`);
  assert.equal(tooLong.errors.length, 1);
  assert.equal(tooLong.errors[0].line, 1);
  assert.match(tooLong.errors[0].message, /最长 20 个字符，实际 21 个/);

  // 非法字符：中文、点号、加号、空格（空格会被切分为多字段）
  const bad1 = Speaker.parseSpeakerIntervals('0 1 甲\n');
  assert.equal(bad1.errors.length, 1);
  assert.match(bad1.errors[0].message, /仅限 ASCII 字母、数字、下划线或连字符/);
  const bad2 = Speaker.parseSpeakerIntervals('0 1 a.b\n');
  assert.equal(bad2.errors.length, 1);
  assert.match(bad2.errors[0].message, /仅限 ASCII/);
  const bad3 = Speaker.parseSpeakerIntervals('0 1 a+b\n');
  assert.equal(bad3.errors.length, 1);
  assert.match(bad3.errors[0].message, /仅限 ASCII/);
});

test('标注解析：空输入或只有注释时报错（第 0 行）', () => {
  const empty = Speaker.parseSpeakerIntervals('   \n# 只有注释\n');
  assert.equal(empty.errors.length, 1);
  assert.equal(empty.errors[0].line, 0);
  assert.match(empty.errors[0].message, /至少需要一条说话人标注/);
});

// ---------- 区间并集 ----------

test('并集：重叠与相接区间合并，不相交保持分开', () => {
  assert.deepEqual(Speaker.unionIntervals([
    { start: 500, end: 1500 },
    { start: 0, end: 1000 },
    { start: 3000, end: 4000 },
    { start: 1500, end: 2000 }, // 与合并后的 [0,2000) 相接
  ]), [
    { start: 0, end: 2000 },
    { start: 3000, end: 4000 },
  ]);
  assert.deepEqual(Speaker.unionIntervals([]), []);
});

// ---------- 标注映射 ----------

test('映射：沿用剪辑段倍速与边界取整规则（2x 压缩 / 0.5x 拉长 / 0.5 向上）', () => {
  // 段0：源 [0,2000) @2 → 输出 [0,1000)；段1：源 [0,1000) @0.5 → 输出 [1000,3000)
  const timeline = timelineOf([0, 2000, 2], [0, 1000, 0.5]);
  const mapped = Speaker.mapSpeakerIntervals([
    iv(0, 2000, 'a', 1),
    iv(1, 3, 'b', 2), // 段0：半毫秒 [1,3] → 四舍五入 [1,2)
    iv(1, 2, 'c', 3), // 段0：半毫秒 [1,2] → 四舍五入后零长，舍弃；段1：0.5x 拉长为 [1002,1004)
  ], timeline);
  assert.deepEqual(
    mapped.map((m) => [m.segOrder, m.start, m.end, m.speaker, m.srcIndex]),
    [
      [0, 0, 1000, 'a', 0],
      [0, 1, 2, 'b', 1],
      [1, 1000, 3000, 'a', 0],
      [1, 1002, 1006, 'b', 1], // 源 [1,3) @0.5 → 输出偏移 [2,6)
      [1, 1002, 1004, 'c', 2], // 源 [1,2) @0.5 → 输出偏移 [2,4)
    ],
  );
});

test('映射：半开区间（端点相接不算）与未命中剪辑段', () => {
  const timeline = timelineOf([1000, 2000, 1]);
  const mapped = Speaker.mapSpeakerIntervals([
    iv(0, 1000, 'a', 1),   // 端点相接（hi == lo），不命中
    iv(2000, 3000, 'b', 2), // 端点相接，不命中
    iv(500, 1500, 'c', 3),  // 命中 [1000,1500)
  ], timeline);
  assert.deepEqual(mapped.map((m) => [m.start, m.end, m.speaker]), [[0, 500, 'c']]);
});

// ---------- 归属判定 ----------

test('归属：交集最长者自动归属；端点相接不计；无交集保持无标签', () => {
  const timeline = timelineOf([0, 10000, 1]);
  const intervals = [
    iv(0, 2000, 'alice', 1),
    iv(1500, 3000, 'bob', 2),
  ];
  const mappings = [
    pm(1, 0, 500, 1000),   // alice 500
    pm(2, 0, 1000, 1500),  // alice 500；bob 端点相接不计
    pm(3, 0, 1500, 2500),  // alice 500 / bob 1000
    pm(4, 0, 5000, 6000),  // 无交集
  ];
  const r = Speaker.computeSpeakers(mappings, intervals, timeline);
  assert.equal(r.ok, true);
  assert.deepEqual(r.items.map((it) => it.status), ['auto', 'auto', 'auto', 'none']);
  assert.deepEqual(r.items.map((it) => it.speakerId), ['alice', 'alice', 'bob', null]);
  assert.deepEqual(r.items[2].overlaps, [
    { id: 'bob', ms: 1000 },
    { id: 'alice', ms: 500 },
  ]);
  assert.deepEqual(r.items[3].overlaps, []);
  assert.equal(r.autoCount, 3);
  assert.equal(r.tieCount, 0);
  assert.equal(r.noneCount, 1);
  assert.equal(r.intervalCount, 2);
  assert.equal(r.mappedCount, 2);
  assert.equal(r.unmappedCount, 0);
  assert.deepEqual(r.speakerIds, ['alice', 'bob']);
  // 无并列 → 无需裁决即可导出
  assert.equal(Speaker.exportReady(r, new Map()), true);
});

test('归属：同一说话人的重叠时段先取并集，不重复计时', () => {
  const timeline = timelineOf([0, 10000, 1]);
  const intervals = [
    iv(0, 1000, 'carol', 1),
    iv(500, 1500, 'carol', 2), // 与上一条重叠：并集 [0,1500)
    iv(2000, 3000, 'carol', 3), // 不相交：单独一段
  ];
  const mappings = [
    pm(1, 0, 0, 1500),    // 并集 [0,1500) → 1500（而非 1000+1000+500）
    pm(2, 0, 500, 2500),  // [500,1500) 1000 + [2000,2500) 500 = 1500
  ];
  const r = Speaker.computeSpeakers(mappings, intervals, timeline);
  assert.deepEqual(r.items[0].overlaps, [{ id: 'carol', ms: 1500 }]);
  assert.deepEqual(r.items[1].overlaps, [{ id: 'carol', ms: 1500 }]);
  assert.equal(r.items[0].speakerId, 'carol');
});

test('归属：不同说话人的时段可重叠，各自计入后比长短', () => {
  const timeline = timelineOf([0, 10000, 1]);
  const intervals = [
    iv(0, 2000, 'a', 1),
    iv(0, 2000, 'b', 2), // 与 a 完全重叠
  ];
  const r = Speaker.computeSpeakers([pm(1, 0, 0, 2000)], intervals, timeline);
  // 两者交集均为 2000 → 并列
  assert.equal(r.items[0].status, 'tie');
  assert.deepEqual(r.items[0].candidates, ['a', 'b']);
});

test('归属：仅统计同一剪辑段内的交集（重复源段各自独立映射）', () => {
  // 同一源段播放两次：段0 输出 [0,1000)，段1 输出 [1000,2000)
  const timeline = timelineOf([0, 1000, 1], [0, 1000, 1]);
  const intervals = [iv(0, 1000, 'eve', 1)];
  const mappings = [
    pm(1, 0, 0, 750),      // 段0 片段 [0,1000) → 750
    pm(2, 1, 1000, 1500),  // 段1 片段 [1000,2000) → 500（不能用段0 的片段）
  ];
  const r = Speaker.computeSpeakers(mappings, intervals, timeline);
  assert.deepEqual(r.items[0].overlaps, [{ id: 'eve', ms: 750 }]);
  assert.deepEqual(r.items[1].overlaps, [{ id: 'eve', ms: 500 }]);
  assert.equal(r.mappedCount, 2);
});

test('归属：最长并列时列出候选（ID 升序），逐条裁决前禁止导出', () => {
  const timeline = timelineOf([0, 10000, 1]);
  const intervals = [
    iv(0, 2000, 'bob', 1),
    iv(1500, 3000, 'alice', 2),
  ];
  const mappings = [
    pm(1, 0, 1500, 2000), // alice 500 / bob 500 → 并列
    pm(2, 0, 0, 1000),    // bob 1000 → 自动
  ];
  const r = Speaker.computeSpeakers(mappings, intervals, timeline);
  assert.equal(r.items[0].status, 'tie');
  assert.deepEqual(r.items[0].candidates, ['alice', 'bob']); // ID 升序
  assert.equal(r.tieCount, 1);
  assert.equal(Speaker.exportReady(r, new Map()), false);
  // 裁决为候选之一后可导出
  const choices = new Map([[1, 'alice']]);
  assert.equal(Speaker.exportReady(r, choices), true);
  assert.equal(Speaker.speakerForItem(r.items[0], choices), 'alice');
  // 非候选的裁决不生效
  assert.equal(Speaker.speakerForItem(r.items[0], new Map([[1, 'carol']])), null);
  assert.equal(Speaker.exportReady(r, new Map([[1, 'carol']])), false);
});

test('归属：未命中剪辑段或映射后零长的标注计入 unmappedCount', () => {
  const timeline = timelineOf([0, 1000, 2]); // 源 [0,1000) @2 → 输出 [0,500)
  const intervals = [
    iv(0, 1000, 'a', 1),   // 命中 → [0,500)
    iv(5000, 6000, 'b', 2), // 未命中任何剪辑段
    iv(1, 2, 'c', 3),      // 命中但映射后零长（半毫秒 [1,2] → [1,1)）
  ];
  const r = Speaker.computeSpeakers([pm(1, 0, 0, 500)], intervals, timeline);
  assert.equal(r.ok, true);
  assert.equal(r.intervalCount, 3);
  assert.equal(r.mappedCount, 1);
  assert.equal(r.unmappedCount, 2);
  assert.deepEqual(r.items[0].overlaps, [{ id: 'a', ms: 500 }]);
});

test('归属：空输出与非法输入的防御返回', () => {
  const timeline = timelineOf([0, 1000, 1]);
  const empty = Speaker.computeSpeakers([], [iv(0, 1000, 'a')], timeline);
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'empty');

  const bad = Speaker.computeSpeakers([pm(1, 0, 0, 100)], [], timeline);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad-intervals');

  const noTl = Speaker.computeSpeakers([pm(1, 0, 0, 100)], [iv(0, 1000, 'a')], []);
  assert.equal(noTl.ok, false);
  assert.equal(noTl.code, 'bad-timeline');
});

// ---------- 标注版导出 ----------

test('导出：已归属字幕正文前加「[ID] 」，时间、编号与正文其余部分不变', () => {
  const timeline = timelineOf([0, 10000, 1]);
  const intervals = [iv(0, 2000, 'alice', 1), iv(1500, 3000, 'bob', 2)];
  const mappings = [
    pm(1, 0, 0, 1000, '第一行\n第二行'),
    pm(2, 0, 1500, 2000, '并列句'), // alice 500 / bob 500 → 并列
    pm(3, 0, 5000, 6000, '无标签句'),
  ];
  const r = Speaker.computeSpeakers(mappings, intervals, timeline);
  assert.equal(r.items[1].status, 'tie');

  // 未裁决：并列按无标签处理（导出本应被禁用）
  const before = Speaker.buildSpeakerEntries(mappings, r, new Map());
  assert.deepEqual(before.map((e) => e.text), ['[alice] 第一行\n第二行', '并列句', '无标签句']);
  assert.deepEqual(before.map((e) => [e.start, e.end]), [[0, 1000], [1500, 2000], [5000, 6000]]);

  // 裁决后：并列字幕加上所选 ID 前缀
  const after = Speaker.buildSpeakerEntries(mappings, r, new Map([[2, 'bob']]));
  assert.deepEqual(after.map((e) => e.text), ['[alice] 第一行\n第二行', '[bob] 并列句', '无标签句']);
});

// ---------- 与 remap 串联 ----------

test('标注 + remap 串联：标注版 SRT 可解析且时间编号不变', () => {
  const cue = (seq, start, end, text) =>
    ({ index: seq - 1, seq, seqText: String(seq), start, end, text, startLine: 1, endLine: 1 });
  const seg = (order, sourceStart, sourceEnd, speed) =>
    ({ order, line: order + 1, raw: '', sourceStart, sourceEnd, speed });
  const cues = [
    cue(1, 0, 2000, '你好'),
    cue(2, 3000, 4000, '世界'),
  ];
  const segs = [seg(0, 0, 5000, 1), seg(1, 0, 2000, 2)];
  const remapped = remap(cues, segs);
  // 输出：#1 [0,2000) 段0 你好；#2 [3000,4000) 段0 世界；#3 [5000,6000) 段1 你好（2x）
  assert.deepEqual(remapped.mappings.map((m) => [m.start, m.end, m.segOrder]),
    [[0, 2000, 0], [3000, 4000, 0], [5000, 6000, 1]]);

  const { intervals, errors } = Speaker.parseSpeakerIntervals('0 1500 alice\n1000 4000 bob\n');
  assert.equal(errors.length, 0);
  const r = Speaker.computeSpeakers(remapped.mappings, intervals, remapped.timeline);
  assert.equal(r.ok, true);
  // #1：alice 1500 / bob 1000 → alice；#2：bob 1000 → bob；
  // #3（段1，2x）：alice [5000,5750) 750 / bob [5500,6000) 500 → alice
  assert.deepEqual(r.items.map((it) => it.speakerId), ['alice', 'bob', 'alice']);
  assert.equal(Speaker.exportReady(r, new Map()), true);

  const srt = serializeSrt(Speaker.buildSpeakerEntries(remapped.mappings, r, new Map()));
  const { cues: parsed, errors: pErr } = parseSrt(srt);
  assert.equal(pErr.length, 0);
  assert.equal(parsed.length, 3);
  parsed.forEach((c, i) => {
    assert.equal(c.seq, i + 1); // 编号顺序不变
    assert.equal(c.start, remapped.mappings[i].start); // 时间不变
    assert.equal(c.end, remapped.mappings[i].end);
  });
  assert.deepEqual(parsed.map((c) => c.text), ['[alice] 你好', '[bob] 世界', '[alice] 你好']);
});
