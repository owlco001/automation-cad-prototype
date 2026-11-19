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
  DECLARED_PRESENCE_POLICY,
  buildTowerExportFacts,
  cylinderAllowanceMm,
  deriveOccludedParts,
  deriveOcclusionAudit,
  evaluateExportBoundary,
  evaluatePartIdentity,
  evaluateStepTower,
  isDeclaredOccludable,
  OCCLUSION_DECLARED_HOSTS,
  readBinaryStlBBox,
  readStepVertexPoints,
  unionBoxes
} from '../../scripts/verify-step-tower.mjs';
import { slotsFromGeometryParts } from '../../scripts/pv-buffer-regenerate.mjs';
import { buildBufferTowerParts, bufferTowerParamsFromConfig } from '../../src/machine/buffer-tower-assembly.ts';
import { buildConveyorParts, conveyorAssembly } from '../../src/machine/conveyor-assembly.ts';
import { geometryToSidecarAssemblies, machineExportParts } from '../../src/machine/geometry-export.ts';
import { WORKPIECE_PART_ID, partWorldBounds } from '../../src/machine/machine-geometry.ts';

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

/**
 * 合成件表（nx×ny×nz 网格，没有 lift-chain）显式选择「声明件可选」策略。
 *
 * 这是**调用方给的策略入参**，不是门禁按件表自己推断的同源过滤：真实 CLI（16 层塔 /
 * 8 层输送基线两个目标）一律传 `required`，合成件表在这里显式 opt-out。
 */
const SYNTHETIC_PRESENCE = Object.freeze({ declaredPresence: DECLARED_PRESENCE_POLICY.OPTIONAL });

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
  // 逐件 B-Rep 占位覆盖（P1-1）：桩 STEP 里根本没有这 146 件的边界 → 必须逐件缺证判红
  assert.match(run.stdout, /FAIL 逐件 B-Rep 占位覆盖/);
  assert.match(run.stdout, /缺证 \d+ 件/);
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

/* ---------------------------------------------------------------------------
 * 逐件 B-Rep 占位覆盖（P1-1）：堵「丢 1 个内部实体仍绿」
 *
 * 这套反例的价值全在「旧证据看不见、新证据看得见」：变异测试在**同一份 facts** 上先把
 * 旧断言跑绿，再从整机 STEP 的顶点集里扣掉一个内部件的全部 B-Rep 顶点 —— 顶点并集、
 * 实体数、件数一条都不动（内部件不撑任何轴极值），逐件占位覆盖必须变红并点名。
 * ------------------------------------------------------------------------- */

/** 一个包络的 8 个角点 == 一件箱体零件的 B-Rep 顶点（与内核真实导出位置一致）。 */
function boxCorners(box) {
  const corners = [];
  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      for (const z of [box.min[2], box.max[2]]) corners.push([x, y, z]);
    }
  }
  return corners;
}

/**
 * 合成件表：nx×ny×nz 网格，每件 100×100×20、间距 200。件数与包络全部算出来，
 * 不出现 90/146 这类写死数字 —— 判据必须能从任意件表派生。
 */
function syntheticGrid(options = {}) {
  const { nx = 4, ny = 3, nz = 2, extraParts = [] } = options;
  const parts = [];
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const cx = (i - (nx - 1) / 2) * 200;
        const cy = (j - (ny - 1) / 2) * 200;
        const cz = k * 200;
        const stlBBox = { min: [cx - 50, cy - 50, cz], max: [cx + 50, cy + 50, cz + 20] };
        parts.push({
          id: `grid-${i}-${j}-${k}`,
          stlBBox,
          kernelBBox: { min: [...stlBBox.min], max: [...stlBBox.max] },
          volumeMm3: 1e5,
          solids: 1
        });
      }
    }
  }
  parts.push(...extraParts);
  const union = unionBoxes(parts.map((part) => part.stlBBox));
  const stepVertices = parts.flatMap((part) => boxCorners(part.stlBBox));
  const facts = {
    levels: nz,
    expectedParts: parts.length,
    toleranceMm: 1,
    parts,
    partById: new Map(),
    stepVertices,
    step: {
      header: 'ISO-10303-21',
      units: 'MM',
      bytes: 2_000_000,
      // 布尔并合并相邻件：实体数少于件数是正常的（实测 90→55、146→104）
      solids: Math.max(1, parts.length - 1),
      faces: parts.length * 6,
      bbox: {
        min: union.min,
        max: union.max,
        size: union.max.map((value, axis) => value - union.min[axis])
      }
    },
    merge: { mode: 'fuse' }
  };
  return { facts, stepVertices };
}

test('readStepVertexPoints：只认 VERTEX_POINT 引用到的三维点（参考几何/二维点不算）', () => {
  const text = [
    'ISO-10303-21;',
    'DATA;',
    "#1=CARTESIAN_POINT('',(0.,0.,0.));",
    "#2=VERTEX_POINT('',#1);",
    "#3=CARTESIAN_POINT('',(10.,20.,30.));",
    "#4=VERTEX_POINT('',#3);",
    "#5=CARTESIAN_POINT('',(99.,99.,99.));", // 参考几何（圆柱轴心之类），没被 VERTEX_POINT 引用
    "#6=CARTESIAN_POINT('',(1.,2.));", // 曲线参数用的二维点
    "#7=VERTEX_POINT('',#6);",
    'ENDSEC;'
  ].join('\n');
  assert.deepEqual(readStepVertexPoints(text), [[0, 0, 0], [10, 20, 30]]);
  assert.deepEqual(readStepVertexPoints(''), [], '空文本不能编出顶点');
  assert.deepEqual(readStepVertexPoints('ISO-10303-21;\nDATA;\nENDSEC;'), []);
});

test('deriveOccludedParts：包络被更大件完全包住才算「被包住」，同尺寸两件互不吃掉', () => {
  const guest = { id: 'guest', box: { min: [-20, -20, -20], max: [20, 20, 20] } };
  const host = { id: 'host', box: { min: [-150, -150, -150], max: [150, 150, 150] } };
  const occluded = deriveOccludedParts([host, guest]);
  assert.equal(occluded.size, 1);
  assert.equal(occluded.get('guest'), 'host');
  assert.equal(occluded.has('host'), false, '宿主不能因为自己也在别人的包里就被剔除');

  // 同尺寸两件（包络完全相同）：不许互相判成"被包住"，否则两件同时失去"必须有证人"的要求
  const twin = { min: [0, 0, 0], max: [10, 10, 10] };
  assert.equal(deriveOccludedParts([{ id: 'a', box: { min: [...twin.min], max: [...twin.max] } }, { id: 'b', box: { min: [...twin.min], max: [...twin.max] } }]).size, 0);
  // 只包含两个方向也不算
  const partialHost = { id: 'partial', box: { min: [-150, -150, 0], max: [150, 150, 5] } };
  assert.equal(deriveOccludedParts([partialHost, guest]).size, 0);
});

test('evaluatePartIdentity：件表每件都在 STEP 顶点集里有证人 → 绿；缺顶点证据判红（不许静默略过）', () => {
  const { facts, stepVertices } = syntheticGrid();
  const result = evaluatePartIdentity({ expectedParts: facts.expectedParts, parts: facts.parts, stepVertices, ...SYNTHETIC_PRESENCE });
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.equal(result.required, facts.parts.length, '网格件没有任何一件被包住');
  assert.equal(result.occluded.length, 0);
  assert.deepEqual(result.unwitnessed, []);
  assert.equal(result.witnessCount.get('grid-0-0-0'), 8, '一件箱体在 STEP 里应有 8 个角点证人');
  assert.match(result.checks[0].expected, new RegExp(`${facts.expectedParts} 件`), '期望值必须从件表派生');

  // 缺证据 ≠ 通过：没给顶点集 / 给空数组都判红并明说
  const missing = evaluatePartIdentity({ expectedParts: facts.expectedParts, parts: facts.parts, ...SYNTHETIC_PRESENCE });
  assert.equal(missing.ok, false);
  assert.match(missing.checks[0].actual, /未提供\/为空/);
  assert.match(missing.checks[0].actual, /缺证据不等于通过/);
  assert.equal(evaluatePartIdentity({ expectedParts: facts.expectedParts, parts: facts.parts, stepVertices: [], ...SYNTHETIC_PRESENCE }).ok, false);

  // 件表件数对不上（少一件）也必须红
  const short = evaluatePartIdentity({
    expectedParts: facts.expectedParts,
    parts: facts.parts.slice(0, -1),
    stepVertices,
    ...SYNTHETIC_PRESENCE
  });
  assert.equal(short.ok, false);
  assert.match(short.checks[0].actual, /件表 \d+ ≠ 期望 \d+/);
});

