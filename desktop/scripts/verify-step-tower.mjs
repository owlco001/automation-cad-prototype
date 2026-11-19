#!/usr/bin/env node
/**
 * 缓存塔 / 多层缓存 STEP 完整性门禁：`npm run verify:step-tower`。
 *
 * 为什么要有它：`verify-step-export.mjs` 只覆盖 85 件输送线，而且它的实体断言用的是
 * **逐件 STEP 的合计**（85±5）——整机那份合并体里到底有没有丢件，它看不出来。缓存塔
 * 恰恰死在这一点上：16 层 146 件的"整机 STEP"实测只有 86 个 `MANIFOLD_SOLID_BREP`、
 * 顶点 z 只到 3636（立柱到 3840）、z 最小 770（底座在 0）；8 层 90 件那份 781,970 B 的
 * "已验收"STEP 只有 47 实体、z 只到 2196。字节数、面数、实体数下限全部照过。
 *
 * 所以这把尺子**不量字节/面数下界**（那些是副产品），它量的是三条相互独立的证据：
 *
 *   1) 顶点并集：整机 STEP 的 B-Rep 顶点包络 == 逐件 STL 顶点包络的并集（每轴 ±1mm；
 *      极值件是回转体时按「圆柱轴向 vs 被测轴」逐端显式外扩——垂直给半径、平行给 0，
 *      见 `cylinderAllowanceMm`。平面端永远是严格 ±1mm）。
 *      逐件 STL 是内核另外导出的、与整机 STEP 无关的一路产物：**撑起某轴极值的那件**
 *      丢了，该轴两端必然对不上。内部件丢失不动任何轴极值时这一条看不见 —— 那一条由
 *      第 6 类证据（逐件 B-Rep 占位覆盖）负责。
 *   2) 件数：逐件 STL 文件数 == 零件表的件数，且每件 STL 非退化、与内核自报 bbox 一致。
 *   3) 实体数：`MANIFOLD_SOLID_BREP` 与件数挂钩（≥ 件数 × 0.6，且 ≤ 逐件实体合计 + 2）。
 *      布尔并会把**相邻件**合成一体（实测 16 层 146 件 → 104 实体、8 层 90 件 → 55），
 *      所以上限用"逐件实体合计"（150 / 94），下限用 0.6——旧累计 fuse 的 86/146 = 0.59
 *      就是在这一条上露头，同时被 (1) 以 204mm 的差距判死。
 *      这一条是**数量**证据，同样不是逐件身份：8 层 90 件 55 实体时余量只有 1 个实体，
 *      「正常合并」与「少一个内部件」在数量上无法区分（这是本脚本最老的洞）。
 *
 * 另有第 4 类证据：**合并路径**必须是 `fuse`（一次性布尔并），回退 `compound` 即失败。
 * 这条**没有**元数据就判不了，所以：
 *   - build 模式：内核必须上报 `stats.merge`；缺失 → 判红（与逐件 solids 缺失同口径）；
 *   - --file 模式：裸 STEP 里 fuse 与 compound 回退都是 `MANIFOLD_SOLID_BREP`，无法判别，
 *     所以默认判红并明说「未验证」。要让它 PASS，必须显式给 `--merge-manifest <json>`
 *     （构建期 stats.merge 的独立证据：`{merge:{mode,fallback}}` 或 `{mode,fallback}`，
 *     `fallback` 必须是布尔值，不能省略）。**--file 默认不是验收门禁。**
 *
 * 第 5 类证据（review P2-5）：**制造导出边界**。原来的输入是 `buildBufferTowerParts()` 的 146 件
 * `ConveyorPart` 表 —— 它结构上**看不见**塔几何里那块工件板，件号/来源标签一漂移，App 的
 * STL/glTF/sidecar(→STEP) 会静默变成 147 件，而这里照样全绿。所以另加一段（不依赖内核，build 与
 * `--file` 都判、build 模式在起内核前先判）：
 *   `resolveMachineGeometry({ bufferTower: TOWER_16 })` 派生的塔几何（147 刚体）→
 *   `machineExportParts` / `geometryToSidecarAssemblies` 必须得 **146 实例**、
 *   件号与 STEP 件表逐件一致、不含工件板（件号/role/占位体位姿任一命中都算漏出），
 *   且**内核输入仍是 146 件**（导出过滤不许改制造件表）。8 层档是输送基线、没有塔板，
 *   该条显式记为「不适用」，不静默略过。
 *
 * 第 6 类证据（P1-1）：**逐件 B-Rep 占位覆盖**。上面 1~3 都只能证明「件齐 + 数量级对 +
 * 三轴极值对」：8 层实测 floor=54 / solids=55，丢 1 个内部实体照样绿。所以这里逐件判：
 * 件表里每一件，都必须在整机 STEP 的 B-Rep 顶点集里找到至少一个落在**自己包络**内的
 * 顶点（±tolerance；边界随件的边界存在/消失）。判据完全从件表派生，不写死 146/16。
 *
 * 结构上限（显式写清，不假装没有）：fuse 把 A 完全吞进 B 时，A 的边界不在结果里 ——
 * 任何顶点判据都不可能看见这类件。所以「A 的包络被另一件 B 的包络完全包含」这类**被包住件
 * 由件表自己算出来**（`deriveOccludedParts`），从"必须有证人"的集合里显式剔除，并在回执里
 * 逐件列出。实测：8 层 90 件、16 层 146 件各只有 2 件命中（`lift-chain-*` 在 `lift-post-*`
 * 里），其余 88/90、144/146 件的证人都落在 0.05mm 内（门禁给 ±1mm，余量 20 倍）。
 *
 * 豁免不能无上限（review P1-2）：豁免集是"必须有证人"的补集，如果它可以被数据放大，
 * 逐件身份门禁就整体失效 —— 实测（修复前）1 个大件 + 20 个小件可得 `required=1 / ok=true`。
 * 所以豁免口加四条硬约束（`evaluatePartIdentity` + `deriveOcclusionAudit`）：
 *   1) 件数上限：豁免件数 ≤ 件数 × 10%（向下取整），超一条即判红（21 件件表上限 = 2）。
 *      **按 entries（件）计数**，不是按件号 —— 重号件表曾经一票多免（146 件 / 145 条同号）；
 *   2) 宿主必须是**非豁免件**（宿主自己也要拿证人），不许链式豁免（A⊂B⊂C 时 B 也不算豁免源）；
 *   3) 严格包住：三轴包含（±tolerance）+ 每轴宿主尺寸 > 客体尺寸 ×1.05（同尺寸/近似同尺寸
 *      的两件不许互相"包住"）+ 三轴尺寸和差 > tolerance；
 *   4) 件号唯一：重号件表直接判红（Map 键身份不成立，"一条豁免掩盖多条"必须现形）。
 * 回执逐件列名并回显包住者件号与每轴尺寸比（`lift-chain-left∈lift-post-left(4.00/3.33/1.08)`）。
 * 1.05 这个阈值是实测定的：真机两处命中最小轴比是 8 层 z 轴 1.082、16 层 z 轴 1.324；
 * review 建议的"每轴 ≥1.5"会直接误杀 8 层（1.082）。
 * 缺顶点证据（没解析出 VERTEX_POINT）判红，不静默略过 —— 与 merge 元数据缺失同口径。
 *
 * 走的是**生产同一条路**（与 App 里同一个 `ParametricManager`）：
 *   buildBufferTowerParts(16 层) / buildConveyorParts(8 层基线)
 *     → conveyorAssembly(doc) → ParametricManager.build({perPart:true})
 *       → spike/build123d/app.py（真实 B-Rep，本机 /root/.venvs/b123d）
 *
 * 用法：
 *   npm run verify:step-tower                     # 默认 16 层塔（真实出 STEP 并断言）
 *   npm run verify:step-tower -- --levels 8       # 8 层缓存基线（90 件，回归用）
 *   npm run verify:step-tower -- --skip-if-no-kernel  # CI：内核不可用时显式 SKIP
 *   npm run verify:step-tower -- --skip-if-no-kernel --require-full
 *                                                # CI 严格档：内核不可用时 SKIP 仍然算失败（exit 1）
 *   npm run verify:step-tower -- --json           # 末尾追加一行 JSON 摘要
 *   npm run verify:step-tower -- --keep           # 保留临时 STEP/STL（排查用）
 *   npm run verify:step-tower -- --file <x.step> --levels 16   # 只查已有文件（不启动内核）
 *   npm run verify:step-tower -- --file <x.step> --levels 16 --merge-manifest <stats.json>
 *                                                # 文件模式 + 构建期 stats.merge 证据才判合并路径
 *   npm run verify:step-tower -- --help           # 用法（与本节同一张单子）
 *
 * 退出码：0 全过（或显式 SKIP，且没给 --require-full）/ 1 任一断言失败、建模失败，
 * 或给了 `--require-full` 时发生 SKIP / 2 文件模式读不到文件、manifest 读不到或不合法，
 * 以及 `--file` 与 `--require-full` 同时出现（严格档在文件模式不适用，直接报用法错误）。
 * 注意 `--file` 默认判红（合并路径未验证），它不是验收模式。
 *
 * `--require-full` 的语义（脚本内自洽，不依赖外部包装）：
 *   - 本次运行**必须**产出完整证据（整机 STEP + 逐件 STL + 逐件 B-Rep 占位覆盖）；
 *   - 因此 `--skip-if-no-kernel` 触发的 SKIP 在带该旗标时 **exit 1**：回执里 `ok:false` /
 *     `degraded:true` / `verdict:SKIPPED_NOT_VERIFIED` / `kernelRan:false` 一个字都不变
 *     （降级语义不变），只是退出码从 0 变 1，任何按退出码归集的 CI 都会把它读成失败；
 *   - 不给该旗标时沿用既有约定（显式跳过 = exit 0，靠回执 verdict 表达未验）；
 *   - 不带 `--skip-if-no-kernel` 时它没有额外作用：内核不可用本来就 exit 1。
 *   - **只适用于 build 模式**：`--file` 只查已有 STEP、不启动内核，"本次必须完整验证"
 *     在文件模式里是空转，所以 `--file` + `--require-full` 直接按用法错误 exit 2
 *     （不让旗标静默失效，也不在回执里留一个不成立的严格档）。
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ParametricManager, resolvePython } from '../electron/parametric.ts';
import { StepInspectError, describeInspection, inspectStep } from '../src/parametric/step-inspect.ts';
import { buildConveyorParts, conveyorAssembly, conveyorEnvelope } from '../src/machine/conveyor-assembly.ts';
import { buildBufferTowerParts, bufferTowerParamsFromConfig } from '../src/machine/buffer-tower-assembly.ts';
import { WORKPIECE_PART_ID, resolveMachineGeometry } from '../src/machine/machine-geometry.ts';
import { geometryToSidecarAssemblies, machineExportParts } from '../src/machine/geometry-export.ts';

/** 8 层缓存基线：与 `scripts/pv-buffer-regenerate.mjs` 的 BASELINE 同一台机（90 件）。 */
const BASELINE_8 = { lengthMm: 2400, widthMm: 1200, beltHeightMm: 900, layers: 8, layerPitchMm: 180 };
const BASELINE_8_PARTS = 90;

