/**
 * 真机自检：在一个真实 Electron 窗口里跑 `capture_view` 的全部四个视图
 * （`3d / linkage / library / exports`）。
 *
 * 用法（headless，本机已用 xvfb 实跑）：
 *   xvfb-run -a -s "-screen 0 1920x1200x24" \
 *     node_modules/.bin/electron . --no-sandbox --headless-capture-view
 *
 * 断言：
 *   1. 还停在首页时，四个视图**全部**返回 `VIEW_NOT_READY`，且 `agent-shots/` 里没有新文件
 *      （这一条是「不许拿首页截图冒充」的闸门，不能省）；
 *   2. 点「进入经典原型界面」后，每个视图都真的点到入口、真的把面板/下拉打开、再截图：
 *      落盘文件字节/尺寸真实、PNG 魔数正确、sha256 与磁盘一致；
 *   3. 每张图做像素统计（颜色数 / 亮度标准差），纯色或近纯色的帧如实报
 *      `VIEW_EMPTY view=<v> reason=<code>`，**不**参与 distinct 校验，也不靠「刚好不为空」蒙过去；
 *   4. 四张非空图的 sha256 两两不同 —— 相同就是拿了同一帧（之前真的发生过）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { AGENT_CAPTURE_VIEWS, captureAgentView, type AgentCaptureView } from '../src/agent/self-evidence.ts';
import { createAgentViewCapture } from './agent-capture.ts';
import { decodePng, resizeRgba, VISION_MAX_BYTES, VISION_MAX_EDGE } from '../src/agent/vision-image.ts';
import { cropImage } from '../src/agent/capture-region.ts';
import { loadShotImage } from '../src/agent/vision.ts';

export interface SelfEvidenceShot {
  view: string;
  path: string;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
}

export interface SelfEvidenceCheckResult {
  ok: boolean;
  homeGateRejected: boolean;
  /** 非空截图里 sha256 互不相同的张数（等于 shots.length 才算过） */
  distinct: number;
  /** 像素统计判定为空白/无内容的视图 */
  empty: string[];
  shots: SelfEvidenceShot[];
}

interface FrameStats {
  width: number;
  height: number;
  /** 去重后的颜色数（超过 4096 就记 4096，说明画面足够丰富） */
  colors: number;
  /** 亮度标准差（0 = 纯色） */
  lumaStd: number;
}

interface ViewProbe {
  view: string;
  /** 目标面板在视口里的位置（CSS px） */
  rect: { x: number; y: number; w: number; h: number };
  /** 面板里的真实内容量（点位数 / 导出项数 / 文本长度…） */
  detail: string;
  /** 结构上是否真的是「这个视图打开了且有内容」 */
  pass: boolean;
}

/** 空白判定阈值：颜色数 ≤ 8 或亮度标准差 < 2 就是纯色/渐变底，不可能是真实界面。 */
const EMPTY_MAX_COLORS = 8;
const EMPTY_MIN_LUMA_STD = 2;

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

/** 像素统计：用来判「这张图是不是纯色底」，比看字节数靠谱（压缩过的纯色图也可能几十 KB）。 */
function frameStats(png: Uint8Array): FrameStats {
  const image = decodePng(png);
  const seen = new Set<number>();
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  const step = 4; // 每 4 个像素取 1 个：1600×1000 也够统计，且不拖慢自检
  for (let index = 0; index + 3 < image.data.length; index += 4 * step) {
    const r = image.data[index] ?? 0;
    const g = image.data[index + 1] ?? 0;
    const b = image.data[index + 2] ?? 0;
    if (seen.size < 4096) seen.add((r << 16) | (g << 8) | b);
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += luma;
    sumSq += luma * luma;
    count += 1;
  }
  const mean = count > 0 ? sum / count : 0;
  const variance = count > 0 ? Math.max(0, sumSq / count - mean * mean) : 0;
  return { width: image.width, height: image.height, colors: seen.size, lumaStd: Math.sqrt(variance) };
}

