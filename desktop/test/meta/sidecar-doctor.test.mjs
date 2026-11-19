// 孤儿 sidecar 体检脚本（`npm run doctor:sidecar`）的定向单测。
//
// 这个脚本的价值**全在「不误杀」**：它要在多会话共用的机器上，从几百个进程里认出
// 「本仓 + python + spike/build123d/app.py + --port 7400-7499 + PPID=1 + 年龄≥1h」的那几个。
// 判据写松一格，就会有别人的 kernel 被 SIGKILL；写紧一格，孤儿继续吃 894 MB。
// 所以下面既有正向（真孤儿 fixture 必须认出来），也有**逐条负向**：
// 跨仓库同形、端口越界、非 python、无 --port、PPID≠1、PID 1、自己、年龄不足。
//
// 全部用纯函数 + fixture `/proc` 树，不碰本机真实进程；`--kill` 路径用注入的 killer 记录器
// 验「一次都没调用」，只有最后一例故意让记录器收到一次调用（证明正向通路是通的）。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_MIN_AGE_SECONDS,
  PORT_MAX,
  PORT_MIN,
  applyKills,
  classifySidecars,
  formatCmdline,
  main,
  matchSidecar,
  planKills,
  readPort,
  scanProcesses,
  verifyIdentity
} from '../../scripts/sidecar-doctor.mjs';

// 造一个**真实存在**的 fixture 仓库根：`--kill` 会校验 `<repoRoot>/spike/build123d/app.py`，
// 这也是「跨仓库同形」用例（`<REPO>-2`）能成立的前提 —— 后者故意不创建。
const REPO = mkdtempSync(join(tmpdir(), 'sidecar-doctor-repo-'));
const APP = join(REPO, 'spike', 'build123d', 'app.py');
mkdirSync(join(REPO, 'spike', 'build123d'), { recursive: true });
writeFileSync(APP, '# fixture: 只为让 --kill 的 repoRoot 校验通过，不执行\n');
const SECRET_TOKEN = 'BRnlXrscSUDI4JZWUq-OdNPl7SdW3dsnu-1Y4q9S19k';

/** 一条 argv 的收束：真孤儿（pid 2040641 的实测形状）。 */
const orphanArgv = (port) => [
  '/root/.venvs/b123d/bin/python3',
  APP,
  '--port',
  String(port),
  '--token',
  SECRET_TOKEN
];

/** 造一条 classifySidecars 能吃的 entry（字段形状与 scanProcesses 输出一致）。 */
const entry = (overrides) => ({
  pid: 2040641,
  ppid: 1,
  argv: orphanArgv(7431),
  ageSeconds: 30487,
  startTicks: 331_000,
  rssKb: 462180,
  ...overrides
});

const baseOpts = { repoRoot: REPO };
/** 记录所有 kill 调用（signals），用来证明「不该杀时一次都没发」。 */
const makeRecorder = () => {
  const calls = [];
  return { calls, killer: (pid, signal) => calls.push({ pid, signal }) };
};

// ---------------------------------------------------------------------------
// 1. 正向：真孤儿 fixture 必须认出来，且凭据不外泄
// ---------------------------------------------------------------------------
test('识别真孤儿：python + 本仓 app.py + 7431 + PPID=1 + 8h28m → killable', () => {
  const [row] = classifySidecars([entry({})], baseOpts);

  assert.equal(row.sidecar, true);
  assert.equal(row.verdict, 'killable');
  assert.deepEqual(row.reasons, []);
  assert.equal(row.pid, 2040641);
  assert.equal(row.ppid, 1);
  assert.equal(row.port, 7431);
  assert.equal(row.ageSeconds, 30487);
  assert.equal(row.rssKb, 462180);

  // python3 / python 两种解释器名（本机两个孤儿就是这两个）都要认。
  const [py] = classifySidecars([entry({ argv: orphanArgv(7445).map((a, i) => (i === 0 ? '/root/.venvs/b123d/bin/python' : a)) })], baseOpts);
  assert.equal(py.verdict, 'killable');
  assert.equal(py.port, 7445);

  // --port=7431 形式。
  assert.equal(readPort(['python3', APP, '--port=7499']), 7499);

  // 凭据必须打码：cmdline 里不能出现 token 明文。
  assert.ok(!row.cmdline.includes(SECRET_TOKEN));
  assert.match(row.cmdline, /--token <redacted>/);
  assert.equal(formatCmdline(['py', '-x', '--token=A_B_C']), 'py -x --token=<redacted>');
});

