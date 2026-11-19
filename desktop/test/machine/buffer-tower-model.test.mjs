/**
 * 缓存塔入口链（S1–S4）：`build_machine_model` 的塔分派、参数严格校验、工程保存往返、
 * 升降轴多件化。
 *
 * 这里**没有**内核：`buffer-tower-assembly` 只出零件表，逐件 STL / STEP 由
 * `window.desktop.parametric` 产出。所以本文件断言的是「交给内核的那份 doc」——
 * 件数（146/90）、件号唯一、包络、以及保存往返后的参数完整性；
 * 真实 per-part STL 计数与 step 路径由 `probe`（stub bridge）给出，见报告。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MODEL_BUILDERS,
  BUFFER_TOWER_PARAMS,
  pickModelBuilder,
  normalizeModelParams,
  toConveyorParams,
  resolveBufferTowerModelInput,
  resolveModelDispatch,
  toBufferTowerConfig,
  bufferTowerModelParams,
  buildBufferTowerDesign
} from '../../src/machine/model-builders.ts';
import {
  BufferTowerConfigError,
  bufferTowerParamsFromConfig,
  buildBufferTowerParts,
  bufferTowerSlots
} from '../../src/machine/buffer-tower-assembly.ts';
import { buildConveyorParts, conveyorAssembly, conveyorEnvelope } from '../../src/machine/conveyor-assembly.ts';
import {
  MachinePartGeometryError,
  conveyorGeometryFromParts,
  partWorldBounds,
  resolveMachineGeometry,
  towerLiftAxis
} from '../../src/machine/machine-geometry.ts';
import { geometryToGltf, geometryToSidecarAssemblies, geometryToStl, geometryTriangleCount } from '../../src/machine/geometry-export.ts';
import { parsePartLocalBox } from '../../src/machine/feature-box.ts';
import { supportRowsFromConveyorPartsDetailed } from '../../src/machine/panel-channel.ts';
import {
  classifyDesignMachineFailure,
  isMachinePartGeometryError,
  machinePartGeometryFailure
} from '../../src/agent/tools.ts';
import { saveProject, openProject } from '../../electron/projects.ts';

const TOWER_ROOT = mkdtempSync(join(tmpdir(), 'buffer-tower-model-'));

/** 塔配置（16 层 / 2278×1134×35 板 / 180 层距）：与 design_machine 的默认塔头同一组数。 */
function towerRequest(params = {}) {
  const resolved = resolveBufferTowerModelInput({ params });
  assert.equal(resolved.ok, true, resolved.message);
  return resolved;
}

function parts16() {
  const resolved = towerRequest();
  return { resolved, params: bufferTowerParamsFromConfig({ bufferTower: resolved.config }), parts: buildBufferTowerParts(bufferTowerParamsFromConfig({ bufferTower: resolved.config })) };
}

/* ---------------- 1. 注册表与分派 ---------------- */

test('注册表：buffer-tower 走参数化引擎，参数清单与塔身上下限同源', () => {
  const builder = pickModelBuilder('buffer-tower');
  assert.ok(builder, 'buffer-tower 必须在注册表里，否则整机建模会静默回落输送线');
  assert.equal(builder.engine, 'parametric');
  assert.equal(builder.rangePolicy, 'reject', '塔参数必须拒绝而不是夹紧');
  // 参数清单 = 塔几何白名单：容量身份（towers/slotsPerTower）不许作为参数出现
  const names = builder.params.map((spec) => spec.name);
  assert.deepEqual(names, BUFFER_TOWER_PARAMS.map((spec) => spec.name));
  for (const banned of ['slotsPerTower', 'slotsPerLevel', 'towers', 'transferLevel']) {
    assert.equal(names.includes(banned), false, `${banned} 不应作为整机建模参数`);
  }
  // 每项都有非空区间，否则「越界拒绝」没有基准
  for (const spec of builder.params) {
    assert.ok(Number.isFinite(spec.min) && Number.isFinite(spec.max), `${spec.name} 缺区间`);
    assert.ok(spec.min < spec.max, `${spec.name} 区间倒置`);
    assert.ok(spec.defaultValue >= spec.min && spec.defaultValue <= spec.max, `${spec.name} 默认值越界`);
  }
  assert.deepEqual(Object.keys(MODEL_BUILDERS), ['conveyor', 'buffer-tower']);
});

/* ---------------- 2. 16 层 146 件 / 8 层 90 件 ---------------- */

test('16 层：146 件、包络 2430×1790×3840、16 层 1 位、可用储位 15', () => {
  const { params, parts } = parts16();
  assert.equal(parts.length, 146);
  assert.deepEqual(conveyorEnvelope(parts).map((value) => Math.round(value)), [2430, 1790, 3840]);
  const slots = bufferTowerSlots(params, parts);
  assert.equal(slots.levels, 16);
  assert.equal(slots.slotsPerLevel, 1);
  assert.equal(slots.usableStorage, 15, '第 1 层是进出料位，可服务储位是 15');
  assert.equal(slots.aligned, true, '层数必须从几何派生而不是参数回声');
  // 件号唯一：逐件 STL 是一实例一文件，重复 id 会让零件树/干涉错位
  assert.equal(new Set(parts.map((part) => part.id)).size, parts.length);
});

test('16 层：交给内核的 doc 恰好 146 个实例（= 逐件 STL 的上限与数量）', () => {
  const { parts } = parts16();
  const doc = conveyorAssembly(parts);
  assert.equal(doc.instances.length, 146);
  assert.equal(doc.instances.length, parts.length, 'doc 实例数必须等于零件表件数，否则会有件不进内核');
  assert.equal(new Set(doc.instances.map((instance) => instance.id)).size, 146);
  for (const instance of doc.instances) {
    assert.ok(instance.features.length > 0, `${instance.id} 没有特征，内核会导出一个空文件`);
    assert.equal(typeof instance.transform.z, 'number');
  }
});

test('8 层旧路径不受影响：layers=8 仍走 conveyor-assembly，90 件、包络不变', () => {
  const builder = pickModelBuilder('conveyor');
  const normalized = normalizeModelParams(builder, {
    lengthMm: 2400, widthMm: 1200, beltHeightMm: 900, layers: 8, layerPitchMm: 180
  });
  assert.equal(normalized.ok, true);
  const parts = buildConveyorParts(toConveyorParams(normalized.params));
  assert.equal(parts.length, 90);
  assert.deepEqual(conveyorEnvelope(parts).map((value) => Math.round(value)), [2430, 1690, 2400]);
  // 输送线的 layers 上限仍是 8（塔没有放宽它）
  const over = normalizeModelParams(builder, { layers: 16 });
  assert.equal(over.ok, true);
  assert.equal(over.params.layers, 8, '输送线保持旧夹紧语义');
  assert.match(over.message ?? '', /超出/);
});

test('两条链同一份零件表：resolveMachineGeometry 与整机建模件数/包络一致', () => {
  const { resolved, parts } = parts16();
  const geometry = resolveMachineGeometry({
    id: 'buffer-tower-16l',
    name: '缓存塔 16 层',
    stations: ['进出料'],
    actuators: [],
    sensors: [],
    bufferTower: resolved.config
  });
  assert.equal(geometry.source, 'buffer-tower-assembly');
  // 板是几何刚体（不进 ConveyorPart 表）：partCount = 建造器件数 + 1
  assert.equal(geometry.partCount, parts.length + 1);
  assert.equal(geometry.assemblyPartCount, parts.length);
  assert.equal(geometry.geometry.parts.length, parts.length + 1);
  assert.equal(geometry.geometry.parts.filter((part) => part.role === 'workpiece').length, 1);
});

