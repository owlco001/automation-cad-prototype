import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AgentTools } from '../../src/agent/tools.ts';
import { createAgentCommandBus } from '../../src/agent/commands.ts';
import { READ_ONLY_TOOLS, WRITE_TOOLS } from '../../src/agent/router.ts';
import { MODEL_BUILDERS, pickModelBuilder } from '../../src/machine/model-builders.ts';

const registry = { listParts: () => [] };

function setup() {
  const calls = [];
  const bridge = {
    calls,
    async call(method, args) {
      calls.push({ method, args });
      if (method !== 'buildMachineModel') return { ok: false, message: `unexpected ${method}` };
      const payload = args?.[0] ?? {};
      if (payload.process === 'screw') {
        return { ok: false, code: 'NO_PARAMETRIC_BUILDER', message: '「screw」暂无参数化整机生成器' };
      }
      return {
        ok: true,
        engine: 'parametric',
        process: payload.process,
        parts: 29,
        loadedParts: 29,
        massKg: 85.41,
        files: { step: 917272, stl: 747284, partCount: 29 }
      };
    }
  };
  const bus = createAgentCommandBus(registry, bridge);
  return { bus, calls, tools: new AgentTools(registry, bus) };
}

test('build_machine_model 已注册、schema 拒绝未知键、且归入写工具', () => {
  const { tools } = setup();
  const tool = tools.summaries().find((item) => item.name === 'build_machine_model');
  assert.ok(tool, '工具未注册');
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(Object.hasOwn(tool.inputSchema, 'required'), true);
  assert.deepEqual(tool.inputSchema.required, []);
  for (const key of ['process', 'params', 'design', 'config', 'name', 'load']) {
    assert.ok(Object.hasOwn(tool.inputSchema.properties, key), `缺少参数 ${key}`);
  }
  assert.equal(WRITE_TOOLS.has('build_machine_model'), true, '会替换视口内容，必须走确认');
  assert.equal(READ_ONLY_TOOLS.has('build_machine_model'), false);
});

test('build_machine_model 默认走输送机，并把参数透传到渲染层', async () => {
  const { bus, calls } = setup();
  const result = await bus.execute('build_machine_model', { params: { lengthMm: 2400 } });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'buildMachineModel');
  assert.equal(calls[0].args[0].process, 'conveyor');
  assert.deepEqual(calls[0].args[0].params, { lengthMm: 2400 });
  assert.equal(result.data.parts, 29);
});

test('build_machine_model 校验：params 必须是对象、name 非空、load 布尔、无未知键', async () => {
  const { bus, calls } = setup();
  const cases = [
    [{ params: [1, 2] }, /params 必须是对象/],
    [{ name: '   ' }, /name/],
    [{ load: 'yes' }, /load/],
    [{ 乱写: 1 }, /未知参数/]
  ];
  for (const [args, pattern] of cases) {
    const result = await bus.execute('build_machine_model', args);
    assert.equal(result.ok, false, `${JSON.stringify(args)} 应当被拒绝`);
    assert.match(result.error?.message ?? '', pattern);
  }
  assert.equal(calls.length, 0, '校验失败不能打到渲染层');
});

test('build_machine_model 不支持的机型在命令层就拒（分派判据只有一份，不靠渲染层兜）', async () => {
  const { bus, calls } = setup();
  const result = await bus.execute('build_machine_model', { process: 'screw' });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'INVALID_ARGUMENT', '机型不支持 = 入参非法，bridge 不该被调');
  assert.match(result.error?.message ?? '', /暂无参数化整机生成器/);
  assert.match(result.error?.message ?? '', /apply_machine_design/);
  assert.equal(calls.length, 0, '不支持的机型不能打到渲染层');
});

/**
 * `process` 给了就必须是非空字符串：命令层与工具层同口径。
 * 以前 `resolveModelDispatch` 只认 `typeof === 'string'`，其它一律当「没写 process」→
 * 默认 conveyor、`ok:true`、bridge 1 次（29 件底层线），与 design/config/params 的
 * 「形状先判」不一致。
 */
