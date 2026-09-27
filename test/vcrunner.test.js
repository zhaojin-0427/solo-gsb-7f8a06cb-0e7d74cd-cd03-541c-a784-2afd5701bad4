'use strict';

/**
 * 成片口播稿核对 Worker 生命周期测试（src/vcrunner.js）。
 *
 * 用 FakeWorker 完全控制消息投递顺序：可模拟「旧任务迟到的成功/错误消息」
 * 「取消后再投递」「Worker 加载失败」等时序，验证状态机行为；
 * 并用同一份 src/voicecheck.js 算法验证经 Worker 边界（结构化克隆）的
 * 核对结果与迁移前（主线程直接调用 verifyScript）完全一致。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const VC = require('../src/voicecheck');
const { createVoiceCheckRunner } = require('../src/vcrunner');

/** 可控制消息顺序的假 Worker：消息投递/错误触发全部由测试显式执行。 */
class FakeWorker {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
    this.sent = [];
    FakeWorker.instances.push(this);
  }
  postMessage(msg) {
    if (this.terminated) return; // 浏览器行为：已终止的 Worker 静默丢弃
    this.sent.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
  /** 投递一条消息（若回调仍在）。 */
  deliver(data) {
    if (this.onmessage) this.onmessage({ data });
  }
  /** 触发 error 事件（模拟 Worker 脚本加载/运行失败）。 */
  fail(event) {
    if (this.onerror) this.onerror(event || { message: 'worker error' });
  }
  /** 用同一算法计算最后收到的 run 消息并回包（经结构化克隆，等同真实线程边界）。 */
  respondByComputing() {
    const msg = this.sent[this.sent.length - 1];
    const report = VC.verifyScript(
      structuredClone(msg.script),
      structuredClone(msg.mappings),
    );
    this.deliver({ type: 'result', taskId: msg.taskId, report: structuredClone(report) });
  }
}
FakeWorker.instances = [];

function mapping(newIndex, start, end, text) {
  return { newIndex, cueIndex: newIndex - 1, seq: newIndex, start, end, text };
}

/** 记录事件序列的回调组。 */
function recorder() {
  const events = [];
  return {
    events,
    onBusy: () => events.push({ type: 'busy' }),
    onSettled: () => events.push({ type: 'settled' }),
    onReport: (report) => events.push({ type: 'report', report }),
    onError: (message) => events.push({ type: 'error', message }),
  };
}

function setup(extra) {
  FakeWorker.instances = [];
  const rec = recorder();
  const runner = createVoiceCheckRunner({
    createWorker: () => new FakeWorker(),
    ...rec,
    ...extra,
  });
  return { runner, rec, workers: FakeWorker.instances };
}

const SAMPLE_MAPPINGS = [
  mapping(1, 0, 1000, '他说 hello wo'),
  mapping(2, 1000, 2000, 'rld 你好'),
];

test('提交：进入计算态，快照随 run 消息原样发出（提交时固定）', () => {
  const { runner, rec, workers } = setup();
  const snapshot = { script: '他说 hello world 你好', mappings: SAMPLE_MAPPINGS };
  assert.equal(runner.isRunning(), false);

  const ok = runner.submit(snapshot);
  assert.equal(ok, true);
  assert.equal(runner.isRunning(), true);
  assert.deepEqual(rec.events, [{ type: 'busy' }]);

  assert.equal(workers.length, 1);
  const msg = workers[0].sent[0];
  assert.equal(msg.type, 'run');
  assert.equal(msg.script, snapshot.script);
  assert.deepEqual(msg.mappings, snapshot.mappings);
});

test('完成：事件顺序 busy→settled→report，结果与迁移前直接计算一致，Worker 已释放', () => {
  const { runner, rec, workers } = setup();
  const script = '他说 hello world 你好';
  runner.submit({ script, mappings: SAMPLE_MAPPINGS });

  workers[0].respondByComputing();

  assert.equal(runner.isRunning(), false);
  assert.equal(workers[0].terminated, true); // 完成后释放 Worker
  assert.deepEqual(rec.events.map((e) => e.type), ['busy', 'settled', 'report']);

  // 与迁移前（主线程直接调用 verifyScript）完全一致
  const expected = VC.verifyScript(script, SAMPLE_MAPPINGS);
  assert.deepEqual(rec.events[2].report, expected);
  assert.equal(rec.events[2].report.ok, true);
  assert.equal(rec.events[2].report.matchedCount, 6); // 跨条目整词 hello+world 归属与定位保持
});

