'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSrt, serializeSrt, parseTimestamp, formatTimestamp } = require('../src/srt');
const { parseSegments } = require('../src/segments');
const { remap } = require('../src/remap');
const { wrapCueText, graphemes, tokenize } = require('../src/wrap');
const { buildPairs, buildBilingualEntries, overlapMs } = require('../src/pair');
const Correct = require('../src/correct');

function cue(seq, start, end, text = `t${seq}`) {
  return { index: seq - 1, seq, seqText: String(seq), start, end, text, startLine: 1, endLine: 1 };
}
function seg(order, sourceStart, sourceEnd, speed, line = order + 1) {
  return { order, line, raw: '', sourceStart, sourceEnd, speed };
}

test('时间戳解析与格式化', () => {
  assert.equal(parseTimestamp('00:00:01,500'), 1500);
  assert.equal(parseTimestamp('01:02:03.456'), 3723456); // 点号毫秒分隔符（小时可不补零）
  assert.equal(parseTimestamp('00:60:00,000'), null);   // 分必须 <=59 且两位
  assert.equal(parseTimestamp('0:00:00,000'), null);    // 秒/分必须两位补零
  assert.equal(parseTimestamp('00:00:60,000'), null);
  assert.equal(parseTimestamp('x'), null);
  assert.equal(formatTimestamp(0), '00:00:00,000');
  assert.equal(formatTimestamp(3723456), '01:02:03,456');
});

test('SRT 解析：多块、多行文本、保留空文本行以外的内容', () => {
  const srt = '1\r\n00:00:00,000 --> 00:00:01,000\r\nhello\r\nworld\r\n\r\n' +
    '2\r\n00:00:02,000 --> 00:00:03,000\r\nbye\r\n';
  const { cues, errors } = parseSrt(srt);
  assert.equal(errors.length, 0);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'hello\nworld');
  assert.equal(cues[1].text, 'bye');
});

test('SRT 解析：BOM 与首尾空行', () => {
  const { cues, errors } = parseSrt('﻿\n\n1\n00:00:00,000 --> 00:00:01,000\nx\n');
  assert.equal(errors.length, 0);
  assert.equal(cues.length, 1);
});

test('SRT 解析错误：坏序号、坏时间轴、倒置区间、空文本', () => {
  const bad = 'abc\n00:00:00,000 --> 00:00:01,000\nx\n\n' +
    '2\n00:00:01,000 --> nope\nx\n\n' +
    '3\n00:00:02,000 --> 00:00:02,000\nx\n\n' +
    '4\n00:00:03,000 --> 00:00:04,000\n\n';
  const { cues, errors } = parseSrt(bad);
  assert.equal(cues.length, 0);
  assert.equal(errors.length, 4);
  assert.ok(errors[0].block === 1 && /序号/.test(errors[0].message));
  assert.ok(/时间轴格式错误/.test(errors[1].message));
  assert.ok(/必须晚于/.test(errors[2].message));
  assert.ok(/缺少字幕文本/.test(errors[3].message));
});

test('剪辑段解析：空白/逗号分隔、注释、错误定位到行', () => {
  const input = '# comment\n0, 2000, 1\n  5000\t8000 2\nbad line\n0 0 1\n10 5 1\n3 4 3\n-1 2 1\n';
  const { segments, errors } = parseSegments(input);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments.map((s) => [s.sourceStart, s.sourceEnd, s.speed]),
    [[0, 2000, 1], [5000, 8000, 2]]);
  assert.equal(segments[0].order, 0);
  assert.equal(segments[1].line, 3);
  const msgs = errors.map((e) => e.message);
  assert.ok(/第 4 行.*3 个字段/.test(msgs[0]));
  assert.ok(/第 5 行.*必须晚于/.test(msgs[1]));
  assert.ok(/第 6 行.*必须晚于/.test(msgs[2]));
  assert.ok(/第 7 行.*倍速/.test(msgs[3]));
  assert.ok(/第 8 行.*负数/.test(msgs[4]));
});

test('剪辑段为空时报错', () => {
  assert.equal(parseSegments('# only comment\n').errors.length, 1);
});

