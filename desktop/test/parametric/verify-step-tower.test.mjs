/**
 * `scripts/verify-step-tower.mjs` 的专用测试：给判定器喂**合成证据**，证明它既不放过
 * "丢件"也不误杀"件齐但被布尔并合并"。
 *
 * 为什么要专门测反例：这条门禁的价值全在"整机 STEP 少了 200mm 结构也能红"——
 * 缓存塔 16 层实测就有过一份 86 实体、顶点 z 只到 3636（立柱 3840）却照样过旧门禁的
 * STEP。反例用真实测到的数字写死，回归时一改口径就会在这里断。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TOWER_16,
  buildTowerExportFacts,
  cylinderAllowanceMm,
  evaluateExportBoundary,
  evaluateStepTower,
  readBinaryStlBBox,
  unionBoxes
} from '../../scripts/verify-step-tower.mjs';
import { buildBufferTowerParts, bufferTowerParamsFromConfig } from '../../src/machine/buffer-tower-assembly.ts';
import { conveyorAssembly } from '../../src/machine/conveyor-assembly.ts';
import { geometryToSidecarAssemblies, machineExportParts } from '../../src/machine/geometry-export.ts';
import { WORKPIECE_PART_ID } from '../../src/machine/machine-geometry.ts';

/** 造一份二进制 STL：每个三角形 3 个顶点，坐标由调用方给。 */
function binaryStl(triangles) {
  const buffer = Buffer.alloc(84 + triangles.length * 50);
  buffer.writeUInt32LE(triangles.length, 80);
  triangles.forEach((vertices, index) => {
    let offset = 84 + index * 50;
    // 法向留 0（本门禁不读法向），只写 3 个顶点
    offset += 12;
    for (const [x, y, z] of vertices) {
      buffer.writeFloatLE(x, offset);
      buffer.writeFloatLE(y, offset + 4);
      buffer.writeFloatLE(z, offset + 8);
      offset += 12;
    }
  });
  return buffer;
}

const TRIANGLES = [
  [[0, 0, 0], [10, 0, 0], [0, 20, 0]],
  [[-5, -5, -30], [10, 20, 40], [0, 0, 0]]
];

test('readBinaryStlBBox：二进制 STL 的顶点包络精确到坐标', () => {
  const box = readBinaryStlBBox(binaryStl(TRIANGLES));
  assert.equal(box.triangles, 2);
  assert.deepEqual(box.min, [-5, -5, -30]);
  assert.deepEqual(box.max, [10, 20, 40]);
});

test('readBinaryStlBBox：ASCII STL 明确报错（不能按二进制读出一份假包络）', () => {
  const ascii = Buffer.from('solid part\nfacet normal 0 0 1\nendsolid part\n');
  assert.throws(() => readBinaryStlBBox(ascii), /ASCII STL/);
});

test('readBinaryStlBBox：声明三角形数与字节数不符时报错（截断文件不当成通过）', () => {
  const truncated = binaryStl(TRIANGLES).subarray(0, 84 + 50);
  assert.throws(() => readBinaryStlBBox(truncated), /需要 .* 字节/);
});

test('readBinaryStlBBox：三角形数为 0 报错', () => {
  const empty = Buffer.alloc(84);
  empty.writeUInt32LE(0, 80);
  assert.throws(() => readBinaryStlBBox(empty), /三角形数为 0/);
});

test('unionBoxes：空数组返回 null，并集逐轴取极值', () => {
  assert.equal(unionBoxes([]), null);
  const union = unionBoxes([
    { min: [0, 0, 0], max: [1, 2, 3] },
    { min: [-4, 1, 2], max: [0, 5, 9] }
  ]);
  assert.deepEqual(union.min, [-4, 0, 0]);
  assert.deepEqual(union.max, [1, 5, 9]);
});

test('cylinderAllowanceMm：径向给半径、轴向给 0、含长方体特征给 0（平面端严格 ±1mm）', () => {
  assert.equal(cylinderAllowanceMm({ features: [{ type: 'box', params: {} }] }, 0), 0);
  // 两根同轴圆柱（默认轴 z）：被测轴与之垂直 → 取最大半径 25
  const twoCylinders = {
    features: [
      { type: 'cylinder', params: { diameter: 50 } },
      { type: 'cylinder', params: { diameter: 12 } }
    ]
  };
  assert.equal(cylinderAllowanceMm(twoCylinders, 'x'), 25);
  assert.equal(cylinderAllowanceMm(twoCylinders, 'y'), 25);
  // 沿轴向两个端面圆的顶点是精确的：不给外扩（旧实现这里也给 25，等于 z 端放宽 25mm）
  assert.equal(cylinderAllowanceMm(twoCylinders, 'z'), 0);
  // 水平圆柱（轴 y，Ø50）：x/z 给 25，y 端是端面 → 0
  const horizontal = { features: [{ type: 'cylinder', params: { diameter: 50, height: 900, axis: 'y' } }] };
  assert.equal(cylinderAllowanceMm(horizontal, 'x'), 25);
  assert.equal(cylinderAllowanceMm(horizontal, 2), 25);
  assert.equal(cylinderAllowanceMm(horizontal, 'y'), 0);
  // 箱体 + 输出轴（`lift-motor` 的真实形状）：极值来自平面 → 三个轴都不给外扩
  const motor = {
    features: [
      { type: 'box', params: { length: 180, width: 140, height: 160 } },
      { type: 'cylinder', params: { diameter: 25, height: 70, axis: 'y', at: [0, -60, 0] } }
    ]
  };
  for (const axis of [0, 1, 2]) assert.equal(cylinderAllowanceMm(motor, axis), 0, `axis ${axis}`);
  // 轴向写错/缺失的输入必须显式报错，不能悄悄退化成某个轴
  assert.throws(() => cylinderAllowanceMm(twoCylinders, 'w'), /axis 必须是/);
  assert.throws(() => cylinderAllowanceMm(twoCylinders, undefined), /axis 必须是/);
});

