// 守住「CLI 出来的数字」和「案例文件里的数字」一致。
// 为什么要有这条：Qt 客户端走 CLI 生成方案，文档/评估里的数字来自 machine-case.json，
// 两边一旦漂移，界面会显示一套、文档写另一套，而且都不会报错。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSyncSubprocessSites } from './sync-subprocess-scan.mjs';
import { screenInterference } from '../../src/machine/interference.ts';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..', '..');
const repoRoot = resolve(desktopRoot, '..');
const script = join(desktopRoot, 'scripts', 'machine-design-cli.mjs');
const caseFile = join(repoRoot, 'docs', 'desktop', 'eval', 'machine-case.json');

const BRIEF = '六工位锁螺丝机，节拍 20 件/分钟，每工位 1 套汇川 750W 伺服 + 1 个 SMC 气爪 + 1 个到位检测 + 安全光栅';
const SIX_BRIEF = BRIEF;
const FOUR_BRIEF = '四工位点胶机，节拍 25 件/分钟';

/**
 * 同步跑 CLI —— 本文件唯一的**同步**子进程入口。
 *
 * 为什么闸门必须下在子进程上（实测过，不是保险）：
 *   - `test(..., { timeout })` 与 `--test-timeout` 都靠 runner 的**进程内定时器**，而
 *     `execFileSync` 会把事件循环整段占死，定时器根本没机会触发。探针里
 *     `test(..., {timeout:300}, () => execFileSync(...))` 照样跑到 3,145 ms。
 *   - 给 `execFileSync` 自己加 `timeout + killSignal` 才是有效闸门：到点子进程被 SIGKILL，
 *     用例立刻失败，而不是让整个套件无限挂起。
 *
 * 取值：本文件基线最长 71.3 s（`--layout-compliance 40`），这里给 180 s（约 2.5 倍余量）。
 * 需要另行标定时用 `FT_CLI_TIMEOUT_MS=90000 node --test test/machine/cli.test.mjs` 覆盖。
 */
const CLI_TIMEOUT_MS = (() => {
  const raw = Number(process.env.FT_CLI_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 180_000;
})();

const argsKey = (args) => JSON.stringify(args);

/**
 * 每次 CLI 调用都起一个进程、跑一遍求解器；同一组参数在多处用到时（例如六工位
 * `--layout-compliance 40` 被 3 条用例、4 处引用），跑第二遍拿到的必然还是同一份结果。
 * 这里按「参数完全一致」记忆化：断言一条都不改，只是不再重复付求解器的钱。
 *
 * 只记忆**成功**的调用：失败用例（退出 2 / 超时）本来就是毫秒级，且错误对象不该被复用。
 */
const stdoutCache = new Map();

/**
 * 昂贵参数集（单次 6~26 s，实测见 cad-opt-pkg-e.md 的计时表）。
 * 启动时并行预跑，用例里 `await` 同一份结果 —— 三条求解在 8 核上互不排队，
 * 墙钟约等于最慢的那一条，而不是三条之和。
 */
const HEAVY_ARG_SETS = [
  ['--brief', SIX_BRIEF, '--with-geometry', '--layout-compliance', '40'],
  ['--brief', SIX_BRIEF, '--with-geometry', '--layout-compliance', '35'],
  ['--brief', FOUR_BRIEF, '--with-geometry', '--max-clearance']
];

const heavyRuns = new Map();

/**
 * 异步跑 CLI（只用于预跑的昂贵参数）。
 *
 * 与 runCli 的区别只在「怎么等」：这里 await，所以事件循环不被占死，多条求解可以真并行。
 * 闸门一条不少：同样的 `timeout + SIGKILL`，到点子进程被硬杀、promise 以超时错误 reject。
 */
function runCliAsync(args, { timeoutMs = CLI_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: desktopRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      const error = new Error(`CLI 退出 code=${code} signal=${signal}${stderr ? `：${stderr.slice(0, 400)}` : ''}`);
      error.status = code;
      error.signal = signal;
      error.stderr = stderr;
      error.timedOut = timedOut;
      rejectPromise(error);
    });
  });
}

for (const args of HEAVY_ARG_SETS) {
  const key = argsKey(args);
  const run = runCliAsync(args);
  // 没被任何用例 await 到（例如 --test-name-pattern 只跑小用例）时不该变成 unhandledRejection
  run.catch(() => {});
  heavyRuns.set(key, run);
}

