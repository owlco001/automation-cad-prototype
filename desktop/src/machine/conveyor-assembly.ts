/**
 * 皮带输送机 → 参数化装配文档（喂给 build123d sidecar 出真实实体）。
 *
 * 这里**不画代理体**：每个零件都是一段合法的参数化特征（box / cylinder / holes），
 * 由软件里的建模内核（spike/build123d/app.py）布尔求和成 B-rep，导出 STEP/STL，
 * 并把每个实例的体积回传用于质量与 BOM。
 *
 * 坐标系与内核一致：Z 向上、单位 mm；X 为输送方向（物料从左往右）；
 * 原点在机架地面中心，皮带面高度默认 850。
 */

import type { AssemblyDoc, FeatureNode, InstanceTransform, PartInstance } from '../parametric/features.ts';

export type ConveyorMaterial = 'AL6063' | 'Q235' | 'PVC' | 'STEEL45';

/** kg/m³ */
export const MATERIAL_DENSITY: Record<ConveyorMaterial, number> = {
  AL6063: 2700,
  Q235: 7850,
  PVC: 1400,
  STEEL45: 7850
};

export const MATERIAL_LABEL: Record<ConveyorMaterial, string> = {
  AL6063: '铝型材 6063-T5',
  Q235: 'Q235 钢板',
  PVC: 'PVC 皮带',
  STEEL45: '45# 钢'
};

export interface ConveyorParams {
  /** 线体总长（两滚筒中心距 + 端部余量），mm */
  lengthMm: number;
  /** 皮带有效宽度，mm */
  widthMm: number;
  /** 皮带面高度，mm（地面到皮带上面） */
  beltHeightMm: number;
  /** 滚筒直径，mm */
  pulleyDiameterMm: number;
  /** 皮带厚度，mm */
  beltThicknessMm: number;
  /** 型材截面，mm（40 表示 4040） */
  frameSectionMm: number;
  /**
   * 缓存层数（1 = 普通输送线；≥2 = 立体缓存：底层输送 + 上方多层托架 + 升降机构）。
   * 层高由 layerPitchMm 决定，层位从皮带面往上排。省略即单层。
   */
  layers?: number;
  /** 层间距，mm（layers ≥ 2 时才有意义） */
  layerPitchMm?: number;
  /**
   * 转向工位：线体中段把工件就地旋转多少度（45/90/180），0 或省略表示不做转向。
   *
   * 只在单层线体（layers === 1）生效：立体缓存的中段要给升降台让位，两套机构抢同一个空间。
   * 角度只影响回转轴的分度范围与动作时间，不影响静态几何（转台在任一角度都是同一个圆柱）。
   */
  turnerAngleDeg?: number;
  /**
   * 顶升移载（直角移载）：板**不转**，顶升后沿 +Y 平移到下游输送线。
   * 与 turnerAngleDeg 互斥（两套机构抢同一段线体）。
   */
  transferPresent?: boolean;
  /** 板材沿 X 的长度（决定下游对接段的 X 宽度与联锁说明），mm；缺省按带宽推 */
  transferPartLengthMm?: number;
  /** 板材沿 Y 的宽度（决定移载行程），mm；缺省按带宽推 */
  transferPartWidthMm?: number;
  /**
   * 板材厚度（工件占位体的 Z 尺寸），mm；缺省 35。
   *
   * 这个参数唯一的用途是**把工件本身建进几何**：干涉检查要能回答「板能不能从出料口推出去」，
   * 就必须有一个和板同尺寸的实体参与碰撞。给它一个显式参数（而不是写死 35）是为了让「板加厚会不会顶到
   * 接料段挡边/挡停」这类问题能被数值验证（这一版把板抬到 915 后才送出去，挡边顶 911 只留 4 mm，
   * 板越厚越要先看竖向账），而不是靠人看图猜。
   */
  transferPartThicknessMm?: number;
}

/** 归一化之后的参数：层数一定存在，内部构建器只用这个类型。 */
export type ResolvedConveyorParams = ConveyorParams & {
  layers: number;
  layerPitchMm: number;
  turnerAngleDeg: number;
  transferPresent: boolean;
};

export const DEFAULT_CONVEYOR: Required<ConveyorParams> = {
  lengthMm: 2000,
  widthMm: 300,
  beltHeightMm: 850,
  pulleyDiameterMm: 50,
  beltThicknessMm: 4,
  frameSectionMm: 40,
  layers: 1,
  layerPitchMm: 400,
  turnerAngleDeg: 0,
  transferPresent: false,
  transferPartLengthMm: 0,
  transferPartWidthMm: 0,
  transferPartThicknessMm: 35
};

export interface ConveyorPart {
  id: string;
  name: string;
  material: ConveyorMaterial;
  /** 特征树（交给内核逐条执行，布尔求和） */
  features: FeatureNode[];
  transform: InstanceTransform;
  /** 只用于 BOM 分组的规格文字 */
  spec: string;
  /**
   * BOM 质量覆盖（kg/件）。代理实体是实心的，对电机、滚筒这类空心件会显著偏重，
   * 这里用样本值覆盖，几何仍然由内核真实生成。
   */
  massOverrideKg?: number;
  /**
   * 这件属于哪个机构的动作/归属（`transfer-lift` / `transfer-push` …）。
   *
   * 只做归属标注，不参与运动学：真正的随动件清单由 machine-geometry 的
   * `conveyorMovingAxes` 按件号规则给出（一处定义，避免两套各说一套）。
   * 作用是把「这台件为什么在这儿、跟哪条轴有关」留在零件表里，BOM/排错能对上。
   */
  actuatorId?: string;
}

function feature(id: string, type: FeatureNode['type'], name: string, params: Record<string, unknown>): FeatureNode {
  return { id, type, name, params };
}

function box(id: string, name: string, length: number, width: number, height: number): FeatureNode {
  return feature(id, 'box', name, { length, width, height });
}

function cylinder(id: string, name: string, diameter: number, height: number, axis: 'x' | 'y' | 'z', at: [number, number, number] = [0, 0, 0]): FeatureNode {
  return feature(id, 'cylinder', name, { diameter, height, axis, at });
}

/**
 * 生成整机零件表。几何关系：
 * - 滚筒中心 z = 皮带面高 - 滚筒半径
 * - 侧梁中心 z = 滚筒中心 z - (frameSection/2 + 10)  ← 留出皮带绕包空间
 * - 支腿从地面顶到侧梁下沿
 * - 有转向工位时：输送面拆成 6 条窄带（整条连续），回程只在单元处让开 900 mm，
 *   单元件（底座框架/下沉框架/台板/回转支承/转台盘/支撑指）装在带面以下，只有支撑指穿带缝
 */
export function buildConveyorParts(params: ConveyorParams): ConveyorPart[] {
  const p = normalizeParams(params);
  const parts = buildSingleLayerParts(p);
  // 立体缓存：底层还是输送线（进出料），上方按层数叠托架 + 一套升降机构
  return p.layers > 1 ? [...parts, ...buildBufferStackParts(p)] : parts;
}

/* ------------------------------------------------------------------ *
 * 转向工位：顶升 — 旋转 — 回落（顶升旋转单元）
 *
 * 上一版把转向做成「固定转台 + 皮带整段断开」：台面与皮带面齐平、直径必须 ≥ 带宽，
 * 皮带、回程、挡边全部在 |x| ≤ 706 断开。结果是机台在转向处被切成两段，还要两套张紧
 * 与两套驱动，现场反馈「机台太长」。这一版按真机做法改成顶升旋转单元：
 *
 * 1) 输送面不再是单条宽带，而是 N 条窄带并联（默认 6 × 80 mm，带间间隙 120 mm）。
 *    窄带在单元处**保持连续**：工件不离开输送面，进料 / 转向 / 出料是同一条带面，
 *    这是连续流的前提，也是机台能缩短的根本原因（不必再分两段各自张紧、各自驱动）。
 * 2) 顶升时穿过带面的是**支撑指**（φ20 立柱 + 70×70 指垫），指宽 70 < 带间间隙 120，
 *    两侧各留 25 mm 让位；立柱落位取带缝中心（y = 0、±200、±400），顶升与回落全程
 *    只走带缝，不碰带体。验收要求在**静止态与顶升到位两种状态**下都零干涉。
 * 3) 回转台盘、回转支承、升降台板全部**待在带面以下**：抬升 60 mm 后，台盘顶
 *    = beltFace − 76 + 60 = 834 < 带底 846，所以「会转的东西」根本不穿过带面，
 *    只有细立柱与指垫穿缝。这也解释了为什么台面直径（φ880）可以比带宽小很多。
 * 4) 指位必须**4 折对称**（十字花盘：0/±200/±400 两轴）：工件转 90° 后要落回同一条
 *    带面，整条纵向长指转过 90° 会横跨带体、回落时必撞带——这是几何硬约束。所以取
 *    老王给的两个选项里的第二个「环形支撑垫」+ 短指：9 个垫托住板心，光伏板长边
 *    悬出 1000、宽边悬出 160（真机同样用小台面 + 真空吸盘，靠板件自身刚性）。
 *
 * 竖向账（beltFace = 850、带厚 4、滚筒 φ50 → railTop 800）：
 *   静止位：指垫顶 845（低于带面 5 mm，工件完全压在带上）→ 台盘 774..784 →
 *           回转支承 756..774 → 台板 740..756 → 活塞杆顶 740 → 缸体 660..716 →
 *           下沉框架底盘 648..660；底座框架坐在两侧纵梁上 800..812。
 *   顶升 60：指垫顶 905，工件底面从 850 抬到 905（离带 55 mm）；台盘顶 844 < 带底 846。
 *   行程 60 的依据：> 带厚 4 + 工件（光伏板 35 mm）厚度一半 17.5，并留 38 mm 余量
 *           吸收带面下垂与工件翘曲；真机顶升单元行程一般取 50~80 mm。
 * ------------------------------------------------------------------ */

/** 窄带并联：单条带宽 80、带间间隙 ≥ 100、最多 6 条 */
const NARROW_BELT_WIDTH_MM = 80;
const NARROW_BELT_GAP_MIN_MM = 100;
const NARROW_BELT_MAX_COUNT = 6;
/** 顶升单元沿 X 的占位半宽：皮带不再断开，这只是单元的轮廓（900 mm） */
const TURNER_UNIT_HALF_MM = 450;
/** 顶升行程（mm）：见上方竖向账 */
const TURNER_LIFT_STROKE_MM = 60;
/** 支撑指：指宽 70 < 带间间隙 120（两侧各 25 让位） */
const TURNER_FINGER_WIDTH_MM = 70;
const TURNER_FINGER_POST_MM = 20;
const TURNER_FINGER_POST_LENGTH_MM = 55;
const TURNER_FINGER_PAD_THICKNESS_MM = 6;
/** 指垫顶比皮带面低 5 mm：静止时指不接触工件 */
const TURNER_PAD_DROP_MM = 5;
/** 转台盘 / 回转支承 / 升降台板的厚度（全部待在带面以下） */
const TURNER_TABLE_THICKNESS_MM = 10;
const TURNER_RING_HEIGHT_MM = 18;
const TURNER_PLATE_THICKNESS_MM = 12;
/** 顶升气缸缸体长度（缸体 + 活塞杆 = 竖直直线轴） */
const TURNER_CYL_BODY_MM = 56;
/** 活塞杆露出段（缩回位） */
const TURNER_CYL_ROD_EXPOSED_MM = 24;
/** 下沉框架底盘厚度 */
const TURNER_FRAME_BASE_THICKNESS_MM = 12;
/** 底座框架（坐在两侧纵梁上）的型材高度 */
const TURNER_BEAM_HEIGHT_MM = 12;
/** 升降台板边长 / 导向柱中心距的一半 */
/** 台板：X 向 900（= 单元占位，回程带缺口比它再宽 10 mm），Y 向 960（回程带只沿 X 走，
 *  Y 向放宽不挡带，只是给导向柱留安装位） */
const TURNER_PLATE_LENGTH_MM = 900;
const TURNER_PLATE_WIDTH_MM = 960;
/** 吊柱截面边长（20×20）与吊柱到台板边缘的最小装配缝 */
const TURNER_HANGER_SIZE_MM = 20;
const TURNER_HANGER_PLATE_GAP_MM = 5;
/** 纵梁内侧面到带宽边缘的让位（与 buildSingleLayerParts 的 outerY 同一口径：带宽/2 + 15） */
const RAIL_INNER_OFFSET_MM = 15;

/**
 * 顶升旋转单元的**横向尺寸护栏**：单元件最占位的不是转台盘，而是「台板 + 两侧吊柱」。
 *
 * 横向占位账（y 向，从中心线往外）：
 *   台板半宽 480 + 吊柱 20 + 吊柱/台板缝 5 = 505 = 吊柱外侧面
 *   吊柱外侧面就贴在纵梁内侧面上（纵梁内侧面 = 带宽/2 + 15）
 *   → 带宽/2 + 15 ≥ 505 → 带宽 ≥ 980。
 * 转台盘 φ880 的账更松：440 + 40 侧隙 ≤ 带宽/2 + 15 → 带宽 ≥ 930。
 *
 * 以前只查「带缝放得下 2 条窄带」（≥ 360），400 mm 宽的线体照样生成 φ880 转台盘：
 * 盘缘切进纵梁 352000 mm³/侧（aabb）、顶升后盘与台板横向扫过纵梁与底座框架，
 * 吊柱整根穿在台板行程里（4800 mm³ ×4，exact）。盘/台板尺寸是机构定死的，
 * 因此带宽不足时**拒建并给出可执行理由**，不做「悄悄缩盘出图」。
 */
export const TURNER_TABLE_DIAMETER_MM = 2 * TURNER_UNIT_HALF_MM - 20; // 880
export const TURNER_TABLE_SIDE_CLEARANCE_MM = 40;
export const TURNER_UNIT_HALF_WIDTH_MM = TURNER_PLATE_WIDTH_MM / 2 + TURNER_HANGER_SIZE_MM + TURNER_HANGER_PLATE_GAP_MM; // 505
export const TURNER_MIN_WIDTH_MM = 2 * (TURNER_UNIT_HALF_WIDTH_MM - RAIL_INNER_OFFSET_MM); // 980
/** 导向柱中心（x, y）：y 必须落在带缝里（±200），x 取 425 让柱心到轴线 470 > 台盘半径 440、
 *  柱的包围盒（414..436）也不压进台盘包围盒（±440）——否则 AABB 初筛会把「柱在盘外」误报成干涉 */
const TURNER_GUIDE_X_MM = 425;
const TURNER_GUIDE_Y_MM = 465;

export interface NarrowBeltLayout {
  /** 窄带条数（1 = 普通单条宽带） */
  count: number;
  widthMm: number;
  pitchMm: number;
  /** 带间间隙（count = 1 时为 0） */
  gapMm: number;
  /** 各条窄带的中心 y */
  centers: number[];
  /** 带缝中心 y（顶升指的落位；count = 1 时为空） */
  gaps: number[];
}

/**
 * 窄带并联布局。
 *
 * 为什么按带宽反算条数而不是固定 6 条：300 mm 宽的普通线体塞 6 条 80 窄带只剩
 * −30 mm 间隙，必须退回单条。条数取 floor((带宽 + 100) / (80 + 100)) 再逐条回退，
 * 保证带缝 ≥ 100 且条数为偶数（4 折对称指位要求轴线上是缝，见下方）：1200 宽正好
 * 6 条（pitch 200、缝隙 120），600 宽退到 2 条（pitch 300、缝隙 220），300 宽退回
 * 1 条（2 条只剩 70 mm 缝，顶升指塞不进去），与真机惯例一致。
 */
export function narrowBeltLayout(params: ConveyorParams): NarrowBeltLayout {
  const p = normalizeParams(params);
  const pitchUnit = NARROW_BELT_WIDTH_MM + NARROW_BELT_GAP_MIN_MM;
  // 条数按「带 + 缝」等分反算：n 条只需要 n×80 + (n−1)×100 宽，所以是 (宽 + 缝) / 单元
  let count = Math.min(NARROW_BELT_MAX_COUNT, Math.floor((p.widthMm + NARROW_BELT_GAP_MIN_MM) / pitchUnit));
  count = Math.max(1, count);
  // 条数取整后带缝可能被压到 100 mm 以下（如 300 mm 宽 → 2 条只剩 70 mm 缝），逐条回退
  while (count > 1 && p.widthMm / count - NARROW_BELT_WIDTH_MM < NARROW_BELT_GAP_MIN_MM) count -= 1;
  // 条数一律取偶数：顶升指必须 4 折对称（转 90° 后落回同一组带缝），这就要求
  // **轴线上是带缝而不是带**。奇数条的等节距排布是关于某一条带对称的，轴线上正好是带，
  // 无论指怎么摆，转 90° 后总有一半落在带上（实测 980 mm 宽 5 条带：中间那条带被
  // 5 只指垫压住 19600 mm³ ×5）。宁可少一条窄带，也不出「转 90° 就撞带」的工位。
  if (count > 1 && count % 2 === 1) count -= 1;
  if (count <= 1) {
    return { count: 1, widthMm: p.widthMm, pitchMm: p.widthMm, gapMm: 0, centers: [0], gaps: [] };
  }
  const pitch = p.widthMm / count;
  const centers = Array.from({ length: count }, (_unused, index) => -p.widthMm / 2 + pitch * (index + 0.5));
  const gaps = Array.from({ length: count - 1 }, (_unused, index) => centers[index]! + pitch / 2);
  return { count, widthMm: NARROW_BELT_WIDTH_MM, pitchMm: pitch, gapMm: pitch - NARROW_BELT_WIDTH_MM, centers, gaps };
}

