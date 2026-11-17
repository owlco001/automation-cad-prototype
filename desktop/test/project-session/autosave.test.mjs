import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectAutosave } from '../../src/project-session/autosave.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(save = async () => ({ ok: true, revision: 'r2' })) {
  let current = { value: 0 };
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  const calls = [];
  const statuses = [];
  const controller = new ProjectAutosave({
    capture: () => current,
    save: (...args) => { calls.push(args); return save(...args); },
    onStatus: (state) => statuses.push(state),
    delayMs: 50,
    setTimer: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  controller.activate('a', 'r1', current);
  return {
    controller, calls, statuses, timers,
    change(value) { current.value = value; controller.markDirty(); },
    poll(value = current.value) { current.value = value; controller.checkForChanges(); },
    replace(value) { current = value; },
    async tick(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of timers) {
        if (timer.at <= now) { timers.delete(id); timer.callback(); }
      }
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

// Promise continuations start the next serialized save without advancing the clock.
async function settle() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

test('unchanged polling leaves a saved session clean without status or timer churn', async () => {
  const f = fixture();
  assert.deepEqual(f.statuses, [{ status: 'saved' }]);
  for (let i = 0; i < 5; i += 1) {
    f.replace({ value: 0 });
    f.controller.checkForChanges();
    await f.tick(100);
  }
  assert.equal(f.controller.isDirty(), false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.statuses, [{ status: 'saved' }]);
});

test('polling detects edits without postponing debounce for repeated identical captures', async () => {
  const f = fixture();
  f.poll(1);
  await f.tick(30);
  f.poll();
  await f.tick(20);
  assert.equal(await f.controller.flush(), true);
  assert.deepEqual(f.calls, [['a', { value: 1 }, 'r1']]);
  const statuses = [...f.statuses];
  f.poll();
  await f.tick(100);
  assert.equal(f.controller.isDirty(), false);
  assert.deepEqual(f.statuses, statuses);
});

test('polling a reverted edit restores saved state without writing', async () => {
  const f = fixture();
  f.poll(1);
  f.poll(0);
  assert.equal(f.controller.isDirty(), false);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.statuses.at(-1), { status: 'saved' });
  await f.tick(100);
  assert.equal(f.calls.length, 0);
});

test('unchanged polling preserves a failed save without automatic retries', async () => {
  const f = fixture(async () => ({ ok: false, message: 'offline' }));
  f.poll(1);
  assert.equal(await f.controller.flush(), false);
  const statuses = [...f.statuses];
  for (let i = 0; i < 3; i += 1) { f.poll(); await f.tick(100); }
  assert.equal(f.calls.length, 1);
  assert.equal(f.controller.isDirty(), true);
  assert.deepEqual(f.statuses, statuses);
});

test('capture errors become dirty errors and polling can recover to the saved baseline', () => {
  const f = fixture();
  const cyclic = {};
  cyclic.self = cyclic;
  f.replace(cyclic);
  assert.doesNotThrow(() => f.controller.checkForChanges());
  assert.equal(f.controller.isDirty(), true);
  assert.equal(f.statuses.at(-1).status, 'error');
  assert.equal(f.timers.size, 0);
  f.replace({ value: 0 });
  f.controller.checkForChanges();
  assert.equal(f.controller.isDirty(), false);
  assert.deepEqual(f.statuses.at(-1), { status: 'saved' });
});

test('polling a return to the previous baseline during flight still saves the revert', async () => {
  const first = deferred();
  const f = fixture(() => f.calls.length === 1 ? first.promise : Promise.resolve({ ok: true }));
  f.poll(1);
  const flushing = f.controller.flush();
  await settle();
  f.poll(0);
  assert.equal(f.controller.isDirty(), true);
  first.resolve({ ok: true, revision: 'r2' });
  assert.equal(await flushing, true);
  assert.deepEqual(f.calls, [['a', { value: 1 }, 'r1'], ['a', { value: 0 }, 'r2']]);
  assert.equal(f.controller.isDirty(), false);
});

test('trailing debounce coalesces edits and skips unchanged JSON snapshots', async () => {
  const f = fixture();
  f.change(1);
  await f.tick(30);
  f.change(2);
  await f.tick(30);
  assert.equal(f.calls.length, 0);
  await f.tick(20);
  assert.equal(await f.controller.flush(), true);
  assert.deepEqual(f.calls, [['a', { value: 2 }, 'r1']]);
  assert.equal(f.controller.isDirty(), false);
  f.change(2);
  assert.equal(await f.controller.flush(), true);
  assert.equal(f.calls.length, 1);
  f.change(3);
  f.change(2);
  assert.equal(await f.controller.flush(), true);
  assert.equal(f.calls.length, 1);
});

test('failed saves stay dirty without automatic retry, then flush retries explicitly', async () => {
  let attempt = 0;
  const f = fixture(async () => ++attempt === 1
    ? { ok: false, message: 'disk full' }
    : { ok: true, revision: 'r2' });
  f.change(1);
  assert.equal(await f.controller.flush(), false);
  assert.equal(f.controller.isDirty(), true);
  assert.deepEqual(f.statuses.at(-1), { status: 'error', message: 'disk full' });
  await f.tick(500);
  assert.equal(f.calls.length, 1);
  assert.equal(await f.controller.flush(), true);
  assert.equal(f.controller.isDirty(), false);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1][2], 'r1');
});

