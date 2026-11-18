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
 *      丢了，该轴两端必然对不上；但内部件丢失、不动任何轴极值时，这一条看不见
 *      （要抓它得做逐实体 bbox/件族覆盖匹配，本脚本没有）。
 *   2) 件数：逐件 STL 文件数 == 零件表的件数，且每件 STL 非退化、与内核自报 bbox 一致。
 *   3) 实体数：`MANIFOLD_SOLID_BREP` 与件数挂钩（≥ 件数 × 0.6，且 ≤ 逐件实体合计 + 2）。
 *      布尔并会把**相邻件**合成一体（实测 16 层 146 件 → 104 实体、8 层 90 件 → 55），
 *      所以上限用"逐件实体合计"（150 / 94），下限用 0.6——旧累计 fuse 的 86/146 = 0.59
 *      就是在这一条上露头，同时被 (1) 以 204mm 的差距判死。
 *      这一条是**数量**证据，同样不是逐件身份：8 层 90 件 55 实体时余量只有 1 个实体。
 *
 * 另有第 4 类证据：**合并路径**必须是 `fuse`（一次性布尔并），回退 `compound` 即失败。
 * 这条**没有**元数据就判不了，所以：
 *   - build 模式：内核必须上报 `stats.merge`；缺失 → 判红（与逐件 solids 缺失同口径）；
 *   - --file 模式：裸 STEP 里 fuse 与 compound 回退都是 `MANIFOLD_SOLID_BREP`，无法判别，
 *     所以默认判红并明说「未验证」。要让它 PASS，必须显式给 `--merge-manifest <json>`
 *     （构建期 stats.merge 的独立证据：`{merge:{mode,fallback}}` 或 `{mode,fallback}`，
 *     `fallback` 必须是布尔值，不能省略）。**--file 默认不是验收门禁。**
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
 *   npm run verify:step-tower -- --json           # 末尾追加一行 JSON 摘要
 *   npm run verify:step-tower -- --keep           # 保留临时 STEP/STL（排查用）
 *   npm run verify:step-tower -- --file <x.step> --levels 16   # 只查已有文件（不启动内核）
 *   npm run verify:step-tower -- --file <x.step> --levels 16 --merge-manifest <stats.json>
 *                                                # 文件模式 + 构建期 stats.merge 证据才判合并路径
 *
 * 退出码：0 全过（或显式 SKIP）/ 1 任一断言失败或建模失败 / 2 文件模式读不到文件、
 * manifest 读不到或不合法。注意 `--file` 默认判红（合并路径未验证），它不是验收模式。
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ParametricManager, resolvePython } from '../electron/parametric.ts';
import { StepInspectError, describeInspection, inspectStep } from '../src/parametric/step-inspect.ts';
import { buildConveyorParts, conveyorAssembly, conveyorEnvelope } from '../src/machine/conveyor-assembly.ts';
import { buildBufferTowerParts, bufferTowerParamsFromConfig } from '../src/machine/buffer-tower-assembly.ts';

/** 8 层缓存基线：与 `scripts/pv-buffer-regenerate.mjs` 的 BASELINE 同一台机（90 件）。 */
const BASELINE_8 = { lengthMm: 2400, widthMm: 1200, beltHeightMm: 900, layers: 8, layerPitchMm: 180 };
const BASELINE_8_PARTS = 90;

/** 16 层缓存塔：与 `buffer-tower-assembly` 探针/`apply_machine_design` 同一份参数（146 件）。 */
const TOWER_16 = {
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
const fileArg = valueOf('--file');
const pythonArg = valueOf('--python');
const mergeManifestArg = valueOf('--merge-manifest');
const levels = Number(valueOf('--levels') ?? 16);
const toleranceArg = Number(valueOf('--tolerance'));

if (![8, 16].includes(levels)) {
  console.error(`STEP_TOWER 用法错误：--levels 只支持 8 或 16（收到 ${valueOf('--levels')}）`);
  process.exit(2);
}

if (mergeManifestArg !== undefined && !fileArg) {
  console.error('STEP_TOWER 用法错误：--merge-manifest 只在 --file 模式有意义（build 模式直接读内核 stats.merge）');
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
  const step = inspectStep(readFileSync(stepPath, 'utf8'), statSync(stepPath).size);
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
  printChecks(result.checks);
  log(`${result.ok ? 'PASS' : 'FAIL'} file-check ${result.checks.filter((check) => check.ok).length}/${result.checks.length}`);
  if (!result.ok) process.exitCode = 1;
  if (jsonOutput) {
    console.log(`STEP_TOWER_JSON ${JSON.stringify({
      mode: 'file',
      ok: result.ok,
      path: stepPath,
      merge,
      mergeVerified: Boolean(merge),
      checks: result.checks
    })}`);
  }
}

function printChecks(checks) {
  for (const check of checks) {
    log(`${check.ok ? 'PASS' : 'FAIL'} ${check.label} 期望=${check.expected} 实际=${check.actual}${check.note ? ` (${check.note})` : ''}`);
  }
}

async function writeSkip(reason) {
  log(`SKIP ${reason}`);
  log('SKIP 跳过原因：本机没有可 import build123d 的 Python，无法真实出 STEP；这是显式跳过，不代表通过');
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        ['### verify:step-tower', '', `**SKIPPED** — ${reason}`, '', '本 job 未验证缓存塔 STEP 完整性；任何结论都不可引用。', ''].join('\n')
      );
    } catch {
      /* 摘要写不进去不影响判定 */
    }
  }
  if (jsonOutput) console.log(`STEP_TOWER_JSON ${JSON.stringify({ mode: 'build', ok: false, skipped: true, reason })}`);
}

async function buildAndVerify() {
  const python = pythonArg ?? process.env.AUTOMATIONCAD_PYTHON ?? resolvePython(process.env);
  const table = tableOf();
  const doc = table.doc;
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
        await writeSkip(reason);
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
    const step = inspectStep(readFileSync(stepPath, 'utf8'), statSync(stepPath).size);
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
    printChecks(result.checks);
    log(
      `perpart files=${parts.length} stepSolids=${step.solids} partSolids=${built.stats?.partSolids ?? '?'} ` +
        `stlUnion=${result.stlUnion ? result.stlUnion.min.map((v, a) => `${v.toFixed(1)}..${result.stlUnion.max[a].toFixed(1)}`).join(' ') : '(无)'}`
    );
    log(`${result.ok ? 'PASS' : 'FAIL'} verify-step-tower ${result.checks.filter((check) => check.ok).length}/${result.checks.length}`);
    if (!result.ok) process.exitCode = 1;
    if (jsonOutput) {
      console.log(
        `STEP_TOWER_JSON ${JSON.stringify({
          mode: 'build',
          ok: result.ok,
          levels,
          parts: parts.length,
          stepPath,
          stepBytes,
          step,
          merge,
          allowances: result.allowances,
          minAllowance: result.minAllowance,
          maxAllowance: result.maxAllowance,
          checks: result.checks
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