test('基础重排：乱序段 + 跨切点拆分 + 半开区间', () => {
  const cues = [cue(1, 0, 3000, 'a'), cue(2, 3000, 6000, 'b')];
  // 先放后面的段，再放前面的段（乱序）；段1[4000,8000) 与字幕2在 4000/6000 切
  const segs = [seg(0, 4000, 8000, 1), seg(1, 0, 4000, 1)];
  const r = remap(cues, segs);
  // 字幕2在段0交集 [4000,6000) -> 输出 [0,2000)
  // 字幕1 [0,3000) -> 段1 输出 [4000,7000)；字幕2 [3000,4000) -> [7000,8000)
  assert.deepEqual(r.mappings.map((m) => [m.newIndex, m.start, m.end, m.seq]), [
    [1, 0, 2000, 2],
    [2, 4000, 7000, 1],
    [3, 7000, 8000, 2],
  ]);
  assert.equal(r.totalDurationMs, 8000);
  assert.deepEqual(r.sourceRows[0].outputs, [2]);
  assert.deepEqual(r.sourceRows[1].outputs, [1, 3]);
});

test('半开区间：端点相接不产生交集', () => {
  const cues = [cue(1, 5000, 6000)];
  const r = remap(cues, [seg(0, 0, 5000, 1)]); // [0,5000) 与 [5000,6000) 不交
  assert.equal(r.mappings.length, 0);
  assert.equal(r.sourceRows[0].status, 'missed');
});

test('重复使用的源段分别生成字幕（编号不同）', () => {
  const cues = [cue(1, 1000, 2000, 'repeat me')];
  const segs = [seg(0, 0, 3000, 1), seg(1, 0, 3000, 1)];
  const r = remap(cues, segs);
  assert.equal(r.mappings.length, 2);
  assert.deepEqual(r.mappings.map((m) => [m.start, m.end]), [[1000, 2000], [4000, 5000]]);
  assert.deepEqual(r.sourceRows[0].outputs, [1, 2]);
});

test('倍速映射：0.5x 拉长、2x 压缩', () => {
  const cues = [cue(1, 0, 2000), cue(2, 2000, 4000)];
  const segs = [seg(0, 0, 4000, 0.5), seg(1, 0, 4000, 2)];
  const r = remap(cues, segs);
  // 0.5x: 4s -> 8s；字幕1->[0,4000) 字幕2->[4000,8000)
  // 2x:   4s -> 2s；字幕1->[8000,9000) 字幕2->[9000,10000)
  assert.deepEqual(r.mappings.map((m) => [m.start, m.end]), [
    [0, 4000], [4000, 8000], [8000, 9000], [9000, 10000],
  ]);
  assert.equal(r.totalDurationMs, 10000);
  assert.equal(r.timeline[0].durationExactMs, 8000);
  assert.equal(r.timeline[1].durationExactMs, 2000);
});

test('精确累计与四舍五入：奇数毫秒源段在 2x 下产生半毫秒边界', () => {
  // 段 [0,3001) 2x -> 精确时长 1500.5ms，下一段起点半毫秒单位 3001
  const cues = [cue(1, 0, 5000)];
  const segs = [seg(0, 0, 3001, 2), seg(1, 0, 1000, 1)];
  const r = remap(cues, segs);
  // 段0：字幕交集 [0,3001) -> 半单位 [0,3001) -> [0ms, 1500.5ms] -> round [0,1501)
  // 段1：起点半单位 3001 -> 1501ms；字幕映射到 [1501, 2501)
  const first = r.mappings.find((m) => m.segOrder === 0);
  const second = r.mappings.find((m) => m.segOrder === 1);
  assert.deepEqual([first.start, first.end], [0, 1501]);
  assert.deepEqual([second.start, second.end], [1501, 2501]);
  assert.equal(r.totalDurationExactMs, 2500.5);
  assert.equal(r.totalDurationMs, 2501);
});

