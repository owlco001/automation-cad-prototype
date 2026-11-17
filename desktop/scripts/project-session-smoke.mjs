#!/usr/bin/env node
/** Real Electron recovery smoke. Build first, then run from desktop:
 *   npm run build:ext && node scripts/project-session-smoke.mjs
 * Requires Node with native WebSocket and TypeScript stripping, Electron and xvfb-run.
 * No model/kernel service, PLC connection, screenshots, or external network requests.
 * PROJECT_SESSION_SMOKE_KEEP=1 retains the unique temporary userData for diagnosis.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveProject } from '../electron/projects.ts';
import { projectMeshSignature } from '../src/project-session/mesh-signature.ts';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const userData = mkdtempSync(join(tmpdir(), 'automationcad-session-smoke-'));
const keep = process.env.PROJECT_SESSION_SMOKE_KEEP === '1';
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
let child = null;
let cdp = null;
let output = '';
let step = 'fixture';
let stopping = false;
let cleanupFailed = false;
const featureDoc = {
  schemaVersion: 1, updatedAt: '2026-01-01T00:00:00.000Z',
  features: [{ id: 'smoke-box', type: 'box', name: 'Recovery smoke box', params: { length: 20, width: 30, height: 40 } }]
};

function cubeStl() {
  const vertices = [[0, 0, 0], [20, 0, 0], [20, 30, 0], [0, 30, 0], [0, 0, 40], [20, 0, 40], [20, 30, 40], [0, 30, 40]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const data = Buffer.alloc(84 + faces.length * 50);
  data.write('project-session-smoke generated cube');
  data.writeUInt32LE(faces.length, 80);
  faces.forEach((face, index) => face.forEach((vertex, corner) => vertices[vertex].forEach((value, axis) => {
    data.writeFloatLE(value, 84 + index * 50 + 12 + corner * 12 + axis * 4);
  })));
  return new Uint8Array(data);
}

async function freePort() {
  const server = createServer();
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise((done, fail) => server.close((error) => error ? fail(error) : done()));
  return port;
}

async function connect(port) {
  let target;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null || child?.signalCode) throw new Error(`Electron exited before CDP: ${output.slice(-5000)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
      const targets = await response.json();
      target = targets.find((item) => item.type === 'page' && String(item.url).includes('index.html'));
      if (target) break;
    } catch { /* Endpoint is not ready yet. */ }
    await delay(200);
  }
  assert.ok(target, 'Electron CDP page did not appear');
  const endpoint = new URL(target.webSocketDebuggerUrl);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'CDP must stay on loopback');
  const socket = new WebSocket(endpoint);
  await new Promise((done, fail) => {
    const timer = setTimeout(() => { socket.close(); fail(new Error('CDP handshake timeout')); }, 10_000);
    socket.addEventListener('open', () => { clearTimeout(timer); done(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); fail(new Error('CDP connection failed')); }, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.fail(new Error(`${entry.method}: ${message.error.message}`));
    else entry.done(message.result);
  });
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.fail(new Error('CDP closed')); }
    pending.clear();
  });
  const send = (method, params = {}) => new Promise((done, fail) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); fail(new Error(`${method} timed out`)); }, 30_000);
    pending.set(id, { method, timer, done, fail });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  await send('Runtime.enable');
  return { send, evaluate, close: () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.fail(new Error('CDP client closed')); }
    pending.clear();
    socket.close();
  } };
}

