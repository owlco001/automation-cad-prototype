// 联动播放控制器：单飞（单例）+ 帧间 ~300ms 线性插值 + 关闭/抛错两条收尾路径。
//
// 全部用例走**假时钟/假 raf**：把 now/raf/cancelRaf 注入控制器，
// 时间由 advance() 手动推进，不依赖真实计时器（文件整体远低于 1s）。
// 分层约定见 desktop/test/MODULE.md：纯逻辑单测放 test/**/*.test.mjs。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {
  LINKAGE_FRAME_BLEND_MS,
  abortLinkagePlayback,
  createLinkagePlayback,
  hasActiveLinkagePlayback,
  startLinkagePlayback
} from '../../src/agent/linkage-panel.ts';

const panelSource = () => readFileSync(new URL('../../src/agent/linkage-panel.ts', import.meta.url), 'utf8');

function fakeClock() {
  let time = 0;
  let nextHandle = 1;
  let queue = [];
  return {
    now: () => time,
    raf: (callback) => {
      const handle = nextHandle++;
      queue.push({ handle, callback });
      return handle;
    },
    cancelRaf: (handle) => {
      queue = queue.filter((item) => item.handle !== handle);
    },
    advance: (ms) => {
      time += ms;
    },
    // 执行当前排队的全部回调（用当前假时间戳），返回执行条数
    flush: () => {
      const batch = queue;
      queue = [];
      for (const item of batch) item.callback(time);
      return batch.length;
    },
    pending: () => queue.length
  };
}

/**
 * 最小抽屉替身，逐字对齐 desktop/src/ui/panels.ts 的关闭语义：
 * × 按钮 / Esc / 再点工具栏入口都收敛到 closeDrawerElement → handle.onClose()，
 * 且已经收起的抽屉不再重复回调。DOM 在这里不可用（panels.ts 还引了 CSS），
 * 所以只复刻调用链，形态与真实接线一致。
 */
function fakeDrawer() {
  let open = true;
  const handle = {
    close: () => {
      if (!open) return;
      open = false;
      handle.onClose?.();
    },
    isOpen: () => open
  };
  return handle;
}

const frames = [
  { tMs: 0, stepNo: 1, offsets: { 'st1-gripper-1': [0, 0, 0] }, rotZDeg: { 'st1-rotary-1': 0 } },
  { tMs: 300, stepNo: 2, offsets: { 'st1-gripper-1': [30, 0, -20] }, rotZDeg: { 'st1-rotary-1': 90 } }
];

test('单例：连续两次 start 只保留一条循环，第一轮的回调不再被调用', () => {
  const clock = fakeClock();
  const firstSamples = [];
  const secondSamples = [];
  // 故意不给 cancelRaf：即便旧回调已经排在队列里，abort 之后也必须自己咽掉
  startLinkagePlayback({
    frames,
    cycleMs: 600,
    now: clock.now,
    raf: clock.raf,
    onSample: (sample) => firstSamples.push(sample.tMs)
  });
  assert.equal(hasActiveLinkagePlayback(), true);
  startLinkagePlayback({
    frames,
    cycleMs: 600,
    now: clock.now,
    raf: clock.raf,
    onSample: (sample) => secondSamples.push(sample.tMs)
  });

  clock.advance(100);
  clock.flush();
  assert.deepEqual(firstSamples, [], '第一条循环被 abort 后不得再回调');
  assert.deepEqual(secondSamples, [100], '只有第二条循环在写场景');
  assert.equal(hasActiveLinkagePlayback(), true);

  abortLinkagePlayback();
  assert.equal(hasActiveLinkagePlayback(), false);
});

