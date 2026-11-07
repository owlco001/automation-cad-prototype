// 材质标识色 → three / glTF 用的**线性**RGB。
//
// 背景：整机模型的视口不是 `buildThreeMachine` 画的，而是参数化内核逐件导出的 STL 装配进
// CadViewer（`parseStandardCadBuffers` → `stageCadLoad`）。STL 没有颜色通道，颜色只能由
// 「件 → 材质」在导入时补上；补晚了（或补在另一条渲染链上）就是「几何里有色、屏幕上全灰」。
//
// 单一色源是 `machine-geometry.ts` 的 `MATERIAL_COLORS`（与 ConveyorMaterial 一一对应，
// 四色任意两两 ΔE76 ≥ 55）。这里只做空间转换：sRGB hex → 线性工作色（three r152+ 的
// `Color.r/g/b` 与 glTF 的 baseColorFactor 都吃线性值）。
import { MATERIAL_COLORS } from '../machine/machine-geometry.ts';

export function hexToLinear(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) throw new Error(`非法颜色：${hex}`);
  const value = match[1] as string;
  const channel = (index: number): number => {
    const srgb = parseInt(value.slice(index, index + 2), 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return [channel(0), channel(2), channel(4)];
}

/** 线性 RGB → '#rrggbb'（写日志/工程文件用，便于和材质色对照）。 */
export function linearToHex(rgb: readonly [number, number, number]): string {
  const channel = (value: number): string => {
    const clamped = Math.min(1, Math.max(0, value));
    const srgb = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(srgb * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`;
}

export interface MachineMaterialColor {
  material: string;
  hex: string;
  linear: [number, number, number];
}

/** 材质名（AL6063 / Q235 / STEEL45 / PVC）→ 标识色；未知材质返回 undefined（保持视口默认色）。 */
export function machineMaterialColor(material: string | undefined | null): MachineMaterialColor | undefined {
  if (!material) return undefined;
  const hex = MATERIAL_COLORS[material];
  if (!hex) return undefined;
  return { material, hex, linear: hexToLinear(hex) };
}