test('同一份零件表的两套导出边界：碰撞 147、制造导出（STL/glTF/sidecar→STEP）146', () => {
  const { resolved, parts } = parts16();
  const geometry = resolveMachineGeometry({
    id: 'buffer-tower-16l',
    name: '缓存塔 16 层',
    stations: ['进出料'],
    actuators: [],
    sensors: [],
    bufferTower: resolved.config
  }).geometry;
  // 碰撞几何仍是「装配件 + 板」：导出过滤不许回头改 geometry.parts
  assert.equal(geometry.parts.length, 147);
  const bundle = geometryToSidecarAssemblies(geometry, { updatedAt: '2026-11-19T00:00:00+08:00' });
  assert.equal(bundle.instances, 146);
  const ids = bundle.chunks.flatMap((chunk) => chunk.instances.map((instance) => instance.id));
  assert.equal(ids.length, 146);
  assert.ok(!ids.includes('workpiece-plate'));
  const stl = geometryToStl(geometry);
  const stlCount = new DataView(stl.buffer, stl.byteOffset, stl.byteLength).getUint32(80, true);
  assert.equal(stlCount, geometryTriangleCount(geometry));
  assert.ok(!geometryToGltf(geometry).nodes.slice(0, -1).some((node) => node.name === 'workpiece-plate'));
  // 原零件表（建造器件数）与制造导出口径一致；板只多一个碰撞刚体
  assert.equal(parts.length, 146);
});

/* ---------------- 3. 参数严格校验：不夹紧 ---------------- */

test('单字段越界：拒绝并说明区间，不夹紧', () => {
  const cases = [
    [{ levels: 65 }, /levels.*超出 2~64/],
    [{ levels: 1 }, /levels.*超出 2~64/],
    [{ panelLengthMm: -5 }, /panelLengthMm.*超出 100~12000/],
    [{ layerPitchMm: 700 }, /layerPitchMm.*超出 131~600/],
    [{ beltHeightMm: 50 }, /beltHeightMm.*超出 100~3000/]
  ];
  for (const [params, pattern] of cases) {
    const result = resolveBufferTowerModelInput({ params });
    assert.equal(result.ok, false, `${JSON.stringify(params)} 必须被拒绝`);
    assert.match(result.message ?? '', pattern);
    assert.match(result.message ?? '', /不夹紧/);
  }
});

test('未知键（容量身份）：拒绝而不是忽略', () => {
  for (const params of [{ slotsPerTower: 32 }, { towers: 2 }, { slotsPerLevel: 2 }, { 乱写: 1 }]) {
    const result = resolveBufferTowerModelInput({ params });
    assert.equal(result.ok, false, `${JSON.stringify(params)} 必须被拒绝`);
    assert.match(result.message ?? '', /不接受参数/);
  }
});

test('跨字段不变量：层距净空 / 进料余量 / 容量算式在几何入口仍是 fail-loud', () => {
  // 单字段都合法（layerPitch 140 ∈ 131~600），但 140 < 板厚 35 + 130 = 165
  const tightPitch = resolveBufferTowerModelInput({ params: { layerPitchMm: 140 } });
  assert.equal(tightPitch.ok, true, '单字段合法就先通过入口校验，跨字段在几何入口判');
  assert.throws(
    () => bufferTowerParamsFromConfig({ bufferTower: tightPitch.config }),
    (error) => error instanceof BufferTowerConfigError && error.code === 'CONFIG_RANGE' && /165/.test(error.message)
  );
  // 进料线 2000 < 板长 2278 + 120 = 2398
  const shortInbound = resolveBufferTowerModelInput({ params: { inboundLengthMm: 2000 } });
  assert.equal(shortInbound.ok, true);
  assert.throws(
    () => bufferTowerParamsFromConfig({ bufferTower: shortInbound.config }),
    (error) => error instanceof BufferTowerConfigError && error.code === 'CONFIG_RANGE' && /2398/.test(error.message)
  );
  // 容量身份由 levels 派生，不会被参数骗
  assert.equal(toBufferTowerConfig({ levels: 12 }).slotsPerTower, 12);
  assert.equal(toBufferTowerConfig({ levels: 12 }).slotsPerLevel, 1);
});

test('design 路径：config.bufferTower 权威；与扁平参数同时给就拒绝', () => {
  const { resolved } = parts16();
  const design = buildBufferTowerDesign(resolved.config);
  assert.equal(resolveBufferTowerModelInput({ design }).source, 'design');
  const conflict = resolveBufferTowerModelInput({ design, params: { levels: 8 } });
  assert.equal(conflict.ok, false);
  assert.match(conflict.message ?? '', /只能有一个来源/);
  // 只给 config（不带 design 外壳）同样认 —— config 指**机型配置**，塔块在 config.bufferTower
  assert.equal(resolveBufferTowerModelInput({ config: design.config }).source, 'design');
  // 直接把塔块当 config 传是错的形状：必须现眼，不能静默当成「没有塔」
  const wrongShape = resolveBufferTowerModelInput({ config: resolved.config });
  assert.equal(wrongShape.ok, false);
  assert.match(wrongShape.message ?? '', /bufferTower 缺失/);
  // design 里没有 bufferTower 时不猜：直接拒
  const noTower = resolveBufferTowerModelInput({ design: { config: { id: 'x', name: 'y', stations: ['s'], actuators: [], sensors: [] } } });
  assert.equal(noTower.ok, false);
  assert.match(noTower.message ?? '', /bufferTower 缺失/);
});

/* ---------------- 4. 保存往返：panel/inbound/frame 不能丢 ---------------- */

test('保存往返：design.config.bufferTower 完整落盘，重开仍有 panel/inbound/frame', () => {
  const { resolved } = parts16();
  const design = buildBufferTowerDesign(resolved.config);
  const saved = saveProject(TOWER_ROOT, {
    name: '缓存塔 16 层往返',
    process: 'buffer-tower',
    params: resolved.params,
    parts: 146,
    design
  });
  assert.equal(saved.ok, true, saved.message);
  assert.ok(saved.record);

  // 落盘文件里就是完整嵌套块
  const designJson = JSON.parse(readFileSync(join(TOWER_ROOT, 'projects', saved.record.id, 'design.json'), 'utf8'));
  assert.equal(designJson.design.config.bufferTower.panel.lengthMm, 2278);
  assert.equal(designJson.design.config.bufferTower.inbound.lengthMm, 2400);
  assert.equal(designJson.design.config.bufferTower.frame.material, 'AL6063');

  const opened = openProject(TOWER_ROOT, saved.record.id);
  assert.equal(opened.ok, true, opened.message);
  const tower = opened.record.design.config.bufferTower;
  assert.equal(tower.kind, 'tower');
  assert.equal(tower.levels, 16);
  assert.equal(tower.slotsPerTower, 16);
  assert.deepEqual(tower.panel, { lengthMm: 2278, widthMm: 1134, thicknessMm: 35, massKg: 32 });
  assert.deepEqual(tower.inbound, { lengthMm: 2400, widthMm: 1200, beltHeightMm: 900 });
  assert.deepEqual(tower.frame, { material: 'AL6063', sectionMm: 40 });
  // 参数回声（工程记录 params 只收数字）与 config 一致，不是另一套数
  assert.deepEqual(bufferTowerModelParams(tower), resolved.params);
});