test('结果一致性：差异片段定位（含跨条目整词归属）与迁移前逐字段一致', () => {
  const { runner, rec, workers } = setup();
  const maps = [
    mapping(1, 0, 1000, 'a wo'),
    mapping(2, 1000, 2000, 'rld b'),
    mapping(3, 2000, 3000, '多二'),
  ];
  const script = '开头 a b 嗯';
  runner.submit({ script, mappings: maps });
  workers[0].respondByComputing();

  const expected = VC.verifyScript(script, maps);
  const got = rec.events.find((e) => e.type === 'report').report;
  assert.deepEqual(got, expected);
  assert.equal(got.ok, true);
  // 字幕多出片段：跨条目整词 world 完整保留并归属起点条目 1
  assert.deepEqual(
    got.subtitleFragments.map((f) => [f.newIndex, f.text]),
    [[1, 'world'], [3, '多二']],
  );
  // 稿件未匹配片段以前/后相邻已匹配字幕定位
  assert.deepEqual(got.scriptFragments.map((f) => f.text), ['开头', '嗯']);
});

test('结果一致性：每侧 1500 词元上限与空输入校验结果照常送达（ok:false 由界面解释）', () => {
  const { runner, rec, workers } = setup();
  const longScript = '甲'.repeat(VC.MAX_TOKENS + 1);
  runner.submit({ script: longScript, mappings: [mapping(1, 0, 1, '甲')] });
  workers[0].respondByComputing();
  const report = rec.events.find((e) => e.type === 'report').report;
  assert.deepEqual(report, VC.verifyScript(longScript, [mapping(1, 0, 1, '甲')]));
  assert.equal(report.ok, false);
  assert.equal(report.code, 'too-many');
  assert.equal(report.side, 'script');
  assert.equal(report.count, VC.MAX_TOKENS + 1);
});

test('再次提交：旧任务立即终止，每页最多一个在途任务，仅新任务结果生效', () => {
  const { runner, rec, workers } = setup();
  runner.submit({ script: '你好', mappings: SAMPLE_MAPPINGS });
  const staleHandler = workers[0].onmessage; // 捕获旧任务回调，模拟迟到消息
  runner.submit({ script: '他说 hello world 你好', mappings: SAMPLE_MAPPINGS });

  assert.equal(workers.length, 2);
  assert.equal(workers[0].terminated, true); // 旧任务被终止
  assert.equal(workers[1].terminated, false);
  assert.equal(runner.isRunning(), true);
  assert.deepEqual(rec.events.map((e) => e.type), ['busy', 'busy']); // 取代旧任务时不闪动状态

  // 旧任务迟到的成功消息：不得改变当前状态
  staleHandler({ data: { type: 'result', taskId: 1, report: { ok: true, fake: true } } });
  assert.equal(rec.events.filter((e) => e.type === 'report').length, 0);
  assert.equal(runner.isRunning(), true);

  // 新任务正常完成
  workers[1].respondByComputing();
  assert.deepEqual(rec.events.map((e) => e.type), ['busy', 'busy', 'settled', 'report']);
  const report = rec.events[3].report;
  assert.deepEqual(report, VC.verifyScript('他说 hello world 你好', SAMPLE_MAPPINGS));
});

test('旧任务迟到的错误消息被忽略，不改变当前状态', () => {
  const { runner, rec, workers } = setup();
  runner.submit({ script: '你好', mappings: SAMPLE_MAPPINGS });
  const staleOnMessage = workers[0].onmessage;
  const staleOnError = workers[0].onerror;
  runner.submit({ script: '世界', mappings: SAMPLE_MAPPINGS });

  staleOnMessage({ data: { type: 'error', taskId: 1, message: '旧任务失败' } });
  staleOnError({ message: '旧 Worker 异常' });
  assert.equal(rec.events.filter((e) => e.type === 'error').length, 0);
  assert.equal(runner.isRunning(), true);

  workers[1].respondByComputing();
  assert.deepEqual(rec.events.map((e) => e.type), ['busy', 'busy', 'settled', 'report']);
});

test('取消：终止 Worker、恢复操作并立即允许重试；取消后迟到的消息被忽略', () => {
  const { runner, rec, workers } = setup();
  runner.submit({ script: '你好', mappings: SAMPLE_MAPPINGS });
  const staleHandler = workers[0].onmessage;

  assert.equal(runner.cancel(), true);
  assert.equal(runner.isRunning(), false);
  assert.equal(workers[0].terminated, true); // 取消须终止 Worker
  assert.deepEqual(rec.events.map((e) => e.type), ['busy', 'settled']);

  // 取消后旧任务迟到的成功/错误消息均不得改变状态
  staleHandler({ data: { type: 'result', taskId: 1, report: { ok: true } } });
  assert.deepEqual(rec.events.map((e) => e.type), ['busy', 'settled']);

  // 立即允许重试
  assert.equal(runner.submit({ script: '他说 hello world 你好', mappings: SAMPLE_MAPPINGS }), true);
  assert.equal(runner.isRunning(), true);
  workers[1].respondByComputing();
  assert.deepEqual(rec.events.map((e) => e.type), ['busy', 'settled', 'busy', 'settled', 'report']);
  assert.equal(workers[1].terminated, true);
});

test('无在途任务时取消/作废为 no-op，不触发任何事件', () => {
  const { runner, rec } = setup();
  assert.equal(runner.cancel(), false);
  assert.equal(runner.invalidate(), false);
  assert.deepEqual(rec.events, []);
});

