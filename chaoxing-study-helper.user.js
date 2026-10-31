// ==UserScript==
// @name         网课助手（超星学习通 / 知到智慧树）安全版
// @namespace    sh.study-helper
// @version      0.5.0
// @description  只做"自动播放 + 分步阅读 + 跳过章节测验"的课程助手：无题库、无 API Key、无任何联网请求；遇认证/异常提示立即让路。
// @author       local
// @license      MIT
// @run-at       document-start
//
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
//
// 0.5.0 变更：**题库 / API Key / GM_xmlhttpRequest 已全部移除**，脚本不再发出任何跨站请求；
//   作业页与章节测验页一律"等 3s → 点右侧目录跳过"，不做题、不填答案、不提示答案。
//
// 安全条目 3.6 的唯一例外：unsafeWindow（已获用户裁决许可）。
// 理由：超星底部"下一节"是 <div onclick="PCount.next(...)">，只派发合成点击在部分版本不触发导航；
//   直接调用平台自己的 PCount.next 是**零合成事件**的路径。
// 风险评估（2026-10-31 复评，结论：保留，但收紧边界）：
//   - PCount.next 是页面自己的业务函数，调用它走的是平台同一条跳转链路（含"任务点未完成"拦截），
//     不伪造 isTrusted=false 的事件，**不会因为"事件不可信"被识别**，风险等级低于伪造点击；
//   - 唯一真实风险是"实参猜错 → 跳到错误章节"。因此现在**只用 onclick 属性里的字面量实参**，
//     删掉了隐藏域 curCourseId/curChapterId/curClazzId 的猜测式兜底；取不到实参直接降级目录；
//   - 右侧目录原生 click（.posCatalog_name）覆盖全部失败分支，PCount.next 只是首选路径。
// 限制（代码里逐条落实，见 platform/chaoxing-study.js 的 B1~B6）：
//   - 只读 unsafeWindow.PCount.next 一个成员，不读其它变量、不写任何东西；
//   - 实参**只**取自目标元素 onclick 属性原样解析，不做隐藏域兜底；
//   - 只在 typeof === 'function' 时调用；异常一律降级到"目录树点击"，不重试；
//   - **不注入 <script>、不 eval、不 new Function**。
// 未授予 unsafeWindow 时 `typeof` 判空 → 自动走目录树降级，不会报错。
//
// 安全条目 3.6：@grant 最小化（GM_getValue / GM_setValue / unsafeWindow 三个）。
// 不声明 GM_addStyle（样式只注入 Shadow Root）、不声明 GM_notification / GM_download / GM_openInTab /
// GM_xmlhttpRequest —— 0.5.0 起脚本完全不联网。
//
// 安全条目 2.3 / 3.5：@match 精确到两平台业务域名，绝不写 *://*/*。
// 覆盖范围说明：
//   - 超星：逐条列举（子域少，可穷举；漏一个的表现是功能静默失效，用户会去装野生脚本，反而更危险）。
//   - 智慧树：子站太多（studyvideoh5 / studyplush5 / studywisdomh5 / onlineweb / onlinestuh5 /
//     hike / fusioncourseh5 / onlineexamh5new ...），逐条列举必然漏；用 *://*.zhihuishu.com/*
//     收紧到域，再由 core/platform.js 的 HOST_ALLOW 白名单剔除登录页/CDN。
//
// 注意：**不使用 @noframes**。学习通的视频/文档在跨域 iframe 里，必须能在子帧运行；
// 子帧默认处于"待命"状态，收到顶帧 ARM 才允许操作（见 core/frames.js）。
//
// @match        *://mooc1.chaoxing.com/*
// @match        *://mooc1-1.chaoxing.com/*
// @match        *://mooc2-ans.chaoxing.com/*
// @match        *://mooc2.chaoxing.com/*
// @match        *://*.zhihuishu.com/*
//
// ==/UserScript==

/* 由 test/build.html 拼接生成（等价于 scripts/build.mjs 的拼接部分）。
 * 0.5.0：在 0.4.0 产物上手工修订（去掉题库/API Key、提高延迟、限制 1.25 倍速、夜间提醒）。 */
