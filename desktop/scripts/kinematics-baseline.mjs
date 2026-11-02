#!/usr/bin/env node
// 运动学自动识别（kinematics-auto.ts）的 precision / recall 基线。
//
// 真值来源（不编造）：
//   1) 整机生成器 machine/geometry.ts 的 movingAxes —— 生成器自己声明「哪个零件沿哪个轴动、行程多少」，
//      这是仓库内唯一的确定性真值来源。配置由 machine/spec.ts 的 parseMachineBrief + machine/synth.ts
//      的 synthMachine 从中文需求文本确定性合成，全程无人工标注。
//   2) test/fixtures/kinematics-assembly.stp —— 仓库自带 STEP 夹具，真值取自生成该夹具的
//      scripts/gen-kinematics-fixture.mjs 的构造注释与 test/cad/kinematics-auto.test.mjs 的断言。
//      该夹具同时被单元测试覆盖（in-sample），结果单独列出、不计入主指标。
//
// 用法：
//   node scripts/kinematics-baseline.mjs                     # 人类可读摘要（默认 vector 口径）
//   node scripts/kinematics-baseline.mjs --stored-axis        # 只看「按存储轴打分」口径
//   node scripts/kinematics-baseline.mjs --both               # 两种口径都打（推荐复核用）
//   node scripts/kinematics-baseline.mjs --angle-variance     # 追加「角度有方差」样本组（只改
//        config.rotationRangeDeg，几何/件名/工位布局不变），历史 21 套的数字不受影响
//   node scripts/kinematics-baseline.mjs --json              # 只输出 JSON（stdout）
//   node scripts/kinematics-baseline.mjs --json=out.json     # 摘要 + 写 JSON 文件
//   KIN_BASELINE_SRC=/path/to/src node scripts/kinematics-baseline.mjs
//       对指定源码目录跑（默认 desktop/src）。工作树被并发修改时，用 git archive 导出的
//       干净版本跑，保证数字对应确定的代码状态。
//
// 两种打分口径（为什么必须都报）：
//   vector（历史口径）—— 方向用 suggestion.directionVector（吸附前的真实方向）比真值，
//     衡量「识别器看得准不准」。它看不见「看准了但存错了」：旧版标注层只认 ±X/±Y/±Z，
//     30° 斜装夹爪被存成 +Y，这条错误在 vector 口径下永远是"方向一致"。
//   stored（P0.5 新增）—— 方向用「实际写进标注的 axis + yawDeg + 正负号」还原出的向量比真值，
//     衡量「标注存得对不对」。yawDeg 落地前它与 vector 差 18 条（6 台机器 × 3 种命名约定）。
//
// 只读：不修改任何产品代码，不写仓库文件（除非显式 --json=<path>）。

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const repoRoot = resolve(desktopRoot, '..');
const srcRoot = process.env.KIN_BASELINE_SRC ? resolve(process.env.KIN_BASELINE_SRC) : resolve(desktopRoot, 'src');

const load = async (relative) => import(pathToFileURL(resolve(srcRoot, relative)).href);
const { parseMachineBrief } = await load('machine/spec.ts');
const { synthMachine } = await load('machine/synth.ts');
const { generateMachineGeometry } = await load('machine/geometry.ts');
const { pointOptionsFromMachineConfig } = await load('cad/kinematics-ui.ts');
const { suggestKinematics, batchGate } = await load('cad/kinematics-auto.ts');
const { axisDirectionVector } = await load('cad/kinematics.ts');
const { parseOcctBuffer } = await load('cad/step.ts');

const args = process.argv.slice(2);
const jsonOnly = args.includes('--json');
const jsonPath = args.find((arg) => arg.startsWith('--json='))?.slice('--json='.length);
/**
 * 打分口径：
 *   vector（默认）= 旧口径，拿 prediction.directionVector（**吸附前**的真实方向）比真值。
 *   stored        = 拿「实际会被写进标注的轴 + yawDeg + 正负号」拼出的向量比真值。
 * 两者必须都报：vector 口径反映「识别器看得准不准」，stored 口径反映「标注存得对不对」。
 * 只报 vector 会把「方向看准了但存成错轴」的条目算成正确（历史报表里 6 条夹爪错误就是这样被藏住的）。
 */
const scoreModes = args.includes('--stored-axis')
  ? ['stored']
  : args.includes('--both')
    ? ['vector', 'stored']
    : ['vector'];

/**
 * 角度方差样本（--angle-variance）：单独一组，不进上面的 21 套历史口径。
 * 唯一自变量是 config.actuators[].rotationRangeDeg —— 它只写进 GeomMovingAxis.rangeDeg（真值），
 * 不参与 mesh 生成（geometry.ts:681-717 的台面/治具几何与角度无关，脚本内会实测核对）。
 * 因此「同一台机器、同一布局、同一件名，只有真值角度不同」，角度是干净的自变量。
 */
const angleVarianceMode = args.includes('--angle-variance');

// ───────────────────────────────────────────── 1. 夹具：GeomPart → AutoKinMesh
//
// geometry.ts 的零件是概念占位体（box / cylinder），没有三角面片。这里按同一形状精确取样顶点：
// box 取 8 个角点、cylinder 取两端各 16 边形顶点，绕 Z 施加 rotationZDeg，最后平移到 center。
// 顶点是形状的精确采样，不是伪造几何；analyzeMeshShape 因此走 vertices 分支（PCA / 回转体判断）。

const SIDES = 16;

function rotateZ(point, deg) {
  if (!deg) return point;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [point[0] * cos - point[1] * sin, point[0] * sin + point[1] * cos, point[2]];
}

function partPositions(part) {
  const out = [];
  if (part.shape.type === 'box') {
    const [sx, sy, sz] = part.shape.size;
    for (const x of [-sx / 2, sx / 2]) {
      for (const y of [-sy / 2, sy / 2]) {
        for (const z of [-sz / 2, sz / 2]) out.push(...rotateZ([x, y, z], part.rotationZDeg));
      }
    }
  } else {
    const { radius, length, axis } = part.shape;
    const k = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    const u = (k + 1) % 3;
    const w = (k + 2) % 3;
    for (const offset of [-length / 2, length / 2]) {
      for (let i = 0; i < SIDES; i += 1) {
        const angle = (2 * Math.PI * i) / SIDES;
        const p = [0, 0, 0];
        p[k] = offset;
        p[u] = radius * Math.cos(angle);
        p[w] = radius * Math.sin(angle);
        out.push(...rotateZ(p, part.rotationZDeg));
      }
    }
  }
  const world = [];
  for (let i = 0; i < out.length; i += 3) {
    world.push(out[i] + part.center[0], out[i + 1] + part.center[1], out[i + 2] + part.center[2]);
  }
  return world;
}

function bboxOf(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      min[k] = Math.min(min[k], positions[i + k]);
      max[k] = Math.max(max[k], positions[i + k]);
    }
  }
  return {
    center: min.map((value, k) => (value + max[k]) / 2),
    size: min.map((value, k) => max[k] - value)
  };
}

function meshesFromParts(parts, pathFor) {
  return parts.map((part, id) => {
    const positions = partPositions(part);
    const { center, size } = bboxOf(positions);
    return {
      id,
      name: part.name,
      path: pathFor(part),
      center,
      size,
      triangles: part.shape.type === 'box' ? 12 : SIDES * 4,
      positions: new Float32Array(positions)
    };
  });
}

// ───────────────────────────────────────────── 2. 三种命名 / 导出约定
//
// 几何与真值在三种约定下完全相同，只有「名称与装配层级」变化——这正是自动识别唯一的输入信号，
// 所以三种约定是识别率的自变量，而不是不同的真值。
//
//   R1 generic    ：synthMachine 默认件名（"工位1气缸1 缸体 Ø32×40"），无子装配层级。最差情形。
//   R2 part-code  ：执行机构名带真实型号（型号取自 packs/builtin/pneumatic-cn/parts.json），
//                  型号出现在每个零件名里。常见于「零件名即料号」的导出。
//   R3 subassembly：中性件名（"工位1 A1 缸体"），型号只出现在子装配名
//                  （"ST1_CYL_A1_CDQ2B25-40DZ"）。常见于 SolidWorks/Inventor 的装配层级导出。

