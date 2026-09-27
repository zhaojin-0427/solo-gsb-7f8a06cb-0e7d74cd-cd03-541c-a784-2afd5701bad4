'use strict';

/**
 * 说话人标注。
 *
 * 用户在结果页逐行输入**源时间轴**上的说话人时段：
 *   起始毫秒 结束毫秒 说话人ID
 * （字段间用空白或逗号分隔，# 之后为注释，空行忽略；时间须为非负整数且
 * 起点小于终点；ID 限 1～20 位 ASCII 字母、数字、下划线或连字符；
 * 不同说话人的时段可重叠；解析错误指出行号。）
 *
 * 归属判定：
 *   1) 标注时段沿用当前剪辑段、倍速与边界取整规则映射到成片时间轴
 *      （与 src/remap.js 相同：半开区间求交、半毫秒精确单位、边界分别
 *      四舍五入 0.5 向上；四舍五入后零长的片段舍弃）；
 *   2) 对每条**未排版**输出字幕，仅统计**同一剪辑段**内与各说话人时段的
 *      正时长交集（半开区间，端点相接不算）；同一人的重叠时段先取并集，
 *      不重复计时；
 *   3) 交集时长最长者为该字幕的说话人；最长并列时列出候选，由用户逐条
 *      裁决（choices: Map<输出编号, 说话人ID>），未裁决前禁用标注版导出；
 *      无交集者保持无标签。
 *
 * 导出：已归属字幕的正文前加「[ID] 」，时间、编号（顺序）及原正文其余
 * 部分不变（正文取未排版原文）。
 *
 * 纯逻辑，Node/浏览器双端通用，不请求后端。
 */

const MAX_ID_LENGTH = 20;
const ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * 解析说话人标注文本。每行一条时段：起始毫秒 结束毫秒 说话人ID。
 * 分隔符支持空白或逗号（可混用）；# 之后为注释，空行忽略。
 *
 * @returns {{ intervals: Array<{start:number, end:number, speaker:string, line:number, raw:string}>,
 *             errors: Array<{line:number, message:string}> }}
 */
function parseSpeakerIntervals(input) {
  const errors = [];
  const intervals = [];
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
        message: `第 ${lineNo} 行：应有 3 个字段（起始ms 结束ms 说话人ID），实际 ${parts.length} 个："${rawLine.trim()}"`,
      });
      return;
    }
    const [startRaw, endRaw, idRaw] = parts;

    if (!/^-?\d+$/.test(startRaw)) {
      errors.push({ line: lineNo, message: `第 ${lineNo} 行：起始时间必须是整数毫秒，实际为 "${startRaw}"` });
      return;
    }
    if (!/^-?\d+$/.test(endRaw)) {
      errors.push({ line: lineNo, message: `第 ${lineNo} 行：结束时间必须是整数毫秒，实际为 "${endRaw}"` });
      return;
    }
    const start = Number(startRaw);
    const end = Number(endRaw);
    if (start < 0) {
      errors.push({ line: lineNo, message: `第 ${lineNo} 行：起始时间不能为负数（${start}）` });
      return;
    }
    if (end <= start) {
      errors.push({ line: lineNo, message: `第 ${lineNo} 行：结束时间（${end}）必须晚于起始时间（${start}）` });
      return;
    }
    if (!ID_RE.test(idRaw)) {
      errors.push({
        line: lineNo,
        message: `第 ${lineNo} 行：说话人ID 仅限 ASCII 字母、数字、下划线或连字符，实际为 "${idRaw}"`,
      });
      return;
    }
    if (idRaw.length > MAX_ID_LENGTH) {
      errors.push({
        line: lineNo,
        message: `第 ${lineNo} 行：说话人ID 最长 ${MAX_ID_LENGTH} 个字符，实际 ${idRaw.length} 个："${idRaw}"`,
      });
      return;
    }

    intervals.push({ start, end, speaker: idRaw, line: lineNo, raw: rawLine.trim() });
  });

  if (errors.length === 0 && intervals.length === 0) {
    errors.push({ line: 0, message: '至少需要一条说话人标注（每行：起始ms 结束ms 说话人ID）' });
  }

  return { intervals, errors };
}

// speed -> 每毫秒源时间对应的半毫秒单位数（与 src/remap.js 的 HALF_UNITS_PER_MS 一致：2/speed；
// 0.5→4、1→2、2→1，均为精确整数）
function halfUnitsPerMs(speed) {
  return 2 / speed;
}

