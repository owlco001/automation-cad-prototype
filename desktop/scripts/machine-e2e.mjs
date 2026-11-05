#!/usr/bin/env node
/**
 * 整机全流程 E2E：光伏板输送机（含 90° 转向工位）
 *
 * 一条命令跑完「设计 → 应用 → 参数化几何 → PLC → 导出 → 干涉 → 截图」，
 * 全程使用**真实 Electron 窗口 + 真实智能体 UI**：
 *
 *   node/electron  ← xvfb + SwiftShader（scripts/electron-run.mjs，root 自动补 --no-sandbox）
 *   交互           ← 从外部 CDP(127.0.0.1:9229) 驱动真实 DOM：点入口按钮、往输入框打字、
 *                    点发送、点「应用到工程」、点确认卡的「允许一次」——不调用任何内部函数绕过 UI。
 *
 * 两个本地桩（都不出本机、都在本脚本内起）：
 *   1) OpenAI 兼容模型桩：真实模型不可用时（CI/容器无密钥、不联网）把用户消息映射成
 *      tool_call。**UI 与工具执行全是真实的**，桩只代替「模型决定调哪个工具」这一步；
 *   2) build123d 内核桩：本机没有 Python+OCP，用同一 HTTP 契约（/health + /build）逐件返回
 *      按特征尺寸生成的 STL，让 build_machine_model 走完真实的「逐件装配 → 零件树 → 干涉」链路。
 *      桩的几何是方块/棱柱近似（不含孔/槽），这一点在日志与报告里明说，不冒充 B-Rep。
 *
 * 用法：
 *   npm run machine:e2e              # 完整流程 + 三张截图
 *   MACHINE_E2E_KEEP=1 npm run machine:e2e   # 失败时保留 userData 目录便于排查
 *
 * 退出码：0 = 全流程通过；1 = 任一步失败（日志里 MACHINE_E2E_FAIL step=N reason=...）。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const repoRoot = resolve(desktopRoot, '..');
const electronBin = join(desktopRoot, 'node_modules', '.bin', 'electron');
const runner = join(here, 'electron-run.mjs');
const shotDir = process.env.AUTOMATIONCAD_SCREENSHOT_DIR
  ? resolve(process.env.AUTOMATIONCAD_SCREENSHOT_DIR)
  : join(repoRoot, 'docs', 'desktop', 'screenshots');
const KEEP = process.env.MACHINE_E2E_KEEP === '1';

const BRIEF = '光伏板加工输送机：输送 2000mm 光伏板，线体长 6000mm、带宽 1200mm，需要把光伏板旋转 90° 改变方向，节拍 6 件/分钟';
/**
 * 第二台机器（同一轮 E2E 里跑）：顶升移载（直角移载）。
 * 与第一台的区别只有「板不转、整块沿 +Y 送到下游」，用来验本轮新增的
 * 移载单元 / 两条轴 / 四个联锁信号 / 下游对接段。
 */
const TRANSFER_BRIEF = '光伏板加工输送机：输送 1200×800mm 光伏板，线体长 6000mm、带宽 1200mm，'
  + '需要顶升移载沿 90° 方向把板子送到下游输送线，节拍 6 件/分钟';
/** 移载工位的四个联锁信号（io-map 里必须逐个能看到） */
const TRANSFER_SIGNALS = ['DO-TRANSFER-READY', 'DO-TRANSFER-DONE', 'DI-DOWNSTREAM-ALLOW', 'DI-TRANSFER-END'];
const CONFIRM_SELECTOR = '#acwConfirmMask [data-acw="once"]';
/** 当前 CDP 客户端：确认按钮/截图这些跨函数的动作都从这里走，避免把 cdp 一路透传。 */
let ACTIVE_CDP = null;
/** 已产出的截图（name → {hash, bytes}）：用于「三张互异」的硬校验，重复即报错。 */
const shotHashes = new Map();
/** 截图尺寸与 docs/desktop/screenshots 里其它整机图一致（1600×1000）。 */
const SHOT_WIDTH = 1600;
const SHOT_HEIGHT = 1000;
/** 每次跑用一个空闲端口：9229 上若挂着别的实例，外部驱动会连到别人的窗口上。 */
let cdpPort = 9229;

// ---------------------------------------------------------------------------
// build123d 内核桩：被主脚本以 `node machine-e2e.mjs --parametric-stub` 再起一份，
// 由 electron/parametric.ts 按 AUTOMATIONCAD_PARAMETRIC_CMD 拉起（--port/--token 由它传）。
// ---------------------------------------------------------------------------
if (process.argv.includes('--parametric-stub')) {
  runParametricStub();
} else {
  await main();
}

/** 逐件返回按特征尺寸生成的 STL：box → 长方体，cylinder → 棱柱，其余（holes/slot）忽略。 */
function runParametricStub() {
  const argv = process.argv.slice(2);
  const argOf = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const port = Number(argOf('--port') ?? 0);
  const token = argOf('--token') ?? '';
  const workDir = process.env.MACHINE_E2E_SIDECAR_DIR || join(tmpdir(), 'machine-e2e-sidecar');
  mkdirSync(workDir, { recursive: true });

  const server = createServer((req, res) => {
    const send = (code, body) => {
      const text = JSON.stringify(body);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    };
    if (req.method === 'GET' && req.url === '/health') {
      return send(200, { ok: true, kernel: 'build123d', version: '0.0.0-machine-e2e-stub', pid: process.pid });
    }
    if (req.method !== 'POST' || req.url !== '/build') return send(404, { ok: false, error: 'not found' });
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { ok: false, error: 'unauthorized' });
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { return send(400, { ok: false, error: 'JSON 解析失败' }); }
      const instances = Array.isArray(payload.instances) ? payload.instances : [];
      if (instances.length === 0) return send(200, { ok: false, error: 'e2e 桩只支持装配文档（instances 为空）' });

      const parts = [];
      let volumeTotal = 0;
      const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const instance of instances) {
        const id = String(instance.id ?? `part-${parts.length + 1}`);
        const built = buildPartMesh(instance);
        const path = join(workDir, `${id.replace(/[^\w.-]+/g, '_')}.stl`);
        const bytes = writeBinaryStl(path, built.triangles);
        parts.push({ id, name: String(instance.name ?? id), stl: { path, bytes }, volumeMm3: built.volumeMm3 });
        volumeTotal += built.volumeMm3;
        for (let axis = 0; axis < 3; axis += 1) {
          box[axis] = Math.min(box[axis], built.min[axis]);
          box[axis + 3] = Math.max(box[axis + 3], built.max[axis]);
        }
      }
      const stepPath = join(workDir, 'assembly.step');
      const stepText = 'ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((\'machine-e2e stub\'),\'2;1\');\nENDSEC;\n'
        + 'DATA;\n' + parts.map((part, index) => `#${index + 1}=CARTESIAN_POINT(\'\',(0.,0.,0.));`).join('\n')
        + '\nENDSEC;\nEND-ISO-10303-21;\n';
      writeFileSync(stepPath, stepText, 'utf8');
      return send(200, {
        ok: true,
        kernel: 'build123d',
        buildMs: 8,
        stats: {
          volumeMm3: Math.round(volumeTotal),
          bbox: [box[3] - box[0], box[4] - box[1], box[5] - box[2]].map((value) => Math.round(value)),
          faces: parts.length * 6,
          edges: parts.length * 12,
          solids: parts.length,
          instances: parts.map((part) => ({ id: part.id, name: part.name, volumeMm3: Math.round(part.volumeMm3) }))
        },
        files: {
          step: { path: stepPath, bytes: statSync(stepPath).size, ms: 3 },
          stl: { path: parts[0].stl.path, bytes: parts[0].stl.bytes, ms: 4 },
          parts: parts.map((part) => ({ id: part.id, name: part.name, stl: { path: part.stl.path, bytes: part.stl.bytes } }))
        }
      });
    });
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(JSON.stringify({ ok: true, port, token, version: '0.0.0-machine-e2e-stub' }));
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => { server.close(); process.exit(0); });
  }
}

