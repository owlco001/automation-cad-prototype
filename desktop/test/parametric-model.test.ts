import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addFeature,
  createUndoRedoHistory,
  createParametricStore,
  debouncePlan,
  deserializeDoc,
  docBounds,
  featureBounds,
  findFeature,
  formatBuildStatus,
  makeDoc,
  moveFeature,
  removeFeature,
  renameFeature,
  serializeDoc,
  setSuppressed,
  storageBucketKey,
  toggleSuppressed,
  updateParams,
  type StorageLike
} from '../src/parametric/model.ts';

const NOW = Date.parse('2026-10-23T12:00:00+08:00');

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key)
  };
}

test('model：新建特征分配 f1 并带默认参数', () => {
  const doc = makeDoc([], { now: NOW });
  const { doc: next, feature } = addFeature(doc, 'box', { now: NOW });
  assert.equal(feature.id, 'f1');
  assert.equal(feature.type, 'box');
  assert.equal(feature.params.length, 120);
  assert.equal(next.features.length, 1);
  assert.notEqual(next, doc);
  assert.equal(doc.features.length, 0);
});

test('model：连续新建使用递增 id 与去重默认名称', () => {
  const first = addFeature(makeDoc([], { now: NOW }), 'holes', { now: NOW });
  const second = addFeature(first.doc, 'holes', { now: NOW });
  assert.equal(first.feature.id, 'f1');
  assert.equal(second.feature.id, 'f2');
  assert.equal(first.feature.name, '安装孔');
  assert.equal(second.feature.name, '安装孔 2');
});

test('model：删除特征只移除目标项', () => {
  const first = addFeature(makeDoc([], { now: NOW }), 'box', { now: NOW });
  const second = addFeature(first.doc, 'slot', { now: NOW });
  const next = removeFeature(second.doc, first.feature.id, NOW);
  assert.deepEqual(next.features.map((feature) => feature.id), [second.feature.id]);
});

test('model：上移与下移交换顺序，越界保持原顺序', () => {
  const first = addFeature(makeDoc([], { now: NOW }), 'box', { now: NOW });
  const second = addFeature(first.doc, 'holes', { now: NOW });
  const third = addFeature(second.doc, 'slot', { now: NOW });
  const moved = moveFeature(third.doc, second.feature.id, 'up', NOW);
  assert.deepEqual(moved.features.map((feature) => feature.id), ['f2', 'f1', 'f3']);
  const back = moveFeature(moved, 'f2', 'down', NOW);
  assert.deepEqual(back.features.map((feature) => feature.id), ['f1', 'f2', 'f3']);
  const edge = moveFeature(back, 'f1', 'up', NOW);
  assert.deepEqual(edge.features.map((feature) => feature.id), ['f1', 'f2', 'f3']);
});

test('model：抑制与恢复不改变顺序，恢复后移除 suppressed 字段', () => {
  const base = addFeature(makeDoc([], { now: NOW }), 'box', { now: NOW }).doc;
  const hidden = setSuppressed(base, 'f1', true, NOW);
  assert.equal(hidden.features[0]?.suppressed, true);
  const shown = toggleSuppressed(hidden, 'f1', NOW);
  assert.equal('suppressed' in (shown.features[0] ?? {}), false);
});

test('model：重命名会去空白并拒绝空名称', () => {
  const base = addFeature(makeDoc([], { now: NOW }), 'box', { now: NOW }).doc;
  assert.equal(renameFeature(base, 'f1', '  承板  ', NOW).features[0]?.name, '承板');
  assert.equal(renameFeature(base, 'f1', '   ', NOW).features[0]?.name, '未命名');
});

test('model：参数更新为浅合并且不污染原数组', () => {
  const base = addFeature(makeDoc([], { now: NOW }), 'holes', { now: NOW }).doc;
  const next = updateParams(base, 'f1', { diameter: 8, positions: [[0, 0]] }, NOW);
  assert.equal(next.features[0]?.params.diameter, 8);
  assert.deepEqual(next.features[0]?.params.positions, [[0, 0]]);
  assert.deepEqual(base.features[0]?.params.positions, [[-40, 0], [40, 0]]);
  (next.features[0]?.params.positions as number[][]).push([5, 5]);
  assert.deepEqual(base.features[0]?.params.positions, [[-40, 0], [40, 0]]);
});

