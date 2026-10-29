#!/usr/bin/env node
// 整机方案 CLI：给 Qt 客户端用（也方便脚本/CI）。
// 用法：node scripts/machine-design-cli.mjs --brief "六工位锁螺丝机，节拍 20 件/分钟" [--out case.json] [--quiet]
// 输出：stdout 只有 JSON（machine-case，schemaVersion=1）；日志走 stderr，方便客户端直接 JSON.parse。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildMachineCase } from '../src/machine/case.ts';
import { generateMachineGeometry } from '../src/machine/geometry.ts';
import { screenInterference } from '../src/machine/interference.ts';
import { resolveConflicts, resolveClearance } from '../src/machine/resolve.ts';
import { resolveLayout, complianceStamp, maxFeasibleClearance } from '../src/machine/layout.ts';
import { minWidening } from '../src/machine/widen.ts';
import { recheckPairs } from '../src/machine/recheck.ts';
import { CATALOG, buildInsertPart } from '../src/machine/catalog.ts';
import { screenClearance } from '../src/machine/clearance.ts';

const args = process.argv.slice(2);

// 构件库清单：Qt / 拖拽面板都从这里取，不要各自写死一份
if (args.includes('--catalog')) {
  process.stdout.write(JSON.stringify({ kind: 'machine-catalog', schemaVersion: 1, catalog: CATALOG }) + '\n');
  process.exit(0);
}

// 参数组合的硬错误要在最前面拦：放进「要几何才执行」的那段里，不带 --with-geometry 时会被静默忽略
if (args.includes('--ignore-pairs') && !args.includes('--layout-compliance')) {
  process.stderr.write('--ignore-pairs 只对 --layout-compliance 生效（没有 --layout-compliance 时不能默默吞掉）\n');
  process.exit(2);
}

// --clearance 的取值在解析参数时就校验：不带 --with-geometry 时也不能静默吞掉错误值
const clearanceIndex = args.indexOf('--clearance');
let clearanceThreshold = null;
if (clearanceIndex >= 0) {
  const raw = args[clearanceIndex + 1];
  const value = Number(raw);
  if (raw === undefined || !Number.isFinite(value) || value <= 0) {
    process.stderr.write('--clearance 需要一个正数（mm）\n');
    process.exit(2);
  }
  clearanceThreshold = value;
}
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.size ? args.at(index + 1) : fallback;
};

const briefIndex = args.indexOf('--brief');
const brief = briefIndex >= 0 && briefIndex + 1 < args.length ? args[briefIndex + 1] : '';
if (!brief.trim()) {
  console.error('FT_MACHINE_CLI_USAGE --brief "一句话需求" [--out path]');
  process.exit(2);
}
const outIndex = args.indexOf('--out');
const outFile = outIndex >= 0 && outIndex + 1 < args.length ? resolve(args[outIndex + 1]) : null;

const desktopRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(desktopRoot, '..');
const partsDir = join(repoRoot, 'packs', 'builtin');
const pricebookFile = join(partsDir, 'pricebook-cn', 'pricebook.json');

const withGeometry = args.includes('--with-geometry');
const { caseData, design } = buildMachineCase({
  brief,
  partsDir,
  ...(existsSync(pricebookFile) ? { pricebookFile } : {}),
  pricingAssumptions: ['命令行未读取 userData/machine-pricing.json，使用工程默认系数与工时单价。']
});

// --move <partId>:<dx>,<dy>,<dz>：试摆位用。可重复；只改中心点，不改尺寸/旋转。
const moves = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] !== '--move') continue;
  const raw = args[i + 1] || '';
  const [id, delta] = raw.split(':');
  const parts = String(delta || '').split(',').map(Number);
  if (!id || parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) {
    console.error(`FT_MACHINE_CLI_BAD_MOVE 需要 <partId>:<dx>,<dy>,<dz>，收到 ${raw}`);
    process.exit(2);
  }
  moves.push({ id, delta: parts });
}

