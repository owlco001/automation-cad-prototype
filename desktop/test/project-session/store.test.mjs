import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { readProjectSession, saveProjectSession, repairProjectSession, readLastProjectSession, rememberLastProjectSession } from '../../electron/project-session-store.ts';

const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function snapshot() {
  return { schemaVersion: 1, projectId: 'session-123', sourceName: 'machine.step', machineConfig: null, machineDesign: null, featureTreeJson: null, kinematicsJson: null, viewState: null, meshSignature: 'ab'.repeat(32), ioPoints: null };
}
function setup(initial = true) {
  const root = mkdtempSync(join(tmpdir(), 'cad-session-'));
  roots.push(root);
  const dir = join(root, 'projects', 'machine');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ id: 'machine', name: 'Machine' }));
  if (initial) writeFileSync(join(dir, 'workspace.json'), JSON.stringify(snapshot()));
  return { root, dir };
}

test('initial workspace fallback, revisioned roundtrip, stale saves and last pointer', () => {
  const { root, dir } = setup();
  assert.deepEqual(readProjectSession(root, 'machine'), { ok: true, revision: null, snapshot: snapshot() });
  const changed = { ...snapshot(), sourceName: 'edited.step' };
  const first = saveProjectSession(root, 'machine', { snapshot: changed, expectedRevision: null });
  assert.equal(first.ok, true, first.message);
  assert.match(first.revision, /^[a-f0-9-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(first.savedAt)));
  assert.deepEqual(readProjectSession(root, 'machine'), first);
  const stale = saveProjectSession(root, 'machine', { snapshot: snapshot(), expectedRevision: null });
  assert.equal(stale.ok, false);
  assert.equal(stale.revision, first.revision);
  const second = saveProjectSession(root, 'machine', { snapshot: snapshot(), expectedRevision: first.revision });
  assert.equal(second.ok, true, second.message);
  assert.notEqual(second.revision, first.revision);
  assert.equal(JSON.parse(readFileSync(join(dir, 'session.json.bak'), 'utf8')).revision, first.revision);
  assert.equal(readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
  assert.deepEqual(rememberLastProjectSession(root, 'machine'), { ok: true });
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'last-project-session.json'), 'utf8')), { id: 'machine' });
  assert.deepEqual(readLastProjectSession(root), { ...second, id: 'machine' });
});

test('read recovers previous valid backup but save fails closed on corrupt current', () => {
  const { root, dir } = setup();
  const first = saveProjectSession(root, 'machine', { snapshot: snapshot(), expectedRevision: null });
  const second = saveProjectSession(root, 'machine', { snapshot: { ...snapshot(), sourceName: 'changed' }, expectedRevision: first.revision });
  assert.equal(second.ok, true);
  writeFileSync(join(dir, 'session.json'), '{broken');
  const recovered = readProjectSession(root, 'machine');
  assert.equal(recovered.ok, true);
  assert.equal(recovered.revision, first.revision);
  assert.match(recovered.message, /backup/);
  assert.equal(saveProjectSession(root, 'machine', { snapshot: snapshot(), expectedRevision: first.revision }).ok, false);
  assert.equal(readFileSync(join(dir, 'session.json'), 'utf8'), '{broken');
});

test('corrupt current and backup never fall back to initial workspace or get overwritten', () => {
  const { root, dir } = setup();
  writeFileSync(join(dir, 'session.json'), 'bad');
  writeFileSync(join(dir, 'session.json.bak'), 'bad backup');
  assert.equal(readProjectSession(root, 'machine').ok, false);
  assert.equal(saveProjectSession(root, 'machine', { snapshot: snapshot(), expectedRevision: null }).ok, false);
  assert.equal(readFileSync(join(dir, 'session.json.bak'), 'utf8'), 'bad backup');
});

test('project replacement invalidates current and backup fingerprint', () => {
  const { root, dir } = setup();
  const first = saveProjectSession(root, 'machine', { snapshot: snapshot(), expectedRevision: null });
  saveProjectSession(root, 'machine', { snapshot: snapshot(), expectedRevision: first.revision });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ id: 'machine', name: 'Replacement' }));
  const read = readProjectSession(root, 'machine');
  assert.equal(read.ok, false);
  assert.match(read.message, /replaced/);
  assert.equal(saveProjectSession(root, 'machine', { snapshot: snapshot(), expectedRevision: null }).ok, false);
});

test('session identity and mesh signature remain bound to saved workspace', () => {
  const { root } = setup();
  for (const change of [{ projectId: 'different' }, { meshSignature: 'cd'.repeat(32) }]) {
    assert.equal(saveProjectSession(root, 'machine', { snapshot: { ...snapshot(), ...change }, expectedRevision: null }).ok, false);
  }
});

