/**
 * `capture_view` 的区域截图：把整窗 PNG 裁出一块**原像素**局部，再按需放大。
 *
 * 为什么需要：整窗 1600×1000 在回灌前会被压到长边 ≤1024，方案卡上的小字、表格里的数值
 * 基本糊成一片，模型「想看清一点」没有任何手段。给一个取景框，它就能只把那一块交给模型，
 * 同样的 1024 长边铺在 400 px 的区域内 —— 相当于按需放大。
 *
 * 两条顺序纪律（顺序反了等于没做）：
 * 1. **先裁后缩**：先按 region 从原图裁出原像素，再决定是否 scale。先整图缩小再裁，
 *    要看清的细节已经在缩放里被面积平均掉了；
 * 2. **取景框不外扩**：越界只做夹紧（并 `clamped: true` 如实上报最终区域），
 *    不静默挪到别的区域、也不悄悄改用整图。
 *
 * 纯函数，只用 `vision-image.ts` 已有的 PNG 解码 / 面积平均缩放 / 编码，不引新依赖
 * （`nativeImage.crop` 在主进程可用，但 `node --test` 里跑不了，裁剪逻辑就没法断言）。
 */
import { decodePng, encodePng, resizeRgba, type RgbaImage } from './vision-image.ts';

/** 取景框最小边长（px）：再小就只剩几个像素，放大也读不出字。 */
export const REGION_MIN_SIZE = 32;
/** 取景框坐标系的上界：`capture_view` 默认窗口就是 1600×1000（原图像素）。 */
export const REGION_SOURCE_WIDTH = 1600;
export const REGION_SOURCE_HEIGHT = 1000;
/** 放大倍数范围：>3 只是把像素拉大，不会多出信息；<0.5 没必要（vision 侧还会再压）。 */
export const REGION_SCALE_MIN = 0.5;
export const REGION_SCALE_MAX = 3;

export interface CaptureRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RegionPlan {
  /** 夹紧后的取景框（原图像素坐标） */
  region: CaptureRegion;
  /** 调用方是否显式给了 region（false 时 region 是整图） */
  requested: boolean;
  /** 是否发生过夹紧/取整 */
  clamped: boolean;
  /** 夹紧到 0.5–3 之后的放大倍数 */
  scale: number;
}

export type RegionParseResult =
  | { ok: true; plan: RegionPlan }
  | { ok: false; code: 'INVALID_ARGUMENT'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function int(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value);
}

/**
 * 把取景框夹到 `0 <= x`、`0 <= y`、`x+w <= width`、`y+h <= height`。
 *
 * 越界时优先保留请求的起点、把宽高截到边界内；起点本身越界则整体平移回来
 * （`x = width - w`）。**最终区域一定回传给调用方**，不静默换成别的区域。
 */
export function clampRegion(
  region: CaptureRegion,
  bounds: { width: number; height: number } = { width: REGION_SOURCE_WIDTH, height: REGION_SOURCE_HEIGHT }
): { region: CaptureRegion; clamped: boolean } {
  const width = Math.max(1, Math.floor(bounds.width));
  const height = Math.max(1, Math.floor(bounds.height));
  let clamped = false;

  let x = Math.round(region.x);
  let y = Math.round(region.y);
  let w = Math.round(region.w);
  let h = Math.round(region.h);
  if (x !== region.x || y !== region.y || w !== region.w || h !== region.h) clamped = true;

  if (x < 0) {
    x = 0;
    clamped = true;
  }
  if (y < 0) {
    y = 0;
    clamped = true;
  }
  if (w > width) {
    w = width;
    clamped = true;
  }
  if (h > height) {
    h = height;
    clamped = true;
  }
  if (w < 1) {
    w = Math.min(REGION_MIN_SIZE, width);
    clamped = true;
  }
  if (h < 1) {
    h = Math.min(REGION_MIN_SIZE, height);
    clamped = true;
  }
  if (x + w > width) {
    x = Math.max(0, width - w);
    clamped = true;
  }
  if (y + h > height) {
    y = Math.max(0, height - h);
    clamped = true;
  }
  return { region: { x, y, w, h }, clamped };
}

/**
 * 解析 `capture_view` 的 `region` / `scale`。
 *
 * - 不传 region：`region` 取整图，`requested=false`，`clamped=false`（老路径，后续不做任何像素处理）；
 * - w/h < 32 或字段不是数字：`INVALID_ARGUMENT`（明确拒绝，不猜一个「差不多」的区域）；
 * - x/y 为负、x+w/y+h 越界：夹紧并 `clamped=true`；
 * - scale 越界：夹到 0.5–3（返回里给最终值），非数字 → `INVALID_ARGUMENT`。
 */
