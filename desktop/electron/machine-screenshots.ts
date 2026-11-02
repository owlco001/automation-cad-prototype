// 六工位锁螺丝机全流程截图。使用本地 OpenAI 兼容桩驱动真实智能体会话，
// 所有画面均由 Electron 渲染后 capturePage 捕获，不使用静态设计稿。
import { nativeImage, type BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SHOT_WIDTH = 1600;
const SHOT_HEIGHT = 1000;
const BRIEF = '六工位锁螺丝机，节拍 20 件/分钟，每工位 1 套汇川 750W 伺服 + 1 个 SMC 气爪 + 1 个到位检测 + 安全光栅';

export interface MachineScreenshotOptions {
  outputDir: string;
}

export interface MachineShotValidation {
  name: string;
  label: string;
  width: number;
  height: number;
  bytes: number;
  uniqueColors: number;
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
      setTimeout(() => { clearInterval(timer); resolve(false); }, 15000);
    })`
  ) as boolean;
  if (!ready) throw new Error('桌面扩展未在 15 秒内就绪');
}

async function waitFor(
  window: BrowserWindow,
  expression: string,
  label: string,
  timeoutMs = 20_000
): Promise<void> {
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

/** 同 waitFor，但超时返回 false 而不是抛错——需要在超时时自己诊断的步骤用这个。 */
async function waitForSoft(
  window: BrowserWindow,
  expression: string,
  timeoutMs = 20_000
): Promise<boolean> {
  return await window.webContents.executeJavaScript(
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
}

async function settle(window: BrowserWindow, extraMs = 220): Promise<void> {
  await window.webContents.executeJavaScript(
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() =>
      setTimeout(resolve, ${Math.max(0, Math.round(extraMs))})
    )))`
  );
}

function uniqueColorCount(bitmap: Buffer): number {
  const seen = new Set<number>();
  for (let index = 0; index + 3 < bitmap.length; index += 4) {
    const key = (bitmap[index]! << 16) | (bitmap[index + 1]! << 8) | bitmap[index + 2]!;
    seen.add(key);
    if (seen.size > 20_000) break;
  }
  return seen.size;
}

/**
 * xvfb + SwiftShader 下 `webContents.capturePage()` 会一直返回第一帧（实测 15/16/17/18
 * 字节完全相同），但 CDP 的 Page.captureScreenshot 是重新合成后再取，能拿到当前画面。
 */
/**
 * 抓图说明（2026-10-27 审计）：
 * xvfb + SwiftShader 下 capturePage / CDP Page.captureScreenshot 都返回同一张首帧
 * （实测 15/16/17/18 字节完全相同），desktopCapturer 在无窗口管理器的 xvfb 里又没有窗口源。
 * 因此这里保留最简单的 capturePage，由调用方用 sha256 去重——重复即报错，
 * 不再产出「四张不同面板」的假截图。真正的修法是换通道（外部 CDP 连可见窗口，已在本机验证可拿到不同帧）。
 */
/**
 * 抓图通道（2026-10-27 结论修正）：
 * 一开始以为是渲染进程帧冻结，加了 ffmpeg x11grab 旁路；后来查明真因是**流程从没离开首页**
 * （所有操作都在首页遮罩下进行），修掉首页那步之后 `capturePage()` 本身就稳定给出四个不同画面
 * （本机连续两次实跑、CI 一次实跑都 4 张互异）。所以这里回到最简单的 capturePage，
 * 不再依赖 ffmpeg / Xauthority，去重守卫保留——四张雷同时直接报错。
 */
async function grabPng(window: BrowserWindow): Promise<Buffer> {
  const image = await window.webContents.capturePage();
  return image.toPNG();
}

async function capture(
  window: BrowserWindow,
  outputDir: string,
  name: string,
  label: string,
  seenHashes: Map<string, string>
): Promise<MachineShotValidation> {
  await window.webContents.executeJavaScript(
    `document.getElementById('cadNotice')?.classList.remove('is-on');
     document.getElementById('acpToast')?.classList.remove('is-on'); true`
  );
  await settle(window);
  // xvfb + SwiftShader 下窗口可能被判为被遮挡，合成器不产新帧，capturePage 会重复返回同一张。
  // 先确保窗口可见并主动作废一帧，再等两个 rAF，最后才抓图。
  if (!window.isVisible()) window.showInactive();
  window.webContents.invalidate();
  await settle(window, 320);
  const png = await grabPng(window);
  const image = nativeImage.createFromBuffer(png);
  const { width, height } = image.getSize();
  if (width !== SHOT_WIDTH || height !== SHOT_HEIGHT) {
    throw new Error(`${name} 尺寸 ${width}×${height}，期望 ${SHOT_WIDTH}×${SHOT_HEIGHT}`);
  }
  // 四张图必须真的是四个画面：字节级重复说明抓到的是同一帧（合成器没刷新），
  // 这种「看起来成功」的截图比失败更糟，直接报错。
  const hash = createHash('sha256').update(png).digest('hex');
  const duplicateOf = seenHashes.get(hash);
  if (duplicateOf) {
    throw new Error(`${name} 与 ${duplicateOf} 字节完全相同，抓到的是同一帧（画面没刷新）`);
  }
  seenHashes.set(hash, name);
  const target = join(outputDir, name);
  writeFileSync(target, png);
  const bytes = statSync(target).size;
  if (bytes <= 20 * 1024) throw new Error(`${name} 仅 ${bytes} 字节，疑似空白`);
  const uniqueColors = uniqueColorCount(nativeImage.createFromBuffer(png).toBitmap());
  if (uniqueColors <= 500) throw new Error(`${name} 唯一色数 ${uniqueColors}，疑似单色/空白`);
  console.log(`MACHINE_SHOT_OK name=${name} label=${label} size=${width}x${height} bytes=${bytes} colors=${uniqueColors}`);
  return { label, name, width, height, bytes, uniqueColors };
}