test('abort 之后不再写场景（applyPose 调用次数不再增长）', () => {
  const clock = fakeClock();
  const applied = [];
  const playback = createLinkagePlayback({
    frames,
    cycleMs: 900,
    now: clock.now,
    raf: clock.raf,
    onSample: (sample) => applied.push(sample.pose)
  });
  clock.flush();
  clock.advance(100);
  clock.flush();
  const before = applied.length;
  assert.equal(before, 2);

  playback.abort();
  clock.advance(400);
  clock.flush();
  assert.equal(applied.length, before, 'abort 后不得再套位姿');
  assert.equal(playback.finished, true);
});

test('abort 取消已排队的 rAF，不留一条会自我续命的循环', () => {
  const clock = fakeClock();
  const applied = [];
  const playback = createLinkagePlayback({
    frames,
    cycleMs: 1200,
    now: clock.now,
    raf: clock.raf,
    cancelRaf: clock.cancelRaf,
    onSample: (sample) => applied.push(sample.pose)
  });
  clock.flush();
  assert.equal(clock.pending(), 1);
  playback.abort();
  assert.equal(clock.pending(), 0, 'abort 必须把排队中的帧回调撤掉');
  clock.advance(500);
  assert.equal(clock.flush(), 0);
  assert.equal(applied.length, 1);
});

test('帧间插值：中间帧严格落在起止之间，末帧精确等于目标（offsets 与 rotZDeg）', () => {
  const clock = fakeClock();
  const samples = [];
  const playback = createLinkagePlayback({
    frames,
    cycleMs: 300,
    now: clock.now,
    raf: clock.raf,
    cancelRaf: clock.cancelRaf,
    onSample: (sample) => samples.push({ tMs: sample.tMs, pose: sample.pose })
  });
  assert.equal(LINKAGE_FRAME_BLEND_MS, 300);

  clock.flush(); // t = 0
  clock.advance(150);
  clock.flush(); // t = 150 → alpha 0.5
  clock.advance(150);
  clock.flush(); // t = 300 → 末帧

  assert.equal(samples.length, 3);
  assert.deepEqual(samples[0]?.pose.offsets?.['st1-gripper-1'], [0, 0, 0]);
  assert.equal(samples[0]?.pose.rotZDeg?.['st1-rotary-1'], 0);

  const mid = samples[1];
  assert.equal(mid?.tMs, 150);
  const midX = mid?.pose.offsets?.['st1-gripper-1']?.[0] ?? Number.NaN;
  const midZ = mid?.pose.offsets?.['st1-gripper-1']?.[2] ?? Number.NaN;
  const midRot = mid?.pose.rotZDeg?.['st1-rotary-1'] ?? Number.NaN;
  assert.ok(midX > 0 && midX < 30, `中间帧 X 应落在 (0,30)，实际 ${midX}`);
  assert.ok(midZ < 0 && midZ > -20, `中间帧 Z 应落在 (-20,0)，实际 ${midZ}`);
  assert.ok(midRot > 0 && midRot < 90, `中间帧 rotZ 应落在 (0,90)，实际 ${midRot}`);
  assert.equal(midRot, 45);

  const last = samples[2];
  assert.equal(last?.tMs, 300);
  assert.deepEqual(last?.pose.offsets?.['st1-gripper-1'], [30, 0, -20], '末帧必须精确等于目标帧');
  assert.equal(last?.pose.rotZDeg?.['st1-rotary-1'], 90, '末帧转角不得停在插值中间值');
  assert.equal(playback.finished, true);
});