const MODELS = { cylinder: 'CDQ2B25-40DZ', gripper: 'MHZ2-16D', rotary: 'MSQB20A' };
const KIND_CN = { cylinder: '压装气缸', gripper: '气爪', rotary: '旋转台' };
const SLOT = { cylinder: 'CYL', gripper: 'GRIP', rotary: 'ROT' };

const stationTag = (part) => `ST${String(part.stationId ?? 'frame').replace(/\D/g, '') || '0'}`;

function actuatorSlot(actuators, part) {
  const actuator = actuators.find((entry) => entry.id === part.actuatorId);
  if (!actuator) return null;
  const index = actuators.filter((entry) => entry.station === actuator.station).indexOf(actuator) + 1;
  return { actuator, index };
}

const REGIMES = [
  {
    id: 'R1',
    label: 'R1 通用件名 / 无子装配层级',
    config: (base) => base,
    path: (part) => ['MACHINE', stationTag(part)]
  },
  {
    id: 'R2',
    label: 'R2 型号在零件名（真实型号）',
    config: (base) => ({
      ...base,
      actuators: base.actuators.map((entry) => ({
        ...entry,
        name: `${entry.station} ${KIND_CN[entry.kind]} ${MODELS[entry.kind]}`
      }))
    }),
    path: (part) => ['MACHINE', stationTag(part)]
  },
  {
    id: 'R3',
    label: 'R3 型号在子装配名 / 中性件名',
    config: (base) => ({
      ...base,
      actuators: base.actuators.map((entry) => {
        const index = base.actuators.filter((other) => other.station === entry.station).indexOf(entry) + 1;
        return { ...entry, name: `${entry.station} A${index}` };
      })
    }),
    path: (part) => {
      const slot = actuatorSlot(part.__actuators ?? [], part);
      if (!slot) return ['MACHINE', stationTag(part)];
      return ['MACHINE', stationTag(part), `${stationTag(part)}_${SLOT[slot.actuator.kind]}_A${slot.index}_${MODELS[slot.actuator.kind]}`];
    }
  }
];

// ───────────────────────────────────────────── 3. 数据集
//
// 需求文本是中文一句话（仓库自带的 parseMachineBrief 负责解析）；第 5 条是
// scripts/build-machine-case.mjs 里的真实案例 brief。
//
// 行程/角度按真实型号样本设定（CDQ2B25-40 → 40 mm；MHZ2-16D → 双指合计 6 mm；
// MSQB20A → 180°），使「型号」与「几何」自洽；否则比的是型号和几何互相打架，不是识别能力。
// 三种命名约定共用同一套几何，因此真值完全一致。

const BRIEFS = [
  { id: 'assembly-2st', text: '两工位装配机，节拍 12 件/分钟，每工位 1 套压装气缸 + 1 个气爪 + 2 个到位检测' },
  { id: 'screw-3st', text: '三工位锁螺丝机，节拍 20 件/分钟，每工位 1 个旋转轴 + 1 个气爪 + 1 个到位检测' },
  { id: 'packaging-4st', text: '四工位包装机，节拍 15 件/分钟，每工位 1 个推料气缸 + 1 个吸盘 + 1 个光电' },
  { id: 'dispense-1st', text: '单工位点胶机，节拍 8 件/分钟，1 个旋转轴 + 1 个压力传感器' },
  { id: 'screw-6st', text: '六工位锁螺丝机，节拍 20 件/分钟，每工位 1 套汇川 750W 伺服 + 1 个 SMC 气爪 + 1 个到位检测 + 安全光栅' },
  { id: 'inspection-2st', text: '两工位检测机，节拍 30 件/分钟，每工位 1 个旋转轴 + 1 个光电 + 安全光栅' },
  { id: 'conveyor-1st', text: '输送线，节拍 40 件/分钟，1 个旋转轴 + 2 个光电' }
];

const MODEL_TRAVEL = {
  cylinder: { travelMm: 40 },
  gripper: { travelMm: 6 },
  rotary: { rotationRangeDeg: 180 }
};

// ───────────────────────────────────────────── 3b. 角度方差样本（--angle-variance）
//
// 目的：历史 21 套里 14 条 rotary 真值**全是 180°**（角度方差 = 0），任何常数先验都满分，
// 因此「rotary 能不能推出角度」从未被真正测过。这里保持工位数、布局、件名、几何完全不变，
// 只把 config.actuators[].rotationRangeDeg 换成不同值，得到角度有方差的同一批装配。
//
// 核心 4 组（90 / 120 / 180 / 270）用于「常数先验」对比：每组 14 条 rotary 真值，均匀覆盖 4 个角度。
// 扩展组：45 / 360（边界与超程）、360N（控制组：把每条轴的真值设成该机 360/工位数，
//   即「这条轴其实是分度盘」的世界，用来检验 360/N 先验到底在什么前提下成立）。

const ANGLE_VARIANTS = [
  { id: '45', deg: () => 45, core: false, label: '45°' },
  { id: '90', deg: () => 90, core: true, label: '90°' },
  { id: '120', deg: () => 120, core: true, label: '120°' },
  { id: '180', deg: () => 180, core: true, label: '180°（= 历史基线角度）' },
  { id: '270', deg: () => 270, core: true, label: '270°' },
  { id: '360', deg: () => 360, core: false, label: '360°（整周）' },
  { id: '360N', deg: (_brief, stations) => 360 / stations, core: false, label: '360/N（分度盘口径，控制组）' }
];

/**
 * R4：型号后缀带角度（`MSQB20A-90`）。不是仓库现有导出约定，是一条**假设性**命名约定，
 * 用来回答「如果角度真的写在名字里，recall 是多少」—— 把「角度不可见」与「算法不会读角度」分开。
 * 旋转外的件名与 R2 完全相同，作为对照不变。
 */
const ANGLE_MODEL_REGIME = {
  id: 'R4',
  label: 'R4 型号后缀带角度（假设性命名约定）',
  config: (base) => ({
    ...base,
    actuators: base.actuators.map((entry) => ({
      ...entry,
      name:
        entry.kind === 'rotary'
          ? `${entry.station} ${KIND_CN.rotary} ${MODELS.rotary}-${Math.round(entry.rotationRangeDeg ?? 180)}`
          : `${entry.station} ${KIND_CN[entry.kind]} ${MODELS[entry.kind]}`
    }))
  }),
  path: (part) => ['MACHINE', stationTag(part)]
};

function baseConfig(brief, angleDeg) {
  const parsed = parseMachineBrief(brief.text);
  // id 必须是 design-<process>-<n>st：geometry.ts 的 inferProcess() 靠它推断工艺，进而决定布局
  // （dial / linear / single）。用别的 id 会让所有机器退化成默认 linear 布局。
  const design = synthMachine(parsed, { id: `design-${parsed.process}-${parsed.stations}st` });
  return {
    ...design.config,
    actuators: design.config.actuators.map((entry) => ({
      ...entry,
      ...MODEL_TRAVEL[entry.kind],
      // 角度变体：只改真值来源（rotationRangeDeg），不动任何几何参数
      ...(angleDeg !== undefined && entry.kind === 'rotary' ? { rotationRangeDeg: angleDeg } : {})
    }))
  };
}