export interface TurnerLayout {
  angleDeg: number;
  /** 顶升行程（mm） */
  strokeMm: number;
  /** 单元沿 X 的占位半宽 */
  unitHalfMm: number;
  /** 窄带并联（皮带不断开，靠带缝给顶升指让位） */
  beltCount: number;
  beltWidthMm: number;
  beltGapMm: number;
  beltPitchMm: number;
  beltCenterYs: number[];
  /** 顶升支撑指：指宽 / 指位（4 折对称，全部落在带缝里） */
  fingerWidthMm: number;
  fingerCenters: Array<[number, number]>;
  /** 底座框架（坐在两侧纵梁上）：长度 / 截面 / 中心 y / 中心 z */
  beamLengthMm: number;
  beamWidthMm: number;
  beamThicknessMm: number;
  beamCenterY: number;
  beamCenterZ: number;
  /** 下沉框架：吊柱高度与中心 z、底盘尺寸与位置 */
  hangerHeightMm: number;
  hangerCenterZ: number;
  hangerCenterY: number;
  hangerOffsetX: number;
  frameBaseLengthMm: number;
  frameBaseWidthMm: number;
  frameBaseCenterX: number;
  frameBaseCenterZ: number;
  /** 顶升气缸：缸体 / 活塞杆 / 杆顶 z */
  cylBodyDiameterMm: number;
  cylBodyCenterZ: number;
  cylRodDiameterMm: number;
  cylRodTopZ: number;
  /** 导向柱 */
  guideDiameterMm: number;
  guideCenters: Array<[number, number]>;
  guideBottomZ: number;
  guideTopZ: number;
  /** 升降台板 */
  plateLengthMm: number;
  plateWidthMm: number;
  plateThicknessMm: number;
  plateCenterZ: number;
  /** 回转支承（薄壁环） */
  ringDiameterMm: number;
  ringBoreMm: number;
  ringHeightMm: number;
  ringCenterZ: number;
  /** 转台盘 */
  tableDiameterMm: number;
  tableThicknessMm: number;
  tableCenterZ: number;
  /** 支撑指：立柱中心 z / 指垫中心 z（静止位） */
  fingerPostCenterZ: number;
  fingerPadCenterZ: number;
  /** 指垫顶（静止位）：必须低于皮带面 */
  padTopZ: number;
  /** 顶升到位时的指垫顶 = padTopZ + strokeMm */
  padTopLiftZ: number;
  /** 转向减速电机（挂在下沉框架上，不随台板升降） */
  motorCenter: [number, number, number];
  /** 顶升 + 回落总时长（两趟气缸动作都计入工位时间） */
  liftSeconds: number;
  /** 旋转分度时长 */
  rotateSeconds: number;
  /** 一次完整动作：顶升 + 旋转 + 回落 */
  actionSeconds: number;
}

/** 旋转分度时间：0.6 s 起停 + 每 90° 1.2 s（90° → 1.8 s、45° → 1.2 s、180° → 3.0 s）。 */
export function turnerRotateSeconds(angleDeg: number): number {
  const angle = Math.abs(angleDeg);
  if (!Number.isFinite(angle) || angle <= 0) return 0;
  return Math.round((0.6 + (angle / 90) * 1.2) * 10) / 10;
}

/**
 * 顶升 + 回落两趟的时间：单趟 0.4 s 起停 + 行程按 100 mm/s（60 mm → 0.6 s），
 * 一次顶升旋转要举升一次、回落一次，所以 ×2 全部计入工位时间。
 */
export function turnerLiftSeconds(strokeMm: number): number {
  if (!Number.isFinite(strokeMm) || strokeMm <= 0) return 0;
  return Math.round((0.4 + strokeMm / 100) * 2 * 10) / 10;
}

/**
 * 一次转向的动作时间（s）= 顶升 + 旋转 + 回落。
 * 节拍仍按 60 / 该时长 封顶（见 synth.ts 的 applyConveyorRefinement）。
 */
export function turnerActionSeconds(angleDeg: number, strokeMm: number = TURNER_LIFT_STROKE_MM): number {
  const total = turnerLiftSeconds(strokeMm) + turnerRotateSeconds(angleDeg);
  return Math.round(total * 10) / 10;
}

/**
 * 为什么不能做转向工位；能做的返回 null。
 * 六种情形：没要求、立体缓存、线体太短、带宽放不下窄带、带宽小于台盘所需最小宽、
 *            机架太矮。
 */
export function turnerSkipReason(params: ConveyorParams): string | null {
  const p = normalizeParams(params);
  if (!(p.turnerAngleDeg > 0)) return null;
  if (p.layers > 1) {
    return `立体缓存（${p.layers} 层）不加转向工位：转向机构与升降机构都要占线体中段，空间互斥；转向需单独做一段转向线体`;
  }
  if (p.lengthMm - 2 * TURNER_UNIT_HALF_MM < 600) {
    return `线体长 ${p.lengthMm} mm 放不下顶升单元：单元占 X 向 2×${TURNER_UNIT_HALF_MM} = ${2 * TURNER_UNIT_HALF_MM} mm，两端还要各留 300 mm 输送段`;
  }
  const belts = narrowBeltLayout(p);
  if (belts.count < 2) {
    // 等节距布置下 gap = 带宽/条数 − 带宽，所以 2 条带至少 2×(80+100) = 360 mm
    return `带宽 ${p.widthMm} mm 放不下窄带并联：顶升指要从带缝穿上来，至少 2 条 ${NARROW_BELT_WIDTH_MM} mm 窄带 + ${NARROW_BELT_GAP_MIN_MM} mm 带缝（等节距，带宽 ≥ ${2 * (NARROW_BELT_WIDTH_MM + NARROW_BELT_GAP_MIN_MM)} mm）`;
  }
  // 横向护栏：转台盘 φ880 / 台板 960 + 两侧吊柱要在两侧纵梁之间落下（以前只查带缝、
  // 不查横向尺寸，400 mm 宽的线体照样生成 φ880 转台盘 → 盘缘切进纵梁 352000 mm³/侧，
  // 顶升后盘与台板横向扫过纵梁与底座框架，吊柱整根穿在台板里 4800 mm³×4）。
  if (p.widthMm < TURNER_MIN_WIDTH_MM) {
    return `带宽 ${p.widthMm} mm < 转向工位所需最小 ${TURNER_MIN_WIDTH_MM} mm：顶升单元横向占「台板 ${TURNER_PLATE_WIDTH_MM} + 两侧吊柱各 ${TURNER_HANGER_SIZE_MM}」`
      + `＝ ${TURNER_PLATE_WIDTH_MM + 2 * TURNER_HANGER_SIZE_MM} mm，吊柱外侧面贴纵梁内侧面（带宽/2 + ${RAIL_INNER_OFFSET_MM}）、吊柱与台板间留 ${TURNER_HANGER_PLATE_GAP_MM} mm，`
      + `故带宽 ≥ ${TURNER_PLATE_WIDTH_MM} + 2×${TURNER_HANGER_SIZE_MM} + 2×${TURNER_HANGER_PLATE_GAP_MM} − 2×${RAIL_INNER_OFFSET_MM} = ${TURNER_MIN_WIDTH_MM} mm`
      + `（转台盘 φ${TURNER_TABLE_DIAMETER_MM} + 两侧各 ${TURNER_TABLE_SIDE_CLEARANCE_MM} mm 侧隙只要 ${TURNER_TABLE_DIAMETER_MM + 2 * TURNER_TABLE_SIDE_CLEARANCE_MM} mm，不是控制项）；`
      + `请把线体加宽到 ≥ ${TURNER_MIN_WIDTH_MM} mm，或改用「台板 ≤ ${p.widthMm - 2 * (TURNER_HANGER_SIZE_MM + TURNER_HANGER_PLATE_GAP_MM - RAIL_INNER_OFFSET_MM)} mm」的窄型转台`;
  }
  const railTop = p.beltHeightMm - p.pulleyDiameterMm;
  const frameBaseTop = p.beltHeightMm - 186;
  if (railTop - frameBaseTop < 20) {
    return `滚筒 φ${p.pulleyDiameterMm} mm 太大：纵梁顶 ${railTop} mm 与下沉框架顶 ${frameBaseTop} mm 之间不足 20 mm，顶升降不下来`;
  }
  if (frameBaseTop - TURNER_FRAME_BASE_THICKNESS_MM < 60) {
    return `皮带面 ${p.beltHeightMm} mm 太低：顶升单元底盘落到 ${frameBaseTop - TURNER_FRAME_BASE_THICKNESS_MM} mm，离地不足 60 mm`;
  }
  return null;
}

/** 转向工位的全部尺寸；不需要/做不了时返回 null。 */
export function turnerLayout(params: ConveyorParams): TurnerLayout | null {
  const p = normalizeParams(params);
  if (!(p.turnerAngleDeg > 0)) return null;
  if (turnerSkipReason(p) !== null) return null;
  const angle = p.turnerAngleDeg;
  const belts = narrowBeltLayout(p);
  const railTop = p.beltHeightMm - p.pulleyDiameterMm;
  const railCenterY = p.widthMm / 2 + p.frameSectionMm / 2 + 15;
  const railInnerY = railCenterY - p.frameSectionMm / 2;

  // 竖向叠层：从带面向下反推（带面是硬基准，滚筒直径只决定纵梁位置）
  const padTopZ = p.beltHeightMm - TURNER_PAD_DROP_MM; // 845
  const padBottomZ = padTopZ - TURNER_FINGER_PAD_THICKNESS_MM; // 839
  const tableTopZ = padBottomZ - TURNER_FINGER_POST_LENGTH_MM; // 784
  const tableBottomZ = tableTopZ - TURNER_TABLE_THICKNESS_MM; // 774
  const ringTopZ = tableBottomZ; // 774
  const ringBottomZ = ringTopZ - TURNER_RING_HEIGHT_MM; // 756
  const plateTopZ = ringBottomZ; // 756
  const plateBottomZ = plateTopZ - TURNER_PLATE_THICKNESS_MM; // 740
  const rodTopZ = plateBottomZ; // 740
  const cylBodyTopZ = rodTopZ - TURNER_CYL_ROD_EXPOSED_MM; // 716
  const frameBaseTopZ = cylBodyTopZ - TURNER_CYL_BODY_MM; // 660
  const frameBaseBottomZ = frameBaseTopZ - TURNER_FRAME_BASE_THICKNESS_MM; // 648

  // 指位：每条带缝给一对（横 / 纵），加中心一只 → 4 折对称（转 90° 后落点仍是这组带缝）
  //
  // 去重键按**最终坐标**取整（transform 只保留 2 位小数）：带缝中心是「带宽/条数」算出来的，
  // 例如 1100 mm 宽 6 条时节距 183.333…，从两侧反算同一只指会得到 183.333…43 与
  // 183.333…31 —— 不取整就会被当成两个指位，同一位置叠两只指（实测互相压 244652 mm³，
  // 台板上的指垫凭空多出一倍）。
  const fingerCenters: Array<[number, number]> = [[0, 0]];
  const fingerKey = (x: number, y: number): string => `${round(x)},${round(y)}`;
  const seenFinger = new Set([fingerKey(0, 0)]);
  for (const gapY of belts.gaps) {
    const snapped = round(gapY);
    if (Math.abs(snapped) < 1e-6) continue;
    for (const pair of [[0, snapped], [-snapped, 0], [snapped, 0]] as Array<[number, number]>) {
      const key = fingerKey(pair[0], pair[1]);
      if (seenFinger.has(key)) continue;
      seenFinger.add(key);
      fingerCenters.push([pair[0], pair[1]]);
    }
  }

  // 转向电机的 Y 位：输出轴要**从带缝里穿上来**顶到转台盘（窄带并联本来就是为了给
  // 穿带件让位）。写死 y=0 只在「带缝正好在轴线」时成立：6 条窄带时缝在 0（120 宽），
  // 5 条窄带（如 980 mm 宽）时带中心在 0、缝在 ±98，电机箱骑在中间那条带上 →
  // 实测 turner-motor × belt-return-3-out 28800 mm³（90 × 80 × 4）。
  // 所以取「离轴线最近、且整箱落得下」的那条带缝；箱体 Y 向 90 mm
  //（窄带并联保证带缝 ≥ 100，90 + 两侧各 5 mm 一定能塞进去）。
  const motorHalfWidthMm = 45;
  const gapHalfMm = (belts.pitchMm - NARROW_BELT_WIDTH_MM) / 2;
  const motorGapY = gapHalfMm >= motorHalfWidthMm + 5
    ? belts.gaps.reduce<number>((best, gap) => (Math.abs(gap) < Math.abs(best) ? gap : best), belts.gaps[0] ?? 0)
    : 0;

  return {
    angleDeg: angle,
    strokeMm: TURNER_LIFT_STROKE_MM,
    unitHalfMm: TURNER_UNIT_HALF_MM,
    beltCount: belts.count,
    beltWidthMm: belts.widthMm,
    beltGapMm: belts.gapMm,
    beltPitchMm: belts.pitchMm,
    beltCenterYs: belts.centers,
    fingerWidthMm: Math.min(TURNER_FINGER_WIDTH_MM, belts.gapMm - 40),
    fingerCenters,
    beamLengthMm: 2 * TURNER_UNIT_HALF_MM,
    beamWidthMm: p.frameSectionMm,
    beamThicknessMm: TURNER_BEAM_HEIGHT_MM,
    beamCenterY: railCenterY,
    beamCenterZ: railTop + TURNER_BEAM_HEIGHT_MM / 2,
    hangerHeightMm: railTop - frameBaseTopZ,
    hangerCenterZ: (railTop + frameBaseTopZ) / 2,
    hangerCenterY: Math.max(
      railInnerY - 10,
      TURNER_PLATE_WIDTH_MM / 2 + TURNER_HANGER_SIZE_MM / 2 + TURNER_HANGER_PLATE_GAP_MM
    ),
    hangerOffsetX: 430,
    frameBaseLengthMm: 2 * TURNER_UNIT_HALF_MM + 230, // 向 +X 多伸 230：外挂转向电机坐在上面
    frameBaseWidthMm: 2 * (railInnerY - 10),
    frameBaseCenterX: 115,
    frameBaseCenterZ: frameBaseBottomZ + TURNER_FRAME_BASE_THICKNESS_MM / 2,
    cylBodyDiameterMm: 80,
    cylBodyCenterZ: (frameBaseTopZ + cylBodyTopZ) / 2,
    cylRodDiameterMm: 30,
    cylRodTopZ: rodTopZ,
    guideDiameterMm: 22,
    guideCenters: [
      [-TURNER_GUIDE_X_MM, -TURNER_GUIDE_Y_MM],
      [TURNER_GUIDE_X_MM, -TURNER_GUIDE_Y_MM],
      [-TURNER_GUIDE_X_MM, TURNER_GUIDE_Y_MM],
      [TURNER_GUIDE_X_MM, TURNER_GUIDE_Y_MM]
    ],
    guideBottomZ: frameBaseTopZ,
    // 柱顶 = 台板顶 + 行程：台板升到顶时仍有一整段导向配合，不脱出
    guideTopZ: plateTopZ + TURNER_LIFT_STROKE_MM,
    plateLengthMm: TURNER_PLATE_LENGTH_MM,
    plateWidthMm: TURNER_PLATE_WIDTH_MM,
    plateThicknessMm: TURNER_PLATE_THICKNESS_MM,
    plateCenterZ: plateBottomZ + TURNER_PLATE_THICKNESS_MM / 2,
    ringDiameterMm: 400,
    ringBoreMm: 280,
    ringHeightMm: TURNER_RING_HEIGHT_MM,
    ringCenterZ: ringBottomZ + TURNER_RING_HEIGHT_MM / 2,
    tableDiameterMm: TURNER_TABLE_DIAMETER_MM, // 880：留在单元轮廓内，仍在带面以下
    tableThicknessMm: TURNER_TABLE_THICKNESS_MM,
    tableCenterZ: tableBottomZ + TURNER_TABLE_THICKNESS_MM / 2,
    fingerPostCenterZ: (tableTopZ + padBottomZ) / 2,
    fingerPadCenterZ: padTopZ - TURNER_FINGER_PAD_THICKNESS_MM / 2,
    padTopZ,
    padTopLiftZ: padTopZ + TURNER_LIFT_STROKE_MM,
    // 电机挂在下沉框架上（不随台板升，跟着升起会顶到工件），竖直输出轴从带缝里伸上去
    motorCenter: [TURNER_UNIT_HALF_MM + 150, motorGapY, frameBaseTopZ + 60], // 电机坐在底盘上（底面贴 664）
    liftSeconds: turnerLiftSeconds(TURNER_LIFT_STROKE_MM),
    rotateSeconds: turnerRotateSeconds(angle),
    actionSeconds: turnerActionSeconds(angle)
  };
}

/**
 * 顶升旋转单元的零件：底座框架 / 吊柱 / 下沉底盘 / 顶升气缸 / 导向柱 /
 * 升降台板 / 回转支承 / 转台盘 / 支撑指 / 转向电机。
 *
 * 为什么台板不是整块大板、指也不是整条长指：见文件顶部第 2、4 条——穿过带面的
 * 只能是「细的、落在带缝里的」东西；台板与转台盘都在带面以下，做多大都不碰带。
 */
