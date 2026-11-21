import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import {
  DEFAULTS,
  computeCost,
  estimateCableMeters,
  priceAgeDays
} from '../src/cost/engine.ts';
import { validatePricebook } from '../src/cost/pricebook.ts';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/pricebook.json', import.meta.url), 'utf8')
) as Record<string, any>;
const costCase = JSON.parse(
  readFileSync(new URL('./fixtures/cost-case.json', import.meta.url), 'utf8')
) as Record<string, any>;
const builtin = validatePricebook(
  JSON.parse(
    readFileSync(new URL('../../packs/builtin/pricebook-cn/pricebook.json', import.meta.url), 'utf8')
  )
);

const NOW = '2026-10-23T12:00:00+08:00';

function book(): Record<string, any> {
  return structuredClone(fixture);
}

function run(overrides: Record<string, any> = {}) {
  return computeCost({
    bom: [],
    pricebook: book(),
    now: NOW,
    ...overrides
  });
}

test('阶梯价：恰好命中 minQty 与相邻边界', () => {
  assert.equal(run({ bom: [{ partId: 'PART-QF', name: 'QF', qty: 9 }] }).lines[0]?.unit, 78);
  assert.equal(run({ bom: [{ partId: 'PART-QF', name: 'QF', qty: 10 }] }).lines[0]?.unit, 68);
  assert.equal(run({ bom: [{ partId: 'PART-QF', name: 'QF', qty: 49 }] }).lines[0]?.unit, 68);
  assert.equal(run({ bom: [{ partId: 'PART-QF', name: 'QF', qty: 50 }] }).lines[0]?.unit, 60);
});

test('阶梯价：取满足条件的最高 minQty', () => {
  const report = run({ bom: [{ partId: 'PART-QF', name: 'QF', qty: 120 }] });
  assert.equal(report.lines[0]?.unit, 60);
  assert.equal(report.lines[0]?.subtotal, 7200);
});

test('阶梯价：数量低于全部阶梯时回落到 list', () => {
  const custom = book();
  custom.items['PART-BTN'].tiers = [{ minQty: 5, price: 10 }];
  const report = computeCost({
    bom: [{ partId: 'PART-BTN', name: '按钮', qty: 2 }],
    pricebook: custom,
    now: NOW
  });
  assert.equal(report.lines[0]?.unit, 12);
  assert.equal(report.lines[0]?.subtotal, 24);
});

test('override 优先于用户价格簿，并标记为项目覆盖', () => {
  const report = run({
    bom: [{ partId: 'PART-QF', name: 'QF', qty: 2 }],
    overrides: { 'PART-QF': 1.23 }
  });
  assert.equal(report.lines[0]?.unit, 1.23);
  assert.equal(report.lines[0]?.subtotal, 2.46);
  assert.equal(report.lines[0]?.priceSource, '项目覆盖');
  assert.equal(report.lines[0]?.priceAgeDays, 0);
});

test('override 允许 0 元，且仍算已定价', () => {
  const report = run({
    bom: [{ partId: 'PART-QF', name: 'QF', qty: 1 }],
    overrides: { 'PART-QF': 0 }
  });
  assert.equal(report.lines.length, 1);
  assert.equal(report.lines[0]?.subtotal, 0);
  assert.equal(report.missing.length, 0);
});

test('用户价格簿优先于内置价格簿', () => {
  const builtinBook = book();
  builtinBook.items['PART-PSU'].list = 999;
  const report = computeCost({
    bom: [{ partId: 'PART-PSU', name: '电源', qty: 1 }],
    pricebook: book(),
    builtinPricebook: builtinBook,
    now: NOW
  });
  assert.equal(report.lines[0]?.unit, 150);
});

test('用户价格簿未命中时回退到内置价格簿', () => {
  const user = book();
  user.items = {};
  const report = computeCost({
    bom: [{ partId: 'PART-PSU', name: '电源', qty: 1 }],
    pricebook: user,
    builtinPricebook: book(),
    now: NOW
  });
  assert.equal(report.lines[0]?.unit, 150);
  assert.equal(report.lines[0]?.priceSource, '测试夹具价');
});

