/**
 * 真机自检：在一个真实 Electron 窗口里跑 `capture_view` 的两条关键路径。
 *
 * 用法（headless，本机已用 xvfb 实跑）：
 *   xvfb-run -a -s "-screen 0 1920x1200x24" \
 *     node_modules/.bin/electron . --no-sandbox --headless-capture-view
 *
 * 断言：
 *   1. 还停在首页时调用 capture_view → `VIEW_NOT_READY`，且 `agent-shots/` 里**没有**新文件
 *      （这一条是「不许拿首页截图冒充」的闸门，不能省）；
 *   2. 点「进入经典原型界面」后 3D 视图 → `ok:true`，落盘文件字节/尺寸真实、PNG 魔数正确、
 *      sha256 与磁盘一致；
 *   3. 机型库视图 → 抽屉真打开后截图，字节与 3D 图不同（不是同一帧复用）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { captureAgentView } from '../src/agent/self-evidence.ts';
import { createAgentViewCapture } from './agent-capture.ts';

export interface SelfEvidenceCheckResult {
  ok: boolean;
  homeGateRejected: boolean;
  shots: Array<{ view: string; path: string; bytes: number; sha256: string; width: number; height: number }>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitFor(window: BrowserWindow, expression: string, label: string, timeoutMs = 20_000): Promise<void> {
  const ok = await window.webContents.executeJavaScript(
    `new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        let value = false;
        try { value = Boolean(${expression}); } catch { value = false; }
        if (value) return resolve(true);
        if (Date.now() - started > ${timeoutMs}) return resolve(false);
        setTimeout(check, 120);
      };
      check();
    })`
  ) as boolean;
  if (!ok) throw new Error(`等待超时：${label}`);
}

export async function checkAgentViewCapture(window: BrowserWindow, userDataRoot: string): Promise<SelfEvidenceCheckResult> {
  const capture = createAgentViewCapture(() => window);
  const deps = { userDataRoot, capture };
  const shotsDir = join(userDataRoot, 'agent-shots');

  window.setContentSize(1600, 1000);
  window.webContents.setBackgroundThrottling(false);
  await waitFor(window, `window.__AUTOMATION_CAD_EXTENSION_READY__ === true`, '桌面扩展就绪', 25_000);
  await delay(300);

  // 1) 首页闸门：此时 #app 仍 inert，工具必须拒绝，且不能留下任何截图
  const before = existsSync(shotsDir) ? readdirSync(shotsDir).length : 0;
  const rejected = await captureAgentView({ view: '3d' }, deps);
  const after = existsSync(shotsDir) ? readdirSync(shotsDir).length : 0;
  if (rejected.ok !== false || rejected.code !== 'VIEW_NOT_READY') {
    throw new Error(`首页闸门失效：${JSON.stringify(rejected)}`);
  }
  if (after !== before) {
    throw new Error(`首页闸门失效：拒绝时仍写了 ${after - before} 个截图`);
  }
  console.log(`AGENT_CAPTURE_HOME_GATE_OK code=${String(rejected.code)} hint=${String(rejected.hint)}`);

  // 2) 进入经典原型界面（与 library-screenshot 同一入口）
  const entered = await window.webContents.executeJavaScript(
    `(() => {
      const classic = document.querySelector('.home-foot .home-link');
      if (!classic) return document.getElementById('app')?.getAttribute('aria-hidden') === null ? 'already' : 'missing-home';
      classic.click();
      return 'clicked';
    })()`
  ) as string;
  if (entered === 'missing-home') throw new Error('首页「进入经典原型界面」入口缺失');
  await waitFor(
    window,
    `(() => {
      const app = document.getElementById('app');
      const home = document.querySelector('.home-root');
      return Boolean(app && app.getAttribute('aria-hidden') === null && (!home || home.hidden));
    })()`,
    '首页关闭、CAD 工作区可见'
  );
  await delay(400);

  const shots: SelfEvidenceCheckResult['shots'] = [];
  for (const view of ['3d', 'library'] as const) {
    const result = await captureAgentView({ view, width: 1600, height: 1000 }, deps);
    if (result.ok !== true) throw new Error(`${view} 截图失败：${JSON.stringify(result)}`);
    const path = String(result.path);
    const disk = readFileSync(path);
    if (disk.length !== Number(result.bytes) || statSync(path).size !== Number(result.bytes)) {
      throw new Error(`${view} 的 bytes 与磁盘大小不一致`);
    }
    if (disk[0] !== 0x89 || disk[1] !== 0x50 || disk[2] !== 0x4e || disk[3] !== 0x47) {
      throw new Error(`${view} 落盘的不是 PNG`);
    }
    const sha256 = createHash('sha256').update(disk).digest('hex');
    if (sha256 !== result.sha256) throw new Error(`${view} 的 sha256 无法在磁盘上复算`);
    if (disk.length < 20_000) throw new Error(`${view} 截图只有 ${disk.length} 字节，疑似空画面`);
    shots.push({
      view,
      path,
      bytes: disk.length,
      sha256,
      width: Number(result.width),
      height: Number(result.height)
    });
    console.log(`AGENT_CAPTURE_OK view=${view} bytes=${disk.length} sha256=${sha256} size=${result.width}x${result.height} path=${path}`);
  }

  if (shots.length === 2 && shots[0]?.sha256 === shots[1]?.sha256) {
    throw new Error('3d 与 library 截图字节完全相同：抓到的是同一帧');
  }
  return { ok: true, homeGateRejected: true, shots };
}
