#!/usr/bin/env node
/**
 * 任务级评测（末态断言）：`npm run eval:tasks`
 *
 * 和 eval/run-eval.mjs 的分工：
 *   run-eval.mjs  验「判得对不对」——意图 / 工具 / 参数，纯规则路由，不产生任何文件；
 *   本脚本        验「做完之后机器是不是对的」——在 mkdtemp 出来的临时 userData 里，
 *                 用**真实 CommandBus + AgentTools** 按固定工具序列执行（不调模型），
 *                 再断言磁盘末态：机型 config、几何件数、PLC 预检与 zip、机型库往返、
 *                 三态干涉数字、截图真伪、大结果外置与分批回取、跨会话记忆、计划预算与
 *                 续跑、写后验证挂回执。
 *
 * 不联网、不调 LLM、不启动 Electron。唯一的替身是「渲染层桥」（见 createHarness）：
 * 它就是主进程 ↔ 渲染层的那条边界，只保留 6 个方法，且行为与真实渲染层一致
 * （applyMachineConfig 把当前机型记进联调面板，getPlcGenConfig 再把它交回来，
 * getProjectContext 交回一份固定工程上下文）。
 * 机型落盘、几何生成、PLC 预检与打包、机型库打包含哈希、结果外置与分片、
 * 记忆落盘与脱敏、预算与续跑、写后自查，全部跑真代码。
 *
 * t08 / t10 需要「会话层」的两件事（写事实进记忆、把验证结论挂到回执上）本来就发生在
 * AgentSession 里，所以这两例用真 AgentSession + 固定剧本的假 LLM（只发一条工具调用，
 * 不产生任何模型请求），其余部分仍是真 bus / 真工具 / 真磁盘。
 *
 * 用法：cd desktop && npm run eval:tasks
 * 输出：每例一行 `TASK_EVAL <id> PASS|FAIL <关键数字>`，末尾 `TASK_EVAL_SUMMARY pass=N/10 failed=M turns_total=T`；
 *      任一 FAIL 追加末态差异（期望 vs 实际），退出码 1。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSession } from '../src/agent/session.ts';
import { AgentTools } from '../src/agent/tools.ts';
import { createAgentCommandBus } from '../src/agent/commands.ts';
import { collectAgentContext } from '../src/agent/context.ts';
import { getRecipe, runRecipe } from '../src/agent/recipes.ts';
import { evidenceHasNumber, findHollowPhrase, isDesignReview } from '../src/agent/design-review.ts';
import { parseToolResultData } from '../src/agent/guard.ts';
import { FileProjectMemory, projectMemoryPath } from '../src/agent/project-memory.ts';
import { AgentThread, resumeRunPlan, runPlan } from '../src/agent/thread.ts';
import { ToolResultStore, resultStoreDir } from '../src/agent/tool-result-store.ts';
import { TOOL_RESULT_BYTE_LIMIT, serializeToolResult, trimToolResult } from '../src/agent/trim.ts';
import { buildConveyorParts } from '../src/machine/conveyor-assembly.ts';
import { conveyorParamsFromBrief } from '../src/machine/conveyor-synth.ts';
import { importPackage, listLibrary, readLibraryPackage, removeFromLibrary } from '../src/machine/library.ts';
import { parseMachineBrief } from '../src/machine/spec.ts';
import {
  machineDesignPath,
  machineGeometryPaths,
  readActivePointer,
  readStoredMachineDesign
} from '../src/machine/store.ts';

/** 光伏板 90° 转向输送机：t01 / t05 的主体。 */
const BRIEF_PV =
  '光伏板加工输送机：输送 2000mm 光伏板，线体长 6000mm、带宽 1200mm，需要把光伏板旋转 90° 改变方向，节拍 6 件/分钟';
/** 出厂就不带急停/安全门的方案（t02 的修复对象）。 */
const BRIEF_SCREW = '设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服';
/** t03 的第二台方案：用来把 active 指针挪走，验证 load 能指回来。 */
const BRIEF_ASSEMBLY = '设计一台四工位装配机，节拍 15 件/分钟，用 400W 伺服';
/** 固定时钟：PLC 导出目录名带时间戳，固定后重复跑不产生新目录、结果可比。 */
const FIXED_NOW = () => new Date('2026-11-04T00:00:00.000Z');

const roots = [];
const registry = { listParts: () => [] };

/**
 * 临时 userData + 真实 CommandBus + 真实 AgentTools。
 *
 * 桥只实现这些用例会碰到的渲染层方法（真实应用里对应 extension.ts 的同名实现）：
 *   applyMachineConfig     → 渲染层把机型配置装进联调面板（这里记进 plcConfig 槽）
 *   getPlcGenConfig        → 联调面板当前配置（真实实现 commission.getMachineConfig()）
 *   appendMachineBomRows   → BOM 草稿追加
 *   removeMachineBomRows   → BOM 草稿回滚
 *   markPlcGenerated       → PLC 建议区状态
 * 其它方法一律 ok:false，避免「以为调到了渲染层」的假通过。
 */
function createHarness(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cad-task-eval-'));
  roots.push(root);
  const calls = [];
  /** 联调面板当前机型配置：真实应用里由 applyMachineConfig 写入、getPlcGenConfig 读出。 */
  let plcConfig = null;
  /**
   * t11 需要「成本/电气拿得到数据」：默认不提供（保持原有行为，getBom / getElecDocument
   * 走 default 分支如实报错），只有显式传进来的用例才拿到真数据。
   */
  const bomRows = Array.isArray(options.bomRows) ? options.bomRows : null;
  const elecDocument = options.elecDocument && typeof options.elecDocument === 'object' ? options.elecDocument : null;
  /**
   * 当前工程上下文：真实应用里由渲染层 getProjectContext 交回来，主进程再交给
   * collectAgentContext 算指纹。t08 的记忆分桶、t09 的续跑指纹都按它算，固定一份
   * 才能让「同一工程」在两次调用之间得到同一个指纹。
   */
  const projectContext = {
    machine: { name: '光伏板转向输送机', id: 'design-conveyor-1st' },
    plate: { placed: 0, width: 600, height: 400, recentActions: [] },
    bomRows: 12,
    hasCadModel: false
  };
  const bridge = {
    async call(method, args = {}) {
      calls.push({ method, args });
      switch (method) {
        case 'applyMachineConfig':
          plcConfig = args?.config ?? null;
          return { ok: true };
        case 'getPlcGenConfig':
          return plcConfig;
        case 'getProjectContext':
          return projectContext;
        case 'appendMachineBomRows':
          return { ok: true, added: Array.isArray(args?.rows) ? args.rows.length : 0 };
        case 'removeMachineBomRows':
          return { ok: true, removed: Array.isArray(args?.rows) ? args.rows.length : 0 };
        case 'markPlcGenerated':
          return { ok: true };
        case 'getBom':
          if (bomRows) return bomRows;
          return { ok: false, message: '任务级评测未提供 BOM' };
        case 'getElecDocument':
          if (elecDocument) return elecDocument;
          return { ok: false, message: '任务级评测未提供电气图纸' };
        default:
          return { ok: false, message: `任务级评测未接的渲染层方法：${method}` };
      }
    }
  };
  const bus = createAgentCommandBus(registry, bridge, {
    userDataRoot: root,
    exportsRoot: join(root, 'exports'),
    now: FIXED_NOW,
    // 成本工具在主进程里靠这个读取器拿内置价格簿；只有显式开启的用例才挂（与真实 app 同源）。
    ...(options.withPricebook === true
      ? {
        loadBuiltinPricebook: () => JSON.parse(
          readFileSync(new URL('../../packs/builtin/pricebook-cn/pricebook.json', import.meta.url), 'utf8')
        )
      }
      : {})
  });
  const tools = new AgentTools(registry, bus, { userDataRoot: root });
  return { root, projectContext, calls, bus, tools };
}