test('safe exact ids, existing projects, malformed pointers, invalid snapshots and symlinks', () => {
  const { root, dir } = setup();
  for (const id of ['../machine', 'machine/', '', '.', 'missing', 'x'.repeat(49)]) {
    assert.equal(readProjectSession(root, id).ok, false);
    assert.equal(saveProjectSession(root, id, { snapshot: snapshot(), expectedRevision: null }).ok, false);
    assert.equal(rememberLastProjectSession(root, id).ok, false);
  }
  assert.equal(saveProjectSession(root, 'machine', { snapshot: {}, expectedRevision: null }).ok, false);
  assert.equal(saveProjectSession(root, 'machine', { snapshot: snapshot(), expectedRevision: 'bad' }).ok, false);
  writeFileSync(join(root, 'last-project-session.json'), JSON.stringify({ id: '../machine', path: '/external' }));
  assert.equal(readLastProjectSession(root).ok, false);
  symlinkSync(join(dir, 'workspace.json'), join(dir, 'session.json'));
  assert.equal(readProjectSession(root, 'machine').ok, false);
  assert.equal(saveProjectSession(root, 'machine', { snapshot: snapshot(), expectedRevision: null }).ok, false);
});

test('explicit repair preserves corrupt bytes, restores matching backup and resumes saves', () => {
  const { root, dir } = setup();
  const first = saveProjectSession(root, 'machine', { snapshot: snapshot(), expectedRevision: null });
  const second = saveProjectSession(root, 'machine', { snapshot: { ...snapshot(), sourceName: 'newer' }, expectedRevision: first.revision });
  const corrupt = Buffer.from([0xff, 0x00, 0x7b, 0x78]);
  writeFileSync(join(dir, 'session.json'), corrupt);
  const wrong = repairProjectSession(root, 'machine', second.revision);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.conflict, true);
  assert.equal(wrong.revision, first.revision);
  assert.deepEqual(readFileSync(join(dir, 'session.json')), corrupt);
  assert.equal(readdirSync(dir).some((name) => name.startsWith('session.corrupt-')), false);
  const repaired = repairProjectSession(root, 'machine', first.revision);
  assert.deepEqual(repaired, first);
  assert.deepEqual(readProjectSession(root, 'machine'), first);
  const preserved = readdirSync(dir).filter((name) => /^session\.corrupt-[a-f0-9-]{36}\.json$/.test(name));
  assert.equal(preserved.length, 1);
  assert.deepEqual(readFileSync(join(dir, preserved[0])), corrupt);
  assert.equal(JSON.parse(readFileSync(join(dir, 'session.json.bak'), 'utf8')).revision, first.revision);
  const saved = saveProjectSession(root, 'machine', { snapshot: { ...snapshot(), sourceName: 'after repair' }, expectedRevision: repaired.revision });
  assert.equal(saved.ok, true, saved.message);
  assert.notEqual(saved.revision, repaired.revision);
});

test('repair requires a valid backup, exact revision, existing project and damaged current', () => {
  const { root, dir } = setup();
  const first = saveProjectSession(root, 'machine', { snapshot: snapshot(), expectedRevision: null });
  assert.equal(repairProjectSession(root, 'machine', first.revision).ok, false);
  assert.equal(repairProjectSession(root, 'machine', 'bad').ok, false);
  assert.equal(repairProjectSession(root, '../machine', first.revision).ok, false);
  const second = saveProjectSession(root, 'machine', { snapshot: snapshot(), expectedRevision: first.revision });
  const healthy = repairProjectSession(root, 'machine', first.revision);
  assert.equal(healthy.ok, false);
  assert.equal(healthy.conflict, true);
  assert.equal(healthy.revision, second.revision);
  assert.equal(readProjectSession(root, 'machine').revision, second.revision);
  writeFileSync(join(dir, 'session.json'), 'corrupt');
  writeFileSync(join(dir, 'session.json.bak'), 'corrupt backup');
  assert.equal(repairProjectSession(root, 'machine', first.revision).ok, false);
  assert.equal(readFileSync(join(dir, 'session.json'), 'utf8'), 'corrupt');
  assert.equal(readdirSync(dir).some((name) => name.startsWith('session.corrupt-')), false);
});

test('repair rejects backups from replaced projects without moving damaged current', () => {
  const { root, dir } = setup();
  const first = saveProjectSession(root, 'machine', { snapshot: snapshot(), expectedRevision: null });
  saveProjectSession(root, 'machine', { snapshot: snapshot(), expectedRevision: first.revision });
  writeFileSync(join(dir, 'session.json'), 'corrupt');
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ id: 'machine', name: 'Replacement' }));
  const repaired = repairProjectSession(root, 'machine', first.revision);
  assert.equal(repaired.ok, false);
  assert.match(repaired.message, /replaced/);
  assert.equal(readFileSync(join(dir, 'session.json'), 'utf8'), 'corrupt');
});

test('repair restores a missing current from its valid backup', () => {
  const { root, dir } = setup();
  const first = saveProjectSession(root, 'machine', { snapshot: snapshot(), expectedRevision: null });
  saveProjectSession(root, 'machine', { snapshot: snapshot(), expectedRevision: first.revision });
  const currentPath = join(dir, 'session.json');
  assert.equal(currentPath, join(root, 'projects', 'machine', 'session.json'));
  rmSync(currentPath);
  assert.deepEqual(repairProjectSession(root, 'machine', first.revision), first);
  assert.deepEqual(readProjectSession(root, 'machine'), first);
  assert.equal(readdirSync(dir).some((name) => name.startsWith('session.corrupt-')), false);
});

test('legacy project without workspace reads empty and accepts first valid session', () => {
  const { root } = setup(false);
  assert.equal(readProjectSession(root, 'machine').snapshot, undefined);
  assert.equal(saveProjectSession(root, 'machine', { snapshot: snapshot(), expectedRevision: null }).ok, true);
});
