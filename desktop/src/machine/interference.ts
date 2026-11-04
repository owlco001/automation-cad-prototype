// 整机示意几何的**干涉初筛**（AABB）。
// 口径必须写死：这是先筛一遍「疑似」，不是布尔交集，不能当干涉体积用。
// 结构件之间本来就会共位（立柱插横梁），但**只放行显式声明过的连接**（见 joints.ts），
// 没声明的重叠一律算「需人工确认」——否则真正的结构撞车会被「都是结构件」一起放行。
//
// 三级判定（`kind`），这是本模块唯一的对外承诺：
//   declared = 已在 joints.ts / 几何 joints 里声明的结构连接；
//   mate     = 同一执行机构的同轴嵌套配合（缸体×活塞杆/压头：杆本来就插在缸孔里），
//              实体布尔一定报重叠，但它不是设计干涉；
//   suspect  = 其余重叠，需要人复核。
// suspect 再按证据强度分两级（`confirmation`）：
//   exact = 用解析式算出精确交集体积（长方体×长方体、同轴圆柱、圆柱全落在长方体里），
//           这是「已确认的实体重叠」；
//   aabb  = 只能给包围盒外接体积，实体未必相交（窄长件斜穿、带缝、过孔都会误报），
//           这是「screen hit，待复核」，**不得**当确认干涉处理。
// 实测（光伏板转向输送机 config 模型）：缸体×活塞杆 AABB 10080 mm³ / 解析 7916.8 mm³
// （= π·6²·70，正好是活塞杆插进缸孔的长度），OCCT 布尔同为 7916.8 mm³ —— 说明这一对
// 不是包围盒误报，而是配合面被当成零件对来比了。

import { declaredJoints, jointKey } from './joints.ts';

/** declared = 已声明/配合；mate = 同轴嵌套配合；suspect = 没声明，需要人看 */
export type ScreenKind = 'declared' | 'mate' | 'suspect';

/** exact = 解析式精确；aabb = 只有包围盒依据 */
export type ScreenConfirmation = 'exact' | 'aabb';

export interface ScreenPair {
  a: string;
  b: string;
  aName: string;
  bName: string;
  aRole: string;
  bRole: string;
  /**
   * 旧口径（保持原值不变，供 layout/resolve 等既有消费方）：declared / suspect。
   * mate 仍记 'suspect' —— 这些模块只会「挪开算重叠的东西」，改判定会改变求解结果。
   */
  kind: 'declared' | 'suspect';
  /** 新口径（权威）：declared / mate / suspect，见文件头 */
  classification: ScreenKind;
  /** exact = 解析式精确交集体积；aabb = 只有包围盒依据，需复核 */
  confirmation: ScreenConfirmation;
  /** declared 时给出原因（如「立柱插横梁」） */
  reason?: string;
  /** mate / 复核说明（为什么不算设计干涉、该怎么复核） */
  note?: string;
  /** 让这一对分开的最小轴向外移建议（谁动、往哪动、多少 mm） */
  suggestion?: { partId: string; axis: 'x' | 'y' | 'z'; delta: number };
  /** AABB 重叠体积（mm³），上界，只作排序/量级参考 */
  overlapMm3: number;
  /** 解析式精确交集体积（mm³）；confirmation='aabb' 时为 null，不拿外接盒冒充 */
  exactOverlapMm3: number | null;
  overlapBox: [number, number, number];
}

export interface ScreenResult {
  /** aabb = 轴对齐包围盒初筛；不是真实布尔交集 */
  mode: 'aabb';
  partCount: number;
  pairs: ScreenPair[];
  count: number;
  /** 按判定拆分：declared=已声明连接，mate=同轴嵌套配合，suspect=需人工确认 */
  declared: number;
  /** 同轴嵌套配合（缸体×活塞杆/压头）——实体布尔也会重叠，但不是设计干涉 */
  mates: number;
  /** 非声明对的总数（旧口径，含 mate）= confirmed + screen + mates */
  suspects: number;
  /** suspect 里能解析式确认「实体真的重叠」的对数 → 才允许判 FAIL */
  confirmed: number;
  /** suspect 里只有包围盒依据、实体未必相交的对数 → screen hit，只能判 WARN */
  screen: number;
  /** 已确认重叠体积（解析式；mm³） */
  confirmedMm3: number;
  /** 待复核对的重叠体积上界（AABB；mm³） */
  screenMm3: number;
  /** 声明放行的重叠体积（mm³，仅供参考：声明规则可能挡掉真实互穿） */
  declaredMm3: number;
  /** 贴面（一轴≈0、另两轴重叠）的对数；这类既不是重叠也不该被静默丢掉 */
  touching: number;
  /** 贴面但没在 joints 里声明连接——值得人看一眼 */
  undeclaredTouching: number;
  touchingPairs: Array<{ a: string; b: string; declared: boolean }>;
  /** 声明连接的数量（可能比 overlapping 的多：声明了但没重叠） */
  declaredJoints: number;
  /** generator = 由几何生成器产出；rules = 退回命名规则（老数据） */
  jointSource: 'generator' | 'rules';
  /** 全部重叠都是已声明连接或配合面时为 true */
  structuralOnly: boolean;
}

