import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import {
  ParametricManager,
  resolvePython,
  resolveScript,
  type ParametricManagerOptions
} from '../electron/parametric.ts';

const FAKE = fileURLToPath(new URL('../scripts/fake-parametric-sidecar.mjs', import.meta.url));
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), '..');
const managers: ParametricManager[] = [];

function manager(options: ParametricManagerOptions = {}): ParametricManager {
  const instance = new ParametricManager({
    command: FAKE,
    healthTimeoutMs: 3_000,
    healthIntervalMs: 50,
    ...options
  });
  managers.push(instance);
  return instance;
}

function childPid(instance: ParametricManager): number | null {
  const proc = (instance as unknown as { proc?: { pid?: number } | null }).proc;
  return proc?.pid ?? null;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error('等待条件超时');
}

function validDoc() {
  return {
    schemaVersion: 1 as const,
    updatedAt: '2026-10-23T12:00:00+08:00',
    features: [
      { id: 'f1', type: 'box' as const, name: '底板', params: { length: 120, width: 80, height: 8 } },
      {
        id: 'f2',
        type: 'holes' as const,
        name: '安装孔',
        params: { diameter: 6, positions: [[-44, -24], [44, -24], [-44, 24], [44, 24]] }
      }
    ]
  };
}

function validAssembly() {
  return {
    schemaVersion: 2 as const,
    updatedAt: '2026-10-23T12:00:00+08:00',
    instances: [
      {
        id: 'p1',
        name: '底板',
        partId: 'BASE-01',
        transform: { x: 0, y: 0, z: 0, rz: 0 },
        features: [
          { id: 'f1', type: 'box' as const, name: '底板', params: { length: 120, width: 80, height: 8 } }
        ]
      },
      {
        id: 'p2',
        name: '顶板',
        transform: { x: 130, y: 0, z: 0, rz: 90 },
        features: [
          { id: 'f1', type: 'box' as const, name: '顶板', params: { length: 60, width: 40, height: 6 } }
        ]
      }
    ]
  };
}

after(async () => {
  await Promise.all(managers.map((instance) => instance.stop().catch(() => undefined)));
});

test('sidecar：解析 Python 与开发态脚本路径', () => {
  assert.equal(resolvePython({ AUTOMATIONCAD_PYTHON: process.execPath }), process.execPath);
  // Windows 上 resolve 返回反斜杠，断言两种分隔符都接受。
  assert.match(resolveScript({ appRoot: REPO_ROOT }) ?? '', /spike[\\/]build123d[\\/]app\.py$/);
});

test('sidecar：启动到 ready，状态不泄露 token 与端口', async () => {
  const instance = manager();
  const info = await instance.start();
  assert.equal(info.ok, true);
  assert.equal(info.status, 'ready');
  assert.equal(info.version, '0.0.0-fake');
  assert.ok(info.port && info.port >= 7430 && info.port <= 7449);
  assert.ok(info.token && info.token.length >= 20);
  assert.equal(instance.status().status, 'ready');
  assert.match(instance.status().message, /就绪/);
  assert.equal('token' in instance.status(), false);
  assert.equal('port' in instance.status(), false);
  await instance.stop();
  assert.equal(instance.status().status, 'stopped');
});

test('sidecar：错误 token 的 /build 返回 401', async () => {
  const instance = manager();
  const info = await instance.start();
  if (!info.port || !info.token) throw new Error('sidecar 未返回端口或 token');
  const response = await fetch(`http://127.0.0.1:${info.port}/build`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer wrong-token',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ ops: [{ op: 'box', length: 1, width: 1, height: 1 }] })
  });
  assert.equal(response.status, 401);
  await instance.stop();
});

test('sidecar：build 返回 stats、buildMs 与文件', async () => {
  const instance = manager();
  await instance.start();
  const result = await instance.build(validDoc());
  assert.equal(result.ok, true, result.message);
  assert.equal(result.buildMs, 12);
  assert.equal(result.stats?.faces, 19);
  assert.equal(result.stats?.volumeMm3, 71495.7);
  assert.ok(result.files?.step);
  assert.ok(result.files?.stl);
  await instance.stop();
});