/** 16 层缓存塔：与 `buffer-tower-assembly` 探针/`apply_machine_design` 同一份参数（146 件）。 */
export const TOWER_16 = {
  kind: 'tower',
  towers: 1,
  slotsPerTower: 16,
  levels: 16,
  slotsPerLevel: 1,
  layerPitchMm: 180,
  panel: { lengthMm: 2278, widthMm: 1134, thicknessMm: 35, massKg: 32 },
  inbound: { lengthMm: 2400, widthMm: 1200, beltHeightMm: 900 },
  frame: { material: 'AL6063', sectionMm: 40 }
};
const TOWER_16_PARTS = 146;

/** STEP 至少这么大才算真几何（桩产物 3 KB 量级）。 */
const MIN_STEP_BYTES = 200_000;
/** 实体数下限系数：布尔并会合并相邻件（实测 16 层 104/146、8 层 55/90），留出余量。 */
const SOLID_FLOOR_RATIO = 0.6;
/** 顶点包络默认容差（mm）。 */
const DEFAULT_TOLERANCE_MM = 1;
/**
 * 「被包住件」豁免上限：≤ 件数 × 10%（向下取整）。豁免是逐件身份门禁的缺口，不许被数据放大。
 * 真机实测 90 件 2 件 / 146 件 2 件（1.1% / 1.4%），上限留了 4~7 倍余量。
 */
const OCCLUSION_MAX_EXEMPT_RATIO = 0.1;
/**
 * 「严格包住」：宿主每轴尺寸必须 > 客体同轴尺寸 × 1.05。
 * 实测下限来自真机 8 层 z 轴 1.082（lift-chain 1460mm 在 lift-post 1580mm 里），
 * 所以 review 建议的 1.5 会直接误杀；1.05 只挡「同尺寸/近似同尺寸互相包住」这一种伪造。
 */
const OCCLUSION_MIN_AXIS_RATIO = 1.05;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KERNEL_READY_TIMEOUT_MS = 120_000;

function log(line) {
  console.log(`STEP_TOWER ${line}`);
}

// ---------------------------------------------------------------------------
// 二进制 STL 顶点包络（不引第三方依赖；ASCII STL 直接报错，避免把文本当二进制读）
// ---------------------------------------------------------------------------

/**
 * 读二进制 STL 的顶点包络。
 *
 * 只支持二进制 STL：内核用 `bd.export_stl` 导的就是二进制。ASCII STL 走另一套解析，
 * 静默按二进制读会把三角形数读成天文数字并给出假包络——所以这里直接抛错。
 */
export function readBinaryStlBBox(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('STL 读取失败：需要 Buffer');
  if (buffer.length < 5) throw new Error(`STL 读取失败：长度 ${buffer.length} < 5（不是 STL）`);
  const head = buffer.subarray(0, 5).toString('latin1');
  if (head === 'solid') {
    throw new Error('STL 读取失败：文件以 "solid" 开头（ASCII STL），本门禁只认二进制 STL');
  }
  if (buffer.length < 84) throw new Error(`STL 读取失败：长度 ${buffer.length} < 84（不是二进制 STL）`);
  const triangles = buffer.readUInt32LE(80);
  const expect = 84 + triangles * 50;
  if (triangles === 0) throw new Error('STL 读取失败：三角形数为 0');
  if (buffer.length < expect) {
    throw new Error(`STL 读取失败：声明 ${triangles} 个三角形需要 ${expect} 字节，实际 ${buffer.length} 字节`);
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < triangles; index += 1) {
    // 每个三角形：法向(12B) + 3 顶点(36B) + 属性(2B)；顶点从 +12 起
    const base = 84 + index * 50 + 12;
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const offset = base + vertex * 12;
      for (let axis = 0; axis < 3; axis += 1) {
        const value = buffer.readFloatLE(offset + axis * 4);
        if (!Number.isFinite(value)) throw new Error(`STL 读取失败：第 ${index + 1} 个三角形含非有限坐标`);
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }
  }
  return { min, max, triangles };
}

/** 包络并集；空数组返回 null。 */
export function unionBoxes(boxes) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let used = 0;
  for (const box of boxes) {
    if (!box || !Array.isArray(box.min) || !Array.isArray(box.max)) continue;
    used += 1;
    for (let axis = 0; axis < 3; axis += 1) {
      const lo = Number(box.min[axis]);
      const hi = Number(box.max[axis]);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
      if (lo < min[axis]) min[axis] = lo;
      if (hi > max[axis]) max[axis] = hi;
    }
  }
  if (used === 0 || !Number.isFinite(min[0])) return null;
  return { min, max, used };
}

/**
 * 该轴极值件是回转体时，B-Rep 顶点**到不了母线**：OCCT 把圆柱写成一条 CIRCLE 边 +
 * 一个接缝顶点（角度 0），顶点只落在接缝上——于是 STEP 顶点包络在**垂直于圆柱轴**的
 * 方向上比真实外形小一个半径；**沿轴向**两个圆都在端面上，顶点是精确的。
 *
 * 所以外扩必须按「圆柱轴向 vs 被测轴」逐端决定：
 *   - 轴向 == 被测轴 → 0（端面圆顶点精确，不需要外扩，仍走 tolerance ±1mm）
 *   - 轴向 ⊥ 被测轴 → 半径 r（母线顶点缺失）
 *   - 不是纯同轴圆柱（含长方体特征）→ 0：那一端的极值是平面/棱边撑起来的，顶点精确。
 *     `lift-motor`（箱体 + Ø25 输出轴）就是这一类：旧实现不分轴按半径给它 12.5mm，
 *     把 x/y 两个平面端各放宽 12.5mm —— 等于门禁在这两个方向留了 12.5mm 的洞。
 *
 * 返回 0 时调用方用 tolerance（默认 ±1mm），即「平面端严格 ±1」。
 *
 * @param {any} part 零件表里的零件（features 带 type/params.axis/params.diameter）
 * @param {number|'x'|'y'|'z'} axis 被测轴（0/1/2 或 'x'/'y'/'z'）
 */
export function cylinderAllowanceMm(part, axis) {
  const measured = typeof axis === 'number' ? ['x', 'y', 'z'][axis] : axis;
  if (measured !== 'x' && measured !== 'y' && measured !== 'z') {
    throw new Error(`cylinderAllowanceMm：axis 必须是 0/1/2 或 'x'/'y'/'z'（收到 ${JSON.stringify(axis)}）`);
  }
  const features = Array.isArray(part?.features) ? part.features : [];
  const cylinders = [];
  for (const node of features) {
    if (!node || node.suppressed === true) continue;
    // 有长方体特征 → 极值可能是平面（棱边/端面）撑起来的，按 0 给：漏判丢件只会更早红。
    if (node.type === 'box') return 0;
    if (node.type !== 'cylinder') continue;
    const diameter = Number(node.params?.diameter);
    if (!Number.isFinite(diameter) || diameter <= 0) continue;
    const nodeAxis = node.params?.axis === 'x' || node.params?.axis === 'y' ? node.params.axis : 'z';
    cylinders.push({ axis: nodeAxis, radius: diameter / 2 });
  }
  if (cylinders.length === 0) return 0;
  const cylinderAxis = cylinders[0].axis;
  // 混轴（同一件上有多个方向的圆柱）也算「极值件形状不明」，按 0 处理。
  if (!cylinders.every((item) => item.axis === cylinderAxis)) return 0;
  if (cylinderAxis === measured) return 0;
  return Math.max(...cylinders.map((item) => item.radius));
}

function fmtBox(box) {
  if (!box) return '(无)';
  return box.min.map((value, axis) => `${value.toFixed(1)}..${box.max[axis].toFixed(1)}`).join(' ');
}

function fmtGap(step, stl) {
  if (!step || !stl) return '(无法比较)';
  const parts = [];
  for (let axis = 0; axis < 3; axis += 1) {
    parts.push(`${Math.abs(step.min[axis] - stl.min[axis]).toFixed(2)}/${Math.abs(step.max[axis] - stl.max[axis]).toFixed(2)}`);
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// 纯判定：不启动内核也能跑（专用测试直接喂合成 facts，含"丢件必须红"的反例）
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   levels: number,
 *   expectedParts: number,
 *   step: object,                       // inspectStep() 的结果
 *   parts: Array<{id:string, stlBBox:object, kernelBBox?:object, volumeMm3?:number, solids?:number}>,
 *   partById?: Map<string, any>,        // 零件表（取圆柱半径算显式外扩）
 *   toleranceMm?: number,
 *   minBytes?: number,
 *   merge?: {mode?: string, reason?: string, fallback?: boolean} | null,
 *   mode?: 'build' | 'file'   // file = 只有 STEP+STL，没有逐件实体数（实体上限不判）
 * }} facts
 */