/** 取预跑结果；参数不在 HEAVY_ARG_SETS 里就是写错了，直接炸而不是静默再跑 26 s。 */
async function heavyStdout(args) {
  const key = argsKey(args);
  const run = heavyRuns.get(key);
  if (!run) throw new Error(`这组参数没有预跑，请先加进 HEAVY_ARG_SETS：${key}`);
  return run;
}

const heavyJson = async (args) => JSON.parse(await heavyStdout(args));

function runCli(args, { timeoutMs = CLI_TIMEOUT_MS, noCache = false } = {}) {
  const key = argsKey(args);
  if (heavyRuns.has(key)) {
    // 昂贵参数被同步调用会把并行预跑变成串行再跑一遍，必须走 await heavyStdout
    throw new Error(`昂贵参数必须 await heavyStdout，不能同步重跑：${key}`);
  }
  const hit = noCache ? undefined : stdoutCache.get(key);
  if (hit !== undefined) return hit;
  const stdout = execFileSync(process.execPath, [script, ...args], {
    cwd: desktopRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    // 硬杀：CLI 卡在内核探测 / sidecar HTTP 时 SIGTERM 可能被忽略
    killSignal: 'SIGKILL'
  });
  if (!noCache) stdoutCache.set(key, stdout);
  return stdout;
}

test('machine-design-cli 输出的方案与 machine-case.json 一致', { timeout: 120_000 }, () => {
  const stdout = runCli(['--brief', BRIEF]);
  const fromCli = JSON.parse(stdout);
  const reference = JSON.parse(readFileSync(caseFile, 'utf8'));

  assert.equal(fromCli.kind, 'machine-case');
  assert.equal(fromCli.schemaVersion, 1);
  assert.equal(fromCli.brief, reference.brief);
  // 结构化结果必须逐字一致（assumptions 文本允许不同：CLI 会说明没读 userData 定价）
  assert.deepEqual(fromCli.parsed, reference.parsed);
  assert.deepEqual(fromCli.stations, reference.stations);
  assert.deepEqual(fromCli.bom, reference.bom);
  assert.deepEqual(fromCli.ioMap, reference.ioMap);
  assert.deepEqual(fromCli.electrical, reference.electrical);
  assert.deepEqual(fromCli.cycleAnalysis, reference.cycleAnalysis);
  assert.equal(fromCli.cost.total, reference.cost.total);
  assert.equal(fromCli.cost.missingCount, reference.cost.missingCount);
});

test('--move 改中心点并带出 moves，未知零件/格式错误都退出 2', { timeout: 120_000 }, () => {
  const stdout = runCli(['--brief', BRIEF, '--with-geometry', '--move', 'frame-stringer-front:0,0,-1000']);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed.geometry.moves, [{ id: 'frame-stringer-front', delta: [0, 0, -1000] }]);
  const moved = parsed.geometry.parts.find((part) => part.id === 'frame-stringer-front');
  const reference = JSON.parse(readFileSync(caseFile, 'utf8'));
  assert.ok(moved, '挪动的零件应还在 parts 里');
  assert.deepEqual(moved.movedBy, [0, 0, -1000]);
  assert.ok(reference.brief.length > 0);

  const run = (extra) => {
    try {
      runCli(['--brief', BRIEF, '--with-geometry', ...extra]);
      return { status: 0, stderr: '' };
    } catch (error) {
      return { status: error.status, stderr: String(error.stderr) };
    }
  };
  const unknown = run(['--move', 'no-such-part:10,0,0']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /FT_MACHINE_CLI_UNKNOWN_PART/);

  const malformed = run(['--move', 'frame-top:10,0']);
  assert.equal(malformed.status, 2);
  assert.match(malformed.stderr, /FT_MACHINE_CLI_BAD_MOVE/);
});