// ---------------------------------------------------------------------------
// 断言：一项一条，失败时留「期望 / 实际」，最后统一打印
// ---------------------------------------------------------------------------

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function short(value, limit = 160) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function createChecker() {
  const checks = [];
  const push = (label, ok, expected, actual) => {
    checks.push({ label, ok: Boolean(ok), expected, actual });
    return Boolean(ok);
  };
  return {
    checks,
    eq(label, actual, expected) {
      return push(label, sameJson(actual, expected), expected, actual);
    },
    ok(label, value, detail) {
      return push(label, value, true, detail ?? value);
    },
    ge(label, actual, min) {
      return push(label, typeof actual === 'number' && actual >= min, `>= ${min}`, actual);
    },
    in(label, actual, allowed) {
      return push(label, allowed.includes(actual), allowed, actual);
    },
    includes(label, list, value) {
      const actual = Array.isArray(list) ? list : [];
      return push(label, actual.includes(value), value, actual);
    },
    fail(label, message, actual) {
      return push(label, false, message, actual);
    }
  };
}

/** 工具结果必须是 ok:true，否则记一条失败并让调用方早退。 */
function requireOk(check, label, result) {
  if (result && result.ok === true) return true;
  check.fail(
    label,
    '工具返回 ok:true',
    result && result.ok === false ? `${result.code ?? 'FAILED'}: ${result.message ?? ''}` : short(result)
  );
  return false;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

/**
 * t01：光伏板 90° 转向输送机 → 设计 → 落盘 → PLC 生成。
 *
 * parts 的口径：design_machine 的 geometry 摘要是**规则占位几何**（47 件，见其 assumptions
 * 「三维模型不走代理体」）；这台机器的真实整机装配是 conveyor-assembly 的参数化件
 * （6 条窄带 + 滚筒 + 顶升旋转单元 + 机架，85 件），也就是交给 build123d 出 STEP 的那份。
 * 因此 parts ≥ 80 断言在参数化装配上（用 design 自己记下的输送机参数算），同时把落盘的
 * geometry.json 件数作为第二条断言，防止「几何文件悄悄消失 / 退化成空壳」。
 */
async function caseConveyor90() {
  const check = createChecker();
  const h = createHarness();
  let turns = 0;

  const design = await h.tools.call('design_machine', { brief: BRIEF_PV });
  turns += 1;
  if (!requireOk(check, 'design_machine 成功', design)) return { ok: false, checks: check.checks, turns };

  const applied = await h.tools.call('apply_machine_design', { design: design.design });
  turns += 1;
  if (!requireOk(check, 'apply_machine_design 成功', applied)) return { ok: false, checks: check.checks, turns };

  // —— 末态 1：磁盘上的方案与指针 ——
  const pointer = readActivePointer(h.root);
  const stored = readStoredMachineDesign(h.root, applied.machineId);
  check.eq('active.json 指向本机', pointer?.machineId, applied.machineId);
  const axisIds = Array.isArray(stored?.config?.actuators) ? stored.config.actuators.map((item) => item.id) : [];
  check.includes('config 有顶升轴 turner-lift', axisIds, 'turner-lift');
  check.includes('config 有回转轴 turner-rotary', axisIds, 'turner-rotary');

  // —— 末态 2：真实参数化整机装配件数 ——
  const brief = parseMachineBrief(BRIEF_PV);
  const conveyorParams = {
    ...conveyorParamsFromBrief(brief.conveyor),
    layers: brief.conveyor?.layers ?? 1,
    turnerAngleDeg: brief.turner?.angleDeg ?? 0
  };
  const assemblyParts = buildConveyorParts(conveyorParams).length;
  check.ge('参数化整机零件数 parts', assemblyParts, 80);

  // —— 末态 3：落盘几何文件 ——
  const geomPath = machineGeometryPaths(h.root, applied.machineId).json;
  const geomExists = existsSync(geomPath);
  check.ok('geometry.json 存在', geomExists, geomPath);
  const geomParts = geomExists ? JSON.parse(readFileSync(geomPath, 'utf8')).parts?.length ?? 0 : 0;
  check.ge('geometry.json 零件数', geomParts, 40);
  check.eq('apply 返回的摘要件数与文件一致', applied.geometry?.parts, geomParts);

  // —— 末态 4：PLC 生成（预检 + 11 个文件 + zip）——
  const plc = await h.tools.call('run_plc_generate', {});
  turns += 1;
  if (!requireOk(check, 'run_plc_generate 成功', plc)) {
    return { ok: false, checks: check.checks, turns };
  }
  const blocked = Array.isArray(plc.precheck?.errors) ? plc.precheck.errors.length : -1;
  const zipOk = typeof plc.zipPath === 'string' && existsSync(plc.zipPath) && statSync(plc.zipPath).size > 0;
  check.eq('PLC 预检 blocked', blocked, 0);
  check.eq('PLC 文件数', plc.fileCount, 11);
  check.ok('PLC zip 存在且非空', zipOk, plc.zipPath);

  const metrics = [
    `axes=${axisIds.filter((id) => id.startsWith('turner-')).join(',')}`,
    `parts=${assemblyParts}`,
    `geom_parts=${geomParts}`,
    `plc_files=${plc.fileCount ?? 0}`,
    `blocked=${blocked}`,
    `zip=${zipOk ? `${statSync(plc.zipPath).size}B` : '-'}`
  ];
  return { ok: check.checks.every((item) => item.ok), checks: check.checks, turns, metrics };
}

/**
 * t02：一台缺急停/安全门（且执行机构缺到位检测）的机型 → 自查 ok、PLC 预检拦下
 * → repair_plc_config 真写盘 → 再生成必须过。
 */
async function caseRepairSafety() {
  const check = createChecker();
  const h = createHarness();
  let turns = 0;

  const design = await h.tools.call('design_machine', { brief: BRIEF_SCREW });
  turns += 1;
  if (!requireOk(check, 'design_machine 成功', design)) return { ok: false, checks: check.checks, turns };

  const applied = await h.tools.call('apply_machine_design', { design: design.design });
  turns += 1;
  if (!requireOk(check, 'apply_machine_design 成功', applied)) return { ok: false, checks: check.checks, turns };

  // 结构/绑定自查：这台机器的结构是对的（0 error），问题只在 PLC 预检层面
  const validated = await h.tools.call('validate_machine_design', {});
  turns += 1;
  check.ok('validate_machine_design 结构化校验通过', validated.ok === true, short(validated.issues ?? validated));
  check.eq('自查 errors', validated.summary?.errors ?? -1, 0);

  // 预检必须拦下（否则 t02 就没东西可修，断言也就失去意义）
  const blockedBefore = await h.tools.call('run_plc_generate', {});
  turns += 1;
  const beforeErrors = blockedBefore.ok === false ? /（(\d+) 个错误）/.exec(blockedBefore.message ?? '')?.[1] : undefined;
  check.eq('修复前 PLC 预检被拦下', blockedBefore.ok, false);
  check.eq('修复前错误码', blockedBefore.code, 'PRECHECK_FAILED');
  check.ge('修复前错误数', Number(beforeErrors ?? 0), 1);
  check.ok('修复前不产出 zip', !blockedBefore.zipPath, blockedBefore.zipPath);

  const sensorsBefore = readStoredMachineDesign(h.root, applied.machineId)?.config?.sensors ?? [];
  const repaired = await h.tools.call('repair_plc_config', { dryRun: false });
  turns += 1;
  if (!requireOk(check, 'repair_plc_config 写盘成功', repaired)) return { ok: false, checks: check.checks, turns };
  check.eq('repair remainingIssues', repaired.remainingIssues ?? null, []);
  check.ge('repair added 条数', Array.isArray(repaired.added) ? repaired.added.length : 0, 1);

  // 修复要真的落到磁盘：读回方案，确认急停/安全门回路已在 config 里
  const stored = readStoredMachineDesign(h.root, applied.machineId);
  const sensorsAfter = stored?.config?.sensors ?? [];
  const points = sensorsAfter.map((item) => String(item.point ?? ''));
  check.ok('config.sensors 含急停回路', points.some((point) => /^ESTOP/i.test(point)), points.slice(-3));
  check.ok(
    'config.sensors 含安全门/光栅回路',
    points.some((point) => /LIGHT-CURTAIN|DOOR/i.test(point)),
    points.slice(-3)
  );
  check.ge('落盘后传感器数量增加', sensorsAfter.length, sensorsBefore.length + 1);

  const plc = await h.tools.call('run_plc_generate', {});
  turns += 1;
  if (!requireOk(check, '修复后 run_plc_generate 成功', plc)) {
    return { ok: false, checks: check.checks, turns };
  }
  const blockedAfter = Array.isArray(plc.precheck?.errors) ? plc.precheck.errors.length : -1;
  const zipOk = typeof plc.zipPath === 'string' && existsSync(plc.zipPath) && statSync(plc.zipPath).size > 0;
  check.eq('修复后 PLC 预检 blocked', blockedAfter, 0);
  check.eq('修复后 PLC 文件数', plc.fileCount, 11);
  check.ok('修复后 PLC zip 存在且非空', zipOk, plc.zipPath);

  const metrics = [
    `blocked_before=${beforeErrors ?? '?'}`,
    `added=${Array.isArray(repaired.added) ? repaired.added.length : 0}`,
    `remaining=${Array.isArray(repaired.remainingIssues) ? repaired.remainingIssues.length : '?'}`,
    `blocked_after=${blockedAfter}`,
    `plc_files=${plc.fileCount ?? 0}`,
    `zip=${zipOk ? `${statSync(plc.zipPath).size}B` : '-'}`
  ];
  return { ok: check.checks.every((item) => item.ok), checks: check.checks, turns, metrics };
}

/** t03：入库 → active 换到另一台 → 从库加载回来，指针与 config 逐字段回到原样。 */
async function caseLibraryRoundtrip() {
  const check = createChecker();
  const h = createHarness();
  let turns = 0;

  const designA = await h.tools.call('design_machine', { brief: BRIEF_PV });
  turns += 1;
  if (!requireOk(check, 'design_machine A 成功', designA)) return { ok: false, checks: check.checks, turns };
  const appliedA = await h.tools.call('apply_machine_design', { design: designA.design });
  turns += 1;
  if (!requireOk(check, 'apply_machine_design A 成功', appliedA)) return { ok: false, checks: check.checks, turns };
  const idA = appliedA.machineId;
  const configBefore = readStoredMachineDesign(h.root, idA)?.config ?? null;
  check.ok('落盘方案 A 有 config', configBefore !== null, idA);

  const saved = await h.tools.call('save_machine_to_library', {});
  turns += 1;
  if (!requireOk(check, 'save_machine_to_library 成功', saved)) return { ok: false, checks: check.checks, turns };
  check.eq('入库 id 与 active 一致', saved.id, idA);

  const listed = await h.tools.call('list_machine_library', {});
  turns += 1;
  if (!requireOk(check, 'list_machine_library 成功', listed)) return { ok: false, checks: check.checks, turns };
  check.eq('库内条数', listed.total, 1);
  check.eq('库里那条是 A', listed.items?.[0]?.id, idA);

  // 换一台：active 必须真的挪走，否则「加载指回」没有验证力
  const designB = await h.tools.call('design_machine', { brief: BRIEF_ASSEMBLY });
  turns += 1;
  if (!requireOk(check, 'design_machine B 成功', designB)) return { ok: false, checks: check.checks, turns };
  const appliedB = await h.tools.call('apply_machine_design', { design: designB.design });
  turns += 1;
  if (!requireOk(check, 'apply_machine_design B 成功', appliedB)) return { ok: false, checks: check.checks, turns };
  check.ok('切换后 active 不再是 A', readActivePointer(h.root)?.machineId !== idA, readActivePointer(h.root)?.machineId);
  check.ok('切换后 A 与 B 是两台机器', appliedB.machineId !== idA, appliedB.machineId);

  const loaded = await h.tools.call('load_machine_from_library', { id: idA });
  turns += 1;
  if (!requireOk(check, 'load_machine_from_library 成功', loaded)) return { ok: false, checks: check.checks, turns };

  const pointerAfter = readActivePointer(h.root);
  const configAfter = readStoredMachineDesign(h.root, idA)?.config ?? null;
  check.eq('active.json 指回 A', pointerAfter?.machineId, idA);
  check.ok('config 逐字段相等（与入库前落盘值）', sameJson(configAfter, configBefore), {
    before: short(configBefore),
    after: short(configAfter)
  });
  const fields = configBefore && typeof configBefore === 'object' ? Object.keys(configBefore).length : 0;

  const metrics = [
    `library_total=${listed.total}`,
    `id=${idA}`,
    `config_fields=${fields}`,
    `config_equal=${sameJson(configAfter, configBefore)}`,
    `active=${pointerAfter?.machineId ?? '-'}`
  ];
  return { ok: check.checks.every((item) => item.ok), checks: check.checks, turns, metrics };
}

/** t04：导出 → 删库 → 用库里那份字节重新导入，config 等价、二次导出 sha256 一致。 */
async function caseExportImport() {
  const check = createChecker();
  const h = createHarness();
  let turns = 0;

  const design = await h.tools.call('design_machine', { brief: BRIEF_PV });
  turns += 1;
  if (!requireOk(check, 'design_machine 成功', design)) return { ok: false, checks: check.checks, turns };
  const applied = await h.tools.call('apply_machine_design', { design: design.design });
  turns += 1;
  if (!requireOk(check, 'apply_machine_design 成功', applied)) return { ok: false, checks: check.checks, turns };
  const id = applied.machineId;
  const configBefore = readStoredMachineDesign(h.root, id)?.config ?? null;

  const saved = await h.tools.call('save_machine_to_library', {});
  turns += 1;
  if (!requireOk(check, 'save_machine_to_library 成功', saved)) return { ok: false, checks: check.checks, turns };

  const exported = await h.tools.call('export_machine_package', { id });
  turns += 1;
  if (!requireOk(check, 'export_machine_package 成功', exported)) return { ok: false, checks: check.checks, turns };
  const firstBytes = existsSync(exported.path) ? readFileSync(exported.path) : null;
  const firstHash = firstBytes ? createHash('sha256').update(firstBytes).digest('hex') : null;
  check.ok('导出文件存在', firstBytes !== null, exported.path);
  check.eq('导出 sha256 与磁盘字节一致', firstHash, exported.sha256);
  check.eq('导出字节数与磁盘一致', firstBytes?.byteLength ?? -1, exported.bytes);

  // 删库：不能只删索引，库目录要真的空
  const removed = removeFromLibrary(h.root, id);
  check.eq('删除的条目是这台的', removed?.id, id);
  check.eq('删库后库内条数', listLibrary(h.root).length, 0);

  // 用导出的字节重新导入（库函数，走真实解包 + 哈希校验 + 原子改名）
  let imported = null;
  try {
    imported = importPackage(h.root, firstBytes);
  } catch (error) {
    check.fail('importPackage 成功', '不抛错', error instanceof Error ? error.message : String(error));
  }
  check.eq('导入后 id', imported?.entry?.id, id);
  check.eq('导入后库内条数', listLibrary(h.root).length, 1);

  const libraryConfig = imported ? readLibraryPackage(h.root, id).pkg.config : null;
  check.ok('导入后的 config 与落盘值逐字段相等', sameJson(libraryConfig, configBefore), {
    before: short(configBefore),
    after: short(libraryConfig)
  });

  const reExported = await h.tools.call('export_machine_package', { id, targetPath: 'machines/re-export.machine.zip' });
  turns += 1;
  if (!requireOk(check, '二次 export_machine_package 成功', reExported)) {
    return { ok: false, checks: check.checks, turns };
  }
  check.eq('二次导出 sha256 与首次相同', reExported.sha256, exported.sha256);
  check.ok('二次导出是另一个文件', reExported.path !== exported.path, { first: exported.path, second: reExported.path });

  const metrics = [
    `bytes=${exported.bytes ?? 0}`,
    `sha=${String(exported.sha256 ?? '').slice(0, 12)}`,
    `reimport_sha=${String(reExported.sha256 ?? '').slice(0, 12)}`,
    `sha_stable=${reExported.sha256 === exported.sha256}`,
    `config_equal=${sameJson(libraryConfig, configBefore)}`,
    `library_total=${listLibrary(h.root).length}`
  ];
  return { ok: check.checks.every((item) => item.ok), checks: check.checks, turns, metrics };
}

/**
 * t05：同一台转向机跑 rest/lift/sweep。
 * 允许 hit=0，但三个状态的 (pairs, hits, mm3) 不能完全一样 —— 一样就说明可动件没动，
 * 检查器只是把静态位姿复制了三份。lift 的行程还必须等于 config 里 turner-lift.travelMm。
 */
async function caseInterferenceStates() {
  const check = createChecker();
  const h = createHarness();
  let turns = 0;

  const design = await h.tools.call('design_machine', { brief: BRIEF_PV });
  turns += 1;
  if (!requireOk(check, 'design_machine 成功', design)) return { ok: false, checks: check.checks, turns };
  const applied = await h.tools.call('apply_machine_design', { design: design.design });
  turns += 1;
  if (!requireOk(check, 'apply_machine_design 成功', applied)) return { ok: false, checks: check.checks, turns };

  const result = await h.tools.call('run_interference_check', { states: ['rest', 'lift', 'sweep'] });
  turns += 1;
  if (!requireOk(check, 'run_interference_check 成功', result)) {
    return { ok: false, checks: check.checks, turns };
  }

  const states = result.states ?? {};
  for (const name of ['rest', 'lift', 'sweep']) {
    const entry = states[name];
    check.ok(`状态 ${name} 有结果`, Boolean(entry) && typeof entry.mm3 === 'number', short(entry));
    // 新口径：必须把「确认干涉」和「待复核」分开给，评审只按 confirmedHits 判 FAIL
    check.ok(
      `状态 ${name} 带 confirmedHits / screenHits 拆分`,
      typeof entry?.confirmedHits === 'number' && typeof entry?.screenHits === 'number',
      short(entry)
    );
  }
  const rest = states.rest ?? {};
  const lift = states.lift ?? {};
  const sweep = states.sweep ?? {};
  const same = (left, right) =>
    left.pairs === right.pairs && left.hits === right.hits && left.mm3 === right.mm3;
  check.ok('lift 与 rest 不同（不是复制静态位姿）', !same(lift, rest), {
    rest: [rest.pairs, rest.hits, rest.mm3],
    lift: [lift.pairs, lift.hits, lift.mm3]
  });
  check.ok('三个状态不是同一个数字', !(same(rest, lift) && same(lift, sweep)), {
    rest: [rest.pairs, rest.hits, rest.mm3],
    lift: [lift.pairs, lift.hits, lift.mm3],
    sweep: [sweep.pairs, sweep.hits, sweep.mm3]
  });

  // 行程来自 config 的 turner-lift.travelMm，本脚本不写死 60
  const stored = readStoredMachineDesign(h.root, applied.machineId);
  const liftAxis = stored?.config?.actuators?.find((item) => item.id === 'turner-lift');
  check.eq('lift 用的执行机构', result.lift?.actuatorId, 'turner-lift');
  check.eq('lift 行程 = config travelMm', result.lift?.strokeMm, liftAxis?.travelMm);
  check.ge('sweep 扫描步数产生 ≥ 2 个位姿（mm3 与 rest 不同即证明扫描在动）', sweep.mm3 !== rest.mm3 ? 2 : 0, 2);

  const fmt = (entry) => `${entry.pairs ?? '?'}/${entry.hits ?? '?'}/${entry.mm3 ?? '?'}`;
  const metrics = [
    `parts=${result.partCount ?? '?'}`,
    `rest=${fmt(rest)}`,
    `lift=${fmt(lift)}`,
    `sweep=${fmt(sweep)}`,
    `stroke=${result.lift?.strokeMm ?? '?'}mm`
  ];
  return { ok: check.checks.every((item) => item.ok), checks: check.checks, turns, metrics };
}

/**
 * t06：无 GUI 环境截 3D 视图。
 * 只认两种结局：① 真落盘 —— 文件存在、bytes 与磁盘一致、sha256 可复算；② 明确拒绝 ——
 * 业务码在 VIEW_NOT_READY / VIEW_CAPTURE_UNAVAILABLE 内，且一个文件都不留。
 * 绝不允许「返回成功但文件不存在」。
 */
async function caseCapture() {
  const check = createChecker();
  const h = createHarness();

  const result = await h.tools.call('capture_view', { view: '3d' });
  const turns = 1;
  const shotsDir = join(h.root, 'agent-shots');
  const shotFiles = existsSync(shotsDir) ? readdirSync(shotsDir) : [];

  if (result?.ok === true) {
    // 成功分支：必须真的有文件，且哈希/字节数能复算
    const exists = typeof result.path === 'string' && existsSync(result.path);
    check.ok('成功时必须真有截图文件', exists, result.path);
    const bytes = exists ? readFileSync(result.path) : null;
    check.eq('返回字节数与磁盘一致', bytes?.byteLength ?? -1, result.bytes);
    check.eq(
      'sha256 可复算',
      bytes ? createHash('sha256').update(bytes).digest('hex') : null,
      result.sha256
    );
    check.ok('是 PNG 文件头', Boolean(bytes && bytes.subarray(1, 4).toString('ascii') === 'PNG'), result.path);
    check.ok('宽度为正', typeof result.width === 'number' && result.width > 0, result.width);
    check.ok('高度为正', typeof result.height === 'number' && result.height > 0, result.height);
    return {
      ok: check.checks.every((item) => item.ok),
      checks: check.checks,
      turns,
      metrics: [`mode=file`, `bytes=${bytes?.byteLength ?? 0}`, `sha=${String(result.sha256 ?? '').slice(0, 12)}`]
    };
  }

  // 拒绝分支：无头 CI 的正常结局，但必须是「明确拒绝 + 零文件」
  check.in('拒绝码是明确的不可用', result?.code, ['VIEW_NOT_READY', 'VIEW_CAPTURE_UNAVAILABLE']);
  check.ok('拒绝时不返回路径', !result?.path, result?.path);
  check.eq('拒绝时不落任何截图文件', shotFiles.length, 0);

  return {
    ok: check.checks.every((item) => item.ok),
    checks: check.checks,
    turns,
    metrics: [`mode=refused`, `code=${result?.code ?? '?'}`, `files=${shotFiles.length}`]
  };
}

// ---------------------------------------------------------------------------
// t07–t10 用到的「会话层」与编排层替身（都是真实代码的薄调用面）
// ---------------------------------------------------------------------------

const bytesOf = (text) => Buffer.byteLength(text, 'utf8');

/**
 * 主进程里的会话执行器（`electron/ipc.ts:1458-1495` 的 agentExecutor）：
 * 先走命令总线，`UNKNOWN_COMMAND` 才回落到工具层；`validateMachineDesign` 就是
 * `bus.execute('validate_machine_design')`，写后自动验证用的就是这条通道。
 * 这里加一个计数器，用来证明「验证结论来自真的跑了一次自查」，不是伪造的。
 */
function createExecutor(h) {
  const validate = { calls: 0 };
  return {
    validate,
    async execute(name, args = {}, signal) {
      const result = await h.bus.execute(name, args, signal);
      if (!result.ok && result.error?.code === 'UNKNOWN_COMMAND' && h.tools.has(name)) {
        return await h.tools.call(name, args, signal);
      }
      return result;
    },
    undoLast(signal) {
      return h.bus.undoLast(signal);
    },
    validateMachineDesign(signal) {
      validate.calls += 1;
      return h.bus.execute('validate_machine_design', {}, signal);
    }
  };
}

/** 剧本固定的假 LLM：只按顺序吐预设回复，不发任何网络请求。 */
function scriptedLlm(responses) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async chat(messages) {
      calls.push(messages);
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return response;
    }
  };
}

