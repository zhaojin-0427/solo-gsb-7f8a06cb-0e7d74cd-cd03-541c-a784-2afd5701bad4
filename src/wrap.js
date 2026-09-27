'use strict';

/**
 * 字幕自动换行（排版重排）。
 *
 * 只调整空白与换行，不改变任何非空白字符的顺序：
 *   - 首尾空白去除；连续空白折叠为一个空格；换行位置的空白直接移除；
 *   非空白字符（含标点、emoji）原样保留。
 *
 * 断点模型：
 *   - 连续 ASCII 字母数字 [A-Za-z0-9]+ 是不可拆分的原子（一个 token）；
 *   - 其他字符按字素簇（grapheme cluster）切分，每个字素簇一个 token；
 *   - 任意两个相邻 token 之间都可以断行（CJK 字间原本无空白也可插入换行）；
 *   - 存在原空白的 token 间隙：断行则空白移除，不断则折叠为一个空格；
 *   - 行首不得是空白或 “，。！？、；：）》」” 中的字符；
 *   - 行尾不得是空白或 “（《「” 中的字符。
 *
 * 宽度：ASCII 字素簇计 1，其他字素簇计 2；每行不得超过 maxWidth。
 *
 * 择优（在合法断点中）：
 *   1) 行数最少（且不超过 3 行）；
 *   2) 各行剩余宽度（上限-行宽）的平方和最小；
 *   3) 仍同分则取断点位置更靠前的方案（断点元组字典序最小）。
 *
 * 无解时保留原文并给出原因：
 *   - token-too-wide：不可拆原子自身宽度超过上限；
 *   - too-many-lines：忽略标点约束的贪心最少行数仍超过 3；
 *   - punctuation：内容在 3 行内放得下，但行首/行尾禁断规则下无合法断点。
 */

const MIN_WIDTH = 4;
const MAX_WIDTH = 40;
const MAX_LINES = 3;

// 不得出现在行首的字符（闭合类标点）
const FORBID_LINE_START = new Set(Array.from('，。！？、；：）》」'));
// 不得出现在行尾的字符（开口类标点）
const FORBID_LINE_END = new Set(Array.from('（《「'));

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** 按字素簇切分字符串。 */
function graphemes(s) {
  return Array.from(segmenter.segment(String(s)), (x) => x.segment);
}

function isAsciiAlnumCode(code) {
  return (code >= 48 && code <= 57) // 0-9
    || (code >= 65 && code <= 90) // A-Z
    || (code >= 97 && code <= 122); // a-z
}

/** 字素簇显示宽度：单个 ASCII 字符计 1，其余（含组合序列、emoji）计 2。 */
function clusterWidth(g) {
  return g.length === 1 && g.charCodeAt(0) < 128 ? 1 : 2;
}

/**
 * 词法切分。
 * @returns {{ tokens: Array<{str,width,lead,tail,alnum}>, spaceBefore: boolean[] }}
 *   spaceBefore[i] 表示 token i 之前是否存在（被折叠的）原始空白。
 */
function tokenize(text) {
  const tokens = [];
  const spaceBefore = [];
  // \s 覆盖空格、制表符、换行、NBSP 等；块与块之间即“空白间隙”
  const chunks = String(text).split(/\s+/u).filter((c) => c.length > 0);

  chunks.forEach((chunk, ci) => {
    if (ci > 0) spaceBefore[tokens.length] = true;
    let run = '';
    let runWidth = 0;
    const flush = () => {
      if (run !== '') {
        tokens.push({ str: run, width: runWidth, lead: run[0], tail: run[run.length - 1], alnum: true });
        run = '';
        runWidth = 0;
      }
    };
    for (const g of graphemes(chunk)) {
      if (g.length === 1 && isAsciiAlnumCode(g.charCodeAt(0))) {
        run += g; // 连续 ASCII 字母数字聚成不可拆原子
        runWidth += 1;
      } else {
        flush();
        tokens.push({ str: g, width: clusterWidth(g), lead: g, tail: g, alnum: false });
      }
    }
    flush();
  });

  return { tokens, spaceBefore };
}

