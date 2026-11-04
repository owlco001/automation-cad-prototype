/**
 * 截图压缩：把 `capture_view` 落盘的 PNG 压到「长边 ≤1024、单图 ≤400 KB」。
 *
 * 为什么自己写而不是引依赖：仓库里没有图片处理库（package.json 只有 three/dxf/xlsx 等），
 * 为了一张截图引 sharp 会带进原生二进制与打包体积；Electron 的 `nativeImage` 在
 * `node --test` 里不可用（主进程 API），压缩逻辑就没法断言。所以这里只用 `node:zlib`
 * 做 PNG 解码→面积平均缩放→重新编码，纯函数、可在 node 里真跑。
 *
 * 只支持 8 位非隔行 PNG（capturePage 的输出就是这种；jpeg 由 vision.ts 判为不支持，
 * 不会把没压缩的图发出去）。
 */
import { deflateSync, inflateSync } from 'node:zlib';

/** 长边上限（px）：模型端图像成本按面积算，1024 足够看清布局与报错条。 */
export const VISION_MAX_EDGE = 1024;
/** 单图上限（字节）：base64 后约 533 KB，单请求不会因为一张图撑爆体积。 */
export const VISION_MAX_BYTES = 400 * 1024;

export type VisionImageErrorCode = 'VISION_UNSUPPORTED_FORMAT' | 'VISION_TOO_LARGE' | 'VISION_UNREADABLE';

export class VisionImageError extends Error {
  readonly code: VisionImageErrorCode;

  constructor(code: VisionImageErrorCode, message: string) {
    super(message);
    this.name = 'VisionImageError';
    this.code = code;
  }
}

export interface RgbaImage {
  width: number;
  height: number;
  /** 每像素 4 字节 RGBA */
  data: Uint8Array;
}