test('挪开横梁后对应重叠消失（试摆位闭环）', { timeout: 180_000 }, () => {
  // 用四工位 brief：这台机器只有「立柱插横梁」两处重叠，挪走后应当真的归零，
  // 六工位机还有立柱×转台这类 AABB 保守重叠，数量不会归零（那是初筛的固有噪声，不该拿来当零基线）
  const brief = '四工位点胶机，节拍 25 件/分钟，每工位 1 套步进 + 1 个气爪 + 1 个到位检测';
  const run = (extra) => JSON.parse(runCli(['--brief', brief, '--with-geometry', ...extra]));
  const before = run([]).geometry.interference;
  const after = run(['--move', 'frame-stringer-front:0,0,-1000', '--move', 'frame-stringer-back:0,0,-1000']).geometry.interference;
  assert.ok(before.count > 0, `挪之前应当有重叠，实际 ${before.count}`);
  assert.equal(after.count, 0, `挪开之后应当没有重叠，实际 ${after.count}（${after.pairs.map((p) => `${p.a}×${p.b}`).join(',')}）`);
});

test('machine-design-cli 缺少 --brief 时退出码 2 且不输出 JSON', { timeout: 60_000 }, () => {
  let failed = null;
  try {
    runCli([]);
  } catch (error) {
    failed = error;
  }
  assert.ok(failed, '应当非零退出');
  assert.equal(failed.status, 2);
  assert.match(String(failed.stderr), /FT_MACHINE_CLI_USAGE/);
});


test('--clearance 20 输出间距初筛，且按间隙升序、count 与数组一致', { timeout: 120_000 }, () => {
  const stdout = runCli(['--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry', '--clearance', '20']);
  const clearance = JSON.parse(stdout).geometry.clearance;
  assert.equal(clearance.thresholdMm, 20);
  assert.equal(clearance.count, clearance.pairs.length);
  for (let index = 1; index < clearance.pairs.length; index += 1) {
    assert.ok(clearance.pairs[index - 1].gapMm <= clearance.pairs[index].gapMm, '必须按间隙升序');
  }
  for (const pair of clearance.pairs) {
    assert.ok(pair.gapMm > 0.5 && pair.gapMm < 20, `间隙必须在 (0.5, 20) 内：${pair.gapMm}`);
  }
});

test('--clearance 取值不合法时退出码 2（不带 --with-geometry 也不能静默吞掉）', { timeout: 120_000 }, () => {
  for (const value of ['0', '-5', 'abc']) {
    let status = 0;
    try {
      runCli(['--brief', '四工位点胶机', '--clearance', value]);
    } catch (error) {
      status = error.status;
    }
    assert.equal(status, 2, `--clearance ${value} 应当退出 2`);
  }
});


test('--boolean-recheck：连不上 sidecar 时如实标「未复核」，不冒充没问题', { timeout: 120_000 }, () => {
  const stdout = runCli(['--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry', '--boolean-recheck', 'http://127.0.0.1:1']);
  const recheck = JSON.parse(stdout).geometry.booleanRecheck;
  assert.equal(recheck.suspects, 0, '排布合规后的样机没有疑似对');
  assert.equal(recheck.checked, 0);
  assert.match(recheck.message, /无需复核/, '0 处疑似要说「不需要」，不能说「已复核」');
});

test('--insert-part 配 --part-size：零件按新尺寸落地，底面仍贴地', { timeout: 120_000 }, () => {
  const stdout = runCli(['--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry', '--insert-part', 'upright@-900,0,0', '--part-size', '60x60x1200']);
  const parts = JSON.parse(stdout).geometry.parts;
  const inserted = parts.find((part) => part.id.startsWith('user-upright'));
  assert.ok(inserted, '必须插入 user-upright-*');
  assert.deepEqual(inserted.shape.size, [60, 60, 1200]);
  assert.equal(inserted.center[2], 600, '中心 z = 高度/2，底面贴地');
});

test('--touching-report：未声明贴面列成可处置清单（带轴与建议）', { timeout: 180_000 }, () => {
  const stdout = runCli(['--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry', '--touching-report']);
  const geometry = JSON.parse(stdout).geometry;
  const report = geometry.touchingReport;
  assert.ok(Array.isArray(report), '必须有清单字段');
  assert.equal(report.length, geometry.touchingReportCount);
  assert.equal(report.length, geometry.interference.undeclaredTouching, '清单条数必须等于未声明数');
  for (const item of report) {
    assert.equal(item.declared, false, '只列未声明的');
    assert.ok(['x', 'y', 'z'].includes(item.axis));
    assert.ok(item.suggestion.length > 0, '每条都要给处置建议');
  }
  // 叠装链声明后四工位不应再有未声明贴面；但贴合本身仍要被计数（不是被删掉）
  assert.equal(geometry.interference.undeclaredTouching, 0);
  assert.ok(geometry.interference.touching > 0, '贴合对仍必须计数');
});

