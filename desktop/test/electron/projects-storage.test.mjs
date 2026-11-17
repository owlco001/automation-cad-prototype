import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { listProjects, openProject, projectsRoot, saveProject } from '../../electron/projects.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = fs.mkdtempSync(join(tmpdir(), 'cad-project-storage-'));
  roots.push(root);
  return root;
}
const bytes = (text) => new TextEncoder().encode(text);
const input = (extra = {}) => ({ name: 'machine', process: 'test', parts: 1, partData: [{ name: 'part', data: bytes('original') }], ...extra });
function tree(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map((name) => [name, fs.statSync(join(dir, name)).isDirectory() ? tree(join(dir, name)) : fs.readFileSync(join(dir, name)).toString('base64')]));
}
function saved(root, extra) {
  const result = saveProject(root, input(extra));
  assert.equal(result.ok, true, result.message);
  return result.record;
}

test('late invalid inputs and missing sources preserve every byte of the previous project', () => {
  const root = setup();
  const record = saved(root, { stlData: bytes('mesh') });
  const before = tree(projectsRoot(root));
  for (const extra of [
    { stlData: new Uint8Array() },
    { partData: [{ name: 'valid', data: bytes('new') }, { name: 'invalid', data: new Uint8Array() }] },
    { partPaths: [{ name: 'missing', path: join(root, 'missing.stl') }] },
    { stepPath: join(root, 'missing.step') },
    { placements: [{ x: Infinity }] },
    { parts: NaN }, { massKg: Infinity }, { envelope: [1, 2, NaN] },
    { design: {} }, { config: {} }, { geometryReview: {} }
  ]) {
    assert.equal(saveProject(root, input(extra)).ok, false);
    assert.deepEqual(tree(projectsRoot(root)), before);
    assert.equal(openProject(root, record.id).ok, true);
  }
});

test('failed first save publishes no project or temporary directory', () => {
  const root = setup();
  assert.equal(saveProject(root, input({ stlData: new Uint8Array() })).ok, false);
  assert.deepEqual(listProjects(root), []);
  assert.equal(fs.existsSync(projectsRoot(root)), false);
});

test('sanitized, truncated, case-folded and identical part names retain distinct bytes and order', () => {
  const root = setup();
  const source = join(root, 'same.stl');
  fs.writeFileSync(source, 'file-part');
  const names = ['a/b', 'a?b', 'Part', 'part', 'x'.repeat(70), 'x'.repeat(71), 'duplicate', 'duplicate'];
  const record = saved(root, { parts: names.length + 1, partPaths: [{ name: 'a/b', path: source, color: '#AABBCC' }], partData: names.map((name, index) => ({ name, data: bytes(`part-${index}`) })) });
  assert.equal(new Set(record.partsList.map((part) => part.file.toLowerCase())).size, names.length + 1);
  const opened = openProject(root, record.id);
  assert.deepEqual(opened.partPaths.map((part) => fs.readFileSync(part.path, 'utf8')), ['file-part', ...names.map((_, index) => `part-${index}`)]);
  assert.deepEqual(opened.partPaths.map((part) => part.name), ['a/b', ...names]);
  assert.equal(record.partsList[0].color, '#aabbcc');
  assert.equal(fs.readdirSync(join(projectsRoot(root), record.id, 'parts')).length, names.length + 1);
});

test('distinct project names with sanitized collisions coexist and overwrite independently', () => {
  const root = setup();
  const names = ['a/b', 'a?b', 'Case', 'case', 'x'.repeat(60), 'x'.repeat(61)];
  const records = names.map((name) => saved(root, { name }));
  assert.equal(new Set(records.map((record) => record.id.toLowerCase())).size, names.length);
  names.forEach((name, index) => assert.equal(saved(root, { name, stlData: bytes(name) }).id, records[index].id));
  assert.equal(listProjects(root).length, names.length);
});

