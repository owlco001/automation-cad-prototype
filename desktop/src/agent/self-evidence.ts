/**
 * 智能体自证：`capture_view` 的落盘与自校验。
 *
 * 为什么要有这一层：模型说「我看过了」不算证据。这里只接受主进程真实截出来的 PNG，
 * 落到 `userData/agent-shots/<timestamp>-<view>.png`，并把字节数 / SHA-256 / 实际尺寸
 * 一起回给模型和审计 —— 同一份哈希可以用 `sha256sum` 在磁盘上复核。
 *
 * 硬约束（都在代码里，不靠提示词）：
 * - 窗口不存在 / 扩展未就绪 / 仍停在首页（#app 仍 inert）→ `VIEW_NOT_READY`，
 *   **绝不**拿一张首页截图冒充 3D 视图；
 * - 单张 > 5 MiB → 缩尺寸重拍一次，仍超限返回 `SHOT_TOO_LARGE`，不把超大图塞进上下文；
 * - 返回的 bytes 一律取自落盘后的 `statSync().size`，不是内存里数出来的。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyRegion, clampRegion, parseRegionArgs, type CaptureRegion } from './capture-region.ts';
import { fitPng, pngSize, VisionImageError } from './vision-image.ts';

export const AGENT_CAPTURE_VIEWS = ['3d', 'linkage', 'library', 'exports'] as const;
export type AgentCaptureView = (typeof AGENT_CAPTURE_VIEWS)[number];

export const DEFAULT_SHOT_WIDTH = 1600;
export const DEFAULT_SHOT_HEIGHT = 1000;
export const MIN_SHOT_WIDTH = 320;
export const MIN_SHOT_HEIGHT = 240;
export const MAX_SHOT_WIDTH = 3840;
export const MAX_SHOT_HEIGHT = 2160;
/** 单张截图上限：超过就缩尺寸重拍，避免把几十 MB 的 PNG 写盘并回灌模型。 */
export const MAX_SHOT_BYTES = 5 * 1024 * 1024;

export interface AgentViewCaptureRequest {
  view: AgentCaptureView;
  width: number;
  height: number;
}

export type AgentViewCaptureResult =
  | { ok: true; png: Uint8Array; width?: number; height?: number }
  | { ok: false; code: string; hint?: string; message?: string };

/** 主进程注入的真实截图通道（BrowserWindow.capturePage + 视图切换）。 */
export type AgentViewCapture = (request: AgentViewCaptureRequest) => Promise<AgentViewCaptureResult>;

export interface AgentCaptureDeps {
  userDataRoot?: string;
  capture?: AgentViewCapture;
  now?: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): Record<string, unknown> {
  return { ok: false, code: 'INVALID_ARGUMENT', message };
}

function dimension(value: unknown, fallback: number, min: number, max: number, label: string): number | string {
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    return `${label} 必须是 ${min}–${max} 的整数`;
  }
  return parsed;
}

/** `2026-11-04T12:34:56.789Z` → `2026-11-04T12-34-56-789Z`（Windows 文件名安全）。 */
function fileStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function uniquePath(dir: string, stamp: string, view: string): string {
  let candidate = join(dir, `${stamp}-${view}.png`);
  let index = 2;
  while (existsSync(candidate)) {
    candidate = join(dir, `${stamp}-${view}-${index}.png`);
    index += 1;
  }
  return candidate;
}

function notReady(hint: string, message = '当前窗口还没进入可截图的经典原型界面'): Record<string, unknown> {
  return { ok: false, code: 'VIEW_NOT_READY', message, hint };
}

/**
 * 执行一次 capture_view。
 *
 * 返回 `{ok:true, view, path, bytes, sha256, width, height}`；
 * 失败时 `{ok:false, code, message, hint?}`，code 是稳定的业务码。
 */