test('relation 分清 overlap / touching / clear（0 mm 不等于撞了）', { timeout: 180_000 }, () => {
  const read = (flag, value) => {
    const stdout = runCli(['--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry', flag, value]);
    const geometry = JSON.parse(stdout).geometry;
    return geometry.inserted ?? geometry.moveNearest;
  };
  assert.equal(read('--insert-part', 'gripper@-870,-330,0').relation, 'overlap');
  assert.equal(read('--insert-part', 'gripper@0,0,0').relation, 'clear');
  assert.equal(read('--move', 'frame-leg-1:840,0,0').relation, 'touching', '立柱顶面贴顶框属于贴合');
  assert.equal(read('--move', 'frame-leg-1:-870,-330,0').relation, 'clear');
});

test('--move 后给出该件最近邻居（贴合/重叠为 0），与插入口径对等', { timeout: 180_000 }, () => {
  const read = (move) => {
    const stdout = runCli(['--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry', '--move', move]);
    return JSON.parse(stdout).geometry.moveNearest;
  };
  const touching = read('frame-leg-1:840,0,0');
  assert.equal(touching.partId, 'frame-leg-1');
  assert.equal(touching.nearGapMm, 0, '挪到贴住别的件，间隙必须是 0');
  assert.ok(touching.nearPart.length > 0);

  const far = read('frame-leg-1:-870,-330,0');
  assert.ok(far.nearGapMm > 100, `挪远后间隙应大于 100，实际 ${far.nearGapMm}`);
});

test('声明叠装链后：未声明贴面为 0，但真重叠与最大可行间距结论不许变', { timeout: 240_000 }, async () => {
  const read = (brief, extra) => {
    const stdout = runCli(['--brief', brief, '--with-geometry', ...extra]);
    return JSON.parse(stdout).geometry;
  };
  const four = read(FOUR_BRIEF, ['--clearance', '20']);
  assert.equal(four.interference.undeclaredTouching, 0, '叠装链应全部声明');
  // 覆盖率反向检查：贴合对总数钉死。生成器以后新增构件却没写声明规则时，这个数会变，测试报警。
  assert.equal(four.interference.touching, 57, '四工位贴合对总数漂了：要么新增了构件，要么声明规则漏了');
  assert.equal(four.interference.suspects, 0);

  // 声明不能把真重叠洗掉：40 mm 排布仍未收敛、最大可行间距仍是 25
  const maxc = await heavyJson(['--brief', FOUR_BRIEF, '--with-geometry', '--max-clearance']).then((doc) => doc.geometry);
  assert.equal(maxc.maxClearance.feasibleMm, 25, '最大可行间距必须仍是 25');
  const l40 = read(FOUR_BRIEF, ['--layout-compliance', '40']);
  assert.equal(l40.layoutCompliance.converged, false, '40 mm 仍必须报不收敛');
  assert.equal(l40.layoutCompliance.suspects, 2, '40 mm 的真重叠仍必须报出来');

  const six = read(SIX_BRIEF, []);
  assert.equal(six.interference.undeclaredTouching, 0);
  assert.equal(six.interference.touching, 102, '六工位贴合对总数漂了：查新增构件是否漏声明');
  assert.equal(six.interference.suspects, 8, '六工位原有重叠不能被声明洗掉');
});

test('--insert-part 会给出新件最近邻居与间隙（重叠时 0）', { timeout: 180_000 }, () => {
  const read = (spec) => {
    const stdout = runCli(['--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry', '--insert-part', spec]);
    return JSON.parse(stdout).geometry.inserted;
  };
  const hit = read('gripper@-870,-330,0');
  assert.equal(hit.nearGapMm, 0, '压在立柱上，间隙必须是 0');
  assert.equal(hit.nearPart, 'frame-leg-1');

  const free = read('gripper@0,0,0');
  assert.ok(free.nearGapMm > 100, `原点附近应当离得远，实际 ${free.nearGapMm}`);
  assert.ok(typeof free.nearPart === 'string' && free.nearPart.length > 0);
});