/** 把一条实例的特征树压成一个可渲染的实心近似体（box / cylinder），其余 op 忽略。 */
function buildPartMesh(instance) {
  const transform = instance?.transform && typeof instance.transform === 'object' ? instance.transform : {};
  const rz = Number(transform.rz ?? 0) * (Math.PI / 180);
  const origin = [Number(transform.x ?? 0), Number(transform.y ?? 0), Number(transform.z ?? 0)];
  const ops = Array.isArray(instance?.ops) ? instance.ops : [];
  let shape = null;
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    if (op.op === 'box') {
      const l = Number(op.length ?? 0), w = Number(op.width ?? 0), h = Number(op.height ?? 0);
      if (l > 0 && w > 0 && h > 0) { shape = { kind: 'box', l, w, h }; break; }
    }
    if (op.op === 'cylinder') {
      const d = Number(op.diameter ?? 0), h = Number(op.height ?? 0);
      const axis = op.axis === 'x' || op.axis === 'y' ? op.axis : 'z';
      if (d > 0 && h > 0) { shape = { kind: 'cylinder', d, h, axis }; break; }
    }
  }
  if (!shape) shape = { kind: 'box', l: 20, w: 20, h: 20 };

  const rotate = ([x, y, z]) => ([
    x * Math.cos(rz) - y * Math.sin(rz) + origin[0],
    x * Math.sin(rz) + y * Math.cos(rz) + origin[1],
    z + origin[2]
  ]);

  const triangles = [];
  let volumeMm3 = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const push = (a, b, c) => {
    for (const point of [a, b, c]) {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], point[axis]);
        max[axis] = Math.max(max[axis], point[axis]);
      }
    }
    triangles.push([a, b, c]);
  };

  if (shape.kind === 'box') {
    const [hl, hw, hh] = [shape.l / 2, shape.w / 2, shape.h / 2];
    volumeMm3 = shape.l * shape.w * shape.h;
    const c = [
      [-hl, -hw, -hh], [hl, -hw, -hh], [hl, hw, -hh], [-hl, hw, -hh],
      [-hl, -hw, hh], [hl, -hw, hh], [hl, hw, hh], [-hl, hw, hh]
    ].map(rotate);
    const faces = [
      [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
      [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
      [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]
    ];
    for (const [i, j, k] of faces) push(c[i], c[j], c[k]);
  } else {
    const segments = 24;
    const radius = shape.d / 2;
    const half = shape.h / 2;
    volumeMm3 = Math.PI * radius * radius * shape.h;
    const ring = (offset) => {
      const loop = [];
      for (let index = 0; index < segments; index += 1) {
        const angle = (index / segments) * Math.PI * 2;
        const u = Math.cos(angle) * radius;
        const v = Math.sin(angle) * radius;
        const local = shape.axis === 'x' ? [offset, u, v] : shape.axis === 'y' ? [u, offset, v] : [u, v, offset];
        loop.push(rotate(local));
      }
      return loop;
    };
    const bottom = ring(-half);
    const top = ring(half);
    for (let index = 0; index < segments; index += 1) {
      const next = (index + 1) % segments;
      push(bottom[index], bottom[next], top[next]);
      push(bottom[index], top[next], top[index]);
      push(bottom[0], bottom[index], bottom[next]);
      push(top[0], top[next], top[index]);
    }
  }
  return { triangles, volumeMm3, min, max };
}

function writeBinaryStl(path, triangles) {
  const buffer = Buffer.alloc(84 + triangles.length * 50);
  buffer.write('machine-e2e parametric stub', 0, 'utf8');
  buffer.writeUInt32LE(triangles.length, 80);
  let offset = 84;
  for (const [a, b, c] of triangles) {
    const normal = cross(sub(b, a), sub(c, a));
    for (const value of normal) { buffer.writeFloatLE(Number.isFinite(value) ? value : 0, offset); offset += 4; }
    for (const point of [a, b, c]) {
      for (const value of point) { buffer.writeFloatLE(Number(value), offset); offset += 4; }
    }
    buffer.writeUInt16LE(0, offset);
    offset += 2;
  }
  writeFileSync(path, buffer);
  return buffer.length;
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
/** 取一个当前空闲的回环端口（拿不到就退回 9229，交给主进程判断）。 */
async function freePort() {
  return await new Promise((resolvePort) => {
    const server = createNetServer();
    server.once('error', () => resolvePort(9229));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 9229;
      server.close(() => resolvePort(port));
    });
  });
}