test('间隔大于 300ms 时先到位再保持，段中不漂移', () => {
  const clock = fakeClock();
  const samples = [];
  createLinkagePlayback({
    frames: [
      { tMs: 0, stepNo: 1, offsets: { p: [0, 0, 0] }, rotZDeg: { r: 0 } },
      { tMs: 1000, stepNo: 2, offsets: { p: [100, 0, 0] }, rotZDeg: { r: 180 } }
    ],
    cycleMs: 1000,
    now: clock.now,
    raf: clock.raf,
    cancelRaf: clock.cancelRaf,
    onSample: (sample) => samples.push({ tMs: sample.tMs, pose: sample.pose })
  });

  clock.flush();
  clock.advance(150);
  clock.flush();
  clock.advance(200); // t = 350 > 300，已经到位
  clock.flush();
  clock.advance(600); // t = 950，仍在保持
  clock.flush();
  clock.advance(50); // t = 1000 结束
  clock.flush();

  const at150 = samples.find((s) => s.tMs === 150);
  assert.equal(at150?.pose.offsets?.['p']?.[0], 50, '150ms 处应走到一半');
  const at350 = samples.find((s) => s.tMs === 350);
  assert.deepEqual(at350?.pose.offsets?.['p'], [100, 0, 0], '超过 300ms 后应已精确到位');
  assert.equal(at350?.pose.rotZDeg?.['r'], 180);
  const at950 = samples.find((s) => s.tMs === 950);
  assert.deepEqual(at950?.pose.offsets?.['p'], [100, 0, 0], '保持阶段不得回漂');
  const atEnd = samples[samples.length - 1];
  assert.equal(atEnd?.tMs, 1000);
  assert.deepEqual(atEnd?.pose.offsets?.['p'], [100, 0, 0]);
});

test('没有帧时不假装播放：立即结束并回调 onDone', () => {
  const clock = fakeClock();
  const reasons = [];
  const playback = createLinkagePlayback({
    frames: [],
    cycleMs: 500,
    now: clock.now,
    raf: clock.raf,
    onDone: (reason) => reasons.push(reason)
  });
  assert.equal(playback.finished, true);
  assert.deepEqual(reasons, ['end']);
  assert.equal(clock.pending(), 0);
  assert.equal(hasActiveLinkagePlayback(), false);
});