test('sidecar：装配 build 发送 instances 并返回 solids 与每实体体积', async () => {
  const instance = manager();
  await instance.start();
  const result = await instance.build(validAssembly());
  assert.equal(result.ok, true, result.message);
  assert.equal(result.stats?.solids, 2);
  assert.equal(Array.isArray(result.stats?.instances), true);
  assert.equal((result.stats?.instances as unknown[]).length, 2);
  await instance.stop();
});

test('sidecar：装配重复实体 id 在本地拦截', async () => {
  const instance = manager();
  await instance.start();
  const doc = validAssembly();
  doc.instances[1]!.id = 'p1';
  const result = await instance.build(doc);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BUILD_FAILED');
  assert.match(result.message ?? '', /重复/);
  await instance.stop();
});

test('sidecar：装配 transform 非数字在本地拦截', async () => {
  const instance = manager();
  await instance.start();
  const doc = validAssembly();
  (doc.instances[0]!.transform as Record<string, unknown>).x = '0';
  const result = await instance.build(doc);
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /transform/);
  await instance.stop();
});

test('sidecar：非法特征树在本地拦截并返回中文错误', async () => {
  const instance = manager();
  await instance.start();
  const result = await instance.build({
    schemaVersion: 1,
    updatedAt: '2026-10-23T12:00:00+08:00',
    features: []
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BUILD_FAILED');
  assert.match(result.message ?? '', /特征树校验失败/);
  await instance.stop();
});

test('sidecar：未启动时 build 返回 UNAVAILABLE', async () => {
  const instance = manager();
  const result = await instance.build(validDoc());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNAVAILABLE');
  assert.match(result.message ?? '', /不可用/);
});

test('sidecar：参数化模块关闭时直接 start/build 均拒绝，sidecar 不运行且无文件落盘', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cad-parametric-module-gate-'));
  const marker = join(root, 'sidecar-was-started.txt');
  const command = `${process.execPath} -e "require('node:fs').writeFileSync('${marker}', 'started')"`;
  const instance = manager({ command, isEnabled: () => false });

  const started = await instance.start();
  const built = await instance.build(validDoc());

  assert.equal(started.ok, false);
  assert.equal(started.code, 'MODULE_DISABLED');
  assert.equal(built.ok, false);
  assert.equal(built.code, 'MODULE_DISABLED');
  assert.equal(instance.status().status, 'stopped');
  assert.equal(childPid(instance), null);
  assert.equal(existsSync(marker), false, '关闭时不启动副进程，也不产生其副作用文件');
  await instance.stop();
  rmSync(root, { recursive: true, force: true });
});

test('sidecar：显式 Python 路径不存在时 start 返回 unavailable', async () => {
  const instance = manager({
    command: undefined,
    env: { ...process.env, AUTOMATIONCAD_PYTHON: '/definitely/not/python' }
  });
  const info = await instance.start();
  assert.equal(info.ok, false);
  assert.equal(info.status, 'unavailable');
  assert.equal(instance.status().status, 'unavailable');
  assert.match(instance.status().message, /不可用/);
});

test('sidecar：空闲超时后自动 stop', async () => {
  const instance = manager({ idleMs: 200 });
  await instance.start();
  const pid = childPid(instance);
  assert.ok(pid);
  await waitFor(() => instance.status().status === 'stopped', 3_000);
  assert.equal(childPid(instance), null);
  let alive = true;
  try {
    process.kill(pid!, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false);
});

test('sidecar：ready 后崩溃自动重启一次，再次崩溃置 crashed', async () => {
  const instance = manager({ idleMs: 0 });
  const first = await instance.start();
  assert.equal(first.ok, true);
  const firstPid = childPid(instance);
  assert.ok(firstPid);

  process.kill(firstPid!, 'SIGKILL');
  await waitFor(() => instance.status().status === 'ready' && childPid(instance) !== firstPid, 6_000);
  const secondPid = childPid(instance);
  assert.ok(secondPid && secondPid !== firstPid);

  process.kill(secondPid!, 'SIGKILL');
  await waitFor(() => instance.status().status === 'crashed', 6_000);
  assert.match(instance.status().message, /崩溃/);
  assert.equal(childPid(instance), null);
});

test('sidecar：stop 杀掉进程并回到 stopped', async () => {
  const instance = manager({ idleMs: 0 });
  await instance.start();
  const pid = childPid(instance);
  assert.ok(pid);
  await instance.stop();
  assert.equal(instance.status().status, 'stopped');
  let alive = true;
  try {
    process.kill(pid!, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false);
});

test('sidecar：启动途中 stop 保持 stopped，不被启动结果覆盖', async () => {
  const instance = manager({ healthTimeoutMs: 2_000 });
  const pending = instance.start();
  await instance.stop();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.status, 'stopped');
  assert.equal(instance.status().status, 'stopped');
});

// ---------------------------------------------------------------------------
// 对抗回归：启动期早退的真实定性（CI 里报「健康检查在 3 秒内未通过」其实是
// 子进程 100 ms 内自己 exit 了；stderr 被 /dev/null 掉，真因永远看不到）
// ---------------------------------------------------------------------------

/** 以 `-` 开头的 token：argparse 会把 `--token -abc` 的 `-abc` 当成选项，exit 2。 */
const DASH_TOKEN = '-SyntheticProbeSidecarToken_not_a_real_secret_0001';
/** 故意含易误报的字符组合，用来验证脱敏不靠「猜」。 */
const LEAK_TOKEN = '-SyntheticLeakProbe_not_a_real_secret_abcdefghijklmnop';

function readArgvLog(path: string): Array<{ args: string[]; pid: number }> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { args: string[]; pid: number });
}

