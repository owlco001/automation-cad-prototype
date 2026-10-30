// 真实布尔复核：把 AABB 初筛出来的「疑似干涉」拿去问 sidecar，分成「确认干涉」和「AABB 误报」。
//
// 为什么需要：AABB 看不见孔、也把圆柱当方块（实测圆柱相贯高估 ×1.273，螺栓穿孔 100% 误报）。
// 所以初筛只能说「疑似」，结论要落到真实布尔上。
//
// 能复核什么：`box`（无旋转）与沿 Z 的 `cylinder`——sidecar 的算子就能表达这两个。
// 能复核：`box`（含 `rotationZDeg`：居中→绕自身转→平移）、沿 Z 的 `cylinder`（绕 Z 自转不影响形状）。
// 不能复核的（沿 X/Y 的圆柱）如实标 `unsupported`，不假装复核过。

import type { GeomPart, Vec3 } from './geometry.ts';

export interface SidecarMember {
  ops: Array<Record<string, unknown>>;
  offset: Vec3;
}

export interface MemberResult {
  ok: boolean;
  member?: SidecarMember;
  reason?: string;
}

/**
 * 把一个整机零件翻译成 sidecar 的成员。
 *
 * 注意坐标系差：sidecar 的 `box` 以**原点角**对齐（align=MIN），整机零件记的是**中心**，
 * 所以 offset 要减半个尺寸；`cylinder` 在 sidecar 里以原点为中心，offset 就是中心。
 */
export function partToMember(part: GeomPart): MemberResult {
  const rotation = ((part.rotationZDeg % 360) + 360) % 360;
  if (part.shape.type === 'box') {
    if (rotation !== 0) {
      // 带转角的方块：先把盒子的几何中心放到原点 → 绕原点转 Z（= 绕自身中心转）→ 平移到实际中心。
      // 之前这里一律标 unsupported，结果六工位那 8 对（整机整体转 60°）永远复核不了。
      const [sx, sy, sz] = part.shape.size;
      return {
        ok: true,
        member: {
          ops: [
            { op: 'box', length: sx, width: sy, height: sz, anchor: 'center' },
            { op: 'rotate', deg: rotation },
            { op: 'move', x: part.center[0], y: part.center[1], z: part.center[2] }
          ],
          offset: [0, 0, 0]
        }
      };
    }
    const [sx, sy, sz] = part.shape.size;
    return {
      ok: true,
      member: {
        ops: [{ op: 'box', length: sx, width: sy, height: sz }],
        offset: [part.center[0] - sx / 2, part.center[1] - sy / 2, part.center[2] - sz / 2]
      }
    };
  }
  const shape = part.shape;
  if (shape.axis !== 'z') {
    return { ok: false, reason: `零件 ${part.id} 是沿 ${shape.axis.toUpperCase()} 的圆柱，sidecar 只支持沿 Z` };
  }
  // 沿 Z 的圆柱绕 Z 自转形状不变，rotationZDeg 可以忽略（不是“不支持”）
  return {
    ok: true,
    member: {
      ops: [{ op: 'cylinder', diameter: shape.radius * 2, height: shape.length }],
      offset: [part.center[0], part.center[1], part.center[2]]
    }
  };
}

export interface RecheckPairResult {
  a: string;
  b: string;
  /** 真实布尔交集体积（mm³），复核不到时为 null */
  overlapMm3: number | null;
  /** confirmed = 真撞；misreported = AABB 误报；unchecked = 复核不了 */
  verdict: 'confirmed' | 'misreported' | 'unchecked';
  reason?: string;
}

export interface RecheckResult {
  checked: number;
  confirmed: number;
  misreported: number;
  unchecked: number;
  pairs: RecheckPairResult[];
  /** false 表示没能连上 sidecar，此时任何「已复核」的说法都不成立 */
  available: boolean;
  message?: string;
}

interface RecheckOptions {
  buildUrl: string;
  /** 只复核前 N 对（初筛可能有几十对，全量跑很慢） */
  limit?: number;
  timeoutMs?: number;
}

export async function recheckPairs(
  parts: GeomPart[],
  suspects: Array<{ a: string; b: string }>,
  options: RecheckOptions
): Promise<RecheckResult> {
  const byId = new Map(parts.map((part) => [part.id, part]));
  const limit = options.limit ?? 40;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const picked = suspects.slice(0, limit);
  if (picked.length === 0) {
    // 没有疑似对：既不是「复核过没问题」，也不是「复核不了」——如实说「不需要」
    return { checked: 0, confirmed: 0, misreported: 0, unchecked: 0, pairs: [], available: true, message: '没有疑似干涉，无需复核' };
  }
  const results: RecheckPairResult[] = [];
  const empty = { checked: 0, confirmed: 0, misreported: 0, unchecked: 0 };

  for (const suspect of picked) {
    const left = byId.get(suspect.a);
    const right = byId.get(suspect.b);
    if (!left || !right) {
      results.push({ a: suspect.a, b: suspect.b, overlapMm3: null, verdict: 'unchecked', reason: '零件不在几何里' });
      continue;
    }
    const memberA = partToMember(left);
    const memberB = partToMember(right);
    if (!memberA.ok || !memberB.ok) {
      results.push({
        a: suspect.a,
        b: suspect.b,
        overlapMm3: null,
        verdict: 'unchecked',
        reason: memberA.reason ?? memberB.reason ?? '零件无法翻译成 sidecar 成员'
      });
      continue;
    }

    let response: Response;
    try {
      response = await fetch(`${options.buildUrl.replace(/\/$/, '')}/interfere`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ members: [memberA.member, memberB.member] }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      // 连不上就整体停：后面每一对都会是同一个错误，不能刷成「全部误报」
      return {
        ...empty,
        pairs: results,
        available: false,
        message: `复核不可用：${(error as Error).message}（结论仍是 AABB 初筛，不能当真实布尔）`
      };
    }
    const payload = (await response.json()) as { ok?: boolean; message?: string; pairs?: Array<{ overlapMm3: number }> };
    if (!payload.ok) {
      results.push({
        a: suspect.a,
        b: suspect.b,
        overlapMm3: null,
        verdict: 'unchecked',
        reason: payload.message ?? 'sidecar 返回失败'
      });
      continue;
    }
    const overlap = payload.pairs?.[0]?.overlapMm3 ?? 0;
    results.push({
      a: suspect.a,
      b: suspect.b,
      overlapMm3: overlap,
      verdict: overlap > 1e-6 ? 'confirmed' : 'misreported'
    });
  }

  const count = (verdict: RecheckPairResult['verdict']) => results.filter((item) => item.verdict === verdict).length;
  return {
    checked: results.length,
    confirmed: count('confirmed'),
    misreported: count('misreported'),
    unchecked: count('unchecked'),
    pairs: results,
    available: true,
    ...(suspects.length > picked.length
      ? { message: `只复核了前 ${picked.length}/${suspects.length} 对（其余仍是 AABB 初筛）` }
      : {})
  };
}