function machineCase(brief, regime, angleDeg) {
  const config = regime.config(baseConfig(brief, angleDeg));
  const geometry = generateMachineGeometry(config, { bypassCache: true });
  const parts = geometry.parts.map((part) => ({ ...part, __actuators: config.actuators }));
  const meshes = meshesFromParts(parts, regime.path);
  const idOf = new Map(parts.map((part, index) => [part.id, index]));
  const truth = geometry.moving.map((axis, index) => ({
    id: `${brief.id}/${regime.id}/T${index + 1}`,
    source: 'generator-moving-axes',
    machine: brief.id,
    regime: regime.id,
    actuatorId: axis.actuatorId,
    kind: axis.kind,
    partIds: axis.partIds.map((partId) => idOf.get(partId)).filter((value) => value !== undefined),
    partNames: axis.partIds,
    axis: axis.axis,
    travelMm: axis.kind === 'linear' ? axis.strokeMm : 0,
    rangeDeg: axis.kind === 'rotary' ? axis.rangeDeg : 0,
    singleTravelMm: axis.kind === 'gripper' ? axis.strokeMm / 2 : null,
    expectedCategory: axis.kind === 'linear' ? 'cylinder' : axis.kind,
    point: axis.points.extend ?? axis.points.grip ?? axis.points.point ?? ''
  }));
  return {
    id: `${brief.id}/${regime.id}`,
    dataset: 'generated-machine',
    brief: brief.text,
    regime: regime.id,
    layout: geometry.layout,
    parts: parts.length,
    // 360/N 先验用的工位数：全台不同工位标签数（与历史文档 §2.3 同口径）
    stations: new Set(config.actuators.map((entry) => entry.station)).size,
    meshes,
    points: pointOptionsFromMachineConfig(config),
    truth,
    partRoles: new Map(parts.map((part, index) => [index, part.role]))
  };
}

// 仓库自带 STEP 夹具：真值来自 gen-kinematics-fixture.mjs 的构造与单元测试断言（in-sample）。
const FIXTURE_TRUTH = [
  { name: 'CDJ2B16-50_rod', kind: 'linear', expectedCategory: 'cylinder', axis: [1, 0, 0], travelMm: 50, point: 'ST1-EXT-A1' },
  { name: 'ST1_CARRIAGE_MGN12H', kind: 'linear', expectedCategory: 'rail', axis: [0, 1, 0], travelMm: 250, point: '' },
  { name: 'MSQB20A_table', kind: 'rotary', expectedCategory: 'rotary', axis: [0, 0, 1], rangeDeg: 180, point: 'ST2-ROT-A1' },
  { name: 'finger_L', kind: 'gripper', expectedCategory: 'gripper', axis: [1, 0, 0], travelMm: 3, point: 'ST2-GRIP-A2' }
];
const FIXTURE_MUST_NOT_BE_HIGH = ['伺服电机_400W'];

// 夹具的 IO 点位表：与 test/cad/kinematics-auto.test.mjs 的 CONFIG 一致（夹具设计的一部分）。
const FIXTURE_POINTS_CONFIG = {
  actuators: [
    { id: 'a1', name: 'ST1 压装气缸', kind: 'cylinder', station: 'ST1', extendPoint: 'ST1-EXT-A1', retractPoint: 'ST1-RET-A1', travelMm: 50 },
    { id: 'a2', name: 'ST2 推料气缸', kind: 'cylinder', station: 'ST2', extendPoint: 'ST2-EXT-A1', retractPoint: 'ST2-RET-A1' },
    { id: 'a3', name: 'ST2 旋转台', kind: 'rotary', station: 'ST2', point: 'ST2-ROT-A1' },
    { id: 'a4', name: 'ST2 夹爪', kind: 'gripper', station: 'ST2', gripPoint: 'ST2-GRIP-A2' },
    { id: 'a5', name: 'ST3 顶升气缸', kind: 'cylinder', station: 'ST3', extendPoint: 'ST3-EXT-A2', retractPoint: 'ST3-RET-A2' }
  ]
};

async function fixtureCase() {
  const file = resolve(desktopRoot, 'test/fixtures/kinematics-assembly.stp');
  const buffer = readFileSync(file);
  const parsed = await parseOcctBuffer(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    'kinematics-assembly.stp'
  );
  const meshes = parsed.meshes.map((mesh, id) => {
    const { center, size } = bboxOf(Array.from(mesh.positions));
    return {
      id,
      name: mesh.name,
      path: mesh.path,
      center,
      size,
      triangles: mesh.indices ? mesh.indices.length / 3 : 0,
      positions: mesh.positions
    };
  });
  const byName = new Map(meshes.map((mesh) => [mesh.name, mesh.id]));
  const truth = FIXTURE_TRUTH.map((entry, index) => ({
    id: `fixture/T${index + 1}`,
    source: 'fixture-design',
    machine: 'fixture',
    regime: 'STEP',
    kind: entry.kind,
    partIds: [byName.get(entry.name)],
    partNames: [entry.name],
    axis: entry.axis,
    travelMm: entry.kind === 'rotary' ? 0 : entry.travelMm,
    rangeDeg: entry.kind === 'rotary' ? entry.rangeDeg : 0,
    singleTravelMm: null,
    expectedCategory: entry.expectedCategory,
    point: entry.point
  }));
  return {
    id: 'kinematics-assembly.stp',
    dataset: 'repo-fixture-step',
    brief: 'test/fixtures/kinematics-assembly.stp（仓库自带夹具；单元测试已覆盖 → in-sample）',
    regime: 'STEP',
    layout: '-',
    parts: meshes.length,
    meshes,
    points: pointOptionsFromMachineConfig(FIXTURE_POINTS_CONFIG),
    truth,
    partRoles: new Map(),
    mustNotBeHigh: FIXTURE_MUST_NOT_BE_HIGH.map((name) => byName.get(name)).filter((value) => value !== undefined)
  };
}

// ───────────────────────────────────────────── 4. 判定规则

const ANGLE_TOL_DEG = 20;
/** 生成器有几何、但没写进 movingAxes 的会动件（分度盘、转盘治具、输送线驱动）。 */
const UNANNOTATED_PATTERN = /分度|转盘|滚筒|输送线|减速电机/;
const DEG = Math.PI / 180;

function unit(value) {
  if (!Array.isArray(value) || value.length < 3) return null;
  const length = Math.hypot(value[0], value[1], value[2]);
  return length > 1e-9 ? [value[0] / length, value[1] / length, value[2] / length] : null;
}

const axisAgrees = (truthAxis, predictionAxis, kind) => {
  const a = unit(truthAxis);
  const b = unit(predictionAxis);
  if (!a || !b) return false;
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // 直线机构要判正负（伸出方向）；旋转/夹爪只看轴线
  if (kind === 'linear') return dot >= Math.cos(ANGLE_TOL_DEG * DEG);
  return Math.acos(Math.min(1, Math.abs(dot))) <= ANGLE_TOL_DEG * DEG;
};

const travelTarget = (truth) => (truth.kind === 'gripper' ? truth.singleTravelMm : truth.kind === 'rotary' ? truth.rangeDeg : truth.travelMm);
const travelValue = (prediction) => (prediction.kind === 'rotary' ? prediction.rangeDeg : prediction.travelMm);
const travelAgrees = (truth, prediction) => {
  const expected = travelTarget(truth);
  if (expected === null || expected === undefined) return true;
  return Math.abs(travelValue(prediction) - expected) <= Math.max(1, 0.05 * Math.abs(expected));
};

/**
 * 一条建议「实际存进标注」的方向向量：轴名 + 水平偏角 + 正负号。
 * 这正是采纳后 `MovingPart`/`KinematicsAxis` 能被 axisPose 还原出来的唯一信息 ——
 * 也正因为如此，旧版（只有轴名）会把 30° 的夹爪存成 90° 偏的方向。
 */
const storedVectorOf = (prediction) =>
  axisDirectionVector(prediction.axis, prediction.yawDeg ?? 0, prediction.direction === -1 ? -1 : 1);

/**
 * 一个装配单元的打分：真值机制 ↔ 建议 1:1 匹配（按重叠网格数贪心）。
 */
