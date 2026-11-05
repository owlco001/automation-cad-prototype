// 移载联锁：联动 → 步序 → 生成路径 + 四个握手信号进真逻辑。
//
// 背景（独立审计 bb02b36 的结论）：四个信号只有点位没有逻辑——
// `buildSequenceFromLinkage` 全仓只在测试里被调用，生成出来的是 `steps=0` 的空壳，
// 每扫描把 DO-TRANSFER-DONE / DO-TRANSFER-READY 写 FALSE，I0.0/I0.1 零引用。
// 这组测试守的就是「以后不许再走回去」：步序必须来自联动、握手必须参与判据、
// 老机型（显式 sequence）逐字节不变、空壳必须带告警。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const { generateProject } = await import('../../src/plcgen/generate.ts');
const { buildSequenceFromLinkage, linkageFromConfig } = await import('../../src/plcgen/linkage-program.ts');
const { detectHandshake } = await import('../../src/plcgen/handshake.ts');
const { simulate } = await import('../../src/plcgen/simulate.ts');
const { verifyGenerated } = await import('../../src/plcgen/verify.ts');

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 移载工位样机：两条直线轴（顶升/移载，单点驱动）+ 四个联锁信号 + 最小安全集。
 * 手写而不是从 synth 取，是为了让 PLC 侧的测试不依赖机器层的需求解析：
 * 机器层改了行程/命名，这组测试不该跟着变红。
 */
const transferConfig = (overrides = {}) => ({
  id: 'fx-transfer-handshake',
  name: '移载工位联锁样机',
  version: 1,
  stations: ['移载工位'],
  actuators: [
    {
      id: 'transfer-lift', name: '移载工位顶升台', kind: 'cylinder', station: '移载工位',
      point: 'ST-TRANSFER-LIFT', travelMm: 70, durationMs: 2000
    },
    {
      id: 'transfer-push', name: '移载工位移载台', kind: 'cylinder', station: '移载工位',
      point: 'ST-TRANSFER-PUSH', travelMm: 1140, durationMs: 4200
    }
  ],
  sensors: [
    { point: 'ST-TRANSFER-LIFT-UP', station: '移载工位', part: 'transfer-lift' },
    { point: 'ST-TRANSFER-LIFT-DOWN', station: '移载工位', part: 'transfer-lift' },
    { point: 'DI-TRANSFER-END', station: '移载工位', part: 'transfer-push' },
    { point: 'DI-DOWNSTREAM-ALLOW', station: '移载工位', part: '移载工位' },
    { point: 'ST-TRANSFER-ESTOP', station: '移载工位', part: '急停' },
    { point: 'ST-TRANSFER-DOOR', station: '移载工位', part: '安全门' }
  ],
  ioPoints: [
    { point: 'DO-TRANSFER-READY', name: '移载工位就绪', area: 'output', station: '移载工位', role: '移载就绪' },
    { point: 'DO-TRANSFER-DONE', name: '移载完成', area: 'output', station: '移载工位', role: '移载完成' }
  ],
  ...overrides
});

/** 老机型：显式 sequence（改动前生成的那份 FC_AutoSequence 已存成 golden 文件）。 */
const legacyExplicit = () => ({
  id: 'legacy-explicit',
  name: '旧机型-显式步序',
  version: 2,
  stations: ['上料', '压装'],
  actuators: [
    { id: 'cyl-1', name: '上料气缸', kind: 'cylinder', station: '上料', extendPoint: 'Y0', retractPoint: 'Y1', travelMm: 40, durationMs: 400 },
    { id: 'grip-1', name: '压装夹爪', kind: 'gripper', station: '压装', gripPoint: 'Y2', travelMm: 20, durationMs: 280 }
  ],
  sensors: [
    { point: 'X0', station: '上料', part: 'cyl-1' },
    { point: 'X1', station: '上料', part: 'cyl-1' },
    { point: 'X2', station: '压装', part: 'grip-1' }
  ],
  safety: { emergencyStop: 'X8', safetyDoor: 'X9' },
  sequence: [
    { id: 's1', name: '上料伸出', action: 'set', point: 'Y0', condition: 'X0', timeoutMs: 1200 },
    { id: 's2', name: '压装夹紧', action: 'set', point: 'Y2', condition: 'X2', timeoutMs: 1200 },
    { id: 's3', name: '上料缩回', action: 'set', point: 'Y1', condition: 'X1', timeoutMs: 1200 }
  ]
});

