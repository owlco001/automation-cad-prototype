import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfirmationQueue } from '../../src/agent/confirmation-queue.ts';
import { mergeLlmConfig, normalizeLlmConfig } from '../../src/agent/llm-config.ts';
import { WriteOperations } from '../../src/agent/write-operations.ts';

test('changing LLM scheme, host or port clears masked credentials; same origin preserves them', () => {
  const config = normalizeLlmConfig({ baseUrl: 'https://models.example.com/v1', apiKey: 'old-key', maxToolCalls: 27 });
  for (const baseUrl of ['https://other.example.com/v1', 'https://models.example.com:8443/v1', 'http://models.example.com/v1', '']) {
    const merged = mergeLlmConfig(config, { baseUrl, apiKey: '****' });
    assert.equal(merged.apiKey, '');
    assert.equal(merged.maxToolCalls, 27);
  }
  assert.equal(mergeLlmConfig(config, { baseUrl: 'https://MODELS.example.com:443/v2' }).apiKey, 'old-key');
  assert.equal(mergeLlmConfig(config, { baseUrl: 'https://other.example.com', apiKey: 'new-key', maxToolCalls: 39 }).maxToolCalls, 39);
  assert.equal(mergeLlmConfig(config, { baseUrl: 'https://other.example.com', apiKey: 'new-key' }).apiKey, 'new-key');
});

test('confirmation queue is bounded, serial, and removes a cancelled queued request', async () => {
  const queue = new ConfirmationQueue(3);
  const cancelled = new AbortController();
  const signal = new AbortController().signal;
  const order = [];
  let finish;
  const first = queue.submit(signal, false, () => new Promise((resolve) => { order.push(1); finish = resolve; }));
  const second = queue.submit(cancelled.signal, false, async () => { order.push(2); return true; });
  const third = queue.submit(signal, false, async () => { order.push(3); return true; });
  assert.equal(await queue.submit(signal, false, async () => { order.push(4); return true; }), false);
  cancelled.abort();
  assert.equal(await second, false);
  assert.deepEqual(order, [1]);
  finish(true);
  assert.equal(await first, true);
  assert.equal(await third, true);
  assert.deepEqual(order, [1, 3]);
});

test('write receipt prevents duplicate execution while pending and after completion', async () => {
  const operations = new WriteOperations();
  const id = 'operation-id-test-001';
  let finish;
  const receipt = { ok: true };
  const first = operations.run('caller', id, 'insert_component', { a: 1, b: 2 }, (started) => {
    started();
    return new Promise((resolve) => { finish = resolve; });
  });
  const unexpected = async () => assert.fail('must not execute a duplicate operation');
  assert.equal((await operations.run('caller', id, 'insert_component', { b: 2, a: 1 }, unexpected)).code, 'WRITE_OPERATION_RECORDED');
  assert.equal((await operations.run('caller', id, 'insert_component', { a: 2, b: 1 }, unexpected)).code, 'WRITE_OPERATION_CONFLICT');
  assert.equal(operations.status('other-caller', id).code, 'WRITE_OPERATION_NOT_FOUND');
  finish({ result: receipt, state: 'finished' });
  assert.deepEqual(await first, receipt);
  assert.deepEqual(await operations.run('caller', id, 'insert_component', { a: 1, b: 2 }, unexpected), receipt);
  assert.deepEqual(operations.status('caller', id), { ok: true, operationId: id, state: 'finished', result: receipt });
});
