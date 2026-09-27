'use strict';

/**
 * 成片口播稿核对的 Web Worker 生命周期管理（双端通用，不依赖 DOM）。
 *
 * 职责（词元化/匹配/差异提取本身在 Worker 内复用 src/voicecheck.js 完成）：
 *   - 每页最多运行一个核对任务：submit 会先终止旧任务再启动新任务；
 *   - 提交时由调用方固定稿件与当前未排版字幕的快照，随 run 消息发出；
 *   - cancel() 终止（terminate）Worker 并立即允许重试；
 *   - invalidate() 作废旧任务（再次提交/编辑稿件/重新生成主结果/清空页面时调用）；
 *   - 旧任务迟到的成功或错误消息一律忽略，不改变当前状态
 *     （释放时摘除回调，且消息回调内再校验任务身份）；
 *   - 完成、取消或异常后释放 Worker；
 *   - Worker 加载或运行失败经 onError 提示并恢复操作，绝不退回主线程计算。
 *
 * 回调（均可选）：
 *   onBusy()           新任务已发出，进入计算中
 *   onSettled()        任务结束（完成/取消/异常/被取代），界面恢复可操作
 *   onReport(report)   当前任务的成功报告（含 ok:false 的校验失败结果，由界面解释）
 *   onError(message)   Worker 加载/运行/收发消息失败
 */
function createVoiceCheckRunner(options) {
  const opts = options || {};
  const createWorker = opts.createWorker;
  const onBusy = opts.onBusy || function () {};
  const onSettled = opts.onSettled || function () {};
  const onReport = opts.onReport || function () {};
  const onError = opts.onError || function () {};

  let task = null; // { id, worker }，仅当核对任务在途时非空
  let nextId = 0;

  /** 释放任务占用的 Worker：摘除回调（迟到消息不再进入）并 terminate。 */
  function release(t) {
    const w = t.worker;
    t.worker = null;
    if (!w) return;
    w.onmessage = null;
    w.onerror = null;
    try {
      w.terminate();
    } catch (_e) {
      // terminate 本身异常不影响状态恢复
    }
  }

  /** 结束当前在途任务（若有）并释放 Worker；返回是否有任务被结束。 */
  function settle() {
    if (!task) return false;
    release(task);
    task = null;
    return true;
  }

  /** 消息/错误是否属于当前在途任务（旧任务迟到的一律忽略）。 */
  function isCurrent(t) {
    return task === t;
  }

  function submit(snapshot) {
    // 再次提交：旧任务立即失效（终止其 Worker），保证每页最多一个在途任务
    settle();
    const t = { id: ++nextId, worker: null };
    let worker;
    try {
      worker = createWorker();
    } catch (e) {
      // Worker 无法创建（如浏览器禁用）：提示并恢复，不退回主线程计算
      onSettled();
      onError(`无法启动核对计算线程（Web Worker）：${e && e.message ? e.message : e}`);
      return false;
    }
    t.worker = worker;
    task = t;

    worker.onmessage = (e) => {
      if (!isCurrent(t)) return; // 旧任务迟到的成功/失败消息：忽略
      settle();
      onSettled();
      const data = (e && e.data) || {};
      if (data.type === 'result') {
        onReport(data.report);
      } else {
        onError(`核对计算失败：${data && data.message ? data.message : '未知错误'}`);
      }
    };
    worker.onerror = (e) => {
      if (!isCurrent(t)) return; // 旧任务迟到的错误：忽略
      settle();
      onSettled();
      const msg = e && e.message ? e.message : 'Worker 脚本加载或运行异常';
      onError(`核对计算线程异常：${msg}`);
    };

    try {
      worker.postMessage({
        type: 'run',
        taskId: t.id,
        script: snapshot.script,
        mappings: snapshot.mappings,
      });
    } catch (e) {
      settle();
      onSettled();
      onError(`核对任务发送失败：${e && e.message ? e.message : e}`);
      return false;
    }
    onBusy();
    return true;
  }

  /** 取消当前任务：终止 Worker，立即允许重试；无在途任务时为 no-op。 */
  function cancel() {
    if (!settle()) return false;
    onSettled();
    return true;
  }

  /** 作废旧任务（编辑稿件/重新生成主结果/清空页面）；无在途任务时为 no-op。 */
  function invalidate() {
    if (!settle()) return false;
    onSettled();
    return true;
  }

  return {
    submit,
    cancel,
    invalidate,
    /** 是否有核对任务正在计算。 */
    isRunning() { return task !== null; },
  };
}

const vcRunnerApi = { createVoiceCheckRunner };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = vcRunnerApi;
}
const vcRunnerGlobal = typeof window !== 'undefined'
  ? window
  : (typeof self !== 'undefined' ? self : undefined);
if (vcRunnerGlobal) {
  vcRunnerGlobal.VcRunner = vcRunnerApi;
}