test('零长片段舍弃：交集映射并四舍五入到同一毫秒', () => {
  // 段 2x、段起点源偏移 1ms：交集源 [1,2) -> 输出 [0.5ms, 1.0ms)
  //   半单位 [1,2) -> round 得 [1,1)，零长舍弃
  // 段 2x、段起点偏移 0：交集源 [0,1) -> 半单位 [0,1) -> round [0,1)，1ms 保留
  const cues = [cue(1, 1, 2), cue(2, 0, 1)];
  const r = remap(cues, [seg(0, 0, 3000, 2)]);
  assert.equal(r.mappings.length, 1);
  assert.deepEqual([r.mappings[0].start, r.mappings[0].end], [0, 1]);
  assert.equal(r.dropped.length, 1);
  assert.deepEqual([r.dropped[0].intersectStart, r.dropped[0].intersectEnd], [1, 2]);
  assert.equal(r.sourceRows[0].status, 'zero-length');
  assert.equal(r.sourceRows[1].status, 'used');
});

test('同起点排序：剪辑段顺序优先于原字幕顺序；编号从 1 连续', () => {
  // 两段输出中两条字幕映射到同一输出起点 0
  const cues = [cue(1, 0, 1000), cue(2, 0, 1000)];
  const segs = [seg(0, 0, 1000, 1), seg(1, 0, 1000, 1)];
  const r = remap(cues, segs);
  // [0,1000) 处四条：(段0,源1)(段0,源2)(段1,源1)(段1,源2)
  assert.deepEqual(r.mappings.map((m) => [m.segOrder, m.cueIndex]), [
    [0, 0], [0, 1], [1, 0], [1, 1],
  ]);
  assert.deepEqual(r.mappings.map((m) => m.newIndex), [1, 2, 3, 4]);
});

test('序列化：重新编号且多行文本保留', () => {
  const cues = [{ start: 0, end: 1000, text: 'a\nb' }, { start: 2000, end: 3000, text: 'c' }];
  const srt = serializeSrt(cues);
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:01,000\na\nb\n\n2\n00:00:02,000 --> 00:00:03,000\nc\n');
});

test('重叠剪辑段各自独立映射', () => {
  const cues = [cue(1, 0, 10000)];
  const segs = [seg(0, 0, 2000, 1), seg(1, 1000, 3000, 1)]; // 重叠 [1000,2000)
  const r = remap(cues, segs);
  assert.deepEqual(r.mappings.map((m) => [m.start, m.end]), [[0, 2000], [2000, 4000]]);
});

// ---------- 字幕自动换行 ----------

/** 便捷断言：成功时返回每行文本数组与各项宽度。 */
function wrapLines(text, w) {
  const r = wrapCueText(text, w);
  assert.equal(r.ok, true, r.reason || 'wrap 应成功');
  return r.lines.map((l) => l.text);
}

test('换行：宽度计数（ASCII 计 1、其他字素簇计 2）', () => {
  // 上限 6：abcd(4)+空格+你(2)=7 放不下 -> 拆两行，剩余 (6-4)^2+(6-4)^2 平衡
  assert.deepEqual(wrapLines('abcd 你好', 6), ['abcd', '你好']);
  assert.deepEqual(wrapLines('你好世界', 4), ['你好', '世界']);
});

test('换行：连续 ASCII 字母数字不可拆', () => {
  // hello 宽 5，上限 4 -> 原子超宽无解
  const r = wrapCueText('hello', 4);
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, 'token-too-wide');
  assert.equal(r.text, 'hello'); // 保留原文
  // 含数字的连续串同样不可拆
  assert.equal(wrapCueText('abc123', 5).reasonCode, 'token-too-wide');
  assert.deepEqual(wrapLines('abc123 x', 7), ['abc123', 'x']);
});

test('换行：空白折叠与首尾空白去除，换行处空白移除', () => {
  assert.deepEqual(wrapLines('  aa   bb  ', 5), ['aa bb']); // aa(2)+空(1)+bb(2)=5
  assert.deepEqual(wrapLines('aa\t\nbb', 4), ['aa', 'bb']); // 宽度不足被迫断行，断点空白移除
  assert.deepEqual(wrapLines('aa bb cc', 5), ['aa', 'bb cc']); // 两种两行同分 -> 靠前断点
});

test('换行：非空白字符顺序不变（仅调整空白/换行）', () => {
  const original = 'Hello， 世界（test）！\n第二行 ABC';
  const r = wrapCueText(original, 12);
  assert.equal(r.ok, true);
  assert.deepEqual(original.replace(/\s+/g, ''), r.text.replace(/\s+/g, ''));
});