/* 生成时间：2026-10-31T03:45:17.157Z（0.5.0 手工修订） */
(function () {
  'use strict';
  const SH = {};   // 全脚本唯一命名空间，不挂 window

/* ================= src/core/const.js ================= */
/* study-helper/src/core/const.js
 * 纯常量模块：无行为、无副作用、不访问 DOM、不发请求。
 *
 * 安全条目：五.5「模块顶层零执行」——本文件是该约束的"唯一例外提供者"。
 * 依赖：无。
 */
(function (SH) {
  'use strict';

  var STATE = Object.freeze({
    IDLE: 'idle',
    PLAYING: 'playing',
    READING: 'reading',
    SEARCHING: 'searching',
    FILLING: 'filling',
    WAITING_MANUAL_PLAY: 'waiting-manual-play',
    PAUSED: 'paused',
    CLOSED: 'closed',
    EXITED: 'exited',
    DONE: 'done',
    ERROR: 'error'
  });

  var PAUSE_REASON = Object.freeze({
    USER: 'user',
    AUTH: 'auth',
    ANOMALY: 'anomaly',
    VISIBILITY: 'visibility',
    MANUAL_PLAY: 'manual-play',
    /* "下一节"点了没反应：不是平台提示，属于我们自己点不动，需要人工接管 */
    TURN_FAILED: 'turn-failed',
    REPEAT_TRIGGER: 'repeat-trigger'
  });

  var MODE = Object.freeze({ STUDY: 'study', WORK: 'work', EXAM: 'exam', OTHER: 'other' });
  var PLATFORM = Object.freeze({ CX: 'chaoxing', ZHS: 'zhihuishu' });
  var ROLE = Object.freeze({ TOP: 'top', CHILD: 'child' });

  var DEFAULTS = Object.freeze({
    speed: 1,
    autoNext: false,
    mutex: true,
    minDwellMs: [8000, 12000]
  });

  var LIMITS = Object.freeze({
    SPEED_MIN: 1,
    SPEED_MAX: 1.25,          /* 0.5.0 用户要求：倍速上限 1.25，超过一律不生效 */

    /* 0.5.0 用户要求：任务之间 / 点击之间的间隔抬到 3–5s（旧的 300–800ms 太像机器）。
     * 轮询（只读 DOM，不产生可见动作）仍可快一些，避免状态刷新迟钝。 */
    JITTER_CLICK_MS: Object.freeze([3000, 5000]),
    JITTER_POLL_MS: Object.freeze([900, 1600]),

    PAUSE_RESUME_MAX: 3,
    ENDED_GAP_MS: Object.freeze([3000, 5000]),

    DWELL_MS: Object.freeze([8000, 12000]),
    NEXT_CHAPTER_GAP_MS: Object.freeze([3000, 5000]),
    NEXT_CHAPTER_DAILY_MAX: 30,

    READER_STEP_MS: Object.freeze([2500, 4000]),   /* 0.5.0：每屏停留 2.5–4s，像人在看 */
    READER_STEP_PX: Object.freeze([240, 520]),
    READER_BOTTOM_DWELL_MS: Object.freeze([3000, 5000]),
    READER_MAX_STEPS: 400,

    LOG_MAX: 100,
    /* 0.5.0 用户要求：00:00–06:00 刷课先提醒一次，用户可选择继续或暂停。 */
    NIGHT_START_HOUR: 0,
    NIGHT_END_HOUR: 6,
    CHILD_ARM_TIMEOUT_MS: 3000,
    SOFT_STOP_MAX_MS: 60000,
    TAB_LOCK_TTL_MS: 15000,
    LOCK_HEARTBEAT_MS: 5000,

    /* 0.5.0：原答案匹配阈值（DICE_* /GAP_*）随 matcher 模块一起删除；
     * 这里只保留"单题最短停留"这一条与答题无关的节流参数。 */
    MIN_DWELL_MS: Object.freeze([8000, 12000])
  });

  var STORAGE_KEYS = Object.freeze({
    ENABLED: 'sh.enabled',
    CFG: 'sh.cfg.v1',
    STAT_PREFIX: 'sh.stat.',
    LOCK: 'sh.lock.tab',
    NOTICE_PREFIX: 'sh.notice.'
  });

  var SESSION_EXITED_KEY = 'sh.exited';
  /* 会话内"上次在跑"标记：用于平台整页跳转（点"下一节"）后自动续跑。
   * 只存在 sessionStorage、只在本标签页、关掉面板/退出即清除 —— 不违反 D8（新装仍是手动启动）。 */
  var SESSION_AUTORUN_KEY = 'sh.autorun';

  SH.const = Object.freeze({
    STATE: STATE,
    PAUSE_REASON: PAUSE_REASON,
    MODE: MODE,
    PLATFORM: PLATFORM,
    ROLE: ROLE,
    DEFAULTS: DEFAULTS,
    LIMITS: LIMITS,
    STORAGE_KEYS: STORAGE_KEYS,
    SESSION_EXITED_KEY: SESSION_EXITED_KEY,
    SESSION_AUTORUN_KEY: SESSION_AUTORUN_KEY
  });
})(SH);

/* ================= src/core/worker.js ================= */
/* study-helper/src/core/worker.js
 * 生命周期状态机 + 资源账本 + 世代号（epoch）。
 *
 * 安全条目：
 *   3.13 / 五.1  所有定时器、观察器、在途请求、事件监听必须登记在账本里，shutdown/exit 逐个回收。
 *   3.4          认证/异常提示触发 pause 时，必须"清定时器 + 断观察器 + abort 在途请求"，且不自动恢复。
 *   五.2         每个异步回调第一行校验 state 与 epoch。
 *   3.9          视频 pause 自动恢复上限 3 次（resumeCount 由 media 子机维护，worker 只提供计数位与重置时机）。
 *
 * 不变式（P5 会断言）：
 *   I1 全仓只有本文件调用 setTimeout / setInterval；其它模块必须走 w.setTimer 或 SH.dom.sleep(w, ms)。
 *   I2 pause / shutdown / exit 之后，counts() 的 timers / observers / inflight 必须为 0。
 *   I3 epoch 只增不减；任何"旧纪元"的回调一律失效（即使清理漏了某个监听器也不会产生幽灵操作）。
 *   I4 状态转换必须命中 ALLOWED 表，否则抛 TransitionError（P1 阶段就把非法转换挡在开发期）。
 *   I5 软关闭（stopping）不是终态：只上标记 + 60s 看门狗，真正收尾由原子步骤结束或看门狗触发。
 *
 * 依赖：SH.const（纯常量）。不得在顶层依赖其它带行为的模块。
 */
(function (SH) {
  'use strict';

  var C = SH.const;
  var STATE = C.STATE;

  function TransitionError(from, to) {
    var e = new Error('illegal transition: ' + from + ' -> ' + to);
    e.name = 'TransitionError';
    e.shStudyHelper = true;
    return e;
  }

  /* 合法转换表（P0-6 的图 + 子机串行）。同态转换只允许 playing/reading/filling 这类"原地续跑"。 */
  var ALLOWED = {
    'idle': ['playing', 'reading', 'searching', 'filling', 'done', 'paused', 'closed', 'exited', 'error'],
    'playing': ['playing', 'idle', 'done', 'waiting-manual-play', 'paused', 'closed', 'exited', 'error'],
    'reading': ['reading', 'idle', 'done', 'paused', 'closed', 'exited', 'error'],
    'searching': ['filling', 'done', 'idle', 'paused', 'closed', 'exited', 'error'],
    'filling': ['filling', 'searching', 'done', 'idle', 'paused', 'closed', 'exited', 'error'],
    'waiting-manual-play': ['playing', 'paused', 'closed', 'exited', 'error'],
    'paused': ['idle', 'closed', 'exited', 'error'],
    'closed': ['idle', 'exited'],
    'exited': ['idle'],
    'done': ['playing', 'idle', 'closed', 'exited', 'error'],
    'error': ['idle', 'paused', 'closed', 'exited']
  };
  Object.freeze(ALLOWED);

  var ACTIVE_STATES = ['idle', 'playing', 'reading', 'searching', 'filling', 'waiting-manual-play', 'done'];

  function isTerminal(state) {
    return state === STATE.CLOSED || state === STATE.EXITED;
  }

  function isActive(state) {
    return ACTIVE_STATES.indexOf(state) >= 0;
  }

  function now() {
    return Date.now();
  }

  function noop() {}

  /* ------------------------------------------------------------------ *
   * 资源账本（唯一允许创建定时器/观察器/监听的地方）
   * ------------------------------------------------------------------ */

  function fireTeardownHooks(w) {
    /* 先取快照再清空，钩子里允许再删自己。
     * 注意：teardownHooks 是 Set，**不能**用 Array.prototype.slice.call(Set) ——
     * Set 没有 length/下标，那样永远得到空数组，sleep / waitFinished 就会被永久悬挂。 */
    var hooks = [];
    w.teardownHooks.forEach(function (fn) { hooks.push(fn); });
    w.teardownHooks.clear();
    for (var i = 0; i < hooks.length; i++) {
      try { hooks[i](); } catch (e) { /* 清理钩子失败不阻断后续清理 */ }
    }
  }

  function clearAllTimers(w) {
    w.timers.forEach(function (entry) {
      try { clearTimeout(entry.id); } catch (e) { /* ignore */ }
    });
    w.timers.clear();
  }

  function disconnectAllObservers(w) {
    w.observers.forEach(function (mo) {
      try { mo.disconnect(); } catch (e) { /* ignore */ }
    });
    w.observers.clear();
  }

  function abortAllRequests(w) {
    w.inflightRequests.forEach(function (entry) {
      try { if (entry && typeof entry.abort === 'function') entry.abort(); } catch (e) { /* ignore */ }
    });
    w.inflightRequests.clear();
  }

  function offAllListeners(w) {
    w.listeners.forEach(function (entry) {
      try { entry.target.removeEventListener(entry.type, entry.fn, entry.opts); } catch (e) { /* ignore */ }
    });
    w.listeners.clear();
  }

  /* 统一收尾：顺序固定，不可乱（先断来源，再解挂起）。 */
  function teardown(w) {
    clearAllTimers(w);
    disconnectAllObservers(w);
    abortAllRequests(w);
    offAllListeners(w);
    fireTeardownHooks(w);
  }

  /* ------------------------------------------------------------------ *
   * 状态机
   * ------------------------------------------------------------------ */

  function emit(w) {
    if (typeof w.onChange !== 'function') return;
    try { w.onChange(w.snapshot()); } catch (e) { /* UI 回调异常不能影响状态机 */ }
  }

  function setState(w, to) {
    if (w.state === to) { emit(w); return; }
    w.prevState = w.state;
    w.state = to;
    emit(w);
  }

  function transition(w, to, meta) {
    var list = ALLOWED[w.state] || [];
    if (list.indexOf(to) < 0) throw TransitionError(w.state, to);
    setState(w, to);
    if (w.hooks && typeof w.hooks.onTransition === 'function') {
      try { w.hooks.onTransition(w.prevState, to, meta); } catch (e) { /* ignore */ }
    }
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 工厂
   * ------------------------------------------------------------------ */

  function createWorker(options) {
    var opt = options || {};

    var w = {
      id: 'w' + Math.random().toString(36).slice(2, 8),

      /* 状态 */
      state: STATE.IDLE,
      prevState: STATE.IDLE,
      pausedReason: null,
      epoch: 0,

      /* 上下文 */
      platform: opt.platform || null,
      mode: opt.mode || null,
      role: opt.role || null,

      /* 计数位 */
      resumeCount: 0,     /* 同一任务点内 pause 自动恢复次数（安全条目 3.9，上限 3） */
      triggerCount: 0,    /* 本次会话内"认证/异常"触发次数（D7：第 2 次不再给"继续"） */
      stopping: false,    /* 软关闭进行中 */
      stoppingSince: 0,

      /* 账本（安全条目 五.1） */
      timers: new Set(),
      observers: new Set(),
      inflightRequests: new Set(),
      listeners: new Set(),
      teardownHooks: new Set(),

      /* 钩子（由 main.js 注入：UI、媒体、任务循环） */
      hooks: opt.hooks || {},
      log: typeof opt.log === 'function' ? opt.log : noop,
      onChange: null
    };

    /* ---------------- 世代 ---------------- */

    w.alive = function (ep) {
      if (isTerminal(w.state)) return false;
      if (ep === undefined || ep === null) return true;
      return ep === w.epoch;
    };

    w.capture = function () { return w.epoch; };

    /* ---------------- 账本写入 ---------------- */

    w.setTimer = function (fn, ms, tag) {
      var ep = w.epoch;
      var entry = { id: 0, tag: tag || '-', ms: Math.max(0, ms | 0), due: now() + Math.max(0, ms | 0) };
      entry.id = setTimeout(function () {
        w.timers.delete(entry);
        if (!w.alive(ep)) return;
        try { fn(); } catch (err) { SH.guards.report(w, err, 'timer:' + entry.tag); }
      }, entry.ms);
      w.timers.add(entry);
      return entry;
    };

    w.clearTimer = function (entry) {
      if (!entry) return false;
      try { clearTimeout(entry.id); } catch (e) { /* ignore */ }
      return w.timers.delete(entry);
    };

    w.trackObserver = function (mo) {
      if (!mo) return mo;
      w.observers.add(mo);
      return mo;
    };

    w.trackRequest = function (req) {
      var entry = req || { abort: noop };
      w.inflightRequests.add(entry);
      return entry;
    };

    w.untrackRequest = function (entry) {
      if (!entry) return false;
      return w.inflightRequests.delete(entry);
    };

    w.on = function (target, type, fn, opts) {
      var entry = { target: target, type: type, fn: fn, opts: opts };
      w.listeners.add(entry);
      target.addEventListener(type, fn, opts);
      return entry;
    };

    w.off = function (entry) {
      if (!entry) return false;
      try { entry.target.removeEventListener(entry.type, entry.fn, entry.opts); } catch (e) { /* ignore */ }
      return w.listeners.delete(entry);
    };

    w.addTeardownHook = function (fn) {
      if (typeof fn === 'function') w.teardownHooks.add(fn);
      return fn;
    };

    w.counts = function () {
      return {
        timers: w.timers.size,
        observers: w.observers.size,
        inflight: w.inflightRequests.size,
        listeners: w.listeners.size,
        teardownHooks: w.teardownHooks.size
      };
    };

    /* ---------------- 生命周期 ---------------- */

    w.transition = function (to, meta) { return transition(w, to, meta); };

    /* 暂停：唯一允许的暂停入口。
     * 不能在 PAUSED/CLOSED/EXITED 上再 pause（重复 pause 会掩盖真实原因）。 */
    w.pause = function (reason) {
      if (isTerminal(w.state)) return false;
      if (w.state === STATE.PAUSED) {
        if (!w.pausedReason) w.pausedReason = reason || C.PAUSE_REASON.USER;
        return false;
      }
      var wasActive = isActive(w.state);
      w.pausedReason = reason || C.PAUSE_REASON.USER;
      w.epoch++;                 /* 先失效旧世代，再清理，避免清理中触发新动作 */
      teardown(w);
      setState(w, STATE.PAUSED);
      w.stopping = false;
      if (wasActive && w.hooks && typeof w.hooks.onPause === 'function') {
        try { w.hooks.onPause(w.pausedReason); } catch (e) { /* ignore */ }
      }
      return true;
    };

    /* 恢复：调用方（UI/main）必须先做认证复检，通过了才能调这里（安全条目 3.4）。 */
    w.resume = function () {
      if (w.state !== STATE.PAUSED) return false;
      w.pausedReason = null;
      w.reinit();
      setState(w, STATE.IDLE);
      if (w.hooks && typeof w.hooks.onResume === 'function') {
        try { w.hooks.onResume(); } catch (e) { /* ignore */ }
      }
      return true;
    };

    /* 重建：epoch++，计数位归零，交给 hooks.rebuild 重建全部运行时对象（不复用旧引用）。 */
    w.reinit = function () {
      w.epoch++;
      w.resumeCount = 0;
      w.stopping = false;
      w.stoppingSince = 0;
      if (w.hooks && typeof w.hooks.rebuild === 'function') {
        try { w.hooks.rebuild(w.epoch); } catch (e) { SH.guards.report(w, e, 'reinit'); }
      }
      return w.epoch;
    };

    /* 关闭：软关闭只上标记 + 看门狗；硬关闭立即收尾。 */
    w.shutdown = function (opts) {
      var o = opts || {};
      if (isTerminal(w.state)) return false;

      /* 已经在 PAUSED（一切已停）或要求硬关闭 → 直接收尾 */
      if (o.hard || w.state === STATE.PAUSED) {
        w.epoch++;
        teardown(w);
        w.stopping = false;
        setState(w, STATE.CLOSED);
        if (w.hooks && typeof w.hooks.onClosed === 'function') {
          try { w.hooks.onClosed({ hard: !!o.hard, by: o.by || 'user' }); } catch (e) { /* ignore */ }
        }
        return true;
      }

      if (w.stopping) return true;   /* 幂等 */
      w.stopping = true;
      w.stoppingSince = now();
      /* graceMs 可按任务类型收窄（例：答题只给 2s 收尾；视频在调用前已被硬打断，不会走到这里） */
      var graceMs = Number(o.maxMs) > 0 ? Math.max(500, Number(o.maxMs)) : C.LIMITS.SOFT_STOP_MAX_MS;
      w.setTimer(function () {
        if (!w.stopping) return;
        w.log('warn', '软关闭超过 ' + Math.round(graceMs / 1000) + 's，强制收尾');
        w.shutdown({ hard: true, by: 'soft-stop-watchdog' });
      }, graceMs, 'soft-stop-watchdog');

      if (w.hooks && typeof w.hooks.onStopping === 'function') {
        try { w.hooks.onStopping(); } catch (e) { /* ignore */ }
      }
      return true;
    };

    /* 退出：收尾 + 通知 UI 销毁 + 最后写 sessionStorage（顺序不能反，见 P0-6）。 */
    w.exit = function () {
      if (w.state === STATE.EXITED) return false;
      w.epoch++;
      teardown(w);
      setState(w, STATE.EXITED);
      if (w.hooks && typeof w.hooks.onExit === 'function') {
        try { w.hooks.onExit(); } catch (e) { /* ignore */ }
      }
      if (w.hooks && typeof w.hooks.onExited === 'function') {
        try { w.hooks.onExited(); } catch (e) { /* ignore */ }
      }
      return true;
    };

    w.incTrigger = function () { w.triggerCount++; return w.triggerCount; };
    w.resetResumeCount = function () { w.resumeCount = 0; };
    w.incResumeCount = function () { w.resumeCount++; return w.resumeCount; };

    w.snapshot = function () {
      return {
        id: w.id,
        state: w.state,
        prevState: w.prevState,
        pausedReason: w.pausedReason,
        epoch: w.epoch,
        platform: w.platform,
        mode: w.mode,
        role: w.role,
        resumeCount: w.resumeCount,
        triggerCount: w.triggerCount,
        stopping: w.stopping,
        counts: w.counts()
      };
    };

    return w;
  }

  SH.worker = Object.freeze({
    STATE: STATE,
    PAUSE_REASON: C.PAUSE_REASON,
    ALLOWED: ALLOWED,
    ACTIVE_STATES: Object.freeze(ACTIVE_STATES),
    TransitionError: TransitionError,
    isTerminal: isTerminal,
    isActive: isActive,
    createWorker: createWorker
  });
})(SH);

/* ================= src/core/guards.js ================= */
/* study-helper/src/core/guards.js
 * 异步守卫：所有异步回调的统一入口断言。
 *
 * 安全条目：五.2「异步回调开头 if (state === CLOSED || state === EXITED) return;」
 *   本文件把这条从"每个回调手写 if"升级为两档：
 *     - canAct(w, ep)        → 布尔，用于"静默放弃"（timer 回调、轮询步进）
 *     - assertCanAct(w, ep)  → 抛 AbortError，用于"必须中断的流水线"（点击序列、答题填写）
 *   判定同时覆盖 CLOSED / EXITED / PAUSED / WAITING_MANUAL_PLAY：暂停或等人工播放期间，
 *   任何推进式操作都必须停（P0-5 / 安全条目 3.4「认证未通过期间不继续任何学习或答题操作」）。
 *
 * 依赖：SH.const（纯常量，允许顶层依赖）。
 */
(function (SH) {
  'use strict';

  var C = SH.const;

  /* 自定义中断错误：故意不复用 DOMException，避免与页面代码产生任何交互。 */
  function AbortError(message) {
    var e = new Error(message || 'aborted');
    e.name = 'AbortError';
    e.shStudyHelper = true;
    return e;
  }
  AbortError.prototype = Object.create(Error.prototype);
  AbortError.prototype.constructor = AbortError;

  function isAbort(err) {
    return !!err && err.name === 'AbortError';
  }

  /* 只判"终态 + 世代"，不判暂停。给"只读探测"用（例如退出时还要读一次 DOM 也不该读，统一用它）。 */
  function aliveOnly(w, ep) {
    if (!w) return false;
    return w.alive(ep);
  }

  /* 能否推进式操作。所有"会产生平台可见行为"的动作前都必须过这一关。 */
  function canAct(w, ep) {
    if (!w || !w.alive(ep)) return false;
    var s = w.state;
    if (s === C.STATE.PAUSED) return false;
    if (s === C.STATE.WAITING_MANUAL_PLAY) return false;
    if (s === C.STATE.CLOSED) return false;
    if (s === C.STATE.EXITED) return false;
    return true;
  }

  function assertCanAct(w, ep, where) {
    if (!canAct(w, ep)) {
      throw AbortError((where || 'unknown') + ' @' + (w ? w.state : 'no-worker'));
    }
  }

  /* 把任意回调包成"守卫版"。不做 this/arguments 的魔法，直接透传。 */
  function wrap(w, ep, fn) {
    return function () {
      if (!canAct(w, ep)) return undefined;
      return fn.apply(this, arguments);
    };
  }

  /* 未实现占位：P1 骨架阶段用，抛出的错误会在 test 里被断言为"预期未实现"。 */
  function notImplemented(what, phase) {
    var e = new Error('NOT_IMPLEMENTED(' + (phase || '?') + '): ' + what);
    e.name = 'NotImplementedError';
    e.shStudyHelper = true;
    return e;
  }

  /* 统一的错误上报：Abort 静默丢弃，其余记日志并交给 worker 的 onError 钩子。
   * 注意：日志里绝不能出现题干原文/API Key（安全条目 3.14 / D9）。 */
  function report(w, err, where) {
    if (!err) return;
    if (isAbort(err)) return;
    if (w && typeof w.log === 'function') {
      w.log('error', '[' + (where || '-') + '] ' + (err && err.message ? err.message : String(err)));
    }
    if (w && w.hooks && typeof w.hooks.onError === 'function') {
      try { w.hooks.onError(err, where); } catch (e) { /* 钩子自身失败不再递归上报 */ }
    }
  }

  SH.guards = Object.freeze({
    AbortError: AbortError,
    isAbort: isAbort,
    aliveOnly: aliveOnly,
    canAct: canAct,
    assertCanAct: assertCanAct,
    wrap: wrap,
    notImplemented: notImplemented,
    report: report
  });
})(SH);

/* ================= src/core/dom.js ================= */
/* study-helper/src/core/dom.js
 * DOM 基础操作：随机区间、可 await 的 sleep（走账本）、可见性/弹窗判定、点击序列。
 *
 * 安全条目：
 *   五.1   sleep 的定时器登记在 worker 账本；pause/close/exit 时由 teardown 钩子 resolve(false)，不留悬挂 Promise。
 *   3.1    点击间隔 3–5s 随机（0.5.0 从 300–800ms 抬高）；禁止同步连点（clickSequence 一次只处理一个目标）。
 *   D2     **不派发 mousemove 预热**（P0 裁决：无安全收益，反而增加"有位移无可信点击"的指纹）。
 *   3.6    只读 textContent，不拼 innerHTML。
 *
 * 依赖：SH.const（顶层）；SH.guards（函数内）。
 */
(function (SH) {
  'use strict';

  var C = SH.const;

  function randomInRange(range) {
    var lo = Array.isArray(range) ? range[0] : 0;
    var hi = Array.isArray(range) ? range[1] : 0;
    if (hi < lo) { var t = lo; lo = hi; hi = t; }
    return lo + Math.random() * (hi - lo);
  }

  function randomIntInRange(range) {
    return Math.round(randomInRange(range));
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /* 可 await 的等待。返回 true = 正常到点；false = 被清理（关闭/暂停/重启世代）。
   * 实现要点：不用原生 setTimeout；用 w.setTimer + 一个 teardown 钩子，保证不会悬挂。 */
  function sleep(w, ms) {
    return new Promise(function (resolve) {
      var ep = w.epoch;
      var settled = false;

      function finish(value) {
        if (settled) return;
        settled = true;
        w.teardownHooks.delete(cancelOnTeardown);
        resolve(value);
      }

      function cancelOnTeardown() { finish(false); }

      w.addTeardownHook(cancelOnTeardown);
      w.setTimer(function () { finish(w.alive(ep)); }, ms, 'sleep');
    });
  }

  function sleepJitter(w, range) {
    return sleep(w, randomIntInRange(range));
  }

  /* 可见性判定（结构门的一部分，供 auth-guard 复用；不要在别处另写一套）。 */
  function rectOf(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    var r = el.getBoundingClientRect();
    if (!r) return null;
    return { w: r.width || (r.right - r.left), h: r.height || (r.bottom - r.top), top: r.top, left: r.left };
  }

  function isVisible(el, doc) {
    if (!el || el.nodeType !== 1) return false;
    var r = rectOf(el);
    if (!r || r.w < 1 || r.h < 1) return false;
    var win = doc && doc.defaultView ? doc.defaultView : window;
    var cs = win.getComputedStyle(el);
    if (!cs) return false;
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (parseFloat(cs.opacity || '1') <= 0.05) return false;
    if (cs.display === 'none') return false;
    return true;
  }

  /* 弹窗结构门（P0-7）：可见 + 面积不超过视口 60% + 文本 ≤ 300 字 + 定位可疑。
   * 语义：**宁可误报（暂停可恢复），不可漏报（继续操作）**。 */
  function isDialogLike(el, doc) {
    if (!isVisible(el, doc)) return false;
    var r = rectOf(el);
    var win = doc && doc.defaultView ? doc.defaultView : window;
    var vw = win.innerWidth || 1024;
    var vh = win.innerHeight || 768;
    if (r.w * r.h > vw * vh * 0.6) return false;

    var text = (el.textContent || '').trim();
    if (text.length > 300) return false;

    /* 自身或近祖（最多 4 层）出现 fixed/absolute 或较大 z-index，才认为是"浮层" */
    var node = el;
    for (var depth = 0; node && node.nodeType === 1 && depth < 4; depth++) {
      var cs = win.getComputedStyle(node);
      if (cs) {
        if (cs.position === 'fixed' || cs.position === 'absolute') return true;
        var z = parseInt(cs.zIndex, 10);
        if (!isNaN(z) && z >= 100) return true;
      }
      node = node.parentElement;
    }
    /* 命中 dialog 语义的角色也算 */
    var role = el.getAttribute && (el.getAttribute('role') || '');
    if (role === 'dialog' || role === 'alertdialog') return true;
    if (el.getAttribute && el.getAttribute('aria-modal') === 'true') return true;
    return false;
  }

  /* 只读文本：禁止 innerHTML 渲染用户输入（安全条目 3.6）。 */
  function textOf(el) {
    if (!el) return '';
    return String(el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /* 目标元素派发事件序列并给框架一个处理周期。
   * 注意（D2）：**不派发 mousemove**；这里的三连/五连事件只为兼容内联 onclick 与 Vue/jQuery 委托，
   * 不是"拟人化"。超星的 #prevNextFocusNext 是 <div onclick="PCount.next(...)">，
   * 只 dispatch click 在部分实现下不触发，因此补 pointerdown/pointerup（PointerEvent 不可用时退化为 MouseEvent）。
   * 输入控件优先用原生 .click()（会正确翻转 checked 并触发 change），它同样是 isTrusted=false。
   * @returns Promise<boolean> 事件序列已派发且未被中断
   */
  function clickSequence(el, w) {
    return new Promise(function (resolve) {
      if (!el || typeof el.dispatchEvent !== 'function') return resolve(false);
      var ep = w.epoch;
      if (!SH.guards.canAct(w, ep)) return resolve(false);

      var tagName = String(el.tagName || '').toUpperCase();
      var isInput = tagName === 'INPUT';

      if (isInput && typeof el.click === 'function') {
        try { el.click(); } catch (e) { return resolve(false); }
      } else {
        var base = {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: (typeof window !== 'undefined' ? window : null),
          button: 0
        };
        var PE = (typeof window !== 'undefined' && typeof window.PointerEvent === 'function') ? window.PointerEvent : null;

        function fire(type, extra, usePointer) {
          var opts = {};
          for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) opts[k] = base[k];
          if (extra) for (var j in extra) if (Object.prototype.hasOwnProperty.call(extra, j)) opts[j] = extra[j];
          var ev;
          try {
            ev = (usePointer && PE) ? new PE(type, opts) : new MouseEvent(type, opts);
          } catch (e) {
            ev = new MouseEvent(type, opts);
          }
          el.dispatchEvent(ev);
        }

        try {
          fire('pointerdown', { buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }, true);
          fire('mousedown', { buttons: 1, detail: 1 }, false);
          fire('pointerup', { buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }, true);
          fire('mouseup', { buttons: 0, detail: 1 }, false);
          fire('click', { buttons: 0, detail: 1 }, false);
        } catch (e) {
          return resolve(false);
        }
      }

      /* 每次点击之间 3–5s 随机（0.5.0，安全条目 3.1），顺带给框架一个处理周期 */
      sleep(w, randomIntInRange(C.LIMITS.JITTER_CLICK_MS)).then(function (ok) {
        resolve(!!ok);
      });
    });
  }

  /* 填写文本类控件：只写 value + 派发 input/change，不碰剪贴板、不模拟键盘。 */
  function fillInput(el, text, w) {
    if (!el || typeof el.value === 'undefined') return false;
    try {
      el.focus && el.focus();
      el.value = String(text == null ? '' : text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) {
      return false;
    }
  }

  SH.dom = Object.freeze({
    randomInRange: randomInRange,
    randomIntInRange: randomIntInRange,
    clamp: clamp,
    sleep: sleep,
    sleepJitter: sleepJitter,
    rectOf: rectOf,
    isVisible: isVisible,
    isDialogLike: isDialogLike,
    textOf: textOf,
    clickSequence: clickSequence,
    fillInput: fillInput
  });
})(SH);

/* ================= src/core/store.js ================= */
/* study-helper/src/core/store.js
 * 配置与本地状态：GM 存储封装、跨日计数、跨标签互斥、退出标记。
 *
 * 0.5.0：**API 地址 / API Key 相关读写与校验全部删除**（题库功能已移除）。
 *
 * 安全条目：
 *   C1     不读 document.cookie / localStorage / indexedDB；sessionStorage 只碰 sh.exited 一个键。
 *   D6     跨标签互斥：GM_setValue + 心跳时间戳，无定时器清零。
 *   用户要求2  自动跳章计数用"本地日期 key"，读到 date 不符即视为新的一天（禁止 setInterval 归零）。
 *
 * 依赖：SH.const（顶层）。
 */
(function (SH) {
  'use strict';

  var C = SH.const;
  var K = C.STORAGE_KEYS;

  /* GM 不可用时（例如被脚本管理器禁用、或本地测试页没装垫片）退回内存存储，
   * 保证脚本不抛异常，但要在 UI 上显式告警（store.degraded）。 */
  var mem = {};
  var degraded = false;

  function gmGet(key, dflt) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(key, dflt);
      degraded = true;
      return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : dflt;
    } catch (e) {
      degraded = true;
      return dflt;
    }
  }

  function gmSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') { GM_setValue(key, value); return true; }
      degraded = true;
      mem[key] = value;
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------------- 日期（本地时区，不能是 UTC） ---------------- */

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function todayKey(dateObj) {
    var d = dateObj instanceof Date ? dateObj : new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /* 跨日计数：读 store → 日期不符就归零（懒重置），不做定时器。 */
  function dailyCounter(name, opts) {
    var bump = !!(opts && opts.bump);
    var key = K.STAT_PREFIX + name;
    var today = todayKey();
    var raw = gmGet(key, null);
    var rec = (raw && typeof raw === 'object' && typeof raw.count === 'number' && typeof raw.day === 'string')
      ? raw : { day: today, count: 0 };

    if (rec.day !== today) rec = { day: today, count: 0 };
    var result = { day: rec.day, count: rec.count };

    if (bump) {
      rec.count = rec.count + 1;
      gmSet(key, { day: rec.day, count: rec.count });
      result.count = rec.count;
    }
    return result;
  }

  /* ---------------- API 相关（0.5.0 已移除） ----------------
   * 这里原本是 validateBaseUrl / maskKey 与"HTTPS 强制校验、Key 掩码"。
   * 题库与 API Key 功能整体删除后，本模块不再保存任何远端地址或密钥。 */

  /* ---------------- 配置读写 ---------------- */

  function normalizeCfg(raw) {
    var d = C.DEFAULTS;
    var r = (raw && typeof raw === 'object') ? raw : {};
    var dwell = Array.isArray(r.minDwellMs) ? r.minDwellMs : d.minDwellMs;
    var lo = Number(dwell[0]);
    var hi = Number(dwell[1]);
    /* D3：可调高不可调低——低于默认下限一律抬回默认值 */
    if (!isFinite(lo) || lo < d.minDwellMs[0]) lo = d.minDwellMs[0];
    if (!isFinite(hi) || hi < lo) hi = Math.max(lo, d.minDwellMs[1]);

    var speed = Number(r.speed);
    if (!isFinite(speed)) speed = d.speed;
    speed = SH.dom.clamp(speed, C.LIMITS.SPEED_MIN, C.LIMITS.SPEED_MAX);

    return {
      speed: speed,
      autoNext: r.autoNext === true,
      mutex: r.mutex !== false,
      minDwellMs: [lo, hi]
    };
  }

  function cfg() { return normalizeCfg(gmGet(K.CFG, null)); }

  function setCfg(patch) {
    var cur = cfg();
    var next = normalizeCfg(Object.assign({}, cur, patch || {}));
    gmSet(K.CFG, next);
    return { ok: true, cfg: next };
  }

  /* ---------------- 总开关（真源） ---------------- */

  /* 默认 **关**：与 D8 同源——绝不在用户不知情时开始自动操作。
   * 新装后必须：勾总开关 → 再点"启动"，才可能开始任何自动化（P1 裁决 1）。 */
  function isEnabled() { return gmGet(K.ENABLED, false) === true; }
  function setEnabled(v) { gmSet(K.ENABLED, v === true); return isEnabled(); }

  /* ---------------- 一次性提示（如 D4 学习通"答案提示模式"说明） ---------------- */

  function noticeSeen(name) { return gmGet(K.NOTICE_PREFIX + name, false) === true; }
  function markNoticeSeen(name) { gmSet(K.NOTICE_PREFIX + name, true); return true; }

  /* ---------------- 退出标记（sessionStorage 唯一允许的键） ---------------- */

  function readExited() {
    try { return window.sessionStorage.getItem(C.SESSION_EXITED_KEY); }
    catch (e) { return null; }   /* 沙箱 iframe / 禁存储：按"未退出"处理，不做死锁 */
  }

  function markExited() {
    try { window.sessionStorage.setItem(C.SESSION_EXITED_KEY, '1'); return true; }
    catch (e) { return false; }
  }

  function clearExited() {
    try { window.sessionStorage.removeItem(C.SESSION_EXITED_KEY); return true; }
    catch (e) { return false; }
  }

  /* ---------------- 会话内续跑标记（平台整页跳转后自动恢复） ---------------- */

  function readAutorun() {
    try { return window.sessionStorage.getItem(C.SESSION_AUTORUN_KEY); }
    catch (e) { return null; }
  }

  function markAutorun() {
    try { window.sessionStorage.setItem(C.SESSION_AUTORUN_KEY, '1'); return true; }
    catch (e) { return false; }
  }

  function clearAutorun() {
    try { window.sessionStorage.removeItem(C.SESSION_AUTORUN_KEY); return true; }
    catch (e) { return false; }
  }

  /* ---------------- 跨标签互斥（D6） ---------------- */

  function lockHolder() {
    var v = gmGet(K.LOCK, null);
    if (!v || typeof v !== 'object') return null;
    if (typeof v.owner !== 'string' || typeof v.ts !== 'number') return null;
    if (Date.now() - v.ts > C.LIMITS.TAB_LOCK_TTL_MS) return null;  /* 过期视为无主 */
    return v;
  }

  function lockAcquire(id) {
    var holder = lockHolder();
    if (holder && holder.owner !== id) return { ok: false, holder: holder.owner };
    gmSet(K.LOCK, { owner: id, ts: Date.now() });
    var check = lockHolder();     /* 回读确认，缩小竞态窗口 */
    if (check && check.owner === id) return { ok: true, holder: id };
    return { ok: false, holder: check ? check.owner : null };
  }

  function lockHeartbeat(id) {
    var holder = lockHolder();
    if (holder && holder.owner !== id) return false;
    gmSet(K.LOCK, { owner: id, ts: Date.now() });
    return true;
  }

  function lockRelease(id) {
    var holder = lockHolder();
    if (!holder) return true;
    if (holder.owner !== id) return false;
    gmSet(K.LOCK, null);
    return true;
  }

  SH.store = Object.freeze({
    isDegraded: function () { return degraded; },
    todayKey: todayKey,
    dailyCounter: dailyCounter,
    cfg: cfg,
    setCfg: setCfg,
    normalizeCfg: normalizeCfg,
    isEnabled: isEnabled,
    setEnabled: setEnabled,
    noticeSeen: noticeSeen,
    markNoticeSeen: markNoticeSeen,
    readExited: readExited,
    markExited: markExited,
    clearExited: clearExited,
    readAutorun: readAutorun,
    markAutorun: markAutorun,
    clearAutorun: clearAutorun,
    lockAcquire: lockAcquire,
    lockHeartbeat: lockHeartbeat,
    lockRelease: lockRelease,
    lockHolder: lockHolder
  });
})(SH);

/* ================= src/core/api.js（0.5.0 已整体删除） ================= */
/* 原题库 API 模块：GM_xmlhttpRequest 请求、X-API-Key 头、答案 schema 校验、2–5s 节流与重试。
 * 0.5.0 按用户要求**全部移除**：
 *   - 不再有 API 地址 / API Key 的保存、校验、掩码；
 *   - 不再有任何 GM_xmlhttpRequest（全脚本唯一网络出口消失，脚本完全不联网）；
 *   - 原调用方（作业/测验模块）一并删除，遇章节测验只等 3s 后点右侧目录跳过。
 * 保留本段注释只为说明"这里是删掉的"，不留任何可执行代码。 */

/* ================= src/core/platform.js ================= */
/* study-helper/src/core/platform.js
 * 平台 / 页面 / 帧角色识别。纯字符串判断：**不查 DOM、不发请求、不读存储**。
 *
 * 安全条目：
 *   2.3 / 3.5   总开关关闭时不激活运行时——本模块必须便宜到"document-start 调用也无感"。
 *   D5          考试页硬阻断：这里给出 mode='exam'，由 main.decide() 拦截，P2~P4 不得自行放行。
 *   3.6         @match 用宽域 + 本文件白名单二次收紧（智慧树子站无法穷举）。
 *
 * 依赖：SH.const（顶层）。
 *
 * 注意：路由规则是"基线"，P2 起必须在真实页面用选择器探针校准。
 *       本文件不做任何猜测性 DOM 探测，避免 document-start 阶段触发样式计算。
 */
(function (SH) {
  'use strict';

  var C = SH.const;
  var PLATFORM = C.PLATFORM;
  var MODE = C.MODE;
  var ROLE = C.ROLE;

  /* 超星：显式列举（@match 与这里必须一致） */
  var CX_HOSTS = ['mooc1.chaoxing.com', 'mooc1-1.chaoxing.com', 'mooc2-ans.chaoxing.com', 'mooc2.chaoxing.com', 'i.chaoxing.com'];

  /* 智慧树：@match 是 *.zhihuishu.com，这里剔除登录页/CDN/静态站。
   * 命中黑名单 → platform=null（返回 unsupported），不注入任何 UI。 */
  var ZHS_BLOCK_SUBDOMAIN = ['passport', 'login', 'ssologin', 'cas', 'cdn', 'static', 'img', 'res', 'file', 'dl', 'download', 'apk'];

  var RE = {
    /* 超星：考试优先判定（顺序不能反，dowork 页也可能带 exam 字样） */
    cxExam: /\/(exam|exam-ans|examtool)\b|reVersionTest|exam\/test/i,
    cxWork: /\/work\/|dowork|selectWorkQuestion|workQuestion|mooc2\/work/i,
    cxStudy: /studentstudy|knowledge\/cards|ananas\/modules|studentcourse|mycourse|chapter|nodepage/i,

    /* 智慧树 */
    zhsExam: /hiexam|onlineexam|examh5|\/exam(\/|$)|examtool|examTable/i,
    zhsWork: /homework|\/work|smartwork|quiz|exercise|testpaper/i,
    zhsStudy: /studyvideo|studyplus|studywisdom|videostudy|stustudy|course-v2|\/hike|fusioncourse|courseware|chapter|lesson/i
  };

  function hostOf(loc) {
    var h = String((loc && loc.hostname) || '').toLowerCase();
    return h.replace(/\.$/, '');
  }

  function isZhsHost(host) {
    if (!/\.zhihuishu\.com$/.test(host) && host !== 'zhihuishu.com') return false;
    var sub = host.replace(/\.zhihuishu\.com$/, '');
    var first = sub.split('.')[0];
    for (var i = 0; i < ZHS_BLOCK_SUBDOMAIN.length; i++) {
      if (first === ZHS_BLOCK_SUBDOMAIN[i]) return false;
    }
    return true;
  }

  function detectPlatform(host) {
    if (CX_HOSTS.indexOf(host) >= 0) return PLATFORM.CX;
    if (isZhsHost(host)) return PLATFORM.ZHS;
    return null;
  }

  function detectMode(platform, url) {
    var pathname = String((url && url.pathname) || '');
    var search = String((url && url.search) || '');
    var probe = pathname + search;

    if (platform === PLATFORM.CX) {
      if (RE.cxExam.test(probe)) return MODE.EXAM;
      if (RE.cxWork.test(probe)) return MODE.WORK;
      if (RE.cxStudy.test(probe)) return MODE.STUDY;
      return MODE.OTHER;
    }
    if (platform === PLATFORM.ZHS) {
      if (RE.zhsExam.test(probe)) return MODE.EXAM;
      if (RE.zhsWork.test(probe)) return MODE.WORK;
      if (RE.zhsStudy.test(probe)) return MODE.STUDY;
      return MODE.OTHER;
    }
    return MODE.OTHER;
  }

  /**
   * @param {Location|{hostname,pathname,search,href}} loc 只读这四个属性
   * @param {boolean} isTop 是否顶帧
   * @returns {{platform:?string, mode:string, role:string, host:string, path:string, reason:string}}
   */
  function detect(loc, isTop) {
    var host = hostOf(loc);
    var platform = detectPlatform(host);
    var path = String((loc && loc.pathname) || '');
    var role = isTop ? ROLE.TOP : ROLE.CHILD;

    if (!platform) {
      return { platform: null, mode: MODE.OTHER, role: role, host: host, path: path, reason: 'unsupported-host' };
    }

    var mode = detectMode(platform, loc);
    return {
      platform: platform,
      mode: mode,
      role: role,
      host: host,
      path: path,
      reason: mode === MODE.OTHER ? 'unknown-page' : 'ok'
    };
  }

  /* D5：考试页硬阻断的唯一判定点。任何模块想放行考试页，都必须先改这里。 */
  function isExamBlocked(info) {
    return !!info && info.mode === MODE.EXAM;
  }

  SH.platform = Object.freeze({
    CX_HOSTS: Object.freeze(CX_HOSTS.slice()),
    ZHS_BLOCK_SUBDOMAIN: Object.freeze(ZHS_BLOCK_SUBDOMAIN.slice()),
    RE: RE,
    detect: detect,
    isExamBlocked: isExamBlocked,
    isZhsHost: isZhsHost
  });
})(SH);

/* ================= src/core/auth-guard.js ================= */
/* study-helper/src/core/auth-guard.js
 * 认证 / 异常提示检测：**纯只读**，命中即让路。
 *
 * 安全条目：
 *   3.4   检测到验证码/人脸/滑块/姓名验证，或"异常操作/请手动完成/检测到脚本"类提示 → 交给 main 执行 pause，
 *         清定时器与观察器，弹提示，**不自动恢复**；认证未通过期间不继续任何学习/答题操作。
 *   3.2   轮询间隔 800ms ± 300ms（500–1100），只查特定选择器，不查全树文本。
 *   D7    第二次触发由 main 处理（本模块只负责"报一次"）。
 *
 * 硬边界（P5 断言）：
 *   A1 对命中节点**不做任何写操作**：不 click、不 remove、不 hide、不改 class/display/visibility。
 *   A2 不读取提示内容并外发（内容只用于本地判定，不进日志正文）。
 *   A3 同一节点只报一次（WeakSet），避免轮询刷屏。
 *   A4 无自动恢复：本模块不等待"认证消失"，只提供 scanOnce 供"继续"按钮手动复检。
 *
 * 未验证项：DIALOG_SEL 里的 `[class*=...]` 宽泛选择器需要在真实页面用 test/probe.js 校准命中量。
 *
 * 依赖：SH.const（顶层）；SH.dom / SH.guards（函数内）。
 */
(function (SH) {
  'use strict';

  var C = SH.const;

  var DIALOG_SEL = [
    '[role="dialog"]',
    '[aria-modal="true"]',
    '.layui-layer',
    '.el-dialog',
    '.el-message-box',
    '.ant-modal',
    '.yidun_popup',
    '.yidun_intellisense',
    '[class*="dialog" i]',
    '[class*="popup" i]',
    '[class*="modal" i]',
    '[class*="mask" i]',
    '[id*="popup" i]',
    '[id*="dialog" i]',
    '[id*="tip" i]'
  ].join(',');

  var PLATFORM_AUTH_SEL = {
    chaoxing: ['#fcqrimg', '.chapterVideoFaceMaskDiv', '[class*="face"]', '[class*="verify"]', 'iframe[src*="captcha"]'],
    zhihuishu: ['.yidun_popup', '.yidun_panel', '[class*="captcha"]']
  };

  /* 正则可读性优先；刻意不用 {n,m} 量词（build.mjs 的扫描器不做正则解析）。 */
  var ANOMALY_RE = /(异常操作|操作异常|检测到(脚本|作弊|外挂|自动化)|请(手动|人工)完成|请勿(使用|开启)[^。]*(脚本|插件|外挂)|行为验证|系统检测到)/;
  var AUTH_RE = /(验证码|滑块|拖动|人脸|活体|实名|身份证|扫码验证|安全校验|安全验证|请完成验证)/;

  var OWN_ID_PREFIX = 'sh-';

  function matchText(text) {
    var t = String(text == null ? '' : text).trim();
    if (!t || t.length > 300) return { auth: false, anomaly: false, reason: 'too-long-or-empty' };
    var auth = AUTH_RE.test(t);
    var anomaly = ANOMALY_RE.test(t);
    return { auth: auth, anomaly: anomaly, reason: auth ? 'auth-text' : (anomaly ? 'anomaly-text' : 'none') };
  }

  function isOwnNode(el) {
    try {
      var n = el;
      for (var i = 0; n && i < 4; i++) {
        if (n.id && String(n.id).indexOf(OWN_ID_PREFIX) === 0) return true;
        if (n.tagName && String(n.tagName).toLowerCase() === 'sh-panel') return true;
        n = n.parentElement;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  function platformAuthHit(platform, doc) {
    var list = PLATFORM_AUTH_SEL[platform] || [];
    for (var i = 0; i < list.length; i++) {
      var nodes;
      try { nodes = doc.querySelectorAll(list[i]); } catch (e) { continue; }
      for (var j = 0; j < nodes.length; j++) {
        var el = nodes[j];
        if (!SH.dom.isVisible(el, doc)) continue;
        var r = SH.dom.rectOf(el);
        if (list[i] === '[class*="face"]' || list[i] === '[class*="verify"]' || list[i] === '[class*="captcha"]') {
          if (!r || r.w < 80 || r.h < 40) continue;
        }
        return { hit: true, el: el, selector: list[i] };
      }
    }
    return { hit: false, el: null, selector: null };
  }

  /**
   * 扫一遍（只读）。可在任何时刻调用，包括 paused 状态下由"继续"按钮触发复检。
   * @returns {{hit:boolean, kind:'auth'|'anomaly'|null, el:?Element, reason:string}}
   */
  function scanOnce(doc, platform) {
    if (!doc) return { hit: false, kind: null, el: null, reason: 'no-doc' };

    var pa = platformAuthHit(platform, doc);
    if (pa.hit) return { hit: true, kind: 'auth', el: pa.el, reason: 'platform-auth:' + pa.selector };

    var nodes;
    try { nodes = doc.querySelectorAll(DIALOG_SEL); } catch (e) { return { hit: false, kind: null, el: null, reason: 'qsa-failed' }; }

    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (isOwnNode(el)) continue;
      if (!SH.dom.isDialogLike(el, doc)) continue;
      var m = matchText(SH.dom.textOf(el));
      if (m.auth) return { hit: true, kind: 'auth', el: el, reason: m.reason };
      if (m.anomaly) return { hit: true, kind: 'anomaly', el: el, reason: m.reason };
    }
    return { hit: false, kind: null, el: null, reason: 'clear' };
  }

  function createGuard(w) {
    var seen = new WeakSet();
    var timer = null;
    var stopped = true;
    var onHit = null;

    function tick(doc, platform) {
      if (stopped) return;
      var hit;
      try { hit = scanOnce(doc, platform); }
      catch (e) { hit = { hit: false }; }
      if (hit.hit) {
        var known = false;
        try { known = seen.has(hit.el); } catch (e) { known = false; }
        if (!known) {
          try { seen.add(hit.el); } catch (e) { /* ignore */ }
          if (typeof onHit === 'function') {
            try { onHit(hit); } catch (e) { /* 回调异常不能打死轮询 */ }
          }
        }
      }
      schedule(doc, platform);
    }

    function schedule(doc, platform) {
      if (stopped) return;
      timer = w.setTimer(function () {
        timer = null;
        tick(doc, platform);
      }, SH.dom.randomIntInRange(C.LIMITS.JITTER_POLL_MS), 'auth-poll');
    }

    return {
      setHandler: function (fn) { onHit = fn; },
      start: function (doc, platform) {
        if (!stopped) return false;
        stopped = false;
        schedule(doc || document, platform);
        return true;
      },
      stop: function () {
        stopped = true;
        if (timer) { w.clearTimer(timer); timer = null; }
        return true;
      },
      scanOnce: function (doc, platform) { return scanOnce(doc || document, platform); },
      isStopped: function () { return stopped; }
    };
  }

  SH.authGuard = Object.freeze({
    DIALOG_SEL: DIALOG_SEL,
    PLATFORM_AUTH_SEL: PLATFORM_AUTH_SEL,
    ANOMALY_RE: ANOMALY_RE,
    AUTH_RE: AUTH_RE,
    matchText: matchText,
    isOwnNode: isOwnNode,
    platformAuthHit: platformAuthHit,
    scanOnce: scanOnce,
    createGuard: createGuard
  });
})(SH);

/* ================= src/core/switch.js ================= */
/* study-helper/src/core/switch.js
 * 总开关：配置真源是 GM_setValue('sh.enabled')，本模块是唯一读写方。
 *
 * 安全条目：
 *   2.3.1 / 3.5  关闭时完全不激活运行时：不注册观察器、不加载解析器、不发请求、不自动播放，只留面板入口。
 *   2.3.6        总开关关闭时，"关闭/退出"按钮置灰。
 *   D8           打开总开关**不自动启动**，只解锁"启动"按钮。
 *
 * 边界：关开关 ≠ 退出。关开关只停运行时（等价于硬 shutdown），面板保留、配置不动、sessionStorage 不动。
 *
 * 依赖：SH.const（顶层）；SH.store / SH.guards（函数内）。
 */
(function (SH) {
  'use strict';

  var listeners = [];

  function isEnabled() { return SH.store.isEnabled(); }

  function setEnabled(next) {
    var v = SH.store.setEnabled(next === true);
    /* 同步广播：不做定时器、不排队。回调异常不得影响开关态。 */
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](v); } catch (e) { /* ignore */ }
    }
    return v;
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  /**
   * 把开关态应用到当前 worker。由 main.js 在开关变化时调用（也可在启动时调一次）。
   * 关闭 = 硬关闭（立即 abort 在途请求），因为"关开关"是用户明确的停止意图，
   * 不是"当前任务走完再停"的软意图。
   */
  function applyTo(w) {
    if (!w) return { ok: false, reason: 'no-worker' };
    var want = isEnabled();
    if (!want) {
      if (w.state !== SH.const.STATE.CLOSED && w.state !== SH.const.STATE.EXITED) {
        w.log('info', '总开关已关闭：停止全部自动化');
        w.shutdown({ hard: true, by: 'master-off' });
      }
      return { ok: true, action: 'closed' };
    }
    return { ok: true, action: 'noop' };
  }

  SH.sw = Object.freeze({
    isEnabled: isEnabled,
    setEnabled: setEnabled,
    subscribe: subscribe,
    applyTo: applyTo
  });
})(SH);

/* ================= src/core/frames.js ================= */
/* study-helper/src/core/frames.js
 * 跨帧通道：顶帧 ↔ 子帧的**双向 source 校验**。子帧默认待命，收到 ARM 才允许操作。
 *
 * 为什么需要它（P0-6 末尾）：
 *   sessionStorage 是 per-origin 的，跨域子帧读不到顶帧的 sh.exited；用户退出后再点导航，
 *   新加载的子帧根本不知道顶帧已退出。若不设这条通道，就会出现"退了还在跑"。
 *
 * 安全条目：
 *   3.12   iframe 递归必须可去重、可取消；本模块只负责通道，递归/去重由 task-loop 负责。
 *   用户要求1  双向校验：
 *        - 子帧：event.source 必须 === 顶帧 window，否则丢弃（防止任意一个 frame 冒充顶帧发 PAUSE/EXIT 反向控制）。
 *        - 顶帧：除 HELLO（注册入口）外，event.source 必须已在注册表里，否则丢弃。
 *   通道只承载控制信号（HELLO/ARM/PAUSE/EXIT/STATE），**不承载**题目、答案、Key、URL 参数。
 *
 * P1 状态：消息协议 + 双向校验 + 注册/广播已实现；waitForArm / 自动 ARM 下发在 P2。
 *
 * 依赖：SH.const（顶层）；SH.guards（函数内）。
 */
(function (SH) {
  'use strict';

  var C = SH.const;

  var NS = 'SH';
  var V = 1;
  var TYPES = ['HELLO', 'ARM', 'PAUSE', 'EXIT', 'STATE', 'PING', 'BYE'];

  function makeMessage(type, extra) {
    var m = { ns: NS, v: V, type: type, t: Date.now() };
    if (extra && typeof extra === 'object') {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) m[k] = extra[k];
      }
    }
    return m;
  }

  /**
   * 校验入站消息。返回消息体或 null。
   * @param {MessageEvent} ev
   * @param {{role:string, topWin:?Window, registry:?Set<Window>}} ctx
   */
  function isValidMessage(ev, ctx) {
    if (!ev || !ev.data || typeof ev.data !== 'object') return null;
    var d = ev.data;
    if (d.ns !== NS || d.v !== V) return null;
    if (TYPES.indexOf(d.type) < 0) return null;

    var src = ev.source;
    if (!src) return null;

    if (ctx && ctx.role === C.ROLE.TOP) {
      /* 注册入口：HELLO 允许来自未知窗口（登记后才认它的其它消息） */
      if (d.type === 'HELLO') return d;
      if (!ctx.registry || !ctx.registry.has(src)) return null;
      return d;
    }

    /* 子帧：只认顶帧。注意 === 比较 window 引用是跨域安全的（不读取属性）。 */
    if (!ctx || src !== ctx.topWin) return null;
    if (d.type === 'HELLO') return null;   /* HELLO 只能由子帧发，不能由顶帧发 */
    return d;
  }

  /**
   * @param {object} opts {role, topWin, registry}
   */
  function createChannel(opts) {
    var o = opts || {};
    var role = o.role === C.ROLE.CHILD ? C.ROLE.CHILD : C.ROLE.TOP;
    var ctx = { role: role, topWin: o.topWin || null, registry: new Set() };
    if (o.registry) ctx.registry = o.registry;

    return {
      role: role,
      registry: ctx.registry,

      /* 收到消息先过校验；调用方只处理返回值非 null 的情况。 */
      accept: function (ev) { return isValidMessage(ev, ctx); },

      register: function (win) {
        if (!win || win === window) return false;
        if (ctx.registry.has(win)) return false;
        ctx.registry.add(win);
        return true;
      },

      unregister: function (win) { return ctx.registry.delete(win); },

      post: function (win, type, extra) {
        if (!win) return false;
        try {
          /* targetOrigin 用 '*'：负载只有控制信号，不含敏感数据；安全性由双向 source 校验保证。
           * 若将来要带数据，必须改成具体 origin，且新增字段前先改本文件头部的边界说明。 */
          win.postMessage(makeMessage(type, extra), '*');
          return true;
        } catch (e) {
          return false;
        }
      },

      broadcast: function (type, extra) {
        var n = 0;
        ctx.registry.forEach(function (win) { if (this.post(win, type, extra)) n++; }, this);
        return n;
      },

      /* 子帧侧：等顶帧 ARM，超时保持待命（fail-safe，宁可不干活）。
       * P2 实现：w.on(window,'message',...) + w.setTimer(CHILD_ARM_TIMEOUT_MS) + teardown 清理。 */
      waitForArm: function (w, timeoutMs) {
        throw SH.guards.notImplemented('frames.waitForArm', 'P2');
      },

      /* 顶帧侧：对全部已注册子帧下发 ARM。P2 实现。 */
      armAll: function () {
        throw SH.guards.notImplemented('frames.armAll', 'P2');
      }
    };
  }

  SH.frames = Object.freeze({
    NS: NS,
    V: V,
    TYPES: Object.freeze(TYPES.slice()),
    makeMessage: makeMessage,
    isValidMessage: isValidMessage,
    createChannel: createChannel
  });
})(SH);

/* ================= src/core/task-loop.js ================= */
/* study-helper/src/core/task-loop.js
 * 任务点遍历与调度：枚举 → 去重 → 串行派发。
 *
 * 安全条目：
 *   3.12   iframe 递归由 platform 采集器负责；本模块用 Set/WeakSet 去重，切页用 AbortController 取消旧任务；
 *          切下一章前等 3–5s 随机（仅 autoNext 开启时）。
 *   2.2    不伪造进度、不跳过视频；任务点顺序固定，不并行。
 *   五.1   派发间隔走 w.setTimer；停止时 abort 采集器的 signal。
 *   2.3.3  自动下一章默认关；开启时受每日次数上限约束。
 *
 * 不变式：
 *   T1 每次派发前 assertCanAct；w.stopping 时不再取新任务。
 *   T2 去重键在派发**之前**写入：失败也不重试同一个任务点，避免死循环。
 *   T3 单轮最多派发 500 个任务（防御性上限）。
 *   T4 采集器抛错 → 记日志并结束本轮，不重试（页面结构问题重试也没用）。
 *
 * 未验证项：真实平台的"下一节"是否需要在同一元素上重新点击（见 platform/chaoxing-study.js 的 TODO）。
 *
 * 依赖：SH.const（顶层）；SH.dom / SH.guards（函数内）。
 */
(function (SH) {
  'use strict';

  var C = SH.const;

  /**
   * @typedef {Object} TaskDescriptor
   * @property {'video'|'doc'|'work'|'turn'} kind
   * @property {string} key      去重键（URL + 任务点文本 + 序号）
   * @property {string} label    面板展示用（不含题干/答案）
   * @property {?Element} el     媒体元素或滚动容器
   * @property {boolean} [turn]  是否是"切章"动作（需要 3–5s 间隔）
   */

  function createLoop(w, opts) {
    var o = opts || {};
    var collector = typeof o.collector === 'function' ? o.collector : null;
    var dispatch = typeof o.dispatch === 'function' ? o.dispatch : null;

    var seenKeys = new Set();
    var aborter = null;
    var running = false;
    var stats = { total: 0, done: 0, failed: 0, skipped: 0, lastError: null, current: null, epoch: 0 };

    function stop() {
      running = false;
      if (aborter) { try { aborter.abort(); } catch (e) { /* ignore */ } aborter = null; }
      return true;
    }

    function collect() {
      if (!collector) return [];
      if (aborter) { try { aborter.abort(); } catch (e) { /* ignore */ } }
      aborter = typeof AbortController === 'function' ? new AbortController() : null;
      var list = collector({ w: w, signal: aborter ? aborter.signal : null });
      return Array.isArray(list) ? list : [];
    }

    function pick() {
      var list = collect();
      stats.total = list.length;
      stats.epoch = w.epoch;
      for (var i = 0; i < list.length; i++) {
        var task = list[i];
        if (!task) continue;
        var key = String(task.key || (task.kind + ':' + i));
        if (seenKeys.has(key)) { stats.skipped++; continue; }
        seenKeys.add(key);           /* T2：先标记再派发 */
        return task;
      }
      return null;
    }

    function gap() {
      return SH.dom.randomIntInRange(C.LIMITS.JITTER_CLICK_MS);
    }

    function turnGap() {
      return SH.dom.randomIntInRange(C.LIMITS.NEXT_CHAPTER_GAP_MS);
    }

    function run() {
      if (running) return Promise.resolve({ ok: false, why: 'already-running' });
      running = true;

      function step() {
        if (!running) return Promise.resolve({ ok: false, why: 'stopped' });
        if (w.state === C.STATE.PAUSED) return Promise.resolve({ ok: true, why: 'paused' });   /* 挂起 ≠ 结束 */
        if (stats.done + stats.failed >= 500) return Promise.resolve({ ok: false, why: 'cap' });
        if (!w.alive()) return Promise.resolve({ ok: false, why: 'dead' });
        if (w.stopping) return Promise.resolve({ ok: false, why: 'stopping' });
        if (!SH.guards.canAct(w, w.epoch)) return Promise.resolve({ ok: false, why: 'blocked' });

        var task;
        try { task = pick(); }
        catch (e) {
          stats.lastError = String((e && e.message) || e);
          if (w.log) w.log('error', '任务点枚举失败：' + stats.lastError);
          return Promise.resolve({ ok: false, why: 'collector-error' });
        }

        if (!task) return Promise.resolve({ ok: true, why: 'empty' });

        stats.current = task.label || task.kind;
        if (w.log) w.log('info', '任务点：' + stats.current);

        if (!dispatch) return Promise.resolve({ ok: false, why: 'no-dispatch' });

        var p;
        try { p = dispatch(task, w); }
        catch (e) { p = Promise.reject(e); }

        return Promise.resolve(p).then(function (r) {
          if (r && r.closing) {
            /* 关闭流程主动打断：算"已收尾"，不要记成任务点失败（避免 video-interrupted 噪音） */
            stats.done++;
            stats.current = null;
            return { ok: true, why: 'closing' };
          }
          if (r && r.ok === false) {
            stats.failed++;
            stats.lastError = r.error || 'dispatch-failed';
            if (w.log) w.log('warn', '任务点跳过：' + stats.lastError);
          } else {
            stats.done++;
          }
          stats.current = null;
          if (!running || !w.alive()) return { ok: false, why: 'stopped' };
          var wait = task.turn ? turnGap() : gap();
          return SH.dom.sleep(w, wait).then(function (slept) {
            if (!slept || !running) return { ok: false, why: 'stopped' };
            return step();
          });
        }, function (err) {
          stats.failed++;
          stats.lastError = String((err && err.message) || err);
          stats.current = null;
          if (!running || !w.alive()) return { ok: false, why: 'stopped' };
          return SH.dom.sleep(w, gap()).then(function (slept) {
            if (!slept || !running) return { ok: false, why: 'stopped' };
            return step();
          });
        });
      }

      return step().then(function (r) {
        running = false;
        return r;
      }, function (err) {
        running = false;
        stats.lastError = String((err && err.message) || err);
        return { ok: false, why: 'exception' };
      });
    }

    return {
      start: run,
      stop: stop,
      isRunning: function () { return running; },
      reset: function () { seenKeys = new Set(); stats = { total: 0, done: 0, failed: 0, skipped: 0, lastError: null, current: null, epoch: w.epoch }; return true; },
      snapshot: function () {
        return {
          running: running,
          total: stats.total,
          done: stats.done,
          failed: stats.failed,
          skipped: stats.skipped,
          current: stats.current,
          lastError: stats.lastError
        };
      },
      _internals: { seenKeys: seenKeys }
    };
  }

  SH.taskLoop = Object.freeze({ createLoop: createLoop });
})(SH);

/* ================= src/core/media.js ================= */
/* study-helper/src/core/media.js
 * 视频/音频播放子机：只在"该播"和"该停"之间做状态迁移，不做任何拟人化。
 *
 * 安全条目：
 *   3.7   **绝不读写 volume / muted / defaultMuted**（连读都不读）。本文件里这两个词只出现在注释中，
 *         build.mjs --check 扫的是剥离注释后的代码，出现即构建失败。
 *   3.7   首次 play() 被 NotAllowedError 拦截 → 不静音绕过，进 waiting-manual-play，不重试 play()。
 *   3.8   倍速默认 1.0，可 1.0–1.5；>1.5 拒绝并告警；每个任务点只设一次（不频繁改）。
 *   3.9   监听 pause 自动恢复，上限 3 次；超过 → w.pause(MANUAL_PLAY)，不再重试。
 *   3.10  visibilityState === 'hidden' → 主动 pause + w.pause(VISIBILITY)；回来时才允许自动恢复。
 *   2.1.5 ended 后等 1–3s 再切下一任务点（不立即跳，也不伪造进度）。
 *   3.7   切任务点直接 play()，**不重置 currentTime**（本文件从不给 currentTime 赋值）。
 *   2.1   不监听 seeking 强制跳转，不伪造 timeupdate，不 reload，不 load()。
 *
 * 不变式：
 *   V1 全文件只有 requestPlay() 一处调用 el.play()。
 *   V2 进入 waiting 后不再调用 play()（唯一的恢复信号是媒体自己发出 'playing'）。
 *   V3 所有回调第一行判 alive()（epoch + 已脱离）。
 *   V4 媒体元素按"鸭子类型"接受（只要 play/pause/addEventListener/playbackRate 在），
 *      这样测试可以用假播放器跑，不需要真的解码视频。
 *
 * P4 待接：createVisibilitySupervisor 的 unbind() 必须在 onClosed / onExit 里调用
 *          （它是唯一"故意不进 worker 账本"的监听，见 DECISIONS 例外清单）。
 *
 * 依赖：SH.const（顶层）；SH.store / SH.dom / SH.guards（函数内）。
 */
(function (SH) {
  'use strict';

  var C = SH.const;
  var L = C.LIMITS;
  var S = C.STATE;

  /* 子机内部状态，与 worker 的 FSM 分开记：worker 管"能不能动"，这里管"播放器到哪一步了"。 */
  var P = Object.freeze({
    DETACHED: 'detached',
    ATTACHED: 'attached',
    PLAYING: 'playing',
    WAITING: 'waiting-manual',
    DONE: 'done'
  });

  function isMediaLike(el) {
    return !!el
      && typeof el.play === 'function'
      && typeof el.pause === 'function'
      && typeof el.addEventListener === 'function'
      && typeof el.removeEventListener === 'function';
  }

  /**
   * @param {object} w worker
   * @param {object} [opts] {onState, onEnded, onNeedManualPlay, onAdvance, delays:{resume, ended}}
   *   delays 只给测试缩短等待用；不传则用 const.LIMITS 的正式区间。
   */
  function createPlayer(w, opts) {
    var o = opts || {};
    var delays = o.delays || null;

    var el = null;
    var ep = 0;
    var state = P.DETACHED;
    var bound = [];            /* w.on 返回的条目，detach 时逐个 off */
    var intentionalPause = false;
    var playAttempts = 0;
    var rateApplied = false;
    var rateUsed = 1;
    var resumeTimer = null;
    var endedTimer = null;
    var waitingSince = 0;
    var waiters = [];

    function settleWaiters(ok) {
      var list = waiters;
      waiters = [];
      for (var i = 0; i < list.length; i++) {
        try { list[i](ok); } catch (e) { /* ignore */ }
      }
    }

    /* 暂停/关闭/退出时，等"播完"的人必须被放出来，否则 task-loop 会一直挂着 */
    w.addTeardownHook(function () { settleWaiters(false); });

    function log(msg) {
      try { w.log('media', msg); } catch (e) { /* ignore */ }
    }

    function alive() {
      return !!el && state !== P.DETACHED && w.alive(ep);
    }

    function notify(ev) {
      var map = {
        state: o.onState,
        ended: o.onEnded,
        'need-manual-play': o.onNeedManualPlay,
        advance: o.onAdvance,
        'play-failed': o.onPlayFailed,
        'media-error': o.onMediaError
      };
      var fn = map[ev.type];
      if (typeof fn === 'function') {
        try { fn(ev); } catch (e) { log('callback error: ' + (e && e.message)); }
      }
    }

    function setSub(next) {
      if (state === next) return;
      state = next;
      notify({ type: 'state', state: next });
    }

    function bind(target, type, fn) {
      bound.push(w.on(target, type, fn));
    }

    function unbindAll() {
      for (var i = 0; i < bound.length; i++) w.off(bound[i]);
      bound = [];
    }

    function clearResumeTimer() {
      if (resumeTimer) { w.clearTimer(resumeTimer); resumeTimer = null; }
    }

    function clearEndedTimer() {
      if (endedTimer) { w.clearTimer(endedTimer); endedTimer = null; }
    }

    /* ---------------- 倍速：每个任务点只设一次 ---------------- */

    function applyRateOnce() {
      if (rateApplied || !el) return;
      var speed = SH.store.cfg().speed;
      var v = SH.dom.clamp(speed, L.SPEED_MIN, L.SPEED_MAX);
      try { el.playbackRate = v; } catch (e) { log('playbackRate 设置失败'); }
      rateUsed = v;
      rateApplied = true;
    }

    /* ---------------- 播放 ---------------- */

    /* 全文件唯一的 el.play() 调用点（不变式 V1）。 */
    function requestPlay(reason) {
      if (!alive()) return { ok: false, error: 'not-alive' };
      if (!SH.guards.canAct(w, ep)) return { ok: false, error: 'blocked' };
      if (state === P.WAITING) return { ok: false, error: 'waiting-manual' };

      playAttempts++;
      var p;
      try {
        p = el.play();
      } catch (err) {
        return handlePlayError(err, reason);
      }

      if (p && typeof p.then === 'function') {
        p.then(function () {
          if (!alive()) return;
          setSub(P.PLAYING);
        }).catch(function (err) {
          handlePlayError(err, reason);
        });
        return { ok: true, pending: true };
      }

      /* 老式同步 play() */
      if (alive()) setSub(P.PLAYING);
      return { ok: true, pending: false };
    }

    /* 首次被拦截：**不静音、不重试 play()**，交给用户点一次（安全条目 3.7）。 */
    function enterWaiting(errName) {
      if (!alive()) return;
      if (state === P.WAITING) return;
      setSub(P.WAITING);
      waitingSince = Date.now();
      if (w.state !== S.WAITING_MANUAL_PLAY) {
        try { w.transition(S.WAITING_MANUAL_PLAY); } catch (e) { /* 状态机已不允许，保持现状 */ }
      }
      log('play() 被拦截（' + errName + '）：不静音绕过，等用户手动点一次播放');
      notify({ type: 'need-manual-play', name: errName });
    }

    function handlePlayError(err, reason) {
      var name = (err && err.name) || 'Error';
      /* pause() 与 play() 的竞态会抛 AbortError，是正常现象，不算失败 */
      if (name === 'AbortError') return { ok: false, aborted: true };
      if (name === 'NotAllowedError') { enterWaiting(name); return { ok: false, needManual: true }; }

      log('play() 失败：' + name + ' (' + (reason || '-') + ')');
      notify({ type: 'play-failed', name: name });

      /* 播不起来了：**必须**结束 waitFinished 的等待，否则它会一直等 'ended' → 任务挂死。
       * 这不是"重试"：等它落到调用方去决定（main 对 NotSupportedError 是跳过 + 重新扫描）。 */
      settleWaiters(false);

      return { ok: false, error: name };
    }

    /* ---------------- 媒体事件 ---------------- */

    function onPlay() {
      if (!alive()) return;
      if (state === P.WAITING) setSub(P.PLAYING);
    }

    function onPlaying() {
      if (!alive()) return;
      /* 真正开始播放才是"人工恢复成功"的证据（不是用户点了某个按钮）。 */
      if (state === P.WAITING) {
        log('检测到已开始播放：恢复自动续播');
        setSub(P.PLAYING);
      }
      if (w.state === S.WAITING_MANUAL_PLAY) {
        try { w.transition(S.PLAYING); } catch (e) { /* ignore */ }
      }
      /* DONE 只代表"本页暂无更多任务点"，不是播放器终态：媒体自己响起 playing 时必须能回到 PLAYING（Bug 2）。 */
      if (w.state === S.DONE) {
        try { w.transition(S.PLAYING); } catch (e) { /* ignore */ }
      }
      /* 注意：这里**不**重置 resumeCount。上限是"每个任务点 3 次"，不是"每次成功播放后重新计数"，
       * 否则平台每播几秒暂停一次就能无限自动恢复（那等于自己造了个死循环）。
       * 计数只在 attach 新任务点 / worker.reinit 时归零。 */
    }

    function onPause() {
      if (!alive()) return;
      if (intentionalPause) { intentionalPause = false; return; }
      if (el && el.ended) return;
      if (state === P.WAITING) return;                 /* 等人工时用户自己暂停，不抢 */
      if (w.state === S.WAITING_MANUAL_PLAY) return;
      if (w.stopping) return;                          /* 软关闭中不恢复 */
      if (w.state === S.PAUSED) return;

      var n = w.incResumeCount();
      if (n > L.PAUSE_RESUME_MAX) {
        clearResumeTimer();
        log('播放被打断 ' + (n - 1) + ' 次，停止自动恢复，交给用户');
        w.pause(C.PAUSE_REASON.MANUAL_PLAY);
        notify({ type: 'resume-limit', count: n - 1 });
        return;
      }

      notify({ type: 'auto-resume', count: n });
      clearResumeTimer();
      var gap = delays && delays.resume ? SH.dom.randomIntInRange(delays.resume) : SH.dom.randomIntInRange(L.JITTER_CLICK_MS);
      resumeTimer = w.setTimer(function () {
        resumeTimer = null;
        requestPlay('resume#' + n);
      }, gap, 'media-resume');
    }

    function onEnded() {
      if (!alive()) return;
      setSub(P.DONE);
      clearResumeTimer();
      notify({ type: 'ended' });
      /* ended 后等 1–3s 再切下一任务点（安全条目 2.1.5） */
      var gap = delays && delays.ended ? SH.dom.randomIntInRange(delays.ended) : SH.dom.randomIntInRange(L.ENDED_GAP_MS);
      endedTimer = w.setTimer(function () {
        endedTimer = null;
        if (!alive()) { settleWaiters(false); return; }
        /* 单个任务点播完 ≠ 整门课完成（Bug 2）：
         * 这里**绝不能** transition(DONE)。DONE 是"本页确实没有可做任务"，一旦在这里锁死，
         * 下一段视频 attach 时无法回到 PLAYING，面板会永久显示"已完成"。
         * 播完只回到"运行中"的空闲态，下一个任务点由 task-loop 继续派发。 */
        if (w.state === S.PLAYING) {
          try { w.transition(S.IDLE); } catch (e) { /* ignore */ }
        }
        notify({ type: 'advance' });
        settleWaiters(true);
      }, gap, 'media-advance');
    }

    function onError() {
      if (!alive()) return;
      /* 只上报，不 reload、不改 currentTime、不换源 */
      log('媒体错误事件（不重载、不跳转）');
      notify({ type: 'media-error' });
    }

    function onStalled() {
      if (!alive()) return;
      log('媒体 stalled（只记录）');
    }

    /* ---------------- 对外 ---------------- */

    function detach(silent) {
      clearResumeTimer();
      clearEndedTimer();
      settleWaiters(false);
      unbindAll();
      el = null;
      var was = state;
      state = P.DETACHED;
      rateApplied = false;
      intentionalPause = false;
      if (!silent && was !== P.DETACHED) notify({ type: 'state', state: P.DETACHED });
      return true;
    }

    function attach(element) {
      if (!isMediaLike(element)) return { ok: false, error: 'not-media-like' };
      if (el === element && state !== P.DETACHED) return { ok: true, reused: true };

      detach(true);
      el = element;
      ep = w.epoch;
      setSub(P.ATTACHED);
      intentionalPause = false;
      playAttempts = 0;
      rateApplied = false;
      w.resetResumeCount();     /* 新任务点 = 新的 3 次预算（安全条目 3.9） */

      bind(el, 'play', onPlay);
      bind(el, 'playing', onPlaying);
      bind(el, 'pause', onPause);
      bind(el, 'ended', onEnded);
      bind(el, 'error', onError);
      bind(el, 'stalled', onStalled);

      applyRateOnce();

      /* 先声明"我要开始播了"，再调 play()：这样 NotAllowedError 时是 playing → waiting（P0-4 的图），
       * 不会出现 idle → waiting 这种状态机不允许的转换。
       * DONE 也必须能回到 PLAYING：它只是"本页暂无任务"，不是播放器终态（Bug 2）。 */
      if ((w.state === S.IDLE || w.state === S.DONE) && SH.guards.canAct(w, ep)) {
        try { w.transition(S.PLAYING); } catch (e) { /* ignore */ }
      }

      var r = requestPlay('attach');
      return { ok: true, play: r };
    }

    /* 主动暂停（切后台、用户点暂停、关闭流程）。标记 intentional，避免被当成"外部打断"去恢复。 */
    function pause() {
      if (!el) return false;
      clearResumeTimer();
      settleWaiters(false);
      intentionalPause = true;
      try { el.pause(); } catch (e) { /* ignore */ }
      return true;
    }

    function setRate(v) {
      var n = Number(v);
      if (!isFinite(n)) return { ok: false, error: 'invalid-rate' };
      if (n > L.SPEED_MAX) {
        return { ok: false, warn: '超过 ' + L.SPEED_MAX + ' 倍不安全，本次不生效', applied: rateUsed };
      }
      if (n < L.SPEED_MIN) n = L.SPEED_MIN;
      if (rateApplied) {
        return { ok: false, warn: '本次任务点已设定倍速，切换任务点后才生效', applied: rateUsed };
      }
      if (!el) return { ok: false, error: 'no-media' };
      try { el.playbackRate = n; } catch (e) { return { ok: false, error: 'set-failed' }; }
      rateApplied = true;
      rateUsed = n;
      return { ok: true, applied: n };
    }

    function snapshot() {
      return {
        sub: state,
        attached: !!el,
        rate: rateUsed,
        rateApplied: rateApplied,
        resumeCount: w.resumeCount,
        playAttempts: playAttempts,
        waitingMs: state === P.WAITING && waitingSince ? (Date.now() - waitingSince) : 0,
        epoch: ep
      };
    }

    return {
      attach: attach,
      detach: detach,
      pause: pause,
      play: function () { return requestPlay('manual'); },
      setRate: setRate,
      snapshot: snapshot,
      /* 只读：给 task-loop 判断"这个任务点结束了没有" */
      isDone: function () { return state === P.DONE; },
      /* 等"这个任务点播完"：ended → 1–3s → true；被打断/关闭 → false。
       * task-loop 靠它保证"视频没播完就不切下一节"。 */
      waitFinished: function () {
        if (state === P.DONE) return Promise.resolve(true);
        return new Promise(function (resolve) { waiters.push(resolve); });
      },
      /* 外部判定"已经播完"时的放行口（2026-10-31）：
       * 用 `el.ended` / `currentTime >= duration` 兜底 —— 有些播放器（或元素被平台替换时）
       * 根本不会派发 ended，只看事件会让 waitFinished 永久挂着，表现为"视频播到 100% 但脚本无反应"。
       * 只放行等待者，**不改播放状态、不碰 media 元素、不 seek、不重载**。 */
      forceFinish: function (ok) {
        settleWaiters(ok !== false);
        return true;
      },
      _internal: { P: P, waiting: function () { return state === P.WAITING; } }
    };
  }

  /**
   * 切屏监督器：**故意不进 worker 账本**的唯一监听（见 DECISIONS 例外清单）。
   * 原因：w.pause() 会摘掉账本里的监听，而"切回前台要恢复"恰恰需要在 paused 状态下还能收到事件。
   * 代价：必须由调用方在 onClosed / onExit 里 unbind()，否则违反 3.13。
   *
   * @param {object} w worker
   * @param {{document?:Document, onHidden?:Function, onVisible?:Function}} opts
   */
  function createVisibilitySupervisor(w, opts) {
    var o = opts || {};
    var doc = o.document || (typeof document !== 'undefined' ? document : null);
    var bound = false;

    function handle() {
      if (!doc) return false;
      var hidden = doc.visibilityState === 'hidden';
      if (hidden) {
        if (w.state === S.CLOSED || w.state === S.EXITED || w.state === S.PAUSED) return false;
        if (typeof o.onHidden === 'function') { try { o.onHidden(); } catch (e) { /* ignore */ } }
        w.pause(C.PAUSE_REASON.VISIBILITY);
        return true;
      }
      /* 回到前台：唯一允许自动恢复的 reason（不涉及任何检测事件） */
      if (w.state === S.PAUSED && w.pausedReason === C.PAUSE_REASON.VISIBILITY) {
        if (typeof o.onVisible === 'function') { try { o.onVisible(); } catch (e) { /* ignore */ } }
        return true;
      }
      return false;
    }

    return {
      bind: function () {
        if (bound || !doc) return false;
        bound = true;
        doc.addEventListener('visibilitychange', handle, false);
        return true;
      },
      unbind: function () {
        if (!bound || !doc) return false;
        bound = false;
        doc.removeEventListener('visibilitychange', handle, false);
        return true;
      },
      isBound: function () { return bound; },
      /* 只读触发入口，给测试用；不改变行为 */
      _handle: handle
    };
  }

  SH.media = Object.freeze({
    P: P,
    isMediaLike: isMediaLike,
    createPlayer: createPlayer,
    createVisibilitySupervisor: createVisibilitySupervisor
  });
})(SH);

/* ================= src/core/reader.js ================= */
/* study-helper/src/core/reader.js
 * 文档 / PPT 阅读子机：平滑分步滚动，到底停留再标记完成。
 *
 * 安全条目：
 *   3.11   平滑分步滚动，每步间隔 2–3.5s 随机（0.5.0 从 300–800ms 抬高）；到底停留 3–5s 才标记完成；**禁止一步到底**。
 *   3.2    不使用 MutationObserver 扫全树；只在需要时读 scrollHeight/clientHeight。
 *   五.1   所有等待走 SH.dom.sleep（账本内定时器），pause/close/exit 时立即解除，不会悬挂。
 *   3.6    只读文本，不写 DOM 内容。
 *
 * 不变式：
 *   R1 单步位移被 clamp 到 READER_STEP_PX（240–520px）且不超过视口的 55%，永远不可能"一屏到底"。
 *   R2 每步前后都校验 canAct(w, ep)：暂停/等人工/关闭时立刻停，不"把这一步走完"。
 *   R3 有步数上限（READER_MAX_STEPS），防止懒加载页面无限滚。
 *   R4 不点击任何东西、不触发平台的"下一页"按钮（翻页属于 task-loop 的职责）。
 *
 * 未验证项：真实课件容器的 `overflow` 判定（有的平台用内层 div 滚动、有的是 document）。
 *           目前取 `opts.container` 或 `document.scrollingElement`，探针结果回来后按平台选择器替换。
 *
 * 依赖：SH.const（顶层）；SH.dom / SH.guards（函数内）。
 */
(function (SH) {
  'use strict';

  var C = SH.const;
  var L = C.LIMITS;

  function isScrollable(el) {
    return !!el && typeof el.scrollTop === 'number' && typeof el.scrollHeight === 'number' && typeof el.clientHeight === 'number';
  }

  /**
   * @param {object} w worker
   * @param {{delays?:{step:number[],dwell:number[]}}} [opts] delays 仅测试用
   */
  function createReader(w, opts) {
    var o = opts || {};
    var delays = o.delays || null;

    var el = null;
    var ep = 0;
    var running = false;
    var finished = false;
    var steps = 0;
    var state = { steps: 0, height: 0, view: 0, atBottom: false };

    function alive() { return !!el && w.alive(ep); }

    function metrics() {
      var top = el.scrollTop || 0;
      var height = el.scrollHeight || 0;
      var view = el.clientHeight || 0;
      return { top: top, height: height, view: view };
    }

    function atBottom() {
      var m = metrics();
      return m.height - (m.top + m.view) <= 4;
    }

    /* 单步位移：视口 55%，再 clamp 到 240–520px（不变式 R1） */
    function stepSize() {
      var m = metrics();
      var base = m.view * 0.55;
      var px = SH.dom.clamp(base, L.READER_STEP_PX[0], L.READER_STEP_PX[1]);
      return Math.max(60, Math.round(px * (0.85 + Math.random() * 0.3)));
    }

    function stepGap() {
      return delays && delays.step ? SH.dom.randomIntInRange(delays.step) : SH.dom.randomIntInRange(L.READER_STEP_MS);
    }

    function dwellGap() {
      return delays && delays.dwell ? SH.dom.randomIntInRange(delays.dwell) : SH.dom.randomIntInRange(L.READER_BOTTOM_DWELL_MS);
    }

    function scrollStep() {
      var m = metrics();
      var next = Math.min(m.height, m.top + stepSize());
      try {
        el.scrollTop = next;
      } catch (e) {
        try { el.scrollTo({ top: next, behavior: 'smooth' }); } catch (e2) { /* 只读容器，放弃 */ }
      }
      steps++;
      state = { steps: steps, height: m.height, view: m.view, atBottom: atBottom() };
      return next;
    }

    /* 到底停留 3–5s 再标记完成（3.11） */
    function dwellThenFinish() {
      return SH.dom.sleep(w, dwellGap()).then(function (ok) {
        if (!ok || !alive()) return false;
        finished = true;
        /* 单篇文档读完 ≠ 整门课完成（Bug 2）：回到"运行中"的空闲态，
         * 由 task-loop 继续派发下一个任务点。全局 DONE 只代表"本页确实没有任务"。 */
        if (w.state === C.STATE.READING) {
          try { w.transition(C.STATE.IDLE); } catch (e) { /* ignore */ }
        }
        return true;
      });
    }

    function runOnce() {
      if (!running || !alive() || !SH.guards.canAct(w, ep)) return Promise.resolve(false);
      return SH.dom.sleep(w, stepGap()).then(function (ok) {
        if (!ok || !running || !alive() || !SH.guards.canAct(w, ep)) return false;

        var m = metrics();
        state.height = m.height;
        state.view = m.view;

        if (steps >= L.READER_MAX_STEPS) return dwellThenFinish();
        if (m.height <= m.view + 4) return dwellThenFinish();   /* 无可滚内容 */

        if (atBottom()) return dwellThenFinish();

        scrollStep();
        return runOnce();
      });
    }

    return {
      attach: function (container) {
        var target = container || (typeof document !== 'undefined' ? document.scrollingElement || document.documentElement : null);
        if (!isScrollable(target)) return { ok: false, error: 'not-scrollable' };
        el = target;
        ep = w.epoch;
        steps = 0;
        finished = false;
        running = false;
        var m = metrics();
        state = { steps: 0, height: m.height, view: m.view, atBottom: atBottom() };
        return { ok: true, metrics: m };
      },

      /* 返回 Promise<boolean>：true = 读到低并停留完毕；false = 被打断/未开始 */
      start: function () {
        if (!alive()) return Promise.resolve(false);
        running = true;
        if (w.state === C.STATE.IDLE && SH.guards.canAct(w, ep)) {
          try { w.transition(C.STATE.READING); } catch (e) { /* ignore */ }
        }
        return runOnce();
      },

      stop: function () {
        running = false;
        return true;
      },

      detach: function () {
        running = false;
        el = null;
        return true;
      },

      isDone: function () { return finished; },
      snapshot: function () {
        return { steps: steps, height: state.height, view: state.view, atBottom: state.atBottom, running: running, done: finished, epoch: ep };
      }
    };
  }

  SH.reader = Object.freeze({
    isScrollable: isScrollable,
    createReader: createReader
  });
})(SH);

/* 0.5.0 已删除：src/core/matcher.js（答案匹配，题库功能整体移除） */

/* 0.5.0 已删除：src/core/parser.js（题目解析，题库功能整体移除） */

/* ================= src/platform/chaoxing-study.js ================= */
/* study-helper/src/platform/chaoxing-study.js
 * 学习通章节页：递归 iframe 找媒体 → 播完 → 下一节 / 下一个未完成任务点。
 *
 * 探针结论（用户提供，2026-10）：
 *   - 顶层**没有** <video>；真实媒体在 top/0（knowledge/cards）再嵌 top/0/0（ananas/modules/video）。
 *   - "下一节" 按钮 id = #prevNextFocusNext，文本 "下一节"。
 *   - 侧边栏任务点是 .posCatalog_select；任务点的 .posCatalog_name 必须含 getTeacherAjax。
 *   - "下一节" 的实参形态（2026-10-30 真机 DOM，**视频页**）：
 *     onclick="PCount.next('2','1261250707','267856131','156668017','',true)"
 *     → 6 个参数，第 6 个是**裸布尔 true**。少传它，函数不报错但页面不动。
 *   - **视频页这条路径已验证可用，不许改**（用户裁决 2026-10-30）。
 *   - 题目页不同：底部"下一节"在隔离 iframe / 防作弊脚本里，顶层 DOM 没有
 *     #prevNextFocusNext、也拿不到 PCount → 放弃按钮，走右侧目录下一个任务点（原生 .click()）。
 *   - 分流硬规则（2026-10-31 重构为「扫描 → 分类 → 按类处理」）：
 *     R0 **拦截框最高优先级**：文案含"当前章节还有任务点未完成"的全屏遮罩/弹窗，命中就只产出
 *        `mode:'intercept'` 并立刻返回（不找视频、不调 PCount.next、不点目录）；处理方式是
 *        **只点一次**框内【下一节】，页面不动就转人工，绝不重试。
 *     S1 每次扫描先等 **10s**（`SCAN_WAIT_MS`），再按 DOM 分成四类并打日志：
 *        真实视频页 / 懒加载视频页 / 章节测验页 / 其他界面。
 *     S2 真实视频页：产出 `video` 任务（main 接管 play）；播完后取同批次的 `next` → `PCount.next`。
 *     S3 懒加载视频页：产出 `mode:'wake'` —— 先点 `button.vjs-big-play-button`（带坐标鼠标三连），
 *        没有它就点 `#videoContainer` 容器本身；然后等 ≤15s 让 `<video>` 注入。
 *     S4 章节测验页：等 **3s** → `catalogFlow()` 点右侧目录下一个任务点。
 *     S5 其他界面：等 **60s** 重扫描；仍然是其他界面 → `mode:'force-catalog'` 强制点右侧目录。
 *     S6 右侧目录找不到（`no-active` / `no-catalog`）：等 **10s** 重试，最多 **3 次**；
 *        3 次全失败 → `finish(false,'catalog-unavailable')` → `paused` + 黄条。
 *     R3 `next` 是"调完就放行"：PCount.next 调用没抛错 → 等 3–5s → 返回 `{ok:true,'force-rescan'}`，
 *        由 task-loop 重新 collect 接管。**不拿 pageChanged 当成功判据**（超星局部刷新常常检测不到）。
 *
 * 安全条目：
 *   3.12  iframe 递归 + 深度/数量上限；不并发遍历；跨域帧只记录不越权。
 *   2.1   按顺序处理；**视频没播完不切下一节**（由 main 等 media.waitFinished）。
 *   2.2   "下一章" 类跳转需显式开启 autoNext；每日上限 30 次（GM 存储 + 本地日期）。
 *   3.7   只把 <video>/<audio> 交给 SH.media（不碰 volume/muted）。
 *   2.2   题目页**不碰底部按钮**：只用侧边栏下一个任务点，跳不动就挂起等人工。
 *
 * 点击策略（2026-10-30 用户裁决）：
 *   - 视频/文档页：只调全局函数 PCount.next（零合成点击，已可用，**不要动**）。
 *   - 题目页 / 目录树任务点：只用原生 element.click()。
 *   - **禁止** dispatchEvent 五连击、禁止改写 alert/confirm、禁止 remove() 遮罩。
 *
 * 不变式：
 *   X1 递归深度 ≤4，单次扫描 iframe ≤12 个，避免畸形页面把 CPU 打满。
 *   X2 跨域帧抛异常 → 记录到 crossOrigin[]，不重试、不猜。
 *   X3 任一 turn 动作执行前复查目标是否仍在文档里（页面可能已导航）。
 *   X4 不点击侧边栏的"已完成"项（.icon_Completed / 文案 / jobUnfinishCount / orangeNew 判定）。
 *
 * 未验证项：
 *   - 跨域帧场景（若 video 落在跨域 ananas 域名，顶层拿不到，需要子帧握手，见 frames.js 的 TODO）。
 *   - 侧边栏点击后是整页刷新还是 iframe 内切换（本实现两种情况都靠"重新扫描"兼容）。
 *
 * 依赖：SH.const（顶层）；SH.dom / SH.media / SH.store / SH.guards（函数内）。
 */
(function (SH) {
  'use strict';

  var C = SH.const;

  var SEL = Object.freeze({
    media: 'video,audio',
    next: '#prevNextFocusNext',
    catalog: '.posCatalog_select',
    question: '.TiMu, .Zy_TItle',
    doc: '.ans-attach-ct, .pdfContainer, .ans-attach-online, #docBox, .pptPlayer',
    /* "任务点未完成"业务拦截框的候选容器（文案门见 findInterceptDialog）。
     * 2026-10-31：加 mask/overlay/layer + el-message-box + id 命中 —— 真机上这个提示是
     * **全屏遮罩**，class/id 五花八门（截图里就是 Element/layui 风格的"提示"框）。
     * 认不出容器时还有一层兜底：正文含这句话 + 找非底部按钮，见 findAnySkipButton。 */
    dialog: '[role="dialog"], [aria-modal="true"], .el-dialog, .el-message-box, .layui-layer, .ant-modal, .yidun_popup, [class*="dialog" i], [class*="popup" i], [class*="modal" i], [class*="mask" i], [class*="overlay" i], [class*="layer" i], [id*="dialog" i], [id*="popup" i]'
  });

  var MAX_DEPTH = 4;
  var MAX_FRAMES = 12;

  /* ---------------- 业务拦截框（"当前章节还有任务点未完成，是否去完成？"） ----------------
   * 红线（用户裁决）：
   *   R1 只认文案含 `当前章节还有任务点未完成` 的浮层；文案不符一律不碰（账号异常/验证码/其它弹窗都不动）。
   *   R2 只点该浮层内部**文本严格等于**"下一节"的元素；绝不点"去学习/确定/取消"。
   *   R3 文案对得上但没有"下一节"按钮 → 不降级、不点别的，直接挂起等人工。
   *   R4 同一页面最多点 3 次；页面没变化就 latch，**禁止反复点**。
   *   R5 与答题逻辑完全解耦：不看 API Key、不看是否填过答案、不 import 任何 work 模块。 */
  var INTERCEPT_TEXT = '当前章节还有任务点未完成';
  var SKIP_LABEL = '下一节';

  /* "点了下一节但页面没变"的闸门：防止循环换个 key 继续重试 → 无限点。
   * 只有 URL 变化 / 目标元素消失 / 视频数量变化，才算"真的切页"并解除。 */
  var latch = null;

  /* 跳转代数：每次**真的发起一次跳转**（PCount.next / 点目录 / 点拦截框）+1。
   * 用途：超星是局部刷新，换页后 pathname+search 可能一模一样，wait-catalog / intercept 的
   * 去重 key 就会跟换页前撞车 → task-loop 认为"这任务做过了"→ 直接空转，
   * 落到 main 的 90s「等待新视频」兜底（真机 2026-10-31 就是这么卡住的）。
   * 带上代数后：发起过跳转 → key 换新 → 等待任务能正常派发。 */
  var navGen = 0;

  function frameSig(doc) {
    var d = doc || document;
    var list = qsa(d, 'iframe,frame');
    var n = Math.min(list.length, 20);
    var parts = [];
    for (var i = 0; i < n; i++) {
      var src = '';
      try { src = String(list[i].getAttribute('src') || ''); } catch (e) { src = ''; }
      parts.push(src.slice(0, 80));
    }
    return list.length + '|' + parts.join(';');
  }

  function baselineNow(doc) {
    var d = doc || document;
    var target = null;
    try { target = d.querySelector(SEL.next); } catch (e) { target = null; }
    var media = 0;
    try { media = d.querySelectorAll(SEL.media).length; } catch (e) { media = 0; }
    return { href: String(location.href), hasNext: !!target, media: media, frames: frameSig(d), target: target };
  }

  function pageChanged(baseline) {
    if (!baseline) return false;
    if (String(location.href) !== baseline.href) return true;
    var now = baselineNow(document);
    if (now.hasNext !== baseline.hasNext) return true;
    if (now.media !== baseline.media) return true;
    if (now.frames !== baseline.frames) return true;   /* 播放器 iframe 换源/重载也算切页 */
    try {
      if (baseline.target && baseline.target.isConnected === false) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  function resetLatch() { latch = null; return true; }

  /* 挂起后的唤醒观察器：只观察"下一节按钮的父容器"与"媒体/iframe 的父容器"，
   * 不观察 documentElement 全树（安全条目 3.2）。拿不到目标就返回 null，由轮询兜底。 */
  function createTurnObserver(doc, onChange) {
    if (typeof MutationObserver !== 'function') return null;
    var d = doc || document;
    var targets = [];
    function push(el) { if (el && targets.indexOf(el) < 0) targets.push(el); }
    try {
      var nb = d.querySelector(SEL.next);
      if (nb && nb.parentElement) push(nb.parentElement);
      var md = d.querySelector(SEL.media);
      if (md && md.parentElement) push(md.parentElement);
      var frames = d.querySelectorAll('iframe');
      for (var i = 0; i < frames.length && i < 4; i++) {
        if (frames[i].parentElement) push(frames[i].parentElement);
      }
    } catch (e) { targets = []; }
    if (!targets.length) return null;

    var mo = new MutationObserver(function () {
      try { onChange(); } catch (e) { /* ignore */ }
    });
    for (var k = 0; k < targets.length; k++) {
      try {
        mo.observe(targets[k], {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['src', 'class', 'style']
        });
      } catch (e) { /* ignore */ }
    }
    return {
      targets: targets.length,
      disconnect: function () { try { mo.disconnect(); } catch (e) { /* ignore */ } }
    };
  }

  /* ---------------- PCount.next 直调（唯一允许的 unsafeWindow 用途） ----------------
   * 为什么允许：超星底部的"下一节"是 <div onclick="PCount.next(...)">，合成事件在部分版本里
   * 无法触发其导航。直接调用平台自己的业务函数**不产生任何合成事件**，是本项目里最"低痕迹"的路径。
   * 边界（必须逐条保持，改动需裁决）：
   *   B1 只读 `unsafeWindow.PCount.next` 这一个成员；不读 PCount 的其它属性、不读其它 unsafeWindow 变量。
   *   B2 参数优先从目标元素的 `onclick` 属性**原样提取**（页面自己的参数，我们只做字符串解析，不执行它）。
   *   B3 取不到 onclick 实参 → **不猜**（0.5.0 删除了隐藏域兜底），整条降级到右侧目录。
   *   B4 只在 `typeof ... .next === 'function'` 时调用，异常一律 catch 后走降级，不重试。
   *   B5 **不注入 <script>、不 eval、不 new Function**（注入等于把代码字符串交给页面执行，且会被 CSP 拦）。
   *   B6 未授予 unsafeWindow 时 `typeof` 判空 → 自动走目录树降级，不报错。
   */
  /* 唯一的页面 window 访问点（build.mjs 断言 unsafeWindow 只出现在本文件且 ≤3 次）。
   * 只做"取窗口"这一件事，不读任何业务属性。 */
  function pageWindow() {
    try {
      if (typeof unsafeWindow === 'undefined' || !unsafeWindow) return null;
      return unsafeWindow;
    } catch (e) {
      return null;
    }
  }

  function pcount() {
    var win = pageWindow();
    if (!win) return null;
    var P = win.PCount;
    if (!P) return null;
    if (typeof P.next !== 'function') return null;
    return P;
  }

  /**
   * 可用的"全局跳转"清单（严格白名单，逐个尝试，绝不同时调用）。
   * 0.5.0 收窄为**只有 `PCount.next` 一个成员**：`getTheNextQuestion` 是无文档的参考脚本写法，
   * 多调用一个非本页按钮绑定的全局函数等于多开一条不受控路径，已删除。
   * 仍受 B1–B6 约束：typeof 守卫、实参只来自 onclick、异常即跳过、不拼接代码。
   * 明确不在此列：alert/confirm 覆写、遮罩 remove、任何"屏蔽提示"的动作。
   */
  function pageTurnCalls(nbEl) {
    var out = [];
    var args = pcountArgs(nbEl);
    var P = pcount();

    if (P && args.ok) {
      out.push({
        name: 'PCount.next',
        available: true,
        argc: args.args.length,
        from: args.from,
        fire: function () { P.next.apply(P, args.args); }
      });
    } else {
      out.push({ name: 'PCount.next', available: false, reason: P ? 'args-missing' : 'no-unsafeWindow-or-PCount' });
    }
    return out;
  }

  function hiddenValue(sel) {
    var n = null;
    try { n = document.querySelector(sel); } catch (e) { n = null; }
    return n ? String(n.value || '').trim() : '';
  }

  /* 实参解析：只认**字面量**，绝不执行 onclick、绝不 eval。
   *
   * 2026-10-30 真机 DOM（测验页）：
   *   onclick="PCount.next('2','1261250707','267856131','156668017','',true)"
   * 第 6 个参数是**裸字面量 true**（不是字符串）。旧实现的正则只抓引号内的字符串，
   * 把它丢掉后变成 5 个实参 → 平台内部拿到 undefined 按 falsy 处理 → 函数不抛错、
   * 页面也不动 → 3s 无变化 → 挂起。这就是测验页"静默拦截"的根因。
   *
   * 现在：字符串 / true / false / null / undefined / 数字 原样保留；
   * 出现任何其它 token（变量名、运算符、函数调用）→ 返回 null 整体放弃，不猜、不拼接、不求值。 */
  function parseCallArgs(src) {
    var out = [];
    var i = 0;
    var n = src.length;

    while (i < n) {
      var ch = src.charAt(i);
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i++; continue; }

      if (ch === "'" || ch === '"') {
        var quote = ch;
        var val = '';
        var closed = false;
        i++;
        while (i < n) {
          var c = src.charAt(i);
          if (c === '\\' && i + 1 < n) { val += src.charAt(i + 1); i += 2; continue; }
          if (c === quote) { closed = true; i++; break; }
          val += c;
          i++;
        }
        if (!closed) return null;
        out.push(val);
        continue;
      }

      var m = /^(true|false|null|undefined|-?\d+(?:\.\d+)?)(?![\w$.])/.exec(src.slice(i));
      if (!m) return null;
      var tok = m[1];
      if (tok === 'true') out.push(true);
      else if (tok === 'false') out.push(false);
      else if (tok === 'null') out.push(null);
      else if (tok === 'undefined') out.push(undefined);
      else out.push(Number(tok));
      i += tok.length;
    }
    return out;
  }

  /* 参数提取：**只**解析 onclick 里的字面量实参，不执行 onclick。
   * 0.5.0 收紧：删掉"猜隐藏域"的兜底（#curCourseId/#curChapterId/#curClazzId 顺序靠猜，
   * 猜错会跳到错误章节，是本路径唯一真实风险）。取不到 onclick 实参 → 直接降级右侧目录。 */
  function pcountArgs(el) {
    var attr = '';
    try { attr = String((el && el.getAttribute && el.getAttribute('onclick')) || ''); } catch (e) { attr = ''; }

    /* 取 PCount.next 之后第一个 '(' 到**最后一个** ')'：字符串实参里出现 ')' 也不会被截断
     * （旧的 /PCount\.next\(([^)]*)\)/ 会在第一个 ')' 处停下）。 */
    var head = attr.indexOf('PCount.next');
    if (head >= 0) {
      var open = attr.indexOf('(', head);
      var close = attr.lastIndexOf(')');
      if (open > head && close > open) {
        var args = parseCallArgs(attr.slice(open + 1, close));
        if (args && args.length >= 2) return { ok: true, args: args, from: 'onclick' };
      }
    }

    return { ok: false, from: 'none' };
  }

  function hash(s) {
    /* FNV-1a 32 位。0.5.0 起答案匹配模块已删除，这里自带一个纯函数，
     * 只用于任务去重 key（不参与任何业务判断，也不影响平台行为）。 */
    var t = String(s == null ? '' : s);
    var h = 0x811c9dc5;
    for (var i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return h.toString(36);
  }

  function qsa(root, sel) {
    try { return Array.prototype.slice.call(root.querySelectorAll(sel)); } catch (e) { return []; }
  }

  /* ---------------- 递归找媒体 / 文档 ---------------- */

  function scanDoc(doc, depth, path, acc, budget) {
    if (!doc || depth > MAX_DEPTH || budget.n > MAX_FRAMES) return;

    var media = qsa(doc, SEL.media);
    for (var i = 0; i < media.length; i++) {
      if (!SH.media.isMediaLike(media[i])) continue;
      acc.media.push({
        el: media[i],
        doc: doc,
        path: path + '[' + i + ']',
        visible: SH.dom.isVisible(media[i], doc)
      });
    }

    var frames = qsa(doc, 'iframe,frame');
    for (var j = 0; j < frames.length; j++) {
      if (budget.n >= MAX_FRAMES) return;
      budget.n++;
      var f = frames[j];
      var childPath = path + '/' + j;
      var cd = null;
      try { cd = f.contentDocument; } catch (e) { cd = null; }
      if (!cd) {
        acc.crossOrigin.push({ path: childPath, src: String(f.getAttribute('src') || '').slice(0, 120) });
        continue;
      }
      acc.frames.push(childPath);
      scanDoc(cd, depth + 1, childPath, acc, budget);
    }
  }

  function scanAll(doc) {
    var acc = { media: [], frames: [], crossOrigin: [] };
    scanDoc(doc || document, 0, 'top', acc, { n: 0 });
    return acc;
  }

  /* 假视频过滤（2026-10-31）：空壳 <video>（没有可播的源）会让 play() 抛 NotSupportedError，
   * 而播放器要等 'ended' 才放行 → 整个任务挂死，后面的 wait-catalog 永远轮不到。
   * 判据（任一不满足就丢掉）：
   *   1. 有源：src / currentSrc / data-src 之一非空，或内部有 <source src>；
   *   2. 是 <video> 的话必须已解析出画面尺寸（videoWidth > 0）：metadata 没到时先不算，
   *      交给 wait-catalog 的蹲点复查（那时通常已经有尺寸了）。
   * <audio> 不检查尺寸。 */
  function isRealMedia(el) {
    if (!SH.media.isMediaLike(el)) return false;

    var src = '';
    try { src = String(el.currentSrc || el.src || el.getAttribute('data-src') || '').trim(); } catch (e) { src = ''; }
    var hasSource = false;
    try { hasSource = !!el.querySelector('source[src]'); } catch (e) { hasSource = false; }
    if (!src && !hasSource) return false;

    var tag = '';
    try { tag = String(el.tagName || '').toUpperCase(); } catch (e) { tag = ''; }
    if (tag === 'VIDEO' && !(el.videoWidth > 0)) return false;

    /* 隐藏的（display:none / visibility:hidden / 不占布局）一律不算：
     * 这类"假视频"会让 startMediaWait 误判"视频来了"→ 重启循环 → 无限 NotSupportedError。 */
    try {
      var ownerDoc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
      var view = ownerDoc && ownerDoc.defaultView;
      var cs = view && view.getComputedStyle ? view.getComputedStyle(el) : null;
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse')) return false;
      if (el.getClientRects && el.getClientRects().length === 0) return false;
    } catch (e) { /* 读不到样式就放过，交给上面的尺寸判断 */ }

    return true;
  }

  function locateMedia(doc) {
    var acc = scanAll(doc);
    var list = [];
    for (var k = 0; k < acc.media.length; k++) {
      if (isRealMedia(acc.media[k].el)) list.push(acc.media[k]);
    }
    if (!list.length) {
      return { ok: false, reason: 'no-media', frames: acc.frames, crossOrigin: acc.crossOrigin };
    }
    for (var i = 0; i < list.length; i++) {
      if (list[i].visible) {
        return { ok: true, el: list[i].el, doc: list[i].doc, path: list[i].path, visible: true, crossOrigin: acc.crossOrigin };
      }
    }
    return { ok: true, el: list[0].el, doc: list[0].doc, path: list[0].path, visible: false, crossOrigin: acc.crossOrigin };
  }

  function locateDoc(doc) {
    var found = null;
    (function walk(d, depth) {
      if (found || !d || depth > MAX_DEPTH) return;
      var boxes = qsa(d, SEL.doc);
      for (var j = 0; j < boxes.length; j++) {
        if (SH.reader.isScrollable(boxes[j]) && boxes[j].scrollHeight > boxes[j].clientHeight + 20) {
          found = { ok: true, el: boxes[j], path: depth === 0 ? 'top' : ('frame' + depth) };
          return;
        }
      }
      /* 子帧里没有专用容器时，退回"子帧 body 可滚动" */
      if (depth > 0) {
        var se = d.scrollingElement || d.documentElement;
        if (SH.reader.isScrollable(se) && se.scrollHeight > se.clientHeight + 20) {
          found = { ok: true, el: se, path: 'frame-body' + depth };
          return;
        }
      }
      var frames = qsa(d, 'iframe,frame');
      for (var i = 0; i < frames.length && i < MAX_FRAMES; i++) {
        var cd = null;
        try { cd = frames[i].contentDocument; } catch (e) { cd = null; }
        if (cd) walk(cd, depth + 1);
      }
    })(doc || document, 0);
    return found || { ok: false, reason: 'no-doc' };
  }

  /* ---------------- 侧边栏任务点 ---------------- */

  /* 真机结构（多份实测 DOM，2026-10-31）：
   *   ① 单元/章标题：div.posCatalog_select.firstLayer（或内部含 span.posCatalog_title），**没有 onclick**；
   *   ② 可点任务点：div.posCatalog_select 内部的 span.posCatalog_name，
   *      onclick="getTeacherAjax('<courseId>','<clazzId>','<chapterId>')"；当前项带 posCatalog_active；
   *   ③ 完成态：.orangeNew / input.jobUnfinishCount>0 = 未完成；
   *      .icon_Completed / input.jobUnfinishCount=0 / 文案"已完成" = 已完成。
   *
   * 旧实现只查 `.jobFinishTip` **是否存在**。真机上这个空壳可能每行都有，
   * 结果把所有小节都判成"已完成"，越过 1.2/1.3 去点章节标题 02 → 点不动 → quiz-no-change。
   * 现在把"标题 / 任务点 / 完成态"三件事分开判，且**永远不点标题**。 */

  function catalogText(node) {
    return SH.dom.textOf(node);
  }

  /* 标题行：firstLayer 或含 posCatalog_title。 */
  function catalogHasTitleMark(node) {
    var cls = '';
    try { cls = String(node.className || ''); } catch (e) { cls = ''; }
    if (/(^|\s)(firstLayer|posCatalog_title)(\s|$)/i.test(cls)) return true;
    try {
      if (node.querySelector('.posCatalog_title')) return true;
    } catch (e2) { /* ignore */ }
    return false;
  }

  /* 任务点判定（2026-10-31 真实 4 门课探针，铁律）：
   *   ① 真任务点必须是 `.posCatalog_name`，且它的 onclick 里含 getTeacherAjax(courseId,clazzId,chapterId)；
   *   ② 大标题（firstLayer / posCatalog_title / 没有 name / 没有 getTeacherAjax）绝对不点；
   *   ③ `.jobFinishTip` 在真实数据里全是 0/null，**彻底不作为完成依据**。
   * 完成态只看：.icon_Completed / 文案"已完成" / jobUnfinishCount 为空 / orangeNew 文字为 "0" 或空壳。 */
  function catalogActionInfo(node) {
    var nameEl = null;
    try { nameEl = node.querySelector('.posCatalog_name'); } catch (e) { nameEl = null; }

    /* 铁律 2：只认 `.posCatalog_name` 自己的 onclick，不看外层行 */
    var args = catalogAjaxArgs(nameEl);
    var target = nameEl || node;

    var onclick = '';
    try {
      onclick = String((target.getAttribute && target.getAttribute('onclick'))
        || (node.getAttribute && node.getAttribute('onclick')) || '');
    } catch (e3) { onclick = ''; }

    return {
      nameEl: nameEl,
      target: target,
      args: args,
      onclick: onclick,
      /* 铁律 2：没有 getTeacherAjax 的一律不是跳转目标 */
      jumpable: !!args,
      title: catalogHasTitleMark(node) || !nameEl
    };
  }

  /* 完成态（铁律 4）：任一条件成立即"已完成"；否则"未完成"。
   * .jobFinishTip 不参与（铁律 3）。 */
  function catalogProgress(node) {
    try { if (node.querySelector('.icon_Completed')) return 'done'; } catch (e) { /* ignore */ }

    var txt = catalogText(node);
    if (/已完成/.test(txt)) return 'done';

    var inp = null;
    try { inp = node.querySelector('input.jobUnfinishCount, .jobUnfinishCount'); } catch (e2) { inp = null; }
    if (inp) {
      var raw = (inp.value !== undefined && inp.value !== null) ? inp.value : SH.dom.textOf(inp);
      var v = String(raw).trim();
      /* jobUnfinishCount 非空且非 0 → 明确未完成；不要被同一行的 orangeNew 空壳覆盖 */
      if (v === '' || v === '0') return 'done';
      return 'pending';
    }

    var orange = null;
    try { orange = node.querySelector('.orangeNew'); } catch (e3) { orange = null; }
    if (orange) {
      var ot = SH.dom.textOf(orange).trim();
      if (ot === '' || ot === '0') return 'done';
      return 'pending';
    }

    /* 两个进度标记都不存在：证据不足以判完成，按"未完成"处理，避免跳过真任务点。 */
    return 'pending';
  }

  function isTaskDone(node) {
    if (!node) return false;
    return catalogProgress(node) === 'done';
  }

  /* 统一构建目录模型：nodes 与 metas 一一对应。 */
  function buildCatalog(doc) {
    var d = doc || document;
    var nodes = qsa(d, SEL.catalog);
    if (!nodes.length) {
      var names = qsa(d, '.posCatalog_name');
      var parents = [];
      for (var p = 0; p < names.length; p++) {
        var par = names[p].parentElement || names[p];
        if (parents.indexOf(par) < 0) parents.push(par);
      }
      nodes = parents;
    }

    var metas = [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var info = catalogActionInfo(node);
      var state = catalogProgress(node);
      metas.push({
        node: node,
        nameEl: info.nameEl,
        target: info.target,
        args: info.args,
        onclick: info.onclick,
        jumpable: info.jumpable,
        title: info.title,
        visible: SH.dom.isVisible(node, d),
        state: state,
        pending: state === 'pending',
        done: state === 'done',
        /* 铁律 1+2+5：标题/无 getTeacherAjax 都不是任务点 */
        task: info.jumpable && !info.title
      });
    }

    return { nodes: nodes, metas: metas };
  }

  function catalogItems(doc) {
    var c = buildCatalog(doc);
    var out = [];
    for (var i = 0; i < c.metas.length; i++) {
      var m = c.metas[i];
      out.push({
        el: m.target,
        node: m.node,
        index: i,
        text: catalogText(m.node).slice(0, 24),
        done: m.state === 'done',
        pending: m.state === 'pending',
        title: m.title,
        task: m.task,
        jumpable: m.jumpable,
        chapterId: catalogChapterId(m.target) || catalogChapterId(m.node),
        args: m.args,
        visible: m.visible
      });
    }
    return out;
  }

  function firstPendingCatalog(doc) {
    var c = buildCatalog(doc);
    for (var i = 0; i < c.metas.length; i++) {
      var m = c.metas[i];
      if (m.task && m.state === 'pending') return itemOf(c, i);
    }
    return null;
  }

  function itemOf(c, i) {
    var m = c.metas[i];
    return {
      el: m.target,
      node: m.node,
      index: i,
      text: catalogText(m.node).slice(0, 24),
      done: m.state === 'done',
      pending: m.state === 'pending'
    };
  }

  /* 失败时带回前几行的真相，排查不用再猜（日志只截 160 字）。 */
  function catalogDebug(c) {
    var parts = [];
    var n = Math.min(c.metas.length, 8);
    for (var i = 0; i < n; i++) {
      var m = c.metas[i];
      parts.push(i + ':' + catalogText(m.node).replace(/\s+/g, ' ').slice(0, 12)
        + '|' + (m.title ? 'T' : '-')
        + (m.task ? 'K' : '-')
        + (m.args ? 'A' : '-')
        + '|' + m.state
        + (m.visible ? '' : '|hid'));
    }
    var s = parts.join(' ; ');
    return s.length > 160 ? s.slice(0, 160) + '…' : s;
  }

  /* ---------------- 侧边栏：当前节点之后的下一个任务点（题目页专用） ----------------
   * 背景（2026-10-30 真机）：章节测验页的底部"下一节"被埋在隔离 iframe / 防作弊脚本里，
   * 顶层 DOM 既没有 #prevNextFocusNext、也拿不到 PCount。真人绕过测验的自然路径是
   * **点侧边栏里的下一个任务点**，所以这里复现那条路径，而不是去碰底部按钮。 */

  /* 只认"当前节点"的明确标记。按 **class token 逐个精确比对**，不做子串匹配
   * （子串会让 inactive / activeItem 之类误命中）。
   * 覆盖：active / current / selected / cur / on / posCatalog_active（超星可能用主题前缀）。 */
  var ACTIVE_TOKENS = /^(active|current|selected|cur|on|posCatalog_active|posCatalog_cur)$/i;

  function isCatalogActive(node) {
    if (!node || node.nodeType !== 1) return false;

    var cls = '';
    try { cls = String(node.className || ''); } catch (e) { cls = ''; }
    var toks = cls.split(/\s+/);
    for (var i = 0; i < toks.length; i++) {
      if (!toks[i]) continue;
      if (ACTIVE_TOKENS.test(toks[i])) return true;
      /* 带主题前缀的写法：xxx_active / xxx-current */
      if (/(^|[_-])(active|current|selected)([_-]|$)/i.test(toks[i])) return true;
    }

    try {
      var cur = node.getAttribute && node.getAttribute('aria-current');
      if (cur === 'true' || cur === 'page' || cur === 'step') return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  /* 播放器 iframe 还在：说明这其实是视频页，只是媒体还没注入（用来放宽蹲点时长）。
   * top/0 的 src 形如 .../knowledge/cards?...，再往里才是 ananas/modules/video。 */
  function looksLikeVideoPage(doc) {
    var frames = qsa(doc || document, 'iframe,frame');
    for (var i = 0; i < frames.length; i++) {
      var src = '';
      try { src = String(frames[i].getAttribute('src') || ''); } catch (e) { src = ''; }
      if (/knowledge|ananas|insertmedia|video|player/i.test(src)) return true;
    }
    return false;
  }

  /* ---------------- 黑屏播放键唤醒（视频懒加载） ----------------
   * 真机现象：跳到新章节后 DOM 里**没有** <video>，只有一块黑屏；必须点一下播放键，
   * 超星的播放器模块才会注入 <video> 并开始加载。
   * 真机确认的选择器：`button.vjs-big-play-button`（可能在顶层，也可能在同源 iframe 里，如 top/0/0）。
   * **普通 el.click() 会被防伪造机制忽略**，所以派发**带坐标的完整鼠标序列**：
   *   mousedown → mouseup → click（bubbles: true，clientX/clientY 取按钮中心点）。 */

  var PLAY_BTN_SEL = 'button.vjs-big-play-button';
  var MAX_PLAY_WAKE_CLICKS = 2;          /* 一次蹲点最多点 2 次，绝不疯点 */

  /* 唤醒点击的模块级防抖（2026-10-31，修"同一秒两条唤醒点击日志"）：
   * 同一次唤醒可能被两条路径同时触发（turn 的 wake 分支 + waitMediaStepped 的 tick，
   * 或 main.startMediaWait 的轮询撞上 turn），两条路径各自算次数是防不住的。
   * 这里用**模块级时间戳**做最后一道闸：2s 内已经点过就一律忽略。
   * 时间戳在**派发前**写入（防事件回调里重入），派发失败再归零允许重试。 */
  var WAKE_CLICK_MIN_GAP_MS = 4000;   /* 0.5.0：两次唤醒点击至少间隔 4s（原来是 2s，太密） */
  var lastWakeClickTime = 0;

  function resetWakeClickGate() {
    lastWakeClickTime = 0;
    return true;
  }

  /* true = 可以点（并已经占住 2s 窗口）；false = 2s 内点过，本次忽略。 */
  function wakeClickGate() {
    var now = Date.now();
    if (now - lastWakeClickTime < WAKE_CLICK_MIN_GAP_MS) return false;
    lastWakeClickTime = now;
    return true;
  }

  /* 递归找可见的播放键（穿透同源 iframe；深度 ≤4、单层帧数 ≤12）。 */
  function findPlayButton(doc, depth) {
    var d = doc || document;
    if (depth > MAX_DEPTH) return null;

    var list = [];
    try { list = qsa(d, PLAY_BTN_SEL); } catch (e) { list = []; }
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var w0 = 0;
      var h0 = 0;
      try { w0 = el.offsetWidth; h0 = el.offsetHeight; } catch (e2) { w0 = 0; h0 = 0; }
      if (!(w0 > 0) || !(h0 > 0)) continue;      /* 隐藏 / 未布局的按钮不算 */
      return el;
    }

    var frames = qsa(d, 'iframe,frame');
    for (var j = 0; j < frames.length && j < MAX_FRAMES; j++) {
      var cd = null;
      try { cd = frames[j].contentDocument; } catch (e3) { cd = null; }
      if (!cd) continue;                          /* 跨域帧：越权读取一律跳过 */
      var found = findPlayButton(cd, depth + 1);
      if (found) return found;
    }
    return null;
  }

  /* 带坐标的鼠标三连（mousedown → mouseup → click）。事件在元素自己文档的 realm 里派发。 */
  function fireMouseTriplet(el) {
    if (!el) return false;
    var edoc = el.ownerDocument || document;
    var view = edoc.defaultView || window;

    var r = null;
    try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
    var x = r ? Math.round(r.left + (r.width || 0) / 2) : 0;
    var y = r ? Math.round(r.top + (r.height || 0) / 2) : 0;

    function make(type) {
      var ev = null;
      try {
        ev = new view.MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: view,
          clientX: x,
          clientY: y,
          button: 0
        });
      } catch (e2) { ev = null; }
      if (ev) return ev;

      /* 老式回退：同一个文档里构造 */
      ev = edoc.createEvent('MouseEvents');
      ev.initMouseEvent(type, true, true, view, 1, x, y, x, y, false, false, false, false, 0, null);
      return ev;
    }

    try {
      el.dispatchEvent(make('mousedown'));
      el.dispatchEvent(make('mouseup'));
      el.dispatchEvent(make('click'));
      return true;
    } catch (e3) { return false; }
  }

  /* 找到黑屏播放键并点一次（三连事件）。成功返回 true，由调用方控制频率。
   * 这是**唯一的**播放键点击入口：所有调用方（wake 分支、waitMediaStepped、
   * main.startMediaWait）都走这里，重复点击由模块级 wakeClickGate 兜住。
   * 防抖命中时静默返回 false（不逐轮打日志，否则轮询会刷屏）。 */
  function findAndClickPlayButton(doc, w) {
    var btn = findPlayButton(doc || document, 0);
    if (!btn) return false;
    if (!wakeClickGate()) return false;
    if (!fireMouseTriplet(btn)) {
      lastWakeClickTime = 0;             /* 没点出去就不占窗口，允许下一轮重试 */
      return false;
    }
    if (w && w.log) w.log('info', '[StudyHelper] 发现黑屏播放键，已执行唤醒点击');
    return true;
  }

  /* 原地蹲点：立刻查一次，之后每 stepMs 复查一次，直到 maxMs。
   * 期间如果一直没视频，就顺手点黑屏播放键唤醒（最多 MAX_PLAY_WAKE_CLICKS 次）。
   * **第一次 tick 就是本轮唯一的初始唤醒点击**（turn 的 wake 分支不再先点一次，
   * 否则同一秒会点两下）；后续每轮受 findAndClickPlayButton 的 2s 防抖约束。
   * 只读媒体状态，除播放键外不改 DOM。返回 {ok:true} = 视频出现；{ok:false} = 等满/被打断。
   * 走 SH.dom.sleep → 账本内定时器，pause/close/exit 会立刻打断。 */
  function waitMediaStepped(w, doc, maxMs, stepMs) {
    var step = Math.max(100, stepMs | 0);
    var waited = 0;
    var clicks = 0;

    function tick() {
      if (locateMedia(doc).ok) return { ok: true, waited: waited, clicks: clicks };
      if (waited >= maxMs) return { ok: false, waited: waited, clicks: clicks };

      /* 黑屏懒加载：每轮复查时若还没视频，就点一次播放键（有上限，绝不疯点）。 */
      if (clicks < MAX_PLAY_WAKE_CLICKS && findAndClickPlayButton(doc, w)) clicks++;

      waited += step;
      return SH.dom.sleep(w, step).then(function (slept) {
        if (!slept) return { ok: false, aborted: true, waited: waited };
        return tick();
      });
    }

    return Promise.resolve().then(tick);
  }

  /* "当前章节"的候选 id：**首选 URL 的 chapterId**（用户要求：绝对锚点），再退隐藏域 #curChapterId。 */
  function currentChapterIds() {
    var ids = [];
    var id = '';

    try {
      if (typeof URL === 'function') {
        var u = new URL(String(location.href));
        id = u.searchParams.get('chapterId') || '';
      }
    } catch (e) { id = ''; }

    if (!id) {
      var m = /[?&#]chapterId=([0-9A-Za-z_-]+)/i.exec(String(location.search || '') + String(location.hash || ''));
      if (m) id = m[1];
    }
    if (id) ids.push(id);

    var hid = hiddenValue('#curChapterId');
    if (hid && ids.indexOf(hid) < 0) ids.push(hid);
    return ids;
  }

  /* 真机 onclick：getTeacherAjax('courseId','clazzId','chapterId') —— 第 3 个参数才是章节 id。
   * 2026-10-31：单/双引号、无引号都认（不同课程模板会变），只取前 3 个参数。 */
  var GET_TEACHER_RE = /getTeacherAjax\(\s*['"]?([^'",)]+)['"]?\s*,\s*['"]?([^'",)]+)['"]?\s*,\s*['"]?([^'",)]+)['"]?\s*\)/;

  function catalogAjaxArgs(node) {
    if (!node) return null;
    var attr = '';
    try { attr = String((node.getAttribute && node.getAttribute('onclick')) || ''); } catch (e) { attr = ''; }
    var m = GET_TEACHER_RE.exec(attr);
    if (!m) return null;
    return [m[1], m[2], m[3]];
  }

  /* 侧边栏节点的章节 id */
  function catalogChapterId(node) {
    var args = catalogAjaxArgs(node);
    return args ? String(args[2]) : '';
  }

  /* 定位"当前项"下标。信号按可靠性排序：
   *   A) 当前行 id == 'cur' + URL/隐藏域 chapterId（真机：当前小节的 id 就是 cur<chapterId>）
   *   B) 节点 onclick 的 getTeacherAjax 第 3 参 == 当前 chapterId（绝对锚点）
   *   C) class 里独立的 active / current / selected / cur / on（含 posCatalog_active）
   *   D) onclick 原文里直接包含当前 chapterId（参数顺序换版本的兜底）
   * 返回 { index, by }；找不到返回 index:-1。
   * ctx = buildCatalog() 的返回值，用于"优先匹配任务点、不要被标题的 active 骗到"。 */
  function findCurrentCatalogIndex(nodes, ctx) {
    var metas = ctx && ctx.metas ? ctx.metas : null;

    function metaAt(i) { return metas && metas[i] ? metas[i] : null; }
    function isTaskAt(i) {
      var m = metaAt(i);
      return m ? !!m.task : true;
    }
    function nodeId(i) {
      try { return String(nodes[i].id || ''); } catch (e) { return ''; }
    }

    var ids = currentChapterIds();

    /* A) 当前行 id = cur<chapterId>（先任务点，再任意行，兼容标题型当前项） */
    for (var aPass = 0; aPass < 2; aPass++) {
      for (var a = 0; a < ids.length; a++) {
        if (!ids[a]) continue;
        for (var i = 0; i < nodes.length; i++) {
          if (aPass === 0 && !isTaskAt(i)) continue;
          if (nodeId(i) === 'cur' + ids[a]) return { index: i, by: 'id' };
        }
      }
    }

    /* B) chapterId 精确对齐 onclick 第 3 参（先任务点，再任意行） */
    for (var bPass = 0; bPass < 2; bPass++) {
      for (var n = 0; n < ids.length; n++) {
        var want = ids[n];
        if (!want) continue;
        for (var j = 0; j < nodes.length; j++) {
          if (bPass === 0 && !isTaskAt(j)) continue;
          var m = metaAt(j);
          var cid = m ? (catalogChapterId(m.target) || catalogChapterId(m.node)) : catalogChapterId(nodes[j]);
          if (!cid) {
            var n2 = null;
            try { n2 = nodes[j].querySelector('.posCatalog_name'); } catch (e2) { n2 = null; }
            cid = catalogChapterId(n2);
          }
          if (cid === want) return { index: j, by: 'chapterId' };
        }
      }
    }

    /* C) active 类：先任务点，再任意行（标题 active 只在没有任务点 active 时用） */
    for (var pass = 0; pass < 2; pass++) {
      for (var k = 0; k < nodes.length; k++) {
        if (pass === 0 && !isTaskAt(k)) continue;
        if (isCatalogActive(nodes[k])) return { index: k, by: 'class' };
        var nameEl = null;
        try { nameEl = nodes[k].querySelector('.posCatalog_name'); } catch (e) { nameEl = null; }
        if (nameEl && isCatalogActive(nameEl)) return { index: k, by: 'class' };
      }
    }

    /* D) onclick 原文里直接含这个 id（行本身或其内部可点元素；参数顺序换版本的兜底） */
    for (var n3 = 0; n3 < ids.length; n3++) {
      if (!ids[n3]) continue;
      for (var k2 = 0; k2 < nodes.length; k2++) {
        var attrs = [];
        try { attrs.push(String((nodes[k2].getAttribute && nodes[k2].getAttribute('onclick')) || '')); } catch (e3) { /* ignore */ }
        var inner = [];
        try { inner = qsa(nodes[k2], '[onclick]'); } catch (e4) { inner = []; }
        for (var q = 0; q < inner.length; q++) {
          try { attrs.push(String(inner[q].getAttribute('onclick') || '')); } catch (e5) { /* ignore */ }
        }
        for (var w2 = 0; w2 < attrs.length; w2++) {
          if (attrs[w2].indexOf(ids[n3]) >= 0) return { index: k2, by: 'chapterId-attr' };
        }
      }
    }

    return { index: -1, by: 'none' };
  }

  /* 真正带 onclick 的元素：真机在 .posCatalog_name 这个 span 上，
   * 直接点外层 .posCatalog_select 是点不动的（这正是"点了没变化"的原因之一）。 */
  function catalogClickTarget(node) {
    if (!node) return null;
    try {
      var name = node.querySelector('.posCatalog_name');
      if (name) return name;
    } catch (e) { /* ignore */ }
    try {
      var a = node.querySelector('a[onclick], a[href]');
      if (a) return a;
    } catch (e2) { /* ignore */ }
    return node;
  }

  /* 点"下一个任务点"：只对内部 `.posCatalog_name` 执行原生 `.click()`（铁律 5）。
   * 不再调 getTeacherAjax —— 原生 click 会触发元素自己的 inline onclick。 */
  function clickCatalogNode(node) {
    if (!node) return '';
    var info = catalogActionInfo(node);
    var target = info.nameEl || info.target || catalogClickTarget(node);
    return clickNative(target) ? 'click' : '';
  }

  /* 返回"当前项"之后的任务点（五铁律 + 2026-10-31 兜底）：
   *   第一优先级：第一个"有 getTeacherAjax 且未完成"的节点；
   *   第二优先级（兜底）：后面所有任务点都已完成时，忽略完成状态，取第一个有 getTeacherAjax 的节点，
   *                        返回 fallback:true，由调用方点击并打兜底日志；
   *   只有当前项之后连一个 getTeacherAjax 节点都没有，才 no-next-node。 */
  function nextCatalogAfterActive(doc) {
    var d = doc || document;
    var c = buildCatalog(d);
    if (!c.nodes.length) return { ok: false, reason: 'no-catalog' };

    var cur = findCurrentCatalogIndex(c.nodes, c);
    if (cur.index < 0) {
      return {
        ok: false,
        reason: 'no-active',
        sample: catalogDebug(c) + ' || ids=' + currentChapterIds().join(',')
      };
    }

    var ids = currentChapterIds();

    function chapterIdOf(m) {
      return catalogChapterId(m.nameEl) || catalogChapterId(m.node);
    }

    function resultOf(j, m, fallback) {
      return {
        ok: true,
        el: m.nameEl || m.target,            /* 铁律 5：点内部 .posCatalog_name */
        node: m.node,
        index: j,
        by: cur.by,
        fallback: !!fallback,
        chapterId: chapterIdOf(m),
        text: SH.dom.textOf(m.node).slice(0, 24)
      };
    }

    /* 第一优先级：第一个未完成、且有 getTeacherAjax 的任务点 */
    for (var j = cur.index + 1; j < c.metas.length; j++) {
      var m = c.metas[j];
      if (!m.task) continue;                 /* 大标题 / 无 getTeacherAjax，绝不点 */
      if (m.state === 'done') continue;      /* 已完成，先跳过 */
      return resultOf(j, m, false);
    }

    /* 第二优先级（兜底）：全都 done → 忽略完成状态，强行跳下一个真实跳转点 */
    for (var k = cur.index + 1; k < c.metas.length; k++) {
      var mk = c.metas[k];
      if (!mk.task) continue;                /* 仍然绝不大标题 */
      return resultOf(k, mk, true);
    }

    return { ok: false, reason: 'no-next-node', by: cur.by, sample: catalogDebug(c) + ' || ids=' + ids.join(',') };
  }

  /* 原生点击：**只用 element.click()**，不 dispatchEvent、不合成五连事件（用户裁决 2026-10-30）。
   * 拿不到 click 方法就返回 false，由调用方转 needManual 挂起，绝不降级去造事件。 */
  function clickNative(el) {
    if (!el || typeof el.click !== 'function') return false;
    try { el.click(); return true; } catch (e) { return false; }
  }

  /* ---------------- 下一节 ---------------- */

  function findNextButton(doc) {
    var el = null;
    try { el = (doc || document).querySelector(SEL.next); } catch (e) { el = null; }
    if (!el) return { ok: false, reason: 'no-button' };
    if (!SH.dom.isVisible(el, doc || document)) return { ok: false, reason: 'invisible' };
    var text = SH.dom.textOf(el);
    if (/上一节|上一章|回目录/.test(text)) return { ok: false, reason: 'wrong-button' };
    return { ok: true, el: el, text: text, chapter: /下一章/.test(text) };
  }

  /* 在浮层内部找"下一节"按钮：文本严格相等，优先语义按钮，否则取最深命中（防点到包裹层） */
  function findSkipButton(box) {
    var nodes = qsa(box, 'button, a, [role="button"], input[type="button"], span, div');
    var strict = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!SH.dom.isVisible(el, box.ownerDocument || document)) continue;
      if (SH.dom.textOf(el) !== SKIP_LABEL) continue;
      strict.push(el);
    }
    if (!strict.length) return null;
    for (var k = 0; k < strict.length; k++) {
      var tag = String(strict[k].tagName || '').toUpperCase();
      if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT') return strict[k];
      var role = '';
      try { role = String(strict[k].getAttribute('role') || ''); } catch (e) { role = ''; }
      if (role === 'button') return strict[k];
    }
    return strict[strict.length - 1];
  }

  /* 底部那个"下一节"（#prevNextFocusNext）：被遮罩挡住时点它必然失败，
   * 所以兜底路径**必须排除**它（用户裁决：这是 dispatch-failed 的来源）。 */
  function isBottomNext(el) {
    if (!el) return false;
    var id = '';
    try { id = String(el.id || ''); } catch (e) { id = ''; }
    if (id === 'prevNextFocusNext') return true;
    try {
      if (el.closest && el.closest('#prevNextFocusNext')) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  /* 兜底找【下一节】：全文档扫，文本严格等于"下一节"、可见、且**不是底部按钮**。
   * 文档顺序里越靠后越深，取最后一个命中 ≈ 取最内层那个按钮。 */
  function findAnySkipButton(doc) {
    var d = doc || document;
    var nodes = qsa(d, 'button, a, [role="button"], input[type="button"], span, div');
    var best = null;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (SH.dom.textOf(el) !== SKIP_LABEL) continue;
      if (!SH.dom.isVisible(el, d)) continue;
      if (isBottomNext(el)) continue;
      best = el;
    }
    return best;
  }

  /**
   * 找"任务点未完成"拦截框（只读）。
   * 2026-10-31 用户裁决（按真机截图）：
   *   ① **不再限制面积/形状** —— 这个提示就是全屏遮罩，用"≤60% 视口"会永远认不出来；
   *      只看：可见 ∩ 文案含该句 ∩ 文本 ≤300（防正文误命中）。
   *   ② 容器 class 完全不认识时，只要 `body.innerText` 里有这句话就当"被拦了"，
   *      再在全文档找【下一节】按钮（排除底部 #prevNextFocusNext）。
   * @returns {{ok:boolean, dialog?:Element, btn:?Element, hasButton?:boolean, text?:string, fallback?:boolean}}
   */
  function findInterceptDialog(doc) {
    var d = doc || document;
    var list = [];
    try { list = qsa(d, SEL.dialog); } catch (e) { list = []; }

    var best = null;
    for (var i = 0; i < list.length; i++) {
      var box = list[i];
      if (!SH.dom.isVisible(box, d)) continue;
      var text = SH.dom.textOf(box);
      if (text.indexOf(INTERCEPT_TEXT) < 0) continue;
      if (text.length > 300) continue;

      /* 取"最紧"的那个容器：文本越短，越贴近提示本身（外层的整页遮罩会被 ≤300 挡掉） */
      if (!best || text.length < best.text.length) {
        best = { box: box, text: text, btn: findSkipButton(box) };
        if (best.btn) break;
      }
    }

    if (best) {
      return { ok: true, dialog: best.box, btn: best.btn, hasButton: !!best.btn, text: best.text.slice(0, 60) };
    }

    /* 兜底：容器认不出来，但整页文本里有这句话 → 一定是平台在拦。 */
    var bodyText = '';
    try { bodyText = String((d.body && d.body.innerText) || ''); } catch (e) { bodyText = ''; }
    if (bodyText.indexOf(INTERCEPT_TEXT) >= 0) {
      var any = findAnySkipButton(d);
      return { ok: true, dialog: null, btn: any, hasButton: !!any, text: INTERCEPT_TEXT, fallback: true };
    }

    return { ok: false };
  }

  function hasQuestions(doc) {
    try { return !!(doc || document).querySelector(SEL.question); } catch (e) { return false; }
  }

  /* ---------------- 页面分类（2026-10-31 重构） ----------------
   * 每次扫描：先等 10s 让页面充分加载，再按 DOM 特征分成四类。
   * `collect()` 只按分类产出任务；分类动作本身在 `turn(mode:'scan')` 里做（collect 是同步的）。 */

  var VIDEO_BOX_SEL = '#videoContainer, .videoContainer, .video-container, [class*="videoContainer" i], .ans-video, #videoWrap, .vjs-player, .prism-player';
  var QUIZ_SEL = '.ZyBottom, #ZyBottom, .CeYan, #CeYan, .TiMu, .Zy_TItle';

  var SCAN_WAIT_MS = 10000;        /* 每次扫描先等 10s */
  var OTHER_WAIT_MS = 60000;       /* 其他界面等 60s 再扫 */
  var CATALOG_RETRY_MS = 10000;    /* 找不到目录 → 等 10s 重试 */
  var CATALOG_MAX_RETRY = 3;       /* 最多重试 3 次 */

  /* 扫描状态：kind=null 表示"本页还没分类，先扫一次"。
   * gen 每次失效就 +1 —— 任务去重 key 必须跟着变，否则同一页反复扫描会被 task-loop 跳过。 */
  var scan = { kind: null, href: '', otherCount: 0, gen: 0 };

  function resetScan() {
    scan.kind = null;
    scan.otherCount = 0;
    scan.gen++;
    scan.href = String(location.href);
  }

  /* 递归：任意同源子帧里有没有匹配元素。 */
  function hasDeep(doc, sel, depth) {
    var d = doc || document;
    if (depth > MAX_DEPTH) return false;
    try { if (qsa(d, sel).length) return true; } catch (e) { /* ignore */ }

    var frames = qsa(d, 'iframe,frame');
    for (var i = 0; i < frames.length && i < MAX_FRAMES; i++) {
      var cd = null;
      try { cd = frames[i].contentDocument; } catch (e2) { cd = null; }
      if (cd && hasDeep(cd, sel, depth + 1)) return true;
    }
    return false;
  }

  /* 递归：找第一个匹配元素（懒加载时点它的容器）。 */
  function findDeepOne(doc, sel, depth) {
    var d = doc || document;
    if (depth > MAX_DEPTH) return null;

    var list = [];
    try { list = qsa(d, sel); } catch (e) { list = []; }
    if (list.length) return list[0];

    var frames = qsa(d, 'iframe,frame');
    for (var i = 0; i < frames.length && i < MAX_FRAMES; i++) {
      var cd = null;
      try { cd = frames[i].contentDocument; } catch (e2) { cd = null; }
      if (!cd) continue;
      var found = findDeepOne(cd, sel, depth + 1);
      if (found) return found;
    }
    return null;
  }

  /* 四类判定（顺序即优先级）：真实视频页 → 懒加载视频页 → 章节测验页 → 其他。 */
  function classifyPage(doc) {
    var d = doc || document;
    var box = findDeepOne(d, VIDEO_BOX_SEL, 0);
    var hasVideo = hasDeep(d, 'video', 0);

    if (box && hasVideo) return { kind: 'real-video', log: '识别到真实视频页', box: box };
    if (box) return { kind: 'lazy-video', log: '识别到懒加载视频页', box: box };
    if (hasDeep(d, QUIZ_SEL, 0)) return { kind: 'quiz', log: '识别到章节测验页' };
    return { kind: 'other', log: '检测到其他界面/页面尚未加载完全' };
  }


  /* ---------------- 采集 ---------------- */

  function collect(ctx) {
    var w = ctx && ctx.w;
    var doc = (ctx && ctx.doc) || document;
    var tasks = [];

    /* 上一次自动点击没生效：在页面真正变化前，一枚任务点都不产出（否则就是死循环）。
     * 2026-10-31：不再只认 href —— 超星是局部刷新，href 可能一直不变。
     * 用 latch 里存下的 baseline 判"页面是否真的变了"（媒体/iframe/按钮任一变化都算）。 */
    if (latch) {
      var moved = String(location.href) !== latch.href
        || (latch.baseline ? pageChanged(latch.baseline) : false);
      if (moved) {
        latch = null;
      } else {
        if (w && w.log) w.log('warn', '上一轮自动跳转未生效，等待手动切换（本次不再自动点击）');
        return [];
      }
    }

    /* 最高优先级（2026-10-31 用户裁决）：**先看拦截框**。
     * 命中就只产出这一枚任务，立刻返回 —— 不找视频、不调 PCount.next、不点目录。
     * 遮罩会挡住一切，继续扫描只会误抓假视频、白调全局函数。 */
    var intercept = findInterceptDialog(doc);
    if (intercept.ok) {
      if (w && w.log) {
        w.log('warn', '检测到"当前章节还有任务点未完成"拦截框（' + (intercept.text || '').slice(0, 20) + '…）');
      }
      tasks.push({
        kind: 'turn',
        mode: 'intercept',
        turn: true,
        key: 'intercept|' + hash(String(location.pathname) + '|' + (intercept.hasButton ? 'btn' : 'nobtn') + '#' + navGen),
        label: '拦截框'
      });
      return tasks;
    }

    /* 真跳转（href 变了）→ 上一次的分类作废，重新扫描 */
    if (String(location.href) !== scan.href) resetScan();

    /* 2026-10-31 用户裁决：**不再做题**。
     * 先用分类器做一次"预判"（它同步、只看 DOM）：如果当前页已经是 quiz，就跳过 10s 扫描，
     * 直接按"章节测验页"处理 —— turn 里等 3s → 点右侧目录。
     * 不能只看 `hasQuestions()`：视频页里也可能藏着未显示的题目模板，必须先让视频容器优先。 */
    if (!scan.kind) {
      var pre = classifyPage(doc);
      if (pre.kind === 'quiz') {
        scan.kind = 'quiz';
        scan.href = String(location.href);
        scan.otherCount = 0;
        if (w && w.log) w.log('info', '检测到答题界面：已禁用做题，等 3s 后点右侧目录跳过');
      }
    }

    /* 还没分类过 → 先扫一次（等 10s 加载 + 分类） */
    if (!scan.kind) {
      tasks.push({
        kind: 'turn',
        mode: 'scan',
        turn: true,
        key: 'scan|' + hash(scan.href + '#' + scan.gen),
        label: '扫描页面'
      });
      return tasks;
    }

    /* ---- 视频页（真实 / 懒加载）：有可播媒体就产 video + next，否则去点播放键 ---- */
    if (scan.kind === 'real-video' || scan.kind === 'lazy-video') {
      var m = locateMedia(doc);
      if (m.ok) {
        var src = '';
        try { src = m.el.currentSrc || m.el.src || m.el.getAttribute('data-src') || ''; } catch (e) { src = ''; }
        var dur = 0;
        try { dur = Math.round(m.el.duration || 0); } catch (e2) { dur = 0; }
        tasks.push({
          kind: 'video',
          key: 'video|' + hash(String(src) + '|' + dur + '|' + m.path),
          label: '视频（' + m.path + '）',
          el: m.el,
          frameKey: m.path
        });
        if (m.crossOrigin && m.crossOrigin.length && w && w.log) {
          w.log('info', '发现 ' + m.crossOrigin.length + ' 个跨域子帧（未越权读取）：' + m.crossOrigin[0].src);
        }

        /* 只有"本页有视频"才有下一节；排在最后，视频播完后才会被取到 */
        var nb = findNextButton(doc);
        if (nb.ok && !(nb.chapter && SH.store.cfg().autoNext !== true)) {
          tasks.push({
            kind: 'turn',
            mode: 'next',
            turn: true,
            key: 'next|' + hash(String(location.href) + '|' + nb.text),
            label: nb.chapter ? '下一章' : '下一节',
            el: nb.el
          });
        } else if (!nb.ok) {
          /* 底部按钮不存在 / 被拦住：播完后直接走 chapterId 绝对锚点点右侧目录。
           * 注意：如果是"下一章"且 autoNext 关闭，则属于用户设置，不加任何跳转任务。 */
          if (w && w.log) w.log('warn', '没有可用的底部"下一节"：播完后改用右侧目录（chapterId 锚点）');
          tasks.push({
            kind: 'turn',
            mode: 'catalog',
            turn: true,
            key: 'catalog|' + hash(scan.href + '#' + scan.gen + '|after-video'),
            label: '播完跳右侧目录'
          });
        }
        return tasks;
      }

      /* 识别成视频页但还没有可播媒体 → 去点黑屏播放键 / 点 videoContainer */
      tasks.push({
        kind: 'turn',
        mode: 'wake',
        turn: true,
        key: 'wake|' + hash(scan.href + '#' + scan.gen),
        label: '唤醒播放器'
      });
      return tasks;
    }

    /* ---- 章节测验页：等 3s 后点右侧目录 ---- */
    if (scan.kind === 'quiz') {
      tasks.push({
        kind: 'turn',
        mode: 'catalog',
        turn: true,
        key: 'catalog|' + hash(scan.href + '#' + scan.gen),
        label: '跳右侧目录'
      });
      return tasks;
    }

    /* ---- 其他界面 ---- */

    /* 文档/PPT 是旧逻辑支持的页面，先保住（不参与 60s 空等） */
    var d = locateDoc(doc);
    if (d.ok) {
      if (w && w.log) w.log('info', '识别到文档/PPT 页（沿用旧阅读逻辑）');
      tasks.push({ kind: 'doc', key: 'doc|' + hash(String(location.href) + '|' + d.path), label: '文档/PPT', el: d.el });

      /* 读完之后照旧可以点"下一节" */
      var nbDoc = findNextButton(doc);
      if (nbDoc.ok && !(nbDoc.chapter && SH.store.cfg().autoNext !== true)) {
        tasks.push({
          kind: 'turn',
          mode: 'next',
          turn: true,
          key: 'next|' + hash(String(location.href) + '|' + nbDoc.text),
          label: nbDoc.chapter ? '下一章' : '下一节',
          el: nbDoc.el
        });
      }
      return tasks;
    }

    /* 第二次仍然是"其他界面" → 强制点右侧目录兜底 */
    if (scan.otherCount >= 2) {
      tasks.push({
        kind: 'turn',
        mode: 'force-catalog',
        turn: true,
        key: 'force|' + hash(scan.href + '#' + scan.gen),
        label: '强制跳右侧目录'
      });
      return tasks;
    }

    tasks.push({
      kind: 'turn',
      mode: 'other-wait',
      turn: true,
      key: 'other|' + hash(scan.href + '#' + scan.gen + '|' + scan.otherCount),
      label: '等待页面加载'
    });
    return tasks;
  }

  /* ---------------- 执行切换 ---------------- */

  function turn(task, ctx) {
    var w = ctx.w;
    var doc = ctx.doc || document;
    var mode = (task && task.mode) || '';
    var interceptMode = mode === 'intercept';

    /* 这些任务自己去等 / 去查，故意不带 el；其它任务的 no-target 仍然是"不可跳过的失败"。 */
    var noEl = interceptMode
      || mode === 'scan'
      || mode === 'wake'
      || mode === 'catalog'
      || mode === 'force-catalog'
      || mode === 'other-wait';

    if (!noEl && (!task || !task.el)) return { ok: false, reason: 'no-target' };
    if (!SH.guards.canAct(w, w.epoch)) return { ok: false, reason: 'blocked' };

    if (!noEl) {
      try {
        if (!task.el.isConnected) return { ok: false, reason: 'target-detached' };
      } catch (e) { /* 老浏览器没有 isConnected，交给后面的点击失败判断 */ }
    }

    var baseline = baselineNow(doc);

    /* 等待时长统一入口：主流程不传 ctx.waitMs；测试用它把 10s/60s 缩短。 */
    function waitMs(def) {
      var v = Number(ctx && ctx.waitMs);
      return v > 0 ? v : def;
    }

    function finish(ok, reason) {
      if (ok) { latch = null; return { ok: true, reason: reason }; }
      /* 任何"没成功"都挂起等人工，绝不返回"跳过"（跳过会被循环当成功继续，就是死循环）。
       * latch 里带上 baseline：下次 collect 只要"页面真的变了"就自动解除，
       * 不必等 href 变化（超星是局部刷新，href 可能一直不变）。 */
      latch = { href: String(location.href), at: Date.now(), baseline: baseline };
      return { ok: false, reason: reason, needManual: true, baseline: baseline };
    }

    /* 拦截框处理（2026-10-31 用户裁决，**推翻**此前"只识别不点击"）：
     * 测验没做完时平台拦跳转，框内【下一节】是唯一出路 → **只点一次**（原生 click），
     * 页面不动就立刻转人工挂起，**绝不重试**（反复点会触发更高级风控）。 */
    function handleIntercept(dlg) {
      if (!dlg || !dlg.btn) {
        if (w.log) w.log('warn', '拦截框里没有【下一节】（可能只有"去学习"）：不点任何按钮，转人工');
        return finish(false, 'intercept-no-button');
      }
      if (w.log) w.log('warn', '拦截框命中 → 点一次框内【下一节】');
      navGen++;                                   /* 这是一次真实跳转尝试：让换页后的任务 key 换新 */
      resetScan();                                /* 换页后要重新扫描分类 */
      /* 0.5.0：先停 3–5s 再点，别在弹窗出现的一瞬间就点下去。 */
      return SH.dom.sleepJitter(w, C.LIMITS.JITTER_CLICK_MS).then(function (slept) {
        if (!slept) return { ok: false, reason: 'aborted' };
        if (!SH.guards.canAct(w, w.epoch)) return { ok: false, reason: 'blocked' };
        if (!clickNative(dlg.btn)) return finish(false, 'intercept-click-failed');

        return waitChangedOnly(3000).then(function (r) {
          if (r && r.ok) return { ok: true, reason: 'intercept-dismissed' };
          if (w.log) w.log('warn', '点了【下一节】页面没动（平台仍在拦截）：转人工，绝不重试');
          return finish(false, 'intercept-blocked');
        });
      });
    }

    /* 只看"页面变没变"的等待（**不**再查拦截框，避免自己触发自己的点击循环）。 */
    function waitChangedOnly(ms) {
      var deadline = Date.now() + ms;

      function tick() {
        if (pageChanged(baseline)) return { ok: true };
        if (Date.now() >= deadline) return null;
        return SH.dom.sleep(w, 400).then(function (slept) {
          if (!slept) return { ok: false, aborted: true };
          return tick();
        });
      }

      return Promise.resolve().then(tick);
    }

    /* 等"页面变化 或 冒出拦截框"。
     * 注意：这里**不再直接调 handleIntercept**（否则点击后自检又会点一次 = 反复点平台提示）。
     * 撞到拦截框就交回 task-loop：下一轮 `collect()` 会以最高优先级产出 intercept 任务，
     * 由那里"只点一次"。 */
    function waitForChangeOrIntercept(label) {
      var deadline = Date.now() + 3000;

      function tick() {
        if (pageChanged(baseline)) return { ok: true, reason: label };
        if (findInterceptDialog(doc).ok) return { ok: false, reason: 'intercepted' };
        if (Date.now() >= deadline) return null;
        return SH.dom.sleep(w, SH.dom.randomIntInRange([350, 650])).then(function (slept) {
          if (!slept) return { ok: false, reason: 'aborted', aborted: true };
          return tick();
        });
      }

      return Promise.resolve().then(tick);
    }

    /* 右侧目录点击 + "找不到目录"重试（最多 3 次，每次等 10s）。
     * 测验页（catalog）与识别失败兜底（force-catalog）共用这一条。 */
    function catalogFlow(attempt) {
      var qn = nextCatalogAfterActive(doc);

      if (!qn.ok || !qn.el) {
        if (attempt >= CATALOG_MAX_RETRY) {
          if (w.log) w.log('warn', '找不到目录，重试 3 次失败，脚本暂停');
          return finish(false, 'catalog-unavailable');
        }
        if (w.log) {
          w.log('warn', '找不到目录（' + (qn.reason || 'none') + (qn.sample ? '，样本：' + qn.sample : '')
            + '），等待 10s 后重试（第 ' + (attempt + 1) + '/' + CATALOG_MAX_RETRY + ' 次）');
        }
        return SH.dom.sleep(w, waitMs(CATALOG_RETRY_MS)).then(function (slept) {
          if (!slept) return { ok: false, reason: 'aborted' };
          if (!SH.guards.canAct(w, w.epoch)) return { ok: false, reason: 'blocked' };
          return catalogFlow(attempt + 1);
        });
      }

      /* 点击前重取 baseline：等待期间页面可能已经变了 */
      baseline = baselineNow(doc);

      if (w.log) {
        w.log('info', '点击右侧目录：' + (qn.text || '')
          + '（当前项定位：' + (qn.by || '?') + '；chapterId=' + (qn.chapterId || '-') + '）');
      }
      navGen++;                                 /* 真发起跳转：换页后的任务 key 换新 */
      resetScan();                              /* 换页后要重新扫描分类 */

      /* 铁律 5：拿到的是内部 `.posCatalog_name`，执行**原生 .click()**。 */
      if (!clickNative(qn.el)) return finish(false, 'quiz-click-failed');
      if (qn.fallback && w.log) {
        w.log('info', '[StudyHelper] 当前章节所有任务均已完成，执行兜底跳转至下一节点');
      }
      if (w.log) w.log('info', '已点击目录任务点（原生 click）');

      return waitForChangeOrIntercept('catalog').then(function (rr) {
        if (rr && rr.ok) {
          if (w.log) w.log('info', '右侧目录跳转成功');
          resetScan();
          return rr;
        }
        if (rr && rr.reason === 'intercepted') return { ok: false, reason: 'intercepted' };
        if (rr && rr.aborted) return { ok: false, reason: 'aborted' };
        if (w.log) w.log('warn', '点了右侧目录但页面没变化，转人工');
        return finish(false, 'quiz-no-change');
      });
    }

    /* 页面已经挂着拦截框：最高优先级处理（任何 mode 都是） */
    var pending = findInterceptDialog(doc);
    if (pending.ok) return handleIntercept(pending);

    /* intercept 任务走到这里说明框已经消失：直接让循环重新扫描 */
    if (interceptMode) return { ok: true, reason: 'intercept-gone' };

    /* ================= ① 扫描任务：等 10s → 分类 → 交回循环 ================= */
    if (mode === 'scan') {
      var scanMs = waitMs(SCAN_WAIT_MS);
      if (w.log) w.log('info', '开始扫描：先等 ' + Math.round(scanMs / 1000) + 's 让页面充分加载');
      return SH.dom.sleep(w, scanMs).then(function (slept) {
        if (!slept) return { ok: false, reason: 'aborted' };
        if (!SH.guards.canAct(w, w.epoch)) return { ok: false, reason: 'blocked' };

        var info = classifyPage(doc);
        scan.kind = info.kind;
        scan.href = String(location.href);
        if (info.kind === 'other') {
          scan.otherCount++;
        } else {
          scan.otherCount = 0;
        }
        if (w.log) w.log('info', info.log);

        return { ok: true, reason: 'scan-done' };
      });
    }

    /* ================= ② 懒加载视频页：点播放器唤醒 → 等 <video> ================= */
    if (mode === 'wake') {
      if (w.log) w.log('info', '懒加载视频页：点击播放器唤醒');

      /* 播放键的点击**只由 waitMediaStepped 的第一次 tick 执行**（它在微任务里立刻跑）。
       * 这里不再先 fireMouseTriplet 一次 —— 否则同一轮会点两下，日志在同一秒打两行。
       * 没有播放键时才退回点 videoContainer 容器（waitMediaStepped 只点播放键，不点容器）。 */
      var vjsBtn = findPlayButton(doc, 0);
      if (!vjsBtn) {
        var box = findDeepOne(doc, VIDEO_BOX_SEL, 0);
        if (box) {
          clickNative(box);
          if (w.log) w.log('info', '没找到 vjs 播放键，已点击 videoContainer 容器唤醒');
        } else if (w.log) {
          w.log('warn', '既没有播放键也没有 videoContainer，无法唤醒');
        }
      }

      return waitMediaStepped(w, doc, waitMs(15000), 1000).then(function (r) {
        if (r && r.ok) {
          if (w.log) w.log('info', '视频已注入：让位给播放');
          resetScan();
          return { ok: true, reason: 'media-appeared' };
        }
        if (r && r.aborted) return { ok: false, reason: 'aborted' };
        if (!SH.guards.canAct(w, w.epoch)) return { ok: false, reason: 'blocked' };

        if (w.log) w.log('warn', '点击后 15s 仍没有 <video>：改为尝试右侧目录');
        return catalogFlow(0);
      });
    }

    /* ================= ③ 章节测验页：等 3s → 点右侧目录 ================= */
    if (mode === 'catalog') {
      var quizMs = waitMs(3000);
      if (w.log) w.log('info', '章节测验页：等 ' + Math.round(quizMs / 1000) + 's 再点右侧目录');
      return SH.dom.sleep(w, quizMs).then(function (slept) {
        if (!slept) return { ok: false, reason: 'aborted' };
        if (!SH.guards.canAct(w, w.epoch)) return { ok: false, reason: 'blocked' };
        return catalogFlow(0);
      });
    }

    /* ================= ④ 其他界面：等 60s → 再扫；再失败就强制点目录 ================= */
    if (mode === 'other-wait') {
      var otherMs = waitMs(OTHER_WAIT_MS);
      if (w.log) w.log('warn', '检测到其他界面/页面尚未加载完全，等待 ' + Math.round(otherMs / 1000) + 's 后重新扫描');
      return SH.dom.sleep(w, otherMs).then(function (slept) {
        if (!slept) return { ok: false, reason: 'aborted' };
        if (!SH.guards.canAct(w, w.epoch)) return { ok: false, reason: 'blocked' };
        scan.kind = null;                    /* 回到第 2 步重新扫描（保留 otherCount） */
        scan.gen++;
        return { ok: true, reason: 'rescan-other' };
      });
    }

    /* ================= ⑤ 强制兜底：识别不了也去点右侧目录（绝不碰 PCount.next） ================= */
    if (mode === 'force-catalog') {
      if (w.log) w.log('warn', '识别失败，当前是其他页面/网络不佳，尝试强制点击右侧目录跳转');
      return catalogFlow(0);
    }

    /* 兜底：未知 mode 一律当人工，不猜 */
    if (mode !== 'next') return finish(false, 'unknown-mode:' + mode);

    /* 门槛检查（只对"下一节/下一章"生效） */
    var nb0 = findNextButton(doc);
    if (!nb0.ok) {
      /* 底部按钮不在了（可能是局部刷新换掉了）→ 直接用右侧目录锚点 */
      if (w.log) w.log('warn', '底部"下一节"不可用（' + (nb0.reason || 'gone') + '）：改用右侧目录锚点');
      return catalogFlow(0);
    }
    if (nb0.chapter && SH.store.cfg().autoNext !== true) return { ok: false, reason: 'auto-next-off', needManual: false };
    var cap = SH.store.dailyCounter('next-chapter', { bump: false });
    if (cap.count >= C.LIMITS.NEXT_CHAPTER_DAILY_MAX) return { ok: false, reason: 'daily-cap', needManual: false };
    SH.store.dailyCounter('next-chapter', { bump: true });
    if (w.log) w.log('info', '切到下一页（今日第 ' + (cap.count + 1) + ' 次）：只走全局函数，不伪造点击');

    /* 只调全局函数（零合成点击），**逐个**尝试（绝不同时调用，避免一次跳两节）。
     *
     * 关键裁决（2026-10-31）：**不拿"页面变没变"当成功判据**。
     * 超星是局部刷新 —— PCount.next 明明已经把页面换成测验页，`pageChanged()` 也可能一点都看不出来。
     * 所以只要调用没抛错：等 3–5s 让新页面刷出来，然后一律 `{ok:true, reason:'force-rescan'}`，
     * 由 task-loop 重新跑 `collect()` 接管（新页面若是测验页，自然走 wait-catalog → 蹲点 → 点右侧目录）。
     * **绝不因为"检测不到变化"就转人工弹黄条。**
     * 仍算失败的只有两种：函数不可用 / 调用抛异常（那是真的没调出去）。 */
    var calls = pageTurnCalls(nb0.el);

    /* 调用后轮询：**拦截框优先**，其次"如果居然检测到变化就提前放行"。
     * 注意"检测到变化"只用来**提前**，不用来判定失败 —— 检测不到照样放行。 */
    function pollAfterCall(ms) {
      var deadline = Date.now() + ms;

      function tick() {
        var dlg = findInterceptDialog(doc);
        if (dlg.ok) return { dlg: dlg };
        if (pageChanged(baseline)) return { changed: true };
        if (Date.now() >= deadline) return {};
        return SH.dom.sleep(w, 500).then(function (slept) {
          if (!slept) return { aborted: true };
          return tick();
        });
      }

      return Promise.resolve().then(tick);
    }

    function settleAfterCall(name) {
      var waitMs = Number(ctx && ctx.waitMs) > 0
        ? Number(ctx.waitMs)
        : SH.dom.randomIntInRange([3000, 5000]);

      if (w.log) w.log('info', '已调用 ' + name + '：最多等 ' + Math.round(waitMs / 1000) + 's（不判页面是否变化）');

      return pollAfterCall(waitMs).then(function (r) {
        if (r && r.dlg) return handleIntercept(r.dlg);           /* 真出拦截框才转人工 */
        if (!SH.guards.canAct(w, w.epoch)) return { ok: false, reason: 'blocked' };
        if (r && r.changed && w.log) w.log('info', '检测到页面变化，提前重新扫描');
        return { ok: true, reason: 'force-rescan' };
      });
    }

    function tryGlobalAt(i) {
      if (i >= calls.length) {
        /* 底部按钮这条路彻底走不通 → **不许停下**，改用 chapterId 绝对锚点点右侧目录 */
        if (w.log) w.log('warn', '底部按钮不可用（no-global-turn-fn）：改用右侧目录 chapterId 锚点跳转');
        return catalogFlow(0);
      }
      var c = calls[i];
      if (!c.available) {
        if (w.log) w.log('info', '全局跳转不可用：' + c.name + '（' + (c.reason || '-') + '），换下一个');
        return tryGlobalAt(i + 1);
      }

      /* 0.5.0 用户要求：点之前先像人一样停 3–5s 再触发跳转
       * （视频刚播完立刻调 PCount.next 是最像脚本的一处时序特征）。 */
      return SH.dom.sleepJitter(w, C.LIMITS.JITTER_CLICK_MS).then(function (slept) {
        if (!slept) return { ok: false, reason: 'aborted' };
        if (!SH.guards.canAct(w, w.epoch)) return { ok: false, reason: 'blocked' };

        try {
          c.fire();
          navGen++;                             /* 这是一次真实跳转尝试：让换页后的任务 key 换新 */
          resetScan();                          /* 换页后要重新扫描分类 */
          if (w.log) w.log('info', '已调用全局跳转：' + c.name
            + (c.argc ? '（' + c.argc + ' 个实参，来源 ' + c.from + '）' : ''));
        } catch (e) {
          if (w.log) w.log('warn', c.name + ' 调用异常，换下一个：' + ((e && e.message) || e));
          return tryGlobalAt(i + 1);
        }
        return settleAfterCall(c.name);
      });
    }

    return tryGlobalAt(0);
  }

  /* ---------------- 手动探针：章节测验页的"下一节"按钮 ----------------
   * 只在 Console 里手动调用：SH.cxStudy.probeQuizNextButton()
   *
   * 只读承诺：不点击、不改属性、不写 DOM、不发请求。
   * 背景：视频播放页的 #prevNextFocusNext 走 PCount.next 已经可用，**不要动**；
   *       章节测验页顶层**没有**这个按钮（在隔离 iframe / 防作弊脚本里），本探针如今只用于
   *       万一需要复核时看一眼有没有残留的 Vue 实例；切页已改走侧边栏（见 nextCatalogAfterActive）。
   */
  function inspectVue(el, maxDepth) {
    var node = el;
    for (var depth = 0; node && depth <= maxDepth; depth++) {
      var vm = null;
      try { vm = node.__vue__; } catch (e) { vm = null; }
      if (!vm) { node = node.parentElement; continue; }

      var info = { found: true, depth: depth, hasOptions: false, methodCount: 0, methodNames: [], componentName: '' };
      try {
        var opts = vm.$options || null;
        info.hasOptions = !!opts;
        if (opts) {
          var methods = opts.methods || null;
          if (methods) {
            var names = Object.keys(methods);
            info.methodCount = names.length;
            info.methodNames = names.slice(0, 40);
          }
          info.componentName = String(opts.name || opts._componentTag || '');
        }
      } catch (e) {
        info.error = String((e && e.message) || e);
      }
      return info;
    }
    return { found: false, depth: -1, hasOptions: false, methodCount: 0, methodNames: [], componentName: '' };
  }

  function inspectHandlers(el) {
    var out = { available: false, types: [], counts: {}, error: null };
    try {
      if (typeof getEventListeners !== 'function') {
        out.error = 'getEventListeners 只在 DevTools Console 里存在（普通页面上下文没有）';
        return out;
      }
      out.available = true;
      var map = getEventListeners(el) || {};
      out.types = Object.keys(map);
      for (var i = 0; i < out.types.length; i++) {
        out.counts[out.types[i]] = (map[out.types[i]] || []).length;
      }
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    return out;
  }

  function describeQuizButton(el, index) {
    var item = {
      index: index,
      tag: String(el.tagName || '').toLowerCase(),
      id: el.id || '',
      className: String(el.className || '').slice(0, 160),
      text: SH.dom.textOf(el),
      rect: SH.dom.rectOf(el),
      isVideoPageButton: el.id === 'prevNextFocusNext',
      hasOnclickAttr: false,
      onclickSnippet: '',
      vue: null,
      handlers: null,
      outerHTML: ''
    };
    try {
      var oc = el.getAttribute('onclick');
      if (oc) { item.hasOnclickAttr = true; item.onclickSnippet = String(oc).slice(0, 200); }
    } catch (e) { /* ignore */ }
    try { item.outerHTML = String(el.outerHTML || '').slice(0, 500); } catch (e) { item.outerHTML = '(取不到 outerHTML)'; }
    item.vue = inspectVue(el, 3);
    item.handlers = inspectHandlers(el);
    return item;
  }

  function probeQuizNextButton() {
    var report = {
      at: new Date().toISOString(),
      url: String(location.href),
      role: (typeof window !== 'undefined' && window.top === window) ? 'top' : 'child',
      candidates: [],
      note: '只读探针：未点击、未修改任何 DOM、未发请求'
    };

    try {
      var nodes = qsa(document, 'button, .btn, [role="button"], a, div, span');
      for (var i = 0; i < nodes.length && report.candidates.length < 8; i++) {
        var el = nodes[i];
        var text = SH.dom.textOf(el);
        if (!text || text.length > 30) continue;          /* 短文本，避免整块容器 */
        if (text.indexOf(SKIP_LABEL) < 0) continue;
        if (!SH.dom.isVisible(el, document)) continue;
        report.candidates.push(describeQuizButton(el, report.candidates.length));
      }
    } catch (e) {
      report.error = String((e && e.message) || e);
    }

    try {
      if (typeof console !== 'undefined' && console.log) {
        console.log('[cxStudy.probeQuizNextButton] 只读探针：候选 ' + report.candidates.length + ' 个（url=' + report.url + '）');
        console.log(report);
        if (!report.candidates.length) {
          console.log('未找到文本含"下一节"的短文本可点元素。请确认当前在章节测验页；若按钮文本不是纯"下一节"（如"下一节 >>"），把它的 outerHTML 发我。');
        } else if (report.candidates[0].vue && report.candidates[0].vue.found) {
          console.log('命中 Vue 实例（深度 ' + report.candidates[0].vue.depth + '），方法名见 vue.methodNames —— 下一步可以安全地只调用它自己的跳转方法。');
        }
      }
    } catch (e) { /* console 不可用就算了 */ }

    return report;
  }

  function next(ctx) {
    var doc = (ctx && ctx.doc) || document;
    var nb = findNextButton(doc);
    if (!nb.ok) return Promise.resolve({ ok: false, reason: nb.reason || 'no-button' });
    return Promise.resolve(turn({ kind: 'turn', mode: 'next', el: nb.el, label: '下一节' }, ctx));
  }

  SH.cxStudy = Object.freeze({
    name: 'chaoxing-study',
    CALIBRATED: true,
    SEL: SEL,
    locateMedia: locateMedia,
    isRealMedia: isRealMedia,
    findPlayButton: findPlayButton,
    fireMouseTriplet: fireMouseTriplet,
    findAndClickPlayButton: findAndClickPlayButton,
    resetWakeClickGate: resetWakeClickGate,
    looksLikeVideoPage: looksLikeVideoPage,
    locateDoc: locateDoc,
    scanAll: scanAll,
    isTaskDone: isTaskDone,
    catalogItems: catalogItems,
    firstPendingCatalog: firstPendingCatalog,
    isCatalogActive: isCatalogActive,
    nextCatalogAfterActive: nextCatalogAfterActive,
    findCurrentCatalogIndex: findCurrentCatalogIndex,
    catalogChapterId: catalogChapterId,
    currentChapterIds: currentChapterIds,
    catalogClickTarget: catalogClickTarget,
    clickCatalogNode: clickCatalogNode,
    catalogAjaxArgs: catalogAjaxArgs,
    clickNative: clickNative,
    findNextButton: findNextButton,
    findInterceptDialog: findInterceptDialog,
    findSkipButton: findSkipButton,
    hasQuestions: hasQuestions,
    probeQuizNextButton: probeQuizNextButton,
    baselineNow: baselineNow,
    pageChanged: pageChanged,
    resetLatch: resetLatch,
    resetScan: resetScan,
    classifyPage: classifyPage,
    hasDeep: hasDeep,
    findDeepOne: findDeepOne,
    pcount: pcount,
    pcountArgs: pcountArgs,
    parseCallArgs: parseCallArgs,
    pageTurnCalls: pageTurnCalls,
    frameSig: frameSig,
    createTurnObserver: createTurnObserver,
    collect: collect,
    turn: turn,
    next: next
  });
})(SH);

/* ================= src/platform/zhihuishu-study.js ================= */
/* study-helper/src/platform/zhihuishu-study.js
 * ⚠ **骨架 + TODO**：选择器未校准，CALIBRATED = false，collect() 永远返回 []（不会误点）。
 *
 * 安全条目：同 chaoxing-study.js（3.12 / 2.1 / 2.2 / 3.7）。
 *
 * 智慧树的结构特点（决定 TODO 的顺序）：
 *   - 播放页分散在多个子站：studyvideoh5 / studyplush5 / studywisdomh5 / hike / fusioncourseh5，
 *     每套的 DOM 都不一样，所以 profile 必须按 `location.hostname` 分支，不能一份选择器打天下。
 *   - 视频多数在**顶层**（不是跨域 iframe），iframe 递归优先级低于超星。
 *   - 章节列表在 `.clearfix`/`ul.list` 一类容器里，任务点的"已完成"标记通常是文字或图标 class。
 *
 * 接口（已定死）：
 *   profileFor(host) → profile 对象
 *   collect({doc, w, mode, info}) → TaskDescriptor[]
 *   next({w, doc}) → Promise<{ok:boolean, reason?:string}>
 *
 * TODO（拿到探针输出后按顺序做）：
 *   TODO-1 按 host 分出 profile（至少 studyvideoh5 / studywisdomh5 两套）。
 *   TODO-2 用 probe 的 `groups.media` 确认 video 在顶层还是 iframe。
 *   TODO-3 用 `groups.study_taskpoints` 的 visible 计数定章节列表容器。
 *   TODO-4 确认"下一节"是列表项点击还是播放器自动跳；必须验证点击后 video 是否被替换。
 *   TODO-5 校准后置 CALIBRATED=true，并加"解析条数"断言。
 *
 * 依赖：SH.const（顶层）。
 */
(function (SH) {
  'use strict';

  var CANDIDATES = Object.freeze({
    media: ['video', '#vjs_container video', '.videoArea video', '.prism-player video'],
    taskpoint: ['.clearfix li', '.list li', '.chapterList li', '.section-list li', '.catalogue li'],
    doc: ['.ppt', '.docBox', 'iframe[src*="ppt"]', '.file-preview']
  });

  var CALIBRATED = false;

  /* 未校准时的兜底：返回空 profile，让 parser 直接解析出 0 题/0 任务，不误操作。 */
  function profileFor() {
    return { name: 'zhihuishu-study-uncalibrated', media: CANDIDATES.media, taskpoint: CANDIDATES.taskpoint, doc: CANDIDATES.doc };
  }

  function collect(ctx) {
    if (!CALIBRATED) {
      if (ctx && ctx.w && ctx.w.log) {
        ctx.w.log('warn', '智慧树章节页选择器未校准（CALIBRATED=false）：不执行任何任务点操作，请先跑 test/probe.js');
      }
      return [];
    }
    return [];
  }

  function next() {
    if (!CALIBRATED) return Promise.resolve({ ok: false, reason: 'not-calibrated' });
    return Promise.resolve({ ok: false, reason: 'todo' });
  }

  SH.zhsStudy = Object.freeze({
    name: 'zhihuishu-study',
    CALIBRATED: CALIBRATED,
    CANDIDATES: CANDIDATES,
    profileFor: profileFor,
    collect: collect,
    next: next
  });
})(SH);

/* 0.5.0 已删除：src/platform/chaoxing-work.js（答题/题库功能整体移除） */

/* 0.5.0 已删除：src/platform/zhihuishu-work.js（答题/题库功能整体移除） */

/* ================= src/ui/theme.js ================= */
/* study-helper/src/ui/theme.js
 * 样式唯一来源：只注入 Shadow Root，**不写 document.head**（安全条目 3.6 / 3.13）。
 *
 * 安全条目：
 *   3.6    不内联 base64 字体、不 @import 外部样式、不引 CDN。
 *   3.13   退出时随宿主元素一起消失（Shadow Root 跟着 host 走），不需要单独清理 <style>。
 *
 * 未验证项：极小屏（<360px）下的折叠行为；深色/浅色跟随系统（用 light-dark() 的降级写法）。
 *
 * 依赖：无（纯字符串）。
 */
(function (SH) {
  'use strict';

  var CSS = [
    ':host{all:initial}',
    ':host{position:fixed;right:16px;bottom:16px;z-index:2147483000;font:13px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#e6e8ec;--sh-bg:#12161f;--sh-bg2:#1a2030;--sh-line:#2b3444;--sh-dim:#9aa4b2;--sh-ok:#4ade80;--sh-warn:#fbbf24;--sh-bad:#f87171;--sh-accent:#60a5fa;}',
    '.wrap{width:360px;max-width:92vw;background:var(--sh-bg);border:1px solid var(--sh-line);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.45);overflow:hidden;display:flex;flex-direction:column}',
    '.wrap.min{width:auto}',
    '.wrap.min .body,.wrap.min .foot{display:none}',
    '.head{display:flex;align-items:center;gap:8px;padding:9px 11px;background:var(--sh-bg2);cursor:move;user-select:none}',
    '.dot{width:8px;height:8px;border-radius:50%;background:var(--sh-dim);flex:0 0 auto}',
    '.dot.on{background:var(--sh-ok)}.dot.pause{background:var(--sh-warn)}.dot.off{background:var(--sh-bad)}',
    '.title{font-weight:600;font-size:13px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.ico{width:22px;height:22px;line-height:20px;text-align:center;border-radius:6px;border:1px solid var(--sh-line);background:transparent;color:var(--sh-dim);cursor:pointer;padding:0}',
    '.body{padding:10px 11px;display:flex;flex-direction:column;gap:9px;max-height:70vh;overflow:auto}',
    '.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}',
    'button.btn{font:inherit;font-size:12px;padding:5px 10px;border-radius:7px;border:1px solid var(--sh-line);background:var(--sh-bg2);color:#e6e8ec;cursor:pointer}',
    'button.btn:hover{border-color:var(--sh-accent)}',
    'button.btn[disabled]{opacity:.4;cursor:not-allowed;border-color:var(--sh-line)}',
    'button.primary{background:#1d4ed8;border-color:#1d4ed8}',
    'button.danger{color:#fecaca;border-color:#7f1d1d}',
    '.kv{font-size:11.5px;color:var(--sh-dim);display:flex;gap:10px;flex-wrap:wrap}',
    '.kv b{color:#e6e8ec;font-weight:600}',
    '.banner{border:1px solid #7c5c12;background:#2a2213;color:#fde68a;border-radius:8px;padding:8px 10px;font-size:12px;display:none}',
    '.banner.show{display:block}',
    '.banner.locked{border-color:#7f1d1d;background:#2a1414;color:#fecaca}',
    '.banner.manual{border-color:#1e40af;background:#132038;color:#bfdbfe}',
    '.sect{border-top:1px solid var(--sh-line);padding-top:8px}',
    '.sect h4{margin:0 0 6px;font-size:11.5px;color:var(--sh-dim);font-weight:600;letter-spacing:.04em}',
    '.log{font:11px/1.5 ui-monospace,Consolas,monospace;background:#0d1117;border:1px solid var(--sh-line);border-radius:8px;padding:6px 8px;height:104px;overflow:auto;white-space:pre-wrap;word-break:break-all}',
    '.log .t{color:#6b7280}.log .warn{color:var(--sh-warn)}.log .error{color:var(--sh-bad)}.log .info{color:#c9d1d9}',
    'input[type=range]{width:100%}',
    'label.ck{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--sh-dim);cursor:pointer}',
    '.foot{border-top:1px solid var(--sh-line);padding:7px 11px;font-size:11px;color:var(--sh-dim)}',
    '.notice{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:20px}',
    '.notice .box{background:var(--sh-bg);border:1px solid var(--sh-line);border-radius:12px;max-width:330px;padding:14px}',
    '.notice h5{margin:0 0 6px;font-size:13px}.notice p{margin:0 0 12px;font-size:12px;color:var(--sh-dim)}',
    '.pill{display:flex;align-items:center;gap:8px;padding:7px 11px;background:var(--sh-bg);border:1px solid var(--sh-line);border-radius:999px;font-size:12px;cursor:pointer}'
  ].join('\n');

  SH.ui = SH.ui || {};
  SH.ui.theme = Object.freeze({ css: CSS });
})(SH);

/* ================= src/ui/logger.js ================= */
/* study-helper/src/ui/logger.js
 * 环形日志（≤100 条）+ 题干脱敏。
 *
 * 0.5.0：Key 掩码整体删除（脚本已无 API Key，日志里也不存在需要掩码的机密）。
 *
 * 安全条目：
 *   3.14 / D9  日志不落盘、不上报；题干只留「前 10 字 + 哈希」，完整题干/选项/答案不进日志。
 *
 * 不变式：
 *   L1 条数上限 LOG_MAX，超出丢最旧（环形）。
 *   L2 push 只接受字符串，任何对象都先 JSON 化再截断（防把 DOM 塞进日志）。
 *   L3 单条 ≤ 300 字，超长截断并标注。
 *
 * 依赖：SH.const（顶层）。
 */
(function (SH) {
  'use strict';

  var C = SH.const;

  function createLogger(opts) {
    var max = (opts && opts.max) || C.LIMITS.LOG_MAX;
    var buf = [];

    /* 只做类型归一，不做任何"脱敏正则"（0.5.0 起没有机密可脱）。 */
    function redact(text) {
      return String(text == null ? '' : text);
    }

    function push(level, msg) {
      var text = msg;
      if (typeof text !== 'string') {
        try { text = JSON.stringify(text); } catch (e) { text = String(text); }
      }
      text = redact(text);
      if (text.length > 300) text = text.slice(0, 300) + '…';

      var now = new Date();
      var hh = ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2) + ':' + ('0' + now.getSeconds()).slice(-2);
      buf.push({ t: hh, level: level || 'info', msg: text });
      while (buf.length > max) buf.shift();
      return text;
    }

    return {
      push: push,
      entries: function () { return buf.slice(); },
      clear: function () { buf = []; },
      redact: redact,
      max: max
    };
  }

  SH.ui = SH.ui || {};
  SH.ui.logger = Object.freeze({ create: createLogger });
})(SH);

/* ================= src/ui/panel.js ================= */
/* study-helper/src/ui/panel.js
 * 面板：原生 Web Component + closed Shadow DOM。样式只进 shadow，不写 document.head。
 *
 * 安全条目：
 *   3.6   用户输入一律 textContent 渲染；不拼 HTML；不引框架；不 @require CDN。
 *   3.13  destroy() 必须移除 host（shadow 里的 <style> 随之消失）、摘掉全部监听、清空状态。
 *   2.3.5 暂停 / 关闭 / 退出 三档按钮；关闭后显示"已关闭，点重新启动恢复"。
 *   2.3.6 总开关关闭时"关闭/退出"按钮置灰。
 *   D8    打开总开关不自动启动，面板必须写清楚（避免以为坏了）。
 *   用户要求3  倍速显示「当前 x.xx（每次启动重置，本次会话可调）」。
 *   2026-10-31 用户裁决：**移除答题功能**，面板不再有 API 地址/Key/跳过答题开关。
 *
 * 不变式：
 *   U1 所有 DOM 通过 createElement/textContent 构建，全文件不出现 HTML 字符串注入。
 *   U2 自建监听列表在 destroy 里逐个摘除；不依赖 worker 账本（面板可能比 worker 活得久）。
 *   U3 面板自身不做任何自动化（不点页面元素、不发请求），只调回调。
 *
 * 未验证项：拖拽在 125%/150% 缩放下边界夹取；窄屏（<360px）折叠。
 *
 * 依赖：SH.const / SH.ui.theme（顶层）；其余函数内。
 */
(function (SH) {
  'use strict';

  var C = SH.const;
  var TAG = 'sh-helper-panel';
  var defined = false;

  function ensureDefined() {
    if (defined) return;
    defined = true;
    try {
      if (typeof customElements === 'undefined' || customElements.get(TAG)) return;
      var El = function () { return Reflect.construct(HTMLElement, [], El); };
      El.prototype = Object.create(HTMLElement.prototype);
      El.prototype.constructor = El;
      Object.setPrototypeOf(El, HTMLElement);
      customElements.define(TAG, El);
    } catch (e) {
      /* 自定义元素不可用（极老浏览器）时退化为普通 div */
    }
  }

  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = String(text);
    return el;
  }

  function clearChildren(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  var STATE_LABEL = {
    idle: '待命', playing: '播放中', reading: '阅读中', searching: '搜题中', filling: '填写中',
    'waiting-manual-play': '等待手动播放', paused: '已暂停', closed: '已关闭', exited: '已退出',
    done: '已完成', error: '出错'
  };

  function create(opts) {
    var o = opts || {};
    ensureDefined();

    var host = document.createElement(TAG);
    host.id = 'sh-panel-host';
    if (!host.attachShadow) return { host: host, root: null, mount: function () {}, destroy: function () {} };

    var root = host.attachShadow({ mode: 'closed' });
    var style = h('style');
    style.textContent = SH.ui.theme.css;
    root.appendChild(style);

    var listeners = [];
    function on(target, type, fn, opt) {
      var rec = [target, type, fn, opt];
      listeners.push(rec);
      target.addEventListener(type, fn, opt);
    }
    function offAll() {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i][0].removeEventListener(listeners[i][1], listeners[i][2], listeners[i][3]); } catch (e) { /* ignore */ }
      }
      listeners = [];
    }

    /* ---------- 骨架 ---------- */
    var wrap = h('div', 'wrap');
    var head = h('div', 'head');
    var dot = h('span', 'dot');
    var title = h('span', 'title', '网课助手');
    var btnMin = h('button', 'ico', '—');
    btnMin.title = '最小化';
    head.appendChild(dot); head.appendChild(title); head.appendChild(btnMin);

    var body = h('div', 'body');
    var banner = h('div', 'banner');
    var bannerText = h('div');
    var bannerRow = h('div', 'row');
    var btnBannerResume = h('button', 'btn', '继续');
    bannerRow.appendChild(btnBannerResume);
    banner.appendChild(bannerText);
    banner.appendChild(bannerRow);

    var kv = h('div', 'kv');

    var actions = h('div', 'grid');
    var btnStart = h('button', 'btn primary', '启动');
    var btnPause = h('button', 'btn', '暂停');
    var btnResume = h('button', 'btn', '继续');
    var btnRestart = h('button', 'btn', '重新启动');
    var btnClose = h('button', 'btn danger', '关闭');
    var btnExit = h('button', 'btn danger', '退出');
    actions.appendChild(btnStart); actions.appendChild(btnPause);
    actions.appendChild(btnResume); actions.appendChild(btnRestart);
    actions.appendChild(btnClose); actions.appendChild(btnExit);

    var taskLine = h('div', 'kv');

    var logSect = h('div', 'sect');
    logSect.appendChild(h('h4', null, '日志（最多 100 条，不含完整题干）'));
    var logBox = h('div', 'log');

    var sectCfg = h('div', 'sect');
    sectCfg.appendChild(h('h4', null, '设置'));
    var ckEnabled = h('input');
    ckEnabled.type = 'checkbox';
    var lbEnabled = h('label', 'ck');
    lbEnabled.appendChild(ckEnabled);
    lbEnabled.appendChild(document.createTextNode('总开关（关掉后不注册观察器、不发请求、不自动播放）'));

    var cfgMsg = h('div', 'kv');

    var speedRow = h('div', 'row');
    var rng = h('input');
    rng.type = 'range'; rng.min = '1'; rng.max = '1.25'; rng.step = '0.05'; rng.value = '1';
    var speedLabel = h('span', 'kv', '当前 1.00（每次启动重置，本次会话可调，最高 1.25）');
    speedRow.appendChild(rng);
    speedRow.appendChild(speedLabel);

    var ckNext = h('input');
    ckNext.type = 'checkbox';
    var lbNext = h('label', 'ck');
    lbNext.appendChild(ckNext);
    lbNext.appendChild(document.createTextNode('自动下一章（默认关；开启后每章间隔 3–5s，每日最多 30 次）'));

    var sectNotice = h('div', 'sect');

    var foot = h('div', 'foot', '自动播放 · 自动跳任务点 · 跳过章节测验 · 倍速≤1.25 · 不碰音量 · 遇认证立即停');

    body.appendChild(banner);
    body.appendChild(kv);
    body.appendChild(actions);
    body.appendChild(taskLine);
    body.appendChild(logSect);
    body.appendChild(sectCfg);
    body.appendChild(sectNotice);
    wrap.appendChild(head);
    wrap.appendChild(body);
    wrap.appendChild(foot);
    root.appendChild(wrap);
    logSect.appendChild(logBox);
    sectCfg.appendChild(lbEnabled);
    sectCfg.appendChild(cfgMsg);
    sectCfg.appendChild(speedRow);
    sectCfg.appendChild(lbNext);

    /* ---------- 模式 ---------- */
    var mounted = false;
    var mountRetry = false;
    var mode = 'ready';
    var visible = true;
    var snapState = null;

    function safe(fn, arg) {
      if (typeof fn !== 'function') return undefined;
      try { return fn(arg); } catch (e) { return undefined; }
    }

    function setMode(next) {
      mode = next;
      if (next === 'exam-blocked') {
        banner.className = 'banner show locked';
        bannerText.textContent = '当前是考试页，脚本已停止，不提供任何自动化（设计如此，不是故障）。';
        bannerRow.style.display = 'none';
        actions.style.display = 'none';
      } else if (next === 'disabled') {
        banner.className = 'banner show';
        bannerText.textContent = '总开关关着：不注册观察器、不发请求、不自动播放。先打开下面的总开关，再点"启动"。';
        bannerRow.style.display = 'none';
        actions.style.display = 'none';
      } else {
        banner.className = 'banner';
        bannerText.textContent = '';
        bannerRow.style.display = '';
        actions.style.display = '';
      }
      refreshButtons();
    }

    /* ---------- 单一真源：状态 → 标题 + 按钮（Bug 1） ----------
     * 之前 title 与 refreshButtons 各算一套，才出现「待命却启动灰」「已完成却暂停可点」
     * 「等待加载按钮不感知」这类矛盾。现在两者都只读 uiModel()：改口径只改这一个函数。
     * 按钮取值：'hidden' 隐藏；true 可见可点；false 可见置灰。 */
    function uiModel() {
      var s = snapState || {};
      var st = s.state || C.STATE.IDLE;
      var started = !!s.started;
      var locked = !!s.lockedOut;
      var waitingMedia = !!s.waitingMedia;

      var label = STATE_LABEL[st] || st || '待命';
      var tone = stateDot(st);

      /* 标题口径：等待加载（仅在运行态）> 运行中（已启动的 idle）> 状态名。
       * 等待中被暂停时仍显示"已暂停"，否则标题会和按钮（暂停态给"继续"）打架。 */
      var running = started && st !== C.STATE.PAUSED && st !== C.STATE.CLOSED &&
        st !== C.STATE.EXITED && st !== C.STATE.ERROR;
      if (waitingMedia && running) { label = '等待加载'; tone = 'dot pause'; }
      else if (started && st === C.STATE.IDLE) { label = '运行中'; }

      var b = {
        start: 'hidden', pause: 'hidden', resume: 'hidden',
        restart: 'hidden', close: 'hidden', exit: 'hidden'
      };
      var out = { label: label, tone: tone, buttons: b, waitingMedia: waitingMedia };

      /* 考试页 / 总开关关闭：动作区整体不可用（setMode 已把 grid 藏起来） */
      if (mode !== 'ready') return out;

      /* 入口面板（还没启动）：待命 → 只有「启动 / 退出」 */
      if (!started) {
        b.start = true;
        b.exit = true;
        return out;
      }

      b.exit = true;   /* 启动之后「退出」始终可用 */

      if (st === C.STATE.PAUSED) {
        b.resume = !locked;
        b.close = true;
        return out;
      }
      if (st === C.STATE.CLOSED) {
        b.restart = !locked;
        return out;
      }
      if (st === C.STATE.EXITED) return out;
      if (waitingMedia || st === C.STATE.DONE) {
        b.restart = !locked;
        b.close = true;
        return out;
      }
      if (st === C.STATE.ERROR) {
        b.close = true;
        return out;
      }

      /* 运行中：idle / playing / reading / searching / filling / waiting-manual-play */
      b.pause = true;
      b.close = true;
      return out;
    }

    var BTN = { start: btnStart, pause: btnPause, resume: btnResume, restart: btnRestart, close: btnClose, exit: btnExit };

    function applyButtons(map) {
      for (var k in BTN) {
        if (!Object.prototype.hasOwnProperty.call(BTN, k)) continue;
        var v = map[k];
        BTN[k].style.display = v === 'hidden' ? 'none' : '';
        BTN[k].disabled = v !== true;
      }
    }

    function refreshButtons() {
      var ui = uiModel();
      applyButtons(ui.buttons);
      btnRestart.textContent = (ui.waitingMedia || (snapState && snapState.state === C.STATE.DONE))
        ? '重新启动（重扫）' : '重新启动';
      btnBannerResume.disabled = !(snapState && snapState.state === C.STATE.PAUSED) || !!(snapState && snapState.lockedOut);
    }

    function stateDot(state) {
      if (state === C.STATE.CLOSED || state === C.STATE.EXITED || state === C.STATE.ERROR) return 'dot off';
      if (state === C.STATE.PAUSED || state === C.STATE.WAITING_MANUAL_PLAY) return 'dot pause';
      if (state === C.STATE.IDLE) return 'dot';
      return 'dot on';
    }

    function setState(snap) {
      snapState = snap || {};
      var s = snapState;
      var ui = uiModel();
      dot.className = ui.tone;
      title.textContent = '网课助手 · ' + ui.label + (s.platform ? ' · ' + s.platform : '');
      if (s.degraded) title.textContent += ' · 存储不可用';

      clearChildren(kv);
      var items = [
        ['定时器', (s.counts && s.counts.timers) || 0],
        ['观察器', (s.counts && s.counts.observers) || 0],
        ['在途请求', (s.counts && s.counts.inflight) || 0],
        ['监听', (s.counts && s.counts.listeners) || 0],
        ['触发', s.triggerCount || 0]
      ];
      for (var i = 0; i < items.length; i++) {
        var seg = h('span');
        seg.appendChild(document.createTextNode(items[i][0] + ' '));
        seg.appendChild(h('b', null, String(items[i][1])));
        kv.appendChild(seg);
      }

      clearChildren(taskLine);
      var t = s.tasks;
      if (t) {
        taskLine.appendChild(document.createTextNode('任务：'));
        taskLine.appendChild(h('b', null, (t.done || 0) + '/' + (t.total || 0)));
        taskLine.appendChild(document.createTextNode(' 失败 '));
        taskLine.appendChild(h('b', null, String(t.failed || 0)));
        if (t.current) {
          taskLine.appendChild(document.createTextNode(' 当前：'));
          taskLine.appendChild(h('b', null, String(t.current)));
        }
      }

      if (s.state === C.STATE.CLOSED) {
        banner.className = 'banner show';
        bannerText.textContent = (s.lockedOut ? '本页已停用（连续触发平台提示）。' : '已关闭。') + '点"重新启动"恢复。';
        bannerRow.style.display = 'none';
      }

      renderLogs(s.logs || []);
      refreshButtons();
    }

    function renderLogs(entries) {
      clearChildren(logBox);
      var start = Math.max(0, entries.length - (C.LIMITS.LOG_MAX));
      for (var i = start; i < entries.length; i++) {
        var e = entries[i];
        var line = h('div');
        var ts = h('span', 't', (e.t || '') + ' ');
        line.appendChild(ts);
        line.appendChild(h('span', e.level || 'info', e.msg || ''));
        logBox.appendChild(line);
      }
      logBox.scrollTop = logBox.scrollHeight;
    }

    function setStatus(text) {
      cfgMsg.textContent = String(text == null ? '' : text);
    }

    function setBanner(b) {
      if (!b) { clearBanner(); return; }
      var kind = b.kind || 'info';
      banner.className = 'banner show' + (kind === 'locked' ? ' locked' : (kind === 'manual-play' ? ' manual' : ''));
      bannerText.textContent = b.text || '';
      bannerRow.style.display = b.canResume ? '' : 'none';
      refreshButtons();
    }

    function clearBanner() {
      banner.className = 'banner';
      bannerText.textContent = '';
      bannerRow.style.display = '';
    }

    /* 通用提示框：默认一个"知道了"按钮；传 cancelText/onCancel 时给第二个选项
     * （夜间提醒用它实现"继续刷课 / 先暂停"）。返回句柄可提前关掉。 */
    function showNotice(n) {
      var notice = n || {};
      var mask = h('div', 'notice');
      var box = h('div', 'box');
      box.appendChild(h('h5', null, notice.title || '提示'));
      box.appendChild(h('p', null, notice.text || ''));
      var row = h('div', 'row');
      var ok = h('button', 'btn primary', notice.ackText || '知道了');
      row.appendChild(ok);
      var cancel = null;
      if (notice.cancelText) {
        cancel = h('button', 'btn', notice.cancelText);
        row.appendChild(cancel);
      }
      box.appendChild(row);
      mask.appendChild(box);
      root.appendChild(mask);

      function dismiss(fn) {
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        safe(fn);
      }

      on(ok, 'click', function () { dismiss(notice.onAck); });
      if (cancel) on(cancel, 'click', function () { dismiss(notice.onCancel); });

      return {
        destroy: function () { if (mask.parentNode) mask.parentNode.removeChild(mask); }
      };
    }

    function markClosed() {
      banner.className = 'banner show';
      bannerText.textContent = '已关闭，点"重新启动"恢复。';
      bannerRow.style.display = 'none';
      refreshButtons();
    }

    function setVisible(v) {
      visible = !!v;
      host.style.display = visible ? '' : 'none';
    }

    function toggle() { setVisible(!visible); return visible; }

    /* ---------- 拖拽 ---------- */
    var drag = null;
    on(head, 'mousedown', function (ev) {
      if (ev.button !== 0) return;
      var r = host.getBoundingClientRect();
      drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top, w: r.width, h: r.height };
      host.style.left = r.left + 'px';
      host.style.top = r.top + 'px';
      host.style.right = 'auto';
      host.style.bottom = 'auto';
      ev.preventDefault();
    });
    on(window, 'mousemove', function (ev) {
      if (!drag) return;
      var x = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - drag.dx));
      var y = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - drag.dy));
      host.style.left = x + 'px';
      host.style.top = y + 'px';
    });
    on(window, 'mouseup', function () { drag = null; });

    /* ---------- 按钮 ---------- */
    on(btnMin, 'click', function () { wrap.classList.toggle('min'); refreshButtons(); });
    on(btnStart, 'click', function () { safe(o.onStart); });
    on(btnPause, 'click', function () { safe(o.onPause); });
    on(btnResume, 'click', function () { safe(o.onResume); });
    on(btnBannerResume, 'click', function () { safe(o.onResume); });
    on(btnRestart, 'click', function () { safe(o.onRestart); });
    on(btnClose, 'click', function (ev) { safe(o.onClose, !!ev.shiftKey); });
    on(btnExit, 'click', function () {
      var ok = true;
      try {
        ok = window.confirm('退出后本页不再自动运行；刷新页面也不会自动激活（需要按 Ctrl+Shift+O 恢复）。彻底卸载请去脚本管理器删除。确定退出？');
      } catch (e) { ok = true; }
      if (ok) safe(o.onExit);
    });
    on(ckEnabled, 'change', function () { safe(o.onToggleEnabled, !!ckEnabled.checked); });
    on(rng, 'input', function () {
      var v = Number(rng.value);
      var r = safe(o.onSpeed, v);
      speedLabel.textContent = '当前 ' + Number(rng.value).toFixed(2) + '（每次启动重置，本次会话可调）' +
        (r && r.warn ? '｜' + r.warn : '');
    });
    on(ckNext, 'change', function () { safe(o.onSetAutoNext, !!ckNext.checked); });

    function refreshCfg() {
      var c = safe(o.onGetConfig) || {};
      ckEnabled.checked = !!c.enabled;
      var sp = Number(c.speed) || 1;
      rng.value = String(sp);
      speedLabel.textContent = '当前 ' + sp.toFixed(2) + '（每次启动重置，本次会话可调）';
      ckNext.checked = c.autoNext === true;
    }

    function mount() {
      if (host.parentNode) { mounted = true; return true; }
      var parent = document.body || document.documentElement;
      if (!parent) {
        /* document-start 时 body 可能还没出来：挂一个一次性监听（已进 listeners，destroy 会摘掉） */
        if (!mountRetry) {
          mountRetry = true;
          on(document, 'DOMContentLoaded', function () {
            mountRetry = false;
            mount();
          });
        }
        return false;
      }
      mounted = true;
      host.style.display = '';
      parent.appendChild(host);
      refreshCfg();
      refreshButtons();
      return true;
    }

    function destroy() {
      offAll();
      try { if (host.parentNode) host.parentNode.removeChild(host); } catch (e) { /* ignore */ }
      clearChildren(root);
      mounted = false;
      snapState = null;
      return true;
    }

    refreshCfg();

    return {
      host: host,
      root: root,
      mount: mount,
      destroy: destroy,
      toggle: toggle,
      setVisible: setVisible,
      setMode: setMode,
      setState: setState,
      setStatus: setStatus,
      setBanner: setBanner,
      clearBanner: clearBanner,
      showNotice: showNotice,
      markClosed: markClosed,
      isMounted: function () { return mounted; },
      _els: { wrap: wrap, log: logBox, banner: banner, bannerText: bannerText, actions: actions, kv: kv, head: head, buttons: { start: btnStart, pause: btnPause, resume: btnResume, restart: btnRestart, close: btnClose, exit: btnExit } }
    };
  }

  SH.ui = SH.ui || {};
  SH.ui.panel = Object.freeze({ create: create, TAG: TAG });
})(SH);