async function main() {
  if (!existsSync(electronBin)) {
    console.error(`MACHINE_E2E_FAIL step=0 reason=electron-missing path=${electronBin}`);
    process.exit(1);
  }
  mkdirSync(shotDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const userDataDir = join(tmpdir(), `automationcad-e2e-${stamp}`);
  const sidecarDir = join(userDataDir, 'e2e-parametric');
  mkdirSync(sidecarDir, { recursive: true });
  console.log(`MACHINE_E2E_USERDATA ${userDataDir}`);

  cdpPort = await freePort();
  const llm = await startLlmStub();
  let electron = null;
  let cdp = null;
  let failedReason = null;
  let stepsOk = 0;
  /** 产品侧已确认的缺口（不是脚本失败）：逐条记下来，最后统一打印。 */
  const blocked = [];
  const step = async (index, label, run) => {
    const startedAt = Date.now();
    try {
      const detail = await run();
      stepsOk += 1;
      console.log(`MACHINE_E2E_STEP_${index}_OK ${label}${detail ? ` ${detail}` : ''} (${Date.now() - startedAt}ms)`);
      return detail;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`MACHINE_E2E_FAIL step=${index} label=${label} reason=${message}`);
      failedReason = message;
      throw error;
    }
  };

  try {
    // detached: 让 xvfb-run 成为独立进程组组长。收尾时按**进程组**杀，
    // 否则只杀掉 xvfb-run 这层壳，底下的 electron/Xvfb 变孤儿（实测跑 5 次留下 79 个进程，
    // 机器 load 冲到 48，`npm test` 里的性能断言全被拖红）。
    electron = spawn(
      existsSync('/usr/bin/xvfb-run') ? 'xvfb-run' : process.execPath,
      existsSync('/usr/bin/xvfb-run')
        ? ['-a', '-s', '-screen 0 1920x1200x24', process.execPath, runner,
          '--machine-e2e-host', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
        : [runner, '--machine-e2e-host', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
      {
        detached: true,
        cwd: desktopRoot,
        env: {
          ...process.env,
          ELECTRON_DISABLE_SANDBOX: '',
          AUTOMATIONCAD_E2E_USERDATA: userDataDir,
          AUTOMATIONCAD_E2E_CDP_PORT: String(cdpPort),
          AUTOMATIONCAD_PARAMETRIC_CMD: `${process.execPath} ${fileURLToPath(import.meta.url)} --parametric-stub`,
          MACHINE_E2E_SIDECAR_DIR: sidecarDir,
          AUTOMATIONCAD_SCREENSHOT_DIR: shotDir,
          AUTOMATIONCAD_STUB_BASE_URL: `http://127.0.0.1:${llm.port}/v1`
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );
    let electronLog = '';
    electron.stdout.setEncoding('utf8');
    electron.stderr.setEncoding('utf8');
    electron.stdout.on('data', (chunk) => {
      electronLog += chunk;
      if (process.env.MACHINE_E2E_VERBOSE === '1') process.stdout.write(`[electron] ${chunk}`);
    });
    electron.stderr.on('data', (chunk) => {
      electronLog += chunk;
      if (process.env.MACHINE_E2E_VERBOSE === '1') process.stderr.write(`[electron:err] ${chunk}`);
    });
    electron.once('exit', (code) => {
      // 收尾时是我们自己杀掉的，code 会是 null —— 只有「非零退出码」才是异常信号
      if (typeof code === 'number' && code !== 0) console.error(`MACHINE_E2E_ELECTRON_EXIT code=${code}`);
    });

    // 现在一轮跑两台机器（转向 + 移载），10 分钟不够：放宽到 20 分钟。
    // 它只是防挂死的兜底，真实耗时以 MACHINE_E2E_DONE 的 steps 计时为准。
    const watchdog = setTimeout(() => {
      console.error('MACHINE_E2E_TIMEOUT 20 分钟内未完成，强制结束');
      try { electron?.kill('SIGKILL'); } catch { /* ignore */ }
    }, 20 * 60_000);
    watchdog.unref?.();

    cdp = await connectCdp();
    await cdp.fixViewport();
    await cdp.waitFor('window.__AUTOMATION_CAD_EXTENSION_READY__ === true', '桌面扩展就绪', 45_000);
    await cdp.evaluate(`(async () => {
      const result = await window.desktop.agent.saveLlmConfig({
        baseUrl: ${JSON.stringify(`http://127.0.0.1:${llm.port}/v1`)},
        apiKey: 'machine-e2e-local-stub',
        model: 'machine-e2e-stub',
        maxIterations: 4
      });
      return result;
    })()`);
    console.log(`MACHINE_E2E_STUB_LLM baseUrl=http://127.0.0.1:${llm.port}/v1 model=machine-e2e-stub（本地桩，不出本机）`);

    // --- 1. 打开智能体抽屉，发送需求原文 -----------------------------------
    const design = await step(1, 'send-brief', async () => {
      await cdp.evaluate(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const home = document.getElementById('homeScreen');
        if (home && !home.hidden) { document.querySelector('.home-link')?.click(); await wait(600); }
        window.AutomationCadViewer?.close();
        window.AutomationCadParametric?.close();
        document.getElementById('commissionDrawer')?.setAttribute('hidden', '');
        document.querySelector('#agentEntryButton')?.click();
        await wait(300);
        const input = document.getElementById('agentChatInput');
        if (!input) throw new Error('智能体输入框缺失');
        input.focus();
        input.value = ${JSON.stringify(BRIEF)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#agentChatSend')?.click();
        return true;
      })()`);
      await cdp.waitFor(`Boolean(document.querySelector('.acp-machine-card'))`, '设计结果卡出现', 90_000, clickConfirm);
      const payload = await llm.waitForTool('design_machine', 20_000);
      const design = payload?.design ?? {};
      const stations = Array.isArray(design?.config?.stations) ? design.config.stations : [];
      return `card=1 stations=${stations.join(',')}`;
    });

    // --- 2. 断言方案内容（转向工位 / turner-rotary 90° / BOM）--------------
    const cardState = await step(2, 'assert-design', async () => {
      const payload = await llm.waitForTool('design_machine', 5_000);
      const body = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
      const design = body?.design ?? body;
      const stations = (design?.config?.stations ?? []).map((entry) => (typeof entry === 'string' ? entry : entry?.name ?? entry?.id ?? ''));
      const actuators = design?.config?.actuators ?? [];
      const turner = actuators.find((entry) => entry?.id === 'turner-rotary');
      const turnerLift = actuators.find((entry) => entry?.id === 'turner-lift');
      const bomDraft = design?.bomDraft?.items ?? [];
      const stationsText = stations.join(',');
      if (!stationsText.includes('转向工位')) throw new Error(`方案里没有「转向工位」：${stationsText}`);
      if (!turner) throw new Error(`actuators 里没有 turner-rotary：${actuators.map((a) => a?.id).join(',')}`);
      if (!turnerLift) throw new Error(`actuators 里没有 turner-lift（顶升轴）：${actuators.map((a) => a?.id).join(',')}`);
      if (Number(turner.rotationRangeDeg) !== 90) throw new Error(`turner-rotary 角度异常：${turner.rotationRangeDeg}`);
      if (Number(turnerLift.travelMm) !== 60) throw new Error(`turner-lift 行程异常：${turnerLift.travelMm}`);
      if (bomDraft.length === 0) throw new Error('BOM 草稿为空');
      const cardStats = await cdp.evaluate(`(() => {
        const card = document.querySelector('.acp-machine-card');
        return {
          stats: Array.from(card?.querySelectorAll('.acp-machine-stats b') ?? []).map((node) => node.textContent),
          hasApply: Boolean(card?.querySelector('[data-apply-machine]')),
          warnings: Array.from(card?.querySelectorAll('.acp-machine-warning') ?? []).map((node) => node.textContent)
        };
      })()`);
      if (!cardStats.hasApply) throw new Error('方案卡缺少「应用到工程」按钮');
      if (Number(cardStats.stats[0]) !== stations.length) {
        throw new Error(`方案卡工位数 ${cardStats.stats[0]} 与方案 ${stations.length} 不一致`);
      }
      // BOM 草稿（电气）本身只装电气件：转向件出现在结构 BOM / 参数化生成的 BOM 里。
      // 这里如实记录，不做假断言——详见步骤 4 的结构 BOM 断言。
      console.log(`MACHINE_E2E_NOTE bom_draft_electrical=${bomDraft.length} (转向件不在电气草稿里；见步骤 4 结构 BOM)`);
      return `stations=${stationsText} actuators=${actuators.length} turnerAxes=turner-lift(${turnerLift.travelMm}mm)+turner-rotary(${turner.rotationRangeDeg}°) turner=90° bomDraft=${bomDraft.length} cardStats=${cardStats.stats.slice(0, 3).join('/')}`;
    });

    // --- 3. 点「应用到工程」→ 真实确认按钮 → 断言 3D + active.json ----------
    const applied = await step(3, 'apply-to-project', async () => {
      const clickedApply = await cdp.evaluate(`(() => {
        const button = document.querySelector('.acp-machine-card [data-apply-machine]');
        if (!button) return false;
        button.click();
        return true;
      })()`);
      if (!clickedApply) throw new Error('「应用到工程」按钮点不到');
      // 确认卡是真实 UI：点「允许一次」（不是注入 auto-confirm）。
      const confirms = await cdp.waitForConfirm(1, '写操作确认卡', 20_000);
      try {
        await cdp.waitFor(
          `(() => { const pill = document.querySelector('.acp-machine-card .acp-pill.is-ok'); return Boolean(pill && (pill.textContent || '').includes('已应用')); })()`,
          '方案卡片显示已应用',
          120_000,
          clickConfirm
        );
      } catch (error) {
        // 超时不能只说「等待超时」：把卡片/反馈/确认卡/工具卡都打出来，否则没法判断卡在哪
        const diagnosis = await cdp.evaluate(`(() => {
          const card = document.querySelector('.acp-machine-card');
          return {
            pill: card?.querySelector('.acp-pill')?.textContent ?? '(无)',
            pillOk: Boolean(card?.querySelector('.acp-pill.is-ok')),
            applyDisabled: card?.querySelector('[data-apply-machine]')?.disabled ?? null,
            feedback: (document.querySelector('#agentChatFeedback')?.textContent || '').slice(0, 300),
            confirmMask: Boolean(document.getElementById('acwConfirmMask')),
            toolCards: Array.from(document.querySelectorAll('.acp-chat-tool')).map((node) => (node.textContent || '').trim().slice(0, 160))
          };
        })()`);
        throw new Error(`${error.message}：${JSON.stringify(diagnosis)}`);
      }
      const activePath = join(userDataDir, 'machine', 'active.json');
      if (!existsSync(activePath)) throw new Error(`active.json 未落盘：${activePath}`);
      const active = JSON.parse(readFileSync(activePath, 'utf8'));
      const machineFile = join(userDataDir, 'machine', `${active.machineId}.json`);
      if (!existsSync(machineFile)) throw new Error(`机型方案未落盘：${machineFile}`);
      const stored = JSON.parse(readFileSync(machineFile, 'utf8'));
      const storedDesign = stored?.design ?? stored;
      const stationNames = (storedDesign?.config?.stations ?? []).map((entry) => (typeof entry === 'string' ? entry : entry?.name ?? entry?.id ?? ''));
      if (!stationNames.join(',').includes('转向工位')) throw new Error(`落盘方案缺少转向工位：${stationNames.join(',')}`);
      const turner = (storedDesign?.config?.actuators ?? []).find((entry) => entry?.id === 'turner-rotary');
      if (!turner) throw new Error('落盘方案缺少 turner-rotary 轴');

      // 3D 切到整机：打开联调抽屉，读真实场景统计（工位/执行机构/帧循环/WebGL）
      await cdp.evaluate(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelector('#agentDrawer [data-acp-close]')?.click();
        document.querySelector('#commissionEntryButton')?.click();
        await wait(700);
        return true;
      })()`);
      await cdp.waitFor(
        `(() => { const s = window.__Commission3D?.stats?.(); return s && s.stations >= 2 && s.ticks > 0 && s.webgl === true; })()`,
        '3D 整机场景就绪',
        45_000
      );
      const scene = await cdp.evaluate(`window.__Commission3D.stats()`);
      const config = await cdp.evaluate(`(() => {
        const cfg = window.AutomationCadCommission.getMachineConfig();
        const stations = Array.isArray(cfg.stations) ? cfg.stations : [];
        return {
          name: cfg.name,
          // 机型配置里的工位是字符串数组（'工位1'/'转向工位'），不是对象
          stations: stations.map((entry) => (typeof entry === 'string' ? entry : entry?.name ?? entry?.id ?? '')),
          actuators: (cfg.actuators ?? []).map((a) => a?.id)
        };
      })()`);
      if (!config.stations.join(',').includes('转向工位')) {
        throw new Error(`3D 里的机型不是含转向工位的整机：${config.stations.join(',')}`);
      }
      if (!config.actuators.includes('turner-rotary')) throw new Error('3D 机型缺少 turner-rotary');
      await cdp.evaluate(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelector('#commissionDrawer [data-acp-close]')?.click();
        await wait(300);
        return true;
      })()`);
      return `machineId=${active.machineId} stations=${config.stations.join(',')} scene=${scene.stations}/${scene.actuators}/${scene.sensors} ticks=${scene.ticks} webgl=${scene.webgl} confirms=${confirms}`;
    });

    // --- 4. 参数化几何（build_machine_model）→ 断言零件数与 turner-* -------
    const geometry = await step(4, 'build-machine-model', async () => {
      const before = await cdp.evaluate(`document.querySelectorAll('.acp-chat-tool').length`);
      await sendMessage(cdp, '按当前机型生成整机实体模型（参数化几何），需求同前：' + BRIEF);
      await cdp.waitFor(
        `document.querySelectorAll('.acp-chat-tool').length > ${before}`,
        'build_machine_model 工具卡出现',
        60_000,
        clickConfirm
      );
      await cdp.waitFor(`Boolean(document.getElementById('cadPartCount'))`, 'CAD 覆盖层就绪', 30_000);
      const payload = await llm.waitForTool('build_machine_model', 20_000);
      const body = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
      if (payload?.ok === false) throw new Error(`build_machine_model 失败：${payload.message ?? payload.code}`);
      const parts = Number(body?.parts ?? 0);
      const loadedParts = Number(body?.loadedParts ?? 0);
      if (!(parts >= 40)) throw new Error(`零件数 ${parts} < 40`);
      // 结构 BOM 现在 25 行（窄带并联 + 顶升单元把零件数从 28 抬到 85），
      // 工具结果超过 20 行会被 trim.ts 裁成 {items,total,truncated}——两种形状都要认。
      const bomRaw = body?.bom;
      const bomRows = Array.isArray(bomRaw) ? bomRaw : Array.isArray(bomRaw?.items) ? bomRaw.items : [];
      const bomTotal = Number(Array.isArray(bomRaw) ? bomRaw.length : bomRaw?.total ?? bomRows.length);
      const turnerRows = bomRows.filter((row) => /转向|回转支承|台面滚轮/.test(String(row?.name ?? '')));
      if (turnerRows.length === 0) throw new Error('结构 BOM 里没有转向件');
      const partNames = turnerRows.map((row) => row.name).join('/');
      if (loadedParts < 40) throw new Error(`视口只装配了 ${loadedParts} 件（期望 ≥40）`);
      await cdp.waitFor(`(Number(document.getElementById('cadPartCount')?.textContent || 0) >= 40)`, '零件列表 ≥40', 30_000);
      const uiPartCount = await cdp.evaluate(`Number(document.getElementById('cadPartCount').textContent || 0)`);
      return `parts=${parts} loaded=${loadedParts} ui=${uiPartCount} bomRows=${bomRows.length}(total=${bomTotal}) turnerRows=${turnerRows.length} (${partNames})`;
    });

    // --- 5. PLC 生成 → 断言 io-map.csv 含 ST-TURN-ROT ----------------------
    const plc = await step(5, 'run-plc-generate', async () => {
      const before = await cdp.evaluate(`document.querySelectorAll('.acp-chat-tool').length`);
      await sendMessage(cdp, '按当前机型生成 PLC 程序并落盘（含 IO 点位映射），需求：' + BRIEF);
      await cdp.waitFor(
        `document.querySelectorAll('.acp-chat-tool').length > ${before}`,
        'run_plc_generate 工具卡出现',
        90_000,
        clickConfirm
      );
      await cdp.waitFor(
        `(() => {
          const cards = Array.from(document.querySelectorAll('.acp-chat-tool'));
          const last = cards[cards.length - 1];
          return Boolean(last && /run_plc_generate/.test(last.textContent || '') && /成功|失败/.test(last.textContent || ''));
        })()`,
        'PLC 生成结果卡完成',
        120_000,
        clickConfirm
      );
      const plcResult = await llm.waitForTool('run_plc_generate', 20_000);
      if (plcResult && plcResult.ok === false) {
        // 预检拒签是产品行为（安全回路/到位传感器缺失时按设计不落盘），不是脚本失败：
        // 如实记账后继续；此时 io-map.csv 仍由 apply_machine_design(withPlc) 落过盘。
        const failure = plcResult.error && typeof plcResult.error === 'object' ? plcResult.error : plcResult;
        const code = String(failure.code ?? plcResult.code ?? '?');
        const reason = String(
          failure.message ?? plcResult.message ?? failure.reason ?? JSON.stringify(plcResult).slice(0, 300)
        );
        blocked.push(`run_plc_generate 预检拒签 code=${code}：${reason}`);
        console.log(`MACHINE_E2E_PLC_BLOCKED code=${code} message=${reason}`);
      }
      const plcRoot = join(userDataDir, 'exports', 'plc');
      if (!existsSync(plcRoot)) throw new Error(`PLC 导出目录不存在：${plcRoot}`);
      const csvFiles = [];
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) walk(path);
          else if (entry.name === 'io-map.csv') csvFiles.push(path);
        }
      };
      walk(plcRoot);
      if (csvFiles.length === 0) throw new Error('没有找到 io-map.csv');
      const latest = csvFiles.map((path) => ({ path, mtime: statSync(path).mtimeMs })).sort((a, b) => b.mtime - a.mtime)[0];
      const csv = readFileSync(latest.path, 'utf8');
      if (!csv.includes('ST-TURN-ROT')) throw new Error('io-map.csv 里没有 ST-TURN-ROT');
      const zips = [];
      const walkZip = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) walkZip(path);
          else if (entry.name.endsWith('.zip')) zips.push(path);
        }
      };
      walkZip(join(userDataDir, 'exports'));
      return `io-map=${latest.path} ST-TURN-ROT=1 zips=${zips.length}`;
    });

    // --- 6. export_files + zip/STEP 真实存在 ------------------------------
    const exports = await step(6, 'export-files', async () => {
      const before = await cdp.evaluate(`document.querySelectorAll('.acp-chat-tool').length`);
      await sendMessage(cdp, '把当前装配体导出为 glb 文件（文件名 pv-conveyor，覆盖同名），需求：' + BRIEF);
      await cdp.waitFor(
        `document.querySelectorAll('.acp-chat-tool').length > ${before}`,
        'export_files 工具卡出现',
        90_000,
        clickConfirm
      );
      await cdp.waitFor(
        `(() => {
          const cards = Array.from(document.querySelectorAll('.acp-chat-tool'));
          const last = cards[cards.length - 1];
          return Boolean(last && /export_files/.test(last.textContent || '') && /成功|失败/.test(last.textContent || ''));
        })()`,
        '导出结果卡完成',
        120_000,
        clickConfirm
      );
      const exportsRoot = join(userDataDir, 'exports');
      const glbs = [];
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) walk(path);
          else if (entry.name.endsWith('.glb')) glbs.push(path);
        }
      };
      if (!existsSync(exportsRoot)) throw new Error(`导出目录不存在：${exportsRoot}`);
      walk(exportsRoot);
      if (glbs.length === 0) throw new Error('export_files 没有产出 glb');
      const glb = glbs.map((path) => ({ path, bytes: statSync(path).size })).sort((a, b) => b.bytes - a.bytes)[0];
      if (glb.bytes <= 0) throw new Error(`glb 为空：${glb.path}`);
      console.log(`MACHINE_E2E_EXPORT_GLB path=${glb.path} bytes=${glb.bytes}`);

      // run_plc_generate 的真实 ZIP
      const zips = [];
      const walkZip = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) walkZip(path);
          else if (entry.name.endsWith('.zip')) zips.push(path);
        }
      };
      walkZip(exportsRoot);
      const zip = zips.length > 0
        ? zips.map((path) => ({ path, bytes: statSync(path).size })).sort((a, b) => b.bytes - a.bytes)[0]
        : null;
      if (zip) {
        if (zip.bytes <= 0) throw new Error(`PLC zip 为空：${zip.path}`);
        console.log(`MACHINE_E2E_EXPORT_ZIP path=${zip.path} bytes=${zip.bytes}`);
      } else {
        // PLC ZIP 由 run_plc_generate 产出；预检拒签时不落盘（见步骤 5 的 BLOCKED）。
        blocked.push('PLC ZIP 未产出：run_plc_generate 预检拒签');
        console.log('MACHINE_E2E_EXPORT_ZIP none reason=plc-precheck-rejected');
      }

      // 参数化内核产出的 STEP（在 e2e userData 里，路径由步骤 4 的工程记录指向）
      const steps = [];
      const walkStep = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) walkStep(path);
          else if (/\.(step|stp)$/i.test(entry.name)) steps.push(path);
        }
      };
      walkStep(userDataDir);
      if (steps.length === 0) throw new Error('没有 STEP 产物');
      const stepFile = steps.map((path) => ({ path, bytes: statSync(path).size })).sort((a, b) => b.bytes - a.bytes)[0];
      if (stepFile.bytes <= 0) throw new Error(`STEP 为空：${stepFile.path}`);
      console.log(`MACHINE_E2E_EXPORT_STEP path=${stepFile.path} bytes=${stepFile.bytes}`);
      return `glb=${glb.bytes}B zip=${zip ? `${zip.bytes}B` : 'none'} step=${stepFile.bytes}B`;
    });

    // --- 7. 干涉初筛（包围盒）→ 期望 0 对 ---------------------------------
    const interference = await step(7, 'interference-screen', async () => {
      const before = await cdp.evaluate(`document.querySelectorAll('.acp-chat-tool').length`);
      await sendMessage(cdp, '对当前装配体做干涉检查，看看转向工位和既有线体有没有干涉');
      await cdp.waitFor(
        `document.querySelectorAll('.acp-chat-tool').length > ${before}`,
        'run_interference_check 工具卡出现',
        60_000
      );
      await cdp.waitFor(
        `(() => {
          const cards = Array.from(document.querySelectorAll('.acp-chat-tool'));
          const last = cards[cards.length - 1];
          return Boolean(last && /run_interference_check/.test(last.textContent || '') && /成功|失败/.test(last.textContent || ''));
        })()`,
        '干涉检查结果卡完成',
        90_000
      );
      const payload = await llm.waitForTool('run_interference_check', 20_000);
      const body = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
      const items = Array.isArray(body?.items) ? body.items : [];
      const hits = Number(body?.hits ?? items.length);
      if (!Number.isFinite(hits) || hits < 0) throw new Error(`干涉结果无法解析：${JSON.stringify(payload).slice(0, 300)}`);
      // 两种引擎口径不同，别混着下结论：
      // - 设计级 screenInterference（带生成器 joints）对「已声明的结构连接」豁免重叠 → 基线 0 对重叠、
      //   35 对贴面（其中 3 对是转向件与 st2-plate/turner 自身叠装，未声明但只是贴面，不是互穿）；
      // - 视口级 mech/interference.ts 只按包围盒判重叠、不认 joints，所以线体自身的结构互穿
      //   （滚筒穿皮带、纵梁穿横撑）都会列出来。
      // 因此这里判「新件不能和既有件互穿」：转向件参与的命中必须是 0。
      const turnerPattern = /转向|回转支承|台面滚轮/;
      const turnerHits = items.filter((item) => turnerPattern.test(String(item.a ?? '')) || turnerPattern.test(String(item.b ?? '')));
      const sample = items.slice(0, 6).map((item) => `${item.a}×${item.b}(${Math.round(Number(item.volumeApprox ?? 0))}mm³)`);
      console.log(`MACHINE_E2E_INTERFERENCE total=${hits} turner=${turnerHits.length} pairs=${items.length}`);
      console.log(`MACHINE_E2E_INTERFERENCE_SAMPLE ${sample.join(' | ')}`);
      if (turnerHits.length > 0) {
        const pairs = turnerHits.slice(0, 8).map((item) => `${item.a}×${item.b} ${item.severity ?? ''} ${Math.round(Number(item.volumeApprox ?? 0))}mm³`);
        throw new Error(`转向件与既有件互穿 ${turnerHits.length} 对：${pairs.join(', ')}`);
      }
      if (hits === 0) return 'hits=0 turnerHits=0（设计级与视口级都是 0）';
      return `turnerHits=0，视口级结构互穿 ${hits} 对（不认 joints，见 MACHINE_E2E_INTERFERENCE_SAMPLE；设计级基线 0 重叠/35 贴面）`;
    });

    // --- 8. 三张截图（sha256 互异）----------------------------------------
    const shots = await step(8, 'screenshots', async () => {
      const names = [];
      // 8a. 整机 3D（含转向工位）：CAD 覆盖层 + 缩放到适合
      await cdp.evaluate(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelector('#agentDrawer [data-acp-close]')?.click();
        await wait(200);
        document.querySelector('#cadEntryButton')?.click();
        await wait(900);
        document.querySelector('[data-cad-action="fit"]')?.click();
        await wait(900);
        return true;
      })()`);
      await cdp.waitFor(`Boolean(document.querySelector('#automationCadOverlay') && !document.querySelector('#automationCadOverlay').hidden)`, 'CAD 覆盖层可见', 20_000);
      // 图里必须真的是整机：零件列表有 ≥40 行，右下的空状态已收起来
      await cdp.waitFor(`(document.querySelectorAll('#cadParts .cad-part').length >= 40) || (Number(document.getElementById('cadPartCount')?.textContent || 0) >= 40)`, '3D 视口里装着 ≥40 件', 20_000);
      const emptyHidden = await cdp.evaluate(`document.getElementById('cadEmpty')?.hidden !== false`);
      if (!emptyHidden) throw new Error('CAD 空状态还盖在视口上，截出来的会是空页面');
      names.push(await capture(cdp, '23-pv-01-3d.png', '含转向工位的整机 3D'));

      // 8b. 联动面板（参数化输送机没有 moving 轴 → 如实截「不可用 + 原因」）
      const linkage = await cdp.evaluate(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelector('#agentEntryButton')?.click();
        await wait(400);
        const button = document.querySelector('[data-linkage-machine]');
        if (!button) return { opened: false, reason: '卡片上没有「联动调试」按钮' };
        button.click();
        for (let index = 0; index < 60; index += 1) {
          await wait(250);
          const slot = document.querySelector('.acp-linkage-slot');
          if (slot && !slot.querySelector('.acp-linkage-loading')) break;
        }
        const slot = document.querySelector('.acp-linkage-slot');
        const panel = slot?.querySelector('.acp-step-table, [data-linkage-step]');
        const play = slot?.querySelector('[data-linkage-play]');
        return {
          opened: true,
          text: (slot?.textContent || '').slice(0, 240),
          hasSteps: Boolean(panel),
          playDisabled: play ? play.disabled : null,
          error: Boolean(slot?.querySelector('.acp-linkage-error'))
        };
      })()`);
      await cdp.evaluate(`(async () => { const wait = (ms) => new Promise((r) => setTimeout(r, ms)); document.querySelector('.acp-linkage-slot')?.scrollIntoView({ block: 'center' }); await wait(500); return true; })()`);
      names.push(await capture(cdp, '23-pv-02-linkage.png', '联动调试面板（如实显示可用性）'));
      console.log(`MACHINE_E2E_LINKAGE opened=${linkage?.opened} steps=${linkage?.hasSteps} playDisabled=${linkage?.playDisabled} error=${linkage?.error} text=${JSON.stringify(String(linkage?.text ?? '').replace(/\s+/g, ' ').slice(0, 160))}`);

      // 8c. 导出结果面板：CAD 覆盖层的 PLC IO 点位（来自 apply 落盘的 io-map.csv，
      // 含 ST-TURN-ROT）。上一张是智能体抽屉里的联动面板，这里换成 CAD 覆盖层，
      // 两张是真正不同的界面——不是靠滚动制造差异（实测滚动不会换帧）。
      await cdp.evaluate(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelector('#agentDrawer [data-acp-close]')?.click();
        await wait(250);
        document.querySelector('#cadEntryButton')?.click();
        await wait(700);
        document.querySelector('[data-cad-side="io"]')?.click();
        await wait(500);
        return true;
      })()`);
      await cdp.waitFor(
        `(() => {
          const pane = document.getElementById('cadIoPane');
          return Boolean(pane && !pane.hidden && (pane.textContent || '').includes('ST-TURN-ROT'));
        })()`,
        'PLC IO 点位面板（含 ST-TURN-ROT）',
        20_000
      );
      const ioRows = await cdp.evaluate(`document.querySelectorAll('#cadIoRows tbody tr').length`);
      names.push(await capture(cdp, '23-pv-03-exports.png', '导出结果：PLC IO 点位（io-map.csv 含 ST-TURN-ROT）'));
      console.log(`MACHINE_E2E_IO_PANEL rows=${ioRows} hasTurnPoint=true`);
      return `shots=${names.join(',')}`;
    });


    // =====================================================================
    // 第二台机器：顶升移载（直角移载，板不转）
    //   建机 → 两条轴/四个联锁信号 → parts 数 → BOM 行 → PLC 预检 blocked=0
    //   → io-map 的 4 个信号 → 三态干涉 confirmed=0 → 3D 截图
    // =====================================================================
    const transferDesign = await step(9, 'transfer-design', async () => {
      await cdp.evaluate(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        document.getElementById('automationCadOverlay')?.setAttribute('hidden', '');
        window.AutomationCadViewer?.close();
        window.AutomationCadParametric?.close();
        // 只在抽屉**确实是关的**时候点入口按钮：入口是开关，抽屉已开时再点会把它关掉
        // （实测抽屉 hidden 时 qSA 仍能查到卡片，于是「点了按钮 = 关掉抽屉」这种 bug 不会立刻暴露）
        const drawer = document.getElementById('agentDrawer');
        if (!drawer || drawer.hidden) document.querySelector('#agentEntryButton')?.click();
        await wait(600);
        return true;
      })()`);
      await sendMessage(cdp, `再做一台顶升移载输送机（板不转、沿 +Y 送到下游）：${TRANSFER_BRIEF}`);
      // 等「这次 design_machine 调用的方案卡」而不是「卡片数变多」：两台机器的机型名一模一样
      //（都是「1 工位输送机（方案草案）」），且抽屉重绘会把旧卡片换掉，按数量判一定误判。
      // 判据取 data-apply-machine="<callId>"——只有这一条调用自己的卡片才会有这个按钮。
      try {
        await cdp.waitFor(
          `(() => {
            const calls = Array.from(document.querySelectorAll('.acp-chat-tool'));
            const mine = calls.filter((node) => (node.textContent || '').includes('顶升移载'));
            const callId = mine.length > 0 ? mine[mine.length - 1].getAttribute('data-tool-call-id') : '';
            if (!callId) return false;
            return Boolean(document.querySelector('[data-apply-machine="' + CSS.escape(callId) + '"]'));
          })()`,
          '移载方案卡出现',
          120_000,
          clickConfirm
        );
      } catch (error) {
        // 超时不能只说「等待超时」：把卡片/工具卡/反馈/抽屉状态都打出来
        const diagnosis = await cdp.evaluate(`(() => {
          const cards = Array.from(document.querySelectorAll('.acp-machine-card'));
          return {
            cards: cards.length,
            titles: cards.map((node) => (node.querySelector('.acp-machine-title')?.textContent || '').trim()).slice(-3),
            toolCards: Array.from(document.querySelectorAll('.acp-chat-tool')).slice(-3)
              .map((node) => (node.textContent || '').trim().slice(0, 200)),
            messages: document.querySelectorAll('.acp-msg, .acp-chat-msg, [data-acp-message]').length,
            chatChars: (document.getElementById('agentChatLog')?.textContent || '').length,
            feedback: (document.getElementById('agentChatFeedback')?.textContent || '').slice(0, 300),
            drawerHidden: document.getElementById('agentDrawer')?.hidden ?? null,
            cardParseFail: window.__MACHINE_CARD_LAST_FAIL__ ?? null,
            lastDesignArgs: (() => {
              const cards = Array.from(document.querySelectorAll('.acp-chat-tool'));
              const last = cards[cards.length - 1];
              return last ? (last.querySelector('.acp-pack-meta')?.textContent || '').slice(0, 200) : null;
            })(),
            sendDisabled: document.getElementById('agentChatSend')?.disabled ?? null,
            inputValue: (document.getElementById('agentChatInput')?.value || '').slice(0, 80)
          };
        })()`);
        throw new Error(`${error.message}：${JSON.stringify(diagnosis)}`);
      }
      const payload = await llm.waitForTool('design_machine', 20_000);
      const body = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
      const design = body?.design ?? body;
      const stations = (design?.config?.stations ?? []).map((entry) => (typeof entry === 'string' ? entry : entry?.name ?? ''));
      const actuators = design?.config?.actuators ?? [];
      const sensors = design?.config?.sensors ?? [];
      const lift = actuators.find((entry) => entry?.id === 'transfer-lift');
      const push = actuators.find((entry) => entry?.id === 'transfer-push');
      const bound = (point) => sensors.find((entry) => entry?.point === point)?.part;
      if (!stations.join(',').includes('移载工位')) throw new Error(`方案里没有「移载工位」：${stations.join(',')}`);
      if (!lift) throw new Error(`actuators 里没有 transfer-lift：${actuators.map((a) => a?.id).join(',')}`);
      if (!push) throw new Error(`actuators 里没有 transfer-push：${actuators.map((a) => a?.id).join(',')}`);
      // 顶升行程 70 = 板底要越过挡边顶 911 至少 4 mm（旧值 60 时板底 905 < 911，板推不出去）
      if (Number(lift.travelMm) !== 70) throw new Error(`transfer-lift 行程异常：${lift.travelMm}（应为 70）`);
      if (!(Number(push.travelMm) > 1000)) throw new Error(`transfer-push 行程异常：${push.travelMm}（应 = 板宽 800 + 结构间隙 220 + 余量 120）`);
      if (!((push.position?.[1] ?? 0) > 0)) throw new Error(`transfer-push 方向不是 +Y：${JSON.stringify(push.position)}`);
      if (bound('DI-TRANSFER-END') !== 'transfer-push') throw new Error(`DI-TRANSFER-END 没绑 transfer-push：${bound('DI-TRANSFER-END')}`);
      if (bound('ST-TRANSFER-LIFT-UP') !== 'transfer-lift') throw new Error(`ST-TRANSFER-LIFT-UP 没绑 transfer-lift：${bound('ST-TRANSFER-LIFT-UP')}`);
      if (bound('DI-DOWNSTREAM-ALLOW') !== '移载工位') throw new Error(`DI-DOWNSTREAM-ALLOW 应绑工位：${bound('DI-DOWNSTREAM-ALLOW')}`);
      const ioPoints = (design?.config?.ioPoints ?? []).map((item) => item?.point);
      for (const point of ['DO-TRANSFER-READY', 'DO-TRANSFER-DONE']) {
        if (!ioPoints.includes(point)) throw new Error(`config.ioPoints 缺 ${point}：${ioPoints.join(',')}`);
      }
      return `stations=${stations.join(',')} lift=${lift.travelMm}mm push=${push.travelMm}mm pos=${JSON.stringify(push.position)} ioPoints=${ioPoints.join(',')} sensors=${sensors.length}`;
    });

    const transferApplied = await step(10, 'transfer-apply', async () => {
      // 按 callId 精确点「这次移载方案」的按钮：机型名两台机器一样，靠「最后一张卡」会点错
      const clicked = await cdp.evaluate(`(() => {
        const calls = Array.from(document.querySelectorAll('.acp-chat-tool'))
          .filter((node) => (node.textContent || '').includes('顶升移载'));
        const callId = calls.length > 0 ? calls[calls.length - 1].getAttribute('data-tool-call-id') : '';
        if (!callId) return false;
        const button = document.querySelector('[data-apply-machine="' + CSS.escape(callId) + '"]');
        if (!button) return false;
        button.click();
        return true;
      })()`);
      if (!clicked) throw new Error('移载方案卡上点不到「应用到工程」');
      const confirms = await cdp.waitForConfirm(1, '写操作确认卡', 20_000);
      try {
        await cdp.waitFor(
          `(() => {
            const calls = Array.from(document.querySelectorAll('.acp-chat-tool'))
              .filter((node) => (node.textContent || '').includes('顶升移载'));
            const callId = calls.length > 0 ? calls[calls.length - 1].getAttribute('data-tool-call-id') : '';
            if (!callId) return false;
            const card = document.querySelector('[data-machine-card="' + CSS.escape(callId) + '"]');
            const pill = card?.querySelector('.acp-pill.is-ok');
            return Boolean(pill && (pill.textContent || '').includes('已应用'));
          })()`,
          '移载方案显示已应用',
          120_000,
          clickConfirm
        );
      } catch (error) {
        const diagnosis = await cdp.evaluate(`(() => {
          const calls = Array.from(document.querySelectorAll('.acp-chat-tool'));
          return {
            lastToolCards: calls.slice(-3).map((node) => (node.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 420)),
            applyButtons: Array.from(document.querySelectorAll('[data-apply-machine]')).map((node) => ({
              id: node.getAttribute('data-apply-machine'), disabled: node.disabled, text: node.textContent.trim()
            })),
            pills: Array.from(document.querySelectorAll('.acp-machine-card .acp-pill')).map((node) => node.textContent.trim()),
            feedback: (document.getElementById('agentChatFeedback')?.textContent || '').slice(0, 400),
            confirmMask: Boolean(document.getElementById('acwConfirmMask'))
          };
        })()`);
        throw new Error(`${error.message}：${JSON.stringify(diagnosis)}`);
      }
      const activePath = join(userDataDir, 'machine', 'active.json');
      const active = JSON.parse(readFileSync(activePath, 'utf8'));
      const stored = JSON.parse(readFileSync(join(userDataDir, 'machine', `${active.machineId}.json`), 'utf8'));
      const storedDesign = stored?.design ?? stored;
      const config = storedDesign?.config ?? {};
      const ids = (config.actuators ?? []).map((entry) => entry?.id);
      if (!ids.includes('transfer-lift') || !ids.includes('transfer-push')) {
        throw new Error(`落盘 config 缺移载轴：${ids.join(',')}`);
      }
      if (config.conveyor?.transferPresent !== true) throw new Error('落盘 config.conveyor 缺 transferPresent（几何会回落普通线）');
      const storedSensors = (config.sensors ?? []).map((entry) => entry?.point);
      for (const point of TRANSFER_SIGNALS) {
        if (!storedSensors.includes(point) && !(config.ioPoints ?? []).some((entry) => entry?.point === point)) {
          throw new Error(`落盘 config 缺信号 ${point}`);
        }
      }
      return `machineId=${active.machineId} actuators=${ids.join(',')} confirms=${confirms} signals=${TRANSFER_SIGNALS.length}`;
    });

    const transferGeometry = await step(11, 'transfer-build-model', async () => {
      await sendMessage(cdp, `按当前机型生成整机实体模型（参数化几何），需求同前：${TRANSFER_BRIEF}`);
      // 按「内容」等而不是按「卡片数量」等：抽屉重绘会把旧卡片换掉，数量增长不是可靠判据。
      // 移载这台机器的 build_machine_model 参数里带「顶升移载」，转向那台不带。
      await cdp.waitFor(
        `Array.from(document.querySelectorAll('.acp-chat-tool')).some((node) => {
          const text = node.textContent || '';
          return /build_machine_model/.test(text) && /顶升移载/.test(text) && /成功|失败/.test(text);
        })`,
        'build_machine_model 工具卡出现',
        120_000,
        clickConfirm
      );
      const payload = await llm.waitForTool('build_machine_model', 30_000);
      const body = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
      if (payload?.ok === false) throw new Error(`build_machine_model 失败：${payload.message ?? payload.code}`);
      const items = Number(body?.parts ?? 0);
      const loaded = Number(body?.loadedParts ?? 0);
      if (items < 100) throw new Error(`移载机型零件数 ${items} < 100（普通线 61 件 + 移载单元 50 件）`);
      if (loaded < 100) throw new Error(`视口只装配了 ${loaded} 件（期望 ≥100）`);
      const bomRaw = body?.bom;
      const bomRows = Array.isArray(bomRaw) ? bomRaw : Array.isArray(bomRaw?.items) ? bomRaw.items : [];
      const rows = bomRows.filter((row) => /移载|对接段/.test(String(row?.name ?? '')));
      if (rows.length < 6) throw new Error(`结构 BOM 里移载件不足：${rows.map((row) => row.name).join('/')}`);
      return `parts=${items} loaded=${loaded} bomRows=${bomRows.length} transferRows=${rows.length} (${rows.slice(0, 5).map((row) => row.name).join(' / ')})`;
    });

    const transferPlc = await step(12, 'transfer-plc', async () => {
      await sendMessage(cdp, `按当前机型生成 PLC 程序并落盘（含 IO 点位映射），需求：${TRANSFER_BRIEF}`);
      // 用 namePrefix=pv-transfer 区分两台机器的 PLC 结果卡
      await cdp.waitFor(
        `Array.from(document.querySelectorAll('.acp-chat-tool')).some((node) => {
          const text = node.textContent || '';
          return /run_plc_generate/.test(text) && /pv-transfer/.test(text) && /成功|失败/.test(text);
        })`,
        'PLC 生成结果卡完成',
        150_000,
        clickConfirm
      );
      const payload = await llm.waitForTool('run_plc_generate', 20_000);
      if (payload?.ok === false) {
        const failure = payload.error && typeof payload.error === 'object' ? payload.error : payload;
        throw new Error(`移载机型 PLC 预检拒签 code=${failure.code ?? '?'}：${failure.message ?? JSON.stringify(payload).slice(0, 200)}`);
      }
      const blocked = Array.isArray(payload?.precheck?.errors) ? payload.precheck.errors.length : 0;
      if (blocked !== 0) throw new Error(`移载机型 PLC 预检 blocked=${blocked}：${JSON.stringify(payload.precheck.errors).slice(0, 300)}`);

      // io-map.csv：4 个联锁信号逐个可见，且方向正确（DO=输出 / DI=输入）
      const plcRoot = join(userDataDir, 'exports', 'plc');
      const csvFiles = [];
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) walk(path);
          else if (entry.name === 'io-map.csv') csvFiles.push(path);
        }
      };
      walk(plcRoot);
      if (csvFiles.length === 0) throw new Error('移载机型没有产出 io-map.csv');
      const latest = csvFiles.map((path) => ({ path, mtime: statSync(path).mtimeMs })).sort((a, b) => b.mtime - a.mtime)[0];
      const csv = readFileSync(latest.path, 'utf8');
      const lines = csv.split(/\r?\n/);
      const rows = {};
      for (const line of lines) {
        const [point, address, direction] = line.split(',');
        if (point) rows[point.trim()] = { address, direction };
      }
      for (const point of TRANSFER_SIGNALS) {
        if (!rows[point]) throw new Error(`io-map 里没有 ${point}`);
        const expect = point.startsWith('DO') ? '输出' : '输入';
        if (rows[point].direction !== expect) throw new Error(`${point} 方向应为 ${expect}，实际 ${rows[point].direction}`);
      }
      // 四个信号必须真的进控制逻辑（审计点 2：只有点位、没有逻辑 = 空壳）。
      // 读这次落盘的工程目录（最新 FC_AutoSequence.st 所在目录）逐条核对，
      // 而不是看变量表里有没有这四行。
      const stFiles = [];
      const walkSt = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) walkSt(path);
          else if (entry.name === 'FC_AutoSequence.st') stFiles.push(path);
        }
      };
      walkSt(plcRoot);
      if (stFiles.length === 0) throw new Error('PLC 导出里没有 FC_AutoSequence.st');
      const latestSt = stFiles.map((path) => ({ path, mtime: statSync(path).mtimeMs })).sort((a, b) => b.mtime - a.mtime)[0];
      const plcDir = dirname(dirname(latestSt.path));
      const readme = readFileSync(join(plcDir, 'README.md'), 'utf8');
      const stepCount = Number((readme.match(/- 自动序列步数：(\d+)/) ?? [])[1] ?? 0);
      if (!(stepCount > 0)) {
        throw new Error(`移载机型的 FC_AutoSequence 是空壳：README 里 自动序列步数=${stepCount}`);
      }
      const autoSeq = readFileSync(latestSt.path, 'utf8');
      const logicChecks = [
        ['ALLOW 约束启动', /IF _StartEdge\.Q AND NOT SafeStop AND NOT Abort AND "DB_IO"\.[^\n]+ THEN/],
        ['END 到位才置 DONE', /STEP_HANDSHAKE:[\s\S]*?IF "DB_IO"\.[^\n]+ THEN\n\s+_HandshakeDone := TRUE;/],
        ['DONE 接锁存位', /移载完成 := _HandshakeDone;/],
        ['READY 就绪判据', /移载就绪 := NOT SafeStop AND NOT SeqTimeout AND \(AlarmWord = 16#0000\)/]
      ];
      const logicHits = [];
      for (const [label, pattern] of logicChecks) {
        if (!pattern.test(autoSeq)) throw new Error(`FC_AutoSequence 里找不到「${label}」逻辑（信号没进控制）`);
        logicHits.push(label);
      }
      const handshakeRefs = (autoSeq.match(/"DB_IO"\.[^\s:=]+/g) ?? []).length;
      return `blocked=0 steps=${stepCount} handshake=${logicHits.length}/4 [${logicHits.join(' / ')}] ST点位引用=${handshakeRefs}处 io-map=${latest.path} signals=${TRANSFER_SIGNALS.map((p) => `${p}@${rows[p].address}`).join(',')}`;
    });

    const transferStates = await step(13, 'transfer-interference-states', async () => {
      await sendMessage(cdp, '对当前机型做四态干涉检查（rest/lift/sweep/push），看移载机构和既有线体有没有干涉');
      await cdp.waitFor(
        `Array.from(document.querySelectorAll('.acp-chat-tool')).some((node) => {
          const text = node.textContent || '';
          return /run_interference_check/.test(text) && /push/.test(text) && /成功|失败/.test(text);
        })`,
        '三态干涉结果卡完成',
        150_000
      );
      const payload = await llm.waitForTool('run_interference_check', 20_000);
      if (payload?.ok === false) throw new Error(`三态干涉失败：${payload.code} ${payload.message ?? ''}`);
      const states = payload?.states ?? {};
      const detail = [];
      for (const name of ['rest', 'lift', 'sweep', 'push']) {
        const entry = states[name];
        if (!entry) throw new Error(`四态里没有 ${name}：${Object.keys(states).join(',')}`);
        detail.push(`${name}=${entry.confirmedHits}/${entry.screenHits}/${entry.mm3Confirmed}`);
        if (Number(entry.confirmedHits) !== 0) {
          throw new Error(`${name} 态有确认干涉 ${entry.confirmedHits} 对：${JSON.stringify(entry.items ?? []).slice(0, 400)}`);
        }
        if (Number(entry.screenHits) !== 0) {
          throw new Error(`${name} 态有待复核对 ${entry.screenHits} 对：${JSON.stringify(entry.items ?? []).slice(0, 400)}`);
        }
      }
      if (payload?.push?.actuatorId !== 'transfer-push') {
        throw new Error(`push 态没用移载轴：${JSON.stringify(payload?.push ?? null).slice(0, 200)}`);
      }
      return `confirmed=0/0/0/0 (rest/lift/sweep/push) axis=${payload.push.actuatorId} stroke=${payload.push.strokeMm}mm ${detail.join(' ')}`;
    });

    const transferShot = await step(14, 'transfer-screenshot', async () => {
      await cdp.evaluate(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        document.querySelector('#agentDrawer [data-acp-close]')?.click();
        await wait(250);
        document.querySelector('#cadEntryButton')?.click();
        await wait(900);
        document.querySelector('[data-cad-action="fit"]')?.click();
        await wait(1200);
        return true;
      })()`);
      await cdp.waitFor(`Boolean(document.querySelector('#automationCadOverlay') && !document.querySelector('#automationCadOverlay').hidden)`, 'CAD 覆盖层可见', 20_000);
      await cdp.waitFor(`(Number(document.getElementById('cadPartCount')?.textContent || 0) >= 100)`, '3D 视口里装着 ≥100 件', 30_000);
      const name = await capture(cdp, '23-pv-04-transfer-3d.png', '顶升移载整机 3D（主线上方横向移载机构 + 下游对接段）');
      const partCount = await cdp.evaluate(`Number(document.getElementById('cadPartCount').textContent || 0)`);
      return `shot=${name} parts=${partCount}`;
    });

    const shotsCheck = checkShotHashes();
    console.log(`MACHINE_E2E_SHOTS ${shotsCheck}`);
    for (const item of blocked) console.log(`MACHINE_E2E_BLOCKED ${item}`);
    console.log(`MACHINE_E2E_DONE steps=${stepsOk} failed=0 blocked=${blocked.length} userData=${userDataDir} shots=${shotDir}`);
    void design; void cardState; void applied; void geometry; void plc; void exports; void interference; void shots;
    void transferDesign; void transferApplied; void transferGeometry; void transferPlc; void transferStates; void transferShot;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`MACHINE_E2E_ABORT ${message}`);
    failedReason = failedReason ?? message;
  } finally {
    try { cdp?.close(); } catch { /* ignore */ }
    await stopElectron(electron);
    await new Promise((resolveClose) => llm.server.close(resolveClose));
    // 默认**保留** userData：导出物、active.json、io-map.csv 就是验收证据，
    // 删掉就没法 `ls -l` 复核了。要清干净用 MACHINE_E2E_CLEAN=1（或 MACHINE_E2E_KEEP=0）。
    const clean = process.env.MACHINE_E2E_CLEAN === '1';
    if (clean) rmSync(userDataDir, { recursive: true, force: true });
    else console.error(`MACHINE_E2E_USERDATA_KEPT ${userDataDir}（MACHINE_E2E_CLEAN=1 可在跑完时删除）`);
  }
  process.exit(failedReason ? 1 : 0);
}