function evaluateCase(testCase) {
  const result = suggestKinematics(testCase.meshes, { pointOptions: testCase.points });
  const predictions = [...result.suggestions, ...result.lowConfidence].map((suggestion) => ({ ...suggestion, machine: testCase.id }));
  const truth = testCase.truth;

  const pairs = [];
  for (const [ti, item] of truth.entries()) {
    for (const [pi, prediction] of predictions.entries()) {
      const overlap = prediction.meshIds.filter((id) => item.partIds.includes(id)).length;
      if (overlap > 0) pairs.push({ ti, pi, overlap });
    }
  }
  pairs.sort((a, b) => b.overlap - a.overlap || predictions[b.pi].confidence - predictions[a.pi].confidence);
  const truthTaken = new Set();
  const predictionTaken = new Set();
  const matched = [];
  for (const pair of pairs) {
    if (truthTaken.has(pair.ti) || predictionTaken.has(pair.pi)) continue;
    truthTaken.add(pair.ti);
    predictionTaken.add(pair.pi);
    const item = truth[pair.ti];
    const prediction = predictions[pair.pi];
    const categoryOk = prediction.category === item.expectedCategory;
    const directionOk = axisAgrees(item.axis, prediction.directionVector, item.kind);
    const storedVector = storedVectorOf(prediction);
    const directionOkStored = axisAgrees(item.axis, storedVector, item.kind);
    const strokeOk = travelAgrees(item, prediction);
    matched.push({
      machine: testCase.id,
      regime: testCase.regime,
      truthId: item.id,
      kind: item.kind,
      category: item.expectedCategory,
      predictedCategory: prediction.category,
      confidence: prediction.confidence,
      level: prediction.level,
      overlap: pair.overlap,
      meshPrecision: prediction.meshIds.length ? pair.overlap / prediction.meshIds.length : 0,
      meshRecall: item.partIds.length ? pair.overlap / item.partIds.length : 0,
      categoryOk,
      directionOk,
      directionOkStored,
      strokeOk,
      pointOk: item.point ? prediction.point === item.point : null,
      pointExpected: item.point,
      pointPredicted: prediction.point,
      strict: categoryOk && directionOk && strokeOk,
      strictStored: categoryOk && directionOkStored && strokeOk,
      truthAxis: item.axis,
      predictedVector: prediction.directionVector,
      predictedStoredVector: storedVector,
      predictedSnappedAxis: prediction.axis,
      predictedYawDeg: prediction.yawDeg ?? 0,
      residualDeg: prediction.residualDeg ?? 0,
      offAxisDeg: prediction.offAxisDeg,
      truthTravel: travelTarget(item),
      predictedTravel: travelValue(prediction),
      strokeSource: prediction.strokeSource,
      // 产品里「批量采纳」的实际闸门（conf≥0.8 + 来源∈{model-code,catalog} + 偏轴≤5°）
      batchOk: batchGate(prediction).ok,
      name: prediction.name,
      meshNames: prediction.meshNames
    });
  }

  const falseNegatives = truth
    .filter((_item, index) => !truthTaken.has(index))
    .map((item) => {
      const skipped = result.skipped.find((entry) => entry.meshIds.some((id) => item.partIds.includes(id)));
      return {
        machine: testCase.id,
        regime: testCase.regime,
        truthId: item.id,
        kind: item.kind,
        category: item.expectedCategory,
        partNames: item.partNames,
        reason: skipped ? skipped.reason : '未产出任何建议（网格未进入任何聚类）'
      };
    });

  const partsById = testCase.partRoles ?? new Map();
  const matchedTruthIds = new Set(matched.map((entry) => entry.truthId));
  const falsePositives = predictions
    .filter((_prediction, index) => !predictionTaken.has(index))
    .map((prediction) => {
      const overlapsTruth = truth.find((item) => prediction.meshIds.some((id) => item.partIds.includes(id)));
      const roles = prediction.meshIds.map((id) => partsById.get(id)).filter(Boolean);
      const text = prediction.meshNames.join(' ');
      let type;
      if (overlapsTruth) type = 'duplicate-split';
      // 分度盘 / 转盘治具 / 输送线电机：确实会动，但生成器没写进 movingAxes → 真值缺口，不算误判
      else if (UNANNOTATED_PATTERN.test(text) || roles.some((role) => role === 'transfer')) type = 'unlabeled-mechanism';
      else if (roles.length > 0 && roles.every((role) => ['frame', 'plate', 'structure', 'fixture', 'sensor', 'safety'].includes(role))) type = 'structure';
      else if (roles.some((role) => role === 'actuator')) type = 'fragment';
      else type = 'other';
      return {
        machine: testCase.id,
        regime: testCase.regime,
        type,
        category: prediction.category,
        kind: prediction.kind,
        confidence: prediction.confidence,
        level: prediction.level,
        name: prediction.name,
        meshNames: prediction.meshNames,
        overlapsTruth: overlapsTruth ? overlapsTruth.id : null,
        alreadyMatched: overlapsTruth ? matchedTruthIds.has(overlapsTruth.id) : false
      };
    });

  const mustNotBeHigh = (testCase.mustNotBeHigh ?? []).map((id) => {
    const prediction = predictions.find((entry) => entry.meshIds.includes(id));
    return {
      machine: testCase.id,
      meshId: id,
      name: testCase.meshes.find((mesh) => mesh.id === id)?.name ?? '',
      confidence: prediction?.confidence ?? null,
      level: prediction?.level ?? 'none'
    };
  });

  return { testCase, stats: result.stats, predictions, matched, falseNegatives, falsePositives, mustNotBeHigh };
}

// ───────────────────────────────────────────── 5. 聚合

const ratio = (numerator, denominator) => (denominator === 0 ? null : numerator / denominator);

/**
 * 一个置信度档位的指标。`mode` 决定「方向正确」用哪个口径：
 *   'vector' = 建议里的真实方向向量（吸附前）；'stored' = 实际会存进标注的轴 + yaw。
 */
function band(records, truthTotal, minConfidence, mode = 'vector') {
  const predictions = records.flatMap((record) => record.predictions).filter((entry) => entry.confidence >= minConfidence);
  const matched = records.flatMap((record) => record.matched).filter((entry) => entry.confidence >= minConfidence);
  const falsePositives = records.flatMap((record) => record.falsePositives).filter((entry) => entry.confidence >= minConfidence);
  const extraByType = {};
  for (const item of falsePositives) extraByType[item.type] = (extraByType[item.type] ?? 0) + 1;
  const unlabeled = falsePositives.filter((entry) => entry.type === 'unlabeled-mechanism').length;
  const strictKey = mode === 'stored' ? 'strictStored' : 'strict';
  const directionKey = mode === 'stored' ? 'directionOkStored' : 'directionOk';
  const tp = matched.filter((entry) => entry[strictKey]).length;
  const precision = ratio(tp, predictions.length);
  const recall = ratio(tp, truthTotal);
  return {
    minConfidence,
    mode,
    predictions: predictions.length,
    truth: truthTotal,
    matched: matched.length,
    truePositives: tp,
    precision,
    recall,
    f1: precision === null || recall === null || precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    looseRecall: ratio(matched.length, truthTotal),
    directionAccuracy: matched.length ? matched.filter((entry) => entry[directionKey]).length / matched.length : null,
    strokeAccuracy: matched.length ? matched.filter((entry) => entry.strokeOk).length / matched.length : null,
    extraByType,
    /** 扣掉「真值缺口」（生成器未标注的分度盘/输送线电机）后的 precision。 */
    precisionExcludingUnlabeled: ratio(tp, predictions.length - unlabeled),
    meshPrecision: matched.length ? matched.reduce((sum, entry) => sum + entry.meshPrecision, 0) / matched.length : null,
    meshRecall: matched.length ? matched.reduce((sum, entry) => sum + entry.meshRecall, 0) / matched.length : null,
    pointAccuracy: (() => {
      const withPoint = matched.filter((entry) => entry.pointOk !== null);
      return withPoint.length ? withPoint.filter((entry) => entry.pointOk).length / withPoint.length : null;
    })()
  };
}

