'use strict';

/**
 * 阅读时窗审计。
 *
 * 以当前**未排版输出字幕**为输入，把“读完一条字幕”视为可暂停、可继续的
 * 单人任务：
 *   - 阅读量按**字素簇**计：ASCII 字素簇计 1，其他字素簇（汉字、全角标点、
 *     emoji 及 ZWJ 组合）计 2，**空白不计**（以 Intl.Segmenter 字素簇切分，
 *     与 src/wrap.js 的计宽规则一致）；
 *   - 用户设置每秒可读 1～40 单位的**整数速度**；
 *   - 每条字幕只能在其**半开显示区间** [start, end) 内阅读（端点相接不算重叠）；
 *   - 阅读可暂停/继续，但同一时刻总速度不超过设定值（单读者，不并行）。
 *
 * 分配规则：**最早截止时间优先（EDF）**——任意时刻把全部阅读速度分配给
 * “当前可见（start ≤ t）且未读完”中截止时间最早的一条；截止时间相同时
 * 按**输出编号**升序。被更早截止的字幕抢占时，本任务自动暂停（已读量保留），
 * 之后可继续。
 *
 * 精度：阅读量以**千分之一阅读单位（毫单位）的整数**记录
 * （需求 = 计权簇数 ×1000）。读完时刻可以是分数毫秒（例如速度 9、需求
 * 2000 毫单位需 2000/9 ms），故时间点与时长内部一律用**BigInt 有理数
 * （分子/分母，最简分数）**表示；区间容量 speed × Δt 以分数对消后仍为整数
 * 毫单位，**全程无浮点误差、不逐毫秒取整**。到截止仍未读完的余量记为
 * **欠量**并随任务移除。
 *
 * 纯逻辑，Node/浏览器双端通用，不请求后端；不改动任何字幕。
 */

const MIN_SPEED = 1;
const MAX_SPEED = 40;
const MILLI = 1000; // 1 阅读单位 = 1000 毫单位（整数精度）

// 注：浏览器端与 src/wrap.js 等同页加载，顶层 const 共享全局词法环境，
// 故内部字素簇切分器使用模块专属命名，避免跨脚本重复声明冲突。
const raSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** 按字素簇切分字符串（与 src/wrap.js 一致）。 */
function graphemes(s) {
  return Array.from(raSegmenter.segment(String(s ?? '')), (x) => x.segment);
}

/** 单个字素簇是否计为阅读量：空白（\s，含空格/制表/换行/NBSP）不计。 */
function isWhitespaceCluster(g) {
  return /^\s+$/u.test(g);
}

/**
 * 一条文本的阅读需求量（整数阅读单位）。
 * ASCII 字素簇（单字符且码点 < 128）计 1，其他字素簇计 2，空白不计。
 */
function readingDemand(text) {
  let demand = 0;
  for (const g of graphemes(text)) {
    if (isWhitespaceCluster(g)) continue;
    demand += g.length === 1 && g.charCodeAt(0) < 128 ? 1 : 2;
  }
  return demand;
}

/** 校验阅读速度：须为 1～40 的整数（number 类型；字符串不接受）。 */
function isValidSpeed(speed) {
  return typeof speed === 'number'
    && Number.isInteger(speed)
    && speed >= MIN_SPEED
    && speed <= MAX_SPEED;
}

// ---- BigInt 有理数（毫秒）；始终保持最简分数、分母为正 ----

function gcdBig(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const r = x % y;
    x = y;
    y = r;
  }
  return x === 0n ? 1n : x;
}
/** 整数毫秒 -> 有理数。 */
function ratOf(intMs) {
  return { n: BigInt(Math.trunc(intMs)), d: 1n };
}
/** a + k/speed（推进读完 k 毫单位所需的毫秒数）。 */
function ratAddKSpeed(a, k, speed) {
  const sp = BigInt(speed);
  const n = a.n * sp + BigInt(k) * a.d;
  const d = a.d * sp;
  const g = gcdBig(n, d);
  return { n: n / g, d: d / g };
}
/** 有理数比较：-1 / 0 / 1。 */
function ratCmp(a, b) {
  const lhs = a.n * b.d;
  const rhs = b.n * a.d;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}
/** 区间 [a,b) 在 speed 下的整数毫单位容量（b≥a；结果恒为非负整数）。 */
function capacityMilli(a, b, speed) {
  const num = (b.n * a.d - a.n * b.d) * BigInt(speed);
  const den = a.d * b.d;
  return Number(num / den); // 必然整除：事件边界来自整数毫秒或 speed 分母的读完点
}

