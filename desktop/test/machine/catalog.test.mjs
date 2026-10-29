import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, buildInsertPart } from '../../src/machine/catalog.ts';

test('构件库：类型唯一，且每个都带默认尺寸与落地偏移', () => {
  assert.ok(CATALOG.length >= 6);
  const types = CATALOG.map((entry) => entry.type);
  assert.equal(new Set(types).size, types.length, '类型不能重复');
  for (const entry of CATALOG) {
    assert.ok(entry.label.length > 0);
    if (entry.shape.type === 'box') {
      assert.ok(entry.shape.size.every((value) => value > 0), `${entry.type} 尺寸必须为正`);
    }
  }
});

test('插入：落点是「底面」，中心要加落地偏移；编号从 1 开始且避让已有 id', () => {
  const first = buildInsertPart({ type: 'upright', at: [0, 0, 0], existingIds: [] });
  assert.equal(first.ok, true);
  assert.equal(first.part.id, 'user-upright-1');
  assert.deepEqual(first.part.center, [0, 0, 415]);

  const second = buildInsertPart({ type: 'upright', at: [100, 0, 0], existingIds: ['user-upright-1'] });
  assert.equal(second.part.id, 'user-upright-2');

  const third = buildInsertPart({ type: 'upright', at: [0, 0, 0], existingIds: ['user-upright-1', 'user-upright-2'] });
  assert.equal(third.part.id, 'user-upright-3');
});

test('未知类型与非法坐标都要说清楚原因，不能默默插一个空件', () => {
  const unknown = buildInsertPart({ type: 'rocket', at: [0, 0, 0], existingIds: [] });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /没有类型 rocket/);
  assert.match(unknown.reason, /upright/, '要列出可用类型');

  const bad = buildInsertPart({ type: 'beam', at: [Number.NaN, 0, 0], existingIds: [] });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /数字/);
});

test('改尺寸：盒体按新尺寸落地，中心 z = 新高度/2（底面仍贴地）', () => {
  const result = buildInsertPart({ type: 'upright', at: [0, 0, 0], size: [60, 60, 1200], existingIds: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.part.shape.size, [60, 60, 1200]);
  assert.deepEqual(result.part.center, [0, 0, 600]);
});

test('改尺寸：非法尺寸、超上限、未知类型都要给可操作原因', () => {
  const bad = buildInsertPart({ type: 'upright', at: [0, 0, 0], size: [60, 0, 100], existingIds: [] });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /正数/);

  const huge = buildInsertPart({ type: 'upright', at: [0, 0, 0], size: [60, 60, 6000], existingIds: [] });
  assert.equal(huge.ok, false);
  assert.match(huge.reason, /5000/);

  const notBox = buildInsertPart({
    type: 'cylinder-part',
    at: [0, 0, 0],
    size: [10, 10, 10],
    existingIds: []
  });
  assert.equal(notBox.ok, false);
  assert.match(notBox.reason, /没有类型/);
});
