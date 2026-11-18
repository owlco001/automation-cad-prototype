import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BUFFER_IO_POINT_SPEC, buildBufferIoMapDraft, validateBufferIoMapDraft
} from '../../src/machine/buffer-io-map.ts';
import { MAX_BUFFER_SLOTS } from '../../src/machine/buffer-tower.ts';

const clone = (draft) => ({ ...draft, points: draft.points.map((point) => ({ ...point })), warnings: [...draft.warnings] });

test('缓存塔 IO 草案稳定生成逻辑点位且不伪造地址', () => {
  const result = buildBufferIoMapDraft({ towerCount: 2, slotsPerTower: 8 });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.points.length, 9);
  assert.deepEqual(result.points.map(point => point.id), [
    'upstream-ready', 'upstream-request', 'downstream-ready', 'downstream-request',
    'transfer-done', 'buffer-full', 'buffer-empty', 'buffer-fault', 'backpressure'
  ]);
  assert.ok(result.points.every(point => point.address === null));
  assert.equal(result.points.find(point => point.id === 'buffer-fault').safety, true);
  assert.match(result.warnings[0], /普通 DI/);
});

test('未分配地址的 IO 草案不可执行并返回安全警告', () => {
  const draft = buildBufferIoMapDraft({ towerCount: 1, slotsPerTower: 16 });
  const result = validateBufferIoMapDraft(draft);
  assert.equal(result.ok, false);
  assert.equal(result.executable, false);
  assert.equal(result.errors.length, 9);
  assert.ok(result.warnings.some(warning => warning.includes('独立安全回路')));
});

test('非法缓存塔配置拒绝生成 IO 草案', () => {
  assert.throws(() => buildBufferIoMapDraft({ towerCount: 3, slotsPerTower: 8 }), RangeError);
  assert.throws(() => buildBufferIoMapDraft({ towerCount: 1, slotsPerTower: 0 }), RangeError);
});

test('IO 草案校验以 9 点规范表为准，空表与缺项都失败', () => {
  assert.equal(BUFFER_IO_POINT_SPEC.length, 9);
  const empty = validateBufferIoMapDraft({ schemaVersion: 1, points: [], warnings: [] });
  assert.equal(empty.ok, false);
  assert.equal(empty.executable, false);
  assert.ok(empty.errors.some((error) => error.includes('必须恰好包含 9')));

  const draft = buildBufferIoMapDraft({ towerCount: 1, slotsPerTower: 4 });
  const short = clone(draft);
  short.points.pop();
  const shortResult = validateBufferIoMapDraft(short);
  assert.equal(shortResult.ok, false);
  assert.ok(shortResult.errors.some((error) => error.includes('必须恰好包含 9')));
  assert.ok(shortResult.errors.some((error) => error.includes('缺少规范逻辑点：backpressure')));
});

test('IO 草案校验拒绝重复 id、重复信号与规范表之外的信号', () => {
  const draft = buildBufferIoMapDraft({ towerCount: 1, slotsPerTower: 4 });

  const duplicateId = clone(draft);
  duplicateId.points[1].id = duplicateId.points[0].id;
  const duplicateIdResult = validateBufferIoMapDraft(duplicateId);
  assert.equal(duplicateIdResult.ok, false);
  assert.ok(duplicateIdResult.errors.some((error) => error.includes('id 重复')));

  const duplicateSignal = clone(draft);
  duplicateSignal.points[1].signal = 'UpstreamReady';
  const duplicateSignalResult = validateBufferIoMapDraft(duplicateSignal);
  assert.equal(duplicateSignalResult.ok, false);
  assert.ok(duplicateSignalResult.errors.some((error) => error.includes('逻辑信号重复：UpstreamReady')));

  const unknown = clone(draft);
  unknown.points[8].signal = 'UpstreamRadar';
  const unknownResult = validateBufferIoMapDraft(unknown);
  assert.equal(unknownResult.ok, false);
  assert.ok(unknownResult.errors.some((error) => error.includes('规范表之外的逻辑信号')));
  assert.ok(unknownResult.errors.some((error) => error.includes('backpressure') && error.includes('UpstreamRadar')));
});