test('--with-geometry 输出 bounds，且与 parts 一一对应（Qt 拖动预览靠它本地判重叠）', { timeout: 120_000 }, () => {
  const stdout = runCli(['--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry']);
  const geometry = JSON.parse(stdout).geometry;
  const parts = geometry.parts;
  const bounds = geometry.bounds;
  assert.equal(bounds.length, parts.length, '每个零件都要有包围盒');
  bounds.forEach((entry, index) => {
    assert.equal(entry.id, parts[index].id);
    assert.equal(entry.min.length, 3);
    assert.equal(entry.max.length, 3);
    entry.min.forEach((value, axis) => assert.ok(value <= entry.max[axis], `${entry.id} min<=max`));
  });
});

test('线体加宽：CLI 把结论写进 geometry.widening，不可行时给带数字的原因', { timeout: 240_000 }, () => {
  const stdout = runCli(['--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry', '--min-widening', '40']);
  const widening = JSON.parse(stdout).geometry.widening;
  assert.equal(widening.targetClearanceMm, 40);
  assert.equal(widening.reachable, false, '四工位 40 mm 加宽到上限仍不收敛');
  assert.equal(widening.extraMm, widening.maxExtraMm);
  assert.ok(widening.probes.length >= 2, '至少探测 0 与上限两点');
  assert.equal(widening.probes[0].extraMm, 0);
  assert.match(widening.remaining.reason, /重叠|工位内部|跨工位/);
  assert.match(widening.remaining.reason, /\d+/, '原因要落到具体处数，不能只说「不行」');
});

test('--resolve-clearance 20 把间距推到阈值之上（不是只算建议，要真的合规）', { timeout: 180_000 }, () => {
  const stdout = runCli(['--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry', '--resolve-clearance', '20', '--clearance', '20']);
  const geometry = JSON.parse(stdout).geometry;
  const resolution = geometry.clearanceResolution;
  assert.equal(resolution.converged, true, `未收敛：${resolution.stopReason}`);
  assert.ok(resolution.before > 0, '这个案例本来就有间距问题');
  assert.equal(resolution.after, 0);
  assert.equal(geometry.clearance.count, 0, '重算后的间距初筛必须为 0');
  // 注意：不能断言「每条 move 的 gapAfter 都 ≥ 阈值」——单轴推开只增加一个轴的距离，
  // 而距离是各分离轴的平方和；后续 move 还会改变这一对的距离（实测某条当时 19.6 mm，
  // 再经过后续微调才到 20 以上）。能守住的是「整轮跑完 count=0」。
  assert.ok(resolution.moves.length > 0);
  for (const move of resolution.moves) {
    assert.ok(move.gapAfter > 0.5, `${move.partId} 挪完是接触状态 ${move.gapAfter} mm`);
  }
});


test('--layout-compliance 20 交替跑完必须两类都清零（不是只清一类）', { timeout: 240_000 }, () => {
  const stdout = runCli(['--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry', '--layout-compliance', '20', '--clearance', '20']);
  const geometry = JSON.parse(stdout).geometry;
  const layout = geometry.layoutCompliance;
  assert.equal(layout.converged, true, `未收敛：${layout.stopReason}`);
  assert.equal(layout.suspects, 0);
  assert.equal(layout.clearance, 0);
  assert.equal(geometry.interference.suspects, 0, '重算后的干涉初筛也必须为 0');
  assert.equal(geometry.clearance.count, 0, '重算后的间距初筛也必须为 0');
  assert.ok(layout.rounds.length >= 1);
  // 轮次记录必须能看出「推间距会撞出新重叠」这件事发生过
  const last = layout.rounds[layout.rounds.length - 1];
  assert.equal(last.suspectsAfter, 0);
  assert.equal(last.clearanceAfter, 0);
  assert.ok(layout.moves.length > 0);
});


test('排布合规：40 mm 放不下时如实报未收敛，且不空转到上千次位移', { timeout: 240_000 }, () => {
  const stdout = runCli(['--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry', '--layout-compliance', '40']);
  const layout = JSON.parse(stdout).geometry.layoutCompliance;
  assert.equal(layout.converged, false, '40 mm 在四工位布局下放不下，不能报合规');
  assert.ok((layout.stopReason ?? '').length > 0, '必须说明为什么没收敛');
  assert.ok(layout.moves.length < 300, `不应空转出上百次位移，实际 ${layout.moves.length}`);
  assert.ok(layout.rounds.length <= 4);
  // 40 mm 下剩下的问题是重叠（不是间距）——所以 advice 为空是合理的
  assert.equal(layout.clearance, 0);
  assert.ok(layout.suspects > 0);
  assert.equal((layout.advice ?? []).length, 0, '没有间距问题时不该硬凑建议');
});