function buildTurnerParts(t: TurnerLayout): ConveyorPart[] {
  const parts: ConveyorPart[] = [];

  // 1) 底座框架：两根纵向梁，坐在两侧纵梁上沿。一根一个零件——特征树里 box 只能居中，
  //    两根梁必须分成两个零件，否则会被当成一块整板压在回程带与顶升指上方
  for (const [label, sign] of [['left', -1], ['right', 1]] as const) {
    parts.push({
      id: `turner-base-${label}`,
      name: `转向工位底座框架（${label === 'left' ? '操作侧' : '驱动侧'}）`,
      material: 'AL6063',
      spec: `${t.beamLengthMm} × ${t.beamWidthMm} × ${t.beamThicknessMm}`,
      features: [box(`turner-base-${label}-body`, '底座梁', t.beamLengthMm, t.beamWidthMm, t.beamThicknessMm)],
      transform: { x: 0, y: round(sign * t.beamCenterY), z: round(t.beamCenterZ), rz: 0 }
    });
  }

  // 2) 下沉框架：4 根吊柱吊在纵梁内侧 + 一块底盘（气缸、导向柱、电机都坐在底盘上）
  for (const [index, x] of [-t.hangerOffsetX, t.hangerOffsetX].entries()) {
    for (const [sub, sign] of [[1, -1], [2, 1]] as const) {
      const id = `turner-hanger-${index * 2 + sub}`;
      parts.push({
        id,
        name: `下沉框架吊柱 ${index * 2 + sub}`,
        material: 'Q235',
        spec: `${TURNER_HANGER_SIZE_MM}×${TURNER_HANGER_SIZE_MM} × ${Math.round(t.hangerHeightMm)}`,
        features: [box(`${id}-body`, '吊柱', TURNER_HANGER_SIZE_MM, TURNER_HANGER_SIZE_MM, t.hangerHeightMm)],
        transform: { x: round(x), y: round(sign * t.hangerCenterY), z: round(t.hangerCenterZ), rz: 0 }
      });
    }
  }
  parts.push({
    id: 'turner-lift-frame',
    name: '顶升下沉框架底盘',
    material: 'Q235',
    spec: `${Math.round(t.frameBaseLengthMm)} × ${Math.round(t.frameBaseWidthMm)} × ${TURNER_FRAME_BASE_THICKNESS_MM}`,
    features: [
      box('turner-lift-frame-body', '底盘', t.frameBaseLengthMm, t.frameBaseWidthMm, TURNER_FRAME_BASE_THICKNESS_MM)
    ],
    transform: { x: round(t.frameBaseCenterX), y: 0, z: round(t.frameBaseCenterZ), rz: 0 }
  });

  // 3) 顶升气缸 ×2：缸体 + 活塞杆（竖直，杆顶顶住升降台板底面）
  for (const [index, x] of [-200, 200].entries()) {
    const bodyBottomZ = t.cylBodyCenterZ - TURNER_CYL_BODY_MM / 2;
    const rodBottomZ = bodyBottomZ + TURNER_CYL_BODY_MM / 2; // 杆从缸体中段起算（同一零件求和）
    const rodHeight = t.cylRodTopZ - rodBottomZ;
    parts.push({
      id: `turner-lift-cyl-${index + 1}`,
      name: `顶升气缸 ${index + 1}`,
      material: 'Q235',
      spec: `φ${t.cylBodyDiameterMm} × ${TURNER_CYL_BODY_MM}，行程 ${t.strokeMm}`,
      massOverrideKg: 4.2,
      features: [
        cylinder(`turner-lift-cyl-${index + 1}-body`, '缸体', t.cylBodyDiameterMm, TURNER_CYL_BODY_MM, 'z'),
        cylinder(
          `turner-lift-cyl-${index + 1}-rod`,
          '活塞杆',
          t.cylRodDiameterMm,
          round(rodHeight),
          'z',
          [0, 0, round((rodBottomZ + t.cylRodTopZ) / 2 - t.cylBodyCenterZ)]
        )
      ],
      transform: { x, y: 0, z: round(t.cylBodyCenterZ), rz: 0 }
    });
  }

  // 4) 导向柱 ×4：从底盘顶到台板顶（台板在柱上滑动，台板开 φ26 过孔）
  t.guideCenters.forEach(([x, y], index) => {
    const height = t.guideTopZ - t.guideBottomZ;
    parts.push({
      id: `turner-guide-post-${index + 1}`,
      name: `升降导向柱 ${index + 1}`,
      material: 'STEEL45',
      spec: `φ${t.guideDiameterMm} × ${Math.round(height)}`,
      massOverrideKg: 0.9,
      features: [cylinder(`turner-guide-post-${index + 1}-body`, '导向柱', t.guideDiameterMm, height, 'z')],
      transform: { x: round(x), y: round(y), z: round((t.guideBottomZ + t.guideTopZ) / 2), rz: 0 }
    });
  });

  // 5) 升降台板：方形台板，四角开导向过孔；全程在带面以下升降
  parts.push({
    id: 'turner-lift-plate',
    name: '升降台板',
    material: 'AL6063',
    spec: `${t.plateLengthMm} × ${t.plateWidthMm} × ${t.plateThicknessMm}，行程 ${t.strokeMm}`,
    features: [
      box('turner-lift-plate-body', '台板', t.plateLengthMm, t.plateWidthMm, t.plateThicknessMm),
      feature('turner-lift-plate-holes', 'holes', '导向柱过孔', {
        diameter: t.guideDiameterMm + 4,
        positions: t.guideCenters
      })
    ],
    transform: { x: 0, y: 0, z: round(t.plateCenterZ), rz: 0 }
  });

  // 6) 回转支承：薄壁环（中孔 φ280），外圈坐在台板上、内圈随转台盘转
  parts.push({
    id: 'turner-ring',
    name: '回转支承环',
    material: 'STEEL45',
    spec: `φ${t.ringDiameterMm}/φ${t.ringBoreMm} × ${t.ringHeightMm}`,
    features: [
      cylinder('turner-ring-body', '回转支承外圈', t.ringDiameterMm, t.ringHeightMm, 'z'),
      feature('turner-ring-bore', 'holes', '内孔', { diameter: t.ringBoreMm, positions: [[0, 0]] })
    ],
    // 实心柱体会把 18 kg 的薄壁环算成 90 kg 的饼，用样本质量覆盖
    massOverrideKg: Math.round((t.ringDiameterMm / 870) ** 2 * 18 * 10) / 10,
    transform: { x: 0, y: 0, z: round(t.ringCenterZ), rz: 0 }
  });

  // 7) 转台盘：φ880 圆盘，中心开过孔让线缆与气缸下来；整个盘在带面以下旋转
  parts.push({
    id: 'turner-table',
    name: '转向转台盘',
    material: 'AL6063',
    spec: `φ${t.tableDiameterMm} × ${t.tableThicknessMm}`,
    features: [
      cylinder('turner-table-body', '转台盘', t.tableDiameterMm, t.tableThicknessMm, 'z'),
      feature('turner-table-bore', 'holes', '中心过孔', { diameter: 160, positions: [[0, 0]] })
    ],
    transform: { x: 0, y: 0, z: round(t.tableCenterZ), rz: 0 }
  });

  // 8) 支撑指 ×9：立柱从带缝升起，指垫在带面下 5 mm 待机；指位 4 折对称
  t.fingerCenters.forEach(([x, y], index) => {
    const postLocalZ = t.fingerPostCenterZ - t.fingerPadCenterZ;
    parts.push({
      id: `turner-finger-${index + 1}`,
      name: `转向支撑指 ${index + 1}`,
      material: 'AL6063',
      spec: `${t.fingerWidthMm}×${t.fingerWidthMm}×${TURNER_FINGER_PAD_THICKNESS_MM} + φ${TURNER_FINGER_POST_MM}×${TURNER_FINGER_POST_LENGTH_MM}`,
      features: [
        cylinder(
          `turner-finger-${index + 1}-post`,
          '指柱',
          TURNER_FINGER_POST_MM,
          TURNER_FINGER_POST_LENGTH_MM,
          'z',
          [0, 0, round(postLocalZ)]
        ),
        box(`turner-finger-${index + 1}-pad`, '指垫', t.fingerWidthMm, t.fingerWidthMm, TURNER_FINGER_PAD_THICKNESS_MM)
      ],
      transform: { x: round(x), y: round(y), z: round(t.fingerPadCenterZ), rz: 0 }
    });
  });

  // 9) 转向减速电机：挂在下沉框架外侧（不随台板升），竖直输出轴从带缝伸到带面下
  parts.push({
    id: 'turner-motor',
    name: '转向减速电机',
    material: 'Q235',
    spec: `0.75 kW · i=180 · 输出约 8 rpm · ${t.angleDeg}°/${t.rotateSeconds}s`,
    massOverrideKg: 6.5,
    features: [
      // 箱体 Y 向 90：要让得开窄带之间的缝（最窄的合法带缝 100 mm，见 turnerLayout 的 motorGapY）
      box('turner-motor-body', '电机+减速箱', 90, 90, 120),
      cylinder('turner-motor-shaft', '输出轴', 22, 60, 'z', [0, 0, 90])
    ],
    transform: {
      x: round(t.motorCenter[0]),
      y: round(t.motorCenter[1]),
      z: round(t.motorCenter[2]),
      rz: 0
    }
  });

  return parts;
}

/* ------------------------------------------------------------------ *
 * 顶升移载（Y 向短带式直角移载 / belt-to-belt right-angle transfer）
 *
 * 构型（老王定的）：X 向 **3 条**窄带 → 带缝里放 **4 段短 Y 向传送带**（每个带缝 2 段）→
 * 板到位后整组 Y 带顶升把板托离 X 带 → Y 短带转动把板送进 +Y 侧下游接料输送机。
 *
 * 与上一版（6 条窄带 + 带缝里的辊道 + 推板 + 无杆气缸）的差别不是换零件，是换原理：
 * 上一版靠推板沿 +Y 推板件，推板/无杆气缸/立柱横梁在机台中段占掉一大片，线长只能做 6 m；
 * 这一版板件由 Y 短带的摩擦力搬走，移载机构整体缩到带面以下，线长缩到 3 m（2400~4000）。
 *
 * 四个硬约束（都是先算过才落下来的）：
 *
 * 1) **X 带上行必须整条连续**，所以能穿过带面的东西只能「落在带缝里且足够窄」。
 *    3 条窄带按节距 = 带宽/3 排（1200 → 100/400/300），Y 段宽 100 < 带缝 300，两侧各留 100。
 * 2) **Y 段的 Y 向长度受带缝宽度限制**：段长 = 带缝 − 2×10 让位（1200 → 280）。
 *    这条不是保守：段长一旦超过带缝，段的两端就伸到 X 带**下方**，顶升 90 mm 的中途
 *    必然扫过带体（带上行 846~850）—— 这是几何硬约束，不是工艺余量。
 *    带宽加大到带缝 ≥ 440 时段长才会自动长到建议值 420（见 transferYBeltLength）。
 * 3) **静止位 Y 带面比 X 带面低 25 mm**：板完全压在 X 带上，Y 带不吃力、不蹭板。
 * 4) **顶升行程由挡边顶反推**：板要从 +Y 侧挡边上方过，板底必须 ≥ 挡边顶 + 4。
 *    板底（静止）= X 带面 850；顶升后板底 = Y 带面（850 − 25）+ 行程
 *    → 行程 = 25 + 1（挡边下沿离带面）+ 60（挡边高）+ 4（间隙）= 90。
 *    （上一版辊面 845 起步 → 70；这一版 Y 带面低 25，行程多 20。）
 *
 * 竖向账（beltFace 850 / 带厚 4 → 带底 846 / X 滚筒 φ50 → 纵梁顶 800）：
 *   静止位：Y 带面 825（= 带面 − 25）→ 带底 821 → 端滚筒 φ20 心 815 → 回程 801..805 →
 *           模块底板 794..802 → 升降架横梁 710..750（横梁顶 = 带底 846 − 净空 6 − 行程 90）
 *           → 活塞杆 596..710 → 缸体 630..686 → 安装板 618..630；
 *           吊柱 630..800 挂纵梁内侧面；导向柱 630..845（柱顶低于带底 1 mm）。
 *   顶升 90：Y 带面 915、板底 915（= 挡边顶 911 + 4）、横梁顶 840 < 846（全程不穿带）；
 *           Y 带面顶升到位后仍**只在带缝里**（X 带、机架都在带缝外），所以 sweep 全程 0 干涉。
 *   下游接料段带面 = 915（与 Y 带出料面同高，落料无落差）。
 *
 * 横向账：Y 段 X 位 = ±节距/2（±200），段宽 100；同步轴沿 X 串起同一带缝的两段（φ20 落在带缝里）；
 *   单元 X 占位半宽 = max(板长/2 + 20, 节距 + 带缝/2 + 40)（1200 板 → 620）。
 *   移载行程（板沿 +Y 的位移）= 板宽/2 + 板心到接料段带面起点（纵梁外侧面 + 5）+ 余量 120
 *   = 400 + 660 + 120 = 1180；下限校验 = 接料段起点 + 板宽/2 = 1060（板尾要整块落到接料段上）。
 * ------------------------------------------------------------------ */

/** 移载线 X 向窄带条数：老王构型 3 条（不是 6 条） */
export const TRANSFER_BELT_COUNT = 3;
/** 单条带宽/节距 = 1/4（1200 → 100），带宽变化按节距算，不写死 */
const TRANSFER_BELT_WIDTH_RATIO = 0.25;
const TRANSFER_BELT_WIDTH_MIN_MM = 60;
const TRANSFER_BELT_WIDTH_MAX_MM = 120;
/** 窄带条数的下限带宽：3 条 60 宽 + 2 条带缝（节距 200） */
export const TRANSFER_MIN_WIDTH_MM = 600;
/** 移载线的线长参数区间（单元 2×unitHalf + 两端输送段，见 transferSkipReason） */
export const TRANSFER_MIN_LENGTH_MM = 2400;
export const TRANSFER_MAX_LENGTH_MM = 4000;
/** 移载线默认线长：6000 → 3000（机台缩短是这一版构型的目的之一） */
export const TRANSFER_DEFAULT_LENGTH_MM = 3000;
/** 单元两端最小输送段 */
export const TRANSFER_END_RUN_MIN_MM = 300;
/** 静止位 Y 带面比 X 带面低多少（不碰板） */
export const TRANSFER_Y_BELT_DROP_MM = 25;
/** 每个带缝放 2 段 Y 带 */
const TRANSFER_Y_SEGMENTS_PER_GAP = 2;
/** Y 段端部到带缝边缘的让位：段长 = 带缝 − 2×10 */
const TRANSFER_Y_SEGMENT_END_CLEAR_MM = 10;
/** Y 段建议长度（带缝够宽时才做得到；1200 带宽的带缝 300 只能做 280） */
const TRANSFER_Y_SEGMENT_MAX_MM = 420;
const TRANSFER_Y_BELT_THICKNESS_MM = 4;
const TRANSFER_Y_PULLEY_DIAMETER_MM = 20;
const TRANSFER_Y_BASE_THICKNESS_MM = 8;
const TRANSFER_Y_CHEEK_THICKNESS_MM = 12;
const TRANSFER_Y_CHEEK_HEIGHT_MM = 22;
/** 模块底板到回程带的让位 */
const TRANSFER_Y_BASE_CLEAR_MM = 3;
/** 升降架横梁 40×40：横梁顶 = 带底 − 净空 − 行程（顶升到位仍低于带底） */
const TRANSFER_LIFT_BEAM_MM = 40;
const TRANSFER_LIFT_CLEAR_MM = 6;
/** 同步轴（沿 X 串起同一带缝的两段 Y 带） */
const TRANSFER_Y_SHAFT_DIAMETER_MM = 20;
/** 顶升气缸 / 安装板 / 吊柱 / 导向柱 */
const TRANSFER_CYL_BODY_MM = 56;
const TRANSFER_CYL_ROD_EXPOSED_MM = 24;
/**
 * 活塞杆缩回位仍插在缸体内的长度。
 *
 * 为什么不是「杆长 = 行程 + 露出」：那样缩回位杆尾会穿过安装板（安装板顶 = 缸体底），
 * 装出来的是一根穿过安装板的杆（实测 8482 mm³ ×2）。真机上杆只在缸体前导套里走，
 * 安装板上没有杆的通道 —— 所以杆尾留在缸体里，顶升到位时杆与缸体之间是**视觉上的拉开**，
 * 与上一版（行程 70 > 缸体 56）同一口径：几何只表达「杆顶跟着升降架走」。
 */
const TRANSFER_CYL_ROD_EMBED_MM = 40;
const TRANSFER_CYL_BODY_DIAMETER_MM = 80;
const TRANSFER_CYL_ROD_DIAMETER_MM = 30;
const TRANSFER_MOUNT_THICKNESS_MM = 12;
const TRANSFER_HANGER_SIZE_MM = 20;
const TRANSFER_GUIDE_DIAMETER_MM = 22;
/** 导向柱顶面到带底的净空（柱顶不穿带面） */
const TRANSFER_GUIDE_TOP_CLEAR_MM = 1;
/** 侧挡边（线体两侧 3 mm 板）：下沿比带面高 1 mm，高 60 → 顶面 = 带面 + 61 */
const SIDE_GUARD_LIFT_MM = 1;
export const SIDE_GUARD_HEIGHT_MM = 60;
/** 板底越过挡边顶的最小间隙（装配 + 带面下垂的可复现余量） */
export const TRANSFER_PLATE_GUARD_CLEAR_MM = 4;
/**
 * 顶升行程：**由挡边顶面反推**。
 *   板底（静止）= 带面
 *   板底（顶升）= Y 带面静止位（带面 − 25）+ 行程
 *   约束：板底 ≥ 挡边顶 + 4 =（带面 + 1 + 60）+ 4
 *   → 行程 ≥ 25 + 1 + 60 + 4 = 90
 * 行程与带面高度无关（挡边顶与 Y 带面都随带面平移），所以 90 是常数。
 */
export const TRANSFER_LIFT_STROKE_MM = TRANSFER_Y_BELT_DROP_MM + SIDE_GUARD_LIFT_MM
  + SIDE_GUARD_HEIGHT_MM + TRANSFER_PLATE_GUARD_CLEAR_MM; // 25 + 1 + 60 + 4 = 90