test('invalidate：作废旧任务并释放 Worker（编辑稿件/重新生成/清空页面）', () => {
  const { runner, rec, workers } = setup();
  runner.submit({ script: '你好', mappings: SAMPLE_MAPPINGS });
  const staleHandler = workers[0].onmessage;

  assert.equal(runner.invalidate(), true);
  assert.equal(runner.isRunning(), false);
  assert.equal(workers[0].terminated, true);
  assert.deepEqual(rec.events.map((e) => e.type), ['busy', 'settled']);

  // 作废后旧任务迟到的消息不得改变状态
  staleHandler({ data: { type: 'result', taskId: 1, report: { ok: true } } });
  staleHandler({ data: { type: 'error', taskId: 1, message: 'x' } });
  assert.deepEqual(rec.events.map((e) => e.type), ['busy', 'settled']);
});

test('Worker 运行中回包 error 消息：提示并恢复操作，Worker 已释放', () => {
  const { runner, rec, workers } = setup();
  runner.submit({ script: '你好', mappings: SAMPLE_MAPPINGS });
  const msg = workers[0].sent[0];
  workers[0].deliver({ type: 'error', taskId: msg.taskId, message: '算法内部异常' });

  assert.equal(runner.isRunning(), false);
  assert.equal(workers[0].terminated, true); // 异常后释放 Worker
  assert.deepEqual(rec.events.map((e) => e.type), ['busy', 'settled', 'error']);
  assert.match(rec.events[2].message, /算法内部异常/);

  // 恢复操作：可立即重新提交
  assert.equal(runner.submit({ script: '你好', mappings: SAMPLE_MAPPINGS }), true);
  assert.equal(runner.isRunning(), true);
});

test('Worker 加载/运行失败（error 事件）：提示并恢复操作，不退回主线程计算', () => {
  const { runner, rec, workers } = setup();
  runner.submit({ script: '你好', mappings: SAMPLE_MAPPINGS });
  workers[0].fail({ message: 'Script error.' });

  assert.equal(runner.isRunning(), false);
  assert.equal(workers[0].terminated, true);
  assert.deepEqual(rec.events.map((e) => e.type), ['busy', 'settled', 'error']);
  assert.match(rec.events[2].message, /Script error\./);
  // 无任何主线程计算结果
  assert.equal(rec.events.filter((e) => e.type === 'report').length, 0);

  // 无 message 的 error 事件也有兜底提示
  runner.submit({ script: '你好', mappings: SAMPLE_MAPPINGS });
  workers[1].fail({});
  assert.equal(rec.events.filter((e) => e.type === 'error').length, 2);
  assert.match(rec.events[rec.events.length - 1].message, /Worker/);
});

test('Worker 创建失败：提示并保持空闲，可重试，不退回主线程计算', () => {
  const rec = recorder();
  const runner = createVoiceCheckRunner({
    createWorker() { throw new Error('Worker is not defined'); },
    ...rec,
  });
  assert.equal(runner.submit({ script: '你好', mappings: [] }), false);
  assert.equal(runner.isRunning(), false);
  assert.deepEqual(rec.events.map((e) => e.type), ['settled', 'error']);
  assert.match(rec.events[1].message, /Worker is not defined/);
  assert.equal(rec.events.filter((e) => e.type === 'report').length, 0);
});

test('postMessage 发送失败：提示、释放 Worker 并恢复操作', () => {
  const rec = recorder();
  const runner = createVoiceCheckRunner({
    createWorker() {
      const w = new FakeWorker();
      w.postMessage = () => { throw new Error('DataCloneError'); };
      return w;
    },
    ...rec,
  });
  assert.equal(runner.submit({ script: '你好', mappings: [] }), false);
  assert.equal(runner.isRunning(), false);
  assert.deepEqual(rec.events.map((e) => e.type), ['settled', 'error']);
  assert.match(rec.events[1].message, /DataCloneError/);
  assert.equal(FakeWorker.instances[FakeWorker.instances.length - 1].terminated, true);
});

test('任务身份按 id 单调递增，旧 id 的消息一律无效', () => {
  const { runner, rec, workers } = setup();
  runner.submit({ script: '一', mappings: SAMPLE_MAPPINGS });
  runner.submit({ script: '二', mappings: SAMPLE_MAPPINGS });
  runner.submit({ script: '三', mappings: SAMPLE_MAPPINGS });
  assert.deepEqual(
    workers.map((w) => w.sent[0].taskId),
    [1, 2, 3],
  );
  assert.deepEqual(
    workers.map((w) => w.terminated),
    [true, true, false],
  );
  // 以旧 id 伪造当前 Worker 回调之外的消息路径不存在；直接验证当前任务完成即可
  workers[2].respondByComputing();
  const report = rec.events.filter((e) => e.type === 'report')[0].report;
  assert.deepEqual(report, VC.verifyScript('三', SAMPLE_MAPPINGS));
});