test('model：防抖计划在 300 ms 内保持等待', () => {
  const plan = debouncePlan(1_000, 1_120);
  assert.deepEqual(plan, { scheduled: true, waitMs: 180, dueAt: 1_300 });
});

test('model：防抖到点/关闭时立即重建', () => {
  assert.deepEqual(debouncePlan(1_000, 1_300), { scheduled: false, waitMs: 0, dueAt: 1_300 });
  assert.deepEqual(debouncePlan(1_000, 1_010, { enabled: false }), { scheduled: false, waitMs: 0, dueAt: 1_010 });
  assert.deepEqual(debouncePlan(1_000, 1_010, { delayMs: 0 }), { scheduled: false, waitMs: 0, dueAt: 1_000 });
});

test('model：分桶键无来源文件时回退 untitled', () => {
  assert.equal(storageBucketKey(''), 'untitled');
  assert.equal(storageBucketKey('   '), 'untitled');
  assert.equal(storageBucketKey(null), 'untitled');
  assert.equal(storageBucketKey('  bracket.step '), 'bracket.step');
});

test('model：localStorage 按 sourceFile 分桶且文件列表排序', () => {
  const storage = memoryStorage();
  const store = createParametricStore(storage);
  const a = addFeature(makeDoc([], { now: NOW }), 'box', { now: NOW }).doc;
  const b = addFeature(makeDoc([], { now: NOW }), 'slot', { now: NOW }).doc;
  store.set('b.step', b);
  store.set('a.step', a);
  store.set(null, a);
  assert.equal(store.get('a.step')?.features[0]?.type, 'box');
  assert.equal(store.get('missing.step'), null);
  assert.equal(store.get('untitled')?.features[0]?.type, 'box');
  assert.deepEqual(store.files(), ['a.step', 'b.step', 'untitled']);
  assert.ok(storage.data.has('automationcad.parametric.v1'));
});

test('model：序列化往返保留特征、抑制与来源文件', () => {
  const second = addFeature(makeDoc([], { now: NOW }), 'holes', { now: NOW });
  const doc = makeDoc([second.feature], { sourceFile: 'plate.step', now: NOW });
  const withSuppressed = setSuppressed(doc, 'f1', true, NOW);
  const parsed = deserializeDoc(serializeDoc(withSuppressed), NOW);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.doc, withSuppressed);
});

test('model：相同 CAD 文件名的不同 project ID 分桶隔离且不删除旧文件名桶', () => {
  const storage = memoryStorage();
  const store = createParametricStore(storage);
  const projectA = 'acproj-00000000-0000-4000-8000-000000000001';
  const projectB = 'acproj-00000000-0000-4000-8000-000000000002';
  const first = addFeature(makeDoc([], { sourceFile: 'fixture.step', now: NOW }), 'box', { now: NOW }).doc;
  const second = addFeature(makeDoc([], { sourceFile: 'fixture.step', now: NOW }), 'slot', { now: NOW }).doc;
  const legacy = addFeature(makeDoc([], { sourceFile: 'fixture.step', now: NOW }), 'holes', { now: NOW }).doc;
  store.set(projectA, first);
  store.set(projectB, second);
  store.set('fixture.step', legacy);
  assert.equal(store.get(projectA)?.features[0]?.type, 'box');
  assert.equal(store.get(projectB)?.features[0]?.type, 'slot');
  assert.equal(store.get('fixture.step')?.features[0]?.type, 'holes');
});

test('model：非法 JSON 与错误 schema 返回中文错误', () => {
  const broken = deserializeDoc('{not json');
  assert.equal(broken.ok, false);
  assert.match(broken.errors[0] ?? '', /解析失败/);
  const wrong = deserializeDoc(JSON.stringify({ schemaVersion: 2, features: [], updatedAt: NOW }));
  assert.equal(wrong.ok, false);
  assert.ok(wrong.errors.some((error) => error.includes('schemaVersion')));
});

test('model：底部状态精确格式化体积与面数', () => {
  assert.equal(
    formatBuildStatus(50, { faces: 19, volumeMm3: 71_495.7 }),
    '重建 50 ms · 面 19 · 体积 71.5 cm³'
  );
  assert.equal(formatBuildStatus(undefined, null), '尚未重建');
});