test('缺价：有 partId 但价格簿未命中记为 NO_PRICE', () => {
  const report = run({ bom: [{ partId: 'NOT-FOUND', name: '未知件', spec: 'X1', qty: 2 }] });
  assert.equal(report.lines.length, 0);
  assert.deepEqual(report.missing, [{ name: '未知件', spec: 'X1', qty: 2, reason: 'NO_PRICE' }]);
  assert.ok(report.warnings.some((warning) => warning.includes('缺价')));
  assert.ok(report.warnings.some((warning) => warning.includes('NO_PRICE')));
});

test('缺价：没有 partId 或为空时记为 NO_PART_ID', () => {
  const report = run({
    bom: [
      { name: '无编号件', qty: 1 },
      { partId: '   ', name: '空白编号件', qty: 3 }
    ]
  });
  assert.deepEqual(report.missing, [
    { name: '无编号件', qty: 1, reason: 'NO_PART_ID' },
    { name: '空白编号件', qty: 3, reason: 'NO_PART_ID' }
  ]);
  assert.ok(report.warnings.some((warning) => warning.includes('NO_PART_ID')));
});

test('bom 数量非正整数直接抛中文错误', () => {
  for (const qty of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2']) {
    assert.throws(
      () => run({ bom: [{ partId: 'PART-QF', name: 'QF', qty }] }),
      { message: 'BOM 第 1 行数量必须是正整数' }
    );
  }
});

test('空 BOM 返回全零报告且不产生线缆告警', () => {
  const report = run();
  assert.deepEqual(report.lines, []);
  assert.deepEqual(report.byCategory, []);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.labor, { wiring: 0, terminals: 0, assembly: 0, total: 0 });
  assert.deepEqual(report.extras, { dinRail: 0, duct: 0, wire: 0 });
  assert.deepEqual(report.totals, {
    hardware: 0,
    extras: 0,
    labor: 0,
    subtotal: 0,
    markup: 0,
    tax: 0,
    freight: 0,
    grand: 0
  });
  assert.deepEqual(report.warnings, []);
});

test('人工与端子公式：接线点数乘数量，装配按 3 分钟/件', () => {
  const report = run({
    bom: [
      { partId: 'PART-QF', name: 'QF', qty: 2, specs: { 接线点数: 2 } },
      { partId: 'PART-KM', name: 'KM', qty: 1, specs: { 接线点数: 6 } }
    ]
  });
  assert.deepEqual(report.labor, { wiring: 120, terminals: 15, assembly: 18, total: 153 });
});

test('人工公式：接线点数缺省按 2', () => {
  const report = run({ bom: [{ partId: 'PART-QF', name: 'QF', qty: 2 }] });
  assert.deepEqual(report.labor, { wiring: 48, terminals: 6, assembly: 12, total: 66 });
});

test('人工公式：可从 spec 文本解析接线点数并支持每件工时覆盖', () => {
  const report = run({
    bom: [
      {
        partId: 'PART-QF',
        name: 'QF',
        qty: 2,
        spec: '接线点数：7',
        assemblyMinutesPerUnit: 5
      }
    ]
  });
  assert.equal(report.labor.wiring, 168);
  assert.equal(report.labor.terminals, 21);
  assert.equal(report.labor.assembly, 20);
  assert.equal(report.labor.total, 209);
});

test('辅材公式：导轨按 rails×底板宽，线槽按周长', () => {
  const report = run({
    bom: [{ partId: 'PART-QF', name: 'QF', qty: 1 }],
    plate: costCase.plate
  });
  assert.equal(report.extras.dinRail, 21.6);
  assert.equal(report.extras.duct, 61.6);
  assert.equal(report.extras.wire, 0);
  assert.ok(report.warnings.includes('无布置数据，无法估算线缆'));
});

