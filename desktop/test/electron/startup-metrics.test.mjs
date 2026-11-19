// 启动分段计时（startup-metrics.ts）的用例：真模块 + 注入时钟，外加对 main.ts 接线站点的结构性守护。
//
// 口径边界（本文件的断言按这个口径写，别改回去）：
// - `did-finish-load` 是 DOM + 子资源加载完成，**不是首帧**，所以字段叫 loadMs，不叫 paintMs/firstPaintMs。
// - 首帧信号用 `ready-to-show`（Electron 在渲染进程画过第一帧后才触发），字段 readyToShowMs；
//   它仍不等于合成器真正 present 的时刻，模块里的 STARTUP_BOUNDARY 常量把这句话钉住。
// - 没发生的阶段一律 null（键必须存在）：0 会把「没测到」伪装成「很快」。
// - 零点 = **main 模块求值**（main-module-evaluation，静态 import 之后、Electron bootstrap 之后）；
//   `atMs`/`totalMs`/`sincePreviousMs` 全都相对它，所以 `Σ sincePreviousMs == totalMs`，且**不含** Electron 冷启动。
//   R10 的 P0 就是这里错了（atMs 用的是绝对时钟，非零 origin 下 totalMs≠分段和），下面有专门的非零 origin 用例。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  STARTUP_BOUNDARY,
  STARTUP_CLOCK_REGRESSION,
  STARTUP_FIRST_PHASE,
  STARTUP_LATE_TOLERANT_PHASES,
  STARTUP_MARK_OUT_OF_ORDER,
  STARTUP_MARK_UNKNOWN_PHASE,
  STARTUP_ORIGIN_SEMANTICS,
  STARTUP_PHASES,
  STARTUP_PHASE_RANK,
  createStartupRecorder
} from '../../electron/startup-metrics.ts';

const MAIN = readFileSync(new URL('../../electron/main.ts', import.meta.url), 'utf8');
const METRICS_SOURCE = readFileSync(new URL('../../electron/startup-metrics.ts', import.meta.url), 'utf8');

/** 注入时钟：按顺序返回给定值，用完后一直返回最后一个（避免用例里出现 undefined 变成 NaN）。 */
function injectedClock(values) {
  let index = 0;
  const read = () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
  read.calls = () => index;
  return read;
}