export interface FitResult {
  data: Uint8Array;
  width: number;
  height: number;
  /** 是否发生过重采样/重编码 */
  scaled: boolean;
  /** 缩放尝试次数（1 表示只压了一轮就达标） */
  attempts: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

/**
 * 只读 PNG 头（IHDR）拿**真实像素尺寸**，不解码像素。
 *
 * 为什么需要：`capture_view` 的 `region` 是原图像素坐标，而高 DPI 屏上 window 请求的
 * 1600×1000 截出来是 3200×2000 —— 夹紧必须按图像实际像素来，不能按请求尺寸。
 * 主进程通道虽然也回传实测尺寸，但那是「通道自报」；这里读文件头是同一份字节的自证。
 */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (!isPng(bytes)) {
    throw new VisionImageError('VISION_UNSUPPORTED_FORMAT', '不是 PNG：缺少 PNG 文件头');
  }
  if (bytes.length < 24) {
    throw new VisionImageError('VISION_UNSUPPORTED_FORMAT', 'PNG 头被截断：读不到 IHDR 里的像素尺寸');
  }
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.toString('ascii', 12, 16) !== 'IHDR') {
    throw new VisionImageError('VISION_UNSUPPORTED_FORMAT', 'PNG 第一块不是 IHDR：无法确定像素尺寸');
  }
  const width = view.readUInt32BE(16);
  const height = view.readUInt32BE(20);
  if (width < 1 || height < 1) {
    throw new VisionImageError('VISION_UNSUPPORTED_FORMAT', `PNG 头里的尺寸非法：${width}x${height}`);
  }
  return { width, height };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ (bytes[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** 解码 8 位非隔行 PNG（灰度/RGB/灰度+透明/RGBA）为 RGBA。 */
export function decodePng(bytes: Uint8Array): RgbaImage {
  if (!isPng(bytes)) {
    throw new VisionImageError('VISION_UNSUPPORTED_FORMAT', '不是 PNG：缺少 PNG 文件头');
  }
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  while (offset + 8 <= view.length) {
    const length = view.readUInt32BE(offset);
    const type = view.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end > view.length) {
      throw new VisionImageError('VISION_UNSUPPORTED_FORMAT', 'PNG 数据块被截断');
    }
    if (type === 'IHDR') {
      width = view.readUInt32BE(start);
      height = view.readUInt32BE(start + 4);
      const bitDepth = view[start + 8] ?? 0;
      colorType = view[start + 9] ?? -1;
      const interlace = view[start + 12] ?? 0;
      if (bitDepth !== 8) {
        throw new VisionImageError('VISION_UNSUPPORTED_FORMAT', `只支持 8 位 PNG，实际 ${bitDepth} 位`);
      }
      if (interlace !== 0) {
        throw new VisionImageError('VISION_UNSUPPORTED_FORMAT', '不支持隔行 PNG');
      }
    } else if (type === 'IDAT') {
      idat.push(view.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (channels === 0 || width <= 0 || height <= 0) {
    throw new VisionImageError('VISION_UNSUPPORTED_FORMAT', `不支持的 PNG 颜色类型 ${colorType}`);
  }
  if (idat.length === 0) {
    throw new VisionImageError('VISION_UNSUPPORTED_FORMAT', 'PNG 缺少 IDAT 数据');
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) {
    throw new VisionImageError('VISION_UNSUPPORTED_FORMAT', 'PNG 像素数据长度不足');
  }
  const out = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const base = y * (stride + 1);
    const filter = raw[base] ?? 0;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[base + 1 + x] ?? 0;
      const left = x >= channels ? (cur[x - channels] ?? 0) : 0;
      const up = y > 0 ? (prev[x] ?? 0) : 0;
      const upLeft = y > 0 && x >= channels ? (prev[x - channels] ?? 0) : 0;
      let restored: number;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + ((left + up) >> 1);
          break;
        case 4:
          restored = value + paeth(left, up, upLeft);
          break;
        default:
          throw new VisionImageError('VISION_UNSUPPORTED_FORMAT', `未知的 PNG 行过滤类型 ${filter}`);
      }
      cur[x] = restored & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4;
      if (channels === 1) {
        const gray = cur[x] ?? 0;
        out[target] = gray;
        out[target + 1] = gray;
        out[target + 2] = gray;
        out[target + 3] = 255;
      } else if (channels === 2) {
        const gray = cur[x * 2] ?? 0;
        out[target] = gray;
        out[target + 1] = gray;
        out[target + 2] = gray;
        out[target + 3] = cur[x * 2 + 1] ?? 255;
      } else if (channels === 3) {
        out[target] = cur[x * 3] ?? 0;
        out[target + 1] = cur[x * 3 + 1] ?? 0;
        out[target + 2] = cur[x * 3 + 2] ?? 0;
        out[target + 3] = 255;
      } else {
        out[target] = cur[x * 4] ?? 0;
        out[target + 1] = cur[x * 4 + 1] ?? 0;
        out[target + 2] = cur[x * 4 + 2] ?? 0;
        out[target + 3] = cur[x * 4 + 3] ?? 255;
      }
    }
    prev.set(cur);
  }
  return { width, height, data: out };
}

function rowCost(line: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < line.length; i += 1) {
    const value = line[i] ?? 0;
    sum += value < 128 ? value : 256 - value;
  }
  return sum;
}

function filterRow(type: number, current: Uint8Array, previous: Uint8Array, bpp: number, out: Uint8Array): void {
  const length = current.length;
  for (let i = 0; i < length; i += 1) {
    const value = current[i] ?? 0;
    const left = i >= bpp ? (current[i - bpp] ?? 0) : 0;
    const up = previous[i] ?? 0;
    const upLeft = i >= bpp ? (previous[i - bpp] ?? 0) : 0;
    switch (type) {
      case 0:
        out[i] = value;
        break;
      case 1:
        out[i] = (value - left) & 0xff;
        break;
      case 2:
        out[i] = (value - up) & 0xff;
        break;
      case 3:
        out[i] = (value - ((left + up) >> 1)) & 0xff;
        break;
      default:
        out[i] = (value - paeth(left, up, upLeft)) & 0xff;
        break;
    }
  }
}

