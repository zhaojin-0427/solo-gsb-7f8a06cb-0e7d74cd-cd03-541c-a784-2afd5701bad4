'use strict';

/**
 * 源字幕勘误回写。
 *
 * 用户对输出条目的未排版正文提交修订，修订按源字幕（cueIndex）归并：
 * 同一源字幕因跨切点拆分或重复剪辑产生的多条输出共享同一份源文修订。
 *
 * 冲突裁决：同一源字幕被提交了不同正文时，各版本全部进入候选并标记
 * “待裁决”，必须显式选定其中一版才生效——不会以最后一次编辑覆盖已有
 * 版本；存在未裁决冲突时禁止导出（exportBlocked）。
 *
 * 校验：修订正文不得为空，也不得包含空白行（仅含空白字符的行）。
 *
 * 导出：buildCorrectedCues 生成勘误后的源字幕序列——未修订的源字幕
 * （包括未进入输出的）保持原文，源时间与条目顺序完全不变。
 */

/** 规范化修订正文：统一换行符、去除整体首尾空白。 */
function normalizeRevisionText(raw) {
  return String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

/**
 * 校验修订正文：不得为空、不得含空白行。
 * @returns {{ok:boolean, text:string, error?:string}} text 为规范化后的正文
 */
function validateRevision(raw) {
  const text = normalizeRevisionText(raw);
  if (!text) {
    return { ok: false, text, error: '修订正文不能为空' };
  }
  const lines = text.split('\n');
  const blankAt = lines.findIndex((l) => l.trim() === '');
  if (blankAt !== -1) {
    return { ok: false, text, error: `修订正文第 ${blankAt + 1} 行为空白行，请删除该行或补写内容` };
  }
  return { ok: true, text };
}

/**
 * 空勘误状态。
 * revisions: Map<cueIndex, string> 已生效修订；conflicts: Map<cueIndex, {candidates:string[]}> 待裁决候选。
 */
function createState() {
  return { revisions: new Map(), conflicts: new Map() };
}

/**
 * 提交某源字幕的修订正文（按 cueIndex 归并）。
 * @returns {{ok:boolean, error?:string, status?:'revised'|'unchanged'|'conflict', candidates?:string[]}}
 *   - revised：首次提交（或裁决后再次修改）成为唯一生效版本；
 *   - unchanged：与当前生效修订一致，无变化；
 *   - conflict：与已有版本不一致，已入候选待裁决（不覆盖任何已有版本）。
 */
function submitRevision(state, cueIndex, raw) {
  const v = validateRevision(raw);
  if (!v.ok) return { ok: false, error: v.error };
  const text = v.text;

  const conflict = state.conflicts.get(cueIndex);
  if (conflict) {
    // 已待裁决：新版本追加为候选，仍须显式选定
    if (!conflict.candidates.includes(text)) conflict.candidates.push(text);
    return { ok: true, status: 'conflict', candidates: conflict.candidates.slice() };
  }

  const existing = state.revisions.get(cueIndex);
  if (existing === undefined) {
    state.revisions.set(cueIndex, text);
    return { ok: true, status: 'revised' };
  }
  if (existing === text) {
    return { ok: true, status: 'unchanged' };
  }
  // 同源不同正文：挂起当前修订，两版同时入候选，等待显式裁决（不以最后编辑覆盖）
  state.revisions.delete(cueIndex);
  const candidates = [existing, text];
  state.conflicts.set(cueIndex, { candidates });
  return { ok: true, status: 'conflict', candidates: candidates.slice() };
}

/**
 * 裁决冲突：选定候选之一作为该源字幕的修订。
 * @returns {{ok:boolean, error?:string, status?:'revised'}}
 */
function resolveConflict(state, cueIndex, chosen) {
  const conflict = state.conflicts.get(cueIndex);
  if (!conflict) return { ok: false, error: '该源字幕没有待裁决的冲突' };
  const text = normalizeRevisionText(chosen);
  if (!conflict.candidates.includes(text)) {
    return { ok: false, error: '只能选定已列出的候选版本' };
  }
  state.conflicts.delete(cueIndex);
  state.revisions.set(cueIndex, text);
  return { ok: true, status: 'revised' };
}

/** 撤销某源字幕的修订/冲突，恢复原文。返回是否有内容被撤销。 */
function revertRevision(state, cueIndex) {
  const hadRev = state.revisions.delete(cueIndex);
  const hadCon = state.conflicts.delete(cueIndex);
  return hadRev || hadCon;
}

/** 存在未裁决冲突时禁止导出。 */
function exportBlocked(state) {
  return state.conflicts.size > 0;
}

/**
 * 生成勘误后的源字幕序列：仅替换已修订正文；未修订（含未进入输出的）
 * 源字幕保持原文，源时间与条目顺序完全不变。
 * @param {Array} cues 含 index 字段的源字幕（parseSrt 结果或等价对象）
 */
function buildCorrectedCues(cues, state) {
  return cues.map((c) => (
    state.revisions.has(c.index) ? { ...c, text: state.revisions.get(c.index) } : { ...c }
  ));
}

const correctApi = {
  createState,
  validateRevision,
  normalizeRevisionText,
  submitRevision,
  resolveConflict,
  revertRevision,
  exportBlocked,
  buildCorrectedCues,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = correctApi;
}
if (typeof window !== 'undefined') {
  window.Correct = correctApi;
}