test('只给 config 的保存也落盘（以前只校验、不写）', () => {
  const { resolved } = parts16();
  const design = buildBufferTowerDesign(resolved.config);
  const saved = saveProject(TOWER_ROOT, {
    name: '缓存塔 config-only',
    process: 'buffer-tower',
    parts: 146,
    config: design.config
  });
  assert.equal(saved.ok, true, saved.message);
  const opened = openProject(TOWER_ROOT, saved.record.id);
  assert.equal(opened.record.design?.config?.bufferTower?.panel?.lengthMm, 2278);
});

test('反例：只走 params 会把 panel/inbound/frame 丢掉——这正是必须传 design 的理由', () => {
  const { resolved } = parts16();
  const saved = saveProject(TOWER_ROOT, {
    name: '缓存塔 params-only',
    process: 'buffer-tower',
    params: resolved.params,
    parts: 146
  });
  assert.equal(saved.ok, true, saved.message);
  const opened = openProject(TOWER_ROOT, saved.record.id);
  assert.equal(opened.record.design, undefined, '没有 design 就没有嵌套块');
  assert.equal(opened.record.params.levels, 16, '标量还在');
  assert.equal(opened.record.params.panelLengthMm, 2278, '扁平标量也在（但结构关系已丢）');
});

/* ---------------- 5. 升降轴多件化（S4） ---------------- */

test('升降轴：单件台面保持旧行为（partIds 一件、pivot = 台面建模位）', () => {
  const { params, parts } = parts16();
  const platform = parts.find((part) => part.id === 'lift-platform');
  assert.ok(platform);
  const axis = towerLiftAxis(parts, params);
  assert.equal(axis.actuatorId, 'tower-lift');
  assert.deepEqual(axis.partIds, ['lift-platform']);
  assert.deepEqual(axis.pivot, [0, 0, platform.transform.z]);
  assert.equal(axis.strokeMm, 2700);
  assert.equal(axis.strokeSource, 'geometry');
});

test('升降轴：多件运动件全带走，pivot 取包围盒 z 中心', () => {
  const { params, parts } = parts16();
  const platform = parts.find((part) => part.id === 'lift-platform');
  assert.ok(platform);
  // 模拟侧叉方案：台面换成横梁 + 2 根叉臂，且叉臂比横梁高 8 mm
  const carriage = { ...platform, id: 'lift-carriage', transform: { ...platform.transform, z: platform.transform.z - 12 } };
  const forkLeft = { ...platform, id: 'lift-fork-left', transform: { ...platform.transform, y: 622 } };
  const forkRight = { ...platform, id: 'lift-fork-right', transform: { ...platform.transform, y: -622 } };
  const synthetic = [...parts.filter((part) => part.id !== 'lift-platform'), carriage, forkLeft, forkRight];
  const axis = towerLiftAxis(synthetic, params);
  assert.deepEqual(axis.partIds, ['lift-carriage', 'lift-fork-left', 'lift-fork-right']);
  const low = platform.transform.z - 12 - 20; // 横梁底面（half z = 20）
  const high = platform.transform.z + 20;     // 叉臂顶面
  assert.equal(axis.pivot[2], Math.round(((low + high) / 2) * 10) / 10);
  assert.equal(axis.pivot[0], 0);
  assert.equal(axis.pivot[1], 0);
});

test('升降轴：一件运动件都没有时抛错，不退化成 0 条轴', () => {
  const { params, parts } = parts16();
  const stripped = parts.filter((part) => part.id !== 'lift-platform');
  assert.throws(() => towerLiftAxis(stripped, params), /缺少升降运动件/);
});

/* ---------------- 6. 接线（源码级）：整机建模必须把塔交给同一份零件表 ---------------- */

test('分派判据（唯一一份）：塔 design/config 不给 process 也走塔；显式 conveyor 与塔冲突要拒', () => {
  const { resolved } = parts16();
  const design = buildBufferTowerDesign(resolved.config);

  // 只给 design（design_machine 的自然产物）：必须判成塔，不能按缺省 conveyor 出 29 件
  const byDesign = resolveModelDispatch({ design });
  assert.equal(byDesign.ok, true);
  assert.equal(byDesign.tower, true);
  assert.equal(byDesign.process, 'buffer-tower');
  assert.equal(byDesign.explicitProcess, false);

  // config 简写、以及显式 process=buffer-tower（不带 design）都走塔
  assert.equal(resolveModelDispatch({ config: design.config }).tower, true);
  const byProcess = resolveModelDispatch({ process: 'buffer-tower' });
  assert.equal(byProcess.ok, true);
  assert.equal(byProcess.tower, true);

  // 两个来源冲突：显式 conveyor + 塔 design → 拒（不许任选一个，也不许静默 29 件）
  const conflict = resolveModelDispatch({ process: 'conveyor', design });
  assert.equal(conflict.ok, false);
  assert.match(conflict.message, /冲突/);
  const conflictConfig = resolveModelDispatch({ process: 'conveyor', config: design.config });
  assert.equal(conflictConfig.ok, false);
  assert.match(conflictConfig.message, /冲突/);

  // 声明是塔却没有 bufferTower → 拒（不从 formId 猜）
  const missing = resolveModelDispatch({ process: 'buffer-tower', design: designWithoutTower() });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /bufferTower 缺失/);

  // 普通输送线不受影响
  const conveyor = resolveModelDispatch({ params: { lengthMm: 2400 } });
  assert.equal(conveyor.ok, true);
  assert.equal(conveyor.tower, false);
  assert.equal(conveyor.process, 'conveyor');
});

function designWithoutTower() {
  return { config: { id: 'x', name: 'y', stations: ['s'], actuators: [], sensors: [], formId: 'belt-line' } };
}

/**
 * 分派层（脚本 API 这一侧）也要拒：命令层早就有形状校验，但直接调
 * `buildMachineModel` / `resolveModelDispatch` 的路径以前可以拿到 `ok:true`。
 */
test('分派判据：形状错 / 机型不支持 / 双源 在分派层就拒（不静默降级成 29 件输送线）', () => {
  const { resolved } = parts16();
  const towerDesign = buildBufferTowerDesign(resolved.config);
  const conveyorDesign = {
    config: {
      id: 'line-1', name: '输送线', stations: ['上料'], actuators: [], sensors: [],
      conveyor: { lengthMm: 6000, widthMm: 600 }
    }
  };
  const cases = [
    [{ design: [1, 2] }, /design 必须是非数组对象/],
    [{ design: { config: [1, 2] } }, /design\.config 必须是非数组对象/],
    [{ config: 'tower' }, /config 必须是非数组对象/],
    [{ params: [2400] }, /params 必须是非数组对象/],
    [{ process: 'screw' }, /暂无参数化整机生成器/],
    [{ process: 'screw', params: { lengthMm: 2000 } }, /apply_machine_design/],
    // process 的形状也要先判：非字符串/空白/null 不许当「没写 process」默认成 conveyor
    [{ process: 123 }, /process 必须是非空字符串/],
    [{ process: {} }, /process 必须是非空字符串/],
    [{ process: [2400] }, /process 必须是非空字符串/],
    [{ process: '' }, /process 必须是非空字符串/],
    [{ process: '   ' }, /process 必须是非空字符串/],
    [{ process: null }, /process 必须是非空字符串/],
    [{ design: towerDesign, config: towerDesign.config }, /二选一/],
    [{ design: towerDesign, params: { lengthMm: 2400 } }, /同时给了/],
    [{ config: towerDesign.config, params: { levels: 8 } }, /同时给了/],
    [{ design: conveyorDesign }, /config\.conveyor 不会被整机建模器读取/],
    [{ process: 'conveyor', config: { conveyor: { lengthMm: 6000 } } }, /config\.conveyor 不会被整机建模器读取/],
    [{ design: designWithoutTower() }, /没有塔块/]
  ];
  for (const [request, pattern] of cases) {
    const result = resolveModelDispatch(request);
    assert.equal(result.ok, false, `${JSON.stringify(request).slice(0, 90)} 应当被拒绝`);
    assert.match(result.message, pattern);
  }
  // 正常路径不受影响：纯 params / 只给塔 design / null 当没给
  assert.equal(resolveModelDispatch({ params: { lengthMm: 2400 } }).ok, true);
  assert.equal(resolveModelDispatch({ design: towerDesign }).tower, true);
  assert.equal(resolveModelDispatch({ design: null, params: { lengthMm: 2400 } }).ok, true);
});

