/**
 * 特征 → 局部盒的**唯一判据**（`machine-geometry` 与 `panel-channel` 共用同一份实现）。
 *
 * 为什么必须抽出来（T3 复审 P1-1）：同一个件表，两处各写一套判据时结论会相反——
 * 碰撞/包络侧（machine-geometry）对未知特征类型当场抛 `INVALID_PART_GEOMETRY`，
 * 承托/通道侧（panel-channel）却把未知类型混进「减材料、无外形」跳过，于是整台机在
 * 碰撞侧失败、而通道 witness 侧继续拿偏小的盒算出「绿」。两处都"有理由"，但合起来就是
 * 「没有任何一处告警」。抽成一份实现之后，两边的分歧在代码层面不可能再出现，
 * 交叉一致性由 `test/machine/buffer-tower-model.test.mjs` 的同一组坏特征用例锁住。
 *
 * 判据（四条，两处必须逐条一致）：
 *   1. `suppressed === true` → 跳过（内核编译时就跳过，`parametric/features.ts:139,484`），
 *      排在类型/参数判定之前：参数好坏与它无关；
 *   2. `box` / `cylinder` → 量盒；参数读不出（非有限、退化半径/长度、轴向不认识、
 *      `at` 不是长度 ≥ 3 的有限数数组）→ **invalid**，不拿 0 / 'z' 顶替；
 *   3. 减材料白名单（`holes/counterbore/slot/fillet`）→ 政策跳过（不撑大、也不报错）；
 *   4. 其余类型 → **invalid**（不知道加材料还是减材料，当"无外形"跳过会让件盒偏小）。
 * 件级再叠两条：没有任何实体特征（`no-solid-feature`，旧口径给 `[0,0,0]` 零盒）、
 * 并集盒三轴有一轴 ≤ 0（`degenerate-box`，含零尺寸特征）——同样是 invalid，不是 0 盒。
 *
 * 本模块**不抛错**：抛/剔除是消费者的事（machine-geometry 抛、panel-channel 记
 * `droppedPartIds`）。这样两处对"什么是坏输入"只有一种理解，而"遇到坏输入怎么办"
 * 各自保留自己的政策。
 *
 * 世界盒换算也在这里（review P2，第二轮）：`rotateAboutZ` + `worldBoxFromLocal` 是
 * `machine-geometry.rotateLocal` 与 `panel-channel.rotate2` 两份手写旋转的唯一替代。
 * 措辞边界（可证实）：**局部盒判据 + 世界盒换算**同源；两处仍各自保留消费政策
 * （几何侧抛错 / 通道侧剔件、通道的 `shiftMm` 随动位移、`round2` 落位）。真件表里
 * `rz≠0` 的件为 0，所以旋转分支由 `buffer-tower-model.test.mjs` 的合成旋转件钉住。
 */
import type { Vec3 } from './geometry.ts';
import type { FeatureNode, InstanceTransform } from '../parametric/features.ts';

/** 量不出件/特征盒的**原因码**（两处共用同一组字符串，调用方可据此分派）。 */
export type FeatureGeometryFault =
  /** 件的结构坏：`features` 不是数组 / 件的 `transform` 缺字段或非有限数（不是参数坏） */
  | 'malformed-part'
  /** 特征节点本身坏：元素不是对象 / `params` 不是对象 */
  | 'malformed-feature'
  /** 参数读不出有限数（NaN / undefined / 字符串乱写） */
  | 'non-finite-param'
  /** 圆柱轴向不是 x/y/z */
  | 'invalid-axis'
  /** 圆柱 at 不是长度 ≥ 3 的有限数数组 */
  | 'invalid-at'
  /** 未知特征类型：不知道是加材料还是减材料，不能当「无实体」跳过 */
  | 'unknown-feature-type'
  /** 件里没有任何实体特征（全是减材料/压缩）→ 量不出盒（旧口径给 [0,0,0] 零盒） */
  | 'no-solid-feature'
  /** 并集包围盒退化（某一轴尺寸 ≤ 0，含零尺寸特征） */
  | 'degenerate-box';

/**
 * 内核里是**布尔减**、不产生外形的特征类型（`spike/build123d/app.py` 认识的减材料算子）。
 * 只有白名单里的类型可以「政策跳过」；其余一律 invalid —— 新增类型（prism/shell/extrude…）
 * 一旦漏登记，就会当场报错，而不是让件盒偏小。
 */
export const SUBTRACTIVE_FEATURE_TYPES: ReadonlySet<string> = new Set(['holes', 'counterbore', 'slot', 'fillet']);