/** 半毫秒单位四舍五入为毫秒（0.5 向上，与 src/remap.js 的 halfToMsRound 一致）。 */
function halfToMsRound(half) {
  return Math.floor((half + 1) / 2);
}

/**
 * 把源时间轴上的标注时段映射到成片时间轴：逐剪辑段求半开交集、按倍速
 * 换算、边界分别四舍五入（规则与 remap 完全一致）。四舍五入后零长的
 * 片段舍弃（不可能产生正时长交集）。
 *
 * @param {Array} intervals parseSpeakerIntervals 得到的标注时段
 * @param {Array} timeline remap 的剪辑段时间轴（含 order/sourceStart/sourceEnd/speed/outStartHalf）
 * @returns {Array<{segOrder:number, start:number, end:number, speaker:string, line:number, srcIndex:number}>}
 */
function mapSpeakerIntervals(intervals, timeline) {
  const mapped = [];
  for (const tl of timeline) {
    const k = halfUnitsPerMs(tl.speed);
    intervals.forEach((iv, srcIndex) => {
      const lo = Math.max(iv.start, tl.sourceStart);
      const hi = Math.min(iv.end, tl.sourceEnd);
      if (lo >= hi) return; // 半开区间，端点相接不算
      const startHalf = tl.outStartHalf + (lo - tl.sourceStart) * k;
      const endHalf = tl.outStartHalf + (hi - tl.sourceStart) * k;
      const start = halfToMsRound(startHalf);
      const end = halfToMsRound(endHalf);
      if (end <= start) return; // 四舍五入后零长
      mapped.push({ segOrder: tl.order, start, end, speaker: iv.speaker, line: iv.line, srcIndex });
    });
  }
  return mapped;
}

/** 半开区间并集（相接即合并）；输入 [{start,end}]，返回合并后的不相交区间数组。 */
function unionIntervals(list) {
  const sorted = list.slice().sort((a, b) => (a.start - b.start) || (a.end - b.end));
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      out.push({ start: iv.start, end: iv.end });
    }
  }
  return out;
}

/**
 * 逐条判定输出字幕的说话人归属。
 * @param {Array} mappings remap 输出（按输出顺序，含 newIndex/segOrder/start/end）
 * @param {Array} intervals parseSpeakerIntervals 得到的标注时段
 * @param {Array} timeline remap 的剪辑段时间轴
 * @returns {object}
 *   成功：{ ok:true, items:[{newIndex, segOrder, start, end,
 *          overlaps:[{id, ms}]（交集降序、同长按 ID 升序）,
 *          status:'auto'|'tie'|'none', speakerId?（auto）, candidates?（tie，ID 升序）}],
 *          speakerIds（按输入出现顺序）, intervalCount, mappedCount, unmappedCount,
 *          autoCount, tieCount, noneCount }
 *   失败：{ ok:false, code:'empty'|'bad-intervals'|'bad-timeline', message }
 */