test('换行：行首禁断闭合标点、行尾禁断开口标点', () => {
  // 上限 8（你好=4、「世界」=6、，结束=6）：唯一可行断点保证
  // 「 不落行尾、， 不落行首
  const r = wrapCueText('你好「世界」，结束', 8);
  assert.equal(r.ok, true);
  for (const l of r.lines) {
    assert.ok(!'，。！？、；：）》」'.includes(l[0]), `行首非法：${l}`);
    assert.ok(!'（《「'.includes(l[l.length - 1]), `行尾非法：${l}`);
  }
  assert.deepEqual(r.lines.map((l) => l.text), ['你好「世', '界」，', '结束']);

  // 上限 6 时三行内无合法断点（， 既不能在行首，能断的位置又会让 「 落行尾）
  const impossible = wrapCueText('你好「世界」，结束', 6);
  assert.equal(impossible.ok, false);
  assert.equal(impossible.reasonCode, 'punctuation');
});

test('换行：开口标点不允许出现在行尾（调整断点）', () => {
  // 你好世界「abc」总宽 13，上限 8：
  //   你好世界 | 「abc」 行尾为「非法；你好 | 世界「abc」 宽 9>8
  //   合法解为 3 行：你好世界 / 「abc」（宽7）→ 实为两行即可：
  //   你好世界(8) + 「abc」(7) 中间断在 「 前 => 上行行尾是「非法，
  //   故必须把 「 留到行首 -> 你好 | 世界 | 「abc」 之类
  const r = wrapCueText('你好世界「abc」', 8);
  assert.equal(r.ok, true);
  for (const l of r.lines) {
    assert.ok(!'（《「'.includes(l[l.length - 1]), '行尾不允许开口标点');
    assert.ok(!'，。！？、；：）》」'.includes(l[0]), '行首不允许闭合标点');
  }
  assert.ok(r.lines[r.lines.length - 1].text.endsWith('」'));
});

test('换行：超三行 -> too-many-lines 并保留原文', () => {
  const text = '你好世界再见啦朋友'; // 9 个全角字 = 宽 18
  const r = wrapCueText(text, 4); // 最少 ceil(18/4)=5 行
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, 'too-many-lines');
  assert.equal(r.text, text);
});

test('换行：放得下但标点约束无合法断点 -> punctuation 并保留原文', () => {
  // 上限 8：a，你好！b 宽 10，需两行；仅有的断点（，/你 与 ！/b）
  // 都会把闭合标点留在行尾？不——规则禁的是闭合标点在行首：
  // 构造：你好，。！？、；：） 全部为闭合标点，任何断点的下一行行首都非法
  const text = 'ab，。！c'; // 宽 2+2*4+2 = 12；上限 6 贪心 2 行
  const r = wrapCueText(text, 6);
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, 'punctuation');
  assert.equal(r.text, text);
});

test('换行：先取最少行数', () => {
  // 6 个全角字宽 12：上限 8 时 1 行放不下，2 行即可；不应给 3 行
  const r = wrapCueText('一二三四五六', 8);
  assert.equal(r.ok, true);
  assert.equal(r.lines.length, 2);
});

test('换行：同分时取更靠前的断点', () => {
  // 5 个全角字，上限 6：两种两行方案
  //   [一二|三四五] 余 (6-4)^2+(6-6)^2 = 4 ，断点 i=2
  //   [一二三|四五] 余 (6-6)^2+(6-4)^2 = 4 ，断点 i=3
  // 同分 -> 取靠前断点 i=2
  const r = wrapCueText('一二三四五', 6);
  assert.deepEqual(r.lines.map((l) => l.text), ['一二', '三四五']);
});

test('换行：三行上限下的最优剩余宽度平方和', () => {
  // 6 全角字，上限 4：每行恰好 2 字（剩余 0）
  const r = wrapCueText('一二三四五六', 4);
  assert.equal(r.lines.length, 3);
  assert.deepEqual(r.lines.map((l) => [l.width, l.remain]), [[4, 0], [4, 0], [4, 0]]);
});

test('换行：CJK 间无空格可插入换行；行内不凭空加空格', () => {
  const r = wrapCueText('你好世界', 4);
  assert.deepEqual(r.lines.map((l) => l.text), ['你好', '世界']);
  assert.equal(r.text, '你好\n世界');
});