test('关闭抽屉后 onSample 不再被调用：applyPose 次数不随 tick 推进增长', () => {
  // 行为之外再钉住真实接线：DOM 不可用（panels.ts 引了 CSS，且没有 jsdom），
  // 所以这里直接读源码确认「关闭路径 → onClose → abortLinkagePlayback」这条线没被删。
  const panelsSource = readFileSync(new URL('../../src/ui/panels.ts', import.meta.url), 'utf8');
  assert.match(panelsSource, /if \(wasOpen\) drawerHandles\.get\(element\)\?\.onClose\?\.\(\)/,
    'closeDrawerElement 必须触发 onClose（×/Esc/再点入口三条路径的共用出口）');
  assert.match(panelsSource, /close\(\): void \{\s*closeDrawerElement\(root\);/, 'DrawerHandle.close 必须走 closeDrawerElement');
  const agentUiSource = readFileSync(new URL('../../src/agent/ui.ts', import.meta.url), 'utf8');
  assert.match(agentUiSource, /drawer\.onClose = abortLinkagePlayback/, '智能体面板必须把 onClose 接到 abortLinkagePlayback');

  const clock = fakeClock();
  const drawer = fakeDrawer();
  // 与 desktop/src/agent/ui.ts 的真实接线一致：drawer.onClose = abortLinkagePlayback
  drawer.onClose = abortLinkagePlayback;

  let applied = 0;
  const done = [];
  const playback = startLinkagePlayback({
    frames,
    cycleMs: 3000,
    now: clock.now,
    raf: clock.raf,
    cancelRaf: clock.cancelRaf,
    onSample: () => {
      applied += 1;
    },
    onDone: (reason) => done.push(reason)
  });
  clock.flush(); // t = 0
  clock.advance(16);
  clock.flush(); // t = 16
  assert.equal(applied, 2, '关闭前应当每帧都在写场景');
  assert.equal(drawer.isOpen(), true);

  drawer.close(); // × / Esc / 再点工具栏入口都是这一条路径
  assert.equal(drawer.isOpen(), false);
  assert.equal(playback.finished, true, '关闭抽屉必须结束播放');
  assert.equal(hasActiveLinkagePlayback(), false, '关闭后单例必须释放');
  assert.deepEqual(done, ['abort'], 'onDone(abort) 必须回调，播放按钮才能还原');

  const before = applied;
  for (let index = 0; index < 20; index += 1) {
    clock.advance(16);
    clock.flush();
  }
  assert.equal(applied, before, '面板已经关了，3D 里不许继续动');
  assert.equal(clock.pending(), 0);
});

test('onSample 抛错不卡死单例：停止播放、释放单例、可立即重新开播', () => {
  const clock = fakeClock();
  const errors = [];
  const done = [];
  let calls = 0;
  startLinkagePlayback({
    frames,
    cycleMs: 3000,
    now: clock.now,
    raf: clock.raf,
    cancelRaf: clock.cancelRaf,
    onSample: () => {
      calls += 1;
      if (calls === 2) throw new Error('applyPose 炸了');
    },
    onError: (error) => errors.push(error.message),
    onDone: (reason) => done.push(reason)
  });
  clock.flush(); // 第 1 次 onSample
  clock.advance(16);
  clock.flush(); // 第 2 次 onSample 抛错 → 必须收尾

  assert.equal(calls, 2);
  assert.deepEqual(errors, ['applyPose 炸了'], '错误要上报，不能吞');
  assert.deepEqual(done, ['abort'], '抛错按 abort 收尾');
  assert.equal(hasActiveLinkagePlayback(), false, '抛错后不能永远卡在 active');
  assert.equal(clock.pending(), 0, '不得留下会自我续命的 rAF');

  // 关键回归点：卡死的旧实现里这里 hasActiveLinkagePlayback() 永远是 true、按钮再也点不动
  const applied = [];
  startLinkagePlayback({
    frames,
    cycleMs: 3000,
    now: clock.now,
    raf: clock.raf,
    onSample: (sample) => applied.push(sample.tMs)
  });
  assert.equal(hasActiveLinkagePlayback(), true, '可以立即重新开播');
  clock.advance(16);
  clock.flush();
  assert.equal(applied.length, 1);
  abortLinkagePlayback();
  assert.equal(hasActiveLinkagePlayback(), false);
});

test('没有 onError 时 onSample 的错误仍然抛回调用方（不吞），且循环已结束', () => {
  const clock = fakeClock();
  const playback = startLinkagePlayback({
    frames,
    cycleMs: 3000,
    now: clock.now,
    raf: clock.raf,
    cancelRaf: clock.cancelRaf,
    onSample: () => {
      throw new Error('场景已释放');
    }
  });
  assert.throws(() => clock.flush(), /场景已释放/);
  assert.equal(playback.finished, true);
  assert.equal(hasActiveLinkagePlayback(), false);
  assert.equal(clock.pending(), 0);
});

// ---------------------------------------------------------------------------
// 生产回归：渲染进程里没有 `process`
//
// 真实接线：`dist/extension.js` 是 Vite **库模式**（iife）产物，在
// `did-finish-load` 以 <script> 注入页面世界执行，而 webPreferences 是
// nodeIntegration:false + contextIsolation:true → 页面世界没有 `process`。
// 库模式不折叠 `process.env.NODE_ENV`，所以告警里一旦出现该表达式，
// 整个播放循环会在第二帧抛 ReferenceError（且抛在 tick 的 try 之外，收尾不跑，
// 单例永远 active、播放按钮永久 disabled、3D 定住）。
// 下面两条用例把这个回归钉死：一条跑「编译产物 + 无 process 的 vm 上下文」，
// 一条守源码形态。
// ---------------------------------------------------------------------------

test('无 process 的上下文里播放照样跑通（编译产物跑两帧 + 回绕告警路径）', async () => {
  // 用与生产同一套编译口径（iife 库产物）把模块编出来，而不是直接 import 源码：
  // 源码在 Node 里有 process，跑了也测不出这个回归。
  const { transformSync } = await import('esbuild');
  const compiled = transformSync(panelSource(), {
    loader: 'ts',
    format: 'iife',
    globalName: 'LinkagePanel',
    target: 'chrome120'
  }).code;
  assert.doesNotMatch(compiled, /\bprocess\b/,
    '编译产物不得引用 process：渲染进程没有它，库模式构建也不会折叠');

  const warned = [];
  const context = vm.createContext({ console: { warn: (message) => warned.push(String(message)) } });
  assert.equal(vm.runInContext('typeof process', context), 'undefined',
    '前提：这个上下文里必须没有 process，否则用例测不到回归');
  vm.runInContext(compiled, context, { filename: 'linkage-panel.iife.js' });

  const api = context.LinkagePanel;
  assert.equal(typeof api.blendLinkagePose, 'function');
  assert.equal(typeof api.createLinkagePlayback, 'function');

  // 1) 逐帧播放：ΔrotZ = 200°（>180°，正是 warnWrappedAngle 那条分支）
  const clock = fakeClock();
  const samples = [];
  const playback = api.createLinkagePlayback({
    frames: [
      { tMs: 0, stepNo: 1, offsets: { 'st1-gripper-1': [0, 0, 0] }, rotZDeg: { 'st1-rotary-1': 0 } },
      { tMs: 300, stepNo: 2, offsets: { 'st1-gripper-1': [30, 0, -20] }, rotZDeg: { 'st1-rotary-1': 200 } }
    ],
    cycleMs: 300,
    now: clock.now,
    raf: clock.raf,
    cancelRaf: clock.cancelRaf,
    onSample: (sample) => samples.push({ tMs: sample.tMs, pose: sample.pose })
  });

  clock.flush(); // t = 0：alpha 0，不进告警分支
  clock.advance(150);
  clock.flush(); // t = 150：alpha 0.5 → 告警分支（旧实现在这里抛 ReferenceError）
  clock.advance(150);
  clock.flush(); // t = 300：末帧

  assert.deepEqual(samples.map((sample) => sample.tMs), [0, 150, 300], '三帧都必须真的写出去，不许停在第 1~2 帧');
  assert.equal(samples[1]?.pose.rotZDeg?.['st1-rotary-1'], 100, '中间帧仍是纯线性插值');
  assert.equal(samples[2]?.pose.rotZDeg?.['st1-rotary-1'], 200, '末帧精确等于目标帧');
  assert.equal(playback.finished, true);
  assert.equal(clock.pending(), 0);
  assert.equal(warned.length, 1, '告警分支必须真的执行到（不是被异常短路）');
  assert.match(warned[0], /回绕.*st1-rotary-1/);

  // 2) 去重靠 warnedWrappedParts，不靠 process.env：同一零件再插值一次不再提示
  api.blendLinkagePose({ rotZDeg: { 'st1-rotary-1': 0 } }, { rotZDeg: { 'st1-rotary-1': 200 } }, 0.5);
  assert.equal(warned.length, 1, '同一零件只告警一次');

  // 3) alpha 边界与 offsets 也不能因为跨上下文而炸
  const mixed = api.blendLinkagePose(
    { offsets: { p: [0, 0, 0] }, rotZDeg: { 'st1-rotary-1': 10 } },
    { offsets: { p: [40, 0, 20] }, rotZDeg: { 'st1-rotary-1': 30 } },
    0.25
  );
  assert.deepEqual(mixed.offsets.p, [10, 0, 5]);
  assert.equal(mixed.rotZDeg['st1-rotary-1'], 15);
  assert.doesNotMatch(vm.runInContext('typeof process', context), /object/,
    '全程都不得出现 process（跑完仍未定义）');
});

test('源码里不得再出现裸 process.env：可执行代码只允许 typeof process 守卫或干脆不引用', () => {
  // 「裸」= 可执行代码里直接读 process.env（注释里说明「为什么不能这么写」不算）。
  // 允许 `typeof process !== 'undefined' && process.env?.X` 这种形态，
  // 但一行代码里有 process.env 却没有 typeof 守卫，就是「渲染进程必抛」的那种写法。
  const bareProcessEnvLines = (text) => text
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .filter(({ line }) => /\bprocess\s*\.\s*env\b/.test(line))
    .filter(({ line }) => !/\btypeof\s+process\s*!==\s*['"]undefined['"]/.test(line))
    .map(({ line, number }) => `${number}: ${line.trim()}`);

  assert.deepEqual(bareProcessEnvLines(panelSource()), [],
    'linkage-panel.ts 在渲染进程里执行：裸 process.env 会让播放循环抛 ReferenceError');

  // 负向自证：检查器不是空转 —— 把出问题的写法（旧版 :164）喂进去必须报红
  const regressed = [
    'function warnWrappedAngle(part) {',
    "  if (process.env.NODE_ENV === 'production') return;",
    '}'
  ].join('\n');
  assert.equal(bareProcessEnvLines(regressed).length, 1, '检查器必须抓得住裸 process.env');
  const guarded = "if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') return;";
  assert.deepEqual(bareProcessEnvLines(guarded), [], '带 typeof 守卫的写法应当放行');
});

test('采样阶段抛错也走 abort 收尾：不留卡死单例、可立即重开播', () => {
  // 旧版把 sampleLinkageFrame(...) 放在 try 之外：采样一抛，异常直接从 rAF 回调冒出去，
  // finished 仍为 false、activeLinkagePlayback 仍指向它 → 按钮永久 disabled、3D 定住。
  const clock = fakeClock();
  const errors = [];
  const done = [];
  let sampled = 0;

  const badFrame = {
    tMs: 300,
    stepNo: 2,
    offsets: { 'st1-gripper-1': [30, 0, -20] },
    // 从第 2 帧起读取就抛（模拟坏帧 / 采样阶段自身出错）：抛点在 blend 之前，
    // 不在 onSample 里，所以只有把 sampleLinkageFrame 放进 try 才收得干净。
    get rotZDeg() {
      if (clock.now() >= 16) throw new Error('帧数据炸了');
      return { 'st1-rotary-1': 90 };
    }
  };

  const playback = startLinkagePlayback({
    frames: [frames[0], badFrame],
    cycleMs: 3000,
    now: clock.now,
    raf: clock.raf,
    cancelRaf: clock.cancelRaf,
    onSample: () => {
      sampled += 1;
    },
    onError: (error) => errors.push(error.message),
    onDone: (reason) => done.push(reason)
  });

  clock.flush(); // 第 1 帧：采样正常
  assert.equal(sampled, 1);
  assert.equal(hasActiveLinkagePlayback(), true);

  clock.advance(16);
  clock.flush(); // 第 2 帧：sampleLinkageFrame 抛错 → 必须走 abort 收尾，不许冒到调用方

  assert.equal(sampled, 1, '采样抛错时 onSample 不该被调用（错误发生在它之前）');
  assert.deepEqual(errors, ['帧数据炸了'], '错误要上报，不能吞');
  assert.deepEqual(done, ['abort'], '采样抛错也按 abort 收尾');
  assert.equal(playback.finished, true);
  assert.equal(hasActiveLinkagePlayback(), false, '抛错后不能永远卡在 active');
  assert.equal(clock.pending(), 0, '不得留下会自我续命的 rAF');

  // 关键回归点：卡死时这里 hasActiveLinkagePlayback() 永远是 true、按钮再也点不动
  const applied = [];
  startLinkagePlayback({
    frames,
    cycleMs: 3000,
    now: clock.now,
    raf: clock.raf,
    onSample: (sample) => applied.push(sample.tMs)
  });
  assert.equal(hasActiveLinkagePlayback(), true, '可以立即重新开播');
  clock.advance(16);
  clock.flush();
  assert.equal(applied.length, 1);
  abortLinkagePlayback();
  assert.equal(hasActiveLinkagePlayback(), false);
});