/** 出料口在 X 向的单边余量：开口总宽 ≥ 板长 + 2×20 = 板长 + 40 */
const TRANSFER_OUTFEED_X_MARGIN_MM = 20;
/** 出料口两侧剩余挡边段的下限：比这短就整段不生成（否则会出现几毫米宽的碎段） */
const TRANSFER_OUTFEED_MIN_SEGMENT_MM = 40;
/** 移载行程余量：板心到接料段带面起点之外再留的装配/落料余量 */
export const TRANSFER_PUSH_MARGIN_MM = 120;
/** 直线轴行程上限：与 validate.ts 的 MAX_ACTUATOR_TRAVEL_MM 同值。
 *  这里不 import validate（它会连带 plcgen，形成循环依赖），超出时由护栏直接拒建。 */
const TRANSFER_MAX_PUSH_STROKE_MM = 2000;
/** 接料段与主线纵梁之间的结构间隙 */
const TRANSFER_DOCK_GAP_MM = 5;
/** 接料段沿 Y 的长度余量（板整块落上去以后还有缓冲段） */
const TRANSFER_DOCK_LENGTH_MARGIN_MM = 100;
/** 接料段 X 向宽度 = 板长 + 200（板横着落上去，宽度要按板长给） */
const TRANSFER_DOCK_WIDTH_MARGIN_MM = 200;
/** 接料段挡边 / 挡停 / 支腿 */
const TRANSFER_DOCK_GUARD_LIFT_MM = 1;
const TRANSFER_DOCK_STOP_HEIGHT_MM = 120;
const TRANSFER_DOCK_LEG_INSET_MM = 120;
/** 板材厚度缺省值（工件占位体 Z 尺寸），mm；可由 transferPartThicknessMm 覆盖 */
export const TRANSFER_DEFAULT_PART_THICKNESS_MM = 35;

export interface TransferYBeltModule {
  /** 1..4 */
  index: number;
  /** 落在第几条带缝（0/1） */
  gapIndex: number;
  /** 模块中心 x（= ±节距/2） */
  xMm: number;
  /** 模块中心 y（= 带缝中心） */
  yMm: number;
}

export interface TransferLayout {
  /** 顶升行程（mm）：25 + 1 + 60 + 4 = 90 */
  strokeMm: number;
  /** 单元沿 X 的占位半宽 */
  unitHalfMm: number;
  /** 单元两端剩余输送段（线长的一半减单元半宽） */
  endRunMm: number;
  /** X 向窄带并联 */
  beltCount: number;
  beltWidthMm: number;
  beltGapMm: number;
  beltPitchMm: number;
  beltCenterYs: number[];
  beltGapCenterYs: number[];
  /** 板材（移载行程、接料段宽度、出料口都从它推） */
  partLengthMm: number;
  partWidthMm: number;
  partThicknessMm: number;
  /** 工件静止位底面 z（= X 带面）：板停在带上，不悬空也不埋进带里 */
  partBottomRestZ: number;
  partTopRestZ: number;
  /** 工件顶升到位底面 z（= Y 带面顶升到位 = 915） */
  partBottomLiftZ: number;
  /** Y 向短带：4 段，每段 100（X）× 280（Y） */
  yBeltCount: number;
  yBeltWidthMm: number;
  yBeltLengthMm: number;
  /** 两端的端滚筒之间那一段带的长度（= 段长 − 2×滚筒直径；带只在这段里，不包进滚筒） */
  yBeltRunMm: number;
  yBeltThicknessMm: number;
  yBeltDropMm: number;
  yBeltFaceRestZ: number;
  yBeltFaceLiftZ: number;
  /** 带缝边缘 → Y 段边缘的让位（= (带缝 − 段长)/2） */
  yBeltClearanceMm: number;
  yPulleyDiameterMm: number;
  yPulleyCenterZ: number;
  yReturnTopZ: number;
  yBaseTopZ: number;
  yBaseBottomZ: number;
  yCheekX: number;
  yCheekHeightMm: number;
  yModules: TransferYBeltModule[];
  ySyncShaftYs: number[];
  ySyncShaftLengthMm: number;
  ySyncShaftZ: number;
  yDriveCenters: Array<[number, number, number]>;
  /** 升降架 */
  liftBeamMm: number;
  beamTopZ: number;
  beamBottomZ: number;
  beamLengthMm: number;
  beamYs: number[];
  sideBeamX: number;
  sideBeamSpanY: number;
  riserHeightMm: number;
  riserCenters: Array<[number, number]>;
  /** 顶升气缸 */
  cylBodyDiameterMm: number;
  cylBodyLengthMm: number;
  cylBodyCenterZ: number;
  cylRodDiameterMm: number;
  cylRodTopZ: number;
  cylRodLengthMm: number;
  cylXs: number[];
  /** 安装板 */
  mountLengthMm: number;
  mountWidthMm: number;
  mountThicknessMm: number;
  mountCenterZ: number;
  mountTopZ: number;
  mountBottomZ: number;
  /** 吊柱 */
  hangerHeightMm: number;
  hangerCenterZ: number;
  hangerCenterY: number;
  hangerOffsetX: number;
  /** 导向柱 */
  guideDiameterMm: number;
  guideCenters: Array<[number, number]>;
  guideBottomZ: number;
  guideTopZ: number;
  /** 移载行程（+Y，板件由 Y 短带送出） */
  pushStrokeMm: number;
  /** 结构间隙：板心 → 接料段带面起点 */
  structuralGapMm: number;
  /** 板尾整块落到接料段所需的最小行程 */
  minPushStrokeMm: number;
  /** 下游接料段（+Y） */
  dockWidthMm: number;
  dockLengthMm: number;
  dockStartY: number;
  dockCenterY: number;
  dockBeltFaceZ: number;
  dockBeltWidthMm: number;
  dockBeltLengthMm: number;
  dockPulleyDiameterMm: number;
  dockPulleyCenterZ: number;
  dockPulleyYs: number[];
  dockRailCenterX: number;
  dockRailZ: number;
  dockLegHeightMm: number;
  dockLegPositions: Array<[number, number]>;
  dockGuardHeightMm: number;
  dockGuardBottomZ: number;
  dockGuardCenterX: number;
  dockStopCenterY: number;
  dockStopHeightMm: number;
  dockSensorCenters: Array<[number, number, number]>;
  /** 动作时间 */
  liftSeconds: number;
  pushSeconds: number;
  actionSeconds: number;
  /** 出料侧挡边（+Y）顶面 z：板底必须越过这个面 ≥ 4 mm */
  guardTopZ: number;
  /** 顶升到位时的板底 z（= Y 带面顶升到位） */
  plateBottomLiftZ: number;
  /** 板底 − 挡边顶（≥ TRANSFER_PLATE_GUARD_CLEAR_MM 才能送出） */
  plateGuardGapMm: number;
  /** 出料口 X 向半宽（开口总宽 = 2×这个值，必须 ≥ 板长 + 40） */
  outfeedOpenHalfXMm: number;
}

/**
 * X 向窄带并联布局（移载专用：3 条）。
 *
 * 节距 = 带宽/3，单条带宽 = 节距/4（1200 → 100/400/300），带宽变化时按公式走：
 *   1080 → 90/360/270，900 → 75/300/225，600 → 60/200/140（下限带宽）。
 * 为什么和转向工位（6 条 80）分开算：转向要「4 折对称指位」所以条数必须偶数、轴线上是缝；
 * 移载要的是「带缝够宽放得下 Y 段」，条数少一条带缝就宽 100 以上 —— 两套口径不能共用。
 */
export function transferBeltLayout(params: ConveyorParams): NarrowBeltLayout {
  const p = normalizeParams(params);
  const pitchMm = Math.max(1, Math.floor(p.widthMm / TRANSFER_BELT_COUNT));
  const widthMm = Math.min(
    TRANSFER_BELT_WIDTH_MAX_MM,
    Math.max(TRANSFER_BELT_WIDTH_MIN_MM, Math.round(pitchMm * TRANSFER_BELT_WIDTH_RATIO))
  );
  const gapMm = Math.max(0, pitchMm - widthMm);
  const centers = Array.from(
    { length: TRANSFER_BELT_COUNT },
    (_unused, index) => round((index - (TRANSFER_BELT_COUNT - 1) / 2) * pitchMm)
  );
  const gaps = centers.slice(0, -1).map((center, index) => round((center + (centers[index + 1] ?? center)) / 2));
  return { count: TRANSFER_BELT_COUNT, widthMm, pitchMm, gapMm, centers, gaps };
}

/**
 * Y 段长度：min(建议 420, 带缝 − 2×10)。
 *
 * 取 min 而不是取 420 的原因写在文件头的硬约束 2：段长超过带缝，段端就伸到 X 带下方，
 * 顶升过程中必扫带。带宽 ≥ 1440（带缝 440）时段长才吃满 420。
 */
export function transferYBeltLength(gapMm: number): number {
  return Math.round(Math.min(
    TRANSFER_Y_SEGMENT_MAX_MM,
    Math.max(TRANSFER_Y_PULLEY_DIAMETER_MM * 3, gapMm - 2 * TRANSFER_Y_SEGMENT_END_CLEAR_MM)
  ));
}

/**
 * 板材尺寸：需求给了就用，没给按带宽推（板宽 = 带宽，板长 = 2×带宽）。
 *
 * **不夹紧**：板宽超过带宽时原样返回，让 transferSkipReason 把它判成「压不住」并拒建。
 * 夹紧会把「要移载 1700 的板」悄悄做成「按 1200 的板移载」，用户看不到任何提示。
 */
export function transferPartSize(params: ConveyorParams): { lengthMm: number; widthMm: number; thicknessMm: number } {
  const p = normalizeParams(params);
  const requestedWidth = p.transferPartWidthMm ?? 0;
  const widthMm = Number.isFinite(requestedWidth) && requestedWidth > 0 ? requestedWidth : p.widthMm;
  const requestedLength = p.transferPartLengthMm ?? 0;
  // 缺省板长按带宽取（1200 带宽 → 1200 板）。旧缺省是 2×带宽（2400），那是 6 m 线时代的数字：
  // 3 m 移载线的单元半宽本身就是「板长/2 + 20」，2400 的板配 3000 的线连两端输送段都放不下，
  // 会直接被护栏拒建（拒得对，但缺省值不该是拒建值）。
  const lengthMm = Number.isFinite(requestedLength) && requestedLength > 0
    ? requestedLength
    : Math.max(600, Math.round(p.widthMm));
  // 厚度不参与行程/开口的推导（只做工件占位体），但仍按参数给，缺省 35。
  const thicknessMm = p.transferPartThicknessMm ?? TRANSFER_DEFAULT_PART_THICKNESS_MM;
  return { lengthMm, widthMm, thicknessMm };
}

/** 单元 X 占位半宽：板要整块落在单元上（板长/2 + 20），且要包住 Y 段外缘（节距 + 带缝/2 + 40）。 */
export function transferUnitHalfXMm(params: ConveyorParams): number {
  const p = normalizeParams(params);
  const belts = transferBeltLayout(p);
  const part = transferPartSize(p);
  return Math.ceil(Math.max(part.lengthMm / 2 + 20, belts.pitchMm + belts.gapMm / 2 + 40));
}

/** 移载行程 = 板宽/2（板心到板尾）+ 板心到接料段带面起点 + 装配余量（三个数都来自参数）。 */
export function transferPushStrokeMm(partWidthMm: number, dockStartY: number): number {
  return Math.ceil(partWidthMm / 2 + dockStartY + TRANSFER_PUSH_MARGIN_MM);
}

/** 顶升 + 回落两趟：单趟 0.4 s 起停 + 行程按 100 mm/s（与转向工位同一口径）。 */
export function transferLiftSeconds(strokeMm: number): number {
  if (!Number.isFinite(strokeMm) || strokeMm <= 0) return 0;
  return Math.round((0.4 + strokeMm / 100) * 2 * 10) / 10;
}

/** Y 短带送料一趟：0.4 s 起停 + 行程按 300 mm/s（短带线速 0.3 m/s，真机 0.2~0.4 m/s）。 */
export function transferPushSeconds(strokeMm: number): number {
  if (!Number.isFinite(strokeMm) || strokeMm <= 0) return 0;
  return Math.round((0.4 + strokeMm / 300) * 10) / 10;
}

/** 一次移载的动作时间（s）= 顶升 + 送料 + 回落。 */
export function transferActionSeconds(strokeMm: number, pushStrokeMm: number): number {
  const total = transferLiftSeconds(strokeMm) + transferPushSeconds(pushStrokeMm);
  return Math.round(total * 10) / 10;
}

/**
 * 出料口（+Y 侧挡边在单元处的断开）X 向半宽。
 *
 * 这是**物料出口**，开口必须让整块板横着过去：板长 1200 → 每侧 ≥ 620（总宽 1240 = 板长 + 40）。
 * 下限取单元占位半宽（单元件全在里面，挡边段不该压在单元正上方）。
 */
export function transferOutfeedOpenHalfXMm(partLengthMm: number, unitHalfMm = 0): number {
  const byPart = Math.ceil(partLengthMm / 2 + TRANSFER_OUTFEED_X_MARGIN_MM);
  return Math.max(Math.ceil(unitHalfMm), byPart);
}

/**
 * 为什么不能做顶升移载；能做的返回 null。每一条都带数字，不做「悄悄退化成普通输送线」。
 */
export function transferSkipReason(params: ConveyorParams): string | null {
  const p = normalizeParams(params);
  if (!p.transferPresent) return null;
  if (p.turnerAngleDeg > 0) {
    return `转向工位（旋转 ${p.turnerAngleDeg}°）与顶升移载互斥：两套机构抢线体中段的同一段 X，`
      + '只能二选一（移载本身已完成 90° 换向，不需要再旋转板件）';
  }
  if (p.layers > 1) {
    return `立体缓存（${p.layers} 层）不加顶升移载：移载单元的顶升机构与缓存升降机构都要占线体中段，空间互斥；`
      + '移载需单独做一段移载线体';
  }
  if (p.widthMm < TRANSFER_MIN_WIDTH_MM) {
    return `带宽 ${p.widthMm} mm < 顶升移载所需最小 ${TRANSFER_MIN_WIDTH_MM} mm：`
      + `${TRANSFER_BELT_COUNT} 条窄带按节距 = 带宽/${TRANSFER_BELT_COUNT} 排，带宽 ${TRANSFER_MIN_WIDTH_MM} 时段距 200、`
      + `单条带 60、带缝 140（Y 段两侧各留 10）；再窄带缝就放不下 Y 段（段长要 ≥ 3×φ${TRANSFER_Y_PULLEY_DIAMETER_MM}）`;
  }
  const belts = transferBeltLayout(p);
  if (belts.count < TRANSFER_BELT_COUNT || belts.gapMm < TRANSFER_Y_SEGMENT_END_CLEAR_MM * 2 + TRANSFER_Y_PULLEY_DIAMETER_MM * 3) {
    return `带宽 ${p.widthMm} mm 放不下 ${TRANSFER_BELT_COUNT} 条窄带 + ${TRANSFER_Y_SEGMENTS_PER_GAP} 段 Y 带：`
      + `按节距 ${belts.pitchMm}（= 带宽/${TRANSFER_BELT_COUNT}）算，单条带 ${belts.widthMm}、带缝 ${belts.gapMm}，`
      + `Y 段（宽 ${belts.widthMm}、长 ≥ ${TRANSFER_Y_PULLEY_DIAMETER_MM * 3}）塞不进 ${belts.gapMm} 的带缝；`
      + `请把带宽加到 ≥ ${TRANSFER_MIN_WIDTH_MM} mm`;
  }
  const part = transferPartSize(p);
  if (part.widthMm > p.widthMm) {
    return `板件 Y 向 ${part.widthMm} mm 大于带宽 ${p.widthMm} mm：板要整块压在 X 带上并被 Y 段托起，`
      + `板宽超过带面就压不住，请把带宽加到 ≥ ${part.widthMm} mm 或改用吊装/机械手移载`;
  }
  // Y 段必须在板的投影里：板宽方向要盖住带缝，板长方向要盖住 ±节距/2
  const yBeltLength = transferYBeltLength(belts.gapMm);
  const gapOuterY = Math.abs(belts.gaps[belts.gaps.length - 1] ?? 0) + yBeltLength / 2;
  if (part.widthMm / 2 < gapOuterY) {
    return `板宽 ${part.widthMm} mm 的投影盖不住 Y 段：最外带缝中心 ±${Math.abs(belts.gaps[belts.gaps.length - 1] ?? 0)}`
      + ` + 段长/2 ${yBeltLength / 2} = ${gapOuterY} > 板半宽 ${part.widthMm / 2}，`
      + '顶升后板只有一部分落在 Y 带上（会翘）；请换更窄的带缝布局或加大板宽';
  }
  const yBeltOuterX = Math.round(belts.pitchMm / 2) + belts.widthMm / 2;
  if (part.lengthMm / 2 < yBeltOuterX + 20) {
    return `板长 ${part.lengthMm} mm 的投影盖不住 Y 段：Y 段外缘 ±${yBeltOuterX} + 20（边距）> 板半长 ${part.lengthMm / 2}，`
      + '顶升后板会有一半悬在 Y 带外；请加大板长或减小带宽';
  }
  const unitHalf = transferUnitHalfXMm(p);
  const endRun = p.lengthMm / 2 - unitHalf;
  if (endRun < TRANSFER_END_RUN_MIN_MM) {
    return `线体长 ${p.lengthMm} mm 放不下移载单元 + 两端输送段：单元占 X 向 2×${unitHalf} = ${2 * unitHalf} mm，`
      + `两端各剩 ${Math.round(endRun)} mm < ${TRANSFER_END_RUN_MIN_MM} mm；`
      + `最短线长 = 2×(${unitHalf} + ${TRANSFER_END_RUN_MIN_MM}) = ${2 * (unitHalf + TRANSFER_END_RUN_MIN_MM)} mm`;
  }
  if (p.lengthMm < TRANSFER_MIN_LENGTH_MM || p.lengthMm > TRANSFER_MAX_LENGTH_MM) {
    return `线体长 ${p.lengthMm} mm 超出移载线参数区间 ${TRANSFER_MIN_LENGTH_MM}~${TRANSFER_MAX_LENGTH_MM} mm：`
      + `这一版构型把机台从 6000 缩到 3000（单元 2×${unitHalf} + 两端输送段），`
      + `最短 ${2 * (unitHalf + TRANSFER_END_RUN_MIN_MM)} mm、最长 ${TRANSFER_MAX_LENGTH_MM} mm；`
      + '超长请拆成「移载段 + 独立输送段」两台设备';
  }
  const railOuterY = p.widthMm / 2 + p.frameSectionMm + 15;
  const dockStartY = railOuterY + TRANSFER_DOCK_GAP_MM;
  const stroke = transferPushStrokeMm(part.widthMm, dockStartY);
  if (stroke > TRANSFER_MAX_PUSH_STROKE_MM) {
    return `移载行程 ${stroke} mm 超出直线轴上限 ${TRANSFER_MAX_PUSH_STROKE_MM} mm：`
      + `行程 = 板宽/2 ${part.widthMm / 2} + 板心到接料段 ${Math.round(dockStartY)} + 余量 ${TRANSFER_PUSH_MARGIN_MM}；`
      + '请拆成两段移载（中间加过渡线体）或减少板宽/带宽';
  }
  const beltBottom = p.beltHeightMm - p.beltThicknessMm;
  const mountTop = beltBottom - TRANSFER_LIFT_CLEAR_MM - TRANSFER_LIFT_STROKE_MM
    - TRANSFER_LIFT_BEAM_MM - TRANSFER_CYL_ROD_EXPOSED_MM - TRANSFER_CYL_BODY_MM;
  const mountBottom = mountTop - TRANSFER_MOUNT_THICKNESS_MM;
  if (mountBottom < 60) {
    return `皮带面 ${p.beltHeightMm} mm 太低：移载单元的顶升气缸安装板落到 ${mountBottom} mm，离地不足 60 mm；`
      + `（安装板顶 = 带底 ${beltBottom} − 净空 ${TRANSFER_LIFT_CLEAR_MM} − 行程 ${TRANSFER_LIFT_STROKE_MM}`
      + ` − 升降架 ${TRANSFER_LIFT_BEAM_MM} − 杆露出 ${TRANSFER_CYL_ROD_EXPOSED_MM} − 缸体 ${TRANSFER_CYL_BODY_MM}），`
      + '请抬高皮带面';
  }
  return null;
}

