// 守住 scripts/pv-buffer-regenerate.mjs 的门禁与「路径/进程边界」语义。
// 为什么要有这条：那个脚本敢在报告里写「180mm 八层路径没退化」，就必须先被证明**会失败**——
// 一个永远返回 ok 的断言等于没有断言。这里用假数据把每类不符逐条打一遍，并用真实子进程
// 验证：负例拒得掉、干净目录只建一次、信号中断后不留孤儿。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BASELINE,
  PV_SLOT_FAMILIES,
  assertBuildFacts,
  assertCleanupUserData,
  assertRecordFacts,
  assertReportTarget,
  assertSceneFacts,
  bomSummary,
  buildFacts,
  buildLaunchSpec,
  createChecks,
  createSupervisor,
  findOwnedLeftovers,
  hasExactUserDataToken,
  isProtectedUserData,
  parseArgs,
  planSummary,
  sanitizeProjectId,
  slotsFromGeometryParts,
  slotsNote,
  terminateOwned,
  validateProjectName,
  verifyProjectDir
} from '../../scripts/pv-buffer-regenerate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..', '..');
const scriptPath = join(desktopRoot, 'scripts', 'pv-buffer-regenerate.mjs');

/** 临时 scratch：`/tmp/<base>/scratch` 深度 ≥3，不会被「浅目录=受保护祖先」规则误伤 */
function makeScratch() {
  const base = mkdtempSync(join(tmpdir(), 'pv-regen-test-'));
  return { base, scratch: join(base, 'scratch') };
}

function runCli(args, { scratch, env = {} } = {}) {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: desktopRoot,
    encoding: 'utf8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(scratch ? { PV_REGEN_SCRATCH: scratch } : {}), ...env }
  });
}

function runCliFailure(args, options = {}) {
  try {
    runCli(args, options);
  } catch (error) {
    return error;
  }
  return null;
}

/** 一条"真实跑出来"的基线返回（数值来自实测，见 scratch/pv-t2-real/<runDir>/report.json） */
function baselineResult(overrides = {}) {
  return {
    ok: true,
    parts: 90,
    loadedParts: 90,
    coloredParts: 90,
    envelope: [2430, 1690, 2400],
    massKg: 827.27,
    solids: 47,
    volumeMm3: 87216581.9,
    buildMs: 8449,
    warnings: null,
    project: { name: 'PV缓存单塔8位概念验证-180', saved: true },
    // conveyorBom 会合并同名同规格：行数少于件数，qty 合计才是件数
    bom: [
      { name: '侧纵梁', qty: 60 },
      { name: '储位托条', qty: 30 }
    ],
    files: { step: 781970, stl: 1022684, partCount: 90 },
    ...overrides
  };
}

function baselineRecord(overrides = {}) {
  return {
    id: 'PV缓存单塔8位概念验证-180',
    name: 'PV缓存单塔8位概念验证-180',
    process: 'conveyor',
    params: { ...BASELINE.params },
    parts: 90,
    massKg: 827.27,
    envelope: [2430, 1690, 2400],
    hasStep: true,
    hasStl: true,
    partsList: Array.from({ length: 90 }, (_, index) => `part-${index}.stl`),
    ...overrides
  };
}

function baselineScene(overrides = {}) {
  return {
    integrity: { modelPartCount: 90, scenePartCount: 90, complete: true },
    sceneParts: 90,
    bomRows: 90,
    bomQty: 90,
    revision: '3cea3eac-6e78-4589-b420-8ad2e678d503',
    sessionOk: true,
    ...overrides
  };
}

function failingNames(checks) {
  return checks.failed().map((item) => item.name);
}

test('parseArgs：默认就是基线（8 层 / 180mm），非基线可识别，小数/非正整数一律拒绝', () => {
  const options = parseArgs([]);
  assert.equal(options.baseline, true);
  assert.deepEqual(options.params, { ...BASELINE.params });
  assert.equal(options.params.layers, 8);
  assert.equal(options.params.layerPitchMm, 180);
  assert.equal(options.dryRun, false);
  assert.equal(options.timeoutMs, 10 * 60 * 1000);

  assert.equal(parseArgs(['--pitch', '250']).baseline, false);
  assert.equal(parseArgs(['--layers', '16']).baseline, false);
  assert.equal(parseArgs(['--pitch', '180', '--layers', '8']).baseline, true);
  assert.throws(() => parseArgs(['--nope']), /未知选项/);
  assert.throws(() => parseArgs(['--pitch', '0']), /正整数|必须在/);
  assert.throws(() => parseArgs(['--pitch', '2.5']), /正整数/);
  assert.throws(() => parseArgs(['--layers', '8.5']), /正整数/);
  assert.throws(() => parseArgs(['--layers', '1e3']), /正整数/);
  assert.throws(() => parseArgs(['--timeout', '0.5']), /正整数/);
  assert.throws(() => parseArgs(['--timeout', '999']), /1000–3600000/);
  assert.throws(() => parseArgs(['--user-data']), /缺少取值/);
});

