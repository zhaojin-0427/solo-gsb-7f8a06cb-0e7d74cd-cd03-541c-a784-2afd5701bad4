'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const VC = require('../src/voicecheck');
const { parseSrt } = require('../src/srt');
const { parseSegments } = require('../src/segments');
const { remap } = require('../src/remap');

function mapping(newIndex, start, end, text) {
  return { newIndex, cueIndex: newIndex - 1, seq: newIndex, start, end, text };
}

test('词元化：连续 ASCII 字母数字聚为一个词元，大小写折叠；空白标点符号忽略', () => {
  const toks = VC.tokenizeText('  Hello, World42!! ABC-123 ');
  assert.deepEqual(toks.map((t) => [t.key, t.str]), [
    ['hello', 'Hello'],
    ['world42', 'World42'],
    ['abc', 'ABC'],
    ['123', '123'], // 连字符为符号，两侧不聚合
  ]);
});

test('词元化：其他 Unicode 字母/数字按字素簇逐个计，标点忽略', () => {
  const toks = VC.tokenizeText('你好，世界123！');
  assert.deepEqual(toks.map((t) => t.key), ['你', '好', '世', '界', '123']);
  // 全角数字、带圈数字、希腊字母各自独立成词元
  const toks2 = VC.tokenizeText('１２①αΩ');
  assert.deepEqual(toks2.map((t) => t.key), ['１', '２', '①', 'α', 'Ω']);
});

test('词元化：组合字素簇（ASCII 基字 + 组合记号）按一个“其他字母”词元计，emoji 符号忽略', () => {
  // café 的 é 为 e + combining acute 的单一字素簇：ASCII 游程 caf 截止，
  // é 整体（首码点为字母）一个词元；👨‍👩‍👧 是符号忽略
  assert.deepEqual(VC.tokenizeText('café! 👨‍👩‍👧 x').map((t) => t.str), ['caf', 'é', 'x']);
  // NFC 的 é（U+00E9）同理为一个非 ASCII 字母词元
  assert.deepEqual(VC.tokenizeText('café').map((t) => t.str), ['caf', 'é']);
});

test('词元化：偏移为原文 UTF-16 区间，片段可据此切回原文', () => {
  const raw = '  你好，world!';
  const toks = VC.tokenizeText(raw);
  assert.equal(raw.slice(toks[0].start, toks[2].end), '你好，world');
});

test('对齐：基础 LCS 与跨条目串接', () => {
  const maps = [mapping(1, 0, 1000, '你好'), mapping(2, 1000, 2000, '世界')];
  const r = VC.verifyScript('你好世界', maps);
  assert.ok(r.ok);
  assert.equal(r.scriptCount, 4);
  assert.equal(r.subtitleCount, 4);
  assert.equal(r.matchedCount, 4);
  assert.equal(r.scriptFragments.length, 0);
  assert.equal(r.subtitleFragments.length, 0);
});

test('对齐：稿件多出片段与字幕多出片段同时列出', () => {
  const maps = [mapping(1, 0, 1000, '你好世界')];
  const r = VC.verifyScript('你好呀世界哦', maps);
  assert.ok(r.ok);
  assert.equal(r.matchedCount, 4);
  assert.deepEqual(r.scriptFragments.map((f) => f.text), ['呀', '哦']);
  assert.deepEqual(r.subtitleFragments.map((f) => f.text), []);

  const r2 = VC.verifyScript('你好', maps);
  assert.equal(r2.matchedCount, 2);
  assert.equal(r2.subtitleFragments.length, 1);
  assert.equal(r2.subtitleFragments[0].text, '世界');
  assert.equal(r2.subtitleFragments[0].newIndex, 1);
});

test('对齐：稿件未匹配片段以前后相邻已匹配字幕定位', () => {
  const maps = [
    mapping(1, 0, 1000, '甲'),
    mapping(2, 1000, 2000, '乙'),
    mapping(3, 2000, 3000, '丙'),
  ];
  const r = VC.verifyScript('X甲Y乙Z丙W', maps);
  assert.ok(r.ok);
  assert.equal(r.scriptFragments.length, 4);
  const [f0, f1, f2, f3] = r.scriptFragments;
  assert.equal(f0.text, 'X');
  assert.equal(f0.prev, null);
  assert.equal(f0.next.newIndex, 1);
  assert.equal(f1.text, 'Y');
  assert.equal(f1.prev.newIndex, 1);
  assert.equal(f1.next.newIndex, 2);
  assert.equal(f2.text, 'Z');
  assert.equal(f2.prev.newIndex, 2);
  assert.equal(f2.next.newIndex, 3);
  assert.equal(f3.text, 'W');
  assert.equal(f3.prev.newIndex, 3);
  assert.equal(f3.next, null);
});