export async function captureMachineScreenshots(
  window: BrowserWindow,
  options: MachineScreenshotOptions
): Promise<{ captured: number; failed: number }> {
  mkdirSync(options.outputDir, { recursive: true });
  const evalDir = process.env.AUTOMATIONCAD_EVAL_DIR
    ? resolve(process.env.AUTOMATIONCAD_EVAL_DIR)
    : resolve(options.outputDir, '..', 'eval');
  mkdirSync(evalDir, { recursive: true });
  const baseUrl = process.env.AUTOMATIONCAD_STUB_BASE_URL;
  if (!baseUrl) throw new Error('缺少 AUTOMATIONCAD_STUB_BASE_URL，无法启动离线模型桩');

  window.setContentSize(SHOT_WIDTH, SHOT_HEIGHT);
  window.webContents.setBackgroundThrottling(false);
  await delay(350);
  await waitForExtension(window);

  await window.webContents.executeJavaScript(
    `(async () => {
      const result = await window.desktop.agent.saveLlmConfig({
        baseUrl: ${JSON.stringify(baseUrl)},
        apiKey: 'offline-stub',
        model: 'offline-stub',
        maxIterations: 4
      });
      return result;
    })()`
  );

  const shots: MachineShotValidation[] = [];
  const seenHashes = new Map<string, string>();
  try {
    await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        // 启动后停在首页；不先离开首页，后面所有操作都在首页底下进行，
        // 抓到的四张图就都是首页（这正是之前「四张图字节相同」的真正原因）。
        const home = document.getElementById('homeScreen');
        if (home && !home.hidden) {
          document.querySelector('.home-link')?.click();
          await wait(600);
        }
        window.AutomationCadViewer?.close();
        window.AutomationCadParametric?.close();
        document.getElementById('commissionDrawer')?.setAttribute('hidden', '');
        document.querySelector('#agentEntryButton')?.click();
        await wait(260);
        const input = document.querySelector('#agentChatInput');
        if (!input) throw new Error('智能体输入框缺失');
        input.value = ${JSON.stringify(BRIEF)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#agentChatSend')?.click();
        return true;
      })()`
    );

    try {
      await waitFor(
        window,
        `document.querySelector('.acp-machine-card') && document.querySelectorAll('.acp-machine-card .acp-machine-stats b').length >= 6`,
        '机型方案卡渲染'
      );
    } catch (error) {
      const debug = await window.webContents.executeJavaScript(
        `(() => ({
          drawerOpen: !document.getElementById('agentDrawer')?.hidden,
          status: document.getElementById('agentChatStatus')?.textContent || '',
          feedback: document.getElementById('agentChatFeedback')?.textContent || '',
          chatText: (document.getElementById('agentChatLog')?.textContent || '').slice(0, 1600),
          toolCards: document.querySelectorAll('.acp-chat-tool').length,
          cards: document.querySelectorAll('.acp-machine-card').length
        }))()`
      );
      console.error('MACHINE_CARD_DEBUG', JSON.stringify(debug));
      throw error;
    }
    await settle(window, 400);

    const cardState = await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const card = document.querySelector('.acp-machine-card');
        const log = document.querySelector('#agentChatLog');
        if (!card) return { ok: false, message: '机型方案卡缺失' };
        const stats = Array.from(card.querySelectorAll('.acp-machine-stats b')).map((node) => node.textContent || '');
        const warnings = Array.from(card.querySelectorAll('.acp-machine-warning')).map((node) => node.textContent || '');
        const button = card.querySelector('[data-apply-machine]');
        if (log) {
          const cardRect = card.getBoundingClientRect();
          const logRect = log.getBoundingClientRect();
          log.scrollTop += cardRect.top - logRect.top - 8;
        }
        await wait(120);
        return {
          ok: true,
          stats,
          warnings,
          hasButton: Boolean(button),
          drawerOpen: !document.getElementById('agentDrawer')?.hidden,
          feedback: document.querySelector('#agentChatFeedback')?.textContent || ''
        };
      })()`
    ) as {
      ok: boolean;
      message?: string;
      stats?: string[];
      warnings?: string[];
      hasButton?: boolean;
      drawerOpen?: boolean;
      feedback?: string;
    };
    if (!cardState.ok) throw new Error(cardState.message ?? '机型方案卡状态异常');
    const expectedStats = ['6', '12', '7', '20', '31.75', '2.18', '3.7', '6A/3P', '79%'];
    if (JSON.stringify(cardState.stats) !== JSON.stringify(expectedStats)) {
      throw new Error(`方案卡统计不符合预期：${JSON.stringify(cardState.stats)}`);
    }
    if (!cardState.hasButton || !cardState.drawerOpen) throw new Error('方案卡应用按钮或侧栏缺失');
    if (!(cardState.warnings ?? []).some((text) => text.includes('安全光栅'))) {
      throw new Error(`方案卡缺少安全光栅选型/安全距离提示：${JSON.stringify(cardState.warnings)}`);
    }
    if (!(cardState.warnings ?? []).some((text) => text.includes('断路器'))) {
      throw new Error(`方案卡缺少断路器交叉校验警告：${JSON.stringify(cardState.warnings)}`);
    }
    if (!(cardState.warnings ?? []).some((text) => text.includes('缺价'))) {
      throw new Error(`方案卡缺少成本缺价警告：${JSON.stringify(cardState.warnings)}`);
    }
    shots.push(await capture(window, options.outputDir, '15-machine-design-card.png', '机型方案卡', seenHashes));

    // 写操作确认现在是页面卡片：截图脚本无人值守，必须在点「应用」前装自动确认
    // （只点「允许一次」，不写死 remember；计数回读写进日志，免得看不出到底弹没弹）
    await window.webContents.executeJavaScript(
      `(() => {
        if (window.__machineShotAutoConfirm) return true;
        const state = { count: 0 };
        window.__machineShotAutoConfirm = state;
        const accept = () => {
          const button = document.querySelector('#acwConfirmMask [data-acw="once"]');
          if (button) { button.click(); state.count += 1; }
        };
        new MutationObserver(accept).observe(document.body, { childList: true, subtree: true });
        accept();
        return true;
      })()`
    );
    await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const button = document.querySelector('.acp-machine-card [data-apply-machine]');
        if (!button) throw new Error('应用按钮缺失');
        button.click();
        return true;
      })()`
    );
    const applied = await waitForSoft(
      window,
      `(() => {
        const pill = document.querySelector('.acp-machine-card .acp-pill.is-ok');
        return pill && (pill.textContent || '').includes('已应用');
      })()`,
      30_000
    );
    if (!applied) {
      // 超时不能只说"等待超时"：把卡片状态/反馈/确认次数都打出来，否则没法判断卡在哪一步
      const diagnosis = await window.webContents.executeJavaScript(
        `(() => {
          const pill = document.querySelector('.acp-machine-card .acp-pill');
          return {
            pill: pill ? pill.textContent : '(无 pill)',
            pillOk: Boolean(document.querySelector('.acp-machine-card .acp-pill.is-ok')),
            feedback: (document.querySelector('#agentChatFeedback')?.textContent || '').slice(0, 200),
            confirmMask: Boolean(document.getElementById('acwConfirmMask')),
            confirms: window.__machineShotAutoConfirm?.count ?? 0,
            buttonDisabled: document.querySelector('.acp-machine-card [data-apply-machine]')?.disabled ?? null
          };
        })()`
      );
      throw new Error(`机型方案应用完成超时：${JSON.stringify(diagnosis)}`);
    }
    const applyState = await window.webContents.executeJavaScript(
      `(() => {
        const pill = document.querySelector('.acp-machine-card .acp-pill.is-ok');
        const feedback = document.querySelector('#agentChatFeedback')?.textContent || '';
        return { applied: pill?.textContent || '', feedback };
      })()`
    ) as { applied: string; feedback: string };
    const confirmCount = await window.webContents.executeJavaScript(
      `(() => window.__machineShotAutoConfirm?.count ?? 0)()`
    ) as number;
    console.log(`MACHINE_APPLY_OK ${applyState.applied} feedback=${applyState.feedback} confirms=${confirmCount}`);

    await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        document.querySelector('#agentDrawer [data-acp-close]')?.click();
        window.AutomationCadViewer?.close();
        document.querySelector('#commissionEntryButton')?.click();
        await wait(500);
        return true;
      })()`
    );
    await waitFor(
      window,
      `(() => {
        const stats = window.__Commission3D?.stats?.();
        return stats && stats.stations === 6 && stats.actuators === 12 && stats.sensors === 7 && stats.webgl === true;
      })()`,
      '6 工位 3D 场景就绪'
    );
    await waitFor(window, `(window.__Commission3D?.stats?.().ticks || 0) > 0`, '3D 帧循环');
    await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const config = window.AutomationCadCommission.getMachineConfig();
        const on = {};
        for (const actuator of config.actuators) {
          if (actuator.point) on[actuator.point] = true;
          if (actuator.gripPoint) on[actuator.gripPoint] = true;
        }
        for (const sensor of config.sensors) on[sensor.point] = true;
        window.__Commission3D.update(on);
        for (let index = 0; index < 14; index += 1) {
          await wait(90);
          window.__Commission3D.update(index % 2 === 0 ? on : { ...on, ...Object.fromEntries(Object.keys(on).map((key) => [key, false])) });
        }
        const body = document.querySelector('#commissionDrawer .acp-drawer-body');
        if (body) body.scrollTop = 0;
        await wait(450);
        return window.__Commission3D.stats();
      })()`
    );
    const sceneStats = await window.webContents.executeJavaScript(
      `window.__Commission3D.stats()`
    ) as { stations: number; actuators: number; sensors: number; ticks: number; webgl: boolean };
    if (sceneStats.stations !== 6 || sceneStats.actuators !== 12 || sceneStats.ticks <= 0) {
      throw new Error(`3D 场景状态异常：${JSON.stringify(sceneStats)}`);
    }
    console.log(`MACHINE_3D_OK stations=${sceneStats.stations} actuators=${sceneStats.actuators} sensors=${sceneStats.sensors} ticks=${sceneStats.ticks}`);
    shots.push(await capture(window, options.outputDir, '16-machine-3d.png', '6 工位 3D 联调', seenHashes));

    await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        document.querySelector('#commissionDrawer [data-acp-close]')?.click();
        window.AutomationCadKinematics?.close();
        document.querySelector('#cadEntryButton')?.click();
        await wait(350);
        window.AutomationCadKinematics?.close();
        document.querySelector('[data-cad-side="bom"]')?.click();
        await wait(260);
        return true;
      })()`
    );
    await waitFor(
      window,
      `(document.querySelectorAll('#cadBomRows tbody tr').length || 0) >= 12`,
      'BOM 面板真实型号行'
    );
    const bomState = await window.webContents.executeJavaScript(
      `(() => {
        const text = document.getElementById('cadBomRows')?.textContent || '';
        return {
          rows: document.querySelectorAll('#cadBomRows tbody tr').length,
          hasSvt: text.includes('SV660P 750 W'),
          hasGripper: text.includes('MHZ2-20D'),
          hasSensor: text.includes('D-M9B'),
          hasValve: text.includes('SY5120-5LZD'),
          hasCurtain: text.includes('F3SG-4SRA0640-14'),
          hasPending: text.includes('待选型'),
          paneOpen: !document.getElementById('cadBomPane')?.hidden
        };
      })()`
    ) as Record<string, unknown>;
    if (bomState.rows !== 12 || !bomState.hasSvt || !bomState.hasGripper || !bomState.hasSensor ||
        !bomState.hasValve || !bomState.hasCurtain || bomState.hasPending || !bomState.paneOpen) {
      throw new Error(`BOM 面板内容不完整：${JSON.stringify(bomState)}`);
    }
    shots.push(await capture(window, options.outputDir, '17-machine-bom.png', 'BOM 真实型号', seenHashes));

    await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        document.querySelector('[data-cad-side="io"]')?.click();
        await wait(300);
        return true;
      })()`
    );
    await waitFor(
      window,
      `(document.querySelectorAll('#cadIoRows tbody tr').length || 0) >= 19`,
      'PLC IO 点位行'
    );
    const ioState = await window.webContents.executeJavaScript(
      `(() => {
        const text = document.getElementById('cadIoRows')?.textContent || '';
        return {
          rows: document.querySelectorAll('#cadIoRows tbody tr').length,
          hasRotary: text.includes('ST1-ROT-A2'),
          hasGripper: text.includes('ST1-GRIP-A1'),
          hasProximity: text.includes('ST1-PRX-S1'),
          hasSafety: text.includes('ST1-SAFE-S2'),
          meta: document.getElementById('cadIoMeta')?.textContent || '',
          paneOpen: !document.getElementById('cadIoPane')?.hidden
        };
      })()`
    ) as Record<string, unknown>;
    if (ioState.rows !== 19 || !ioState.hasRotary || !ioState.hasGripper ||
        !ioState.hasProximity || !ioState.hasSafety || !ioState.paneOpen) {
      throw new Error(`IO 点位面板不完整：${JSON.stringify(ioState)}`);
    }
    console.log(`MACHINE_IOMAP_OK rows=${ioState.rows} meta=${String(ioState.meta)}`);
    shots.push(await capture(window, options.outputDir, '18-machine-iomap.png', 'PLC IO 点位', seenHashes));

    const validationFile = join(evalDir, 'machine-screenshots.json');
    writeFileSync(validationFile, `${JSON.stringify({
      schemaVersion: 1,
      kind: 'machine-screenshots',
      size: { width: SHOT_WIDTH, height: SHOT_HEIGHT },
      minBytes: 20 * 1024,
      minUniqueColors: 500,
      shots
    }, null, 2)}\n`, 'utf8');
    console.log(`MACHINE_SHOTS_DONE captured=${shots.length} failed=0 validation=${validationFile}`);
    return { captured: shots.length, failed: 0 };
  } catch (error) {
    console.error('MACHINE_SHOTS_FAIL', error);
    try {
      const validationFile = join(evalDir, 'machine-screenshots.json');
      writeFileSync(validationFile, `${JSON.stringify({
        schemaVersion: 1,
        kind: 'machine-screenshots',
        size: { width: SHOT_WIDTH, height: SHOT_HEIGHT },
        shots,
        error: error instanceof Error ? error.message : String(error)
      }, null, 2)}\n`, 'utf8');
    } catch (error) {
      // 失败报告是辅助信息，不覆盖原始错误。
      console.warn(`[MACHINE_SCREENSHOT_FAILURE_REPORT]`, { site: 'desktop/electron/machine-screenshots.ts:398' }, error);
    }
    return { captured: shots.length, failed: 1 };
  }
}

/**
 * 「从零建一台机器」的分步截图：整机设计向导 5 步 + 保存后的 3D + BOM + IO。
 * 与 captureMachineScreenshots 的区别是**不走智能体**，纯手工走向导，
 * 这样每一步的界面状态都能单独截下来当证据（哪一步填了什么、候选长什么样）。
 */
export async function captureDesignWizardScreenshots(
  window: BrowserWindow,
  options: MachineScreenshotOptions
): Promise<{ captured: number; failed: number }> {
  mkdirSync(options.outputDir, { recursive: true });
  const shots: MachineShotValidation[] = [];
  const seenHashes = new Map<string, string>();
  const step = (name: string, label: string) => capture(window, options.outputDir, name, label, seenHashes);

  window.setContentSize(SHOT_WIDTH, SHOT_HEIGHT);
  window.webContents.setBackgroundThrottling(false);
  await delay(350);
  await waitForExtension(window);

  try {
    // 0. 首页（还没开始建机）
    shots.push(await step('20-wizard-00-home.png', '首页：整机设计入口'));

    // 1. 第一步：基本信息
    await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const home = document.getElementById('homeScreen');
        if (home && !home.hidden) { document.querySelector('.home-link')?.click(); await wait(600); }
        window.AutomationCadViewer?.close();
        window.AutomationCadParametric?.close();
        await window.desktop.design.clearDraft();
        document.getElementById('designWizardEntry').click();
        await wait(700);
        const root = document.getElementById('designWizard');
        const set = (name, value) => {
          const field = root.querySelector('[name="' + name + '"]');
          if (!field) throw new Error('字段缺失：' + name);
          field.value = value;
          field.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('name', '从零建机演示');
        set('stations', '3');
        set('cyclePerMin', '10');
        set('lengthMm', '2400');
        set('widthMm', '1600');
        await wait(200);
        return true;
      })()`
    );
    await settle(window, 300);
    shots.push(await step('20-wizard-01-brief.png', '第 1 步：工艺与节拍'));

    // 2. 第二步：形态候选（3 个方案 + 预测节拍）
    await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const root = document.getElementById('designWizard');
        root.querySelector('[data-action="next"]').click();
        await wait(1600);
        if (root.querySelectorAll('[data-candidate]').length < 3) throw new Error('候选未生成');
        return true;
      })()`
    );
    await settle(window, 350);
    shots.push(await step('20-wizard-02-candidates.png', '第 2 步：形态候选'));

    // 2b. 候选预览（3D 缩略）
    await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const root = document.getElementById('designWizard');
        root.querySelector('[data-preview="0"]')?.click();
        await wait(700);
        return true;
      })()`
    );
    await settle(window, 300);
    shots.push(await step('20-wizard-03-candidate-preview.png', '候选预览'));
    await window.webContents.executeJavaScript(
      `(async () => {
        const root = document.getElementById('designWizard');
        root.querySelector('#designPreviewClose')?.click();
        root.querySelector('[data-action="next"]').click();
        await new Promise((r) => setTimeout(r, 400));
        return true;
      })()`
    );

    // 3. 第三步：工位与执行机构（在第 3 工位加一个执行机构，让点位自动分配可见）
    await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const root = document.getElementById('designWizard');
        root.querySelectorAll('[data-station]')[2]?.click();
        await wait(120);
        root.querySelector('[data-action="add-actuator"]')?.click();
        await wait(250);
        return true;
      })()`
    );
    await settle(window, 350);
    shots.push(await step('20-wizard-04-stations.png', '第 3 步：工位与执行机构'));

    // 4. 第四步：布局
    await window.webContents.executeJavaScript(
      `(async () => {
        const root = document.getElementById('designWizard');
        root.querySelector('[data-action="next"]').click();
        await new Promise((r) => setTimeout(r, 500));
        return true;
      })()`
    );
    await settle(window, 350);
    shots.push(await step('20-wizard-05-layout.png', '第 4 步：布局'));

    // 5. 第五步：评审
    await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const root = document.getElementById('designWizard');
        root.querySelector('[data-action="next"]')?.click();
        await wait(300);
        root.querySelector('[data-action="run-review"]')?.click();
        await wait(600);
        return true;
      })()`
    );
    await settle(window, 350);
    shots.push(await step('20-wizard-06-review.png', '第 5 步：评审与保存'));

    // 5b. 在第 5 步真的生成一次 BOM（不是空面板）
    await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const root = document.getElementById('designWizard');
        root.querySelector('[data-output="bom"]')?.click();
        await wait(900);
        return true;
      })()`
    );
    await settle(window, 350);
    shots.push(await step('20-wizard-06b-bom-generated.png', '第 5 步：生成 BOM'));

    // 6. 保存为工程 → 3D
    await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const root = document.getElementById('designWizard');
        const save = root.querySelector('[data-action="save-project"]');
        if (!save) throw new Error('保存按钮缺失');
        if (save.disabled) {
          const notice = root.querySelector('.design-content')?.textContent || '';
          throw new Error('保存按钮不可用（评审未通过）：' + notice.slice(0, 300));
        }
        save.click();
        // 概念保存后向导不会自己关（要等用户点「保存并关闭」），所以这里显式走同一路径
        await wait(2200);
        const state = document.getElementById('designSaveState')?.textContent || '';
        root.querySelector('[data-action="close"]')?.click();
        for (let i = 0; i < 120 && !root.hidden; i += 1) await wait(250);
        if (!root.hidden) throw new Error('保存后向导仍未关闭：' + state.slice(0, 200));
        window.AutomationCadKinematics?.close();
        document.querySelector('#cadEntryButton')?.click();
        await wait(900);
        return true;
      })()`
    );
    await waitFor(window, `(document.getElementById('cadPartCount')?.textContent || '').trim().length > 0`, '3D 零件数就绪', 30_000);
    await settle(window, 500);
    shots.push(await step('20-wizard-07-3d.png', '保存后：3D 联调'));

    // 注意：向导路径保存的是「概念工程」，CAD 面板里的 BOM/IO 要「应用机型方案」才有内容，
    // 所以这里不抓那两张空面板——BOM 已在第 5 步用「生成 BOM」落成 CSV（06b）。

    console.log(`DESIGN_WIZARD_SHOTS_DONE captured=${shots.length} failed=0`);
    return { captured: shots.length, failed: 0 };
  } catch (error) {
    console.error('DESIGN_WIZARD_SHOTS_FAIL', error);
    return { captured: shots.length, failed: 1 };
  }
}

