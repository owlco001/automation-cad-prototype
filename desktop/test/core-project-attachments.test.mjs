import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CoreProjectStore } from '../electron/core/project-store.mjs';

function makeBinaryStl(scale = 1) {
  const buffer = Buffer.alloc(134);
  buffer.write('Core immutable attachment fixture', 0, 'ascii');
  buffer.writeUInt32LE(1, 80);
  const vertices = [[0, 0, 0], [scale, 0, 0], [0, scale, 0]];
  for (let vertex = 0; vertex < 3; vertex += 1) {
    for (let axis = 0; axis < 3; axis += 1) buffer.writeFloatLE(vertices[vertex][axis], 96 + vertex * 12 + axis * 4);
  }
  return buffer;
}

async function withStore(callback) {
  const root = await mkdtemp(join(tmpdir(), 'core-project-attachments-test-'));
  try {
    return await callback(root, new CoreProjectStore(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function makeProject(store, name = '项目附件测试') {
  return store.create(name);
}

function objectPath(root, projectId, hash) {
  return join(root, projectId, 'attachments', hash);
}

function indexPath(root, projectId) {
  return join(root, projectId, 'attachments', 'index-v1.json');
}

test('主进程解析拒绝不会创建附件目录/对象或改变项目元数据与附件索引', async () => {
  await withStore(async (root, store) => {
    const project = await makeProject(store);
    const projectBytes = await readFile(join(root, `${project.id}.json`));
    await assert.rejects(
      store.addCadPreviewAttachment(project.id, 'malformed.stl', '.stl', Buffer.from('not an STL mesh')),
      (error) => error.code === 'CAD_PREVIEW_PARSE_FAILED'
    );
    assert.deepEqual(await store.open(project.id), project);
    assert.deepEqual(await readFile(join(root, `${project.id}.json`)), projectBytes);
    assert.deepEqual(await store.listCadPreviewAttachments(project.id), []);
    await assert.rejects(lstat(join(root, project.id, 'attachments')), { code: 'ENOENT' });
  });
});

test('重复内容以 SHA-256 同址去重，读取时重验摘要并返回原始字节', async () => {
  await withStore(async (root, store) => {
    const project = await makeProject(store);
    const bytes = makeBinaryStl();
    const expectedHash = createHash('sha256').update(bytes).digest('hex');
    const first = await store.addCadPreviewAttachment(project.id, 'fixture.stl', '.stl', bytes);
    const duplicate = await store.addCadPreviewAttachment(project.id, 'another-name.stl', '.stl', Buffer.from(bytes));
    assert.equal(first.sha256, expectedHash);
    assert.deepEqual(duplicate, first);
    assert.deepEqual(await store.listCadPreviewAttachments(project.id), [first]);
    assert.deepEqual(await readFile(objectPath(root, project.id, expectedHash)), bytes);

    const reopened = await store.openCadPreviewAttachment(project.id, expectedHash);
    assert.deepEqual(Buffer.from(reopened.bytes), bytes);
    assert.equal(reopened.name, 'fixture.stl');
    assert.equal(reopened.extension, '.stl');
    assert.equal(reopened.byteLength, bytes.byteLength);

    const changed = Buffer.from(bytes);
    changed[100] ^= 1;
    const object = objectPath(root, project.id, expectedHash);
    await writeFile(object, changed);
    await assert.rejects(
      store.openCadPreviewAttachment(project.id, expectedHash),
      { code: 'CORE_ATTACHMENT_CORRUPT' }
    );
    assert.deepEqual(await readFile(object), changed, 'corrupt content-addressed objects are rejected, never overwritten');
  });
});

test('复制失败不会更改旧索引或任何已登记附件', async () => {
  await withStore(async (root, store) => {
    const project = await makeProject(store);
    const original = makeBinaryStl(1);
    const first = await store.addCadPreviewAttachment(project.id, 'first.stl', '.stl', original);
    const indexBefore = await readFile(indexPath(root, project.id));
    const firstObjectBefore = await readFile(objectPath(root, project.id, first.sha256));
    const failingStore = new CoreProjectStore(root, {
      linkAttachment: async () => { throw new Error('injected content object link failure'); }
    });

    await assert.rejects(
      failingStore.addCadPreviewAttachment(project.id, 'second.stl', '.stl', makeBinaryStl(2)),
      { code: 'CORE_ATTACHMENT_COPY_FAILED' }
    );
    assert.deepEqual(await readFile(indexPath(root, project.id)), indexBefore);
    assert.deepEqual(await store.listCadPreviewAttachments(project.id), [first]);
    assert.deepEqual(await readFile(objectPath(root, project.id, first.sha256)), firstObjectBefore);
    assert.deepEqual(await store.open(project.id), project);
    assert.deepEqual((await readdir(join(root, project.id, 'attachments'))).filter((name) => name.endsWith('.tmp')), []);
  });
});

test('原子索引替换失败保留旧索引和现有附件，未提交的新对象不进入可见索引', async () => {
  await withStore(async (root, store) => {
    const project = await makeProject(store);
    const first = await store.addCadPreviewAttachment(project.id, 'first.stl', '.stl', makeBinaryStl(1));
    const indexBefore = await readFile(indexPath(root, project.id));
    const existingObjectBefore = await readFile(objectPath(root, project.id, first.sha256));
    const failingStore = new CoreProjectStore(root, {
      replaceAttachmentIndex: async () => { throw new Error('injected atomic index replacement failure'); }
    });

    await assert.rejects(
      failingStore.addCadPreviewAttachment(project.id, 'second.stl', '.stl', makeBinaryStl(2)),
      { code: 'CORE_ATTACHMENT_INDEX_WRITE_FAILED' }
    );
    assert.deepEqual(await readFile(indexPath(root, project.id)), indexBefore);
    assert.deepEqual(await store.listCadPreviewAttachments(project.id), [first]);
    assert.deepEqual(await readFile(objectPath(root, project.id, first.sha256)), existingObjectBefore);
    assert.deepEqual(await store.open(project.id), project);
    const index = JSON.parse(indexBefore.toString('utf8'));
    assert.equal(index.attachments.length, 1);
    const directoryEntries = await readdir(join(root, project.id, 'attachments'));
    assert.deepEqual(directoryEntries.filter((name) => name.startsWith('.index-v1.') && name.endsWith('.tmp')), []);
  });
});

test('同一项目的并发重复添加串行合并为一个不可变附件索引条目', async () => {
  await withStore(async (root, store) => {
    const project = await makeProject(store);
    const bytes = makeBinaryStl();
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      store.addCadPreviewAttachment(project.id, `parallel-${index}.stl`, '.stl', Buffer.from(bytes))
    ));
    const attachments = await store.listCadPreviewAttachments(project.id);
    assert.equal(attachments.length, 1);
    assert.equal(new Set(results.map((result) => result.sha256)).size, 1);
    assert.equal(new Set(results.map((result) => result.name)).size, 1);
    assert.deepEqual(await store.openCadPreviewAttachment(project.id, attachments[0].sha256).then((result) => Buffer.from(result.bytes)), bytes);
    assert.deepEqual((await readdir(join(root, project.id, 'attachments'))).sort(), [attachments[0].sha256, 'index-v1.json'].sort());
  });
});

test('不安全项目 ID、附件摘要、扩展名及文件名在派生存储路径前拒绝', async () => {
  await withStore(async (root, store) => {
    const project = await makeProject(store);
    const bytes = makeBinaryStl();
    for (const unsafeId of ['../outside', `${project.id}/../../outside`, 'not-a-uuid']) {
      await assert.rejects(store.listCadPreviewAttachments(unsafeId), { code: 'CORE_PROJECT_INVALID' });
      await assert.rejects(store.addCadPreviewAttachment(unsafeId, 'safe.stl', '.stl', bytes), { code: 'CORE_PROJECT_INVALID' });
    }
    await assert.rejects(store.openCadPreviewAttachment(project.id, '../outside'), { code: 'CORE_ATTACHMENT_INVALID' });
    await assert.rejects(store.openCadPreviewAttachment(project.id, 'a'.repeat(63)), { code: 'CORE_ATTACHMENT_INVALID' });
    await assert.rejects(store.addCadPreviewAttachment(project.id, '../escape.stl', '.stl', bytes), { code: 'CORE_ATTACHMENT_INVALID' });
    await assert.rejects(store.addCadPreviewAttachment(project.id, 'wrong.stp', '.stp', bytes), { code: 'CORE_ATTACHMENT_INVALID' });
    assert.deepEqual(await store.listCadPreviewAttachments(project.id), []);
    assert.deepEqual(await readdir(root), [`${project.id}.json`]);
  });
});

test('附件目录与索引符号链接均失败关闭，不触及链接目标', async () => {
  await withStore(async (root, store) => {
    const outside = join(root, '..', `outside-${process.pid}-${Date.now()}`);
    await mkdir(outside);
    try {
      const projectWithLinkedDirectory = await makeProject(store, '附件目录链接测试');
      await symlink(outside, join(root, projectWithLinkedDirectory.id), 'dir');
      await assert.rejects(
        store.addCadPreviewAttachment(projectWithLinkedDirectory.id, 'linked.stl', '.stl', makeBinaryStl()),
        { code: 'CORE_ATTACHMENT_STORAGE_ERROR' }
      );
      assert.deepEqual(await readdir(outside), []);

      const projectWithLinkedIndex = await makeProject(store, '索引链接测试');
      const attachment = await store.addCadPreviewAttachment(projectWithLinkedIndex.id, 'safe.stl', '.stl', makeBinaryStl());
      const index = indexPath(root, projectWithLinkedIndex.id);
      await rm(index);
      const outsideIndex = join(outside, 'index-target.json');
      await symlink(outsideIndex, index);
      await assert.rejects(store.listCadPreviewAttachments(projectWithLinkedIndex.id), { code: 'CORE_ATTACHMENT_INDEX_CORRUPT' });
      await assert.rejects(lstat(outsideIndex), { code: 'ENOENT' });
      assert.ok(await lstat(objectPath(root, projectWithLinkedIndex.id, attachment.sha256)));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