export function evaluateStepTower(facts) {
  const checks = [];
  const tolerance = Number.isFinite(facts.toleranceMm) ? facts.toleranceMm : DEFAULT_TOLERANCE_MM;
  const minBytes = Number.isFinite(facts.minBytes) ? facts.minBytes : MIN_STEP_BYTES;
  const parts = Array.isArray(facts.parts) ? facts.parts : [];
  const step = facts.step ?? null;

  checks.push({
    label: 'STEP 头',
    ok: step?.header === 'ISO-10303-21',
    expected: 'ISO-10303-21',
    actual: step?.header ?? '(缺失)'
  });

  checks.push({
    label: '长度单位',
    ok: step?.units === null || step?.units === undefined ? true : step.units === 'MM',
    expected: 'MM',
    actual: step?.units ?? '(未声明)'
  });

  // ---- 1) 件数：逐件 STL 一个不少，且每件非退化 ----
  const expectedParts = Number(facts.expectedParts);
  const degenerate = parts.filter((item) => {
    const box = item?.stlBBox;
    if (!box) return true;
    for (let axis = 0; axis < 3; axis += 1) {
      if (!Number.isFinite(box.min[axis]) || !Number.isFinite(box.max[axis])) return true;
      if (box.max[axis] - box.min[axis] <= 0) return true;
    }
    return false;
  });
  checks.push({
    label: '逐件 STL 件数',
    ok: parts.length === expectedParts && degenerate.length === 0,
    expected: `${expectedParts} 件、每件包络非退化`,
    actual: `件数=${parts.length} 退化=${degenerate.length}${degenerate.length ? `（${degenerate.slice(0, 3).map((item) => item.id).join(',')}…）` : ''}`
  });

  // ---- 2) 顶点并集：整机 STEP vs 逐件 STL（每轴 ±1mm；回转体极值件按半径显式外扩）----
  const stlUnion = unionBoxes(parts.map((item) => item.stlBBox));
  // 容差按**端**分别取：min 端只看撑起 min 的那件、max 端只看撑起 max 的那件。
  // 以前两端共用 max(两件半径)：16 层 y 轴 min 端是箱体（不需要外扩）、max 端是 Ø40 导柱，
  // 共用之后 min 端也被放宽到 20mm —— 那一端丢一件 20mm 都能过，等于门禁留了个洞。
  const minAllowance = [0, 0, 0];
  const maxAllowance = [0, 0, 0];
  const extremeParts = { min: [null, null, null], max: [null, null, null] };
  if (stlUnion) {
    for (let axis = 0; axis < 3; axis += 1) {
      let lo = null;
      let hi = null;
      for (const item of parts) {
        const box = item?.stlBBox;
        if (!box) continue;
        if (lo === null || box.min[axis] < lo.stlBBox.min[axis]) lo = item;
        if (hi === null || box.max[axis] > hi.stlBBox.max[axis]) hi = item;
      }
      minAllowance[axis] = Math.max(tolerance, lo ? cylinderAllowanceMm(facts.partById?.get?.(lo.id), axis) : 0);
      maxAllowance[axis] = Math.max(tolerance, hi ? cylinderAllowanceMm(facts.partById?.get?.(hi.id), axis) : 0);
      extremeParts.min[axis] = lo?.id ?? null;
      extremeParts.max[axis] = hi?.id ?? null;
    }
  }
  const allowances = [0, 1, 2].map((axis) => Math.max(minAllowance[axis], maxAllowance[axis]));
  const stepBox = step?.bbox ?? null;
  const bboxOk = Boolean(stepBox && stlUnion) && [0, 1, 2].every((axis) => (
    Math.abs(stepBox.min[axis] - stlUnion.min[axis]) <= minAllowance[axis] + 1e-6 &&
    Math.abs(stepBox.max[axis] - stlUnion.max[axis]) <= maxAllowance[axis] + 1e-6
  ));
  const widened = allowances.some((value) => value > tolerance);
  checks.push({
    label: '顶点并集 == 逐件 STL 并集',
    ok: bboxOk,
    expected: `每轴 min ±${minAllowance.map((v) => v.toFixed(1)).join('/')} max ±${maxAllowance.map((v) => v.toFixed(1)).join('/')}mm`
      + `${widened ? `（含回转体外扩，按端点极值件取半径：min=${extremeParts.min.map((id) => id ?? '-').join('/')} max=${extremeParts.max.map((id) => id ?? '-').join('/')}）` : ''}`,
    actual: `STEP ${fmtBox(stepBox)} | STL ${fmtBox(stlUnion)} | Δ(min/max x,y,z)=${fmtGap(stepBox, stlUnion)}`
  });

  // ---- 3) 实体数：与件数挂钩（下限）且不超过逐件实体合计（上限）----
  // 逐件 `solids` 缺失**不能按 1 计**：那会把上限退化成「件数 + 2」，等于没有上限。
  const solidValues = parts.map((item) => Number(item?.solids));
  const solidsReported = parts.length > 0 && solidValues.every((value) => Number.isFinite(value) && value > 0);
  const partSolids = solidsReported ? solidValues.reduce((sum, value) => sum + value, 0) : null;
  const ceiling = partSolids === null ? null : partSolids + 2;
  // 文件模式（--file）只有 STL，没有逐件实体数，这是输入限制而不是缺陷：显式声明后只判下限。
  // build 模式没有这个豁免 —— 内核本该逐件上报，缺失就是链路坏了。
  const perPartSolidsEvidence = solidsReported || facts.mode === 'file';
  const solids = Number(step?.solids);
  const floor = Math.ceil(expectedParts * SOLID_FLOOR_RATIO);
  checks.push({
    label: '实体数（与件数关联）',
    ok: Number.isFinite(solids) && solids >= floor && (ceiling === null || solids <= ceiling) && perPartSolidsEvidence,
    expected: ceiling === null
      ? `≥ ${floor}（逐件实体数缺失，上限不判）`
      : `${floor}~${ceiling}（≥ 件数 ${expectedParts}×${SOLID_FLOOR_RATIO}，≤ 逐件实体合计 ${partSolids}+2）`,
    actual: perPartSolidsEvidence ? String(step?.solids ?? '(缺失)') : `逐件 solids 缺失 ${solidValues.filter((value) => !(value > 0)).length}/${parts.length} 件`,
    note: `实体/件数=${Number.isFinite(solids) ? (solids / expectedParts).toFixed(2) : '?'}；布尔并会合并相邻件，故不要求等于件数`
  });

  // ---- 4) 每件 STL 与内核自报 bbox 一致（防止 STL 与 transform 脱节）----
  const bboxMismatch = parts.filter((item) => {
    if (!item?.kernelBBox || !item?.stlBBox) return false;
    for (let axis = 0; axis < 3; axis += 1) {
      if (Math.abs(Number(item.kernelBBox.min[axis]) - item.stlBBox.min[axis]) > 0.05) return true;
      if (Math.abs(Number(item.kernelBBox.max[axis]) - item.stlBBox.max[axis]) > 0.05) return true;
    }
    return false;
  });
  checks.push({
    label: '逐件 STL 与内核 bbox 一致',
    ok: bboxMismatch.length === 0,
    expected: '逐件 STL 顶点包络 == 内核自报 bbox（±0.05mm）',
    actual: `不一致 ${bboxMismatch.length} 件${bboxMismatch.length ? `（${bboxMismatch.slice(0, 3).map((item) => item.id).join(',')}…）` : ''}`
  });

  // ---- 5) 兜底：字节数与面数（挡住桩产物/单块冒充；不是主证据）----
  checks.push({
    label: '字节数（兜底）',
    ok: Number(step?.bytes ?? 0) >= minBytes,
    expected: `≥ ${minBytes}`,
    actual: String(step?.bytes ?? 0)
  });
  checks.push({
    label: '面数 ≥ 件数（兜底）',
    ok: Number(step?.faces ?? 0) >= expectedParts,
    expected: `≥ ${expectedParts}`,
    actual: String(step?.faces ?? 0)
  });

  // ---- 6) 合并路径：必须是 fuse；回退复合体 = 失败；没元数据也不许当通过 ----
  // 自校验的唯一目的就是发现丢件；发现了却把 `reason` 塞进一条 `ok:true` 的检查，
  // 等于「检测器抓到了、门禁照样绿」。回退说明这一次的整机 STEP **不是**布尔并，
  // 而是上百个独立实体堆成的复合体 —— 对下游 CAD/制造是另一种不合格，必须人工判断。
  //
  // 元数据缺失同样判红：`partSolids` 缺失在 build 模式已经是「链路坏了」，`merge` 必须同口径。
  // 以前 `if (mergeMode)` 让 `merge=null` 整条检查消失（9 项变 8 项仍可全绿）。
  // `--file` 模式拿不到元数据（裸 STEP 区分不了 fuse 与 compound 回退），默认同样判红，
  // 只有显式 `--merge-manifest` 给出独立证据才进入判定 —— 不允许「默默略过」。
  const mergeMode = typeof facts.merge?.mode === 'string' && facts.merge.mode.length > 0
    ? facts.merge.mode
    : null;
  if (!mergeMode) {
    const fileMode = facts.mode === 'file';
    checks.push({
      label: '整机合并路径',
      ok: false,
      expected: 'fuse（一次性布尔并，且必须由内核/构建期元数据证明）',
      actual: fileMode
        ? '未验证：--file 只读 STEP，裸 STEP 里 fuse 与 compound 回退都是 MANIFOLD_SOLID_BREP'
        : 'merge 元数据缺失（build 模式内核必须上报 stats.merge.mode）',
      note: fileMode
        ? '文件模式默认不是验收门禁：要判合并路径请给 --merge-manifest <构建期 stats.merge JSON>，或改用 build 模式'
        : 'merge 缺失 = 合并链路没上报，与逐件 solids 缺失同口径判红（缺失不许当成通过）'
    });
  } else {
    const fallback = facts.merge?.fallback === true || mergeMode === 'compound';
    const reason = facts.merge?.reason ? String(facts.merge.reason) : '';
    checks.push({
      label: '整机合并路径',
      ok: !fallback,
      expected: 'fuse（一次性布尔并）',
      actual: fallback ? `${mergeMode}（回退，未做布尔并）` : mergeMode,
      note: [reason, fallback ? '回退即失败：需人工判断丢件原因（不得当作验收通过）' : ''].filter(Boolean).join('；') || undefined
    });
  }

  return { ok: checks.every((check) => check.ok), checks, stepBox, stlUnion, allowances, minAllowance, maxAllowance };
}