async function waitFor(expression, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await cdp.evaluate(expression); if (value) return value; } catch (error) { lastError = error; }
    await delay(150);
  }
  throw new Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ''}`);
}

async function launch() {
  const port = await freePort();
  output = '';
  child = spawn('xvfb-run', ['-a', process.execPath, 'scripts/electron-run.mjs', '--machine-e2e-host', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], {
    cwd: desktopRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AUTOMATIONCAD_E2E_USERDATA: userData, AUTOMATIONCAD_E2E_CDP_PORT: String(port) }
  });
  let spawnError;
  child.on('error', (error) => { spawnError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + chunk).slice(-50_000); });
  await delay(100);
  if (spawnError) throw spawnError;
  cdp = await connect(port);
  await waitFor('window.__AUTOMATION_CAD_EXTENSION_READY__ === true', 'extension ready', 60_000);
  assert.equal(await cdp.evaluate('typeof window.require'), 'undefined', 'renderer must not expose Node require');
  assert.equal(await cdp.evaluate('typeof window.process'), 'undefined', 'renderer must not expose Node process');
  console.log('PROJECT_SESSION_SMOKE_MODULES ' + JSON.stringify(await cdp.evaluate('__ModuleRegistry.list()')));
  assert.equal(await cdp.evaluate('__ModuleRegistry.getStatus("cad.parametric-import").enabled'), true, 'fresh userData must enable parametric import');
  await cdp.evaluate(`(() => {
    const button = document.querySelector('.home-foot .home-link'); if (button) button.click();
    AutomationCadParametric.getDoc();
    const auto = document.querySelector('[data-param-auto]');
    if (!auto) throw new Error('Parametric auto-rebuild toggle missing');
    auto.checked = false; auto.dispatchEvent(new Event('change', {bubbles:true}));
    return true;
  })()`);
  console.log(`PROJECT_SESSION_SMOKE_READY port=${port}`);
}

async function stop() {
  cdp?.close();
  cdp = null;
  const running = child;
  child = null;
  if (!running?.pid) return;
  const signalGroup = (signal) => {
    try { process.kill(-running.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  signalGroup('SIGTERM');
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    try { process.kill(-running.pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(100);
  }
  signalGroup('SIGKILL');
  // Do not start another Electron instance before the previous process group exits.
  const killedDeadline = Date.now() + 4000;
  while (Date.now() < killedDeadline) {
    try { process.kill(-running.pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(100);
  }
  throw new Error('Electron process group did not exit after SIGKILL');
}

async function runtimeState() {
  return await cdp.evaluate(`(() => ({
    id: AutomationCadProjects.currentId(),
    scene: AutomationCadViewer.describeScene(),
    doc: AutomationCadParametric.getDoc(),
    annotation: AutomationCadKinematics.getAnnotation(),
    io: [...document.querySelectorAll('[data-point-address]')].map(n => ({ id: n.dataset.pointAddress, address: Number(n.value) })),
    plc: document.getElementById('commissionStatusText')?.textContent
  }))()`);
}

function assertRestored(actual, expected, id) {
  assert.equal(actual.id, id, 'current project identity');
  assert.equal(actual.scene.parts.length, 1, 'real scene contains fixture mesh');
  assert.equal(actual.scene.degraded, false, 'WebGL viewer must be active');
  assert.equal(actual.scene.wireframe, expected.scene.wireframe, 'wireframe restored');
  assert.ok(actual.scene.camera?.position, 'restored camera exists');
  actual.scene.camera.position.forEach((value, index) => assert.ok(Math.abs(value - expected.scene.camera.position[index]) < 1e-5, 'camera position restored'));
  assert.deepEqual(actual.doc.instances.map(item => item.features), expected.doc.instances.map(item => item.features), 'feature tree restored');
  assert.deepEqual(actual.annotation.parts, expected.annotation.parts, 'kinematics restored');
  assert.deepEqual(actual.io, expected.io, 'editable IO restored');
  assert.ok(!/已连接|connected/i.test(actual.plc ?? ''), 'recovery must not connect a PLC');
}

async function main() {
  const data = cubeStl();
  const meshSignature = await projectMeshSignature([{ name: 'Recovery cube', data }]);
  const fixture = saveProject(userData, {
    name: 'Recovery smoke fixture', process: 'recovery-smoke', parts: 1, envelope: [20, 30, 40], partData: [{ name: 'Recovery cube', data }],
    workspace: {
      schemaVersion: 1, projectId: 'smoke-fixture-binding', sourceName: 'Recovery cube.stl', meshSignature,
      machineConfig: null, machineDesign: null, featureTreeJson: null, kinematicsJson: null, viewState: null,
      ioPoints: [{ id: 'smoke-input', name: 'Smoke input', area: 'discrete', address: 21, dataType: 'bool' }]
    }
  });
  assert.equal(fixture.ok, true, fixture.message);
  step = 'open fixture';
  await launch();
  const opened = await cdp.evaluate(`AutomationCadProjects.open(${JSON.stringify(fixture.record.id)})`);
  console.log('PROJECT_SESSION_SMOKE_OPEN ' + JSON.stringify(opened));
  console.log('PROJECT_SESSION_SMOKE_INITIAL_SESSION ' + JSON.stringify(await cdp.evaluate(`desktop.projects.session(${JSON.stringify(fixture.record.id)})`)));
  assert.ok(opened, 'fixture open failed');
  step = 'workspace UI';
  assert.equal(await cdp.evaluate('document.querySelectorAll("[data-workspace]").length >= 4'), true);
  assert.equal(await cdp.evaluate('document.getElementById("projectContextBar").parentElement.id'), 'automationCadOverlay');
  for (const key of ['inspection', 'kinematics', 'parametric', 'collapsed']) {
    await cdp.evaluate(`document.querySelector('[data-cad-inspector-tab="${key}"]').click()`);
    await delay(50);
    const visible = await cdp.evaluate(`['.cad-inspector','#cadKinematicsDrawer','#cadParametricDrawer'].filter(s=>!document.querySelector(s).hidden)`);
    assert.equal(visible.length, key === 'collapsed' ? 0 : 1, `exclusive ${key} panel`);
  }
  await cdp.evaluate('document.querySelector(\'[data-cad-inspector-tab="inspection"]\').click()');
  if (process.env.PROJECT_SESSION_SMOKE_SCREENSHOT) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(process.env.PROJECT_SESSION_SMOKE_SCREENSHOT, Buffer.from(shot.data, 'base64'));
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  assert.equal(await cdp.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2'), true, 'narrow window has no document overflow');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.evaluate(`document.querySelector('.project-context-workflows button').click()`);
  assert.equal(await cdp.evaluate('document.getElementById("automationCadOverlay").hidden'), true, 'current workflow navigation exits CAD');
  await cdp.evaluate('AutomationCadViewer.open()');
  step = 'edit fixture';
  await cdp.evaluate(`(() => {
    AutomationCadParametric.setDoc(${JSON.stringify(featureDoc)});
    const mesh = AutomationCadKinematics.state().meshes[0];
    if (!mesh) throw new Error('No fixture mesh for kinematics');
    AutomationCadKinematics.addMovingPart([mesh.id], 'Smoke moving part');
    return true;
  })()`);
  step = 'save scene as project';
  const saved = await cdp.evaluate(`__AgentBridge.saveSceneAsProject({name:'Recovery smoke saved'})`);
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const id = saved.projectId;
  assert.ok(id);
  step = 'edit and automatic save';
  const initial = await cdp.evaluate(`desktop.projects.session(${JSON.stringify(id)})`);
  assert.equal(initial.ok, true, initial.message);
  await cdp.evaluate(`(() => {
    const address = document.querySelector('[data-point-address="smoke-input"]');
    if (!address) throw new Error('Recovery IO input missing');
    address.value = '321'; address.dispatchEvent(new Event('change', {bubbles:true}));
    AutomationCadViewer.toggleWireframe();
    const doc = AutomationCadParametric.getDoc();
    doc.instances[0].features[0].params.length = 77;
    AutomationCadParametric.setDoc(doc);
    const part = AutomationCadKinematics.getAnnotation().parts[0];
    AutomationCadKinematics.updatePart(part.id, {travelMm: 123});
    return true;
  })()`);
  // Real CDP wheel input exercises OrbitControls and persisted camera position.
  const rect = await cdp.evaluate(`(() => { const r = document.querySelector('.cad-canvas').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height}; })()`);
  assert.ok(rect.width > 0 && rect.height > 0, 'viewer canvas must be visible');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: 0, deltaY: 180 });
  await delay(700);
  const expected = await runtimeState();
  assert.equal(expected.io.find(point => point.id === 'smoke-input')?.address, 321, 'IO DOM edit applied');
  const persisted = await waitFor(`(async () => {
    const r = await desktop.projects.session(${JSON.stringify(id)});
    return r.ok && r.revision && r.revision !== ${JSON.stringify(initial.revision)}
      && r.snapshot?.ioPoints?.some(p => p.id === 'smoke-input' && p.address === 321)
      && r.snapshot?.featureTreeJson?.includes('77')
      && JSON.parse(r.snapshot.kinematicsJson).parts.some(p => p.travelMm === 123)
      && r.snapshot.viewState.wireframe === ${JSON.stringify(expected.scene.wireframe)} ? r : false;
  })()`, 'poll-driven persisted edits');
  assert.notDeepEqual(persisted.snapshot.viewState.position, initial.snapshot.viewState.position, 'wheel changed persisted camera');
  step = 'same-process reopen';
  assert.ok(await cdp.evaluate(`AutomationCadProjects.open(${JSON.stringify(id)})`));
  assertRestored(await runtimeState(), expected, id);
  step = 'cold restart recovery';
  await stop();
  await launch();
  await waitFor('Boolean(document.getElementById("recoverLastProject"))', 'cold recovery button');
  assert.equal(await cdp.evaluate('AutomationCadProjects.currentId()'), null, 'startup should offer recovery without silently opening');
  await cdp.evaluate('document.getElementById("recoverLastProject").click()');
  await waitFor(`AutomationCadProjects.currentId() === ${JSON.stringify(id)} && !document.getElementById('recoverLastProject')`, 'recovery button completed');
  assertRestored(await runtimeState(), expected, id);
  console.log(`PROJECT_SESSION_SMOKE_PASS project=${id} checks=save-as,poll,io,feature-tree,kinematics,camera,reopen,cold-recovery,renderer-isolation`);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  if (stopping) return;
  stopping = true;
  void stop().finally(() => process.exit(130));
});
try {
  await main();
} catch (error) {
  process.exitCode = 1;
  console.error(`PROJECT_SESSION_SMOKE_FAIL step=${step} reason=${error.stack ?? error}`);
  if (cdp) {
    try {
      const diagnostics = await cdp.evaluate(`(async () => {
        const safe = (fn) => {try {return fn();} catch(e) {return {error:String(e)};}};
        const id = safe(() => AutomationCadProjects.currentId());
        return {
          id, status: document.getElementById('projectSessionStatus')?.textContent,
          notice: document.getElementById('cadNotice')?.textContent,
          ready: window.__AUTOMATION_CAD_EXTENSION_READY__,
          modules: safe(() => __ModuleRegistry.list()),
          scene: safe(() => AutomationCadViewer.describeScene()),
          doc: safe(() => AutomationCadParametric.getDoc()),
          annotation: safe(() => AutomationCadKinematics.getAnnotation()),
          session: typeof id === 'string' ? await desktop.projects.session(id) : null,
          io: [...document.querySelectorAll('[data-point-address]')].map(n => ({id:n.dataset.pointAddress,address:n.value}))
        };
      })()`);
      console.error('PROJECT_SESSION_SMOKE_DIAGNOSTICS ' + JSON.stringify(diagnostics));
    } catch (diagnosticError) { console.error('PROJECT_SESSION_SMOKE_DIAGNOSTICS_FAIL ' + diagnosticError.message); }
  }
  console.error(output.slice(-8000));
} finally {
  try { await stop(); } catch (error) { cleanupFailed = true; process.exitCode = 1; console.error(`PROJECT_SESSION_SMOKE_CLEANUP_FAIL ${error.message}`); }
  if (keep || cleanupFailed) console.log(`PROJECT_SESSION_SMOKE_USERDATA ${userData}`);
  else {
    // mkdtemp created this exact absolute directory; never delete a supplied path.
    assert.equal(dirname(userData), resolve(tmpdir()));
    assert.ok(userData.startsWith(join(resolve(tmpdir()), 'automationcad-session-smoke-')));
    if (!child) rmSync(userData, { recursive: true, force: true });
  }
  // Node's built-in WebSocket can retain an idle transport after Electron exits.
  // All owned process groups have been awaited above; finish the standalone CLI.
  process.exit(process.exitCode ?? 0);
}