// ---------------------------------------------------------------------------
// 「联动播放中」真机截图（21-linkage-01/02/03）
//
// 为什么单开一组：15/16 与 20-wizard-07 拍的都是「静态的联调面板 / 保存后的 CAD 面板」，
// 镜头里从来没有「零件正在动」。P0（3D 联动空场景）修好后必须有图能证明零件真的在动，
// 所以这里既要出图，也要把坐标证据打出来（不靠肉眼）。
//
// 抽屉互斥（重要）：`src/ui/panels.ts` 的 createDrawer.open() 会先 closeOtherDrawers()——
// 智能体抽屉（联动面板所在）与联调抽屉（3D 视口所在）停在同一位置，同一时刻只能开一个。
// 因此：
//   - 「点播放 → 零件动」用真实 UI 走一遍（点 [data-linkage-play]），证据是坐标：
//     LINKAGE_UI_PLAY_OK / LINKAGE_UI_RESET_OK；
//   - 三张图在联调抽屉里拍（只有那里看得见 3D）。mid 的位姿不是编的：它取自同一条
//     `machine.linkage()` 时间线上 t≈cycleMs/2 的真实关键帧，通过
//     `window.__cadApplyLinkagePose`（面板播放时调用的同一个写入点）施加，
//     施加后立刻用 `__cadLinkageDebugSnapshot()` 前后对比断言零件确实动了。
// ---------------------------------------------------------------------------