test('name 白名单：路径遍历 / 斜杠 / 空格 / 超长 / 非消毒形态全部拒绝', () => {
  assert.equal(validateProjectName('PV缓存单塔8位概念验证-180'), 'PV缓存单塔8位概念验证-180');
  assert.equal(validateProjectName('abc_DEF-123'), 'abc_DEF-123');
  for (const bad of [
    '../../../../tmp/automationcad-pv-buffer-live',
    'a/b',
    'a\\b',
    '缓存 机',
    '..',
    '.',
    '-lead',
    'trail-',
    'nul\u0000byte',
    'x'.repeat(49),
    ''
  ]) {
    assert.throws(() => validateProjectName(bad), /--name/, `应当拒绝 ${JSON.stringify(bad)}`);
  }
  assert.throws(() => parseArgs(['--name', '缓存 机']), /--name/);
});

test('受保护路径：整段比较（含祖先方向），绝不做子串匹配', () => {
  assert.equal(isProtectedUserData('/tmp/automationcad-pv-buffer-live'), true);
  assert.equal(isProtectedUserData('/tmp/automationcad-pv-buffer-live/projects'), true);
  assert.equal(isProtectedUserData('/tmp/automationcad-pv-buffer-iter'), true);
  // 关键回归：`/tmp` 是旧 live 工程的祖先 → 必须拒绝（P1-4 的误杀来源）
  assert.equal(isProtectedUserData('/tmp'), true);
  assert.equal(isProtectedUserData('/'), true);
  assert.equal(isProtectedUserData(resolve('/tmp', '..')), true);
  assert.equal(isProtectedUserData(join(process.env.HOME ?? '/root', '.config', 'AutomationCAD')), true);
  // 子串诱饵不是受保护路径
  assert.equal(isProtectedUserData('/tmp/automationcad-pv-buffer-live2/x/y'), false);
  assert.equal(isProtectedUserData('/root/.hermes/cache/scratch/pv-buffer-regen-abc'), false);
});

test('启动命令把 userData 与端口放进环境变量（否则会写真实 userData、抢 9229）', () => {
  const spec = buildLaunchSpec({ port: 43711, userData: '/tmp/some-user-data' });
  assert.equal(spec.command, 'xvfb-run');
  assert.ok(spec.args.includes('--machine-e2e-host'));
  assert.ok(spec.args.includes('--use-angle=swiftshader'));
  assert.equal(spec.env.AUTOMATIONCAD_E2E_USERDATA, '/tmp/some-user-data');
  assert.equal(spec.env.AUTOMATIONCAD_E2E_CDP_PORT, '43711');

  const noXvfb = buildLaunchSpec({ port: 1, userData: '/tmp/x', hasXvfb: false });
  assert.equal(noXvfb.command, process.execPath);
  assert.ok(noXvfb.args[0].endsWith(join('scripts', 'electron-run.mjs')));
});

test('计划里必须写明「8 层 = 8 储位 ≠ 16 位」，且盘上目录名走 sanitizeId', () => {
  const plan = planSummary(parseArgs([]), {
    userData: '/tmp/u', port: 1, reportPath: '/tmp/r.json', runDir: '/tmp/run'
  });
  assert.equal(plan.expect.slotsFromGeometry, 8);
  assert.equal(plan.expect.claimedSlots, 16);
  assert.equal(plan.expect.slotsAligned, false);
  assert.equal(plan.params.layerPitchMm, 180);
  assert.equal(plan.projectDir, join('projects', sanitizeProjectId(BASELINE.name)));
  assert.equal(sanitizeProjectId('缓存 机'), '缓存-机');
  assert.equal(sanitizeProjectId('../../../../tmp/x'), 'tmp-x');
});

test('bomSummary：按行数 + qty 合计，脏数据不参与求和', () => {
  assert.deepEqual(bomSummary([{ qty: 60 }, { qty: 30 }]), { rows: 2, qty: 90 });
  assert.deepEqual(bomSummary([{ qty: '5' }, { qty: null }, {}]), { rows: 3, qty: 5 });
  assert.deepEqual(bomSummary(null), { rows: 0, qty: 0 });
});

test('基线返回全过（证明断言不是恒假）', () => {
  const checks = createChecks();
  assertBuildFacts(checks, buildFacts(baselineResult()), parseArgs([]));
  assert.deepEqual(failingNames(checks), []);
  assert.ok(checks.items.length >= 10);
});

test('构建结果负例：缺件 / 包络漂了 / 桩几何 / 180 被夹紧 / 没入库 都必须失败', () => {
  const options = parseArgs([]);
  const cases = [
    ['89 件', baselineResult({ parts: 89 }), 'build.parts'],
    ['场景少装', baselineResult({ loadedParts: 89 }), 'build.loadedParts'],
    ['包络回到 250 层距', baselineResult({ envelope: [2430, 1690, 2890] }), 'build.envelopeMm'],
    ['BOM 合计不等于件数', baselineResult({ bom: [{ qty: 89 }] }), 'build.bomQty'],
    ['STEP 是占位桩', baselineResult({ files: { step: 4096, stl: 1022684, partCount: 90 } }), 'build.stepBytes'],
    ['STL 缺失', baselineResult({ files: { step: 781970, stl: 0, partCount: 90 } }), 'build.stlBytes'],
    ['层距被夹（有 warning）', baselineResult({ warnings: ['层距已夹到 250'] }), 'build.noWarnings'],
    ['没入库', baselineResult({ project: { name: 'x', saved: false } }), 'build.savedProject'],
    ['构建失败', baselineResult({ ok: false, code: 'BUILD_FAILED' }), 'build.ok']
  ];
  for (const [label, result, expected] of cases) {
    const checks = createChecks();
    assertBuildFacts(checks, buildFacts(result), options);
    assert.ok(failingNames(checks).includes(expected), `${label} 应当命中 ${expected}，实际 ${failingNames(checks).join(',')}`);
  }
});

