// 智能体自证能力（D）：capture_view 真截图落盘 + run_interference_check 的 rest/lift/sweep 多态。
//
// 断言口径：
// - 走真实 AgentTools + CommandBus（bridge 只做假渲染层，机型落盘/bus 逻辑不 mock）；
// - 截图通道用可注入的假 capture 返回**真实字节**，落盘/哈希/尺寸都从磁盘复算；
// - lift 必须与 rest 数字不同 —— 证明可动件真的按行程平移了，不是把 rest 复制一遍；
// - 行程来自机型 config（turner-lift.travelMm），测试里不写死 60，用 config 值推算步数。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AgentTools } from '../../src/agent/tools.ts';
import { createAgentCommandBus } from '../../src/agent/commands.ts';
import { READ_ONLY_TOOLS } from '../../src/agent/router.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';

const BRIEF_TURNER = '皮带输送线，皮带有效宽度 600 mm，工件 90° 转向改变方向，节拍 20 件/分钟';
const BRIEF_NO_LIFT = '设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服';

/** 一张能过 PNG 头检查的最小假图（不是首页截图，只是可控字节）。 */
function fakePng(size = 4096) {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 8; index < size; index += 1) bytes[index] = index % 251;
  return bytes;
}

const roots = [];
const registry = { listParts: () => [] };

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function setup({ capture, interference } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cad-self-evidence-'));
  roots.push(root);
  const calls = [];
  const bridge = {
    calls,
    async call(method, args) {
      calls.push({ method, args });
      if (method === 'runInterference') {
        return interference ?? {
          hits: 25,
          items: Array.from({ length: 25 }, (_value, index) => ({
            a: `A${index}`,
            b: `B${index}`,
            volume: index,
            severity: 'warning'
          }))
        };
      }
      if (method === 'applyMachineConfig') return { ok: true };
      if (method === 'appendMachineBomRows') return { ok: true, added: 0 };
      return { ok: false, message: `unexpected ${method}` };
    }
  };
  const bus = createAgentCommandBus(registry, bridge, {
    userDataRoot: root,
    exportsRoot: join(root, 'exports'),
    ...(capture ? { captureView: capture } : {}),
    now: () => new Date('2026-11-04T08:09:10.123Z')
  });
  return { root, calls, bus, tools: new AgentTools(registry, bus) };
}

/** 用真实 apply_machine_design 落一台 active 机型（不写几何文件，省时间）。 */
async function applyActive(bus, brief) {
  const design = synthMachine(parseMachineBrief(brief));
  const result = await bus.execute('apply_machine_design', {
    design,
    name: design.config.name,
    withGeometry: false
  });
  assert.equal(result.ok, true, `落盘机型失败：${JSON.stringify(result.error ?? {})}`);
  return design.config;
}

test('capture_view 未就绪时返回 VIEW_NOT_READY，不返回首页截图', async () => {
  const { tools, root } = setup({
    capture: async () => ({ ok: false, code: 'VIEW_NOT_READY', message: '页面仍停在首页', hint: '先进入经典原型界面' })
  });
  const result = await tools.call('capture_view', { view: '3d' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'VIEW_NOT_READY');
  assert.match(result.hint, /经典原型界面/);
  assert.equal(existsSync(join(root, 'agent-shots')), false, '未就绪时不能落任何截图文件');
  assert.equal(READ_ONLY_TOOLS.has('capture_view'), true, 'capture_view 必须是只读工具');
});

test('capture_view 成功路径：文件存在、bytes 与磁盘一致、sha256 可复算', async () => {
  const png = fakePng(12_345);
  const requests = [];
  const { tools, root } = setup({
    capture: async (request) => {
      requests.push(request);
      return { ok: true, png, width: request.width, height: request.height };
    }
  });
  const result = await tools.call('capture_view', { view: 'library', width: 1280, height: 800 });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.view, 'library');
  assert.equal(result.width, 1280);
  assert.equal(result.height, 800);
  assert.match(result.path, /agent-shots[\\/]2026-11-04T08-09-10-123Z-library\.png$/);
  assert.equal(existsSync(result.path), true);

  const disk = readFileSync(result.path);
  assert.equal(result.bytes, statSync(result.path).size, 'bytes 必须来自落盘后的真实文件大小');
  assert.equal(result.bytes, disk.length);
  assert.equal(disk.length, png.byteLength);
  assert.equal(result.sha256, createHash('sha256').update(disk).digest('hex'), 'sha256 必须能在磁盘上复算');
  assert.equal(requests.length, 1, '正常尺寸不该重拍');
});