type PoseSnapshot = Record<string, [number, number, number]>;

interface PoseDelta {
  movedParts: number;
  maxDeltaMm: number;
  ids: string[];
}

/** 两次坐标快照的逐件欧氏位移；movedParts/maxDeltaMm 就是「零件真的动了」的证据 */
function poseDelta(before: PoseSnapshot | null, after: PoseSnapshot | null): PoseDelta {
  const ids: string[] = [];
  let maxDeltaMm = 0;
  for (const [id, point] of Object.entries(after ?? {})) {
    const base = before?.[id];
    if (!base) continue;
    const delta = Math.hypot(point[0] - base[0], point[1] - base[1], point[2] - base[2]);
    if (delta > 1e-6) {
      ids.push(id);
      if (delta > maxDeltaMm) maxDeltaMm = delta;
    }
  }
  return { movedParts: ids.length, maxDeltaMm, ids };
}

/**
 * 像素级对比两张 PNG：nativeImage.toBitmap() 给的是 BGRA 原始位图，
 * 不需要 sharp/ffmpeg，也不依赖 PNG 压缩率（字节数只能算弱证据）。
 * 阈值 6/255 用来吃掉抗锯齿与合成噪声，但抓得住「零件挪了几十毫米」这种成片变化。
 *
 * 可选 viewport 矩形：额外统计「差异是否落在 3D 视口里」——面板/顶栏闪一下也会让
 * 全局像素差变大，只有落在视口内的差异才说明零件真的动了。
 */
interface BitmapDiff {
  differentPixels: number;
  totalPixels: number;
  maxChannelDelta: number;
  ratio: number;
  differentInsideViewport: number;
  insideRatio: number;
  outsideRatio: number;
}

function bitmapDiff(
  leftPng: Buffer,
  rightPng: Buffer,
  viewport?: { x: number; y: number; width: number; height: number } | null
): BitmapDiff {
  const leftImage = nativeImage.createFromBuffer(leftPng);
  const rightImage = nativeImage.createFromBuffer(rightPng);
  const left = leftImage.toBitmap();
  const right = rightImage.toBitmap();
  const size = leftImage.getSize();
  const length = Math.min(left.length, right.length);
  const totalPixels = Math.floor(length / 4);
  const width = Math.max(1, size.width);
  // 位图可能被 devicePixelRatio 放大：视口矩形（CSS px）按同比例换算
  const scale = SHOT_WIDTH > 0 ? width / SHOT_WIDTH : 1;
  const rect = viewport
    ? {
        x: Math.round(viewport.x * scale),
        y: Math.round(viewport.y * scale),
        width: Math.round(viewport.width * scale),
        height: Math.round(viewport.height * scale)
      }
    : null;
  let differentPixels = 0;
  let differentInsideViewport = 0;
  let viewportPixels = 0;
  let maxChannelDelta = 0;
  for (let index = 0; index + 3 < length; index += 4) {
    const pixelX = (index / 4) % width;
    const pixelY = Math.floor(index / 4 / width);
    const inside = Boolean(rect
      && pixelX >= rect.x && pixelX < rect.x + rect.width
      && pixelY >= rect.y && pixelY < rect.y + rect.height);
    if (inside) viewportPixels += 1;
    let delta = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const diff = Math.abs((left[index + channel] ?? 0) - (right[index + channel] ?? 0));
      if (diff > delta) delta = diff;
    }
    if (delta > 6) {
      differentPixels += 1;
      if (inside) differentInsideViewport += 1;
    }
    if (delta > maxChannelDelta) maxChannelDelta = delta;
  }
  const outsidePixels = totalPixels - viewportPixels;
  return {
    differentPixels,
    totalPixels,
    maxChannelDelta,
    ratio: totalPixels > 0 ? differentPixels / totalPixels : 0,
    differentInsideViewport,
    insideRatio: viewportPixels > 0 ? differentInsideViewport / viewportPixels : 0,
    outsideRatio: outsidePixels > 0 ? (differentPixels - differentInsideViewport) / outsidePixels : 0
  };
}

/**
 * 用滚轮把联调 3D 视口拉近（OrbitControls 的 wheel 入口，等于用户滚鼠标）。
 * 返回画布是否存在；notches 格 × 120 的 deltaY，实测 5 格约 1.29 倍近且不裁切机体。
 */
async function zoomCommissionViewport(window: BrowserWindow, notches: number): Promise<boolean> {
  return await window.webContents.executeJavaScript(
    `(async () => {
      const canvas = document.querySelector('#commission3dHost canvas');
      if (!canvas) return false;
      for (let index = 0; index < ${Math.max(0, Math.round(notches))}; index += 1) {
        canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      return true;
    })()`
  ) as boolean;
}