/**
 * 停掉整棵进程树：xvfb-run（组长）→ electron → 渲染/GPU 子进程 + Xvfb。
 * 只 kill 子进程本身会留下孤儿，下一轮 E2E 和 `npm test` 都会被它们拖慢。
 */
async function stopElectron(child) {
  if (!child || child.exitCode !== null) return;
  const signal = (sig) => {
    try { process.kill(-child.pid, sig); } catch { /* 进程组已经没了 */ }
    try { child.kill(sig); } catch { /* 同上 */ }
  };
  signal('SIGTERM');
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(400) });
      if (!response.ok) break;
    } catch { break; }
  }
  if (child.exitCode === null) signal('SIGKILL');
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 600));
}

/** 三张截图必须都存在、>20KB、sha256 互异。 */
function checkShotHashes() {
  const names = ['23-pv-01-3d.png', '23-pv-02-linkage.png', '23-pv-03-exports.png', '23-pv-04-transfer-3d.png'];
  const seen = new Map();
  const parts = [];
  for (const name of names) {
    const path = join(shotDir, name);
    if (!existsSync(path)) throw new Error(`截图缺失：${path}`);
    const bytes = readFileSync(path);
    if (bytes.length <= 20 * 1024) throw new Error(`${name} 只有 ${bytes.length} 字节，疑似空白`);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (seen.has(hash)) throw new Error(`${name} 与 ${seen.get(hash)} 字节完全相同（抓到同一帧）`);
    seen.set(hash, name);
    parts.push(`${name}:${bytes.length}B:${hash.slice(0, 12)}`);
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// 本地模型桩：把「用户这句话」映射成 tool_call；工具结果回来后收尾。
// 只记录工具结果，供断言使用（模型看到的就是这些）。
// ---------------------------------------------------------------------------
async function startLlmStub() {
  const toolResults = [];
  const waiters = [];
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { body = {}; }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const last = messages[messages.length - 1] ?? {};

      if (last.role === 'tool') {
        const name = String(last.name ?? last.tool_call_id ?? 'tool');
        // 会话层把工具结果包了一层：{kind:'tool_result_data', tool, notice, data:'<json 字符串>'}
        // 断言要的是里层那个真结果，这里拆一层；拆不动就保留原样。
        let parsed = null;
        const rawText = String(last.content ?? '');
        try { parsed = JSON.parse(rawText); } catch {
          const start = rawText.indexOf('{');
          if (start >= 0) { try { parsed = JSON.parse(rawText.slice(start)); } catch { parsed = null; } }
        }
        if (parsed && typeof parsed === 'object' && typeof parsed.data === 'string') {
          try { parsed = JSON.parse(parsed.data); } catch { /* 保留包装层 */ }
        }
        toolResults.push({ name, parsed, raw: String(last.content ?? '') });
        for (const waiter of [...waiters]) {
          if (waiter.name !== name) continue;
          const entry = toolResults.filter((item) => item.name === name).pop();
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(entry?.parsed ?? null);
        }
        console.log(`MACHINE_E2E_STUB_TOOLRESULT tool=${name} ok=${parsed?.ok ?? '?'}`);
        if (process.env.MACHINE_E2E_DEBUG_STUB === '1') {
          const dumpPath = join(tmpdir(), `machine-e2e-raw-${name}.json`);
          writeFileSync(dumpPath, rawText, 'utf8');
          console.log(`MACHINE_E2E_STUB_RAW_DUMP ${dumpPath} bytes=${rawText.length}`);
        }
        return reply(res, { role: 'assistant', content: summarize(name, parsed) });
      }

      const userText = lastUserText(messages);
      const planned = planFor(userText);
      if (!planned) return reply(res, { role: 'assistant', content: '我是本地 E2E 桩，只认本流程里的几句话。' });
      console.log(`MACHINE_E2E_STUB_PLAN tool=${planned.name}`);
      return reply(res, {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `call_e2e_${planned.name}_${Date.now()}`, type: 'function', function: { name: planned.name, arguments: JSON.stringify(planned.args) } }]
      }, 'tool_calls');
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen(undefined));
  });
  const port = server.address().port;
  return {
    server,
    port,
    waitForTool(name, timeoutMs) {
      return new Promise((resolveWait, rejectWait) => {
        const existing = toolResults.filter((item) => item.name === name).pop();
        if (existing) return resolveWait(existing.parsed);
        const waiter = { name, resolve: resolveWait };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) { waiters.splice(index, 1); rejectWait(new Error(`等待工具结果超时：${name}`)); }
        }, timeoutMs).unref?.();
      });
    }
  };
}