/**
 * 用真 AgentSession 跑一次 `apply_machine_design`，返回**模型看到的工具回执**。
 *
 * 为什么非要走会话层：写事实进 `agent-memory.json`（`session.ts:895` recordProjectFact）
 * 和把 `verification` 挂到回执上（`session.ts:1358-1360`）都发生在 AgentSession 内部，
 * 直接 `tools.call` 会绕过它们。这里除了 LLM 是剧本，其余（命令总线、工具、磁盘、
 * 项目记忆、验证通道）全是真的。
 */
async function applyViaSession(h, design, extra = {}) {
  const executor = createExecutor(h);
  const llm = scriptedLlm([
    {
      content: '',
      toolCalls: [
        {
          id: 'call-apply-1',
          type: 'function',
          function: { name: 'apply_machine_design', arguments: JSON.stringify({ design, ...extra }) }
        }
      ]
    },
    { content: '已应用到工程。', toolCalls: [] }
  ]);
  const memory = new FileProjectMemory({ root: h.root, now: () => FIXED_NOW() });
  const session = new AgentSession({
    llm,
    bus: executor,
    confirmWrite: async () => true,
    offlineFallback: false,
    contextProvider: () => collectAgentContext({ projectContext: () => h.projectContext }),
    projectMemory: memory
  });
  await session.run('把这台机型应用到工程');

  const toolMessage = [...session.history()].reverse().find(
    (message) => message.role === 'tool' && message.name === 'apply_machine_design'
  );
  const receipt = toolMessage ? parseToolResultData(toolMessage.content) : null;
  return { receipt, executor, session, memory, history: session.history() };
}