function aggregate(records, label, mode = 'vector') {
  const truthTotal = records.reduce((sum, record) => sum + record.testCase.truth.length, 0);
  const bands = [0, 0.6, 0.8, 0.9].map((minConfidence) => band(records, truthTotal, minConfidence, 'vector'));
  const bandsStored = [0, 0.6, 0.8, 0.9].map((minConfidence) => band(records, truthTotal, minConfidence, 'stored'));
  // 本次汇总的主口径：整张表、错误计数、分类明细统一用它，避免同一份报表里混两种口径
  const shown = mode === 'stored' ? bandsStored : bands;
  const strictKey = mode === 'stored' ? 'strictStored' : 'strict';
  const directionKey = mode === 'stored' ? 'directionOkStored' : 'directionOk';
  const matched = records.flatMap((record) => record.matched);
  const falsePositives = records.flatMap((record) => record.falsePositives);
  const falseNegatives = records.flatMap((record) => record.falseNegatives);
  const fpByType = {};
  for (const item of falsePositives) fpByType[item.type] = (fpByType[item.type] ?? 0) + 1;
  const strokeSources = {};
  for (const entry of matched) strokeSources[entry.strokeSource] = (strokeSources[entry.strokeSource] ?? 0) + 1;
  const byCategory = {};
  const truthByCategory = {};
  for (const record of records) {
    for (const item of record.testCase.truth) truthByCategory[item.expectedCategory] = (truthByCategory[item.expectedCategory] ?? 0) + 1;
  }
  for (const entry of matched) {
    byCategory[entry.category] ??= { matched: 0, strict: 0, directionOk: 0, strokeOk: 0 };
    byCategory[entry.category].matched += 1;
    if (entry[strictKey]) byCategory[entry.category].strict += 1;
    if (entry[directionKey]) byCategory[entry.category].directionOk += 1;
    if (entry.strokeOk) byCategory[entry.category].strokeOk += 1;
  }
  const byCategoryAt06 = {};
  for (const entry of matched.filter((item) => item.confidence >= 0.6)) {
    byCategoryAt06[entry.category] ??= { matched: 0, strict: 0 };
    byCategoryAt06[entry.category].matched += 1;
    if (entry[strictKey]) byCategoryAt06[entry.category].strict += 1;
  }
  return {
    label,
    mode,
    byCategoryAt06,
    assemblies: records.length,
    meshes: records.reduce((sum, record) => sum + record.testCase.meshes.length, 0),
    truthMechanisms: truthTotal,
    predicted: records.reduce((sum, record) => sum + record.predictions.length, 0),
    bands: shown,
    bandsByMode: { vector: bands, stored: bandsStored },
    errorCounts: {
      roleOrCategoryWrong: matched.filter((entry) => !entry.categoryOk).length,
      directionWrong: matched.filter((entry) => !entry[directionKey]).length,
      strokeWrong: matched.filter((entry) => !entry.strokeOk).length,
      extra: falsePositives.length,
      missing: falseNegatives.length
    },
    falsePositiveTypes: fpByType,
    strokeSources,
    byCategory,
    truthByCategory,
    mustNotBeHighViolations: records.flatMap((record) => record.mustNotBeHigh).filter((entry) => entry.level === 'high')
  };
}

// ───────────────────────────────────────────── 6. 输出

const pct = (value) => (value === null || value === undefined ? '  —  ' : `${(value * 100).toFixed(1)}%`.padStart(6));

function printBandTable(title, summary) {
  console.log(`\n${title}（${summary.assemblies} 套装配 · ${summary.meshes} 个网格 · 真值 ${summary.truthMechanisms} 条）`);
  console.log('  档位   预测  真值  命中  严格  多余  precision  扣缺口P  recall      F1   方向  行程  网格P  网格R');
  for (const row of summary.bands) {
    const extra = Object.values(row.extraByType).reduce((sum, value) => sum + value, 0);
    console.log(
      `  ≥${row.minConfidence.toFixed(1)}  ${String(row.predictions).padStart(5)} ${String(row.truth).padStart(5)} ${String(row.matched).padStart(5)} ${String(row.truePositives).padStart(5)} ${String(extra).padStart(5)}   ${pct(row.precision)}  ${pct(row.precisionExcludingUnlabeled)}  ${pct(row.recall)} ${pct(row.f1)} ${pct(row.directionAccuracy)} ${pct(row.strokeAccuracy)} ${pct(row.meshPrecision)} ${pct(row.meshRecall)}`
    );
  }
  const at06 = summary.bands.find((row) => row.minConfidence === 0.6);
  const types = Object.entries(at06.extraByType).map(([key, value]) => `${key} ${value}`).join(' · ') || '无';
  console.log(`  ≥0.6 档多余项构成：${types}（「未标注机构」= 生成器没写进 movingAxes 的分度盘/输送线电机，属真值缺口）`);
}

function printErrors(summary) {
  const { errorCounts, falsePositiveTypes, strokeSources } = summary;
  console.log(
    `  误判：角色/类别错 ${errorCounts.roleOrCategoryWrong} · 方向错 ${errorCounts.directionWrong} · 行程错 ${errorCounts.strokeWrong} · 多余项 ${errorCounts.extra} · 漏项 ${errorCounts.missing}`
  );
  console.log(
    `  多余项来源：${Object.entries(falsePositiveTypes).map(([key, value]) => `${key} ${value}`).join(' · ') || '无'} ｜ 命中项的行程来源：${Object.entries(strokeSources).map(([key, value]) => `${key} ${value}`).join(' · ') || '无'}`
  );
}

// ───────────────────────────────────────────── 7. 角度方差样本（--angle-variance）

/** 与 travelAgrees 同一容差：|c − 真值| ≤ max(1, 5%·真值)。 */
const angleWithinTol = (value, expected) => Math.abs(value - expected) <= Math.max(1, 0.05 * Math.abs(expected));

/** 几何指纹：件名 + 中心 + 形状 + 自身 rotationZ。用来实测「角度只改真值、不改几何」。 */
const geometrySignature = (parts) =>
  JSON.stringify(parts.map((part) => [part.name, part.center, part.shape, part.rotationZDeg]));

function stationsOf(brief) {
  const parsed = parseMachineBrief(brief.text);
  return Math.max(1, Number(parsed.stations) || 1);
}

/** 实测核对：同一台机器切换 rotationRangeDeg，几何指纹必须逐字相同。 */
function geometryInvariantCheck() {
  const mismatches = [];
  for (const brief of BRIEFS) {
    const reference = geometrySignature(generateMachineGeometry(baseConfig(brief), { bypassCache: true }).parts);
    for (const variant of ANGLE_VARIANTS) {
      const deg = variant.deg(brief, stationsOf(brief));
      const signature = geometrySignature(generateMachineGeometry(baseConfig(brief, deg), { bypassCache: true }).parts);
      if (signature !== reference) mismatches.push(`${brief.id}@${variant.id}`);
    }
  }
  return mismatches;
}

/** 角度变体的整批录制：变体 × 约定（R1/R2/R3/R4）× 7 台。 */
function angleVarianceRecords() {
  const regimes = [...REGIMES, ANGLE_MODEL_REGIME];
  const records = [];
  for (const variant of ANGLE_VARIANTS) {
    for (const regime of regimes) {
      for (const brief of BRIEFS) {
        const deg = variant.deg(brief, stationsOf(brief));
        const record = evaluateCase(machineCase(brief, regime, deg));
        record.variant = variant.id;
        record.variantDeg = deg;
        records.push(record);
      }
    }
  }
  return records;
}