function isBlank(stats: FrameStats): boolean {
  return stats.colors <= EMPTY_MAX_COLORS || stats.lumaStd < EMPTY_MIN_LUMA_STD;
}

/** 结构探针：不只是「截到了图」，还要确认目标面板真的打开、真的有内容、真的落在视口里。 */
async function probeView(window: BrowserWindow, view: AgentCaptureView): Promise<ViewProbe> {
  return await window.webContents.executeJavaScript(
    `(() => {
      const view = ${JSON.stringify(view)};
      const empty = { x: 0, y: 0, w: 0, h: 0 };
      const rectOf = (element) => {
        if (!element) return empty;
        const r = element.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      };
      const inViewport = (r) => r.w > 0 && r.h > 0 && r.x + r.w > 0 && r.y + r.h > 0
        && r.x < window.innerWidth && r.y < window.innerHeight;
      if (view === '3d') {
        // 建模工作区的 3D 舞台是 #stageAssembly（#cadHost 属于「CAD 查看」覆盖层，
        // 层没开时它是 0×0 —— 拿它做判据会把「真的 3D 工作区」误判成空视图）。
        const stage = document.getElementById('stageAssembly');
        const overlay = document.getElementById('automationCadOverlay');
        const openDrawers = [...document.querySelectorAll('.acp-drawer')].filter((el) => !el.hidden).map((el) => el.id);
        const menu = document.getElementById('cadExportMenu');
        const menuOpen = Boolean(menu && !menu.hidden);
        const overlayOpen = Boolean(overlay && !overlay.hidden);
        const rect = rectOf(stage);
        return {
          view,
          rect,
          detail: 'openDrawers=' + openDrawers.length + ' menu=' + (menuOpen ? 'open' : 'closed') + ' overlay=' + (overlayOpen ? 'open' : 'closed'),
          pass: inViewport(rect) && openDrawers.length === 0 && !menuOpen && !overlayOpen
        };
      }
      if (view === 'library') {
        const drawer = document.getElementById('machineLibraryDrawer');
        const rect = rectOf(drawer);
        const text = (drawer && drawer.innerText ? drawer.innerText : '').trim().length;
        const buttons = drawer ? drawer.querySelectorAll('button').length : 0;
        return { view, rect, detail: 'text=' + text + ' buttons=' + buttons, pass: inViewport(rect) && text > 40 && buttons > 0 };
      }
      if (view === 'linkage') {
        const drawer = document.getElementById('commissionDrawer');
        const rect = rectOf(drawer);
        const points = document.querySelectorAll('#commissionPoints tr').length;
        const steps = document.querySelectorAll('#commissionPowerSteps > *').length;
        return { view, rect, detail: 'points=' + points + ' steps=' + steps, pass: inViewport(rect) && points > 0 && steps > 0 };
      }
      const menu = document.getElementById('cadExportMenu');
      const rect = rectOf(menu);
      const items = menu ? menu.querySelectorAll('[data-export]').length : 0;
      const overlay = document.getElementById('automationCadOverlay');
      const overlayOpen = Boolean(overlay && !overlay.hidden);
      return { view, rect, detail: 'items=' + items + ' overlay=' + (overlayOpen ? 'open' : 'closed'), pass: inViewport(rect) && items > 0 && overlayOpen };
    })()`
  ) as ViewProbe;
}