/**
 * t07：大结果外置 + 分批回取。
 *
 * 用 `design_machine` 的**真实返回**（本机型约 18 KB）按 10 KB 默认上限序列化——
 * 这就是任何普通工具在生产里走过的那条路（`design_machine` 自己是 64 KB 上限，
 * 所以这里显式传默认上限，才真的会超限）。断言：回执 id/bytes、落盘文件字节数与
 * 回执一致、分批读完拼回去与落盘原文逐字符相等、小结果不落盘。
 */
async function caseToolResultOffload() {
  const check = createChecker();
  const h = createHarness();
  let turns = 0;
  let offloadCalls = 0;
  const store = new ToolResultStore({ dir: resultStoreDir(h.root) });
  const offload = (text) => {
    offloadCalls += 1;
    return store.save(text);
  };

  const design = await h.tools.call('design_machine', { brief: BRIEF_PV });
  turns += 1;
  if (!requireOk(check, 'design_machine 成功', design)) return { ok: false, checks: check.checks, turns };

  // 原始 JSON = 生产里被外置的那份文本（trimToolResult 是序列化前的真实裁剪步骤）
  const original = JSON.stringify(trimToolResult(design));
  const originalBytes = bytesOf(original);
  check.ok('真实结果超过 10 KB（否则这条用例没有验证力）', originalBytes > TOOL_RESULT_BYTE_LIMIT, `${originalBytes}B`);

  const serialized = serializeToolResult(design, TOOL_RESULT_BYTE_LIMIT, offload);
  const receipt = JSON.parse(serialized.text);
  check.eq('回执 truncated', receipt.truncated, true);
  check.ok('回执 resultId 是 16 位小写 hex', /^[a-f0-9]{16}$/.test(String(receipt.resultId ?? '')), receipt.resultId);
  check.eq('offload 只被调用一次', offloadCalls, 1);
  check.eq('回执 bytes = 完整结果字节数', receipt.bytes, originalBytes);
  check.eq('serialize 的 fullBytes 与回执 bytes 一致', serialized.fullBytes, receipt.bytes);
  check.ok('回执本身 ≤ 10 KB（没有把完整结果塞回去）', bytesOf(serialized.text) <= TOOL_RESULT_BYTE_LIMIT, `${bytesOf(serialized.text)}B`);
  check.ok(
    'hint 能照着直接调 get_tool_result',
    new RegExp(`get_tool_result\\(resultId="${receipt.resultId}"`).test(String(receipt.hint ?? '')),
    receipt.hint
  );

  const file = join(h.root, 'agent-results', `${receipt.resultId}.json`);
  const fileExists = existsSync(file);
  check.ok('落盘文件存在', fileExists, file);
  const fileBytes = fileExists ? statSync(file).size : -1;
  check.eq('落盘字节数 = 回执 bytes', fileBytes, receipt.bytes);
  const onDisk = fileExists ? readFileSync(file, 'utf8') : '';
  check.ok('落盘内容与原始 JSON 逐字符相等', onDisk === original, {
    onDisk: onDisk.length,
    original: original.length
  });

  // 分批读完（每片 4096 字节，约 5 片），拼回去必须逐字符相等
  let offset = 0;
  let assembled = '';
  let pages = 0;
  let eof = false;
  while (!eof && pages < 64) {
    const page = await h.tools.call('get_tool_result', {
      resultId: receipt.resultId,
      offset,
      limit: 4096
    });
    turns += 1;
    pages += 1;
    if (!requireOk(check, `get_tool_result 第 ${pages} 片`, page)) break;
    check.eq(`第 ${pages} 片 bytes 与文件一致`, page.bytes, receipt.bytes);
    check.ok(
      `第 ${pages} 片落在 UTF-8 字符边界上（无 U+FFFD）`,
      typeof page.content === 'string' && !page.content.includes('\uFFFD'),
      String(page.content ?? '').slice(0, 32)
    );
    assembled += page.content;
    eof = page.eof === true;
    if (!eof) {
      const next = page.nextOffset;
      check.ok(`第 ${pages} 片给出可续读的 nextOffset`, Number.isInteger(next) && next > offset, { next, offset });
      if (!Number.isInteger(next) || next <= offset) break;
      offset = next;
    }
  }
  check.ge('确实分批读了（≥3 片）', pages, 3);
  check.eq('读到末尾时 eof=true', eof, true);
  check.ok('分批拼回去与原始 JSON 逐字符相等', assembled === original, {
    assembled: assembled.length,
    original: original.length
  });

  // 小结果不落盘：同一套 offload 回调，字节数没超限就不该碰磁盘
  const filesBefore = store.stats().files;
  const small = await h.tools.call('list_machine_library', {});
  turns += 1;
  if (!requireOk(check, 'list_machine_library 成功', small)) {
    return { ok: false, checks: check.checks, turns };
  }
  const smallSerialized = serializeToolResult(small, TOOL_RESULT_BYTE_LIMIT, offload);
  const smallReceipt = JSON.parse(smallSerialized.text);
  // 未超限时 text 就是原样结果本身：既没有外置回执的 {resultId,hint,preview} 包装，
  // 也保留工具自己的字段（这里是小列表的 {items,total,truncated}）。
  check.ok('小结果回执没有 preview 包装', smallReceipt.preview === undefined, smallReceipt.preview);
  check.ok('小结果回执没有 hint', smallReceipt.hint === undefined, smallReceipt.hint);
  check.ok('小结果回执没有 resultId', smallReceipt.resultId === undefined, smallReceipt.resultId);
  check.eq('小结果是原样工具结果（items/total 还在）', smallReceipt.total, small.total);
  check.ok('小结果没超上限', bytesOf(smallSerialized.text) <= TOOL_RESULT_BYTE_LIMIT, `${bytesOf(smallSerialized.text)}B`);
  check.eq('小结果没触发外置回调', offloadCalls, 1);
  check.eq('小结果不落盘（文件数不变）', store.stats().files, filesBefore);

  const metrics = [
    `full=${originalBytes}B`,
    `receipt=${bytesOf(serialized.text)}B`,
    `resultId=${receipt.resultId}`,
    `pages=${pages}`,
    `files=${store.stats().files}`
  ];
  return { ok: check.checks.every((item) => item.ok), checks: check.checks, turns, metrics };
}

