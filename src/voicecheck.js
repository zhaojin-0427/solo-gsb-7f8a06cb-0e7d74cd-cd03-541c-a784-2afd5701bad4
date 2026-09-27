'use strict';

/**
 * 成片口播稿核对。
 *
 * 用户粘贴按成片播放顺序整理的口播纯文本（稿件），与当前“未排版”的输出字幕
 * （mappings，按输出顺序）按顺序串接后的词元序列做保序一对一匹配：
 *
 * 词元化（两侧规则相同）：
 *   - 连续 ASCII 字母数字 [A-Za-z0-9]+ 聚合为一个词元（匹配时大小写不敏感）；
 *   - 其他 Unicode 字母或数字按字素簇（Intl.Segmenter grapheme）逐个计，
 *     每个字素簇一个词元（大小写敏感，仅 ASCII 折叠）；
 *   - 空白、标点、符号一律忽略。
 *   多码点字素簇以其首个码点的 Unicode 属性（Letter/Number）判定是否为
 *   “字母或数字”，词元原文保留整个字素簇。
 *
 * 字幕侧先把全部输出正文按输出顺序直接串接成一段连续文本（条目之间不加
 * 任何分隔），再按上述规则切分：因此相邻条目交界处——前一条以 ASCII 字母
 * 数字结尾、后一条以 ASCII 字母数字开头——会跨条目聚成同一个词元，被字幕
 * 条目边界拆开的整词得以与稿件匹配。每个词元归属于其起点所在条目，携带该
 * 条目的输出编号与时间，供差异片段定位、相邻匹配锚点与点击跳转使用。
 *
 * 匹配：两侧词元键相等方可配对的最长公共子序列（LCS）——先最大化匹配词元数；
 * 匹配数相同时，取匹配对序列 (稿件位置, 字幕位置) 字典序最小者。
 * DP：L(i,j) = 稿件后缀 i.. 与字幕后缀 j.. 的最大匹配数，倒序填表；
 * 重建时能在不损失匹配数的前提下配对当前稿件词元就一定配对（稿件位置最小），
 * 并在可达成最优的候选里取字幕位置最小者。
 *
 * 结果列出：
 *   - 稿件未匹配片段：稿件中连续未匹配词元组成的最大游程，用相邻（前/后）
 *     已匹配字幕定位；
 *   - 字幕多出片段：字幕侧连续未匹配词元的最大游程，跨输出条目边界时按条目
 *     拆开，每条标注输出编号与输出时间（前端可点击跳转）；跨条目词元归属其
 *     起点所在条目，片段原文完整保留整词。
 *
 * 校验：任一侧没有词元（空输入或仅含空白/标点/符号）、或任一侧词元数超过
 * MAX_TOKENS（1500）时返回错误，不生成报告。
 */

const MAX_TOKENS = 1500;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function isAsciiAlnumCode(code) {
  return (code >= 48 && code <= 57) // 0-9
    || (code >= 65 && code <= 90) // A-Z
    || (code >= 97 && code <= 122); // a-z
}

/** 字素簇是否为“其他 Unicode 字母或数字”：以首个码点的 L/N 属性判定。 */
function isLetterOrNumberCluster(g) {
  return /[\p{L}\p{N}]/u.test(g);
}

/**
 * 词法切分（不依赖任何条目结构，可用于稿件纯文本或单条字幕文本）。
 * @param {string} input 原始文本
 * @returns {Array<{key:string,str:string,start:number,end:number,ascii:boolean}>}
 *   start/end 为输入字符串中的 UTF-16 偏移（半开区间）；key 为匹配用规范键。
 */
function tokenizeText(input) {
  const raw = String(input ?? '');
  const tokens = [];
  let runStart = -1;
  let runEnd = -1; // 连续 ASCII 字母数字游程区间 [runStart, runEnd)

  const flush = () => {
    if (runStart < 0) return;
    tokens.push({
      key: raw.slice(runStart, runEnd).toLowerCase(),
      str: raw.slice(runStart, runEnd),
      start: runStart,
      end: runEnd,
      ascii: true,
    });
    runStart = -1;
    runEnd = -1;
  };

  for (const part of segmenter.segment(raw)) {
    const g = part.segment;
    if (g.length === 1 && isAsciiAlnumCode(g.charCodeAt(0))) {
      if (runStart < 0) runStart = part.index;
      runEnd = part.index + g.length; // 相邻 ASCII 字母数字聚成一个词元
    } else {
      flush();
      if (isLetterOrNumberCluster(g)) {
        tokens.push({
          key: g, // 非 ASCII 不做大小写折叠
          str: g,
          start: part.index,
          end: part.index + g.length,
          ascii: false,
        });
      }
    }
  }
  flush();
  return tokens;
}