export function encodePng(image: RgbaImage): Uint8Array {
  const { width, height, data } = image;
  const stride = width * 4;
  const raw = Buffer.allocUnsafe((stride + 1) * height);
  const previous = new Uint8Array(stride);
  const current = new Uint8Array(stride);
  const candidates = [
    new Uint8Array(stride),
    new Uint8Array(stride),
    new Uint8Array(stride),
    new Uint8Array(stride),
    new Uint8Array(stride)
  ];
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    current.set(data.subarray(y * stride, (y + 1) * stride));
    let bestType = 0;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let type = 0; type < 5; type += 1) {
      const candidate = candidates[type]!;
      filterRow(type, current, previous, 4, candidate);
      const cost = rowCost(candidate);
      if (cost < bestCost) {
        bestCost = cost;
        bestType = type;
      }
    }
    raw[offset] = bestType;
    offset += 1;
    raw.set(candidates[bestType]!, offset);
    offset += stride;
    previous.set(current);
  }
  const compressed = deflateSync(raw, { level: 9 });
  const chunks: Buffer[] = [
    writeChunk('IHDR', (() => {
      const header = Buffer.allocUnsafe(13);
      header.writeUInt32BE(width, 0);
      header.writeUInt32BE(height, 4);
      header[8] = 8; // bit depth
      header[9] = 6; // RGBA
      header[10] = 0;
      header[11] = 0;
      header[12] = 0;
      return header;
    })()),
    writeChunk('IDAT', compressed),
    writeChunk('IEND', Buffer.alloc(0))
  ];
  return new Uint8Array(Buffer.concat([Buffer.from(PNG_SIGNATURE), ...chunks]));
}

function writeChunk(type: string, body: Buffer): Buffer {
  const head = Buffer.allocUnsafe(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const tail = Buffer.allocUnsafe(4);
  tail.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([head, body, tail]);
}

/** 面积平均（box filter）缩放；缩小时比最近邻少出锯齿，截图文字更可读。 */
export function resizeRgba(source: RgbaImage, width: number, height: number): RgbaImage {
  const { width: sw, height: sh, data } = source;
  if (width === sw && height === sh) return source;
  const out = new Uint8Array(width * height * 4);
  const xRatio = sw / width;
  const yRatio = sh / height;
  for (let dy = 0; dy < height; dy += 1) {
    const y0 = dy * yRatio;
    const y1 = y0 + yRatio;
    for (let dx = 0; dx < width; dx += 1) {
      const x0 = dx * xRatio;
      const x1 = x0 + xRatio;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weightSum = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy += 1) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        if (wy <= 0) continue;
        const rowBase = sy * sw * 4;
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx += 1) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          if (wx <= 0) continue;
          const weight = wx * wy;
          const index = rowBase + sx * 4;
          r += (data[index] ?? 0) * weight;
          g += (data[index + 1] ?? 0) * weight;
          b += (data[index + 2] ?? 0) * weight;
          a += (data[index + 3] ?? 0) * weight;
          weightSum += weight;
        }
      }
      const target = (dy * width + dx) * 4;
      if (weightSum <= 0) continue;
      out[target] = Math.round(r / weightSum);
      out[target + 1] = Math.round(g / weightSum);
      out[target + 2] = Math.round(b / weightSum);
      out[target + 3] = Math.round(a / weightSum);
    }
  }
  return { width, height, data: out };
}

export interface FitOptions {
  maxEdge?: number;
  maxBytes?: number;
}

/**
 * 压到「长边 ≤ maxEdge 且 ≤ maxBytes」；两者冲突时优先满足体积上限（长边继续往下缩），
 * 缩到 256 px 还超限就抛 VISION_TOO_LARGE —— 宁可明说没发图，也不发一张超限的图。
 */
export function fitPng(bytes: Uint8Array, options: FitOptions = {}): FitResult {
  const maxEdge = options.maxEdge ?? VISION_MAX_EDGE;
  const maxBytes = options.maxBytes ?? VISION_MAX_BYTES;
  const decoded = decodePng(bytes);
  const longEdge = Math.max(decoded.width, decoded.height);
  if (longEdge <= maxEdge && bytes.length <= maxBytes) {
    return { data: bytes, width: decoded.width, height: decoded.height, scaled: false, attempts: 0 };
  }
  let edge = Math.min(maxEdge, longEdge);
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const scale = edge / longEdge;
    const width = Math.max(1, Math.min(decoded.width, Math.round(decoded.width * scale)));
    const height = Math.max(1, Math.min(decoded.height, Math.round(decoded.height * scale)));
    const encoded = encodePng(resizeRgba(decoded, width, height));
    if (encoded.length <= maxBytes) {
      return { data: encoded, width, height, scaled: true, attempts: attempt };
    }
    if (edge <= 256) break;
    edge = Math.max(256, Math.floor(edge * 0.85));
  }
  throw new VisionImageError('VISION_TOO_LARGE', `压缩后仍超过 ${Math.round(maxBytes / 1024)} KB`);
}
