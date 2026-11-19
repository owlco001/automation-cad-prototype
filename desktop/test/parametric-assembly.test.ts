import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_ASSEMBLY_INSTANCES,
  compileOps,
  toAssembly,
  validateAssembly,
  validateFeatures,
  type AssemblyDoc,
  type FeatureDoc,
  type FeatureNode,
  type PartInstance
} from '../src/parametric/features.ts';
import { bomToCsv, toBom, toCostBomRows, toCostInput } from '../src/parametric/bom.ts';
import { computeCost } from '../src/cost/engine.ts';
import {
  createParametricStore,
  deserializeDoc,
  serializeDoc,
  type StorageLike
} from '../src/parametric/model.ts';

const UPDATED = '2026-10-23T12:00:00+08:00';

function box(id = 'f1', name = '底板', params: Record<string, unknown> = {}): FeatureNode {
  return {
    id,
    type: 'box',
    name,
    params: { length: 120, width: 80, height: 8, ...params }
  };
}

function instance(overrides: Partial<PartInstance> = {}): PartInstance {
  return {
    id: 'p1',
    name: '零件 1',
    transform: { x: 0, y: 0, z: 0, rz: 0 },
    features: [box()],
    ...overrides
  };
}

function assembly(instances: PartInstance[] = [instance()]): AssemblyDoc {
  return { schemaVersion: 2, updatedAt: UPDATED, instances };
}

function legacy(features: FeatureNode[] = [box()]): FeatureDoc {
  return { schemaVersion: 1, updatedAt: UPDATED, features };
}

test('assembly：旧 FeatureDoc 自动包成单实体并保留特征', () => {
  const doc = legacy([box('f1'), box('f2', '凸台', { length: 20, width: 20, height: 5 })]);
  const wrapped = toAssembly(doc);
  assert.equal(wrapped.schemaVersion, 2);
  assert.equal(wrapped.instances.length, 1);
  assert.equal(wrapped.instances[0]?.id, 'p1');
  assert.equal(wrapped.instances[0]?.name, '零件 1');
  assert.deepEqual(wrapped.instances[0]?.transform, { x: 0, y: 0, z: 0, rz: 0 });
  assert.deepEqual(wrapped.instances[0]?.features.map((feature) => feature.id), ['f1', 'f2']);
});

test('assembly：toAssembly 不共享数组，修改结果不污染旧文档', () => {
  const doc = legacy();
  const wrapped = toAssembly(doc);
  (wrapped.instances[0]?.features[0]?.params as Record<string, unknown>).length = 999;
  assert.equal(doc.features[0]?.params.length, 120);
});

test('compileOps：旧 FeatureDoc 仍返回算子数组（兼容路径）', () => {
  const result = compileOps(legacy());
  assert.ok(Array.isArray(result));
  assert.deepEqual(result, [{ op: 'box', length: 120, width: 80, height: 8 }]);
});

test('compileOps：装配输出 ops 与每实体 base 变换', () => {
  const source = assembly([
    instance({ id: 'p1', name: '底板', partId: 'BASE-01', transform: { x: 10, y: 0, z: 0, rz: 0 } }),
    instance({
      id: 'p2',
      name: '支架',
      transform: { x: 0, y: 100, z: 5, rz: 30 },
      features: [box('f1', '支架', { length: 60, width: 40, height: 12 })]
    })
  ]);
  const compiled = compileOps(source);
  assert.ok(!Array.isArray(compiled));
  assert.equal(compiled.instances.length, 2);
  assert.deepEqual(compiled.instances[0]?.transform, { x: 10, y: 0, z: 0, rz: 0 });
  assert.deepEqual(compiled.instances[1]?.transform, { x: 0, y: 100, z: 5, rz: 30 });
  assert.equal(compiled.instances[0]?.partId, 'BASE-01');
  assert.equal(compiled.ops.length, 2);
});