/**
 * 将输出字幕按顺序串接后词元化：先把各条未排版正文按输出顺序直接串接成
 * 一段连续文本（条目之间不加任何分隔），再按与稿件相同的规则切分词元。
 * 因此相邻条目交界处——前一条以 ASCII 字母数字结尾、后一条以 ASCII 字母
 * 数字开头——会跨条目聚成同一个词元，被条目边界拆开的整词得以匹配。
 *
 * 每个词元归属于其**起点所在条目**，携带该条目的输出编号与时间（供差异
 * 片段定位、相邻匹配锚点与点击跳转使用）；跨条目词元的原文完整保留在
 * str 中，start/end 为其在串接文本中的实际区间（可越过条目边界）。
 *
 * @param {Array} mappings remap 输出，至少含 newIndex/start/end/text，按输出顺序
 * @returns {{groups:Array, flat:Array, joined:string}}
 *   joined 为按顺序串接后的完整文本；
 *   groups[i] = { newIndex, start, end, text, offset }（offset 为本条正文在
 *   joined 中的起始偏移）；
 *   flat 为串接后切出的词元：start/end 为 joined 中的 UTF-16 偏移（半开
 *   区间），另带所属条目输出编号 cueNewIndex 与条目时间 outStart/outEnd。
 */
function tokenizeMappings(mappings) {
  const groups = [];
  let joined = '';
  for (const m of mappings) {
    const text = String(m.text ?? '');
    groups.push({ newIndex: m.newIndex, start: m.start, end: m.end, text, offset: joined.length });
    joined += text;
  }
  const flat = [];
  let gi = 0; // 条目偏移与词元起点均升序，单调指针定位词元起点所在条目
  for (const t of tokenizeText(joined)) {
    while (gi + 1 < groups.length && groups[gi + 1].offset <= t.start) gi++;
    const g = groups[gi];
    flat.push({
      key: t.key,
      str: t.str,
      start: t.start,
      end: t.end,
      cueNewIndex: g.newIndex,
      outStart: g.start,
      outEnd: g.end,
    });
  }
  return { groups, flat, joined };
}

/**
 * 保序一对一匹配（LCS）。
 * @param {Array} aTokens 稿件词元
 * @param {Array} bTokens 串接后的字幕词元
 * @returns {{pairs:Array<{scriptIndex:number,subtitleIndex:number}>,count:number}}
 *   pairs 已按 (稿件位置, 字幕位置) 升序；count 为最大匹配词元数。
 */
function alignTokens(aTokens, bTokens) {
  const n = aTokens.length;
  const m = bTokens.length;
  const width = m + 1;
  const at = (i, j) => i * width + j;
  // L(i,j)：LCS 长度，边界行/列（i=n 或 j=m）为 0
  const L = new Int32Array((n + 1) * width);

  for (let i = n - 1; i >= 0; i--) {
    const ka = aTokens[i].key;
    for (let j = m - 1; j >= 0; j--) {
      let best = Math.max(L[at(i + 1, j)], L[at(i, j + 1)]);
      if (ka === bTokens[j].key) {
        const v = 1 + L[at(i + 1, j + 1)];
        if (v > best) best = v;
      }
      L[at(i, j)] = best;
    }
  }

  // 重建：匹配对序列 (稿件位置, 字幕位置) 字典序最小
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m && L[at(i, j)] > 0) {
    const total = L[at(i, j)];
    let chosen = -1;
    // 若当前稿件词元能在某个最优方案中配对，则必须配对（稿件位置最小），
    // 并取其中字幕位置最小者。
    for (let k = j; k < m; k++) {
      if (aTokens[i].key === bTokens[k].key && 1 + L[at(i + 1, k + 1)] === total) {
        chosen = k;
        break;
      }
    }
    if (chosen === -1) {
      i++; // 任何最优方案都不使用当前稿件词元
      continue;
    }
    pairs.push({ scriptIndex: i, subtitleIndex: chosen });
    i++;
    j = chosen + 1;
  }

  return { pairs, count: L[at(0, 0)] };
}

function anchorOf(flatToken) {
  return flatToken
    ? { newIndex: flatToken.cueNewIndex, start: flatToken.outStart, end: flatToken.outEnd }
    : null;
}