/** 顶升移载的全部尺寸；不需要/做不了时返回 null。 */
export function transferLayout(params: ConveyorParams): TransferLayout | null {
  const p = normalizeParams(params);
  if (!p.transferPresent) return null;
  if (transferSkipReason(p) !== null) return null;
  const belts = transferBeltLayout(p);
  const part = transferPartSize(p);
  const section = p.frameSectionMm;
  const railTop = p.beltHeightMm - p.pulleyDiameterMm;
  const railZ = railTop - p.pulleyDiameterMm / 2 - section / 2;
  const railCenterY = p.widthMm / 2 + section / 2 + 15;
  const railOuterY = railCenterY + section / 2;
  const beltBottom = p.beltHeightMm - p.beltThicknessMm;

  const stroke = TRANSFER_LIFT_STROKE_MM;
  const yBeltLength = transferYBeltLength(belts.gapMm);
  const yBeltWidth = belts.widthMm;
  // 竖向叠层（自上而下）：Y 带面 → 带底 → 端滚筒心 → 回程 → 模块底板 → 升降架横梁 → 气缸 → 安装板
  const yBeltFaceRestZ = p.beltHeightMm - TRANSFER_Y_BELT_DROP_MM;
  const yBeltFaceLiftZ = yBeltFaceRestZ + stroke;
  const yPulleyCenterZ = yBeltFaceRestZ - TRANSFER_Y_PULLEY_DIAMETER_MM / 2;
  const yReturnTopZ = yPulleyCenterZ - TRANSFER_Y_PULLEY_DIAMETER_MM / 2;
  const yBaseTopZ = yReturnTopZ - TRANSFER_Y_BASE_CLEAR_MM;
  const yBaseBottomZ = yBaseTopZ - TRANSFER_Y_BASE_THICKNESS_MM;
  const beamTopZ = beltBottom - TRANSFER_LIFT_CLEAR_MM - stroke;
  const beamBottomZ = beamTopZ - TRANSFER_LIFT_BEAM_MM;
  const cylRodTopZ = beamBottomZ;
  const cylBodyTopZ = cylRodTopZ - TRANSFER_CYL_ROD_EXPOSED_MM;
  const cylBodyBottomZ = cylBodyTopZ - TRANSFER_CYL_BODY_MM;
  const mountTopZ = cylBodyBottomZ;
  const mountBottomZ = mountTopZ - TRANSFER_MOUNT_THICKNESS_MM;

  const unitHalfMm = transferUnitHalfXMm(p);
  const endRunMm = Math.round(p.lengthMm / 2 - unitHalfMm);
  const sideBeamX = round(unitHalfMm - 40);
  const beamLengthMm = 2 * (sideBeamX - TRANSFER_LIFT_BEAM_MM / 2);
  const beamYs = [0, ...belts.gaps.map((gap) => round(gap))];
  const sideBeamSpanY = 2 * (Math.abs(belts.gaps[belts.gaps.length - 1] ?? 0) + TRANSFER_LIFT_BEAM_MM / 2);

  // Y 段：每个带缝 2 段，X 位 ±节距/2
  const yModuleX = Math.round(belts.pitchMm / 2);
  const yModules: TransferYBeltModule[] = [];
  belts.gaps.forEach((gapY, gapIndex) => {
    for (const side of [-1, 1] as const) {
      yModules.push({ index: yModules.length + 1, gapIndex, xMm: side * yModuleX, yMm: round(gapY) });
    }
  });
  const yCheekX = Math.round(yBeltWidth / 2 + TRANSFER_Y_CHEEK_THICKNESS_MM / 2);
  // 同步轴取**每个带缝外侧**那只端滚筒：两侧对称（−330 / +330），
  // 且离带缝边缘还有 10 mm（内侧那只离边只剩 10 mm，装配/皮带跑偏都不够）
  const ySyncShaftYs = belts.gaps.map((gap) => round(
    gap + Math.sign(gap) * (yBeltLength / 2 - TRANSFER_Y_PULLEY_DIAMETER_MM / 2)
  ));
  const ySyncShaftLengthMm = 2 * (yModuleX + yBeltWidth / 2);
  const cylXs = [-(beamLengthMm / 2 - 80), beamLengthMm / 2 - 80];
  const riserHeightMm = yBaseBottomZ - beamTopZ;
  const riserCenters: Array<[number, number]> = yModules.map((module) => [module.xMm, module.yMm]);

  const hangerOffsetX = round(unitHalfMm - 100);
  const guideX = round(unitHalfMm - 100);
  const guideY = Math.round(Math.max(...belts.gaps.map((gap) => Math.abs(gap))));
  const guideTopZ = beltBottom - TRANSFER_GUIDE_TOP_CLEAR_MM;
  const mountWidthMm = round(2 * (Math.abs(belts.gaps[belts.gaps.length - 1] ?? 0) + yBeltLength / 2 + 60));

  // 下游接料段：带面 = Y 带出料面（同高，落料无落差）
  const dockStartY = round(railOuterY + TRANSFER_DOCK_GAP_MM);
  const dockBeltFaceZ = yBeltFaceLiftZ;
  const dockPulleyDiameterMm = p.pulleyDiameterMm;
  const dockPulleyCenterZ = dockBeltFaceZ - dockPulleyDiameterMm / 2;
  const dockRailTopZ = dockBeltFaceZ - dockPulleyDiameterMm;
  const dockRailZ = dockRailTopZ - dockPulleyDiameterMm / 2 - section / 2;
  const structuralGapMm = dockStartY;
  const pushStrokeMm = transferPushStrokeMm(part.widthMm, dockStartY);
  const minPushStrokeMm = Math.ceil(dockStartY + part.widthMm / 2);
  const dockWidthMm = Math.ceil(part.lengthMm + TRANSFER_DOCK_WIDTH_MARGIN_MM);
  const dockLengthMm = Math.ceil(Math.max(
    part.widthMm + 200,
    pushStrokeMm - dockStartY + part.widthMm / 2 + TRANSFER_DOCK_LENGTH_MARGIN_MM
  ));
  const dockCenterY = round(dockStartY + dockLengthMm / 2);
  const dockRailCenterX = round(dockWidthMm / 2 + 15 + section / 2);
  const dockLegHeightMm = dockRailZ - section / 2;
  const dockGuardBottomZ = dockBeltFaceZ + TRANSFER_DOCK_GUARD_LIFT_MM;
  const dockSensorCenters: Array<[number, number, number]> = [
    // 支架底面贴接料段纵梁顶，中心 +5
    [round(-dockRailCenterX), round(dockStartY + 80), dockRailTopZ + 5],
    [round(-dockRailCenterX), round(dockStartY + dockLengthMm - 160), dockRailTopZ + 5]
  ];

  const guardTopZ = p.beltHeightMm + SIDE_GUARD_LIFT_MM + SIDE_GUARD_HEIGHT_MM;

  return {
    strokeMm: stroke,
    unitHalfMm,
    endRunMm,
    beltCount: belts.count,
    beltWidthMm: belts.widthMm,
    beltGapMm: belts.gapMm,
    beltPitchMm: belts.pitchMm,
    beltCenterYs: belts.centers,
    beltGapCenterYs: belts.gaps,
    partLengthMm: part.lengthMm,
    partWidthMm: part.widthMm,
    partThicknessMm: part.thicknessMm,
    // 工件停在 X 带面上（底面 850）：不悬空（否则「板能被托起」是假的），也不埋进带里
    partBottomRestZ: p.beltHeightMm,
    partTopRestZ: p.beltHeightMm + part.thicknessMm,
    partBottomLiftZ: yBeltFaceLiftZ,
    yBeltCount: yModules.length,
    yBeltWidthMm: yBeltWidth,
    yBeltLengthMm: yBeltLength,
    yBeltRunMm: yBeltLength - 2 * TRANSFER_Y_PULLEY_DIAMETER_MM,
    yBeltThicknessMm: TRANSFER_Y_BELT_THICKNESS_MM,
    yBeltDropMm: TRANSFER_Y_BELT_DROP_MM,
    yBeltFaceRestZ,
    yBeltFaceLiftZ,
    yBeltClearanceMm: (belts.gapMm - yBeltLength) / 2,
    yPulleyDiameterMm: TRANSFER_Y_PULLEY_DIAMETER_MM,
    yPulleyCenterZ,
    yReturnTopZ,
    yBaseTopZ,
    yBaseBottomZ,
    yCheekX,
    yCheekHeightMm: TRANSFER_Y_CHEEK_HEIGHT_MM,
    yModules,
    ySyncShaftYs,
    ySyncShaftLengthMm,
    ySyncShaftZ: yPulleyCenterZ,
    yDriveCenters: [
      [0, round(-(mountWidthMm / 2 - 130)), round(mountBottomZ - 75)],
      [0, round(mountWidthMm / 2 - 130), round(mountBottomZ - 75)]
    ],
    liftBeamMm: TRANSFER_LIFT_BEAM_MM,
    beamTopZ,
    beamBottomZ,
    beamLengthMm,
    beamYs,
    sideBeamX,
    sideBeamSpanY,
    riserHeightMm,
    riserCenters,
    cylBodyDiameterMm: TRANSFER_CYL_BODY_DIAMETER_MM,
    cylBodyLengthMm: TRANSFER_CYL_BODY_MM,
    cylBodyCenterZ: (cylBodyBottomZ + cylBodyTopZ) / 2,
    cylRodDiameterMm: TRANSFER_CYL_ROD_DIAMETER_MM,
    cylRodTopZ,
    cylRodLengthMm: TRANSFER_CYL_ROD_EXPOSED_MM + TRANSFER_CYL_ROD_EMBED_MM,
    cylXs,
    mountLengthMm: 2 * unitHalfMm,
    mountWidthMm,
    mountThicknessMm: TRANSFER_MOUNT_THICKNESS_MM,
    mountCenterZ: (mountBottomZ + mountTopZ) / 2,
    mountTopZ,
    mountBottomZ,
    hangerHeightMm: round(railTop - mountTopZ),
    hangerCenterZ: round((railTop + mountTopZ) / 2),
    hangerCenterY: round(railCenterY - section / 2 - 10),
    hangerOffsetX,
    guideDiameterMm: TRANSFER_GUIDE_DIAMETER_MM,
    guideCenters: [
      [-guideX, -guideY],
      [guideX, -guideY],
      [-guideX, guideY],
      [guideX, guideY]
    ],
    guideBottomZ: mountTopZ,
    guideTopZ,
    pushStrokeMm,
    structuralGapMm,
    minPushStrokeMm,
    dockWidthMm,
    dockLengthMm,
    dockStartY,
    dockCenterY,
    dockBeltFaceZ,
    dockBeltWidthMm: dockWidthMm - 100,
    dockBeltLengthMm: dockLengthMm - 100,
    dockPulleyDiameterMm,
    dockPulleyCenterZ,
    dockPulleyYs: [round(dockStartY + 50), round(dockStartY + dockLengthMm - 50)],
    dockRailCenterX,
    dockRailZ,
    dockLegHeightMm,
    dockLegPositions: [
      [-dockRailCenterX, round(dockStartY + TRANSFER_DOCK_LEG_INSET_MM)],
      [dockRailCenterX, round(dockStartY + TRANSFER_DOCK_LEG_INSET_MM)],
      [-dockRailCenterX, round(dockStartY + dockLengthMm - TRANSFER_DOCK_LEG_INSET_MM)],
      [dockRailCenterX, round(dockStartY + dockLengthMm - TRANSFER_DOCK_LEG_INSET_MM)]
    ],
    dockGuardHeightMm: SIDE_GUARD_HEIGHT_MM,
    dockGuardBottomZ,
    dockGuardCenterX: round(dockWidthMm / 2 + 3),
    dockStopCenterY: round(dockStartY + dockLengthMm - 30),
    dockStopHeightMm: TRANSFER_DOCK_STOP_HEIGHT_MM,
    dockSensorCenters,
    liftSeconds: transferLiftSeconds(stroke),
    pushSeconds: transferPushSeconds(pushStrokeMm),
    actionSeconds: transferActionSeconds(stroke, pushStrokeMm),
    guardTopZ,
    plateBottomLiftZ: yBeltFaceLiftZ,
    plateGuardGapMm: yBeltFaceLiftZ - guardTopZ,
    outfeedOpenHalfXMm: transferOutfeedOpenHalfXMm(part.lengthMm, unitHalfMm)
  };
}

/**
 * 顶升移载的零件：安装板 / 吊柱 / 顶升气缸 / 导向柱 / 升降架（横梁 + 立柱）/ 4 段 Y 短带
 * （带 + 回程 + 端滚筒 + 底板 + 侧颊）/ 同步轴 + 驱动电机 / 下游接料段
 * （纵梁 + 皮带 + 滚筒 + 支腿 + 挡边 + 挡停 + 光电）。
 *
 * 与上一版的零件差别：辊道 + 轴承立柱 + 推板 + 无杆气缸 + 横梁 + 立柱 全部去掉，
 * 换成「升降架 + Y 短带模块」—— 这是构型变化，不是改名。
 */