// ---------------------------------------------------------------------------
// 2. 负向：repoRoot / 端口 / 解释器 不符 → 不是本仓 sidecar，不可回收
// ---------------------------------------------------------------------------
test('repoRoot、端口窗、解释器任一不符 → not-sidecar，计划里为空', () => {
  const rows = classifySidecars(
    [
      // 跨仓库同形：路径只差仓库名（前缀匹配会误伤，这里必须逐段相等）。
      entry({ pid: 11, argv: orphanArgv(7431).map((a) => a.replace(REPO, `${REPO}-2`)) }),
      // 端口越界：7399 / 7500 都在窗外。
      entry({ pid: 12, argv: orphanArgv(7399) }),
      entry({ pid: 13, argv: orphanArgv(7500) }),
      // 不是 python。
      entry({ pid: 14, argv: ['/usr/bin/node', APP, '--port', '7431'] }),
      // 完全没有 --port。
      entry({ pid: 15, argv: ['/root/.venvs/b123d/bin/python3', APP, '--token', SECRET_TOKEN] })
    ],
    baseOpts
  );

  assert.equal(rows.length, 5);
  for (const row of rows) {
    assert.equal(row.sidecar, false, `pid ${row.pid} 不该被认成本仓 sidecar`);
    assert.equal(row.verdict, 'not-sidecar');
  }
  assert.ok(rows[0].reasons.includes('app-path-mismatch'));
  assert.ok(rows[1].reasons.includes('port-out-of-window:7399'));
  assert.ok(rows[2].reasons.includes('port-out-of-window:7500'));
  assert.ok(rows[3].reasons.some((r) => r.startsWith('not-python')));
  assert.ok(rows[4].reasons.includes('port-missing'));

  assert.deepEqual(planKills(rows, { kill: true }), [], '不符判据的一律不许进回收计划');
  assert.equal(PORT_MIN, 7400);
  assert.equal(PORT_MAX, 7499);
});

// ---------------------------------------------------------------------------
// 3. 误杀防护：PPID≠1 / PID 1 / 自己 —— 是本仓 sidecar 也不杀
// ---------------------------------------------------------------------------
test('误杀防护：PPID≠1、PID 1、自身进程一律 refuse', () => {
  const rows = classifySidecars(
    [
      // 别人正在管的（父进程还活着）——最危险的一种：可能正是别人的长跑任务。
      entry({ pid: 21, ppid: 4242 }),
      entry({ pid: 1, ppid: 0 }),
      entry({ pid: 22, ppid: 1 })
    ],
    { ...baseOpts, selfPid: 22 }
  );

  assert.deepEqual(
    rows.map((r) => r.verdict),
    ['refused', 'refused', 'refused']
  );
  assert.ok(rows[0].reasons.includes('refuse:ppid-not-1:4242'));
  assert.ok(rows[1].reasons.includes('refuse:pid-1'));
  assert.ok(rows[2].reasons.includes('refuse:self'));
  assert.deepEqual(planKills(rows, { kill: true }), []);
});