/** 16 层塔（146 件）的"健康"证据：顶点包络与逐件 STL 完全一致、实体 104、逐件合计 150。 */
function healthyTowerFacts(overrides = {}) {
  const parts = [];
  for (let index = 0; index < 146; index += 1) {
    const z = (index % 16) * 180;
    parts.push({
      id: `tower-part-${index}`,
      stlBBox: { min: [-1200, -900, z], max: [1200, 900, z + 40] },
      kernelBBox: { min: [-1200, -900, z], max: [1200, 900, z + 40] },
      volumeMm3: 1e5,
      solids: index < 4 ? 2 : 1
    });
  }
  // 首末件撑起 z 0..3840 / x ±1230 的整机包络（与实测一致）
  parts[0].stlBBox = { min: [-1230, -990, 0], max: [1230, 900, 240] };
  parts[0].kernelBBox = { ...parts[0].stlBBox };
  parts[145].stlBBox = { min: [-1230, -990, 3600], max: [1230, 800, 3840] };
  parts[145].kernelBBox = { ...parts[145].stlBBox };
  return {
    levels: 16,
    expectedParts: 146,
    toleranceMm: 1,
    parts,
    partById: new Map(),
    step: {
      header: 'ISO-10303-21',
      units: 'MM',
      bytes: 2_344_830,
      solids: 104,
      faces: 900,
      bbox: { min: [-1230, -990, 0], max: [1230, 900, 3840], size: [2460, 1890, 3840] }
    },
    merge: { mode: 'fuse' },
    ...overrides
  };
}

test('evaluateStepTower：件齐、包络一致、实体与件数挂钩 → 全绿', () => {
  const result = evaluateStepTower(healthyTowerFacts());
  assert.equal(result.ok, true, JSON.stringify(result.checks.filter((check) => !check.ok)));
  assert.equal(result.checks.every((check) => check.ok), true);
});

test('反例（16 层实测丢件）：75% 实体 + 顶点 z 只到 3636 → 必须红', () => {
  const facts = healthyTowerFacts({
    step: {
      header: 'ISO-10303-21',
      units: 'MM',
      bytes: 828_000,
      solids: 86,
      faces: 700,
      bbox: { min: [-1230, -990, 770], max: [1190, 660, 3636], size: [2420, 1650, 2866] }
    }
  });
  const result = evaluateStepTower(facts);
  assert.equal(result.ok, false);
  const byLabel = new Map(result.checks.map((check) => [check.label, check]));
  // 顶点并集：z 上限差 204mm，远超 ±1mm
  assert.equal(byLabel.get('顶点并集 == 逐件 STL 并集').ok, false);
  // 实体数：86 < ceil(146×0.6)=88，旧累计 fuse 就在这条线上露头
  assert.equal(byLabel.get('实体数（与件数关联）').ok, false);
  assert.match(byLabel.get('实体数（与件数关联）').actual, /^86$/);
});

test('反例（8 层基线实测丢件 47 实体 / z 2196）：即使字节数与面数都很大也必须红', () => {
  const parts = [];
  for (let index = 0; index < 90; index += 1) {
    const z = (index % 8) * 180;
    parts.push({
      id: `layer-part-${index}`,
      stlBBox: { min: [-1230, -930, z], max: [1200, 760, z + 40] },
      kernelBBox: { min: [-1230, -930, z], max: [1200, 760, z + 40] },
      volumeMm3: 1e5,
      solids: index < 4 ? 2 : 1
    });
  }
  parts[0].stlBBox = { min: [-1230, -930, 0], max: [1200, 760, 2400] };
  parts[0].kernelBBox = { ...parts[0].stlBBox };
  const result = evaluateStepTower({
    levels: 8,
    expectedParts: 90,
    toleranceMm: 1,
    parts,
    partById: new Map(),
    step: {
      header: 'ISO-10303-21',
      units: 'MM',
      bytes: 781_970, // 这份"已验收"的 STEP 字节数很大
      solids: 47,
      faces: 264,
      bbox: { min: [-1230, -930, 770], max: [1190, 660, 2196], size: [2420, 1590, 1426] }
    },
    merge: { mode: 'fuse' }
  });
  assert.equal(result.ok, false);
  const byLabel = new Map(result.checks.map((check) => [check.label, check]));
  assert.equal(byLabel.get('字节数（兜底）').ok, true, '字节数这一条本来就过（旧门禁就是这么放行的）');
  assert.equal(byLabel.get('顶点并集 == 逐件 STL 并集').ok, false);
  assert.equal(byLabel.get('实体数（与件数关联）').ok, false);
});

test('反例：整机包络对但少了 1 件 → 件数那一条必须红', () => {
  const facts = healthyTowerFacts();
  facts.parts = facts.parts.slice(0, 145);
  const result = evaluateStepTower(facts);
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((check) => check.label === '逐件 STL 件数').ok, false);
});