/** 单条特征的解析结果（**不许把 `none` 与 `invalid` 混成一个 null**）。 */
export type ParsedFeatureBox =
  /** 实体特征，量得出局部盒；`radius` 只对圆柱有意义（= diameter/2），长方体给 -1 */
  | { kind: 'solid'; shape: 'box' | 'cylinder'; axis: 'x' | 'y' | 'z'; min: Vec3; max: Vec3; radius: number }
  /** 本来就没有实体外形：减材料特征（政策）或压缩特征（内核跳过） */
  | { kind: 'none'; policy: 'subtractive' | 'suppressed' }
  /** 声明了实体外形但读不出 / 类型不认识 → 不能量盒，也不能拿同件其余特征拼一个偏小的盒 */
  | { kind: 'invalid'; fault: FeatureGeometryFault; detail: string };

/** 只认「普通对象」：数组 / null / 标量都不是合法的特征节点或 params。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 诊断文案用的类型描述（null / array / 具体 typeof），别把 `[object Object]` 写进回执。 */
function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** 特征在零件局部坐标里的外形盒（box 居中；cylinder 按轴 + at 偏移）。 */
export function parseFeatureBox(node: FeatureNode): ParsedFeatureBox {
  // 结构级坏件（review P2，第二轮）：`features` 里混进 null / 字符串 / 缺 params 的节点时，
  // 旧代码在读 `node.suppressed` / `params.length` 处抛 TypeError，件号丢失并被归到
  // INTERNAL_ERROR（"软件缺陷"）—— 数据坏被说成代码坏。这里先判结构，给可派发的原因码。
  if (!isRecord(node)) {
    return {
      kind: 'invalid',
      fault: 'malformed-feature',
      detail: `特征节点不是对象（实际 ${describeType(node)}）：结构级坏件`
    };
  }
  // 压缩特征：内核编译时就跳过（`parametric/features.ts:139,484`），这里必须同口径跳过。
  // 排在类型/参数判定之前 —— 内核根本不读它的参数，参数好坏无关。
  if (node.suppressed === true) return { kind: 'none', policy: 'suppressed' };
  if (!isRecord(node.params)) {
    return {
      kind: 'invalid',
      fault: 'malformed-feature',
      detail: `特征 ${String(node.id)} 的 params 不是对象（实际 ${describeType(node.params)}）：结构级坏件`
    };
  }
  const params = node.params;
  if (node.type === 'box') {
    const length = Number(params.length);
    const width = Number(params.width);
    const height = Number(params.height);
    if (![length, width, height].every((value) => Number.isFinite(value))) {
      return {
        kind: 'invalid',
        fault: 'non-finite-param',
        detail: `长/宽/高读不出有限数（length=${String(params.length)}、width=${String(params.width)}、height=${String(params.height)}）`
      };
    }
    return {
      kind: 'solid',
      shape: 'box',
      axis: 'z',
      min: [-length / 2, -width / 2, -height / 2],
      max: [length / 2, width / 2, height / 2],
      radius: -1
    };
  }
  if (node.type === 'cylinder') {
    const radius = Number(params.diameter) / 2;
    const length = Number(params.height);
    // 半径/长度必须有限且为正，否则量不出实体盒（旧实现静默返回 null = 丢件）
    if (!Number.isFinite(radius) || !Number.isFinite(length) || radius <= 0 || length <= 0) {
      return {
        kind: 'invalid',
        fault: 'non-finite-param',
        detail: `直径/长度读不出有限正数（diameter=${String(params.diameter)}、height=${String(params.height)}）`
      };
    }
    // 轴向只认三个枚举值；缺省按 z（既有口径），声明了别的值就是参数坏了 —— 不拿 'z' 顶替
    const rawAxis = params.axis;
    const axis = rawAxis === undefined ? 'z' : rawAxis;
    if (axis !== 'x' && axis !== 'y' && axis !== 'z') {
      return { kind: 'invalid', fault: 'invalid-axis', detail: `轴向 ${String(rawAxis)} 不是 x / y / z` };
    }
    let center: Vec3 = [0, 0, 0];
    if (params.at !== undefined) {
      const rawAt = params.at;
      if (!Array.isArray(rawAt) || rawAt.length < 3) {
        return {
          kind: 'invalid',
          fault: 'invalid-at',
          detail: `at 必须是长度 ≥ 3 的数组（实际 ${Array.isArray(rawAt) ? `${rawAt.length} 项` : typeof rawAt}）`
        };
      }
      // 旧实现用 `Number(value) || 0` 把 NaN 悄悄变 0：那是编坐标，必须改成「读不出」
      const at = rawAt.map((value) => Number(value));
      if (!at.every((value) => Number.isFinite(value))) {
        return {
          kind: 'invalid',
          fault: 'invalid-at',
          detail: `at 含非有限数（${rawAt.map((value) => String(value)).join(', ')}）`
        };
      }
      center = [at[0] ?? 0, at[1] ?? 0, at[2] ?? 0];
    }
    const half: Vec3 = axis === 'x' ? [length / 2, radius, radius] : axis === 'y' ? [radius, length / 2, radius] : [radius, radius, length / 2];
    return {
      kind: 'solid',
      shape: 'cylinder',
      axis,
      min: [center[0] - half[0], center[1] - half[1], center[2] - half[2]],
      max: [center[0] + half[0], center[1] + half[1], center[2] + half[2]],
      radius
    };
  }
  if (SUBTRACTIVE_FEATURE_TYPES.has(node.type)) return { kind: 'none', policy: 'subtractive' };
  // 未知类型：既不能当「无外形」跳过（可能加材料 → 件盒偏小），也不能猜参数形状
  return {
    kind: 'invalid',
    fault: 'unknown-feature-type',
    detail: `未知特征类型 ${String(node.type)}：不确定它是加材料还是减材料，不能当「无实体特征」跳过`
  };
}

