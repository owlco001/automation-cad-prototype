// 「线体加宽」：把工位沿 X 拉开，同时把机架/输送线按同一比例拉长。
//
// 为什么必须一起动：只挪工位、不动机架时，工位会走到机架外面去（上一版实测 800 mm 也不收敛）。
// 这里的模型是**示意级**的：机架件的 X 位置与 X 尺寸按同一比例缩放，等同于「线体按比例加长」；
// 不是真实的结构改型（门架、护栏、地脚、安全门都要重做，那属于详设）。
//
// 口径：extraMm 是「相邻工位之间多加多少」。整体 X 跨度从 span 变成 span + extraMm × (站数-1)。

import { resolveLayout } from './layout.ts';
import type { LayoutResult } from './layout.ts';

const STATION = /^st\d+$/;

function scopeOf(partId: string): string {
  const head = partId.split('-')[0] ?? partId;
  return head;
}

export interface WidenProbe {
  extraMm: number;
  converged: boolean;
  suspects: number;
  clearance: number;
}

export interface WidenResult {
  /** 最小可行加宽（mm）。reachable=false 时是探测上限 */
  extraMm: number;
  targetClearanceMm: number;
  probes: WidenProbe[];
  reachable: boolean;
  maxExtraMm: number;
  /** 到上限仍不行时的剩余问题（用于说明「加宽救不了」） */
  remaining?: { intra: number; cross: number; reason: string };
}

/** 按比例拉长：工位按序号右移，机架类零件的位置与 X 尺寸一起放大 */
export function widenMachine(geometry: any, extraMm: number): any {
  const parts: any[] = Array.isArray(geometry?.parts) ? geometry.parts : [];
  if (parts.length === 0 || extraMm === 0) {
    return { ...geometry, parts: parts.map((part: any) => ({ ...part })) };
  }

  const stationXs = new Map<string, number[]>();
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (const part of parts) {
    const center = part?.center as number[] | undefined;
    if (!center) continue;
    const x = Number(center[0]);
    if (Number.isFinite(x)) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
    const scope = scopeOf(String(part.id ?? ''));
    if (!STATION.test(scope)) continue;
    const list = stationXs.get(scope) ?? [];
    list.push(x);
    stationXs.set(scope, list);
  }
  const orderedStations = [...stationXs.entries()]
    .map(([scope, xs]) => ({ scope, x: xs.reduce((sum, value) => sum + value, 0) / (xs.length || 1) }))
    .sort((left, right) => left.x - right.x)
    .map((entry) => entry.scope);

  const span = Number.isFinite(minX) && Number.isFinite(maxX) ? Math.max(maxX - minX, 1) : 1;
  const growth = extraMm * Math.max(orderedStations.length - 1, 0);
  const factor = (span + growth) / span;

  return {
    ...geometry,
    parts: parts.map((part: any) => {
      const center = part?.center as number[] | undefined;
      if (!center) return { ...part };
      const scope = scopeOf(String(part.id ?? ''));
      const next = [...center];
      if (STATION.test(scope)) {
        // 工位：按序号整体右移，站内相对位置不动（站内要改布局是另一回事）
        const index = orderedStations.indexOf(scope);
        next[0] = Number(center[0]) + Math.max(index, 0) * extraMm;
      } else {
        // 机架/输送线：位置与 X 尺寸按同一比例放大，相当于线体按比例拉长
        next[0] = Number(center[0]) * factor;
      }
      const shape = part?.shape;
      let scaledShape = shape;
      if (shape && Array.isArray(shape.size) && shape.type === 'box') {
        const size = [...shape.size];
        if (STATION.test(scope)) {
          // 站内的板件跟着站走，尺寸不变
        } else {
          size[0] = Number(size[0]) * factor;
        }
        scaledShape = { ...shape, size };
      }
      return { ...part, center: next, ...(scaledShape ? { shape: scaledShape } : {}) };
    })
  };
}

export interface WidenOptions {
  clearanceMm: number;
  maxExtraMm?: number;
  stepMm?: number;
  maxRounds?: number;
}

export function minWidening(geometry: any, options: WidenOptions): WidenResult {
  const maxExtraMm = options.maxExtraMm ?? 800;
  const stepMm = options.stepMm ?? 20;
  const probes: WidenProbe[] = [];

  const probe = (extraMm: number): WidenProbe => {
    const widened = widenMachine(geometry, extraMm);
    const layout: LayoutResult = resolveLayout(widened, {
      clearanceMm: options.clearanceMm,
      maxRounds: options.maxRounds ?? 4
    });
    return { extraMm, converged: layout.converged, suspects: layout.suspects, clearance: layout.clearance };
  };

  const atZero = probe(0);
  probes.push(atZero);
  if (atZero.converged) {
    return { extraMm: 0, targetClearanceMm: options.clearanceMm, probes, reachable: true, maxExtraMm };
  }

  const atMax = probe(maxExtraMm);
  probes.push(atMax);
  if (!atMax.converged) {
    const widened = widenMachine(geometry, maxExtraMm);
    const layout = resolveLayout(widened, { clearanceMm: options.clearanceMm, maxRounds: options.maxRounds ?? 4 });
    const advice = layout.advice ?? [];
    const intra = advice.filter((item) => item.intraScope).length;
    const cross = advice.length - intra;
    return {
      extraMm: maxExtraMm,
      targetClearanceMm: options.clearanceMm,
      probes,
      reachable: false,
      maxExtraMm,
      remaining: {
        intra,
        cross,
        reason: layout.suspects > 0 && layout.clearance === 0
          // 剩下的是重叠：加宽只解决「太近」，解决不了「撞在一起」
          ? `加宽到 +${maxExtraMm} mm 仍有 ${layout.suspects} 处重叠：加宽只解决间距，重叠要改布局或减件`
          : intra > 0
            ? `加宽到 +${maxExtraMm} mm 仍有 ${intra} 个工位内部的问题：这些跟线体宽度无关，要改工位内布局`
            : `加宽到 +${maxExtraMm} mm 仍有 ${cross} 个跨工位问题：需要继续加宽或减少零件`
      }
    };
  }

  let low = 0;
  let high = maxExtraMm;
  while (high - low > stepMm) {
    const mid = Math.round((low + high) / 2);
    if (mid <= low || mid >= high) break;
    const result = probe(mid);
    probes.push(result);
    if (result.converged) high = mid;
    else low = mid;
  }
  return { extraMm: high, targetClearanceMm: options.clearanceMm, probes, reachable: true, maxExtraMm };
}