/** 任一 8 字符窗口出现即算泄露（分片/截断后残留的片段一定有 ≥8 字符窗口）。 */
function tokenFragments(token: string): string[] {
  const windows: string[] = [];
  for (let index = 0; index + 8 <= token.length; index += 1) windows.push(token.slice(index, index + 8));
  return windows;
}

function assertNoTokenLeak(text: string, token: string, label: string): void {
  assert.equal(text.includes(token), false, `${label} 出现完整 token`);
  for (const window of tokenFragments(token)) {
    assert.equal(text.includes(window), false, `${label} 出现 token 片段 ${window}`);
  }
}

test('sidecar：token 以 - 开头时用 --token=value 传递，argparse 不会早退', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cad-parametric-dash-token-'));
  const argvLog = join(root, 'argv.jsonl');
  const instance = manager({
    idleMs: 0,
    tokenFactory: () => DASH_TOKEN,
    env: { ...process.env, FAKE_SIDECAR_ARGV_DUMP: argvLog }
  });
  const info = await instance.start();
  assert.equal(info.ok, true, info.message);
  assert.equal(info.status, 'ready');
  assert.equal(info.token, DASH_TOKEN);
  // 熵不变：注入只替换随机源，不缩短长度
  assert.equal(info.token?.length, DASH_TOKEN.length);

  const spawns = readArgvLog(argvLog);
  assert.equal(spawns.length, 1);
  const args = spawns[0]!.args;
  assert.deepEqual(args.filter((arg) => arg.startsWith('--token')), [`--token=${DASH_TOKEN}`]);
  assert.equal(args.includes(DASH_TOKEN), false, '不能把 - 开头的值单独作为 argv 元素');

  // 真的连得上：同一 token 授权 /build 必须通过（证明 token 没被 argv 形状破坏）
  const built = await instance.build(validDoc());
  assert.equal(built.ok, true, built.message);
  await instance.stop();
  rmSync(root, { recursive: true, force: true });
});