/** 旧机型 B：无显式步序、且执行机构只有伸出/缩回双线圈（生成器不猜方向 → 仍是空骨架）。 */
const legacyEmpty = () => ({
  id: 'legacy-empty',
  name: '旧机型-空步序',
  version: 1,
  stations: ['上料'],
  actuators: [{ id: 'cyl-1', name: '上料气缸', kind: 'cylinder', station: '上料', extendPoint: 'Y0', retractPoint: 'Y1', travelMm: 40, durationMs: 400 }],
  sensors: [{ point: 'X0', station: '上料', part: 'cyl-1' }, { point: 'X1', station: '上料', part: 'cyl-1' }],
  safety: { emergencyStop: 'X2', safetyDoor: 'X3' },
  sequence: []
});

function ok(result, label) {
  assert.equal(result.ok, true, `${label ?? ''} 生成被预检拦截：${JSON.stringify(result.ok ? [] : result.errors)}`);
  return result;
}

const fileOf = (result, path) => {
  const file = result.files.find((candidate) => candidate.path === path);
  assert.ok(file, `缺少文件 ${path}`);
  return file.content;
};

const seqOf = (config) => fileOf(ok(generateProject({ config })), 'src/FC_AutoSequence.st');

test('联动进生成路径：config 无显式 sequence 时用执行机构驱动点位推出步序（不再是空壳）', () => {
  const config = transferConfig();
  const project = ok(generateProject({ config }));
  assert.equal(project.stats.sequenceSource, 'linkage', '步序来源必须是联动推导');
  assert.equal(project.stats.steps, 2, '两条单点驱动轴 → 两步');
  assert.equal(project.stats.sequenceEmpty, false);

  const derived = linkageFromConfig(config);
  assert.deepEqual(derived.usedActuators, ['transfer-lift', 'transfer-push']);
  assert.deepEqual(derived.steps.map((step) => step.sets), [['ST-TRANSFER-LIFT'], ['ST-TRANSFER-PUSH']]);
  // 双传感器只等动作侧那一条，不能拼成「UP AND DOWN」永远等不到的等待
  assert.deepEqual(derived.steps.map((step) => step.waits), [['ST-TRANSFER-LIFT-UP'], ['DI-TRANSFER-END']]);
  // 生成路径用的就是同一个函数（不是另一套实现）
  assert.deepEqual(buildSequenceFromLinkage(derived.linkage, config), derived.steps);

  const st = fileOf(project, 'src/FC_AutoSequence.st');
  assert.match(st, /\n\s+1:\n/);
  assert.match(st, /\n\s+2:\n/);
  assert.doesNotMatch(st, /联调步序为空/);
});

test('握手四信号进逻辑：ALLOW 约束启动、END 置 DONE、READY 按就绪置位、安全不被绕过', () => {
  const st = seqOf(transferConfig());
  const handshake = detectHandshake(transferConfig());
  assert.deepEqual(handshake.signals.slice().sort(), [
    'DI-DOWNSTREAM-ALLOW', 'DI-TRANSFER-END', 'DO-TRANSFER-DONE', 'DO-TRANSFER-READY'
  ]);
  const allow = '"DB_IO".移载工位_通用_传感器';
  const end = '"DB_IO".移载工位_移载工位移载台_到位';
  const ready = '"DB_IO".移载工位_通用_移载就绪';
  const done = '"DB_IO".移载工位_通用_移载完成';

  // ① 启动受 ALLOW 约束
  assert.match(st, new RegExp(`IF _StartEdge\\.Q AND NOT SafeStop AND NOT Abort AND ${escapeRe(allow)} THEN`));
  assert.match(st, new RegExp(`_StartInhibit := NOT ${escapeRe(allow)};`));
  // ② END 到位才置 DONE：最后一步的转移条件带 END，STEP_HANDSHAKE 里再过一次
  assert.match(st, new RegExp(`IF ${escapeRe(end)} THEN\\n\\s+StepNo := STEP_HANDSHAKE;`));
  assert.match(st, new RegExp(`STEP_HANDSHAKE:[\\s\\S]*?IF ${escapeRe(end)} THEN\\n\\s+_HandshakeDone := TRUE;`));
  assert.match(st, new RegExp(`${escapeRe(done)} := _HandshakeDone;`));
  // ③ READY 在待机且无报警时置位，且写在 END_CASE 之后（不被 IDLE 的复位写覆盖）
  const readyLine = `${ready} := NOT SafeStop AND NOT SeqTimeout AND (AlarmWord = 16#0000) AND (StepNo = STEP_IDLE);`;
  assert.ok(st.includes(readyLine), `READY 判据不对：\n${st}`);
  assert.ok(st.indexOf('END_CASE;') < st.indexOf(readyLine), 'READY 必须写在 CASE 之后');
  // ④ 急停/安全门：SafeStop 同周期清握手并复位输出（安全块仍在最后执行）
  assert.match(st, /IF _AbortEdge\.Q OR SafeStop THEN[\s\S]*?_HandshakeDone := FALSE;/);
  const safety = fileOf(ok(generateProject({ config: transferConfig() })), 'src/FC_Safety.st');
  assert.match(safety, new RegExp(`IF SafeStop THEN[\\s\\S]*?${escapeRe(ready)} := FALSE;`));
  assert.match(safety, new RegExp(`IF SafeStop THEN[\\s\\S]*?${escapeRe(done)} := FALSE;`));
  assert.match(safety, /SafetyHealthy := "DB_IO"\.移载工位_通用_急停 AND "DB_IO"\.移载工位_通用_安全门;/);
});