test('换行：emoji ZWJ 序列按一个字素簇计宽 2', () => {
  const family = '👨‍👩‍👧';
  assert.equal(graphemes(family).length, 1);
  const r = wrapCueText(`${family} ${family}`, 4); // 5 宽放不下一行
  assert.equal(r.ok, true);
  assert.deepEqual(r.lines.map((l) => [l.width, l.remain]), [[2, 2], [2, 2]]);
});

test('换行：全角标点各为独立 token，不与相邻字粘连', () => {
  const { tokens } = tokenize('你好，世界');
  assert.deepEqual(tokens.map((t) => t.str), ['你', '好', '，', '世', '界']);
});

test('换行：空文本与空白文本', () => {
  assert.equal(wrapCueText('', 10).text, '');
  const r = wrapCueText('   \n\t ', 10);
  assert.equal(r.ok, true);
  assert.equal(r.text, '');
});

test('换行：宽度超范围抛异常', () => {
  assert.throws(() => wrapCueText('x', 3));
  assert.throws(() => wrapCueText('x', 41));
  assert.throws(() => wrapCueText('x', 12.5));
  assert.throws(() => wrapCueText('x', NaN));
});

test('换行 + 重排串联：编号/时间/来源不变，仅文本空白与换行变化', () => {
  const cues = [
    cue(1, 0, 2000, '第一句话很长很长   需要换行'),
    cue(2, 2000, 4000, 'second'),
  ];
  const r = remap(cues, [seg(0, 0, 5000, 1)]);
  assert.equal(r.mappings.length, 2);
  const wrapped = r.mappings.map((m) => {
    const w = wrapCueText(m.text, 8);
    assert.equal(w.ok, true);
    return { start: m.start, end: m.end, text: w.text };
  });
  // 时间、顺序保持
  assert.deepEqual(wrapped.map((x) => [x.start, x.end]), [[0, 2000], [2000, 4000]]);
  const srt = serializeSrt(wrapped);
  assert.match(srt, /1\n00:00:00,000 --> 00:00:02,000\n/);
  // 去掉所有空白后与原文一致
  assert.equal(wrapped[0].text.replace(/\s+/g, ''), cues[0].text.replace(/\s+/g, ''));
});

// ---------- 双语字幕配对 ----------

/** 构造一条重排结果（同 remap mappings 字段的最小子集）。 */
function pm(newIndex, segOrder, start, end, cueIndex, seq = cueIndex + 1, text = `M${newIndex}`) {
  return { newIndex, segOrder, start, end, cueIndex, seq, text };
}
function pt(newIndex, segOrder, start, end, cueIndex, seq = cueIndex + 1, text = `T${newIndex}`) {
  return { newIndex, segOrder, start, end, cueIndex, seq, text };
}

test('配对：正时长交集（半开），端点相接不配对', () => {
  assert.equal(overlapMs({ start: 0, end: 1000 }, { start: 500, end: 1500 }), 500);
  assert.equal(overlapMs({ start: 0, end: 1000 }, { start: 1000, end: 2000 }), 0);
  assert.equal(overlapMs({ start: 2000, end: 3000 }, { start: 0, end: 1000 }), 0);
});

test('配对：同段一对一、保持顺序，按交集最大化', () => {
  // 主 [0,2000) [2000,4000)；译文 [0,1000) 与主1交1000，[1000,3000) 与主1交1000/与主2交1000
  const main = [pm(1, 0, 0, 2000, 0), pm(2, 0, 2000, 4000, 1)];
  const trans = [pt(1, 0, 0, 1000, 0), pt(2, 0, 1000, 3000, 1)];
  const r = buildPairs(main, trans);
  assert.equal(r.pairCount, 2);
  assert.equal(r.totalOverlapMs, 2000);
  assert.deepEqual(r.pairs.map((p) => [p.mainNewIndex, p.transNewIndex]), [[1, 1], [2, 2]]);
  assert.deepEqual(r.unpairedMain, []);
  assert.deepEqual(r.unpairedTrans, []);
});

