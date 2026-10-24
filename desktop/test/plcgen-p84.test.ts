import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlcGenConfig } from '../src/plcgen/types.ts';
import { generateProject, type GenerateProjectSuccess } from '../src/plcgen/generate.ts';
import { simulate, type SimResult } from '../src/plcgen/simulate.ts';
import { summarizeVerification, verifyGenerated } from '../src/plcgen/verify.ts';
import { AgentTools } from '../src/agent/tools.ts';
import { READ_ONLY_TOOLS, planTool } from '../src/agent/router.ts';
import { createAgentCommandBus } from '../src/agent/commands.ts';

function makeConfig(overrides: Record<string, unknown> = {}): PlcGenConfig {
  return {
    id: 'p84-machine',
    name: 'P8-4 测试机型',
    stations: ['上料', '压装'],
    actuators: [
      {
        id: 'cyl-1', name: '上料气缸', kind: 'cylinder', station: '上料',
        extendPoint: 'Y0', retractPoint: 'Y6', travelMm: 40, durationMs: 400
      },
      {
        id: 'cyl-2', name: '压装气缸', kind: 'cylinder', station: '压装',
        extendPoint: 'Y2', retractPoint: 'Y7', travelMm: 30, durationMs: 400
      },
      {
        id: 'cyl-3', name: '锁付气缸', kind: 'cylinder', station: '压装',
        extendPoint: 'Y4', retractPoint: 'Y8', travelMm: 20, durationMs: 400
      },
      {
        id: 'grip-1', name: '上料夹爪', kind: 'gripper', station: '上料',
        gripPoint: 'Y1', durationMs: 280
      },
      {
        id: 'grip-2', name: '压装夹爪', kind: 'gripper', station: '压装',
        gripPoint: 'Y3', durationMs: 280
      },
      {
        id: 'grip-3', name: '下料夹爪', kind: 'gripper', station: '压装',
        gripPoint: 'Y5', durationMs: 280
      }
    ],
    sensors: [
      { point: 'X0', station: '上料', part: 'cyl-1' },
      { point: 'X1', station: '上料', part: 'cyl-1' },
      { point: 'X2', station: '压装', part: 'cyl-2' },
      { point: 'X3', station: '压装', part: 'cyl-2' },
      { point: 'X4', station: '压装', part: 'cyl-3' },
      { point: 'X5', station: '压装', part: 'cyl-3' },
      { point: 'X6', station: '上料', part: 'grip-1' },
      { point: 'X7', station: '压装', part: 'grip-2' },
      { point: 'X8', station: '压装', part: 'grip-3' }
    ],
    safety: { emergencyStop: 'X9', safetyDoor: 'X10' },
    sequence: [
      { id: 's1', name: '上料伸出', action: 'set', point: 'Y0', condition: 'X0', timeoutMs: 1000 },
      { id: 's2', name: '上料夹紧', action: 'set', point: 'Y1', condition: 'X6', timeoutMs: 1000 },
      { id: 's3', name: '压装伸出', action: 'set', point: 'Y2', condition: 'X2', timeoutMs: 1000 },
      { id: 's4', name: '压装夹紧', action: 'set', point: 'Y3', condition: 'X7', timeoutMs: 1000 },
      { id: 's5', name: '锁付伸出', action: 'set', point: 'Y4', condition: 'X4', timeoutMs: 1000 },
      { id: 's6', name: '下料夹紧', action: 'set', point: 'Y5', condition: 'X8', timeoutMs: 1000 }
    ],
    ...overrides
  } as PlcGenConfig;
}

function generated(config: PlcGenConfig): GenerateProjectSuccess {
  const result = generateProject({ config });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('生成被预检拦截');
  return result;
}

function run(config: PlcGenConfig, options: Record<string, unknown> = {}): SimResult {
  return simulate({ project: generated(config), config, ...options });
}

test('P8-4 正常：6 步全部按行程到位并回传最终输出', () => {
  const result = run(makeConfig());
  assert.equal(result.ok, true);
  assert.equal(result.steps.length, 6);
  assert.deepEqual(result.steps.map((step) => step.ok), [true, true, true, true, true, true]);
  assert.deepEqual(result.steps.map((step) => step.waitedMs), [400, 280, 400, 280, 400, 280]);
  assert.deepEqual(result.alarms, []);
  assert.equal(result.elapsedMs, 2040);
  assert.equal(result.finalOutputs.Y0, true);
  assert.equal(result.finalOutputs.Y5, true);
  assert.equal(result.finalOutputs.Y6, false);
});