export async function checkAgentViewCapture(window: BrowserWindow, userDataRoot: string): Promise<SelfEvidenceCheckResult> {
  const capture = createAgentViewCapture(() => window);
  const deps = { userDataRoot, capture };
  const shotsDir = join(userDataRoot, 'agent-shots');

  window.setContentSize(1600, 1000);
  window.webContents.setBackgroundThrottling(false);
  await waitFor(window, `window.__AUTOMATION_CAD_EXTENSION_READY__ === true`, '桌面扩展就绪', 25_000);
  await delay(300);

  // 1) 首页闸门：四个视图此时都必须拒拍，且不能留下任何截图
  const before = existsSync(shotsDir) ? readdirSync(shotsDir).length : 0;
  for (const view of AGENT_CAPTURE_VIEWS) {
    const rejected = await captureAgentView({ view }, deps);
    if (rejected.ok !== false || rejected.code !== 'VIEW_NOT_READY') {
      throw new Error(`首页闸门失效（view=${view}）：${JSON.stringify(rejected)}`);
    }
    console.log(`AGENT_CAPTURE_HOME_GATE_OK view=${view} code=${String(rejected.code)}`);
  }
  const after = existsSync(shotsDir) ? readdirSync(shotsDir).length : 0;
  if (after !== before) {
    throw new Error(`首页闸门失效：拒绝时仍写了 ${after - before} 个截图`);
  }
  console.log(`AGENT_CAPTURE_HOME_GATE_OK views=${AGENT_CAPTURE_VIEWS.length} files_before=${before} files_after=${after}`);

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

  const shots: SelfEvidenceShot[] = [];
  const empty: string[] = [];
  for (const view of AGENT_CAPTURE_VIEWS) {
    const result = await captureAgentView({ view, width: 1600, height: 1000 }, deps);
    // 拿不到图就是真失败：报错误码，绝不把上一次的帧当成这个视图的结果
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

    const stats = frameStats(disk);
    if (isBlank(stats)) {
      empty.push(view);
      console.log(
        `VIEW_EMPTY view=${view} reason=flat-frame colors=${stats.colors} luma_std=${stats.lumaStd.toFixed(2)} bytes=${disk.length} size=${stats.width}x${stats.height} path=${path}`
      );
      continue;
    }

    // 结构探针：像素不空不等于「这个视图真的打开了」（比如 exports 只截到了 3D 底图）。
    // 面板可能还在渲染，给最多 2.5 s 的收敛时间，仍不通过就按空视图如实报。
    let probe = await probeView(window, view);
    for (let attempt = 0; attempt < 10 && !probe.pass; attempt += 1) {
      await delay(250);
      probe = await probeView(window, view);
    }
    console.log(`AGENT_CAPTURE_VIEW_PROBE view=${view} pass=${probe.pass} rect=${probe.rect.w}x${probe.rect.h}@${probe.rect.x},${probe.rect.y} ${probe.detail}`);
    if (!probe.pass) {
      empty.push(view);
      console.log(
        `VIEW_EMPTY view=${view} reason=panel-not-visible rect=${probe.rect.w}x${probe.rect.h}@${probe.rect.x},${probe.rect.y} ${probe.detail} path=${path}`
      );
      continue;
    }

    shots.push({
      view,
      path,
      bytes: disk.length,
      sha256,
      width: Number(result.width),
      height: Number(result.height)
    });
    console.log(
      `AGENT_CAPTURE_OK view=${view} bytes=${disk.length} sha256=${sha256} size=${result.width}x${result.height} colors=${stats.colors} luma_std=${stats.lumaStd.toFixed(2)} path=${path}`
    );

    // 视觉自检（P2）：真截图必须能被压到「长边 ≤1024、≤400 KB」并解回同一尺寸，
    // 否则模型这一侧拿到的是坏图或超限图，宁可在这里失败。
    const attached = loadShotImage(userDataRoot, path);
    if (!attached.ok) throw new Error(`${view} 截图无法回灌：${attached.code} ${attached.message}`);
    if (attached.bytes > VISION_MAX_BYTES) {
      throw new Error(`${view} 压缩后仍 ${attached.bytes} 字节，超过 ${VISION_MAX_BYTES}`);
    }
    if (Math.max(attached.width, attached.height) > VISION_MAX_EDGE) {
      throw new Error(`${view} 压缩后长边 ${Math.max(attached.width, attached.height)} px，超过 ${VISION_MAX_EDGE}`);
    }
    if (!attached.dataUrl.startsWith('data:image/png;base64,')) {
      throw new Error(`${view} 的 data URL 前缀不对：${attached.dataUrl.slice(0, 24)}`);
    }
    const reread = decodePng(new Uint8Array(Buffer.from(attached.dataUrl.split(',')[1] ?? '', 'base64')));
    if (reread.width !== attached.width || reread.height !== attached.height) {
      throw new Error(`${view} 压缩图解码尺寸对不上：${reread.width}x${reread.height} vs ${attached.width}x${attached.height}`);
    }
    console.log(
      `AGENT_CAPTURE_VISION_OK view=${view} src=${disk.length} out=${attached.bytes} size=${attached.width}x${attached.height} base64=${attached.dataUrl.length}`
    );
  }

  const distinct = new Set(shots.map((shot) => shot.sha256)).size;

  // 3) 区域截图（region + scale）：真机验证「先裁后缩」比「先缩后裁」清楚，
  //    并确认取景框、clamped、最终尺寸与 1024/400 KB 上限都是真的。
  const REGION = { x: 0, y: 0, w: 480, h: 300 };
  const regionShot = await captureAgentView({ view: '3d', region: REGION, scale: 2 }, deps);
  if (regionShot.ok !== true) throw new Error(`区域截图失败：${JSON.stringify(regionShot)}`);
  if (regionShot.clamped !== false) throw new Error(`合法取景框不该被夹紧：${JSON.stringify(regionShot.region)}`);
  if (JSON.stringify(regionShot.region) !== JSON.stringify(REGION)) {
    throw new Error(`区域截图回传的取景框不对：${JSON.stringify(regionShot.region)} vs ${JSON.stringify(REGION)}`);
  }
  const expectedW = REGION.w * 2;
  const expectedH = REGION.h * 2;
  if (Number(regionShot.width) !== expectedW || Number(regionShot.height) !== expectedH) {
    throw new Error(`区域截图尺寸应为 ${expectedW}x${expectedH}，实际 ${regionShot.width}x${regionShot.height}`);
  }
  const regionDisk = readFileSync(String(regionShot.path));
  const regionSha = createHash('sha256').update(regionDisk).digest('hex');
  if (regionSha !== regionShot.sha256) throw new Error('区域截图的 sha256 无法在磁盘上复算');
  if (regionDisk.length !== Number(regionShot.bytes)) throw new Error('区域截图的 bytes 与磁盘不一致');
  const regionImage = decodePng(new Uint8Array(regionDisk));
  if (regionImage.width !== expectedW || regionImage.height !== expectedH) {
    throw new Error(`区域截图解码尺寸不对：${regionImage.width}x${regionImage.height}`);
  }
  const regionAttached = loadShotImage(userDataRoot, String(regionShot.path));
  if (!regionAttached.ok) throw new Error(`区域截图无法回灌：${regionAttached.code} ${regionAttached.message}`);
  if (regionAttached.bytes > VISION_MAX_BYTES || Math.max(regionAttached.width, regionAttached.height) > VISION_MAX_EDGE) {
    throw new Error(`区域截图压缩后仍超限：${regionAttached.width}x${regionAttached.height} / ${regionAttached.bytes} B`);
  }

  // 越界：夹紧 + 如实标 clamped，最终区域与图上像素一致
  const clampedShot = await captureAgentView({ view: '3d', region: { x: 1400, y: 900, w: 400, h: 300 } }, deps);
  if (clampedShot.ok !== true) throw new Error(`越界区域截图失败：${JSON.stringify(clampedShot)}`);
  if (clampedShot.clamped !== true) throw new Error('越界取景框必须标 clamped=true');
  const clampedRegion = JSON.stringify(clampedShot.region);
  if (clampedRegion !== JSON.stringify({ x: 1200, y: 700, w: 400, h: 300 })) {
    throw new Error(`越界取景框夹紧结果不对：${clampedRegion}`);
  }
  const finalRegion = clampedShot.region as { x: number; y: number; w: number; h: number };

  // 清晰度对比：同一块区域，「先裁后放」vs「先整图缩到 1024 再裁再放」的边缘能量
  const full3d = shots.find((shot) => shot.view === '3d');
  let sharpness = 'skipped(no-full-3d)';
  if (full3d) {
    const full = decodePng(new Uint8Array(readFileSync(full3d.path)));
    const ratio = Math.min(1, VISION_MAX_EDGE / Math.max(full.width, full.height));
    const shrunk = resizeRgba(full, Math.round(full.width * ratio), Math.round(full.height * ratio));
    const mapped = {
      x: Math.round(REGION.x * ratio),
      y: Math.round(REGION.y * ratio),
      w: Math.round(REGION.w * ratio),
      h: Math.round(REGION.h * ratio)
    };
    const blurry = resizeRgba(cropImage(shrunk, mapped).image, expectedW, expectedH);
    const energy = (image: { width: number; height: number; data: Uint8Array }): number => {
      let sum = 0;
      let count = 0;
      for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x + 1 < image.width; x += 1) {
          const a = (y * image.width + x) * 4;
          const b = a + 4;
          const lumaA = 0.2126 * (image.data[a] ?? 0) + 0.7152 * (image.data[a + 1] ?? 0) + 0.0722 * (image.data[a + 2] ?? 0);
          const lumaB = 0.2126 * (image.data[b] ?? 0) + 0.7152 * (image.data[b + 1] ?? 0) + 0.0722 * (image.data[b + 2] ?? 0);
          sum += Math.abs(lumaA - lumaB);
          count += 1;
        }
      }
      return count > 0 ? sum / count : 0;
    };
    const energyCropFirst = energy(regionImage);
    const energyShrinkFirst = energy(blurry);
    sharpness = `crop_first=${energyCropFirst.toFixed(2)} shrink_first=${energyShrinkFirst.toFixed(2)}`;
    if (energyCropFirst <= energyShrinkFirst) {
      throw new Error(`先裁后缩没有更清楚：${sharpness}`);
    }
  }

  console.log(
    `AGENT_CAPTURE_REGION_OK view=3d region=${REGION.x},${REGION.y},${REGION.w}x${REGION.h} scale=${regionShot.scale} size=${regionShot.width}x${regionShot.height} bytes=${regionDisk.length} sha256=${regionSha} vision=${regionAttached.width}x${regionAttached.height}/${regionAttached.bytes}B path=${regionShot.path}`
  );
  console.log(
    `AGENT_CAPTURE_REGION_CLAMP_OK requested=1400,900,400x300 final=${finalRegion.x},${finalRegion.y},${finalRegion.w}x${finalRegion.h} clamped=${clampedShot.clamped} size=${clampedShot.width}x${clampedShot.height}`
  );
  console.log(`AGENT_CAPTURE_REGION_SHARPNESS ${sharpness}`);

  if (empty.length > 0) {
    // 有视图是空白：如实报出来，不拿「截图刚好不为空」凑数，也不把它算进 distinct。
    console.log(
      `AGENT_CAPTURE_SELF_CHECK_PARTIAL shots=${shots.length} empty=${empty.join(',')} distinct=${distinct} home_gate=true`
    );
    return { ok: false, homeGateRejected: true, distinct, empty, shots };
  }
  if (distinct !== shots.length || shots.length !== AGENT_CAPTURE_VIEWS.length) {
    throw new Error(`四个视图的截图有重复帧：distinct=${distinct} shots=${shots.length}（同一帧被复用）`);
  }
  return { ok: true, homeGateRejected: true, distinct, empty, shots };
}