test('overwrite reads its own source geometry before publication and removes stale outputs', () => {
  const root = setup();
  const source = join(root, 'source.step');
  fs.writeFileSync(source, 'step');
  const design = synthMachine(parseMachineBrief('三工位锁螺丝机，10 件/分钟'));
  const original = saved(root, { stepPath: source, stlData: bytes('mesh'), design, placements: [] });
  const dir = join(projectsRoot(root), original.id);
  const opened = openProject(root, original.id);
  const replacement = saved(root, { partData: [], partPaths: opened.partPaths, stepPath: opened.stepPath, stlPath: join(dir, 'model.stl') });
  assert.equal(fs.readFileSync(openProject(root, replacement.id).partPaths[0].path, 'utf8'), 'original');
  assert.equal(fs.readFileSync(join(dir, 'model.step'), 'utf8'), 'step');
  assert.equal(fs.readFileSync(join(dir, 'model.stl'), 'utf8'), 'mesh');
  assert.equal(fs.existsSync(join(dir, 'design.json')), false);
  const empty = saved(root, { parts: 0, partData: [] });
  assert.equal(empty.hasStep, false);
  assert.equal(empty.hasStl, false);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['parts', 'project.json']);
  assert.deepEqual(fs.readdirSync(join(dir, 'parts')), []);
  assert.equal(openProject(root, empty.id).stepPath, null);
});

test('copy, metadata-write and publish-rename failures preserve the complete prior directory', () => {
  const root = setup();
  saved(root);
  const source = join(root, 'source.step');
  fs.writeFileSync(source, 'step');
  const before = tree(projectsRoot(root));
  for (const operation of ['copyFileSync', 'writeFileSync', 'renameSync']) {
    const original = fs[operation];
    fs[operation] = (...args) => {
      const target = String(operation === 'copyFileSync' ? args[1] : args[0]);
      if ((operation === 'copyFileSync') ||
          (operation === 'writeFileSync' && basename(target) === 'project.json') ||
          (operation === 'renameSync' && basename(target).startsWith('.project-stage-'))) throw new Error(`injected ${operation}`);
      return original(...args);
    };
    syncBuiltinESMExports();
    try {
      const result = saveProject(root, input({ stepPath: source }));
      assert.equal(result.ok, false);
      assert.match(result.message, /injected/);
    } finally { fs[operation] = original; syncBuiltinESMExports(); }
    assert.deepEqual(tree(projectsRoot(root)), before, operation);
  }
});

test('cleanup failure after publication reports success and is finished on next access', () => {
  const root = setup();
  const record = saved(root);
  const original = fs.rmSync;
  fs.rmSync = (...args) => {
    if (basename(String(args[0])).startsWith('.project-backup-')) throw new Error('injected cleanup failure');
    return original(...args);
  };
  syncBuiltinESMExports();
  try {
    const result = saveProject(root, input({ partData: [{ name: 'new', data: bytes('published') }] }));
    assert.equal(result.ok, true, result.message);
  } finally { fs.rmSync = original; syncBuiltinESMExports(); }
  const opened = openProject(root, record.id);
  assert.equal(opened.ok, true);
  assert.equal(fs.readFileSync(opened.partPaths[0].path, 'utf8'), 'published');
  assert.deepEqual(fs.readdirSync(projectsRoot(root)), [record.id]);
});

test('failed immediate rollback leaves a recoverable backup for the next open', () => {
  const root = setup();
  const record = saved(root);
  const before = tree(join(projectsRoot(root), record.id));
  const original = fs.renameSync;
  fs.renameSync = (...args) => {
    const source = basename(String(args[0]));
    if (source.startsWith('.project-stage-') || source.startsWith('.project-backup-')) throw new Error('injected publish and rollback failure');
    return original(...args);
  };
  syncBuiltinESMExports();
  try { assert.equal(saveProject(root, input({ stlData: bytes('replacement') })).ok, false); }
  finally { fs.renameSync = original; syncBuiltinESMExports(); }
  assert.equal(openProject(root, record.id).ok, true);
  assert.deepEqual(tree(join(projectsRoot(root), record.id)), before);
  assert.deepEqual(fs.readdirSync(projectsRoot(root)), [record.id]);
});