test('mapping.json 带握手追溯块：四个信号的点位/地址/变量/驱动判据都在', () => {
  const project = ok(generateProject({ config: transferConfig() }));
  const mapping = JSON.parse(fileOf(project, 'mapping.json'));
  assert.equal(mapping.handshake.station, '移载工位');
  const byPoint = new Map(mapping.handshake.signals.map((signal) => [signal.point, signal]));
  for (const point of ['DO-TRANSFER-READY', 'DO-TRANSFER-DONE', 'DI-DOWNSTREAM-ALLOW', 'DI-TRANSFER-END']) {
    assert.ok(byPoint.has(point), `mapping.handshake 缺 ${point}`);
    const signal = byPoint.get(point);
    assert.match(signal.address, /^[IQ]\d+\.\d+$/);
    assert.ok(signal.variable.length > 0 && signal.ref.startsWith('"DB_IO".'));
    assert.ok(signal.driver.length > 0, `${point} 没有写驱动判据`);
  }
  // 握手信号不是步序输出，不该被错记成「某步置位」
  assert.deepEqual(byPoint.get('DO-TRANSFER-DONE').steps ?? [], []);
});

test('旧机型：显式 sequence 的 11 个文件 sha256 与改动前完全一致（逐字节不变）', () => {
  const project = ok(generateProject({ config: legacyExplicit() }));
  const golden = {
    'src/OB1_Main.st': 'be6e56e54087f922305f2d3885130ddd3f6ee8597bd263cd7d3f12d717b9f292',
    'src/DB_IO.st': '3eba5bfe62b563f0d8bfeedf692ca505eb4364a834e0b173ce737283aae22282',
    'src/FB_Cylinder.st': '3b1095ddd5f9e24270da1b7223b9552b4681df5c12b910d5a1e5af11f5166957',
    'src/FB_Gripper.st': '08d26cc45091e56f77a795c829409e95d70766a039e740cc3ca0f1f3a6fce286',
    'src/FB_RotaryAxis.st': '5af1c1681e0fd867d9b52bd6ca5b50794e4f0b0e53cc93eee91d72034e6baad4',
    'src/FC_AutoSequence.st': '1482962efec1697bdd8ff119f849f50540fcd5c01aae7fb7e950dbf06c1bcaef',
    'src/FC_Alarms.st': '69ec190faeac6b0e86871bea1788f6817b8e1ede6ca02b3584ed9622d1dcec6f',
    'src/FC_Safety.st': 'b90ccf38c1d0c292961502a42593aaf3785f8924fae0d6593cb4899dcd7594cc',
    'io-tags.csv': '8ef041581e46ba9ac6fd89012d8029a2b9fa6e8ffb0e01d7f54e5a092d5a73d3',
    'mapping.json': 'f4bcac8067b9966e6abaa41b3a57453dba8ae97e4d312a590b1ac84b62ba0bb3',
    'README.md': 'a75c2b1d4d60aa4644fcf4c0e32dc087ede5239c6d9061d4ee32ae4f8d3f51e8'
  };
  assert.deepEqual(project.stats.hashes, golden);
  assert.equal(project.stats.sequenceSource, 'explicit');
  assert.deepEqual(project.stats.handshakeSignals, [], '老机型没有握手信号，不该生成握手逻辑');

  // 不只比哈希：FC_AutoSequence 与本轮改动前存下的文件逐字节相同
  const goldenFile = readFileSync(join(here, 'fixtures', 'legacy-explicit-FC_AutoSequence.st'), 'utf8');
  assert.equal(fileOf(project, 'src/FC_AutoSequence.st'), goldenFile);
});