/**
 * 对未排版输出字幕执行阅读时窗审计（EDF 事件扫描，BigInt 有理数时间）。
 *
 * @param {Array} mappings remap 输出（按输出顺序，至少含 newIndex/start/end/text；
 *        时间为整数毫秒，区间半开 [start,end)）
 * @param {number} speed 每秒可读单位数（1～40 整数）
 * @returns {{ok:true, speed:number, items:Array, totalDemandMilli:number,
 *            totalReadMilli:number, totalShortfallMilli:number,
 *            firstMissMs:number|null, missNewIndexes:number[],
 *            cueCount:number, readMs:number, idleMs:number, horizonMs:number}}
 *   item: {newIndex,start,end,durationMs,demandMilli,readMilli,shortfallMilli,
 *          completed:boolean, firstMiss:boolean}
 * @throws 当 speed 不是 1～40 的整数、或存在非正时长/非整数边界的字幕时
 */
function auditReading(mappings, speed) {
  if (!isValidSpeed(speed)) {
    throw new Error(`阅读速度必须是 ${MIN_SPEED}～${MAX_SPEED} 之间的整数（单位/秒），实际为 ${speed}`);
  }
  const list = Array.isArray(mappings) ? mappings : [];

  // 每毫秒可读取的毫单位数：speed 单位/秒 = speed 毫单位/毫秒
  // （1s = 1000ms，1 单位 = 1000 毫单位，两个 1000 对消）。
  const capPerMs = speed;

  // 构造任务（需求放大到整数毫单位），并校验时间区间
  const jobs = list.map((m) => {
    const start = Number(m.start);
    const end = Number(m.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) {
      throw new Error(
        `输出 #${m.newIndex} 的显示区间无效（须为整数毫秒且终点晚于起点）：[${start}, ${end})`,
      );
    }
    return {
      newIndex: m.newIndex,
      start,
      end,
      remaining: readingDemand(m.text) * MILLI,
      read: 0,
    };
  });

  // EDF 选择键：截止时间升序，相同按输出编号升序
  const pickJob = (active) => {
    let best = null;
    for (const j of active) {
      if (j.remaining <= 0) continue;
      if (!best
        || j.end < best.end
        || (j.end === best.end && j.newIndex < best.newIndex)) {
        best = j;
      }
    }
    return best;
  };

  // 外部事件（起点/截止）都是整数毫秒，用有序时刻数组 + 游标；读完事件可为
  // 分数毫秒，在统一事件点循环中即时产生。
  const startMs = jobs.map((j) => j.start).sort((a, b) => a - b);
  const endMs = jobs.map((j) => j.end).sort((a, b) => a - b);
  const startByT = new Map();
  const endByT = new Map();
  for (const j of jobs) {
    if (!startByT.has(j.start)) startByT.set(j.start, []);
    startByT.get(j.start).push(j);
    if (!endByT.has(j.end)) endByT.set(j.end, []);
    endByT.get(j.end).push(j);
  }

  const active = new Set(); // 已到达起点、尚未到截止点的未读完任务
  let si = 0; // 下一个待处理起点在 startMs 的游标
  let ei = 0; // 下一个待处理截止点在 endMs 的游标
  let t = ratOf(0);
  const readTime = ratOf(0); // 累计满速阅读时长（有理数累加器）
  const idleTime = ratOf(0); // 累计空闲时长（无可见未读任务；可为分数毫秒）

  /** 把有理数 b 累加到可变累加器 a（保持最简分数）。 */
  const addRat = (a, b) => {
    const n = a.n * b.d + b.n * a.d;
    const d = a.d * b.d;
    const g = gcdBig(n, d);
    a.n = n / g;
    a.d = d / g;
  };
  /** b − a（毫秒有理数）。 */
  const ratDiff = (a, b) => ({ n: b.n * a.d - a.n * b.d, d: a.d * b.d });

  // 在整数时刻 xMs 结算外部事件：先纳入起点到达，再移除半开到期（end ≤ x）。
  // 到期优先于到达——端点相接 [..,x) 与 [x,..) 不重叠，旧任务在 x 已不可读。
  // 零需求（纯空白/空文本）任务到达即视为读完，不进入活动集。
  const settleAt = (xMs) => {
    while (si < startMs.length && startMs[si] <= xMs) {
      for (const j of startByT.get(startMs[si]) || []) {
        if (j.remaining > 0) active.add(j);
      }
      si += 1;
    }
    while (ei < endMs.length && endMs[ei] <= xMs) {
      for (const j of endByT.get(endMs[ei]) || []) active.delete(j); // 到期移除（含欠量）
      ei += 1;
    }
  };

  if (startMs.length) {
    t = ratOf(startMs[0]);
    settleAt(startMs[0]);
  }
  while (active.size > 0 || si < startMs.length) {
    if (active.size === 0) {
      // 无任何可见未读任务：空闲到下一个起点（起点为整数毫秒）
      const x = startMs[si];
      addRat(idleTime, ratDiff(t, ratOf(x)));
      t = ratOf(x);
      settleAt(x);
      continue;
    }
    const job = pickJob(active);
    // 最近的未来外部事件（游标已处理 ≤ t 的事件）：起点（新任务可能更早
    // 截止，需抢占）或截止点；分数读完时刻不推进游标。
    const nextStart = si < startMs.length ? startMs[si] : Infinity;
    const nextEnd = ei < endMs.length ? endMs[ei] : Infinity;
    const nextEvent = Math.min(nextStart, nextEnd);
    // 当前任务读完时刻（有理数毫秒）与下一个整数外部事件点比较
    const finishAt = ratAddKSpeed(t, job.remaining, capPerMs);
    const nextRat = ratOf(nextEvent);
    const c = ratCmp(finishAt, nextRat);

    let x;
    if (c <= 0) {
      // 读完先发生（含恰好同时）：在 [t, finishAt) 满速读这一条（amount =
      // speed × Δt = remaining，整数毫单位），读完即移出活动集；finishAt 处
      // 重新裁决，容量立即转给下一条（可暂停/继续）或空闲。
      addRat(readTime, ratDiff(t, finishAt));
      job.read += job.remaining;
      job.remaining = 0;
      active.delete(job);
      x = finishAt;
    } else {
      // 外部事件先发生：在 [t, nextEvent) 满速读当前任务；区间容量为整数
      // 毫单位（t 的分母恒整除 speed：所有非整数 t 都是某个 speed 分母的读完点）。
      // 事件点重新裁决（可能被更早截止者抢占，本任务暂停）。
      const amount = capacityMilli(t, nextRat, capPerMs);
      job.read += amount;
      job.remaining -= amount;
      addRat(readTime, ratDiff(t, nextRat));
      x = nextRat;
    }
    t = x;
    if (x.d === 1n) settleAt(Number(x.n)); // 只有整数时刻才可能有外部事件
  }

  // 汇总（按输出编号升序）
  const items = jobs.map((j) => {
    const demandMilli = j.read + j.remaining;
    const shortfallMilli = j.remaining; // 到截止未完成：欠量随任务移除
    return {
      newIndex: j.newIndex,
      start: j.start,
      end: j.end,
      durationMs: j.end - j.start,
      demandMilli,
      readMilli: j.read,
      shortfallMilli,
      completed: shortfallMilli === 0,
      firstMiss: false,
    };
  }).sort((a, b) => a.newIndex - b.newIndex);

  // 最早失约时刻：欠量字幕中最早的截止时刻（半开区间终点；同刻按输出编号）
  const missItems = items.filter((it) => it.shortfallMilli > 0)
    .sort((a, b) => (a.end - b.end) || (a.newIndex - b.newIndex));
  const firstMissMs = missItems.length ? missItems[0].end : null;
  for (const it of missItems) {
    if (it.end === firstMissMs) it.firstMiss = true;
  }

  const totalDemandMilli = items.reduce((s, it) => s + it.demandMilli, 0);
  const totalReadMilli = items.reduce((s, it) => s + it.readMilli, 0);
  const totalShortfallMilli = items.reduce((s, it) => s + it.shortfallMilli, 0);
  const horizonMs = jobs.length
    ? Math.max(...jobs.map((j) => j.end)) - Math.min(...jobs.map((j) => j.start))
    : 0;

  return {
    ok: true,
    speed: Number(speed),
    items,
    totalDemandMilli,
    totalReadMilli,
    totalShortfallMilli,
    firstMissMs,
    missNewIndexes: missItems.map((it) => it.newIndex),
    cueCount: items.length,
    readMs: Number(readTime.n) / Number(readTime.d),
    idleMs: Number(idleTime.n) / Number(idleTime.d),
    horizonMs,
  };
}

/** 毫单位（千分之一阅读单位）格式化为三位小数文本（不做进一步取整）。 */
function formatMilli(milli) {
  const n = Number(milli);
  const whole = Math.floor(n / MILLI);
  const frac = String(n % MILLI).padStart(3, '0');
  return `${whole}.${frac}`;
}

const readAuditApi = {
  MIN_SPEED,
  MAX_SPEED,
  MILLI,
  graphemes,
  readingDemand,
  isValidSpeed,
  auditReading,
  formatMilli,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = readAuditApi;
}
if (typeof window !== 'undefined') {
  window.ReadAudit = readAuditApi;
}