type Vec3 = [number, number, number];

/** 建议位移里预留给「刚好贴住」之外的间隙（mm） */
const GAP = 1;

/** 判定为「同轴」的中心偏移容差（mm）与「确认重叠」的最小体积（mm³） */
const COAXIAL_TOL_MM = 0.5;
const CONFIRM_MIN_MM3 = 1;

const isZCylinder = (part: any): boolean =>
  part?.shape?.type === 'cylinder' && (part.shape.axis ?? 'z') === 'z';

/**
 * 解析式精确交集体积（mm³）。只在**能证明精确**时返回数字，其余返回 null ——
 * 宁可标成待复核，也不拿外接盒体积冒充交集体积。
 *
 * 覆盖三类（本生成器只有 box / cylinder 两种原始体）：
 * 1. 长方体 × 长方体，都不绕 Z 转：包围盒就是实体；
 * 2. 同轴圆柱（缸体×活塞杆这类）：交集是半径取小者、长度取 Z 向重叠的圆柱；
 * 3. 圆柱整个落在长方体 XY 内部：圆面积 × Z 向重叠。
 * 旋转件、斜穿件、圆柱压长方体的边角情形一律 null（AABB 会高估）。
 */
export function exactOverlapMm3(a: any, b: any, dims: Vec3): number | null {
  const [dx, dy, dz] = dims;
  if (!(dx > 0) || !(dy > 0) || !(dz > 0)) return null;
  const rotA = Math.abs(Number(a?.rotationZDeg) || 0);
  const rotB = Math.abs(Number(b?.rotationZDeg) || 0);
  const boxA = a?.shape?.type === 'box';
  const boxB = b?.shape?.type === 'box';
  const cylA = isZCylinder(a);
  const cylB = isZCylinder(b);
  if (boxA && boxB && rotA < 1e-9 && rotB < 1e-9) return dx * dy * dz;
  if (cylA && cylB) {
    const ca = a.center as Vec3;
    const cb = b.center as Vec3;
    if (Math.abs(ca[0] - cb[0]) <= COAXIAL_TOL_MM && Math.abs(ca[1] - cb[1]) <= COAXIAL_TOL_MM) {
      const radius = Math.min(Number(a.shape.radius) || 0, Number(b.shape.radius) || 0);
      return radius > 0 ? Math.PI * radius * radius * dz : null;
    }
    return null;
  }
  const cylinderInsideBox = (cyl: any, box: any): number | null => {
    if (Math.abs(Number(box?.rotationZDeg) || 0) > 1e-9) return null;
    const bounds = partBounds(box);
    const center = cyl.center as Vec3;
    const radius = Number(cyl.shape.radius) || 0;
    if (!(radius > 0)) return null;
    const inside =
      center[0] - radius >= bounds.min[0] - 1e-9 && center[0] + radius <= bounds.max[0] + 1e-9 &&
      center[1] - radius >= bounds.min[1] - 1e-9 && center[1] + radius <= bounds.max[1] + 1e-9;
    return inside ? Math.PI * radius * radius * dz : null;
  };
  if (cylA && boxB) return cylinderInsideBox(a, b);
  if (cylB && boxA) return cylinderInsideBox(b, a);
  return null;
}

/**
 * 同轴嵌套配合：同一执行机构、两根 Z 向圆柱、中心重合、半径不等（杆在缸孔里）。
 *
 * 为什么必须单独判：`generateMachineGeometry` 把缸体与活塞杆建成两个实心圆柱
 * （geometry.ts 缸体 Ø32×130 / 活塞杆 Ø12×95，杆插进孔里 70 mm），任何实体布尔
 * ——AABB 也好、OCCT 也好——都会算出重叠。把它算成设计干涉，就会得出「缸体撞活塞杆」
 * 这种不成立的结论。这里只放行**同一执行机构内的同轴嵌套**，跨执行机构一律 suspect。
 */