test('P8-4 正常：每步 actions 记录输出、启动与到位', () => {
  const result = run(makeConfig());
  const first = result.steps[0];
  assert.ok(first);
  assert.deepEqual(first.actions, ['Y0 := TRUE', '启动 上料气缸 → 伸出（400 ms）', '到位 X0 := TRUE']);
});

test('P8-4 超时：第 3 步按生成 TimeoutTime 失败并给出原因', () => {
  const config = makeConfig({
    sequence: [
      { name: '上料伸出', action: 'set', point: 'Y0', condition: 'X0', timeoutMs: 1000 },
      { name: '上料夹紧', action: 'set', point: 'Y1', condition: 'X6', timeoutMs: 1000 },
      { name: '压装伸出', action: 'set', point: 'Y2', condition: 'X1', timeoutMs: 50 },
      { name: '压装夹紧', action: 'set', point: 'Y3', condition: 'X7', timeoutMs: 1000 }
    ]
  });
  const result = run(config);
  assert.equal(result.ok, false);
  const third = result.steps.find((step) => step.stepNo === 3);
  assert.ok(third);
  assert.equal(third.ok, false);
  assert.equal(third.waitedMs, 50);
  assert.match(third.reason ?? '', /第 3 步「压装伸出」超时/);
  assert.match(third.reason ?? '', /50 ms/);
  assert.ok(result.steps.slice(3).every((step) => step.ok === false && /超时/.test(step.reason ?? '')));
  assert.ok(result.alarms.some((alarm) => alarm.startsWith('SEQ_TIMEOUT:')));
  assert.ok(Object.values(result.finalOutputs).every((value) => value === false));
});

test('P8-4 超时：未到位的传感器不会被误判', () => {
  const config = makeConfig({
    sequence: [{ name: '短超时', action: 'set', point: 'Y0', condition: 'X0', timeoutMs: 100 }]
  });
  const result = run(config);
  assert.equal(result.ok, false);
  assert.equal(result.steps[0]?.waitedMs, 100);
  assert.match(result.steps[0]?.reason ?? '', /100 ms/);
});

test('P8-4 安全：注入急停立即 SafeStop，后续步全部跳过且只记一条报警', () => {
  const result = run(makeConfig(), { safetyTripAtStep: 2, safetyTripPoint: 'X9' });
  assert.equal(result.ok, false);
  assert.equal(result.alarms.length, 1);
  assert.match(result.alarms[0] ?? '', /^SAFE_STOP:/);
  assert.match(result.alarms[0] ?? '', /X9/);
  assert.equal(result.steps[0]?.ok, true);
  assert.equal(result.steps[1]?.ok, false);
  assert.match(result.steps[1]?.reason ?? '', /SafeStop/);
  assert.deepEqual(result.steps.slice(2).map((step) => step.ok), [false, false, false, false]);
  assert.ok(result.steps.slice(2).every((step) => step.reason === '安全停止后跳过'));
  assert.ok(Object.values(result.finalOutputs).every((value) => value === false));
});

test('P8-4 安全：安全门触发同样 SafeStop 并标明点位', () => {
  const result = run(makeConfig(), { safetyTripAtStep: 1, safetyTripPoint: 'X10' });
  assert.equal(result.alarms.length, 1);
  assert.match(result.alarms[0] ?? '', /X10/);
  assert.equal(result.steps.length, 6);
  assert.equal(result.steps[0]?.ok, false);
  assert.equal(result.elapsedMs, 0);
});

test('P8-4 安全：步序显式断开安全输入也立即中止', () => {
  const config = makeConfig({
    sequence: [
      { name: '上料伸出', action: 'set', point: 'Y0', condition: 'X0', timeoutMs: 1000 },
      { name: '误断急停', action: 'reset', point: 'X9' }
    ]
  });
  const result = run(config);
  assert.equal(result.ok, false);
  assert.equal(result.alarms.length, 1);
  assert.match(result.alarms[0] ?? '', /SAFE_STOP:/);
  assert.equal(result.steps[1]?.ok, false);
  assert.match(result.steps[1]?.reason ?? '', /SafeStop/);
});