/** 一件里参与外形的实体特征（供缸体/活塞杆拆件、圆柱清单用）。 */
export interface PartSolidFeature {
  node: FeatureNode;
  box: { shape: 'box' | 'cylinder'; axis: 'x' | 'y' | 'z'; min: Vec3; max: Vec3 };
  radius: number;
}

export type ParsedPartLocalBox =
  /** 件盒量得出来：实体特征并集盒（零件局部坐标，未加件变换） */
  | { kind: 'solid'; min: Vec3; max: Vec3; features: PartSolidFeature[] }
  /** 件盒量不出来：带件级原因码 + 出问题的特征定位（件级故障 `featureIndex = -1`） */
  | {
    kind: 'invalid';
    fault: FeatureGeometryFault;
    detail: string;
    featureIndex: number;
    featureId: string;
    featureType: string;
  };

/**
 * 一件的特征树 → 局部并集盒。**先判定、再聚合**：一条特征 invalid 就整件 invalid
 * （不拿其余特征拼一个偏小的盒，那会让包络、干涉、通道 witness 一起漂）。
 */
export function parsePartLocalBox(features: readonly FeatureNode[]): ParsedPartLocalBox {
  // 结构级坏件（review P2）：`features` 本身不是数组时，旧代码靠 `features.length` 抛 TypeError，
  // 两个消费者一个整机失败、一个整张行表中断；这里统一成可分类的 `malformed-part`。
  if (!Array.isArray(features)) {
    return {
      kind: 'invalid',
      fault: 'malformed-part',
      detail: `件的 features 不是数组（实际 ${describeType(features)}）：结构级坏件，不是特征参数坏`,
      featureIndex: -1,
      featureId: '',
      featureType: ''
    };
  }
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const solids: PartSolidFeature[] = [];
  for (let index = 0; index < features.length; index += 1) {
    const raw = features[index];
    if (!isRecord(raw)) {
      return {
        kind: 'invalid',
        fault: 'malformed-feature',
        detail: `第 ${index + 1} 条特征不是对象（实际 ${describeType(raw)}）：结构级坏件`,
        featureIndex: index,
        featureId: '',
        featureType: ''
      };
    }
    // 结构检查通过后再按 `FeatureNode` 使用（isRecord 的窄化会丢掉字段类型）
    const node = raw as unknown as FeatureNode;
    const parsed = parseFeatureBox(node);
    if (parsed.kind === 'invalid') {
      return {
        kind: 'invalid',
        fault: parsed.fault,
        detail: parsed.detail,
        featureIndex: index,
        featureId: node.id,
        featureType: String(node.type)
      };
    }
    if (parsed.kind === 'none') continue;
    solids.push({
      node,
      box: { shape: parsed.shape, axis: parsed.axis, min: parsed.min, max: parsed.max },
      radius: parsed.radius
    });
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis] ?? Infinity, parsed.min[axis] ?? 0);
      max[axis] = Math.max(max[axis] ?? -Infinity, parsed.max[axis] ?? 0);
    }
  }
  if (solids.length === 0) {
    // 旧口径：`solids === 0 → box = {[0,0,0],[0,0,0]}`，一件量不出几何的零件变成零体积点
    return {
      kind: 'invalid',
      fault: 'no-solid-feature',
      detail: `件内 ${features.length} 条特征全是减材料/压缩特征，没有任何实体外形可量（旧口径会给一个 [0,0,0] 零盒）`,
      featureIndex: -1,
      featureId: '',
      featureType: ''
    };
  }
  const size: Vec3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  if (!size.every((value) => Number.isFinite(value) && value > 0)) {
    return {
      kind: 'invalid',
      fault: 'degenerate-box',
      detail: `并集包围盒退化：尺寸 ${size.map((value) => (Number.isFinite(value) ? value : String(value))).join(' × ')} mm（三轴都必须 > 0）`,
      featureIndex: -1,
      featureId: '',
      featureType: ''
    };
  }
  return { kind: 'solid', min, max, features: solids };
}