test('compileOps：件号源标识保真（默认路径逐字透传，不 trim），校验仍按 trim 判空判重', () => {
  const padded = assembly([
    instance({ id: '  tray-1  ', name: '托板', partId: 'TRAY-01' }),
    instance({ id: 'tower-post-01', name: '立柱', transform: { x: 100, y: 0, z: 0, rz: 0 } }),
    instance({ id: 'tray 1', name: '内部空格', transform: { x: 0, y: 100, z: 0, rz: 0 } }),
    instance({ id: '托板-01', name: '非 ASCII', transform: { x: 0, y: 0, z: 50, rz: 0 } })
  ]);
  assert.deepEqual(validateAssembly(padded), [], '带首尾空格的件号 trim 后非空，校验照旧放行（校验口径不动）');
  const compiled = compileOps(padded);
  assert.ok(!Array.isArray(compiled));
  assert.deepEqual(
    compiled.instances.map((item) => item.id),
    ['  tray-1  ', 'tower-post-01', 'tray 1', '托板-01'],
    '默认路径件号逐字透传：桌面层不许替调用方改写源标识（内部空格 / 非 ASCII 同样原样）'
  );

  // 另一面：校验仍按 trim 判重（'p1' 与 ' p1 ' 视为同一件号 → 报重复），但编译输出逐字保留源串；
  // 首尾空白件号在 identityStep 入口会被内核 400 点名拒绝，所以两条口径不会各自改写。
  const duplicates = assembly([instance({ id: 'p1', name: 'A' }), instance({ id: ' p1 ', name: 'B' })]);
  assert.match(validateAssembly(duplicates).join('\n'), /重复/);
  const compiledDuplicates = compileOps(duplicates);
  assert.ok(!Array.isArray(compiledDuplicates));
  assert.deepEqual(
    compiledDuplicates.instances.map((item) => item.id),
    ['p1', ' p1 '],
    '判重按 trim、透传按原值 —— 归一化只发生在校验里，不改写发给内核的字符串'
  );
});

test('compileOps：实体顺序 + 实体内特征顺序稳定，ops 为拼接结果', () => {
  const source = assembly([
    instance({
      id: 'p2',
      name: '后件',
      features: [
        box('f1', '底板'),
        { id: 'f2', type: 'holes', name: '孔', params: { diameter: 6, positions: [[0, 0]] } }
      ]
    }),
    instance({ id: 'p1', name: '前件', features: [box('f1', '小底板', { length: 20, width: 20, height: 4 })] })
  ]);
  const compiled = compileOps(source);
  assert.deepEqual(compiled.ops.map((op) => op.op), ['box', 'holes', 'box']);
  assert.deepEqual(compiled.instances.map((item) => item.id), ['p2', 'p1']);
  assert.deepEqual(compiled.ops, [...compiled.instances[0]!.ops, ...compiled.instances[1]!.ops]);
});

test('compileOps：装配内抑制特征只跳过该项', () => {
  const source = assembly([instance({
    features: [box('f1'), box('f2', '抑制件', { length: 10, width: 10, height: 2 })]
  })]);
  source.instances[0]!.features[1]!.suppressed = true;
  const compiled = compileOps(source);
  assert.equal(compiled.instances[0]?.ops.length, 1);
  assert.equal(compiled.ops.length, 1);
});

test('compileOps：transform 省略 rz 时按 0 输出', () => {
  const source = assembly([instance({ transform: { x: 5, y: 6, z: 7 } as PartInstance['transform'] })]);
  const compiled = compileOps(source);
  assert.deepEqual(compiled.instances[0]?.transform, { x: 5, y: 6, z: 7, rz: 0 });
});

test('assembly 校验：重复实体 id 返回中文错误', () => {
  const errors = validateAssembly(assembly([
    instance({ id: 'p1' }),
    instance({ id: 'p1', name: '重复件' })
  ]));
  assert.ok(errors.some((message) => message.includes('id「p1」') && message.includes('重复')));
});

test('assembly 校验：transform 非数字被拒绝', () => {
  const errors = validateAssembly(assembly([
    instance({ transform: { x: '10', y: 0, z: 0, rz: 0 } as unknown as PartInstance['transform'] }),
    instance({ id: 'p2', name: '旋转件', transform: { x: 0, y: 0, z: 0, rz: '30' } as unknown as PartInstance['transform'] })
  ]));
  assert.ok(errors.some((message) => message.includes('transform') && message.includes('数字')));
  assert.equal(errors.filter((message) => message.includes('transform')).length >= 2, true);
});