test('rejections are contained and markDirty explicitly schedules a retry', async () => {
  let attempt = 0;
  const f = fixture(async () => {
    if (++attempt === 1) throw new Error('offline');
    return { ok: true };
  });
  f.change(1);
  assert.equal(await f.controller.flush(), false);
  assert.deepEqual(f.statuses.at(-1), { status: 'error', message: 'offline' });
  f.change(2);
  await f.tick(50);
  assert.equal(await f.controller.flush(), true);
  assert.equal(f.calls.length, 2);
});

test('edits in flight are isolated, remain dirty, and serialize with the returned revision', async () => {
  const first = deferred();
  const second = deferred();
  const f = fixture(() => f.calls.length === 1 ? first.promise : second.promise);
  f.change(1);
  const flushing = f.controller.flush();
  await settle();
  f.change(2);
  assert.deepEqual(f.calls[0][1], { value: 1 }, 'capture must not mutate in flight');
  await f.tick(100);
  assert.equal(f.calls.length, 1);
  assert.equal(f.controller.isDirty(), true);
  first.resolve({ ok: true, revision: 'r2' });
  await settle();
  assert.deepEqual(f.calls[1], ['a', { value: 2 }, 'r2']);
  assert.equal(f.controller.isDirty(), true);
  second.resolve({ ok: true, revision: 'r3' });
  assert.equal(await flushing, true);
  assert.equal(f.controller.isDirty(), false);
  assert.equal(f.calls.length, 2);
});

test('old session completion never changes a new activation and saves remain single flight', async () => {
  const old = deferred();
  const f = fixture(() => f.calls.length === 1 ? old.promise : Promise.resolve({ ok: true, revision: 'b2' }));
  f.change(1);
  const oldFlush = f.controller.flush();
  await settle();
  f.controller.activate('b', 'b1', { value: 1 });
  f.change(2);
  const newFlush = f.controller.flush();
  await settle();
  assert.equal(f.calls.length, 1);
  const statusesBeforeCompletion = f.statuses.length;
  old.resolve({ ok: true, revision: 'old-revision' });
  assert.equal(await oldFlush, false);
  assert.equal(await newFlush, true);
  assert.deepEqual(f.calls[1], ['b', { value: 2 }, 'b1']);
  assert.deepEqual(f.statuses.slice(statusesBeforeCompletion), [{ status: 'saving' }, { status: 'saved' }]);
});

test('conflicts block timer and explicit overwrites until a fresh activation', async () => {
  const f = fixture(async () => ({ ok: false, conflict: true, message: 'changed elsewhere' }));
  f.change(1);
  assert.equal(await f.controller.flush(), false);
  assert.deepEqual(f.statuses.at(-1), { status: 'conflict', message: 'changed elsewhere' });
  f.change(2);
  await f.tick(500);
  assert.equal(await f.controller.flush(), false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.controller.isDirty(), true);
  f.controller.activate('a', 'fresh', { value: 2 });
  assert.equal(f.controller.isDirty(), false);
  assert.equal(await f.controller.flush(), true);
});

test('suspend and dispose cancel timers and invalidate asynchronous completions', async () => {
  const pending = deferred();
  const f = fixture(() => pending.promise);
  f.change(1);
  const flushing = f.controller.flush();
  await settle();
  f.change(2);
  f.controller.suspend();
  assert.equal(f.controller.isDirty(), false);
  f.controller.checkForChanges();
  assert.equal(f.controller.isDirty(), false);
  assert.equal(f.timers.size, 0);
  const statusCount = f.statuses.length;
  pending.resolve({ ok: false, conflict: true });
  assert.equal(await flushing, false);
  assert.equal(f.statuses.length, statusCount);
  assert.equal(await f.controller.flush(), false);
  f.controller.activate('b', null, { value: 2 });
  f.change(3);
  f.controller.dispose();
  f.controller.activate('c', null, { value: 3 });
  f.controller.markDirty();
  await f.tick(500);
  assert.equal(await f.controller.flush(), false);
  assert.equal(f.calls.length, 1);
});

test('failure after edits in flight cancels queued retries', async () => {
  const pending = deferred();
  const f = fixture(() => pending.promise);
  f.change(1);
  const flushing = f.controller.flush();
  await settle();
  f.change(2);
  pending.resolve({ ok: false, message: 'offline' });
  assert.equal(await flushing, false);
  await f.tick(500);
  assert.equal(f.calls.length, 1);
  assert.equal(f.controller.isDirty(), true);
});
