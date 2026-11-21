import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/machine-e2e.mjs', import.meta.url));
const shot = '23-pv-04-transfer-3d.png';

function runMaterialGate(outputDir) {
  return spawnSync(process.execPath, [script, '--transfer-material-only'], {
    env: { ...process.env, AUTOMATIONCAD_SCREENSHOT_DIR: outputDir },
    encoding: 'utf8',
    timeout: 10_000
  });
}

function assertRefused(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /--transfer-material-only 要求 AUTOMATIONCAD_SCREENSHOT_DIR/);
  assert.doesNotMatch(result.stdout, /MACHINE_E2E_USERDATA/);
}

test('material-only E2E cannot fall back to repository screenshots', () => {
  assertRefused(runMaterialGate(''));
});

test('material-only E2E refuses an existing transfer screenshot before launching Electron', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'transfer-material-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const oldShot = join(dir, shot);
  writeFileSync(oldShot, 'old screenshot');
  assertRefused(runMaterialGate(dir));
  assert.equal(readFileSync(oldShot, 'utf8'), 'old screenshot');
});

test('material E2E sidecar accepts the manager inline token without dropping auth', { timeout: 10_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'transfer-material-sidecar-'));
  const token = '-fake-token';
  const child = spawn(process.execPath, [script, '--parametric-stub', '--port', '0', `--token=${token}`], {
    env: { ...process.env, MACHINE_E2E_SIDECAR_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const closed = once(child, 'close');
  t.after(async () => {
    child.kill();
    await closed;
    rmSync(dir, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Stub startup timed out')), 5_000);
    let output = '';
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Stub exited before listening: ${code}`)));
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
      const end = output.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(output.slice(0, end)).port); } catch (error) { reject(error); }
    });
  });
  assert.ok(Number.isInteger(port) && port > 0);
  const post = (credential) => fetch(`http://127.0.0.1:${port}/build`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${credential}` },
    body: '{}',
    signal: AbortSignal.timeout(2000)
  });
  const denied = await post('wrong');
  assert.equal(denied.status, 401);
  await denied.json();
  const allowed = await post(token);
  assert.equal(allowed.status, 200);
  assert.match((await allowed.json()).error, /instances/);
});
