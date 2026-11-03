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
}

/** 归一化之后的参数：层数一定存在，内部构建器只用这个类型。 */
export type ResolvedConveyorParams = ConveyorParams & { layers: number; layerPitchMm: number; turnerAngleDeg: number };

export const DEFAULT_CONVEYOR: Required<ConveyorParams> = {
  lengthMm: 2000,
  widthMm: 300,
  beltHeightMm: 850,
  pulleyDiameterMm: 50,
  beltThicknessMm: 4,
  frameSectionMm: 40,
  layers: 1,
  layerPitchMm: 400,
  turnerAngleDeg: 0
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
 * 保证带缝 ≥ 100：1200 宽正好 6 条（pitch 200、缝隙 120），600 宽 3 条（pitch 200、
 * 缝隙 120），300 宽退回 1 条（2 条只剩 70 mm 缝，顶升指塞不进去），与真机惯例一致。
 */
export function narrowBeltLayout(params: ConveyorParams): NarrowBeltLayout {
  const p = normalizeParams(params);
  const pitchUnit = NARROW_BELT_WIDTH_MM + NARROW_BELT_GAP_MIN_MM;
  // 条数按「带 + 缝」等分反算：n 条只需要 n×80 + (n−1)×100 宽，所以是 (宽 + 缝) / 单元
  let count = Math.min(NARROW_BELT_MAX_COUNT, Math.floor((p.widthMm + NARROW_BELT_GAP_MIN_MM) / pitchUnit));
  count = Math.max(1, count);
  // 条数取整后带缝可能被压到 100 mm 以下（如 300 mm 宽 → 2 条只剩 70 mm 缝），逐条回退
  while (count > 1 && p.widthMm / count - NARROW_BELT_WIDTH_MM < NARROW_BELT_GAP_MIN_MM) count -= 1;
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
 * 四种情形：没要求、立体缓存、线体太短、带宽太窄（放不下 2 条以上窄带）、机架太矮。
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
  const fingerCenters: Array<[number, number]> = [[0, 0]];
  const seenFinger = new Set(['0,0']);
  for (const gapY of belts.gaps) {
    if (Math.abs(gapY) < 1e-6) continue;
    for (const pair of [[0, gapY], [-gapY, 0], [gapY, 0]] as Array<[number, number]>) {
      const key = `${pair[0]},${pair[1]}`;
      if (seenFinger.has(key)) continue;
      seenFinger.add(key);
      fingerCenters.push([pair[0], pair[1]]);
    }
  }

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
    hangerCenterY: railInnerY - 10,
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
    tableDiameterMm: 2 * TURNER_UNIT_HALF_MM - 20, // 880：留在单元轮廓内，仍在带面以下
    tableThicknessMm: TURNER_TABLE_THICKNESS_MM,
    tableCenterZ: tableBottomZ + TURNER_TABLE_THICKNESS_MM / 2,
    fingerPostCenterZ: (tableTopZ + padBottomZ) / 2,
    fingerPadCenterZ: padTopZ - TURNER_FINGER_PAD_THICKNESS_MM / 2,
    padTopZ,
    padTopLiftZ: padTopZ + TURNER_LIFT_STROKE_MM,
    // 电机挂在下沉框架上（不随台板升，跟着升起会顶到工件），竖直输出轴从带缝里伸上去
    motorCenter: [TURNER_UNIT_HALF_MM + 150, 0, frameBaseTopZ + 60], // 电机坐在底盘上（底面贴 664）
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
        spec: `20×20 × ${Math.round(t.hangerHeightMm)}`,
        features: [box(`${id}-body`, '吊柱', 20, 20, t.hangerHeightMm)],
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
      box('turner-motor-body', '电机+减速箱', 90, 110, 120),
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
  /** 窄带并联布局：只有顶升单元才把单条宽带拆成多条窄带（宽度不够时退回单条） */
  const narrow = turner ? narrowBeltLayout(p) : null;

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
    if (turner && Math.abs(x) < turner.unitHalfMm + section + 10) continue;
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
    const innerX = turner ? turner.unitHalfMm + 10 : 0;
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
      if (!turner) {
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
  // |x| ≤ 450 且 y ≤ 带宽/2 以内，扫不到挡边）
  for (const [label, sign] of [['left', -1], ['right', 1]] as const) {
    const side = label === 'left' ? '左' : '右';
    parts.push({
      id: `guard-${label}`,
      name: `侧挡边（${side}）`,
      material: 'Q235',
      spec: `3 × 60 × ${Math.round(p.lengthMm)}`,
      features: [box(`guard-${label}-body`, '挡边', p.lengthMm - 60, 3, 60)],
      transform: { x: 0, y: sign * (halfW + 3), z: p.beltHeightMm + 26, rz: 0 }
    });
  }

  // 7) 减速电机（驱动侧端部，含输出轴）
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
    transform: { x: halfL - 120, y: -(outerY + section / 2 + 65), z: pulleyZ, rz: 0 }
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
  const columnY = outerY + section / 2 + 40;
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
    // 层内传动辊：进出各一根，托板中间让开
    for (const [label, sign] of [['in', -1], ['out', 1]] as const) {
      parts.push({
        id: `tray-roller-${layer}-${label}`,
        name: `第 ${layer} 层传动辊（${label === 'in' ? '进' : '出'}）`,
        material: 'STEEL45',
        spec: `φ${p.pulleyDiameterMm} × ${Math.round(p.widthMm * 0.85)}`,
        massOverrideKg: 2.4,
        features: [cylinder(`tray-roller-${layer}-${label}-body`, '辊筒', p.pulleyDiameterMm, round(p.widthMm * 0.85), 'y')],
        transform: { x: sign * round(halfL - 220), y: 0, z: round(layerZ + 16), rz: 0 }
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
  const travel = (layerCount - 1) * p.layerPitchMm;
  const postH = travel + 320;
  for (const [label, sign] of [['left', -1], ['right', 1]] as const) {
    parts.push({
      id: `lift-post-${label}`,
      name: `升降导柱（${label === 'left' ? '左' : '右'}）`,
      material: 'STEEL45',
      spec: `φ${section} × ${Math.round(postH)}`,
      features: [cylinder(`lift-post-${label}-body`, '导柱', section, postH, 'z')],
      transform: { x: round(-halfL + 60), y: sign * round(halfW * 0.8), z: round(postH / 2 + 20), rz: 0 }
    });
    parts.push({
      id: `lift-chain-${label}`,
      name: `升降链条（${label === 'left' ? '左' : '右'}）`,
      material: 'STEEL45',
      spec: `8B 单排 × ${Math.round(travel + 200)}`,
      massOverrideKg: 1.6,
      features: [box(`lift-chain-${label}-body`, '链条', 10, 12, travel + 200)],
      transform: { x: round(-halfL + 60), y: sign * round(halfW * 0.8), z: round((travel + 200) / 2 + 90), rz: 0 }
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
    // 挂在左侧立柱外侧，留 5mm 安装面
    transform: { x: round(-halfL + 60), y: round(-(columnY + section / 2 + 80)), z: round(p.beltHeightMm), rz: 0 }
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
  return { lengthMm, widthMm, beltHeightMm, pulleyDiameterMm, beltThicknessMm, frameSectionMm, layers, layerPitchMm, turnerAngleDeg };
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