test('model：特征包围盒覆盖 box/cylinder/holes', () => {
  const box = addFeature(makeDoc([], { now: NOW }), 'box', { now: NOW });
  assert.deepEqual(featureBounds(box.feature, box.doc), {
    min: [-60, -40, 0],
    max: [60, 40, 8]
  });
  const cylinder = addFeature(makeDoc([], { now: NOW }), 'cylinder', { now: NOW });
  assert.deepEqual(featureBounds(cylinder.feature, cylinder.doc), {
    min: [-10, -10, 8],
    max: [10, 10, 18]
  });
  const holes = addFeature(makeDoc([], { now: NOW }), 'holes', { now: NOW });
  assert.deepEqual(featureBounds(holes.feature, holes.doc), {
    min: [-43, -3, 0],
    max: [43, 3, 8]
  });
});

test('model：fillet 无独立实体时回退整树包围盒', () => {
  const box = addFeature(makeDoc([], { now: NOW }), 'box', { now: NOW });
  const fillet = addFeature(box.doc, 'fillet', { now: NOW });
  assert.equal(featureBounds(fillet.feature, fillet.doc), null);
  assert.deepEqual(docBounds(fillet.doc), {
    min: [-60, -40, 0],
    max: [60, 40, 8]
  });
});

test('model：损坏的 localStorage 内容不会抛异常', () => {
  const storage = memoryStorage({ 'automationcad.parametric.v1': '{oops' });
  const store = createParametricStore(storage);
  assert.equal(store.get('a.step'), null);
  assert.deepEqual(store.files(), []);
});

test('model：findFeature 支持空 id 与不存在 id', () => {
  const doc = addFeature(makeDoc([], { now: NOW }), 'box', { now: NOW }).doc;
  assert.equal(findFeature(doc, 'f1')?.type, 'box');
  assert.equal(findFeature(doc, 'f9'), null);
  assert.equal(findFeature(doc, null), null);
});

test('model：新增特征可撤销和重做，历史快照相互隔离', () => {
  const history = createUndoRedoHistory<ReturnType<typeof makeDoc>>();
  const initial = makeDoc([], { now: NOW });
  const added = addFeature(initial, 'box', { now: NOW }).doc;
  history.push(initial, { now: NOW });
  const undone = history.undo(added);
  assert.deepEqual(undone, initial);
  assert.equal(history.canRedo(), true);
  const redone = history.redo(undone!);
  assert.deepEqual(redone, added);
  assert.equal(history.canUndo(), true);
  assert.equal(history.canRedo(), false);
});

test('model：同一数值字段在合并窗口内连续编辑只占一个撤销点', () => {
  const history = createUndoRedoHistory<ReturnType<typeof makeDoc>>({ mergeWindowMs: 500 });
  const initial = addFeature(makeDoc([], { now: NOW }), 'box', { now: NOW }).doc;
  const first = updateParams(initial, 'f1', { length: 121 }, NOW);
  const second = updateParams(first, 'f1', { length: 122 }, NOW);
  history.push(initial, { mergeKey: 'p1:f1:length', now: 1_000 });
  history.push(first, { mergeKey: 'p1:f1:length', now: 1_200 });
  assert.equal(history.undoCount(), 1);
  assert.deepEqual(history.undo(second), initial);
  assert.deepEqual(history.redo(initial), second);
});

test('model：撤销后分支编辑清空 redo，超限时裁剪最旧撤销点但保留可用 redo 栈', () => {
  const history = createUndoRedoHistory<number>({ limit: 2 });
  history.push(0, { now: 0 });
  history.push(1, { now: 1 });
  history.push(2, { now: 2 });
  assert.equal(history.undoCount(), 2);
  const at2 = history.undo(3);
  const at1 = history.undo(at2!);
  assert.equal(at1, 1);
  assert.equal(history.undo(at1!), null, '最早的历史已裁剪');
  const redone = history.redo(at1!);
  assert.equal(redone, 2);
  history.undo(2);
  history.push(1, { now: 10 });
  assert.equal(history.canRedo(), false, '从撤销位置继续编辑会清空重做分支');
  assert.equal(history.redo(1), null);
});