test('配对：不同剪辑段之间绝不配对（即使输出时间相交）', () => {
  // 人为构造不同 segOrder 但输出时间相同的片段，必须不配对
  const main = [pm(1, 0, 0, 2000, 0)];
  const trans = [pt(1, 1, 0, 2000, 0)];
  const r = buildPairs(main, trans);
  assert.equal(r.pairCount, 0);
  assert.deepEqual(r.unpairedMain, [1]);
  assert.deepEqual(r.unpairedTrans, [1]);
});

test('配对：交集总和优先于配对数', () => {
  // 主 A[0,1000)、A'[1000,3000)；
  // 译文 B长[0,3000)(cue5，按起点排第一)、B短[1000,1100)(cue6)。
  // 两配对方案 (A,B长)+(A',B短) = 1000+100 = 1100；
  // 只配 (A',B长) = 2000 -> 交集总和更大，即使少一对也优先。
  const main = [pm(1, 0, 0, 1000, 0), pm(2, 0, 1000, 3000, 1)];
  const trans = [
    pt(1, 0, 0, 3000, 5, 6),
    pt(2, 0, 1000, 1100, 6, 7),
  ];
  const r = buildPairs(main, trans);
  assert.equal(r.totalOverlapMs, 2000);
  assert.equal(r.pairCount, 1);
  assert.deepEqual(r.pairs.map((p) => [p.mainNewIndex, p.transNewIndex]), [[2, 1]]);
  assert.deepEqual(r.unpairedMain, [1]);
  assert.deepEqual(r.unpairedTrans, [2]);
});

test('配对：交集总和相同取配对数最多', () => {
  // 主 A[0,1000)、A'[1000,2000)；译文 B[0,250)、B2[250,1500)。
  // 只配 (A,B2)：交集 750（1 对）；两配对 (A,B)+(A',B2)：250+500=750（2 对）
  // -> 总和相同，取配对数更多的两配对方案。
  const main = [pm(1, 0, 0, 1000, 0), pm(2, 0, 1000, 2000, 1)];
  const trans = [
    pt(1, 0, 0, 250, 5, 6),
    pt(2, 0, 250, 1500, 6, 7),
  ];
  const r = buildPairs(main, trans);
  assert.equal(r.totalOverlapMs, 750);
  assert.equal(r.pairCount, 2);
  assert.deepEqual(r.pairs.map((p) => [p.mainNewIndex, p.transNewIndex]), [[1, 1], [2, 2]]);
});

test('配对：总和与配对数相同取 (主编号, 译文原序) 序列字典序最小', () => {
  // 主 A[0,1000)、A'[1000,2000)；译文 B[0,2000)(cue 4)、B'(cue 5)
  // 方案1 (A,B) 交1000；方案2 (A',B) 交1000；权重与配对数相同 -> 配主编号最小的 A
  const main = [pm(1, 0, 0, 1000, 0), pm(2, 0, 1000, 2000, 1)];
  const trans = [pt(1, 0, 0, 2000, 4, 5)];
  const r = buildPairs(main, trans);
  assert.equal(r.totalOverlapMs, 1000);
  assert.deepEqual(r.pairs.map((p) => [p.mainNewIndex, p.transCueIndex]), [[1, 4]]);
});

test('配对：同主字幕多个最优候选译文时取译文原序最小', () => {
  // 主 A[0,1000)；译文 B0(cue 7)[0,1000)、B1(cue 3)[0,1000) 同起点、同交1000，
  // 排序后顺序为 B1(cue3)、B0(cue7)；字典序要求选 cueIndex=3
  const main = [pm(1, 0, 0, 1000, 0)];
  const trans = [
    pt(1, 0, 0, 1000, 7, 8),
    pt(2, 0, 0, 1000, 3, 4),
  ];
  const r = buildPairs(main, trans);
  assert.equal(r.pairCount, 1);
  assert.deepEqual(r.pairs.map((p) => [p.mainNewIndex, p.transCueIndex]), [[1, 3]]);
});