function lexLess(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? Number.POSITIVE_INFINITY;
    const y = b[i] ?? Number.POSITIVE_INFINITY;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * 对一条字幕文本执行自动换行。
 * @param {string} input 原始字幕文本（可含多行）
 * @param {number} maxWidth 每行宽度上限（4～40 整数）
 * @returns {{ok:boolean, original:string, text:string, width:number,
 *            lines: null|Array<{text:string,width:number,remain:number}>,
 *            reasonCode?:string, reason?:string}}
 * @throws 当 maxWidth 不是 4～40 的整数时
 */
function wrapCueText(input, maxWidth) {
  const W = Number(maxWidth);
  if (!Number.isInteger(W) || W < MIN_WIDTH || W > MAX_WIDTH) {
    throw new Error(`每行宽度上限必须是 ${MIN_WIDTH}～${MAX_WIDTH} 之间的整数，实际为 ${maxWidth}`);
  }

  const original = String(input ?? '');
  const { tokens, spaceBefore } = tokenize(original);
  const N = tokens.length;
  if (N === 0) {
    return { ok: true, original, text: '', width: W, lines: [] };
  }

  // pref[i]：前 i 个 token 按空白规则拼接后的宽度
  const pref = new Array(N + 1).fill(0);
  for (let i = 0; i < N; i++) {
    pref[i + 1] = pref[i] + tokens[i].width + (i > 0 && spaceBefore[i] ? 1 : 0);
  }
  // token i..j 放在同一行的宽度
  const lineWidth = (i, j) =>
    pref[j + 1] - pref[i] - (i > 0 && spaceBefore[i] ? 1 : 0);

  const headOk = (i) => !FORBID_LINE_START.has(tokens[i].lead);
  const tailOk = (j) => !FORBID_LINE_END.has(tokens[j].tail);
  // 在 token i 之前断行是否合法（行尾为 i-1、行首为 i）
  const breakOk = (i) => tailOk(i - 1) && headOk(i);

  // —— 无解原因 1：不可拆原子自身超宽 ——
  const tooWide = tokens.find((t) => t.width > W);
  if (tooWide) {
    return fail(original, W, 'token-too-wide',
      `不可拆分的连续 ASCII 字母数字/字素簇 "${truncate(tooWide.str)}" 宽度为 ${tooWide.width}，超过每行上限 ${W}`);
  }

  // —— 无解原因 2：忽略标点约束的贪心最少行数仍超过 3 ——
  let greedyLines = 1;
  let greedyWidth = tokens[0].width;
  for (let i = 1; i < N; i++) {
    const add = tokens[i].width + (spaceBefore[i] ? 1 : 0);
    if (greedyWidth + add <= W) {
      greedyWidth += add;
    } else {
      greedyLines += 1;
      greedyWidth = tokens[i].width;
    }
  }
  if (greedyLines > MAX_LINES) {
    return fail(original, W, 'too-many-lines',
      `即使任意间隙都允许断行也至少需要 ${greedyLines} 行，超过每条字幕最多 ${MAX_LINES} 行的限制（每行上限 ${W}）`);
  }

  // —— 动态规划：dp[k][j] = token 0..j 排成 k 行的最优方案 ——
  // 方案比较：剩余宽度平方和最小，同分取断点元组字典序最小。
  const dp = Array.from({ length: MAX_LINES + 1 }, () => new Array(N).fill(null));

  for (let j = 0; j < N; j++) {
    const wd = lineWidth(0, j);
    if (wd <= W && headOk(0) && tailOk(j)) {
      dp[1][j] = { cost: (W - wd) ** 2, breaks: [] };
    }
  }

  for (let k = 2; k <= MAX_LINES; k++) {
    for (let j = k - 1; j < N; j++) {
      if (!tailOk(j)) continue; // 末字禁断，任何以 j 结尾的行都不合法
      let best = null;
      for (let i = k - 1; i <= j; i++) {
        const prev = dp[k - 1][i - 1];
        if (!prev || !breakOk(i)) continue;
        const wd = lineWidth(i, j);
        if (wd > W) continue;
        const cost = prev.cost + (W - wd) ** 2;
        const br = prev.breaks.concat(i);
        if (!best || cost < best.cost || (cost === best.cost && lexLess(br, best.breaks))) {
          best = { cost, breaks: br };
        }
      }
      dp[k][j] = best;
    }
  }

  // 行数最少优先：依次检查 1、2、3 行
  for (let k = 1; k <= MAX_LINES; k++) {
    const chosen = dp[k][N - 1];
    if (chosen) {
      const bounds = [0, ...chosen.breaks, N];
      const lines = [];
      for (let r = 0; r < bounds.length - 1; r++) {
        const i = bounds[r];
        const j = bounds[r + 1] - 1;
        lines.push({
          text: renderLine(tokens, spaceBefore, i, j),
          width: lineWidth(i, j),
          remain: W - lineWidth(i, j),
        });
      }
      return {
        ok: true,
        original,
        text: lines.map((l) => l.text).join('\n'),
        width: W,
        lines,
      };
    }
  }

  // —— 无解原因 3：标点行首/行尾约束下不存在合法断点 ——
  let detail = '';
  if (!headOk(0)) {
    detail = `：首字 "${tokens[0].lead}" 不允许出现在行首`;
  } else if (!tailOk(N - 1)) {
    detail = `：末字 "${tokens[N - 1].tail}" 不允许出现在行尾`;
  }
  return fail(original, W, 'punctuation',
    `内容可在 ${MAX_LINES} 行内放下，但受行首禁断标点（${Array.from(FORBID_LINE_START).join('')}）`
    + `与行尾禁断标点（${Array.from(FORBID_LINE_END).join('')}）限制，不存在合法断点${detail}`);
}

function renderLine(tokens, spaceBefore, i, j) {
  let s = tokens[i].str;
  for (let p = i + 1; p <= j; p++) {
    if (spaceBefore[p]) s += ' ';
    s += tokens[p].str;
  }
  return s;
}

function fail(original, width, reasonCode, reason) {
  return { ok: false, original, text: original, width, lines: null, reasonCode, reason };
}

function truncate(s) {
  const g = graphemes(s);
  return g.length > 10 ? `${g.slice(0, 10).join('')}…` : s;
}

const wrapApi = {
  wrapCueText,
  tokenize,
  graphemes,
  clusterWidth,
  MIN_WIDTH,
  MAX_WIDTH,
  MAX_LINES,
  FORBID_LINE_START,
  FORBID_LINE_END,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = wrapApi;
}
if (typeof window !== 'undefined') {
  window.Wrap = wrapApi;
}