test('接线：buildMachineModel 用统一分派 + 塔分支走同一几何收尾，保存带 design、构建 perPart', () => {
  const source = readFileSync(new URL('../../src/extension.ts', import.meta.url), 'utf8');
  // 旧实现：只看 builder.process，只给 design 时静默落到 29 件底层线
  assert.doesNotMatch(source, /builder\.process === 'buffer-tower'/, '不许再只看 process 分派');
  assert.match(source, /resolveModelDispatch\(\{/, '分派必须走统一判据（与命令层/几何层同一份）');
  assert.match(source, /const towerModel = dispatch\.tower/, '塔分支必须由 dispatch.tower 决定');
  assert.match(source, /resolveBufferTowerModelInput\(/, '塔入参解析必须走同一入口（严格校验）');
  // 收尾：与 apply_machine_design 同一条几何入口（含 assertTowerAboveGround / 随动件标注）
  assert.match(source, /resolveMachineGeometry\(\{ config: towerGeometryConfig\(/, '塔分支必须过几何收尾断言');
  assert.match(source, /closing\.assemblyPartCount !== parts\.length/, '两条链件数不一致必须是内部错误，不能照建');
  assert.match(source, /bufferTowerParamsFromConfig\(\{ bufferTower: towerModel\.config \}\)/, '几何必须与 apply_machine_design 同一份');
  assert.match(source, /buildBufferTowerParts\(params\)/, '塔必须走塔身建造器，不是 buildConveyorParts');
  assert.match(source, /parametric\.build\(doc, \{ perPart: true \}\)/, '逐件 STL 依赖 perPart');
  // 落盘来源二选一：完整 design（或 params 合成方案）走 design，裸 config 走 config ——
  // 裸 config 合成的 `{ config }` 壳缺 stations，当 design 送进 validateMachineDesign 会被整份拒。
  assert.match(source, /\(towerModel \? \{ design: towerModel\.design \} : \{\}\)/, '嵌套参数必须走 design/config 落盘');
});

test('接线：几何入口与整机建模用同一个判别函数（不许两边各写一份 kind 判定）', () => {
  const geometry = readFileSync(new URL('../../src/machine/machine-geometry.ts', import.meta.url), 'utf8');
  assert.match(geometry, /if \(isBufferTowerConfig\(config\.bufferTower\)\)/, '几何入口必须调 isBufferTowerConfig');
  assert.doesNotMatch(geometry, /config\.bufferTower\?\.kind === 'tower'/, '不许再写第二份 kind 判定');
  const assembly = readFileSync(new URL('../../src/machine/buffer-tower-assembly.ts', import.meta.url), 'utf8');
  assert.match(assembly, /export function isBufferTowerConfig/, '判别函数只能有一份');
  const builders = readFileSync(new URL('../../src/machine/model-builders.ts', import.meta.url), 'utf8');
  assert.match(builders, /export function resolveModelDispatch/);
  assert.match(builders, /isBufferTowerConfig\(/, '分派也必须用同一个判别函数');
});

/* ---------------- 7. 件盒三态（P1-2）：坏数据不再被静默编成几何 ---------------- *
 *
 * machine-geometry 的件盒解析与 panel-channel.featureLocalBox 同一判据：
 * `box/cylinder | none（减材料/压缩）| invalid（读不出/类型不认识）`。
 * 旧口径（本轮被替换的四处）：
 *   - 参数非有限 → 返回 null，调用方 continue → 特征被静默丢弃、件盒偏小；
 *   - `Number(v) || 0` → at 里的 NaN 悄悄变 0（编坐标）；
 *   - 未知类型 → 与减材料合并，静默当「无实体」；
 *   - `solids === 0` → `[0,0,0]` 零盒（一件量不出几何的零件变成零体积点）。
 * 下面每个反例都直接断言「现在会抛 INVALID_PART_GEOMETRY」而不是「给个数」。
 * ------------------------------------------------------------------ */

/** 夹具：一条普通输送线（2400×1200，默认层数）。不动仓库数据，全部在内存里改件。 */
function conveyorFixture(overrides = {}) {
  const builder = pickModelBuilder('conveyor');
  const normalized = normalizeModelParams(builder, { lengthMm: 2400, widthMm: 1200, ...overrides });
  assert.equal(normalized.ok, true, normalized.message);
  const params = toConveyorParams(normalized.params);
  const config = {
    id: 'p12-fixture',
    name: '件盒三态夹具',
    stations: ['上料'],
    actuators: [],
    sensors: [],
    formId: 'belt-line',
    // 让唯一入口也走参数化整机（否则会回落工位生成器，两条入口比的就不是同一台机器）
    conveyor: { lengthMm: params.lengthMm, widthMm: params.widthMm }
  };
  return { params, config, parts: buildConveyorParts(params) };
}

/** 把某个件的特征树换掉（其余件原样）。 */
function replaceFeatures(parts, partId, features) {
  assert.ok(parts.some((part) => part.id === partId), `夹具里没有件 ${partId}`);
  return parts.map((part) => (part.id === partId ? { ...part, features } : part));
}

const partById = (parts, id) => {
  const part = parts.find((entry) => entry.id === id);
  assert.ok(part, `夹具里没有件 ${id}`);
  return part;
};

const boxFeature = (id, length, width, height, extra = {}) => ({
  id, type: 'box', name: '型材', params: { length, width, height }, ...extra
});

test('件盒三态·NaN 参数：不再静默丢特征，抛 INVALID_PART_GEOMETRY', () => {
  const { params, config, parts } = conveyorFixture();
  const broken = replaceFeatures(parts, 'rail-left', [boxFeature('rail-left-body', Number.NaN, params.frameSectionMm, params.frameSectionMm)]);
  const target = partById(broken, 'rail-left');
  assert.throws(
    () => partWorldBounds(target),
    (error) => error instanceof MachinePartGeometryError
      && error.code === 'INVALID_PART_GEOMETRY'
      && error.fault === 'non-finite-param'
      && error.partId === 'rail-left'
      && error.featureId === 'rail-left-body'
      && error.featureIndex === 0
      && /rail-left/.test(error.message)
  );
  // 消费方整机入口也必须 fail-closed（旧口径是「这件小一圈，别处照算」）
  assert.throws(() => conveyorGeometryFromParts(broken, config, params), (error) => error instanceof MachinePartGeometryError && error.partId === 'rail-left');

  // 圆柱 at 里的 NaN：旧实现 `Number(v) || 0` 会把它变成 0（编坐标），现在读不出就报错
  const cylinderPart = parts.find((part) => part.features.some((feature) => feature.type === 'cylinder'));
  assert.ok(cylinderPart, '夹具里必须有圆柱件（滚筒/导柱）');
  const node = cylinderPart.features.find((feature) => feature.type === 'cylinder');
  const badAt = replaceFeatures(parts, cylinderPart.id, [{ ...node, params: { ...node.params, at: [0, Number.NaN, 0] } }]);
  assert.throws(
    () => partWorldBounds(partById(badAt, cylinderPart.id)),
    (error) => error.fault === 'invalid-at' && /NaN/.test(error.message)
  );
});

test('件盒三态·未知类型：不并入「减材料」，抛 unknown-feature-type（件盒不许偏小）', () => {
  const { params, config, parts } = conveyorFixture();
  // 一块合法型材 + 一条内核还不认识的加材料特征（prism）：旧口径把它当无实体丢掉，
  // 件盒只剩 40 宽（真实外形 80 宽）；现在必须报错，不能给出偏小的盒。
  const broken = replaceFeatures(parts, 'rail-left', [
    boxFeature('rail-left-body', params.lengthMm, params.frameSectionMm, params.frameSectionMm),
    { id: 'rail-left-prism', type: 'prism', name: '未知加材料特征', params: { length: params.lengthMm, width: 80, height: 80 } }
  ]);
  assert.throws(
    () => partWorldBounds(partById(broken, 'rail-left')),
    (error) => error instanceof MachinePartGeometryError
      && error.fault === 'unknown-feature-type'
      && error.featureIndex === 1
      && error.featureId === 'rail-left-prism'
      && /prism/.test(error.message)
  );
  assert.throws(() => conveyorGeometryFromParts(broken, config, params), (error) => error.fault === 'unknown-feature-type');
  // 四个减材料类型仍是政策跳过（既不报错，也不撑大件盒）
  const subtractive = replaceFeatures(parts, 'rail-left', [
    boxFeature('rail-left-body', params.lengthMm, params.frameSectionMm, params.frameSectionMm),
    ...['holes', 'counterbore', 'slot', 'fillet'].map((type) => ({ id: `rail-left-${type}`, type, name: type, params: {} }))
  ]);
  assert.doesNotThrow(() => conveyorGeometryFromParts(subtractive, config, params));
});

test('件盒三态·suppressed：与内核同口径跳过；唯一实体特征被压缩时不再给零盒', () => {
  const { params, config, parts } = conveyorFixture();
  const section = params.frameSectionMm;
  // 正控（skip 口径）：压缩的大块特征不参与外形 —— 内核编译时也跳过（features.ts:139/484）
  const withSuppressed = replaceFeatures(parts, 'rail-left', [
    boxFeature('rail-left-body', params.lengthMm, section, section),
    boxFeature('rail-left-guard', params.lengthMm, 400, 400, { suppressed: true })
  ]);
  const bounds = partWorldBounds(partById(withSuppressed, 'rail-left'));
  assert.deepEqual(
    [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]],
    [params.lengthMm, section, section],
    '被压缩的特征不许撑大件盒'
  );
  assert.doesNotThrow(() => conveyorGeometryFromParts(withSuppressed, config, params));

  // 反例：唯一实体特征被压缩 → 件里没有任何实体外形。旧口径给 [0,0,0] 零盒（件成零体积点）。
  const onlySuppressed = replaceFeatures(parts, 'rail-left', [boxFeature('rail-left-body', params.lengthMm, section, section, { suppressed: true })]);
  assert.throws(
    () => partWorldBounds(partById(onlySuppressed, 'rail-left')),
    (error) => error instanceof MachinePartGeometryError
      && error.fault === 'no-solid-feature'
      && error.partId === 'rail-left'
      && error.featureIndex === -1
  );
  assert.throws(() => conveyorGeometryFromParts(onlySuppressed, config, params), (error) => error.fault === 'no-solid-feature');
});

test('件盒三态·零尺寸：零厚/零盒都判退化，不给零体积点', () => {
  const { params, config, parts } = conveyorFixture();
  const section = params.frameSectionMm;
  // (a) 三轴里有一轴为 0 → 并集盒退化（旧口径照收，件变成一张零体积的“纸”）
  const zeroThickness = replaceFeatures(parts, 'rail-left', [boxFeature('rail-left-body', params.lengthMm, section, 0)]);
  assert.throws(
    () => partWorldBounds(partById(zeroThickness, 'rail-left')),
    (error) => error instanceof MachinePartGeometryError
      && error.fault === 'degenerate-box'
      && /三轴都必须 > 0/.test(error.message)
  );
  assert.throws(() => conveyorGeometryFromParts(zeroThickness, config, params), (error) => error.fault === 'degenerate-box');

  // (b) 件里只有减材料特征 → 无实体外形可量（旧口径 `solids === 0` 给 [0,0,0] 零盒）
  const noSolid = replaceFeatures(parts, 'rail-left', [{ id: 'rail-left-holes', type: 'holes', name: '安装孔', params: { positions: [[0, 0]] } }]);
  assert.throws(
    () => partWorldBounds(partById(noSolid, 'rail-left')),
    (error) => error.fault === 'no-solid-feature' && /零盒/.test(error.message)
  );
});

test('正控：正常件的几何结果不变（两条入口同一份几何、包络与逐件盒仍从零件表派生）', () => {
  const { params, config, parts } = conveyorFixture();
  const direct = conveyorGeometryFromParts(parts, config, params);
  const resolved = resolveMachineGeometry(config);
  assert.equal(direct.parts.length, parts.length, '件数不变（一件拆两件的只有同轴双径圆柱）');
  // 唯一入口与直接映射必须给出**同一份**几何（本轮只改坏数据的判定，不改正常件的数）
  assert.deepEqual(direct, resolved.geometry);
  assert.deepEqual(direct.envelope, conveyorEnvelope(parts).map((value) => Math.round(value)));
  // 逐件盒与特征声明一致：rail-left 的外形盒 = 线体长 × 截面 × 截面
  const rail = partWorldBounds(partById(parts, 'rail-left'));
  assert.deepEqual(
    [rail.max[0] - rail.min[0], rail.max[1] - rail.min[1], rail.max[2] - rail.min[2]],
    [params.lengthMm, params.frameSectionMm, params.frameSectionMm]
  );
  // 每件都量得出盒（没有一件掉到零盒/静默丢特征）
  for (const part of parts) {
    const box = partWorldBounds(part);
    for (const axis of [0, 1, 2]) assert.ok(box.max[axis] > box.min[axis], `${part.id} 的轴 ${axis} 尺寸必须 > 0`);
  }
});

/* ---------------- 8. 两处判据是同一份实现（T3 P1-1）：交叉一致性 ---------------- *
 *
 * 复审结论是「`machine-geometry` 与 `panel-channel` 同口径」这句话当时是假的：
 * 同一份件表，碰撞侧对未知类型/退化盒**抛 INVALID_PART_GEOMETRY**，承托侧却当「无外形」跳过，
 * `suppressed` 在 panel-channel 里根本没有被读过 —— 一处失败、一处继续算偏小的盒，且两处都不告警。
 * 现在判据只有 `feature-box.ts` 一份实现，本节直接断言**同一组坏特征在两处结论一致**：
 *   ① `parsePartLocalBox`（两个消费者的共用输入）判 invalid + 原因码；
 *   ② `machine-geometry.partWorldBounds` 抛同一个原因码；
 *   ③ `panel-channel.supportRowsFromConveyorPartsDetailed` 把该件剔进 `droppedPartIds`（行表里没有它）。
 * 另加正控：正常件/被压缩件/减材料件，两处的盒逐字段相等（没有"这边算大、那边算小"的漂移）。
 * ------------------------------------------------------------------ */

const round2 = (value) => Math.round(value * 100) / 100;

/** 世界 AABB → 与 panel-channel 行表同形状（它也 round2）。 */
function geometryRowOf(part) {
  const box = partWorldBounds(part);
  return {
    minX: round2(box.min[0]), maxX: round2(box.max[0]),
    minY: round2(box.min[1]), maxY: round2(box.max[1]),
    minZ: round2(box.min[2]), maxZ: round2(box.max[2])
  };
}

const rowFields = (row) => ({
  minX: row.minX, maxX: row.maxX, minY: row.minY, maxY: row.maxY, minZ: row.minZ, maxZ: row.maxZ
});

/** 捕获抛出（要求确实抛了，没抛就是回归）。 */
function thrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('必须抛 INVALID_PART_GEOMETRY，实际没抛（静默给了个数）');
}

test('交叉一致性·坏特征：同一组坏特征在 machine-geometry 与 panel-channel 结论一致', () => {
  const { params, config, parts } = conveyorFixture();
  const section = params.frameSectionMm;
  const length = params.lengthMm;
  // 每条用例只换 rail-left 的特征树，其余件原样。
  // `channel` 字段 = 承托侧遇到这条坏特征时的政策：
  //   - `drop`：剔件（→ invalid-shelf-geometry），与几何侧抛错同义；
  //   - `skip`：整件没有实体外形 → 不成行、不记 dropped（唯一被保留的政策差异，几何侧仍抛）。
  const cases = [
    {
      label: 'NaN 参数（旧口径静默丢特征）',
      fault: 'non-finite-param',
      channel: 'drop',
      features: [boxFeature('rail-left-body', Number.NaN, section, section)]
    },
    {
      label: '未知类型 prism（旧口径当无外形跳过 → 件盒偏小）',
      fault: 'unknown-feature-type',
      channel: 'drop',
      features: [
        boxFeature('rail-left-body', length, section, section),
        { id: 'rail-left-prism', type: 'prism', name: '未知加材料', params: { length, width: 80, height: 80 } }
      ]
    },
    {
      label: '零厚特征 → 并集盒退化（旧口径照收，件成零体积纸片）',
      fault: 'degenerate-box',
      channel: 'drop',
      features: [boxFeature('rail-left-body', length, section, 0)]
    },
    {
      label: '圆柱 at 含 NaN（旧口径 `Number(v) || 0` 编坐标）',
      fault: 'invalid-at',
      channel: 'drop',
      features: [{
        id: 'rail-left-pin',
        type: 'cylinder',
        name: '销轴',
        params: { diameter: 20, height: length, axis: 'x', at: [0, Number.NaN, 0] }
      }]
    },
    {
      label: '圆柱轴向不认识（旧口径拿 z 顶替）',
      fault: 'invalid-axis',
      channel: 'drop',
      features: [{
        id: 'rail-left-pin',
        type: 'cylinder',
        name: '销轴',
        params: { diameter: 20, height: length, axis: 'w', at: [0, 0, 0] }
      }]
    },
    {
      label: 'suppressed 唯一实体特征（旧 panel-channel 不读 suppressed）',
      fault: 'no-solid-feature',
      channel: 'skip',
      features: [boxFeature('rail-left-body', length, section, section, { suppressed: true })]
    },
    {
      label: '只有减材料特征（旧口径给 [0,0,0] 零盒）',
      fault: 'no-solid-feature',
      channel: 'skip',
      features: [{ id: 'rail-left-holes', type: 'holes', name: '安装孔', params: { positions: [[0, 0]] } }]
    }
  ];

  for (const entry of cases) {
    const broken = replaceFeatures(parts, 'rail-left', entry.features);
    const part = partById(broken, 'rail-left');

    // ① 共用判据（两个消费者的同一份输入）：invalid + 同一个原因码
    const shared = parsePartLocalBox(part.features);
    assert.equal(shared.kind, 'invalid', `${entry.label}：共用判据必须判 invalid`);
    assert.equal(shared.fault, entry.fault, `${entry.label}：共用判据原因码`);

    // ② 碰撞/包络侧：抛，且原因码与共用判据一致
    const error = thrownBy(() => partWorldBounds(part));
    assert.ok(error instanceof MachinePartGeometryError, `${entry.label}：必须抛 MachinePartGeometryError`);
    assert.equal(error.code, 'INVALID_PART_GEOMETRY');
    assert.equal(error.partId, 'rail-left');
    assert.equal(error.fault, shared.fault, `${entry.label}：抛出的原因码必须与共用判据一致`);
    assert.equal(thrownBy(() => conveyorGeometryFromParts(broken, config, params)).fault, shared.fault,
      `${entry.label}：整机几何入口也必须是同一个原因码`);

    // ③ 承托/通道侧：判据相同（同一条 invalid），政策按上表
    const derived = supportRowsFromConveyorPartsDetailed(broken);
    assert.equal(derived.rows.some((row) => row.id === 'rail-left'), false, `${entry.label}：行表里不许再有该件`);
    if (entry.channel === 'drop') {
      assert.deepEqual(derived.droppedPartIds, ['rail-left'], `${entry.label}：panel-channel 必须把该件剔进 droppedPartIds`);
      assert.equal(derived.rows.length, broken.length - 1, `${entry.label}：其余件仍各自成行（只剔坏件）`);
    } else {
      // 唯一保留的政策差异：整件没有实体外形 → 不是承托面，不成行；也不是"坏输入"，不记 dropped。
      assert.deepEqual(derived.droppedPartIds, [], `${entry.label}：无实体外形的件不是坏输入，不许进 droppedPartIds`);
      assert.equal(derived.rows.length, broken.length - 1, `${entry.label}：该件不成行，其余件照常`);
    }
  }

  // 反例：正控不能被误伤 —— 合法件 + 减材料 + suppressed 大块特征 两处都不许报错
  const healthy = replaceFeatures(parts, 'rail-left', [
    boxFeature('rail-left-body', length, section, section),
    { id: 'rail-left-holes', type: 'holes', name: '安装孔', params: { positions: [[0, 0]] } },
    boxFeature('rail-left-guard', length, 400, 400, { suppressed: true })
  ]);
  assert.equal(parsePartLocalBox(partById(healthy, 'rail-left').features).kind, 'solid');
  assert.doesNotThrow(() => conveyorGeometryFromParts(healthy, config, params));
  assert.deepEqual(supportRowsFromConveyorPartsDetailed(healthy).droppedPartIds, []);
});

test('交叉一致性·正常件：同一件表两处的承托面盒逐字段相等（两套包络不许漂移）', () => {
  const conveyor = conveyorFixture();
  const towerParts16 = parts16().parts;
  for (const [label, table] of [['输送线夹具', conveyor.parts], ['缓存塔 16 层', towerParts16]]) {
    const derived = supportRowsFromConveyorPartsDetailed(table);
    assert.deepEqual(derived.droppedPartIds, [], `${label}：正常件表不允许有被剔除的件`);
    const rowsById = new Map(derived.rows.map((row) => [row.id, row]));
    for (const part of table) {
      const row = rowsById.get(part.id);
      assert.ok(row, `${label}：${part.id} 必须有行`);
      assert.deepEqual(rowFields(row), geometryRowOf(part), `${label}：${part.id} 两处盒必须逐字段相等`);
    }
  }
});

test('交叉一致性·suppressed/减材料：两处都不参与外形，盒逐字段相等（不许一边撑大一边不撑）', () => {
  const { params, parts } = conveyorFixture();
  const section = params.frameSectionMm;
  const withExtras = replaceFeatures(parts, 'rail-left', [
    boxFeature('rail-left-body', params.lengthMm, section, section),
    // 压缩的大块特征：内核编译时跳过 → 两处的盒都只能是 body 那一条
    boxFeature('rail-left-guard', params.lengthMm, 400, 400, { suppressed: true }),
    // 减材料特征：政策跳过，不撑大也不报错
    { id: 'rail-left-holes', type: 'holes', name: '安装孔', params: {} },
    { id: 'rail-left-slot', type: 'slot', name: '长槽', params: {} }
  ]);
  const part = partById(withExtras, 'rail-left');
  const derived = supportRowsFromConveyorPartsDetailed([part]);
  assert.deepEqual(derived.droppedPartIds, [], '合法件（含 suppressed/减材料）不许被剔');
  assert.equal(derived.rows.length, 1);
  const row = derived.rows[0];
  assert.deepEqual(rowFields(row), geometryRowOf(part), '两处的盒必须逐字段相等');
  assert.equal(round2(row.maxY - row.minY), round2(section), '被压缩的 400 宽特征不许撑大承托面');
  assert.equal(round2(row.maxZ - row.minZ), round2(section));
  assert.equal(round2(row.maxX - row.minX), round2(params.lengthMm));
});

test('判据只有一份实现：panel-channel 不再自算局部盒、减材料白名单只定义一次', () => {
  const panel = readFileSync(new URL('../../src/machine/panel-channel.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(panel, /function featureLocalBox/, 'panel-channel 不许再有第二套特征判据');
  assert.match(panel, /parsePartLocalBox\(part\.features\)/, 'panel-channel 必须走共用判据');
  const geometry = readFileSync(new URL('../../src/machine/machine-geometry.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(geometry, /function featureLocalBox/, 'machine-geometry 不许再有第二套特征判据');
  assert.match(geometry, /parsePartLocalBox\(part\.features\)/, 'machine-geometry 必须走共用判据');
  // 白名单/原因码只在 feature-box.ts 定义
  for (const [name, source] of [['machine-geometry', geometry], ['panel-channel', panel]]) {
    assert.doesNotMatch(source, /new Set\(\['holes', 'counterbore', 'slot', 'fillet'\]\)/, `${name} 不许再定义一份减材料白名单`);
  }
  // 世界盒换算（review P2 第二轮）：rotateLocal / rotate2 两份手写实现必须已并入 feature-box.ts
  const featureBox = readFileSync(new URL('../../src/machine/feature-box.ts', import.meta.url), 'utf8');
  assert.match(featureBox, /export function rotateAboutZ/, '旋转只有 feature-box.ts 一份');
  assert.match(featureBox, /export function worldBoxFromLocal/, '世界盒换算只有 feature-box.ts 一份');
  assert.match(featureBox, /export function inspectTransform/, 'transform 结构检查在同源模块里');
  for (const [name, source] of [['machine-geometry', geometry], ['panel-channel', panel]]) {
    assert.doesNotMatch(source, /function rotateLocal|function rotate2/, `${name} 不许再有第二份手写旋转`);
    assert.match(source, /worldBoxFromLocal/, `${name} 必须走共用世界盒换算`);
  }
});

test('结构级坏件（P2）：features 非数组 / 元素 null / params 缺 / transform 缺 → INVALID_ARGUMENT，通道只剔该件', () => {
  const { params, config, parts } = conveyorFixture();
  const cases = [
    { label: 'features=undefined', fault: 'malformed-part', featureLevel: true, mutate: (part) => ({ ...part, features: undefined }) },
    { label: 'features=null', fault: 'malformed-part', featureLevel: true, mutate: (part) => ({ ...part, features: null }) },
    { label: 'features 是字符串', fault: 'malformed-part', featureLevel: true, mutate: (part) => ({ ...part, features: 'rail-left-body' }) },
    { label: 'features=[null]', fault: 'malformed-feature', featureLevel: true, mutate: (part) => ({ ...part, features: [null] }) },
    {
      label: '特征缺 params',
      fault: 'malformed-feature',
      featureLevel: true,
      mutate: (part) => ({ ...part, features: [{ id: 'rail-left-body', type: 'box', name: '型材' }] })
    },
    { label: 'transform 缺', fault: 'malformed-part', featureLevel: false, mutate: (part) => ({ ...part, transform: undefined }) },
    {
      label: 'transform.rz=NaN',
      fault: 'malformed-part',
      featureLevel: false,
      mutate: (part) => ({ ...part, transform: { ...part.transform, rz: Number.NaN } })
    }
  ];
  for (const entry of cases) {
    const broken = parts.map((part) => (part.id === 'rail-left' ? entry.mutate(part) : part));
    const target = broken.find((part) => part.id === 'rail-left');

    // ① 共用判据：结构级坏件同样是 invalid + 固定原因码（transform 不在 parsePartLocalBox 的输入里，
    //    那两条只断言下面 ②③④ —— 不把「查不到」说成「查过且通过」）。
    if (entry.featureLevel) {
      const shared = parsePartLocalBox(target.features);
      assert.equal(shared.kind, 'invalid', `${entry.label}：共用判据必须判 invalid（旧口径 TypeError）`);
      assert.equal(shared.fault, entry.fault, `${entry.label}：共用判据原因码`);
    }

    // ② 几何/包络侧：抛 MachinePartGeometryError（件号 + 原因码），不是 TypeError
    const error = thrownBy(() => partWorldBounds(target));
    assert.ok(error instanceof MachinePartGeometryError, `${entry.label}：必须抛 MachinePartGeometryError（收到 ${error}）`);
    assert.equal(error.code, 'INVALID_PART_GEOMETRY');
    assert.equal(error.partId, 'rail-left');
    assert.equal(error.fault, entry.fault, `${entry.label}：结构级坏件的原因码`);
    assert.throws(
      () => conveyorGeometryFromParts(broken, config, params),
      (thrown) => thrown instanceof MachinePartGeometryError && thrown.fault === entry.fault,
      `${entry.label}：整机几何入口同样 fail-closed`
    );

    // ③ 错误分类：结构级坏件 = 件表数据坏 → INVALID_ARGUMENT（旧口径 TypeError → INTERNAL_ERROR）
    const classified = classifyDesignMachineFailure(error);
    assert.equal(classified.code, 'INVALID_ARGUMENT', `${entry.label}：不许落 INTERNAL_ERROR`);
    assert.equal(classified.partId, 'rail-left');
    assert.equal(classified.fault, entry.fault);
    assert.match(classified.hint, /件表数据本身不合法/);

    // ④ 通道侧：只剔这一件，其余件照常成行（旧口径整张行表 TypeError 中断）
    const derived = supportRowsFromConveyorPartsDetailed(broken);
    assert.deepEqual(derived.droppedPartIds, ['rail-left'], `${entry.label}：通道只剔坏件`);
    assert.equal(derived.rows.some((row) => row.id === 'rail-left'), false);
    assert.equal(derived.rows.length, broken.length - 1, `${entry.label}：其余件不许跟着消失`);
  }
});

test('世界盒换算·rz≠0：合成旋转件两处逐字段相等（旋转分支不再无覆盖）', () => {
  const { parts } = conveyorFixture();
  const base = partById(parts, 'rail-left');
  const rz = 30;
  // 局部盒中心偏到 (60, 20)：rz≠0 时「中心偏移也要旋转」，rz=0 分支看不出差别。
  const rotated = {
    ...base,
    transform: { x: 120, y: -80, z: 260, rz },
    features: [{ id: 'rail-left-pin', type: 'cylinder', name: '偏置销轴', params: { diameter: 40, height: 100, axis: 'z', at: [60, 20, 0] } }]
  };
  const world = partWorldBounds(rotated);
  const derived = supportRowsFromConveyorPartsDetailed([rotated]);
  assert.deepEqual(derived.droppedPartIds, []);
  assert.deepEqual(rowFields(derived.rows[0]), geometryRowOf(rotated), 'rz≠0 时两处盒必须逐字段相等');

  // 变异自证：旋转真的参与换算（否则这条用例对 rz≠0 分支零约束）
  const rad = (rz * Math.PI) / 180;
  const expectedCenterX = 120 + 60 * Math.cos(rad) - 20 * Math.sin(rad);
  const expectedCenterY = -80 + 60 * Math.sin(rad) + 20 * Math.cos(rad);
  const expectedHalfX = 20 * Math.cos(rad) + 20 * Math.sin(rad);
  assert.equal(round2(world.center[0]), round2(expectedCenterX), '中心必须绕 Z 旋转');
  assert.equal(round2(world.center[1]), round2(expectedCenterY));
  assert.equal(round2(world.half[0]), round2(expectedHalfX), 'AABB 半宽必须按 |cos|/|sin| 撑开');
  const straight = partWorldBounds({ ...rotated, transform: { ...rotated.transform, rz: 0 } });
  assert.notEqual(round2(world.center[0]), round2(straight.center[0]), 'rz≠0 与 rz=0 的盒必须不同');
  assert.notEqual(round2(world.half[0]), round2(straight.half[0]));
  assert.equal(round2(straight.half[0]), 20, 'rz=0 时半宽就是原尺寸');

  // 整表交叉一致性：所有件统一转 17°，两处逐件逐字段相等（不只挑一件）
  const allRotated = parts.map((part) => ({ ...part, transform: { ...part.transform, rz: 17 } }));
  const rowsById = new Map(supportRowsFromConveyorPartsDetailed(allRotated).rows.map((row) => [row.id, row]));
  for (const part of allRotated) {
    assert.deepEqual(rowFields(rowsById.get(part.id)), geometryRowOf(part), `${part.id}：rz=17 时两处盒必须相等`);
  }
});

/* ---------------- 9. 错误分类（T3 P2-4）：件表坏 ≠ 软件缺陷 ---------------- */

test('错误分类：INVALID_PART_GEOMETRY 映射 INVALID_ARGUMENT（带件号/原因码/特征定位），不落 INTERNAL_ERROR', () => {
  const { params, config, parts } = conveyorFixture();
  const broken = replaceFeatures(parts, 'rail-left', [boxFeature('rail-left-body', Number.NaN, params.frameSectionMm, params.frameSectionMm)]);
  const error = thrownBy(() => conveyorGeometryFromParts(broken, config, params));
  assert.ok(error instanceof MachinePartGeometryError);

  const result = machinePartGeometryFailure(error);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_ARGUMENT', '件表坏必须按调用方输入错分类，不是 INTERNAL_ERROR');
  assert.equal(result.partId, 'rail-left');
  assert.equal(result.fault, 'non-finite-param');
  assert.equal(result.featureIndex, 0);
  assert.equal(result.featureId, 'rail-left-body');
  assert.equal(result.featureType, 'box');
  assert.match(result.message, /rail-left/);
  // hint 必须指向"修件表"，不能再是"反馈现场日志"
  assert.match(result.hint, /件表数据本身不合法/);
  assert.match(result.hint, /suppressed/);
  assert.doesNotMatch(result.hint, /反馈现场日志/);

  // 分派按 code 判（跨模块实例/序列化回来的也认），字段不齐不猜
  assert.equal(isMachinePartGeometryError(error), true);
  assert.equal(isMachinePartGeometryError({ code: 'INVALID_PART_GEOMETRY', partId: 'p-1', fault: 'degenerate-box', featureIndex: -1, message: 'x' }), true);
  assert.equal(isMachinePartGeometryError({ code: 'INVALID_PART_GEOMETRY' }), false, '缺上下文的同 code 对象不许当证据');
  assert.equal(isMachinePartGeometryError(new RangeError('越界')), false);
  assert.equal(isMachinePartGeometryError({ code: 'INTERNAL_ERROR', message: 'x' }), false);

  // 分类顺序（catch 的唯一出口）：几何坏 → INVALID_ARGUMENT；其余三类不许被它吃掉
  const viaClassifier = classifyDesignMachineFailure(error);
  assert.equal(viaClassifier.code, 'INVALID_ARGUMENT');
  assert.equal(viaClassifier.partId, 'rail-left', '分类器必须把件号带出来');
  assert.equal(viaClassifier.fault, 'non-finite-param');
  assert.equal(classifyDesignMachineFailure(new BufferTowerConfigError('NOT_IMPLEMENTED', '双塔本期不支持')).code, 'NOT_IMPLEMENTED',
    'NOT_IMPLEMENTED 仍是 NOT_IMPLEMENTED，不许被几何分支抢走');
  assert.equal(classifyDesignMachineFailure(new RangeError('层距越界')).code, 'INVALID_ARGUMENT', '范围参数错仍是 INVALID_ARGUMENT');
  const internal = classifyDesignMachineFailure(new TypeError('constructor 里少个字段'));
  assert.equal(internal.code, 'INTERNAL_ERROR', '真软件缺陷仍必须是 INTERNAL_ERROR');
  assert.match(internal.hint, /反馈现场日志/);
  // 只带 code 的伪造对象走 INVALID_ARGUMENT 会缺上下文，故分类器要求字段齐全：这种情况落 INTERNAL_ERROR（不猜）
  assert.equal(classifyDesignMachineFailure({ code: 'INVALID_PART_GEOMETRY' }).code, 'INTERNAL_ERROR');

  // 接线：design_machine 的 catch 里，几何坏分支必须在 INTERNAL_ERROR 之前，且返回走上面这个映射
  const source = readFileSync(new URL('../../src/agent/tools.ts', import.meta.url), 'utf8');
  const geometryBranch = source.indexOf('[DESIGN_MACHINE_INVALID_PART_GEOMETRY]');
  const internalBranch = source.indexOf('[DESIGN_MACHINE_FAILED]');
  assert.ok(geometryBranch > 0, 'design_machine 必须为件表几何坏单独记一条日志');
  assert.ok(internalBranch > geometryBranch, '几何坏分支必须排在 INTERNAL_ERROR 之前');
  assert.match(source, /return machinePartGeometryFailure\(error\)/, '几何坏分支必须返回 INVALID_ARGUMENT 回执');
});