test('process 显式给了却非字符串/空白：命令层与工具层都拒成 INVALID_ARGUMENT（不许默认 conveyor）', async () => {
  const { bus, calls, tools } = setup();
  for (const process of [123, {}, [], true, null, '', '   ']) {
    const label = JSON.stringify(process);
    const viaBus = await bus.execute('build_machine_model', { process });
    assert.equal(viaBus.ok, false, `process=${label} 应当被命令层拒绝`);
    assert.equal(viaBus.error?.code, 'INVALID_ARGUMENT', `process=${label} 的错误码`);
    assert.match(viaBus.error?.message ?? '', /process 必须是非空字符串/);

    const viaTool = await tools.call('build_machine_model', { process });
    assert.equal(viaTool?.ok, false, `process=${label} 应当被工具层拒绝`);
    assert.equal(viaTool?.code, 'INVALID_ARGUMENT', `process=${label} 的工具层错误码`);
    assert.match(viaTool?.message ?? '', /process 必须是非空字符串/);
  }
  assert.equal(calls.length, 0, '被拒的 process 不能打到渲染层（那里会按 conveyor 建 29 件）');

  // 反例对照：不写 process 仍按默认 conveyor；写对了原样透传
  const implicit = await bus.execute('build_machine_model', { params: { lengthMm: 2400 } });
  assert.equal(implicit.ok, true, implicit.error?.message);
  assert.equal(calls[0].args[0].process, 'conveyor', '省略 process 仍然走默认输送线');
  const explicit = await bus.execute('build_machine_model', { process: 'buffer-tower', params: { levels: 16 } });
  assert.equal(explicit.ok, true, explicit.error?.message);
  assert.equal(calls[1].args[0].process, 'buffer-tower');
});

/**
 * 非塔 design/config 与形状错误：全部在命令层拒（bridge 0 次）。
 * 背景：`process:'conveyor' + config.conveyor{lengthMm:6000}` 实测 `ok:true`
 * 却建默认 2000×300 的 29 件线 —— config.conveyor 被完全忽略且没有任何提示。
 */
test('build_machine_model：非塔 design/config、双源、形状错在命令层显式拒', async () => {
  const { bus, calls } = setup();
  const conveyorDesign = {
    config: {
      id: 'line-1',
      name: '输送线',
      stations: ['上料'],
      actuators: [],
      sensors: [],
      conveyor: { lengthMm: 6000, widthMm: 600 }
    }
  };
  const cases = [
    [{ process: 'conveyor', config: { ...conveyorDesign.config } }, /config\.conveyor 不会被整机建模器读取/],
    [{ process: 'conveyor', design: conveyorDesign }, /config\.conveyor 不会被整机建模器读取/],
    [{ design: conveyorDesign }, /config\.conveyor 不会被整机建模器读取/],
    [{ process: 'conveyor', params: { lengthMm: 6000 }, design: conveyorDesign }, /config\.conveyor 不会被整机建模器读取/],
    [{ design: TOWER_DESIGN, params: { lengthMm: 2400 } }, /params（lengthMm）与 design\.config\.bufferTower 同时给了/],
    [{ config: TOWER_DESIGN.config, params: { levels: 8 } }, /params（levels）与 config\.bufferTower 同时给了/],
    [{ params: [2400] }, /params 必须是/]
  ];
  for (const [args, pattern] of cases) {
    const result = await bus.execute('build_machine_model', args);
    assert.equal(result.ok, false, `${JSON.stringify(args).slice(0, 90)} 应当被拒绝`);
    assert.match(result.error?.message ?? '', pattern);
  }
  assert.equal(calls.length, 0, '静默忽略的入参不能打到渲染层');
});

test('build_machine_model 把 buffer-tower 与塔参数原样透传渲染层（不在工具层夹紧）', async () => {
  const { bus, calls } = setup();
  const params = { levels: 16, layerPitchMm: 180, panelLengthMm: 2278, inboundLengthMm: 2400 };
  await bus.execute('build_machine_model', { process: 'buffer-tower', params });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0].process, 'buffer-tower');
  assert.deepEqual(calls[0].args[0].params, params, '塔参数必须原样到渲染层，工具层不许改写/夹紧');
});

test('注册表里只有输送机与缓存塔，其它工艺必须显式失败而不是回落', () => {
  // buffer-tower 是几何专用机型（config.bufferTower），不是可合成工艺：它没有 synth 模板/节拍基数，
  // 所以只出现在 MODEL_BUILDERS，不进 MachineProcess/RULES_ONLY_PROCESSES。
  assert.deepEqual(Object.keys(MODEL_BUILDERS), ['conveyor', 'buffer-tower']);
  for (const process of ['screw', 'dispense', 'assembly', 'inspection', 'packaging']) {
    assert.equal(pickModelBuilder(process), null);
  }
  assert.equal(pickModelBuilder('buffer-tower')?.engine, 'parametric');
});

/* ---------------- design / config 入口（命令层不再拦） ---------------- */