export function mateReason(a: any, b: any): string | null {
  const actuator = a?.actuatorId;
  if (typeof actuator !== 'string' || actuator.length === 0 || actuator !== b?.actuatorId) return null;
  if (!isZCylinder(a) || !isZCylinder(b)) return null;
  const ca = a.center as Vec3;
  const cb = b.center as Vec3;
  if (Math.abs(ca[0] - cb[0]) > COAXIAL_TOL_MM || Math.abs(ca[1] - cb[1]) > COAXIAL_TOL_MM) return null;
  const ra = Number(a.shape.radius) || 0;
  const rb = Number(b.shape.radius) || 0;
  if (!(ra > 0) || !(rb > 0) || Math.abs(ra - rb) < COAXIAL_TOL_MM) return null;
  const innerDiameter = Math.min(ra, rb) * 2;
  const outerDiameter = Math.max(ra, rb) * 2;
  return `同轴嵌套配合（执行机构 ${actuator}）：Ø${innerDiameter.toFixed(0)} 杆件插在 Ø${outerDiameter.toFixed(0)} 缸孔内，实体布尔必然重叠，属配合面而非设计干涉`;
}


function halfExtents(part: any): Vec3 {
  const shape = part.shape || {};
  if (shape.type === 'box') {
    const [x, y, z] = shape.size as Vec3;
    return [x / 2, y / 2, z / 2];
  }
  const radius = Number(shape.radius) || 0;
  const length = Number(shape.length) || 0;
  if (shape.axis === 'x') return [length / 2, radius, radius];
  if (shape.axis === 'y') return [radius, length / 2, radius];
  return [radius, radius, length / 2];
}

