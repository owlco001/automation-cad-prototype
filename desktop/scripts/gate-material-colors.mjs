#!/usr/bin/env node
/**
 * 材质色像素闸门（可单独跑，machine:e2e 第 14 步用的是同一套实现）。
 *
 *   node scripts/gate-material-colors.mjs docs/desktop/screenshots/23-pv-04-transfer-3d.png
 *   node scripts/gate-material-colors.mjs <png> --rect 420,90,1180,860     # 只数 3D 画布
 *   node scripts/gate-material-colors.mjs <png> --min 3000 --tolerance 25
 *
 * 判定：四种材质标识色（AL6063/Q235/STEEL45/PVC）各自 ≥ min 个像素落在 ΔE76 < tolerance 内。
 * 退出码 0 = 全过；1 = 有材质缺色（打印每色实际像素数）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkMaterialPixels, describeMaterialPixels, MATERIAL_LAB_EPSILON } from './lib/material-gate.mjs';

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help')) {
  console.error('用法：node scripts/gate-material-colors.mjs <png> [--rect x,y,w,h] [--min 3000] [--tolerance 25]');
  process.exit(2);
}

const path = args[0];
let rect = null;
/** 只显式传 --min 才覆盖分材质门槛（STEEL45 的默认门槛是 1200，见 material-gate.mjs） */
let minPixels;
let tolerance = MATERIAL_LAB_EPSILON;
for (let index = 1; index < args.length; index += 1) {
  const flag = args[index];
  const value = args[index + 1];
  if (flag === '--rect' && value) {
    const parts = value.split(',').map((item) => Number(item.trim()));
    if (parts.length !== 4 || parts.some((item) => !Number.isFinite(item))) {
      console.error(`--rect 需要 x,y,w,h：${value}`);
      process.exit(2);
    }
    rect = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
    index += 1;
  } else if (flag === '--min' && value) {
    minPixels = Number(value);
    index += 1;
  } else if (flag === '--tolerance' && value) {
    tolerance = Number(value);
    index += 1;
  }
}

const png = readFileSync(resolve(path));
const result = checkMaterialPixels(png, rect, { ...(minPixels === undefined ? {} : { minPixels }), tolerance });
console.log(`MATERIAL_PX ${describeMaterialPixels(result)}`);
console.log(`MATERIAL_PX_STATUS ${result.ok ? 'PASS' : 'FAIL'} image=${result.image.width}x${result.image.height} sampled=${result.sampled}`);
if (!result.ok) {
  for (const failure of result.failures) console.error(`MATERIAL_PX_MISSING ${failure}`);
  process.exit(1);
}
