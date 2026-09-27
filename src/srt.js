'use strict';

/**
 * SRT 解析与序列化。
 * 时间戳格式：HH:MM:SS,mmm（也兼容标准允许的点号毫秒分隔符 .mmm）。
 *
 * 解析失败时 collect 所有错误（带块序号/行号），成功时返回字幕数组：
 *   { index, seqText, start, end, text, startLine, endLine }
 */

const TIMESTAMP_RE = /^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})$/;

/** 解析单个时间戳字符串为毫秒；非法返回 null。 */
function parseTimestamp(raw) {
  if (typeof raw !== 'string') return null;
  const m = TIMESTAMP_RE.exec(raw.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  const ms = Number(m[4]);
  if (mm > 59 || ss > 59) return null; // 小时不设上限
  return hh * 3600000 + mm * 60000 + ss * 1000 + ms;
}

/** 将毫秒格式化为 SRT 时间戳 HH:MM:SS,mmm（ms 必须为非负整数）。 */
function formatTimestamp(ms) {
  const n = Math.round(ms);
  const hh = Math.floor(n / 3600000);
  const mm = Math.floor((n % 3600000) / 60000);
  const ss = Math.floor((n % 60000) / 1000);
  const mmm = n % 1000;
  const p2 = (v) => String(v).padStart(2, '0');
  const p3 = (v) => String(v).padStart(3, '0');
  return `${String(hh).padStart(2, '0')}:${p2(mm)}:${p2(ss)},${p3(mmm)}`;
}

/**
 * 解析 SRT 文本。
 * @returns {{ cues: Array, errors: Array<{block:number, lines:number[], message:string}> }}
 */
function parseSrt(input) {
  const errors = [];
  const cues = [];

  const text = String(input ?? '')
    .replace(/^\uFEFF/, '') // 去 BOM
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const lines = text.split('\n');
  let block = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;

    block += 1;
    const blockStartLine = i + 1;

    // 第一行：序号（标准 SRT 必须有；没有序号也无法对齐后续行，直接报错）
    const seqText = lines[i].trim();
    if (!/^\d+$/.test(seqText)) {
      errors.push({
        block,
        lines: [i + 1],
        message: `第 ${block} 块（第 ${i + 1} 行）：首行应为数字序号，实际为 "${seqText.slice(0, 30)}"`,
      });
      i = skipBlock(lines, i);
      continue;
    }
    i++;

    // 第二行：时间轴
    if (i >= lines.length || !lines[i].trim()) {
      errors.push({
        block,
        lines: [blockStartLine],
        message: `第 ${block} 块（序号 ${seqText}）：缺少时间轴行`,
      });
      continue;
    }
    const timingLine = lines[i].trim();
    const timing = parseTimingLine(timingLine);
    if (!timing.ok) {
      errors.push({
        block,
        lines: [i + 1],
        message: `第 ${block} 块（序号 ${seqText}）：时间轴格式错误 "${timingLine.slice(0, 60)}"，应为 hh:mm:ss,mmm --> hh:mm:ss,mmm`,
      });
      i = skipBlock(lines, i);
      continue;
    }
    if (timing.end <= timing.start) {
      errors.push({
        block,
        lines: [i + 1],
        message: `第 ${block} 块（序号 ${seqText}）：结束时间（${formatTimestampSafe(timing.end)}）必须晚于开始时间（${formatTimestampSafe(timing.start)}）`,
      });
      i = skipBlock(lines, i);
      continue;
    }
    const timingLineNo = i + 1;
    i++;

    // 收集文本行直到空行
    const body = [];
    const bodyStartLine = i + 1;
    while (i < lines.length && lines[i].trim()) {
      body.push(lines[i]);
      i++;
    }
    if (body.length === 0) {
      errors.push({
        block,
        lines: [timingLineNo],
        message: `第 ${block} 块（序号 ${seqText}）：缺少字幕文本`,
      });
      continue;
    }

    cues.push({
      index: block - 1, // 解析序（0 起），错误时不产生该条
      seq: Number(seqText), // SRT 原始序号
      seqText,
      start: timing.start,
      end: timing.end,
      text: body.join('\n'),
      startLine: blockStartLine,
      endLine: bodyStartLine + body.length - 1,
    });
  }

  return { cues, errors };
}

function parseTimingLine(line) {
  const parts = line.split('-->');
  if (parts.length !== 2) return { ok: false };
  const start = parseTimestamp(parts[0].trim());
  const end = parseTimestamp(parts[1].trim());
  if (start === null || end === null) return { ok: false };
  return { ok: true, start, end };
}

function formatTimestampSafe(ms) {
  return ms === null ? '非法时间戳' : formatTimestamp(ms);
}

/** 跳到当前块之后（下一个空行之后的一行），返回块最后行索引。 */
function skipBlock(lines, i) {
  while (i < lines.length && lines[i].trim()) i++;
  return i - 1;
}

/** 序列化为 SRT 文本。cues: { start, end, text }（start/end 为整数毫秒）。 */
function serializeSrt(cues) {
  return cues
    .map((c, i) => `${i + 1}\n${formatTimestamp(c.start)} --> ${formatTimestamp(c.end)}\n${c.text}`)
    .join('\n\n')
    .concat('\n');
}

const srtApi = { parseSrt, serializeSrt, parseTimestamp, formatTimestamp };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = srtApi;
}
if (typeof window !== 'undefined') {
  window.Srt = srtApi;
}