test('反例：一个方块冒充整机（1 实体、包络小）→ 实体数与包络都红', () => {
  const facts = healthyTowerFacts({
    step: {
      header: 'ISO-10303-21',
      units: 'MM',
      bytes: 60_000,
      solids: 1,
      faces: 6,
      bbox: { min: [0, 0, 0], max: [100, 100, 100], size: [100, 100, 100] }
    }
  });
  const result = evaluateStepTower(facts);
  assert.equal(result.ok, false);
  const byLabel = new Map(result.checks.map((check) => [check.label, check]));
  assert.equal(byLabel.get('实体数（与件数关联）').ok, false);
  assert.equal(byLabel.get('顶点并集 == 逐件 STL 并集').ok, false);
  assert.equal(byLabel.get('面数 ≥ 件数（兜底）').ok, false);
});

test('回转体极值件的显式外扩：Ø50 滚筒外扩 25mm 内算过，超了必红', () => {
  const parts = [];
  for (let index = 0; index < 90; index += 1) {
    parts.push({
      id: `layer-part-${index}`,
      stlBBox: { min: [-1200, -600, index * 20], max: [1200, 675, index * 20 + 40] },
      kernelBBox: { min: [-1200, -600, index * 20], max: [1200, 675, index * 20 + 40] },
      volumeMm3: 1e5,
      solids: 1
    });
  }
  // 极值件是滚筒：STL 顶点到母线（y 675+25=700），B-Rep 顶点只在接缝（y 675）
  parts[0].stlBBox = { min: [-1230, -930, 0], max: [1200, 700, 2400] };
  parts[0].kernelBBox = { ...parts[0].stlBBox };
  const partById = new Map([['layer-part-0', { id: 'layer-part-0', features: [{ type: 'cylinder', params: { diameter: 50 } }] }]]);
  const base = {
    levels: 8,
    expectedParts: 90,
    toleranceMm: 1,
    parts,
    partById,
    merge: { mode: 'fuse' }
  };
  const stepAt = (maxY, solids) => ({
    header: 'ISO-10303-21',
    units: 'MM',
    bytes: 1_641_305,
    solids,
    faces: 600,
    bbox: { min: [-1230, -930, 0], max: [1200, maxY, 2400], size: [2430, maxY + 930, 2400] }
  });

  const green = evaluateStepTower({ ...base, step: stepAt(675, 55) });
  assert.equal(green.ok, true, JSON.stringify(green.checks.filter((check) => !check.ok)));
  assert.equal(green.allowances[1], 25);

  const red = evaluateStepTower({ ...base, step: stepAt(670, 55) });
  assert.equal(red.ok, false, '相差 30mm 已超出 Ø50 滚筒的 25mm 外扩');
});

test('内核回退复合体 = 门禁失败（检测到丢件不许判 PASS）', () => {
  const result = evaluateStepTower(
    healthyTowerFacts({ merge: { mode: 'compound', fallback: true, reason: 'fuse 包络偏移 204.00mm（>0.5），判定丢件' } })
  );
  const mergeCheck = result.checks.find((check) => check.label === '整机合并路径');
  assert.equal(mergeCheck.ok, false, '回退是「检测到丢件」，不是通过');
  assert.match(mergeCheck.note, /判定丢件/);
  assert.match(mergeCheck.actual, /回退/);
  assert.equal(result.ok, false, '自校验抓到丢件却判绿，等于门禁没用');
});

test('merge 元数据缺失：build 模式必须判红（不许整条检查消失后全绿）', () => {
  const facts = healthyTowerFacts();
  delete facts.merge;
  const result = evaluateStepTower(facts);
  assert.equal(result.ok, false, 'merge=null 时 9 项变 8 项仍全绿，就是静默略过');
  const mergeCheck = result.checks.find((check) => check.label === '整机合并路径');
  assert.ok(mergeCheck, '合并路径这一条必须始终存在');
  assert.equal(mergeCheck.ok, false);
  assert.match(mergeCheck.actual, /merge 元数据缺失/);
  assert.match(mergeCheck.note, /同口径/);

  // 空对象 / 空 mode 同样算缺失（不能因为字段在就当成有证据）
  const blank = evaluateStepTower(healthyTowerFacts({ merge: {} }));
  assert.equal(blank.ok, false);
  assert.equal(blank.checks.find((check) => check.label === '整机合并路径').ok, false);
});

test('compound 且 fallback 未标 true 也必须红（模式本身就是回退）', () => {
  const result = evaluateStepTower(healthyTowerFacts({ merge: { mode: 'compound', fallback: false } }));
  assert.equal(result.ok, false);
  const mergeCheck = result.checks.find((check) => check.label === '整机合并路径');
  assert.equal(mergeCheck.ok, false);
  assert.match(mergeCheck.actual, /compound/);
});

