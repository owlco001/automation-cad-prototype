import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { spawn } from 'node:child_process';
import { loadMachineLinkage, loadPlcAudit, runMachineCli } from '../../electron/machine-linkage.ts';

const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function fixture({ packaged = false, source = false, script = 'console.log(JSON.stringify({ok:true}))' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'machine-linkage-'));
  dirs.push(root);
  const resourcesPath = join(root, 'resources');
  const appRoot = packaged ? join(resourcesPath, 'app.asar') : root;
  const pipeline = source
    ? join(appRoot, 'scripts', 'machine-design-cli.mjs')
    : join(packaged ? resourcesPath : join(root, 'vendor'), 'pipeline', 'machine-design-cli.cjs');
  mkdirSync(dirname(pipeline), { recursive: true });
  writeFileSync(pipeline, script);
  return { appRoot, resourcesPath, isPackaged: packaged, pipeline, root };
}

function runOptions(paths, extra = {}) {
  return { ...paths, brief: '六工位 machine', args: [], electronExePath: process.execPath, ...extra };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 42;
  child.exitCode = null;
  child.signalCode = null;
  child.kills = [];
  child.kill = (signal) => { child.kills.push(signal); return true; };
  return child;
}

function track(promise) {
  const state = { settled: false };
  state.result = promise.then(
    (value) => { state.settled = true; return { value }; },
    (error) => { state.settled = true; return { error }; }
  );
  return state;
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('packaged CLI runs the bundled CJS with a real cwd, intact arguments and Electron node mode', async () => {
  const paths = fixture({ packaged: true, script: `console.log(JSON.stringify({
    args:process.argv.slice(2), cwd:process.cwd(), runAsNode:process.env.ELECTRON_RUN_AS_NODE
  }))` });
  const result = await runMachineCli(runOptions(paths, { args: ['--linkage', '--linkage-frames', '17'] }));
  assert.deepEqual(result.args, ['--brief', '六工位 machine', '--with-geometry', '--linkage', '--linkage-frames', '17']);
  assert.equal(result.cwd, dirname(paths.pipeline));
  assert.equal(result.runAsNode, '1');
});

test('dev prefers the shared vendor bundle, with source fallback for existing development callers', async () => {
  const bundle = fixture();
  mkdirSync(join(bundle.appRoot, 'scripts'));
  writeFileSync(join(bundle.appRoot, 'scripts', 'machine-design-cli.mjs'), 'throw Error("source must not run")');
  assert.deepEqual(await runMachineCli(runOptions(bundle)), { ok: true });
  const source = fixture({ source: true });
  assert.deepEqual(await runMachineCli(runOptions(source)), { ok: true });
});

test('packaged mode never falls back to a source checkout or dev vendor bundle', async () => {
  const paths = fixture({ source: true });
  let spawned = false;
  await assert.rejects(runMachineCli(runOptions(paths, {
    isPackaged: true,
    spawnImpl: () => { spawned = true; throw Error('unexpected spawn'); }
  })), /找不到整机管线脚本.*pipeline/);
  assert.equal(spawned, false);
  await assert.rejects(runMachineCli(runOptions(paths, { isPackaged: true, resourcesPath: undefined })), /缺少 resourcesPath/);
});

test('wrapper options reach the packaged resolver; existing positional calls and default frames still work', async () => {
  const script = `const args=process.argv.slice(2); console.log(JSON.stringify({
    linkage:{frames:args[args.indexOf('--linkage-frames')+1], motion:args.includes('--motion-check')},
    plcAudit:{enabled:args.includes('--plc-audit')}
  }))`;
  const packaged = fixture({ packaged: true, script });
  const options = { isPackaged: true, resourcesPath: packaged.resourcesPath, electronExePath: process.execPath };
  assert.deepEqual(await loadMachineLinkage(packaged.appRoot, 'brief', 17, options), { frames: '17', motion: true });
  assert.deepEqual(await loadPlcAudit(packaged.appRoot, 'brief', options), { enabled: true });
  const source = fixture({ source: true, script });
  assert.deepEqual(await loadMachineLinkage(source.appRoot, 'brief'), { frames: '120', motion: true });
  assert.deepEqual(await loadPlcAudit(source.appRoot, 'brief'), { enabled: true });
});

test('wrappers reject missing fields instead of returning undefined', async () => {
  const paths = fixture();
  await assert.rejects(loadMachineLinkage(paths.appRoot, 'brief'), /没有返回 linkage/);
  await assert.rejects(loadPlcAudit(paths.appRoot, 'brief'), /没有返回 plcAudit/);
});

test('valid JSON survives UTF-8 characters split across stdout chunks', async () => {
  const child = fakeChild();
  const pending = runMachineCli(runOptions(fixture(), { spawnImpl: () => child }));
  const bytes = Buffer.from('{"name":"机械"}');
  for (const byte of bytes) child.stdout.emit('data', Buffer.from([byte]));
  child.emit('close', 0, null);
  assert.deepEqual(await pending, { name: '机械' });
});

test('nonzero exit, signal termination, and invalid JSON have actionable errors', async () => {
  await assert.rejects(runMachineCli(runOptions(fixture({ script: 'process.stderr.write("cli diagnostic"); process.exitCode=7' }))), /exit 7.*cli diagnostic/);
  await assert.rejects(runMachineCli(runOptions(fixture({ script: 'console.log("not JSON")' }))), /输出不是 JSON/);
  const child = fakeChild();
  const pending = runMachineCli(runOptions(fixture(), { spawnImpl: () => child }));
  child.emit('close', null, 'SIGTERM');
  await assert.rejects(pending, /exit null, signal SIGTERM/);
});

test('timeout reports the configured duration, kills once, and waits for close despite racing errors', async () => {
  const child = fakeChild();
  let killed;
  const killedPromise = new Promise((resolve) => { killed = resolve; });
  child.kill = (signal) => { child.kills.push(signal); killed(); return true; };
  const state = track(runMachineCli(runOptions(fixture(), { spawnImpl: () => child, timeoutMs: 15 })));
  await killedPromise;
  await nextTurn();
  assert.equal(state.settled, false, 'kill request is not process cleanup');
  child.emit('error', new Error('late kill race'));
  assert.deepEqual(child.kills, ['SIGKILL']);
  child.emit('close', null, 'SIGKILL');
  child.emit('close', 0, null);
  assert.match((await state.result).error.message, /超时（15 ms）/);
});

for (const stream of ['stdout', 'stderr']) {
  test(`${stream} byte limit kills the child and rejects only after close`, async () => {
    const child = fakeChild();
    const state = track(runMachineCli(runOptions(fixture(), {
      spawnImpl: () => child, maxStdoutBytes: 4, maxStderrBytes: 4
    })));
    child[stream].emit('data', Buffer.from('机械')); // 6 UTF-8 bytes, two JS characters
    child[stream].emit('data', Buffer.alloc(100));
    await nextTurn();
    assert.equal(state.settled, false);
    assert.deepEqual(child.kills, ['SIGKILL']);
    child.emit('close', null, 'SIGKILL');
    assert.match((await state.result).error.message, new RegExp(`${stream}.*4 bytes`));
  });
}

test('stdout exactly at its limit succeeds', async () => {
  const child = fakeChild();
  const pending = runMachineCli(runOptions(fixture(), { spawnImpl: () => child, maxStdoutBytes: 2 }));
  child.stdout.emit('data', Buffer.from('{}'));
  child.emit('close', 0, null);
  assert.deepEqual(await pending, {});
});

test('spawn errors preserve their cause and await close; synchronous spawn throws reject too', async () => {
  const child = fakeChild();
  child.pid = undefined;
  const state = track(runMachineCli(runOptions(fixture(), { spawnImpl: () => child })));
  const failure = new Error('ENOENT injected executable');
  child.emit('error', failure);
  await nextTurn();
  assert.equal(state.settled, false);
  assert.deepEqual(child.kills, []);
  child.emit('close', -2, null);
  assert.equal((await state.result).error, failure);
  await assert.rejects(runMachineCli(runOptions(fixture(), { spawnImpl: () => { throw failure; } })), /ENOENT/);
});

test('real timed-out child has emitted close before rejection is observed', async () => {
  const paths = fixture({ script: 'setInterval(() => {}, 1000)' });
  let closed = false;
  let child;
  try {
    await assert.rejects(runMachineCli(runOptions(paths, {
      timeoutMs: 100,
      spawnImpl: (...args) => {
        child = spawn(...args);
        child.once('close', () => { closed = true; });
        return child;
      }
    })), /超时（100 ms）/);
    assert.equal(closed, true);
    assert.equal(child.signalCode, 'SIGKILL');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('invalid timeout and output budgets fail before spawning', async () => {
  const paths = fixture();
  for (const extra of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 2_147_483_648 }, { maxStdoutBytes: -1 }, { maxStderrBytes: NaN }]) {
    await assert.rejects(runMachineCli(runOptions(paths, {
      ...extra,
      spawnImpl: () => { assert.fail('must validate before spawn'); }
    })), /有效正整数/);
  }
});