export async function captureAgentView(
  args: Record<string, unknown>,
  deps: AgentCaptureDeps
): Promise<Record<string, unknown>> {
  const rawView = args.view;
  if (rawView !== undefined && rawView !== null && (typeof rawView !== 'string' || !(AGENT_CAPTURE_VIEWS as readonly string[]).includes(rawView))) {
    return invalid(`view 只能是 ${AGENT_CAPTURE_VIEWS.join(' / ')}`);
  }
  const view = (typeof rawView === 'string' ? rawView : '3d') as AgentCaptureView;

  const width = dimension(args.width, DEFAULT_SHOT_WIDTH, MIN_SHOT_WIDTH, MAX_SHOT_WIDTH, 'width');
  if (typeof width === 'string') return invalid(width);
  const height = dimension(args.height, DEFAULT_SHOT_HEIGHT, MIN_SHOT_HEIGHT, MAX_SHOT_HEIGHT, 'height');
  if (typeof height === 'string') return invalid(height);

  // 区域截图：参数校验放在开窗之前 —— w/h 太小这类错误不该先截一张整窗再报错。
  // 此刻还不知道图像像素尺寸（高 DPI 下截图会比请求的 1600×1000 大一倍），所以
  // `parseRegionArgs(args, null)` 只校验、不夹紧；坐标夹紧一律等拿到真实图之后按
  // `pngSize(png)` 做 —— 否则 3200×2000 上请求右侧 x=2000 会被 1600 的常量夹回左上。
  const validated = parseRegionArgs(args, null);
  if (!validated.ok) return invalid(validated.message);
  const plan = validated.plan;
  const wantsRegion = plan.requested || plan.scale !== 1;

  if (!deps.capture) {
    return notReady('当前进程没有接入截图通道；请在 AutomationCAD 桌面应用内调用，MCP 需经桌面 RPC 转发');
  }
  if (!deps.userDataRoot) {
    return {
      ok: false,
      code: 'VIEW_CAPTURE_UNAVAILABLE',
      message: '主进程没有提供 userData 目录，截图无处落盘',
      hint: '在桌面应用内运行；独立进程请先用 apply_machine_design 之外的桌面入口'
    };
  }

  let png: Uint8Array;
  let shotWidth = width;
  let shotHeight = height;
  const first = await deps.capture({ view, width, height });
  if (!isRecord(first) || first.ok !== true || !(first.png instanceof Uint8Array)) {
    const failure: Record<string, unknown> = isRecord(first) ? first : {};
    return {
      ok: false,
      code: typeof failure.code === 'string' && failure.code ? failure.code : 'VIEW_NOT_READY',
      message: typeof failure.message === 'string' && failure.message
        ? failure.message
        : '窗口未就绪或页面不在经典原型界面，未产出截图',
      hint: typeof failure.hint === 'string' && failure.hint ? failure.hint : '先点首页「进入经典原型界面」，等 3D 视图就绪再试'
    };
  }
  png = first.png;
  shotWidth = Number(first.width ?? width) || width;
  shotHeight = Number(first.height ?? height) || height;

  // 超 5 MiB：缩到 70% 重拍一次（只一次），仍然超限就如实报错，不裁不压不伪造。
  if (png.byteLength > MAX_SHOT_BYTES) {
    const narrowWidth = Math.max(MIN_SHOT_WIDTH, Math.round(width * 0.7));
    const narrowHeight = Math.max(MIN_SHOT_HEIGHT, Math.round(height * 0.7));
    const retry = await deps.capture({ view, width: narrowWidth, height: narrowHeight });
    if (!isRecord(retry) || retry.ok !== true || !(retry.png instanceof Uint8Array)) {
      return {
        ok: false,
        code: 'VIEW_NOT_READY',
        message: `首张截图 ${png.byteLength} 字节超过 ${MAX_SHOT_BYTES} 上限，缩小重拍失败`,
        hint: '先确认窗口可见且画面已刷新，再重试'
      };
    }
    png = retry.png;
    shotWidth = Number(retry.width ?? narrowWidth) || narrowWidth;
    shotHeight = Number(retry.height ?? narrowHeight) || narrowHeight;
    if (png.byteLength > MAX_SHOT_BYTES) {
      return {
        ok: false,
        code: 'SHOT_TOO_LARGE',
        message: `缩到 ${narrowWidth}×${narrowHeight} 后仍为 ${png.byteLength} 字节，超过单张 ${MAX_SHOT_BYTES} 字节上限`,
        hint: '减小 width/height 后重试（例如 1200×800），或先关闭高 DPI 缩放'
      };
    }
  }

  if (png.byteLength === 0) {
    return notReady('截图通道返回了空图（窗口可能被最小化或合成器未出帧）');
  }

  // 区域截图：**先裁后缩** —— 从原像素里裁出取景框，再按 scale 放大。
  // 不传 region 且 scale=1 时整段跳过，落盘字节与旧行为完全一致。
  let shotRegion: { region: CaptureRegion; clamped: boolean; scale: number; sourceSize: { w: number; h: number } } | null = null;
  if (wantsRegion) {
    try {
      // 坐标上界 = 本次截图的真实像素尺寸（高 DPI 是 3200×2000），不是请求的 1600×1000。
      const source = pngSize(png);
      // 只给 scale 不给 region 时语义是「整图放大」：按真实整图，而不是默认窗口那一块
      // （高 DPI 上 1600×1000 的常量会把整图放大变成「左上角一块放大」）。
      const desired = plan.requested ? plan.region : { x: 0, y: 0, w: source.width, h: source.height };
      const bounded = clampRegion(desired, source);
      let applied = applyRegion(png, bounded.region, plan.scale, bounded.clamped);
      // 放大后可能撑破单张 5 MiB：仍按字节上限兜底压一档，不写一张超大图到磁盘。
      if (applied.png.byteLength > MAX_SHOT_BYTES) {
        const capped = fitPng(applied.png, {
          maxEdge: Math.max(applied.width, applied.height),
          maxBytes: MAX_SHOT_BYTES
        });
        applied = { ...applied, png: capped.data, width: capped.width, height: capped.height };
      }
      png = applied.png;
      shotWidth = applied.width;
      shotHeight = applied.height;
      shotRegion = {
        region: applied.region,
        clamped: applied.clamped,
        // 实际生效倍数（大区域封顶 / 5 MiB 兜底后可能小于请求值），与落盘 width 对得上
        scale: Number((applied.width / Math.max(1, applied.region.w)).toFixed(3)),
        sourceSize: applied.sourceSize
      };
    } catch (error) {
      const code = error instanceof VisionImageError ? error.code : 'SHOT_CROP_FAILED';
      return {
        ok: false,
        code,
        message: `区域截图失败：${error instanceof Error ? error.message : String(error)}`,
        hint: '截图通道返回的可能不是 8 位非隔行 PNG；去掉 region 参数按整窗重试'
      };
    }
  }

  const dir = join(deps.userDataRoot, 'agent-shots');
  mkdirSync(dir, { recursive: true });
  // 区域截图单独加 `-region` 后缀：agent-shots 里整窗图和局部图混在一起时能一眼分开。
  const label = shotRegion ? `${view}-region` : view;
  const path = uniquePath(dir, fileStamp((deps.now ?? (() => new Date()))()), label);
  writeFileSync(path, png);

  // 字节数取落盘后的真实大小：写入失败或截断时这里会立刻对不上。
  const bytes = statSync(path).size;
  if (bytes !== png.byteLength) {
    return {
      ok: false,
      code: 'SHOT_WRITE_FAILED',
      message: `截图落盘不完整：内存 ${png.byteLength} 字节，磁盘 ${bytes} 字节`,
      hint: '检查磁盘空间与写入权限后重试'
    };
  }
  const sha256 = createHash('sha256').update(png).digest('hex');

  return {
    ok: true,
    view,
    path,
    bytes,
    sha256,
    width: shotWidth,
    height: shotHeight,
    // 区域截图的取证信息：模型必须知道「这是局部」，否则会把局部当全景下结论。
    ...(shotRegion
      ? {
          region: shotRegion.region,
          clamped: shotRegion.clamped,
          scale: shotRegion.scale,
          sourceSize: shotRegion.sourceSize
        }
      : {}),
    // 给模型一句能直接复述的话，避免它把「我截了图」说成「我看过模型了」
    note: shotRegion
      ? `这张图是 ${view} 视图的局部（原图像素 x=${shotRegion.region.x}, y=${shotRegion.region.y}, ${shotRegion.region.w}×${shotRegion.region.h}${shotRegion.clamped ? '，请求越界已夹紧到此区域' : ''}），不是整屏；sha256 可用 sha256sum 在磁盘上复核。`
      : '这张图是主进程真实截取的当前界面；sha256 可用 sha256sum 在磁盘上复核。'
  };
}