test('对齐：字幕多出片段跨输出条目边界时按条目拆开并标注时间', () => {
  const maps = [
    mapping(1, 0, 1000, '多一'),
    mapping(2, 1000, 2000, '匹配'),
    mapping(3, 2000, 3000, '多二'),
  ];
  const r = VC.verifyScript('匹配', maps);
  assert.ok(r.ok);
  assert.deepEqual(r.subtitleFragments.map((f) => [f.newIndex, f.text]), [
    [1, '多一'],
    [3, '多二'],
  ]);
  assert.deepEqual([r.subtitleFragments[0].start, r.subtitleFragments[0].end], [0, 1000]);
});

test('对齐：同一条目内分散的未匹配词元分别成段', () => {
  const maps = [mapping(1, 0, 1000, '甲多乙多丙')];
  const r = VC.verifyScript('甲乙丙', maps);
  assert.deepEqual(r.subtitleFragments.map((f) => f.text), ['多', '多']);
  assert.equal(r.subtitleFragments[0].newIndex, 1);
});

test('对齐同分裁决：匹配对序列按 (稿件位置, 字幕位置) 字典序最小', () => {
  // 连续 ASCII 聚成一个词元，故用空格分隔的英文词构造多词元序列
  // 两个 a 词：最优可 (0,0)/(1,1) 或 (0,1)/(1,0)，取前者
  let p = VC.alignTokens(
    VC.tokenizeText('a a'),
    VC.tokenizeMappings([mapping(1, 0, 1, 'a a')]).flat,
  ).pairs;
  assert.deepEqual(p.map((q) => [q.scriptIndex, q.subtitleIndex]),
    [[0, 0], [1, 1]]);

  // script='a b', subs='a b a b'：字典序最小取前两个
  p = VC.alignTokens(
    VC.tokenizeText('a b'),
    VC.tokenizeMappings([mapping(1, 0, 1, 'a b a b')]).flat,
  ).pairs;
  assert.deepEqual(p.map((q) => [q.scriptIndex, q.subtitleIndex]),
    [[0, 0], [1, 1]]);

  // script='a b a', subs='b a'：LCS 长度 2，字典序最小为 (1,0)(2,1)
  p = VC.alignTokens(
    VC.tokenizeText('a b a'),
    VC.tokenizeMappings([mapping(1, 0, 1, 'b a')]).flat,
  ).pairs;
  assert.deepEqual(p.map((q) => [q.scriptIndex, q.subtitleIndex]),
    [[1, 0], [2, 1]]);

  // 可提前配对但非最优时跳过当前稿件词元：script='x a', subs='a'
  // x 无法在最优方案（长度1，配 a）中出现 -> 跳过 x 后配 (1,0)
  p = VC.alignTokens(
    VC.tokenizeText('x a'),
    VC.tokenizeMappings([mapping(1, 0, 1, 'a')]).flat,
  ).pairs;
  assert.deepEqual(p.map((q) => [q.scriptIndex, q.subtitleIndex]),
    [[1, 0]]);
});

test('对齐：ASCII 大小写不敏感；非 ASCII 大小写敏感', () => {
  const maps = [mapping(1, 0, 1000, 'Hello WORLD')];
  const r = VC.verifyScript('hello world', maps);
  assert.equal(r.matchedCount, 2);
  // 希腊字母大写不折叠到小写
  const toksA = VC.tokenizeText('Α');
  const toksB = VC.tokenizeText('α');
  assert.notEqual(toksA[0].key, toksB[0].key);
});

test('校验：空输入或仅有空白/标点/符号不生成报告', () => {
  let r = VC.verifyScript('   ', [mapping(1, 0, 1, '甲')]);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'empty');
  r = VC.verifyScript('，。！？⋯ 🎉\n', [mapping(1, 0, 1, '甲')]);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'empty');
});

test('校验：任一侧超过 1500 词元不生成报告并给出实际词元数', () => {
  const longScript = '甲'.repeat(VC.MAX_TOKENS + 1);
  let r = VC.verifyScript(longScript, [mapping(1, 0, 1, '甲')]);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'too-many');
  assert.equal(r.side, 'script');
  assert.equal(r.count, VC.MAX_TOKENS + 1);

  // 连续 ASCII 按“词元”计而非按字符：1501 个以空格分隔的英文词
  const words = Array.from({ length: VC.MAX_TOKENS + 1 }, (_, i) => `w${i}`).join(' ');
  r = VC.verifyScript('甲', [mapping(1, 0, 1, words)]);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'too-many');
  assert.equal(r.side, 'subtitle');
  assert.equal(r.count, VC.MAX_TOKENS + 1);
});