function buildTransferParts(t: TransferLayout): ConveyorPart[] {
  const parts: ConveyorPart[] = [];
  const liftTag = 'transfer-lift';
  const driveTag = 'transfer-push';
  const dockTag = 'transfer-dock';

  // 1) 安装板：气缸 / 导向柱坐在上面，吊在两侧纵梁之间（不占带面）
  parts.push({
    id: 'transfer-mount-plate',
    name: '移载单元安装板',
    material: 'Q235',
    spec: `${Math.round(t.mountLengthMm)} × ${Math.round(t.mountWidthMm)} × ${t.mountThicknessMm}`,
    actuatorId: liftTag,
    features: [box('transfer-mount-plate-body', '安装板', t.mountLengthMm, t.mountWidthMm, t.mountThicknessMm)],
    transform: { x: 0, y: 0, z: round(t.mountCenterZ), rz: 0 }
  });

  // 2) 吊柱 ×4：从纵梁内侧面吊到安装板
  for (const [index, x] of [-t.hangerOffsetX, t.hangerOffsetX].entries()) {
    for (const [sub, sign] of [[1, -1], [2, 1]] as const) {
      const id = `transfer-hanger-${index * 2 + sub}`;
      parts.push({
        id,
        name: `移载单元吊柱 ${index * 2 + sub}`,
        material: 'Q235',
        spec: `${TRANSFER_HANGER_SIZE_MM}×${TRANSFER_HANGER_SIZE_MM} × ${Math.round(t.hangerHeightMm)}`,
        actuatorId: liftTag,
        features: [box(`${id}-body`, '吊柱', TRANSFER_HANGER_SIZE_MM, TRANSFER_HANGER_SIZE_MM, t.hangerHeightMm)],
        transform: { x: round(x), y: round(sign * t.hangerCenterY), z: round(t.hangerCenterZ), rz: 0 }
      });
    }
  }

  // 3) 顶升气缸 ×2：缸体 + 活塞杆（竖直，杆顶顶住升降架横梁底面）
  for (const [index, x] of t.cylXs.entries()) {
    const rodBottomZ = t.cylRodTopZ - t.cylRodLengthMm;
    parts.push({
      id: `transfer-lift-cyl-${index + 1}`,
      name: `移载顶升气缸 ${index + 1}`,
      material: 'Q235',
      spec: `φ${t.cylBodyDiameterMm} × ${t.cylBodyLengthMm}，行程 ${t.strokeMm}`,
      massOverrideKg: 4.2,
      actuatorId: liftTag,
      features: [
        cylinder(`transfer-lift-cyl-${index + 1}-body`, '缸体', t.cylBodyDiameterMm, t.cylBodyLengthMm, 'z'),
        cylinder(
          `transfer-lift-cyl-${index + 1}-rod`,
          '活塞杆',
          t.cylRodDiameterMm,
          round(t.cylRodLengthMm),
          'z',
          [0, 0, round((rodBottomZ + t.cylRodTopZ) / 2 - t.cylBodyCenterZ)]
        )
      ],
      transform: { x: round(x), y: 0, z: round(t.cylBodyCenterZ), rz: 0 }
    });
  }

  // 4) 导向柱 ×4：从安装板顶到带底以下（升降架导套沿它滑动，柱顶不穿带面）
  t.guideCenters.forEach(([x, y], index) => {
    const height = t.guideTopZ - t.guideBottomZ;
    parts.push({
      id: `transfer-guide-post-${index + 1}`,
      name: `移载导向柱 ${index + 1}`,
      material: 'STEEL45',
      spec: `φ${t.guideDiameterMm} × ${Math.round(height)}`,
      massOverrideKg: 0.9,
      actuatorId: liftTag,
      features: [cylinder(`transfer-guide-post-${index + 1}-body`, '导向柱', t.guideDiameterMm, height, 'z')],
      transform: { x: round(x), y: round(y), z: round((t.guideBottomZ + t.guideTopZ) / 2), rz: 0 }
    });
  });

  // 5) 升降架：3 根沿 X 的横梁（0、±带缝中心）+ 2 根沿 Y 的侧梁。横梁顶 = 带底 − 净空 − 行程，
  //    顶升到位仍低于带底（840 < 846），所以横梁可以整根跨过带体下方而不穿带。
  t.beamYs.forEach((y, index) => {
    parts.push({
      id: `transfer-lift-beam-x${index + 1}`,
      name: `移载升降架横梁 ${index + 1}`,
      material: 'AL6063',
      spec: `${Math.round(t.beamLengthMm)} × ${t.liftBeamMm} × ${t.liftBeamMm}`,
      actuatorId: liftTag,
      features: [box(`transfer-lift-beam-x${index + 1}-body`, '横梁', t.beamLengthMm, t.liftBeamMm, t.liftBeamMm)],
      transform: { x: 0, y: round(y), z: round((t.beamTopZ + t.beamBottomZ) / 2), rz: 0 }
    });
  });
  for (const [label, sign] of [['left', -1], ['right', 1]] as const) {
    parts.push({
      id: `transfer-lift-beam-y-${label}`,
      name: `移载升降架侧梁（${label === 'left' ? '操作侧' : '驱动侧'}）`,
      material: 'AL6063',
      spec: `${Math.round(t.sideBeamSpanY)} × ${t.liftBeamMm} × ${t.liftBeamMm}`,
      actuatorId: liftTag,
      features: [box(`transfer-lift-beam-y-${label}-body`, '侧梁', t.liftBeamMm, t.sideBeamSpanY, t.liftBeamMm)],
      transform: { x: round(sign * t.sideBeamX), y: 0, z: round((t.beamTopZ + t.beamBottomZ) / 2), rz: 0 }
    });
  }

  // 6) 立柱（Y 短带模块 → 升降架）：每段一根，落在带缝中心（φ 与段同宽）
  t.riserCenters.forEach(([x, y], index) => {
    parts.push({
      id: `transfer-lift-riser-${index + 1}`,
      name: `移载升降架立柱 ${index + 1}`,
      material: 'Q235',
      spec: `${t.liftBeamMm}×${t.liftBeamMm} × ${Math.round(t.riserHeightMm)}`,
      actuatorId: liftTag,
      features: [box(`transfer-lift-riser-${index + 1}-body`, '立柱', t.liftBeamMm, t.liftBeamMm, t.riserHeightMm)],
      transform: { x: round(x), y: round(y), z: round(t.beamTopZ + t.riserHeightMm / 2), rz: 0 }
    });
  });

  // 7) Y 短带模块 ×4：带（上行程 + 回程）+ 两端滚筒 + 底板 + 两侧颊。
  //    全部落在带缝里（Y 向 280 < 带缝 300，X 向 100 + 侧颊 12×2 < 300），
  //    所以顶升全程不碰 X 带、不碰机架 —— 这是「静止位低 25 mm + 顶升 90」能成立的唯一前提。
  t.yModules.forEach((module) => {
    const tag = module.index;
    // 带只画两只端滚筒之间那一段（段长 − 2×φ20）：包进滚筒的部分由「带×滚筒」的装配连接表达，
    // 不画成一块盖住滚筒的板 —— 那样同步轴会从带里穿过去，AABB 一查就是待复核对。
    parts.push({
      id: `transfer-y-belt-${tag}`,
      name: `移载 Y 向短带上行程 ${tag}`,
      material: 'PVC',
      spec: `${Math.round(t.yBeltRunMm)} × ${t.yBeltWidthMm} × ${t.yBeltThicknessMm}（沿 Y，落在带缝）`,
      actuatorId: liftTag,
      features: [box(`transfer-y-belt-${tag}-body`, '短带', t.yBeltWidthMm, t.yBeltRunMm, t.yBeltThicknessMm)],
      transform: { x: round(module.xMm), y: round(module.yMm), z: round(t.yBeltFaceRestZ - t.yBeltThicknessMm / 2), rz: 0 }
    });
    parts.push({
      id: `transfer-y-belt-return-${tag}`,
      name: `移载 Y 向短带回程 ${tag}`,
      material: 'PVC',
      spec: `${Math.round(t.yBeltRunMm)} × ${t.yBeltWidthMm} × ${t.yBeltThicknessMm}`,
      actuatorId: liftTag,
      features: [box(`transfer-y-belt-return-${tag}-body`, '回程带', t.yBeltWidthMm, t.yBeltRunMm, t.yBeltThicknessMm)],
      transform: { x: round(module.xMm), y: round(module.yMm), z: round(t.yReturnTopZ - t.yBeltThicknessMm / 2), rz: 0 }
    });
    for (const [side, dy] of [['in', -1], ['out', 1]] as const) {
      parts.push({
        id: `transfer-y-pulley-${tag}-${side}`,
        name: `移载 Y 向短带滚筒 ${tag}（${side === 'in' ? '进料端' : '出料端'}）`,
        material: 'STEEL45',
        spec: `φ${t.yPulleyDiameterMm} × ${t.yBeltWidthMm}`,
        massOverrideKg: 0.3,
        actuatorId: liftTag,
        features: [cylinder(
          `transfer-y-pulley-${tag}-${side}-body`,
          '端滚筒',
          t.yPulleyDiameterMm,
          t.yBeltWidthMm,
          'x'
        )],
        transform: {
          x: round(module.xMm),
          y: round(module.yMm + dy * (t.yBeltLengthMm / 2 - t.yPulleyDiameterMm / 2)),
          z: round(t.yPulleyCenterZ),
          rz: 0
        }
      });
    }
    parts.push({
      id: `transfer-y-base-${tag}`,
      name: `移载 Y 向短带底板 ${tag}`,
      material: 'Q235',
      spec: `${t.yBeltWidthMm} × ${Math.round(t.yBeltLengthMm)} × ${Math.round(t.yBaseTopZ - t.yBaseBottomZ)}`,
      actuatorId: liftTag,
      features: [box(
        `transfer-y-base-${tag}-body`,
        '短带底板',
        t.yBeltWidthMm,
        t.yBeltLengthMm,
        t.yBaseTopZ - t.yBaseBottomZ
      )],
      transform: { x: round(module.xMm), y: round(module.yMm), z: round((t.yBaseTopZ + t.yBaseBottomZ) / 2), rz: 0 }
    });
    for (const [label, sign] of [['left', -1], ['right', 1]] as const) {
      parts.push({
        id: `transfer-y-cheek-${tag}-${label}`,
        name: `移载 Y 向短带侧颊 ${tag}（${label === 'left' ? '左' : '右'}）`,
        material: 'AL6063',
        spec: `${TRANSFER_Y_CHEEK_THICKNESS_MM} × ${Math.round(t.yBeltLengthMm)} × ${t.yCheekHeightMm}`,
        actuatorId: liftTag,
        features: [box(
          `transfer-y-cheek-${tag}-${label}-body`,
          '侧颊',
          TRANSFER_Y_CHEEK_THICKNESS_MM,
          t.yBeltLengthMm,
          t.yCheekHeightMm
        )],
        transform: {
          x: round(module.xMm + sign * t.yCheekX),
          y: round(module.yMm),
          z: round(t.yBaseTopZ + t.yCheekHeightMm / 2),
          rz: 0
        }
      });
    }
  });

  // 8) 同步轴 ×2：沿 X 串起同一带缝的两段 Y 带（同带缝的两段必须同速，否则板会歪）
  t.ySyncShaftYs.forEach((y, index) => {
    parts.push({
      id: `transfer-y-shaft-${index + 1}`,
      name: `移载 Y 向短带同步轴 ${index + 1}`,
      material: 'STEEL45',
      spec: `φ${TRANSFER_Y_SHAFT_DIAMETER_MM} × ${Math.round(t.ySyncShaftLengthMm)}`,
      massOverrideKg: 0.8,
      actuatorId: liftTag,
      features: [cylinder(`transfer-y-shaft-${index + 1}-body`, '同步轴', TRANSFER_Y_SHAFT_DIAMETER_MM, t.ySyncShaftLengthMm, 'x')],
      transform: { x: 0, y: round(y), z: round(t.ySyncShaftZ), rz: 0 }
    });
  });

  // 9) Y 短带驱动电机 ×2：装在固定安装板下方，经伸缩万向轴把动力送到升降架上的同步轴
  //    （电机不随升降架走：随动的电机电缆+重量在 90 mm 行程上没必要，真机也这么做）
  t.yDriveCenters.forEach(([x, y, z], index) => {
    parts.push({
      id: `transfer-y-motor-${index + 1}`,
      name: `移载 Y 向短带驱动电机 ${index + 1}`,
      material: 'Q235',
      spec: '0.2 kW · i=30 · 输出 60 rpm，经伸缩万向轴驱动',
      massOverrideKg: 3.6,
      actuatorId: driveTag,
      features: [
        box(`transfer-y-motor-${index + 1}-body`, '电机+减速箱', 160, 120, 140),
        cylinder(`transfer-y-motor-${index + 1}-shaft`, '输出轴', 20, 60, 'z')
      ],
      transform: { x: round(x), y: round(y), z: round(z), rz: 0 }
    });
  });

  // 10) 下游接料段（+Y）：带面与 Y 带出料面同高（落料无落差）
  for (const [label, sign] of [['left', -1], ['right', 1]] as const) {
    parts.push({
      id: `dock-rail-${label}`,
      name: `接料段纵梁（${label === 'left' ? '操作侧' : '驱动侧'}）`,
      material: 'AL6063',
      spec: `40×40 × ${Math.round(t.dockLengthMm)}`,
      actuatorId: dockTag,
      // 接料段沿 +Y 走：型材长边直接给 Y（box 的 length/width/height 就是 X/Y/Z），不靠 rz 转
      features: [box(`dock-rail-${label}-body`, '型材', 40, t.dockLengthMm, 40)],
      transform: { x: round(sign * t.dockRailCenterX), y: round(t.dockCenterY), z: round(t.dockRailZ), rz: 0 }
    });
  }
  for (const [label, z] of [
    ['top', t.dockBeltFaceZ - t.yBeltThicknessMm / 2],
    ['return', t.dockPulleyCenterZ - t.dockPulleyDiameterMm / 2 - t.yBeltThicknessMm / 2]
  ] as const) {
    parts.push({
      id: `dock-belt-${label}`,
      name: `接料段皮带（${label === 'top' ? '上行程' : '回程'}）`,
      material: 'PVC',
      spec: `${Math.round(t.dockBeltLengthMm)} × ${Math.round(t.dockBeltWidthMm)} × ${t.yBeltThicknessMm}`,
      actuatorId: dockTag,
      features: [box(`dock-belt-${label}-body`, '皮带', t.dockBeltWidthMm, t.dockBeltLengthMm, t.yBeltThicknessMm)],
      transform: { x: 0, y: round(t.dockCenterY), z: round(z), rz: 0 }
    });
  }
  t.dockPulleyYs.forEach((y, index) => {
    parts.push({
      id: `dock-pulley-${index + 1}`,
      name: `接料段滚筒 ${index + 1}`,
      material: 'STEEL45',
      spec: `φ${t.dockPulleyDiameterMm} × ${Math.round(t.dockBeltWidthMm + 40)}`,
      massOverrideKg: 3.2,
      actuatorId: dockTag,
      features: [cylinder(`dock-pulley-${index + 1}-body`, '滚筒', t.dockPulleyDiameterMm, t.dockBeltWidthMm + 40, 'x')],
      transform: { x: 0, y: round(y), z: round(t.dockPulleyCenterZ), rz: 0 }
    });
  });
  t.dockLegPositions.forEach(([x, y], index) => {
    parts.push({
      id: `dock-leg-${index + 1}`,
      name: `接料段支腿 ${index + 1}`,
      material: 'AL6063',
      spec: `40×40 × ${Math.round(t.dockLegHeightMm)}`,
      actuatorId: dockTag,
      features: [box(`dock-leg-${index + 1}-body`, '型材', 40, 40, t.dockLegHeightMm)],
      transform: { x: round(x), y: round(y), z: round(t.dockLegHeightMm / 2), rz: 0 }
    });
  });
  for (const [label, sign] of [['left', -1], ['right', 1]] as const) {
    parts.push({
      id: `dock-guard-${label}`,
      name: `接料段挡边（${label === 'left' ? '左' : '右'}）`,
      material: 'Q235',
      spec: `3 × ${t.dockGuardHeightMm} × ${Math.round(t.dockLengthMm - 60)}`,
      actuatorId: dockTag,
      features: [box(`dock-guard-${label}-body`, '挡边', 3, t.dockLengthMm - 60, t.dockGuardHeightMm)],
      transform: {
        x: round(sign * t.dockGuardCenterX),
        y: round(t.dockCenterY),
        z: round(t.dockGuardBottomZ + t.dockGuardHeightMm / 2),
        rz: 0
      }
    });
  }
  parts.push({
    id: 'dock-stop',
    name: '接料段挡停板',
    material: 'Q235',
    spec: `${Math.round(t.dockWidthMm)} × 20 × ${t.dockStopHeightMm}`,
    actuatorId: dockTag,
    features: [box('dock-stop-body', '挡停板', t.dockWidthMm, 20, t.dockStopHeightMm)],
    transform: {
      x: 0,
      y: round(t.dockStopCenterY),
      z: round(t.dockGuardBottomZ + t.dockStopHeightMm / 2),
      rz: 0
    }
  });
  t.dockSensorCenters.forEach(([x, y, z], index) => {
    const tag = index === 0 ? 'inlet' : 'outlet';
    parts.push({
      id: `dock-sensor-${tag}`,
      name: `接料段${index === 0 ? '进料' : '到位'}光电支架`,
      material: 'Q235',
      spec: '40×30×80 + M12 漫反射光电',
      massOverrideKg: 0.8,
      actuatorId: dockTag,
      features: [
        box(`dock-sensor-${tag}-bracket`, '支架', 40, 30, 80),
        cylinder(`dock-sensor-${tag}-body`, 'M12 光电', 12, 40, 'y')
      ],
      transform: { x: round(x), y: round(y), z: round(z + 40), rz: 0 }
    });
  });

  return parts;
}