test('capture_view 超过 5 MiB 时缩尺寸重拍一次', async () => {
  const requests = [];
  const { tools } = setup({
    capture: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return { ok: true, png: fakePng(6 * 1024 * 1024), width: request.width, height: request.height };
      }
      return { ok: true, png: fakePng(4096), width: request.width, height: request.height };
    }
  });
  const result = await tools.call('capture_view', { view: '3d', width: 1600, height: 1000 });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(requests.length, 2, '超过 5 MiB 必须重拍一次');
  assert.equal(requests[0].width, 1600);
  assert.ok(requests[1].width < requests[0].width, `重拍宽度应缩小：${requests[1].width}`);
  assert.ok(requests[1].height < requests[0].height, `重拍高度应缩小：${requests[1].height}`);
  assert.equal(result.bytes, 4096);
  assert.equal(result.width, requests[1].width);

  // 重拍一次仍超限：如实报 SHOT_TOO_LARGE，不静默截断/压缩
  const huge = [];
  const second = setup({
    capture: async (request) => {
      huge.push(request);
      return { ok: true, png: fakePng(6 * 1024 * 1024), width: request.width, height: request.height };
    }
  });
  const failed = await second.tools.call('capture_view', { view: '3d', width: 1600, height: 1000 });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'SHOT_TOO_LARGE');
  assert.equal(huge.length, 2, '只允许缩尺寸重拍一次');
});

test('run_interference_check 不传 states 时形状与旧版一致', async () => {
  const { tools, calls } = setup();
  const result = await tools.call('run_interference_check', {});
  assert.deepEqual(Object.keys(result).sort(), ['hits', 'items', 'ok']);
  assert.equal(result.ok, true);
  assert.equal(result.hits, 25);
  assert.equal(result.items.length, 20);
  assert.equal(calls.at(-1).method, 'runInterference', '不传 states 必须仍走渲染层旧通道');
});

test('states:[rest,lift] 时 lift 真的按行程平移，数字与 rest 不同', async () => {
  const { tools, bus } = setup();
  const config = await applyActive(bus, BRIEF_TURNER);
  const liftActuator = config.actuators.find((actuator) => actuator.id === 'turner-lift');
  assert.ok(liftActuator, '带转向工位的机型必须有 turner-lift 轴');
  assert.ok(Number(liftActuator.travelMm) > 0, 'turner-lift 必须有行程');

  const result = await tools.call('run_interference_check', { states: ['rest', 'lift'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(Object.keys(result.states).sort(), ['lift', 'rest']);
  assert.equal(result.lift.actuatorId, 'turner-lift');
  assert.equal(result.lift.strokeMm, Number(liftActuator.travelMm), '行程必须来自 active config，不是写死值');
  assert.ok(result.lift.partIds.length > 0);

  const rest = result.states.rest;
  const lift = result.states.lift;
  for (const state of [rest, lift]) {
    assert.equal(typeof state.pairs, 'number');
    assert.equal(typeof state.hits, 'number');
    assert.equal(typeof state.mm3, 'number');
  }
  assert.notDeepEqual(
    { pairs: lift.pairs, hits: lift.hits, mm3: lift.mm3 },
    { pairs: rest.pairs, hits: rest.hits, mm3: rest.mm3 },
    'lift 与 rest 数字完全相同说明可动件没平移（或在复制 rest）'
  );
});

test('机型没有可顶升轴时返回 STATE_UNAVAILABLE', async () => {
  const { tools, bus } = setup();
  await applyActive(bus, BRIEF_NO_LIFT);
  const result = await tools.call('run_interference_check', { states: ['rest', 'lift'] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'STATE_UNAVAILABLE');
  assert.match(result.hint, /顶升|转向/);
});

test('states:[sweep] 返回逐步结果，步数 = 行程/10 + 1', async () => {
  const { tools, bus } = setup();
  const config = await applyActive(bus, BRIEF_TURNER);
  const strokeMm = Number(config.actuators.find((actuator) => actuator.id === 'turner-lift').travelMm);

  const result = await tools.call('run_interference_check', { states: ['sweep'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  const sweep = result.states.sweep;
  assert.equal(sweep.step, 10);
  assert.equal(sweep.steps.length, Math.floor(strokeMm / 10) + 1, `行程 ${strokeMm} mm 应有 ${Math.floor(strokeMm / 10) + 1} 步`);
  assert.deepEqual(sweep.steps.map((step) => step.z), Array.from({ length: sweep.steps.length }, (_v, index) => index * 10));
  assert.equal(sweep.steps[0].z, 0, '第一步必须是 rest 位（z=0）');
  assert.equal(sweep.steps.at(-1).z, strokeMm);
  // 扫掠的聚合口径：pairs 取单步最大，hits/mm3 按步累计
  assert.equal(sweep.pairs, Math.max(...sweep.steps.map((step) => step.pairs)));
  assert.equal(sweep.hits, sweep.steps.reduce((sum, step) => sum + step.hits, 0));
});