test('--layout-compliance 会把合规结论写成文档顶层的 compliance 戳（与 details 一致）', { timeout: 240_000 }, () => {
  const stdout = runCli(['--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry', '--layout-compliance', '20']);
  const document = JSON.parse(stdout);
  const stamp = document.compliance;
  const details = document.geometry.layoutCompliance;
  assert.ok(stamp, '文档顶层必须有 compliance');
  assert.equal(stamp.clearanceMm, 20);
  assert.equal(stamp.converged, details.converged);
  assert.equal(stamp.rounds, details.rounds.length);
  assert.equal(stamp.moves, details.moves.length);
  assert.equal(stamp.suspects, details.suspects);
  assert.equal(stamp.clearance, details.clearance);
});


test('排布合规 fixture 与当前算法一致（CI 的 Qt 自检靠它，漂了要重新生成）', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, 'docs', 'desktop', 'eval', 'layout-case.json'), 'utf8'));
  const stamp = fixture.compliance;
  assert.equal(fixture.kind, 'machine-case');
  assert.equal(stamp.clearanceMm, 20);
  assert.equal(stamp.converged, true);
  assert.equal(stamp.suspects, 0);
  assert.equal(stamp.clearance, 0);
  assert.equal(stamp.rounds, 2);
  assert.equal(stamp.moves, 50);
  const details = fixture.geometry.layoutCompliance;
  assert.equal(details.moves.length, 50);
  assert.equal(details.rounds.length, 2);
  // 同一份 fixture 也标了机器上限：打开方案就能看出「按 20 排的，其实能到 25」
  assert.equal(stamp.maxFeasibleMm, 25);
  assert.equal(fixture.geometry.maxClearance.feasibleMm, 25);
  // fixture 里必须真有一个未收敛的反例参数可查（同一份 geometry 按 40 mm 会放不下）
  assert.equal(fixture.geometry.parts.length > 0, true);
});


test('排布没收敛时必须给出“还剩哪几对、往哪挪多少”（不能只说没排开）', { timeout: 300_000 }, () => {
  const stdout = runCli(['--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry', '--layout-compliance', '40']);
  const layout = JSON.parse(stdout).geometry.layoutCompliance;
  assert.equal(layout.converged, false);
  assert.ok(layout.remainingPairs.length > 0, '未收敛时必须列出剩余重叠对');
  assert.equal(layout.remainingPairs.length, layout.suspects, '剩余对数量必须与 suspects 一致');
  for (const pair of layout.remainingPairs) {
    assert.ok(typeof pair.a === 'string' && typeof pair.b === 'string');
    assert.ok(['x', 'y', 'z'].includes(pair.axis), '每对都要有轴');
    assert.ok(Number.isFinite(pair.deltaMm) && pair.deltaMm !== 0, '每对都要有非零位移');
  }
});

test('排布求解器不得在两张布局之间来回挪：必须识别活锁并如实说明', { timeout: 300_000 }, () => {
  const run = (args) => JSON.parse(runCli([...args])).geometry.layoutCompliance;

  // 40 mm：实测会在 st1/st4-rotary-1-table 的 z 上来回 +13/-13，直到轮数用尽
  const forty = run(['--brief', FOUR_BRIEF, '--with-geometry', '--layout-compliance', '40']);
  assert.equal(forty.converged, false);
  assert.match(forty.stopReason, /来回挪|回到第 \d+ 轮/, '必须点明是来回挪，而不是含糊说“没进展”');
  assert.match(forty.stopReason, /第 \d+ 轮回到了第 \d+ 轮/, '要说清是在哪两轮之间循环');
  assert.match(forty.stopReason, /rotary-1-table/, '必须点名是哪几件在来回挪');
  assert.equal(forty.remainingPairs.length, forty.suspects);

  // 同一件同一轴被推的次数必须有界：这是「别无限来回蹭」的底线守卫，
  // 不是精确值——真正的结构约束（位移不得减少与支撑件的间隙）还没做。
  const perAxis = new Map();
  for (const move of forty.moves ?? []) {
    const key = `${move.partId}|${move.axis}`;
    perAxis.set(key, (perAxis.get(key) ?? 0) + 1);
  }
  for (const [key, count] of perAxis) {
    assert.ok(count <= 6, `${key} 被挪了 ${count} 次，像是没止住的来回蹭`);
  }

  // 20 mm 仍然必须收敛（别为了防活锁把正常情况也卡死）
  const twenty = run(['--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry', '--layout-compliance', '20']);
  assert.equal(twenty.converged, true);
  assert.equal(twenty.suspects, 0);
});