/** 某一变体 × 某一约定的 rotary 明细（真值条数 / 命中 / 严格 / 角度对 / 预测角度分布）。 */
function rotarySlice(records) {
  const truths = records.flatMap((record) => record.testCase.truth.filter((item) => item.kind === 'rotary'));
  const matched = records.flatMap((record) =>
    record.matched
      .filter((entry) => entry.kind === 'rotary')
      .map((entry) => ({ ...entry, stations: record.testCase.stations, layout: record.testCase.layout }))
  );
  const at06 = matched.filter((entry) => entry.confidence >= 0.6);
  const predictedAt06 = records
    .flatMap((record) => record.predictions)
    .filter((entry) => entry.category === 'rotary' && entry.confidence >= 0.6).length;
  const predictedAngles = {};
  const sources = {};
  for (const entry of matched) {
    const key = `${entry.predictedTravel}°`;
    predictedAngles[key] = (predictedAngles[key] ?? 0) + 1;
    sources[entry.strokeSource] = (sources[entry.strokeSource] ?? 0) + 1;
  }
  return {
    truth: truths.length,
    matched: matched.length,
    strict: matched.filter((entry) => entry.strict).length,
    strictAt06: at06.filter((entry) => entry.strict).length,
    predictedAt06,
    angleOk: matched.filter((entry) => entry.strokeOk).length,
    highConfidenceWrongAngle: matched.filter((entry) => entry.confidence >= 0.6 && !entry.strokeOk).length,
    // 能通过产品「批量采纳」闸门、但角度是错的条数（会无提示写进标注）
    batchOk: matched.filter((entry) => entry.batchOk).length,
    batchOkWrongAngle: matched.filter((entry) => entry.batchOk && !entry.strokeOk).length,
    // 通过闸门且角度正确的条数（用来说明「对的仍然进得去」，不是把旋转台整体挡死）
    batchOkAngleOk: matched.filter((entry) => entry.batchOk && entry.strokeOk).length,
    predictedAngles,
    sources,
    truthAngles: [...new Set(truths.map((item) => item.rangeDeg))].sort((a, b) => a - b),
    entries: matched
  };
}

/**
 * 常数先验：把每条建议的**角度**替换成常数 c（或 360/N），其余字段（类别/方向/置信度）不动，
 * 再用同一容差重判行程。这样得到的是「若产品预填 c，会有多少条对」——与历史 §2.3 的
 * KIN_ROTARY_PRIOR 实验同口径，但这里的数据集角度有方差。
 */
function priorHits(entries, prior) {
  return entries.filter((entry) => {
    const value = typeof prior === 'function' ? prior(entry) : prior;
    return Number.isFinite(value) && angleWithinTol(value, entry.truthTravel);
  }).length;
}

const PRIOR_CONSTANTS = [45, 60, 90, 120, 150, 180, 270, 360];

/** 汇总「角度方差」这一组：不做产品代码改动，全部是对真实运行的统计。 */
function buildAngleVariance() {
  const geometryMismatches = geometryInvariantCheck();
  const records = angleVarianceRecords();
  const regimes = [...REGIMES, ANGLE_MODEL_REGIME];
  const sliceOf = (variantId, regimeId) =>
    rotarySlice(records.filter((record) => record.variant === variantId && record.testCase.regime === regimeId));

  const variants = ANGLE_VARIANTS.map((variant) => ({
    id: variant.id,
    label: variant.label,
    core: variant.core,
    byRegime: regimes.map((regime) => {
      const slice = sliceOf(variant.id, regime.id);
      return {
        regime: regime.id,
        truth: slice.truth,
        matched: slice.matched,
        strict: slice.strict,
        strictAt06: slice.strictAt06,
        predictedAt06: slice.predictedAt06,
        angleOk: slice.angleOk,
        highConfidenceWrongAngle: slice.highConfidenceWrongAngle,
        batchOk: slice.batchOk,
        batchOkWrongAngle: slice.batchOkWrongAngle,
        batchOkAngleOk: slice.batchOkAngleOk,
        truthAngles: slice.truthAngles,
        predictedAngles: slice.predictedAngles,
        sources: slice.sources
      };
    })
  }));

  // 常数先验矩阵：口径 = R1（无型号，产品今天就是靠 default 90° 兜底的那一档）
  const priorRows = PRIOR_CONSTANTS.map((value) => ({
    prior: String(value),
    hits: Object.fromEntries(
      ANGLE_VARIANTS.map((variant) => [variant.id, priorHits(sliceOf(variant.id, 'R1').entries, value)])
    )
  }));
  priorRows.push({
    prior: '360/N',
    hits: Object.fromEntries(
      ANGLE_VARIANTS.map((variant) => [
        variant.id,
        priorHits(sliceOf(variant.id, 'R1').entries, (entry) => 360 / entry.stations)
      ])
    )
  });
  priorRows.push({
    prior: '识别器(R1)',
    hits: Object.fromEntries(ANGLE_VARIANTS.map((variant) => [variant.id, sliceOf(variant.id, 'R1').angleOk]))
  });
  priorRows.push({
    prior: '识别器(R2)',
    hits: Object.fromEntries(ANGLE_VARIANTS.map((variant) => [variant.id, sliceOf(variant.id, 'R2').angleOk]))
  });
  priorRows.push({
    prior: '识别器(R4)',
    hits: Object.fromEntries(ANGLE_VARIANTS.map((variant) => [variant.id, sliceOf(variant.id, 'R4').angleOk]))
  });

  const coreVariants = ANGLE_VARIANTS.filter((variant) => variant.core).map((variant) => variant.id);
  // 每命名约定的 rotary 真值条数（跨 7 台求和，取任一约定 — 三种约定几何相同，条数必然一致）
  const rotaryTruthPerConvention = records
    .filter((record) => record.variant === ANGLE_VARIANTS[0].id && record.testCase.regime === 'R1')
    .reduce((total, record) => total + record.testCase.truth.filter((item) => item.kind === 'rotary').length, 0);
  const perRegime = regimes.map((regime) => {
    const slices = coreVariants.map((variantId) => sliceOf(variantId, regime.id));
    const sum = (key) => slices.reduce((total, slice) => total + slice[key], 0);
    return {
      regime: regime.id,
      label: regime.label,
      truth: sum('truth'),
      matched: sum('matched'),
      strict: sum('strict'),
      strictAt06: sum('strictAt06'),
      predictedAt06: sum('predictedAt06'),
      angleOk: sum('angleOk'),
      highConfidenceWrongAngle: sum('highConfidenceWrongAngle'),
      batchOk: sum('batchOk'),
      batchOkWrongAngle: sum('batchOkWrongAngle'),
      batchOkAngleOk: sum('batchOkAngleOk'),
      predictedAngles: slices.reduce((acc, slice) => {
        for (const [key, value] of Object.entries(slice.predictedAngles)) acc[key] = (acc[key] ?? 0) + value;
        return acc;
      }, {}),
      sources: slices.reduce((acc, slice) => {
        for (const [key, value] of Object.entries(slice.sources)) acc[key] = (acc[key] ?? 0) + value;
        return acc;
      }, {})
    };
  });

  // 确定性核对（与历史组同样的口径）：任取一例跑两遍
  const probeA = evaluateCase(machineCase(BRIEFS[1], REGIMES[0], 90));
  const probeB = evaluateCase(machineCase(BRIEFS[1], REGIMES[0], 90));
  const determinism =
    JSON.stringify(probeA.predictions) === JSON.stringify(probeB.predictions) &&
    JSON.stringify(probeA.matched) === JSON.stringify(probeB.matched);

  return {
    geometryInvariant: geometryMismatches.length === 0,
    geometryMismatches,
    determinism,
    variants: ANGLE_VARIANTS.length,
    regimes: regimes.map((regime) => regime.id),
    assemblies: records.length,
    rotaryTruthPerConvention,
    coreVariants,
    byVariant: variants,
    priorRows,
    perRegime,
    note:
      '角度变体只改 config.actuators[].rotationRangeDeg（GeomMovingAxis.rangeDeg 的真值来源），几何/件名/工位布局不变；' +
      '常数先验 = 把建议角度替换成常数后按同一容差重判，其余字段不动。'
  };
}