/**
 * t08：跨会话项目记忆（写事实 → 读回 → 脱敏 → 清空）。
 *
 * 走真 AgentSession，所以 recordProjectFact 那条线是真的；断言磁盘上的
 * `userData/agent-memory.json`：该工程 1 条、kind=machine-apply、summary 含机型名。
 * 然后故意把 apiKey 形状的串塞进能进记忆的字段（应用时的 name），断言文件与读回
 * 都不出现 `sk-` 原文；最后 clear 后该工程为空。
 */
async function caseProjectMemory() {
  const check = createChecker();
  const h = createHarness();
  let turns = 0;

  const design = await h.tools.call('design_machine', { brief: BRIEF_PV });
  turns += 1;
  if (!requireOk(check, 'design_machine 成功', design)) return { ok: false, checks: check.checks, turns };
  const machineName = String(design.design?.config?.name ?? '');
  check.ok('机型有名字（summary 要含它）', machineName.length > 0, machineName);

  const applied = await applyViaSession(h, design.design);
  turns += 1;
  if (!requireOk(check, '真会话 apply_machine_design 成功', applied.receipt)) {
    return { ok: false, checks: check.checks, turns };
  }

  const file = projectMemoryPath(h.root);
  const fileExists = existsSync(file);
  check.ok('agent-memory.json 已落盘', fileExists, file);
  if (!fileExists) return { ok: false, checks: check.checks, turns };

  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const buckets = Object.entries(parsed.projects ?? {});
  check.eq('只有一个工程桶', buckets.length, 1);
  const [fingerprint, bucket] = buckets[0] ?? ['', { entries: [] }];
  check.eq('该工程有 1 条事实', bucket?.entries?.length, 1);
  check.eq('kind = machine-apply', bucket?.entries?.[0]?.kind, 'machine-apply');
  check.ok(
    'summary 含机型名',
    String(bucket?.entries?.[0]?.summary ?? '').includes(machineName),
    bucket?.entries?.[0]?.summary
  );
  const onlyFields = Object.keys(bucket?.entries?.[0] ?? {}).sort();
  check.eq('只落 5 个白名单字段', onlyFields, ['kind', 'ok', 'ref', 'summary', 'ts']);

  // 读回来：指纹必须与文件里的桶一致，否则「读记忆」和「写记忆」就是两套算法
  const readBack = await h.tools.call('get_agent_memory', {});
  turns += 1;
  if (!requireOk(check, 'get_agent_memory 成功', readBack)) return { ok: false, checks: check.checks, turns };
  check.eq('get_agent_memory 的指纹 = 文件里的桶', readBack.fingerprint, fingerprint);
  check.eq('get_agent_memory count', readBack.count, 1);
  check.eq('读回的 summary 与文件一致', readBack.entries?.[0]?.summary, bucket?.entries?.[0]?.summary);
  check.eq('读回的 kind', readBack.entries?.[0]?.kind, 'machine-apply');

  // 脱敏：把 apiKey 形状的串塞进「能进记忆」的字段（应用名会进 summary）
  const secret = 'sk-live-evaltasks0a1b2c3d4e5f';
  const taintedName = `${machineName} ${secret}`;
  const tainted = await applyViaSession(h, design.design, { name: taintedName, overwrite: true });
  turns += 1;
  if (!requireOk(check, '带敏感串的应用成功（脱敏发生在写记忆时）', tainted.receipt)) {
    return { ok: false, checks: check.checks, turns };
  }
  const rawAfter = readFileSync(file, 'utf8');
  check.ok('记忆文件不含 sk- 原文', !rawAfter.includes('sk-live'), rawAfter.includes('sk-live') ? '文件里出现了 sk-live' : '干净');
  check.ok('记忆文件含脱敏标记', rawAfter.includes('[已隐去]'), 'missing [已隐去]');
  const readAfter = await h.tools.call('get_agent_memory', {});
  turns += 1;
  check.eq('第二台应用后共 2 条', readAfter.count, 2);
  check.ok('读回也不含 sk- 原文', !JSON.stringify(readAfter.entries ?? []).includes('sk-live'), readAfter.entries?.at(-1)?.summary);
  check.ok(
    '最新一条的 summary 里密钥位置已被替换',
    String(readAfter.entries?.at(-1)?.summary ?? '').includes('[已隐去]'),
    readAfter.entries?.at(-1)?.summary
  );

  // 清空：只清当前工程，清完读回为空、文件里也不再有这个桶
  const cleared = await h.tools.call('clear_agent_memory', {});
  turns += 1;
  if (!requireOk(check, 'clear_agent_memory 成功', cleared)) return { ok: false, checks: check.checks, turns };
  check.eq('清掉的条数', cleared.cleared, 2);
  const afterClear = await h.tools.call('get_agent_memory', {});
  turns += 1;
  check.eq('清空后 count=0', afterClear.count, 0);
  check.eq('清空后文件里没有该工程桶', Object.keys(JSON.parse(readFileSync(file, 'utf8')).projects ?? {}).length, 0);

  const metrics = [
    `entries=1→2→0`,
    `kind=machine-apply`,
    `fingerprint=${fingerprint}`,
    `scrubbed=${rawAfter.includes('[已隐去]')}`,
    `cleared=${cleared.cleared}`
  ];
  return { ok: check.checks.every((item) => item.ok), checks: check.checks, turns, metrics };
}