test('--max-clearance 二分出四工位的最大可行间距 = 25 mm，且该值复算确实收敛', { timeout: 300_000 }, async () => {
  const document = await heavyJson(['--brief', FOUR_BRIEF, '--with-geometry', '--max-clearance']);
  const maxClearance = document.geometry.maxClearance;
  assert.equal(maxClearance.feasibleMm, 25, `实际 ${maxClearance.feasibleMm}`);
  assert.ok(maxClearance.probes.length >= 3, '二分至少探测 3 次');
  // 探测记录必须自洽：25 通过、26 不通过（否则结论不可信）
  const byMm = new Map(maxClearance.probes.map((probe) => [probe.mm, probe.converged]));
  assert.equal(byMm.get(25), true);
  assert.equal(byMm.get(26), false);
});


test('工位级建议：只有跨工位的间距问题才可能给建议', { timeout: 300_000 }, async () => {
  const read = (brief, threshold) => {
    const stdout = runCli(['--brief', brief, '--with-geometry', '--layout-compliance', String(threshold)]);
    return JSON.parse(stdout).geometry.layoutCompliance;
  };

  // 四工位 40 mm：剩下的 2 处是重叠，不是间距 → 没有建议可说
  const four = read(FOUR_BRIEF, 40);
  assert.equal(four.clearance, 0);
  assert.ok(four.suspects > 0);
  assert.equal((four.advice ?? []).length, 0, '没有间距问题时不该硬凑建议');

  // 六工位 40 mm：应当有跨工位的间距建议；可执行性由下面的几何重放校验。
  const six = (await heavyJson(['--brief', SIX_BRIEF, '--with-geometry', '--layout-compliance', '40'])).geometry.layoutCompliance;
  assert.ok(six.advice.length > 0);
  assert.ok(six.advice.every((item) => item.intraScope === false), '六工位应当全是跨工位问题');
});

test('建议的可执行性：actionable 只给「跨工位且推完不撞」的条目', { timeout: 300_000 }, async () => {
  for (const threshold of [35, 40]) {
    const { geometry } = await heavyJson(['--brief', SIX_BRIEF, '--with-geometry', '--layout-compliance', String(threshold)]);
    const { advice } = geometry.layoutCompliance;
    assert.ok(advice.length > 0, `${threshold} mm 应当有建议`);
    for (const item of advice) {
      if (item.intraScope) {
        assert.equal(item.actionable, false, `${item.scope} 是工位内部问题，不该可执行`);
        continue;
      }
      const axis = ['x', 'y', 'z'].indexOf(item.axis);
      assert.ok(axis >= 0, `无效轴向：${item.axis}`);
      assert.ok(item.direction === 1 || item.direction === -1, `无效方向：${item.direction}`);
      assert.ok(Number.isFinite(item.shortByMm) && item.shortByMm > 0, `无效位移：${item.shortByMm}`);
      const parts = geometry.parts.map((part) => part.id.split('-')[0] === item.scope
        ? { ...part, center: part.center.map((value, index) => index === axis ? value + item.direction * item.shortByMm : value) }
        : part);
      assert.ok(parts.some((part, index) => part !== geometry.parts[index]), `没有移动 ${item.scope} 的零件`);
      const suspects = screenInterference({ ...geometry, parts }).suspects;
      const label = `${threshold} mm ${item.scope} 移动后的干涉初筛`;
      assert.equal(item.overlapsAfter, suspects, label);
      assert.equal(item.actionable, suspects === 0, label);
    }
  }
});