/** 16 层塔 design：与 design_machine 的产物同形（config.bufferTower 是权威块）。 */
const TOWER_DESIGN = {
  config: {
    id: 'buffer-tower-16l',
    name: '缓存塔 16 层',
    stations: ['进出料'],
    actuators: [],
    sensors: [],
    formId: 'belt-line',
    bufferTower: {
      kind: 'tower',
      towers: 1,
      slotsPerTower: 16,
      levels: 16,
      slotsPerLevel: 1,
      layerPitchMm: 180,
      panel: { lengthMm: 2278, widthMm: 1134, thicknessMm: 35, massKg: 32 },
      inbound: { lengthMm: 2400, widthMm: 1200, beltHeightMm: 900 },
      frame: { material: 'AL6063', sectionMm: 40 }
    }
  }
};

test('build_machine_model：只给 design 也过命令层，并归一到 process=buffer-tower 透传 design', async () => {
  const { bus, calls } = setup();
  const result = await bus.execute('build_machine_model', { design: TOWER_DESIGN });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0].process, 'buffer-tower', '只给 design 不许按默认 conveyor 打到渲染层（那会出 29 件）');
  assert.deepEqual(calls[0].args[0].design, TOWER_DESIGN, 'design 必须原样透传：落盘的 panel/inbound/frame 只在它里面');
});

test('build_machine_model：config 简写（design.config）同样认塔', async () => {
  const { bus, calls } = setup();
  const result = await bus.execute('build_machine_model', { config: TOWER_DESIGN.config });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(calls[0].args[0].process, 'buffer-tower');
  assert.deepEqual(calls[0].args[0].config, TOWER_DESIGN.config);
  assert.equal(calls[0].args[0].design, undefined, 'config 简写不合成 design 外壳');
});

test('build_machine_model：塔入参冲突/缺失/形状错在命令层显式拒，不打到渲染层', async () => {
  const { bus, calls } = setup();
  const noTower = { config: { id: 'x', name: 'y', stations: [], actuators: [], sensors: [] } };
  const cases = [
    [{ process: 'conveyor', design: TOWER_DESIGN }, /冲突/],
    [{ process: 'conveyor', config: TOWER_DESIGN.config }, /冲突/],
    [{ process: 'buffer-tower', design: noTower }, /bufferTower 缺失/],
    [{ design: [TOWER_DESIGN] }, /design 必须是对象/],
    [{ config: 'tower' }, /config 必须是对象/],
    [{ design: TOWER_DESIGN, config: TOWER_DESIGN.config }, /二选一/],
    [{ design: { config: 'nope' } }, /design\.config 必须是机型配置对象/]
  ];
  for (const [args, pattern] of cases) {
    const result = await bus.execute('build_machine_model', args);
    assert.equal(result.ok, false, `${JSON.stringify(args).slice(0, 80)} 应当被拒绝`);
    assert.match(result.error?.message ?? '', pattern);
  }
  assert.equal(calls.length, 0, '分派冲突不能靠渲染层「任选一个」');
});

test('build_machine_model：design/config 传 null 当没给；bufferTower:null 不被当成塔', async () => {
  const { bus, calls } = setup();
  const nulled = await bus.execute('build_machine_model', { design: null, config: null, params: { lengthMm: 2000 } });
  assert.equal(nulled.ok, true, nulled.error?.message);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0].process, 'conveyor');
  assert.equal(calls[0].args[0].design, undefined);
  assert.equal(calls[0].args[0].config, undefined);

  // design 里 bufferTower:null = 「没有塔」→ 不能按塔建；但这份 design 也不是输送线几何源，
  // 放它过去只会建出默认 2000×300（参数没生效却 ok:true），所以显式拒并要求用 params。
  const nullTower = await bus.execute('build_machine_model', {
    design: { config: { id: 'x', name: 'y', stations: [], actuators: [], sensors: [], bufferTower: null } },
    params: { lengthMm: 2000 }
  });
  assert.equal(nullTower.ok, false);
  assert.match(nullTower.error?.message ?? '', /没有塔块/);
  assert.equal(calls.length, 1, '被拒的调用不能打到渲染层');
});

/**
 * `bufferTower` 键存在但 kind 不是 'tower'：**不许当没有**。
 * 同一份 config 在 apply_machine_design 侧会直接拒（normalizeBufferTowerConfig），
 * 若这里静默放行，智能体拿到的是一台「参数没生效」的 29 件底层输送线 + ok:true。
 */
