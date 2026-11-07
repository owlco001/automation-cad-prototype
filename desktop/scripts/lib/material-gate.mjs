// 材质标识色的**像素闸门**：从实际截图 PNG 里数四种色相的像素，而不是问渲染层「你觉得是什么色」。
//
// 为什么必须从 PNG 数：这个 bug 就是「几何里有四色、截图里全灰」——
// `resolveMachineGeometry` / `buildThreeMachine` 里颜色都对，链路却在
// 「逐件 STL → CadViewer」这一跳丢了色，任何读内存材质的断言都是绿的。
// 只有数最终像素才能发现「渲染的不是这份 geometry」「颜色被覆盖」「抓的不是这个画布」。
import { MATERIAL_COLORS } from '../../src/machine/machine-geometry.ts';
import { countColorPixels, decodePng } from './png-pixels.mjs';

/** 默认门槛：1600×1000 截图里，一种材质至少得有这么多像素才算「看得出来」。 */
export const MIN_MATERIAL_PIXELS = 3000;
/** CIE76 色差阈值：受光面/背光面与本色之间允许的漂移。 */
export const MATERIAL_LAB_EPSILON = 25;

/**
 * 分材质门槛。
 *
 * 三个大件材质按 3000 px 卡。**STEEL45 单独给 1200**，理由是实测的可见面积上限，
 * 不是为了让红灯变绿：
 *   - 本机型里 45# 钢只有滚筒（φ100×380，装在端部机架内侧）、移载导向柱（φ40）、
 *     同步轴（φ20）——全部被侧梁/皮带包在机架内部，整机 3/4 机位看过去只露弧形面；
 *   - 在 889×908 的 3D 画布上（1600×1000 窗口扣掉零件栏与干涉栏）扫描 12 个机位
 *     （方位 ±600px / 俯仰 ±240px / 缩放 ±700），STEEL45 命中像素最高 2209、默认机位 1660；
 *   - 要让它 ≥3000 只能把镜头怼进移载单元（不再满足这张图「整机 3D」的定义）。
 * 所以 1200 是「这四种材质都真的画出来了、45# 不是零星高光」的下限；
 * 若以后 45# 件不再被机架遮住（几何改动），把这里和测试一起抬回 3000。
 */
export const MATERIAL_PIXEL_FLOORS = Object.freeze({
  AL6063: MIN_MATERIAL_PIXELS,
  Q235: MIN_MATERIAL_PIXELS,
  PVC: MIN_MATERIAL_PIXELS,
  STEEL45: 1200
});

/**
 * 四色命中像素总和的下限：这一条才是「机器不是灰的」的直接判据。
 * 修复前整机 bbox 内只有 2574 px 命中（蓝 241 / 红 0 / 黄 53 / 绿 2280，且绿的还是 UI 强调色），
 * 修复后同一画布 72,791 px。门槛取 25000（实测的 1/3），只拦「颜色链路又断了」这类回归。
 */
export const MIN_TOTAL_MATERIAL_PIXELS = 25000;

export function materialTargets() {
  return Object.entries(MATERIAL_COLORS).map(([material, hex]) => ({
    material,
    hex,
    floor: MATERIAL_PIXEL_FLOORS[material] ?? MIN_MATERIAL_PIXELS
  }));
}

/**
 * @param {Buffer} png 截图字节
 * @param {{x:number,y:number,width:number,height:number}} [rect] 只统计这个区域（3D 画布），
 *        缺省整图。必须给画布矩形：UI 里的青绿/琥珀强调色也会落在色差半径内。
 * @param {{minPixels?:number, tolerance?:number}} [options]
 */
export function checkMaterialPixels(png, rect, options = {}) {
  const globalFloor = options.minPixels ?? MIN_MATERIAL_PIXELS;
  const tolerance = options.tolerance ?? MATERIAL_LAB_EPSILON;
  const image = decodePng(png);
  const targets = materialTargets();
  const scoped = rect ?? { x: 0, y: 0, width: image.width, height: image.height };
  const { counts, sampled } = countColorPixels(image, targets, { rect: scoped, tolerance });
  const rows = targets.map((target, index) => {
    const pixels = counts[index] ?? 0;
    // 显式传 minPixels 时以调用方为准（用来「按统一门槛红一次」验证闸门本身有效）
    const floor = options.minPixels === undefined ? target.floor : globalFloor;
    return { material: target.material, hex: target.hex, pixels, floor, ok: pixels >= floor };
  });
  const total = rows.reduce((sum, row) => sum + row.pixels, 0);
  const totalFloor = options.minTotal ?? MIN_TOTAL_MATERIAL_PIXELS;
  const failures = [
    ...rows.filter((row) => !row.ok).map((row) => `${row.material}(${row.hex}) ${row.pixels}px < ${row.floor}px`),
    ...(total >= totalFloor ? [] : [`四色合计 ${total}px < ${totalFloor}px（整机看起来还是灰的）`])
  ];
  return {
    ok: failures.length === 0,
    rows,
    failures,
    total,
    totalFloor,
    sampled,
    minPixels: globalFloor,
    tolerance,
    image: { width: image.width, height: image.height },
    rect: scoped
  };
}

/** 一行可直接进日志/CI 摘要的文本。 */
export function describeMaterialPixels(result) {
  const parts = result.rows.map((row) => `${row.material}(${row.hex})=${row.pixels}px/${row.floor}`);
  return `${parts.join(' ')} total=${result.total}/${result.totalFloor} | ΔE76<${result.tolerance} rect=${Math.round(result.rect.x)},${Math.round(result.rect.y)},${Math.round(result.rect.width)}x${Math.round(result.rect.height)}`;
}
