#!/usr/bin/env node
/**
 * 真实性门禁：**真实参数化内核**出一条整机 STEP，然后打开文件逐项断言。`npm run verify:step`
 *
 * 为什么要有它：`machine-e2e` 的 STEP 是桩产物（`MACHINE_E2E_STUB_PLAN tool=export_files`
 * + 按特征尺寸生成的方块），3 KB 量级、实体数对不上、包络也是估的。它证明的是「链路通」，
 * 不能证明「真内核能出 STEP」。这个脚本走的是**生产同一条路**：
 *
 *   buildConveyorParts / conveyorAssembly   （src/machine/conveyor-assembly.ts，85 件）
 *     → ParametricManager                  （electron/parametric.ts，与 App 里同一个管理器）
 *       → spike/build123d/app.py + OCP     （真实 B-rep，本机 /root/.venvs/b123d）
 *         → OS 临时目录里的 part.step
 *
 * 断言（任一不过 exit 1）：
 *   1) 文件存在、字节数 ≥ 50 KB（桩产物 3 KB 必挂）；
 *   2) 头部 ISO-10303-21；
 *   3) 实体数对得上 85 装配件 ±5：合并体 STEP 只有 27 个 `MANIFOLD_SOLID_BREP`——85 件里相邻件
 *      被布尔并成了一体，这是真实几何的结果，不是缺件。所以「85 件」按**逐件导出的合计**判：
 *      85 个 STEP 文件的 MANIFOLD_SOLID_BREP 合计 89（4 件被拆成两体），Δ=+4 在容差内；
 *   4) 包络：从 B-rep 顶点（VERTEX_POINT 引用的 CARTESIAN_POINT）算 6000×1495×930，
 *      与同一份参数化零件表的包络一致（逐轴 ±40mm）；
 *   5) 长度单位 mm、面数 ≥ 件数（挡住「一个方块冒充整机」）；
 *   6) 内核自报的 85 件逐件 bbox 并集 == 整机 bbox（证明件数没少、位置没偏）。
 *
 * 用法：
 *   npm run verify:step                           # 真出 STEP 并断言（内核缺失 = 失败）
 *   npm run verify:step -- --skip-if-no-kernel    # CI 用：内核不可用时打印 SKIP + 原因
 *   npm run verify:step -- --file <path.step>     # 只检查已有文件（回归用，不启动内核）
 *   npm run verify:step -- --json                 # 末尾追加一行 JSON 摘要
 *
 * 退出码：0 = 全部断言通过（或显式 SKIP）；1 = 任一断言失败 / 建模失败；2 = 文件模式读不到文件。
 */
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ParametricManager, resolvePython } from '../electron/parametric.ts';
import {
  STEP_MIN_BYTES,
  StepInspectError,
  aggregateInspections,
  checkStepExport,
  describeInspection,
  inspectStep
} from '../src/parametric/step-inspect.ts';
import { buildConveyorParts, conveyorAssembly, conveyorEnvelope } from '../src/machine/conveyor-assembly.ts';

/** 与 machine-e2e / eval:tasks t01 同一台机器：光伏板输送机，6000 长、1200 宽、90° 转向。 */
const CONVEYOR_PARAMS = {
  lengthMm: 6000,
  widthMm: 1200,
  beltHeightMm: 850,
  turnerAngleDeg: 90,
  layers: 1
};

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const skipIfNoKernel = flag('--skip-if-no-kernel');
const jsonOutput = flag('--json');
const fileArg = valueOf('--file');
const pythonArg = valueOf('--python');
/** desktop/scripts → 仓库根（spike/build123d/app.py 在这里）。 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 内核 import 实测 6~7 秒（冷启动更久），健康检查给足 120 s。 */
const KERNEL_READY_TIMEOUT_MS = 120_000;

function log(line) {
  console.log(`STEP_VERIFY ${line}`);
}