test('file 模式：没有 merge 证据必须判红并明说未验证（裸 STEP 判不了 fuse/compound）', () => {
  const facts = healthyTowerFacts({ mode: 'file' });
  delete facts.merge;
  const result = evaluateStepTower(facts);
  assert.equal(result.ok, false, '--file 不能默默略过合并路径');
  const mergeCheck = result.checks.find((check) => check.label === '整机合并路径');
  assert.equal(mergeCheck.ok, false);
  assert.match(mergeCheck.actual, /未验证/);
  assert.match(mergeCheck.actual, /MANIFOLD_SOLID_BREP/);
  assert.match(mergeCheck.note, /--merge-manifest/);
  // 给了独立证据（构建期 stats.merge）才允许判过
  const withEvidence = evaluateStepTower(healthyTowerFacts({ mode: 'file', merge: { mode: 'fuse', fallback: false } }));
  assert.equal(withEvidence.checks.find((check) => check.label === '整机合并路径').ok, true);
  assert.equal(withEvidence.ok, true, JSON.stringify(withEvidence.checks.filter((check) => !check.ok)));
});

test('反例：逐件 solids 缺失不能按 1 计（build 模式判红；文件模式只判下限）', () => {
  const facts = healthyTowerFacts();
  facts.parts = facts.parts.map(({ solids, ...rest }) => rest);
  const result = evaluateStepTower(facts);
  const check = result.checks.find((item) => item.label === '实体数（与件数关联）');
  assert.equal(check.ok, false);
  assert.match(check.actual, /逐件 solids 缺失 146\/146/);
  assert.match(check.expected, /上限不判/);
  assert.equal(result.ok, false);

  // --file 模式只有 STL、没有逐件实体数：显式声明后只判下限，同样不拿 1 冒充
  const fileMode = evaluateStepTower({ ...facts, mode: 'file' });
  const fileCheck = fileMode.checks.find((item) => item.label === '实体数（与件数关联）');
  assert.equal(fileCheck.ok, true, '104 ≥ ceil(146×0.6)=88');
  assert.match(fileCheck.expected, /上限不判/);
});

test('容差按端取：min 端是平面件时丢 10mm 必须红（旧口径被 max 端 Ø40 放宽到 20mm 会放行）', () => {
  const parts = [];
  for (let index = 0; index < 146; index += 1) {
    parts.push({
      id: `layer-part-${index}`,
      stlBBox: { min: [-1200, -900, 0], max: [1200, 600, 40] },
      solids: 1
    });
  }
  // min 端（y=-900）是箱体（无圆柱，严格 ±1）；max 端（y=695 母线）是 Ø40 升降导柱
  parts[0].id = 'panel-min';
  parts[0].stlBBox = { min: [-1200, -900, 0], max: [1200, 600, 40] };
  parts[1].id = 'post-max';
  parts[1].stlBBox = { min: [-1200, -900, 0], max: [1200, 695, 3840] };
  const partById = new Map([
    ['panel-min', { id: 'panel-min', features: [{ type: 'box', params: {} }] }],
    ['post-max', { id: 'post-max', features: [{ type: 'cylinder', params: { diameter: 40 } }] }]
  ]);
  const stepAt = (minY) => ({
    header: 'ISO-10303-21',
    units: 'MM',
    bytes: 2_301_982,
    solids: 104,
    faces: 900,
    bbox: { min: [-1200, minY, 0], max: [1200, 675, 3840], size: [2400, 675 - minY, 3840] }
  });
  const base = { levels: 16, expectedParts: 146, toleranceMm: 1, parts, partById, merge: { mode: 'fuse' } };

  // 对照：两端都对齐（max 端差 20mm = Ø40 半径，那是 B-Rep 顶点语义，允许）
  const green = evaluateStepTower({ ...base, step: stepAt(-900) });
  assert.equal(green.ok, true, JSON.stringify(green.checks.filter((check) => !check.ok)));
  assert.deepEqual(green.minAllowance, [1, 1, 1], 'min 端极值件是箱体，不给回转体外扩');
  assert.equal(green.maxAllowance[1], 20, 'max 端极值件是 Ø40 导柱，只放宽这一端');

  // 反例：min 端（平面件）丢了 10mm —— 旧实现两端共用 20mm 会放行
  const red = evaluateStepTower({ ...base, step: stepAt(-890) });
  assert.equal(red.ok, false, 'min 端 10mm 的丢件必须红');
  const bboxCheck = red.checks.find((check) => check.label === '顶点并集 == 逐件 STL 并集');
  assert.equal(bboxCheck.ok, false);
  assert.match(bboxCheck.expected, /min ±1\.0\/1\.0\/1\.0/);
});

/* ---------------------------------------------------------------------------
 * 端点负测：外扩必须按「圆柱轴向 vs 被测轴」给，不能按半径不分轴地给。
 * 旧实现（不分轴取最大半径）在这三种情形下都会放行 10~12mm 的丢件。
 * ------------------------------------------------------------------------- */