function reply(res, message, finish = 'stop') {
  const text = JSON.stringify({
    id: `chatcmpl-e2e-${Date.now()}`,
    object: 'chat.completion',
    created: 0,
    model: 'machine-e2e-stub',
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 }
  });
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return String(messages[index].content ?? '');
  }
  return '';
}

function planFor(text) {
  // 顺序要紧：带需求原文的后续消息里也有「光伏板/输送」，先把更具体的意图挑出来
  // 第二台机器（顶升移载）的整段对话都带「移载」两个字，先按它分流到对应 brief
  const isTransfer = /移载/.test(text);
  const brief = isTransfer ? TRANSFER_BRIEF : BRIEF;
  if (/(实体模型|整机模型|参数化几何|三维模型)/.test(text)) {
    return { name: 'build_machine_model', args: { process: 'conveyor', brief } };
  }
  if (/三态|四态/.test(text)) {
    // 位姿化检查：移载机型必须能跑 rest / lift / sweep / push（sweep 覆盖顶升途中，push 覆盖顶升后推出）
    return { name: 'run_interference_check', args: { states: ['rest', 'lift', 'sweep', 'push'] } };
  }
  if (/干涉/.test(text)) {
    return { name: 'run_interference_check', args: {} };
  }
  if (/plc/i.test(text)) {
    return { name: 'run_plc_generate', args: { namePrefix: isTransfer ? 'pv-transfer' : 'pv-conveyor' } };
  }
  if (/导出/.test(text)) {
    return { name: 'export_files', args: { kind: 'glb', fileName: 'pv-conveyor.glb', overwrite: true } };
  }
  if (isTransfer) {
    return { name: 'design_machine', args: { brief: TRANSFER_BRIEF } };
  }
  if (/光伏板/.test(text) && /(设计|做|规划|输送)/.test(text)) {
    return { name: 'design_machine', args: { brief: BRIEF } };
  }
  return null;
}