/* ================= src/ui/exit-layer.js ================= */
/* study-helper/src/ui/exit-layer.js
 * 退出后的最小恢复浮层：懒创建、单例、可彻底销毁。
 *
 * 安全条目：
 *   3.13  退出只留这一个入口；恢复后必须 destroy()（host + shadow 样式 + 监听全部消失）。
 *   3.6   纯 DOM 构建，不拼 HTML。
 *
 * 不变式：
 *   E1 单例：重复 show() 不产生第二个浮层。
 *   E2 只提供一个按钮（恢复）与一句说明，不提供任何自动化入口。
 *   E3 destroy() 后再次 show() 会重新创建（不复用旧 host）。
 *
 * 未验证项：无（纯 UI，风险最低的一块）。
 *
 * 依赖：SH.ui.theme（顶层）。
 */
(function (SH) {
  'use strict';

  var host = null;
  var root = null;
  var listeners = [];
  var onRestore = null;

  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = String(text);
    return el;
  }

  function offAll() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i][0].removeEventListener(listeners[i][1], listeners[i][2]); } catch (e) { /* ignore */ }
    }
    listeners = [];
  }

  function build() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'sh-exit-host';
    root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;

    var style = h('style');
    style.textContent = SH.ui.theme.css;
    root.appendChild(style);

    var wrap = h('div', 'wrap');
    var pill = h('div', 'pill');
    pill.appendChild(h('span', 'dot off'));
    pill.appendChild(document.createTextNode('脚本已退出（本页静默）'));
    wrap.appendChild(pill);

    var row = h('div', 'row');
    var btn = h('button', 'btn primary', '恢复运行');
    row.appendChild(btn);
    wrap.appendChild(row);

    var tip = h('div', 'foot', 'Ctrl+Shift+O 也可以唤出这个入口。刷新页面不会自动激活。');
    wrap.appendChild(tip);

    root.appendChild(wrap);

    function restore(ev) {
      if (ev) { try { ev.preventDefault(); } catch (e) { /* ignore */ } }
      if (typeof onRestore === 'function') {
        try { onRestore(); } catch (e) { /* ignore */ }
      }
      hide();
    }

    btn.addEventListener('click', restore);
    listeners.push([btn, 'click', restore]);
  }

  function show(opts) {
    if (opts && typeof opts.onRestore === 'function') onRestore = opts.onRestore;
    build();
    var parent = document.body || document.documentElement;
    if (!parent) return false;
    if (!host.parentNode) parent.appendChild(host);
    host.style.display = '';
    return true;
  }

  function hide() {
    if (host) host.style.display = 'none';
    return true;
  }

  function destroy() {
    offAll();
    if (host && host.parentNode) {
      try { host.parentNode.removeChild(host); } catch (e) { /* ignore */ }
    }
    if (root) {
      while (root.firstChild) root.removeChild(root.firstChild);
    }
    host = null;
    root = null;
    return true;
  }

  function setHandler(fn) { onRestore = fn; }

  SH.ui = SH.ui || {};
  SH.ui.exitLayer = Object.freeze({
    show: show,
    hide: hide,
    destroy: destroy,
    setHandler: setHandler,
    isMounted: function () { return !!(host && host.parentNode); }
  });
})(SH);