/** 拿 start → end 之间的源码片段，用来断言「这条语句真的在这个事件处理器里」。 */
function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `源码里找不到起点：${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `源码里找不到终点：${endMarker}`);
  return source.slice(start, end);
}

/** 冻结对象在 ESM（严格模式）里赋值会抛；这里统一吞掉，只看「内部状态有没有被改」与返回值。 */
function attempt(work) {
  try {
    work();
    return 'ok';
  } catch {
    return 'threw';
  }
}

test('顺序 mark 得到各段毫秒，phases 按发生顺序排列，boundary 说明写清', () => {
  const clock = injectedClock([0, 100, 150, 220, 260]);
  const recorder = createStartupRecorder(clock);

  recorder.mark('ready');
  recorder.mark('window');
  recorder.mark('readyToShow');
  recorder.mark('load');

  const snapshot = recorder.snapshot();
  assert.equal(snapshot.readyMs, 100);
  assert.equal(snapshot.windowMs, 150);
  assert.equal(snapshot.readyToShowMs, 220);
  assert.equal(snapshot.loadMs, 260);
  assert.equal(snapshot.extensionMs, null, '没有 mark 的阶段必须是 null，不是 0');
  assert.equal(snapshot.totalMs, 260);
  assert.deepEqual(
    snapshot.phases.map((entry) => [entry.phase, entry.atMs, entry.sincePreviousMs]),
    [
      ['ready', 100, 100],
      ['window', 150, 50],
      ['readyToShow', 220, 70],
      ['load', 260, 40]
    ]
  );
  // 第一段的 sincePreviousMs 是「相对零点」而不是 null：null 会让求和断链，
  // 而「相对零点的间隔」正好等于 atMs，求和口径才闭合（R10 P3-a 的口径纠正就落在这里）。
  assert.equal(
    snapshot.phases.reduce((sum, entry) => sum + entry.sincePreviousMs, 0),
    snapshot.totalMs,
    'Σ sincePreviousMs 必须等于 totalMs（同一零点、同一口径）'
  );
  assert.equal(snapshot.boundary, STARTUP_BOUNDARY);
  assert.match(snapshot.boundary, /not a paint/);
  assert.equal(
    Object.prototype.hasOwnProperty.call(snapshot, 'paintMs'),
    false,
    '不许出现 paintMs：did-finish-load 不是首帧，别用字段名冒充'
  );
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'firstPaintMs'), false);
});

test('未发生的阶段是 null 且键存在（JSON 里能看见 null，不是 0、不是缺键）', () => {
  const recorder = createStartupRecorder(injectedClock([0, 42]));
  recorder.mark('ready');

  const snapshot = recorder.snapshot();
  assert.equal(snapshot.readyMs, 42);
  for (const key of ['windowMs', 'readyToShowMs', 'loadMs', 'extensionMs']) {
    assert.ok(Object.prototype.hasOwnProperty.call(snapshot, key), `${key} 键必须存在`);
    assert.equal(snapshot[key], null, `${key} 未发生必须是 null`);
  }
  assert.equal(snapshot.totalMs, 42, 'totalMs 只累计到最后一个已发生的阶段');

  const line = JSON.stringify(snapshot);
  assert.match(line, /"loadMs":null/);
  assert.match(line, /"readyMs":42/);
  assert.equal(/"loadMs":0(?!\d)/.test(line), false, '未发生阶段不许序列化成 0');
  assert.equal(line.includes('\n'), false, '一行日志不许换行');
});

// —— R10 P0 回归：非零 / 小数 origin ——
test('非零 origin：atMs/totalMs 相对零点，回执自洽（R10 探针 A/B 的回归）', () => {
  // 时钟起点 1000，事件 1100/1200/1300/1400：相对零点是 100/200/300/400。
  const recorder = createStartupRecorder(injectedClock([1000, 1100, 1200, 1300, 1400]));
  recorder.mark('ready');
  recorder.mark('window');
  recorder.mark('readyToShow');
  recorder.mark('load');

  const snapshot = recorder.snapshot();
  assert.equal(snapshot.readyMs, 100);
  assert.equal(snapshot.windowMs, 200);
  assert.equal(snapshot.readyToShowMs, 300);
  assert.equal(snapshot.loadMs, 400);
  assert.equal(snapshot.totalMs, 400, 'totalMs 是「最后一个阶段距零点」，不是绝对时钟读数 1400');
  assert.equal(
    snapshot.phases.reduce((sum, entry) => sum + entry.sincePreviousMs, 0),
    snapshot.totalMs,
    '分段和必须等于 totalMs：差一个 origin 的回执没法当证据'
  );
  const line = JSON.stringify(snapshot);
  assert.equal(line.includes('1400'), false, '回执里不许漏出绝对时钟值');
  assert.equal(line.includes('1000'), false, '回执里不许漏出零点本身');
});

test('小数 origin：舍入只发生在写出，差值与 atMs 同一零点', () => {
  const origin = 123.4567;
  const recorder = createStartupRecorder(injectedClock([origin, 224.1617, 274.1617]));
  recorder.mark('ready');
  recorder.mark('window');

  const snapshot = recorder.snapshot();
  assert.equal(snapshot.readyMs, 100.705, '224.1617-123.4567 三位小数');
  assert.equal(snapshot.windowMs, 150.705);
  assert.equal(snapshot.phases[1].sincePreviousMs, 50);
  // 加法在 IEEE754 里会带 1e-14 级的尾巴（100.705+50 = 150.70499999999998），这里比的是「口径」不是位模式。
  assert.ok(
    Math.abs(snapshot.phases.reduce((sum, entry) => sum + entry.sincePreviousMs, 0) - snapshot.totalMs) < 1e-9,
    `Σ sincePreviousMs 必须落在 totalMs 上，实际 ${snapshot.phases.reduce((sum, entry) => sum + entry.sincePreviousMs, 0)} vs ${snapshot.totalMs}`
  );
  // 零点本身不参与写出，但仍以它为零点：1100.1234 起点下第一个事件必须跟着平移。
  const shifted = createStartupRecorder(injectedClock([1000.1234, 1100.9876]));
  shifted.mark('ready');
  assert.equal(shifted.snapshot().readyMs, 100.864);
});

test('近舍入边界：raw 单调递增不许判回退，真回退仍拒（且消息不再自相矛盾）', () => {
  // 100.0006 → 100.0007：两者都舍入成 100.001。旧实现拿 raw 比已舍入值，会抛
  // 「100.001 < 100.001」；新实现只比 raw。
  const monotonic = createStartupRecorder(injectedClock([0, 100.0006, 100.0007]));
  monotonic.mark('ready');
  monotonic.mark('window');
  assert.deepEqual(
    monotonic.snapshot().phases.map((entry) => entry.atMs),
    [100.001, 100.001],
    '舍入后可以相等，但不许抛'
  );

  // raw 真下降 0.0002：舍入后两位都显示 100.001，仍然必须拒。
  const regressed = createStartupRecorder(injectedClock([0, 100.0006, 100.0004]));
  regressed.mark('ready');
  let captured = null;
  assert.throws(
    () => regressed.mark('window'),
    (error) => {
      assert.equal(error.code, STARTUP_CLOCK_REGRESSION);
      captured = error;
      return true;
    }
  );
  assert.match(captured.message, /相对 main 模块求值零点/, '回退消息要说明是相对零点的值，别再写出「X < X」');
  assert.equal(regressed.has('window'), false);

  // 零点附近的边界：起点 1000.0004、事件 1000.0005 → 距零点 0.0001 ms，舍入到 0。
  // 这里是**真的 0**（阶段发生了、就是几乎没有耗时），和「没测到」的 null 是两件事。
  const nearZero = createStartupRecorder(injectedClock([1000.0004, 1000.0005]));
  nearZero.mark('ready');
  const snapshot = nearZero.snapshot();
  assert.equal(snapshot.readyMs, 0);
  assert.equal(snapshot.totalMs, 0);
  assert.equal(snapshot.loadMs, null, '真的 0 与「没发生」的 null 不许混');
});

// —— 对象污染 / 冻结 ——
test('对象污染：mark 返回冻结副本、快照是副本、rank 表改不动（R10 探针 E/G）', () => {
  assert.ok(Object.isFrozen(STARTUP_PHASE_RANK), 'rank 是活状态，必须冻结（类型层 Readonly 运行时不管用）');
  assert.ok(Object.isFrozen(STARTUP_PHASES));
  assert.ok(Object.isFrozen(STARTUP_LATE_TOLERANT_PHASES));

  assert.equal(attempt(() => { STARTUP_PHASE_RANK.window = 99; }), 'threw');
  assert.equal(attempt(() => { STARTUP_PHASE_RANK.paint = 2; }), 'threw');
  assert.equal(STARTUP_PHASE_RANK.window, 1, 'rank 表不许被改：改了会让下一次合法 mark 抛错序');
  assert.equal(Object.prototype.hasOwnProperty.call(STARTUP_PHASE_RANK, 'paint'), false);

  const clock = injectedClock([0, 10, 20, 30, 40]);
  const recorder = createStartupRecorder(clock);
  const handle = recorder.mark('ready');
  assert.ok(Object.isFrozen(handle), 'mark 必须返回冻结副本，不是内部对象本体');
  assert.equal(attempt(() => { handle.atMs = -999; }), 'threw');
  assert.equal(attempt(() => { handle.phase = 'paint'; }), 'threw');
  assert.equal(attempt(() => Object.assign(handle, { atMs: -1 })), 'threw');
  assert.equal(handle.atMs, 10, '返回值自身也不许被改写');
  assert.equal(handle.phase, 'ready');

  const snapshot = recorder.snapshot();
  assert.equal(snapshot.readyMs, 10, '改返回值不许污染内部记录');
  assert.equal(snapshot.totalMs, 10);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'undefined'), false, '不许出现 undefined 键');

  // 改快照（含 phases 里的元素）同样不影响内部
  snapshot.readyMs = -1;
  snapshot.totalMs = -1;
  snapshot.phases[0].atMs = -1;
  snapshot.phases[0].phase = 'paint';
  const again = recorder.snapshot();
  assert.equal(again.readyMs, 10);
  assert.equal(again.totalMs, 10);
  assert.deepEqual(again.phases.map((entry) => entry.phase), ['ready']);

  // rank 没被污染 ⇒ 脊梁判定照旧：extension 之后再来 load 仍是错序
  const spine = createStartupRecorder(injectedClock([0, 1, 2, 3]));
  spine.mark('ready');
  spine.mark('window');
  spine.mark('extension');
  assert.throws(
    () => spine.mark('load'),
    (error) => error.code === STARTUP_MARK_OUT_OF_ORDER,
    'load 不是 late-tolerant：本应用的注入就在 did-finish-load 里，顺序倒了说明接线坏了'
  );
});

// —— 首阶段 / 晚到首帧 ——
test('第一阶段必须是 ready：空记录不许直接记 window/extension（防「空壳回执」）', () => {
  assert.equal(STARTUP_FIRST_PHASE, 'ready');
  for (const phase of ['window', 'readyToShow', 'load', 'extension']) {
    const recorder = createStartupRecorder(injectedClock([0, 5]));
    assert.throws(
      () => recorder.mark(phase),
      (error) => {
        assert.equal(error.code, STARTUP_MARK_OUT_OF_ORDER);
        assert.match(error.message, /第一个阶段必须是 ready/);
        return true;
      },
      `${phase} 不能当第一个阶段`
    );
    assert.deepEqual(recorder.snapshot().phases, [], '被拒绝的 mark 不许留下记录');
    assert.equal(recorder.snapshot().totalMs, null);
  }
  const ok = createStartupRecorder(injectedClock([0, 5]));
  assert.equal(ok.mark('ready').atMs, 5);
});

test('late-show：readyToShow 可晚于 extension 到达并照记，重复晚到幂等', () => {
  const clock = injectedClock([0, 10, 20, 30, 40, 50]);
  const recorder = createStartupRecorder(clock);
  recorder.mark('ready');
  recorder.mark('window');
  recorder.mark('load');
  recorder.mark('extension');

  // xvfb / --disable-gpu 下首帧完全可能晚于注入：照记，不许抛（R10 P1 的核心）
  const late = recorder.mark('readyToShow');
  assert.equal(late.phase, 'readyToShow');
  assert.equal(late.atMs, 50);

  const snapshot = recorder.snapshot();
  assert.equal(snapshot.readyToShowMs, 50, '晚到的首帧仍然是头条指标，必须落进回执');
  assert.equal(snapshot.extensionMs, 40);
  assert.equal(snapshot.totalMs, 50, 'totalMs 跟「最后一个已发生阶段」，晚到者就是最后一个');
  assert.deepEqual(
    snapshot.phases.map((entry) => entry.phase),
    ['ready', 'window', 'load', 'extension', 'readyToShow']
  );
  assert.equal(snapshot.phases[4].sincePreviousMs, 10, '晚到阶段的分段间隔仍相对上一个已发生阶段');

  const calls = clock.calls();
  const repeated = recorder.mark('readyToShow');
  assert.equal(repeated.atMs, 50);
  assert.equal(clock.calls(), calls, '重复晚到不许再读时钟');
  assert.equal(snapshot.phases.filter((entry) => entry.phase === 'readyToShow').length, 1, 'phases 不许重复');

  // 但「window 还没建就有首帧」是不可能的，仍要拒
  const early = createStartupRecorder(injectedClock([0, 1, 2]));
  early.mark('ready');
  assert.throws(() => early.mark('readyToShow'), (error) => error.code === STARTUP_MARK_OUT_OF_ORDER);
});

test('错序 mark 抛 STARTUP_MARK_OUT_OF_ORDER，不静默排序', () => {
  const recorder = createStartupRecorder(injectedClock([0, 10, 20]));
  recorder.mark('ready');
  recorder.mark('load');
  assert.throws(
    () => recorder.mark('window'),
    (error) => {
      assert.equal(error.code, STARTUP_MARK_OUT_OF_ORDER);
      assert.match(error.message, /STARTUP_MARK_OUT_OF_ORDER/);
      return true;
    }
  );
  assert.equal(recorder.has('window'), false, '被拒绝的 mark 不许留下痕迹');
  assert.deepEqual(
    recorder.snapshot().phases.map((entry) => entry.phase),
    ['ready', 'load']
  );

  // extension 之后又来 readyToShow 是合法的晚到（见 late-show 用例）；反过来 extension 之后又来 load
  // 仍是错序 —— 本应用的注入发生在 did-finish-load 里，顺序倒了就是接线坏了。
  const spineClock = injectedClock([0, 1, 2, 3, 4]);
  const spine = createStartupRecorder(spineClock);
  spine.mark('ready');
  spine.mark('window');
  spine.mark('extension');
  assert.throws(() => spine.mark('load'), (error) => error.code === STARTUP_MARK_OUT_OF_ORDER);
  // 重复 mark 优先按幂等处理（不算错序、也不读时钟）
  const callsBefore = spineClock.calls();
  assert.equal(spine.mark('window').atMs, spine.snapshot().windowMs);
  assert.equal(spineClock.calls(), callsBefore);
});

test('渲染侧两个事件（ready-to-show / did-finish-load）不硬排顺序，但进程脊梁不许倒', () => {
  // Chromium 里首帧与 load 的先后取决于子资源，硬排会在真机上随机抛错 —— 两者同档，任一先后都合法。
  assert.equal(STARTUP_PHASE_RANK.readyToShow, STARTUP_PHASE_RANK.load);
  assert.ok(STARTUP_PHASE_RANK.ready < STARTUP_PHASE_RANK.window);
  assert.ok(STARTUP_PHASE_RANK.window < STARTUP_PHASE_RANK.load);
  assert.ok(STARTUP_PHASE_RANK.load < STARTUP_PHASE_RANK.extension);

  const loadFirst = createStartupRecorder(injectedClock([0, 10, 20, 30]));
  loadFirst.mark('ready');
  loadFirst.mark('window');
  loadFirst.mark('load');
  loadFirst.mark('readyToShow');
  assert.deepEqual(
    loadFirst.snapshot().phases.map((entry) => entry.phase),
    ['ready', 'window', 'load', 'readyToShow']
  );

  const paintFirst = createStartupRecorder(injectedClock([0, 10, 20, 30]));
  paintFirst.mark('ready');
  paintFirst.mark('window');
  paintFirst.mark('readyToShow');
  paintFirst.mark('load');
  assert.equal(paintFirst.snapshot().loadMs, 30);
});

test('时钟回退抛 STARTUP_CLOCK_REGRESSION，不 clamp、不写半条记录', () => {
  const recorder = createStartupRecorder(injectedClock([10, 5]));
  assert.throws(
    () => recorder.mark('ready'),
    (error) => {
      assert.equal(error.code, STARTUP_CLOCK_REGRESSION);
      assert.match(error.message, /STARTUP_CLOCK_REGRESSION/);
      return true;
    }
  );
  assert.equal(recorder.has('ready'), false);
  assert.equal(recorder.snapshot().totalMs, null, '一次都没成功 mark 时 totalMs 是 null');

  // 第二段回退（相对上一次 mark，而不是相对起点）同样要拒绝
  const later = createStartupRecorder(injectedClock([0, 100, 90]));
  later.mark('ready');
  assert.throws(() => later.mark('window'), (error) => error.code === STARTUP_CLOCK_REGRESSION);

  // NaN / Infinity 也是坏时钟，不能变成 null 或 0 混进回执
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const broken = createStartupRecorder(injectedClock([0, bad]));
    assert.throws(() => broken.mark('ready'), (error) => error.code === STARTUP_CLOCK_REGRESSION);
  }
});

test('重复事件幂等：同一阶段再 mark 不重读时钟、不重复 phases、snapshot 两次深相等', () => {
  const clock = injectedClock([0, 10, 20, 30, 40, 50, 60]);
  const recorder = createStartupRecorder(clock);
  recorder.mark('ready');
  recorder.mark('load');
  const first = recorder.snapshot();
  const callsBefore = clock.calls();

  // 模拟 reload：同一批事件再来一遍，不许抛、不许改写首启数字
  recorder.mark('ready');
  recorder.mark('load');
  recorder.mark('load');

  assert.equal(clock.calls(), callsBefore, '重复 mark 不许再读时钟');
  assert.deepEqual(recorder.snapshot(), first);
  assert.deepEqual(
    recorder.snapshot().phases.map((entry) => entry.phase),
    ['ready', 'load']
  );

  // snapshot 本身可重复调用且幂等
  assert.deepEqual(recorder.snapshot(), recorder.snapshot());
});

test('未知阶段（paint / firstPaint 之类）直接拒绝，字段命名不许漂', () => {
  const recorder = createStartupRecorder(injectedClock([0, 1, 2]));
  for (const bogus of ['paint', 'firstPaint', 'domContentLoaded']) {
    assert.throws(
      () => recorder.mark(bogus),
      (error) => error.code === STARTUP_MARK_UNKNOWN_PHASE,
      `${bogus} 必须被拒绝`
    );
  }
  assert.deepEqual(Array.from(STARTUP_PHASES), ['ready', 'window', 'readyToShow', 'load', 'extension']);
});

// —— 接线守护：纯 helper 绿不代表启动日志真的有 ——
// 这一组读 main.ts 源码，钉住「谁在什么时候 mark、日志什么时候才允许打、坏了不崩」。
test('main.ts 接线：起点在模块作用域、各段 mark 在各自真实事件里、reload 不会再打第二行', () => {
  const recorderInit = MAIN.indexOf('createStartupRecorder()');
  assert.ok(recorderInit > 0, 'main.ts 必须创建 recorder');
  assert.ok(
    recorderInit < MAIN.indexOf('async function bootstrap()'),
    'recorder 必须在模块作用域创建（main 模块求值即零点），不能等 whenReady 之后才建'
  );

  const bootstrap = sliceBetween(MAIN, 'async function bootstrap()', 'let quitAfterParametricStop');
  assert.ok(
    bootstrap.indexOf('await app.whenReady();') < bootstrap.indexOf("markStartup('ready')"),
    'ready 必须紧跟在 whenReady 之后 mark'
  );
  assert.ok(
    bootstrap.indexOf('mainWindow = createWindow();') < bootstrap.indexOf("markStartup('window')"),
    'window 必须在主窗口构造之后 mark'
  );

  const createWindowBody = sliceBetween(MAIN, 'function createWindow(): BrowserWindow {', "window.webContents.on('will-navigate'");
  assert.ok(
    createWindowBody.includes("window.once('ready-to-show'"),
    '首帧信号必须来自 ready-to-show（once：重开窗口不重复注册）'
  );
  assert.ok(createWindowBody.includes("markStartup('readyToShow')"), 'ready-to-show 里必须 mark readyToShow');
  assert.ok(createWindowBody.includes("markStartup('load')"), 'did-finish-load 里必须 mark load（不是 paint）');

  const syncLoad = sliceBetween(MAIN, "window.webContents.on('did-finish-load', () => {", "window.webContents.on('will-navigate'");
  assert.ok(syncLoad.includes("markStartup('load')"), 'load 必须在同步的 did-finish-load 监听器里 mark');

  const asyncLoad = sliceBetween(MAIN, "window.webContents.on('did-finish-load', async () => {", 'if (HEADLESS_LINKAGE_SHOTS)');
  assert.ok(asyncLoad.includes("markStartup('extension')"), '扩展注入完成后 mark extension');

  const prints = MAIN.match(/console\.log\(`STARTUP_METRICS /g) ?? [];
  assert.equal(prints.length, 1, 'STARTUP_METRICS 只允许一个打印点（单行、无双份格式漂移）');
  const logFn = sliceBetween(MAIN, 'function logStartupMetricsOnce(trigger: string): void {', '\n}\n');
  assert.ok(logFn.includes('if (startupMetricsLogged) return;'), '重复 did-finish-load（reload）不许刷第二行');
  assert.ok(logFn.includes('JSON.stringify(startupRecorder.snapshot())'), '回执必须是 snapshot 的 JSON 单行');

  assert.equal(/\bpaintMs\b/.test(MAIN), false, 'main.ts 不许把 did-finish-load 叫 paintMs');
  assert.equal(/firstPaint/.test(MAIN), false, 'main.ts 不许出现 firstPaint');
});