test('旧机型：无步序且执行机构只有双线圈时，文本仍与改动前一致，但必须给出「为什么空」的告警', () => {
  const project = ok(generateProject({ config: legacyEmpty() }));
  assert.equal(project.stats.steps, 0);
  assert.equal(project.stats.sequenceSource, 'none');
  // 状态机正文没变（少一个 README 警告行，ST 一个字节都不许动）
  assert.match(fileOf(project, 'src/FC_AutoSequence.st'), /联调步序为空：未生成转移动画分支/);
  assert.doesNotMatch(fileOf(project, 'src/FC_AutoSequence.st'), /_HandshakeDone|_StartEdge/);

  // 「空壳不得静默」：有执行机构却没生成步序，必须点名是哪个机构、为什么
  const codes = project.warnings.map((warning) => warning.code);
  assert.ok(codes.includes('SEQUENCE_EMPTY'), '仍要保留 SEQUENCE_EMPTY');
  assert.ok(codes.includes('SEQUENCE_NOT_DERIVABLE'), '有执行机构却 0 步必须单独告警');
  const warning = project.warnings.find((item) => item.code === 'SEQUENCE_NOT_DERIVABLE');
  assert.match(warning.message, /上料气缸\(cyl-1\)/);
  assert.match(warning.message, /extendPoint\/retractPoint/);
  assert.match(fileOf(project, 'README.md'), /SEQUENCE_NOT_DERIVABLE/);
});

test('没有执行机构也没有步序：只能报 SEQUENCE_EMPTY，不误报「不可推导」', () => {
  const project = ok(generateProject({
    config: {
      id: 'fx-empty', name: '空机型', stations: ['上料'],
      actuators: [], sensors: [], safety: { emergencyStop: 'X0', safetyDoor: 'X1' }
    }
  }));
  assert.equal(project.stats.steps, 0);
  const codes = project.warnings.map((warning) => warning.code);
  assert.ok(codes.includes('SEQUENCE_EMPTY'));
  assert.ok(!codes.includes('SEQUENCE_NOT_DERIVABLE'));
});

// ---------------------------------------------------------------------------
// 三个场景（+1 个负向对照）：用生成出来的程序跑 plcgen 自带仿真器
// ---------------------------------------------------------------------------

const simConfig = () => transferConfig();
const simProject = () => ok(generateProject({ config: simConfig() }));

test('场景①：DOWNSTREAM-ALLOW = 0 → 不启动、不动任何输出、DONE 不置位', () => {
  const result = simulate({
    project: simProject(),
    config: simConfig(),
    inputs: { 'DI-DOWNSTREAM-ALLOW': false }
  });
  assert.equal(result.ok, false);
  assert.equal(result.elapsedMs, 0, '一步都没走');
  assert.equal(result.handshake.startPermitted, false);
  assert.equal(result.handshake.startBlockedBy, 'DI-DOWNSTREAM-ALLOW');
  assert.equal(result.handshake.done, false);
  assert.ok(result.steps.every((step) => step.ok === false), '全部步序应被拦下');
  assert.match(result.alarms[0], /^START_INHIBIT:DI-DOWNSTREAM-ALLOW/);
  for (const point of ['DO-TRANSFER-DONE', 'ST-TRANSFER-LIFT', 'ST-TRANSFER-PUSH']) {
    assert.equal(result.finalOutputs[point], false, `${point} 不得动作`);
  }
  // READY 不受 ALLOW 影响：ready = 「我能接」，allow = 「你可以给」
  assert.equal(result.finalOutputs['DO-TRANSFER-READY'], true);
});

test('场景②：ALLOW = 1 且 END 到位 → 两步都过、DONE 置位', () => {
  const result = simulate({
    project: simProject(),
    config: simConfig(),
    inputs: { 'DI-DOWNSTREAM-ALLOW': true }
  });
  assert.equal(result.ok, true, JSON.stringify(result.alarms));
  assert.deepEqual(result.alarms, []);
  assert.equal(result.steps.length, 2);
  assert.ok(result.steps.every((step) => step.ok));
  assert.equal(result.handshake.startPermitted, true);
  assert.equal(result.handshake.done, true);
  assert.equal(result.finalOutputs['DO-TRANSFER-DONE'], true);
  assert.equal(result.finalOutputs['DO-TRANSFER-READY'], true);
  // 移载台那一步等的是 DI-TRANSFER-END（到位后才算完成）
  assert.ok(result.steps[1].waitedMs >= 4200, `第二步应等满移载时间，实际 ${result.steps[1].waitedMs}`);
});

