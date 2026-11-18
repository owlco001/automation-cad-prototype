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
import { resolveMachineGeometry, towerLiftAxis } from '../../src/machine/machine-geometry.ts';
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
  assert.equal(geometry.partCount, parts.length);
  assert.equal(geometry.geometry.parts.length, 146);
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
  assert.match(source, /\.\.\.\(towerModel \? \{ design: towerModel\.design \} : \{\}\)/, '嵌套参数必须走 design 落盘');
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