// —— R10 P1 回归：回执时点 ——
test('main.ts 接线：回执等 extension 与 readyToShow 都齐、只打一行、兜底有限且会清理', () => {
  // 1) 正常路径：两个关键阶段都在才允许打
  const maybeFn = sliceBetween(MAIN, 'function maybeLogStartupMetrics(trigger: string): void {', '\n}\n');
  assert.ok(maybeFn.includes('if (startupMetricsLogged) return;'));
  assert.ok(maybeFn.includes("startupRecorder.has('extension')"), '打回执前必须确认扩展注入已完成');
  assert.ok(maybeFn.includes("startupRecorder.has('readyToShow')"), '打回执前必须确认首帧已发生');
  assert.ok(
    maybeFn.indexOf("has('extension')") < maybeFn.indexOf('logStartupMetricsOnce(trigger)'),
    '顺序：先判齐再打'
  );

  // 2) 两个触发点都在：注入完成后一次、首帧到达后一次（谁后到都能凑齐）
  const asyncLoad = sliceBetween(MAIN, "window.webContents.on('did-finish-load', async () => {", 'if (HEADLESS_LINKAGE_SHOTS)');
  assert.ok(
    asyncLoad.indexOf("markStartup('extension')") < asyncLoad.indexOf('maybeLogStartupMetrics('),
    'extension 记完之后才允许试打回执'
  );
  assert.ok(asyncLoad.includes("maybeLogStartupMetrics('extension+readyToShow')"));

  const showHandler = sliceBetween(MAIN, "window.once('ready-to-show', () => {", '});');
  assert.ok(showHandler.includes("markStartup('readyToShow')"));
  assert.ok(
    showHandler.includes('maybeLogStartupMetrics('),
    'ready-to-show 也要试打：首帧晚于注入时靠这里凑齐（别等到进程退出都没有回执）'
  );

  // 3) 有限兜底：定时器不无限等、不拖住退出、不叠加、打过就清
  const armFn = sliceBetween(MAIN, 'function armStartupReceiptFallback(): void {', '\n}\n');
  assert.ok(
    armFn.includes('if (startupMetricsLogged || startupReceiptTimer !== null) return;'),
    '已打过 / 已有定时器直接返回：reload / activate 不叠加定时器'
  );
  assert.ok(armFn.includes('HEADLESS ? STARTUP_RECEIPT_FALLBACK_MS.headless : STARTUP_RECEIPT_FALLBACK_MS.windowed'));
  assert.ok(armFn.includes('.unref?.()'), '兜底定时器必须 unref：只补一行，不许拖住进程退出');
  assert.match(
    MAIN,
    /STARTUP_RECEIPT_FALLBACK_MS = Object\.freeze\(\{ headless: 4000, windowed: 15000 \}\)/,
    '兜底必须是有限值（headless 4s 早于截图流程的 app.exit；有窗口 15s）'
  );
  assert.equal(/setInterval/.test(MAIN), false, '回执链上不许用会自增的 setInterval');

  const logFn = sliceBetween(MAIN, 'function logStartupMetricsOnce(trigger: string): void {', '\n}\n');
  assert.ok(logFn.includes('clearStartupReceiptTimer()'), '打过就清定时器：退出 / reload 后不许再冒一行');
  const clearFn = sliceBetween(MAIN, 'function clearStartupReceiptTimer(): void {', '\n}\n');
  assert.ok(clearFn.includes('clearTimeout(startupReceiptTimer)'), '清理要真的 clearTimeout');
  assert.ok(clearFn.includes('startupReceiptTimer = null'), '清理后句柄必须置空，否则后续 arm 会被「已有定时器」挡住');
  assert.ok(logFn.includes('degraded=missing:'), '降级快照必须写明缺哪个阶段（缺失原因）');
  assert.ok(logFn.includes('trigger=${trigger}'), '降级快照必须写明触发点');
  assert.ok(logFn.includes('headless=${HEADLESS}'), '降级快照要带 headless 标记，免得又被读成「xvfb 没画」');

  // 4) 硬退出保险：app.exit 不走 will-quit，退出时补一条（已打过则 no-op）
  const exitHook = sliceBetween(MAIN, "process.once('exit', () => {", '});');
  assert.ok(exitHook.includes('if (!startupMetricsLogged)'), '退出补打必须在已打过时静默');
  assert.ok(exitHook.includes("logStartupMetricsOnce('process-exit')"));

  // 5) 只在建窗口之后 arm 一次（定义 1 处 + 调用 1 处）
  const bootstrap = sliceBetween(MAIN, 'async function bootstrap()', 'let quitAfterParametricStop');
  assert.ok(bootstrap.indexOf("markStartup('window')") < bootstrap.indexOf('armStartupReceiptFallback()'));
  assert.equal(
    (MAIN.match(/armStartupReceiptFallback\(\)/g) ?? []).length,
    2,
    'arm 只允许「一处定义 + 一处调用」'
  );
});