function summarize(name, parsed) {
  const data = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed;
  if (name === 'design_machine') return '方案已生成，见下方方案卡；点「应用到工程」写入工程并刷新 3D/BOM/IO。';
  if (name === 'build_machine_model') {
    return `整机模型已生成：${data?.parts ?? '?'} 件，视口装配 ${data?.loadedParts ?? '?'} 件。`;
  }
  if (name === 'run_plc_generate') return `PLC 工程已落盘：${data?.fileCount ?? data?.files?.length ?? '?'} 个文件。`;
  if (name === 'export_files') return `已导出 ${data?.kind ?? 'glb'}：${data?.path ?? ''}`;
  if (name === 'run_interference_check') return `干涉初筛完成：${data?.hits ?? data?.items?.length ?? '?'} 对。`;
  return `${name} 完成。`;
}

// ---------------------------------------------------------------------------
// CDP 客户端：连 127.0.0.1:9229（主进程非 headless 模式固定监听）
// ---------------------------------------------------------------------------
async function connectCdp() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let target = null;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await sleep(500);
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const list = await response.json();
      target = list.find((item) => item.type === 'page' && String(item.url).includes('index.html'))
        ?? list.find((item) => item.type === 'page');
      if (target) break;
    } catch { /* 还没起来 */ }
  }
  if (!target) throw new Error(`等待 CDP 端点超时（127.0.0.1:${cdpPort} 没起来）`);

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', () => resolveOpen(undefined), { once: true });
    socket.addEventListener('error', () => rejectOpen(new Error('CDP WebSocket 连接失败')), { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    let payload = null;
    try { payload = JSON.parse(event.data); } catch { return; }
    if (!payload?.id) return;
    const entry = pending.get(payload.id);
    if (!entry) return;
    pending.delete(payload.id);
    if (payload.error) entry.reject(new Error(`${entry.method}: ${payload.error.message}`));
    else entry.resolve(payload.result);
  });
  const request = (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest, method });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await request('Runtime.enable');
  await request('Page.enable');

  const evaluate = async (expression) => {
    const result = await request('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result?.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(`页面脚本异常：${detail.text ?? ''} ${detail.exception?.description ?? ''}`.slice(0, 400));
    }
    return result?.result?.value;
  };

  const clickConfirmButton = async () => evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(CONFIRM_SELECTOR)});
    if (!button) return false;
    button.click();
    return true;
  })()`);

  const client = {
    evaluate,
    send: request,
    clickConfirm: clickConfirmButton,
    /**
     * xvfb + SwiftShader 下合成器可能不产新帧（实测第二、三张字节完全相同）。
     * 用一次「改视口尺寸 → 还原」强制整页重排重绘，比等 rAF 可靠。
     */
    async forceRepaint() {
      await request('Emulation.setDeviceMetricsOverride', {
        width: SHOT_WIDTH - 2,
        height: SHOT_HEIGHT - 2,
        deviceScaleFactor: 1,
        mobile: false
      }).catch(() => {});
      await sleep(320);
      await request('Emulation.setDeviceMetricsOverride', {
        width: SHOT_WIDTH,
        height: SHOT_HEIGHT,
        deviceScaleFactor: 1,
        mobile: false
      }).catch(() => {});
      await sleep(420);
    },
    /** 固定渲染视口尺寸：文档里其它整机截图都是 1600×1000，别混两种尺寸。 */
    async fixViewport() {
      await request('Emulation.setDeviceMetricsOverride', {
        width: SHOT_WIDTH,
        height: SHOT_HEIGHT,
        deviceScaleFactor: 1,
        mobile: false
      }).catch(() => {});
      await sleep(400);
    },
    async screenshot() {
      const result = await request('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      return Buffer.from(String(result?.data ?? ''), 'base64');
    },
    close() { try { socket.close(); } catch { /* ignore */ } },
    async waitFor(expression, label, timeoutMs = 30_000, sideEffect = null) {
      const started = Date.now();
      for (;;) {
        let value = false;
        try { value = Boolean(await evaluate(expression)); } catch { value = false; }
        if (value) return true;
        if (sideEffect) await sideEffect();
        if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`);
        await sleep(200);
      }
    },
    /** 等到确认卡出现并点真实按钮（[data-acw="once"]）。返回点了几次。 */
    async waitForConfirm(minClicks = 1, label = '写操作确认卡', timeoutMs = 20_000) {
      const started = Date.now();
      let clicks = 0;
      for (;;) {
        if (await clickConfirmButton()) clicks += 1;
        if (clicks >= minClicks) return clicks;
        if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`);
        await sleep(200);
      }
    }
  };
  ACTIVE_CDP = client;
  return client;
}

/**
 * 点确认卡上的「允许一次」——真实 DOM 按钮，不是注入 auto-confirm。
 * 只在真正点不到时才允许退化成测试注入（本流程不需要）。
 */
async function clickConfirm() {
  return ACTIVE_CDP ? ACTIVE_CDP.clickConfirm() : false;
}

async function sendMessage(cdp, text) {
  await cdp.waitFor(`(() => {
    const send = document.getElementById('agentChatSend');
    return Boolean(send && !send.disabled && document.getElementById('agentChatInput'));
  })()`, '输入框可用', 30_000, clickConfirm);
  await cdp.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const input = document.getElementById('agentChatInput');
    input.focus();
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(120);
    document.querySelector('#agentChatSend')?.click();
    return true;
  })()`);
}

