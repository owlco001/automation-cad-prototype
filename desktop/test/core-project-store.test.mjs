import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CoreProjectStore, CORE_PROJECT_SCHEMA_VERSION } from '../electron/core/project-store.mjs';

async function makeStore(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'automationcad-core-project-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new CoreProjectStore(root, options) };
}

test('Core 项目可创建、列出、打开并保存；数据使用版本 1 schema', async (t) => {
  const { root, store } = await makeStore(t);
  const created = await store.create('  夹具设计  ');
  assert.equal(created.name, '夹具设计');
  assert.equal(created.format, 'automationcad-core-project');
  assert.equal(created.schemaVersion, CORE_PROJECT_SCHEMA_VERSION);
  assert.match(created.id, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(await store.open(created.id), created);

  const saved = await store.save({ id: created.id, name: '夹具设计 V2', notes: '离线草案\n安全门与气缸顺序' });
  assert.equal(saved.id, created.id);
  assert.equal(saved.createdAt, created.createdAt);
  assert.equal(saved.name, '夹具设计 V2');
  assert.equal(saved.notes, '离线草案\n安全门与气缸顺序');
  assert.deepEqual(await store.open(created.id), saved);
  assert.deepEqual(await store.list(), [{ id: created.id, name: saved.name, updatedAt: saved.updatedAt }]);

  const file = JSON.parse(await readFile(join(root, `${created.id}.json`), 'utf8'));
  assert.deepEqual(Object.keys(file).sort(), ['createdAt', 'format', 'id', 'name', 'notes', 'schemaVersion', 'updatedAt']);
  assert.equal(file.schemaVersion, 1);
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), []);
});

test('非法名称、备注、项目 ID 或额外字段在落盘前被拒绝', async (t) => {
  const { root, store } = await makeStore(t);
  const project = await store.create('受保护的数据');
  const path = join(root, `${project.id}.json`);
  const before = await readFile(path, 'utf8');

  await assert.rejects(store.create('   '), { code: 'CORE_PROJECT_INVALID' });
  await assert.rejects(store.open('../outside'), { code: 'CORE_PROJECT_INVALID' });
  await assert.rejects(store.save({ id: project.id, name: '损坏输入', notes: '未保存', filePath: '/tmp/other' }), { code: 'CORE_PROJECT_INVALID' });
  await assert.rejects(store.save({ id: project.id, name: '损坏输入', notes: '\u0000' }), { code: 'CORE_PROJECT_INVALID' });
  assert.equal(await readFile(path, 'utf8'), before);
});

test('失败的原子替换保留先前版本且清理临时文件', async (t) => {
  const { root, store } = await makeStore(t);
  const project = await store.create('原始项目');
  const path = join(root, `${project.id}.json`);
  const before = await readFile(path, 'utf8');
  const failingStore = new CoreProjectStore(root, {
    replaceFile: async () => { throw new Error('simulated pre-commit failure'); }
  });

  await assert.rejects(
    failingStore.save({ id: project.id, name: '不应提交', notes: '新内容' }),
    { code: 'CORE_PROJECT_WRITE_FAILED' }
  );
  assert.equal(await readFile(path, 'utf8'), before);
  assert.deepEqual(await store.open(project.id), project);
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), []);
});

test('未知 schema 版本或损坏数据不会被打开或覆盖', async (t) => {
  const { root, store } = await makeStore(t);
  const project = await store.create('版本测试');
  const path = join(root, `${project.id}.json`);
  const unsupported = JSON.stringify({ ...project, schemaVersion: 2 });
  await writeFile(path, unsupported, 'utf8');

  await assert.rejects(store.open(project.id), { code: 'CORE_PROJECT_CORRUPT' });
  await assert.rejects(store.save({ id: project.id, name: '尝试覆盖', notes: '' }), { code: 'CORE_PROJECT_CORRUPT' });
  assert.equal(await readFile(path, 'utf8'), unsupported);
  await assert.rejects(store.list(), { code: 'CORE_PROJECT_CORRUPT' });
});

test('并发保存保持文件始终符合 schema 且列表只暴露项目摘要', async (t) => {
  const { store } = await makeStore(t);
  const project = await store.create('并发项目');
  await Promise.all([
    store.save({ id: project.id, name: '并发项目 A', notes: 'A' }),
    store.save({ id: project.id, name: '并发项目 B', notes: 'B' })
  ]);
  const opened = await store.open(project.id);
  assert.ok(['并发项目 A', '并发项目 B'].includes(opened.name));
  assert.ok(['A', 'B'].includes(opened.notes));
  assert.deepEqual(Object.keys((await store.list())[0]).sort(), ['id', 'name', 'updatedAt']);
});