test('端点负测：极值件是竖直柱（轴 z）→ z 端严格 ±1，x 端才给半径 20', () => {
  const parts = [];
  for (let index = 0; index < 146; index += 1) {
    parts.push({
      id: `box-part-${index}`,
      stlBBox: { min: [-1200, -900, 0], max: [1100, 600, 3840] },
      solids: 1
    });
  }
  // 唯一极值件：Ø40 升降导柱（轴 z），同时撑起 x max（1200）与 z max（3840）
  parts[0].id = 'post-z';
  parts[0].stlBBox = { min: [-1000, -100, 0], max: [1200, 100, 3840] };
  const partById = new Map([
    ['post-z', { id: 'post-z', features: [{ type: 'cylinder', params: { diameter: 40, height: 3840, axis: 'z' } }] }]
  ]);
  const stepAt = (maxZ) => ({
    header: 'ISO-10303-21',
    units: 'MM',
    bytes: 2_301_982,
    solids: 104,
    faces: 900,
    bbox: { min: [-1200, -900, 0], max: [1200, 600, maxZ], size: [2400, 1500, maxZ] }
  });
  const base = { levels: 16, expectedParts: 146, toleranceMm: 1, parts, partById, merge: { mode: 'fuse' } };

  const green = evaluateStepTower({ ...base, step: stepAt(3840) });
  assert.equal(green.ok, true, JSON.stringify(green.checks.filter((check) => !check.ok)));
  assert.equal(green.maxAllowance[0], 20, 'x 与柱轴垂直：母线顶点缺失，给半径 20');
  assert.equal(green.maxAllowance[2], 1, 'z 与柱轴平行：端面圆顶点精确，严格 ±1');

  // 反例：z 端少了 10mm —— 旧实现（z 也给 20）会放行
  const red = evaluateStepTower({ ...base, step: stepAt(3830) });
  assert.equal(red.ok, false, 'z 端差 10mm 必须红');
  assert.equal(red.checks.find((check) => check.label === '顶点并集 == 逐件 STL 并集').ok, false);
  assert.match(red.checks.find((check) => check.label === '顶点并集 == 逐件 STL 并集').expected, /max ±20\.0\/1\.0\/1\.0/);
});

test('端点负测：极值件是水平圆柱（轴 y）→ y 端严格 ±1，x 端才给半径 25', () => {
  const parts = [];
  for (let index = 0; index < 90; index += 1) {
    parts.push({
      id: `box-part-${index}`,
      stlBBox: { min: [-1200, -900, 0], max: [1100, 600, 2400] },
      solids: 1
    });
  }
  // 唯一极值件：Ø50 层传动辊（轴 y），撑起 x max（1200）与 y max（700）
  parts[0].id = 'roller-y';
  parts[0].stlBBox = { min: [-1000, -200, 0], max: [1200, 700, 2400] };
  const partById = new Map([
    ['roller-y', { id: 'roller-y', features: [{ type: 'cylinder', params: { diameter: 50, height: 900, axis: 'y' } }] }]
  ]);
  const stepAt = (maxY) => ({
    header: 'ISO-10303-21',
    units: 'MM',
    bytes: 1_622_322,
    solids: 55,
    faces: 538,
    bbox: { min: [-1200, -900, 0], max: [1200, maxY, 2400], size: [2400, maxY + 900, 2400] }
  });
  const base = { levels: 8, expectedParts: 90, toleranceMm: 1, parts, partById, merge: { mode: 'fuse' } };

  const green = evaluateStepTower({ ...base, step: stepAt(700) });
  assert.equal(green.ok, true, JSON.stringify(green.checks.filter((check) => !check.ok)));
  assert.equal(green.maxAllowance[1], 1, 'y 与辊轴平行：端面圆顶点精确，严格 ±1（旧实现给 25）');
  assert.equal(green.maxAllowance[0], 25, 'x 与辊轴垂直：给半径 25');

  // 反例：y 端少了 10mm —— 旧实现（y 也给 25）会放行
  const red = evaluateStepTower({ ...base, step: stepAt(690) });
  assert.equal(red.ok, false, 'y 端差 10mm 必须红');
  assert.equal(red.checks.find((check) => check.label === '顶点并集 == 逐件 STL 并集').ok, false);
});

test('端点负测：极值件是箱体+输出轴（lift-motor 型）→ 平面端不给 12.5mm（差 12.4mm 必红）', () => {
  const parts = [];
  for (let index = 0; index < 146; index += 1) {
    parts.push({
      id: `box-part-${index}`,
      stlBBox: { min: [-1200, -900, 0], max: [1200, 600, 3840] },
      solids: 1
    });
  }
  // 实测 16 层 x/y min 端的极值件就是它：箱体面撑起 x，非回转体
  parts[0].id = 'lift-motor';
  parts[0].stlBBox = { min: [-1230, -95, 900], max: [-1050, 70, 1060] };
  const partById = new Map([[
    'lift-motor',
    {
      id: 'lift-motor',
      features: [
        { type: 'box', params: { length: 180, width: 140, height: 160 } },
        { type: 'cylinder', params: { diameter: 25, height: 70, axis: 'y', at: [0, -60, 0] } }
      ]
    }
  ]]);
  const stepAt = (minX) => ({
    header: 'ISO-10303-21',
    units: 'MM',
    bytes: 2_301_982,
    solids: 104,
    faces: 900,
    bbox: { min: [minX, -900, 0], max: [1200, 600, 3840], size: [1200 - minX, 1500, 3840] }
  });
  const base = { levels: 16, expectedParts: 146, toleranceMm: 1, parts, partById, merge: { mode: 'fuse' } };

  const green = evaluateStepTower({ ...base, step: stepAt(-1230) });
  assert.equal(green.ok, true, JSON.stringify(green.checks.filter((check) => !check.ok)));
  assert.deepEqual(green.minAllowance, [1, 1, 1], '含长方体特征的极值件不给回转体外扩');

  // 反例：x min 端少 12.4mm —— 旧实现按 Ø25 半径给 12.5mm，正好放行
  const red = evaluateStepTower({ ...base, step: stepAt(-1217.6) });
  assert.equal(red.ok, false, '平面端 12.4mm 的丢件必须红');
  assert.match(red.checks.find((check) => check.label === '顶点并集 == 逐件 STL 并集').expected, /min ±1\.0\/1\.0\/1\.0/);
});