if (withGeometry) {
  // 概念占位体（geometryFidelity='conceptual-estimate'）：给客户端画“示意装配”，不是制造几何
  caseData.geometry = generateMachineGeometry(design.config, {});
  const insertIndex = args.indexOf('--insert-part');
  if (insertIndex >= 0) {
    const spec = args[insertIndex + 1] ?? '';
    const [type, coords] = spec.split('@');
    const [x, y, z] = (coords ?? '').split(',').map(Number);
    const partial = buildInsertPart({ type: type ?? '', at: [x, y, z], existingIds: caseData.geometry.parts.map((part) => part.id) });
    if (!partial.ok) {
      process.stderr.write(`FT_MACHINE_CLI_INSERT_FAIL ${partial.reason}\n`);
      process.exit(2);
    }
    caseData.geometry.parts = [...caseData.geometry.parts, partial.part];
    caseData.geometry.inserted = { type: type, partId: partial.part.id, at: [x, y, z] };
  }
  // 干涉初筛（AABB）：只是「疑似」，不是布尔交集；结构件共位是正常装配
  if (moves.length > 0) {
    const byId = new Map(caseData.geometry.parts.map((part) => [part.id, part]));
    for (const move of moves) {
      const part = byId.get(move.id);
      if (!part) {
        console.error(`FT_MACHINE_CLI_UNKNOWN_PART ${move.id}`);
        process.exit(2);
      }
      part.center = [part.center[0] + move.delta[0], part.center[1] + move.delta[1], part.center[2] + move.delta[2]];
      part.movedBy = move.delta;
    }
    caseData.geometry.moves = moves;
  }
  if (args.includes('--resolve')) {
    // 批量解开未声明的重叠：逐轮挪一件再重算，收敛不了要如实写进 resolution
    const resolution = resolveConflicts(caseData.geometry);
    caseData.geometry.parts = resolution.parts;
    caseData.geometry.resolution = {
      before: resolution.before,
      after: resolution.after,
      moves: resolution.moves,
      iterations: resolution.iterations,
      converged: resolution.converged,
      ...(resolution.stopReason ? { stopReason: resolution.stopReason } : {})
    };
  }
  const ignoreIndex = args.indexOf('--ignore-pairs');
  const ignorePairs = ignoreIndex >= 0 && args[ignoreIndex + 1] && !args[ignoreIndex + 1].startsWith('--')
    ? args[ignoreIndex + 1].split(',').map((item) => item.trim()).filter(Boolean)
    : [];
  if (ignorePairs.length && args.indexOf('--layout-compliance') < 0) {
    process.stderr.write('--ignore-pairs 只对 --layout-compliance 生效\n');
    process.exit(2);
  }
  const recheckIndex = args.indexOf('--boolean-recheck');
  if (recheckIndex >= 0) {
    const url = args[recheckIndex + 1];
    if (!url || url.startsWith('--')) {
      process.stderr.write('--boolean-recheck 需要 sidecar 地址（如 http://127.0.0.1:18151）\n');
      process.exit(2);
    }
    const screen = screenInterference(caseData.geometry);
    const suspects = screen.pairs.filter((pair) => pair.kind === 'suspect').map((pair) => ({ a: pair.a, b: pair.b }));
    // 复核失败也必须落盘：要能看出「没复核」和「复核过没问题」的区别
    caseData.geometry.booleanRecheck = { suspects: suspects.length, ...(await recheckPairs(caseData.geometry.parts, suspects, { buildUrl: url })) };
  }
  const wideningIndex = args.indexOf('--min-widening');
  if (wideningIndex >= 0) {
    const target = Number(args[wideningIndex + 1]);
    if (!Number.isFinite(target) || target <= 0) {
      process.stderr.write('--min-widening 需要一个正数（目标间距 mm）\n');
      process.exit(2);
    }
    caseData.geometry.widening = minWidening(caseData.geometry, { clearanceMm: target });
  }
  if (args.includes('--max-clearance')) {
    // 二分找「还能排开的最大间距」，口径与排布合规一致
    const feasible = maxFeasibleClearance(caseData.geometry, { minMm: 5, maxMm: 60 });
    caseData.geometry.maxClearance = feasible;
  }
  const layoutIndex = args.indexOf('--layout-compliance');
  if (layoutIndex >= 0) {
    const threshold = Number(args[layoutIndex + 1]);
    if (!Number.isFinite(threshold) || threshold <= 0) {
      process.stderr.write('--layout-compliance 需要一个正数（mm）\n');
      process.exit(2);
    }
    const layout = resolveLayout(caseData.geometry, { clearanceMm: threshold, ...(ignorePairs.length ? { ignorePairs } : {}) });
    caseData.geometry.parts = layout.parts;
    caseData.geometry.layoutCompliance = {
      clearanceMm: layout.clearanceMm,
      rounds: layout.rounds,
      moves: layout.moves,
      suspects: layout.suspects,
      clearance: layout.clearance,
      converged: layout.converged,
      ...(layout.stopReason ? { stopReason: layout.stopReason } : {}),
      // 被跳过的「复核确认误报」对：不写出来的话，数字会显得莫名比上次好
      ...(ignorePairs.length ? { ignoredPairs: ignorePairs.length, ignoredKeys: ignorePairs } : {}),
      ...(layout.advice ? { advice: layout.advice } : {})
    };
    // 同时把结论写到文档顶层：打开方案时不用翻 geometry 也知道「按多少 mm 检查过、结论如何」
    caseData.compliance = {
      ...complianceStamp(layout),
      // 如果同一份方案也测过「最大可行间距」，把上限一起写进戳：
      // 打开方案时才能回答「这份是按 25 排的，机器上限也是 25」还是「按 20 排的，其实还能到 25」
      ...(caseData.geometry.maxClearance
        ? { maxFeasibleMm: caseData.geometry.maxClearance.feasibleMm }
        : {})
    };
  }
  const clearanceResolveIndex = args.indexOf('--resolve-clearance');
  if (clearanceResolveIndex >= 0) {
    const threshold = Number(args[clearanceResolveIndex + 1]);
    if (!Number.isFinite(threshold) || threshold <= 0) {
      process.stderr.write('--resolve-clearance 需要一个正数（mm）\n');
      process.exit(2);
    }
    const resolved = resolveClearance(caseData.geometry, { thresholdMm: threshold });
    caseData.geometry.parts = resolved.parts;
    caseData.geometry.clearanceResolution = {
      thresholdMm: resolved.thresholdMm,
      before: resolved.before,
      after: resolved.after,
      moves: resolved.moves,
      iterations: resolved.iterations,
      converged: resolved.converged,
      ...(resolved.stopReason ? { stopReason: resolved.stopReason } : {})
    };
  }
  if (clearanceThreshold !== null) {
    caseData.geometry.clearance = screenClearance(caseData.geometry, { thresholdMm: clearanceThreshold });
  }
  caseData.geometry.interference = screenInterference(caseData.geometry);
}

const json = `${JSON.stringify(caseData, null, 2)}\n`;
if (outFile) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, json, 'utf8');
  console.error(`FT_MACHINE_CLI_WROTE ${outFile}`);
}
process.stdout.write(json);