/**
 * t09：计划预算到顶 + 续跑不重跑。
 *
 * 真 `runPlan` + 13 步计划（第 1 步是真写：`apply_machine_design`），所以预算按
 * 「含写步骤」上抬到 12；跑满 12 步后预算停下，返回 stopped/nextStepIndex。
 * 再用 `resumeRunPlan` 从第 13 步接着跑，用**逐步调用计数**证明前 12 步没被重跑。
 */
async function casePlanBudgetResume() {
  const check = createChecker();
  const h = createHarness();
  let turns = 0;

  const design = await h.tools.call('design_machine', { brief: BRIEF_PV });
  turns += 1;
  if (!requireOk(check, 'design_machine 成功', design)) return { ok: false, checks: check.checks, turns };

  const readTools = ['validate_machine_design', 'list_machine_library', 'get_agent_memory'];
  const steps = [
    { tool: 'apply_machine_design', args: { design: design.design }, why: '把方案应用到工程', readOnly: false },
    ...Array.from({ length: 12 }, (_, index) => {
      const tool = readTools[index % readTools.length];
      return { tool, args: {}, why: `自查第 ${index + 1} 轮（${tool}）`, readOnly: true };
    })
  ];
  const plan = { confidence: 0.9, steps };
  check.eq('计划 13 步（> 预算 12，才停得下来）', steps.length, 13);

  const counts = new Map();
  const execute = async (step, index) => {
    counts.set(index, (counts.get(index) ?? 0) + 1);
    return await h.tools.call(step.tool, step.args ?? {});
  };

  const thread = new AgentThread();
  const first = await runPlan(plan, {
    execute,
    confirmPlan: async () => true,
    thread,
    currentContext: h.projectContext,
    userText: '把这台机器应用到工程并逐项自查'
  });
  turns += counts.size ? [...counts.values()].reduce((sum, value) => sum + value, 0) : 0;

  check.eq('预算 effective=12', first.budget?.effective, 12);
  check.eq('预算原因 = write（含写步骤）', first.budget?.reason, 'write');
  check.eq('stopped = iteration_limit', first.stopped, 'iteration_limit');
  check.eq('results.length = 已执行步数', first.results.length, 12);
  check.eq('iterations = 已执行步数', first.iterations, 12);
  check.eq('nextStepIndex 指向下一步', first.nextStepIndex, 12);
  check.eq('12 步全成功', first.results.every((item) => item.ok === true), true);
  check.eq('执行过的是第 0..11 步', [...counts.keys()].sort((a, b) => a - b), [...Array(12).keys()]);
  check.ok('pendingHint 点名从第 13 步继续', /第 13 步/.test(String(first.pendingHint ?? '')), first.pendingHint);
  check.ok('第 1 步真的把方案写进了磁盘', existsSync(machineDesignPath(h.root, 'design-conveyor-1st')), machineDesignPath(h.root, 'design-conveyor-1st'));

  const beforeResume = new Map(counts);
  // 续跑也带上确认回调：万一实现退化成「从头再跑」，写步骤会真的重放，
  // 下面的调用计数立刻能抓到（不带确认回调的话它只会以「取消」收场，暴露得不够直接）。
  const second = await resumeRunPlan(plan, {
    execute,
    confirmPlan: async () => true,
    thread,
    currentContext: h.projectContext
  });
  turns += 1;

  check.eq('续跑起点 = 12', second.resumedFrom, 12);
  check.eq('续跑 ok', second.ok, true);
  check.eq('续跑没再停（stopped 不出现）', second.stopped, undefined);
  check.eq('续跑只执行剩余 1 步', second.results.length, 1);
  check.eq('续跑执行的是第 13 步', second.results[0]?.index, 12);
  const rerun = [...beforeResume.entries()].filter(([index, count]) => (counts.get(index) ?? 0) !== count).map(([index]) => index);
  check.eq('前 12 步一次都没被重跑', rerun, []);
  check.eq('第 13 步只执行 1 次', counts.get(12), 1);
  check.eq('续跑后线程状态不再残留续跑位置', thread.read()?.nextStepIndex, undefined);

  const metrics = [
    `budget=${first.budget?.effective}/${first.budget?.reason}`,
    `stopped_at=${first.results.length}`,
    `next=${first.nextStepIndex}`,
    `resume=${second.resumedFrom}→${second.results.length}step`,
    `rerun=${rerun.length}`
  ];
  return { ok: check.checks.every((item) => item.ok), checks: check.checks, turns, metrics };
}