// ---------------------------------------------------------------------------
// 4. --kill 三闸：年龄不足 → 计划为空 + killer 零调用
// ---------------------------------------------------------------------------
test('年龄不足（1h 阈值）→ orphan-too-young，不产生任何 kill 调用', async () => {
  const recorder = makeRecorder();
  const rows = classifySidecars([entry({ ageSeconds: 600, ppid: 1 })], baseOpts);
  assert.equal(rows[0].verdict, 'orphan-too-young');
  assert.ok(rows[0].reasons.includes(`refuse:age-below:600<${DEFAULT_MIN_AGE_SECONDS}`));

  const targets = planKills(rows, { kill: true });
  assert.deepEqual(targets, []);
  const results = await applyKills(targets, { killer: recorder.killer });
  assert.deepEqual(results, []);
  assert.deepEqual(recorder.calls, [], '条件不满足时必须一次 SIGTERM 都不发');

  // 年龄未知同样不给杀（读不到 starttime 不等于「很老」）。
  const [unknown] = classifySidecars([entry({ ageSeconds: null })], baseOpts);
  assert.equal(unknown.verdict, 'orphan-too-young');
  assert.ok(unknown.reasons.includes('refuse:age-unknown'));

  // 阈值可调：600 s > 300 s 时才是可回收的。
  const [lenient] = classifySidecars([entry({ ageSeconds: 600 })], { ...baseOpts, minAgeSeconds: 300 });
  assert.equal(lenient.verdict, 'killable');
});

// ---------------------------------------------------------------------------
// 5. dry-run 是默认行为：即使有可回收孤儿，也不发信号
// ---------------------------------------------------------------------------
test('默认 dry-run：可回收孤儿只列出，killer 零调用，退出码 0', async () => {
  const recorder = makeRecorder();
  // repoRoot 指到 fixture 仓库：这一行**确实**判为 killable，dry-run 依然不许动手。
  const code = await main(['--repo-root', REPO], { entries: [entry({})], killer: recorder.killer });
  assert.equal(code, 0);
  assert.deepEqual(recorder.calls, []);

  // --json 也不改行为（仍然是 dry-run）。
  const codeJson = await main(['--json', '--repo-root', REPO], { entries: [entry({})], killer: recorder.killer });
  assert.equal(codeJson, 0);
  assert.deepEqual(recorder.calls, []);
});

// ---------------------------------------------------------------------------
// 6. 用法错 → 退出码 2（不猜、不默默继续）
// ---------------------------------------------------------------------------
test('用法错误退出码 2：未知参数 / 非法阈值 / --kill 配错 repoRoot', async () => {
  assert.equal(await main(['--nope'], { entries: [] }), 2);
  assert.equal(await main(['--min-age-min', '-5'], { entries: [] }), 2);
  assert.equal(await main(['--min-age-min'], { entries: [] }), 2);
  // `--min-age-min 0` = 关掉年龄闸（三闸变两闸）→ 用法错，不许「默默宽松」
  assert.equal(await main(['--min-age-min', '0', '--json', '--repo-root', REPO], { entries: [] }), 2);
  assert.equal(await main(['--repo-root'], { entries: [] }), 2);
  // repoRoot 下没有 spike/build123d/app.py → --kill 报用法错（防止「端口窗内随便什么进程」被当成孤儿）。
  assert.equal(await main(['--kill', '--repo-root', '/tmp'], { entries: [entry({})] }), 2);
});

// ---------------------------------------------------------------------------
// 7. 正向 kill 通路：三闸全过时恰好发一次 SIGTERM（记录器注入，不碰真进程）
// ---------------------------------------------------------------------------
test('三闸全过 → 计划恰好一个目标，SIGTERM 一次并判为已退出', async () => {
  const fixture = buildProcFixture([
    { pid: 424242, ppid: 1, argv: orphanArgv(7487), startTicks: 1000, rssKb: 462180 }
  ]);
  const recorder = makeRecorder();
  const probed = [];
  // 「收到 SIGTERM 就退出」：把 fixture 的 /proc/<pid> 整个删掉（身份读不到 = 目标不在了）。
  const killer = (pid, signal) => {
    recorder.calls.push({ pid, signal });
    rmSync(join(fixture.procRoot, String(pid)), { recursive: true, force: true });
  };

  const code = await main(
    ['--kill', '--json', '--repo-root', REPO],
    {
      procRoot: fixture.procRoot,
      clkTck: 100,
      killer,
      sleep: async () => {},
      portProbe: async (port) => {
        probed.push(port);
        return true;
      }
    }
  );

  assert.equal(code, 0);
  // 一次性 SIGTERM：进程已退出 → 不升级 SIGKILL。
  assert.deepEqual(recorder.calls, [{ pid: 424242, signal: 'SIGTERM' }]);
  // 进程消失之后必须再验一次端口（「端口还被占着」才是孤儿那个 bug 的真实症状）。
  assert.deepEqual(probed, [7487]);
});