function buildSingleLayerParts(p: ResolvedConveyorParams): ConveyorPart[] {
  const halfL = p.lengthMm / 2;
  const halfW = p.widthMm / 2;
  const section = p.frameSectionMm;
  const pulleyRadius = p.pulleyDiameterMm / 2;
  const pulleyZ = p.beltHeightMm - pulleyRadius;
  const railZ = pulleyZ - pulleyRadius - section / 2;
  const legHeight = railZ - section / 2;
  const legCenterZ = legHeight / 2;
  const outerY = halfW + section / 2 + 15;
  const parts: ConveyorPart[] = [];
  // 转向工位：顶升旋转单元。皮带**不再断开**（窄带连续），单元只在 |x| ≤ unitHalf 处
  // 占位：横撑让开、顶升指从带缝穿过（见 turnerLayout 注释）
  const turner = turnerLayout(p);
  // 顶升移载与转向工位互斥（transferSkipReason 已把「两个都要」判成拒建），
  // 这里只取一个「中段单元占位」，带面/回程/横撑的让位口径两边共用。
  const transfer = transferLayout(p);
  const unitHalfMm = turner?.unitHalfMm ?? transfer?.unitHalfMm ?? 0;
  const hasUnit = turner !== null || transfer !== null;
  /**
   * 窄带并联布局：只有顶升单元才把单条宽带拆成多条窄带（宽度不够时退回单条）。
   *
   * 两套口径按机构分：转向工位要「4 折对称指位」→ 6 条 80（narrowBeltLayout）；
   * 顶升移载要「带缝放得下 Y 短带」→ 3 条 100 / 节距 400（transferBeltLayout）。
   * 混用会把移载的 Y 段塞进 120 的带缝里（那是 80 宽窄带的缝），几何上根本装不下。
   */
  const narrow = turner ? narrowBeltLayout(p) : transfer ? transferBeltLayout(p) : null;

  // 1) 两侧纵梁（4040 型材）
  for (const [label, sign] of [['left', -1], ['right', 1]] as const) {
    parts.push({
      id: `rail-${label}`,
      name: `侧纵梁（${label === 'left' ? '操作侧' : '驱动侧'}）`,
      material: 'AL6063',
      spec: `${section}×${section} × ${Math.round(p.lengthMm)}`,
      features: [box(`rail-${label}-body`, '型材', p.lengthMm, section, section)],
      transform: { x: 0, y: sign * outerY, z: railZ, rz: 0 }
    });
  }

  // 2) 横撑（跨接两侧梁）
  // 首尾横撑必须让开端板：端板占 x ∈ ±[halfL-8, halfL]，横撑半宽 section/2，
  // 过去直接排到 ±halfL，端板与横撑实打实撞在一起（干涉检查 153600 mm³）。
  const crossCount = Math.max(3, Math.round(p.lengthMm / 500) + 1);
  // 还要躲开尾部张紧滑座（|x| ∈ [halfL-110, halfL-40]），否则横撑 1 顶住滑座
  const crossInset = Math.max(section + 8, 130);
  const returnBeltBottom = pulleyZ - pulleyRadius - p.beltThicknessMm;
  const crossZ = returnBeltBottom - 4 - section / 2;
  const crossSpan = Math.max(0, p.lengthMm - crossInset * 2);
  for (let i = 0; i < crossCount; i += 1) {
    const x = -halfL + crossInset + (crossSpan * i) / (crossCount - 1);
    // 顶升单元的竖井：单元占位内不放横撑。横撑跨整幅宽度（y ±(带宽/2+型材)），
    // 与下沉框架、升降台板、转台盘、顶升指全都在同一段 X 上，装上就互穿；
    // 这段的横向刚度由单元自带的底座框架 + 下沉底盘承担（真机也这么做）。
    if (hasUnit && Math.abs(x) < unitHalfMm + section + 10) continue;
    parts.push({
      id: `cross-${i + 1}`,
      name: `横撑 ${i + 1}`,
      material: 'AL6063',
      spec: `${section}×${section} × ${Math.round(p.widthMm + section * 2)}`,
      features: [box(`cross-${i + 1}-body`, '型材', section, p.widthMm + section * 2, section)],
      // 横撑要躲开回程皮带：回程带下沿在 pulleyZ - pulleyRadius - t，
      // 过去横撑放在 railZ（与皮带同一高度），实打实穿带（干涉 64000 mm³）
      transform: { x: round(x), y: 0, z: crossZ, rz: 0 }
    });
  }

  // 3) 头尾端板（装滚筒轴承座）
  for (const [label, sign] of [['head', 1], ['tail', -1]] as const) {
    parts.push({
      id: `endplate-${label}`,
      name: `${label === 'head' ? '头部' : '尾部'}端板`,
      material: 'Q235',
      spec: `8 mm × ${Math.round(p.widthMm + section * 2)} × ${Math.round(section * 3)}`,
      features: [
        box(`endplate-${label}-body`, '钢板', 8, p.widthMm + section * 2, section * 3),
        feature(`endplate-${label}-holes`, 'holes', '轴承座螺栓孔', {
          // 板厚沿 X（8 mm），宽度沿 Y；孔必须落在板的 Y 向范围内
          diameter: 9,
          positions: [
            [0, -halfW - 10],
            [0, halfW + 10]
          ]
        })
      ],
      transform: { x: sign * (halfL - 4), y: 0, z: railZ, rz: 0 }
    });
  }

  // 4) 支腿 + 地脚
  const legPositions: Array<[number, number]> = [
    [-halfL + 120, -outerY],
    [-halfL + 120, outerY],
    [halfL - 120, -outerY],
    [halfL - 120, outerY]
  ];
  legPositions.forEach(([x, y], index) => {
    parts.push({
      id: `leg-${index + 1}`,
      name: `支腿 ${index + 1}`,
      material: 'AL6063',
      spec: `${section}×${section} × ${Math.round(legHeight)}`,
      features: [box(`leg-${index + 1}-body`, '型材', section, section, legHeight)],
      transform: { x: round(x), y, z: legCenterZ, rz: 0 }
    });
    parts.push({
      id: `foot-${index + 1}`,
      name: `可调地脚 ${index + 1}`,
      material: 'Q235',
      spec: `80×80×8 + 2×M10`,
      features: [
        box(`foot-${index + 1}-plate`, '底板', 80, 80, 8),
        feature(`foot-${index + 1}-holes`, 'holes', '地脚螺栓孔', {
          diameter: 11,
          positions: [
            [-25, -25],
            [25, 25]
          ]
        })
      ],
      transform: { x: round(x), y, z: 4, rz: 0 }
    });
  });

  // 5) 转向工位（顶升旋转单元）。排在这里不是随手放：BOM 按零件出现顺序归类，
  //    工位单元件排在传动件之前是 BOM 的常规排法，也让方案卡/工具结果的前 20 行里
  //    直接看到转向件（trim.ts 会把 >20 行的数组裁成 {items,total,truncated}）
  if (turner) parts.push(...buildTurnerParts(turner));
  if (transfer) parts.push(...buildTransferParts(transfer));

  // 6) 主动 / 从动滚筒（横轴圆柱，直径 × 面宽）
  //    有顶升单元时输送面是 N 条窄带并联，每条窄带各有一套滚筒（可共轴、零件独立），
  //    命名 pulley-drive-1..N / pulley-idle-1..N；否则仍是两根通长滚筒。
  if (narrow && narrow.count > 1) {
    narrow.centers.forEach((beltY, index) => {
      for (const [label, sign] of [['drive', 1], ['idle', -1]] as const) {
        parts.push({
          id: `pulley-${label}-${index + 1}`,
          name: `${label === 'drive' ? '主动' : '从动'}滚筒 ${index + 1}`,
          material: 'STEEL45',
          spec: `φ${p.pulleyDiameterMm} × ${Math.round(narrow.widthMm + 20)}`,
          features: [
            cylinder(`pulley-${label}-${index + 1}-body`, '滚筒筒体', p.pulleyDiameterMm, narrow.widthMm + 20, 'y'),
            // 轴头：贯穿整幅轴的公共轴上，这里只表达本段
            cylinder(`pulley-${label}-${index + 1}-shaft`, '轴头', 20, narrow.widthMm + 60, 'y')
          ],
          // 真实滚筒是空心筒体 + 轴，实心代理体会重一倍以上，按样本质量给
          massOverrideKg: 1.1,
          transform: { x: sign * (halfL - 10 - pulleyRadius), y: round(beltY), z: pulleyZ, rz: 0 }
        });
      }
    });
  } else {
    for (const [label, sign] of [['drive', 1], ['tail', -1]] as const) {
      parts.push({
        id: `pulley-${label}`,
        name: `${label === 'drive' ? '主动' : '从动'}滚筒`,
        material: 'STEEL45',
        spec: `φ${p.pulleyDiameterMm} × ${Math.round(p.widthMm + 40)}`,
        features: [
          cylinder(`pulley-${label}-body`, '滚筒筒体', p.pulleyDiameterMm, p.widthMm + 40, 'y'),
          // 轴头：两侧各伸 30
          cylinder(`pulley-${label}-shaft`, '轴头', 20, p.widthMm + 100, 'y')
        ],
        // 真实滚筒是空心筒体 + 轴，实心代理体会重一倍以上，按样本质量给
        massOverrideKg: 3.2,
        // 筒体必须让开端板：端板占 x ∈ ±[halfL-8, halfL]，滚筒半径 25，
        // 放在 ±halfL 时筒体整段穿过端板（干涉 47985 mm³）
        transform: { x: sign * (halfL - 10 - pulleyRadius), y: 0, z: pulleyZ, rz: 0 }
      });
    }
  }

  // 6) 皮带：上行程 + 回程 + 两侧挡边
  //    上一版有转向工位时把皮带、回程、挡边都在 |x| ≤ gapHalf 断开（固定转台与带面同高，
  //    必然互穿）。顶升单元改成「会转的东西全在带面以下、只有支撑指穿带缝」之后，
  //    皮带不再需要让位：窄带整条连续，回程与挡边也整条连续 —— 工件不离开输送面。
  const beltTopZ = p.beltHeightMm - p.beltThicknessMm / 2;
  const beltReturnZ = pulleyZ - pulleyRadius - p.beltThicknessMm / 2;
  if (narrow && narrow.count > 1) {
    const outerX = halfL - 20;
    // 回程缺口比台板宽 10 mm：台板 X 向正好 900（±450），留 10 mm 装配余量
    const innerX = hasUnit ? unitHalfMm + 10 : 0;
    const pieceLength = outerX - innerX;
    narrow.centers.forEach((beltY, index) => {
      // 上行程：整条连续，**不为转向断开**——工件全程压在带上，这是连续流的前提
      parts.push({
        id: `belt-${index + 1}`,
        name: `皮带上行程 ${index + 1}`,
        material: 'PVC',
        spec: `${Math.round(p.lengthMm - 40)} × ${Math.round(narrow.widthMm)} × ${p.beltThicknessMm}`,
        features: [box(`belt-${index + 1}-body`, '皮带', p.lengthMm - 40, narrow.widthMm, p.beltThicknessMm)],
        transform: { x: 0, y: round(beltY), z: beltTopZ, rz: 0 }
      });
      // 回程：只有回程在单元处让开 900 mm——顶升台板/回转支承/转台盘要升到这个高度，
      // 回程带在 z 796..800 横穿整幅，不让位就会被顶穿（真实设备回程也走在机构外侧）
      if (!hasUnit) {
        parts.push({
          id: `belt-return-${index + 1}`,
          name: `皮带回程 ${index + 1}`,
          material: 'PVC',
          spec: `${Math.round(p.lengthMm - 40)} × ${Math.round(narrow.widthMm)} × ${p.beltThicknessMm}`,
          features: [box(`belt-return-${index + 1}-body`, '皮带', p.lengthMm - 40, narrow.widthMm, p.beltThicknessMm)],
          transform: { x: 0, y: round(beltY), z: beltReturnZ, rz: 0 }
        });
        return;
      }
      for (const [seg, sign] of [['in', -1], ['out', 1]] as const) {
        parts.push({
          id: `belt-return-${index + 1}-${seg}`,
          name: `皮带回程 ${index + 1}（${seg === 'in' ? '进料段' : '出料段'}）`,
          material: 'PVC',
          spec: `${Math.round(pieceLength)} × ${Math.round(narrow.widthMm)} × ${p.beltThicknessMm}`,
          features: [box(`belt-return-${index + 1}-${seg}-body`, '皮带', pieceLength, narrow.widthMm, p.beltThicknessMm)],
          transform: { x: round((sign * (outerX + innerX)) / 2), y: round(beltY), z: beltReturnZ, rz: 0 }
        });
      }
    });
  } else {
    for (const [run, name, z] of [
      ['top', '皮带上行程', beltTopZ],
      ['return', '皮带回程', beltReturnZ]
    ] as const) {
      parts.push({
        id: `belt-${run}`,
        name,
        material: 'PVC',
        spec: `${Math.round(p.lengthMm - 40)} × ${Math.round(p.widthMm)} × ${p.beltThicknessMm}`,
        features: [box(`belt-${run}-body`, '皮带', p.lengthMm - 40, p.widthMm, p.beltThicknessMm)],
        transform: { x: 0, y: 0, z, rz: 0 }
      });
    }
  }
  // 侧挡边：有顶升单元也整条不断（挡边在 y = ±(带宽/2+3) 处，单元的所有件都在
  // |x| ≤ 450 且 y ≤ 带宽/2 以内，扫不到挡边）。
  //
  // 竖向口径：挡边**下沿不得低于带面**。以前挡边中心放在 带面 + 26（高 60 → 下沿 带面 − 4），
  // 下沿比带面低 4 mm，于是挡边一头扎进皮带上行程、一头扎进滚筒筒体
  //（pulley-drive/tail × guard 各 360 mm³，普通线与立体缓存都有）。现在下沿 = 带面 + 1。
  //
  // 唯一的例外是**顶升移载的出料侧**（+Y 挡边）：这块板要从这条边出去，所以挡边在单元占位内
  // 必须断开——这是物料的出口，不是干涉修补。
  //
  // 开口宽度**从板长推**（≥ 板长 + 40，见 transferOutfeedOpenHalfXMm）：旧口径写死 ±530，
  // 板长 1200 时每侧差 70 mm，板角直接扫在残留的挡边段上（2×70×3×6 = 2520 mm³）。
  for (const [label, sign] of [['left', -1], ['right', 1]] as const) {
    const side = label === 'left' ? '左' : '右';
    const guardHeightMm = SIDE_GUARD_HEIGHT_MM;
    const guardBottomZ = p.beltHeightMm + SIDE_GUARD_LIFT_MM;
    const exitCut = transfer !== null && sign > 0;
    if (!exitCut) {
      parts.push({
        id: `guard-${label}`,
        name: `侧挡边（${side}）`,
        material: 'Q235',
        spec: `3 × ${guardHeightMm} × ${Math.round(p.lengthMm)}`,
        features: [box(`guard-${label}-body`, '挡边', p.lengthMm - 60, 3, guardHeightMm)],
        transform: { x: 0, y: sign * (halfW + 3), z: guardBottomZ + guardHeightMm / 2, rz: 0 }
      });
      continue;
    }
    // 出料口：单元占位内断开，两段各自留 5 mm 装配缝
    const outerX = halfL - 30;
    const innerX = transfer === null ? unitHalfMm + 10 : transfer.outfeedOpenHalfXMm;
    const pieceLength = outerX - innerX;
    if (pieceLength < TRANSFER_OUTFEED_MIN_SEGMENT_MM) continue; // 开口盖满整侧：不留碎段
    for (const [seg, segSign] of [['in', -1], ['out', 1]] as const) {
      parts.push({
        id: `guard-${label}-${seg}`,
        name: `侧挡边（${side}·${seg === 'in' ? '进料段' : '出料段'}）`,
        material: 'Q235',
        spec: `3 × ${guardHeightMm} × ${Math.round(pieceLength)}`,
        features: [box(`guard-${label}-${seg}-body`, '挡边', pieceLength, 3, guardHeightMm)],
        transform: {
          x: round((segSign * (outerX + innerX)) / 2),
          y: sign * (halfW + 3),
          z: guardBottomZ + guardHeightMm / 2,
          rz: 0
        }
      });
    }
  }

  // 7) 减速电机（驱动侧端部，含输出轴）
  //
  // Y 向定位分两种：单层线体贴在纵梁外侧；立体缓存时纵梁外侧还立着 4 根缓存立柱
  //（columnX = halfL − 120，与电机同一个 x），电机箱必须再让到立柱**外侧**去，留 5 mm
  // 安装面。修复前两者在 x = halfL−120 处完全重叠，实测 224000 mm³（160 × 40 × 140 的
  // 140/40/40 交叠，exact）——这不是「声明一下就行」的装配面，是两坨实体撞在一起。
  const motorCenterY = -(p.layers > 1
    ? bufferColumnCenterY(p) + section / 2 + 5 + 60
    : outerY + section / 2 + 65);
  parts.push({
    id: 'gearmotor',
    name: '减速电机',
    material: 'Q235',
    spec: '40 W · i=18 · 输出 76 rpm',
    massOverrideKg: 2.8,
    features: [
      box('gearmotor-body', '电机+减速箱', 160, 120, 140),
      cylinder('gearmotor-shaft', '输出轴', 25, 80, 'y', [0, -60, 0])
    ],
    // 电机箱外挂在纵梁外侧：过去中心只在纵梁外 60、箱体深 120，
    // 有一半压进纵梁（干涉 128000 mm³），现在留 5 mm 安装面间隙
    transform: { x: halfL - 120, y: round(motorCenterY), z: pulleyZ, rz: 0 }
  });

  // 8) 尾部张紧滑座 + 螺杆（两侧各一套）
  for (const [label, sign] of [['left', -1], ['right', 1]] as const) {
    parts.push({
      id: `tension-${label}`,
      name: `张紧滑座（${label === 'left' ? '左' : '右'}）`,
      material: 'Q235',
      spec: '70×50×50 + M10 螺杆，行程 ±30',
      features: [
        box(`tension-${label}-body`, '滑座', 70, 50, 50),
        feature(`tension-${label}-slot`, 'slot', '滑动长槽', { length: 60, width: 12 }),
        cylinder(`tension-${label}-screw`, 'M10 调节螺杆', 10, 90, 'x')
      ],
      transform: { x: -halfL + 60, y: sign * outerY, z: railZ, rz: 0 }
    });
  }

  // 9) 进出料光电（支架 + M12 传感器本体）
  for (const [label, sign, y] of [['inlet', -1, -outerY], ['outlet', 1, outerY]] as const) {
    parts.push({
      id: `sensor-${label}`,
      name: `${label === 'inlet' ? '进料' : '出料'}光电支架`,
      material: 'Q235',
      spec: '40×30×80 + M12 漫反射光电',
      massOverrideKg: 0.8,
      features: [
        box(`sensor-${label}-bracket`, '支架', 40, 30, 80),
        cylinder(`sensor-${label}-body`, 'M12 光电', 12, 40, 'y')
      ],
      transform: { x: sign * (halfL - 160), y, z: p.beltHeightMm + 40, rz: 0 }
    });
  }

  return parts;
}

