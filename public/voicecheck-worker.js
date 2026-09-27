'use strict';

/**
 * 成片口播稿核对 Web Worker。
 *
 * 词元化、保序一对一匹配（LCS）与差异片段提取全部复用 src/voicecheck.js
 * （与 Node 测试、页面主线程共用同一份算法，结果与迁移前一致），
 * 本文件只负责消息收发。每侧 1500 词元上限、跨条目整词归属与定位
 * 均由 verifyScript 内部保证。
 *
 * 接收：{ type:'run', taskId, script, mappings }
 *   script/mappings 为提交时固定的快照（mappings 仅含 newIndex/start/end/text）。
 * 回包：{ type:'result', taskId, report } 或 { type:'error', taskId, message }
 * 取消由主线程 terminate() 实现，本 Worker 无需处理取消消息。
 */

importScripts('/src/voicecheck.js');

self.onmessage = (e) => {
  const data = (e && e.data) || {};
  if (data.type !== 'run') return;
  try {
    const report = self.VoiceCheck.verifyScript(data.script, data.mappings);
    self.postMessage({ type: 'result', taskId: data.taskId, report });
  } catch (err) {
    self.postMessage({
      type: 'error',
      taskId: data.taskId,
      message: err && err.message ? err.message : String(err),
    });
  }
};