// ---------------------------------------------------------------------------
// 8. 进程没了但端口仍被占 → 判失败（退出码 1），不许报成功
// ---------------------------------------------------------------------------
test('端口未释放 → ok=false / port-still-listening / 退出码 1', async () => {
  const fixture = buildProcFixture([
    { pid: 434343, ppid: 1, argv: orphanArgv(7488), startTicks: 1000, rssKb: 1024 }
  ]);

  const code = await main(
    ['--kill', '--json', '--repo-root', REPO],
    {
      procRoot: fixture.procRoot,
      clkTck: 100,
      killer: (pid) => rmSync(join(fixture.procRoot, String(pid)), { recursive: true, force: true }),
      sleep: async () => {},
      portProbe: async () => false
    }
  );
  assert.equal(code, 1);
});

// ---------------------------------------------------------------------------
// 8b. C-3 pid 复用：身份（starttime）必须进 record，发信号前必须复验
// ---------------------------------------------------------------------------
test('身份进 record：scanProcesses 带 startTicks，classify → planKills 一路不丢', () => {
  const fixture = buildProcFixture([
    { pid: 424300, ppid: 1, argv: orphanArgv(7461), startTicks: 1000, rssKb: 2048 }
  ]);
  const [scanned] = scanProcesses({ procRoot: fixture.procRoot, clkTck: 100 });
  assert.equal(scanned.startTicks, 1000, 'scanProcesses 必须保留 starttime（原来只用来算 ageSeconds 就丢掉了）');
  assert.equal(scanned.ageSeconds, Math.round(40000 - 1000 / 100));

  const [row] = classifySidecars([scanned], baseOpts);
  assert.equal(row.startTicks, 1000, 'record 必须带身份，否则 applyKills 无从复验');
  assert.equal(row.verdict, 'killable');
  // 计划里也要带 —— 否则「识别时的一致」传不到发信号那一刻
  assert.deepEqual(planKills([row], { kill: true }), [{ pid: 424300, port: 7461, startTicks: 1000 }]);
});

test('对抗：发信号前 starttime 对不上（pid 已被复用）→ 一次信号都不发，判 refused', async () => {
  const recorder = makeRecorder();
  const results = await applyKills([{ pid: 515151, port: 7451, startTicks: 1000 }], {
    killer: recorder.killer,
    sleep: async () => {},
    // 识别时 1000，真到发信号时读到的却是 2000 = 别的进程
    readStartTicks: () => 2000,
    portProbe: async () => true
  });

  assert.deepEqual(recorder.calls, [], 'pid 已被复用：SIGTERM/SIGKILL 一次都不许发（这就是误杀窗口）');
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].refused, true);
  assert.match(results[0].error, /^refuse:pid-reused:2000!=1000/);
});

test('对抗：SIGTERM 后 pid 被复用 → 不升级 SIGKILL，按「目标已退出」报 ok', async () => {
  const calls = [];
  let reads = 0;
  const results = await applyKills([{ pid: 525252, port: 7452, startTicks: 1000 }], {
    killer: (pid, signal) => calls.push({ pid, signal }),
    sleep: async () => {},
    // 第 1 次 = 发信号前的身份闸（我们的人）；之后 = 已被别人接管的同一个 pid
    readStartTicks: () => (reads++ === 0 ? 1000 : 2000),
    portProbe: async () => true
  });

  assert.deepEqual(calls, [{ pid: 525252, signal: 'SIGTERM' }], 'pid 换人之后不许再发 SIGKILL');
  assert.deepEqual(results, [{ pid: 525252, ok: true, portFree: true }],
    'pid 换人 = 我们的目标已退出（不许报 still-alive 假阳性）');
});