test('build_machine_model：bufferTower 存在但 kind≠tower 必须显式拒（不静默出 29 件）', async () => {
  const { bus, calls } = setup();
  const towerBlock = TOWER_DESIGN.config.bufferTower;
  const withKind = (kind) => ({
    config: { ...TOWER_DESIGN.config, bufferTower: kind === undefined ? { ...towerBlock, kind: undefined } : { ...towerBlock, kind } }
  });
  const cases = [
    [{ design: withKind('Tower') }, /kind !== 'tower'/],   // 大小写拼错（最常见的 LLM 手写错误）
    [{ design: withKind('rack') }, /kind !== 'tower'/],    // 写成别的机型
    [{ design: withKind(undefined) }, /kind !== 'tower'/], // 漏写 kind
    [{ config: withKind('Tower').config }, /kind !== 'tower'/], // config 简写同一个判据
    [{ process: 'buffer-tower', design: withKind('rack') }, /kind !== 'tower'/]
  ];
  for (const [args, pattern] of cases) {
    const result = await bus.execute('build_machine_model', args);
    assert.equal(result.ok, false, `${JSON.stringify(args).slice(0, 120)} 应当被拒绝`);
    assert.match(result.error?.message ?? '', pattern);
    assert.match(result.error?.message ?? '', /29 件/);
  }
  assert.equal(calls.length, 0, '不合法的塔块不能打到渲染层（那里会按输送线建 29 件）');
});

test('build_machine_model：bufferTower 显式 null 不属于「kind 错了」，但非塔 design 仍显式拒', async () => {
  const { bus, calls } = setup();
  const result = await bus.execute('build_machine_model', {
    design: { config: { id: 'x', name: 'y', stations: [], actuators: [], sensors: [], bufferTower: null } }
  });
  // bufferTower:null = 「没有塔」→ 不能报成「kind !== 'tower'」（那会把 null 说成拼错）
  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? '', /没有塔块/);
  assert.doesNotMatch(result.error?.message ?? '', /kind !== 'tower'/);
  assert.equal(calls.length, 0, '非塔 design 不许静默建默认 2000×300 的 29 件线');
});

/* ---------------- 裸 config 入口：落盘走 config 字段，不许顶替 design ---------------- */

/** `build_machine_model({ config })` 的真实形状：塔的调用方手上常常只有塔块。 */
const BARE_TOWER_CONFIG = { bufferTower: TOWER_DESIGN.config.bufferTower };

test('build_machine_model：裸 {bufferTower} 经 bus 到 bridge 仍是 config（panel/inbound/frame 原样），不合成 design', async () => {
  const { bus, calls } = setup();
  const result = await bus.execute('build_machine_model', { config: BARE_TOWER_CONFIG });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(calls.length, 1);
  const payload = calls[0].args[0];
  assert.equal(payload.process, 'buffer-tower', '裸 config 必须判成塔，不能默认 conveyor');
  assert.equal(payload.design, undefined, 'config 入口不许在命令层合成 design 外壳（那份壳缺 stations）');
  assert.deepEqual(payload.config, BARE_TOWER_CONFIG, 'config 必须原样到渲染层（工具层不许改写）');
  assert.deepEqual(payload.config.bufferTower.panel, TOWER_DESIGN.config.bufferTower.panel);
  assert.deepEqual(payload.config.bufferTower.inbound, TOWER_DESIGN.config.bufferTower.inbound);
  assert.deepEqual(payload.config.bufferTower.frame, TOWER_DESIGN.config.bufferTower.frame);
});

/**
 * 落盘接线：裸 config 必须走 `projects.save` 的 config 字段。
 *
 * 反例（真实 Electron 实测）：把 `{ config }` 壳当 design 送进 `validateMachineDesign`
 * →「缺少必填参数：机型配置.stations」→ `project.saved=false`：几何建出来了、参数没进库。
 */
test('接线：裸 config 落盘走 projects.save 的 config 字段，完整 design/params 仍走 design', () => {
  const source = readFileSync(new URL('../../src/extension.ts', import.meta.url), 'utf8');
  assert.ok(
    source.includes('towerSaveConfig ? { config: towerSaveConfig } : (towerModel ? { design: towerModel.design }'),
    '裸 config 入口必须落 config 字段（design 只留给完整方案/params 合成方案）'
  );
  assert.ok(
    source.includes("towerModel.source === 'design' && request.design === undefined"),
    '只有裸 config 才改走 config（params 路径保持 design）'
  );
  assert.ok(source.includes('function towerSaveConfigFor('), '裸 config 的机型级字段必须由一个入口补齐，不散在调用点');
  assert.ok(
    source.includes('buildBufferTowerDesign(tower).config as unknown as MachineConfig'),
    '只给塔块时用与 params 入口同源的合成器补最小可落盘集（id/name/stations/actuators/sensors）'
  );
  assert.ok(source.includes('config?: MachineConfig;'), 'saveProjectToLibrary 必须显式接 MachineConfig');
});