/* ================= src/main.js ================= */
/* study-helper/src/main.js
 * 唯一入口 + 运行时编排。boot() 只做判定与分派；start() 才构造运行时。
 *
 * 安全条目：
 *   2.3.1 / 3.5  六步启动保证"总开关关闭时零激活"。
 *   3.13         exited 检查早于一切运行时构造；退出后只注册快捷键 + 最小浮层。
 *   3.4          认证/异常命中 → pause（清定时器/观察器/在途请求）→ 弹提示 → 不自动恢复；
 *                "继续"前必须 scanOnce 复检，仍命中则拒绝恢复。
 *   D5           考试页硬阻断。
 *   D7           第二次触发不再给"继续"，直接 closed + lockedOut。
 *   D8           打开总开关不自动启动。
 *   0.5.0        答案提示模式说明已删除（不做题了）；改为 00:00–06:00 夜间提醒（可选择继续）。
 *
 * 不变式：
 *   M1 模块顶层零执行：只定义函数与冻结对象；dist 尾部才调 boot()。
 *   M2 boot 幂等。
 *   M3 快捷键监听不归 worker 账本管（退出态下 worker 不存在），由 hotkeyBound 单独持有，只有一个 handler。
 *   M4 所有 UI 调用都做存在性判断（P4 之前 SH.ui 缺失时 boot 不炸）。
 *
 * 未验证项：真实平台的"任务点采集器"（platform/*.js）尚未接探针结果，目前为空数组。
 *
 * 依赖：SH.const（顶层）；其余函数内惰性取用。
 */