test('线缆公式：相邻元件中心曼哈顿距离 × 1.35，单根最少 0.3 m', () => {
  const close = [
    { id: 'a', partId: 'A', model: 'A', x: 0, y: 0, w: 10, h: 10 },
    { id: 'b', partId: 'B', model: 'B', x: 10, y: 0, w: 10, h: 10 }
  ];
  assert.equal(estimateCableMeters(close), 0.3);
  assert.equal(estimateCableMeters(costCase.placements), 0.705);

  const report = run({
    bom: [{ partId: 'PART-QF', name: 'QF', qty: 1 }],
    placements: costCase.placements,
    plate: costCase.plate,
    wireSection: '2.5'
  });
  assert.equal(report.extras.wire, 3.38);
  assert.equal(report.extras.dinRail, 21.6);
  assert.equal(report.extras.duct, 61.6);
});

test('拒绝非法布局坐标和尺寸，不生成不完整报价', () => {
  const valid = { x: 0, y: 0, w: 10, h: 10 };
  for (const invalid of [{}, null, { ...valid, x: '2' }, { ...valid, y: Infinity }, { ...valid, w: -1 }]) {
    assert.throws(() => run({ placements: [valid, invalid] }), /placements\[1\]/);
  }
  assert.throws(() => run({ placements: {} }), /placements 必须是数组/);
  assert.throws(() => run({ placements: [{}] }), /placements\[0\]/);
});

test('拒绝有限输入运算溢出后的非有限报价', () => {
  assert.throws(() => run({
    bom: [{ partId: 'PART-QF', name: 'QF', qty: 2 }],
    overrides: { 'PART-QF': Number.MAX_VALUE }
  }), /金额/);
});

test('无布置数据时给出线缆估算告警', () => {
  const report = run({ bom: [{ partId: 'PART-QF', name: 'QF', qty: 1 }] });
  assert.ok(report.warnings.includes('无布置数据，无法估算线缆'));
});

test('加成、税、运费只进入 totals，不污染单行价格', () => {
  const report = run({
    bom: [{ partId: 'PART-QF', name: 'QF', qty: 1 }],
    options: { markupRate: 0.1, taxRate: 0.13, freight: 5 }
  });
  assert.equal(report.lines[0]?.unit, 78);
  assert.equal(report.lines[0]?.subtotal, 78);
  assert.equal(report.totals.hardware, 78);
  assert.equal(report.totals.labor, 33);
  assert.equal(report.totals.subtotal, 111);
  assert.equal(report.totals.markup, 11.1);
  assert.equal(report.totals.tax, 15.87);
  assert.equal(report.totals.freight, 5);
  assert.equal(report.totals.grand, 142.97);
});

test('价格过期：超过 180 天告警，恰好 180 天不告警', () => {
  const custom = book();
  custom.items['PART-QF'].updatedAt = '2026-01-01T00:00:00+08:00';
  const updated = Date.parse('2026-01-01T00:00:00+08:00');
  const at180 = new Date(updated + 180 * 24 * 60 * 60 * 1000);
  const at181 = new Date(updated + 181 * 24 * 60 * 60 * 1000);

  const notExpired = computeCost({
    bom: [{ partId: 'PART-QF', name: 'QF', qty: 1 }],
    pricebook: custom,
    now: at180
  });
  assert.equal(notExpired.lines[0]?.priceAgeDays, 180);
  assert.equal(notExpired.warnings.some((warning) => warning.includes('价格过期')), false);

  const expired = computeCost({
    bom: [{ partId: 'PART-QF', name: 'QF', qty: 1 }],
    pricebook: custom,
    now: at181
  });
  assert.equal(expired.lines[0]?.priceAgeDays, 181);
  assert.ok(expired.warnings.some((warning) => warning.includes('价格过期')));
});

test('价龄天数：按自然日向下取整，未来日期按 0', () => {
  assert.equal(priceAgeDays('2026-10-01T00:00:00+08:00', NOW), 22);
  assert.equal(priceAgeDays('2026-10-23T00:00:00+08:00', NOW), 0);
  assert.equal(priceAgeDays('2026-12-01T00:00:00+08:00', NOW), 0);
});