test('边界：1500 词元恰好允许；字幕为空（无输出）时全部稿件词元未匹配', () => {
  const r = VC.verifyScript('甲'.repeat(VC.MAX_TOKENS), [mapping(1, 0, 1, '甲'.repeat(VC.MAX_TOKENS))]);
  assert.ok(r.ok);
  assert.equal(r.matchedCount, VC.MAX_TOKENS);

  const empty = VC.verifyScript('你好', []);
  assert.ok(empty.ok);
  assert.equal(empty.subtitleCount, 0);
  assert.equal(empty.scriptFragments.length, 1);
  assert.equal(empty.scriptFragments[0].text, '你好');
  assert.equal(empty.scriptFragments[0].prev, null);
  assert.equal(empty.scriptFragments[0].next, null);
});

test('片段原文保留标点与空白：从首个到末个词元的完整原文区间切取', () => {
  const maps = [mapping(1, 0, 1000, '你好世界')];
  const r = VC.verifyScript(' 开头，你好——世界！结尾…', maps);
  assert.ok(r.ok);
  // 两段：开头 与 结尾；中间“你好世界”匹配；
  // 词元游程外（紧邻已匹配词元）的标点不计入片段，游程内部的标点随原文保留
  assert.equal(r.scriptFragments.length, 2);
  assert.equal(r.scriptFragments[0].text, '开头');
  assert.equal(r.scriptFragments[1].text, '结尾');

  // 未匹配游程内部的标点/空白随原文区间保留
  const r2 = VC.verifyScript('你好，呀、哦世界', maps);
  assert.deepEqual(r2.scriptFragments.map((f) => f.text), ['呀、哦']);
});

// ---- 回归：字幕条目边界拆词（先串接后切分） ----

test('边界整词：相邻条目交界处的 ASCII 字母数字跨条目聚为一个词元并匹配', () => {
  // 旧行为逐条切分时 'wo'/'rld' 是两个词元，无法匹配稿件中的 'world'
  const maps = [
    mapping(1, 0, 1000, '他说 hello wo'),
    mapping(2, 1000, 2000, 'rld 你好'),
  ];
  const r = VC.verifyScript('他说 hello world 你好', maps);
  assert.ok(r.ok);
  // 串接文本 '他说 hello world 你好'：他 说 hello world 你 好
  assert.equal(r.subtitleCount, 6);
  assert.equal(r.scriptCount, 6);
  assert.equal(r.matchedCount, 6);
  assert.equal(r.scriptFragments.length, 0);
  assert.equal(r.subtitleFragments.length, 0);
});

test('边界整词：跨条目词元归属起点所在条目并带该条编号与时间；可连续跨多条目', () => {
  const { flat, joined } = VC.tokenizeMappings([
    mapping(1, 0, 1000, 'ab'),
    mapping(2, 1000, 2000, 'cd'),
    mapping(3, 2000, 3000, ' ef'),
  ]);
  assert.equal(joined, 'abcd ef');
  assert.deepEqual(flat.map((t) => [t.str, t.cueNewIndex, t.outStart, t.outEnd]), [
    ['abcd', 1, 0, 1000], // 跨条目 1→2，归属起点所在条目 1
    ['ef', 3, 2000, 3000],
  ]);
  // 起点/终点为串接文本偏移，跨条目词元区间越过边界
  assert.deepEqual([flat[0].start, flat[0].end], [0, 4]);
});

test('边界整词：稿件片段的相邻匹配锚点定位到跨条目词元的起点条目', () => {
  const maps = [
    mapping(1, 0, 1000, 'he'),
    mapping(2, 1000, 2000, 'llo 世界'),
  ];
  const r = VC.verifyScript('hello 嗯 世界', maps);
  assert.ok(r.ok);
  assert.equal(r.matchedCount, 3); // hello（跨 1→2）、世、界
  assert.equal(r.scriptFragments.length, 1);
  const f = r.scriptFragments[0];
  assert.equal(f.text, '嗯');
  // hello 跨条目 1→2：前锚点为起点条目 1；世在条目 2：后锚点为条目 2
  assert.deepEqual([f.prev.newIndex, f.prev.start, f.prev.end], [1, 0, 1000]);
  assert.deepEqual([f.next.newIndex, f.next.start, f.next.end], [2, 1000, 2000]);
});