test('P8-4 传感器矛盾：双到位同时为 1 记一条报警且整体失败', () => {
  const result = run(makeConfig(), { sensorConflictAtStep: 2, sensorConflictActuator: 'cyl-1' });
  assert.equal(result.ok, false);
  assert.equal(result.alarms.length, 1);
  assert.match(result.alarms[0] ?? '', /^SENSOR_CONFLICT:/);
  assert.match(result.alarms[0] ?? '', /cyl-1/);
  assert.equal(result.steps[0]?.ok, true);
  assert.equal(result.steps[1]?.ok, true);
});

test('P8-4 传感器矛盾：同时置位伸出/缩回输出会形成双到位报警', () => {
  const config = makeConfig({
    sequence: [
      { name: '同时动作', action: 'set', setPoints: ['Y0', 'Y6'], condition: 'X0 AND X1', timeoutMs: 1000 }
    ]
  });
  const result = run(config);
  assert.equal(result.ok, false);
  assert.equal(result.alarms.length, 1);
  assert.match(result.alarms[0] ?? '', /^SENSOR_CONFLICT:/);
});

test('P8-4 timeScale：2 倍加速使等待与总耗时减半', () => {
  const normal = run(makeConfig());
  const fast = run(makeConfig(), { timeScale: 2 });
  assert.equal(normal.ok, true);
  assert.equal(fast.ok, true);
  assert.equal(fast.steps[0]?.waitedMs, 200);
  assert.equal(fast.steps[1]?.waitedMs, 140);
  assert.equal(fast.elapsedMs, normal.elapsedMs / 2);
});

test('P8-4 timeScale：非法值回落到默认 1', () => {
  const result = run(makeConfig(), { timeScale: 0 });
  assert.equal(result.steps[0]?.waitedMs, 400);
  assert.equal(result.elapsedMs, 2040);
});

test('P8-4 空序列：模拟与验证显式失败，摘要不显示通过', () => {
  const config = makeConfig({ sequence: [] });
  const project = generated(config);
  assert.equal(project.stats.sequenceEmpty, true);
  const simulation = simulate({ project, config });
  assert.equal(simulation.ok, false);
  assert.deepEqual(simulation.steps, []);
  assert.deepEqual(simulation.alarms, ['EMPTY_SEQUENCE:联调步序为空，无法进行模拟验证']);
  assert.equal(simulation.elapsedMs, 0);
  assert.ok(Object.values(simulation.finalOutputs).every((value) => value === false));

  const result = verifyGenerated(config);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'precheck');
  assert.equal(result.simulation, undefined);
  assert.ok(result.precheck.errors.some((error) => error.code === 'SEQUENCE_EMPTY'));
  assert.ok(result.errors.some((error) => error.code === 'SEQUENCE_EMPTY'));
  const summary = summarizeVerification(result);
  assert.equal(summary.ok, false);
  assert.equal(summary.steps, 0);
  assert.equal(summary.passed, 0);
  assert.equal(summary.failure, undefined);
  assert.equal(summary.precheckErrors, 1);

  const providedProjectResult = verifyGenerated(project, makeConfig());
  assert.equal(providedProjectResult.ok, false);
  assert.equal(providedProjectResult.stage, 'simulate');
  assert.ok(providedProjectResult.errors.some((error) => error.code === 'SEQUENCE_EMPTY'));

  const emptyConfigWithOldProject = verifyGenerated(generated(makeConfig()), config);
  assert.equal(emptyConfigWithOldProject.ok, false);
  assert.equal(emptyConfigWithOldProject.stage, 'precheck');
  assert.ok(emptyConfigWithOldProject.errors.some((error) => error.code === 'SEQUENCE_EMPTY'));
});

test('P8-4 校验：mapping.json 缺失 sequence 时明确失败', () => {
  const config = makeConfig();
  const project = generated(config);
  const mappingFile = project.files.find((file) => file.path === 'mapping.json');
  assert.ok(mappingFile);
  const mapping = JSON.parse(mappingFile.content) as Record<string, unknown>;
  delete mapping.sequence;
  const malformedProject = {
    files: project.files.map((file) => file.path === 'mapping.json'
      ? { ...file, content: JSON.stringify(mapping) }
      : file)
  };

  const result = verifyGenerated(malformedProject, config);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'simulate');
  assert.ok(result.simulation?.alarms.some((alarm) => alarm.includes('mapping.json.sequence')));
  assert.ok(result.errors.some((error) => error.code === 'SEQUENCE_MISSING'));
  const summary = summarizeVerification(result);
  assert.equal(summary.ok, false);
  assert.equal(summary.steps, 0);
  assert.equal(summary.passed, 0);
});