/* ---------------------------------------------------------------------------
 * 导出边界（review P2-5）：生产路径 146、变异不回流、门禁本身不是摆设
 * ------------------------------------------------------------------------- */

/** 与门禁同一份件表（buildBufferTowerParts → conveyorAssembly），STEP 内核输入就是它。 */
function towerTable() {
  const parts = buildBufferTowerParts(bufferTowerParamsFromConfig({ bufferTower: TOWER_16 }));
  return { parts, expectedParts: 146, doc: conveyorAssembly(parts) };
}

/** 拿变异后的几何重算导出/sidecar，其余事实（件表、内核输入）保持不变。 */
function reexport(facts, mutate) {
  const geometry = mutate(facts.geometry);
  return {
    ...facts,
    geometry,
    exportParts: machineExportParts(geometry),
    sidecar: geometryToSidecarAssemblies(geometry, { updatedAt: 'p2-5-mutation' })
  };
}

test('导出边界门禁：生产塔几何（147 刚体）→ 制造导出/sidecar 都是 146，八条证据全绿', () => {
  const facts = buildTowerExportFacts(towerTable());
  assert.equal(facts.geometry.parts.length, 147, '塔几何 = 146 装配 + 1 块板');
  assert.equal(facts.geometry.assemblyPartCount, 146);
  assert.equal(facts.kernelInstances, 146, 'STEP 内核输入仍是 146 件');
  assert.equal(facts.exportParts.length, 146, '制造导出 146（不是 147）');
  assert.equal(facts.sidecar.instances, 146, 'sidecar ⇒ STEP 146 实例');
  const result = evaluateExportBoundary(facts);
  assert.equal(result.ok, true, JSON.stringify(result.checks.filter((check) => !check.ok)));
  assert.equal(result.checks.length, 8, '八条证据一条都不能少（少一条就是静默略过）');
});

test('变异：改板件号 / 改来源标签都不能静默变成 147 实例（门禁必须仍判 146）', () => {
  const base = buildTowerExportFacts(towerTable());
  const plate = base.geometry.parts.find((part) => part.role === 'workpiece');
  assert.equal(plate.id, WORKPIECE_PART_ID);

  const variants = {
    '只改件号（占位体保持原名）': (geometry) => ({
      ...geometry,
      parts: geometry.parts.map((part) => (part === plate ? { ...part, id: 'panel-x' } : part))
    }),
    '件号与占位体一起改': (geometry) => ({
      ...geometry,
      parts: geometry.parts.map((part) => (part === plate ? { ...part, id: 'panel-x' } : part)),
      workpiecePlaceholder: { ...geometry.workpiecePlaceholder, id: 'panel-x' }
    }),
    '只改来源标签（station-generator）': (geometry) => ({ ...geometry, geometrySource: 'station-generator' }),
    '件号 + 来源一起改': (geometry) => ({
      ...geometry,
      geometrySource: 'station-generator',
      parts: geometry.parts.map((part) => (part === plate ? { ...part, id: 'panel-x' } : part))
    }),
    '件号 + role + 来源一起改': (geometry) => ({
      ...geometry,
      geometrySource: 'station-generator',
      parts: geometry.parts.map((part) => (part === plate ? { ...part, id: 'panel-x', role: 'frame' } : part))
    }),
    '占位体被剥掉 + 件号 + 来源一起改': (geometry) => ({
      ...geometry,
      geometrySource: 'station-generator',
      workpiecePlaceholder: undefined,
      parts: geometry.parts.map((part) => (part === plate ? { ...part, id: 'panel-x' } : part))
    })
  };

  for (const [label, mutate] of Object.entries(variants)) {
    const facts = reexport(base, mutate);
    assert.equal(facts.exportParts.length, 146, `${label}：导出必须 146（147 就是 P2-5 的原始症状）`);
    assert.equal(facts.sidecar.instances, 146, `${label}：sidecar 实例数必须是 146，不是 147`);
    const result = evaluateExportBoundary(facts);
    assert.equal(result.ok, true, `${label}：${JSON.stringify(result.checks.filter((check) => !check.ok))}`);
  }
});

test('门禁不是摆设：导出泄漏成 147 / 内核输入被动 / 件表多一件时，证据必须自己变红', () => {
  const base = buildTowerExportFacts(towerTable());
  // 模拟「过滤退化」：导出件集 = 全部碰撞刚体（147），sidecar 也照出 147
  const leakedSidecar = {
    instances: base.geometry.parts.length,
    chunks: [{
      instances: base.geometry.parts.map((part) => ({
        id: part.id,
        transform: { x: part.center[0], y: part.center[1], z: part.center[2], rz: part.rotationZDeg }
      }))
    }]
  };
  const leaked = evaluateExportBoundary({ ...base, exportParts: base.geometry.parts, sidecar: leakedSidecar });
  assert.equal(leaked.ok, false);
  const byLabel = new Map(leaked.checks.map((check) => [check.label, check]));
  assert.equal(byLabel.get('导出边界：制造导出件数 == assemblyPartCount').ok, false);
  assert.equal(byLabel.get('导出边界：制造导出件数 == assemblyPartCount').actual, '147');
  assert.equal(byLabel.get('导出边界：制造导出不含工件板').ok, false);
  assert.match(byLabel.get('导出边界：制造导出不含工件板').actual, /^1 件/);
  assert.equal(byLabel.get('导出边界：sidecar 实例 == assemblyPartCount').ok, false);
  assert.equal(byLabel.get('导出边界：sidecar 不含工件板（⇒ STEP 不会 147 件）').ok, false);

  // 内核输入被导出过滤改动（146 → 147）同样必须红
  const shifted = evaluateExportBoundary({ ...base, kernelInstances: 147 });
  assert.equal(shifted.ok, false);
  assert.equal(shifted.checks.find((check) => check.label === '导出边界：STEP 内核输入仍是 146 件').ok, false);

  // 件表名不副实（多一件 / 重号）：件号逐件对照那一条必须红
  const ghost = evaluateExportBoundary({ ...base, tablePartIds: [...base.tablePartIds, 'ghost-part'] });
  assert.equal(ghost.ok, false);
  assert.equal(ghost.checks.find((check) => check.label === '导出边界：导出件号 == STEP 件表').ok, false);
});

