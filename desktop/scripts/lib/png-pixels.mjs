// 截图像素闸门的最小依赖实现：解 8bit PNG → RGBA，按 CIE76 (ΔE76) 统计材质色像素。
// 不引第三方图像库：CI 里只装了运行时依赖，加 pngjs 会让 npm ci 变重、也可能装不上。
// 只支持本流程实际用到的子集：8bit、RGB/RGBA、非隔行（Electron Page.captureScreenshot 的产物）。
import { inflateSync } from 'node:zlib';

/** sRGB 分量（0..1）→ CIE Lab（D65，2° 观察者）。 */
export function srgbToLab(r, g, b) {
  const linear = (value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const rl = linear(r);
  const gl = linear(g);
  const bl = linear(b);
  const x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047;
  const y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175;
  const z = (rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041) / 1.08883;
  const f = (t) => (t > 0.008856451679035631 ? Math.cbrt(t) : t / 0.12841854934601665 + 4 / 29);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 色差。 */
export function deltaE76(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** '#rrggbb' / '#rgb' → [r, g, b]（0..255）。 */
export function parseHex(hex) {
  const text = String(hex).trim().replace(/^#/, '');
  const full = text.length === 3 ? text.split('').map((c) => c + c).join('') : text;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`非法颜色：${hex}`);
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

export function hexToLab(hex) {
  const [r, g, b] = parseHex(hex);
  return srgbToLab(r / 255, g / 255, b / 255);
}

/**
 * 解 PNG → { width, height, channels, pixels }（pixels 为 RGBA 连续数组）。
 * 支持位深 8、颜色类型 0/2/4/6（灰度/真彩/带 alpha），不支持 16bit 与隔行。
 */
export function decodePng(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) throw new Error('不是 PNG 文件');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const data = bytes.subarray(dataStart, dataStart + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + length + 4;
  }
  if (bitDepth !== 8) throw new Error(`只支持 8bit PNG，实际 ${bitDepth}`);
  if (interlace !== 0) throw new Error('不支持隔行 PNG');
  const channelsByType = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const channels = channelsByType[colorType];
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const prior = new Uint8Array(stride);
  const current = new Uint8Array(stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    for (let i = 0; i < stride; i += 1) current[i] = raw[pos + i];
    pos += stride;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? current[i - channels] : 0;
      const up = prior[i];
      const upLeft = i >= channels ? prior[i - channels] : 0;
      let value = current[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filter !== 0) {
        throw new Error(`未知 PNG 过滤类型 ${filter}`);
      }
      current[i] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      if (channels >= 3) {
        out[target] = current[source];
        out[target + 1] = current[source + 1];
        out[target + 2] = current[source + 2];
        out[target + 3] = channels === 4 ? current[source + 3] : 255;
      } else {
        out[target] = current[source];
        out[target + 1] = current[source];
        out[target + 2] = current[source];
        out[target + 3] = channels === 2 ? current[source + 1] : 255;
      }
    }
    prior.set(current);
  }
  return { width, height, channels, pixels: out };
}

/**
 * 在 rect（缺省整图）内统计每种目标色的像素数：与目标色的 ΔE76 < tolerance 才算命中。
 * 只统计不透明像素（alpha ≥ 128），避免半透明叠层与背景混色误判。
 */
export function countColorPixels(image, targets, options = {}) {
  const tolerance = options.tolerance ?? 25;
  const rect = options.rect ?? { x: 0, y: 0, width: image.width, height: image.height };
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(image.width, Math.floor(rect.x + rect.width));
  const y1 = Math.min(image.height, Math.floor(rect.y + rect.height));
  const labs = targets.map((target) => hexToLab(target.hex ?? target));
  const counts = new Array(targets.length).fill(0);
  let sampled = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const index = (y * image.width + x) * 4;
      if (image.pixels[index + 3] < 128) continue;
      sampled += 1;
      const lab = srgbToLab(image.pixels[index] / 255, image.pixels[index + 1] / 255, image.pixels[index + 2] / 255);
      for (let i = 0; i < labs.length; i += 1) {
        if (deltaE76(lab, labs[i]) < tolerance) counts[i] += 1;
      }
    }
  }
  return { counts, sampled, tolerance };
}