test('配对：跨切点拆分字幕分别在各自剪辑段内配对，结果按主编号排序', () => {
  // seg0 内主 #1/#3 与译文 #1/#3 各自相交；seg1 内主 #2 与译文 #2 相交；
  // 段间即使输出时间重叠（seg1 的 [0,2000) 与 seg0 重叠）也不跨段配对。
  const main = [
    pm(1, 0, 0, 1000, 0),
    pm(2, 1, 0, 2000, 5),
    pm(3, 0, 1000, 2000, 1),
  ];
  const trans = [
    pt(1, 0, 0, 1000, 0),
    pt(2, 1, 0, 2000, 9),
    pt(3, 0, 1000, 2000, 2),
  ];
  const r = buildPairs(main, trans);
  assert.equal(r.pairCount, 3);
  assert.deepEqual(r.pairs.map((p) => [p.mainNewIndex, p.transNewIndex, p.segOrder]),
    [[1, 1, 0], [2, 2, 1], [3, 3, 0]]);
});

test('配对：无任何交集时全部未配对', () => {
  const main = [pm(1, 0, 0, 1000, 0)];
  const trans = [pt(1, 0, 2000, 3000, 0)];
  const r = buildPairs(main, trans);
  assert.equal(r.pairCount, 0);
  assert.deepEqual(r.unpairedMain, [1]);
  assert.deepEqual(r.unpairedTrans, [1]);
});

test('双语条目：时间与编号以主字幕为准，正文先主后译，未配对主字幕保留单语', () => {
  const main = [pm(1, 0, 0, 1000, 0, 1, '主一'), pm(2, 0, 1000, 2000, 1, 2, '主二')];
  const trans = [pt(1, 0, 0, 900, 0, 1, 'EN ONE')];
  const r = buildPairs(main, trans);
  const entries = buildBilingualEntries(main, trans, r);
  assert.deepEqual(entries.map((e) => [e.start, e.end]), [[0, 1000], [1000, 2000]]);
  assert.equal(entries[0].text, '主一\nEN ONE');
  assert.equal(entries[1].text, '主二'); // 未配对主字幕单语
});

test('双语条目：mainText 选项取排版后主文，译文保持原文', () => {
  const main = [pm(1, 0, 0, 1000, 0, 1, '主文原文')];
  const trans = [pt(1, 0, 0, 1000, 0, 1, 'EN')];
  const r = buildPairs(main, trans);
  main[0].wrappedText = '主文排版';
  const entries = buildBilingualEntries(main, trans, r, { mainText: (m) => m.wrappedText });
  assert.equal(entries[0].text, '主文排版\nEN');
});

test('配对 + remap 串联：译文沿用同一剪辑段与倍速重排后配对', () => {
  const mainCues = [cue(1, 0, 3000, '主'), cue(2, 3000, 6000, '主二')];
  const transCues = [cue(1, 0, 3000, 'EN1'), cue(2, 3000, 6000, 'EN2')];
  const segs = [seg(0, 0, 6000, 1)];
  const mainMap = remap(mainCues, segs).mappings;
  const transMap = remap(transCues, segs).mappings;
  const r = buildPairs(mainMap, transMap);
  assert.deepEqual(r.pairs.map((p) => [p.mainNewIndex, p.transNewIndex]), [[1, 1], [2, 2]]);
});

// ---------- 源字幕勘误回写 ----------

test('勘误校验：空正文与空白行拒绝，换行符与首尾空白规范化', () => {
  assert.equal(Correct.validateRevision('').ok, false);
  assert.equal(Correct.validateRevision('   \n\t ').ok, false);
  assert.equal(Correct.validateRevision('好的\n\n不好').ok, false);
  assert.match(Correct.validateRevision('a\n \nb').error, /第 2 行为空白行/);
  const ok = Correct.validateRevision('  第一行\r\n第二行  ');
  assert.equal(ok.ok, true);
  assert.equal(ok.text, '第一行\n第二行');
});

test('勘误归并：同源共享一份修订，相同正文不冲突', () => {
  const st = Correct.createState();
  assert.equal(Correct.submitRevision(st, 0, '版本A').status, 'revised');
  assert.equal(Correct.submitRevision(st, 0, '版本A').status, 'unchanged');
  assert.equal(st.revisions.get(0), '版本A');
  assert.equal(st.conflicts.size, 0);
  assert.equal(Correct.exportBlocked(st), false);
});