// ---------------------------------------------------------------------------
// 制造导出边界（review P2-5）：件数门禁，不把「板被静默导出」只押在单测上
// ---------------------------------------------------------------------------

/**
 * 塔几何 → 制造导出（STL / glTF / sidecar ⇒ STEP）的实测事实。
 *
 * **输入必须走生产入口**：`resolveMachineGeometry({ bufferTower })` 派生塔几何（147 刚体），
 * 再走 `machineExportParts` / `geometryToSidecarAssemblies`（App 里导出用的同一对函数）。
 * STEP 门禁自己的件表（`buildBufferTowerParts`，146 件）只用来对照件号 —— 它结构上**看不见**
 * 塔几何里那块板，所以不能拿它当导出边界的证据。
 */
export function buildTowerExportFacts(table) {
  const geometry = resolveMachineGeometry({
    id: 'verify-step-tower-16',
    name: '缓存塔 16 层（制造导出门禁）',
    stations: ['进出料'],
    actuators: [],
    sensors: [],
    bufferTower: TOWER_16
  }).geometry;
  return {
    geometry,
    exportParts: machineExportParts(geometry),
    sidecar: geometryToSidecarAssemblies(geometry, { updatedAt: 'verify-step-tower' }),
    kernelInstances: Array.isArray(table?.doc?.instances) ? table.doc.instances.length : null,
    expectedAssemblyParts: Number(table?.expectedParts),
    tablePartIds: Array.isArray(table?.parts) ? table.parts.map((part) => part.id) : []
  };
}

const PLATE_IDENTITY_EPS = 1e-6;
const PLATE_ANGLE_EPS_DEG = 1e-6;

function angleDiffDeg(a, b) {
  const raw = Math.abs((((a - b) % 360) + 360) % 360);
  return Math.min(raw, 360 - raw);
}

/**
 * 门禁**自己再判一次**工件身份（不调 `geometry-export` 里的私有判据）：共享件号、`role=workpiece`、
 * 或与 `workpiecePlaceholder` 位姿同一（box size/center ±EPS、朝向周期等价）。这样导出函数本身
 * 退化时这条门禁仍然会红 —— 与 `verify:channel` 不认手写 `inCollisionSet` 是同一条原则。
 */
function isWorkpieceIdentity(part, placeholder) {
  if (!part) return false;
  if (part.id === WORKPIECE_PART_ID || part.role === 'workpiece') return true;
  if (!placeholder || part.shape?.type !== 'box' || placeholder.shape?.type !== 'box') return false;
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(Number(part.shape.size[axis]) - Number(placeholder.shape.size[axis])) > PLATE_IDENTITY_EPS) return false;
    if (Math.abs(Number(part.center[axis]) - Number(placeholder.center[axis])) > PLATE_IDENTITY_EPS) return false;
  }
  if (!Number.isFinite(part.rotationZDeg) || !Number.isFinite(placeholder.rotationZDeg)) return false;
  return angleDiffDeg(part.rotationZDeg, placeholder.rotationZDeg) <= PLATE_ANGLE_EPS_DEG;
}

/** sidecar 实例没有 role/shape，只能用实例 transform 与占位体位姿对照（同一位姿就是同一件）。 */
function instanceMatchesPlaceholder(instance, placeholder) {
  const transform = instance?.transform;
  if (!placeholder || !transform) return false;
  const values = [transform.x, transform.y, transform.z];
  if (values.some((value) => !Number.isFinite(value))) return false;
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(values[axis] - Number(placeholder.center[axis])) > PLATE_IDENTITY_EPS) return false;
  }
  if (!Number.isFinite(transform.rz) || !Number.isFinite(placeholder.rotationZDeg)) return false;
  return angleDiffDeg(transform.rz, placeholder.rotationZDeg) <= PLATE_ANGLE_EPS_DEG;
}

/**
 * 导出边界判定（纯函数，可喂合成 facts）：
 *   导出实例数 == `geometry.assemblyPartCount`（16 层 = 146）、导出件集 == STEP 件表、
 *   碰撞几何仍是 147（板在、看得见）、且 STEP 内核输入仍是 146 件（导出过滤不许改它）。
 */
export function evaluateExportBoundary(facts) {
  const checks = [];
  const geometry = facts?.geometry ?? null;
  const expected = Number(facts?.expectedAssemblyParts);
  const expectedOk = Number.isFinite(expected) && expected > 0;
  const exportParts = Array.isArray(facts?.exportParts) ? facts.exportParts : [];
  const geometryParts = Array.isArray(geometry?.parts) ? geometry.parts : [];
  const placeholder = geometry?.workpiecePlaceholder;
  const assemblyCount = Number(geometry?.assemblyPartCount);
  const sidecar = facts?.sidecar ?? null;
  const sidecarInstances = Array.isArray(sidecar?.chunks)
    ? sidecar.chunks.flatMap((chunk) => (Array.isArray(chunk?.instances) ? chunk.instances : []))
    : [];

  checks.push({
    label: '导出边界：装配件数口径',
    ok: expectedOk && assemblyCount === expected,
    expected: `${expected}（BOM/STEP 口径）`,
    actual: String(geometry?.assemblyPartCount ?? '(缺失)')
  });

  const plateInGeometry = geometryParts.filter((part) => isWorkpieceIdentity(part, placeholder));
  checks.push({
    label: '导出边界：碰撞几何 = 装配件数 + 1（板确实在）',
    ok: expectedOk && geometryParts.length === expected + 1 && plateInGeometry.length === 1,
    expected: `${expected + 1}（${expected} 装配 + 1 块板）`,
    actual: `刚体 ${geometryParts.length} / 工件身份件 ${plateInGeometry.length}`
  });

  checks.push({
    label: '导出边界：制造导出件数 == assemblyPartCount',
    ok: expectedOk && exportParts.length === expected && exportParts.length === assemblyCount,
    expected: `${expected}`,
    actual: String(exportParts.length)
  });

  const leakedParts = exportParts.filter((part) => isWorkpieceIdentity(part, placeholder));
  checks.push({
    label: '导出边界：制造导出不含工件板',
    ok: leakedParts.length === 0,
    expected: '0 件（件号 / role / 占位体位姿任一命中都算漏出）',
    actual: `${leakedParts.length} 件${leakedParts.length ? `（${leakedParts.slice(0, 3).map((part) => part.id).join(',')}…）` : ''}`
  });

  checks.push({
    label: '导出边界：sidecar 实例 == assemblyPartCount',
    ok: expectedOk && sidecar?.instances === expected && sidecarInstances.length === expected,
    expected: `${expected}（分块合计同数）`,
    actual: `instances=${sidecar?.instances ?? '(缺失)'} 分块合计=${sidecarInstances.length}`
  });

  const leakedInstances = sidecarInstances.filter((instance) => (
    instance?.id === WORKPIECE_PART_ID || instanceMatchesPlaceholder(instance, placeholder)
  ));
  checks.push({
    label: '导出边界：sidecar 不含工件板（⇒ STEP 不会 147 件）',
    ok: leakedInstances.length === 0,
    expected: '0 件（件号或占位体位姿命中都算漏出）',
    actual: `${leakedInstances.length} 件${leakedInstances.length ? `（${leakedInstances.slice(0, 3).map((instance) => instance.id).join(',')}…）` : ''}`
  });

  const tablePartIds = Array.isArray(facts?.tablePartIds) ? facts.tablePartIds : [];
  const exportIds = exportParts.map((part) => part.id);
  const exportIdSet = new Set(exportIds);
  const missing = tablePartIds.filter((id) => !exportIdSet.has(id));
  checks.push({
    label: '导出边界：导出件号 == STEP 件表',
    ok: tablePartIds.length === expected
      && exportIds.length === tablePartIds.length
      && exportIdSet.size === exportIds.length
      && missing.length === 0,
    expected: `${tablePartIds.length} 个件号（与 buildBufferTowerParts 逐件一致，不许重号/缺号）`,
    actual: `导出 ${exportIds.length} 件 / 唯一 ${exportIdSet.size} / 缺 ${missing.length}`
  });

  checks.push({
    label: '导出边界：STEP 内核输入仍是 146 件',
    ok: expectedOk && facts?.kernelInstances === expected,
    expected: `${expected}（buildBufferTowerParts → conveyorAssembly，制造导出不许改它）`,
    actual: String(facts?.kernelInstances ?? '(缺失)')
  });

  return { ok: checks.every((check) => check.ok), checks };
}

// ---------------------------------------------------------------------------
// 逐件 B-Rep 占位覆盖（P1-1）：把「STEP 里到底还有没有这件」变成逐件证据
// ---------------------------------------------------------------------------
//
// 为什么数量证据不够（实测，不是推测）：
//   - 8 层 90 件：实体下限 floor = ceil(90×0.6) = 54，实际 solids = 55 —— 余量 1 个实体；
//     布尔并本来就合并相邻件（90→55、146→104），所以"少一个内部件"与"正常合并"
//     在数量上无从区分。
//   - 顶点并集只量三轴极值：内部件丢了，极值一件不动，那一条照样绿。
//   - 「逐件 STL 与内核 bbox 一致」比的是**输入侧**（transform 有没有生效），
//     与"整机 STEP 里还有没有这件实体"无关。
//
// 判据：件表里每一件，都要在整机 STEP 的 B-Rep 顶点集里找到至少一个落在它**自己包络**
// 内的顶点。件的边界没了，它的顶点就没了 —— 这是"有没有这件"的直接证据。
// 全部从件表派生：件数、包络、被包住件都算出来的，不写死 146/16 层。
//
// 结构上限：fuse 把 A 完全吞进 B 时，A 的边界不在结果里，顶点判据看不见它。这类件
// （A 的包络被另一件 B 的包络完全包含）由件表自己派生后**显式剔除并逐件列出**，
// 不做白名单、不静默放过。