test('interrupted swaps restore missing live projects and clean published backups without duplicates', () => {
  const root = setup();
  const record = saved(root);
  const projectRoot = projectsRoot(root);
  const dir = join(projectRoot, record.id);
  const stage = '.project-stage-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const backup = '.project-backup-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const journal = join(projectRoot, `.project-swap-${record.id}.json`);
  const before = tree(dir);
  fs.renameSync(dir, join(projectRoot, backup));
  fs.mkdirSync(join(projectRoot, stage));
  fs.writeFileSync(join(projectRoot, stage, 'partial'), 'unpublished');
  fs.writeFileSync(journal, JSON.stringify({ id: record.id, stage, backup }));
  assert.equal(openProject(root, record.id).ok, true);
  assert.deepEqual(tree(dir), before);
  assert.deepEqual(fs.readdirSync(projectRoot), [record.id]);

  fs.cpSync(dir, join(projectRoot, backup), { recursive: true });
  fs.mkdirSync(join(projectRoot, stage));
  fs.writeFileSync(journal, JSON.stringify({ id: record.id, stage, backup }));
  assert.equal(listProjects(root).length, 1);
  assert.deepEqual(tree(dir), before);
  assert.deepEqual(fs.readdirSync(projectRoot), [record.id]);
});

test('unpublished first-save recovery does not expose its staged record', () => {
  const root = setup();
  const record = saved(root);
  const projectRoot = projectsRoot(root);
  const stage = '.project-stage-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const backup = '.project-backup-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  fs.renameSync(join(projectRoot, record.id), join(projectRoot, stage));
  fs.writeFileSync(join(projectRoot, `.project-swap-${record.id}.json`), JSON.stringify({ id: record.id, stage, backup }));
  assert.deepEqual(listProjects(root), []);
  assert.deepEqual(fs.readdirSync(projectRoot), []);
});

test('workspace snapshot validates before publish, opens safely and disappears on full overwrite', () => {
  const root = setup();
  const workspace = { schemaVersion: 1, projectId: 'local-session', sourceName: 'source.step', machineConfig: null, machineDesign: null, featureTreeJson: null, kinematicsJson: null, viewState: null, meshSignature: 'a'.repeat(64), ioPoints: null };
  const record = saved(root, { workspace });
  assert.deepEqual(openProject(root, record.id).workspace, workspace);
  const before = tree(projectsRoot(root));
  assert.equal(saveProject(root, input({ workspace: { ...workspace, meshSignature: 'bad' } })).ok, false);
  assert.deepEqual(tree(projectsRoot(root)), before);
  fs.writeFileSync(join(projectsRoot(root), record.id, 'workspace.json'), '{bad');
  const opened = openProject(root, record.id);
  assert.equal(opened.ok, true);
  assert.equal(opened.workspace, undefined);
  assert.match(opened.workspaceMessage, /损坏/);
  saved(root);
  assert.equal(fs.existsSync(join(projectsRoot(root), record.id, 'workspace.json')), false);
});

test('corrupt partsList traversal and missing referenced parts fail clearly on open', () => {
  const root = setup();
  const record = saved(root);
  const dir = join(projectsRoot(root), record.id);
  const metadata = join(dir, 'project.json');
  for (const file of ['../../outside.stl', '..\\outside.stl']) {
    fs.writeFileSync(metadata, JSON.stringify({ ...record, partsList: [{ name: 'escape', file }] }));
    assert.equal(openProject(root, record.id).ok, false);
  }
  fs.writeFileSync(metadata, JSON.stringify(record));
  fs.rmSync(join(dir, 'parts', record.partsList[0].file));
  const opened = openProject(root, record.id);
  assert.equal(opened.ok, false);
  assert.match(opened.message, /缺失/);
});
