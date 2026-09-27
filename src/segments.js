'use strict';

/**
 * 解析“剪辑段”输入文本。
 * 每行一段，按播放顺序排列；格式：
 *   源起ms 源止ms 倍速
 * 分隔符支持空白或逗号（可混用）。# 之后为注释，空行忽略。
 * 倍速仅允许 0.5 / 1 / 2。
 * 源段允许乱序、重叠、重复（由 remap 模块负责各自生成字幕）。
 *
 * @returns {{ segments: Array, errors: Array<{line:number, message:string}> }}
 */

const SPEEDS = [0.5, 1, 2];

function parseSegments(input) {
  const errors = [];
  const segments = [];
  const rawLines = String(input ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  rawLines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) return;

    // 逗号/制表符/空白统一切分，过滤空字段
    const parts = line.split(/[\s,]+/).filter(Boolean);
    if (parts.length !== 3) {
      errors.push({
        line: lineNo,
        message: `第 ${lineNo} 行：应有 3 个字段（源起ms 源止ms 倍速），实际 ${parts.length} 个："${rawLine.trim()}"`,
      });
      return;
    }

    const [startRaw, endRaw, speedRaw] = parts;

    if (!/^-?\d+$/.test(startRaw)) {
      errors.push({ line: lineNo, message: `第 ${lineNo} 行：源起时间必须是整数毫秒，实际为 "${startRaw}"` });
      return;
    }
    if (!/^-?\d+$/.test(endRaw)) {
      errors.push({ line: lineNo, message: `第 ${lineNo} 行：源止时间必须是整数毫秒，实际为 "${endRaw}"` });
      return;
    }

    const start = Number(startRaw);
    const end = Number(endRaw);

    if (start < 0) {
      errors.push({ line: lineNo, message: `第 ${lineNo} 行：源起时间不能为负数（${start}）` });
      return;
    }
    if (end <= start) {
      errors.push({ line: lineNo, message: `第 ${lineNo} 行：源止时间（${end}）必须晚于源起时间（${start}）` });
      return;
    }
    if (!/^(0\.5|1|2)$/.test(speedRaw)) {
      errors.push({ line: lineNo, message: `第 ${lineNo} 行：倍速仅允许 0.5、1、2，实际为 "${speedRaw}"` });
      return;
    }

    segments.push({
      order: segments.length, // 播放顺序（0 起）
      line: lineNo,
      raw: rawLine.trim(),
      sourceStart: start,
      sourceEnd: end,
      speed: Number(speedRaw),
    });
  });

  if (errors.length === 0 && segments.length === 0) {
    errors.push({ line: 0, message: '至少需要一条剪辑段（每行：源起ms 源止ms 倍速）' });
  }

  return { segments, errors };
}

const segmentsApi = { parseSegments, SPEEDS };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = segmentsApi;
}
if (typeof window !== 'undefined') {
  window.Segments = segmentsApi;
}