const STEP_POINT_RE = /#(\d+)\s*=\s*CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(([^()]*)\)\s*\)/g;
const STEP_VERTEX_RE = /#(\d+)\s*=\s*VERTEX_POINT\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*\)/g;

/**
 * 从 STEP 文本里取 B-Rep 顶点坐标（VERTEX_POINT → CARTESIAN_POINT）。
 *
 * 与 `step-inspect.ts` 同一套口径（只认被 VERTEX_POINT 引用到的点，参考几何的
 * CARTESIAN_POINT 不算），但那个函数只回包络，这里要**坐标本身**做逐件占位判定。
 * 空文本/无顶点返回空数组（调用方据此判红，不当成"没有要求"）。
 */
export function readStepVertexPoints(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  if (!text.includes('VERTEX_POINT')) return [];
  const points = new Map();
  for (const match of text.matchAll(STEP_POINT_RE)) {
    const id = match[1];
    const raw = match[2];
    if (!id || raw === undefined) continue;
    const values = raw.split(',').map((item) => Number(item.trim()));
    if (values.length !== 3) continue;
    if (!values.every((value) => Number.isFinite(value))) continue;
    points.set(id, [values[0], values[1], values[2]]);
  }
  const vertices = [];
  for (const match of text.matchAll(STEP_VERTEX_RE)) {
    const coords = points.get(match[2]);
    if (coords) vertices.push(coords);
  }
  return vertices;
}

/** 件包络：优先用逐件 STL（与整机 STEP 无关的另一路产物），退化到内核自报 bbox。 */
function partBox(part) {
  const box = part?.stlBBox ?? part?.kernelBBox ?? null;
  if (!box || !Array.isArray(box.min) || !Array.isArray(box.max)) return null;
  const min = [0, 1, 2].map((axis) => Number(box.min[axis]));
  const max = [0, 1, 2].map((axis) => Number(box.max[axis]));
  if (![...min, ...max].every((value) => Number.isFinite(value))) return null;
  return { min, max };
}

function boxExtentSum(box) {
  return [0, 1, 2].reduce((sum, axis) => sum + (box.max[axis] - box.min[axis]), 0);
}

function boxExtentOf(box, axis) {
  return box.max[axis] - box.min[axis];
}

function countVerticesInBox(vertices, box, tolerance) {
  let count = 0;
  for (const vertex of vertices) {
    let inside = true;
    for (let axis = 0; axis < 3; axis += 1) {
      const value = vertex[axis];
      if (!Number.isFinite(value) || value < box.min[axis] - tolerance || value > box.max[axis] + tolerance) {
        inside = false;
        break;
      }
    }
    if (inside) count += 1;
  }
  return count;
}

/**
 * 由件表派生「结构上被包住的件」并带回逐件证据（review P1-2）：A 的包络被另一件 B 的包络
 * 完全包含（±tolerance），B 明显更大（三个方向尺寸之和更大），且**严格包住**——
 * 每轴 B 的尺寸 > A 的同轴尺寸 × 1.05。同尺寸/近似同尺寸的两件不许互相"包住"。
 *
 * 宿主必须是**非豁免件**（按尺寸降序处理，宿主只能取已经判过、自己没被豁免的件）：
 * 否则 A⊂B⊂C 时 B 既被豁免又给别人当豁免源，等于一条链把整组件全免掉。
 *
 * 这类件在 fuse 后边界被吞掉，任何顶点/边界判据都看不见它们；剔除名单是算出来的，
 * 不是写死的。**豁免多少条由调用方（`evaluatePartIdentity`）按件数比例判红**，
 * 这里只负责「逐件是谁、被谁包住、每轴多大比例」，不做上限判定。
 *
 * @param {Array<{id: string, box: {min:number[], max:number[]}|null}>} entries
 * @returns {{occluded: Map<string, string>, details: Array<{id:string, host:string, ratios:number[], minRatio:number}>}}
 */