/* ---------------------------------------------------------------------------
 * CLI 级：退出码与参数/文件错误（门禁的价值一半在「红了真的会红」）
 * ------------------------------------------------------------------------- */

const SCRIPT_PATH = fileURLToPath(new URL('../../scripts/verify-step-tower.mjs', import.meta.url));

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8', timeout: 120_000 });
}

/** 桩 STEP：头合法、1 个实体、包络只有 100³（就是 `machine:e2e` 里那种占位产物）。 */
function stubStepText() {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('stub.step','',(),(),'','','');",
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));",
    'ENDSEC;',
    'DATA;',
    "#1=CARTESIAN_POINT('',(0.,0.,0.));",
    "#2=VERTEX_POINT('',#1);",
    "#3=CARTESIAN_POINT('',(100.,100.,100.));",
    "#4=VERTEX_POINT('',#3);",
    "#5=MANIFOLD_SOLID_BREP('',#6);",
    "#6=CLOSED_SHELL('',());",
    '#7=ADVANCED_FACE();',
    'ENDSEC;',
    'END-ISO-10303-21;'
  ].join('\n');
}

test('CLI：--levels 只认 8/16（其它值 exit 2，不当成 16 层跑）', () => {
  const run = runCli(['--levels', '99']);
  assert.equal(run.status, 2, `退出码应为 2，实际 ${run.status}\n${run.stdout}${run.stderr}`);
  assert.match(run.stderr, /--levels 只支持 8 或 16/);
});

test('CLI：--file 指向不存在的文件 exit 2（不静默当通过）', () => {
  const run = runCli(['--file', join(mkdtempSync(join(tmpdir(), 'step-tower-cli-')), 'nope.step')]);
  assert.equal(run.status, 2, `退出码应为 2，实际 ${run.status}\n${run.stdout}`);
  assert.match(run.stdout + run.stderr, /STEP_TOWER FAIL 文件不存在/);
});

