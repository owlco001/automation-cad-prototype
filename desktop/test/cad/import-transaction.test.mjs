import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cadImportFailureView,
  parseCadImportTransaction
} from '../../src/cad/import-transaction.ts';
import { PROJECT_IDENTITY_STORAGE_KEY } from '../../src/project-archive/identity.ts';

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

const sourceBytes = new Uint8Array([83, 84, 69, 80, 45, 102, 105, 120, 116, 117, 114, 101]);
const projectId = 'acproj-00000000-0000-4000-8000-000000000091';

test('CAD 解析失败时不持久化新工程身份', async () => {
  const storage = new MemoryStorage();
  await assert.rejects(parseCadImportTransaction({
    sourceName: 'bad.step',
    sourceBytes,
    storage,
    parse: async () => { throw new Error('CAD 解析失败'); },
    // 固定 ID 仅用于稳定断言；正式运行继续使用安全随机 UUID。
    onIdentityError: () => {}
  }), /CAD 解析失败/);
  assert.equal(storage.getItem(PROJECT_IDENTITY_STORAGE_KEY), null);
});

test('身份登记发生在解析完成之后，成功结果才返回持久工程身份', async () => {
  const storage = new MemoryStorage();
  let parseSawUncommittedIdentity = false;
  let applySawUncommittedIdentity = false;
  const transaction = await parseCadImportTransaction({
    sourceName: 'good.step',
    sourceBytes,
    storage,
    parse: async () => {
      parseSawUncommittedIdentity = storage.getItem(PROJECT_IDENTITY_STORAGE_KEY) === null;
      return { meshes: 1 };
    },
    apply: async (result, candidate) => {
      applySawUncommittedIdentity = storage.getItem(PROJECT_IDENTITY_STORAGE_KEY) === null
        && result.meshes === 1
        && candidate.projectId === projectId;
    },
    onIdentityError: (error) => { throw error; },
    identityOptions: { createId: () => projectId }
  });
  assert.equal(parseSawUncommittedIdentity, true);
  assert.equal(applySawUncommittedIdentity, true);
  assert.deepEqual(transaction.result, { meshes: 1 });
  assert.equal(transaction.identity.persisted, true);
  assert.equal(transaction.identity.projectId, projectId);
  assert.equal(JSON.parse(storage.getItem(PROJECT_IDENTITY_STORAGE_KEY)).records[transaction.identity.identityKey].projectId, transaction.identity.projectId);
});

test('CAD 解析成功但 viewer 应用失败时不登记新工程身份', async () => {
  const storage = new MemoryStorage();
  await assert.rejects(parseCadImportTransaction({
    sourceName: 'render-failure.step',
    sourceBytes,
    storage,
    parse: async () => ({ meshes: 1 }),
    apply: async () => { throw new Error('CadViewer.load 失败'); },
    onIdentityError: (error) => { throw error; },
    identityOptions: { createId: () => projectId }
  }), /CadViewer.load 失败/);
  assert.equal(storage.getItem(PROJECT_IDENTITY_STORAGE_KEY), null);
});

test('身份登记不可用时仍可完成 CAD 只读解析并以无身份结果返回', async () => {
  const storage = new MemoryStorage();
  storage.setItem(PROJECT_IDENTITY_STORAGE_KEY, '{broken');
  let parseCalled = false;
  let applyCalled = false;
  let identityError = null;
  const transaction = await parseCadImportTransaction({
    sourceName: 'good.step',
    sourceBytes,
    storage,
    parse: async () => {
      parseCalled = true;
      return { meshes: 1 };
    },
    apply: async (result, candidate) => {
      applyCalled = result.meshes === 1 && candidate === null;
    },
    onIdentityError: (error) => { identityError = error; }
  });
  assert.equal(parseCalled, true);
  assert.equal(applyCalled, true);
  assert.deepEqual(transaction.result, { meshes: 1 });
  assert.equal(transaction.identity, null);
  assert.match(identityError.message, /登记损坏/);
  assert.equal(storage.getItem(PROJECT_IDENTITY_STORAGE_KEY), '{broken');
});

test('已有文档时导入失败隐藏空状态和错误遮罩；首次导入失败仍显示错误/空状态', () => {
  assert.deepEqual(cadImportFailureView(true), {
    loadingErrorVisible: false,
    emptyStateVisible: false
  });
  assert.deepEqual(cadImportFailureView(false), {
    loadingErrorVisible: true,
    emptyStateVisible: true
  });
});