test('P8-4 确定性：同一输入重复模拟结果完全一致', () => {
  const config = makeConfig();
  const project = generated(config);
  const first = simulate({ project, config });
  const second = simulate({ project, config });
  assert.deepEqual(first, second);
});

test('P8-4 确定性：timeScale 不影响 finalOutputs 与报警口径', () => {
  const config = makeConfig();
  const normal = simulate({ project: generated(config), config });
  const fast = simulate({ project: generated(config), config, timeScale: 4 });
  assert.deepEqual(normal.finalOutputs, fast.finalOutputs);
  assert.deepEqual(normal.alarms, fast.alarms);
});

test('P8-4 校验：预检 error 直接失败且不生成/不模拟', () => {
  const config = makeConfig({ safety: undefined });
  const result = verifyGenerated(config);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'precheck');
  assert.equal(result.simulation, undefined);
  assert.equal(result.stats, undefined);
  assert.ok(result.errors.some((error) => error.code === 'ESTOP_UNDEFINED'));
  assert.ok(result.errors.some((error) => error.code === 'SAFETY_DOOR_UNDEFINED'));
});

test('P8-4 校验：正常机型生成 11 文件并返回 6 步通过摘要', () => {
  const config = makeConfig();
  const result = verifyGenerated(config);
  assert.equal(result.ok, true);
  assert.equal(result.stage, 'done');
  assert.equal(result.stats?.files, 11);
  assert.equal(result.simulation?.steps.length, 6);
  assert.equal(result.simulation?.alarms.length, 0);
  const summary = summarizeVerification(result);
  assert.equal(summary.ok, true);
  assert.equal(summary.steps, 6);
  assert.equal(summary.passed, 6);
  assert.equal(summary.failure, undefined);
  assert.equal(summary.precheckErrors, 0);
});

test('P8-4 校验：模拟失败时摘要给出失败步与原因', () => {
  const config = makeConfig();
  config.sequence = [
    { name: '上料伸出', action: 'set', point: 'Y0', condition: 'X0', timeoutMs: 1000 },
    { name: '上料夹紧', action: 'set', point: 'Y1', condition: 'X6', timeoutMs: 1000 },
    { name: '压装伸出', action: 'set', point: 'Y2', condition: 'X1', timeoutMs: 60 }
  ];
  const result = verifyGenerated(config);
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'simulate');
  const summary = summarizeVerification(result);
  assert.equal(summary.ok, false);
  assert.equal(summary.failure?.stepNo, 3);
  assert.match(summary.failure?.reason ?? '', /60 ms/);
});

test('P8-4 校验：支持直接验证已有生成工程（project, config）', () => {
  const config = makeConfig();
  const project = generated(config);
  const result = verifyGenerated(project, config);
  assert.equal(result.ok, true);
  assert.equal(result.stage, 'done');
  assert.equal(result.simulation?.steps.length, 6);
});

test('P8-4 工具：verify_plc_program 已注册为只读且能直接返回摘要', async () => {
  assert.ok(READ_ONLY_TOOLS.has('verify_plc_program'));
  const tools = new AgentTools({} as never);
  assert.equal(tools.list().length, 21);
  assert.ok(tools.has('verify_plc_program'));
  const summary = await tools.call('verify_plc_program', { config: makeConfig() }) as {
    ok: boolean;
    steps: number;
    passed: number;
    alarms: string[];
  };
  assert.equal(summary.ok, true);
  assert.equal(summary.steps, 6);
  assert.equal(summary.passed, 6);
  assert.deepEqual(summary.alarms, []);
});

test('P8-4 工具：路由能识别模拟验证且不进入写通道', () => {
  const plan = planTool('模拟验证一下 PLC 程序');
  assert.equal(plan?.tool, 'verify_plc_program');
  assert.equal(plan?.readOnly, true);
});

test('P8-4 命令：未显式传 config 时从渲染桥读取当前机型', async () => {
  const calls: string[] = [];
  const bridge = {
    async call<T>(method: string): Promise<T> {
      calls.push(method);
      return makeConfig() as T;
    }
  };
  const bus = createAgentCommandBus({} as never, bridge);
  const result = await bus.execute('verify_plc_program', {});
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['getPlcGenConfig']);
  const summary = result.data as { steps: number; passed: number; alarms: string[] };
  assert.equal(summary.steps, 6);
  assert.equal(summary.passed, 6);
  assert.deepEqual(summary.alarms, []);
});