/** 稿件侧连续未匹配词元的最大游程；每个片段只用前/后相邻已匹配字幕定位。 */
function buildScriptFragments(rawScript, scriptTokens, flat, pairs) {
  const matched = new Uint8Array(scriptTokens.length);
  pairs.forEach((p) => { matched[p.scriptIndex] = 1; });

  const fragments = [];
  let pi = 0; // pairs 按稿件位置升序
  for (let i = 0; i < scriptTokens.length; i++) {
    if (matched[i]) continue;
    const startToken = i;
    while (i + 1 < scriptTokens.length && !matched[i + 1]) i++;
    const endToken = i;

    while (pi < pairs.length && pairs[pi].scriptIndex < startToken) pi++;
    const prevPair = pi > 0 ? pairs[pi - 1] : null; // 稿件位置 < startToken 的最后一对
    let nextPair = null; // 稿件位置 > endToken 的第一对（游程内不可能有配对）
    for (let q = pi; q < pairs.length; q++) {
      if (pairs[q].scriptIndex > endToken) { nextPair = pairs[q]; break; }
    }

    fragments.push({
      text: rawScript.slice(scriptTokens[startToken].start, scriptTokens[endToken].end),
      prev: prevPair ? anchorOf(flat[prevPair.subtitleIndex]) : null,
      next: nextPair ? anchorOf(flat[nextPair.subtitleIndex]) : null,
    });
  }
  return fragments;
}

/**
 * 字幕侧连续未匹配词元的最大游程；跨输出条目边界时按条目拆开。
 * 片段文本取串接文本中从游程首词元起点到末词元终点的原文区间：与普通
 * 逐条切取一致，且末词元跨条目时完整整词随其起点所在条目的片段显示。
 * @param {{groups:Array, flat:Array, joined:string}} tokenized tokenizeMappings 的结果
 * @param {Array<{scriptIndex:number,subtitleIndex:number}>} pairs 匹配对
 */
function buildSubtitleFragments(tokenized, pairs) {
  const { groups, flat, joined } = tokenized;
  const matched = new Uint8Array(flat.length);
  pairs.forEach((p) => { matched[p.subtitleIndex] = 1; });
  const groupByNewIndex = new Map(groups.map((g) => [g.newIndex, g]));

  const fragments = [];
  for (let j = 0; j < flat.length; j++) {
    if (matched[j]) continue;
    const newIndex = flat[j].cueNewIndex;
    const first = j;
    while (j + 1 < flat.length
      && !matched[j + 1]
      && flat[j + 1].cueNewIndex === newIndex) {
      j++;
    }
    const last = j;
    const group = groupByNewIndex.get(newIndex);
    fragments.push({
      newIndex,
      start: group.start,
      end: group.end,
      text: joined.slice(flat[first].start, flat[last].end),
    });
  }
  return fragments;
}

/**
 * 核对入口：校验 → 词元化 → 保序一对一匹配 → 提取两侧未匹配片段。
 * @param {string} rawScript 稿件纯文本
 * @param {Array} mappings 当前未排版输出字幕（remap 的 mappings，按输出顺序）
 * @returns {object} 失败：{ ok:false, code, message, side?, count? }；
 *   成功：{ ok:true, scriptCount, subtitleCount, matchedCount,
 *          scriptFragments, subtitleFragments }
 */
function verifyScript(rawScript, mappings) {
  const raw = String(rawScript ?? '');
  const scriptTokens = tokenizeText(raw);

  if (raw.trim() === '' || scriptTokens.length === 0) {
    return {
      ok: false,
      code: 'empty',
      message: '口播稿内容为空（或不含任何字母/数字词元），请粘贴按成片播放顺序整理的口播纯文本后再核对。',
    };
  }
  if (scriptTokens.length > MAX_TOKENS) {
    return {
      ok: false,
      code: 'too-many',
      side: 'script',
      count: scriptTokens.length,
      message: `稿件词元数为 ${scriptTokens.length}，超过每侧 ${MAX_TOKENS} 词元的上限，未生成核对报告；请删减稿件内容后重试。`,
    };
  }

  const tokenized = tokenizeMappings(mappings || []);
  const { flat } = tokenized;
  if (flat.length > MAX_TOKENS) {
    return {
      ok: false,
      code: 'too-many',
      side: 'subtitle',
      count: flat.length,
      message: `当前输出字幕串接后词元数为 ${flat.length}，超过每侧 ${MAX_TOKENS} 词元的上限，未生成核对报告。`,
    };
  }

  const { pairs, count } = alignTokens(scriptTokens, flat);

  return {
    ok: true,
    scriptCount: scriptTokens.length,
    subtitleCount: flat.length,
    matchedCount: count,
    scriptFragments: buildScriptFragments(raw, scriptTokens, flat, pairs),
    subtitleFragments: buildSubtitleFragments(tokenized, pairs),
  };
}

const voiceCheckApi = {
  MAX_TOKENS,
  tokenizeText,
  tokenizeMappings,
  alignTokens,
  buildScriptFragments,
  buildSubtitleFragments,
  verifyScript,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = voiceCheckApi;
}
// 浏览器主线程（window）与 Web Worker（self）均挂载为全局 VoiceCheck，
// 供页面直接调用或 public/voicecheck-worker.js 以 importScripts 复用同一算法
const vcGlobal = typeof window !== 'undefined'
  ? window
  : (typeof self !== 'undefined' ? self : undefined);
if (vcGlobal) {
  vcGlobal.VoiceCheck = voiceCheckApi;
}
