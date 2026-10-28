// Store 单元验收（不走 HTTP，直接构造 Store）：边界语义比接口测试更容易漏，这里逐条钉住。
import { Store } from './store.mjs';

let n = 0;
const failures = [];
const ok = (cond, label, extra = '') => {
  n += 1;
  if (cond) { console.log(`PASS ${n}: ${label}`); return; }
  failures.push(label);
  console.error(`FAIL ${n}: ${label} ${extra}`);
};

const seed = () => ({
  schemaVersion: 1,
  material: 'steel',
  features: [
    { id: 'f-body', type: 'box', name: '板体', params: { length: 90, width: 90, height: 12, centered: true } },
    { id: 'f-cb-in', type: 'counterbore', name: '沉头孔', params: { diameter: 5.5, cbDiameter: 8.5, cbDepth: 5, depth: 'through', positions: [[-30, -30], [30, -30], [-30, 30], [30, 30]] } },
    { id: 'f-holes-out', type: 'holes', name: '孔阵列', params: { diameter: 5.5, depth: 'through', positions: [[-24, -18], [24, -18], [-24, 18], [24, 18]] } },
    { id: 'f-fillet', type: 'fillet', name: '四角 R3', params: { radius: 3, edges: '|Z' } }
  ],
  updatedAt: '2026-10-28T00:00:00+08:00'
});

const editHeight = (store, revision, height) => store.applyOperation({
  documentId: 'demo-adapter', expectedRevision: revision, actor: 'manual',
  operation: 'updateFeatureParams', featureId: 'f-body', patch: { height }
});
const heightOf = (env) => env.doc.features.find((f) => f.id === 'f-body').params.height;

try {
  // 1. 版本推进与参数
  let store = new Store(seed());
  const first = await editHeight(store, 0, 20);
  ok(first.revision === 1 && heightOf(first) === 20, '写入推进版本并改参数');
  ok(store.envelope().undoDepth === 1 && store.envelope().redoDepth === 0, 'undoDepth/redoDepth 初始正确');

  // 2. 乐观锁：旧版本必须被拒，且不改变文档
  const stale = await editHeight(store, 0, 99);
  ok(stale.error === 'CONFLICT_STALE_REVISION', '旧 revision 被拒', JSON.stringify(stale).slice(0, 100));
  ok(heightOf(store.envelope()) === 20, '被拒后文档不变');

  // 3. undo steps=2：回到两个版本之前
  await editHeight(store, 1, 30);
  const undone2 = await store.undo(2, 'manual', 2);
  ok(undone2.revision === 3 && heightOf(undone2) === 12, 'undo steps=2 回到初始厚度', `h=${heightOf(undone2)}`);
  ok(store.envelope().redoDepth === 1, 'undo 两步只压一个 redo 快照（语义：撤销到的那一版）', `redo=${store.envelope().redoDepth}`);

  // 4. redo 把它放回来
  const redone = await store.redo(3, 'manual', 1);
  ok(redone.revision === 4 && heightOf(redone) === 30, 'redo 回到撤销前的厚度', `h=${heightOf(redone)}`);
  const redoAgain = await store.redo(4, 'manual', 1);
  ok(redoAgain.error === 'REDO_EMPTY', 'redo 栈空再取一次被拒', JSON.stringify(redoAgain).slice(0, 90));

  // 5. undo 越界
  const tooFar = await store.undo(4, 'manual', 99);
  ok(tooFar.error === 'NOT_FOUND', 'undo 越界返回 NOT_FOUND', JSON.stringify(tooFar).slice(0, 90));

  // 6. 未知操作 / 重复 id / 非法材料
  const unknown = await store.applyOperation({ expectedRevision: 4, operation: 'explodeFeature' });
  ok(unknown.error === 'VALIDATION_FAILED', '未知操作被拒');
  const dup = await store.applyOperation({
    expectedRevision: 4, operation: 'createFeature',
    feature: { id: 'f-body', type: 'box', name: 'dup', params: { length: 10, width: 10, height: 10 } }
  });
  ok(dup.error === 'DUPLICATE_ID', '重复 id 被拒');
  const badMaterial = await store.applyOperation({ expectedRevision: 4, operation: 'setMaterial', material: 'mithril' });
  ok(badMaterial.error === 'VALIDATION_FAILED' && /可选/.test(badMaterial.message), '未知材料被拒且列出可选值');

  // 7. 删除唯一基体（其余是孔/圆角）→ REFERENCE_IN_USE
  store = new Store(seed());
  const delBody = await store.applyOperation({ expectedRevision: 0, operation: 'deleteFeature', featureId: 'f-body' });
  ok(delBody.error === 'REFERENCE_IN_USE' && /孔|沉头|fillet|holes|counterbore/.test(delBody.message),
    '删除唯一基体被拒并点名引用方', JSON.stringify(delBody).slice(0, 120));

  // 8. 全部压缩 → 重建失败且版本不变
  store = new Store(seed());
  const suppressAll = await store.applyOperation({
    expectedRevision: 0, operation: 'applyTransaction', operations: [
      { operation: 'setSuppressed', featureId: 'f-body', suppressed: true },
      { operation: 'setSuppressed', featureId: 'f-cb-in', suppressed: true },
      { operation: 'setSuppressed', featureId: 'f-holes-out', suppressed: true },
      { operation: 'setSuppressed', featureId: 'f-fillet', suppressed: true }
    ]
  });
  ok(suppressAll.error === 'REBUILD_FAILED' && store.revision === 0, '全部压缩时重建失败且版本停在 0',
    JSON.stringify(suppressAll).slice(0, 100));

  // 8b. 只压基体（留下孔/圆角孤儿）→ 校验层就该拒（VALIDATION_FAILED），不是等到重建
  store = new Store(seed());
  const orphanOnly = await store.applyOperation({
    expectedRevision: 0, operation: 'setSuppressed', featureId: 'f-body', suppressed: true
  });
  ok(orphanOnly.error === 'VALIDATION_FAILED' && store.revision === 0,
    '压掉基体留下孤儿特征 → 校验层拒绝且版本不变', JSON.stringify(orphanOnly).slice(0, 120));

  // 9. 非法补丁字段（面板白名单外）
  store = new Store(seed());
  const badField = await store.applyOperation({
    expectedRevision: 0, operation: 'updateFeatureParams', featureId: 'f-body', patch: { centered: false }
  });
  ok(badField.error === 'UNKNOWN_FIELD', '白名单外字段被拒（UNKNOWN_FIELD）', JSON.stringify(badField).slice(0, 100));
} catch (error) {
  failures.push('异常');
  console.error('STORE_TEST_FAIL', error);
}

if (failures.length) {
  console.error(`失败 ${failures.length} 条：${failures.join(' | ')}`);
  process.exit(1);
}
console.log(`STORE_OK 全部通过：${n} 条`);