export function deriveOcclusionAudit(entries, toleranceMm = DEFAULT_TOLERANCE_MM) {
  const tolerance = Number.isFinite(toleranceMm) ? toleranceMm : DEFAULT_TOLERANCE_MM;
  // 豁免必须**按 entries（件）**判定与计数，不能按件号去重（review P2 反例：
  // 146 件里 145 条同号「ghost」→ Map 只有 1 个键，145 条从未被任何顶点验证却 ok:true）。
  // 所以这里保留原始下标：宿主/客体的「已豁免」判断、`details` 都逐 entry 一条。
  const indexed = (Array.isArray(entries) ? entries : [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item && item.box);
  // 降序：宿主只会是更大的、且自己没被豁免的件（链式豁免从这里被禁掉）。
  const desc = indexed.slice().sort((a, b) => boxExtentSum(b.item.box) - boxExtentSum(a.item.box));
  const occludedIndices = new Set();
  const occluded = new Map();
  const details = [];
  for (const { item, index } of desc) {
    const host = desc.find((other) => {
      if (other.index === index) return false;
      if (other.item.id === item.id) return false;
      if (occludedIndices.has(other.index)) return false;
      if (boxExtentSum(other.item.box) - boxExtentSum(item.box) <= tolerance) return false;
      const contained = [0, 1, 2].every((axis) => (
        other.item.box.min[axis] <= item.box.min[axis] + tolerance &&
        other.item.box.max[axis] >= item.box.max[axis] - tolerance
      ));
      if (!contained) return false;
      // 严格包住：每轴都要有明显余量（近似同尺寸的两件不许互相吃掉）
      return [0, 1, 2].every((axis) => {
        const guestExtent = boxExtentOf(item.box, axis);
        const hostExtent = boxExtentOf(other.item.box, axis);
        if (!(hostExtent > 0)) return false;
        return guestExtent <= 0 ? true : hostExtent >= guestExtent * OCCLUSION_MIN_AXIS_RATIO;
      });
    });
    if (!host) continue;
    const ratios = [0, 1, 2].map((axis) => {
      const guestExtent = boxExtentOf(item.box, axis);
      return guestExtent > 0 ? boxExtentOf(host.item.box, axis) / guestExtent : Number.POSITIVE_INFINITY;
    });
    occludedIndices.add(index);
    occluded.set(String(item.id), String(host.item.id));
    details.push({
      id: String(item.id),
      host: String(host.item.id),
      ratios,
      minRatio: Math.min(...ratios),
      index,
      hostIndex: host.index
    });
  }
  // `occluded`（Map）保持旧调用方语义（按件号去重，只给“谁被谁包住”）；门禁计数一律用
  // `occludedIndices.size` / `details.length`（按 entries），重号件表因此不可能一票多免。
  return { occluded, occludedIndices, details };
}

/**
 * `deriveOcclusionAudit` 的 Map 视图（兼容旧调用方）：被包住件 id → 宿主件 id。
 *
 * 注意：**只给 Map 就丢了「为什么被豁免」的证据**，门禁内部走 audit 版本；
 * 这个导出保留给「只要名单」的调用方/测试。
 *
 * @param {Array<{id: string, box: {min:number[], max:number[]}|null}>} entries
 * @returns {Map<string, string>} 被包住件 id → 宿主件 id
 */
export function deriveOccludedParts(entries, toleranceMm = DEFAULT_TOLERANCE_MM) {
  return deriveOcclusionAudit(entries, toleranceMm).occluded;
}

/**
 * 逐件 B-Rep 占位覆盖判定（纯函数，可喂合成 facts）：
 *   件表里每一件（被包住件除外）在整机 STEP 的顶点集里至少有一个落在自己包络内的顶点。
 *
 * 豁免（被包住件）**不是白名单**：三条硬约束同时成立才算数，任一不成立整条判红（review P1-2）：
 *   1) 件数上限 ≤ 件数 × 10%（向下取整）—— 豁免是"必须有证人"的补集，不许被数据放大；
 *   2) 宿主必须是非豁免件（不许链式豁免）；
 *   3) 严格包住（每轴尺寸比 ≥ 1.05，见 `deriveOcclusionAudit`）。
 * 回执逐件列名 + 回显包住者件号与每轴尺寸比，另有一条独立检查记录豁免上限。
 *
 * facts:
 *   expectedParts  件表件数（由 `buildBufferTowerParts` / `buildConveyorParts` 派生）
 *   parts          [{id, stlBBox, kernelBBox?}]  逐件包络
 *   stepVertices   [[x,y,z], ...]               整机 STEP 的 B-Rep 顶点（readStepVertexPoints）
 *   toleranceMm    默认 1（与顶点并集同一容差，不新增阈值）
 */
export function evaluatePartIdentity(facts) {
  const tolerance = Number.isFinite(facts?.toleranceMm) ? facts.toleranceMm : DEFAULT_TOLERANCE_MM;
  const parts = Array.isArray(facts?.parts) ? facts.parts : [];
  const expectedParts = Number(facts?.expectedParts);
  const vertices = Array.isArray(facts?.stepVertices) ? facts.stepVertices : null;
  // `index` 让「谁是第几件」独立于件号：重号件表里按件号去重 = 一票多免（review P2 反例）。
  const entries = parts.map((part, index) => ({ index, id: String(part?.id ?? '?'), box: partBox(part) }));
  const audit = deriveOcclusionAudit(entries, tolerance);
  const occluded = audit.occluded;
  const required = entries.filter((entry) => !audit.occludedIndices.has(entry.index));
  // 豁免件数按 **entries** 计（= details 条数），不是 Map 键数。
  const exemptCount = entries.length - required.length;
  const maxExempt = Math.max(0, Math.floor(parts.length * OCCLUSION_MAX_EXEMPT_RATIO));
  const overCap = exemptCount > maxExempt;
  // 件号唯一性断言：Map 视图按件号折叠；重号件表里「一条豁免」会掩盖多条从未验证的件。
  const idCounts = new Map();
  for (const entry of entries) idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1);
  const duplicateIds = [...idCounts].filter(([, count]) => count > 1).map(([id]) => id);
  // 防御性复验：即使 derive 将来被改坏，这两类"假豁免"也必须自己现形。
  const chainedHosts = audit.details.filter((detail) => audit.occludedIndices.has(detail.hostIndex));
  const weakHosts = audit.details.filter((detail) => !(detail.minRatio >= OCCLUSION_MIN_AXIS_RATIO));
  const ratioText = (ratios) => ratios.map((value) => (Number.isFinite(value) ? value.toFixed(2) : '∞')).join('/');
  const exemptionText = audit.details.map((detail) => `${detail.id}∈${detail.host}(${ratioText(detail.ratios)})`).join(' ');
  const witnessCount = new Map();
  for (const entry of required) {
    witnessCount.set(entry.id, entry.box ? countVerticesInBox(vertices ?? [], entry.box, tolerance) : 0);
  }
  const unwitnessed = required.filter((entry) => (witnessCount.get(entry.id) ?? 0) === 0);
  const hasVertexEvidence = vertices !== null && vertices.length > 0;
  const occludedIds = [...occluded.keys()];
  const shortList = (list, limit = 5) => `${list.slice(0, limit).join(',')}${list.length > limit ? '…' : ''}`;

  const check = {
    label: '逐件 B-Rep 占位覆盖（内部件缺失）',
    ok: hasVertexEvidence && parts.length === expectedParts && required.length > 0 && unwitnessed.length === 0,
    expected: `${expectedParts} 件里「没有被别的件包住」的 ${required.length} 件，每件 ≥1 个整机 STEP B-Rep 顶点落在自己的包络内（±${tolerance}mm）；`
      + `另有 ${exemptCount} 件由件表派生为「结构上被包住」（fuse 后边界不可见，逐件列名，且受 ${maxExempt} 件上限约束）`,
    actual: !hasVertexEvidence
      ? 'STEP B-Rep 顶点集未提供/为空：缺证据不等于通过（与 merge 元数据缺失同口径）'
      : `覆盖 ${required.length - unwitnessed.length}/${required.length}`
        + `${unwitnessed.length ? `；缺证 ${unwitnessed.length} 件（${shortList(unwitnessed.map((entry) => entry.id))}）` : ''}`
        + `；被包住 ${exemptCount} 件${exemptCount ? `（${shortList(occludedIds)}）` : ''}`
        + `${parts.length === expectedParts ? '' : `；件表 ${parts.length} ≠ 期望 ${expectedParts}`}`,
    note: `STEP 顶点 ${vertices?.length ?? 0} 个；被包住件 ${exemptCount} 件`
      + `${exemptCount ? `：${exemptionText}` : ''}`
      + '；判据按件表派生，不写死层数/件数'
  };

  // 豁免上限单列一条：超限即判红（review P1-2 的实测症状：1 大 + 20 小 时 required=1、全绿）。
  const exemptionCheck = {
    label: '被包住件豁免上限（结构上限不许被数据放大）',
    ok: !overCap && chainedHosts.length === 0 && weakHosts.length === 0,
    expected: `豁免 ≤ ${maxExempt} 件（件数 ${parts.length} × ${OCCLUSION_MAX_EXEMPT_RATIO} 向下取整）；`
      + `每件必须被「非豁免件」严格包住（三轴包含 ±${tolerance}mm，且每轴尺寸比 ≥ ${OCCLUSION_MIN_AXIS_RATIO}）`,
    actual: `${exemptCount} 件`
      + `${overCap ? `（超上限 ${exemptCount - maxExempt} 件：豁免集是「必须有证人」的补集，无上限 = 逐件身份门禁整体失效）` : ''}`
      + `${chainedHosts.length ? `；链式豁免 ${chainedHosts.length} 件（${shortList(chainedHosts.map((detail) => `${detail.id}∈${detail.host}`))}）` : ''}`
      + `${weakHosts.length ? `；非严格包住 ${weakHosts.length} 件（${shortList(weakHosts.map((detail) => `${detail.id}∈${detail.host}`))}）` : ''}`,
    note: occludedIds.length
      ? `逐件回显：${exemptionText}`
      : '无豁免件（所有件都必须自己拿证人）'
  };

  // 件号唯一性单列一条（review P2 反例）：重号件表里 cap/required 都按件号去重 ⇒
  // 「146 件 1 宿主 + 145 条同号」曾经 ok:true。这条与「按 entries 计数」互为防线：
  // 计数防『一票多免』，唯一性防『件号本身不可作为身份』。
  const uniquenessCheck = {
    label: '件表件号唯一性（重号不许一票多免）',
    ok: duplicateIds.length === 0,
    expected: '件号在件表里唯一（豁免/覆盖判据都以件号作 Map 键，重号会让一条豁免掩盖多条从未验证的件）',
    actual: duplicateIds.length === 0
      ? `${entries.length} 件件号唯一`
      : `${duplicateIds.length} 个件号重复（${shortList(duplicateIds.map((id) => `${id}×${idCounts.get(id)}`))}）：`
        + '同号件在回执里无法区分，豁免必须判红',
    note: `${entries.length} 件 / ${idCounts.size} 个不同件号`
  };

  return {
    ok: check.ok && exemptionCheck.ok && uniquenessCheck.ok,
    checks: [check, exemptionCheck, uniquenessCheck],
    required: required.length,
    requested: parts.length,
    unwitnessed: unwitnessed.map((entry) => entry.id),
    occluded: occludedIds,
    witnessCount,
    exemption: {
      count: exemptCount,
      uniqueCount: occluded.size,
      duplicateIds,
      maxExempt,
      overCap,
      details: audit.details.map((detail) => ({
        id: detail.id,
        host: detail.host,
        ratios: detail.ratios.map((value) => (Number.isFinite(value) ? Number(value.toFixed(3)) : null)),
        minRatio: Number.isFinite(detail.minRatio) ? Number(detail.minRatio.toFixed(3)) : null
      }))
    }
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const jsonOutput = flag('--json');
const keep = flag('--keep');
const skipIfNoKernel = flag('--skip-if-no-kernel');
/**
 * 严格档（review P2-1）：本次必须产出完整证据 —— SKIP 也算失败（exit 1）。
 * 回执的 `ok:false / degraded:true / verdict:SKIPPED_NOT_VERIFIED` 不变，只改退出码，
 * 这样「按退出码归集的 CI」与「读回执的自动化」看到的结论一致，不会一个绿一个红。
 */
const requireFull = flag('--require-full');
const fileArg = valueOf('--file');
const pythonArg = valueOf('--python');
const mergeManifestArg = valueOf('--merge-manifest');
const levels = Number(valueOf('--levels') ?? 16);
const toleranceArg = Number(valueOf('--tolerance'));

if (flag('--help') || flag('-h')) {
  console.log(`缓存塔 STEP 完整性门禁（verify:step-tower）

用法：node scripts/verify-step-tower.mjs [选项]

  （默认）                         16 层塔：真起内核出 STEP/STL 并逐条断言
  --levels 8|16                    8 = 90 件输送基线，16 = 146 件缓存塔（默认 16）
  --skip-if-no-kernel              内核不可用时显式 SKIP（回执 ok:false/degraded:true）
  --require-full                   本次必须完整验证：SKIP 即 exit 1（回执降级语义不变）；
                                   只适用于 build 模式，与 --file 同给 = 用法错误 exit 2
  --file <x.step>                  只查已有 STEP（不启动内核；默认不是验收门禁；不接受 --require-full）
  --parts-dir <dir>                --file 配套的逐件 STL 目录（NN-<件号>.stl）
  --merge-manifest <stats.json>    --file 模式下唯一的合并路径证据（需 mode + fallback 布尔）
  --tolerance <mm>                 顶点包络容差（默认 1）
  --json                           末尾追加一行 STEP_TOWER_JSON 摘要
  --keep                           保留临时 STEP/STL
  --help, -h                       本页

退出码：0 全过（或显式 SKIP 且未给 --require-full）/ 1 任一断言失败、建模失败，
或给了 --require-full 时发生 SKIP / 2 参数或证据文件不合法（含 --file 与 --require-full 同给）。

豁免硬约束（逐件身份门禁的缺口，不允许被数据放大）：
  「被包住件」豁免 ≤ 件数×10%（向下取整，按件数计不是按件号）；宿主必须是非豁免件；
  每轴尺寸比 ≥ 1.05；件号必须唯一（重号判红）；回执逐件列名并回显包住者件号与每轴尺寸比。`);
  process.exit(0);
}

if (![8, 16].includes(levels)) {
  console.error(`STEP_TOWER 用法错误：--levels 只支持 8 或 16（收到 ${valueOf('--levels')}）`);
  process.exit(2);
}

if (mergeManifestArg !== undefined && !fileArg) {
  console.error('STEP_TOWER 用法错误：--merge-manifest 只在 --file 模式有意义（build 模式直接读内核 stats.merge）');
  process.exit(2);
}

// 严格档只对 build 模式成立：--file 不启动内核，「本次必须完整验证」在文件模式里是空转
// （review P2：以前 --file + --require-full 仍 exit 0 / 12/12，回执里连 kernelRan 都没有）。
// 与其让旗标静默失效，不如当场报用法错误 —— 严格档绝不能被读成已验证。
if (fileArg && requireFull) {
  console.error(
    'STEP_TOWER 用法错误：--require-full 在 --file 模式下不适用 —— '
      + '--file 只查已有 STEP、不启动内核，本次不可能产出「完整验证」证据（整机 STEP / 逐件 STL / 逐件 B-Rep 占位覆盖）。'
      + ' 要么去掉 --file 用 build 模式跑严格档，要么去掉 --require-full 接受文件模式的「非验收」定位。'
  );
  process.exit(2);
}

/** 只有被直接执行（而不是被测试 import）时才跑 CLI，否则 import 会去起内核。 */
const invokedDirectly = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function buildPartTable() {
  if (levels === 8) {
    const parts = buildConveyorParts(BASELINE_8);
    return { parts, expectedParts: BASELINE_8_PARTS, label: '8 层缓存基线', envelope: conveyorEnvelope(parts) };
  }
  const parts = buildBufferTowerParts(bufferTowerParamsFromConfig({ bufferTower: TOWER_16 }));
  return { parts, expectedParts: TOWER_16_PARTS, label: '16 层缓存塔', envelope: conveyorEnvelope(parts) };
}

const tableCache = { value: null };
function tableOf() {
  if (!tableCache.value) {
    const parts = buildPartTable();
    tableCache.value = { ...parts, doc: conveyorAssembly(parts.parts), partById: new Map(parts.parts.map((part) => [part.id, part])) };
  }
  return tableCache.value;
}

const exportFactsCache = { value: null };
/**
 * 制造导出边界门禁（review P2-5）。
 *
 * 16 层塔的几何含 1 块工件板（147 刚体），制造导出必须是 146 实例；8 层档是**输送基线**
 * （`buildConveyorParts`，没有塔板），塔的导出边界不适用 —— 显式记一条「不适用」，不静默略过。
 */
function exportBoundaryOf(table) {
  if (levels !== 16) {
    return {
      ok: true,
      checks: [{
        label: '导出边界（16 层塔专用）',
        ok: true,
        expected: '16 层塔几何（含 1 块工件板）',
        actual: `levels=${levels} 是输送基线，几何里没有塔板；塔的制造导出边界由 16 层档判定`
      }]
    };
  }
  if (!exportFactsCache.value) exportFactsCache.value = buildTowerExportFacts(table);
  return evaluateExportBoundary(exportFactsCache.value);
}

/**
 * 读 `--merge-manifest`：构建期 `stats.merge` 的独立证据。
 *
 * 形状接受三种（都要求 `fallback` 是**显式布尔**）：
 *   `{ merge: { mode, fallback } }`（内核 stats 原样）
 *   `{ mode, fallback }`
 *   `{ stats: { merge: { mode, fallback } } }`（整份 stats 直接给，最自然的一种）
 * 顺序有讲究：`parsed` 自己是任何 JSON 对象都成立，必须排在两个「带 merge 块」的候选
 * 之后；否则 `{stats:{merge:{…}}}` 会被 `parsed` 抢先命中，报成「缺少 merge.mode」。
 * 缺 `fallback` 直接报错而不是默认 false：省略就等于没证明「没回退」，
 * 那与裸 STEP 一样无法判定，不能拿它换 PASS。
 */
function readMergeManifest(manifestPath) {
  if (!existsSync(manifestPath)) return { error: `--merge-manifest 文件不存在：${manifestPath}` };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { error: `--merge-manifest 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
  }
  // 顺序：两个「带 merge 块」的形状优先，`parsed` 自己放最后兜底 `{mode,fallback}`。
  const candidates = [parsed?.merge, parsed?.stats?.merge, parsed];
  const block = candidates.find((item) => item && typeof item === 'object' && !Array.isArray(item));
  if (!block) return { error: '--merge-manifest 必须是 {merge:{mode,fallback}}、{mode,fallback} 或 {stats:{merge:{mode,fallback}}} 形状的对象' };
  if (typeof block.mode !== 'string' || !block.mode) {
    return { error: `--merge-manifest 缺少 merge.mode（收到 ${JSON.stringify(block.mode)}）` };
  }
  if (typeof block.fallback !== 'boolean') {
    return {
      error: `--merge-manifest 的 fallback 必须是显式布尔值（收到 ${JSON.stringify(block.fallback)}）：`
        + '省略 fallback 等于没证明「没回退」，不能当合并路径证据'
    };
  }
  return {
    merge: {
      mode: block.mode,
      fallback: block.fallback,
      ...(block.reason !== undefined ? { reason: block.reason } : {})
    }
  };
}

/** 文件模式：只查已有整机 STEP + 逐件 STL 目录（`--parts-dir`）。 */
function inspectOnly(stepPath, partsDir) {
  if (!existsSync(stepPath)) {
    console.error(`STEP_TOWER FAIL 文件不存在：${stepPath}`);
    process.exitCode = 2;
    return;
  }
  const table = tableOf();
  const stepText = readFileSync(stepPath, 'utf8');
  const step = inspectStep(stepText, statSync(stepPath).size);
  log(`file ${stepPath} ${describeInspection(step)}`);
  // 文件模式的合并路径无法从裸 STEP 判别（fuse 与 compound 回退都出 MANIFOLD_SOLID_BREP）。
  // 默认判红并明说「未验证」；要 PASS 必须显式给构建期 stats.merge 作为独立证据。
  let merge = null;
  if (mergeManifestArg !== undefined) {
    const manifest = readMergeManifest(mergeManifestArg);
    if (manifest.error) {
      console.error(`STEP_TOWER FAIL ${manifest.error}`);
      process.exitCode = 2;
      return;
    }
    merge = manifest.merge;
    log(`merge-manifest ${mergeManifestArg} mode=${merge.mode} fallback=${merge.fallback}`);
  } else {
    log('NOTE file 模式不是验收门禁：裸 STEP 无法区分 fuse 与 compound 回退，合并路径默认判红');
    log('NOTE 要判合并路径，请给 --merge-manifest <构建期 stats.merge JSON>（需含 mode + fallback 布尔值）');
  }
  // sidecar 的逐件文件名是 `NN-<safe id>.stl`；按同一规则反查，查不到就记 null（判红）。
  const names = partsDir && existsSync(partsDir)
    ? readdirSync(partsDir).filter((name) => name.toLowerCase().endsWith('.stl'))
    : [];
  const partMetas = table.parts.map((part, index) => {
    const safe = part.id.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40);
    const wanted = `${String(index + 1).padStart(2, '0')}-${safe}.stl`;
    const hit = names.includes(wanted) ? wanted : names.find((name) => name.endsWith(`-${safe}.stl`));
    if (!hit) return { id: part.id, stlBBox: null };
    return { id: part.id, stlBBox: readBinaryStlBBox(readFileSync(resolve(partsDir, hit))) };
  });
  const result = evaluateStepTower({
    levels,
    expectedParts: table.expectedParts,
    step,
    parts: partMetas,
    partById: table.partById,
    // 文件模式没有逐件实体数（STL 里没有实体概念）：显式声明，只判实体数下限
    mode: 'file',
    // null = 没有合并路径证据 → 判红（不静默略过）；有 manifest 才进判定
    merge,
    toleranceMm: Number.isFinite(toleranceArg) ? toleranceArg : DEFAULT_TOLERANCE_MM
  });
  // 导出边界（P2-5）不依赖内核：文件模式同样判，别让它成为「只有 build 模式才看」的缺口。
  const boundary = exportBoundaryOf(table);
  // 逐件 B-Rep 占位覆盖（P1-1）：文件模式同样判 —— 件表 + STEP 顶点都在手上，没有理由不看。
  const identity = evaluatePartIdentity({
    expectedParts: table.expectedParts,
    parts: partMetas,
    stepVertices: readStepVertexPoints(stepText),
    toleranceMm: Number.isFinite(toleranceArg) ? toleranceArg : DEFAULT_TOLERANCE_MM
  });
  const checks = [...result.checks, ...identity.checks, ...boundary.checks];
  const ok = result.ok && identity.ok && boundary.ok;
  printChecks(checks);
  log(`${ok ? 'PASS' : 'FAIL'} file-check ${checks.filter((check) => check.ok).length}/${checks.length}`);
  if (!ok) process.exitCode = 1;
  if (jsonOutput) {
    console.log(`STEP_TOWER_JSON ${JSON.stringify({
      mode: 'file',
      ok,
      path: stepPath,
      merge,
      mergeVerified: Boolean(merge),
      // 文件模式也回显 exemption（cap/overCap/duplicateIds）：读回执的自动化不必再猜
      // 「豁免了几件、上限多少」（review P3 残留 6），与 build 模式同一份结构。
      partIdentity: {
        ok: identity.ok,
        requested: identity.requested,
        required: identity.required,
        unwitnessed: identity.unwitnessed,
        occluded: identity.occluded,
        exemption: identity.exemption,
        checks: identity.checks
      },
      exportBoundary: { ok: boundary.ok, checks: boundary.checks },
      checks
    })}`);
  }
}

function printChecks(checks) {
  for (const check of checks) {
    log(`${check.ok ? 'PASS' : 'FAIL'} ${check.label} 期望=${check.expected} 实际=${check.actual}${check.note ? ` (${check.note})` : ''}`);
  }
}

/**
 * 显式跳过（`--skip-if-no-kernel`）：**不许表现为纯绿**。
 *
 * 以前这里只打一行 `SKIP` + 一句「不代表通过」，JSON 里只有 `{ok:false,skipped:true}`，
 * CI 侧看到的仍然是一片绿（退出码 0、没有 FAIL 行）。现在把「哪些证据这次根本没跑」
 * 逐项写进回执与 JSON：
 *   - 内核未跑 ⇒ 整机 STEP / 逐件 STL / 逐件 B-Rep 占位覆盖 全部未验；
 *   - 导出边界（件表/几何派生，**内核无关**）在起内核之前就已经判过，结论随附回执，
 *     不再跟着一起被当成「未验」——附带一句它在本次是否真的判过。
 * 退出码：默认 0（沿用「显式跳过不是失败」的既有约定）；给了 `--require-full` 则 **1**
 * （严格档：本次必须完整验证，SKIP 即失败）。**回执语义两边完全一致**：`ok:false` /
 * `degraded:true` / `verdict:SKIPPED_NOT_VERIFIED` / `kernelRan:false` 不变，只是退出码
 * 随 `--require-full` 变 —— 读回执的自动化与按退出码归集的 CI 因此不会得出相反结论。
 */
async function writeSkip(reason, boundary) {
  const boundaryJudged = Boolean(boundary);
  const skipExitCode = requireFull ? 1 : 0;
  log(`SKIP ${reason}`);
  log(
    `SKIP 退出码 = ${skipExitCode}`
      + (requireFull
        ? '（--require-full：本次必须完整验证，SKIP 即失败）'
        : '（显式跳过沿用退出码 0；CI 要按退出码归集请加 --require-full）')
  );
  log('SKIP 内核未跑 = true：build123d 不可用 ⇒ 整机 STEP / 逐件 STL / 逐件 B-Rep 占位覆盖 全部未验');
  log(`SKIP 导出边界（内核无关的 8 条）= ${boundaryJudged ? `本次已判，${boundary.ok ? '通过' : '不通过'}` : '未判'}`);
  log('SKIP 判定 = SKIPPED_NOT_VERIFIED：这是显式跳过，不代表通过；任何 STEP 结论都不可引用');
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        [
          '### verify:step-tower',
          '',
          `**SKIPPED — NOT VERIFIED** — ${reason}`,
          '',
          '- 内核未跑：整机 STEP、逐件 STL、逐件 B-Rep 占位覆盖**全部未验**。',
          `- 导出边界（件表派生、内核无关）：${boundaryJudged ? (boundary.ok ? '本次已判通过' : '本次已判**不通过**') : '未判'}。`,
          `- 退出码：${skipExitCode}（${requireFull ? '`--require-full`：SKIP 即失败' : '显式跳过沿用「不是失败」的约定；要按退出码归集请加 `--require-full`'}）。`,
          '',
          '本 job 未验证缓存塔 STEP 完整性；任何结论都不可引用。',
          ''
        ].join('\n')
      );
    } catch {
      /* 摘要写不进去不影响判定 */
    }
  }
  if (jsonOutput) {
    console.log(`STEP_TOWER_JSON ${JSON.stringify({
      mode: 'build',
      ok: false,
      skipped: true,
      degraded: true,
      verdict: 'SKIPPED_NOT_VERIFIED',
      reason,
      kernelRan: false,
      // 退出码可配置（review P2-1）：回执语义不随旗标变，只有退出码变，并把它写进回执自证。
      requireFull,
      exitCode: skipExitCode,
      exportBoundaryVerified: boundaryJudged,
      exportBoundary: boundaryJudged ? { ok: boundary.ok, verified: true, checks: boundary.checks } : { ok: null, verified: false },
      unverified: ['kernel', 'step', 'perPartStl', 'partIdentity'],
      note: '显式跳过不等于通过：kernelRan=false ⇒ STEP/逐件 STL/逐件占位覆盖本次没有任何证据'
    })}`);
  }
  if (skipExitCode !== 0) process.exitCode = skipExitCode;
}

async function buildAndVerify() {
  const python = pythonArg ?? process.env.AUTOMATIONCAD_PYTHON ?? resolvePython(process.env);
  const table = tableOf();
  const doc = table.doc;
  // P2-5：导出边界与内核无关，先判（不合格就别花几分钟起内核），同时保证「STEP 输入件数不变」。
  const boundary = exportBoundaryOf(table);
  if (!boundary.ok) {
    printChecks(boundary.checks);
    console.error(
      'STEP_TOWER FAIL 制造导出边界不成立（P2-5）：塔几何 → 制造导出件数/件号不合格 —— '
        + 'STEP 会跟着变成 147 件，先修 `machineExportParts` 的工件板判据'
    );
    process.exitCode = 1;
    if (jsonOutput) {
      console.log(`STEP_TOWER_JSON ${JSON.stringify({
        mode: 'build',
        ok: false,
        levels,
        exportBoundary: { ok: false, checks: boundary.checks }
      })}`);
    }
    return;
  }
  log(`case=${table.label} levels=${levels} parts=${doc.instances.length} envelope(估算)=${table.envelope.join('×')}`);
  log(`python=${python ?? '(未找到)'}`);

  const manager = new ParametricManager({
    appRoot: repoRoot,
    env: python ? { ...process.env, AUTOMATIONCAD_PYTHON: python } : { ...process.env },
    buildTimeoutMs: 600_000,
    healthTimeoutMs: KERNEL_READY_TIMEOUT_MS,
    idleMs: 0
  });
  const created = [];

  try {
    let started;
    try {
      started = await manager.start();
    } catch (error) {
      started = { ok: false, status: 'unavailable', message: error instanceof Error ? error.message : String(error) };
    }
    if (!started.ok) {
      const reason = `内核不可用（status=${started.status}）：${started.message ?? '未知原因'}`;
      if (skipIfNoKernel) {
        await writeSkip(reason, boundary);
        return;
      }
      console.error(`STEP_TOWER FAIL ${reason}`);
      process.exitCode = 1;
      return;
    }

    log(`kernel port=${started.port ?? '?'}`);
    const buildStartedAt = Date.now();
    const built = await manager.build(doc, { perPart: true });
    if (!built.ok) {
      console.error(`STEP_TOWER FAIL 建模失败 code=${built.code ?? '?'}：${built.message ?? '(无消息)'}`);
      process.exitCode = 1;
      return;
    }
    const stepPath = built.files?.step?.path;
    if (typeof stepPath !== 'string' || !existsSync(stepPath)) {
      console.error('STEP_TOWER FAIL 内核没有返回 STEP 文件路径');
      process.exitCode = 1;
      return;
    }
    created.push(dirname(stepPath));
    const stepBytes = Number(built.files?.step?.bytes ?? 0);
    const stepText = readFileSync(stepPath, 'utf8');
    const step = inspectStep(stepText, statSync(stepPath).size);
    const merge = built.stats?.merge ?? null;
    log(
      `build parts=${doc.instances.length} ms=${Date.now() - buildStartedAt} kernelBuildMs=${built.buildMs ?? '?'} ` +
        `kernelBbox=${JSON.stringify(built.stats?.bbox ?? null)} kernelSolids=${built.stats?.solids ?? '?'} ` +
        `partSolids=${built.stats?.partSolids ?? '?'} merge=${merge?.mode ?? '?'} stepBytes=${stepBytes}`
    );
    log(`step ${describeInspection(step)}`);

    const partMetas = Array.isArray(built.files?.parts) ? built.files.parts : [];
    const parts = [];
    for (const meta of partMetas) {
      const stlPath = meta?.stl?.path;
      if (typeof stlPath !== 'string' || !existsSync(stlPath)) {
        parts.push({ id: String(meta?.id ?? '?'), stlBBox: null });
        continue;
      }
      parts.push({
        id: String(meta.id ?? '?'),
        stlBBox: readBinaryStlBBox(readFileSync(stlPath)),
        kernelBBox: Array.isArray(meta.bboxMin) && Array.isArray(meta.bboxMax)
          ? { min: meta.bboxMin.map(Number), max: meta.bboxMax.map(Number) }
          : null,
        volumeMm3: Number(meta.volumeMm3 ?? 0),
        solids: Number(meta.solids ?? 0)
      });
    }

    const result = evaluateStepTower({
      levels,
      expectedParts: table.expectedParts,
      step,
      parts,
      partById: table.partById,
      mode: 'build',
      toleranceMm: Number.isFinite(toleranceArg) ? toleranceArg : DEFAULT_TOLERANCE_MM,
      minBytes: MIN_STEP_BYTES,
      merge
    });
    // 导出边界已在起内核前判过；这里只把它并入同一张回执，避免「内核绿、导出红」被分开读。
    // 逐件 B-Rep 占位覆盖（P1-1）同理：它是「STEP 里到底还有没有这件」的直接证据。
    const identity = evaluatePartIdentity({
      expectedParts: table.expectedParts,
      parts,
      stepVertices: readStepVertexPoints(stepText),
      toleranceMm: Number.isFinite(toleranceArg) ? toleranceArg : DEFAULT_TOLERANCE_MM
    });
    const checks = [...result.checks, ...identity.checks, ...boundary.checks];
    const ok = result.ok && identity.ok && boundary.ok;
    printChecks(checks);
    log(
      `perpart files=${parts.length} stepSolids=${step.solids} partSolids=${built.stats?.partSolids ?? '?'} ` +
        `identity=${identity.ok ? 'PASS' : 'FAIL'}(${identity.required - identity.unwitnessed.length}/${identity.required}` +
        `${identity.occluded.length ? `，被包住 ${identity.occluded.length}/上限 ${identity.exemption.maxExempt}` : ''}) ` +
        `stlUnion=${result.stlUnion ? result.stlUnion.min.map((v, a) => `${v.toFixed(1)}..${result.stlUnion.max[a].toFixed(1)}`).join(' ') : '(无)'}`
    );
    log(`${ok ? 'PASS' : 'FAIL'} verify-step-tower ${checks.filter((check) => check.ok).length}/${checks.length}`);
    if (!ok) process.exitCode = 1;
    if (jsonOutput) {
      console.log(
        `STEP_TOWER_JSON ${JSON.stringify({
          mode: 'build',
          ok,
          levels,
          parts: parts.length,
          stepPath,
          stepBytes,
          step,
          merge,
          partIdentity: {
            ok: identity.ok,
            requested: identity.requested,
            required: identity.required,
            unwitnessed: identity.unwitnessed,
            occluded: identity.occluded,
            exemption: identity.exemption,
            checks: identity.checks
          },
          exportBoundary: { ok: boundary.ok, checks: boundary.checks },
          allowances: result.allowances,
          minAllowance: result.minAllowance,
          maxAllowance: result.maxAllowance,
          checks
        })}`
      );
    }
  } finally {
    try {
      await manager.stop();
    } catch {
      /* 停不掉不影响判定 */
    }
    if (!keep) {
      for (const dir of new Set(created)) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* 临时目录清不掉不影响判定 */
        }
      }
    }
  }
}

if (invokedDirectly) {
  if (fileArg) {
    inspectOnly(fileArg, valueOf('--parts-dir'));
  } else {
    await buildAndVerify();
  }
}