/** 联动面板迟迟不出现时的现场快照：不靠猜是「桥没了」还是「管线报错」 */
async function describeLinkageSlot(window: BrowserWindow): Promise<string> {
  try {
    const state = await window.webContents.executeJavaScript(
      `(() => {
        const slot = document.querySelector('.acp-linkage-slot');
        const drawer = document.getElementById('agentDrawer');
        return {
          hasSlot: Boolean(slot),
          hasPanel: Boolean(slot?.querySelector('[data-linkage-panel]')),
          hasError: Boolean(slot?.querySelector('.acp-linkage-error')),
          loading: Boolean(slot?.querySelector('.acp-linkage-loading')),
          bridge: typeof window.desktop?.machine?.linkage === 'function',
          legacyBridge: typeof window.machine?.linkage === 'function',
          drawerOpen: Boolean(drawer && !drawer.hidden),
          slotText: (slot?.textContent || '').slice(0, 200)
        };
      })()`
    );
    return JSON.stringify(state);
  } catch (error) {
    return `诊断失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * 关掉「检测到软件渲染」顶部横幅：它是 fixed + z-index 12000，横跨顶栏 44px，
 * 出现时机由渲染统计的 4.5 s 节流决定——不主动收掉就会在两次截图之间突然出现。
 * 先等它（最多 12 s，真 GPU 机器上不会出现），有就点 ×（真实 UI 入口，幂等）。
 */
async function dismissSoftwareRenderNotice(window: BrowserWindow): Promise<void> {
  await waitForSoft(window, `Boolean(document.getElementById('orbitSoftwareNotice'))`, 12_000);
  const dismissed = await window.webContents.executeJavaScript(
    `(() => {
      const button = document.querySelector('#orbitSoftwareNotice .orbit-software-close');
      if (!button) return false;
      button.click();
      return true;
    })()`
  ) as boolean;
  await waitForSoft(window, `!document.getElementById('orbitSoftwareNotice')`, 3_000);
  console.log(`LINKAGE_SOFTWARE_NOTICE dismissed=${dismissed} present=${Boolean(
    await window.webContents.executeJavaScript(`Boolean(document.getElementById('orbitSoftwareNotice'))`)
  )}`);
}

export async function captureLinkageScreenshots(
  window: BrowserWindow,
  options: MachineScreenshotOptions
): Promise<{ captured: number; failed: number }> {
  mkdirSync(options.outputDir, { recursive: true });
  const evalDir = process.env.AUTOMATIONCAD_EVAL_DIR
    ? resolve(process.env.AUTOMATIONCAD_EVAL_DIR)
    : resolve(options.outputDir, '..', 'eval');
  mkdirSync(evalDir, { recursive: true });
  const baseUrl = process.env.AUTOMATIONCAD_STUB_BASE_URL;
  if (!baseUrl) throw new Error('缺少 AUTOMATIONCAD_STUB_BASE_URL，无法启动离线模型桩');

  window.setContentSize(SHOT_WIDTH, SHOT_HEIGHT);
  window.webContents.setBackgroundThrottling(false);
  await delay(350);
  await waitForExtension(window);

  await window.webContents.executeJavaScript(
    `(async () => {
      const result = await window.desktop.agent.saveLlmConfig({
        baseUrl: ${JSON.stringify(baseUrl)},
        apiKey: 'offline-stub',
        model: 'offline-stub',
        maxIterations: 4
      });
      return result;
    })()`
  );

  const shots: MachineShotValidation[] = [];
  // base 与 mid 必须互异（否则说明画面没刷新 / 没动）；reset 单独一份去重表 ——
  // 复位后本来就该和 base 一模一样，字节相同正是「回得到基准」的表现。
  const seenHashes = new Map<string, string>();
  const step = (name: string, label: string, hashes: Map<string, string> = seenHashes) =>
    capture(window, options.outputDir, name, label, hashes);
  let evidence: Record<string, unknown> = {};

  try {
    // 1) 真实智能体链路：一句话 → 机型方案卡 → 应用到工程（3D 换成 6 工位几何）
    await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const home = document.getElementById('homeScreen');
        if (home && !home.hidden) {
          document.querySelector('.home-link')?.click();
          await wait(600);
        }
        window.AutomationCadViewer?.close();
        window.AutomationCadParametric?.close();
        document.getElementById('commissionDrawer')?.setAttribute('hidden', '');
        document.querySelector('#agentEntryButton')?.click();
        await wait(260);
        const input = document.querySelector('#agentChatInput');
        if (!input) throw new Error('智能体输入框缺失');
        input.value = ${JSON.stringify(BRIEF)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#agentChatSend')?.click();
        return true;
      })()`
    );
    await waitFor(
      window,
      `document.querySelector('.acp-machine-card') && document.querySelectorAll('.acp-machine-card .acp-machine-stats b').length >= 6`,
      '机型方案卡渲染'
    );
    await settle(window, 400);

    await window.webContents.executeJavaScript(
      `(() => {
        if (window.__linkageShotAutoConfirm) return true;
        const state = { count: 0 };
        window.__linkageShotAutoConfirm = state;
        const accept = () => {
          const button = document.querySelector('#acwConfirmMask [data-acw="once"]');
          if (button) { button.click(); state.count += 1; }
        };
        new MutationObserver(accept).observe(document.body, { childList: true, subtree: true });
        accept();
        return true;
      })()`
    );
    await window.webContents.executeJavaScript(
      `(() => {
        const button = document.querySelector('.acp-machine-card [data-apply-machine]');
        if (!button) throw new Error('应用按钮缺失');
        button.click();
        return true;
      })()`
    );
    const applied = await waitForSoft(
      window,
      `(() => {
        const pill = document.querySelector('.acp-machine-card .acp-pill.is-ok');
        return pill && (pill.textContent || '').includes('已应用');
      })()`,
      30_000
    );
    if (!applied) throw new Error('机型方案应用完成超时（联动截图需要 6 工位几何）');
    console.log('LINKAGE_APPLY_OK machine=已应用');

    // 2) 真实 UI 播放：点「联动调试…」→ 点「▶ 播放联动」，轮询坐标证明零件动了
    await window.webContents.executeJavaScript(
      `(() => {
        const button = document.querySelector('.acp-machine-card [data-linkage-machine]');
        if (!button) throw new Error('联动调试按钮缺失');
        button.click();
        return true;
      })()`
    );
    // 面板要主进程跑一次整机管线（实测 0.2 s，但 CI 冷启动可能慢），给足 120 s；
    // 超时不能只说「等待超时」：把 slot 状态与桥的可见性一起打出来，否则没法判断卡在哪。
    const panelReady = await waitForSoft(
      window,
      `Boolean(document.querySelector('.acp-linkage-slot [data-linkage-panel]'))`,
      120_000
    );
    if (!panelReady) throw new Error(`联动面板未渲染：${await describeLinkageSlot(window)}`);
    const panelState = await window.webContents.executeJavaScript(
      `(() => {
        const slot = document.querySelector('.acp-linkage-slot');
        const play = slot?.querySelector('[data-linkage-play]');
        return {
          panel: Boolean(slot?.querySelector('[data-linkage-panel]')),
          steps: slot?.querySelectorAll('[data-linkage-step]').length ?? 0,
          playDisabled: play ? play.disabled : null,
          playTitle: play?.title || '',
          text: (slot?.textContent || '').slice(0, 260)
        };
      })()`
    ) as { panel: boolean; steps: number; playDisabled: boolean | null; playTitle: string; text: string };
    if (!panelState.panel || panelState.steps < 6) {
      throw new Error(`联动面板没有步序（面板内容：${panelState.text}）`);
    }
    if (panelState.playDisabled !== false) {
      // 播放按钮不可用 = 真实 UI 路径断了，不允许退化去「只调函数」然后拍一张没动的图
      throw new Error(`播放按钮不可用：${panelState.playTitle || panelState.text}`);
    }

    const playState = await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const slot = document.querySelector('.acp-linkage-slot');
        const play = slot?.querySelector('[data-linkage-play]');
        const clock = slot?.querySelector('[data-linkage-clock]');
        const snap = window.__cadLinkageDebugSnapshot;
        if (typeof snap !== 'function') return { ok: false, reason: 'no_snapshot_bridge' };
        if (typeof window.__cadApplyLinkagePose !== 'function') return { ok: false, reason: 'no_pose_bridge' };
        const base = snap();
        if (!base || Object.keys(base).length === 0) return { ok: false, reason: 'empty_scene' };
        play.click();
        let best = { movedParts: 0, maxDeltaMm: 0, clock: '', step: 0 };
        for (let attempt = 0; attempt < 70; attempt += 1) {
          await wait(45);
          const now = snap() || {};
          let moved = 0;
          let max = 0;
          for (const [id, point] of Object.entries(now)) {
            const origin = base[id];
            if (!origin) continue;
            const delta = Math.hypot(point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]);
            if (delta > 1e-6) { moved += 1; if (delta > max) max = delta; }
          }
          if (max > best.maxDeltaMm) {
            best = {
              movedParts: moved,
              maxDeltaMm: max,
              clock: clock?.textContent || '',
              step: Number(slot?.querySelector('[data-linkage-step].is-active')?.dataset.linkageStep || 0)
            };
          }
          // 播到明显位移就停（不必等整轮循环），后面的复位/截图不依赖播放是否结束
          if (best.maxDeltaMm > 25 && attempt > 8) break;
        }
        return { ok: true, base, parts: Object.keys(base).length, ...best };
      })()`
    ) as { ok: boolean; reason?: string; base?: PoseSnapshot; parts?: number; movedParts?: number; maxDeltaMm?: number; clock?: string; step?: number };
    if (!playState.ok) throw new Error(`联动播放失败：${playState.reason ?? 'unknown'}`);
    if (!(Number(playState.movedParts) > 0) || !(Number(playState.maxDeltaMm) > 0)) {
      throw new Error(`点了播放但零件没动：movedParts=${playState.movedParts} maxDeltaMm=${playState.maxDeltaMm}`);
    }
    console.log(
      `LINKAGE_UI_PLAY_OK parts=${playState.parts} movedParts=${playState.movedParts} `
      + `maxDeltaMm=${Number(playState.maxDeltaMm).toFixed(3)} clock=${playState.clock} step=${playState.step}`
    );

    // 3) 关闭抽屉（abortLinkagePlayback → resetLinkagePose 的真实入口）→ 坐标必须回基准
    const closed = await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        document.querySelector('#agentDrawer [data-acp-close]')?.click();
        await wait(320);
        const snap = window.__cadLinkageDebugSnapshot;
        return {
          drawerHidden: Boolean(document.getElementById('agentDrawer')?.hidden),
          after: typeof snap === 'function' ? snap() : null
        };
      })()`
    ) as { drawerHidden: boolean; after: PoseSnapshot | null };
    if (!closed.drawerHidden) throw new Error('关闭联动抽屉失败（复位路径没走到）');
    const uiResetDelta = poseDelta(playState.base ?? null, closed.after);
    if (uiResetDelta.maxDeltaMm > 1e-6) {
      throw new Error(`关闭抽屉后姿态没回基准：maxDeltaMm=${uiResetDelta.maxDeltaMm}`);
    }
    console.log(`LINKAGE_UI_RESET_OK maxDeltaMm=${uiResetDelta.maxDeltaMm.toFixed(9)}`);

    // 4) 打开联调抽屉：3D 视口在这里才可见（抽屉互斥，见文件头注释）
    await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        document.querySelector('#commissionEntryButton')?.click();
        await wait(420);
        const body = document.querySelector('#commissionDrawer .acp-drawer-body');
        if (body) body.scrollTop = 0;
        return true;
      })()`
    );
    await waitFor(
      window,
      `(() => {
        const stats = window.__Commission3D?.stats?.();
        return Boolean(stats && stats.webgl === true && (stats.ticks || 0) > 0);
      })()`,
      '联调 3D 视口就绪',
      30_000
    );
    await settle(window, 600);

    const baseSnapshot = await window.webContents.executeJavaScript(
      `(() => {
        const snap = window.__cadLinkageDebugSnapshot;
        const value = typeof snap === 'function' ? snap() : null;
        return value && Object.keys(value).length > 0 ? value : null;
      })()`
    ) as PoseSnapshot | null;
    if (!baseSnapshot) throw new Error('3D 场景没有可联动零件（debugPositions 为空）');
    const partCount = Object.keys(baseSnapshot).length;
    if (partCount < 20) throw new Error(`3D 场景只有 ${partCount} 个零件，不足以证明联动`);
    console.log(`LINKAGE_SCENE_OK parts=${partCount}`);

    // SwiftShader 下 ~5 s 才会弹「检测到软件渲染」的顶部横幅（#orbitSoftwareNotice，
    // position:fixed; inset:0 0 auto 0 → 正好盖住 44px 顶栏）。等它出现过再关掉，
    // 三张图的顶部才一致——否则 base 先拍（没横幅）、mid/reset 后拍（有横幅），
    // 4% 的像素差全是这条横幅，会把「零件动没动」彻底淹掉。
    await dismissSoftwareRenderNotice(window);
    await settle(window, 500);

    // 5) 把 3D 视口拉近一点再拍：视口只有 670×368（抽屉里的 3D 区），
    //    整机在这个窗口里很小，40 mm 的位移只剩几个像素——真实用户看机构动作也会先滚轮拉近。
    //    用 WheelEvent 滚 5 格（OrbitControls 的真实入口，实测约 1.29 倍近），
    //    三张图共用同一机位，对比才成立。缩放失败不影响结论（下面像素阈值按不缩放也能过）。
    const zoomed = await zoomCommissionViewport(window, 5);
    console.log(`LINKAGE_VIEWPORT_ZOOM notches=5 applied=${zoomed}`);
    await settle(window, 600);
    const viewportRect = await window.webContents.executeJavaScript(
      `(() => {
        const rect = document.getElementById('commission3dHost')?.getBoundingClientRect();
        return rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null;
      })()`
    ) as { x: number; y: number; width: number; height: number } | null;

    // 6) 基准姿态（t=0）
    const baseShot = await step('21-linkage-01-base.png', '联动 t=0 基准姿态');
    shots.push(baseShot);
    console.log(`LINKAGE_SHOT_OK name=${baseShot.name} bytes=${baseShot.bytes} movedParts=0 maxDeltaMm=0.000 parts=${partCount}`);

    // 7) 中间帧：取同一条时间线上 t≈cycleMs/2 的真实关键帧（不是手工编的位移）
    const midFrame = await window.webContents.executeJavaScript(
      `(async () => {
        const doc = await window.desktop.machine.linkage(${JSON.stringify(BRIEF)});
        const linkage = doc && doc.linkage ? doc.linkage : doc;
        const frames = Array.isArray(linkage?.frames) ? linkage.frames : [];
        const cycleMs = Number(linkage?.cycleMs ?? 0);
        if (frames.length === 0) return { ok: false, reason: 'no_frames', message: String(doc?.message || '') };
        const target = cycleMs > 0 ? cycleMs / 2 : Number(frames[Math.floor(frames.length / 2)]?.tMs ?? 0);
        let mid = frames[0];
        for (const frame of frames) {
          if (Number(frame?.tMs ?? 0) <= target) mid = frame;
        }
        return {
          ok: true,
          cycleMs,
          frames: frames.length,
          tMs: Number(mid?.tMs ?? 0),
          pose: { offsets: mid?.offsets ?? {}, rotZDeg: mid?.rotZDeg ?? {} }
        };
      })()`
    ) as { ok: boolean; reason?: string; message?: string; cycleMs?: number; frames?: number; tMs?: number; pose?: unknown };
    if (!midFrame.ok || !midFrame.pose) {
      throw new Error(`拿不到联动帧：${midFrame.reason ?? 'unknown'} ${midFrame.message ?? ''}`);
    }

    const appliedMid = await window.webContents.executeJavaScript(
      `(() => {
        const snap = window.__cadLinkageDebugSnapshot;
        if (typeof window.__cadApplyLinkagePose !== 'function') return { ok: false, reason: 'bridge_missing' };
        window.__cadApplyLinkagePose(${JSON.stringify(midFrame.pose)});
        return { ok: true, after: typeof snap === 'function' ? snap() : null };
      })()`
    ) as { ok: boolean; reason?: string; after?: PoseSnapshot | null };
    if (!appliedMid.ok) throw new Error(`联动位姿桥缺失：${appliedMid.reason}`);
    const midDelta = poseDelta(baseSnapshot, appliedMid.after ?? null);
    if (midDelta.movedParts < 1 || midDelta.maxDeltaMm <= 0) {
      throw new Error(`中间帧位姿没落到零件上：movedParts=${midDelta.movedParts} maxDeltaMm=${midDelta.maxDeltaMm}`);
    }
    await settle(window, 320);
    const midShot = await step('21-linkage-02-mid.png', `联动播放中 t≈${Math.round(Number(midFrame.tMs))} ms`);
    shots.push(midShot);
    console.log(
      `LINKAGE_SHOT_OK name=${midShot.name} bytes=${midShot.bytes} movedParts=${midDelta.movedParts} `
      + `maxDeltaMm=${midDelta.maxDeltaMm.toFixed(3)} tMs=${midFrame.tMs} frames=${midFrame.frames} `
      + `sample=${midDelta.ids.slice(0, 3).join(',')}`
    );

    // 8) 复位（与 abortLinkagePlayback 调的同一个 resetLinkagePose 写入点）
    const resetState = await window.webContents.executeJavaScript(
      `(() => {
        const reset = window.__cadResetLinkagePose;
        if (typeof reset !== 'function') return { ok: false, reason: 'reset_bridge_missing' };
        reset();
        const snap = window.__cadLinkageDebugSnapshot;
        return { ok: true, after: typeof snap === 'function' ? snap() : null };
      })()`
    ) as { ok: boolean; reason?: string; after?: PoseSnapshot | null };
    if (!resetState.ok) throw new Error(`复位桥缺失：${resetState.reason}`);
    const resetDelta = poseDelta(baseSnapshot, resetState.after ?? null);
    if (resetDelta.maxDeltaMm > 1e-6) {
      throw new Error(`复位后没回到基准：maxDeltaMm=${resetDelta.maxDeltaMm}（${resetDelta.ids.slice(0, 3).join(',')}）`);
    }
    await settle(window, 320);
    // reset 用独立去重表（只拦「和 mid 一模一样」）：与 base 字节相同恰恰说明复位到位
    const midHash = createHash('sha256')
      .update(readFileSync(join(options.outputDir, '21-linkage-02-mid.png')))
      .digest('hex');
    const resetSeen = new Map<string, string>([[midHash, '21-linkage-02-mid.png']]);
    const resetShot = await step('21-linkage-03-reset.png', '取消播放后回到 t=0 基准', resetSeen);
    shots.push(resetShot);
    console.log(
      `LINKAGE_RESET_OK name=${resetShot.name} maxDeltaMm=${resetDelta.maxDeltaMm.toFixed(9)} `
      + `movedParts=${resetDelta.movedParts}`
    );

    // 9) 像素证据（不靠肉眼）：base↔mid 必须成片不同，base↔reset 必须几乎相同。
    //    同时按 3D 视口矩形分区统计：差异应该几乎全落在视口里（= 零件在动，不是顶栏/面板在闪）。
    const basePng = readFileSync(join(options.outputDir, '21-linkage-01-base.png'));
    const midPng = readFileSync(join(options.outputDir, '21-linkage-02-mid.png'));
    const resetPng = readFileSync(join(options.outputDir, '21-linkage-03-reset.png'));
    const baseVsMid = bitmapDiff(basePng, midPng, viewportRect);
    const baseVsReset = bitmapDiff(basePng, resetPng, viewportRect);
    console.log(
      `LINKAGE_PIXEL_OK base_vs_mid=${(baseVsMid.ratio * 100).toFixed(3)}% `
      + `in_viewport=${(baseVsMid.insideRatio * 100).toFixed(3)}% `
      + `maxChannelDelta=${baseVsMid.maxChannelDelta} `
      + `base_vs_reset=${(baseVsReset.ratio * 100).toFixed(3)}% `
      + `maxChannelDelta=${baseVsReset.maxChannelDelta}`
    );
    // 阈值按本机实测留余量（SwiftShader 1600×1000）：base↔mid 实测 0.075%，
    // 其中 ~100% 落在 670×368 的 3D 视口内；base↔reset 实测 0.000%（字节相同）。
    if (baseVsMid.ratio < 0.0003) {
      throw new Error(`base 与 mid 只有 ${(baseVsMid.ratio * 100).toFixed(3)}% 像素不同，看不出零件在动`);
    }
    if (baseVsMid.insideRatio < 0.0002) {
      throw new Error(`base 与 mid 的差异不在 3D 视口内（视口内仅 ${(baseVsMid.insideRatio * 100).toFixed(3)}%），可能是面板噪声`);
    }
    if (baseVsReset.ratio > 0.0002) {
      throw new Error(`base 与 reset 有 ${(baseVsReset.ratio * 100).toFixed(3)}% 像素不同，复位没回到基准`);
    }

    evidence = {
      parts: partCount,
      uiPlay: {
        movedParts: playState.movedParts,
        maxDeltaMm: playState.maxDeltaMm,
        clock: playState.clock,
        activeStep: playState.step,
        resetMaxDeltaMm: uiResetDelta.maxDeltaMm
      },
      midFrame: {
        tMs: midFrame.tMs,
        frames: midFrame.frames,
        cycleMs: midFrame.cycleMs,
        movedParts: midDelta.movedParts,
        maxDeltaMm: midDelta.maxDeltaMm,
        sampleParts: midDelta.ids.slice(0, 5)
      },
      reset: { maxDeltaMm: resetDelta.maxDeltaMm },
      viewport: { rect: viewportRect, zoomNotches: zoomed ? 5 : 0 },
      pixels: {
        baseVsMid: baseVsMid.ratio,
        baseVsMidInsideViewport: baseVsMid.insideRatio,
        baseVsReset: baseVsReset.ratio,
        baseVsMidMaxChannelDelta: baseVsMid.maxChannelDelta,
        baseVsResetMaxChannelDelta: baseVsReset.maxChannelDelta
      }
    };
    const validationFile = join(evalDir, 'linkage-screenshots.json');
    writeFileSync(validationFile, `${JSON.stringify({
      schemaVersion: 1,
      kind: 'linkage-screenshots',
      size: { width: SHOT_WIDTH, height: SHOT_HEIGHT },
      shots,
      evidence
    }, null, 2)}\n`, 'utf8');
    console.log(`LINKAGE_SHOTS_DONE captured=${shots.length} failed=0 validation=${validationFile}`);
    return { captured: shots.length, failed: 0 };
  } catch (error) {
    console.error('LINKAGE_SHOTS_FAIL', error);
    try {
      const validationFile = join(evalDir, 'linkage-screenshots.json');
      writeFileSync(validationFile, `${JSON.stringify({
        schemaVersion: 1,
        kind: 'linkage-screenshots',
        size: { width: SHOT_WIDTH, height: SHOT_HEIGHT },
        shots,
        evidence,
        error: error instanceof Error ? error.message : String(error)
      }, null, 2)}\n`, 'utf8');
    } catch (writeError) {
      console.warn('[LINKAGE_SCREENSHOT_FAILURE_REPORT]', { site: 'desktop/electron/machine-screenshots.ts' }, writeError);
    }
    return { captured: shots.length, failed: 1 };
  }
}

/** 智能体面板单张截图的结果：比 machine 多一个 nodes（结果区真实节点数）。 */
export interface AgentShotValidation {
  name: string;
  label: string;
  width: number;
  height: number;
  bytes: number;
  nodes: number;
  uniqueColors: number;
}

/**
 * 智能体面板截图：与 `capture()` 同一套抓帧/去重口径，但多两条针对面板的守卫——
 * - `bytes > 60 KB`：纯色面板（抽屉没渲染出来）PNG 会压到几 KB；
 * - `nodes > 0`：由调用方传入「结果区真实节点数」，为 0 说明内容没落进 DOM。
 */
async function captureAgentShot(
  window: BrowserWindow,
  outputDir: string,
  name: string,
  label: string,
  nodes: number,
  seenHashes: Map<string, string>
): Promise<AgentShotValidation> {
  await window.webContents.executeJavaScript(
    `document.getElementById('cadNotice')?.classList.remove('is-on');
     document.getElementById('acpToast')?.classList.remove('is-on'); true`
  );
  await settle(window);
  // 与 machine 截图同因：xvfb 下窗口被判遮挡时合成器不产新帧，先确保可见再主动作废一帧。
  if (!window.isVisible()) window.showInactive();
  window.webContents.invalidate();
  await settle(window, 320);
  const png = await grabPng(window);
  const image = nativeImage.createFromBuffer(png);
  const { width, height } = image.getSize();
  if (width !== SHOT_WIDTH || height !== SHOT_HEIGHT) {
    throw new Error(`${name} 尺寸 ${width}×${height}，期望 ${SHOT_WIDTH}×${SHOT_HEIGHT}`);
  }
  const hash = createHash('sha256').update(png).digest('hex');
  const duplicateOf = seenHashes.get(hash);
  if (duplicateOf) {
    throw new Error(`${name} 与 ${duplicateOf} 字节完全相同，抓到的是同一帧（面板没刷新）`);
  }
  seenHashes.set(hash, name);
  const target = join(outputDir, name);
  writeFileSync(target, png);
  const bytes = statSync(target).size;
  if (bytes <= 60 * 1024) throw new Error(`${name} 仅 ${bytes} 字节（要求 > 60 KB），疑似面板没渲染`);
  if (!(nodes > 0)) throw new Error(`${name} 结果区节点数 ${nodes}，画面里没有可断言的内容`);
  const uniqueColors = uniqueColorCount(image.toBitmap());
  if (uniqueColors <= 500) throw new Error(`${name} 唯一色数 ${uniqueColors}，疑似单色/空白`);
  console.log(`AGENT_SHOT_OK name=${name} label=${label} bytes=${bytes} nodes=${nodes}`);
  return { name, label, width, height, bytes, nodes, uniqueColors };
}

/** 智能体对话的现场快照：超时时能说清是「没回」还是「回了但内容不对」，不靠猜。 */
async function describeAgentChat(window: BrowserWindow): Promise<string> {
  try {
    const state = await window.webContents.executeJavaScript(
      `(() => {
        const log = document.getElementById('agentChatLog');
        const feedback = document.getElementById('agentChatFeedback');
        return {
          status: document.getElementById('agentChatStatus')?.textContent || '',
          feedback: feedback && !feedback.hidden ? feedback.textContent : '',
          messages: Array.from(log ? log.querySelectorAll('.acp-chat-msg') : []).map((node) => ({
            role: node.className.includes('is-user') ? 'user' : 'assistant',
            text: (node.textContent || '').slice(0, 240)
          })),
          receipt: log?.querySelector('.acp-chat-receipt')?.textContent || '',
          bubbles: log ? log.querySelectorAll('.acp-chat-bubble').length : 0
        };
      })()`
    );
    return JSON.stringify(state);
  } catch (error) {
    return `诊断失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