/* ------------------------------------------------------------------ *
 * 局部盒 → 世界盒（绕 Z 旋转 + 平移 + 旋转后的轴对齐包络）
 *
 * 这里只有一份实现：`machine-geometry`（碰撞/包络/拆件中心）与 `panel-channel`
 * （承托面行表）都走 `worldBoxFromLocal`。抽走之前两处各写一套 `rotateLocal` / `rotate2`，
 * 真件表 `rz≠0` 的件为 0，漂移了也没有任何用例会断（review P2）。
 * 旋转角在运行时只可能是有限数（`inspectTransform` 先判），这里不再重复兜底。
 * ------------------------------------------------------------------ */

/** 平移 + 绕 Z 旋转（角度制；`|rz| < 1e-9` 视为不转）。 */
export function rotateAboutZ(x: number, y: number, rzDeg: number): [number, number] {
  if (!Number.isFinite(rzDeg) || Math.abs(rzDeg) < 1e-9) return [x, y];
  const rad = (rzDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [x * cos - y * sin, x * sin + y * cos];
}

/** 世界盒（AABB）：`center` 是件局部盒中心经 rz 旋转 + 平移后的位置，`half` 是旋转后 AABB 的半尺寸。 */
export interface WorldBox {
  min: Vec3;
  max: Vec3;
  center: Vec3;
  half: Vec3;
}

/**
 * 局部盒 → 世界 AABB（绕 Z 旋转后的外接盒）。
 *
 * 半尺寸用 |cos|/|sin| 撑开（rz=0 时就是原尺寸），与 `interference.partBounds` 同口径；
 * z 不参与旋转。`transform` 必须已通过 `inspectTransform`（x/y/z 有限，rz 有限或缺省）。
 */
export function worldBoxFromLocal(
  transform: Pick<InstanceTransform, 'x' | 'y' | 'z'> & { rz?: number },
  box: { min: Vec3; max: Vec3 }
): WorldBox {
  const rz = Number.isFinite(transform.rz) ? (transform.rz as number) : 0;
  const local: Vec3 = [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2
  ];
  const [offsetX, offsetY] = rotateAboutZ(local[0], local[1], rz);
  const hx = (box.max[0] - box.min[0]) / 2;
  const hy = (box.max[1] - box.min[1]) / 2;
  const rad = (rz * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const half: Vec3 = [hx * cos + hy * sin, hx * sin + hy * cos, (box.max[2] - box.min[2]) / 2];
  const center: Vec3 = [transform.x + offsetX, transform.y + offsetY, transform.z + local[2]];
  return {
    center,
    half,
    min: [center[0] - half[0], center[1] - half[1], center[2] - half[2]],
    max: [center[0] + half[0], center[1] + half[1], center[2] + half[2]]
  };
}

/**
 * 件的 `transform` 结构检查：**结构级坏件**（缺字段 / 非对象 / 非有限数）必须落
 * `malformed-part`（→ `INVALID_ARGUMENT`），不许让 `part.transform.rz` 抛 TypeError
 * 被归成软件缺陷。`rz` 缺省按 0（内核编译时也是 0）。
 */
export function inspectTransform(value: unknown): { ok: true; transform: InstanceTransform } | { ok: false; detail: string } {
  if (!isRecord(value)) {
    return { ok: false, detail: `件的 transform 不是对象（实际 ${describeType(value)}）：结构级坏件` };
  }
  for (const axis of ['x', 'y', 'z'] as const) {
    const raw = value[axis];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return { ok: false, detail: `件的 transform.${axis} 读不出有限数（实际 ${String(raw)}）：结构级坏件` };
    }
  }
  const rawRz = value.rz;
  if (rawRz !== undefined && (typeof rawRz !== 'number' || !Number.isFinite(rawRz))) {
    return { ok: false, detail: `件的 transform.rz 读不出有限数（实际 ${String(rawRz)}）：结构级坏件` };
  }
  return {
    ok: true,
    transform: {
      x: value.x as number,
      y: value.y as number,
      z: value.z as number,
      rz: rawRz === undefined ? 0 : (rawRz as number)
    }
  };
}
