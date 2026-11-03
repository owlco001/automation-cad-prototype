/**
 * 机型库抽屉的真机截图（`24-machine-library.png`）。
 *
 * 为什么要在主进程里做：机型库的数据源是 `userData/machine-library/`，只有主进程能写；
 * 而且这条链路（preload → `library:list` → 面板渲染）必须整条真跑，不能拿静态 HTML 充数。
 *
 * 流程：
 *   1. 用 `saveToLibrary()` 往这次 headless 的临时 userData 里预置两台机型（真实包校验/落盘）；
 *   2. 页面扩展就绪后点入口按钮 `[data-machine-library-open]` 打开抽屉；
 *   3. 断言面板里真的出现这两台（DOM 文本 + `library:list` 的 IPC 返回值双重证据）；
 *   4. capturePage 落盘，断言 > 150 KB 并打印 `LIBRARY_SHOT_OK bytes=… path=…`。
 */

import { nativeImage, type BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoMachineConfig, validateMachineConfig } from '../src/commission/machine-config.ts';
import type { MachineConfig } from '../src/machine/validate.ts';
import { listLibrary, saveToLibrary } from '../src/machine/library.ts';
import { validateMachineDesign } from '../src/machine/store.ts';

const SHOT_WIDTH = 1600;
const SHOT_HEIGHT = 1000;
const SHOT_NAME = '24-machine-library.png';
const MIN_BYTES = 150 * 1024;

export interface LibraryScreenshotOptions {
  outputDir: string;
  userDataRoot: string;
}