test('CLI：--file 喂 1 实体 100³ 的桩 STEP 必须 FAIL/exit 1（真丢件的旧门禁会放行）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'step-tower-cli-'));
  const stepPath = join(dir, 'stub.step');
  writeFileSync(stepPath, stubStepText());
  // 不给 --parts-dir：逐件 STL 一件都读不到 → 件数/包络也必须红
  const run = runCli(['--file', stepPath]);
  assert.equal(run.status, 1, `退出码应为 1，实际 ${run.status}\n${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /FAIL 逐件 STL 件数/);
  assert.match(run.stdout, /FAIL 顶点并集 == 逐件 STL 并集/);
  assert.match(run.stdout, /FAIL 实体数（与件数关联）/);
  assert.match(run.stdout, /FAIL file-check \d+\/\d+/);
  // 合并路径拿不到证据 → 必须判红并明说未验证（不许默默略过）
  assert.match(run.stdout, /FAIL 整机合并路径/);
  assert.match(run.stdout, /未验证/);
  assert.match(run.stdout, /NOTE file 模式不是验收门禁/);
});

test('CLI：--file + --merge-manifest(fuse) 才判合并路径通过；compound 证据必须判红', () => {
  const dir = mkdtempSync(join(tmpdir(), 'step-tower-cli-'));
  const stepPath = join(dir, 'stub.step');
  writeFileSync(stepPath, stubStepText());
  const fuseManifest = join(dir, 'stats.json');
  writeFileSync(fuseManifest, JSON.stringify({ merge: { mode: 'fuse', fallback: false } }));

  const fuseRun = runCli(['--file', stepPath, '--merge-manifest', fuseManifest]);
  assert.match(fuseRun.stdout, /PASS 整机合并路径/, fuseRun.stdout);
  // 桩 STEP 本身仍不合格：合并路径过了也不能整体变绿
  assert.equal(fuseRun.status, 1, `退出码应为 1，实际 ${fuseRun.status}\n${fuseRun.stdout}`);

  const compoundManifest = join(dir, 'stats-compound.json');
  writeFileSync(compoundManifest, JSON.stringify({ merge: { mode: 'compound', fallback: true, reason: '包络偏移 204mm' } }));
  const compoundRun = runCli(['--file', stepPath, '--merge-manifest', compoundManifest]);
  assert.match(compoundRun.stdout, /FAIL 整机合并路径/);
  assert.match(compoundRun.stdout, /回退/);
  assert.equal(compoundRun.status, 1);
});

/**
 * 三种 manifest 形状都必须真的认（注释/文档只许宣称已实现的形状）：
 * `{merge:{mode,fallback}}`、`{mode,fallback}`、`{stats:{merge:{mode,fallback}}}`。
 * 第三种最容易踩：整份内核 stats 直接当 manifest 是最自然的用法，`parsed` 自己是
 * 任何 JSON 对象都成立，候选顺序写错就会先命中它、报成「缺少 merge.mode」。
 */
test('CLI：--merge-manifest 三种形状（merge 包裹 / 扁平 / 整份 stats）都判同一结果', () => {
  const dir = mkdtempSync(join(tmpdir(), 'step-tower-cli-'));
  const stepPath = join(dir, 'stub.step');
  writeFileSync(stepPath, stubStepText());
  const shapes = {
    'wrapped.json': { merge: { mode: 'fuse', fallback: false } },
    'flat.json': { mode: 'fuse', fallback: false },
    'stats.json': { stats: { merge: { mode: 'fuse', fallback: false } }, parts: 146, bytes: 2301982 }
  };
  for (const [name, body] of Object.entries(shapes)) {
    const manifestPath = join(dir, name);
    writeFileSync(manifestPath, JSON.stringify(body));
    const run = runCli(['--file', stepPath, '--merge-manifest', manifestPath]);
    assert.match(run.stdout, /PASS 整机合并路径/, `${name} 应被判成 fuse：\n${run.stdout}`);
    assert.equal(run.status, 1, `${name}：桩 STEP 仍应整体红（合并路径过了不等于整机合格）`);
  }
  // 整份 stats 里的 merge 说 compound → 同样必须红（形状不影响判据）
  const statsCompound = join(dir, 'stats-compound.json');
  writeFileSync(statsCompound, JSON.stringify({ stats: { merge: { mode: 'compound', fallback: true } } }));
  const compoundRun = runCli(['--file', stepPath, '--merge-manifest', statsCompound]);
  assert.match(compoundRun.stdout, /FAIL 整机合并路径/);
  assert.equal(compoundRun.status, 1);
});

test('CLI：--merge-manifest 证据不合格（缺 fallback / 坏 JSON / 无 --file）一律 exit 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'step-tower-cli-'));
  const stepPath = join(dir, 'stub.step');
  writeFileSync(stepPath, stubStepText());

  const noFallback = join(dir, 'no-fallback.json');
  writeFileSync(noFallback, JSON.stringify({ merge: { mode: 'fuse' } }));
  const runNoFallback = runCli(['--file', stepPath, '--merge-manifest', noFallback]);
  assert.equal(runNoFallback.status, 2, `缺 fallback 应 exit 2，实际 ${runNoFallback.status}\n${runNoFallback.stdout}`);
  assert.match(runNoFallback.stderr, /fallback 必须是显式布尔值/);

  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{not json');
  const runBroken = runCli(['--file', stepPath, '--merge-manifest', broken]);
  assert.equal(runBroken.status, 2);
  assert.match(runBroken.stderr, /不是合法 JSON/);

  const runOrphan = runCli(['--levels', '16', '--merge-manifest', noFallback]);
  assert.equal(runOrphan.status, 2, 'build 模式不该接受 manifest（它自己会读内核 stats.merge）');
  assert.match(runOrphan.stderr, /只在 --file 模式有意义/);
});

/**
 * 导出边界门禁必须真的接在 CLI 上（P2-5）：只测纯函数不够 —— 如果 `--file`/build 流程没把它
 * 并进回执，退化时门禁照样全绿。这条用桩 STEP（不需要内核）证明：回执里有导出边界证据、且全过。
 */
test('CLI：--file 模式也跑导出边界门禁，八条证据进同一张回执', () => {
  const dir = mkdtempSync(join(tmpdir(), 'step-tower-cli-'));
  const stepPath = join(dir, 'stub.step');
  writeFileSync(stepPath, stubStepText());
  const manifest = join(dir, 'stats.json');
  writeFileSync(manifest, JSON.stringify({ merge: { mode: 'fuse', fallback: false } }));

  const run = runCli(['--file', stepPath, '--merge-manifest', manifest, '--json']);
  assert.equal(run.status, 1, '桩 STEP 本身仍整体红（导出边界过不等于整机合格）');
  assert.match(run.stdout, /PASS 导出边界：制造导出件数 == assemblyPartCount/);
  assert.match(run.stdout, /PASS 导出边界：STEP 内核输入仍是 146 件/);

  const line = run.stdout.split('\n').find((row) => row.startsWith('STEP_TOWER_JSON '));
  assert.ok(line, `必须输出 JSON 回执：\n${run.stdout}`);
  const payload = JSON.parse(line.slice('STEP_TOWER_JSON '.length));
  assert.equal(payload.exportBoundary?.ok, true, JSON.stringify(payload.exportBoundary?.checks));
  assert.equal(payload.exportBoundary.checks.length, 8);
  const boundaryChecks = payload.checks.filter((check) => check.label.startsWith('导出边界'));
  assert.equal(boundaryChecks.length, 8, '导出边界证据必须并进同一张 checks 回执');
  assert.ok(boundaryChecks.every((check) => check.ok), JSON.stringify(boundaryChecks.filter((check) => !check.ok)));
});
