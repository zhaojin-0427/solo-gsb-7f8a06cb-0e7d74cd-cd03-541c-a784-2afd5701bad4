'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const SAMPLE_SRT = `1
00:00:00,000 --> 00:00:03,000
第一句：开场标题（Subtitle）
第二行字幕 ABCDEFG

2
00:00:03,000 --> 00:00:07,000
第二句：这是一条横跨切点的很长很长的中文字幕，hello world！

3
00:00:08,000 --> 00:00:10,000
第三句：不会被任何剪辑段用到

4
00:00:10,000 --> 00:00:13,500
第四句：结尾段（重复使用）`;

// 播放顺序：正序段 → 2倍速倒回 → 0.5倍速慢放 → 同一段重复
const SAMPLE_SEG = `# 源起ms 源止ms 倍速
0 5000 1        # 正常速度前 5 秒（字幕2在切点被拆开）
10000 13500 2   # 2 倍速播放结尾，重复使用
3000 6000 0.5   # 倒回慢放（源段乱序）
0 2000 1        # 重复使用的源段
`;

/** 毫秒 -> HH:MM:SS,mmm（与后端格式一致） */
function fmtTs(ms) {
  const n = Math.max(0, Math.round(ms));
  const p = (v, w) => String(v).padStart(w, '0');
  return `${p(Math.floor(n / 3600000), 2)}:${p(Math.floor((n % 3600000) / 60000), 2)}:` +
    `${p(Math.floor((n % 60000) / 1000), 2)},${p(n % 1000, 3)}`;
}
function fmtRange(a, b) {
  return `${fmtTs(a)} → ${fmtTs(b)}`;
}
function fmtNum(n) {
  return n.toLocaleString('en-US');
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let lastSrt = '';
let lastSegments = '';
let lastData = null;

// 双语配对状态：transMappings 为译文重排结果，result 为 buildPairs 输出，
// biSrt 为当前（可能已排版的）双语 SRT 文本。
let biData = null;
let biSrt = '';

// 成片口播稿核对状态：vcData 为最近一次核对报告。
// 词元化/匹配/差异提取在本地 Web Worker（public/voicecheck-worker.js，
// 复用 src/voicecheck.js 算法）中执行；任务生命周期由 src/vcrunner.js 管理。
let vcData = null;

// 字幕时间避让状态：avoidData 为 Avoid.computeAvoidance 的结果（浏览器内计算，src/avoid.js），
// avoidSrt 为当前避让版 SRT 文本（未排版正文 + 新时间）
let avoidData = null;
let avoidSrt = '';

// 成片同步校准状态：syncData 为 Sync.computeSync 的结果（浏览器内计算，src/sync.js），
// syncSrt 为当前校准版 SRT 文本（未排版正文 + 校准时间）
let syncData = null;
let syncSrt = '';

// 剪辑方案对照状态：pcData 为最近一次对照结果（src/plancompare.js，浏览器内计算，
// 方案 A 取当前结果的源字幕与剪辑段，方案 B 为用户输入的剪辑段）
let pcData = null;

// 说话人标注状态：spkData 为 Speaker.computeSpeakers 的结果（浏览器内计算，src/speaker.js），
// spkChoices 为并列字幕的逐条裁决（Map<输出编号, 说话人ID>），spkSrt 为标注版 SRT 文本
// （未排版正文前加「[ID] 」，时间与编号不变）
let spkData = null;
let spkChoices = new Map();
let spkSrt = '';

// 阅读时窗审计状态：raData 为 ReadAudit.auditReading 的结果（浏览器内计算，src/readaudit.js），
// 以当前未排版输出字幕为输入；调整速度即时重算，重新生成主结果后旧结论清除。
let raData = null;

// 源字幕勘误状态：修订/冲突按源字幕 cueIndex 归并（逻辑在 src/correct.js，双端通用）
let corrState = window.Correct.createState();
let corrSrt = '';
let corrEditorFor = null; // 当前打开勘误编辑器的输出编号
let corrDraft = null; // 编辑器草稿（表格重渲染时保留）
let corrPreviewReq = 0; // 预览请求序号，防止旧响应覆盖新状态

async function run() {
  hideErrors();
  $('#resultPanel').hidden = true;
  // 开始重新生成主结果：旧核对任务与报告立即失效（迟到的消息不会改变新状态）
  invalidateVoiceCheck();

  const srt = $('#srtInput').value;
  const segments = $('#segInput').value;

  let res;
  try {
    res = await fetch('/api/remap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ srt, segments }),
    });
  } catch (e) {
    showGenericError(`请求失败：${e.message}`);
    return;
  }

  const data = await res.json();
  if (!res.ok) {
    showErrors(data.errors || []);
    return;
  }
  lastSegments = segments;
  render(data);
}

function showGenericError(message) {
  showErrors([{ type: 'other', message }]);
}

function showErrors(errors) {
  const srtErrs = errors.filter((e) => e.type === 'srt');
  const segErrs = errors.filter((e) => e.type === 'segment');
  const otherErrs = errors.filter((e) => e.type !== 'srt' && e.type !== 'segment');

  $('#srtErrorList').innerHTML = srtErrs.length
    ? srtErrs.map((e) => `<li><span class="loc">字幕第 ${e.block} 块${
        e.lines && e.lines.length ? `（第 ${e.lines.join('、')} 行）` : ''
      }</span>${escapeHtml(e.message)}</li>`).join('')
    : '<li class="error-empty">无</li>';

  $('#segErrorList').innerHTML = segErrs.length
    ? segErrs.map((e) => `<li><span class="loc">${e.line ? `剪辑段第 ${e.line} 行` : '剪辑段'
      }</span>${escapeHtml(e.message)}</li>`).join('')
    : '<li class="error-empty">无</li>';

  const otherHtml = otherErrs.map((e) => `<li>${escapeHtml(e.message)}</li>`).join('');
  if (otherHtml) $('#srtErrorList').insertAdjacentHTML('beforeend', otherHtml);

  $('#errorCount').textContent = errors.length;
  $('#errorPanel').hidden = false;
  $('#errorSummary').textContent = `存在 ${errors.length} 个输入错误，请按提示修正`;
  $('#errorSummary').hidden = false;
  $('#errorPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hideErrors() {
  $('#errorPanel').hidden = true;
  $('#errorSummary').hidden = true;
  $('#errorSummary').textContent = '';
}

function render(data) {
  lastData = data;
  resetBilingual();
  resetCorrections();
  resetVoiceCheck();
  resetPlanCompare();
  resetSync();
  resetSpeakers();
  applyReadAudit();
  applyWrap();
  // 重新生成主结果时清空旧排程，并按当前避让参数对新结果重算
  applyAvoid();
  // 若正停留在勘误标签页，为新结果重渲染（已清空的）勘误视图
  if (!$('#corrTable').closest('.tab-body').hidden) renderCorrections();
  $('#resultPanel').hidden = false;
  renderStats(data.stats);
  renderSourceTable(data.sourceRows);
  renderOutputTable();
  renderTimelineTable(data.timeline, data.stats);
  renderDropped(data.dropped);
  $('#resultPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- 双语字幕配对（译文在浏览器内沿用 /api/remap + src/pair.js 完成） ----

/** 主结果重新生成时清除旧配对（译文文本框保留，提示重新配对）。 */
function resetBilingual() {
  biData = null;
  biSrt = '';
  $('#biErrorBox').hidden = true;
  $('#biSummary').hidden = true;
  $('#biDownloadBtn').disabled = true;
  $('#biCopyBtn').disabled = true;
  $('#biPairTable tbody').innerHTML = '';
  $('#biUnpairedTransTable tbody').innerHTML = '';
  $('#biUnpairedMainTable tbody').innerHTML = '';
  $('#biMissedTransTable tbody').innerHTML = '';
  $('#biMissedTransWrap').hidden = true;
  $('#biPairedCount').textContent = '0';
  $('#biUnpairedTransCount').textContent = '0';
  $('#biUnpairedMainCount').textContent = '0';
  $('#biMissedTransCount').textContent = '0';
  $('#biSrtOutput').textContent = '尚未粘贴译文并配对（当前主字幕结果已更新，请重新点击「配对译文」）。';
  $('#biSrtOutput').classList.add('bi-placeholder');
}

async function runPair() {
  if (!lastData) return;
  const transSrt = $('#transInput').value;
  if (!transSrt.trim()) {
    showBiErrors([{ type: 'srt', block: 0, lines: [], message: '译文 SRT 内容为空' }]);
    return;
  }

  let res;
  try {
    res = await fetch('/api/remap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ srt: transSrt, segments: lastSegments }),
    });
  } catch (e) {
    showBiErrors([{ type: 'other', message: `请求失败：${e.message}` }]);
    return;
  }

  const data = await res.json();
  if (!res.ok) {
    // 译文格式错误按原有条目提示，不清除主字幕结果与单语下载
    showBiErrors(data.errors || []);
    return;
  }
  $('#biErrorBox').hidden = true;
  applyBilingual(data);
}

/** 译文 SRT/剪辑段错误：定位到具体块/行，展示在双语工具条内（主结果不受影响）。 */
function showBiErrors(errors) {
  const srtErrs = errors.filter((e) => e.type === 'srt');
  const segErrs = errors.filter((e) => e.type === 'segment');
  const otherErrs = errors.filter((e) => e.type !== 'srt' && e.type !== 'segment');

  const srtHtml = srtErrs.length
    ? srtErrs.map((e) => `<li><span class="loc">译文第 ${e.block} 块${
        e.lines && e.lines.length ? `（第 ${e.lines.join('、')} 行）` : ''
      }</span>${escapeHtml(e.message)}</li>`).join('')
    : '';
  const segHtml = segErrs.length
    ? segErrs.map((e) => `<li><span class="loc">${e.line ? `剪辑段第 ${e.line} 行` : '剪辑段'
      }（沿用主结果时异常）</span>${escapeHtml(e.message)}</li>`).join('')
    : '';
  const otherHtml = otherErrs.map((e) => `<li>${escapeHtml(e.message)}</li>`).join('');

  $('#biErrorList').innerHTML = srtHtml + segHtml + otherHtml;
  $('#biErrorCount').textContent = errors.length;
  $('#biErrorBox').hidden = false;
}

/** 用译文重排结果完成配对并刷新双语视图与下载内容。 */
function applyBilingual(transData) {
  const result = window.Pair.buildPairs(lastData.mappings, transData.mappings);
  biData = { transData, result };
  rebuildBiSrt();

  const missedTransCount = transData.sourceRows.filter((r) => r.status !== 'used').length;
  $('#biSummary').hidden = false;
  $('#biSummary').innerHTML =
    `<span class="bi-ok">✓ 配对 ${result.pairCount} 对</span> · ` +
    `交集总和 <b>${fmtNum(result.totalOverlapMs)}</b> ms · ` +
    `<span class="dim">未配对主字幕 ${result.unpairedMain.length} 条（保留单语） · ` +
    `未配对译文 ${result.unpairedTrans.length} 条（不进入文件） · ` +
    `译文重排输出 ${transData.mappings.length} 条${
      missedTransCount ? ` · ${missedTransCount} 条译文源字幕未进入重排` : ''
    }</span>`;

  $('#biDownloadBtn').disabled = false;
  $('#biCopyBtn').disabled = false;
  renderBilingual();
}

/** 依据当前自动换行设置重建双语 SRT（主文取排版后文本，译文保持原文）。 */
function rebuildBiSrt() {
  if (!biData) return;
  const width = readWrapWidth();
  const enabled = $('#wrapEnabled').checked && width !== null;
  const entries = window.Pair.buildBilingualEntries(
    lastData.mappings,
    biData.transData.mappings,
    biData.result,
    { mainText: (m) => (enabled ? m.wrappedText : m.text) },
  );
  biSrt = window.Srt.serializeSrt(entries);
  const pre = $('#biSrtOutput');
  pre.textContent = biSrt;
  pre.classList.remove('bi-placeholder');
}

function mainById(newIndex) {
  return lastData.mappings.find((m) => m.newIndex === newIndex);
}
function transById(newIndex) {
  return biData.transData.mappings.find((m) => m.newIndex === newIndex);
}

function renderBilingual() {
  if (!biData) return;
  const { result, transData } = biData;

  $('#biPairedCount').textContent = result.pairCount;
  $('#biUnpairedTransCount').textContent = result.unpairedTrans.length;
  $('#biUnpairedMainCount').textContent = result.unpairedMain.length;

  $('#biPairTable tbody').innerHTML = result.pairs.map((p) => {
    const m = mainById(p.mainNewIndex);
    const t = transById(p.transNewIndex);
    const mainText = m.wrap && !m.wrap.ok
      ? `<span class="tag tag-warn">无解·原文</span> ${escapeHtml(m.wrappedText)}`
      : escapeHtml(m.wrappedText);
    return `<tr>
      <td class="num"><b>#${p.mainNewIndex}</b></td>
      <td class="mono">${fmtRange(m.start, m.end)}</td>
      <td class="num">${p.segOrder + 1}</td>
      <td><div class="cell-text">${mainText}</div></td>
      <td><div class="cell-text bi-trans-text">
        <div class="bi-trans-meta dim">源序 ${t.seq} → 输出 #${t.newIndex}</div>
        ${escapeHtml(t.text)}</div></td>
      <td class="num">${fmtNum(p.overlapMs)}</td>
    </tr>`;
  }).join('');

  $('#biUnpairedTransTable tbody').innerHTML = result.unpairedTrans.length
    ? result.unpairedTrans.map((idx) => {
      const t = transById(idx);
      return `<tr>
        <td class="num">${t.seq}</td>
        <td class="num">#${t.newIndex}</td>
        <td class="num">${t.segOrder + 1}</td>
        <td class="mono">${fmtRange(t.start, t.end)}</td>
        <td><div class="cell-text">${escapeHtml(t.text)}</div></td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="5" class="dim">无</td></tr>';

  $('#biUnpairedMainTable tbody').innerHTML = result.unpairedMain.length
    ? result.unpairedMain.map((idx) => {
      const m = mainById(idx);
      return `<tr>
        <td class="num"><b>#${m.newIndex}</b></td>
        <td class="mono">${fmtRange(m.start, m.end)}</td>
        <td class="num">${m.segOrder + 1}</td>
        <td><div class="cell-text">${escapeHtml(m.wrappedText)}</div></td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="4" class="dim">无</td></tr>';

  // 译文源字幕中未进入重排的条目（未命中剪辑段 / 零长舍弃），仅提示不参与配对
  const missedRows = transData.sourceRows.filter((r) => r.status !== 'used');
  $('#biMissedTransWrap').hidden = missedRows.length === 0;
  $('#biMissedTransCount').textContent = missedRows.length;
  $('#biMissedTransTable tbody').innerHTML = missedRows.length
    ? missedRows.map((r) => {
      const tag = r.status === 'zero-length'
        ? '<span class="tag tag-zero">零长舍弃</span>'
        : '<span class="tag tag-missed">未命中丢弃</span>';
      return `<tr>
        <td class="num">${r.seq}</td>
        <td class="mono">${fmtRange(r.sourceStart, r.sourceEnd)}</td>
        <td>${tag}</td>
        <td><div class="cell-text">${escapeHtml(r.text)}</div></td>
      </tr>`;
    }).join('')
    : '';
}

// ---- 成片口播稿核对（Worker 内计算：public/voicecheck-worker.js 复用 src/voicecheck.js） ----

/**
 * 核对任务生命周期：每页最多一个在途任务；完成/取消/异常后释放 Worker；
 * 旧任务迟到的消息由 runner 忽略，不改变当前状态；失败只提示并恢复，不回主线程计算。
 */
const vcRunner = window.VcRunner.createVoiceCheckRunner({
  createWorker: () => new Worker('voicecheck-worker.js'),
  onBusy() {
    $('#vcCancelBtn').hidden = false;
    const st = $('#vcStatus');
    st.hidden = false;
    st.textContent = '⏳ 正在后台核对口播稿：计算期间可继续编辑稿件、切换页签或取消。';
    const ph = $('#vcPlaceholder');
    ph.hidden = false;
    ph.textContent = '正在后台核对口播稿…';
  },
  onSettled() {
    $('#vcCancelBtn').hidden = true;
    $('#vcStatus').hidden = true;
  },
  onReport(report) {
    if (!report || !report.ok) {
      // 空输入或超过每侧 1500 词元：明确提示，不生成报告
      vcData = null;
      $('#vcSummary').hidden = true;
      $('#vcReportWrap').hidden = true;
      const ph = $('#vcPlaceholder');
      ph.hidden = false;
      ph.textContent = '未生成核对报告。';
      showVoiceError(report && report.message ? report.message : '核对失败。');
      return;
    }
    $('#vcErrorBox').hidden = true;
    vcData = report;
    renderVoiceCheck();
  },
  onError(message) {
    vcData = null;
    $('#vcSummary').hidden = true;
    $('#vcReportWrap').hidden = true;
    const ph = $('#vcPlaceholder');
    ph.hidden = false;
    ph.textContent = '未生成核对报告。';
    showVoiceError(message);
  },
});

/** 清除核对报告视图（不触碰在途任务；placeholderText 为占位提示）。 */
function resetVoiceCheck(placeholderText) {
  vcData = null;
  $('#vcErrorBox').hidden = true;
  $('#vcSummary').hidden = true;
  $('#vcSummary').innerHTML = '';
  $('#vcReportWrap').hidden = true;
  $('#vcScriptFragTable tbody').innerHTML = '';
  $('#vcSubFragTable tbody').innerHTML = '';
  $('#vcScriptFragCount').textContent = '0';
  $('#vcSubFragCount').textContent = '0';
  const ph = $('#vcPlaceholder');
  ph.hidden = false;
  ph.textContent = placeholderText || '主字幕结果已更新，请重新点击「核对口播稿」。';
}

/** 作废旧任务与旧报告：终止 Worker、恢复操作并清空报告视图。 */
function invalidateVoiceCheck(placeholderText) {
  vcRunner.invalidate();
  resetVoiceCheck(placeholderText);
}

function showVoiceError(message) {
  $('#vcErrorBox').innerHTML = `<div class="bi-error-head">⚠️ ${escapeHtml(message)}</div>`;
  $('#vcErrorBox').hidden = false;
}

/**
 * 提交核对：固定当前稿件与当前未排版输出字幕的快照（仅取核对所需字段），
 * 交给后台 Worker 计算；旧任务与旧报告立即失效。
 */
function runVoiceCheck() {
  if (!lastData) return;
  const snapshot = {
    script: $('#voiceInput').value,
    mappings: lastData.mappings.map((m) => ({
      newIndex: m.newIndex,
      start: m.start,
      end: m.end,
      text: m.text,
    })),
  };
  resetVoiceCheck(); // 旧报告立即失效（submit 内部会终止旧任务）
  vcRunner.submit(snapshot);
}

/** 相邻已匹配字幕定位（稿件侧）：显示编号/时间，可点击跳转到输出字幕列表。 */
function vcAnchorHtml(anchor) {
  if (!anchor) return '<span class="dim">—</span>';
  return `<span class="out-ref" data-jump="${anchor.newIndex}">#${anchor.newIndex}</span> `
    + `<span class="mono dim">${fmtRange(anchor.start, anchor.end)}</span>`;
}

function renderVoiceCheck() {
  if (!vcData) return;
  const r = vcData;

  const matchedRate = r.scriptCount
    ? Math.round(r.matchedCount / r.scriptCount * 100) : 0;
  $('#vcSummary').hidden = false;
  $('#vcSummary').innerHTML =
    `<span class="bi-ok">✓ 匹配 ${r.matchedCount} 个词元</span>（稿件覆盖率 ${matchedRate}%） · `
    + `稿件词元 <b>${fmtNum(r.scriptCount)}</b> · 字幕词元 <b>${fmtNum(r.subtitleCount)}</b> · `
    + `<span class="${r.scriptFragments.length ? 'corr-blocked' : 'wrap-ok'}">稿件未匹配片段 ${r.scriptFragments.length}</span> · `
    + `<span class="${r.subtitleFragments.length ? 'corr-blocked' : 'wrap-ok'}">字幕多出片段 ${r.subtitleFragments.length}</span>`;

  $('#vcScriptFragCount').textContent = r.scriptFragments.length;
  $('#vcScriptFragTable tbody').innerHTML = r.scriptFragments.length
    ? r.scriptFragments.map((f, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td><div class="cell-text vc-frag">${escapeHtml(f.text)}</div></td>
      <td>${vcAnchorHtml(f.prev)}</td>
      <td>${vcAnchorHtml(f.next)}</td>
    </tr>`).join('')
    : '<tr><td colspan="4" class="dim">无：稿件词元全部匹配。</td></tr>';

  $('#vcSubFragCount').textContent = r.subtitleFragments.length;
  $('#vcSubFragTable tbody').innerHTML = r.subtitleFragments.length
    ? r.subtitleFragments.map((f, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td class="num"><span class="out-ref" data-jump="${f.newIndex}">#${f.newIndex}</span></td>
      <td class="mono">${fmtRange(f.start, f.end)}</td>
      <td><div class="cell-text vc-frag">${escapeHtml(f.text)}</div></td>
    </tr>`).join('')
    : '<tr><td colspan="4" class="dim">无：输出字幕词元全部在稿件中出现。</td></tr>';

  $('#vcReportWrap').hidden = false;
  $('#vcPlaceholder').hidden = true;
}

// ---- 字幕时间避让（整体平移；逻辑在 src/avoid.js，双端通用，不请求后端） ----

/** 清空旧排程与避让视图（参数输入保留）。 */
function resetAvoid() {
  avoidData = null;
  avoidSrt = '';
  $('#avoidSummary').innerHTML = '';
  $('#avoidDownloadBtn').disabled = true;
  $('#avoidCopyBtn').disabled = true;
  $('#avoidTable tbody').innerHTML = '';
  $('#avoidTableWrap').hidden = true;
  $('#avoidFailBox').hidden = true;
  $('#avoidFailBox').innerHTML = '';
  const ph = $('#avoidPlaceholder');
  ph.hidden = false;
  ph.textContent = '尚未计算时间避让。';
}

/** 读取并校验避让参数；非法时标红输入框并返回 null。 */
function readAvoidParams() {
  const gap = Number($('#avoidGap').value);
  const shift = Number($('#avoidShift').value);
  const gapOk = Number.isInteger(gap) && gap >= 0 && gap <= window.Avoid.MAX_GAP;
  const shiftOk = Number.isInteger(shift) && shift >= 0 && shift <= window.Avoid.MAX_SHIFT;
  $('#avoidGap').classList.toggle('input-invalid', !gapOk);
  $('#avoidShift').classList.toggle('input-invalid', !shiftOk);
  return gapOk && shiftOk ? { minGap: gap, maxShift: shift } : null;
}

/** 依据当前参数对当前未排版输出计算避让排程并刷新视图（参数变化即重算）。 */
function applyAvoid() {
  if (!lastData) return;
  resetAvoid();
  const params = readAvoidParams();
  if (!params) {
    $('#avoidSummary').innerHTML = '<span class="wrap-fail">参数须为整数：最小间隔 0～500 ms、最大平移量 0～1000 ms</span>';
    $('#avoidPlaceholder').textContent = '避让参数无效，未计算。';
    return;
  }
  const r = window.Avoid.computeAvoidance(
    lastData.mappings, lastData.timeline, params.minGap, params.maxShift);
  avoidData = r;
  if (!r.ok) {
    // 超限/无解等：提示（无解含最短不可行前缀末条编号），禁用避让版下载
    $('#avoidSummary').innerHTML = `<span class="wrap-fail">⚠ ${escapeHtml(r.message)}</span>`;
    $('#avoidFailBox').innerHTML = `⚠️ ${escapeHtml(r.message)}`
      + (r.code === 'infeasible' ? ' 可尝试增大最大平移量或减小最小间隔。' : '');
    $('#avoidFailBox').hidden = false;
    $('#avoidPlaceholder').textContent = '未生成避让排程，避让版下载已禁用。';
    return;
  }
  avoidSrt = window.Srt.serializeSrt(window.Avoid.buildAvoidedEntries(lastData.mappings, r));
  $('#avoidSummary').innerHTML = `<span class="wrap-ok">✓ 可行排程</span> · `
    + `总平移 <b>${fmtNum(r.totalAbsShift)}</b> ms · 最大单条位移 ${fmtNum(r.maxAbsShift)} ms · `
    + `平移 ${r.shiftedCount}/${lastData.mappings.length} 条`;
  $('#avoidDownloadBtn').disabled = false;
  $('#avoidCopyBtn').disabled = false;
  renderAvoidTable();
  $('#avoidTableWrap').hidden = false;
  $('#avoidPlaceholder').hidden = true;
}

/** 逐条对照：原时间 vs 新时间 vs 位移。 */
function renderAvoidTable() {
  if (!avoidData || !avoidData.ok || !lastData) return;
  $('#avoidTable tbody').innerHTML = avoidData.items.map((it) => {
    const m = lastData.mappings[it.newIndex - 1];
    const cls = it.shift > 0 ? 'shift-pos' : it.shift < 0 ? 'shift-neg' : 'shift-zero';
    const label = it.shift > 0 ? `+${fmtNum(it.shift)}` : it.shift < 0 ? `−${fmtNum(-it.shift)}` : '0';
    return `<tr id="avoid-row-${it.newIndex}">
      <td class="num"><b>#${it.newIndex}</b></td>
      <td class="num">${it.segOrder + 1}</td>
      <td class="mono">${fmtRange(it.start, it.end)}</td>
      <td class="mono">${fmtRange(it.newStart, it.newEnd)}</td>
      <td class="num"><span class="shift-badge ${cls}">${label}</span></td>
      <td class="num">${fmtNum(it.end - it.start)}</td>
      <td><div class="cell-text">${escapeHtml(m.text)}</div></td>
    </tr>`;
  }).join('');
}

function downloadAvoidSrt() {
  if (!avoidSrt) return;
  const blob = new Blob([avoidSrt], { type: 'application/x-subrip;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'output-avoid.srt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function copyAvoidSrt() {
  if (!avoidSrt) return;
  const btn = $('#avoidCopyBtn');
  try {
    await navigator.clipboard.writeText(avoidSrt);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = avoidSrt;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const old = btn.textContent;
  btn.textContent = '✓ 已复制';
  setTimeout(() => { btn.textContent = old; }, 1500);
}

// ---- 成片同步校准（锚点线性映射；逻辑在 src/sync.js，双端通用，不请求后端） ----

/** 清空旧校准与对照视图（锚点文本保留；placeholderText 为占位提示）。 */
function resetSync(placeholderText) {
  syncData = null;
  syncSrt = '';
  $('#syncErrorBox').hidden = true;
  $('#syncSummary').hidden = true;
  $('#syncSummary').innerHTML = '';
  $('#syncDownloadBtn').disabled = true;
  $('#syncCopyBtn').disabled = true;
  $('#syncTable tbody').innerHTML = '';
  $('#syncTableWrap').hidden = true;
  $('#syncFailBox').hidden = true;
  $('#syncFailBox').innerHTML = '';
  const ph = $('#syncPlaceholder');
  ph.hidden = false;
  ph.textContent = placeholderText || '主字幕结果已更新，请重新点击「应用校准」。';
}

/** 同步锚点错误：定位到具体行，只显示在校准工具条内（主结果与各项下载不受影响）。 */
function showSyncErrors(errors) {
  $('#syncErrorList').innerHTML = errors.map((e) => `<li><span class="loc">${
    e.line ? `锚点第 ${e.line} 行` : '同步锚点'
  }</span>${escapeHtml(e.message)}</li>`).join('');
  $('#syncErrorCount').textContent = errors.length;
  $('#syncErrorBox').hidden = false;
}

/**
 * 应用校准：解析锚点（src/sync.js），错误只显示在工具条内；
 * 通过后以当前未排版输出字幕的毫秒时间为旧轴逐条映射并刷新对照视图。
 */
function runSync() {
  if (!lastData) return;
  resetSync(); // 再次提交：旧校准立即失效
  const text = $('#syncAnchorInput').value;
  if (!text.trim()) {
    showSyncErrors([{ line: 0, message: '同步锚点内容为空' }]);
    $('#syncPlaceholder').textContent = '同步锚点有误，未生成校准结果。';
    return;
  }
  const { anchors, errors } = window.Sync.parseAnchors(text);
  if (errors.length > 0) {
    showSyncErrors(errors);
    $('#syncPlaceholder').textContent = '同步锚点有误，未生成校准结果。';
    return;
  }
  $('#syncErrorBox').hidden = true;
  const r = window.Sync.computeSync(lastData.mappings, anchors);
  if (!r.ok) {
    $('#syncSummary').hidden = false;
    $('#syncSummary').innerHTML = `<span class="wrap-fail">⚠ ${escapeHtml(r.message)}</span>`;
    $('#syncPlaceholder').textContent = '未生成校准结果。';
    return;
  }
  syncData = r;
  if (r.exportable) {
    syncSrt = window.Srt.serializeSrt(window.Sync.buildSyncedEntries(lastData.mappings, r));
    $('#syncDownloadBtn').disabled = false;
    $('#syncCopyBtn').disabled = false;
  }
  renderSync();
}

/** 位移徽标（前移负/后移正/未动 0），与时间避让的徽标样式一致。 */
function shiftBadgeHtml(shift) {
  const cls = shift > 0 ? 'shift-pos' : shift < 0 ? 'shift-neg' : 'shift-zero';
  const label = shift > 0 ? `+${fmtNum(shift)}` : shift < 0 ? `−${fmtNum(-shift)}` : '0';
  return `<span class="shift-badge ${cls}">${label}</span>`;
}

/** 渲染校准对照：原时间 vs 校准时间；负时刻/取整后零长行高亮并禁止导出。 */
function renderSync() {
  if (!syncData || !lastData) return;
  const r = syncData;
  const problemByIndex = new Map(r.problems.map((p) => [p.newIndex, p.kind]));

  $('#syncSummary').hidden = false;
  $('#syncSummary').innerHTML = r.exportable
    ? `<span class="bi-ok">✓ 校准完成</span> · 锚点 <b>${r.anchorCount}</b> 个 · `
      + `输出 <b>${r.items.length}</b> 条全部映射（边界最后分别四舍五入）· 可下载校准版 SRT`
    : `<span class="corr-blocked">⚠ ${r.problems.length} 条字幕校准后不可用（负时刻/取整后零长），`
      + `已禁止校准版导出</span> · 锚点 ${r.anchorCount} 个 · 主结果不受影响`;

  if (r.exportable) {
    $('#syncFailBox').hidden = true;
  } else {
    $('#syncFailBox').innerHTML = `⚠️ ${escapeHtml(r.message)}`;
    $('#syncFailBox').hidden = false;
  }

  $('#syncTable tbody').innerHTML = r.items.map((it) => {
    const m = lastData.mappings[it.newIndex - 1];
    const kind = problemByIndex.get(it.newIndex);
    const problemTag = kind === 'negative'
      ? ' <span class="tag tag-missed">负时刻</span>'
      : kind === 'zero-length'
        ? ' <span class="tag tag-zero">取整后零长</span>'
        : '';
    return `<tr id="sync-row-${it.newIndex}" class="${kind ? 'sync-bad-row' : ''}">
      <td class="num"><b>#${it.newIndex}</b></td>
      <td class="mono">${fmtRange(it.start, it.end)}</td>
      <td class="mono">${fmtRange(it.newStart, it.newEnd)}${problemTag}<br>
        <span class="dim">${fmtNum(it.newStart)} → ${fmtNum(it.newEnd)} ms</span></td>
      <td class="num">${shiftBadgeHtml(it.shiftStart)}</td>
      <td class="num">${shiftBadgeHtml(it.shiftEnd)}</td>
      <td class="num">${fmtNum(it.end - it.start)} → ${fmtNum(it.newEnd - it.newStart)}</td>
      <td><div class="cell-text">${escapeHtml(m.text)}</div></td>
    </tr>`;
  }).join('');
  $('#syncTableWrap').hidden = false;
  $('#syncPlaceholder').hidden = true;
}

function downloadSyncSrt() {
  if (!syncSrt) return;
  const blob = new Blob([syncSrt], { type: 'application/x-subrip;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'output-synced.srt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function copySyncSrt() {
  if (!syncSrt) return;
  const btn = $('#syncCopyBtn');
  try {
    await navigator.clipboard.writeText(syncSrt);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = syncSrt;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const old = btn.textContent;
  btn.textContent = '✓ 已复制';
  setTimeout(() => { btn.textContent = old; }, 1500);
}

// ---- 剪辑方案对照（方案 A = 当前结果的源 SRT 与剪辑段；逻辑在 src/plancompare.js，浏览器内计算） ----

/** 清空对照结果视图（方案 B 文本保留；placeholderText 为占位提示）。 */
function resetPlanCompare(placeholderText) {
  pcData = null;
  $('#pcErrorBox').hidden = true;
  $('#pcSummary').hidden = true;
  $('#pcSummary').innerHTML = '';
  $('#pcReportWrap').hidden = true;
  $('#pcCueTable tbody').innerHTML = '';
  $('#pcDetailList').innerHTML = '';
  $('#pcCueCount').textContent = '0';
  $('#pcDiffCueCount').textContent = '0';
  $('#pcDiffIntervalCount').textContent = '0';
  const ph = $('#pcPlaceholder');
  ph.hidden = false;
  ph.textContent = placeholderText || '主字幕结果已更新，请重新点击「对照方案」。';
}

/** 方案 B 剪辑段错误：定位到具体行，只显示在对照工具条内（主结果与下载不受影响）。 */
function showPlanCompareErrors(errors) {
  $('#pcErrorList').innerHTML = errors.map((e) => `<li><span class="loc">${
    e.line ? `方案 B 第 ${e.line} 行` : '方案 B'
  }</span>${escapeHtml(e.message)}</li>`).join('');
  $('#pcErrorCount').textContent = errors.length;
  $('#pcErrorBox').hidden = false;
}

/**
 * 执行对照：沿用现有剪辑段解析规则（src/segments.js）校验方案 B，
 * 错误只显示在对照区；通过后以当前结果的源字幕与剪辑段为方案 A 逐条对照。
 */
function runPlanCompare() {
  if (!lastData) return;
  resetPlanCompare(); // 再次提交：旧对照立即失效
  const text = $('#planBInput').value;
  if (!text.trim()) {
    showPlanCompareErrors([{ line: 0, message: '方案 B 剪辑段内容为空' }]);
    $('#pcPlaceholder').textContent = '方案 B 有误，未生成对照结果。';
    return;
  }
  const { segments: segsB, errors } = window.Segments.parseSegments(text);
  if (errors.length > 0) {
    showPlanCompareErrors(errors);
    $('#pcPlaceholder').textContent = '方案 B 有误，未生成对照结果。';
    return;
  }
  $('#pcErrorBox').hidden = true;
  // 方案 A：当前结果的源字幕与剪辑段（timeline 即生成时已校验的剪辑段）
  const segsA = lastData.timeline.map((t) => ({
    sourceStart: t.sourceStart,
    sourceEnd: t.sourceEnd,
    speed: t.speed,
  }));
  const cues = lastData.sourceRows.map((r) => ({ start: r.sourceStart, end: r.sourceEnd }));
  pcData = window.PlanCompare.comparePlans(cues, segsA, segsB);
  renderPlanCompare();
}

/** 半毫秒单位 → 精确毫秒文本（0.5 精度，不取整）。 */
function fmtHalfMs(half) {
  return fmtNum(half / 2);
}
/** 带符号的精确毫秒差值（正 + / 负 − / 零 0）。 */
function fmtSignedHalfMs(half) {
  if (half > 0) return `+${fmtNum(half / 2)}`;
  if (half < 0) return `−${fmtNum(-half / 2)}`;
  return '0';
}
/** 带符号的整数差值（覆盖次数差）。 */
function fmtSignedInt(n) {
  if (n > 0) return `+${fmtNum(n)}`;
  if (n < 0) return `−${fmtNum(-n)}`;
  return '0';
}
/** 差值徽标样式：正 amber / 负 accent / 零 muted（复用时间避让的徽标样式）。 */
function pcBadgeClass(v) {
  return v > 0 ? 'shift-pos' : v < 0 ? 'shift-neg' : 'shift-zero';
}

/** 渲染对照结果：每条源字幕播放时长汇总表 + 差异区间明细。 */
function renderPlanCompare() {
  if (!pcData || !lastData) return;
  const r = pcData;

  const totalText = `播放时长总计：方案 A <b>${fmtHalfMs(r.totalHalfA)}</b> ms · `
    + `方案 B <b>${fmtHalfMs(r.totalHalfB)}</b> ms · 差 A−B <b>${fmtSignedHalfMs(r.diffHalf)}</b> ms`;
  $('#pcSummary').hidden = false;
  $('#pcSummary').innerHTML = r.diffCueCount === 0
    ? `<span class="bi-ok">✓ 无差异：两套方案在全部 ${r.cueCount} 条源字幕上的覆盖次数与精确播放时长完全一致</span>`
      + ` · ${totalText}`
    : `<span class="corr-blocked">⚠ ${r.diffCueCount}/${r.cueCount} 条源字幕存在差异</span>`
      + ` · 差异区间 <b>${r.diffIntervalCount}</b> 个 · ${totalText}`;

  $('#pcCueCount').textContent = r.cueCount;
  $('#pcDiffCueCount').textContent = r.diffCueCount;
  $('#pcDiffIntervalCount').textContent = r.diffIntervalCount;

  // 每条源字幕一行：两方案精确播放时长与差值（未命中/重叠/重复源段均计入）
  $('#pcCueTable tbody').innerHTML = r.cueRows.map((c) => {
    const row = lastData.sourceRows[c.cueIndex];
    const hasDiff = c.intervals.length > 0;
    const diffCell = hasDiff
      ? `<span class="shift-badge ${pcBadgeClass(c.diffHalf)}">${fmtSignedHalfMs(c.diffHalf)}</span>`
      : '<span class="dim">0</span>';
    const ivCell = hasDiff
      ? `<button type="button" class="btn btn-ghost pc-jump" data-cue="${c.cueIndex}">${c.intervals.length} 个区间</button>`
      : '<span class="tag tag-used">一致</span>';
    return `<tr class="${hasDiff ? 'pc-diff-row' : ''}">
      <td class="num">${row.seq}</td>
      <td class="mono">${fmtRange(row.sourceStart, row.sourceEnd)}<br>
        <span class="dim">${fmtNum(row.sourceStart)} → ${fmtNum(row.sourceEnd)} ms</span></td>
      <td><div class="cell-text">${escapeHtml(row.text)}</div></td>
      <td class="num">${fmtHalfMs(c.totalHalfA)}</td>
      <td class="num">${fmtHalfMs(c.totalHalfB)}</td>
      <td class="num">${diffCell}</td>
      <td>${ivCell}</td>
    </tr>`;
  }).join('');

  // 差异区间明细：仅覆盖次数或精确播放时长不同的小区间，逐区间显示两侧数值与差值
  const diffCues = r.cueRows.filter((c) => c.intervals.length > 0);
  $('#pcDetailList').innerHTML = diffCues.length
    ? diffCues.map((c) => {
      const row = lastData.sourceRows[c.cueIndex];
      const trs = c.intervals.map((iv) => {
        const covDiff = iv.coverageA - iv.coverageB;
        const durDiff = iv.durHalfA - iv.durHalfB;
        return `<tr>
          <td class="mono">${fmtNum(iv.start)} → ${fmtNum(iv.end)}</td>
          <td class="num">${fmtNum(iv.end - iv.start)}</td>
          <td class="num">${iv.coverageA}</td>
          <td class="num">${iv.coverageB}</td>
          <td class="num"><span class="shift-badge ${pcBadgeClass(covDiff)}">${fmtSignedInt(covDiff)}</span></td>
          <td class="num">${fmtHalfMs(iv.durHalfA)}</td>
          <td class="num">${fmtHalfMs(iv.durHalfB)}</td>
          <td class="num"><span class="shift-badge ${pcBadgeClass(durDiff)}">${fmtSignedHalfMs(durDiff)}</span></td>
        </tr>`;
      }).join('');
      return `<div class="pc-cue-detail" id="pc-detail-${c.cueIndex}">
        <h4>源 #${row.seq}（${fmtNum(row.sourceStart)} → ${fmtNum(row.sourceEnd)} ms）· `
          + `时长 A ${fmtHalfMs(c.totalHalfA)} ms / B ${fmtHalfMs(c.totalHalfB)} ms · `
          + `差 <span class="${c.diffHalf === 0 ? 'dim' : 'corr-blocked'}">${fmtSignedHalfMs(c.diffHalf)} ms</span> · `
          + `${c.intervals.length} 个差异区间</h4>
        <div class="table-wrap">
          <table class="pc-interval-table">
            <thead>
              <tr>
                <th>源区间 (ms)</th>
                <th>区间长 (ms)</th>
                <th>覆盖 A</th>
                <th>覆盖 B</th>
                <th>覆盖差 A−B</th>
                <th>播放时长 A (ms)</th>
                <th>播放时长 B (ms)</th>
                <th>时长差 A−B (ms)</th>
              </tr>
            </thead>
            <tbody>${trs}</tbody>
          </table>
        </div>
      </div>`;
    }).join('')
    : '<p class="dim">无差异区间：两方案逐区间的覆盖次数与精确播放时长完全一致。</p>';

  $('#pcReportWrap').hidden = false;
  $('#pcPlaceholder').hidden = true;
}

// ---- 说话人标注（源时间轴时段映射到成片；逻辑在 src/speaker.js，双端通用，不请求后端） ----

/** 清空旧归属/裁决与标注视图（标注文本保留；placeholderText 为占位提示）。 */
function resetSpeakers(placeholderText) {
  spkData = null;
  spkChoices = new Map();
  spkSrt = '';
  $('#spkErrorBox').hidden = true;
  $('#spkSummary').hidden = true;
  $('#spkSummary').innerHTML = '';
  $('#spkDownloadBtn').disabled = true;
  $('#spkCopyBtn').disabled = true;
  $('#spkTable tbody').innerHTML = '';
  $('#spkTableWrap').hidden = true;
  $('#spkTieBox').hidden = true;
  $('#spkTieBox').innerHTML = '';
  const ph = $('#spkPlaceholder');
  ph.hidden = false;
  ph.textContent = placeholderText || '主字幕结果已更新，请重新点击「应用标注」。';
}

/** 说话人标注错误：定位到具体行，只显示在标注工具条内（主结果与各项下载不受影响）。 */
function showSpeakerErrors(errors) {
  $('#spkErrorList').innerHTML = errors.map((e) => `<li><span class="loc">${
    e.line ? `标注第 ${e.line} 行` : '说话人标注'
  }</span>${escapeHtml(e.message)}</li>`).join('');
  $('#spkErrorCount').textContent = errors.length;
  $('#spkErrorBox').hidden = false;
}

/**
 * 应用标注：解析标注时段（src/speaker.js），错误只显示在工具条内；
 * 通过后沿用当前剪辑段与倍速把标注映射到成片，逐条判定归属并刷新对照视图。
 */
function runSpeakers() {
  if (!lastData) return;
  resetSpeakers(); // 再次提交：旧归属与裁决立即失效
  const text = $('#spkInput').value;
  if (!text.trim()) {
    showSpeakerErrors([{ line: 0, message: '说话人标注内容为空' }]);
    $('#spkPlaceholder').textContent = '说话人标注有误，未生成归属结果。';
    return;
  }
  const { intervals, errors } = window.Speaker.parseSpeakerIntervals(text);
  if (errors.length > 0) {
    showSpeakerErrors(errors);
    $('#spkPlaceholder').textContent = '说话人标注有误，未生成归属结果。';
    return;
  }
  $('#spkErrorBox').hidden = true;
  const r = window.Speaker.computeSpeakers(lastData.mappings, intervals, lastData.timeline);
  if (!r.ok) {
    $('#spkSummary').hidden = false;
    $('#spkSummary').innerHTML = `<span class="wrap-fail">⚠ ${escapeHtml(r.message)}</span>`;
    $('#spkPlaceholder').textContent = '未生成归属结果。';
    return;
  }
  spkData = r;
  renderSpeakers();
}

/** 渲染归属对照：输出编号、各说话人交集时长与归属；并列行内逐条裁决，未裁决禁用导出。 */
function renderSpeakers() {
  if (!spkData || !lastData) return;
  const r = spkData;
  const unresolved = r.items.filter((it) => it.status === 'tie' && !spkChoices.has(it.newIndex));
  const ready = window.Speaker.exportReady(r, spkChoices);

  const parts = [
    `<span class="bi-ok">✓ 标注 ${r.intervalCount} 条时段</span>（映射片段 ${r.mappedCount} 个）`,
    `说话人 <b>${r.speakerIds.length}</b> 人`,
    `自动归属 <b>${r.autoCount}</b> 条`,
  ];
  if (r.tieCount > 0) {
    parts.push(unresolved.length > 0
      ? `<span class="corr-blocked">⚠ ${unresolved.length} 条并列待裁决，裁决前禁止标注版导出</span>`
      : `<span class="wrap-ok">✓ ${r.tieCount} 条并列已全部裁决</span>`);
  }
  parts.push(`<span class="dim">无标签 ${r.noneCount} 条${
    r.unmappedCount ? ` · ${r.unmappedCount} 条标注未产生成片时段（未命中剪辑段或映射后零长）` : ''
  }</span>`);
  $('#spkSummary').hidden = false;
  $('#spkSummary').innerHTML = parts.join(' · ');

  if (ready) {
    spkSrt = window.Srt.serializeSrt(window.Speaker.buildSpeakerEntries(lastData.mappings, r, spkChoices));
    $('#spkDownloadBtn').disabled = false;
    $('#spkCopyBtn').disabled = false;
    $('#spkTieBox').hidden = true;
  } else {
    spkSrt = '';
    $('#spkDownloadBtn').disabled = true;
    $('#spkCopyBtn').disabled = true;
    $('#spkTieBox').innerHTML = `⚠️ ${unresolved.length} 条输出字幕的最长交集并列（输出 ${
      unresolved.map((it) => `#${it.newIndex}`).join('、')
    }），请在下方逐条裁决；未裁决前标注版导出已禁用（主结果与其他下载不受影响）。`;
    $('#spkTieBox').hidden = false;
  }

  $('#spkTable tbody').innerHTML = r.items.map((it) => {
    const m = lastData.mappings[it.newIndex - 1];
    const overlapCell = it.overlaps.length
      ? it.overlaps.map((o) =>
        `<span class="spk-chip">${escapeHtml(o.id)} <b>${fmtNum(o.ms)}</b></span>`).join('')
      : '<span class="dim">—</span>';
    let ownerCell;
    if (it.status === 'auto') {
      ownerCell = `<span class="tag tag-spk">${escapeHtml(it.speakerId)}</span>`;
    } else if (it.status === 'none') {
      ownerCell = '<span class="dim">无标签</span>';
    } else {
      const chosen = spkChoices.get(it.newIndex);
      const head = chosen
        ? `<span class="tag tag-spk">${escapeHtml(chosen)}</span> <span class="tag tag-used">已裁决</span>`
        : '<span class="tag tag-zero">并列待裁决</span>';
      const buttons = it.candidates.map((id) => {
        const ms = it.overlaps.find((o) => o.id === id).ms;
        const isChosen = chosen === id;
        return `<button type="button" class="btn btn-ghost spk-pick${isChosen ? ' spk-picked' : ''}" `
          + `data-newindex="${it.newIndex}" data-speaker="${escapeHtml(id)}">`
          + `${isChosen ? '✓ ' : ''}${escapeHtml(id)}（${fmtNum(ms)} ms）</button>`;
      }).join(' ');
      ownerCell = `${head}<div class="spk-picks">${buttons}</div>`;
    }
    const rowCls = it.status === 'tie'
      ? (spkChoices.has(it.newIndex) ? 'spk-tie-resolved' : 'spk-tie-row')
      : '';
    return `<tr id="spk-row-${it.newIndex}" class="${rowCls}">
      <td class="num"><b>#${it.newIndex}</b></td>
      <td class="mono">${fmtRange(it.start, it.end)}</td>
      <td class="num">${it.segOrder + 1}</td>
      <td>${overlapCell}</td>
      <td>${ownerCell}</td>
      <td><div class="cell-text">${escapeHtml(m.text)}</div></td>
    </tr>`;
  }).join('');
  $('#spkTableWrap').hidden = false;
  $('#spkPlaceholder').hidden = true;
}

function downloadSpkSrt() {
  if (!spkSrt) return;
  const blob = new Blob([spkSrt], { type: 'application/x-subrip;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'output-speakers.srt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function copySpkSrt() {
  if (!spkSrt) return;
  const btn = $('#spkCopyBtn');
  try {
    await navigator.clipboard.writeText(spkSrt);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = spkSrt;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const old = btn.textContent;
  btn.textContent = '✓ 已复制';
  setTimeout(() => { btn.textContent = old; }, 1500);
}

// ---- 阅读时窗审计（EDF；逻辑在 src/readaudit.js，双端通用，不请求后端，不改动字幕） ----

/** 清空旧审计结论与视图（速度输入保留；placeholderText 为占位提示）。 */
function resetReadAudit(placeholderText) {
  raData = null;
  $('#raSummary').innerHTML = '';
  $('#raMissBox').hidden = true;
  $('#raMissBox').innerHTML = '';
  $('#raTable tbody').innerHTML = '';
  $('#raTableWrap').hidden = true;
  const ph = $('#raPlaceholder');
  ph.hidden = false;
  ph.textContent = placeholderText || '主字幕结果已更新，请重新审计（调整阅读速度即可自动重算）。';
}

/** 读取阅读速度；非法时标红输入框并返回 null。 */
function readAuditSpeed() {
  const v = Number($('#raSpeed').value);
  const ok = window.ReadAudit.isValidSpeed(v);
  $('#raSpeed').classList.toggle('input-invalid', !ok);
  return ok ? v : null;
}

/** 千分之一单位 → 三位小数文本。 */
function fmtRaMilli(milli) {
  return window.ReadAudit.formatMilli(milli);
}

/** 分数毫秒统计：整数不带小数，非整数保留至多 3 位（去尾零）。 */
function fmtRaMs(ms) {
  if (Number.isInteger(ms)) return fmtNum(ms);
  return fmtNum(Math.round(ms * 1000) / 1000);
}

/** 依据当前速度对当前未排版输出重新审计（速度变化或重新生成主结果即重算）。 */
function applyReadAudit() {
  if (!lastData) return;
  resetReadAudit();
  const speed = readAuditSpeed();
  if (speed === null) {
    $('#raSummary').innerHTML = '<span class="wrap-fail">阅读速度须为 1～40 的整数（单位/秒）</span>';
    $('#raPlaceholder').textContent = '阅读速度无效，未审计。';
    return;
  }
  let r;
  try {
    r = window.ReadAudit.auditReading(lastData.mappings, speed);
  } catch (e) {
    $('#raSummary').innerHTML = `<span class="wrap-fail">⚠ ${escapeHtml(e.message)}</span>`;
    $('#raPlaceholder').textContent = '无法审计：输出字幕时间区间无效。';
    return;
  }
  raData = r;
  renderReadAudit();
}

/** 渲染审计结果：逐条需求量/已读量/欠量，标出最早失约时刻。 */
function renderReadAudit() {
  if (!raData || !lastData) return;
  const r = raData;
  const missCount = r.missNewIndexes.length;
  const readRate = r.totalDemandMilli
    ? Math.round(r.totalReadMilli / r.totalDemandMilli * 100) : 100;

  const parts = [
    `速度 <b>${r.speed}</b> 单位/秒`,
    `输出 <b>${r.cueCount}</b> 条`,
    `总需求 <b>${fmtRaMilli(r.totalDemandMilli)}</b>`,
    `已读 <b>${fmtRaMilli(r.totalReadMilli)}</b>（${readRate}%）`,
  ];
  if (missCount > 0) {
    parts.push(`<span class="corr-blocked">⚠ 欠量 ${missCount} 条，共 ${fmtRaMilli(r.totalShortfallMilli)}；`
      + `最早失约时刻 <b>${fmtTs(r.firstMissMs)}</b>（${fmtNum(r.firstMissMs)} ms）</span>`);
  } else {
    parts.push('<span class="wrap-ok">✓ 全部按时读完，无欠量</span>');
  }
  parts.push(`<span class="dim">满速阅读 ${fmtRaMs(r.readMs)} ms · 空闲 ${fmtRaMs(r.idleMs)} ms（分数毫秒精确统计）</span>`);
  $('#raSummary').innerHTML = parts.join(' · ');

  if (missCount > 0) {
    $('#raMissBox').innerHTML = `⚠️ 最早失约时刻：<b>${fmtTs(r.firstMissMs)}</b>（${fmtNum(r.firstMissMs)} ms，`
      + `输出 ${r.items.filter((it) => it.firstMiss).map((it) => `#${it.newIndex}`).join('、')} 的显示截止点）。`
      + '到截止仍未读完的部分已记为欠量并移除（半开区间终点不可读）。';
    $('#raMissBox').hidden = false;
  }

  $('#raTable tbody').innerHTML = r.items.map((it) => {
    const m = lastData.mappings[it.newIndex - 1];
    let statusCell;
    if (it.demandMilli === 0) {
      statusCell = '<span class="tag tag-zero">零需求</span>';
    } else if (it.completed) {
      statusCell = '<span class="tag tag-used">已读完</span>';
    } else {
      const tag = it.firstMiss
        ? '<span class="tag tag-missed">欠量·最早失约</span>'
        : '<span class="tag tag-warn">欠量</span>';
      statusCell = `${tag}<div class="dim ra-miss-at">截止 ${fmtTs(it.end)}</div>`;
    }
    return `<tr id="ra-row-${it.newIndex}" class="${it.firstMiss ? 'ra-miss-row' : ''}">
      <td class="num"><b>#${it.newIndex}</b></td>
      <td class="mono">${fmtRange(it.start, it.end)}<br>
        <span class="dim">${fmtNum(it.start)} → ${fmtNum(it.end)} ms（半开）</span></td>
      <td class="num">${fmtNum(it.durationMs)}</td>
      <td class="num">${fmtRaMilli(it.demandMilli)}</td>
      <td class="num">${fmtRaMilli(it.readMilli)}</td>
      <td class="num"><b class="${it.shortfallMilli > 0 ? 'ra-short' : 'dim'}">${fmtRaMilli(it.shortfallMilli)}</b></td>
      <td>${statusCell}</td>
      <td><div class="cell-text">${escapeHtml(m.text)}</div></td>
    </tr>`;
  }).join('');
  $('#raTableWrap').hidden = false;
  $('#raPlaceholder').hidden = true;
}

// ---- 源字幕勘误回写（按源字幕归并；冲突需显式裁决，未裁决禁止导出） ----

/** 主结果重新生成时清空勘误状态（与 resetBilingual 同步调用）。 */
function resetCorrections() {
  corrState = window.Correct.createState();
  corrSrt = '';
  corrEditorFor = null;
  corrDraft = null;
  corrPreviewReq += 1; // 使进行中的预览响应失效
  $('#corrDownloadBtn').disabled = true;
  $('#corrCopyBtn').disabled = true;
  $('#corrSummary').innerHTML = '';
  $('#corrConflictBox').hidden = true;
  $('#corrConflictList').innerHTML = '';
  $('#corrTable tbody').innerHTML = '';
  $('#corrRevisionsTable tbody').innerHTML = '';
  $('#corrCount').textContent = '0';
  $('#corrPreviewWrap').hidden = true;
  $('#corrPreviewHint').textContent = '提交勘误后，将按当前剪辑段对勘误后的源字幕重新重排并在此预览。';
  const pre = $('#corrSrtOutput');
  pre.textContent = '尚未提交勘误。';
  pre.classList.add('bi-placeholder');
}

/** 输出/勘误列表共用的状态标签。 */
function corrTagHtml(cueIndex) {
  if (corrState.conflicts.has(cueIndex)) return '<span class="tag tag-zero">冲突待裁决</span>';
  if (corrState.revisions.has(cueIndex)) return '<span class="tag tag-used">已勘误</span>';
  return '';
}

/** 源字幕序列（含未进入输出者），供生成勘误后源 SRT 使用；时间与顺序保持原样。 */
function sourceCuesForCorrection() {
  return lastData.sourceRows.map((r) => ({
    index: r.cueIndex,
    seq: r.seq,
    start: r.sourceStart,
    end: r.sourceEnd,
    text: r.text,
  }));
}

/** 依据当前勘误状态重建勘误后源 SRT 文本。 */
function rebuildCorrSrt() {
  corrSrt = window.Srt.serializeSrt(window.Correct.buildCorrectedCues(sourceCuesForCorrection(), corrState));
  const pre = $('#corrSrtOutput');
  if (corrState.revisions.size === 0 && corrState.conflicts.size === 0) {
    pre.textContent = '尚未提交勘误。';
    pre.classList.add('bi-placeholder');
  } else {
    pre.textContent = corrSrt;
    pre.classList.remove('bi-placeholder');
  }
}

function renderCorrections() {
  if (!lastData) return;
  renderCorrSummary();
  renderCorrConflicts();
  renderCorrTable();
  renderCorrRevisions();
  refreshCorrPreview();
}

function renderCorrSummary() {
  const revised = corrState.revisions.size;
  const conflicts = corrState.conflicts.size;
  const canExport = revised > 0 && conflicts === 0;
  $('#corrDownloadBtn').disabled = !canExport;
  $('#corrCopyBtn').disabled = !canExport;
  const parts = [revised > 0 ? `已修订 <b>${revised}</b> 条源字幕` : '尚未提交勘误'];
  if (conflicts > 0) {
    parts.push(`<span class="corr-blocked">⚠ ${conflicts} 组同源冲突待裁决，裁决前禁止导出</span>`);
  } else if (revised > 0) {
    parts.push('<span class="wrap-ok">✓ 无冲突，可导出勘误后源 SRT</span>');
  }
  $('#corrSummary').innerHTML = parts.join(' · ');
}

/** 冲突裁决区：列出同源不同正文候选，必须显式选定一版。 */
function renderCorrConflicts() {
  const conflicts = Array.from(corrState.conflicts.entries());
  $('#corrConflictBox').hidden = conflicts.length === 0;
  $('#corrConflictCount').textContent = conflicts.length;
  if (!conflicts.length) {
    $('#corrConflictList').innerHTML = '';
    return;
  }
  $('#corrConflictList').innerHTML = conflicts.map(([cueIndex, c]) => {
    const row = lastData.sourceRows.find((r) => r.cueIndex === cueIndex);
    const cands = c.candidates.map((text, i) => `
      <div class="corr-candidate">
        <div class="corr-candidate-head">
          <span class="tag tag-zero">候选 ${i + 1}</span>
          <button type="button" class="btn corr-resolve" data-cue="${cueIndex}" data-cand="${i}">采用此版</button>
        </div>
        <div class="cell-text wrap-box">${escapeHtml(text)}</div>
      </div>`).join('');
    return `<div class="corr-conflict-item">
      <div class="corr-conflict-meta">源 #${row.seq}（${fmtRange(row.sourceStart, row.sourceEnd)}）· 原文：</div>
      <div class="cell-text wrap-box wrap-box-old">${escapeHtml(row.text)}</div>
      <div class="corr-candidates">${cands}</div>
    </div>`;
  }).join('');
}

/** 输出条目勘误表：每行一条输出，同源输出共享一份修订。 */
function renderCorrTable() {
  if (!lastData) return;
  const sameCueCount = new Map();
  lastData.mappings.forEach((m) => sameCueCount.set(m.cueIndex, (sameCueCount.get(m.cueIndex) || 0) + 1));

  const rows = [];
  for (const m of lastData.mappings) {
    const rev = corrState.revisions.get(m.cueIndex);
    const shared = sameCueCount.get(m.cueIndex) > 1
      ? `<br><span class="dim">同源 ${sameCueCount.get(m.cueIndex)} 条输出共享修订</span>` : '';
    const revPreview = rev !== undefined
      ? `<div class="corr-rev-preview dim">修订后：${escapeHtml(rev)}</div>` : '';
    rows.push(`<tr id="corr-row-${m.newIndex}">
      <td class="num"><b>#${m.newIndex}</b></td>
      <td class="mono">${fmtRange(m.start, m.end)}</td>
      <td class="num">源 #${m.seq}${shared}</td>
      <td><div class="cell-text">${escapeHtml(m.text)}</div>${revPreview}</td>
      <td>${corrTagHtml(m.cueIndex) || '<span class="dim">—</span>'}</td>
      <td><button type="button" class="btn btn-ghost corr-edit" data-newindex="${m.newIndex}">勘误</button></td>
    </tr>`);
    if (corrEditorFor === m.newIndex) {
      const prefill = corrDraft && corrDraft.newIndex === m.newIndex
        ? corrDraft.text
        : (rev !== undefined ? rev : m.text);
      rows.push(`<tr class="corr-editor-row"><td colspan="6">
        <div class="corr-editor">
          <div class="hint">修订源 #${m.seq} 的未排版正文（同源输出共享此修订；正文不能为空且不得含空白行）：</div>
          <textarea id="corrEditorText" rows="3" spellcheck="false">${escapeHtml(prefill)}</textarea>
          <div class="corr-editor-actions">
            <button type="button" class="btn btn-primary" id="corrSubmitBtn">提交修订</button>
            <button type="button" class="btn" id="corrCancelBtn">取消</button>
            <span class="corr-editor-error" id="corrEditorError"></span>
          </div>
        </div>
      </td></tr>`);
    }
  }
  $('#corrTable tbody').innerHTML = rows.join('');
}

/** 已提交修订列表（按提交顺序），可单条撤销恢复原文。 */
function renderCorrRevisions() {
  const entries = Array.from(corrState.revisions.entries());
  $('#corrCount').textContent = entries.length;
  $('#corrRevisionsTable tbody').innerHTML = entries.length
    ? entries.map(([cueIndex, text]) => {
      const row = lastData.sourceRows.find((r) => r.cueIndex === cueIndex);
      const refs = row.outputs.length
        ? row.outputs.map((n) => `<span class="out-ref" data-jump="${n}">#${n}</span>`).join('')
        : '<span class="dim">—</span>';
      return `<tr>
        <td class="num">${row.seq}</td>
        <td class="mono">${fmtRange(row.sourceStart, row.sourceEnd)}</td>
        <td><div class="cell-text">${escapeHtml(row.text)}</div></td>
        <td><div class="cell-text">${escapeHtml(text)}</div></td>
        <td>${refs}</td>
        <td><button type="button" class="btn btn-ghost corr-revert" data-cue="${cueIndex}">撤销</button></td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="6" class="dim">无</td></tr>';
}

/** 按当前剪辑段对勘误后的源字幕重新重排并预览（复用同一 /api/remap）。 */
async function refreshCorrPreview() {
  const hint = $('#corrPreviewHint');
  const wrapEl = $('#corrPreviewWrap');
  if (corrState.conflicts.size > 0) {
    wrapEl.hidden = true;
    hint.innerHTML = '<span class="corr-blocked">存在未裁决的同源冲突，裁决后才能生成重排预览。</span>';
    return;
  }
  if (corrState.revisions.size === 0) {
    wrapEl.hidden = true;
    hint.textContent = '提交勘误后，将按当前剪辑段对勘误后的源字幕重新重排并在此预览（同源输出文本一致）。';
    return;
  }
  const reqId = ++corrPreviewReq;
  let res;
  try {
    res = await fetch('/api/remap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ srt: corrSrt, segments: lastSegments }),
    });
  } catch (e) {
    if (reqId !== corrPreviewReq) return;
    wrapEl.hidden = true;
    hint.textContent = `预览请求失败：${e.message}`;
    return;
  }
  const data = await res.json();
  if (reqId !== corrPreviewReq) return;
  if (!res.ok) {
    wrapEl.hidden = true;
    hint.textContent = `勘误后源 SRT 重排失败：${(data.errors || []).map((e) => e.message).join('；')}`;
    return;
  }
  const sameCue = new Map();
  data.mappings.forEach((m) => sameCue.set(m.cueIndex, (sameCue.get(m.cueIndex) || 0) + 1));
  hint.innerHTML = `勘误后的源字幕按当前剪辑段重新重排，共 <b>${data.mappings.length}</b> 条输出；`
    + '同一源字幕的多条输出共享同一份源文修订，文本一致。';
  $('#corrPreviewTable tbody').innerHTML = data.mappings.map((m) => {
    const shared = sameCue.get(m.cueIndex) > 1
      ? `<br><span class="dim">同源 ${sameCue.get(m.cueIndex)} 条同文</span>` : '';
    const revTag = corrState.revisions.has(m.cueIndex) ? ' <span class="tag tag-used">已勘误</span>' : '';
    return `<tr>
      <td class="num"><b>#${m.newIndex}</b></td>
      <td class="mono">${fmtRange(m.start, m.end)}</td>
      <td class="num">${m.segOrder + 1}</td>
      <td class="num">源 #${m.seq}${shared}</td>
      <td><div class="cell-text">${escapeHtml(m.text)}</div>${revTag}</td>
    </tr>`;
  }).join('');
  wrapEl.hidden = false;
}

function openCorrEditor(newIndex) {
  if (corrEditorFor === newIndex) {
    corrEditorFor = null;
    corrDraft = null;
  } else {
    corrEditorFor = newIndex;
    corrDraft = null; // 由 renderCorrTable 用当前修订/原文预填
  }
  renderCorrTable();
  const ta = $('#corrEditorText');
  if (ta) ta.focus();
}

function submitCorr() {
  if (corrEditorFor === null || !lastData) return;
  const m = lastData.mappings.find((x) => x.newIndex === corrEditorFor);
  const ta = $('#corrEditorText');
  if (!m || !ta) return;
  const r = window.Correct.submitRevision(corrState, m.cueIndex, ta.value);
  if (!r.ok) {
    $('#corrEditorError').textContent = r.error;
    return;
  }
  corrEditorFor = null;
  corrDraft = null;
  afterCorrChange();
}

function resolveCorr(cueIndex, candIdx) {
  const conflict = corrState.conflicts.get(cueIndex);
  if (!conflict) return;
  const r = window.Correct.resolveConflict(corrState, cueIndex, conflict.candidates[candIdx]);
  if (r.ok) afterCorrChange();
}

function revertCorr(cueIndex) {
  window.Correct.revertRevision(corrState, cueIndex);
  afterCorrChange();
}

/** 勘误状态变化后：重建勘误后源 SRT、刷新勘误页与输出列表状态。 */
function afterCorrChange() {
  rebuildCorrSrt();
  renderCorrections();
  if (!$('#outputTable').closest('.tab-body').hidden) renderOutputTable();
}

function corrCanExport() {
  return corrState.revisions.size > 0 && corrState.conflicts.size === 0;
}

function downloadCorrSrt() {
  if (!corrCanExport() || !corrSrt) return;
  const blob = new Blob([corrSrt], { type: 'application/x-subrip;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'output-source-corrected.srt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function copyCorrSrt() {
  if (!corrCanExport() || !corrSrt) return;
  const btn = $('#corrCopyBtn');
  try {
    await navigator.clipboard.writeText(corrSrt);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = corrSrt;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const old = btn.textContent;
  btn.textContent = '✓ 已复制';
  setTimeout(() => { btn.textContent = old; }, 1500);
}

// ---- 字幕自动换行（只动空白/换行；编号、时间、来源不变） ----

function readWrapWidth() {
  const v = Number($('#wrapWidth').value);
  return Number.isInteger(v) && v >= 4 && v <= 40 ? v : null;
}

/** 依据当前开关/宽度设置，对所有输出字幕执行排版并刷新结果视图。 */
function applyWrap() {
  if (!lastData) return;
  const width = readWrapWidth();
  const widthInput = $('#wrapWidth');
  widthInput.classList.toggle('input-invalid', width === null);

  const enabled = $('#wrapEnabled').checked && width !== null;
  let okCount = 0;
  let failCount = 0;

  lastData.mappings.forEach((m) => {
    if (!enabled) {
      m.wrappedText = m.text;
      m.wrap = null;
      return;
    }
    const r = window.Wrap.wrapCueText(m.text, width);
    m.wrappedText = r.text;
    m.wrap = r;
    if (r.ok) okCount += 1;
    else failCount += 1;
  });

  $('#wrapWidthHead').textContent = width === null ? '—' : String(width);
  const summary = $('#wrapSummary');
  if (!enabled) {
    summary.innerHTML = '<span class="dim">未启用：下载与展示均为原始排版</span>';
  } else if (failCount === 0) {
    summary.innerHTML = `<span class="wrap-ok">✓ ${okCount} 条全部排版成功（每行上限 ${width}，每条最多 3 行）</span>`;
  } else {
    summary.innerHTML = `<span class="wrap-ok">✓ 成功 ${okCount} 条</span> · `
      + `<span class="wrap-fail">⚠ ${failCount} 条无解，已保留原文（见「排版逐条对照」）</span>`;
  }

  lastSrt = window.Srt.serializeSrt(lastData.mappings.map((m) => ({
    start: m.start,
    end: m.end,
    text: enabled ? m.wrappedText : m.text,
  })));
  $('#srtOutput').textContent = lastSrt;
  $('#rawHint').textContent = enabled
    ? `当前为自动排版后的 SRT（每行宽度上限 ${width}；${failCount} 条无解保留原文），编号与时间未改变。`
    : '当前为原始排版 SRT（自动换行未启用或宽度设置无效）。';

  if (!$('#compareTable').closest('.tab-body').hidden) renderCompareTable();
  // 输出列表若正展示则一并刷新文本列
  if (!$('#outputTable').closest('.tab-body').hidden) renderOutputTable();
  // 双语结果随主文排版即时更新
  if (biData) {
    rebuildBiSrt();
    if (!$('#biPairTable').closest('.tab-body').hidden) renderBilingual();
  }
}

function renderStats(s) {
  $('#stats').innerHTML = `
    <span class="stat stat-total">拼接总时长<b>${fmtNum(s.totalDurationMs)}</b>ms</span>
    <span class="stat">剪辑段<b>${s.segmentCount}</b></span>
    <span class="stat">源字幕<b>${s.sourceCount}</b></span>
    <span class="stat">输出字幕<b>${s.outputCount}</b></span>
    <span class="stat stat-used">已采用源字幕<b>${s.usedCount}</b></span>
    <span class="stat stat-missed">未命中丢弃<b>${s.missedCount}</b></span>
    <span class="stat stat-zero">零长舍弃片段<b>${s.droppedFragmentCount}</b></span>`;
}

function renderSourceTable(rows) {
  const statusMap = {
    used: ['tag-used', '已采用'],
    missed: ['tag-missed', '未命中丢弃'],
    'zero-length': ['tag-zero', '零长舍弃'],
  };
  $('#sourceTable tbody').innerHTML = rows.map((r) => {
    const [cls, label] = statusMap[r.status];
    const refs = r.outputs.length
      ? r.outputs.map((n) => `<span class="out-ref" data-jump="${n}">#${n}</span>`).join('')
      : '<span class="dim">—</span>';
    return `<tr>
      <td class="num">${r.seq}</td>
      <td class="mono">${fmtRange(r.sourceStart, r.sourceEnd)}<br>
        <span class="dim">${fmtNum(r.sourceStart)} → ${fmtNum(r.sourceEnd)} ms</span></td>
      <td><div class="cell-text">${escapeHtml(r.text)}</div></td>
      <td><span class="tag ${cls}">${label}</span></td>
      <td>${refs}</td>
    </tr>`;
  }).join('');
}

function renderOutputTable() {
  $('#outputTable tbody').innerHTML = lastData.mappings.map((m) => `
    <tr id="out-row-${m.newIndex}">
      <td class="num"><b>${m.newIndex}</b></td>
      <td class="mono">${fmtRange(m.start, m.end)}<br>
        <span class="dim">${fmtNum(m.start)} → ${fmtNum(m.end)} ms</span></td>
      <td class="num">${fmtNum(m.end - m.start)}</td>
      <td class="num">源 #${m.seq} / 段 ${m.segOrder + 1}<br>
        <span class="dim">输入第 ${m.segLine} 行</span></td>
      <td><span class="tag tag-speed">${m.speed}×</span></td>
      <td class="mono">${fmtNum(m.intersectStart)} → ${fmtNum(m.intersectEnd)}</td>
      <td><div class="cell-text">${m.wrap && !m.wrap.ok
          ? `<span class="tag tag-warn">无解·原文</span> ${escapeHtml(m.wrappedText)}`
          : escapeHtml(m.wrappedText)}</div></td>
      <td>${corrTagHtml(m.cueIndex)} <button type="button" class="btn btn-ghost corr-jump" data-newindex="${m.newIndex}">勘误</button></td>
    </tr>`).join('');
}

/** 逐条对照：原文 vs 排版结果（含行宽/剩余宽度/无解原因）。 */
function renderCompareTable() {
  if (!lastData) return;
  $('#compareTable tbody').innerHTML = lastData.mappings.map((m) => {
    let resultCell;
    let widthCell;
    if (!m.wrap) {
      resultCell = `<div class="cell-text"><span class="dim">自动换行未启用：</span>${escapeHtml(m.text)}</div>`;
      widthCell = '<span class="dim">—</span>';
    } else if (m.wrap.ok) {
      const linesHtml = m.wrap.lines.map((l) =>
        `<span class="wrap-line">${escapeHtml(l.text)}</span>`).join('<br>');
      resultCell = `<div class="cell-text wrap-box">${linesHtml}</div>`;
      widthCell = m.wrap.lines.map((l, idx) =>
        `<div class="wrap-meter" title="第 ${idx + 1} 行：宽度 ${l.width} / 上限 ${m.wrap.width}，剩余 ${l.remain}">`
        + `<span class="mono dim">${l.width}</span>`
        + `<span class="meter"><span class="meter-fill" style="width:${Math.min(100, l.width / m.wrap.width * 100)}%"></span></span>`
        + `<span class="mono dim">余 ${l.remain}</span></div>`).join('');
    } else {
      resultCell = `<div><span class="tag tag-warn">无解·保留原文</span></div>`
        + `<div class="cell-text wrap-box wrap-box-fail">${escapeHtml(m.text)}</div>`
        + `<div class="wrap-reason">原因：${escapeHtml(m.wrap.reason)}</div>`;
      widthCell = '<span class="dim">—</span>';
    }
    return `<tr>
      <td class="num"><b>${m.newIndex}</b></td>
      <td class="mono">${fmtRange(m.start, m.end)}</td>
      <td><div class="cell-text wrap-box wrap-box-old">${escapeHtml(m.text)}</div></td>
      <td>${resultCell}</td>
      <td class="wrap-width-cell">${widthCell}</td>
    </tr>`;
  }).join('');
}

function renderTimelineTable(timeline, stats) {
  $('#timelineTable tbody').innerHTML = timeline.map((t) => `
    <tr>
      <td class="num"><b>${t.order + 1}</b></td>
      <td class="num dim">${t.line}</td>
      <td class="num">${fmtNum(t.sourceStart)}</td>
      <td class="num">${fmtNum(t.sourceEnd)}</td>
      <td><span class="tag tag-speed">${t.speed}×</span></td>
      <td class="num">${fmtNum(t.outStart)}</td>
      <td class="num">${fmtNum(t.outEnd)}</td>
      <td class="num">${t.durationExactMs % 1 === 0 ? fmtNum(t.durationExactMs) : t.durationExactMs.toFixed(1)}</td>
    </tr>`).join('');
  $('#totalLine').textContent =
    `拼接总时长（精确累计）：${stats.totalDurationExactMs} ms；输出边界四舍五入后：${fmtNum(stats.totalDurationMs)} ms`;
}

function renderDropped(dropped) {
  const wrap = $('#droppedWrap');
  if (!dropped.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  $('#droppedCount').textContent = dropped.length;
  $('#droppedTable tbody').innerHTML = dropped.map((d) => `
    <tr>
      <td class="num">#${d.seq}</td>
      <td class="num">段 ${d.segOrder + 1}（输入第 ${d.segLine} 行）</td>
      <td><span class="tag tag-speed">${d.speed}×</span></td>
      <td class="mono">${fmtNum(d.intersectStart)} → ${fmtNum(d.intersectEnd)}</td>
      <td class="mono">${d.exactStartMs} → ${d.exactEndMs}</td>
      <td>${escapeHtml(d.reason)}</td>
    </tr>`).join('');
}

function downloadSrt() {
  if (!lastSrt) return;
  const blob = new Blob([lastSrt], { type: 'application/x-subrip;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'output.srt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function copySrt() {
  if (!lastSrt) return;
  const btn = $('#copyBtn');
  try {
    await navigator.clipboard.writeText(lastSrt);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = lastSrt;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const old = btn.textContent;
  btn.textContent = '✓ 已复制';
  setTimeout(() => { btn.textContent = old; }, 1500);
}

function downloadBiSrt() {
  if (!biSrt) return;
  const blob = new Blob([biSrt], { type: 'application/x-subrip;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'output-bilingual.srt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function copyBiSrt() {
  if (!biSrt) return;
  const btn = $('#biCopyBtn');
  try {
    await navigator.clipboard.writeText(biSrt);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = biSrt;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const old = btn.textContent;
  btn.textContent = '✓ 已复制';
  setTimeout(() => { btn.textContent = old; }, 1500);
}

// ---- 事件绑定 ----
$('#runBtn').addEventListener('click', run);
$('#clearBtn').addEventListener('click', () => {
  $('#srtInput').value = '';
  $('#segInput').value = '';
  $('#resultPanel').hidden = true;
  lastData = null;
  lastSrt = '';
  lastSegments = '';
  hideErrors();
  resetCorrections();
  invalidateVoiceCheck();
  resetAvoid();
  resetPlanCompare();
  resetSync();
  resetSpeakers();
  resetReadAudit('页面已清空。');
});
$('#loadSampleBtn').addEventListener('click', () => {
  $('#srtInput').value = SAMPLE_SRT;
  $('#segInput').value = SAMPLE_SEG;
});
$('#downloadBtn').addEventListener('click', downloadSrt);
$('#copyBtn').addEventListener('click', copySrt);
$('#biPairBtn').addEventListener('click', runPair);
$('#biClearBtn').addEventListener('click', () => {
  $('#transInput').value = '';
  resetBilingual();
});
$('#vcRunBtn').addEventListener('click', runVoiceCheck);
$('#vcCancelBtn').addEventListener('click', () => {
  // 取消：终止 Worker，立即允许重试
  if (vcRunner.cancel()) {
    const ph = $('#vcPlaceholder');
    ph.hidden = false;
    ph.textContent = '已取消核对，可重新点击「核对口播稿」。';
  }
});
$('#vcClearBtn').addEventListener('click', () => {
  $('#voiceInput').value = '';
  invalidateVoiceCheck();
});
// 编辑稿件：旧任务与旧报告立即失效（无任务/报告/提示时不动界面）
$('#voiceInput').addEventListener('input', () => {
  if (vcRunner.isRunning() || vcData || !$('#vcErrorBox').hidden) {
    invalidateVoiceCheck('稿件已修改，请重新点击「核对口播稿」。');
  }
});
$('#biDownloadBtn').addEventListener('click', downloadBiSrt);
$('#biCopyBtn').addEventListener('click', copyBiSrt);
$('#corrDownloadBtn').addEventListener('click', downloadCorrSrt);
$('#corrCopyBtn').addEventListener('click', copyCorrSrt);

// 勘误相关操作（表格随状态重渲染，统一事件委托）
document.addEventListener('click', (e) => {
  const edit = e.target.closest('.corr-edit');
  if (edit) { openCorrEditor(Number(edit.dataset.newindex)); return; }
  if (e.target.closest('#corrSubmitBtn')) { submitCorr(); return; }
  if (e.target.closest('#corrCancelBtn')) {
    corrEditorFor = null;
    corrDraft = null;
    renderCorrTable();
    return;
  }
  const resolve = e.target.closest('.corr-resolve');
  if (resolve) { resolveCorr(Number(resolve.dataset.cue), Number(resolve.dataset.cand)); return; }
  const revert = e.target.closest('.corr-revert');
  if (revert) { revertCorr(Number(revert.dataset.cue)); return; }
  // 输出列表「勘误」按钮：跳到勘误标签页并打开该条目的编辑器
  const jump = e.target.closest('.corr-jump');
  if (jump) {
    const n = Number(jump.dataset.newindex);
    $$('.tab').find((t) => t.dataset.tab === 'correct').click();
    corrEditorFor = n;
    corrDraft = null;
    renderCorrTable();
    const row = $(`#corr-row-${n}`);
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.style.background = 'rgba(163,113,247,.22)';
      setTimeout(() => { row.style.background = ''; }, 1600);
    }
    const ta = $('#corrEditorText');
    if (ta) ta.focus();
  }
});

// 勘误编辑器草稿：表格重渲染（如切换标签页）时保留未提交内容
document.addEventListener('input', (e) => {
  if (e.target.id === 'corrEditorText' && corrEditorFor !== null) {
    corrDraft = { newIndex: corrEditorFor, text: e.target.value };
  }
});

// 编辑器内 Ctrl/⌘+Enter 提交修订；捕获阶段拦截，避免触发全局「重新生成」清空勘误状态
document.addEventListener('keydown', (e) => {
  if (e.target && e.target.id === 'corrEditorText' && (e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    submitCorr();
  }
}, true);

// 自动换行设置变化即重算（无需重新请求后端）
$('#wrapEnabled').addEventListener('change', applyWrap);
$('#wrapWidth').addEventListener('input', applyWrap);

// 避让参数变化即重算（纯浏览器内计算）
$('#avoidGap').addEventListener('input', applyAvoid);
$('#avoidShift').addEventListener('input', applyAvoid);
$('#avoidDownloadBtn').addEventListener('click', downloadAvoidSrt);
$('#avoidCopyBtn').addEventListener('click', copyAvoidSrt);

// 阅读时窗审计：速度变化即重算（纯浏览器内计算；不改动字幕，无独立下载）
$('#raSpeed').addEventListener('input', applyReadAudit);

// 成片同步校准：提交/清空；修改锚点或重新生成主结果后旧校准立即失效
$('#syncRunBtn').addEventListener('click', runSync);
$('#syncClearBtn').addEventListener('click', () => {
  $('#syncAnchorInput').value = '';
  resetSync('尚未校准：在上方「成片同步校准」工具条输入同步锚点并点击「应用校准」。');
});
$('#syncAnchorInput').addEventListener('input', () => {
  if (syncData || !$('#syncErrorBox').hidden) {
    resetSync('锚点已修改，请重新点击「应用校准」。');
  }
});
$('#syncDownloadBtn').addEventListener('click', downloadSyncSrt);
$('#syncCopyBtn').addEventListener('click', copySyncSrt);

// 剪辑方案对照：提交/清空；修改源 SRT、主剪辑段（方案 A）或方案 B 时旧对照立即失效
$('#pcRunBtn').addEventListener('click', runPlanCompare);
$('#pcClearBtn').addEventListener('click', () => {
  $('#planBInput').value = '';
  resetPlanCompare('尚未对照：在上方「剪辑方案对照」工具条输入方案 B 的剪辑段并点击「对照方案」。');
});
$('#srtInput').addEventListener('input', () => {
  if (pcData || !$('#pcErrorBox').hidden) {
    resetPlanCompare('源 SRT 已修改，旧对照已失效；请重新生成主结果后再对照。');
  }
});
$('#segInput').addEventListener('input', () => {
  if (pcData || !$('#pcErrorBox').hidden) {
    resetPlanCompare('剪辑段（方案 A）已修改，旧对照已失效；请重新生成主结果后再对照。');
  }
});
$('#planBInput').addEventListener('input', () => {
  if (pcData || !$('#pcErrorBox').hidden) {
    resetPlanCompare('方案 B 已修改，请重新点击「对照方案」。');
  }
});

// 说话人标注：提交/清空；修改标注或重新生成主结果后旧归属、裁决与标注版导出立即失效
$('#spkRunBtn').addEventListener('click', runSpeakers);
$('#spkClearBtn').addEventListener('click', () => {
  $('#spkInput').value = '';
  resetSpeakers('尚未标注：在上方「说话人标注」工具条输入标注时段并点击「应用标注」。');
});
$('#spkInput').addEventListener('input', () => {
  if (spkData || !$('#spkErrorBox').hidden) {
    resetSpeakers('标注已修改，请重新点击「应用标注」。');
  }
});
$('#spkDownloadBtn').addEventListener('click', downloadSpkSrt);
$('#spkCopyBtn').addEventListener('click', copySpkSrt);
// 并列裁决：逐条选定候选说话人（可改选），全部裁决后自动解除导出禁用
document.addEventListener('click', (e) => {
  const pick = e.target.closest('.spk-pick');
  if (!pick || !spkData) return;
  spkChoices.set(Number(pick.dataset.newindex), pick.dataset.speaker);
  renderSpeakers();
});
// 汇总表「N 个区间」按钮：跳到对应源字幕的差异区间明细并高亮
document.addEventListener('click', (e) => {
  const jump = e.target.closest('.pc-jump');
  if (!jump) return;
  const el = $(`#pc-detail-${jump.dataset.cue}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.background = 'rgba(163,113,247,.22)';
    setTimeout(() => { el.style.background = ''; }, 1600);
  }
});

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    const name = tab.dataset.tab;
    $$('.tab-body').forEach((b) => { b.hidden = b.dataset.body !== name; });
    if (name === 'compare') renderCompareTable();
    if (name === 'readaudit') renderReadAudit();
    if (name === 'avoid') renderAvoidTable();
    if (name === 'sync') renderSync();
    if (name === 'speaker') renderSpeakers();
    if (name === 'bilingual') renderBilingual();
    if (name === 'voicecheck') renderVoiceCheck();
    if (name === 'correct') renderCorrections();
    if (name === 'output') renderOutputTable();
  });
});

// 点击 #编号 跳到输出字幕列表并高亮
document.addEventListener('click', (e) => {
  const ref = e.target.closest('.out-ref');
  if (!ref) return;
  const n = ref.dataset.jump;
  $$('.tab').find((t) => t.dataset.tab === 'output').click();
  const row = $(`#out-row-${n}`);
  if (row) {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.style.background = 'rgba(163,113,247,.22)';
    setTimeout(() => { row.style.background = ''; }, 1600);
  }
});

// Ctrl/Cmd+Enter 快捷生成
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run();
});