test('场景③：运行中急停 → 全部输出复位、DONE 不锁存、后续步跳过', () => {
  const result = simulate({
    project: simProject(),
    config: simConfig(),
    inputs: { 'DI-DOWNSTREAM-ALLOW': true },
    safetyTripAtStep: 2
  });
  assert.equal(result.ok, false);
  assert.match(result.alarms[0], /^SAFE_STOP:/);
  assert.equal(result.handshake.done, false);
  assert.equal(result.handshake.ready, false);
  for (const [point, value] of Object.entries(result.finalOutputs)) {
    assert.equal(value, false, `急停后 ${point} 必须为 FALSE`);
  }
  assert.equal(result.steps.length, 2, `急停后不应再产生新步，实际 ${result.steps.length}`);
  assert.equal(result.steps[1].ok, false);
  assert.match(result.steps[1].reason, /安全触发/);
});

test('负向对照：ALLOW = 1 但 END 始终不到 → 最后一步超时，DONE 不置位（不是「跑完就算完成」）', () => {
  const result = simulate({
    project: simProject(),
    config: simConfig(),
    inputs: { 'DI-DOWNSTREAM-ALLOW': true, 'DI-TRANSFER-END': false }
  });
  assert.equal(result.ok, false);
  assert.equal(result.handshake.done, false);
  assert.equal(result.finalOutputs['DO-TRANSFER-DONE'], false);
  assert.match(result.alarms[0], /^SEQ_TIMEOUT:第 2 步/);
});

test('确定性：同一输入两次生成 11 个文件逐字节一致（握手块也不例外）', () => {
  const first = ok(generateProject({ config: transferConfig() }));
  const second = ok(generateProject({ config: transferConfig() }));
  assert.deepEqual(first.files.map((file) => file.path), second.files.map((file) => file.path));
  for (const [index, file] of first.files.entries()) {
    assert.equal(file.content, second.files[index].content, `${file.path} 两次生成不一致`);
  }
});

test('握手信号只有一半时如实告警，其余照常生成（不静默假装完整）', () => {
  // 只保留 READY 输出，并把 ALLOW / END 两条输入一起拿掉 → 三环都缺
  const config = transferConfig({
    ioPoints: [
      { point: 'DO-TRANSFER-READY', name: '移载工位就绪', area: 'output', station: '移载工位', role: '移载就绪' }
    ],
    sensors: [
      { point: 'ST-TRANSFER-LIFT-UP', station: '移载工位', part: 'transfer-lift' },
      { point: 'ST-TRANSFER-LIFT-DOWN', station: '移载工位', part: 'transfer-lift' },
      { point: 'ST-TRANSFER-PUSH-END', station: '移载工位', part: 'transfer-push' },
      { point: 'ST-TRANSFER-ESTOP', station: '移载工位', part: '急停' },
      { point: 'ST-TRANSFER-DOOR', station: '移载工位', part: '安全门' }
    ]
  });
  const project = ok(generateProject({ config }));
  const codes = project.warnings.map((warning) => warning.code);
  assert.ok(codes.includes('HANDSHAKE_PARTIAL'), `缺 DONE/ALLOW/END 必须告警：${codes.join(',')}`);
  const warning = project.warnings.find((item) => item.code === 'HANDSHAKE_PARTIAL');
  assert.match(warning.message, /DO-\*-DONE/);
  assert.match(warning.message, /DI-\*-ALLOW/);
  assert.match(warning.message, /DI-\*-END/);

  const st = fileOf(project, 'src/FC_AutoSequence.st');
  // 只有 READY：不许凭空捏出 DONE 锁存/握手状态，也不许假装有 ALLOW 门
  assert.doesNotMatch(st, /STEP_HANDSHAKE/);
  assert.doesNotMatch(st, /_HandshakeDone/);
  assert.doesNotMatch(st, /IF _StartEdge\.Q AND NOT SafeStop AND NOT Abort AND/);
  assert.match(st, /移载工位_通用_移载就绪 := NOT SafeStop/);
});

test('verify 基线：下游允许时验证通过；显式注入 ALLOW=0 时验证失败（基线不掩盖互锁）', () => {
  const passed = verifyGenerated(transferConfig());
  assert.equal(passed.ok, true, `验证应通过：${JSON.stringify(passed.errors)}`);
  assert.equal(passed.stage, 'done');
  assert.equal(passed.simulation.handshake.done, true);

  const blocked = verifyGenerated(transferConfig(), { inputs: { 'DI-DOWNSTREAM-ALLOW': false } });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.stage, 'simulate');
  assert.match(blocked.simulation.alarms[0], /^START_INHIBIT:/);
});

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