export interface LibraryScreenshotResult {
  path: string;
  bytes: number;
  entries: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForExtension(window: BrowserWindow): Promise<void> {
  const ready = await window.webContents.executeJavaScript(
    `new Promise((resolve) => {
      if (window.__AUTOMATION_CAD_EXTENSION_READY__ === true) return resolve(true);
      const timer = setInterval(() => {
        if (window.__AUTOMATION_CAD_EXTENSION_READY__ === true) {
          clearInterval(timer);
          resolve(true);
        }
      }, 100);
      setTimeout(() => { clearInterval(timer); resolve(false); }, 20000);
    })`
  ) as boolean;
  if (!ready) throw new Error('桌面扩展未在 20 秒内就绪');
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

async function settle(window: BrowserWindow, extraMs = 260): Promise<void> {
  await window.webContents.executeJavaScript(
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() =>
      setTimeout(resolve, ${Math.max(0, Math.round(extraMs))})
    )))`
  );
}

/** 第二台机型：3 工位装配机（与 demo 的 4 工位样机不同，表格里一眼能分辨）。 */
function assemblyMachineConfig(): MachineConfig {
  return validateMachineConfig({
    id: 'assembly-3-station',
    name: '三工位装配机',
    stations: ['上料', '压装', '下料'],
    actuators: [
      { id: 'asm-feed-cylinder', name: '上料推料气缸', kind: 'cylinder', station: '上料', extendPoint: 'Y0', retractPoint: 'Y4' },
      { id: 'asm-press-cylinder', name: '压装气缸', kind: 'cylinder', station: '压装', extendPoint: 'Y1', retractPoint: 'Y5' },
      { id: 'asm-grip', name: '下料夹爪', kind: 'gripper', station: '下料', gripPoint: 'Y2' }
    ],
    sensors: [
      { point: 'X0', station: '上料', part: 'asm-feed-cylinder' },
      { point: 'X1', station: '压装', part: 'asm-press-cylinder' },
      { point: 'X2', station: '下料', part: 'asm-grip' }
    ]
  });
}

/** 四工位螺丝机样机（复用内置 demo 配置，只改 id/名称，避免几何与点位凭空编）。 */
function screwMachineConfig(): MachineConfig {
  const base = demoMachineConfig();
  return validateMachineConfig({
    ...base,
    id: 'screw-4-station',
    name: '四工位螺丝机样机'
  });
}

/**
 * 预置机型库：走真实 `saveToLibrary`（打包 → 逐条 SHA-256 → 原子落盘），
 * 因此列表里的名称/版本/大小都是真数据，不是写死的假行。
 */
function seedLibrary(userDataRoot: string, appVersion: string): void {
  const seeds: Array<{ config: MachineConfig; version: string }> = [
    { config: screwMachineConfig(), version: '1.2.0' },
    { config: assemblyMachineConfig(), version: '0.9.3' }
  ];
  for (const seed of seeds) {
    const design = validateMachineDesign({ config: seed.config });
    saveToLibrary(userDataRoot, design, { version: seed.version, appVersion });
  }
}

export async function captureLibraryScreenshot(
  window: BrowserWindow,
  options: LibraryScreenshotOptions
): Promise<LibraryScreenshotResult> {
  mkdirSync(options.outputDir, { recursive: true });
  window.setContentSize(SHOT_WIDTH, SHOT_HEIGHT);
  window.webContents.setBackgroundThrottling(false);
  await delay(300);
  await waitForExtension(window);

  // 0) 先离开首页：启动时 #app 是 inert + aria-hidden，被首页盖着。
  //    不关首页就截图，拿到的是首页那一帧（实测与旧截图像素完全相同 —— 假证据）。
  const entered = await window.webContents.executeJavaScript(
    `(() => {
      const classic = document.querySelector('.home-foot .home-link');
      if (!classic) return document.getElementById('app')?.getAttribute('aria-hidden') === null ? 'already' : 'missing-home';
      classic.click();
      return 'clicked';
    })()`
  ) as string;
  if (entered === 'missing-home') throw new Error('首页「进入经典原型界面」入口缺失，无法进入 CAD 工作区');
  await waitFor(
    window,
    `(() => {
      const app = document.getElementById('app');
      const home = document.querySelector('.home-root');
      return Boolean(app && app.getAttribute('aria-hidden') === null && (!home || home.hidden));
    })()`,
    '首页关闭、CAD 工作区可见'
  );
  console.log(`LIBRARY_HOME_OK mode=${entered}`);

  // 1) 预置机型库（真包：saveToLibrary 内部会走 importPackage 的全套校验）
  seedLibrary(options.userDataRoot, 'headless-library-shot');
  const seeded = listLibrary(options.userDataRoot);
  if (seeded.length < 2) throw new Error(`预置机型库失败：只有 ${seeded.length} 台`);
  console.log(`LIBRARY_SEED entries=${seeded.length} ids=${seeded.map((entry) => entry.id).join(',')}`);

  // 2) 参照帧（抽屉还没开）：最终图若与它字节相同，说明抓到的是旧帧，不是这次画面。
  await settle(window);
  const beforeHash = createHash('sha256').update((await window.webContents.capturePage()).toPNG()).digest('hex');

  // 3) 打开抽屉：入口按钮可能被「工具」菜单收走（不可见），但 .click() 仍走同一条监听
  //    （入口 id 是 machineLibraryEntryButton，data-machine-library-open 是截图/自检锚点）
  const clicked = await window.webContents.executeJavaScript(
    `(() => {
      const entry = document.querySelector('[data-machine-library-open]');
      if (!entry) return 'missing-entry';
      entry.click();
      return 'clicked';
    })()`
  ) as string;
  if (clicked !== 'clicked') throw new Error(`机型库入口缺失：${clicked}`);

  await waitFor(
    window,
    `(() => {
      const drawer = document.getElementById('machineLibraryDrawer');
      if (!drawer || drawer.hidden) return false;
      return document.querySelectorAll('[data-library-row]').length >= 2;
    })()`,
    '机型库抽屉出现且至少两行'
  );

  // 3) 真实 IPC 证据：渲染层拿到的列表来自主进程 library:list
  const ipcEntries = await window.webContents.executeJavaScript(
    `(async () => {
      const result = await window.__machineLibrary.list();
      return result && result.ok ? result.entries.map((entry) => ({ id: entry.id, name: entry.name, version: entry.version })) : { error: result };
    })()`
  ) as Array<{ id: string; name: string; version: string }> | { error: unknown };
  if (!Array.isArray(ipcEntries)) throw new Error(`library:list 返回异常：${JSON.stringify(ipcEntries)}`);
  if (ipcEntries.length !== seeded.length) {
    throw new Error(`library:list 条目数 ${ipcEntries.length} 与预置 ${seeded.length} 不一致`);
  }
  console.log(`LIBRARY_IPC_OK entries=${ipcEntries.length} names=${ipcEntries.map((entry) => entry.name).join(' / ')}`);

  const domText = await window.webContents.executeJavaScript(
    `(() => {
      const table = document.querySelector('[data-machine-library-table]');
      if (!table) return '';
      return table.innerText.replace(/\\s+/g, ' ').trim();
    })()`
  ) as string;
  for (const name of ['四工位螺丝机样机', '三工位装配机']) {
    if (!domText.includes(name)) throw new Error(`抽屉里没渲染出「${name}」：${domText.slice(0, 200)}`);
  }
  console.log(`LIBRARY_DOM_OK text=${domText.slice(0, 160)}`);

  // 抽屉真的占了右侧版面（DOM 坐标证据，配合截图的像素边界一起看）
  const rect = await window.webContents.executeJavaScript(
    `(() => {
      const drawer = document.getElementById('machineLibraryDrawer');
      if (!drawer) return null;
      const box = drawer.getBoundingClientRect();
      return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
    })()`
  ) as { x: number; y: number; width: number; height: number } | null;
  if (!rect || rect.width < 300 || rect.height < 400) {
    throw new Error(`机型库抽屉尺寸异常：${JSON.stringify(rect)}`);
  }
  console.log(`LIBRARY_RECT x=${rect.x} y=${rect.y} w=${rect.width} h=${rect.height}`);

  // 4) 抓图（xvfb + SwiftShader 下先作废一帧再抓，避免拿到首帧）
  await window.webContents.executeJavaScript(
    `document.getElementById('acpToast')?.classList.remove('is-on');
     document.getElementById('cadNotice')?.classList.remove('is-on'); true`
  );
  await settle(window);
  if (!window.isVisible()) window.showInactive();
  window.webContents.invalidate();
  await settle(window, 360);

  const png = (await window.webContents.capturePage()).toPNG();
  const { width, height } = nativeImage.createFromBuffer(png).getSize();
  if (width !== SHOT_WIDTH || height !== SHOT_HEIGHT) {
    throw new Error(`截图尺寸 ${width}×${height}，期望 ${SHOT_WIDTH}×${SHOT_HEIGHT}`);
  }
  const shotHash = createHash('sha256').update(png).digest('hex');
  if (shotHash === beforeHash) {
    throw new Error('截图与「抽屉打开前」的参照帧完全相同：抓到的是旧帧（合成器没刷新），拒绝产出假截图');
  }
  const target = join(options.outputDir, SHOT_NAME);
  writeFileSync(target, png);
  const bytes = statSync(target).size;
  if (bytes <= MIN_BYTES) throw new Error(`${SHOT_NAME} 仅 ${bytes} 字节（< ${MIN_BYTES}），疑似空白`);
  console.log(`LIBRARY_SHOT_OK bytes=${bytes} path=${target}`);

  // 5) 抓完图再顺手验一遍写链路：`library:apply` 真的把方案写回 machine/<id>.json 并把
  //    active.json 指过去（截图只覆盖「列表 + 渲染」，这一步补上「加载」）。
  const applyCheck = await window.webContents.executeJavaScript(
    `(async () => {
      const result = await window.__machineLibrary.apply('screw-4-station');
      if (!result || !result.ok) return { ok: false, failure: result };
      const active = await window.desktop.machine.active();
      const design = active && active.ok ? active.design : null;
      return {
        ok: true,
        designId: design && design.id ? design.id : null,
        name: design && design.config ? design.config.name : null
      };
    })()`
  ) as { ok: boolean; designId?: string | null; name?: string | null; failure?: unknown };
  if (!applyCheck.ok || applyCheck.designId !== 'screw-4-station') {
    throw new Error(`library:apply 未写回 active 指针：${JSON.stringify(applyCheck)}`);
  }
  console.log(`LIBRARY_APPLY_OK id=${applyCheck.designId} name=${applyCheck.name ?? ''}`);
  return { path: target, bytes, entries: ipcEntries.length };
}