test('排序稳定：重复计算结果一致，分类按名称稳定排序', () => {
  const input = { ...costCase, pricebook: book(), now: NOW };
  const first = computeCost(input);
  const second = computeCost(input);
  assert.deepEqual(first, second);
  assert.deepEqual(first.lines.map((line) => line.partId), [
    'PART-QF',
    'PART-KM',
    'PART-PSU',
    'PART-TB',
    'PART-SENSOR',
    'PART-BTN'
  ]);
  assert.deepEqual(first.byCategory.map((entry) => entry.category), [
    '传感器',
    '按钮',
    '接触器',
    '断路器',
    '电源',
    '端子',
  ]);
  assert.deepEqual(first.byCategory.find((entry) => entry.category === '断路器'), {
    category: '断路器',
    subtotal: 156,
    count: 1
  });
});

test('固定 fixture 汇总与 smoke 口径一致', () => {
  const report = computeCost({ ...costCase, pricebook: book(), now: NOW });
  assert.equal(report.lines.length, 6);
  assert.equal(report.missing.length, 1);
  assert.equal(report.totals.hardware, 547.5);
  assert.equal(report.extras.dinRail, 21.6);
  assert.equal(report.extras.duct, 61.6);
  assert.equal(report.extras.wire, 3.38);
  assert.equal(report.labor.total, 471);
  assert.equal(report.totals.subtotal, 1105.08);
  assert.equal(report.totals.grand, 1398.64);
});

test('500 行 BOM 计算在宽松阈值内完成', () => {
  const bom = Array.from({ length: 500 }, (_, index) => ({
    partId: index % 10 === 0 ? 'NOT-FOUND' : 'PART-QF',
    name: `物料 ${index + 1}`,
    qty: 1
  }));
  const started = performance.now();
  const report = computeCost({ bom, pricebook: book(), now: NOW });
  const elapsed = performance.now() - started;
  assert.equal(report.lines.length + report.missing.length, 500);
  assert.ok(elapsed < 300, `500 行 BOM 耗时 ${elapsed.toFixed(1)} ms`);
});

test('PLC 模块进入同一成本模型，缺价同样标记', () => {
  const report = run({
    bom: [],
    plc: {
      ioPoints: 16,
      modules: [
        { partId: 'PART-QF', qty: 1 },
        { partId: 'NOT-FOUND', qty: 2 }
      ]
    }
  });
  assert.equal(report.lines.length, 1);
  assert.equal(report.lines[0]?.category, 'PLC');
  assert.equal(report.lines[0]?.subtotal, 78);
  assert.deepEqual(report.missing, [{ name: 'PLC 模块 NOT-FOUND', qty: 2, reason: 'NO_PRICE' }]);
});

test('内置价格簿的示例条目不会进入真实报告', () => {
  const report = computeCost({
    bom: [{ partId: 'EXAMPLE-QF-16A', name: '示例断路器', qty: 1 }],
    pricebook: builtin,
    now: NOW
  });
  assert.equal(report.lines.length, 0);
  assert.deepEqual(report.missing, [
    { name: '示例断路器', qty: 1, reason: 'NO_PRICE' }
  ]);
});

test('默认常量与设计文档一致，且允许覆盖单价', () => {
  assert.equal(DEFAULTS.priceMaxAgeDays, 180);
  assert.equal(DEFAULTS.cableWasteFactor, 1.35);
  assert.equal(DEFAULTS.minCableMeters, 0.3);
  assert.equal(DEFAULTS.defaultTerminationPoints, 2);
  assert.equal(DEFAULTS.assemblyMinutesPerUnit, 3);
  assert.equal(DEFAULTS.defaultRailCount, 2);
  assert.equal(DEFAULTS.defaultWireSection, '2.5');
  assert.throws(
    () => run({ bom: [{ partId: 'PART-QF', name: 'QF', qty: 1 }], overrides: { 'PART-QF': -1 } }),
    /项目覆盖价必须是非负有限数/
  );
});