test('IO 草案校验拒绝方向、安全属性与规范不一致', () => {
  const draft = buildBufferIoMapDraft({ towerCount: 1, slotsPerTower: 4 });

  const wrongDirection = clone(draft);
  const fullPoint = wrongDirection.points.find((point) => point.id === 'buffer-full');
  fullPoint.direction = 'input';
  const directionResult = validateBufferIoMapDraft(wrongDirection);
  assert.equal(directionResult.ok, false);
  assert.ok(directionResult.errors.some((error) => error.includes('方向应为 output')));

  const wrongSafety = clone(draft);
  const readyPoint = wrongSafety.points.find((point) => point.id === 'upstream-ready');
  readyPoint.safety = true;
  const safetyResult = validateBufferIoMapDraft(wrongSafety);
  assert.equal(safetyResult.ok, false);
  assert.ok(safetyResult.errors.some((error) => error.includes('安全属性与规范表不一致')));
});

test('IO 草案校验拒绝预填地址，且 executable 恒为 false', () => {
  const draft = buildBufferIoMapDraft({ towerCount: 1, slotsPerTower: 4 });
  const prefilled = clone(draft);
  prefilled.points[0].address = 'I0.0';
  const result = validateBufferIoMapDraft(prefilled);
  assert.equal(result.ok, false);
  assert.equal(result.executable, false);
  assert.ok(result.errors.some((error) => error.includes('不允许在草案中预填地址')));
  assert.equal(result.executable, false);
});

test('IO 草案生成同样受槽位总数上限约束', () => {
  assert.doesNotThrow(() => buildBufferIoMapDraft({ towerCount: 2, slotsPerTower: MAX_BUFFER_SLOTS / 2 }));
  assert.throws(() => buildBufferIoMapDraft({ towerCount: 1, slotsPerTower: MAX_BUFFER_SLOTS + 1 }), /不得超过 512/);
  assert.throws(() => buildBufferIoMapDraft({ towerCount: 2, slotsPerTower: 300 }), /不得超过 512/);
});

test('回归 E2：省略 address 键不能变成“校验通过”', () => {
  const draft = buildBufferIoMapDraft({ towerCount: 1, slotsPerTower: 4 });
  const stripped = clone(draft);
  for (const point of stripped.points) delete point.address;
  const result = validateBufferIoMapDraft(stripped);
  assert.equal(result.ok, false);
  assert.equal(result.errors.filter((error) => error.includes('缺少 address 字段')).length, 9);
});

test('回归 E5b：id↔signal 错绑即使方向/安全位自洽也必须失败', () => {
  const draft = buildBufferIoMapDraft({ towerCount: 1, slotsPerTower: 4 });
  const swapped = clone(draft);
  const ready = swapped.points.find((point) => point.id === 'upstream-ready');
  const full = swapped.points.find((point) => point.id === 'buffer-full');
  ready.signal = 'BufferFull';
  full.signal = 'UpstreamReady';
  // 方向与安全位跟着自洽，模拟“把整组语义对调”的错绑。
  ready.direction = 'input';
  full.direction = 'output';
  const result = validateBufferIoMapDraft(swapped);
  assert.equal(result.ok, false, '信号仍在规范表内且方向自洽时也必须按 id 绑定的信号拒绝');
  assert.ok(result.errors.some((error) => error.includes('upstream-ready 的逻辑信号应为 UpstreamReady')));
  assert.ok(result.errors.some((error) => error.includes('buffer-full 的逻辑信号应为 BufferFull')));

  // 只换一处的错绑同样失败（方向不变）。
  const single = clone(draft);
  single.points.find((point) => point.id === 'buffer-fault').signal = 'TransferDone';
  single.points.find((point) => point.id === 'transfer-done').signal = 'BufferFault';
  const singleResult = validateBufferIoMapDraft(single);
  assert.equal(singleResult.ok, false);
  assert.ok(singleResult.errors.some((error) => error.includes('buffer-fault 的逻辑信号应为 BufferFault')));
});

test('回归：非法方向与零槽位配置的错误信息各自可读', () => {
  const draft = buildBufferIoMapDraft({ towerCount: 1, slotsPerTower: 4 });
  const badDirection = clone(draft);
  badDirection.points[0].direction = 'both';
  const directionResult = validateBufferIoMapDraft(badDirection);
  assert.equal(directionResult.ok, false);
  assert.ok(directionResult.errors.some((error) => error.includes('方向必须为 input 或 output')));

  assert.throws(() => buildBufferIoMapDraft({ towerCount: 1, slotsPerTower: 0 }), /slotsPerTower 必须为正整数/);
  assert.throws(() => buildBufferIoMapDraft({ towerCount: 3, slotsPerTower: 8 }), /towerCount 必须为 1 或 2/);
});