function printChecks(checks) {
  for (const check of checks) {
    log(`${check.ok ? 'PASS' : 'FAIL'} ${check.label} 期望=${check.expected} 实际=${check.actual}${check.note ? ` (${check.note})` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// 期望值：同一份参数化零件表（纯函数，不启动内核也能算）
// ---------------------------------------------------------------------------
const parts = buildConveyorParts(CONVEYOR_PARAMS);
const assembly = conveyorAssembly(parts);
const envelope = conveyorEnvelope(parts);
const expectation = {
  parts: parts.length,
  envelopeMm: envelope,
  minBytes: STEP_MIN_BYTES,
  solidTolerance: 5,
  envelopeToleranceMm: 40
};

/** 显式跳过：日志里必须有 SKIP 行，GitHub job summary 里必须写明「未验证」。 */
async function writeSkip(reason) {
  log(`SKIP ${reason}`);
  log('SKIP 跳过原因：本机没有可 import build123d 的 Python，无法真实出 STEP；这是显式跳过，不代表通过');
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [
      '### verify:step',
      '',
      `**SKIPPED** — ${reason}`,
      '',
      '本 job 未验证「能真实出 STEP」；任何 STEP 结论都不可引用。',
      '需要真实内核：`pip install build123d`（或设置 `AUTOMATIONCAD_PYTHON`）后重跑。',
      ''
    ].join('\n');
    try {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    } catch {
      /* 摘要写不进去不影响判定 */
    }
  }
  if (jsonOutput) console.log(`STEP_VERIFY_JSON ${JSON.stringify({ mode: 'build', ok: false, skipped: true, reason })}`);
}

/** 读 sidecar 的 /health（内核加载状态与版本）。读不到返回 null。 */
async function readHealth(port) {
  if (!port) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/**
 * 等内核真正 ready：`/health` 的 kernelState 只有 `import build123d` 成功后才变成 ready。
 * 端口是先绑的（调用方健康检查只有 3 秒），所以启动后立刻查大概率还是 loading——必须轮询。
 */
async function waitKernelReady(port) {
  const deadline = Date.now() + KERNEL_READY_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    last = await readHealth(port);
    if (last?.kernelState === 'ready' || last?.kernelState === 'failed') return last;
    await new Promise((done) => setTimeout(done, 500));
  }
  return last;
}

/** 只检查已有文件（回归：故意给一份 3 KB 假 STEP，必须 FAIL）。 */
function inspectOnly(path) {
  if (!existsSync(path)) {
    console.error(`STEP_VERIFY FAIL 文件不存在：${path}`);
    process.exitCode = 2;
    return;
  }
  const bytes = statSync(path).size;
  let inspection;
  try {
    inspection = inspectStep(readFileSync(path, 'utf8'), bytes);
  } catch (error) {
    if (error instanceof StepInspectError) {
      console.error(`STEP_VERIFY FAIL 解析失败：${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  log(`file ${path} ${describeInspection(inspection)}`);
  // 文件模式仍按整机期望判（85 件）：拿一份桩产物/单件来冒充整机，实体数与面数都会挂。
  const result = checkStepExport(inspection, expectation);
  printChecks(result.checks);
  log(`${result.ok ? 'PASS' : 'FAIL'} file-check ${result.checks.filter((c) => c.ok).length}/${result.checks.length}`);
  if (!result.ok) process.exitCode = 1;
  if (jsonOutput) console.log(`STEP_VERIFY_JSON ${JSON.stringify({ mode: 'file', path, ok: result.ok, inspection })}`);
}

async function buildAndVerify() {
  const python = pythonArg ?? process.env.AUTOMATIONCAD_PYTHON ?? resolvePython(process.env);
  log(`expect parts=${expectation.parts} envelope=${envelope.map((v) => v.toFixed(1)).join('×')} minBytes=${expectation.minBytes}`);
  log(`python=${python ?? '(未找到)'}`);

  const manager = new ParametricManager({
    appRoot: repoRoot,
    env: python ? { ...process.env, AUTOMATIONCAD_PYTHON: python } : { ...process.env },
    buildTimeoutMs: 300_000,
    healthTimeoutMs: KERNEL_READY_TIMEOUT_MS,
    idleMs: 0
  });
  /** sidecar 每次 build 都 mkdtemp，跑完清理（不留垃圾，也不删别人的）。 */
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
      console.error(`STEP_VERIFY FAIL ${reason}`);
      process.exitCode = 1;
      return;
    }

    const health = await waitKernelReady(started.port);
    const kernelReady = health?.kernelState === 'ready';
    log(
      `kernel=${health?.kernel ?? '?'} version=${health?.version ?? '?'} state=${health?.kernelState ?? '?'} port=${started.port ?? '?'}` +
        (health?.error ? ` error=${health.error}` : '')
    );
    if (!kernelReady) {
      const reason = `build123d 未加载（kernelState=${health?.kernelState ?? 'health 不可读'}）：${health?.error ?? '未知'}`;
      if (skipIfNoKernel) {
        await writeSkip(reason);
        return;
      }
      console.error(`STEP_VERIFY FAIL ${reason}`);
      process.exitCode = 1;
      return;
    }

    // ---- 1) 合并体 STEP：用户真正拿到的那份模型（顺带逐件 bbox，用于核对 85 件都在） ----
    const buildStartedAt = Date.now();
    const merged = await manager.build(assembly, { perPart: true });
    if (!merged.ok) {
      console.error(`STEP_VERIFY FAIL 建模失败 code=${merged.code ?? '?'}：${merged.message ?? '(无消息)'}`);
      process.exitCode = 1;
      return;
    }
    const stepPath = merged.files?.step?.path;
    const stepBytes = Number(merged.files?.step?.bytes ?? 0);
    if (typeof stepPath !== 'string' || !existsSync(stepPath)) {
      console.error('STEP_VERIFY FAIL 内核没有返回 STEP 文件路径');
      process.exitCode = 1;
      return;
    }
    created.push(dirname(stepPath));
    const kernelBbox = Array.isArray(merged.stats?.bbox) ? merged.stats.bbox.map(Number) : null;
    log(
      `build parts=${assembly.instances.length} ms=${Date.now() - buildStartedAt} kernelBuildMs=${merged.buildMs ?? '?'} ` +
        `volume=${merged.stats?.volumeMm3 ?? '?'} kernelBbox=${JSON.stringify(kernelBbox)} kernelSolids=${merged.stats?.solids ?? '?'} stepBytes=${stepBytes}`
    );
    const mergedInspection = inspectStep(readFileSync(stepPath, 'utf8'), statSync(stepPath).size);
    log(`merged ${stepPath} ${describeInspection(mergedInspection)}`);

    const extraChecks = [];

    // ---- 1b) 内核自报的逐件 bbox 并集 == 整机 bbox（85 件一个不少、位置没偏） ----
    const partMetas = Array.isArray(merged.files?.parts) ? merged.files.parts : [];
    const broken = partMetas.filter(
      (item) => !(Number(item?.volumeMm3) > 0) || !Array.isArray(item?.bboxMin) || !Array.isArray(item?.bboxMax)
    );
    const unionMin = [Infinity, Infinity, Infinity];
    const unionMax = [-Infinity, -Infinity, -Infinity];
    let volumeSum = 0;
    for (const item of partMetas) {
      if (!Array.isArray(item?.bboxMin) || !Array.isArray(item?.bboxMax)) continue;
      volumeSum += Number(item.volumeMm3 ?? 0);
      for (let axis = 0; axis < 3; axis += 1) {
        unionMin[axis] = Math.min(unionMin[axis], Number(item.bboxMin[axis]));
        unionMax[axis] = Math.max(unionMax[axis], Number(item.bboxMax[axis]));
      }
    }
    const unionSize = unionMax.map((value, axis) => Number((value - unionMin[axis]).toFixed(2)));
    const unionGap = unionSize.map((value, axis) => Math.abs(value - (kernelBbox?.[axis] ?? Number.NaN)));
    const unionOk =
      partMetas.length === expectation.parts && broken.length === 0 && unionGap.every((gap) => Number.isFinite(gap) && gap <= 0.05);
    extraChecks.push({
      label: `逐件实体覆盖（${expectation.parts} 件）`,
      ok: unionOk,
      expected: `${expectation.parts} 件；逐件 bbox 并集 = 整机 bbox（±0.05mm）`,
      actual: `件数=${partMetas.length} 缺体积/bbox=${broken.length} 并集=${unionSize.join('×')} 整机=${(kernelBbox ?? []).join('×')}`,
      note: `体积合计=${(volumeSum / 1e6).toFixed(2)}e6 mm³ / 并集后=${(Number(merged.stats?.volumeMm3 ?? 0) / 1e6).toFixed(2)}e6 mm³`
    });

    // ---- 2) 逐件 STEP：数「85 装配件」用（合并体把相邻件布尔并成一体，只剩 27 个实体） ----
    const perPart = [];
    for (const [index, part] of parts.entries()) {
      const result = await manager.build(conveyorAssembly([part]));
      if (!result.ok) {
        console.error(`STEP_VERIFY FAIL 第 ${index + 1} 件（${part.id}）建模失败：${result.message ?? ''}`);
        process.exitCode = 1;
        return;
      }
      const path = result.files?.step?.path;
      if (typeof path !== 'string' || !existsSync(path)) {
        console.error(`STEP_VERIFY FAIL 第 ${index + 1} 件（${part.id}）没有 STEP`);
        process.exitCode = 1;
        return;
      }
      created.push(dirname(path));
      perPart.push(inspectStep(readFileSync(path, 'utf8'), statSync(path).size));
    }
    const aggregate = aggregateInspections(perPart);
    // 注意：这里的 bbox 是逐件**顶点**包络的并集，圆柱（滚筒/转台）顶点不在极值上，会比真机小
    // （6000×1280×760 vs 6000×1495×930）。整机包络以上面的合并体 + 内核逐件 bbox 为准。
    log(
      `perpart files=${perPart.length} solids=${aggregate.solids} faces=${aggregate.faces} bytes=${aggregate.bytes} ` +
        `vertexBbox=${aggregate.bbox ? aggregate.bbox.size.map((v) => v.toFixed(1)).join('×') : '?'}`
    );

    // ---- 3) 断言：合并体判头/字节/包络/单位/面数，实体数用逐件合计（85 ±5） ----
    const base = checkStepExport(
      { ...mergedInspection, solids: aggregate.solids, faces: mergedInspection.faces },
      expectation
    );
    const allChecks = [...base.checks, ...extraChecks];
    printChecks(allChecks);
    const ok = allChecks.every((check) => check.ok);
    log(`${ok ? 'PASS' : 'FAIL'} verify-step ${allChecks.filter((check) => check.ok).length}/${allChecks.length}`);
    if (!ok) process.exitCode = 1;
    if (jsonOutput) {
      console.log(
        `STEP_VERIFY_JSON ${JSON.stringify({
          mode: 'build',
          ok,
          stepPath,
          stepBytes,
          merged: mergedInspection,
          perPart: { files: perPart.length, solids: aggregate.solids, faces: aggregate.faces, bytes: aggregate.bytes },
          checks: allChecks
        })}`
      );
    }
  } finally {
    await manager.stop().catch(() => undefined);
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  }
}

if (fileArg) {
  inspectOnly(fileArg);
} else {
  await buildAndVerify();
}