test('身份未知 → 拒发信号；且正常链路上「读不到 starttime」根本进不了 killable', async () => {
  const recorder = makeRecorder();
  const results = await applyKills([{ pid: 535353, port: 7453 }], {
    killer: recorder.killer,
    sleep: async () => {},
    readStartTicks: () => 1000,
    portProbe: async () => true
  });
  assert.deepEqual(recorder.calls, []);
  assert.equal(results[0].refused, true);
  assert.match(results[0].error, /^refuse:identity-unknown/);

  // 真实链路：stat 读不到 → ageSeconds=null → orphan-too-young → 计划为空（fail-closed 自然成立）
  const [unknownAge] = classifySidecars([entry({ startTicks: null, ageSeconds: null })], baseOpts);
  assert.equal(unknownAge.verdict, 'orphan-too-young');
  assert.deepEqual(planKills([unknownAge], { kill: true }), []);
  // verifyIdentity 直接验一遍判据形状
  assert.deepEqual(verifyIdentity({ pid: 1, startTicks: 7 }, () => 7), { ok: true, startTicks: 7 });
  assert.equal(verifyIdentity({ pid: 1, startTicks: 7 }, () => null).reason, 'gone-before-signal');
  assert.equal(verifyIdentity({ pid: 1, startTicks: 7 }, () => 8).reason, 'refuse:pid-reused:8!=7');
  assert.equal(verifyIdentity({ pid: 1, startTicks: null }, () => 7).reason, 'refuse:identity-unknown');
});

// ---------------------------------------------------------------------------
// 8c. C-4 打包态形态：resources/parametric/app.py（与 parametric.ts:307-320 同一份解析规则）
// ---------------------------------------------------------------------------
const PACKAGED = '/opt/AutomationCAD/resources/parametric/app.py';
const packagedArgv = (port, app = PACKAGED) => [
  '/opt/AutomationCAD/resources/parametric/python',
  app,
  '--port',
  String(port),
  '--token=auth-token-fixture'
];

test('打包态 app.py 必须认出来（发行包孤儿才是最常见的那种），开发态形态不回归', () => {
  const packagedMatch = matchSidecar(packagedArgv(7431), baseOpts);
  assert.equal(packagedMatch.sidecar, true, `打包态 app.py 必须认：${packagedMatch.reasons.join(' ')}`);
  assert.equal(packagedMatch.match, 'packaged');
  assert.equal(packagedMatch.port, 7431);

  // macOS 的 resources 目录名是大写 Resources（同一份 resolveScript 规则：join(resourcesPath,'parametric','app.py')）
  assert.equal(
    matchSidecar(['python3', '/Applications/AutomationCAD.app/Contents/Resources/parametric/app.py', '--port=7499', '--token=x'], baseOpts).match,
    'packaged'
  );
  // 开发态（<repoRoot>/spike/build123d/app.py）继续逐段相等匹配
  assert.equal(matchSidecar(orphanArgv(7431), baseOpts).match, 'dev');

  // 反例：三段结构不对 / 文件名不对 / ≠ 我们的副本
  for (const bad of [
    '/opt/AutomationCAD/resources/spike/build123d/app.py',
    '/opt/AutomationCAD/parametric/app.py',
    '/opt/AutomationCAD/resources/parametric/app.py.bak',
    '/opt/AutomationCAD/resources/parametric/other.py'
  ]) {
    assert.equal(matchSidecar(['python3', bad, '--port', '7431', '--token=x'], baseOpts).sidecar, false,
      `${bad} 不许认成本仓 sidecar`);
  }
  // 反例：没有 --token 协议旗标（手工起的 kernel，不是我们 launch 的；也不带 auth 协议）
  assert.equal(matchSidecar(['python3', PACKAGED, '--port', '7431'], baseOpts).sidecar, false,
    '打包态形态必须同时带 --token 协议旗标（parametric.ts 的 launch 一定带）');

  // 显式 pin：只认这一份 resources；别处的同形路径一律不认（fail-closed）
  const pinnedOpts = { repoRoot: REPO, resourcesRoot: '/opt/AutomationCAD/resources' };
  assert.equal(matchSidecar(packagedArgv(7432), pinnedOpts).match, 'packaged-pinned');
  assert.equal(
    matchSidecar(['python3', '/opt/Other/resources/parametric/app.py', '--port', '7432', '--token=x'], pinnedOpts).sidecar,
    false,
    '给了 --resources-root 之后，别的安装目录不许再按后缀蒙进来'
  );
});

