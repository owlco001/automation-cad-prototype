import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