test('sidecar：启动期 exit 2 定性为子进程已退出，不伪装成健康检查超时', async () => {
  const instance = manager({
    idleMs: 0,
    healthTimeoutMs: 3_000,
    env: { ...process.env, FAKE_SIDECAR_EXIT_CODE: '2' }
  });
  const wallStart = Date.now();
  const info = await instance.start();
  const wall = Date.now() - wallStart;

  assert.equal(info.ok, false);
  assert.equal(info.status, 'unavailable');
  assert.equal(info.code, 'PROCESS_EXITED');
  assert.equal(info.exitCode, 2);
  assert.ok(typeof info.elapsedMs === 'number', '必须上报实测耗时');
  assert.ok(info.elapsedMs! < 1_500, `实测 ${info.elapsedMs} ms，早退不该等满预算`);
  assert.ok(wall < 3_000);
  assert.match(info.message, /已退出/);
  assert.match(info.message, /code=2/);
  assert.doesNotMatch(info.message, /超时/);
  assert.doesNotMatch(info.message, /3 秒/);
  // 不读原文也能定位：argparse 分类 + 脱敏后的 stderr 尾
  assert.equal(info.stderrClass, 'argparse');
  assert.match(info.stderrTail ?? '', /expected one argument/);
  assert.equal(instance.status().status, 'unavailable');
  assert.match(instance.status().message, /已退出/);
});

test('sidecar：健康检查超时的文案用 healthTimeoutMs 实值，而不是写死 3 秒', async () => {
  const instance = manager({
    idleMs: 0,
    healthTimeoutMs: 600,
    healthIntervalMs: 100,
    // 只挂着不监听端口：既不 ready，也不退出 —— 唯一能走「真超时」的形态
    env: { ...process.env, FAKE_SIDECAR_HANG_MS: '5000' }
  });
  const info = await instance.start();
  assert.equal(info.ok, false);
  assert.equal(info.code, 'HEALTH_TIMEOUT');
  assert.match(info.message, /600 ms/);
  assert.match(info.message, /健康检查在 1 秒/);
  assert.doesNotMatch(info.message, /3 秒/);
  assert.ok((info.elapsedMs ?? 0) >= 500, `实测 ${info.elapsedMs} ms`);
  await instance.stop();
});

test('sidecar：启动期退出不抢跑自动重启，只 spawn 一次且状态不被重启覆盖', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cad-parametric-early-exit-'));
  const argvLog = join(root, 'argv.jsonl');
  const instance = manager({
    idleMs: 0,
    healthTimeoutMs: 3_000,
    env: { ...process.env, FAKE_SIDECAR_EXIT_CODE: '2', FAKE_SIDECAR_ARGV_DUMP: argvLog }
  });
  const info = await instance.start();
  assert.equal(info.ok, false);
  assert.equal(info.code, 'PROCESS_EXITED');

  // 旧实现会在这里立刻发起第二次 launch 并把结论盖成 crashed
  await new Promise((done) => setTimeout(done, 400));
  assert.equal(readArgvLog(argvLog).length, 1, '启动期失败不得自动重启');
  assert.equal(instance.status().status, 'unavailable');
  assert.match(instance.status().message, /已退出/);
  assert.doesNotMatch(instance.status().message, /自动重启/);
  assert.equal(instance.status().status === 'crashed', false);
  rmSync(root, { recursive: true, force: true });
});

test('sidecar：stderr 分片出现的本次 token 必须脱敏，不进结果', async () => {
  const instance = manager({
    idleMs: 0,
    healthTimeoutMs: 3_000,
    tokenFactory: () => LEAK_TOKEN,
    env: { ...process.env, FAKE_SIDECAR_EXIT_CODE: '2', FAKE_SIDECAR_ECHO_TOKEN: '1' }
  });
  const info = await instance.start();
  assert.equal(info.ok, false);
  const tail = info.stderrTail ?? '';
  assert.ok(tail.length > 0, '必须留下 stderr 证据，否则真因依旧不可见');
  assert.match(tail, /\[REDACTED\]/);
  // 证据仍然有诊断价值
  assert.match(tail, /expected one argument/);
  assertNoTokenLeak(tail, LEAK_TOKEN, 'stderrTail');
  assertNoTokenLeak(info.message, LEAK_TOKEN, 'message');
  assertNoTokenLeak(instance.status().message, LEAK_TOKEN, 'status.message');
});