test('assembly 校验：实体数超过上限被拒绝（整机上限定 200，内核单次装配同值）', () => {
  const instances = Array.from({ length: MAX_ASSEMBLY_INSTANCES + 1 }, (_value, index) =>
    instance({ id: `p${index + 1}`, name: `零件 ${index + 1}` })
  );
  const errors = validateAssembly(assembly(instances));
  assert.ok(errors.some((message) => message.includes(`最多支持 ${MAX_ASSEMBLY_INSTANCES} 个实体`)));
});

test('assembly 校验：恰好到上限的实体数允许', () => {
  const instances = Array.from({ length: MAX_ASSEMBLY_INSTANCES }, (_value, index) =>
    instance({ id: `p${index + 1}`, name: `零件 ${index + 1}` })
  );
  assert.deepEqual(validateAssembly(assembly(instances)), []);
});

test('assembly 校验：空装配被拒绝', () => {
  const errors = validateAssembly(assembly([]));
  assert.ok(errors.some((message) => message.includes('装配为空')));
});

test('assembly 校验：不同实体可使用相同特征 id', () => {
  const source = assembly([
    instance({ id: 'p1', features: [box('f1')] }),
    instance({ id: 'p2', name: '零件 2', features: [box('f1', '第二件')] })
  ]);
  assert.deepEqual(validateAssembly(source), []);
});

test('assembly 校验：validateFeatures 接受装配并定位到具体实体', () => {
  const errors = validateFeatures(assembly([
    instance({ id: 'p1' }),
    instance({ id: 'p2', name: '坏件', features: [box('f1', '坏板', { length: 0 })] })
  ]));
  assert.ok(errors.some((message) => message.includes('第 2 个实体（坏件）')));
});

test('BOM：相同 partId 合并数量并保留首次名称/规格', () => {
  const source = assembly([
    instance({ id: 'p1', name: '底板', partId: 'BASE-01' }),
    instance({ id: 'p2', name: '底板（重复）', partId: 'BASE-01', transform: { x: 100, y: 0, z: 0, rz: 0 } }),
    instance({ id: 'p3', name: '支架', partId: 'BRACKET-02', features: [box('f1', '支架', { length: 60, width: 40, height: 12 })] })
  ]);
  const rows = toBom(source);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { no: 1, partId: 'BASE-01', name: '底板', spec: '120×80×8 mm', qty: 2 });
  assert.equal(rows[1]?.partId, 'BRACKET-02');
});

test('BOM：无 partId 按名称合并并显式标记 unmapped', () => {
  const source = assembly([
    instance({ id: 'p1', name: '自制支架' }),
    instance({ id: 'p2', name: '自制支架' }),
    instance({ id: 'p3', name: '垫块' })
  ]);
  const rows = toBom(source);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { no: 1, name: '自制支架', spec: '120×80×8 mm', qty: 2, unmapped: true });
  assert.equal(rows[1]?.unmapped, true);
});

test('BOM：同名但一个映射一个未映射时分成两行', () => {
  const rows = toBom(assembly([
    instance({ id: 'p1', name: '支架', partId: 'BRACKET-01' }),
    instance({ id: 'p2', name: '支架' })
  ]));
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.partId, 'BRACKET-01');
  assert.equal(rows[0]?.unmapped, undefined);
  assert.equal(rows[1]?.unmapped, true);
});