test('工程库记录负例：层距/层数/件数/STEP 标记不对都要失败', () => {
  const options = parseArgs([]);
  const cases = [
    ['层距 250', baselineRecord({ params: { ...BASELINE.params, layerPitchMm: 250 } }), 'record.params.layerPitchMm'],
    ['层数 16（拿几何冒充）', baselineRecord({ params: { ...BASELINE.params, layers: 16 } }), 'record.params.layers'],
    ['件数 89', baselineRecord({ parts: 89 }), 'record.parts'],
    ['零件清单 89', baselineRecord({ partsList: ['a.stl'] }), 'record.partsList'],
    ['没 STEP', baselineRecord({ hasStep: false }), 'record.hasStep'],
    ['记录不存在', null, 'record.present']
  ];
  for (const [label, record, expected] of cases) {
    const checks = createChecks();
    assertRecordFacts(checks, record, options);
    assert.ok(failingNames(checks).includes(expected), `${label} 应当命中 ${expected}，实际 ${failingNames(checks).join(',')}`);
  }
});

test('场景完整性负例：90 对 89 / complete=false / BOM 行数不对都要失败', () => {
  const options = parseArgs([]);
  const cases = [
    ['模型 89', baselineScene({ integrity: { modelPartCount: 89, scenePartCount: 89, complete: false } }), 'scene.modelPartCount'],
    ['场景多算', baselineScene({ integrity: { modelPartCount: 90, scenePartCount: 91, complete: false } }), 'scene.scenePartCount'],
    ['视口 89', baselineScene({ sceneParts: 89 }), 'scene.scenePartsExact'],
    ['BOM 89 行', baselineScene({ bomRows: 89 }), 'scene.bomRows'],
    ['没有 revision', baselineScene({ revision: null }), 'scene.revisionPresent']
  ];
  for (const [label, scene, expected] of cases) {
    const checks = createChecks();
    assertSceneFacts(checks, scene, options);
    assert.ok(failingNames(checks).includes(expected), `${label} 应当命中 ${expected}，实际 ${failingNames(checks).join(',')}`);
  }
});

/**
 * 造一份与 `conveyor-assembly.buildBufferStackParts` 同形的**件名表**：
 * 29 件底层线体件 + 每层（第 2..N 层）托条 2 / 托板 1 / 传动辊 2 / 挡停 1 / 层光电 1 +
 * 4 根立柱 + 2 根顶部横梁 + 6 件升降机构。8 层 = 29 + 49 + 12 = **90 件**（与实际机型一致）。
 *
 * 为什么按件名造：盘上 `project.json` 的 `partsList` 只有 `{file,name}`（`electron/projects.ts`
 * 落盘时件号丢了），派生函数认件名兜底——这份表就是「真实的盘上工程」形状。
 */
function stackPartNames(layers) {
  const names = Array.from({ length: 29 }, (_, index) => `底层线体件-${index + 1}`);
  for (let layer = 2; layer <= layers; layer += 1) {
    names.push(
      `第 ${layer} 层托条（左）`,
      `第 ${layer} 层托条（右）`,
      `第 ${layer} 层托板`,
      `第 ${layer} 层传动辊（进）`,
      `第 ${layer} 层传动辊（出）`,
      `第 ${layer} 层挡停板`,
      `第 ${layer} 层到位光电`
    );
  }
  names.push(
    '缓存立柱 1', '缓存立柱 2', '缓存立柱 3', '缓存立柱 4',
    '顶部横梁（前）', '顶部横梁（后）',
    '升降导柱（左）', '升降导柱（右）',
    '升降链条（左）', '升降链条（右）',
    '升降台', '升降减速电机'
  );
  return names;
}

/** 造一个"盘上工程"目录：真 STEP 头 + 47 实体 + 逐件 STL + project.json(partsList) */
function makeProjectFixture(root, overrides = {}) {
  const dir = join(root, sanitizeProjectId(BASELINE.name));
  mkdirSync(join(dir, 'parts'), { recursive: true });
  const { names: nameOverride, ...projectOverrides } = overrides;
  const names = nameOverride ?? stackPartNames(BASELINE.params.layers);
  const partsList = names.map((name, index) => ({
    file: `${String(index + 1).padStart(4, '0')}-part-${index + 1}.stl`,
    name
  }));
  const project = {
    name: BASELINE.name,
    process: 'conveyor',
    params: { ...BASELINE.params },
    parts: 90,
    massKg: 827.27,
    envelope: [2430, 1690, 2400],
    hasStep: true,
    hasStl: true,
    partsList,
    ...projectOverrides
  };
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project, null, 2));
  const step = ['ISO-10303-21;', 'HEADER;', 'ENDSEC;']
    .concat(Array.from({ length: 47 }, (_, i) => `#${i}=MANIFOLD_SOLID_BREP('',#${i + 1});`))
    .concat(Array.from({ length: 264 }, (_, i) => `#${1000 + i}=ADVANCED_FACE('',#1,.T.);`))
    .join('\n')
    .padEnd(BASELINE.minStepBytes + 1024, ' ');
  writeFileSync(join(dir, 'model.step'), step);
  writeFileSync(join(dir, 'model.stl'), 'solid x\n'.padEnd(BASELINE.minStlBytes + 1024, ' '));
  writeFileSync(join(dir, 'session.json'), '{}');
  for (const entry of partsList) {
    writeFileSync(join(dir, 'parts', entry.file), 'solid y\n');
  }
  return dir;
}