/**
 * t10：写后自动验证挂回执。
 *
 * ① 真会话跑 `apply_machine_design` → 回执必须带 `verification.ok=true` 且
 *    `source='auto'`，并断言验证通道真的被调了一次（不是凭空写上去的字段）；
 * ② 再跑一个坏方案（传感器绑到不存在的执行机构）→ 必须被拦住：要么操作 `ok:false`
 *    且有中文原因，要么 `verification.ok=false` 且有中文下一步；两者必居其一。
 */
async function caseVerifyAttached() {
  const check = createChecker();
  const h = createHarness();
  let turns = 0;

  const design = await h.tools.call('design_machine', { brief: BRIEF_PV });
  turns += 1;
  if (!requireOk(check, 'design_machine 成功', design)) return { ok: false, checks: check.checks, turns };

  const applied = await applyViaSession(h, design.design);
  turns += 1;
  if (!requireOk(check, '真会话 apply_machine_design 成功', applied.receipt)) {
    return { ok: false, checks: check.checks, turns };
  }
  const goodId = readActivePointer(h.root)?.machineId;
  check.ok('好方案已落盘', Boolean(goodId && existsSync(machineDesignPath(h.root, goodId))), goodId);

  check.eq('回执带 verification.ok', applied.receipt?.verification?.ok, true);
  check.eq('verification.source = auto', applied.receipt?.verification?.source, 'auto');
  check.eq('验证 issues 为空', applied.receipt?.verification?.issues, []);
  check.eq('验证通道真的跑了一次自查', applied.executor.validate.calls, 1);

  // 坏方案：把一个非安全传感器的 part 指到不存在的执行机构
  const broken = JSON.parse(JSON.stringify(design.design));
  broken.config.id = 'design-broken-1st';
  const sensors = Array.isArray(broken.config.sensors) ? broken.config.sensors : [];
  const victim = sensors.find((item) => !/^ESTOP|SAFETY|DOOR|CURTAIN|LIGHT/i.test(String(item?.point ?? '')));
  check.ok('找到可改绑的普通传感器（否则这条断言没有验证力）', Boolean(victim), short(sensors.slice(0, 3)));
  if (!victim) return { ok: false, checks: check.checks, turns };
  victim.part = 'ghost-actuator-9';

  const bad = await applyViaSession(h, broken);
  turns += 1;
  const blockedByValidation = bad.receipt?.ok === false;
  const failedSelfCheck = bad.receipt?.verification?.ok === false;
  check.ok(
    '坏方案被拦住：或操作失败、或自查未通过（二者必居其一）',
    blockedByValidation || failedSelfCheck,
    { ok: bad.receipt?.ok, verification: bad.receipt?.verification }
  );
  const reason = blockedByValidation
    ? String(bad.receipt?.error?.message ?? '')
    : String(bad.receipt?.verification?.nextAction ?? '');
  check.ok('拦住时有中文原因', /[\u4e00-\u9fa5]{2,}/.test(reason), reason);
  check.ok(
    '原因点出坏在哪个绑定/引用',
    /ghost-actuator-9/.test(reason) || /传感器/.test(reason) || /执行机构/.test(reason),
    reason
  );
  if (blockedByValidation) {
    check.eq('被结构校验拦住（INVALID_ARGUMENT）', bad.receipt?.error?.code, 'INVALID_ARGUMENT');
  }
  // 末态：坏方案不能落盘，active 也不能被挪走
  check.ok(
    '坏方案没有落盘',
    !existsSync(machineDesignPath(h.root, 'design-broken-1st')),
    machineDesignPath(h.root, 'design-broken-1st')
  );
  check.eq('active 仍是好方案', readActivePointer(h.root)?.machineId, goodId);

  const metrics = [
    `verified=${applied.receipt?.verification?.ok}`,
    `source=${applied.receipt?.verification?.source}`,
    `validate_calls=${applied.executor.validate.calls}`,
    `bad=${blockedByValidation ? 'rejected' : 'verify_failed'}`,
    `bad_code=${bad.receipt?.error?.code ?? bad.receipt?.verification?.ok}`
  ];
  return { ok: check.checks.every((item) => item.ok), checks: check.checks, turns, metrics };
}

/**
 * t11：设计评审（第 6 个配方）——真实跑一次，末态断言汇总结论。
 *
 * 输入是真实落盘机型的 review-design 全链路：get_project_context → validate_machine_design
 * → run_interference_check(states) → run_electrical_check → run_cost_report，5 步全真跑，
 * 汇总器是纯函数。电气图纸故意带两处真缺陷（线号 101 重复、1.5mm² 配 16A 断路器），
 * 用来证明三件事：
 *   1) 评审能给 FAIL，且 FAIL 的理由是数字（error 条数），不是空话；
 *   2) collect 策略：电气失败后成本照样跑完（后面的步骤结果真的存在）；
 *   3) 汇总出的 4 条都带数字证据、建议都指名工具。
 */