test('变异自证：从 STEP 顶点集里扣掉 1 个内部件 → 旧断言全绿、逐件占位覆盖必须红', () => {
  const { facts, stepVertices } = syntheticGrid();
  const target = 'grid-1-1-0'; // x/y/z 都不是极值件：丢了不动任何轴的包络
  const targetPart = facts.parts.find((part) => part.id === target);
  assert.ok(targetPart, '件表里必须有这个内部件');

  // 基线：旧 8 条 + 新 1 条全绿
  const before = evaluateStepTower(facts);
  assert.equal(before.ok, true, JSON.stringify(before.checks.filter((check) => !check.ok)));
  assert.equal(evaluatePartIdentity({ expectedParts: facts.expectedParts, parts: facts.parts, stepVertices, ...SYNTHETIC_PRESENCE }).ok, true);

  // 变异：这件在 STEP 里的边界整个不见了（等价于 fuse 把它丢了）
  const removed = new Set(boxCorners(targetPart.stlBBox).map((corner) => corner.join(',')));
  const mutated = stepVertices.filter((vertex) => !removed.has(vertex.join(',')));
  assert.equal(mutated.length, stepVertices.length - 8, '扣掉的正好是这个件的 8 个角点');

  // 旧证据：一无所知 —— 顶点并集没变（不是极值件）、件数没变、实体数没变
  const oldGreen = evaluateStepTower({ ...facts, stepVertices: mutated });
  assert.equal(oldGreen.ok, true, '旧断言看不见内部件缺失，这正是要堵的洞');
  const byLabel = new Map(oldGreen.checks.map((check) => [check.label, check]));
  assert.equal(byLabel.get('顶点并集 == 逐件 STL 并集').ok, true);
  assert.equal(byLabel.get('实体数（与件数关联）').ok, true);
  assert.equal(byLabel.get('逐件 STL 件数').ok, true);

  // 新证据：必须变红，并且点名是哪一件（不是"少了一件"这种没法排查的结论）
  const identity = evaluatePartIdentity({ expectedParts: facts.expectedParts, parts: facts.parts, stepVertices: mutated, ...SYNTHETIC_PRESENCE });
  assert.equal(identity.ok, false, '丢了 1 个内部实体仍然是绿 = 门禁没堵上');
  assert.deepEqual(identity.unwitnessed, [target], '只应该有这一件缺证');
  assert.match(identity.checks[0].actual, /缺证 1 件（grid-1-1-0）/);
  assert.match(identity.checks[0].actual, new RegExp(`覆盖 ${facts.parts.length - 1}/${facts.parts.length}`));
});

test('被包住件（结构上无法用顶点判据看见）：由件表派生剔除，宿主一变就必须自己拿证人', () => {
  // 宿主/被包住件放在网格之外，避免它与网格件形成别的包含关系（判据要逐件精确，不要含混）
  // 件号取**声明表里实证过的那一对**（lift-chain-left ∈ lift-post-left）：豁免必须同时是
  // 「结构上被包住」+「声明过且宿主合法」，随便一件被包住不再自动获得豁免。
  const hostBBox = { min: [600, 600, -50], max: [900, 900, 400] };
  const guestBBox = { min: [700, 700, 100], max: [760, 760, 160] };
  const host = { id: 'lift-post-left', stlBBox: hostBBox, kernelBBox: { min: [...hostBBox.min], max: [...hostBBox.max] }, solids: 1 };
  const guest = { id: 'lift-chain-left', stlBBox: guestBBox, kernelBBox: { min: [...guestBBox.min], max: [...guestBBox.max] }, solids: 1 };
  const { facts, stepVertices } = syntheticGrid({ extraParts: [host, guest] });

  // 真实的 fuse 行为：被完全包住的件边界被吞掉，STEP 里只剩宿主的顶点
  const swallowed = stepVertices.filter((vertex) => boxCorners(guestBBox).every(
    (corner) => corner.some((value, axis) => Math.abs(value - vertex[axis]) > 1e-6)
  ));
  const result = evaluatePartIdentity({ expectedParts: facts.expectedParts, parts: facts.parts, stepVertices: swallowed, ...SYNTHETIC_PRESENCE });
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.deepEqual(result.occluded, ['lift-chain-left'], '被包住件必须由件表派生出来并逐件列名');
  assert.match(result.checks[0].note, /lift-chain-left∈lift-post-left/);

  // 同一几何、只是件号没被声明 → 不再自动豁免（旧实现只看几何，任何件号都吃配额）
  const renamed = facts.parts.map((part) => (part.id === 'lift-chain-left' ? { ...part, id: 'inside-chain' } : part));
  const undeclared = evaluatePartIdentity({ expectedParts: facts.expectedParts, parts: renamed, stepVertices: swallowed, ...SYNTHETIC_PRESENCE });
  assert.equal(undeclared.ok, false, '件号未声明 = 不许占豁免名额');
  assert.deepEqual(undeclared.exemption.undeclared.map((entry) => entry.id), ['inside-chain']);
  assert.match(undeclared.checks[3].actual, /inside-chain/);

  // 变异：宿主挪走（不再包含它）→ 这件不再"结构上被包住"，必须自己拿证人 → 红
  const moved = facts.parts.map((part) => (
    part.id === 'lift-post-left'
      ? { ...part, stlBBox: { min: [600, 600, 600], max: [900, 900, 1000] }, kernelBBox: { min: [600, 600, 600], max: [900, 900, 1000] } }
      : part
  ));
  const mutated = evaluatePartIdentity({ expectedParts: facts.expectedParts, parts: moved, stepVertices: swallowed, ...SYNTHETIC_PRESENCE });
  assert.equal(mutated.ok, false, '宿主不再包住它，就不能再被剔除');
  assert.ok(mutated.unwitnessed.includes('lift-chain-left'));
  assert.equal(mutated.occluded.length, 0);
});

/**
 * CLI 级（P1-1）：逐件占位覆盖必须真的接在回执上 —— 只测纯函数不够。
 * 用桩 STEP（无内核）证明：`--file` 模式下这条检查在、结论进 JSON、桩产物必须判红。
 */
test('CLI：--file 模式的回执里有逐件占位覆盖（桩 STEP 必须红，且点名缺证件）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'step-tower-cli-'));
  const stepPath = join(dir, 'stub.step');
  writeFileSync(stepPath, stubStepText());
  const run = runCli(['--file', stepPath, '--json']);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /FAIL 逐件 B-Rep 占位覆盖（内部件缺失）/);
  const line = run.stdout.split('\n').find((row) => row.startsWith('STEP_TOWER_JSON '));
  assert.ok(line, `必须输出 JSON 回执：\n${run.stdout}`);
  const payload = JSON.parse(line.slice('STEP_TOWER_JSON '.length));
  assert.equal(payload.partIdentity?.ok, false, '桩 STEP 里没有这 146 件的边界');
  assert.equal(payload.partIdentity.requested, 146, '件数必须从件表派生');
  assert.ok(payload.partIdentity.unwitnessed.length > 0);
  assert.ok(payload.checks.some((check) => check.label === '逐件 B-Rep 占位覆盖（内部件缺失）'));
});

/**
 * CLI 级（P1-7）：`--skip-if-no-kernel` 不许表现为纯绿。
 * `--python /nonexistent/...` 让内核起不来（不需要真的没装内核，也不会等 120s）。
 */
