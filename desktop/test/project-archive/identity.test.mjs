import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  identifyCadModelObjects,
  PROJECT_IDENTITY_STORAGE_KEY,
  resolveCadProjectIdentity
} from '../../src/project-archive/identity.ts';

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

function bytes(...values) {
  return new Uint8Array(values);
}

function mesh(name, positions, path = ['Assembly']) {
  return { name, positions: new Float32Array(positions), indices: null, path };
}

const fixedIds = ['acproj-00000000-0000-4000-8000-000000000001', 'acproj-00000000-0000-4000-8000-000000000002'];

test('same basename with different CAD bytes gets isolated persistent project IDs', async () => {
  const storage = new MemoryStorage();
  let idIndex = 0;
  const createId = () => fixedIds[idIndex++];
  const first = await resolveCadProjectIdentity('fixture.step', bytes(1, 2, 3), storage, { createId });
  const second = await resolveCadProjectIdentity('fixture.step', bytes(1, 2, 4), storage, { createId });

  assert.notEqual(first.sourceSha256, second.sourceSha256);
  assert.notEqual(first.projectId, second.projectId);
  assert.equal(JSON.parse(storage.getItem(PROJECT_IDENTITY_STORAGE_KEY)).records[first.identityKey].projectId, first.projectId);
  assert.equal(JSON.parse(storage.getItem(PROJECT_IDENTITY_STORAGE_KEY)).records[second.identityKey].projectId, second.projectId);
});

test('reopening the exact basename and CAD bytes reuses the persistent project ID', async () => {
  const storage = new MemoryStorage();
  const first = await resolveCadProjectIdentity('fixture.step', bytes(9, 8, 7), storage, {
    createId: () => fixedIds[0]
  });
  const reopened = await resolveCadProjectIdentity('fixture.step', bytes(9, 8, 7), storage, {
    createId: () => fixedIds[1]
  });
  assert.equal(reopened.projectId, first.projectId);
  assert.equal(reopened.persisted, true);
});

test('model object IDs are independent of imported mesh order', async () => {
  const storage = new MemoryStorage();
  const project = await resolveCadProjectIdentity('fixture.step', bytes(4, 5, 6), storage, {
    createId: () => fixedIds[0]
  });
  const left = mesh('left', [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const right = mesh('right', [0, 0, 0, 0, 2, 0, 0, 0, 2], ['Assembly', 'Sub']);
  const forward = await identifyCadModelObjects(project.projectId, project.sourceSha256, [left, right]);
  const reversed = await identifyCadModelObjects(project.projectId, project.sourceSha256, [right, left]);
  assert.equal(forward[0].objectId, reversed[1].objectId);
  assert.equal(forward[1].objectId, reversed[0].objectId);
  assert.ok(forward.every((entry) => entry.objectId && !entry.ambiguous));
});

test('indistinguishable duplicate objects are marked ambiguous, not assigned order-based IDs', async () => {
  const storage = new MemoryStorage();
  const project = await resolveCadProjectIdentity('fixture.step', bytes(1, 1, 1), storage, {
    createId: () => fixedIds[0]
  });
  const duplicate = mesh('part', [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const identities = await identifyCadModelObjects(project.projectId, project.sourceSha256, [duplicate, duplicate]);
  assert.deepEqual(identities.map((entry) => entry.objectId), [null, null]);
  assert.ok(identities.every((entry) => entry.ambiguous));
});

test('corrupt identity registry fails closed without replacing the original record', async () => {
  const storage = new MemoryStorage();
  storage.setItem(PROJECT_IDENTITY_STORAGE_KEY, '{broken');
  await assert.rejects(
    resolveCadProjectIdentity('fixture.step', bytes(1, 2), storage, { createId: () => fixedIds[0] }),
    /登记损坏/
  );
  assert.equal(storage.getItem(PROJECT_IDENTITY_STORAGE_KEY), '{broken');
});

test('different CAD sources cannot share a projectId even if an ID generator collides', async () => {
  const storage = new MemoryStorage();
  await resolveCadProjectIdentity('first.step', bytes(1, 2, 3), storage, { createId: () => fixedIds[0] });
  const before = storage.getItem(PROJECT_IDENTITY_STORAGE_KEY);
  await assert.rejects(
    resolveCadProjectIdentity('second.step', bytes(4, 5, 6), storage, { createId: () => fixedIds[0] }),
    /工程 ID 与另一 CAD 来源重复/
  );
  assert.equal(storage.getItem(PROJECT_IDENTITY_STORAGE_KEY), before);
});