const AGENT_DOC_QUERY = 'D2 是什么决策';
const AGENT_SECOND_QUERY = '没有尺寸的件怎么处理';

/**
 * 智能体面板三张真机截图：初始态 / 离线规则问答 / 审计记录。
 *
 * 全部走真实 DOM 入口：`#agentEntryButton` 开抽屉、`#agentChatInput` 填字、
 * `#agentChatSend` 点发送、`#agentAuditRefresh` 刷审计、`#agentAuditList` 点开一行。
 * 不调用内部函数、不拼假消息。
 *
 * 离线怎么来的：`getSession()` 在缺 key 时直接抛错（连离线降级都不会走），所以这里必须
 * 配一条**必然失败**的 LLM 端点——回环 127.0.0.1 上已关闭的端口（由 capture 脚本用
 * net 现取空端口传入）。请求立刻 ECONNREFUSED → `runOffline()` → 规则路由执行只读
 * `search_docs`。全程不出本机、不联网。
 */
export async function captureAgentScreenshots(
  window: BrowserWindow,
  options: MachineScreenshotOptions
): Promise<{ captured: number; failed: number }> {
  mkdirSync(options.outputDir, { recursive: true });
  const shots: AgentShotValidation[] = [];
  const seenHashes = new Map<string, string>();
  // 默认 127.0.0.1:9（discard，容器里通常没人监听）：没有 stub 服务器，等于「模型不可达」。
  const offlineBaseUrl = process.env.AUTOMATIONCAD_AGENT_OFFLINE_BASE_URL || 'http://127.0.0.1:9/v1';

  window.setContentSize(SHOT_WIDTH, SHOT_HEIGHT);
  window.webContents.setBackgroundThrottling(false);
  await delay(350);
  await waitForExtension(window);

  console.log(`AGENT_SHOTS_ENDPOINT baseUrl=${offlineBaseUrl} reachable=no（回环空端口，不联网）`);

  await window.webContents.executeJavaScript(
    `(async () => {
      const saved = await window.desktop.agent.saveLlmConfig({
        baseUrl: ${JSON.stringify(offlineBaseUrl)},
        apiKey: 'offline-rules-shots',
        model: 'offline-rules',
        maxIterations: 4
      });
      return saved;
    })()`
  );

  try {
    // 0. 离开首页 + 收起其它面板，再点工具栏入口开智能体抽屉（真实 UI 入口）。
    const opened = await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const home = document.getElementById('homeScreen');
        if (home && !home.hidden) { document.querySelector('.home-link')?.click(); await wait(600); }
        window.AutomationCadViewer?.close();
        window.AutomationCadParametric?.close();
        document.getElementById('commissionDrawer')?.setAttribute('hidden', '');
        const entry = document.getElementById('agentEntryButton');
        if (!entry) throw new Error('智能体入口按钮缺失（#agentEntryButton）');
        entry.click();
        await wait(500);
        const drawer = document.getElementById('agentDrawer');
        const input = document.getElementById('agentChatInput');
        const log = document.getElementById('agentChatLog');
        if (!drawer || drawer.hidden) throw new Error('智能体侧栏没有打开（#agentDrawer 仍 hidden）');
        if (!(input instanceof HTMLTextAreaElement)) throw new Error('智能体输入框缺失（#agentChatInput）');
        if (!log) throw new Error('对话区缺失（#agentChatLog）');
        return {
          title: document.querySelector('#agentDrawer .acp-drawer-title')?.textContent || '',
          placeholder: input.placeholder,
          empty: log.textContent.trim(),
          preview: document.getElementById('agentPlanTitle')?.textContent || '',
          send: Boolean(document.getElementById('agentChatSend')),
          sendText: document.getElementById('agentChatSend')?.textContent || ''
        };
      })()`
    ) as {
      title: string; placeholder: string; empty: string; preview: string; send: boolean; sendText: string;
    };
    if (!opened.title.includes('智能体')) throw new Error(`抽屉标题异常：${opened.title}`);
    if (!opened.placeholder || !opened.placeholder.includes('例如')) {
      throw new Error(`输入框缺少示例提示，placeholder=${opened.placeholder}`);
    }
    if (!opened.send || !opened.sendText.includes('发送')) throw new Error('发送按钮缺失');
    console.log(
      `AGENT_PANEL_OPEN title=${opened.title} placeholder=${JSON.stringify(opened.placeholder)} ` +
        `preview=${JSON.stringify(opened.preview)}`
    );

    // 1. 初始态：空对话 + 输入框 + 示例提示
    const initialNodes = await window.webContents.executeJavaScript(
      `document.querySelectorAll('#agentChatLog *').length`
    ) as number;
    if (initialNodes <= 0) throw new Error('初始态对话区没有节点');
    shots.push(await captureAgentShot(
      window, options.outputDir, '22-agent-01-panel.png',
      '智能体侧栏初始态：输入框 + 示例提示 + 空对话', initialNodes, seenHashes
    ));

    // 2. 真实输入 + 点发送 → 离线规则路由执行 search_docs
    const sent = await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const input = document.getElementById('agentChatInput');
        const preview = document.getElementById('agentPlanPreview');
        input.focus();
        input.value = ${JSON.stringify(AGENT_DOC_QUERY)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(180);
        const plan = {
          tool: preview?.dataset.tool || '',
          readOnly: preview?.dataset.readOnly || '',
          offline: preview?.dataset.offline || '',
          title: document.getElementById('agentPlanTitle')?.textContent || '',
          hint: document.getElementById('agentPlanHint')?.textContent || ''
        };
        const send = document.getElementById('agentChatSend');
        if (!send) throw new Error('发送按钮缺失（#agentChatSend）');
        send.click();
        return plan;
      })()`
    ) as { tool: string; readOnly: string; offline: string; title: string; hint: string };
    if (sent.tool !== 'search_docs' || sent.readOnly !== '1' || sent.offline !== '1') {
      throw new Error(`计划预览不是「只读·可离线」的 search_docs：${JSON.stringify(sent)}`);
    }
    console.log(
      `AGENT_PLAN_PREVIEW tool=${sent.tool} readOnly=${sent.readOnly} offline=${sent.offline} ` +
        `title=${JSON.stringify(sent.title)} hint=${JSON.stringify(sent.hint)}`
    );

    // 等真实回答落进对话区：必须有助手气泡、含 search_docs 与 docs/desktop/ 命中来源
    await waitFor(
      window,
      `(() => {
        const bubble = document.querySelector('#agentChatLog .acp-chat-msg.is-assistant .acp-chat-bubble');
        const text = bubble ? bubble.textContent || '' : '';
        return text.length > 80 && text.includes('search_docs') && text.includes('docs/desktop/');
      })()`,
      '离线规则回答（含 search_docs 与 docs/desktop 来源）',
      40_000
    );
    // 回执「离线规则」= 真走了离线通道，不是在线模型
    await waitFor(
      window,
      `(() => {
        const receipt = document.querySelector('#agentChatLog .acp-chat-receipt');
        return Boolean(receipt && (receipt.textContent || '').includes('离线规则'));
      })()`,
      '离线回执（离线规则）',
      20_000
    );

    const answer = await window.webContents.executeJavaScript(
      `(() => {
        const log = document.getElementById('agentChatLog');
        const user = log.querySelector('.acp-chat-msg.is-user .acp-chat-bubble')?.textContent || '';
        const bubble = log.querySelector('.acp-chat-msg.is-assistant .acp-chat-bubble');
        const text = bubble?.textContent || '';
        const receipt = log.querySelector('.acp-chat-receipt');
        // 对话区 260px 高：回到顶部才是「提问 + 回答开头（含 source/heading）」同框
        log.scrollTop = 0;
        const sourceMatch = text.match(/docs\\/desktop\\/[A-Za-z0-9._\\/-]+/);
        // 不只看 DOM 里有：用 Range 量出 source 文字与提问气泡的实际像素位置，
        // 断言它们落在对话区的可视裁剪区内（否则截图上根本看不见）。
        const logRect = log.getBoundingClientRect();
        const inside = (rect) => rect.width > 0 && rect.top >= logRect.top - 1 && rect.bottom <= logRect.bottom + 1;
        const userBubble = log.querySelector('.acp-chat-msg.is-user .acp-chat-bubble');
        const node = bubble ? bubble.firstChild : null;
        let sourceVisible = false;
        if (node && node.nodeType === 3 && sourceMatch) {
          const start = text.indexOf(sourceMatch[0]);
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + sourceMatch[0].length);
          sourceVisible = inside(range.getBoundingClientRect());
        }
        return {
          user,
          textLength: text.length,
          visibleHead: text.slice(0, 600),
          source: sourceMatch ? sourceMatch[0] : '',
          sourceVisible,
          questionVisible: userBubble ? inside(userBubble.getBoundingClientRect()) : false,
          hasHeading: text.includes('heading'),
          receipt: receipt ? receipt.textContent : '',
          receiptTone: receipt ? receipt.className : '',
          nodes: log.querySelectorAll('*').length
        };
      })()`
    ) as {
      user: string; textLength: number; visibleHead: string; source: string; sourceVisible: boolean;
      questionVisible: boolean; hasHeading: boolean; receipt: string; receiptTone: string; nodes: number;
    };
    if (!answer.user.includes(AGENT_DOC_QUERY)) throw new Error(`提问没进对话区：${answer.user}`);
    if (!answer.questionVisible) throw new Error('提问气泡不在对话区可视范围内（截图上看不到提问）');
    if (!answer.textLength || answer.textLength < 80) throw new Error('回答为空');
    if (!answer.source) throw new Error('回答里没有 docs/desktop/ 命中来源');
    if (!answer.sourceVisible) throw new Error(`命中来源 ${answer.source} 不在对话区可视范围内`);
    if (!answer.hasHeading) throw new Error('回答里没有 heading 字段');
    if (!answer.receipt.includes('离线规则')) throw new Error(`回执不是离线通道：${answer.receipt}`);
    if (!/is-warn/.test(answer.receiptTone)) throw new Error(`离线回执底色异常：${answer.receiptTone}`);
    console.log(
      `AGENT_ANSWER_OK user=${JSON.stringify(AGENT_DOC_QUERY)} chars=${answer.textLength} ` +
        `source=${answer.source} receipt=${JSON.stringify(answer.receipt)}`
    );
    shots.push(await captureAgentShot(
      window, options.outputDir, '22-agent-02-answer.png',
      '离线规则问答：只读 search_docs 命中本地文档（source/heading）', answer.nodes, seenHashes
    ));

    // 3. 再跑一条离线只读查询，让审计里有两行；然后滚到审计区、点开第一行看执行记录
    await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const input = document.getElementById('agentChatInput');
        input.value = ${JSON.stringify(AGENT_SECOND_QUERY)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(180);
        document.getElementById('agentChatSend')?.click();
        return true;
      })()`
    );
    await waitFor(
      window,
      `document.querySelectorAll('#agentChatLog .acp-chat-msg.is-user').length >= 2 &&
       document.querySelectorAll('#agentChatLog .acp-chat-msg.is-assistant .acp-chat-bubble').length >= 2`,
      '第二条离线回答',
      40_000
    );

    const audit = await window.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        document.getElementById('agentAuditRefresh')?.click();
        let rows = 0;
        let summary = '';
        for (let attempt = 0; attempt < 60; attempt += 1) {
          await wait(100);
          rows = document.querySelectorAll('#agentAuditList .acp-audit-row').length;
          summary = document.getElementById('agentAuditSummary')?.textContent || '';
          if (rows >= 2) break;
        }
        // 展开第一行：审计行是 <details>，点 summary 等价于用户点开看执行记录
        document.querySelector('#agentAuditList .acp-audit-row summary')?.click();
        const sectionTitle = document.getElementById('agentAuditCount')?.closest('.acp-section-title');
        (sectionTitle || document.getElementById('agentAuditList'))?.scrollIntoView({ block: 'start' });
        await wait(260);
        const first = document.querySelector('#agentAuditList .acp-audit-row');
        return {
          rows,
          summary,
          count: document.getElementById('agentAuditCount')?.textContent || '',
          firstRow: first ? first.textContent.replace(/\\s+/g, ' ').trim() : '',
          expanded: first ? first.hasAttribute('open') : false,
          nodes: document.querySelectorAll('#agentAuditList .acp-audit-row').length,
          visible: (() => {
            const body = document.querySelector('#agentDrawer .acp-drawer-body');
            const list = document.getElementById('agentAuditList');
            if (!body || !list) return false;
            const bodyRect = body.getBoundingClientRect();
            const listRect = list.getBoundingClientRect();
            return listRect.top < bodyRect.bottom && listRect.bottom > bodyRect.top;
          })()
        };
      })()`
    ) as {
      rows: number; summary: string; count: string; firstRow: string; expanded: boolean;
      nodes: number; visible: boolean;
    };
    if (audit.rows < 2) throw new Error(`审计只有 ${audit.rows} 行，离线查询没写进审计`);
    if (!audit.summary.includes('共')) throw new Error(`审计汇总异常：${audit.summary}`);
    if (!audit.firstRow.includes('search_docs')) throw new Error(`审计行不含 search_docs：${audit.firstRow}`);
    if (!audit.expanded) throw new Error('审计第一行没有展开（点击没生效）');
    if (!audit.visible) throw new Error('审计列表不在抽屉可视区内（滚动没生效）');
    console.log(
      `AGENT_AUDIT_OK rows=${audit.rows} count=${audit.count} summary=${JSON.stringify(audit.summary)} ` +
        `expanded=${audit.expanded}`
    );
    shots.push(await captureAgentShot(
      window, options.outputDir, '22-agent-03-audit.png',
      '审计：离线只读的工具调用记录（工具名/参数/结果/耗时）', audit.nodes, seenHashes
    ));

    console.log(`AGENT_SHOTS_DONE captured=${shots.length} failed=0 dir=${options.outputDir}`);
    return { captured: shots.length, failed: 0 };
  } catch (error) {
    console.error('AGENT_SHOTS_FAIL', error);
    console.error('AGENT_SHOTS_STATE', await describeAgentChat(window));
    return { captured: shots.length, failed: 1 };
  }
}

