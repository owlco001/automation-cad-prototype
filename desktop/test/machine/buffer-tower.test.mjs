import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_BUFFER_SLOTS, bufferQueueIo, createBufferQueue, dequeueBufferItem, enqueueBufferItem, removeBufferItem
} from '../../src/machine/buffer-tower.ts';

test('双塔 FIFO 轮询分配并映射层位', () => {
  let state = createBufferQueue({ towerCount: 2, slotsPerTower: 2 });
  const placed = [];
  for (const id of ['p1', 'p2', 'p3', 'p4']) {
    const result = enqueueBufferItem(state, id);
    assert.equal(result.ok, true);
    placed.push(result.slot);
    state = result.state;
  }
  assert.deepEqual(placed.map((slot) => `${slot.tower}${slot.level}`), ['A1', 'B1', 'A2', 'B2']);
  assert.deepEqual(bufferQueueIo(state), { full: true, empty: false, occupied: 4, free: 0, nextTower: 'A' });
  assert.equal(enqueueBufferItem(state, 'p5').reason, 'FULL');
});

test('出队保持 FIFO 并释放原槽位', () => {
  let state = createBufferQueue({ towerCount: 1, slotsPerTower: 2 });
  state = enqueueBufferItem(state, 'p1').state;
  state = enqueueBufferItem(state, 'p2').state;
  const result = dequeueBufferItem(state);
  assert.equal(result.ok, true);
  assert.equal(result.itemId, 'p1');
  assert.deepEqual(result.slot, { tower: 'A', level: 1, occupied: false, itemId: null });
  assert.equal(bufferQueueIo(result.state).free, 1);
});

test('空队列与非法重复输入显式失败', () => {
  const state = createBufferQueue({ towerCount: 1, slotsPerTower: 1 });
  assert.equal(dequeueBufferItem(state).reason, 'EMPTY');
  const filled = enqueueBufferItem(state, 'x').state;
  assert.throws(() => enqueueBufferItem(filled, 'x'), RangeError);
  assert.throws(() => createBufferQueue({ towerCount: 2, slotsPerTower: 0 }), RangeError);
});

test('单塔时 nextTower 不再指向不存在的 B 塔', () => {
  let state = createBufferQueue({ towerCount: 1, slotsPerTower: 2 });
  assert.equal(state.nextTower, 'A');
  const first = enqueueBufferItem(state, 'p1');
  assert.equal(first.ok, true);
  assert.equal(first.state.nextTower, 'A', '单塔入料后下一塔仍应为 A');
  state = enqueueBufferItem(first.state, 'p2').state;
  assert.equal(state.nextTower, 'A');
  assert.equal(bufferQueueIo(state).nextTower, 'A');
  const emptied = dequeueBufferItem(state).state;
  assert.equal(emptied.nextTower, 'A');
  const single = createBufferQueue({ towerCount: 1, slotsPerTower: 1 });
  assert.equal(enqueueBufferItem(single, 'only').state.nextTower, 'A', '单槽单塔也不得产生 B');
});

test('槽位总数有界：超过上限立即 RangeError，且不分配槽位', () => {
  assert.equal(MAX_BUFFER_SLOTS, 512);
  assert.equal(createBufferQueue({ towerCount: 1, slotsPerTower: MAX_BUFFER_SLOTS }).slots.length, 512);
  assert.equal(createBufferQueue({ towerCount: 2, slotsPerTower: 256 }).slots.length, 512);
  assert.throws(() => createBufferQueue({ towerCount: 1, slotsPerTower: MAX_BUFFER_SLOTS + 1 }), /不得超过 512/);
  assert.throws(() => createBufferQueue({ towerCount: 2, slotsPerTower: 257 }), /不得超过 512/);
  const started = Date.now();
  assert.throws(() => createBufferQueue({ towerCount: 1, slotsPerTower: 1_000_000_000 }), /不得超过 512/);
  assert.ok(Date.now() - started < 1000, '超限配置必须在分配前拒绝');
  assert.throws(() => createBufferQueue({ towerCount: 1, slotsPerTower: 2.5 }), /正整数/);
  assert.throws(() => createBufferQueue({ towerCount: 1, slotsPerTower: Number.MAX_SAFE_INTEGER }), /不得超过 512/);
});

test('双塔交错进出仍保持 FIFO 与两塔占用差不超过 1', () => {
  let state = createBufferQueue({ towerCount: 2, slotsPerTower: 4 });
  const order = [];
  const occupancy = () => ['A', 'B'].map((tower) => state.slots.filter((slot) => slot.tower === tower && slot.occupied).length);
  const enqueue = (id) => {
    const result = enqueueBufferItem(state, id);
    assert.equal(result.ok, true);
    state = result.state;
  };
  const dequeue = () => {
    const result = dequeueBufferItem(state);
    assert.equal(result.ok, true);
    order.push(result.itemId);
    state = result.state;
  };
  enqueue('p1');
  enqueue('p2');
  dequeue();
  enqueue('p3');
  dequeue();
  enqueue('p4');
  assert.deepEqual(order, ['p1', 'p2']);
  assert.deepEqual(state.queue, ['p3', 'p4']);
  const [a, b] = occupancy();
  assert.ok(Math.abs(a - b) <= 1, `两塔占用差应 ≤1，实际 A=${a} B=${b}`);
  assert.equal(bufferQueueIo(state).occupied, 2);
});

test('双塔单塔槽位映射与层号连续', () => {
  const double = createBufferQueue({ towerCount: 2, slotsPerTower: 3 });
  assert.deepEqual(double.slots.map((slot) => `${slot.tower}${slot.level}`), ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']);
  const single = createBufferQueue({ towerCount: 1, slotsPerTower: 3 });
  assert.deepEqual(single.slots.map((slot) => `${slot.tower}${slot.level}`), ['A1', 'A2', 'A3']);
});

test('removeBufferItem：按件号精确移除并回收槽位，不动其它件', () => {
  let state = createBufferQueue({ towerCount: 2, slotsPerTower: 2 });
  for (const id of ['p1', 'p2', 'p3']) state = enqueueBufferItem(state, id).state;
  const after = removeBufferItem(state, 'p2');
  assert.deepEqual(after.queue, ['p1', 'p3']);
  assert.equal(bufferQueueIo(after).occupied, 2);
  assert.equal(after.slots.find((slot) => slot.itemId === 'p2'), undefined);
  assert.equal(after.slots.find((slot) => slot.itemId === 'p1').occupied, true);
  assert.deepEqual(state.queue, ['p1', 'p2', 'p3'], '入参不得被就地修改');
});

test('removeBufferItem：件号不存在或状态非法时显式失败', () => {
  const state = createBufferQueue({ towerCount: 1, slotsPerTower: 2 });
  assert.throws(() => removeBufferItem(state, 'ghost'), RangeError);
  assert.throws(() => removeBufferItem(state, '  '), /itemId 必须为非空字符串/);
  assert.throws(() => removeBufferItem(null, 'p1'), /缓存队列状态无效/);
});