test('勘误冲突：不同正文入候选待裁决，不按最后一次编辑覆盖', () => {
  const st = Correct.createState();
  Correct.submitRevision(st, 0, '版本A');
  const r = Correct.submitRevision(st, 0, '版本B');
  assert.equal(r.status, 'conflict');
  assert.deepEqual(r.candidates, ['版本A', '版本B']);
  // 未裁决：修订被挂起（不生效任何一版，尤其不是最后编辑的 B），导出被禁止
  assert.equal(st.revisions.has(0), false);
  assert.equal(Correct.exportBlocked(st), true);
  // 第三版追加为候选；重复提交已有候选不重复添加
  Correct.submitRevision(st, 0, '版本C');
  Correct.submitRevision(st, 0, '版本A');
  assert.deepEqual(st.conflicts.get(0).candidates, ['版本A', '版本B', '版本C']);
  // 显式裁决后生效
  const rr = Correct.resolveConflict(st, 0, '版本B');
  assert.equal(rr.ok, true);
  assert.equal(st.revisions.get(0), '版本B');
  assert.equal(Correct.exportBlocked(st), false);
});

test('勘误裁决：只能选定列出的候选；无冲突时报错', () => {
  const st = Correct.createState();
  Correct.submitRevision(st, 0, '版本A');
  Correct.submitRevision(st, 0, '版本B');
  assert.equal(Correct.resolveConflict(st, 0, '版本X').ok, false);
  assert.equal(Correct.exportBlocked(st), true); // 仍未裁决
  assert.equal(Correct.resolveConflict(st, 1, '版本A').ok, false);
});

test('勘误撤销：修订与冲突均可撤销，恢复原文', () => {
  const st = Correct.createState();
  Correct.submitRevision(st, 0, '版本A');
  Correct.submitRevision(st, 1, '甲');
  Correct.submitRevision(st, 1, '乙');
  assert.equal(Correct.revertRevision(st, 0), true);
  assert.equal(Correct.revertRevision(st, 1), true);
  assert.equal(st.revisions.size, 0);
  assert.equal(st.conflicts.size, 0);
  assert.equal(Correct.revertRevision(st, 5), false);
});

test('勘误导出：未修订（含未进入输出）保持原文，源时间与条目顺序不变', () => {
  const cues = [
    cue(1, 0, 3000, '原文一'),
    cue(2, 3000, 6000, '原文二'),
    cue(3, 8000, 9000, '未进入输出'),
  ];
  const st = Correct.createState();
  Correct.submitRevision(st, 0, '修订一\n第二行');
  const corrected = Correct.buildCorrectedCues(cues, st);
  assert.deepEqual(corrected.map((c) => [c.start, c.end]), [[0, 3000], [3000, 6000], [8000, 9000]]);
  assert.equal(corrected[0].text, '修订一\n第二行');
  assert.equal(corrected[1].text, '原文二');
  assert.equal(corrected[2].text, '未进入输出');
});

test('勘误 + 重排串联：勘误后源 SRT 重新重排，同源输出文本一致', () => {
  const cues = [
    cue(1, 0, 3000, '原文一'),
    cue(2, 3000, 6000, '原文二'),
    cue(3, 8000, 9000, '未进入输出'),
  ];
  const st = Correct.createState();
  Correct.submitRevision(st, 0, '修订一\n第二行');
  // 序列化→重新解析等价于前端“导出勘误后源 SRT 再按现有剪辑段重排”的流程
  const srt = serializeSrt(Correct.buildCorrectedCues(cues, st));
  const { cues: parsed, errors } = parseSrt(srt);
  assert.equal(errors.length, 0);
  assert.equal(parsed.length, 3);
  // 重复使用的源段 + 跨切点拆分：源1 产生多条输出
  const segs = [seg(0, 0, 5000, 1), seg(1, 2000, 4000, 2), seg(2, 0, 5000, 1)];
  const r = remap(parsed, segs);
  const outs1 = r.mappings.filter((m) => m.cueIndex === 0);
  assert.ok(outs1.length > 1);
  assert.ok(outs1.every((m) => m.text === '修订一\n第二行'));
  const outs2 = r.mappings.filter((m) => m.cueIndex === 1);
  assert.ok(outs2.length > 1);
  assert.ok(outs2.every((m) => m.text === '原文二'));
  // 未进入输出的源字幕仍在源序列中且保持原文
  assert.equal(parsed[2].text, '未进入输出');
  assert.equal(r.sourceRows[2].status, 'missed');
});