test('边界整词：跨条目词元未匹配时字幕多出片段完整显示整词并标注起点条目', () => {
  const maps = [
    mapping(1, 0, 1000, 'a wo'),
    mapping(2, 1000, 2000, 'rld b'),
  ];
  const r = VC.verifyScript('a b', maps);
  assert.ok(r.ok);
  assert.equal(r.matchedCount, 2); // a、b；'world'（跨 1→2）多出
  assert.equal(r.subtitleFragments.length, 1);
  const f = r.subtitleFragments[0];
  assert.equal(f.text, 'world'); // 完整整词随起点条目显示
  assert.deepEqual([f.newIndex, f.start, f.end], [1, 0, 1000]);
});

test('边界整词：交界处有标点或空白时不跨条目聚合（普通词、标点不受影响）', () => {
  // 标点截断 ASCII 游程：'wo,' + 'rld' 仍是两个词元
  let maps = [mapping(1, 0, 1000, 'wo,'), mapping(2, 1000, 2000, 'rld')];
  assert.deepEqual(VC.tokenizeMappings(maps).flat.map((t) => t.key), ['wo', 'rld']);
  let r = VC.verifyScript('wo rld', maps);
  assert.equal(r.matchedCount, 2);
  assert.equal(r.subtitleFragments.length, 0);

  // 空白截断：前一条以空格结尾
  maps = [mapping(1, 0, 1000, 'hello '), mapping(2, 1000, 2000, 'world')];
  assert.deepEqual(VC.tokenizeMappings(maps).flat.map((t) => t.str), ['hello', 'world']);
  r = VC.verifyScript('hello world', maps);
  assert.equal(r.matchedCount, 2);
  assert.equal(r.subtitleFragments.length, 0);
});

test('边界整词：跨条目聚合仍做 ASCII 大小写折叠，数字同样跨条目', () => {
  const maps = [mapping(1, 0, 1000, 'Hel'), mapping(2, 1000, 2000, 'lo42')];
  const r = VC.verifyScript('hello42', maps);
  assert.ok(r.ok);
  assert.equal(r.matchedCount, 1);
  assert.equal(r.scriptFragments.length, 0);
  assert.equal(r.subtitleFragments.length, 0);
});

test('重复剪辑：同一源段重复生成的相邻输出条目照常核对（端到端 remap → verify）', () => {
  // 同一源段出现两次，各自独立生成输出（编号、时间不同，文本相同）
  const parsed = parseSrt('1\n00:00:00,000 --> 00:00:02,000\n你好世界\n');
  const { segments } = parseSegments('0 2000 1\n0 2000 1\n');
  assert.equal(parsed.errors.length, 0);
  const { mappings } = remap(parsed.cues, segments);
  assert.deepEqual(mappings.map((m) => [m.newIndex, m.text]), [
    [1, '你好世界'],
    [2, '你好世界'],
  ]);
  const r = VC.verifyScript('你好世界你好世界', mappings);
  assert.ok(r.ok);
  assert.equal(r.subtitleCount, 8);
  assert.equal(r.matchedCount, 8);
  assert.equal(r.scriptFragments.length, 0);
  assert.equal(r.subtitleFragments.length, 0);
});

test('重复剪辑：含英文的重复输出逐条词元化结果不变（标点结尾不聚合）', () => {
  // 句末标点使每条独立，重复段不产生误聚合
  const maps = [
    mapping(1, 0, 1000, 'Ready.'),
    mapping(2, 1000, 2000, 'Ready.'),
  ];
  const r = VC.verifyScript('ready ready', maps);
  assert.equal(r.matchedCount, 2);
  assert.equal(r.subtitleFragments.length, 0);
});

test('边界整词：空字幕/空文本条目不影响串接与归属', () => {
  const maps = [
    mapping(1, 0, 1000, 'he'),
    mapping(2, 1000, 1000, ''),
    mapping(3, 1000, 2000, 'llo'),
  ];
  const r = VC.verifyScript('hello', maps);
  assert.ok(r.ok);
  assert.equal(r.matchedCount, 1);
  // 跨边界整词归属起点所在条目 1（空条目 2 不参与）
  const { flat } = VC.tokenizeMappings(maps);
  assert.deepEqual(flat.map((t) => [t.str, t.cueNewIndex]), [['hello', 1]]);
});
