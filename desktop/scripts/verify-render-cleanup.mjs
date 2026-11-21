import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { spawnOwnedProcess, stopOwnedProcess, ownedProcessPids } from './lib/owned-process.mjs';

if (process.platform !== 'linux') throw new Error('This verification requires Linux /proc and Xvfb');
const desktop = fileURLToPath(new URL('../', import.meta.url));
const outputs = mkdtempSync(join(tmpdir(), 'automationcad-render-cleanup-'));
const scenarios = [
  { name: 'success', timeout: '60000', code: 0 },
  { name: 'cancel-after-build', timeout: '60000', code: 143, cancelAt: 'MACHINE_E2E_STEP_11_OK' },
  { name: 'launcher-crash-after-build', timeout: '60000', code: 1, cancelAt: 'MACHINE_E2E_STEP_11_OK', crashLauncher: true },
  { name: 'startup-timeout', timeout: '1', code: 1 }
];
for (const scenario of scenarios) {
  const shotDir = join(outputs, scenario.name);
  const child = spawnOwnedProcess(process.execPath, ['scripts/machine-e2e.mjs', '--transfer-material-only'], {
    cwd: desktop,
    env: { ...process.env, AUTOMATIONCAD_SCREENSHOT_DIR: shotDir, MACHINE_E2E_CLEAN: '1', MACHINE_E2E_TIMEOUT_MS: scenario.timeout },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '', cancelled = false, triggerError;
  const collect = chunk => {
    log += chunk.toString();
    if (scenario.cancelAt && !cancelled && log.includes(scenario.cancelAt)) {
      cancelled = true;
      try {
        if (scenario.crashLauncher) {
          const pid = Number(log.match(/^OWNED_PROCESS_START pid=(\d+)/m)?.[1]);
          assert.ok(ownedProcessPids(child).includes(pid), 'launcher must belong to this scenario before signalling');
          process.kill(pid, 'SIGKILL');
        } else child.kill('SIGTERM');
      } catch (error) { triggerError = error; child.kill('SIGTERM'); }
    }
  };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  let timer;
  try {
    const [code, signal] = await Promise.race([
      once(child, 'exit'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${scenario.name} supervisor timeout`)), 90000); })
    ]);
    if (triggerError) throw triggerError;
    assert.equal(signal, null, log);
    assert.equal(code, scenario.code, log);
    assert.match(log, /MACHINE_E2E_CLEANUP .*"remaining":\[\]/);
    assert.doesNotMatch(log, /MACHINE_E2E_CLEANUP_FAIL/);
    const remaining = ownedProcessPids(child);
    assert.deepEqual(remaining, [], `Leaked task processes after launcher exited: ${remaining}`);
    const userData = log.match(/^MACHINE_E2E_USERDATA (.+)$/m)?.[1];
    assert.ok(userData); assert.equal(existsSync(userData), false, 'isolated userData not removed after verified cleanup');
    for (const resource of ['cdpPort', 'llmPort']) {
      const port = log.match(new RegExp(`^MACHINE_E2E_RESOURCES .*${resource}=(\\d+)`, 'm'))?.[1];
      if (!port) continue;
      let available = false;
      try { await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) }); available = true; } catch {}
      assert.equal(available, false, `task ${resource} still responds`);
    }
    if (scenario.code === 0) {
      assert.match(log, /MACHINE_E2E_DONE steps=4 failed=0/);
      assert.ok(readFileSync(join(shotDir, '23-pv-04-transfer-3d.png')).length > 20000);
    } else assert.doesNotMatch(log, /MACHINE_E2E_DONE/);
    if (scenario.cancelAt) assert.equal(cancelled, true);
    console.log(`RENDER_CLEANUP_OK ${scenario.name} exit=${code} remaining=0`);
  } finally {
    clearTimeout(timer);
    writeFileSync(join(outputs, `${scenario.name}.log`), log);
    // Emergency containment is separate from the pre-cleanup assertion above.
    await stopOwnedProcess(child);
  }
}
console.log(`RENDER_CLEANUP_ARTIFACTS ${outputs}`);