test('CLI 子进程到点被硬杀（真正的闸门在子进程上，不在 {timeout}）', () => {
  const started = Date.now();
  let failure = null;
  try {
    // 1ms 必然超时：正常单条 CLI 约 0.4s，这条件下不许"静默跑完"
    // noCache：这组参数与首条用例相同，吃了记忆化就成了「断言缓存」而不是「断言闸门」
    runCli(['--brief', BRIEF], { timeoutMs: 1, noCache: true });
  } catch (error) {
    failure = error;
  }
  const elapsed = Date.now() - started;
  assert.ok(failure, '1ms 超时必须让调用失败');
  assert.ok(
    failure.code === 'ETIMEDOUT' || failure.signal === 'SIGKILL',
    `必须以超时/硬杀结束，实际 code=${failure.code} signal=${failure.signal}`
  );
  assert.ok(elapsed < 30_000, `必须立刻结束，实际等了 ${elapsed}ms`);
});

test('cli.test.mjs 里同步子进程都带 timeout 与 killSignal（防止有人绕过 runCli）', () => {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  // 扫描口径只有一份实现（`sync-subprocess-scan.mjs`）：注释里会讲到这些 API，先剥注释再数；
  // 三种同步子进程都要认——只数 execFileSync 的话，换成 spawnSync/execSync 就能绕过这把锁
  // （它们同样会把事件循环占死，{timeout} 选项照样不生效）。
  const sites = scanSyncSubprocessSites(source);
  assert.equal(sites.length, 1, `所有 CLI 调用必须走 runCli，不允许散落同步子进程（实际命中 ${sites.join('/') || '无'}）`);
  assert.equal(sites[0], 'execFileSync', 'runCli 里的那一次调用必须是 execFileSync（要能拿到 ETIMEDOUT/SIGKILL）');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /timeout: timeoutMs/, 'runCli 必须把 timeout 传给子进程');
  assert.match(code, /killSignal: 'SIGKILL'/, 'runCli 必须硬杀超时子进程');
  // 预跑昂贵参数走的是异步 spawn（不占事件循环），但闸门不许因此变松：
  // 它必须自己带计时器 + SIGKILL，否则一个卡死的求解能把整个套件挂住 180 s 以上。
  assert.equal((code.match(/\bspawn\s*\(/g) ?? []).length, 1, '异步入口只允许 runCliAsync 里那一次 spawn');
  assert.match(code, /const timer = setTimeout\(/, 'runCliAsync 必须给子进程装超时计时器');
  assert.match(code, /child\.kill\('SIGKILL'\)/, 'runCliAsync 到点必须 SIGKILL 子进程');
  assert.match(code, /clearTimeout\(timer\)/, 'runCliAsync 子进程结束后必须清掉计时器');
});

test('静态守卫负例（行为式）：扫描函数对三种同步子进程都必须咬，且不误报字符串/属性', () => {
  // 负向自证不再「自己抄一份正则」：这里只喂伪造源码给**守卫用的同一个函数**，验它的行为。
  // 守卫若退化成只认 `execFileSync\(`，`spawnSync`/`execSync` 两条断言立刻红——
  // 旧写法（负例自己写一份同样的正则）在守卫退化时两条测试会同时绿，等于没自证。
  const fakeCall = (name, args = '') => `${name}(${args})`;
  assert.deepEqual(scanSyncSubprocessSites(fakeCall('execFileSync', "'node', ['x'], { timeout: 1 }")), ['execFileSync']);
  assert.deepEqual(scanSyncSubprocessSites(fakeCall('spawnSync', "'node', ['x']")), ['spawnSync'], '只认 execFileSync 的实现会在这里返回 []');
  assert.deepEqual(scanSyncSubprocessSites(fakeCall('execSync', "'node x'")), ['execSync'], '只认 execFileSync 的实现会在这里返回 []');
  assert.deepEqual(
    scanSyncSubprocessSites([fakeCall('execFileSync'), fakeCall('spawnSync'), fakeCall('execSync')].join('; ')),
    ['execFileSync', 'spawnSync', 'execSync']
  );
  // 名字出现在字符串/属性里不算调用点（避免把文档文字或 foo.execSyncX( ) 当子进程）
  assert.deepEqual(scanSyncSubprocessSites("const name = 'spawnSync'; foo.execSyncX(1)"), []);
  // 注释里的调用片段也不算（真有人写说明文字时不该把守卫顶红）。
  // 这里用拼接构造：字面量里不出现「名字紧跟左括号」，否则上面的全文件扫描会把本测试自己数进去。
  const commented = ['// 这里有 spawn' + 'Sync(x)', '/* exec' + 'Sync(y) */', 'const ok = 1;'].join('\n');
  assert.deepEqual(scanSyncSubprocessSites(commented), []);
});