export function parseRegionArgs(
  args: Record<string, unknown>,
  bounds: { width: number; height: number } = { width: REGION_SOURCE_WIDTH, height: REGION_SOURCE_HEIGHT }
): RegionParseResult {
  let scale = 1;
  const rawScale = args.scale;
  if (rawScale !== undefined && rawScale !== null) {
    if (typeof rawScale !== 'number' || !Number.isFinite(rawScale)) {
      return { ok: false, code: 'INVALID_ARGUMENT', message: 'scale 必须是 0.5–3 的数字' };
    }
    scale = Math.min(REGION_SCALE_MAX, Math.max(REGION_SCALE_MIN, rawScale));
  }

  const raw = args.region;
  if (raw === undefined || raw === null) {
    const full = clampRegion({ x: 0, y: 0, w: bounds.width, h: bounds.height }, bounds);
    return { ok: true, plan: { region: full.region, requested: false, clamped: false, scale } };
  }
  if (!isRecord(raw)) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'region 必须是 {x,y,w,h} 对象' };
  }
  const x = int(raw.x);
  const y = int(raw.y);
  const w = int(raw.w);
  const h = int(raw.h);
  if (x === null || y === null || w === null || h === null) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'region 的 x/y/w/h 必须是有限的数字（原图像素坐标）' };
  }
  if (w < REGION_MIN_SIZE || h < REGION_MIN_SIZE) {
    return {
      ok: false,
      code: 'INVALID_ARGUMENT',
      message: `region 的 w/h 至少 ${REGION_MIN_SIZE} px（收到 ${w}x${h}）；太小放大也读不出内容`
    };
  }
  const clamped = clampRegion({ x, y, w, h }, bounds);
  return { ok: true, plan: { region: clamped.region, requested: true, clamped: clamped.clamped, scale } };
}

/** 从原像素图里裁出一块（不缩放）；区域会先夹到图像边界内。 */
export function cropImage(source: RgbaImage, region: CaptureRegion): { image: RgbaImage; region: CaptureRegion; clamped: boolean } {
  const bounded = clampRegion(region, { width: source.width, height: source.height });
  const { x, y, w, h } = bounded.region;
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row += 1) {
    const from = ((y + row) * source.width + x) * 4;
    out.set(source.data.subarray(from, from + w * 4), row * w * 4);
  }
  return { image: { width: w, height: h, data: out }, region: bounded.region, clamped: bounded.clamped };
}

/** 放大后最多产出多少像素：再大也只会被 vision 压到 1024，白占内存与编码时间。 */
export const REGION_MAX_OUTPUT_PIXELS = 4_000_000;

export interface AppliedRegion {
  png: Uint8Array;
  width: number;
  height: number;
  /** 原图尺寸（裁剪前），用于提示「这是局部」 */
  sourceSize: { w: number; h: number };
  region: CaptureRegion;
  clamped: boolean;
  scale: number;
}

/**
 * 对整窗 PNG 执行「先裁 → 再缩」。
 *
 * 返回的 `width/height` 是**落盘图的真实尺寸**，`scale` 是**实际生效倍数**
 * （受 `REGION_MAX_OUTPUT_PIXELS` 约束时小于请求值，可据 `width/region.w` 复核）。
 * 视觉侧的 1024/400 KB 上限仍由 `vision.ts` 的 `fitPng` 兜底 —— 这里不做二次压缩，
 * 否则同一张图会被压两遍，模型端反而更糊。
 */
export function applyRegion(
  png: Uint8Array,
  region: CaptureRegion,
  scale: number,
  clampedHint = false
): AppliedRegion {
  const decoded = decodePng(png);
  const cropped = cropImage(decoded, region);
  const pixels = cropped.image.width * cropped.image.height;
  const maxScale = Math.min(REGION_SCALE_MAX, scale, Math.sqrt(REGION_MAX_OUTPUT_PIXELS / Math.max(1, pixels)));
  const width = Math.max(1, Math.round(cropped.image.width * maxScale));
  const height = Math.max(1, Math.round(cropped.image.height * maxScale));
  const scaled = resizeRgba(cropped.image, width, height);
  return {
    png: encodePng(scaled),
    width,
    height,
    sourceSize: { w: decoded.width, h: decoded.height },
    region: cropped.region,
    clamped: clampedHint || cropped.clamped,
    scale: Number((width / cropped.image.width).toFixed(3))
  };
}