test('盘上工程校验：真实形状的产物全过，改一个参数就失败', () => {
  const root = mkdtempSync(join(tmpdir(), 'pv-regen-test-'));
  try {
    const dir = makeProjectFixture(root);
    const good = verifyProjectDir(dir, parseArgs([]));
    assert.deepEqual(failingNames(good.checks), []);
    assert.equal(good.project.params.layerPitchMm, 180);
    // 储位是从这 90 件零件表里数出来的，不是 params.layers 回声
    assert.equal(good.slots.ok, true);
    assert.equal(good.slots.partsCount, 90);
    assert.equal(good.slots.fromGeometry, 8);
    assert.equal(good.slots.claimed, 16);
    assert.equal(good.slots.aligned, false);

    const bad = verifyProjectDir(makeProjectFixture(mkdtempSync(join(tmpdir(), 'pv-regen-test-')), {
      params: { ...BASELINE.params, layerPitchMm: 250 }
    }), parseArgs([]));
    assert.ok(failingNames(bad.checks).includes('disk.params.layerPitchMm'));

    const empty = verifyProjectDir(join(root, 'nope'), parseArgs([]));
    assert.ok(failingNames(empty.checks).includes('disk.projectJson'));
    assert.equal(empty.slots, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 储位派生（P1-3）

const asParts = (names) => names.map((name) => ({ name }));

test('储位派生：8 层 90 件 → 托板 7 层 + 进出料 1 层 = 8 位（与 buffer-tower 口径同形）', () => {
  const names = stackPartNames(8);
  assert.equal(names.length, 90, '件名表必须与真实机型一样是 90 件，否则反例没有意义');

  const slots = slotsFromGeometryParts(asParts(names), { layers: 8 });
  assert.deepEqual(slots.errors, []);
  assert.equal(slots.ok, true);
  assert.equal(slots.trayCount, 7);
  assert.equal(slots.transferLevels, 1);
  assert.equal(slots.levelsFromGeometry, 8);
  assert.equal(slots.slotsPerLevelFromGeometry, 1);
  assert.equal(slots.towersFromGeometry, 1);
  assert.equal(slots.fromGeometry, 8);
  assert.equal(slots.usableStorage, 7);
  assert.equal(slots.claimed, 16);
  assert.equal(slots.aligned, false, '8 位 ≠ 声明 16 位：本脚本不冒充');
  assert.equal(slots.layerTrace.length, 7);
  assert.match(slots.layerTrace[0], /^第 2 层：托板 1\/托条 2\/挡停 1\/光电 1\/辊 2$/);
});

test('储位派生反例①：抹掉一整层塔件 → 派生必须现形（不许恒等于参数）', () => {
  const names = stackPartNames(8);
  const wiped = names.filter((name) => !name.startsWith('第 5 层'));
  assert.equal(wiped.length, 90 - 7, '第 5 层有 7 件（托条2/托板1/辊2/挡停1/光电1）');

  const slots = slotsFromGeometryParts(asParts(wiped), { layers: 8 });
  assert.equal(slots.ok, false);
  assert.equal(slots.levelsFromGeometry, 7, '几何只剩 7 层');
  assert.notEqual(slots.levelsFromGeometry, 8, '旧实现这里是参数回声，永远等于 8');
  // 四个独立件族各自报缺：不是「两边同减 1 互相抵消」
  const missing = slots.errors.filter((error) => /缺第 5 层/.test(error));
  assert.ok(missing.length >= 4, `四族都要点名第 5 层，实际 ${JSON.stringify(slots.errors)}`);
  assert.ok(slots.errors.some((error) => /≠ 参数 8 层/.test(error)), '层数不符必须单独报');
  assert.ok(slots.errors.some((error) => /层传动辊/.test(error)), '滚轮各层不一致也要报');
});

test('储位派生反例②：只抹掉一层的托板（件数少 1）→ 托板族与层数同时现形', () => {
  const names = stackPartNames(8).filter((name) => name !== '第 6 层托板');
  const slots = slotsFromGeometryParts(asParts(names), { layers: 8 });
  assert.equal(slots.ok, false);
  assert.equal(slots.levelsFromGeometry, 7);
  assert.ok(slots.errors.some((error) => /托板 tray-\* 缺第 6 层/.test(error)));
});

test('储位派生反例③：每层件数不对 / 层号越界 / 立柱不足 / 空表 全部 fail-closed', () => {
  // 每层托条少一件
  const shortRail = stackPartNames(8).filter((name) => name !== '第 3 层托条（右）');
  const railSlots = slotsFromGeometryParts(asParts(shortRail), { layers: 8 });
  assert.equal(railSlots.ok, false);
  assert.ok(railSlots.errors.some((error) => /托条 tray-rail-\* 每层应 2 件，第 3 层（1 件）\s+不符/.test(error)));

  // 多出一层（第 9 层的托板），层号越界
  const extra = slotsFromGeometryParts(asParts([...stackPartNames(8), '第 9 层托板']), { layers: 8 });
  assert.equal(extra.ok, false);
  assert.ok(extra.errors.some((error) => /多出第 9 层/.test(error)));

  // 立柱只有 3 根 → 塔数读不出，不许算成 0.75 塔
  const fewColumns = stackPartNames(8).filter((name) => name !== '缓存立柱 4');
  const columnSlots = slotsFromGeometryParts(asParts(fewColumns), { layers: 8 });
  assert.equal(columnSlots.ok, false);
  assert.equal(columnSlots.towersFromGeometry, null);
  assert.equal(columnSlots.fromGeometry, null, '读不出塔数就不许给一个数');
  assert.ok(columnSlots.errors.some((error) => /缓存立柱 3 根/.test(error)));

  // 空零件表 ≠ 0 储位
  const emptySlots = slotsFromGeometryParts([], { layers: 8 });
  assert.equal(emptySlots.ok, false);
  assert.equal(emptySlots.fromGeometry, null);
  assert.ok(emptySlots.errors.some((error) => /零件表为空/.test(error)));

  // 层数参数本身不合法
  assert.equal(slotsFromGeometryParts(asParts(stackPartNames(8)), { layers: 1 }).ok, false);
});

test('储位派生：件号在就认件号（与 buffer-tower-assembly 的 id 判据一致）', () => {
  const byId = [{ id: 'column-fl' }, { id: 'column-fr' }, { id: 'column-bl' }, { id: 'column-br' }];
  for (let layer = 2; layer <= 4; layer += 1) {
    byId.push(
      { id: `tray-${layer}` },
      { id: `tray-rail-${layer}-left` },
      { id: `tray-rail-${layer}-right` },
      { id: `stop-${layer}` },
      { id: `layer-sensor-${layer}` },
      { id: `tray-roller-${layer}-in` },
      { id: `tray-roller-${layer}-out` }
    );
  }
  const slots = slotsFromGeometryParts(byId, { layers: 4 });
  assert.equal(slots.ok, true);
  assert.equal(slots.levelsFromGeometry, 4);
  assert.equal(slots.fromGeometry, 4);

  // 件号坏了但件名在 → 件名兜底（落盘只留件名）
  const byNameOnly = stackPartNames(6).map((name) => ({ id: 'unknown-0001', name }));
  const named = slotsFromGeometryParts(byNameOnly, { layers: 6 });
  assert.equal(named.ok, true);
  assert.equal(named.fromGeometry, 6);

  // 件族表本身就是口子：键与 buffer-tower-assembly 对得上
  assert.deepEqual(PV_SLOT_FAMILIES.map((family) => family.key),
    ['tray', 'trayRail', 'stop', 'layerSensor', 'trayRoller']);
});

test('盘上门禁：整层丢失必须红——件数被别处补齐也躲不过去（唯一能抓住它的检查）', () => {
  const root = mkdtempSync(join(tmpdir(), 'pv-regen-test-'));
  try {
    // 反例 A：真删一层（90 → 83），件数检查与储位检查一起红
    const dirA = makeProjectFixture(mkdtempSync(join(tmpdir(), 'pv-regen-test-')), {
      names: stackPartNames(8).filter((name) => !name.startsWith('第 4 层'))
    });
    const a = verifyProjectDir(dirA, parseArgs([]));
    assert.ok(failingNames(a.checks).includes('disk.slots.derived'));
    assert.ok(failingNames(a.checks).includes('disk.slots.levelsFromGeometry'));
    assert.ok(failingNames(a.checks).includes('disk.partFiles'), '83 个 STL 当然也红');
    // 派生值本身还是个数（7），只是与参数 8 层对不上——门禁靠 levelsFromGeometry 抓
    const detailA = a.checks.items.find((item) => item.name === 'disk.slots.derived')?.detail;
    assert.equal(detailA.levelsFromGeometry, 7);
    assert.equal(detailA.fromGeometry, 7);

    // 反例 B：抹掉第 5 层 7 件、别处补 7 件 → 件数仍是 90、STL 仍 90 个，
    // 件数类检查全绿，只有储位派生能发现「第 5 层没了」。
    const base = stackPartNames(8);
    const patched = [
      ...base.filter((name) => !name.startsWith('第 5 层')),
      ...Array.from({ length: 7 }, () => '底层线体件-1')
    ];
    const dirB = makeProjectFixture(mkdtempSync(join(tmpdir(), 'pv-regen-test-')), { names: patched });
    const b = verifyProjectDir(dirB, parseArgs([]));
    const failedB = failingNames(b.checks);
    assert.equal(b.project.partsList.length, 90);
    assert.equal(failedB.includes('disk.partFiles'), false, '件数检查在这里是瞎的');
    assert.equal(failedB.includes('disk.parts'), false);
    assert.ok(failedB.includes('disk.slots.derived'), `储位派生必须红，实际 ${failedB.join(',')}`);
    assert.ok(failedB.includes('disk.slots.levelsFromGeometry'), '派生层数 7 ≠ 参数 8');
    const detail = b.checks.items.find((item) => item.name === 'disk.slots.derived')?.detail;
    assert.ok(detail.errors.some((error) => /缺第 5 层/.test(error)), JSON.stringify(detail));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('储位回执：dry-run 没有零件表就写 null（不拿参数回声冒充几何），真跑写派生值', () => {
  const dry = slotsNote(null, parseArgs(['--dry-run']));
  assert.equal(dry.slotsFromGeometry, null);
  assert.equal(dry.aligned, null);
  assert.equal(dry.expectedSlotsFromParams, 8);
  assert.equal(dry.claimedSlots, 16);
  assert.equal(dry.source, 'dry-run-no-parts');
  assert.match(dry.text, /8 个储位/);
  assert.match(dry.text, /不从几何派生/);

  const derived = slotsNote(slotsFromGeometryParts(asParts(stackPartNames(8)), { layers: 8 }), parseArgs([]));
  assert.equal(derived.slotsFromGeometry, 8);
  assert.equal(derived.claimedSlots, 16);
  assert.equal(derived.aligned, false);
  assert.equal(derived.source, 'project-parts');
  assert.equal(derived.levelsFromGeometry, 8);
  assert.equal(derived.slotsPerLevelFromGeometry, 1);
  assert.equal(derived.towersFromGeometry, 1);
  assert.match(derived.text, /90 件/);
  assert.match(derived.text, /8 个储位/);
  assert.match(derived.text, /不一致/);
  assert.deepEqual(derived.errors, []);
});

test('--report 只能新建在本轮运行目录内：外部路径 / 已存在文件 / 软链都拒绝', () => {
  const { base, scratch } = makeScratch();
  try {
    mkdirSync(scratch, { recursive: true });
    const owned = mkdtempSync(join(scratch, 'pv-buffer-regen-'));
    const okPath = assertReportTarget(join(owned, 'report.json'), { ownedDir: owned });
    assert.equal(okPath, join(owned, 'report.json'));

    assert.throws(() => assertReportTarget(join(base, 'report.json'), { ownedDir: owned }), /只能写本轮新建运行目录内/);
    assert.throws(() => assertReportTarget('/tmp/automationcad-pv-buffer-live/report.json', { ownedDir: owned }),
      /只能写本轮新建运行目录内/);

    const existing = join(owned, 'exists.json');
    writeFileSync(existing, '{"sentinel":true}');
    assert.throws(() => assertReportTarget(existing, { ownedDir: owned }), /拒绝覆盖/);

    symlinkSync(join(owned, 'target.json'), join(owned, 'link.json'));
    assert.throws(() => assertReportTarget(join(owned, 'link.json'), { ownedDir: owned }), /符号链接/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('--dry-run：每次运行目录与报告都唯一，报告里写明储位不算 16', () => {
  const { base, scratch } = makeScratch();
  try {
    const reports = [];
    for (let round = 0; round < 2; round += 1) {
      const startedAt = Date.now();
      const stdout = runCli(['--dry-run'], { scratch });
      assert.ok(Date.now() - startedAt < 30_000, 'dry-run 不许真起 Electron');
      assert.match(stdout, /PV_REGEN_DRY_RUN ok=true/);
      const reportPath = /report=(\S+)/.exec(stdout)?.[1];
      assert.ok(reportPath, '必须打印报告落点');
      reports.push(reportPath);
      const written = JSON.parse(readFileSync(reportPath, 'utf8'));
      assert.equal(written.dryRun, true);
      assert.equal(written.runDir, dirname(reportPath));
      assert.equal(written.plan.params.layerPitchMm, 180);
      assert.equal(written.plan.expect.slotsFromGeometry, 8);
      assert.equal(written.plan.expect.claimedSlots, 16);
      assert.equal(written.plan.expect.slotsAligned, false);
      assert.match(written.note.text, /8 个储位/);
      // 报告只落在本轮运行目录里，没有别的散落文件
      assert.deepEqual(readdirSync(written.runDir).sort(), ['report.json']);
    }
    assert.notEqual(reports[0], reports[1], '默认报告必须每次唯一');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('userData 负例：受保护目录 / 既有目录 / 软链 / scratch 根 / 根外路径 全部退 2', () => {
  const { base, scratch } = makeScratch();
  try {
    mkdirSync(scratch, { recursive: true });
    mkdirSync(join(scratch, 'existing'));
    symlinkSync(join(scratch, 'target'), join(scratch, 'link'));
    const cases = [
      ['/tmp', /受保护目录/],
      ['/tmp/automationcad-pv-buffer-live', /受保护目录/],
      [join(process.env.HOME ?? '/root', '.config', 'AutomationCAD'), /受保护目录/],
      [scratch, /scratch 根本身/],
      [join(base, 'outside'), /scratch 之外/],
      [join(scratch, 'existing'), /拒绝复用既有/],
      [join(scratch, 'link'), /符号链接/]
    ];
    for (const [dir, pattern] of cases) {
      const failure = runCliFailure(['--dry-run', '--user-data', dir], { scratch });
      assert.ok(failure, `${dir} 必须非零退出`);
      assert.equal(failure.status, 2, `${dir} 应当退 2，实际 ${failure.status}`);
      assert.match(String(failure.stderr), pattern, `${dir} 的报错应当匹配 ${pattern}`);
    }
    // 合法用法：scratch 根内一个尚不存在的新目录（dry-run 不真正创建）
    const stdout = runCli(['--dry-run', '--user-data', join(scratch, 'brand-new')], { scratch });
    assert.match(stdout, /PV_REGEN_DRY_RUN ok=true/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('--report 负例：外部路径 / 受保护目录 退 2，不写任何文件', () => {
  const { base, scratch } = makeScratch();
  try {
    for (const target of [join(base, 'r.json'), '/tmp/automationcad-pv-buffer-live/r.json']) {
      const failure = runCliFailure(['--dry-run', '--report', target], { scratch });
      assert.ok(failure, `${target} 必须非零退出`);
      assert.equal(failure.status, 2);
      assert.match(String(failure.stderr), /--report/);
    }
    assert.equal(readdirSync(base).includes('r.json'), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ownership：只认进程组 / 祖先链 / 精确命令行 token，子串与受保护实例都不命中', () => {
  const root = mkdtempSync(join(tmpdir(), 'pv-regen-proc-'));
  const userData = join(root, 'pv-buffer-regen-abc', 'userdata');
  const proc = (pid, { ppid = 1, pgid = pid, starttime = 500, argv = [] } = {}) => {
    const dir = join(root, String(pid));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stat'),
      `${pid} (electron) S ${ppid} ${pgid} ${pgid} 0 -1 4194560 0 0 0 0 0 0 0 0 0 0 0 0 ${starttime} 0 0\n`);
    writeFileSync(join(dir, 'cmdline'), argv.map((item) => `${item}\0`).join(''));
  };
  try {
    // 2 = 本轮子进程（组 id）
    proc(2, { ppid: 1, pgid: 2, argv: ['/usr/bin/xvfb-run', 'node', 'scripts/electron-run.mjs'] });
    // 3：同组渲染进程，token 精确
    proc(3, { ppid: 2, pgid: 2, argv: ['/x/electron', '.', `--user-data-dir=${userData}`] });
    // 4：父子串诱饵（-OLD），既不同组也不在链上 → 不许命中
    proc(4, { ppid: 1, pgid: 90, argv: ['/x/electron', `--user-data-dir=${userData}-OLD`] });
    // 5：受保护实例，即使组 id 相同也一条都不许返回
    proc(5, { ppid: 2, pgid: 2, argv: ['/x/electron', '--user-data-dir=/tmp/automationcad-pv-buffer-live'] });
    // 6：同组但命令行没有 token（只能靠 group 证据）
    proc(6, { ppid: 2, pgid: 2, argv: ['/x/electron', '.'] });
    // 7：token 精确但启动早于本轮（旧实例 / PID 复用）→ 不许命中
    proc(7, { ppid: 1, pgid: 77, starttime: 100, argv: ['/x/electron', `--user-data-dir=${userData}`] });
    // 8：自己 setsid 的孙进程（pgid 独立，但祖先链到 2）→ tree 证据
    proc(8, { ppid: 6, pgid: 88, argv: ['/x/electron', '--type=gpu-process'] });
    // 10：祖先链到 2 但启动**早于**本轮（pid 复用出来的陌生进程链）→ tree 证据也必须看 starttime
    proc(10, { ppid: 6, pgid: 99, starttime: 100, argv: ['/x/electron', '--type=utility'] });
    proc(9, { ppid: 1, pgid: 9, argv: ['/bin/sleep', '1000'] });

    // 2 是本轮子进程本身（组 leader），也要算进残留集
    assert.deepEqual(
      findOwnedLeftovers(userData, { procRoot: root, pgid: 2, sinceTicks: 400 })
        .map((row) => [row.pid, row.evidence]),
      [[2, 'group'], [3, 'group'], [6, 'group'], [8, 'tree']]
    );
    assert.equal(
      findOwnedLeftovers(userData, { procRoot: root, pgid: 2, sinceTicks: 400 }).some((row) => row.pid === 10),
      false,
      'tree 证据必须受 sinceTicks 约束（复审 N5）'
    );
    // 受保护路径本身永远返回空（不看进程表）
    assert.deepEqual(findOwnedLeftovers('/tmp/automationcad-pv-buffer-live',
      { procRoot: root, pgid: 2, sinceTicks: 400 }), []);

    assert.equal(hasExactUserDataToken([`--user-data-dir=${userData}`], userData), true);
    assert.equal(hasExactUserDataToken(['--user-data-dir', userData], userData), true);
    assert.equal(hasExactUserDataToken([`--user-data-dir=${userData}-OLD`], userData), false);
    assert.equal(hasExactUserDataToken([`--user-data-dir=${userData}/nested`], userData), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('真实进程组清理：SIGTERM 打不到时按证据补 SIGKILL，孙进程也不留', async () => {
  const { base, scratch } = makeScratch();
  const marker = `pv-regen-kill-${process.pid}`;
  let child = null;
  try {
    child = spawn(process.execPath, ['-e',
      "const {spawn}=require('child_process');"
      + `const g=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000) //${marker}'],{stdio:'ignore'});`
      + `console.log('GC='+g.pid);process.on("SIGTERM",()=>{});setInterval(()=>{},1000); //${marker}`
    ], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let grandchild = null;
    child.stdout.on('data', (chunk) => {
      const match = /GC=(\d+)/.exec(String(chunk));
      if (match) grandchild = Number(match[1]);
    });
    const deadline = Date.now() + 5000;
    while (!grandchild && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
    assert.ok(grandchild, '孙进程必须起来');

    const leftovers = await terminateOwned({
      userData: join(scratch, 'pv-buffer-regen-real', 'userdata'),
      pgid: child.pid,
      graceMs: 1500
    });
    assert.deepEqual(leftovers, []);
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    assert.equal(alive(child.pid), false, '子进程必须退出');
    assert.equal(alive(grandchild), false, '孙进程必须退出（忽略 SIGTERM 也要被 SIGKILL）');
  } finally {
    if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已清理 */ } }
    rmSync(base, { recursive: true, force: true });
  }
});

test('回归 N4：清理 API 参数形状错误一律抛错（fail-closed），不许"报告干净"', async () => {
  // 形状闸门：非字符串 / 空串 / 相对路径都不许进清理路径
  assert.equal(assertCleanupUserData('/tmp/some/userdata'), '/tmp/some/userdata');
  for (const bad of [undefined, null, '', '   ', 'relative/dir', './x', { dir: '/tmp/x' }, 42, ['/tmp/x']]) {
    assert.throws(() => assertCleanupUserData(bad), /非空绝对路径/, `应当拒绝 ${JSON.stringify(bad)}`);
    assert.throws(() => findOwnedLeftovers(bad), /非空绝对路径/, `findOwnedLeftovers 应当拒绝 ${JSON.stringify(bad)}`);
  }

  // 复审 N4 的原始复现：`terminateOwned(target, {...})` 少写一层对象。
  // 旧实现返回 []，上层据此把 cleanup.noLeftoverProcess 记成 ok:true，而一个进程都没清。
  await assert.rejects(
    () => terminateOwned('/tmp/pv-regen-n4/userdata', { pgid: 1, procRoot: '/proc' }),
    /非空绝对路径/
  );
  await assert.rejects(
    () => terminateOwned({ userData: { path: '/tmp/pv-regen-n4/userdata' }, pgid: 1 }),
    /非空绝对路径/
  );

  // 受保护路径不抛错：返回空集是正确结论（那些进程明确不属于本轮），保护方向不变。
  assert.deepEqual(findOwnedLeftovers('/tmp'), []);
  assert.deepEqual(findOwnedLeftovers('/tmp/automationcad-pv-buffer-live'), []);
});

test('信号中断：SIGINT 后 supervisor 清理整组并退出 130，标记进程零残留', async () => {
  const { base, scratch } = makeScratch();
  const marker = `pv-regen-signal-${process.pid}`;
  const driverPath = join(base, 'driver.mjs');
  writeFileSync(driverPath, `
import { createSupervisor } from ${JSON.stringify(pathToFileURL(scriptPath).href)};
const [userData, marker] = process.argv.slice(2);
const sup = createSupervisor({ userData, graceMs: 2000 });
sup.start({
  command: process.execPath,
  args: ['-e', "const {spawn}=require('child_process');"
    + "spawn(process.execPath,['-e','setInterval(()=>{},1000) //" + marker + "'],{stdio:'ignore'});"
    + "setInterval(()=>{},1000); //" + marker + ""]
});
console.log('DRIVER_READY child=' + sup.pid);
sup.signalPromise.then(async (signal) => {
  const left = await sup.stop();
  sup.dispose();
  console.log('DRIVER_STOPPED sig=' + signal + ' left=' + left.length);
  process.exit(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
});
setInterval(() => {}, 1000);
`);
  const driver = spawn(process.execPath, [driverPath, join(scratch, 'pv-buffer-regen-sig', 'userdata'), marker],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  driver.stdout.on('data', (chunk) => { out += chunk; });
  driver.stderr.on('data', (chunk) => { out += chunk; });
  const deadline = Date.now() + 5000;
  while (!/DRIVER_READY/.test(out) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
  try {
    assert.match(out, /DRIVER_READY/, `driver 未就绪：${out}`);
    driver.kill('SIGINT');
    const exit = await new Promise((done) => driver.on('exit', (code, signal) => done({ code, signal })));
    await new Promise((done) => setTimeout(done, 200));
    assert.equal(exit.code, 130, `SIGINT 应当退 130，实际 ${JSON.stringify(exit)}`);
    assert.match(out, /DRIVER_STOPPED sig=SIGINT left=0/);
    const holders = readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)).filter((pid) => {
      try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(marker); } catch { return false; }
    });
    assert.deepEqual(holders, [], `信号后仍有残留进程：${holders.join(',')}`);
  } finally {
    try { driver.kill('SIGKILL'); } catch { /* 已退出 */ }
    rmSync(base, { recursive: true, force: true });
  }
});