function computeSpeakers(mappings, intervals, timeline) {
  const list = Array.isArray(mappings) ? mappings : [];
  if (list.length === 0) {
    return { ok: false, code: 'empty', message: '当前没有输出字幕，无法进行说话人标注。' };
  }
  if (!Array.isArray(intervals) || intervals.length === 0) {
    return { ok: false, code: 'bad-intervals', message: '说话人标注无效：至少需要一条合法标注时段。' };
  }
  if (!Array.isArray(timeline) || timeline.length === 0) {
    return { ok: false, code: 'bad-timeline', message: '剪辑段时间轴无效，无法进行说话人标注。' };
  }

  const mapped = mapSpeakerIntervals(intervals, timeline);

  // 段 -> 说话人 -> 该说话人在本段的映射区间；同一人的重叠时段先取并集
  const unionBySeg = new Map();
  for (const mp of mapped) {
    let perSpeaker = unionBySeg.get(mp.segOrder);
    if (!perSpeaker) {
      perSpeaker = new Map();
      unionBySeg.set(mp.segOrder, perSpeaker);
    }
    let arr = perSpeaker.get(mp.speaker);
    if (!arr) {
      arr = [];
      perSpeaker.set(mp.speaker, arr);
    }
    arr.push(mp);
  }
  for (const perSpeaker of unionBySeg.values()) {
    for (const [speaker, arr] of perSpeaker) {
      perSpeaker.set(speaker, unionIntervals(arr));
    }
  }

  const items = list.map((m) => {
    const perSpeaker = unionBySeg.get(m.segOrder);
    const overlaps = [];
    if (perSpeaker) {
      for (const [speaker, comps] of perSpeaker) {
        let ms = 0;
        for (const c of comps) {
          const lo = Math.max(m.start, c.start);
          const hi = Math.min(m.end, c.end);
          if (lo < hi) ms += hi - lo; // 仅正时长交集
        }
        if (ms > 0) overlaps.push({ id: speaker, ms });
      }
    }
    // 交集降序；同长按 ID 升序（保证候选顺序确定）
    overlaps.sort((a, b) => (b.ms - a.ms) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    let status = 'none';
    let speakerId = null;
    let candidates = null;
    if (overlaps.length > 0) {
      const best = overlaps[0].ms;
      const tied = overlaps.filter((o) => o.ms === best).map((o) => o.id);
      if (tied.length === 1) {
        status = 'auto';
        speakerId = tied[0];
      } else {
        status = 'tie';
        candidates = tied; // 已按 ID 升序
      }
    }
    return { newIndex: m.newIndex, segOrder: m.segOrder, start: m.start, end: m.end, overlaps, status, speakerId, candidates };
  });

  // 不同说话人按输入出现顺序去重
  const speakerIds = [];
  const seen = new Set();
  for (const iv of intervals) {
    if (!seen.has(iv.speaker)) {
      seen.add(iv.speaker);
      speakerIds.push(iv.speaker);
    }
  }

  return {
    ok: true,
    items,
    speakerIds,
    intervalCount: intervals.length,
    mappedCount: mapped.length,
    // 未产生任何有效映射片段的标注条数（未命中剪辑段或映射后零长）
    unmappedCount: intervals.length - new Set(mapped.map((mp) => mp.srcIndex)).size,
    autoCount: items.filter((it) => it.status === 'auto').length,
    tieCount: items.filter((it) => it.status === 'tie').length,
    noneCount: items.filter((it) => it.status === 'none').length,
  };
}

/**
 * 字幕的有效说话人：auto 取判定结果；tie 取逐条裁决 choices
 * （Map<输出编号, 说话人ID>，须为候选之一）；无交集或未裁决返回 null。
 */
function speakerForItem(item, choices) {
  if (item.status === 'auto') return item.speakerId;
  if (item.status === 'tie' && choices && typeof choices.get === 'function') {
    const pick = choices.get(item.newIndex);
    if (typeof pick === 'string' && item.candidates.includes(pick)) return pick;
  }
  return null;
}

/** 全部并列字幕均已裁决（可导出标注版）。 */
function exportReady(result, choices) {
  if (!result || !result.ok) return false;
  return result.items.every((it) => it.status !== 'tie' || speakerForItem(it, choices) !== null);
}

/**
 * 生成标注版 SRT 条目：编号与顺序不变（serializeSrt 按顺序从 1 重新编号，
 * 与原输出编号一致），时间取原起止，正文取未排版原文；已归属字幕的正文
 * 前加「[ID] 」。未裁决的并列按无标签处理（导出前应由 exportReady 禁用）。
 * @param {Array} mappings remap 输出（与 computeSpeakers 同一输入，按输出顺序）
 * @param {object} result computeSpeakers 的成功结果
 * @param {Map} choices 并列裁决（Map<输出编号, 说话人ID>）
 * @returns {Array<{start:number, end:number, text:string}>}
 */
function buildSpeakerEntries(mappings, result, choices) {
  return result.items.map((it, i) => {
    const speaker = speakerForItem(it, choices);
    const text = String(mappings[i].text ?? '');
    return {
      start: it.start,
      end: it.end,
      text: speaker ? `[${speaker}] ${text}` : text,
    };
  });
}

const speakerApi = {
  MAX_ID_LENGTH,
  parseSpeakerIntervals,
  mapSpeakerIntervals,
  unionIntervals,
  computeSpeakers,
  speakerForItem,
  exportReady,
  buildSpeakerEntries,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = speakerApi;
}
if (typeof window !== 'undefined') {
  window.Speaker = speakerApi;
}