/** 绕 Z 旋转后的轴对齐包围盒（mm）。 */
export function partBounds(part: any): { min: Vec3; max: Vec3 } {
  const [hx, hy, hz] = halfExtents(part);
  const rad = ((Number(part.rotationZDeg) || 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const isCylinder = part?.shape?.type === 'cylinder';
  // 圆柱绕自身 Z 轴转，包围盒不变。按「旋转的方块」算会把半径方向放大到 √2 倍，
  // 从而凭空造出一堆假重叠（实测六工位机里 12 对就是这么来的）。
  const ex = isCylinder ? hx : hx * cos + hy * sin;
  const ey = isCylinder ? hy : hx * sin + hy * cos;
  const center = part.center as Vec3;
  return {
    min: [center[0] - ex, center[1] - ey, center[2] - hz],
    max: [center[0] + ex, center[1] + ey, center[2] + hz]
  };
}

function extentVolume(part: any): number {
  const [hx, hy, hz] = halfExtents(part);
  return hx * hy * hz * 8;
}

export interface ScreenOptions {
  /**
   * 已由真实布尔确认「AABB 误报」的对（`jointKey(a,b)`），初筛直接跳过。
   * 只该放进来**复核过**的对：没复核过的照旧算 suspect，不能靠猜。
   */
  ignorePairs?: string[];
}

export function screenInterference(geometry: any, options: ScreenOptions = {}): ScreenResult {
  const ignored = new Set(options.ignorePairs ?? []);
  const parts = Array.isArray(geometry?.parts) ? geometry.parts : [];
  const boxes = parts.map((part: any) => ({ part, bounds: partBounds(part) }));
  // 优先用生成器自己产出的 joints（几何=唯一事实来源）；
  // 老数据/外部 geometry 没有 joints 字段时，退回按命名规则的表，并在结果里标出来源。
  const generatorJoints = Array.isArray(geometry?.joints) ? geometry.joints : [];
  const declared = new Map<string, { reason: string; contactOnly: boolean }>();
  for (const joint of declaredJoints(parts)) {
    declared.set(jointKey(joint.a, joint.b), { reason: joint.reason, contactOnly: false });
  }
  for (const joint of generatorJoints) {
    if (typeof joint?.a !== 'string' || typeof joint?.b !== 'string') continue;
    declared.set(jointKey(joint.a, joint.b), {
      reason: String(joint.reason ?? '生成器声明的结构连接'),
      // contactOnly：只允许贴合，不允许互穿（叠装关系就是这样）
      contactOnly: joint.contactOnly === true
    });
  }
  const jointSource = generatorJoints.length > 0 ? 'generator' : 'rules';
  const pairs: ScreenPair[] = [];
  const touching: Array<{ a: string; b: string; declared: boolean }> = [];
  const EPS = 0.5;  // mm：小于这个量的接触（贴面/装配面）不算
  const CONTACT_TOLERANCE_MM = 1.0;  // 声明为贴合的连接，最多容忍 1 mm 互穿
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i].bounds;
      const b = boxes[j].bounds;
      const dx = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]);
      const dy = Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]);
      const dz = Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]);
      if (dx <= EPS || dy <= EPS || dz <= EPS) {
        // 贴面（一轴 ≈0、另两轴真重叠）：以前直接丢掉，等于静默漏报。
        // 立柱顶面贴顶框这类是正常装配，但**没在 joints 里声明的贴面**值得人看一眼。
        const spans = [dx, dy, dz];
        const flat = spans.filter((value) => Math.abs(value) <= EPS).length;
        const overlapping = spans.filter((value) => value > EPS).length;
        if (flat === 1 && overlapping === 2) {
          const idA = String(boxes[i].part.id);
          const idB = String(boxes[j].part.id);
          const declaredReason = declared.get(jointKey(idA, idB));
          touching.push({ a: idA, b: idB, declared: declaredReason !== undefined });
        }
        continue;
      }
      if (ignored.has(jointKey(String(boxes[i].part.id), String(boxes[j].part.id)))) continue;
      const declaration = declared.get(jointKey(String(boxes[i].part.id), String(boxes[j].part.id)));
      // 声明为「只许贴合」的连接：穿模超过容差**仍要算 suspect**。
      // 之前只改了文案没改 kind，结果照样被当成 declared —— 等于没修。
      const penetration = Math.min(dx, dy, dz);
      const violatesContact = declaration?.contactOnly === true && penetration > CONTACT_TOLERANCE_MM;
      const reason = violatesContact ? undefined : declaration?.reason;
      const suspectNote = violatesContact
        ? `${declaration?.reason ?? '已声明连接'}，但穿模 ${penetration.toFixed(1)} mm`
        : undefined;
      // 分开代价最小的方案：逐轴算「往 + / 往 -」各自要挪多远，取全局最小。
      // 注意不能直接拿重叠量当位移：移动件一旦越过对方边界，所需位移会比重叠量更大
      //（实测下横梁 40mm 重叠却要挪 51mm 才真的分开）。
      const iPart = boxes[i].part;
      const jPart = boxes[j].part;
      // 三级判定：声明连接 → 同轴嵌套配合 → 待复核。配合面要排在 suspect 之前，
      // 否则缸体×活塞杆会被算成「设计干涉」（这是本次评审误判 FAIL 的直接原因）。
      const mate = reason ? null : mateReason(iPart, jPart);
      const classification: ScreenKind = reason ? 'declared' : mate ? 'mate' : 'suspect';
      const exact = exactOverlapMm3(iPart, jPart, [dx, dy, dz]);
      const confirmation: ScreenConfirmation = exact === null ? 'aabb' : 'exact';
      const pairNote = suspectNote
        ?? mate
        ?? (confirmation === 'aabb' && classification === 'suspect'
          ? '只有包围盒依据（旋转件/斜穿件/过孔都可能误报），实体是否真的相交要另行复核'
          : undefined);
      const iVolume = extentVolume(iPart);

      const jVolume = extentVolume(jPart);
      const mover = iVolume <= jVolume ? iPart : jPart;
      const other = iVolume <= jVolume ? jPart : iPart;
      const moverBounds = partBounds(mover);
      const otherBounds = partBounds(other);
      // 逐个下标取用会命中 noUncheckedIndexedAccess（number | undefined），摊平成数组再索引
      const moverMin: number[] = [...moverBounds.min];
      const moverMax: number[] = [...moverBounds.max];
      const otherMin: number[] = [...otherBounds.min];
      const otherMax: number[] = [...otherBounds.max];
      let bestAxis: 'x' | 'y' | 'z' = 'x';
      let bestDelta = Number.POSITIVE_INFINITY;
      (['x', 'y', 'z'] as const).forEach((axis, index) => {
        const plus = (otherMax[index] ?? 0) - (moverMin[index] ?? 0) + GAP;
        const minus = (moverMax[index] ?? 0) - (otherMin[index] ?? 0) + GAP;
        if (plus < bestDelta) {
          bestDelta = plus;
          bestAxis = axis;
        }
        if (minus < bestDelta) {
          bestDelta = minus;
          bestAxis = axis;
        }
      });
      const axisIndex = bestAxis === 'x' ? 0 : bestAxis === 'y' ? 1 : 2;
      // 方向：优先「往远离对方中心的那一侧」
      const centerGap = Number(mover.center[axisIndex]) - Number(other.center[axisIndex]);
      const sign = centerGap > 0 ? 1 : centerGap < 0 ? -1 : 1;
      const plusNeed = (otherMax[axisIndex] ?? 0) - (moverMin[axisIndex] ?? 0) + GAP;
      const minusNeed = (moverMax[axisIndex] ?? 0) - (otherMin[axisIndex] ?? 0) + GAP;
      const delta = sign > 0 ? plusNeed : -minusNeed;
      const suggestion = {
        partId: String(mover.id),
        axis: bestAxis,
        delta: Math.round(delta * 10) / 10
      };
      pairs.push({
        kind: classification === 'declared' ? 'declared' : 'suspect',
        classification,
        confirmation,
        ...(reason ? { reason } : {}),
        ...(pairNote ? { note: pairNote } : {}),
        ...(suspectNote ? { penetrationMm: Math.round(penetration * 10) / 10 } : {}),
        a: boxes[i].part.id,
        b: boxes[j].part.id,
        aName: boxes[i].part.name,
        bName: boxes[j].part.name,
        aRole: boxes[i].part.role,
        bRole: boxes[j].part.role,
        suggestion,
        overlapMm3: Math.round(dx * dy * dz * 10) / 10,
        exactOverlapMm3: exact === null ? null : Math.round(exact * 10) / 10,
        overlapBox: [Math.round(dx * 100) / 100, Math.round(dy * 100) / 100, Math.round(dz * 100) / 100]
      });
    }
  }
  // 需人工确认的排前面：结构共位与配合面是常态，先看 suspect 才有意义
  // 排序用旧口径 kind（declared 沉底），配合面在组内按体积排，不改既有顺序语义
  pairs.sort((x, y) => (x.kind === y.kind ? y.overlapMm3 - x.overlapMm3 : x.kind === 'suspect' ? -1 : 1));
  // 「确认」的门槛：非配合的 suspect + 解析式精确 + 体积超过 1 mm³。
  // 只有这一档允许下游判 FAIL；confirmation='aabb' 的一律是 screen hit（待复核）。
  const confirmedPairs = pairs.filter(
    (pair) => pair.classification === 'suspect' && pair.confirmation === 'exact' && (pair.exactOverlapMm3 ?? 0) > CONFIRM_MIN_MM3
  );
  const screenPairs = pairs.filter((pair) => pair.classification === 'suspect' && !confirmedPairs.includes(pair));
  const matePairs = pairs.filter((pair) => pair.classification === 'mate');
  const declaredPairs = pairs.filter((pair) => pair.classification === 'declared');
  // suspects 保留「非声明对」的旧口径（含 mate）：layout.ts / resolve.ts / widen.ts 靠它判
  // 「还有没有要挪的」，配合面本来也在里面，语义不变；新的细分看 confirmed / screen / mates。
  const suspects = pairs.filter((pair) => pair.kind !== 'declared').length;
  const sum = (list: ScreenPair[], pick: (pair: ScreenPair) => number): number =>
    Math.round(list.reduce((total, pair) => total + pick(pair), 0) * 10) / 10;
  const undeclaredTouching = touching.filter((item) => !item.declared).length;
  return {
    mode: 'aabb',
    partCount: parts.length,
    pairs,
    count: pairs.length,
    declared: declaredPairs.length,
    mates: matePairs.length,
    suspects,
    confirmed: confirmedPairs.length,
    screen: screenPairs.length,
    confirmedMm3: sum(confirmedPairs, (pair) => pair.exactOverlapMm3 ?? 0),
    screenMm3: sum(screenPairs, (pair) => pair.overlapMm3),
    declaredMm3: sum(declaredPairs, (pair) => pair.exactOverlapMm3 ?? pair.overlapMm3),
    touching: touching.length,
    undeclaredTouching,
    touchingPairs: touching,
    declaredJoints: declared.size,
    jointSource,
    structuralOnly: pairs.length > 0 && suspects === 0
  };
}