test('sidecar：stderr 超过 4 KB 只留尾部，且尾部仍按本次 token 脱敏', async () => {
  const filler = `${'x'.repeat(6_000)}Traceback (most recent call last):`;
  const instance = manager({
    idleMs: 0,
    healthTimeoutMs: 3_000,
    tokenFactory: () => LEAK_TOKEN,
    env: {
      ...process.env,
      FAKE_SIDECAR_EXIT_CODE: '2',
      FAKE_SIDECAR_ECHO_TOKEN: '1',
      FAKE_SIDECAR_STDERR: filler
    }
  });
  const info = await instance.start();
  assert.equal(info.ok, false);
  const tail = info.stderrTail ?? '';
  assert.ok(tail.length <= 4_096 + 64, `尾部缓存不得超过 4 KB，实测 ${tail.length}`);
  assert.match(tail, /\[REDACTED\]/);
  assertNoTokenLeak(tail, LEAK_TOKEN, '4KB stderrTail');
  assert.equal(info.stderrClass, 'traceback');
});

// ---------------------------------------------------------------------------
// 回归：stop() 之后立刻 start() 造成两次 launch 重叠时，旧 launch 的收尾不得清掉
// 新 launch 的启动期标记。旧实现里这个标记是单布尔，旧 launch 的 finally 无条件
// 置 false，于是新 launch 的早退被当成「运行期崩溃」：多 spawn 一次、烧掉唯一一次
// 自动重启、终态从 unavailable 升级成 crashed，且 start() 的返回值与 status() 互相矛盾。
// ---------------------------------------------------------------------------

test('sidecar：stop 后立刻重启时，旧 launch 的收尾不得清掉新 launch 的启动期标记', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cad-parametric-overlap-launch-'));
  const countFile = join(root, 'spawn-count.txt');
  const wrapper = join(root, 'overlap-sidecar.mjs');
  // 第 1 次 spawn：启动期挂起（永不监听端口），让 launch#1 停在健康轮询里；
  // 第 2 次及以后：等 400 ms（明显晚于 launch#1 的收尾）再按 argparse 形状 exit 2。
  writeFileSync(
    wrapper,
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      'const countFile = process.env.OVERLAP_SPAWN_COUNT;',
      'let n = 0;',
      "try { n = Number(readFileSync(countFile, 'utf8')) || 0; } catch {}",
      'n += 1;',
      'writeFileSync(countFile, String(n));',
      'if (n === 1) await new Promise((done) => setTimeout(done, 5000));',
      'await new Promise((done) => setTimeout(done, 400));',
      "process.stderr.write('usage: app.py: error: expected one argument\\n');",
      'process.exit(2);',
      ''
    ].join('\n'),
    'utf8'
  );
  const instance = manager({
    command: `${process.execPath} ${wrapper}`,
    idleMs: 0,
    healthTimeoutMs: 5_000,
    healthIntervalMs: 50,
    env: { ...process.env, OVERLAP_SPAWN_COUNT: countFile }
  });

  const first = instance.start();
  await waitFor(() => existsSync(countFile) && Number(readFileSync(countFile, 'utf8')) === 1, 5_000);
  // 真正的重叠窗口：stop() 返回时 launch#1 还卡在 waitHealthy 的 delay 里
  await instance.stop();
  const second = instance.start();

  const info = await second;
  const firstInfo = await first;
  // 再留一段时间：旧 launch 的 finally 正是在这里有机会把新 launch 的标记清掉
  await new Promise((done) => setTimeout(done, 400));

  assert.equal(firstInfo.status, 'stopped');
  assert.equal(Number(readFileSync(countFile, 'utf8')), 2, '重叠窗口只允许 2 次 spawn，不得烧掉自动重启');
  assert.equal(info.ok, false);
  assert.equal(info.status, 'unavailable');
  assert.equal(info.code, 'PROCESS_EXITED');
  assert.equal(info.exitCode, 2);
  assert.equal(info.stderrClass, 'argparse');
  assert.match(info.message, /已退出/);
  assert.doesNotMatch(info.message, /崩溃/);
  // result 与终态必须一致（旧实现：result=unavailable，status=crashed）
  assert.equal(instance.status().status, info.status);
  assert.equal(instance.status().status, 'unavailable');
  assert.match(instance.status().message, /已退出/);
  rmSync(root, { recursive: true, force: true });
});