async function caseDesignReview() {
  const check = createChecker();
  const h = createHarness({
    withPricebook: true,
    // 真实价格簿里的型号，让成本这一项能算出总价（缺价 0 条）
    bomRows: [
      { partId: 'D-M9B', name: '磁性开关', qty: 4, unit: '件' },
      { partId: 'MHZ2-20D', name: '气爪', qty: 2, unit: '件' }
    ],
    elecDocument: {
      ok: true,
      source: { kind: 'sheet', name: 't11-评审图纸' },
      document: {
        // 同网络重复线号 → WIRE_NO_DUPLICATE（真实 error）
        wires: [
          { no: '101', net: 'N1', potential: '24V', from: 'QF1', to: 'KA1', sectionMm2: 1.5 },
          { no: '101', net: 'N1', potential: '24V', from: 'QF1', to: 'KA2', sectionMm2: 1.5 }
        ],
        loads: [
          { tag: 'M1', powerKw: 0.75, phase: '3P' },
          { tag: 'M2', powerKw: 0.4, phase: 'L1' }
        ],
        // 16A 断路器配 1.5mm²（载流量 14A）→ WIRE_SECTION_UNDER / 断路器大于载流量
        circuits: [{ wireNo: '101', currentA: 8, sectionMm2: 1.5, breakerA: 16 }],
        options: { psuRatedA: 10 }
      }
    }
  });
  let turns = 0;

  const design = await h.tools.call('design_machine', { brief: BRIEF_PV });
  turns += 1;
  if (!requireOk(check, 'design_machine 成功', design)) return { ok: false, checks: check.checks, turns };
  const applied = await h.tools.call('apply_machine_design', { design: design.design });
  turns += 1;
  if (!requireOk(check, 'apply_machine_design 成功', applied)) return { ok: false, checks: check.checks, turns };

  const recipe = getRecipe('review-design');
  check.ok('配方存在且为 collect 策略', recipe?.onError === 'collect', {
    id: recipe?.id,
    onError: recipe?.onError,
    aggregate: recipe?.aggregate
  });

  const run = await runRecipe('review-design', {}, {
    execute: async (step) => {
      const outcome = await h.tools.call(step.tool, step.args);
      turns += 1;
      return outcome;
    },
    now: () => Date.now()
  });

  // —— 末态 1：5 步都执行过（collect 不中断）——
  const stepIds = run.results.map((item) => item.stepId);
  check.eq('步骤顺序固定', stepIds, ['context', 'structure', 'interference', 'electrical', 'cost']);
  check.eq('跑完整条流程（ok）', run.ok, true);
  const structure = run.results.find((item) => item.stepId === 'structure');
  const interference = run.results.find((item) => item.stepId === 'interference');
  const electrical = run.results.find((item) => item.stepId === 'electrical');
  const cost = run.results.find((item) => item.stepId === 'cost');
  check.eq('结构校验 0 error', structure?.data?.summary?.errors, 0);
  // run_electrical_check 的「有 error」是 findings 里的 error，不是工具失败（工具本身 ok:true）
  check.eq('电气工具跑成功', electrical?.ok, true);
  check.ge('电气 findings 抓到真缺陷（error ≥ 1）', electrical?.data?.counts?.error, 1);
  check.eq('成本步骤成功（电气有 error 也不影响后面跑）', cost?.ok, true);
  check.ge('成本总价是数字', cost?.data?.totals?.grand, 1);

  // —— 末态 2：汇总结论 ——
  const review = run.aggregate;
  check.ok('run.aggregate 是评审结论', isDesignReview(review), short(review));
  if (!isDesignReview(review)) return { ok: false, checks: check.checks, turns };

  check.eq('items 数量 = 4', review.items.length, 4);
  check.eq('四条区域固定', review.items.map((item) => item.area), ['结构', '干涉', '电气', '成本']);
  const statuses = review.items.map((item) => item.status);
  const expectedVerdict = statuses.includes('fail')
    ? 'FAIL'
    : statuses.some((status) => status === 'warn' || status === 'na') ? 'WARN' : 'PASS';
  check.eq('verdict 符合规则（任一 fail → FAIL）', review.verdict, expectedVerdict);
  check.eq('电气这一项判 fail', review.items.find((item) => item.area === '电气')?.status, 'fail');
  // 干涉判定必须与三态数字对齐（新口径）：
  //   无状态数据 → na；任一态 confirmedHits>0 → fail；
  //   任一态 screenHits>0 或位姿 direction-overridden → warn；否则 pass。
  // 这里不能用 hits 判 fail：hits 含 AABB 候选，正是这次误判「不可出图」的来源。
  const stateEntries = ['rest', 'lift', 'sweep']
    .map((name) => interference?.data?.[name] ?? interference?.data?.states?.[name])
    .filter((entry) => entry && typeof entry === 'object');
  const confirmedHits = stateEntries.map((entry) => entry.confirmedHits).filter((value) => typeof value === 'number');
  const screenHits = stateEntries.map((entry) => entry.screenHits).filter((value) => typeof value === 'number');
  const poseOverridden = stateEntries.some((entry) => entry.poseValidity === 'direction-overridden')
    || interference?.data?.lift?.directionOverridden === true;
  const expectedInterference = stateEntries.length === 0
    ? 'na'
    : confirmedHits.some((value) => value > 0)
      ? 'fail'
      : screenHits.some((value) => value > 0) || poseOverridden ? 'warn' : 'pass';
  check.eq('干涉判定与 confirmedHits/screenHits 一致', review.items.find((item) => item.area === '干涉')?.status, expectedInterference);

  for (const item of review.items) {
    check.ok(`${item.area} 的证据带数字`, evidenceHasNumber(item.evidence), item.evidence);
    const toolHit = ['get_project_context', 'validate_machine_design', 'run_interference_check',
      'run_electrical_check', 'run_cost_report', 'export_cost_report', 'run_plc_generate',
      'place_component', 'update_component', 'apply_machine_design']
      .some((name) => item.suggestion.includes(name));
    check.ok(`${item.area} 的建议指名工具`, toolHit, item.suggestion);
    check.eq(`${item.area} 的建议不含空话`, findHollowPhrase(item.suggestion), null);
  }
  check.eq('摘要不含「进一步检查」这类空话', findHollowPhrase(review.summary), null);
  check.ok('摘要带结论与数字', /设计评审 (PASS|WARN|FAIL)/.test(review.summary) && /\d/.test(review.summary), review.summary);
  check.ok('流程摘要带评审结论', /设计评审 (PASS|WARN|FAIL)/.test(run.summary), run.summary);

  const metrics = [
    `verdict=${review.verdict}`,
    `items=${review.items.length}`,
    `status=${review.items.map((item) => item.status).join(',')}`,
    `elec_errors=${electrical?.data?.counts?.error ?? '?'}`,
    `cost_grand=${cost?.data?.totals?.grand ?? '?'}`,
    `steps=${run.results.length}`
  ];
  return { ok: check.checks.every((item) => item.ok), checks: check.checks, turns, metrics };
}

const CASES = [
  ['t01-conveyor-90', caseConveyor90],
  ['t02-repair-safety', caseRepairSafety],
  ['t03-library-roundtrip', caseLibraryRoundtrip],
  ['t04-export-import', caseExportImport],
  ['t05-interference-states', caseInterferenceStates],
  ['t06-capture', caseCapture],
  ['t07-tool-result-offload', caseToolResultOffload],
  ['t08-project-memory', caseProjectMemory],
  ['t09-plan-budget-resume', casePlanBudgetResume],
  ['t10-verify-attached', caseVerifyAttached],
  ['t11-design-review', caseDesignReview]
];

function printFailure(caseId, result) {
  for (const check of result.checks.filter((item) => !item.ok)) {
    console.error(
      `  ✗ ${caseId} · ${check.label}：期望 ${short(check.expected)} / 实际 ${short(check.actual)}`
    );
  }
  if (result.error) console.error(`  ✗ ${caseId} · 未捕获异常：${result.error}`);
}

async function main() {
  const startedAt = Date.now();
  let passed = 0;
  let failed = 0;
  let turnsTotal = 0;

  for (const [caseId, run] of CASES) {
    let result;
    try {
      result = await run();
    } catch (error) {
      result = {
        ok: false,
        checks: [],
        turns: 0,
        metrics: [],
        error: error instanceof Error ? (error.stack ?? error.message) : String(error)
      };
    }
    turnsTotal += result.turns ?? 0;
    if (result.ok) {
      passed += 1;
      console.log(`TASK_EVAL ${caseId} PASS ${(result.metrics ?? []).join(' ')}`.trim());
    } else {
      failed += 1;
      console.log(`TASK_EVAL ${caseId} FAIL ${(result.metrics ?? []).join(' ')}`.trim());
      printFailure(caseId, result);
    }
  }

  console.log(
    `TASK_EVAL_SUMMARY pass=${passed}/${CASES.length} failed=${failed} turns_total=${turnsTotal}`
  );
  console.log(`TASK_EVAL_RUNTIME ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(`TASK_EVAL_CRASH ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