/**
 * 缓存立柱中心的 y（4 根柱立在纵梁外侧）：纵梁外侧面 + 40 安装面。
 * 单层线体没有立柱；这个函数是「立柱在哪儿」的唯一来源 —— 电机让位、升降导柱让位
 * 都按它算，避免两处各写一遍公式后一走就散。
 */
function bufferColumnCenterY(p: ResolvedConveyorParams): number {
  const outerY = p.widthMm / 2 + p.frameSectionMm / 2 + RAIL_INNER_OFFSET_MM;
  return outerY + p.frameSectionMm / 2 + 40;
}

/**
 * 立体缓存叠加层（layers ≥ 2）：4 根缓存立柱 + 每层托条/托板/传动辊/挡停 + 一套升降机构。
 *
 * 为什么单独一段而不是把单层线体按层复制：缓存机型的进出料仍然只有底层一条输送线，
 * 上方各层是储位（托条 + 托板），靠一套升降台在层间搬运。复制线体会把皮带、滚筒、
 * 电机按层数翻倍，既不真实也会让 BOM 里出现 3 条皮带的荒唐行。
 */
function buildBufferStackParts(p: ResolvedConveyorParams): ConveyorPart[] {
  const parts: ConveyorPart[] = [];
  const section = p.frameSectionMm;
  const halfL = p.lengthMm / 2;
  const halfW = p.widthMm / 2;
  const outerY = halfW + section / 2 + 15;
  const layerCount = p.layers;
  const topLayerZ = p.beltHeightMm + (layerCount - 1) * p.layerPitchMm;
  const columnH = topLayerZ + 240;
  const columnY = bufferColumnCenterY(p);
  const columnX = halfL - 120;

  // 1) 缓存立柱：4 根，立在纵梁外侧（不与侧挡边、支腿、横撑同位置）
  const columns: Array<[string, number, number]> = [
    ['fl', -columnX, -columnY],
    ['fr', -columnX, columnY],
    ['bl', columnX, -columnY],
    ['br', columnX, columnY]
  ];
  columns.forEach(([label, x, y], index) => {
    parts.push({
      id: `column-${label}`,
      name: `缓存立柱 ${index + 1}`,
      material: 'AL6063',
      spec: `${section}×${section} × ${Math.round(columnH)}`,
      features: [box(`column-${label}-body`, '型材', section, section, columnH)],
      transform: { x: round(x), y: round(y), z: round(columnH / 2), rz: 0 }
    });
  });

  // 2) 顶部横梁：把四根立柱在 Y 向连成门架，托架层才有支点
  for (const [label, sign] of [['front', -1], ['back', 1]] as const) {
    parts.push({
      id: `top-beam-${label}`,
      name: `顶部横梁（${label === 'front' ? '前' : '后'}）`,
      material: 'AL6063',
      spec: `${section}×${section} × ${Math.round(p.lengthMm - 200)}`,
      features: [box(`top-beam-${label}-body`, '横梁', p.lengthMm - 240, section, section)],
      transform: { x: 0, y: sign * columnY, z: round(topLayerZ + 200), rz: 0 }
    });
  }

  // 3) 逐层储位：第 2 层起（第 1 层就是底层输送线）
  for (let layer = 2; layer <= layerCount; layer += 1) {
    const layerZ = p.beltHeightMm + (layer - 1) * p.layerPitchMm;
    // 托条：两根沿 X，托住托盘两侧长边
    for (const [label, sign] of [['left', -1], ['right', 1]] as const) {
      parts.push({
        id: `tray-rail-${layer}-${label}`,
        name: `第 ${layer} 层托条（${label === 'left' ? '左' : '右'}）`,
        material: 'AL6063',
        spec: `${section}×${section} × ${Math.round(p.lengthMm - 320)}`,
        features: [box(`tray-rail-${layer}-${label}-body`, '托条', p.lengthMm - 320, section, section)],
        transform: { x: 0, y: sign * round(halfW * 0.55), z: round(layerZ - section / 2), rz: 0 }
      });
    }
    // 托板：放在托条上，留 5mm 高度间隙，避免和托条共面被算成干涉
    parts.push({
      id: `tray-${layer}`,
      name: `第 ${layer} 层托板`,
      material: 'Q235',
      spec: `3 × ${Math.round(p.widthMm * 0.9)} × ${Math.round(p.lengthMm - 340)}`,
      features: [box(`tray-${layer}-body`, '托板', p.lengthMm - 340, round(p.widthMm * 0.9), 3)],
      transform: { x: 0, y: 0, z: round(layerZ + 3 + 2), rz: 0 }
    });
    // 层内传动辊：**改到两根托条之间**（辊长按托条内宽取，两侧各留 5 mm 装配缝）。
    // 修复前辊筒按 0.85×带宽 做（510 mm 长），横穿两根托条，辊面又只比托条顶低 9 mm
    // → 每层 4 对、实测 18000 mm³（50 × 9 × 40，aabb）。现在辊面抬到托盘底面
    //（层高 + 3.5）：托盘坐在辊上，辊只在托条之间转，托条变成侧向限位。
    const railCenterY = round(halfW * 0.55);
    // 辊长 = 两根托条内侧面之间再各让 5 mm；实在塞不下（极窄线体）就不装层辊，
    // 不硬塞一根比托条内宽还长的辊上去
    const rollerLengthMm = Math.round(2 * (railCenterY - section / 2) - 10);
    const trayBottomZ = layerZ + 3 + 2 - 1.5;
    const rollerCenterZ = round(trayBottomZ - p.pulleyDiameterMm / 2);
    for (const [label, sign] of rollerLengthMm >= 60 ? [['in', -1], ['out', 1]] as const : []) {
      parts.push({
        id: `tray-roller-${layer}-${label}`,
        name: `第 ${layer} 层传动辊（${label === 'in' ? '进' : '出'}）`,
        material: 'STEEL45',
        spec: `φ${p.pulleyDiameterMm} × ${rollerLengthMm}`,
        massOverrideKg: 2.4,
        features: [cylinder(`tray-roller-${layer}-${label}-body`, '辊筒', p.pulleyDiameterMm, rollerLengthMm, 'y')],
        transform: { x: sign * round(halfL - 220), y: 0, z: rollerCenterZ, rz: 0 }
      });
    }
    // 出口挡停：装在托板上方，挡住托盘
    parts.push({
      id: `stop-${layer}`,
      name: `第 ${layer} 层挡停板`,
      material: 'Q235',
      spec: `3 × ${Math.round(p.widthMm * 0.8)} × 60`,
      features: [box(`stop-${layer}-body`, '挡停板', 3, round(p.widthMm * 0.8), 60)],
      transform: { x: round(halfL - 190), y: 0, z: round(layerZ + 36), rz: 0 }
    });
    // 层到位检测（每层一只，简化成 M12 传感器本体）
    parts.push({
      id: `layer-sensor-${layer}`,
      name: `第 ${layer} 层到位光电`,
      material: 'Q235',
      spec: 'M12 漫反射光电',
      massOverrideKg: 0.08,
      features: [cylinder(`layer-sensor-${layer}-body`, 'M12 光电', 12, 40, 'y')],
      transform: { x: round(-halfL + 300), y: round(halfW + 12), z: round(layerZ + 30), rz: 0 }
    });
  }

  // 4) 升降机构：2 根导柱 + 升降台 + 升降电机 + 2 条链条
  //
  // 导柱 / 链条的 Y 位：以前取 ±0.8×半宽——那正好是**带面里面**，φ40 柱整根穿过上行程
  // 与回程皮带（实测 5026.5 mm³ ×4，exact）、链条也穿带（480 mm³ ×4），尾部滚筒还被
  // 导柱/链条穿过（40000 / 3000 mm³，aabb）。导柱是缓存架的立柱式导轨，必须落在
  // **缓存立柱外侧的同一排**：y = ±(立柱中心 + 型材 + 5)，与柱面留 5 mm 安装缝；
  // X 向与立柱错开 60 mm（导柱 halfL−60、立柱 halfL−120），两根立筋不共面。
  const travel = (layerCount - 1) * p.layerPitchMm;
  const postH = travel + 320;
  const mastY = columnY + section + 5;
  for (const [label, sign] of [['left', -1], ['right', 1]] as const) {
    parts.push({
      id: `lift-post-${label}`,
      name: `升降导柱（${label === 'left' ? '左' : '右'}）`,
      material: 'STEEL45',
      spec: `φ${section} × ${Math.round(postH)}`,
      features: [cylinder(`lift-post-${label}-body`, '导柱', section, postH, 'z')],
      transform: { x: round(-halfL + 60), y: sign * round(mastY), z: round(postH / 2 + 20), rz: 0 }
    });
    parts.push({
      id: `lift-chain-${label}`,
      name: `升降链条（${label === 'left' ? '左' : '右'}）`,
      material: 'STEEL45',
      spec: `8B 单排 × ${Math.round(travel + 200)}`,
      massOverrideKg: 1.6,
      features: [box(`lift-chain-${label}-body`, '链条', 10, 12, travel + 200)],
      transform: { x: round(-halfL + 60), y: sign * round(mastY), z: round((travel + 200) / 2 + 90), rz: 0 }
    });
  }
  // 升降台：位于底层输送线上方一个层距处，宽度略小于皮带，避免压挡边
  parts.push({
    id: 'lift-platform',
    name: '升降台',
    material: 'Q235',
    spec: `${Math.round(p.widthMm * 0.9)} × 320 × 16`,
    features: [
      box('lift-platform-body', '台面', 320, round(p.widthMm * 0.9), 16),
      box('lift-platform-guide', '导向块', 60, 60, 40)
    ],
    transform: { x: round(-halfL + 240), y: 0, z: round(p.beltHeightMm + p.layerPitchMm * 0.5), rz: 0 }
  });
  parts.push({
    id: 'lift-motor',
    name: '升降减速电机',
    material: 'Q235',
    spec: '0.75 kW · i=40 · 带制动',
    massOverrideKg: 12.5,
    features: [
      box('lift-motor-body', '电机+减速箱', 180, 140, 160),
      cylinder('lift-motor-shaft', '输出轴', 25, 70, 'y', [0, -60, 0])
    ],
    // 挂在左侧立柱外侧、再让到升降导柱外侧（留 5 mm 安装面）。
    // 导柱挪到立柱外排之后，电机箱（140 深）正好压住导柱与链条，
    // 所以这里按导柱排反算：y = -(mastY + 型材/2 + 5 + 箱体半深 70)。
    transform: {
      x: round(-halfL + 60),
      y: round(-(mastY + section / 2 + 5 + 70)),
      z: round(p.beltHeightMm),
      rz: 0
    }
  });

  return parts;
}

function normalizeParams(params: Partial<ConveyorParams> | undefined): ResolvedConveyorParams {
  const merged = { ...DEFAULT_CONVEYOR, ...(params ?? {}) };
  const positive = (value: number, fallback: number): number =>
    Number.isFinite(value) && value > 0 ? value : fallback;
  const lengthMm = clamp(positive(merged.lengthMm, DEFAULT_CONVEYOR.lengthMm), 400, 12000);
  const widthMm = clamp(positive(merged.widthMm, DEFAULT_CONVEYOR.widthMm), 100, 1200);
  const beltHeightMm = clamp(positive(merged.beltHeightMm, DEFAULT_CONVEYOR.beltHeightMm), 300, 1400);
  const pulleyDiameterMm = clamp(positive(merged.pulleyDiameterMm, DEFAULT_CONVEYOR.pulleyDiameterMm), 20, 200);
  const beltThicknessMm = clamp(positive(merged.beltThicknessMm, DEFAULT_CONVEYOR.beltThicknessMm), 1, 20);
  const frameSectionMm = clamp(positive(merged.frameSectionMm, DEFAULT_CONVEYOR.frameSectionMm), 20, 100);
  const layers = clamp(Math.round(positive(merged.layers ?? DEFAULT_CONVEYOR.layers, 1)), 1, 8);
  const layerPitchMm = clamp(positive(merged.layerPitchMm ?? DEFAULT_CONVEYOR.layerPitchMm, 400), 250, 900);
  // 转向角度：0 = 不做转向；只接受 1–180（超过 180 的「旋转」实际是一圈以上的分度，需要另做机构）
  const turnerAngleDeg = clamp(Math.round(merged.turnerAngleDeg ?? 0), 0, 180);
  // 顶升移载：与转向互斥（同时给两个由 transferSkipReason 给出理由并拒建）。
  // 两种开法都认：显式 transferPresent=true（方案/落盘 config），或写了板宽
  //（参数化生成器只吃数字参数，用「板宽 > 0」当开关，见 model-builders.ts）。
  const transferPresent = merged.transferPresent === true || (merged.transferPartWidthMm ?? 0) > 0;
  const transferPartLengthMm = positive(merged.transferPartLengthMm ?? 0, 0);
  const transferPartWidthMm = positive(merged.transferPartWidthMm ?? 0, 0);
  // 板厚：1–200 mm。上限 200 是为了让「板太厚顶到接料段挡边/挡停」能被干涉检查报出来，
  // 而不是在参数层被夹成一个看不出来的数。
  const transferPartThicknessMm = clamp(
    positive(merged.transferPartThicknessMm ?? TRANSFER_DEFAULT_PART_THICKNESS_MM, TRANSFER_DEFAULT_PART_THICKNESS_MM),
    1,
    200
  );
  return {
    lengthMm,
    widthMm,
    beltHeightMm,
    pulleyDiameterMm,
    beltThicknessMm,
    frameSectionMm,
    layers,
    layerPitchMm,
    turnerAngleDeg,
    transferPresent,
    transferPartLengthMm,
    transferPartWidthMm,
    transferPartThicknessMm
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function conveyorAssembly(parts: readonly ConveyorPart[]): AssemblyDoc {
  const instances: PartInstance[] = parts.map((part) => ({
    id: part.id,
    name: part.name,
    transform: part.transform,
    features: part.features
  }));
  return { schemaVersion: 2, instances, updatedAt: new Date().toISOString() };
}

/**
 * 包络（mm）：X 长 × Y 宽 × Z 高。
 * 按每个零件的实际外形盒求并集，避免「公式估的包络」小于真实模型（电机、挡边会超出）。
 */
export function conveyorEnvelope(parts: readonly ConveyorPart[]): [number, number, number] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    const half = partHalfExtent(part);
    const axes: Array<[number, number]> = [
      [part.transform.x - half[0], part.transform.x + half[0]],
      [part.transform.y - half[1], part.transform.y + half[1]],
      [part.transform.z - half[2], part.transform.z + half[2]]
    ];
    for (let axis = 0; axis < 3; axis += 1) {
      const [lo, hi] = axes[axis] ?? [0, 0];
      min[axis] = Math.min(min[axis] ?? Infinity, lo);
      max[axis] = Math.max(max[axis] ?? -Infinity, hi);
    }
  }
  if (!Number.isFinite(min[0])) return [0, 0, 0];
  return [
    Math.round((max[0] - min[0]) * 10) / 10,
    Math.round((max[1] - min[1]) * 10) / 10,
    Math.round((max[2] - min[2]) * 10) / 10
  ];
}

/** 单个零件的半尺寸（按特征包围盒估算，含圆柱的轴向长度） */
function partHalfExtent(part: ConveyorPart): [number, number, number] {
  const half: [number, number, number] = [0, 0, 0];
  for (const node of part.features) {
    const params = node.params;
    if (node.type === 'box') {
      half[0] = Math.max(half[0], Number(params.length) / 2);
      half[1] = Math.max(half[1], Number(params.width) / 2);
      half[2] = Math.max(half[2], Number(params.height) / 2);
    } else if (node.type === 'cylinder') {
      const radius = Number(params.diameter) / 2;
      const length = Number(params.height);
      const axis = String(params.axis ?? 'z');
      const at = Array.isArray(params.at) ? (params.at as number[]) : [0, 0, 0];
      const extent: [number, number, number] = axis === 'x'
        ? [length / 2, radius, radius]
        : axis === 'y' ? [radius, length / 2, radius] : [radius, radius, length / 2];
      for (let i = 0; i < 3; i += 1) {
        half[i] = Math.max(half[i] ?? 0, Math.abs(at[i] ?? 0) + (extent[i] ?? 0));
      }
    }
  }
  return half;
}

export interface ConveyorBomRow {
  name: string;
  spec: string;
  qty: number;
  material: string;
  /** 单件质量（kg），有内核体积时按密度精确计算 */
  massKg: number | null;
}

/**
 * BOM。传了 `volumes`（内核回传的每实例体积 mm³）就按密度算真实质量，
 * 没传则 massKg 为 null——不猜重量。
 */
export function conveyorBom(
  parts: readonly ConveyorPart[],
  volumes?: Record<string, number>
): ConveyorBomRow[] {
  const grouped = new Map<string, ConveyorBomRow>();
  for (const part of parts) {
    const volume = volumes?.[part.id];
    const fromKernel = typeof volume === 'number' && volume > 0
      ? Math.round((volume / 1e9) * MATERIAL_DENSITY[part.material] * 1000) / 1000
      : null;
    // 目录件（电机/滚筒/光电）用样本质量覆盖；其余按内核体积 × 密度
    const massKg = part.massOverrideKg ?? fromKernel;
    // 左右/进出这类括号限定不该参与分组，否则「侧纵梁（操作侧）」和「（驱动侧）」会各算一行
    const baseName = part.name.replace(/（[^）]*）/g, '').replace(/ \d+$/, '').trim();
    const key = `${baseName}|${part.spec}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.qty += 1;
      if (existing.massKg !== null && massKg !== null) existing.massKg = Math.min(existing.massKg, massKg);
      continue;
    }
    grouped.set(key, {
      name: baseName,
      spec: part.spec,
      qty: 1,
      material: MATERIAL_LABEL[part.material],
      massKg
    });
  }
  return [...grouped.values()];
}