test('CLI：--skip-if-no-kernel 必须写「内核未跑 / 未验」回执，不许当成通过', () => {
  const run = runCli(['--levels', '8', '--skip-if-no-kernel', '--python', '/nonexistent/python3', '--json']);
  assert.equal(run.status, 0, `显式跳过沿用退出码 0（收到 ${run.status}）\n${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /SKIP 内核未跑 = true/);
  assert.match(run.stdout, /整机 STEP \/ 逐件 STL \/ 逐件 B-Rep 占位覆盖 全部未验/);
  assert.match(run.stdout, /SKIPPED_NOT_VERIFIED/);
  assert.doesNotMatch(run.stdout, /PASS verify-step-tower/, '跳过不许打印通过行');

  const line = run.stdout.split('\n').find((row) => row.startsWith('STEP_TOWER_JSON '));
  assert.ok(line, `必须输出 JSON 回执：\n${run.stdout}`);
  const payload = JSON.parse(line.slice('STEP_TOWER_JSON '.length));
  assert.equal(payload.ok, false);
  assert.equal(payload.skipped, true);
  assert.equal(payload.degraded, true);
  assert.equal(payload.verdict, 'SKIPPED_NOT_VERIFIED');
  assert.equal(payload.kernelRan, false);
  assert.deepEqual(payload.unverified, ['kernel', 'step', 'perPartStl', 'partIdentity']);
  // 导出边界不依赖内核（件表/几何派生），本次确实判过 —— 结论如实随附，不跟着一起"未验"
  assert.equal(payload.exportBoundaryVerified, true);
  assert.equal(payload.exportBoundary.ok, true, JSON.stringify(payload.exportBoundary));
  assert.match(payload.note, /不等于通过/);
});

/* ---------------------------------------------------------------------------
 * 豁免上限（review P1-2）：逐件身份门禁的缺口不许被数据放大
 *
 * 修复前的实测症状：1 个大件 + 20 个小件 → `required=1 / ok=true`，只要 2 个随便的顶点就绿。
 * 之所以危险：某件 STL 包络异常变大（stlBBox 与 kernelBBox 取自同一份 STL，互相查不出来）
 * 就会把它里面的件全部豁免，丢件不可见。所以豁免必须有件数上限 + 严格包住 + 非豁免宿主，
 * 并逐件回显「谁被谁包住、每轴多大比例」。
 * ------------------------------------------------------------------------- */

test('deriveOcclusionAudit：严格包住（每轴 ≥1.05）、宿主自己不许是豁免件、逐件回显包住者', () => {
  const host = { id: 'host', box: { min: [-150, -150, -150], max: [150, 150, 150] } };
  const guest = { id: 'guest', box: { min: [-20, -20, -20], max: [20, 20, 20] } };
  const audit = deriveOcclusionAudit([host, guest]);
  assert.equal(audit.occluded.get('guest'), 'host');
  assert.deepEqual(audit.details.map((detail) => `${detail.id}∈${detail.host}`), ['guest∈host']);
  assert.ok(audit.details[0].minRatio >= 1.05, '真包住的事件每轴尺寸比必须 ≥1.05');

  // 近似同尺寸（每轴比 1.02）：不算严格包住 → 不许拿豁免（旧判据只比"尺寸和"，这里能过）
  const big = { id: 'big', box: { min: [0, 0, 0], max: [100, 100, 100] } };
  const near = { id: 'near', box: { min: [1, 1, 1], max: [99, 99, 99] } };
  assert.equal(deriveOcclusionAudit([big, near]).occluded.size, 0, '近似同尺寸的两件不许互相吃掉');

  // 链式豁免：a⊂b⊂c 且 b 自己也被 c 包住 → b 不许给 a 当豁免源（否则一条链能免掉整组件）
  const c = { id: 'c', box: { min: [0, 0, 0], max: [400, 400, 400] } };
  const b = { id: 'b', box: { min: [10, 10, 10], max: [300, 300, 300] } };
  const a = { id: 'a', box: { min: [50, 50, 50], max: [200, 200, 200] } };
  const chain = deriveOcclusionAudit([a, b, c]);
  assert.equal(chain.occluded.get('b'), 'c');
  assert.equal(chain.occluded.get('a'), 'c', 'a 只能挂到非豁免的 c 上，不能挂在同样是豁免件的 b 上');
  assert.ok(!chain.details.some((detail) => detail.host === 'b'), '豁免源里不许出现自身被豁免的件');
});

test('变异自证（P1-2）：1 个大件 + 20 个小件 —— 覆盖判据 required=1 全绿，豁免上限必须判红', () => {
  const parts = [{
    id: 'big-box',
    stlBBox: { min: [-500, -500, -500], max: [500, 500, 500] },
    solids: 1
  }];
  for (let index = 0; index < 20; index += 1) {
    const x = -400 + (index % 5) * 160;
    const y = -400 + Math.floor(index / 5) * 160;
    parts.push({ id: `tiny-${index}`, stlBBox: { min: [x, y, 0], max: [x + 30, y + 30, 30] }, solids: 1 });
  }
  const stepVertices = parts.flatMap((part) => boxCorners(part.stlBBox));
  const result = evaluatePartIdentity({ expectedParts: parts.length, parts, stepVertices, ...SYNTHETIC_PRESENCE });

  assert.equal(result.requested, 21);
  assert.equal(result.occluded.length, 20);
  assert.equal(result.required, 1, '修复前就是这个症状：21 件里只有 1 件需要拿证人');
  // 洞在哪：覆盖判据本身是绿的（大件的角点就够当唯一证人了）
  assert.equal(result.checks[0].ok, true, JSON.stringify(result.checks[0]));
  // 新硬约束：21 件 × 10% = 2 件上限，20 件豁免必须红，并把上限/超限量写进回执
  assert.equal(result.exemption.maxExempt, 2);
  assert.equal(result.exemption.overCap, true);
  assert.equal(result.checks[1].ok, false);
  assert.match(result.checks[1].actual, /20 件（超上限 18 件/);
  assert.equal(result.ok, false, '豁免能被数据放大 = 逐件占位覆盖门禁整体失效');
  // 逐件列名 + 包住者件号 + 每轴尺寸比回显（不是"20 件"这种查不动的结论）
  assert.match(result.checks[1].label, /被包住件豁免上限/);
  assert.match(result.checks[1].note, /tiny-0∈big-box\(/);
  assert.match(result.checks[0].note, /tiny-19∈big-box/);
  assert.equal(result.exemption.details.length, 20);
  assert.ok(result.exemption.details.every((detail) => detail.host === 'big-box' && detail.minRatio >= 1.05));
});

test('变异自证（P2）：146 件里 145 条同号 ghost —— 豁免按件数计 + 件号唯一性，任一处回退都必须红', () => {
  const host = { id: 'big-box', stlBBox: { min: [-500, -500, -500], max: [500, 500, 500] }, solids: 1 };
  const parts = [host];
  for (let index = 0; index < 145; index += 1) {
    const x = -400 + (index % 12) * 60;
    const y = -400 + Math.floor(index / 12) * 40;
    // 145 条**同号** 'ghost'：Map 视图只留 1 个键 —— 这就是 review 的绕过反例。
    parts.push({ id: 'ghost', stlBBox: { min: [x, y, 0], max: [x + 30, y + 30, 30] }, solids: 1 });
  }
  const stepVertices = boxCorners(host.stlBBox);
  const result = evaluatePartIdentity({ expectedParts: parts.length, parts, stepVertices, ...SYNTHETIC_PRESENCE });

  assert.equal(result.requested, 146);
  assert.equal(result.required, 1, '按件号去重时就是这个症状：146 件里只有 1 件需要拿证人');
  assert.equal(result.exemption.count, 145, '豁免必须按件数（entries）计，不是 Map 键数');
  assert.equal(result.exemption.uniqueCount, 1, 'Map 视图按件号折叠 → 只有 1 个键（旧实现据此计数）');
  assert.deepEqual(result.exemption.duplicateIds, ['ghost']);
  assert.equal(result.exemption.maxExempt, 14);
  assert.equal(result.exemption.overCap, true, '145 条 > 14 上限：按件数计就不可能漏');
  // 6 条：覆盖 + 上限 + 件号唯一性 + 豁免声明 + 死声明 + 声明件存在性（optional 下恒绿）
  assert.equal(result.checks.length, 6);

  // 件号唯一性单列一条：即便将来 cap 又被改回按件号计，这条也自己判红。
  const uniqueness = result.checks.find((check) => check.label.includes('件号唯一性'));
  assert.ok(uniqueness, '回执必须有件号唯一性这一条');
  assert.equal(uniqueness.ok, false);
  assert.match(uniqueness.actual, /ghost×145/);
  assert.equal(result.ok, false, '同号 146 件场景必须红（旧实现 ok:true）');

  // 对照：件号改唯一后唯一性那条转绿，但「按件数计」的上限照样红 —— 两道防线各自独立成立。
  const uniqueParts = parts.map((part, index) => (index === 0 ? part : { ...part, id: `ghost-${index}` }));
  const unique = evaluatePartIdentity({ expectedParts: uniqueParts.length, parts: uniqueParts, stepVertices, ...SYNTHETIC_PRESENCE });
  assert.deepEqual(unique.exemption.duplicateIds, []);
  assert.equal(unique.exemption.count, 145);
  assert.equal(unique.exemption.overCap, true);
  assert.equal(unique.checks[2].ok, true, '件号唯一时这一条不许误杀');
  assert.equal(unique.ok, false, '145 条豁免本身就超过 14 上限');
});

/** 生产件表 → 世界坐标包络；被包住件的顶点按真实 fuse 行为扣掉（边界被吞）。 */
function identityFactsFromParts(parts) {
  const boxes = parts.map((part) => {
    const bounds = partWorldBounds(part);
    return { id: part.id, stlBBox: { min: bounds.min.slice(), max: bounds.max.slice() } };
  });
  const audit = deriveOcclusionAudit(boxes.map((item) => ({ id: item.id, box: item.stlBBox })));
  const stepVertices = boxes
    .filter((item) => !audit.occluded.has(item.id))
    .flatMap((item) => boxCorners(item.stlBBox));
  return { boxes, audit, stepVertices };
}

const BASELINE_8 = { lengthMm: 2400, widthMm: 1200, beltHeightMm: 900, layers: 8, layerPitchMm: 180 };

for (const label of ['8 层基线', '16 层塔']) {
  test(`不误杀（${label}）：真件表只有 lift-chain 两件被包住 → 豁免上限内仍绿`, () => {
    const parts = label === '8 层基线'
      ? buildConveyorParts(BASELINE_8)
      : buildBufferTowerParts(bufferTowerParamsFromConfig({ bufferTower: TOWER_16 }));
    const expectedParts = label === '8 层基线' ? 90 : 146;
    assert.equal(parts.length, expectedParts, `${label} 件表件数必须与门禁口径一致`);

    const { boxes, stepVertices } = identityFactsFromParts(parts);
    // 真实件表（8 层 / 16 层）是**当前门禁目标**：声明件策略按真实 CLI 的 required 判。
    const result = evaluatePartIdentity({
      expectedParts,
      parts: boxes,
      stepVertices,
      declaredPresence: DECLARED_PRESENCE_POLICY.REQUIRED
    });
    assert.equal(result.ok, true, JSON.stringify(result.checks));
    assert.deepEqual([...result.occluded].sort(), ['lift-chain-left', 'lift-chain-right'], '真机只有链条被导柱包住');
    assert.equal(result.required, expectedParts - 2);
    assert.equal(result.exemption.maxExempt, Math.floor(expectedParts * 0.1));
    assert.equal(result.exemption.overCap, false);
    assert.equal(result.checks.length, 6, '覆盖 + 上限 + 件号唯一性 + 豁免声明 + 死声明 + 声明件存在性六条证据一条都不能少');
    assert.equal(result.checks[1].ok, true);
    // 逐件回显包住者 + 每轴比（实测 8 层最小 1.082、16 层 1.324）
    assert.match(result.checks[1].note, /lift-chain-left∈lift-post-left\(/);
    assert.match(result.checks[1].note, /lift-chain-right∈lift-post-right\(/);
    for (const detail of result.exemption.details) {
      assert.ok(detail.minRatio >= 1.05, `${detail.id} 每轴尺寸比必须 ≥1.05（实测 ${detail.minRatio}）`);
    }

    // 身份约束（P2 逐件豁免）：真件表 2 件全部命中声明表，宿主与声明一致，无死声明
    assert.equal(result.exemption.declared, 2, '真件表被包住的 2 件必须都是声明过的件号');
    assert.deepEqual(result.exemption.undeclared, [], '真件表里没有未声明的被包住件');
    assert.deepEqual(result.exemption.staleDeclared, [], '声明表两件都真被包住，没有死条目');
    assert.deepEqual(result.exemption.hostMismatch, [], '宿主与声明一一对应');
    assert.equal(result.exemption.capUsed, 2, 'cap 用量仍是 2（原 10% 上限不变）');
    assert.equal(result.exemption.maxExempt, Math.floor(expectedParts * 0.1), '10% 上限一个字没改');
    assert.equal(result.checks[3].ok, true);
    assert.equal(result.checks[4].ok, true);

    // 变异：把一件缩进导柱里（等于 STL 包络异常变小/被宿主吞掉）→ 豁免数 +1，仍在上限内；
    // 但它是**未声明**件号 ⇒ 身份检查必须判红（cap 放行、身份不放行 = 这才是逐件豁免）。
    const host = boxes.find((box) => box.id === 'lift-post-left');
    assert.ok(host, '件表里必须有这个宿主');
    const hostBox = host.stlBBox;
    const inset = [0, 1, 2].map((axis) => (hostBox.max[axis] - hostBox.min[axis]) * 0.45);
    const shrinkInto = {
      min: [0, 1, 2].map((axis) => hostBox.min[axis] + inset[axis]),
      max: [0, 1, 2].map((axis) => hostBox.max[axis] - inset[axis])
    };
    const extra = boxes.map((box) => (box.id === 'tray-rail-2-left' ? { ...box, stlBBox: shrinkInto } : box));
    const inflated = evaluatePartIdentity({
      expectedParts,
      parts: extra,
      stepVertices,
      declaredPresence: DECLARED_PRESENCE_POLICY.REQUIRED
    });
    assert.equal(inflated.exemption.count, 3, '缩进导柱里的那件必须由件表派生为被包住');
    assert.equal(inflated.exemption.overCap, false, '3 件仍在上限内（上限按 10% 派生，不是零容忍）');
    assert.ok(inflated.exemption.details.some((detail) => detail.id === 'tray-rail-2-left' && detail.host === 'lift-post-left'));
    assert.deepEqual(inflated.exemption.undeclared.map((entry) => entry.id), ['tray-rail-2-left']);
    assert.equal(inflated.checks[3].ok, false, 'cap 没超但件号没声明 → 身份检查必须红');
    assert.equal(inflated.ok, false, '未声明的被包住件 = 吃配额，整条门禁必须红');
  });
}

test('CLI（P2-1）：--require-full 让 SKIP exit 1，回执的降级语义一个字不变', () => {
  const strict = runCli(['--levels', '8', '--skip-if-no-kernel', '--require-full', '--python', '/nonexistent/python3', '--json']);
  assert.equal(strict.status, 1, `--require-full 下 SKIP 必须 exit 1（收到 ${strict.status}）\n${strict.stdout}${strict.stderr}`);
  assert.match(strict.stdout, /SKIP 退出码 = 1/);
  assert.doesNotMatch(strict.stdout, /PASS verify-step-tower/, '跳过不许打印通过行');

  const line = strict.stdout.split('\n').find((row) => row.startsWith('STEP_TOWER_JSON '));
  assert.ok(line, `必须输出 JSON 回执：\n${strict.stdout}`);
  const payload = JSON.parse(line.slice('STEP_TOWER_JSON '.length));
  // 回执语义不变：ok:false / degraded:true / verdict / kernelRan / unverified 都与不带旗标时一致
  assert.equal(payload.ok, false);
  assert.equal(payload.degraded, true);
  assert.equal(payload.verdict, 'SKIPPED_NOT_VERIFIED');
  assert.equal(payload.kernelRan, false);
  assert.equal(payload.skipped, true);
  assert.deepEqual(payload.unverified, ['kernel', 'step', 'perPartStl', 'partIdentity']);
  // 新增的只有「退出码」这一维，而且写进回执自证
  assert.equal(payload.requireFull, true);
  assert.equal(payload.exitCode, 1);

  // 对照：不带旗标沿用既有约定 exit 0（既有断言不放宽）
  const relaxed = runCli(['--levels', '8', '--skip-if-no-kernel', '--python', '/nonexistent/python3', '--json']);
  assert.equal(relaxed.status, 0, `显式跳过默认仍是 exit 0（收到 ${relaxed.status}）`);
  const relaxedLine = relaxed.stdout.split('\n').find((row) => row.startsWith('STEP_TOWER_JSON '));
  const relaxedPayload = JSON.parse(relaxedLine.slice('STEP_TOWER_JSON '.length));
  assert.equal(relaxedPayload.requireFull, false);
  assert.equal(relaxedPayload.exitCode, 0);
  assert.equal(relaxedPayload.degraded, true);
  assert.equal(relaxedPayload.verdict, 'SKIPPED_NOT_VERIFIED');
});

test('CLI：--help 把 --require-full 与退出码写在同一张单子上（语义不许只活在注释里）', () => {
  const run = runCli(['--help']);
  assert.equal(run.status, 0, `--help 应 exit 0（收到 ${run.status}）\n${run.stderr}`);
  assert.match(run.stdout, /--require-full/);
  assert.match(run.stdout, /SKIP 即 exit 1/);
  assert.match(run.stdout, /退出码：0 全过/);
  assert.match(run.stdout, /豁免 ≤ 件数×10%/);
  assert.match(run.stdout, /--merge-manifest/);
  // 严格档的适用边界必须写在 --help 上（不许只活在注释里）：--file 模式不适用
  assert.match(run.stdout, /与 --file 同给 = 用法错误 exit 2/);
  assert.match(run.stdout, /不接受 --require-full/);
});

test('CLI：--file 与 --require-full 互斥 —— 严格档在文件模式必须报用法错误（exit 2），不许 exit 0 冒充', () => {
  const dir = mkdtempSync(join(tmpdir(), 'step-tower-strict-file-'));
  const stepPath = join(dir, 'stub.step');
  writeFileSync(stepPath, stubStepText());

  const combo = runCli(['--file', stepPath, '--require-full', '--json']);
  assert.equal(combo.status, 2, `--file + --require-full 必须是用法错误 exit 2（收到 ${combo.status}）\n${combo.stdout}${combo.stderr}`);
  assert.match(combo.stderr, /--require-full 在 --file 模式下不适用/);
  assert.doesNotMatch(combo.stdout, /file-check/, '不许跑到判定阶段');
  assert.doesNotMatch(combo.stdout, /STEP_TOWER_JSON/, '不许产出看起来正常的回执');

  // 对照：同一个桩文件不带严格档仍走文件模式（exit 1 是桩产物判红，不是用法错误）
  const plain = runCli(['--file', stepPath, '--json']);
  assert.equal(plain.status, 1);
  assert.match(plain.stdout, /file-check/);
});

/* ---------------------------------------------------------------------------
 * P2-②（C）：塔数派生会不会把「塔柱」和「基础输送线立柱」混算
 *
 * 判定依据只能是**真件表**：两个建造器都复用同一组 `column-(fl|fr|bl|br)` 件号，
 * 所以「是不是混算」不能靠读正则，要靠数出来。实测两档都只有 4 件命中、0 重号 ⇒ 塔数=1，
 * 今天不混算（`towers=2` 被 `NOT_IMPLEMENTED` 锁死，见 buffer-tower-assembly.ts:332）。
 * 这条测试的作用是把「同一族 4 根/塔」这个前提钉住：谁哪天让基础输送线再生产一组
 * 同 id 的立柱，这里立刻断（`pv-buffer-regenerate.mjs` 的修正口不在本任务白名单内，
 * 故这里只做判据核对，不改那个文件）。
 * ------------------------------------------------------------------------- */
test('P2-② 判据核对：8/16 层真件表的立柱族都只有 4 件/0 重号 → 塔数派生不混算', () => {
  const tables = [
    ['8 层基线', buildConveyorParts(BASELINE_8), { layers: 8, claimed: 8 }, 8],
    ['16 层塔', buildBufferTowerParts(bufferTowerParamsFromConfig({ bufferTower: TOWER_16 })), { layers: 16, claimed: 15 }, 16]
  ];
  for (const [label, parts, options, layers] of tables) {
    const columns = parts.filter((part) => /^column-(fl|fr|bl|br)$/.test(String(part.id ?? ''))
      || /^缓存立柱 \d+$/.test(String(part.name ?? '')));
    assert.equal(columns.length, 4, `${label}：立柱族必须正好 4 件（多于 4 就是两族被混算）`);
    assert.equal(new Set(columns.map((part) => part.id)).size, 4, `${label}：立柱件号不许重号`);
    assert.deepEqual(columns.map((part) => part.name).sort(), ['缓存立柱 1', '缓存立柱 2', '缓存立柱 3', '缓存立柱 4']);

    const derived = slotsFromGeometryParts(parts, options);
    assert.equal(derived.ok, true, `${label}：${JSON.stringify(derived.errors)}`);
    assert.equal(derived.towersFromGeometry, 1, `${label}：4 根/塔 ⇒ 1 塔（不是 8 根 ⇒ 2 塔）`);
    assert.equal(derived.levelsFromGeometry, layers, `${label}：层数由托板族派生`);
    assert.deepEqual(derived.errors, []);
  }
});

/* ---------------------------------------------------------------------------
 * P2 逐件豁免（R10）：比例配额 → 点名声明 + 合法宿主 + 双向闭合
 *
 * 架构漏洞：只按**件族前缀**（`lift-chain*`）放行，等于给「批造同族件号」开新口子 ——
 * 造 12 个 `lift-chain-ghost-*` 缩进导柱里，配额（10%）照样被吃满，逐件身份门禁整体失效。
 * 所以声明表必须是「精确件号 → 精确合法宿主」的映射，且双向闭合：
 *   - 被包住但没声明（或宿主不是声明的那个）→ 红；
 *   - 声明了却没被包住（死条目）→ 红。
 * 10% cap 与每轴 1.05 一个字不改，退化成第二道闸（defense in depth）。
 * ------------------------------------------------------------------------- */

/** 造一件「世界坐标包络」件，给下面几个对抗用例复用。 */
function boxPart(id, min, max) {
  return { id, stlBBox: { min: [...min], max: [...max] }, kernelBBox: { min: [...min], max: [...max] }, solids: 1 };
}

test('声明表形状：只有实证的两条链 + 各自合法宿主，族前缀不算（lift-chain-ghost 不许自动入表）', () => {
  assert.deepEqual({ ...OCCLUSION_DECLARED_HOSTS }, {
    'lift-chain-left': 'lift-post-left',
    'lift-chain-right': 'lift-post-right'
  }, '声明表 = 件号 → 唯一合法宿主；不许按族前缀、不许带件数/层数');
  for (const id of ['lift-chain-left', 'lift-chain-right']) {
    assert.equal(isDeclaredOccludable(id), true, `${id} 是实证过的豁免件`);
  }
  // 前缀族匹配会把下面这些自动收进来 —— 逐件身份门禁因此必须用精确件号
  for (const id of [
    'lift-chain', 'lift-chain-ghost', 'lift-chain-ghost-left', 'lift-chain-left-ghost',
    'lift-chain-left-2', 'lift-chain-left:2', 'lift-chain-左', 'lift-post-left', 'inside-chain'
  ]) {
    assert.equal(isDeclaredOccludable(id), false, `${id} 不是声明件号：族前缀不许进白名单`);
  }
  assert.equal(isDeclaredOccludable(undefined), false);
  assert.equal(isDeclaredOccludable(Object.prototype), false, '不许走原型链（hasOwnProperty 而不是 in）');
});

test('对抗（配额吃满）：12 个 lift-chain 族 ghost 缩进导柱里 → cap 放行，声明检查必须逐件点名判红', () => {
  const extras = [boxPart('lift-post-left', [800, 800, -50], [1140, 1140, 400])];
  const ghostIds = [];
  for (let index = 0; index < 12; index += 1) {
    const x = 820 + (index % 4) * 40;
    const y = 820 + Math.floor(index / 4) * 40;
    const id = `lift-chain-ghost-${index}`;
    ghostIds.push(id);
    extras.push(boxPart(id, [x, y, 10], [x + 20, y + 20, 30]));
  }
  // 140 件网格 + 1 宿主 + 12 ghost = 153 件 ⇒ cap = 15，12 条 ghost 吃得下（旧实现全绿）
  const { facts, stepVertices } = syntheticGrid({ nx: 7, ny: 5, nz: 4, extraParts: extras });
  const result = evaluatePartIdentity({ expectedParts: facts.expectedParts, parts: facts.parts, stepVertices, ...SYNTHETIC_PRESENCE });

  assert.equal(result.requested, 153, '件数由件表派生（140 + 1 + 12）');
  assert.equal(result.exemption.count, 12);
  assert.equal(result.exemption.maxExempt, Math.floor(153 * 0.1));
  assert.equal(result.exemption.overCap, false, 'cap 没超：挡住它的是声明约束，不是 10% 比例');
  assert.deepEqual(result.exemption.undeclared.map((entry) => entry.id).sort(), ghostIds.slice().sort());
  assert.equal(result.exemption.declared, 0);
  assert.equal(result.checks[3].ok, false, '未声明的被包住件必须判红');
  assert.match(result.checks[3].actual, /未声明 12 件/);
  assert.match(result.checks[3].actual, /lift-chain-ghost-0/);
  assert.equal(result.ok, false, 'ghost 吃配额 = 逐件占位覆盖门禁失效（旧实现这里 ok:true）');
  // cap/1.05 的旧口径一个字没改：证人豁免仍按「结构上被包住」剔除，声明检查单独判红
  assert.equal(result.required, 153 - 12);
  assert.equal(result.checks[4].ok, true, '没有任何死声明（这两条链的件号不在件表里）');
});

test('对抗（宿主冒名）：件号对、宿主被换掉 → 判红（声明是「件号→宿主」映射，不是件号清单）', () => {
  const extras = [
    boxPart('lift-post-right', [800, 800, -50], [1140, 1140, 400]),
    boxPart('lift-post-left', [-1140, -1140, -50], [-800, -800, 400]),
    // 两条链互换了导柱：件号是声明过的，宿主不是
    boxPart('lift-chain-left', [900, 900, 0], [910, 912, 300]),
    boxPart('lift-chain-right', [-940, -940, 0], [-930, -938, 300])
  ];
  const { facts, stepVertices } = syntheticGrid({ nx: 7, ny: 5, nz: 4, extraParts: extras });
  const result = evaluatePartIdentity({ expectedParts: facts.expectedParts, parts: facts.parts, stepVertices, ...SYNTHETIC_PRESENCE });

  assert.equal(result.exemption.count, 2);
  assert.deepEqual(result.exemption.undeclared, [], '件号都声明过 → 红的原因必须是宿主');
  const mismatched = result.exemption.hostMismatch
    .map((entry) => `${entry.id}∈${entry.host}(应∈${entry.expectedHost})`)
    .sort();
  assert.deepEqual(mismatched, [
    'lift-chain-left∈lift-post-right(应∈lift-post-left)',
    'lift-chain-right∈lift-post-left(应∈lift-post-right)'
  ]);
  assert.equal(result.checks[3].ok, false);
  assert.match(result.checks[3].actual, /宿主冒名 2 件/);
  assert.match(result.checks[3].actual, /lift-chain-left∈lift-post-right/);
  assert.equal(result.exemption.overCap, false, '不是被 cap 挡住的：2/15');
  assert.equal(result.ok, false);
});

test('对抗（死声明）：链条还在件表里但不再被导柱包住 → 判红（白名单不许留空位、不许靠多声明扩容）', () => {
  const parts = buildConveyorParts(BASELINE_8);
  const { boxes } = identityFactsFromParts(parts);
  // 只把两条链挪出导柱（模拟几何调整后「声明还在、事情没发生」），其余件表原样
  const movedBoxes = boxes.map((box) => (String(box.id).startsWith('lift-chain-')
    ? { ...box, stlBBox: { min: [9000, 9000, 0], max: [9010, 9012, 300] } }
    : box));
  const stepVertices = movedBoxes.flatMap((item) => boxCorners(item.stlBBox));
  // 真实 8 层件表：两条链都在件表里、只是不再被包住 → 死声明红（存在性不红）。
  const result = evaluatePartIdentity({
    expectedParts: parts.length,
    parts: movedBoxes,
    stepVertices,
    declaredPresence: DECLARED_PRESENCE_POLICY.REQUIRED
  });

  assert.equal(result.exemption.count, 0, '没有任何件被包住');
  assert.deepEqual(result.exemption.staleDeclared.slice().sort(), ['lift-chain-left', 'lift-chain-right']);
  assert.equal(result.checks[4].ok, false, '死声明必须判红');
  assert.match(result.checks[4].actual, /死声明 2 件/);
  assert.match(result.checks[4].actual, /lift-chain-left/);
  assert.equal(result.checks[3].ok, true, '红的原因只能是死声明，不是未声明件/冒名宿主');
  assert.equal(result.checks[0].ok, true, '覆盖判据本身是绿的：死声明是身份检查抓出来的');
  assert.equal(result.ok, false);
});

test('对抗（链式包裹）：lift-chain 被另一个 lift-chain 包住 → 同族不放宽，仍然判红', () => {
  const extras = [
    boxPart('lift-post-right', [800, 800, -50], [1140, 1140, 400]),
    boxPart('lift-chain-right', [850, 850, 0], [1090, 1090, 350]),
    boxPart('lift-chain-left', [880, 880, 20], [1060, 1060, 320])
  ];
  const { facts, stepVertices } = syntheticGrid({ nx: 7, ny: 5, nz: 4, extraParts: extras });
  const result = evaluatePartIdentity({ expectedParts: facts.expectedParts, parts: facts.parts, stepVertices, ...SYNTHETIC_PRESENCE });

  assert.equal(result.exemption.count, 2, '两件都是「结构上被包住」，旧实现会两件一起免掉');
  assert.deepEqual(
    result.exemption.details.map((detail) => `${detail.id}∈${detail.host}`).sort(),
    ['lift-chain-left∈lift-post-right', 'lift-chain-right∈lift-post-right']
  );
  assert.ok(!result.exemption.details.some((detail) => detail.host === 'lift-chain-right'),
    '同族豁免件不许给别人当宿主（链式豁免仍被 derive 禁掉）');
  assert.deepEqual(result.exemption.hostMismatch.map((entry) => entry.id), ['lift-chain-left'],
    '同族嵌套不构成合法宿主：lift-chain-left 只能挂 lift-post-left');
  assert.equal(result.checks[3].ok, false);
  assert.equal(result.ok, false);
  assert.equal(result.exemption.overCap, false, '2/15：不是 cap 挡住的');
});

/* ---------------------------------------------------------------------------
 * R10 P2-1 整改：声明件必备（review 反例：删链 + 同步改 expectedParts 曾能 ok=true）
 *
 * 为什么必须单独判：expectedParts 与 parts 来自**同一个构造器**，覆盖判据只能发现
 * 「表里有、STEP 里没有」，发现不了「表里没有」。删链后件数、包络、实体数全部自洽，
 * 旧五条检查全绿。存在性策略由调用方显式给：真实 CLI（8/16 层目标）传 required，
 * 无链合成件表传 optional —— 不是按件表同源过滤。
 * ------------------------------------------------------------------------- */

/** 真实 8 层件表 + 世界坐标包络（被包住件的顶点按真实 fuse 行为扣掉）。 */
function baseline8Identity() {
  const parts = buildConveyorParts(BASELINE_8);
  return { parts, ...identityFactsFromParts(parts) };
}

test('反例（P2-1 两条链都删）：expectedParts 同步改成 88 → 覆盖/死声明全绿，声明件存在性必须红', () => {
  const { boxes, stepVertices } = baseline8Identity();
  assert.equal(boxes.length, 90);
  const withoutChains = boxes.filter((box) => box.id !== 'lift-chain-left' && box.id !== 'lift-chain-right');
  assert.equal(withoutChains.length, 88, '删掉两条链后件表就是 88 件（与构造器同源，旧口径抓不到）');

  const result = evaluatePartIdentity({
    expectedParts: withoutChains.length,
    parts: withoutChains,
    stepVertices,
    declaredPresence: DECLARED_PRESENCE_POLICY.REQUIRED
  });

  // 旧证据全部自洽：件数 88/88、每件都有证人、没有被包住件、没有死声明、没有未声明件。
  assert.equal(result.checks[0].ok, true, '覆盖判据看不见"表里没有"（这正是 review P2-1 的反例）');
  assert.equal(result.checks[1].ok, true);
  assert.equal(result.checks[2].ok, true);
  assert.equal(result.checks[3].ok, true);
  assert.equal(result.checks[4].ok, true, '链条不在件表里时死声明判据本来就不响');
  // 唯一红的是存在性：两条链是当前目标的必备件。
  assert.equal(result.checks[5].ok, false);
  assert.match(result.checks[5].label, /声明件必须在件表里/);
  assert.match(result.checks[5].actual, /声明件缺席 2 件/);
  assert.deepEqual(result.exemption.missingDeclared.slice().sort(), ['lift-chain-left', 'lift-chain-right']);
  assert.equal(result.ok, false, '删链 + 同步改件数绝不许放行（旧实现 ok=true）');
});

test('反例（P2-1 单链缺失）：只删 lift-chain-left → 只点名这一件，仍然红', () => {
  const { boxes, stepVertices } = baseline8Identity();
  const withoutLeft = boxes.filter((box) => box.id !== 'lift-chain-left');
  assert.equal(withoutLeft.length, 89);

  const result = evaluatePartIdentity({
    expectedParts: withoutLeft.length,
    parts: withoutLeft,
    stepVertices,
    declaredPresence: DECLARED_PRESENCE_POLICY.REQUIRED
  });

  assert.deepEqual(result.exemption.missingDeclared, ['lift-chain-left'], '缺席名单必须精确到件号');
  assert.equal(result.checks[5].ok, false);
  assert.match(result.checks[5].actual, /声明件缺席 1 件（lift-chain-left）/);
  // 剩余件表本身是自洽的：红只能来自存在性，不是覆盖/死声明。
  assert.equal(result.checks[0].ok, true);
  assert.equal(result.checks[4].ok, true);
  assert.equal(result.ok, false);
});

test('反例（P2-1 宿主缺失）：链条在件表里、宿主被删 → 关系判据红（存在性仍绿）', () => {
  const { boxes } = baseline8Identity();
  const withoutHost = boxes.filter((box) => box.id !== 'lift-post-left');
  assert.equal(withoutHost.length, 89);
  // 宿主没了，链条的边界不再被吞：这里把两条链自己的顶点也放进 STEP（最有利于放行的姿态）。
  const stepVertices = withoutHost.flatMap((box) => boxCorners(box.stlBBox));

  const result = evaluatePartIdentity({
    expectedParts: withoutHost.length,
    parts: withoutHost,
    stepVertices,
    declaredPresence: DECLARED_PRESENCE_POLICY.REQUIRED
  });

  assert.equal(result.checks[0].ok, true, '链条自己拿得到证人：覆盖判据是绿的');
  assert.equal(result.checks[5].ok, true, '两条链都在件表里：存在性不红');
  assert.deepEqual(result.exemption.hostMismatch, [], '没有冒名宿主（是宿主整件缺失）');
  assert.deepEqual(result.exemption.staleDeclared, ['lift-chain-left'], '声明的宿主没了 ⇒ 声明不再落地');
  assert.equal(result.checks[4].ok, false);
  assert.match(result.checks[4].actual, /死声明 1 件（lift-chain-left）/);
  assert.equal(result.ok, false);
});

test('策略是显式入参（fail-closed）：无链合成件表默认 required 判红，显式 optional 才放行', () => {
  const { facts, stepVertices } = syntheticGrid();

  // 不传策略 = required（fail-closed）：门禁不许因为件表里没有声明件就悄悄放宽。
  const defaulted = evaluatePartIdentity({ expectedParts: facts.expectedParts, parts: facts.parts, stepVertices });
  assert.equal(defaulted.exemption.declaredPresence, DECLARED_PRESENCE_POLICY.REQUIRED);
  assert.deepEqual(defaulted.exemption.missingDeclared.slice().sort(), ['lift-chain-left', 'lift-chain-right']);
  assert.equal(defaulted.checks[5].ok, false);
  assert.equal(defaulted.ok, false, '默认策略必须严格，忘了传不许变成静默通过');

  // 合成件表显式 opt-out：这是调用方给的策略，不是门禁按件表推断。
  const optional = evaluatePartIdentity({
    expectedParts: facts.expectedParts,
    parts: facts.parts,
    stepVertices,
    declaredPresence: DECLARED_PRESENCE_POLICY.OPTIONAL
  });
  assert.equal(optional.exemption.declaredPresence, DECLARED_PRESENCE_POLICY.OPTIONAL);
  assert.deepEqual(optional.exemption.missingDeclared.slice().sort(), ['lift-chain-left', 'lift-chain-right']);
  assert.equal(optional.checks[5].ok, true, 'optional 下存在性不判，但缺席名单仍然回显');
  assert.match(optional.checks[5].note, /不是从件表推断出来/);
  assert.equal(optional.ok, true, JSON.stringify(optional.checks.filter((check) => !check.ok)));

  // 非法策略值必须当场报错，不许退化成某个默认方向。
  assert.throws(
    () => evaluatePartIdentity({ expectedParts: facts.expectedParts, parts: facts.parts, stepVertices, declaredPresence: 'auto' }),
    /declaredPresence 必须是/
  );
});

test('CLI（P2-1）：真实 --file 路径把 declaredPresence=required 写进回执（策略由 CLI 提供）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'step-tower-cli-'));
  const stepPath = join(dir, 'stub.step');
  writeFileSync(stepPath, stubStepText());
  const run = runCli(['--file', stepPath, '--json']);
  assert.equal(run.status, 1, '桩 STEP 本身红，但回执里必须带策略');
  const line = run.stdout.split('\n').find((row) => row.startsWith('STEP_TOWER_JSON '));
  assert.ok(line, `必须输出 JSON 回执：\n${run.stdout}`);
  const payload = JSON.parse(line.slice('STEP_TOWER_JSON '.length));
  assert.equal(payload.partIdentity.exemption.declaredPresence, DECLARED_PRESENCE_POLICY.REQUIRED);
  assert.deepEqual(payload.partIdentity.exemption.missingDeclared, [], '146 件真件表两条链都在');
  assert.match(run.stdout, /STEP_TOWER_IDENTITY FAIL .*missing=0 policy=required/);
});

/* ---------------------------------------------------------------------------
 * R12 第 7 类证据：逐实体身份（STEP_TOWER_ENTITY_IDENTITY）
 *
 * 为什么单列一段：这一层证的是「件表里每一件，在 identity 伴生成物里都有具名、包络、
 * 实体数都对得上的实体」。它**不证明** identity.step 与融合制造 STEP 内部拓扑/形状等价，
 * 也不认证材质/可制造性；bbox 只是包络核对。而 `--file` 只读一份 STEP，没有伴生成物，
 * 所以那里必须显式 not-applicable —— 不许多出一条静默通过的绿项。
 *
 * 这里的用例全部**追加**：既有 47 例的断言一个字不动。
 * ------------------------------------------------------------------------- */

test('CLI（R12）：--file 的 entityIdentity 显式 not-applicable，既有证据条数一条不加', () => {
  const dir = mkdtempSync(join(tmpdir(), 'step-tower-entity-'));
  const stepPath = join(dir, 'stub.step');
  writeFileSync(stepPath, stubStepText());

  const run = runCli(['--file', stepPath, '--json']);
  assert.equal(run.status, 1, '桩 STEP 照旧整体红（文件模式不是验收门禁）');
  assert.match(run.stdout, /STEP_TOWER_ENTITY_IDENTITY NOT-APPLICABLE/);

  const line = run.stdout.split('\n').find((row) => row.startsWith('STEP_TOWER_JSON '));
  assert.ok(line, `必须输出 JSON 回执：\n${run.stdout}`);
  const payload = JSON.parse(line.slice('STEP_TOWER_JSON '.length));
  assert.equal(payload.entityIdentity.applicable, false);
  assert.equal(payload.entityIdentity.ok, null, '不适用必须留 null —— true 会被读成「验过了」');
  assert.equal(payload.entityIdentity.verdict, 'NOT_APPLICABLE');
  assert.match(payload.entityIdentity.reason, /not-applicable/);
  // 既有文件模式证据 23 条（16 条 STEP/件/合并 + 4 条豁免/覆盖 + ... ）：加身份就等于改了文件模式语义
  assert.equal(payload.checks.length, 23, `文件模式证据条数不许变（收到 ${payload.checks.length}）`);
  assert.equal(
    payload.checks.filter((check) => /身份伴生成物|身份件号集合|逐件实体数与包络|并集核对与制造件污染/.test(check.label)).length,
    0,
    '文件模式不许混进一条身份绿项（静默跳过同样不允许）'
  );
});

test('CLI（R12）：--help 把第 7 类证据、fail-closed 与判别力边界写在同一张单子上', () => {
  const run = runCli(['--help']);
  assert.equal(run.status, 0, `--help 应 exit 0（收到 ${run.status}）\n${run.stderr}`);
  assert.match(run.stdout, /STEP_TOWER_ENTITY_IDENTITY/);
  assert.match(run.stdout, /entityIdentity = NOT-APPLICABLE/);
  assert.match(run.stdout, /缺 files\.identity.*FAIL、exit 1/);
  assert.match(run.stdout, /不是唯一几何指纹/);
  assert.match(run.stdout, /本轮不加 --identity-step \/ --require-identity/);
});

test('CLI（R12）：--skip-if-no-kernel 时身份证据记「未验」，unverified 语义不变', () => {
  const run = runCli(['--levels', '8', '--skip-if-no-kernel', '--python', '/nonexistent/python3', '--json']);
  assert.equal(run.status, 0, '显式跳过沿用退出码 0');
  assert.match(run.stdout, /SKIP 逐实体身份（第 7 类证据）= 未验/);
  const line = run.stdout.split('\n').find((row) => row.startsWith('STEP_TOWER_JSON '));
  assert.ok(line, `必须输出 JSON 回执：\n${run.stdout}`);
  const payload = JSON.parse(line.slice('STEP_TOWER_JSON '.length));
  assert.equal(payload.entityIdentity.verified, false);
  assert.equal(payload.entityIdentity.ok, null, '未验不许写成绿');
  assert.deepEqual(payload.unverified, ['kernel', 'step', 'perPartStl', 'partIdentity'], '既有 unverified 语义不变');
});

test('R12 接线（无内核）：缺 files.identity → 4 条身份 check 第 1 条红，且不是 not-applicable', async () => {
  const gate = await import('../../scripts/verify-step-tower.mjs');
  const parts = [
    { id: 'a', bboxMin: [0, 0, 0], bboxMax: [10, 10, 10], solids: 1, volumeMm3: 1000 },
    { id: 'b', bboxMin: [20, 0, 0], bboxMax: [30, 10, 10], solids: 1, volumeMm3: 1000 }
  ];
  const dir = mkdtempSync(join(tmpdir(), 'step-tower-entity-'));
  const stepPath = join(dir, 'step.step');
  writeFileSync(stepPath, stubStepText());

  // 老内核：回执里根本没有 files.identity
  const built = { ok: true, files: { parts, step: { path: stepPath } }, stats: { partSolids: 2 } };
  const result = await gate.entityIdentityOf({
    built,
    table: { parts: parts.map((part) => ({ id: part.id })) },
    stepPath,
    step: { bbox: { min: [0, 0, 0], max: [30, 10, 10] } },
    stepText: stubStepText()
  });
  assert.equal(result.checks.length, 4, '身份证据固定 4 条，缺产物也不许少一条');
  assert.equal(result.ok, false, '缺身份产物必须 FAIL（fail-closed），不是 SKIP');
  assert.equal(result.checks[0].ok, false);
  assert.match(result.checks[0].actual, /缺 files\.identity/);
  assert.equal(result.entityIdentity.applicable, true, 'build 语义下是「判了没通过」，不是不适用');
  assert.ok(result.checks.slice(1).every((check) => check.ok === false), '没有回读时其余三条也不许绿');

  // 回执里声称有 identity、磁盘上却没有 → 同样红（路径归属与真实 bytes 都要核）
  const ghost = await gate.entityIdentityOf({
    built: { ...built, files: { ...built.files, identity: { path: join(dir, 'identity.step'), bytes: 999 } } },
    table: { parts: parts.map((part) => ({ id: part.id })) },
    stepPath,
    step: { bbox: { min: [0, 0, 0], max: [30, 10, 10] } },
    stepText: stubStepText()
  });
  assert.equal(ghost.ok, false);
  assert.match(ghost.checks[0].actual, /文件不存在/);
});

test('R12 接线（真 fixtures，无内核）：真 bytes 回读 → 4 条全绿；跨目录/非同请求 → 红', async () => {
  const gate = await import('../../scripts/verify-step-tower.mjs');
  const entities = await import('../../src/cad/step-entities.ts');
  const occtimportjs = (await import('occt-import-js')).default;
  const { readFileSync } = await import('node:fs');

  const fixture = fileURLToPath(new URL('../fixtures/step-identity-3parts.step', import.meta.url));
  const raw = readFileSync(fixture);
  const dir = mkdtempSync(join(tmpdir(), 'step-tower-entity-'));
  const identityPath = join(dir, 'identity.step');
  writeFileSync(identityPath, raw);
  // 制造侧必须是**真能导入的同一几何**：C7 之后并集核对比的是两份文件的同口径网格包络，
  // 拿桩文本当制造 STEP 会（正确地）判「导入失败」。这里把 PRODUCT 名抹成 COMPOUND —— 正是
  // fuse 之后件号消失的样子，几何与 identity 完全一致，且不触发 C8 污染判据。
  // 同源替换只验证同口径读数与判据方向，不证明 fuse 产物与 compound 拓扑等价。
  const mergedText = (text) => text.replace(/PRODUCT\('([^']*)','\1'/g, "PRODUCT('COMPOUND','COMPOUND'");
  const stepPath = join(dir, 'step.step');
  writeFileSync(stepPath, mergedText(raw.toString('utf8')));

  const occt = await occtimportjs();
  const readback = entities.readStepEntities(new Uint8Array(raw), occt);
  assert.equal(readback.ok, true, readback.errors.join('；'));
  const parts = readback.entities.map((entity) => ({
    id: entity.leaf,
    bboxMin: [...entity.bbox.min],
    bboxMax: [...entity.bbox.max],
    solids: entity.meshCount,
    volumeMm3: 1
  }));

  const built = {
    ok: true,
    files: { identity: { path: identityPath, bytes: raw.length }, parts, step: { path: stepPath } },
    stats: { partSolids: parts.reduce((sum, part) => sum + part.solids, 0) }
  };
  // 制造侧拓扑（VERTEX_POINT）包络：C7 之后它只作**参考**写进 JSON（不参与判定），
  // 这里传真实值，好让「旧口径 vs 同口径」的差在回执里看得见。
  const stepTextOfMerged = readFileSync(stepPath, 'utf8');
  const vertices = readStepVertexPoints(stepTextOfMerged);
  const vertexBox = unionBoxes(
    vertices.map((point) => ({ min: [...point], max: [...point] }))
  );
  const args = {
    table: { parts: parts.map((part) => ({ id: part.id })) },
    stepPath,
    step: { bbox: vertexBox ?? { min: [...readback.bbox.min], max: [...readback.bbox.max] } },
    stepText: stepTextOfMerged
  };

  const green = await gate.entityIdentityOf({ built, ...args });
  assert.equal(green.ok, true, JSON.stringify(green.checks));
  assert.equal(green.entityIdentity.actualParts, 3);
  assert.equal(green.entityIdentity.meshCount, 3);
  // 同口径：两侧都是网格包络，Δ 应为 0；拓扑包络只作参考存在 JSON 里。
  assert.deepEqual(green.entityIdentity.unionDeltaMm.map((value) => Number(value.toFixed(3))), [0, 0, 0]);
  assert.ok(green.entityIdentity.mergedReadbackBBox, '必须给出制造侧同口径网格包络');
  assert.ok(green.entityIdentity.identityBBox, '必须给出 identity 侧网格包络');
  assert.equal(green.entityIdentity.mergedReadbackMeshCount, 3);
  assert.deepEqual(green.entityIdentity.mergedReadbackErrors, []);

  // 一行回执必须是真数字（CI 归档读的就是这一行）
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    gate.logEntityIdentityLine(green);
  } finally {
    console.log = original;
  }
  assert.match(lines.join('\n'), /STEP_TOWER_ENTITY_IDENTITY PASS ids=3\/3 unknown=0 dup=0 solids=3\/3 mesh=3 /);

  // 越界：identity 被挪到别的目录（跨请求张冠李戴的最省事做法）→ 产物判据红
  const elsewhere = mkdtempSync(join(tmpdir(), 'step-tower-entity-other-'));
  const movedPath = join(elsewhere, 'identity.step');
  writeFileSync(movedPath, raw);
  const outside = await gate.entityIdentityOf({
    built: { ...built, files: { ...built.files, identity: { path: movedPath, bytes: raw.length } } },
    ...args
  });
  assert.equal(outside.ok, false);
  assert.match(outside.checks[0].actual, /不同目录/);

  // 把制造 STEP 自身当身份件 → 红（指向自身不算产物）
  const alias = await gate.entityIdentityOf({
    built: { ...built, files: { ...built.files, identity: { path: stepPath, bytes: raw.length } } },
    ...args
  });
  assert.equal(alias.ok, false);
  assert.match(alias.checks[0].actual, /制造 STEP 自身/);
});

/* ---------------------------------------------------------------------------
 * R12/C7 补强（T3 复审 P1-2 / P1-3 / P2）：真实文件系统上的软链、`./` 写法、
 * 制造 STEP 导入失败、身份容差不继承 CLI。全部**追加**，既有断言一字未改。
 * ------------------------------------------------------------------------- */

test('R12/P1-2（真文件）：软链越界与软链自指都判红，`./` 写法不假红', async () => {
  const gate = await import('../../scripts/verify-step-tower.mjs');
  const entities = await import('../../src/cad/step-entities.ts');
  const occtimportjs = (await import('occt-import-js')).default;
  const { readFileSync, symlinkSync } = await import('node:fs');

  const fixture = fileURLToPath(new URL('../fixtures/step-identity-3parts.step', import.meta.url));
  const raw = readFileSync(fixture);
  const realDir = mkdtempSync(join(tmpdir(), 'step-tower-link-real-'));
  const linkDir = mkdtempSync(join(tmpdir(), 'step-tower-link-alias-'));
  const identityPath = join(realDir, 'identity.step');
  writeFileSync(identityPath, raw);
  const stepPath = join(realDir, 'step.step');
  writeFileSync(stepPath, raw.toString('utf8').replace(/PRODUCT\('([^']*)','\1'/g, "PRODUCT('COMPOUND','COMPOUND'"));

  const occt = await occtimportjs();
  const readback = entities.readStepEntities(new Uint8Array(raw), occt);
  const parts = readback.entities.map((entity) => ({
    id: entity.leaf,
    bboxMin: [...entity.bbox.min],
    bboxMax: [...entity.bbox.max],
    solids: entity.meshCount,
    volumeMm3: 1
  }));
  const built = {
    ok: true,
    files: { parts, step: { path: stepPath } },
    stats: { partSolids: parts.reduce((sum, part) => sum + part.solids, 0) }
  };
  const args = {
    table: { parts: parts.map((part) => ({ id: part.id })) },
    stepPath,
    step: { bbox: { min: [...readback.bbox.min], max: [...readback.bbox.max] } },
    stepText: readFileSync(stepPath, 'utf8')
  };

  // ① 软链到另一目录：字符串层面看不出越界，realpath 一眼看穿
  //    真实 identity 放在 thirdDir，软链挂在 linkDir，制造 STEP 在 realDir —— 三处不同。
  const thirdDir = mkdtempSync(join(tmpdir(), 'step-tower-link-target-'));
  const realIdentity = join(thirdDir, 'identity.step');
  writeFileSync(realIdentity, raw);
  const escapedLink = join(linkDir, 'identity.step');
  symlinkSync(realIdentity, escapedLink);
  const escaped = await gate.entityIdentityOf({
    built: { ...built, files: { ...built.files, identity: { path: escapedLink, bytes: raw.length } } },
    ...args
  });
  assert.equal(escaped.ok, false);
  assert.equal(escaped.entityIdentity.sameDir, false, '真实路径不同目录不许报 true');
  assert.match(escaped.checks[0].actual, /不同目录|符号链接/);

  // ② 软链指回制造 STEP 自身
  const selfLink = join(realDir, 'self.step');
  symlinkSync(stepPath, selfLink);
  const self = await gate.entityIdentityOf({
    built: { ...built, files: { ...built.files, identity: { path: selfLink, bytes: raw.length } } },
    ...args
  });
  assert.equal(self.ok, false);
  assert.match(self.checks[0].actual, /制造 STEP 自身|符号链接/);

  // ③ `./` 只是写法差异：不许假红（旧实现报「不同目录 …/real/. vs …/real」）
  const dotted = await gate.entityIdentityOf({
    built: {
      ...built,
      files: {
        ...built.files,
        identity: { path: `${realDir}/./identity.step`, bytes: raw.length }
      }
    },
    ...args
  });
  assert.equal(dotted.ok, true, JSON.stringify(dotted.checks));
  assert.equal(dotted.entityIdentity.sameDir, true);
  assert.equal(dotted.entityIdentity.toleranceMm, 1, '身份容差固定 1mm');
  assert.equal(dotted.entityIdentity.tolerancePolicy, 'fixed');
  assert.ok(dotted.entityIdentity.mergedReadbackBBox, 'JSON 必须有制造侧同口径包络');
  assert.ok(dotted.entityIdentity.identityBBox, 'JSON 必须有 identity 侧网格包络');
});

test('R12/C7（真文件）：制造 STEP 导入失败 → 第 4 条红，缺边不退回旧口径', async () => {
  const gate = await import('../../scripts/verify-step-tower.mjs');
  const entities = await import('../../src/cad/step-entities.ts');
  const occtimportjs = (await import('occt-import-js')).default;
  const { readFileSync } = await import('node:fs');

  const fixture = fileURLToPath(new URL('../fixtures/step-identity-3parts.step', import.meta.url));
  const raw = readFileSync(fixture);
  const dir = mkdtempSync(join(tmpdir(), 'step-tower-bad-merged-'));
  const identityPath = join(dir, 'identity.step');
  writeFileSync(identityPath, raw);
  const stepPath = join(dir, 'step.step');
  writeFileSync(stepPath, 'this is not a STEP file\n');

  const occt = await occtimportjs();
  const readback = entities.readStepEntities(new Uint8Array(raw), occt);
  const parts = readback.entities.map((entity) => ({
    id: entity.leaf,
    bboxMin: [...entity.bbox.min],
    bboxMax: [...entity.bbox.max],
    solids: entity.meshCount,
    volumeMm3: 1
  }));
  const result = await gate.entityIdentityOf({
    built: {
      ok: true,
      files: { identity: { path: identityPath, bytes: raw.length }, parts, step: { path: stepPath } },
      stats: { partSolids: parts.reduce((sum, part) => sum + part.solids, 0) }
    },
    table: { parts: parts.map((part) => ({ id: part.id })) },
    stepPath,
    // 故意继续传旧的拓扑包络：C7 之后它只作参考，不许拿它顶包络比较
    step: { bbox: { min: [...readback.bbox.min], max: [...readback.bbox.max] } },
    stepText: readFileSync(stepPath, 'utf8')
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks[3].ok, false, '制造 STEP 导入失败必须红在第 4 条');
  assert.match(result.checks[3].actual, /同口径回读失败|导入失败/);
  assert.equal(result.entityIdentity.mergedReadbackBBox, null);
  assert.equal(result.entityIdentity.unionDeltaMm, null, '缺少制造侧网格包络，不许回退拓扑包络伪造零差');
  assert.ok(result.entityIdentity.mergedReadbackErrors.length > 0);
});

test('R12/P1-3（源码结构守卫）：身份判据不接 CLI --tolerance，固定 1mm', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(
    fileURLToPath(new URL('../../scripts/verify-step-tower.mjs', import.meta.url)),
    'utf8'
  );
  // 身份事实对象（entityIdentityOf 里的 base）必须钉常量；旧写法是
  // `toleranceMm: Number.isFinite(toleranceArg) ? toleranceArg : DEFAULT_TOLERANCE_MM`，
  // 那会让 `--tolerance 20` 把 19.85mm 的口径差判绿（T3 E10）。
  const identityBase = source.match(/const base = \{[\s\S]{0,1200}?\n  \};/);
  assert.ok(identityBase, '找不到 entityIdentityOf 的 facts 对象');
  assert.match(identityBase[0], /toleranceMm:\s*ENTITY_IDENTITY_TOLERANCE_MM/);
  assert.doesNotMatch(identityBase[0], /toleranceArg/, '身份 facts 里不许出现 CLI 容差');
});
