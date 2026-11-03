#!/usr/bin/env node
/**
 * 任务级评测（末态断言）：`npm run eval:tasks`
 *
 * 和 eval/run-eval.mjs 的分工：
 *   run-eval.mjs  验「判得对不对」——意图 / 工具 / 参数，纯规则路由，不产生任何文件；
 *   本脚本        验「做完之后机器是不是对的」——在 mkdtemp 出来的临时 userData 里，
 *                 用**真实 CommandBus + AgentTools** 按固定工具序列执行（不调模型），
 *                 再断言磁盘末态：机型 config、几何件数、PLC 预检与 zip、机型库往返、
 *                 三态干涉数字、截图真伪。
 *
 * 不联网、不调 LLM、不启动 Electron。唯一的替身是「渲染层桥」（见 createHarness）：
 * 它就是主进程 ↔ 渲染层的那条边界，只保留 4 个方法，且行为与真实渲染层一致
 * （applyMachineConfig 把当前机型记进联调面板，getPlcGenConfig 再把它交回来）。
 * 机型落盘、几何生成、PLC 预检与打包、机型库打包含哈希，全部跑真代码。
 *
 * 用法：cd desktop && npm run eval:tasks
 * 输出：每例一行 `TASK_EVAL <id> PASS|FAIL <关键数字>`，末尾 `TASK_EVAL_SUMMARY pass=N/6 failed=M turns_total=T`；
 *      任一 FAIL 追加末态差异（期望 vs 实际），退出码 1。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentTools } from '../src/agent/tools.ts';
import { createAgentCommandBus } from '../src/agent/commands.ts';
import { buildConveyorParts } from '../src/machine/conveyor-assembly.ts';
import { conveyorParamsFromBrief } from '../src/machine/conveyor-synth.ts';
import { importPackage, listLibrary, readLibraryPackage, removeFromLibrary } from '../src/machine/library.ts';
import { parseMachineBrief } from '../src/machine/spec.ts';
import {
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
function createHarness() {
  const root = mkdtempSync(join(tmpdir(), 'cad-task-eval-'));
  roots.push(root);
  const calls = [];
  /** 联调面板当前机型配置：真实应用里由 applyMachineConfig 写入、getPlcGenConfig 读出。 */
  let plcConfig = null;
  const bridge = {
    async call(method, args = {}) {
      calls.push({ method, args });
      switch (method) {
        case 'applyMachineConfig':
          plcConfig = args?.config ?? null;
          return { ok: true };
        case 'getPlcGenConfig':
          return plcConfig;
        case 'appendMachineBomRows':
          return { ok: true, added: Array.isArray(args?.rows) ? args.rows.length : 0 };
        case 'removeMachineBomRows':
          return { ok: true, removed: Array.isArray(args?.rows) ? args.rows.length : 0 };
        case 'markPlcGenerated':
          return { ok: true };
        default:
          return { ok: false, message: `任务级评测未接的渲染层方法：${method}` };
      }
    }
  };
  const bus = createAgentCommandBus(registry, bridge, {
    userDataRoot: root,
    exportsRoot: join(root, 'exports'),
    now: FIXED_NOW
  });
  const tools = new AgentTools(registry, bus, { userDataRoot: root });
  return { root, calls, bus, tools };
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

const CASES = [
  ['t01-conveyor-90', caseConveyor90],
  ['t02-repair-safety', caseRepairSafety],
  ['t03-library-roundtrip', caseLibraryRoundtrip],
  ['t04-export-import', caseExportImport],
  ['t05-interference-states', caseInterferenceStates],
  ['t06-capture', caseCapture]
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