async function capture(cdp, name, label) {
  await cdp.evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.getElementById('cadNotice')?.classList.remove('is-on');
    document.getElementById('acpToast')?.classList.remove('is-on');
    await wait(600);
    return true;
  })()`);
  await cdp.forceRepaint();
  let png = await cdp.screenshot();
  let hash = createHash('sha256').update(png).digest('hex');
  // 抓到上一张的同一帧 = 合成器没刷新：再强制重绘一次，第二次仍相同就报错，绝不写重复图。
  const duplicated = [...shotHashes.entries()].find(([, value]) => value.hash === hash);
  if (duplicated) {
    await cdp.forceRepaint();
    png = await cdp.screenshot();
    hash = createHash('sha256').update(png).digest('hex');
    const stillDuplicate = [...shotHashes.entries()].find(([, value]) => value.hash === hash);
    if (stillDuplicate) throw new Error(`${name} 与 ${stillDuplicate[0]} 字节完全相同（画面没刷新）`);
  }
  const target = join(shotDir, name);
  writeFileSync(target, png);
  const bytes = statSync(target).size;
  if (bytes <= 20 * 1024) throw new Error(`${name} 只有 ${bytes} 字节，疑似空白`);
  shotHashes.set(name, { hash, bytes });
  console.log(`MACHINE_E2E_SHOT_OK name=${name} label=${label} bytes=${bytes} sha256=${hash.slice(0, 12)}`);
  return name;
}