test('main.ts 接线：mark 异常（错序/回退）只打一行码，不许打断启动与 reload', () => {
  const markFn = sliceBetween(MAIN, 'function markStartup(phase: StartupPhase): void {', '\n}\n');
  assert.ok(markFn.includes('try {'), 'mark 必须被 try 包住：错序/回退不能抛进 Electron 事件循环');
  assert.ok(markFn.includes('catch'), 'mark 必须有 catch');
  assert.ok(markFn.includes('STARTUP_METRICS_ERROR'), 'catch 里要留一行可 grep 的错误码，不能静默');

  const guardedCalls = MAIN.match(/markStartup\('/g) ?? [];
  assert.ok(guardedCalls.length >= 5, `至少 5 处 markStartup 站点（ready/window/readyToShow/load/extension），实际 ${guardedCalls.length}`);
  const rawCalls = MAIN.match(/startupRecorder\.mark\('/g) ?? [];
  const insideHelper = (markFn.match(/startupRecorder\.mark\('/g) ?? []).length;
  assert.equal(rawCalls.length, insideHelper, 'mark 只允许出现在 markStartup 里，站点一律走受保护版本');
});

test('main.ts 接线：--diagnose 也能读到启动快照（不扩诊断报告 schema、不加新 IPC）', () => {
  const diagnose = sliceBetween(MAIN, 'async function runDiagnoseMode(): Promise<void> {', 'function publicAgentInfo()');
  assert.ok(diagnose.includes("markStartup('ready')"), 'diagnose 分支也要 mark ready（它不建窗口，只有 ready 段）');
  assert.ok(
    diagnose.includes("logStartupMetricsOnce('diagnose-no-window')"),
    'diagnose 分支要打出同一行 STARTUP_METRICS，并把「为什么只有 ready」写进 trigger'
  );
  assert.equal(MAIN.includes('automation-cad-diagnosis'), false, 'main.ts 不许改诊断报告 schema（schema 在 shared/diagnostics.ts）');
});

// —— 口径守卫：文档不许再写回「含 Electron 冷启动 / 进程初始化」 ——
test('口径守卫：起点叫 main-module-evaluation，不声称包含 Electron 冷启动与静态 import', () => {
  assert.match(STARTUP_ORIGIN_SEMANTICS, /main-module-evaluation/);
  assert.match(STARTUP_ORIGIN_SEMANTICS, /excludes both/);
  assert.match(METRICS_SOURCE, /main-module-evaluation/, '模块文档必须点名起点口径');
  assert.equal(/计时含 Electron 自身冷启动/.test(METRICS_SOURCE), false, '不许再声称含 Electron 冷启动');
  assert.equal(/计时含 Electron 自身冷启动/.test(MAIN), false, 'main.ts 同样不许再这么写');
  assert.match(MAIN, /main-module-evaluation/, 'main.ts 的接线注释必须点名同一口径');
  assert.match(MAIN, /不含\*\* Electron 冷启动|不含 Electron 冷启动/, 'main.ts 要写清「不含」什么');
  assert.equal(/起点是\*\*进程初始化\*\*/.test(METRICS_SOURCE), false, '「进程初始化」是错的口径（模块作用域 ≠ 进程启动）');
});

// —— R10 P2 回归：顺序水位只许单调抬升，晚到的低档阶段不许把水位拉回去 ——
test('rank 水位单调：晚到的 readyToShow 不许把水位拉回 load 档，随后非法 load 必须拒（R10 P2）', () => {
  // 复现（旧实现红）：ready→window→extension→晚到 readyToShow 之后又来一个 load。
  // 旧代码把 lastRank 直接赋成 rank（readyToShow=2），水位从 extension 的 3 掉回 2，
  // 紧随其后的 load（同为 rank 2，不满足 rank < lastRank）就被当成「不倒序」接受，
  // 于是一个接线坏掉（load 晚于注入）的启动会静默通过。修法是水位取 max，不是放宽判据。
  const clock = injectedClock([0, 10, 20, 30, 40, 50]);
  const recorder = createStartupRecorder(clock);
  recorder.mark('ready');
  recorder.mark('window');
  recorder.mark('extension');
  recorder.mark('readyToShow'); // 合法晚到：照记，但它不是新的水位

  assert.throws(
    () => recorder.mark('load'),
    (error) => error.code === STARTUP_MARK_OUT_OF_ORDER,
    'extension 之后来的 load 必须拒：本应用在 did-finish-load 里注入，load 晚到说明接线坏了'
  );
  assert.equal(recorder.has('load'), false, '被拒的 load 不许留下痕迹');
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.loadMs, null, '被拒之后 loadMs 仍是 null（没测到，不是 0）');
  assert.deepEqual(
    snapshot.phases.map((entry) => entry.phase),
    ['ready', 'window', 'extension', 'readyToShow']
  );

  // 水位没被拉低的第二个可观测面：晚到之后再 mark readyToShow 仍走幂等，不读时钟、不加记录
  const calls = clock.calls();
  assert.equal(recorder.mark('readyToShow').atMs, snapshot.readyToShowMs);
  assert.equal(clock.calls(), calls, '重复晚到仍是幂等空操作');

  // 对照组（另一条合法顺序 load→extension）：load 已经记过，再来一次走幂等、不许误判成错序 ——
  // 也就是说「拒」只针对水位真正被越过的情况，不是把 rank 判据改成一律拒。
  const loadFirst = createStartupRecorder(injectedClock([0, 10, 20, 30, 40, 50]));
  loadFirst.mark('ready');
  loadFirst.mark('window');
  loadFirst.mark('load');
  loadFirst.mark('extension');
  loadFirst.mark('readyToShow');
  const loadFirstSnapshot = loadFirst.snapshot();
  assert.equal(loadFirst.mark('load').atMs, loadFirstSnapshot.loadMs, '已记过的 load 重复到达是幂等，不是错序');
  assert.deepEqual(
    loadFirstSnapshot.phases.map((entry) => entry.phase),
    ['ready', 'window', 'load', 'extension', 'readyToShow']
  );
});
