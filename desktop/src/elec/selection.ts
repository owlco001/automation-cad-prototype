/**
 * 断路器—导线截面配合选型（纯函数，出图与功率估算共用）。
 *
 * 顺序固定，不允许反过来「先挑一根常用线再配断路器」：
 *   负载计算电流 → 标准断路器额定（向上取，1.25 倍余量）
 *                → 导线截面（载流量 ≥ 断路器额定，保证过载时导线仍受保护）
 *
 * 与 check.ts 的 BREAKER_OVERSIZE 是同一套口径：检查器只判对错，这里负责选得对。
 */

import { AMPACITY_TABLE, BREAKER_RATINGS } from './check.ts';

/** 单根常用导线截面上限（mm²）。超过它不再默默选一根更粗的线，而是提示分回路/并联。 */
export const SINGLE_CABLE_MAX_MM2 = 6;

export interface CableForBreaker {
  sectionMm2: number | null;
  ampacityA: number | null;
  warnings: string[];
}

export interface ProtectionSelection extends CableForBreaker {
  breakerA: number;
}

/** 按计算电流选标准断路器：1.25 倍向上取；超出最大壳架时停在最大档并告警。 */
export function breakerFor(currentA: number): number {
  const min = BREAKER_RATINGS[0] as number;
  const max = BREAKER_RATINGS[BREAKER_RATINGS.length - 1] as number;
  if (!Number.isFinite(currentA) || currentA <= 0) return min;
  const target = currentA * 1.25;
  return BREAKER_RATINGS.find((rating) => rating >= target) ?? max;
}

/**
 * 按已定断路器选导线：取载流量 ≥ 断路器额定的最小截面。
 * 表内没有能覆盖该断路器的截面时返回 null（交给调用方提示分回路/并联），
 * 绝不返回一根「看起来够粗」的表外截面。
 */
export function sectionForBreaker(breakerA: number): { sectionMm2: number; ampacityA: number } | null {
  if (!Number.isFinite(breakerA) || breakerA <= 0) return null;
  const hit = AMPACITY_TABLE.find((row) => row.amp >= breakerA);
  return hit ? { sectionMm2: hit.mm2, ampacityA: hit.amp } : null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 已知断路器时选导线，并给出「截面过大 / 超出表单范围」的告警。 */
export function selectCableForBreaker(breakerA: number, options: { label?: string } = {}): CableForBreaker {
  const label = options.label ?? '回路';
  const cable = sectionForBreaker(breakerA);
  const warnings: string[] = [];
  if (cable === null) {
    const last = AMPACITY_TABLE[AMPACITY_TABLE.length - 1];
    warnings.push(
      `${label}：断路器 ${breakerA}A 超出单根导线载流量上限` +
      `（${last?.amp ?? 0}A / ${last?.mm2 ?? 95}mm²），需分回路或并联小截面导线。`
    );
    return { sectionMm2: null, ampacityA: null, warnings };
  }
  if (cable.sectionMm2 > SINGLE_CABLE_MAX_MM2) {
    warnings.push(
      `${label}：断路器 ${breakerA}A 需要 ${cable.sectionMm2}mm² 导线（载流量 ${cable.ampacityA}A），` +
      `超过单根常用上限 ${SINGLE_CABLE_MAX_MM2}mm²，建议分回路或并联小截面导线。`
    );
  }
  return { sectionMm2: cable.sectionMm2, ampacityA: cable.ampacityA, warnings };
}

/**
 * 电流 → 断路器 → 截面 的完整选型。
 * 返回的 {breakerA, sectionMm2, ampacityA} 直接写回电气配置，供校验与报表复用。
 */
export function selectCableProtection(currentA: number, options: { label?: string } = {}): ProtectionSelection {
  const label = options.label ?? '回路';
  const breakerA = breakerFor(currentA);
  const cable = selectCableForBreaker(breakerA, options);
  const warnings = [...cable.warnings];
  const max = BREAKER_RATINGS[BREAKER_RATINGS.length - 1] as number;
  if (Number.isFinite(currentA) && currentA > 0 && currentA * 1.25 > max) {
    warnings.push(
      `${label}：计算电流 ${round1(currentA)} A 需要 ${round1(currentA * 1.25)} A 保护，` +
      `超过最大标准断路器 ${max} A，需采用更大壳架或分回路。`
    );
  }
  return { breakerA, sectionMm2: cable.sectionMm2, ampacityA: cable.ampacityA, warnings };
}

/**
 * 从断路器型号读额定电流：`iC65N 3P C16` → 16、`NXB-63 3P C32` → 32、`NSX160F 3P 100A` → 100。
 * 读不出（如 GV2 整定型号）返回 null，由调用方按计算电流回退。
 */
export function breakerRatingFromModel(model: string): number | null {
  if (typeof model !== 'string' || model.trim() === '') return null;
  // iC65N 里的 C65N 不算：数字后必须是非单词字符（空格/结尾/标点）
  for (const match of model.matchAll(/\bC\s*(\d{1,3})\b/gi)) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const amp = /\b(\d{1,3})\s*A\b/i.exec(model);
  if (amp?.[1]) {
    const value = Number(amp[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}