test('BOM：序号按首次出现顺序从 1 连续分配且确定性', () => {
  const source = assembly([
    instance({ id: 'p3', name: 'C', partId: 'C' }),
    instance({ id: 'p1', name: 'A', partId: 'A' }),
    instance({ id: 'p2', name: 'C', partId: 'C' })
  ]);
  const first = toBom(source);
  const second = toBom(source);
  assert.deepEqual(first.map((row) => [row.no, row.partId, row.qty]), [[1, 'C', 2], [2, 'A', 1]]);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('BOM：旧 FeatureDoc 也能生成一行未映射 BOM', () => {
  const rows = toBom(legacy());
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.unmapped, true);
  assert.equal(rows[0]?.qty, 1);
});

test('CSV：UTF-8 BOM、固定表头、未映射列与逗号转义', () => {
  const csv = bomToCsv(toBom(assembly([
    instance({ id: 'p1', name: '底板, A', partId: 'BASE-01' }),
    instance({ id: 'p2', name: '底板, A', partId: 'BASE-01' }),
    instance({ id: 'p3', name: '支架"X"' })
  ])));
  assert.equal(csv.startsWith('\uFEFF序号,物料号,名称,规格,数量,未映射\r\n'), true);
  assert.ok(csv.includes('"底板, A"'));
  assert.ok(csv.includes('BASE-01'));
  assert.ok(csv.includes('"支架""X"""'));
  assert.ok(csv.includes(',2,'));
  assert.ok(csv.endsWith('\r\n'));
});

test('成本联动：映射件带 partId，未映射件不带 partId（NO_PART_ID）', () => {
  const source = assembly([
    instance({ id: 'p1', name: '底板', partId: 'BASE-01' }),
    instance({ id: 'p2', name: '自制支架' })
  ]);
  const input = toCostInput(source);
  assert.equal(input.bom.length, 2);
  assert.equal(input.bom[0]?.partId, 'BASE-01');
  assert.equal('partId' in (input.bom[1] ?? {}), false);
  assert.equal(toCostBomRows(source)[1]?.name, '自制支架');
});

test('成本联动：computeCost 将未映射件记为 NO_PART_ID 且不按 0 计价', () => {
  const source = assembly([
    instance({ id: 'p1', name: '底板', partId: 'BASE-01' }),
    instance({ id: 'p2', name: '自制支架' })
  ]);
  const report = computeCost({
    ...toCostInput(source),
    pricebook: {
      schemaVersion: 1,
      currency: 'CNY',
      updatedAt: '2026-10-01T00:00:00+08:00',
      source: '测试价格簿',
      items: {
        'BASE-01': { list: 10, source: '测试价格簿', updatedAt: '2026-10-01T00:00:00+08:00' }
      },
      labor: { panelWiringPerPoint: 0, terminalPerWire: 0, assemblyHourly: 0 },
      accessories: { dinRail35PerMeter: 0, wireDuctPerMeter: 0, wirePerMeter: { '2.5': 0 } }
    },
    now: UPDATED
  });
  assert.equal(report.lines.length, 1);
  assert.equal(report.lines[0]?.partId, 'BASE-01');
  assert.deepEqual(report.missing.map((item) => [item.name, item.reason]), [['自制支架', 'NO_PART_ID']]);
});

test('BOM/编译：相同输入产生相同 JSON（确定性）', () => {
  const source = assembly([
    instance({ id: 'p2', name: 'B', partId: 'B', transform: { x: 10, y: 20, z: 0, rz: 45 } }),
    instance({ id: 'p1', name: 'A', partId: 'A' })
  ]);
  assert.equal(JSON.stringify(compileOps(source)), JSON.stringify(compileOps(source)));
  assert.equal(JSON.stringify(toBom(source)), JSON.stringify(toBom(source)));
});

test('持久化：装配 JSON 往返保留实体、transform 与 partId', () => {
  const source = assembly([
    instance({ id: 'p2', name: '顶板', partId: 'PLATE-02', transform: { x: 140, y: 0, z: 5, rz: 90 } }),
    instance({ id: 'p1', name: '底板', transform: { x: -10, y: 2, z: 0, rz: 0 } })
  ]);
  const parsed = deserializeDoc(serializeDoc(source));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.doc, source);
});

test('持久化：localStorage 分桶可读写装配文档', () => {
  const data = new Map<string, string>();
  const storage: StorageLike = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key)
  };
  const store = createParametricStore(storage);
  const source = assembly([instance({ id: 'p7', name: '装配件', partId: 'ASM-07' })]);
  store.set('asm.step', source);
  const loaded = store.get('asm.step');
  assert.equal(loaded && 'instances' in loaded ? loaded.instances.length : 0, 1);
  assert.deepEqual(loaded, source);
});