const visualWidth = (text) => [...text].reduce((width, ch) => width + (/[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1), 0);
const padEndW = (text, width) => text + ' '.repeat(Math.max(0, width - visualWidth(text)));
const padStartW = (text, width) => ' '.repeat(Math.max(0, width - visualWidth(text))) + text;

function printAngleVariance(report) {
  console.log('\n════════════════ 角度方差样本（--angle-variance · 独立于历史 21 套口径）════════════════');
  console.log(
    `几何不受角度影响的实测核对：${report.geometryInvariant ? '通过' : `失败（${report.geometryMismatches.join(' ')}）`}` +
      '（7 台 × 7 个角度：件名 / 中心 / 形状 / 自身 rotationZ 逐字一致）'
  );
  console.log(
    `确定性核对（同一输入两次运行一致）：${report.determinism ? '通过' : '失败'} ｜ 规模：${report.variants} 个角度变体 × ` +
      `${report.regimes.length} 种命名约定 × 7 台 = ${report.assemblies} 套装配 · 每个命名约定 rotary 真值 ${report.rotaryTruthPerConvention} 条`
  );
  console.log(
    `核心 4 组（${report.coreVariants.join(' / ')}）各 ${report.rotaryTruthPerConvention} 条 rotary 真值 = ` +
      `${report.rotaryTruthPerConvention * report.coreVariants.length} 条/命名约定；4 个角度等量，角度方差不再为 0。`
  );

  console.log('\nA. rotary 逐角度表现（严格 = 类别 + 方向 + 角度；角度容差 ±max(1°, 5%)）');
  console.log(
    `  ${padEndW('变体', 26)}${padEndW('约定', 6)}${padStartW('真值', 6)}${padStartW('命中', 6)}` +
      `${padStartW('严格≥0.6', 10)}${padStartW('角度对', 8)}${padStartW('高置信错填', 12)}  ${padEndW('预测角度', 24)}来源`
  );
  for (const variant of report.byVariant) {
    for (const row of variant.byRegime) {
      const angles = Object.entries(row.predictedAngles)
        .map(([key, value]) => `${key}×${value}`)
        .join(' ');
      const sources = Object.entries(row.sources)
        .map(([key, value]) => `${key} ${value}`)
        .join(' ');
      console.log(
        `  ${padEndW(variant.label, 26)}${padEndW(row.regime, 6)}${padStartW(String(row.truth), 6)}` +
          `${padStartW(String(row.matched), 6)}${padStartW(`${row.strictAt06}`, 10)}${padStartW(`${row.angleOk}`, 8)}` +
          `${padStartW(`${row.highConfidenceWrongAngle}`, 12)}  ${padEndW(angles, 24)}${sources}`
      );
    }
  }

  console.log(
    `\nB. 核心对比：若「只允许一个先验值」，各常数在角度有方差的数据上能对几条（R1 口径；每列 = 该角度变体的 ${report.rotaryTruthPerConvention} 条 rotary 真值）`
  );
  const columns = ['90', '120', '180', '270', '45', '360', '360N'];
  const columnHead = (id) => (id === '360N' ? '360/N' : `${id}°`);
  console.log(
    `  ${padEndW('先验值', 14)}${columns.map((id) => padStartW(columnHead(id), 10)).join('')}${padStartW('核心4组平均', 14)}`
  );
  for (const row of report.priorRows) {
    const cells = columns.map((id) => `${row.hits[id]}/${report.rotaryTruthPerConvention}`);
    const coreAverage =
      report.coreVariants.reduce((total, id) => total + row.hits[id], 0) /
      (report.coreVariants.length * report.rotaryTruthPerConvention);
    console.log(
      `  ${padEndW(row.prior, 14)}${cells.map((cell) => padStartW(cell, 10)).join('')}` +
        `${padStartW(`${(coreAverage * 100).toFixed(1)}%`, 14)}`
    );
  }

  console.log(
    `\nC. 按命名约定汇总（核心 4 组合计，每约定 ${report.rotaryTruthPerConvention * report.coreVariants.length} 条 rotary 真值）`
  );
  console.log(
    `  ${padEndW('约定', 6)}${padStartW('真值', 6)}${padStartW('命中', 6)}${padStartW('严格≥0.6', 10)}` +
      `${padStartW('P≥0.6', 8)}${padStartW('高置信错填', 12)}${padStartW('可批量且角度错', 16)}` +
      `${padStartW('角度对且通过', 14)}  预测角度`
  );
  for (const row of report.perRegime) {
    const angles = Object.entries(row.predictedAngles)
      .map(([key, value]) => `${key}×${value}`)
      .join(' ');
    console.log(
      `  ${padEndW(row.regime, 6)}${padStartW(String(row.truth), 6)}${padStartW(String(row.matched), 6)}` +
        `${padStartW(`${row.strictAt06}`, 10)}` +
        `${padStartW(row.predictedAt06 ? `${((row.strictAt06 / row.predictedAt06) * 100).toFixed(1)}%` : '—', 8)}` +
        `${padStartW(`${row.highConfidenceWrongAngle}`, 12)}${padStartW(`${row.batchOkWrongAngle}/${row.batchOk}`, 16)}` +
        `${padStartW(`${row.batchOkAngleOk}`, 14)}  ${angles}`
    );
  }
  console.log(
    `  （「高置信错填」= 置信度 ≥0.6 且角度错；「可批量且角度错」= 直接调用产品 batchGate() 判过、同时角度错的条数 /` +
      ` 通过 batchGate 的总条数 —— 这批会无提示批量写进标注；「角度对且通过」= 通过 batchGate 且角度正确的条数，` +
      ` 用来看「挡的是错角度，不是整个旋转台」）`
  );
}

const main = async () => {
  const records = [];
  for (const regime of REGIMES) {
    for (const brief of BRIEFS) records.push(evaluateCase(machineCase(brief, regime)));
  }
  const fixtureRecord = evaluateCase(await fixtureCase());

  // 确定性核对：同一输入跑两遍，预测与匹配必须完全一致（识别器声明纯函数）。
  const probeA = evaluateCase(machineCase(BRIEFS[0], REGIMES[0]));
  const probeB = evaluateCase(machineCase(BRIEFS[0], REGIMES[0]));
  const determinism = JSON.stringify(probeA.predictions) === JSON.stringify(probeB.predictions) && JSON.stringify(probeA.matched) === JSON.stringify(probeB.matched);

  const overall = aggregate(records, '生成器整机 × 三种命名约定');
  const overallStored = aggregate(records, '生成器整机 × 三种命名约定', 'stored');
  const byRegime = REGIMES.map((regime) => {
    const subset = records.filter((record) => record.testCase.regime === regime.id);
    return aggregate(subset, regime.label);
  });
  const byRegimeStored = REGIMES.map((regime) => {
    const subset = records.filter((record) => record.testCase.regime === regime.id);
    return aggregate(subset, regime.label, 'stored');
  });
  const fixture = aggregate([fixtureRecord], '仓库 STEP 夹具（in-sample）');
  const angleVariance = angleVarianceMode ? buildAngleVariance() : null;

  const headCommit = (() => {
    try {
      return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    } catch {
      return 'unknown';
    }
  })();
  const codeHash = createHash('sha256').update(readFileSync(resolve(srcRoot, 'cad/kinematics-auto.ts'))).digest('hex').slice(0, 16);
  const worktreeDirty = (() => {
    try {
      return execFileSync('git', ['status', '--porcelain', '--', 'desktop/src/cad/kinematics-auto.ts'], { cwd: repoRoot, encoding: 'utf8' }).trim() !== '';
    } catch {
      return false;
    }
  })();

  const payload = {
    schemaVersion: 1,
    kind: 'kinematics-baseline',
    generatedBy: 'desktop/scripts/kinematics-baseline.mjs',
    code: { commit: headCommit, srcRoot, kinematicsAutoSha256: codeHash, worktreeDirty, determinism },
    definition: {
      unit: '机构（一条可动轴）',
      matchRule: '预测建议与真值轴按重叠网格 1:1 贪心匹配（至少 1 个网格重叠）',
      strictRule: '类别一致 + 方向一致（±20°；直线还要求正负号一致）+ 行程一致（±max(1mm, 5%)；夹爪按单指行程、旋转按角度）',
      scoreBases: {
        vector: '方向按 suggestion.directionVector（吸附前的真实方向）判定 —— 识别器看得准不准',
        stored: '方向按「实际写进标注的 axis + yawDeg + 正负号」还原出的向量判定 —— 标注存得对不对；两份数字都可能出现差异，必须都报'
      },
      bands: [0, 0.6, 0.8, 0.9]
    },
    dataset: {
      briefs: BRIEFS.length,
      regimes: REGIMES.map((regime) => ({ id: regime.id, label: regime.label })),
      generatedAssemblies: records.length,
      fixtureAssemblies: 1,
      truthMechanisms: overall.truthMechanisms,
      meshes: overall.meshes,
      groundTruthSource: [
        'machine/geometry.ts 的 movingAxes（生成器自己声明的可动件 / 轴向 / 行程）',
        '配置由 parseMachineBrief + synthMachine 从中文需求确定性合成',
        'STEP 夹具真值取自 gen-kinematics-fixture.mjs 与 kinematics-auto.test.mjs 断言（in-sample，单独列出）'
      ]
    },
    overall,
    overallStored,
    byRegime,
    byRegimeStored,
    byMachine: records
      .concat([fixtureRecord])
      .map((record) => {
        const bands = [0, 0.6, 0.8, 0.9].map((minConfidence) => band([record], record.testCase.truth.length, minConfidence, 'vector'));
        const bandsStored = [0, 0.6, 0.8, 0.9].map((minConfidence) => band([record], record.testCase.truth.length, minConfidence, 'stored'));
        return {
          id: record.testCase.id,
          dataset: record.testCase.dataset,
          layout: record.testCase.layout,
          parts: record.testCase.parts,
          truth: record.testCase.truth.length,
          predicted: record.predictions.length,
          strictAt06: bands[1].truePositives,
          precisionAt06: bands[1].precision,
          recallAt06: bands[1].recall,
          strictAt06Stored: bandsStored[1].truePositives,
          precisionAt06Stored: bandsStored[1].precision,
          recallAt06Stored: bandsStored[1].recall,
          errorCounts: {
            roleOrCategoryWrong: record.matched.filter((entry) => !entry.categoryOk).length,
            directionWrong: record.matched.filter((entry) => !entry.directionOk).length,
            directionWrongStored: record.matched.filter((entry) => !entry.directionOkStored).length,
            strokeWrong: record.matched.filter((entry) => !entry.strokeOk).length,
            extra: record.falsePositives.length,
            missing: record.falseNegatives.length
          }
        };
      }),
    details: {
      falsePositives: records.flatMap((record) => record.falsePositives),
      falseNegatives: records.flatMap((record) => record.falseNegatives),
      matched: records.flatMap((record) => record.matched)
    },
    fixture,
    ...(angleVariance ? { angleVariance } : {}),
    fixtureDetails: {
      predictions: fixtureRecord.predictions.map((entry) => ({
        category: entry.category,
        confidence: entry.confidence,
        level: entry.level,
        meshNames: entry.meshNames,
        axis: entry.axis,
        direction: entry.direction,
        travelMm: entry.travelMm,
        rangeDeg: entry.rangeDeg,
        point: entry.point
      })),
      mustNotBeHigh: fixtureRecord.mustNotBeHigh
    },
    caveats: [
      '真值只覆盖「整机生成器的概念占位体」这一类装配：box / cylinder 两种形状、标准件按规则摆放，不含真实 STEP 的曲面、B-Rep 拓扑与非单位阵装配变换。',
      '客户 STEP 的代表性有限：真实导出常带真实型号与子装配层级（对应 R2/R3），但也常带名称缺失、几何不完整、装配变换非单位阵，本基线未覆盖。',
      'STEP 夹具是 in-sample（同一夹具被单元测试断言），其结果偏乐观，不计入 overall。',
      '夹爪真值 = geometry.ts 的双指合计行程 / 2（每指行程），识别侧取型号样本表单指行程。',
      '行程判定容差 max(1mm, 5%)；旋转角度同为 5%。'
    ]
  };

  if (jsonPath) writeFileSync(resolve(process.cwd(), jsonPath), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  if (jsonOnly) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  console.log(`运动学自动识别基线 · commit ${headCommit} · src=${srcRoot} · kinematics-auto.ts ${codeHash}`);
  if (worktreeDirty) console.log('⚠ 工作树里的 src/cad/kinematics-auto.ts 有未提交改动；下面的数字对应 src 指向的那份代码，不代表工作树当前状态。');
  console.log(`确定性核对（同一输入两次运行一致）：${determinism ? '通过' : '失败'}`);
  console.log(
    `数据集：${records.length} 套整机（${BRIEFS.length} 种需求 × ${REGIMES.length} 种命名约定）+ 1 套 STEP 夹具 · 真值机构 ${overall.truthMechanisms} 条 · 网格 ${overall.meshes} 个`
  );
  const storedMode = scoreModes.includes('stored');

  if (storedMode) {
    console.log(
      '\n★ 打分口径：stored —— 方向用「实际写进标注的 axis + yawDeg + 正负号」还原，' +
        '"方向"列即存储轴一致率。\n'
    );
    printBandTable('总体（生成器整机，三种命名约定合计）', overallStored);
    printErrors(overallStored);
    for (const summary of byRegimeStored) {
      printBandTable(summary.label, summary);
      printErrors(summary);
    }
    printBandTable('仓库 STEP 夹具（in-sample，仅供参考）', fixture);
  }

  if (scoreModes.includes('vector')) {
    if (storedMode) console.log('\n──────────────── 对照：vector 口径（吸附前真实方向）────────────────\n');
    printBandTable('总体（生成器整机，三种命名约定合计）', overall);
    printErrors(overall);
    for (const summary of byRegime) {
      printBandTable(summary.label, summary);
      printErrors(summary);
    }
    if (!storedMode) printBandTable('仓库 STEP 夹具（in-sample，仅供参考）', fixture);
  }

  console.log(`  夹具预测：${fixtureRecord.predictions.map((entry) => `${entry.category}@${entry.confidence}(${entry.meshNames.join('+')})`).join(' · ')}`);
  console.log(`  夹具应保持低置信度的固定件：${fixtureRecord.mustNotBeHigh.map((entry) => `${entry.name}→${entry.level}(${entry.confidence})`).join(' · ')}`);

  const categoryTable = (title, summaries) => {
    console.log(`\n按机构类别（≥0.6 档严格正确 / 真值条数）· ${title}：`);
    for (const summary of summaries) {
      const strictAt06 = summary.bands.find((row) => row.minConfidence === 0.6);
      const row = Object.entries(summary.truthByCategory)
        .map(([key, total]) => `${key} ${summary.byCategoryAt06[key]?.strict ?? 0}/${total}`)
        .join(' · ');
      console.log(`  ${summary.label}：${row}（≥0.6 档严格正确合计 ${strictAt06.truePositives}）`);
    }
  };
  if (scoreModes.includes('stored')) categoryTable('stored 存储轴口径', byRegimeStored);
  if (scoreModes.includes('vector')) categoryTable('vector 真实方向口径', byRegime);

  // 两种口径并列的一张速查表：哪几条被存储轴口径判错，一眼可见
  const mismatched = records
    .flatMap((record) => record.matched)
    .filter((entry) => entry.directionOk !== entry.directionOkStored);
  console.log(
    `\n两种口径的分歧条目：${mismatched.length} 条` +
      (mismatched.length === 0
        ? '（存储轴与真实方向完全一致）'
        : `（这些条目"看得准"但"存错了"，vector 口径看不见）`)
  );
  for (const entry of mismatched.slice(0, 20)) {
    console.log(
      `  ${entry.machine} ${entry.kind} conf=${entry.confidence} 存成 ${entry.predictedSnappedAxis}${entry.predictedYawDeg ? `@${entry.predictedYawDeg}°` : ''}` +
        ` 向量(${entry.predictedStoredVector.map((value) => value.toFixed(2)).join(',')}) vs 真值(${entry.truthAxis.map((value) => value.toFixed(2)).join(',')})`
    );
  }
  if (angleVariance) {
    printAngleVariance(angleVariance);
    console.log('\n（以上角度方差样本不进历史 21 套口径：关掉 --angle-variance 时，上面所有数字与改动前逐字相同。）');
  }
  console.log(`\n（明细：--both 两种口径都打；--stored-axis 只看存储轴；默认 vector。JSON 里 overall / overallStored 同时给出。）`);
  if (jsonPath) console.log(`\nJSON 已写入 ${resolve(process.cwd(), jsonPath)}`);
};

await main();