(function (SH) {
  'use strict';

  var C = SH.const;
  var S = C.STATE;
  var R = C.PAUSE_REASON;

  var booted = false;
  var hotkeyBound = false;
  var hotkeyHandler = null;
  var pageHideBound = false;
  var rt = null;
  var launcher = null;      /* 启动前的入口面板（rt 建立后销毁，避免出现两个面板） */
  var launcherMode = 'ready';
  var subs = [];
  var sid = 's' + Math.random().toString(36).slice(2, 9);

  function syncLauncherMode() {
    if (!launcher) return false;
    /* 考试页是被硬阻断的，不能因为用户拨开关就放行 */
    if (launcherMode !== 'ready' && launcherMode !== 'disabled') return false;
    var next = SH.sw.isEnabled() ? 'ready' : 'disabled';
    if (next === launcherMode) return false;
    launcherMode = next;
    launcher.setMode(next);
    return true;
  }

  function panelCallbacks() {
    return {
      onStart: function () { return start(); },
      onToggleEnabled: function (v) { SH.sw.setEnabled(v); syncLauncherMode(); notify(); },
      onSetAutoNext: function (v) { SH.store.setCfg({ autoNext: !!v }); notify(); },
      onGetConfig: function () {
        var c = SH.store.cfg();
        return {
          speed: c.speed,
          enabled: SH.sw.isEnabled(),
          autoNext: c.autoNext
        };
      }
    };
  }

  function mountLauncher(mode) {
    if (!SH.ui || !SH.ui.panel) return null;
    if (launcher) { try { launcher.destroy(); } catch (e) { /* ignore */ } }
    launcher = SH.ui.panel.create(panelCallbacks());
    launcher.mount();
    launcherMode = mode;
    launcher.setMode(mode);
    /* Bug 1：launcher 阶段也要有状态文字（待命）和与之一致的按钮口径 */
    launcher.setState(snapshot());
    return launcher;
  }

  function dropLauncher() {
    if (!launcher) return false;
    try { launcher.destroy(); } catch (e) { /* ignore */ }
    launcher = null;
    return true;
  }

  /* ---------------- 判定 ---------------- */

  function decide(info, env) {
    var e = env || {};
    if (!info || !info.platform) return { action: 'ignore', reason: (info && info.reason) || 'unsupported-host' };
    if (e.exited === true) return { action: 'exited', reason: 'session-exited' };
    if (info.role === C.ROLE.CHILD) return { action: 'child-wait', reason: 'frame-child' };
    if (SH.platform.isExamBlocked(info)) return { action: 'exam-blocked', reason: 'exam-page' };
    if (e.enabled !== true) return { action: 'disabled', reason: 'master-off' };
    return { action: 'launcher', reason: 'ok' };
  }

  /* ---------------- 状态广播 ---------------- */

  function snapshot() {
    var base = {
      ready: !!rt,
      started: !!rt,
      state: S.IDLE,
      pausedReason: null,
      platform: null,
      mode: null,
      counts: { timers: 0, observers: 0, inflight: 0, listeners: 0 },
      triggerCount: 0,
      lockedOut: false,
      logs: [],
      tasks: null,
      reader: null,
      player: null,
      enabled: SH.sw.isEnabled(),
      speed: SH.store.cfg().speed,
      degraded: SH.store.isDegraded()
    };
    if (!rt) return base;

    var w = rt.w.snapshot();
    base.state = w.state;
    base.pausedReason = w.pausedReason;
    base.platform = rt.info.platform;
    base.mode = rt.info.mode;
    base.counts = w.counts;
    base.triggerCount = w.triggerCount;
    base.lockedOut = rt.lockedOut;
    base.logs = rt.logger ? rt.logger.entries() : [];
    base.tasks = rt.loop ? rt.loop.snapshot() : null;
    base.waitingMedia = !!rt.waitingMedia;
    base.reader = rt.reader ? rt.reader.snapshot() : null;
    base.player = rt.player ? rt.player.snapshot() : null;
    return base;
  }

  function notify() {
    var snap = snapshot();
    for (var i = 0; i < subs.length; i++) {
      try { subs[i](snap); } catch (e) { /* UI 异常不能影响运行时 */ }
    }
    if (rt && rt.panel) { try { rt.panel.setState(snap); } catch (e) { /* ignore */ } }
    else if (launcher) { try { launcher.setState(snap); } catch (e) { /* ignore */ } }
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    subs.push(fn);
    return function () { var i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); };
  }

  /* ---------------- 平台模块 ---------------- */

  function moduleFor(info) {
    if (!info) return null;
    if (info.platform === C.PLATFORM.CX) {
      /* 2026-10-31 用户裁决：**答题功能移除**，不再做题。
       * 作业/章节测验页也交给章节模块：检测到题目 → 等 3s → 点右侧目录跳过。 */
      if (info.mode === C.MODE.STUDY || info.mode === C.MODE.WORK) return SH.cxStudy || null;
      return null;
    }
    if (info.platform === C.PLATFORM.ZHS) {
      if (info.mode === C.MODE.STUDY || info.mode === C.MODE.WORK) return SH.zhsStudy || null;
      return null;
    }
    return null;
  }

  /* ---------------- 运行时 ---------------- */

  function makeLogger() {
    if (SH.ui && SH.ui.logger) return SH.ui.logger.create({ max: C.LIMITS.LOG_MAX });
    return { push: function () {}, entries: function () { return []; }, clear: function () {}, redact: function (s) { return s; } };
  }

  function createRuntime(info) {
    var logger = makeLogger();
    var obj = {
      info: info,
      logger: logger,
      w: null,
      player: null,
      reader: null,
      loop: null,
      guard: null,
      supervisor: null,
      panel: null,
      lockedOut: false,
      heartbeat: null,
      startedAt: Date.now()
    };

    obj.w = SH.worker.createWorker({
      platform: info.platform,
      mode: info.mode,
      role: info.role,
      log: function (level, msg) { logger.push(level, msg); notify(); },
      hooks: {
        onPause: function (reason) { onPaused(obj, reason); },
        onResume: function () { onResumed(obj); },
        onClosed: function (meta) { onClosed(obj, meta); },
        onExit: function () { onExitUI(obj); },
        onExited: function () { SH.store.markExited(); },
        rebuild: function () { rebuildSubsystems(obj); }
      }
    });
    obj.w.onChange = function () { notify(); };

    obj.player = SH.media.createPlayer(obj.w, {
      onNeedManualPlay: function () { onNeedManualPlay(obj); },
      onAdvance: function () { logger.push('info', '任务点播完，准备切下一个'); },
      /* 异步 play() 失败（媒体元素没有可播源等）。只记下来，由 runTask 决定怎么收场：
       * 绝不能"重试"，也绝不能放任 waitFinished 一直等 ended（那是挂死）。 */
      onPlayFailed: function (ev) { obj.lastPlayFailed = (ev && ev.name) || 'Error'; },
      onState: function () { notify(); }
    });

    obj.supervisor = SH.media.createVisibilitySupervisor(obj.w, {
      onHidden: function () {
        if (obj.player) obj.player.pause();
        logger.push('info', '页面切到后台，已暂停（回来自动继续）');
      },
      onVisible: function () { resume(); }
    });

    rebuildSubsystems(obj);

    if (SH.ui && SH.ui.panel) {
      obj.panel = SH.ui.panel.create({
        onStart: function () { start(); },
        onPause: function () { pause(R.USER); },
        onResume: function () { resume(); },
        onClose: function (hard) { close({ hard: hard }); },
        onRestart: function () { restart(); },
        onExit: function () { exit(); },
        onSpeed: function (v) {
          var r = obj.player ? obj.player.setRate(v) : { ok: false, error: 'no-player' };
          logger.push(r.ok ? 'info' : 'warn', r.ok ? ('倍速设为 ' + r.applied) : (r.warn || r.error));
          return r;
        },
        onToggleEnabled: function (v) { SH.sw.setEnabled(v); notify(); },
        onSetAutoNext: function (v) { SH.store.setCfg({ autoNext: !!v }); notify(); },
        onGetConfig: function () {
          var c = SH.store.cfg();
          return {
            speed: c.speed,
            enabled: SH.sw.isEnabled(),
            autoNext: c.autoNext
          };
        }
      });
    }
    return obj;
  }

  /* 子机重建：**不复用旧引用**（epoch 已变） */
  function rebuildSubsystems(obj) {
    if (obj.guard) obj.guard.stop();
    obj.guard = SH.authGuard.createGuard(obj.w);
    obj.guard.setHandler(function (hit) { onGuardHit(obj, hit); });

    if (obj.loop) obj.loop.stop();
    obj.loop = SH.taskLoop.createLoop(obj.w, {
      collector: function (ctx) {
        var mod = moduleFor(obj.info);
        if (!mod || typeof mod.collect !== 'function') return [];
        try { return mod.collect({ doc: document, w: obj.w, mode: obj.info.mode, info: obj.info }) || []; }
        catch (e) { obj.logger.push('error', '采集器异常：' + ((e && e.message) || e)); return []; }
      },
      dispatch: function (task) { return dispatchTask(obj, task); }
    });
  }

  function dispatchTask(obj, task) {
    obj.currentTask = task;
    return runTask(obj, task).then(function (r) {
      obj.currentTask = null;
      return r;
    }, function (e) {
      obj.currentTask = null;
      throw e;
    });
  }

  function runTask(obj, task) {
    if (task.kind === 'video') {
      if (!task.el) return Promise.resolve({ ok: false, error: 'no-media-element' });
      if (task.frameKey) obj.logger.push('info', '视频位于子帧 ' + task.frameKey);

      obj.lastPlayFailed = null;
      var at = obj.player.attach(task.el);
      if (!at.ok) return Promise.resolve({ ok: false, error: at.error || 'attach-failed' });

      /* 老式同步 play() 抛错：attach 已经把错误放在 at.play 里。 */
      var pr0 = at.play || null;
      if (pr0 && pr0.ok === false) {
        if (pr0.needManual) return Promise.resolve({ ok: false, needManual: true, error: 'play-blocked' });
        if (pr0.error && pr0.error !== 'blocked' && pr0.error !== 'not-alive') {
          obj.player.detach();
          obj.logger.push('warn', 'play() 同步失败（' + pr0.error + '）：不重试，交给重新扫描');
          return Promise.resolve({ ok: true, skipped: 'play-failed' });
        }
      }

      /* 视频没播完不许切下一节：这里等 ended（或被打断）才放行（安全条目 2.1）。
       * 2026-10-31：**再加一道看门狗** —— 有的播放器（或元素被平台替换时）不派发 ended，
       * 只看事件会永远挂着（真机症状：视频到 100% 但脚本毫无反应、连日志都没有）。
       * 看门狗每 2s 检查：ended / currentTime 到结尾 / 元素被换掉后的新元素已到结尾 → 放行。 */
      var watchdog = null;

      function stopWatchdog() {
        if (watchdog) {
          try { obj.w.clearTimer(watchdog); } catch (e) { /* ignore */ }
          watchdog = null;
        }
      }

      function endedByState(x) {
        if (!x) return false;
        try {
          if (x.ended) return true;
          if (x.duration > 0 && isFinite(x.duration) && x.currentTime >= x.duration - 1) return true;
        } catch (e) { /* ignore */ }
        return false;
      }

      function videoAlreadyFinished() {
        var el = task.el;
        if (el && el.isConnected !== false && endedByState(el)) return true;
        /* 元素被平台换掉了：看页面上现在那个媒体有没有播到结尾 */
        try {
          var m = SH.cxStudy && SH.cxStudy.locateMedia ? SH.cxStudy.locateMedia(document) : null;
          if (m && m.ok && m.el !== el && endedByState(m.el)) return true;
        } catch (e2) { /* ignore */ }
        return false;
      }

      function watchVideo() {
        watchdog = null;
        if (!obj.w.alive()) return;
        if (videoAlreadyFinished()) {
          obj.logger.push('warn', '没收到 ended 事件，但视频已到结尾：按"播完"处理');
          obj.player.forceFinish(true);
          return;
        }
        watchdog = obj.w.setTimer(watchVideo, 2000, 'video-watchdog');
      }

      watchdog = obj.w.setTimer(watchVideo, 2000, 'video-watchdog');

      return obj.player.waitFinished().then(function (done) {
        stopWatchdog();
        /* 主动关闭打断：返回 closing，让 task-loop 当"已收尾"，不报 video-interrupted */
        if (!done && (obj.w.state === S.CLOSED || obj.w.stopping)) return { ok: true, closing: true };

        /* 假视频（空壳 <video> 没有可播的源）→ play() 抛 NotSupportedError。
         * 既不当"视频被打断"，也绝不重试：摘掉播放器、让任务正常收场，
         * task-loop 重新 collect() 时这个元素会被 locateMedia 的 isRealMedia 过滤掉
         * → 页面没有视频 → 自动落到扫描/目录兜底。 */
        if (!done && obj.lastPlayFailed === 'NotSupportedError') {
          obj.lastPlayFailed = null;
          obj.player.detach();
          if (obj.w.state === S.PLAYING) { try { obj.w.transition(S.IDLE); } catch (e) { /* ignore */ } }
          obj.logger.push('warn', '该 <video> 没有可播放的源（NotSupportedError）：跳过并重新扫描');
          return { ok: true, skipped: 'fake-media' };
        }

        obj.lastPlayFailed = null;
        return { ok: !!done, error: done ? null : 'video-interrupted' };
      });
    }
    if (task.kind === 'doc') {
      obj.reader = SH.reader.createReader(obj.w);
      var a = obj.reader.attach(task.el || null);
      if (!a.ok) return Promise.resolve({ ok: false, error: a.error });
      return obj.reader.start().then(function (ok) {
        return { ok: !!ok };
      });
    }
    if (task.kind === 'work') {
      /* 2026-10-31 用户裁决：答题功能移除。正常路径已不会走到这里（moduleFor 已把作业页交给
       * 章节模块）；万一有旧任务残留，也绝不再调 fillCurrent 去请求题库/填答案。 */
      obj.logger.push('warn', '答题功能已移除：本页不做题，交给右侧目录跳过');
      return Promise.resolve({ ok: false, error: 'answer-disabled' });
    }
    if (task.kind === 'turn') {
      var m2 = moduleFor(obj.info);
      if (!m2) return Promise.resolve({ ok: false, error: 'no-module' });
      var pr;
      if (typeof m2.turn === 'function') {
        pr = Promise.resolve(m2.turn(task, { w: obj.w, doc: document }));
      } else if (typeof m2.next === 'function') {
        pr = Promise.resolve(m2.next({ w: obj.w, doc: document }));
      } else {
        return Promise.resolve({ ok: false, error: 'no-turn-handler' });
      }
      return pr.then(function (r) {
        if (r && r.needManual) {
          onTurnFailed(obj, r);
          return { ok: true, needManual: true };   /* 已暂停，循环下一步会自动停；不要记成"任务点失败" */
        }
        /* 2026-10-31：真跳转（PCount.next / 点目录）后统一打这一行，然后重新扫描分类 */
        if (r && r.reason === 'force-rescan') logScanStart(obj);
        return r;
      });
    }
    return Promise.resolve({ ok: false, error: 'unknown-kind' });
  }

  function runLoop(obj) {
    if (!obj || !obj.loop) return;
    var p = obj.loop.start();
    Promise.resolve(p).then(function (r) {
      var why = (r && r.why) || '';
      if (!obj.logger) return;
      if (why === 'paused') { obj.logger.push('info', '已挂起，等待人工处理（不会自动重试）'); return; }
      if (why === 'empty') {
        obj.logger.push('info', '本页暂无更多任务点');
        /* 章节页：下一节视频可能还在加载 —— 进入"等待加载"，出现视频就自动接管（Bug 3）。
         * 只有"连等待都做不到"（非章节页/未校准）才记 DONE（已完成）。 */
        if (obj.info.mode === C.MODE.STUDY && startMediaWait(obj)) return;
        markPageDone(obj);
        return;
      }
      if (why === '' || why === 'stopped' || why === 'blocked' || why === 'stopping' || why === 'closing') {
        return;
      }
      obj.logger.push('info', '任务循环结束：' + why);
    }, function (e) {
      if (obj.logger) obj.logger.push('error', '任务循环异常：' + ((e && e.message) || e));
    });
  }

  /* 只有"本页确实没有可做的任务点"才记 DONE（已完成）。
   * 单个视频播完 / 单篇文档读完都只是"一个任务点完成"，回到 IDLE 继续下一个（Bug 2）。
   * DONE 下仍允许"重新启动（重扫）"，所以它不是锁死状态。 */
  function markPageDone(obj, quiet) {
    if (!obj || !obj.w) return false;
    var st = obj.w.state;
    if (st === S.DONE || st === S.PAUSED || st === S.CLOSED || st === S.EXITED) return false;
    try { obj.w.transition(S.DONE); } catch (e) { return false; }
    if (!quiet && obj.logger) obj.logger.push('info', '本页任务已处理完（已完成）');
    return true;
  }

  /* ---------------- 等待新视频加载（Bug 3） ----------------
   * 点完"下一节"后新视频常常要几秒才注入。此时 task-loop 会"扫不到任务"而结束，
   * 之前就直接停在 DONE，平台自己把视频播起来，脚本再也不管了（状态脱节）。
   * 现在：进入"等待加载"，用 800±300ms 轮询（跨域 iframe 无法用 MutationObserver 观察，
   * 且全树观察违反安全条目 3.2），一旦出现媒体元素就切回 IDLE 并重启任务循环。
   *
   * 2026-10-31 与 `turn()` 的 wait-catalog 整合：这里也走**同一套唤醒**（点黑屏播放键，最多 2 次），
   * 且预算对齐 —— 视频页 15s、非视频页保留 90s。因为这条路径只在"整页没有任务点"时兜底，
   * 而 15s 已经是"有播放键可点"时的合理上限（再等就是平台真的没东西可看了）。
   * pause/close/exit 都会停止它。 */
  function startMediaWait(obj) {
    stopMediaWait(obj);
    if (!obj || !SH.cxStudy || !SH.cxStudy.CALIBRATED) return false;

    var videoPage = false;
    try { videoPage = !!SH.cxStudy.looksLikeVideoPage(document); } catch (e) { videoPage = false; }
    var budgetMs = videoPage ? 15000 : 90000;

    obj.waitingMedia = true;
    obj.waitStartedAt = Date.now();
    obj.waitWakeClicks = 0;
    if (obj.panel) obj.panel.setStatus('等待新视频加载…');
    if (obj.logger) obj.logger.push('info', '未发现任务点：等待新视频加载（最多 ' + Math.round(budgetMs / 1000) + 's）');
    /* "等待加载"不是"已完成"：DONE 只留给真的没有任务可做（Bug 1/2）。
     * 若上一轮遗留 DONE，先退回 IDLE，让等待处于一个干净的运行态。 */
    if (obj.w.state === S.DONE) {
      try { obj.w.transition(S.IDLE); } catch (e) { /* ignore */ }
    }
    notify();

    function poll() {
      obj.mediaWaitTimer = null;
      if (!obj.waitingMedia) return;
      if (!obj.w.alive()) return;

      if (Date.now() - obj.waitStartedAt > budgetMs) {
        obj.waitingMedia = false;
        if (obj.logger) obj.logger.push('warn', '等待新视频超时，停在当前页（不重试）');
        if (obj.panel) obj.panel.setStatus('等待超时，停在当前页');
        markPageDone(obj, true);   /* 已完成：用户可点"重新启动（重扫）"再试 */
        return;
      }

      /* 与 wait-catalog 同一个唤醒动作：每轮没视频就点一次黑屏播放键（最多 2 次）。 */
      if (obj.waitWakeClicks < 2) {
        try {
          if (SH.cxStudy.findAndClickPlayButton(document, obj.w)) obj.waitWakeClicks++;
        } catch (e) { /* ignore */ }
      }

      var found = false;
      try { found = !!SH.cxStudy.locateMedia(document).ok; } catch (e) { found = false; }

      if (found) {
        obj.waitingMedia = false;
        if (obj.logger) obj.logger.push('info', '检测到新视频，继续接管');
        if (obj.panel) obj.panel.setStatus('已接管新视频');
        try { obj.w.transition(S.IDLE); } catch (e) { /* ignore */ }
        if (obj.loop) obj.loop.reset();
        runLoop(obj);
        return;
      }

      obj.mediaWaitTimer = obj.w.setTimer(poll, SH.dom.randomIntInRange(C.LIMITS.JITTER_POLL_MS), 'media-wait');
    }

    obj.mediaWaitTimer = obj.w.setTimer(poll, SH.dom.randomIntInRange(C.LIMITS.JITTER_POLL_MS), 'media-wait');
    return true;
  }

  function stopMediaWait(obj) {
    if (!obj) return false;
    obj.waitingMedia = false;
    if (obj.mediaWaitTimer && obj.w) { obj.w.clearTimer(obj.mediaWaitTimer); obj.mediaWaitTimer = null; }
    return true;
  }

  function startHeartbeat(obj) {
    function tick() {
      if (!obj.w.alive()) return;
      SH.store.lockHeartbeat(sid);
      /* 0.5.0：跨零点也提醒（23:xx 开始一直刷到 0 点后同样会弹；每会话仅一次，重复调用是空操作） */
      if (obj.w.state !== S.PAUSED && obj.w.state !== S.CLOSED && obj.w.state !== S.EXITED) {
        maybeShowNightNotice(obj);
      }
      obj.heartbeat = obj.w.setTimer(tick, C.LIMITS.LOCK_HEARTBEAT_MS, 'lock-heartbeat');
    }
    obj.heartbeat = obj.w.setTimer(tick, C.LIMITS.LOCK_HEARTBEAT_MS, 'lock-heartbeat');
  }

  /* ---------------- 暂停 / 恢复 / 关闭 / 退出 ---------------- */

  function onPaused(obj, reason) {
    if (obj.player) obj.player.pause();
    if (obj.guard) obj.guard.stop();
    if (obj.loop) obj.loop.stop();
    if (obj.panel) {
      obj.panel.setStatus(reason === R.VISIBILITY ? '已切到后台，回来自动继续' : '已暂停');
    }
    notify();
  }

  function onResumed(obj) {
    if (obj.guard) obj.guard.start(document, obj.info.platform);
    if (obj.panel) obj.panel.clearBanner();
    runLoop(obj);
    notify();
  }

  function onClosed(obj, meta) {
    stopMediaWait(obj);
    if (obj.guard) obj.guard.stop();
    if (obj.supervisor) obj.supervisor.unbind();
    if (obj.loop) obj.loop.stop();
    if (obj.player) obj.player.detach();
    if (obj.panel) obj.panel.markClosed({ hard: meta && meta.hard, by: meta && meta.by });
    SH.store.lockRelease(sid);
    notify();
  }

  function onExitUI(obj) {
    stopTurnWatcher();
    stopMediaWait(obj);
    if (obj.guard) obj.guard.stop();
    if (obj.supervisor) obj.supervisor.unbind();
    if (obj.loop) obj.loop.stop();
    if (obj.player) obj.player.detach();
    if (obj.panel) obj.panel.destroy();
    showExitLayer();
    SH.store.lockRelease(sid);
    rt = null;
    notify();
  }

  function showExitLayer() {
    if (!SH.ui || !SH.ui.exitLayer || typeof SH.ui.exitLayer.show !== 'function') return false;
    SH.ui.exitLayer.show({ onRestore: function () { restore(); } });
    return true;
  }

  /* ---------------- "下一节"点不动：交给人工，等页面变化 ---------------- */

  var turnWatch = null;

  function stopTurnWatcher() {
    if (!turnWatch) return false;
    try { clearTimeout(turnWatch.timer); } catch (e) { /* ignore */ }
    if (turnWatch.frames) {
      for (var i = 0; i < turnWatch.frames.length; i++) {
        try { turnWatch.frames[i].el.removeEventListener('load', turnWatch.frames[i].fn, true); } catch (e) { /* ignore */ }
      }
    }
    if (turnWatch.observer) {
      try { turnWatch.observer.disconnect(); } catch (e) { /* ignore */ }
    }
    turnWatch = null;
    return true;
  }

  /* 唯一第二处"账本外"轮询（与 visibility supervisor 同级例外）：
   * pause 会清掉 worker 账本里的定时器，而"等用户手动切页"必须在 paused 状态下继续。
   * 双通道：① 800±300ms 轮询 pageChanged；② 给每个 iframe 挂 load 监听（播放器重载=切页的强信号）。
   * 约束：只有这两处、最长 10 分钟、任何 resume/close/exit 都必须 stopTurnWatcher()。 */
  function startTurnWatcher(obj, baseline) {
    stopTurnWatcher();
    var started = Date.now();
    var target = obj;

    function wake(reason) {
      if (!rt || rt !== target) return;
      if (target.logger) target.logger.push('info', '检测到' + reason + '，继续');
      if (SH.cxStudy && SH.cxStudy.resetLatch) SH.cxStudy.resetLatch();
      resume();
    }

    function check(reason) {
      var changed = false;
      try { changed = !!(SH.cxStudy && SH.cxStudy.pageChanged && SH.cxStudy.pageChanged(baseline)); }
      catch (e) { changed = false; }
      if (changed) { wake(reason); return true; }
      return false;
    }

    function tick() {
      if (!turnWatch) return;
      turnWatch.timer = null;
      if (!rt || rt !== target || target.w.state !== S.PAUSED) { stopTurnWatcher(); return; }
      if (Date.now() - started > 600000) {
        if (target.logger) target.logger.push('warn', '等待手动切页超时（10 分钟），已停止监听');
        stopTurnWatcher();
        return;
      }
      if (check('页面已切换')) return;
      turnWatch.timer = setTimeout(tick, SH.dom.randomIntInRange(C.LIMITS.JITTER_POLL_MS));
    }

    var frames = [];
    try {
      var list = document.querySelectorAll('iframe');
      for (var i = 0; i < list.length && i < 8; i++) {
        (function (f) {
          var fn = function () {
            if (!rt || rt !== target) return;
            check('播放器 iframe 已重载');
          };
          f.addEventListener('load', fn, true);
          frames.push({ el: f, fn: fn });
        })(list[i]);
      }
    } catch (e) { frames = []; }

    var observer = null;
    try {
      observer = (SH.cxStudy && SH.cxStudy.createTurnObserver)
        ? SH.cxStudy.createTurnObserver(document, function () {
          if (!rt || rt !== target) return;
          check('页面结构发生变化');
        })
        : null;
    } catch (e) { observer = null; }

    turnWatch = { timer: setTimeout(tick, 600), frames: frames, observer: observer };
  }

  function onTurnFailed(obj, r) {
    if (obj.logger) obj.logger.push('warn', '自动切页失败（' + ((r && r.reason) || 'unknown') + '），转为人工');
    obj.w.pause(R.TURN_FAILED);
    if (obj.panel) {
      /* 黄条文案按原因分流：拦截框 → 明确告诉用户"平台限制跳转"；目录 → 让用户点目录。 */
      var reason = String((r && r.reason) || '');
      var text;
      if (/^intercept-/.test(reason)) {
        text = '测验未完成平台限制跳转，请手动点击弹窗内的【下一节】或完成测验。';
      } else if (reason === 'catalog-unavailable') {
        text = '找不到目录，重试 3 次失败，脚本已暂停。请手动点右侧目录，或刷新页面后重新启动。';
      } else if (/^quiz-/.test(reason)) {
        text = '无法自动跳转，请手动点右侧目录。检测到页面切换后会自动继续（不会反复点击）。';
      } else {
        text = '自动切页失败，请手动点"下一节"离开。检测到页面切换或播放器重载后会自动继续（不会反复点击）。';
      }
      obj.panel.setBanner({ kind: 'turn-failed', text: text, canResume: true });
    }
    startTurnWatcher(obj, (r && r.baseline) || null);
  }

  function onNeedManualPlay(obj) {
    if (obj.panel) {
      obj.panel.setBanner({
        kind: 'manual-play',
        text: '浏览器拦截了自动播放（浏览器策略，不是脚本故障）。请手动点一次播放，之后会自动续播。',
        canResume: false
      });
    }
    obj.logger.push('warn', '等待用户手动点播放（不会静音绕过）');
  }

  function onGuardHit(obj, hit) {
    var n = obj.w.incTrigger();
    var reason = hit.kind === 'auth' ? R.AUTH : R.ANOMALY;
    obj.logger.push('warn', '检测到' + (hit.kind === 'auth' ? '真人认证' : '平台异常提示') + '（第 ' + n + ' 次）→ 立即暂停');

    obj.w.pause(reason);

    if (n >= 2) {
      obj.lockedOut = true;
      obj.w.shutdown({ hard: true, by: 'repeat-trigger' });
      if (obj.panel) {
        obj.panel.setBanner({
          kind: 'locked',
          text: '本页已连续 ' + n + ' 次触发平台提示。按规则不再提供"继续"——请刷新页面后重新启动。',
          canResume: false
        });
      }
      return;
    }

    if (obj.panel) {
      obj.panel.setBanner({
        kind: hit.kind,
        text: hit.kind === 'auth'
          ? '检测到真人认证，请手动完成后点"继续"（脚本不会自动关闭、不会重试）'
          : '检测到平台异常提示，请手动处理后点"继续"（脚本不会关闭提示、不会重试）',
        canResume: true
      });
    }
  }

  function pause(reason) {
    if (!rt) return { ok: false, why: 'no-runtime' };
    var ok = rt.w.pause(reason || R.USER);
    return { ok: ok };
  }

  function resume() {
    if (!rt) return { ok: false, why: 'no-runtime' };
    stopTurnWatcher();
    stopMediaWait(rt);
    if (rt.lockedOut) return { ok: false, why: 'locked-out' };
    if (rt.w.state !== S.PAUSED) return { ok: false, why: 'not-paused' };

    if (rt.w.pausedReason === R.AUTH || rt.w.pausedReason === R.ANOMALY) {
      if (rt.panel) rt.panel.setStatus('正在复检页面…');
      var hit = SH.authGuard.scanOnce(document, rt.info.platform);
      if (hit.hit) {
        if (rt.panel) {
          rt.panel.setBanner({ kind: hit.kind, text: '仍然检测到认证/异常提示，请先手动处理完再点"继续"。', canResume: true });
          rt.panel.setStatus('仍被拦截，未恢复');
        }
        return { ok: false, why: 'still-hit' };
      }
    }
    var ok = rt.w.resume();
    if (ok) {
      if (SH.cxStudy && SH.cxStudy.resetScan) SH.cxStudy.resetScan();   /* 继续 → 重新扫描分类 */
      logScanStart(rt);
    }
    return { ok: ok };
  }

  function close(opts) {
    if (!rt) return { ok: false, why: 'no-runtime' };
    stopTurnWatcher();
    stopMediaWait(rt);
    SH.store.clearAutorun();      /* 关闭后不再跨页续跑 */

    var hard = !!(opts && opts.hard);
    var w = rt.w;
    var kind = rt.currentTask ? rt.currentTask.kind : null;

    if (hard) {
      if (rt.player) { rt.player.pause(); rt.player.detach(); }
      w.shutdown({ hard: true, by: 'user-hard' });
      rt.logger.push('info', '已立即关闭（硬关闭）');
      return { ok: true, hard: true };
    }

    /* 分类型软关闭（Bug 1）：
     *  - 视频：等 60s 毫无意义，立即打断播放器再收尾。
     *  - 其他（文档/跳转）：直接收尾。
     * 0.5.0：答题分支已删除（不做题，就没有"等这道题填完"的收尾）。 */
    if (kind === 'video') {
      if (rt.player) { rt.player.pause(); rt.player.detach(); }
      w.shutdown({ hard: true, by: 'user-video' });
      rt.logger.push('info', '已立即停止视频并关闭（不等待看门狗）');
      return { ok: true, hard: true, interrupted: 'video' };
    }

    if (rt.player) { rt.player.pause(); rt.player.detach(); }
    w.shutdown({ hard: true, by: 'user-idle' });
    rt.logger.push('info', '已关闭');
    return { ok: true, hard: true };
  }

  function restart() {
    if (!rt) return start();
    if (rt.lockedOut) return { ok: false, why: 'locked-out' };
    var st = rt.w.state;
    /* CLOSED：重新启动；DONE / 等待加载：重新扫描本页（用户裁决的"重扫"口径）。
     * 两者都走同一条 reinit 路径，避免出现"按钮可点但函数拒绝"的矛盾（Bug 1）。 */
    var rescan = !!(rt.waitingMedia || st === S.DONE);
    if (st !== S.CLOSED && !rescan) return { ok: false, why: 'not-closed' };
    if (st === S.PAUSED) return { ok: false, why: 'paused' };

    stopMediaWait(rt);
    stopTurnWatcher();
    if (rt.loop) rt.loop.stop();
    if (st === S.DONE || st === S.CLOSED) rt.w.transition(S.IDLE);   /* done/closed → idle 都是合法回退，DONE 不是终态 */
    rt.w.reinit();                                 /* epoch++，重建子机（不复用旧引用） */
    if (SH.cxStudy && SH.cxStudy.resetLatch) SH.cxStudy.resetLatch();
    if (SH.cxStudy && SH.cxStudy.resetScan) SH.cxStudy.resetScan();     /* 重新启动 → 重新扫描分类 */
    SH.store.markAutorun();       /* 重新启动后同样允许跨页续跑 */
    if (rt.panel) { rt.panel.setStatus(rescan ? '已重新扫描本页' : '已重新启动'); rt.panel.clearBanner(); }
    if (rt.guard) rt.guard.start(document, rt.info.platform);
    if (rt.supervisor) rt.supervisor.bind();
    logScanStart(rt);
    runLoop(rt);
    notify();
    return { ok: true, rescan: rescan };
  }

  function exit() {
    stopTurnWatcher();
    if (rt) stopMediaWait(rt);
    SH.store.clearAutorun();     /* 退出后不再跨页续跑 */
    if (!rt) {
      SH.store.markExited();
      showExitLayer();
      bindHotkey();
      return { ok: true, why: 'no-runtime' };
    }
    rt.w.exit();          /* onExit → onExitUI；onExited → markExited */
    return { ok: true };
  }

  /* ---------------- 启动 ---------------- */

  /* ---------------- 夜间提醒（0.5.0 用户要求） ----------------
   * 00:00–06:00 启动刷课时提醒一次，**默认继续**：用户可点"继续刷课"（什么都不改）
   * 或"先暂停"（立即挂起，之后能点"继续"恢复）。只提醒一次，不重复弹窗、不自动停止。 */
  function inNightWindow(dateObj) {
    var h = (dateObj instanceof Date ? dateObj : new Date()).getHours();
    return h >= C.LIMITS.NIGHT_START_HOUR && h < C.LIMITS.NIGHT_END_HOUR;
  }

  function maybeShowNightNotice(obj) {
    if (!obj || !obj.panel) return false;
    if (!inNightWindow()) return false;
    /* 每个标签页会话只提醒一次：超星点"下一节"会整页跳转，
     * 不记住的话 0–6 点几乎每换一节都会弹一次，反而更打扰。 */
    var KEY = 'sh.night.notice';
    try {
      if (window.sessionStorage.getItem(KEY) === '1') return false;
      window.sessionStorage.setItem(KEY, '1');
    } catch (e) { /* 沙箱 iframe / 禁存储：退化为"本次页面只弹一次" */ }
    if (obj.logger) {
      obj.logger.push('warn', '夜间提醒：现在是 '
        + C.LIMITS.NIGHT_START_HOUR + ':00–' + C.LIMITS.NIGHT_END_HOUR + ':00，可选择继续或暂停');
    }
    obj.panel.showNotice({
      title: '夜间刷课提醒',
      text: '现在是 00:00–06:00。脚本会照常自动播放，但建议早点休息。'
        + '点"继续刷课"不改变任何设置；点"先暂停"会立即挂起，之后点"继续"即可恢复。',
      ackText: '继续刷课',
      cancelText: '先暂停',
      onAck: function () { /* 继续：不做任何额外动作 */ },
      onCancel: function () {
        pause(R.USER);
        if (obj.panel) {
          obj.panel.setBanner({ kind: 'info', text: '已按夜间提醒暂停，点"继续"即可恢复刷课。', canResume: true });
        }
      }
    });
    return true;
  }

  function start() {
    if (rt) return { ok: false, why: 'already-running' };

    var info = SH.platform.detect(window.location, window.top === window);
    var d = decide(info, { exited: SH.store.readExited() === '1', enabled: SH.sw.isEnabled() });
    if (d.action !== 'launcher') {
      if (d.action === 'disabled') return { ok: false, why: 'master-off', hint: '请先在设置里打开总开关，再点启动' };
      if (d.action === 'exam-blocked') return { ok: false, why: 'exam-blocked', hint: '考试页不提供任何自动化（设计如此）' };
      return { ok: false, why: d.action };
    }

    if (SH.store.cfg().mutex) {
      var lock = SH.store.lockAcquire(sid);
      if (!lock.ok) {
        if (launcher) launcher.setStatus('另一个标签页正在运行，请先停掉它');
        return { ok: false, why: 'locked-by-tab', hint: '另一个标签页已在运行，请先停掉它再启动' };
      }
    }

    dropLauncher();                       /* 入口面板退场，交给运行时面板 */
    rt = createRuntime(info);
    SH.store.markAutorun();      /* 本标签页会话内运行中：平台整页跳转后据此续跑（关闭/退出即清除） */
    if (rt.panel) { rt.panel.mount(); rt.panel.setState(snapshot()); }
    rt.guard.start(document, info.platform);
    rt.supervisor.bind();
    startHeartbeat(rt);
    maybeShowNightNotice(rt);
    logScanStart(rt);
    runLoop(rt);
    notify();
    return { ok: true };
  }

  /* 2026-10-31 用户要求：启动 / 重新启动 / 继续 / 跳转时都要有这一行日志 */
  function logScanStart(obj) {
    if (!obj || !obj.logger) return;
    obj.logger.push('info', '成功启动/重新启动/继续/跳转，正在扫描');
  }

  function destroyRuntime() {
    stopTurnWatcher();
    if (!rt) return false;
    if (rt.guard) rt.guard.stop();
    if (rt.supervisor) rt.supervisor.unbind();
    if (rt.loop) rt.loop.stop();
    if (rt.player) rt.player.detach();
    if (rt.panel) rt.panel.destroy();
    if (rt.w) rt.w.shutdown({ hard: true, by: 'destroy' });
    SH.store.lockRelease(sid);
    rt = null;
    notify();
    return true;
  }

  function restore() {
    SH.store.clearExited();
    if (SH.ui && SH.ui.exitLayer && SH.ui.exitLayer.hide) SH.ui.exitLayer.hide();
    destroyRuntime();
    var r = start();
    return { ok: r.ok, why: r.why };
  }

  /* ---------------- 快捷键 ---------------- */

  function bindHotkey() {
    if (hotkeyBound) return false;
    if (typeof window !== 'undefined' && window.top !== window) return false;
    if (typeof document === 'undefined') return false;
    hotkeyBound = true;

    hotkeyHandler = function (ev) {
      if (!ev) return;
      if (!(ev.ctrlKey && ev.shiftKey)) return;
      if (ev.altKey || ev.metaKey) return;
      if (String(ev.key || '').toLowerCase() !== 'o') return;
      try { ev.preventDefault(); } catch (e) { /* ignore */ }
      try { ev.stopPropagation(); } catch (e) { /* ignore */ }

      if (SH.store.readExited() === '1') {
        if (SH.ui && SH.ui.exitLayer && SH.ui.exitLayer.show) SH.ui.exitLayer.show();
        return;
      }
      if (rt && rt.panel) rt.panel.toggle();
    };

    document.addEventListener('keydown', hotkeyHandler, true);
    return true;
  }

  /* ---------------- 入口 ---------------- */

  function boot() {
    if (booted) return { ok: false, why: 'already-booted' };
    booted = true;

    try {
      /* 页面卸载前释放跨标签锁：否则整页跳转后新页面会因"另一个标签页已在运行"而拒绝启动。
       * 这是"点下一节 → 整页导航 → 自动续跑"链路能成立的前提。 */
      if (typeof window !== 'undefined' && !pageHideBound) {
        pageHideBound = true;
        window.addEventListener('pagehide', function () {
          try { SH.store.lockRelease(sid); } catch (e) { /* ignore */ }
          try { stopTurnWatcher(); } catch (e) { /* ignore */ }
        });
      }

      var info = SH.platform.detect(window.location, window.top === window);
      var env = { exited: SH.store.readExited() === '1', enabled: SH.sw.isEnabled() };
      var d = decide(info, env);

      if (d.action === 'ignore') return { ok: true, action: d.action, reason: d.reason, info: info };

      if (d.action === 'exited') {
        bindHotkey();
        if (SH.ui && SH.ui.exitLayer && SH.ui.exitLayer.show) SH.ui.exitLayer.show();
        return { ok: true, action: d.action, info: info };
      }

      if (d.action === 'child-wait') {
        /* P2：子帧等顶帧 ARM；收不到就保持待命。P1~P4 只在顶帧工作。 */
        return { ok: true, action: d.action, info: info };
      }

      bindHotkey();

      if (d.action === 'exam-blocked') {
        mountLauncher('exam-blocked');
        return { ok: true, action: d.action, info: info };
      }

      if (d.action === 'disabled') {
        mountLauncher('disabled');
        return { ok: true, action: d.action, info: info };
      }

      /* 允许启动但不自动启动（D8） */
      mountLauncher('ready');

      /* 唯一例外：本标签页会话内**已经在跑**，平台整页跳转（点"下一节"）后自动续跑。
       * 新装不会有这个标记（必须手动启动），关闭/退出会清掉它。 */
      if (SH.store.readAutorun() === '1') {
        var rr = start();
        return { ok: true, action: 'autorun', started: !!(rr && rr.ok), info: info };
      }
      return { ok: true, action: 'launcher', info: info };
    } catch (err) {
      return { ok: false, why: 'exception', error: String((err && err.message) || err) };
    }
  }

  function resetForTest() {
    booted = false;
    hotkeyBound = false;
    rt = null;
    subs = [];
    return true;
  }

  SH.main = Object.freeze({
    boot: boot,
    decide: decide,
    start: start,
    pause: pause,
    resume: resume,
    close: close,
    restart: restart,
    exit: exit,
    restore: restore,
    subscribe: subscribe,
    snapshot: snapshot,
    bindHotkey: bindHotkey,
    isBooted: function () { return booted; },
    isHotkeyBound: function () { return hotkeyBound; },
    getRuntime: function () { return rt; },
    resetForTest: resetForTest,
    _test: { createRuntime: createRuntime, destroyRuntime: destroyRuntime }
  });
})(SH);


  SH.main.boot();   // 唯一入口：模块顶层零执行，只在这里启动
})();