test('打包态孤儿走完三闸：PPID=1 + 年龄够 → killable，凭据打码', () => {
  const [row] = classifySidecars([
    entry({ pid: 2040777, argv: packagedArgv(7444), startTicks: 5000, ageSeconds: 7200 })
  ], baseOpts);
  assert.equal(row.sidecar, true);
  assert.equal(row.match, 'packaged');
  assert.equal(row.verdict, 'killable');
  assert.equal(row.port, 7444);
  assert.ok(!row.cmdline.includes('auth-token-fixture'), '打包态 cmdline 也必须打码');
  assert.deepEqual(planKills([row], { kill: true }), [{ pid: 2040777, port: 7444, startTicks: 5000 }]);
});

test('--resources-root：发行包机器上没有 dev app.py 也能 --kill（repoRoot 校验认两种形态）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sidecar-doctor-res-'));
  mkdirSync(join(root, 'parametric'));
  const app = join(root, 'parametric', 'app.py');
  writeFileSync(app, '# fixture: 打包态副本，不执行\n');
  const fixture = buildProcFixture([
    { pid: 545454, ppid: 1, argv: packagedArgv(7455, app), startTicks: 1000, rssKb: 1024 }
  ]);

  const code = await main(
    ['--kill', '--json', '--repo-root', '/tmp', '--resources-root', root],
    {
      procRoot: fixture.procRoot,
      clkTck: 100,
      killer: (pid) => rmSync(join(fixture.procRoot, String(pid)), { recursive: true, force: true }),
      sleep: async () => {},
      portProbe: async () => true
    }
  );
  assert.equal(code, 0, '--resources-root 合法时 repoRoot 缺 dev app.py 不该退 2');
});

function buildProcFixture(procs) {
  const procRoot = mkdtempSync(join(tmpdir(), 'sidecar-doctor-proc-'));
  // uptime 设成「比所有 starttime 都大」，使 age = uptime - startTicks/HZ 可控。
  writeFileSync(join(procRoot, 'uptime'), '40000.00 1.00\n');

  for (const proc of procs) {
    const dir = join(procRoot, String(proc.pid));
    mkdirSync(dir);
    writeFileSync(join(dir, 'cmdline'), `${proc.argv.join('\0')}\0`);
    writeFileSync(join(dir, 'status'), `Name:\tpython3\nPPid:\t${proc.ppid}\nVmRSS:\t  ${proc.rssKb} kB\n`);
    // /proc/<pid>/stat：comm 带括号，'(' 之后从**字段 3** 起。
    // 解析侧按「最后一个 ')' 之后」切，所以 tail[0]=字段3(state)、tail[1]=字段4(ppid)、
    // tail[19]=字段22(starttime)。这里按同一口径造。
    const tailFields = Array.from({ length: 46 }, () => '0');
    tailFields[0] = 'S'; // 字段 3 state
    tailFields[1] = String(proc.ppid); // 字段 4 ppid
    tailFields[19] = String(proc.startTicks); // 字段 22 starttime（clock ticks）
    writeFileSync(join(dir, 'stat'), `${proc.pid} (python3) ${tailFields.join(' ')}\n`);
  }

  return { procRoot };
}
