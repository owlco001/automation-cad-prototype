/**
 * 缓存塔（专用塔身几何）→ `ConveyorPart[]`。
 *
 * 为什么单独一个模块（方案 C，见 docs 与探针报告）：
 * - `conveyor-assembly` 的 `layers` 语义是「输送线 + 多层托架缓存」，上限 8 是**产品语义**
 *   （拖动条/brief 解析/8 层概念验证都有测试锚），把它放宽到 16 等于把「输送线的多层缓存」
 *   和「缓存塔」两套语义焊死在一起；
 * - 但也不另造第三套几何：本模块只出 `ConveyorPart`，BOM/包络/干涉/评审/3D/STEP 仍然走
 *   同一条零件表管线（`conveyorAssembly` / `conveyorBom` / `conveyorEnvelope` /
 *   `conveyorGeometryFromParts` / `conveyorJoints`）。件号沿用 `column-*` / `tray-*` /
 *   `stop-*` / `lift-*` 族，`JOINT_RULES` 直接命中，不需要为新件族开白名单。
 *
 * 与 8 层建造器的三处**有理由的**差异：
 * 1. 立柱截面按柱高反算：`max(型材截面, ceil5(柱高/48))`。40×40 铝柱在 3.84 m 静载下屈曲临界不足
 *    （探针手算量级：K=1 约 350 kg、K=2 约 88 kg，无安全系数）。注意：反算只是把「差一个量级」
 *    收敛到「差一成左右」（80×80×3 在 K=2 + 安全系数 3 下许用约 0.36 t，而特征体积口径的四柱静载
 *    约 0.41 t/柱），**不等于截面够了**，定截面必须做正式校核。
 * 2. 导柱顶到顶层以上：`postTop = 柱高 = 顶层托板 + 240`。旧 8 层建造器 `postTop` 恒比顶层
 *    托板低 560 mm（导柱压根没到顶层），那是既有缺陷；本模块不复制它，也不去改旧路径
 *    （旧路径的行为由 `conveyor-assembly.test.mjs` / regen 门禁锁住）。
 * 3. 升降台带 `actuatorId: 'tower-lift'` 与「服务第 1..N 层」的规格文字：静态几何只建一个台面，
 *    但件上标明它是一条**能到顶**的轴，而不是「一块钉死在 990 mm 的板」。这条轴现在真的接进了
 *    状态化干涉（`interference-states.ts` 认 `strokeSource: 'geometry'`）与联动（轴带 `point`）；
 *    代价要一起读：台面在层托板投影内、塔身没有升降通道，sweep 会把 lift-platform × tray-* 报为命中。
 * 4. **层完整性按四族逐层核对**（`bufferTowerSlots`）：托板 / 托条 / 挡停 / 层光电每一层都必须齐、
 *    件数必须正好；缺层、多件、多余层号一律抛 `BufferTowerGeometryError`（内部缺陷，不是参数问题）。
 *    旧实现只比「托板件数 vs 层光电件数」，而两族在同一个循环体里产出，整层一起丢时校验恒相等。
 *
 * 能力边界（必须原样读，不许当验收）：这是**静态概念几何**。件外形是参数化特征/包围盒，
 * 不是制造用 B-Rep 结论；lift/sweep 状态化干涉可跑（AABB 初筛 + 解析式确认），但只对台面这一条轴、
 * 且台面没有升降通道（sweep 会把 lift-platform × tray-* 报为命中）；push 不适用（无移载轴）；
 * 未做结构强度/挠度/屈曲校核、未做防坠与抱闸、未生成 PLC、未分配 IO 地址、未做安全回路。
 * `slots` 里的数字是**货位数**（含第 1 层进出料位），不是已验证可服务储位数，也不是吞吐结论。
 */

import { buildConveyorParts, type ConveyorPart } from './conveyor-assembly.ts';

/** 单塔物理层数上限：超过这个数（>64 层 @180 = 11.5 m）已经不是本机构，别用参数硬顶。 */
export const MAX_BUFFER_TOWER_LEVELS = 64;
/** 逻辑槽位总上限与 `buffer-tower.ts` 的 MAX_BUFFER_SLOTS 同口径。 */
export const MAX_BUFFER_TOWER_SLOTS = 512;
/** 层距下限余量：托板厚 + 130（板放到托板上、挡停/辊子要有净空）。 */
export const BUFFER_TOWER_PITCH_CLEARANCE_MM = 130;
export const BUFFER_TOWER_MAX_PITCH_MM = 600;
/** 进料线比板材长出的最小余量（板要完全落在第 1 层输送线上）。 */
export const BUFFER_TOWER_INBOUND_MARGIN_MM = 120;
/** 导柱顶相对顶层托板的最小余量（修正旧 builder 的 560 mm 缺口）。 */
export const BUFFER_TOWER_POST_TOP_CLEARANCE_MM = 240;

/**
 * 尺寸上下限（mm / kg）。为什么要有上限：这些字段以前只判「有限数字」，
 * 于是 `beltHeightMm = -900` 会被接受、零件落到地面以下 0.98 m 还能回 `ok:true`；
 * `panel.lengthMm = -500` 会让「进料线 ≥ 板长 + 120」这条算式失效（负数永远小于正数）。
 * 上限不是物理极限，是「再大就不是本机构」（也挡住把 m 当 mm 的输入）。
 */
export const BUFFER_TOWER_PANEL_LIMITS = { lengthMm: [100, 12000], widthMm: [50, 4000], thicknessMm: [1, 200], massKg: [0, 2000] } as const;
export const BUFFER_TOWER_INBOUND_LIMITS = { lengthMm: [500, 12000], widthMm: [200, 4000], beltHeightMm: [100, 3000] } as const;
export const BUFFER_TOWER_SECTION_LIMITS = { sectionMm: [10, 400], columnSectionMm: [10, 600] } as const;

export type BufferTowerErrorCode =
  /** 形状/字段类型不对（不是数字、缺必填块） */
  | 'CONFIG_SHAPE'
  /** 数值在物理/语义上不成立（层数、层距、进料长度、立柱截面） */
  | 'CONFIG_RANGE'
  /** `levels × slotsPerLevel ≠ slotsPerTower`：容量与几何对不上 */
  | 'CONFIG_CAPACITY_MISMATCH'
  /** 形状合法但本期几何不支持（双塔镜像、每层多位） */
  | 'NOT_IMPLEMENTED';

/**
 * 缓存塔配置错误。**一律继承 RangeError**：`design_machine` 用 `instanceof RangeError`
 * 区分「调用方参数问题」与「程序内部缺陷」（后者不再误报 INVALID_ARGUMENT）。
 */
export class BufferTowerConfigError extends RangeError {
  readonly code: BufferTowerErrorCode;

  constructor(code: BufferTowerErrorCode, message: string) {
    super(message);
    this.name = 'BufferTowerConfigError';
    this.code = code;
  }
}

/**
 * 零件表与配置自相矛盾（≠ 调用方参数错）。
 *
 * 故意**不继承 RangeError**：`design_machine` 用 `instanceof RangeError` 区分「参数问题」与
 * 「程序内部缺陷」。层数对不上、整层丢件、`slots` 与声明容量不一致，都是建造器的 bug，
 * 该回 `INTERNAL_ERROR` 让人去修代码，而不是让调用方去改参数。
 */
export class BufferTowerGeometryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BufferTowerGeometryError';
  }
}

export interface BufferTowerPanel {
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  /** 单板质量（kg）；只用于容量/载荷说明，不参与几何 */
  massKg: number;
}

export interface BufferTowerInbound {
  lengthMm: number;
  widthMm: number;
  /** 底层输送线（= 第 1 层）的皮带面高 mm */
  beltHeightMm: number;
}

export interface BufferTowerFrame {
  material: 'AL6063' | 'Q235';
  /** 底层输送型材截面（沿用 conveyor 的 40 语义） */
  sectionMm: number;
  /**
   * 缓存立柱截面；缺省按柱高反算（`max(sectionMm, ceil5(柱高/48))`）。
   * 显式给出时**只能大于等于反算值**——给 40 建 3.84 m 的塔是出图不是出机器。
   */
  columnSectionMm?: number;
}

/**
 * `MachineConfig.bufferTower`：容量身份 + 塔身几何参数同一份。
 *
 * 判别字段是 `kind: 'tower'`（不看 formId：formId 仍是 belt-line，第 1 层就是那条输送线）。
 * 与 `config.conveyor` 并列而不是塞进去：`config.conveyor.layers` 与这里的 `levels`
 * 是两套语义（输送线的多层缓存 / 塔的物理层数），混在一个对象里就再也说不清谁是谁。
 */
export interface MachineBufferTowerConfig {
  kind: 'tower';
  /** 塔数；本期几何只支持 1（双塔镜像不在范围内） */
  towers: 1 | 2;
  /** 每塔逻辑储位数（与 buffer-tower.ts 的 slotsPerTower 同口径） */
  slotsPerTower: number;
  /** 物理层数，含第 1 层进出料输送线 */
  levels: number;
  /** 每层沿 X 的储位数；本期几何只支持 1（>1 需要伸缩叉/穿梭车） */
  slotsPerLevel: number;
  /** 层距 mm */
  layerPitchMm: number;
  panel: BufferTowerPanel;
  inbound: BufferTowerInbound;
  frame: BufferTowerFrame;
  /** 第 1 层兼作进出料工位（固定 1，避免把「货位数」说成「可服务储位数」） */
  transferLevel: 1;
}

export interface ResolvedBufferTowerParams {
  /** 归一化后的配置（回执原样回显，与 config 落盘同一份） */
  config: MachineBufferTowerConfig;
  levels: number;
  slotsPerLevel: number;
  layerPitchMm: number;
  panel: BufferTowerPanel;
  inbound: BufferTowerInbound;
  frameSectionMm: number;
  /** 按柱高反算出的最小立柱截面（mm） */
  requiredColumnSectionMm: number;
  columnSectionMm: number;
  columnSectionSource: 'derived' | 'explicit';
  /** 柱高 = 进料皮带面 + (层数-1)×层距 + 240 */
  columnHeightMm: number;
  /** 顶层托板中心 Z */
  topLayerZMm: number;
  /** 升降行程 = (层数-1)×层距 */
  liftTravelMm: number;
  /** 导柱顶 Z：本模块保证 = 柱高 = 顶层托板 + 240 */
  postTopZMm: number;
}

function fail(code: BufferTowerErrorCode, message: string): never {
  throw new BufferTowerConfigError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNumber(source: Record<string, unknown>, key: string, label: string, options: { integer?: boolean } = {}): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('CONFIG_SHAPE', `${label} 必须是有限数字（收到 ${JSON.stringify(value)}）`);
  }
  if (options.integer && (!Number.isSafeInteger(value) || value <= 0)) {
    fail('CONFIG_SHAPE', `${label} 必须是正整数（收到 ${JSON.stringify(value)}）`);
  }
  return value;
}

/**
 * 尺寸类入参：必须是有限数字且落在 `[min, max]`。
 *
 * 只判「有限数字」是不够的：`panel.thicknessMm = -10` 会把层距下限从 165 降到 120，
 * `inbound.beltHeightMm = -900` 会让整机落到地面以下 —— 两者都能让回执 `ok:true`。
 * 这里一律 fail-loud（`CONFIG_RANGE`，message 带区间），**不夹紧**。
 */
function requireDimension(
  source: Record<string, unknown>,
  key: string,
  label: string,
  limits: readonly [number, number]
): number {
  const value = requireNumber(source, key, label);
  const [min, max] = limits;
  if (value < min || value > max) {
    fail(
      'CONFIG_RANGE',
      `${label}=${value} 超出 ${min}~${max}：`
        + (min > 0
          ? '尺寸必须是正数（mm/kg），负值/零值/非有限数一律不接受，也不夹紧'
          : '不得为负（零值合法），负值/非有限数一律不接受，也不夹紧')
    );
  }
  return value;
}

function requireBlock(source: Record<string, unknown>, key: string, label: string): Record<string, unknown> {
  const value = source[key];
  if (!isRecord(value)) fail('CONFIG_SHAPE', `${label} 必须是对象`);
  return value;
}

/** 向上取到 5 的倍数（截面规格按 5 mm 一档）。 */
function ceil5(value: number): number {
  return Math.ceil(value / 5) * 5;
}

/**
 * 塔的**唯一判别字段**：`config.bufferTower.kind === 'tower'`。
 *
 * 为什么单独导出：整机建模入口（`extension.ts` / `model-builders.ts`）与几何入口
 * （`machine-geometry.ts`）以前各写一份判定，一边按 `process`、一边按
 * `config.bufferTower.kind`，于是「只给 design、不给 process」会静默落到 29 件输送线
 * 且回执 `ok:true`。判定只许有一份，两边都调这里。
 */
export function isBufferTowerConfig(value: unknown): value is MachineBufferTowerConfig {
  return isRecord(value) && value.kind === 'tower';
}

/**
 * 把外部输入（JSON / 工具参数 / 落盘 config）归一化成 `MachineBufferTowerConfig`。
 *
 * 只做**形状**归一：缺省值只补 `layerPitchMm`（180）、`frame.sectionMm`（40）、
 * `frame.material`（AL6063）、`slotsPerLevel`（1）、`transferLevel`（1）。
 * 数值是否成立（容量算式、层距净空、进料余量、立柱截面）由
 * `bufferTowerParamsFromConfig` 判定，**不在这里夹紧**。
 */
export function normalizeBufferTowerConfig(raw: unknown): MachineBufferTowerConfig {
  if (!isRecord(raw)) fail('CONFIG_SHAPE', 'config.bufferTower 必须是对象');
  if (raw.kind !== 'tower') {
    fail('CONFIG_SHAPE', `config.bufferTower.kind 必须是 'tower'（收到 ${JSON.stringify(raw.kind)}）；没有它就不是缓存塔几何`);
  }
  const towers = requireNumber(raw, 'towers', 'config.bufferTower.towers', { integer: true });
  if (towers !== 1 && towers !== 2) fail('CONFIG_RANGE', `config.bufferTower.towers 只能是 1 或 2（收到 ${towers}）`);
  const slotsPerTower = requireNumber(raw, 'slotsPerTower', 'config.bufferTower.slotsPerTower', { integer: true });
  const levels = requireNumber(raw, 'levels', 'config.bufferTower.levels', { integer: true });
  const slotsPerLevel = raw.slotsPerLevel === undefined
    ? 1
    : requireNumber(raw, 'slotsPerLevel', 'config.bufferTower.slotsPerLevel', { integer: true });
  const layerPitchMm = raw.layerPitchMm === undefined ? 180 : requireNumber(raw, 'layerPitchMm', 'config.bufferTower.layerPitchMm');
  const panelRaw = requireBlock(raw, 'panel', 'config.bufferTower.panel');
  const panel: BufferTowerPanel = {
    lengthMm: requireDimension(panelRaw, 'lengthMm', 'config.bufferTower.panel.lengthMm', BUFFER_TOWER_PANEL_LIMITS.lengthMm),
    widthMm: requireDimension(panelRaw, 'widthMm', 'config.bufferTower.panel.widthMm', BUFFER_TOWER_PANEL_LIMITS.widthMm),
    thicknessMm: requireDimension(panelRaw, 'thicknessMm', 'config.bufferTower.panel.thicknessMm', BUFFER_TOWER_PANEL_LIMITS.thicknessMm),
    // 质量 0 是合法输入（未称重的薄板），负值不是：负质量会让含板料载荷的结构标注反向
    massKg: requireDimension(panelRaw, 'massKg', 'config.bufferTower.panel.massKg', BUFFER_TOWER_PANEL_LIMITS.massKg)
  };
  const inboundRaw = requireBlock(raw, 'inbound', 'config.bufferTower.inbound');
  const inbound: BufferTowerInbound = {
    lengthMm: requireDimension(inboundRaw, 'lengthMm', 'config.bufferTower.inbound.lengthMm', BUFFER_TOWER_INBOUND_LIMITS.lengthMm),
    widthMm: requireDimension(inboundRaw, 'widthMm', 'config.bufferTower.inbound.widthMm', BUFFER_TOWER_INBOUND_LIMITS.widthMm),
    // 下限 100 mm 是实测地面线：基本输送线在 beltHeight=100 时最低件 z=0，再低就落到地面以下
    beltHeightMm: requireDimension(inboundRaw, 'beltHeightMm', 'config.bufferTower.inbound.beltHeightMm', BUFFER_TOWER_INBOUND_LIMITS.beltHeightMm)
  };
  const frameRaw = raw.frame === undefined ? {} : requireBlock(raw, 'frame', 'config.bufferTower.frame');
  const material = frameRaw.material === undefined ? 'AL6063' : frameRaw.material;
  if (material !== 'AL6063' && material !== 'Q235') {
    fail('CONFIG_SHAPE', `config.bufferTower.frame.material 只能是 AL6063 / Q235（收到 ${JSON.stringify(material)}）`);
  }
  const sectionMm = frameRaw.sectionMm === undefined
    ? 40
    : requireDimension(frameRaw, 'sectionMm', 'config.bufferTower.frame.sectionMm', BUFFER_TOWER_SECTION_LIMITS.sectionMm);
  const frame: BufferTowerFrame = { material, sectionMm };
  if (frameRaw.columnSectionMm !== undefined) {
    frame.columnSectionMm = requireDimension(
      frameRaw,
      'columnSectionMm',
      'config.bufferTower.frame.columnSectionMm',
      BUFFER_TOWER_SECTION_LIMITS.columnSectionMm
    );
  }
  const transferLevel = raw.transferLevel === undefined ? 1 : requireNumber(raw, 'transferLevel', 'config.bufferTower.transferLevel', { integer: true });
  if (transferLevel !== 1) {
    fail('CONFIG_RANGE', `config.bufferTower.transferLevel 必须是 1（本期只有第 1 层兼作进出料位，收到 ${transferLevel}）`);
  }
  return { kind: 'tower', towers, slotsPerTower, levels, slotsPerLevel, layerPitchMm, panel, inbound, frame, transferLevel: 1 };
}

/**
 * 归一化 + 全部不变量判定（**fail-loud，不夹紧**）。
 *
 * 现状 `conveyor.layers` 在 4 处被硬编码夹到 8，连 message 都不给的地方也有
 * （`parseConveyorParams` 的 `Math.min(8, …)`）：那正是「参数不生效却看不出来」。
 * 塔这条路径宁可抛错：16 被静默改成 8，画出来就是另一台机器。
 */
export function bufferTowerParamsFromConfig(config: { bufferTower?: MachineBufferTowerConfig | undefined } | undefined): ResolvedBufferTowerParams {
  const raw = config?.bufferTower;
  if (raw === undefined || raw === null) {
    fail('CONFIG_SHAPE', '缺少 config.bufferTower：缓塔几何必须由它派生，不从 formId/conveyor 猜');
  }
  const normalized = normalizeBufferTowerConfig(raw);
  const { towers, slotsPerTower, levels, slotsPerLevel, layerPitchMm, panel, inbound, frame } = normalized;

  // 1) 容量身份（与 buffer-tower.ts 纯数据层同口径）
  const total = towers * slotsPerTower;
  if (!Number.isSafeInteger(total) || total > MAX_BUFFER_TOWER_SLOTS) {
    fail('CONFIG_RANGE', `缓存塔槽位总数 ${total}（${towers}×${slotsPerTower}）不得超过 ${MAX_BUFFER_TOWER_SLOTS}`);
  }
  // 2) 容量与几何必须自洽：这条算式要出现在 message 里，否则「16 位」只是一句口号
  if (levels * slotsPerLevel !== slotsPerTower) {
    fail(
      'CONFIG_CAPACITY_MISMATCH',
      `缓存塔容量与几何不一致：levels ${levels} × slotsPerLevel ${slotsPerLevel} = ${levels * slotsPerLevel} ≠ slotsPerTower ${slotsPerTower}`
        + `（单塔 ${levels * slotsPerLevel} 层/位，声明 ${slotsPerTower} 个储位）`
    );
  }
  // 3) 本期几何只支持单塔、每层 1 位：不做静默降级
  if (towers !== 1) {
    fail('NOT_IMPLEMENTED', `towers=${towers} 的镜像塔身几何本期未实现：双塔需要汇流/争用机构，单塔几何复制一份会假装「两塔都能取放」`);
  }
  if (slotsPerLevel !== 1) {
    fail(
      'NOT_IMPLEMENTED',
      `slotsPerLevel=${slotsPerLevel} 未实现：每层 2 位（2278 板）需要伸缩叉/穿梭车/两套升降，inbound 要 ≥ 4.9 m；`
        + '按 1 位建会画出一块隔板假装「两位可取」'
    );
  }
  // 4) 层数：<2 就是输送线，>64 已不是本机构
  if (levels < 2) {
    fail('CONFIG_RANGE', `levels=${levels} 不构成缓存塔：单层请用 config.conveyor（layers 1）`);
  }
  if (levels > MAX_BUFFER_TOWER_LEVELS) {
    fail('CONFIG_RANGE', `levels=${levels} 超过 ${MAX_BUFFER_TOWER_LEVELS} 层（180 mm 层距下已 11.5 m 以上），本机构不覆盖`);
  }
  // 5) 层距净空：托板厚 + 130 ≤ 层距 ≤ 600
  const minPitch = panel.thicknessMm + BUFFER_TOWER_PITCH_CLEARANCE_MM;
  if (layerPitchMm < minPitch || layerPitchMm > BUFFER_TOWER_MAX_PITCH_MM) {
    fail(
      'CONFIG_RANGE',
      `layerPitchMm=${layerPitchMm} 超出 ${minPitch}~${BUFFER_TOWER_MAX_PITCH_MM} mm（托板厚 ${panel.thicknessMm} + 净空 ${BUFFER_TOWER_PITCH_CLEARANCE_MM} = ${minPitch}）`
    );
  }
  // 6) 进料线要放得下整块板（含端部余量）
  const minInboundLength = panel.lengthMm + BUFFER_TOWER_INBOUND_MARGIN_MM;
  if (inbound.lengthMm < minInboundLength) {
    fail(
      'CONFIG_RANGE',
      `inbound.lengthMm=${inbound.lengthMm} 短于板材长 ${panel.lengthMm} + 余量 ${BUFFER_TOWER_INBOUND_MARGIN_MM} = ${minInboundLength}`
    );
  }
  if (inbound.widthMm < panel.widthMm) {
    fail('CONFIG_RANGE', `inbound.widthMm=${inbound.widthMm} 小于板材宽 ${panel.widthMm}：板会压在挡边/托条外侧`);
  }

  // 7) 立柱截面按柱高反算（显式值只允许更大）
  const columnHeightMm = Math.round(inbound.beltHeightMm + (levels - 1) * layerPitchMm + 240);
  const requiredColumnSectionMm = Math.max(frame.sectionMm, ceil5(columnHeightMm / 48));
  let columnSectionMm = requiredColumnSectionMm;
  let columnSectionSource: 'derived' | 'explicit' = 'derived';
  if (frame.columnSectionMm !== undefined) {
    columnSectionSource = 'explicit';
    if (frame.columnSectionMm < requiredColumnSectionMm) {
      fail(
        'CONFIG_RANGE',
        `frame.columnSectionMm=${frame.columnSectionMm} 小于柱高 ${columnHeightMm} mm 需用的 ${requiredColumnSectionMm} mm：`
          + '40×40×2 铝型材在 3.84 m 高、~333 kg/柱 时屈曲临界不足（探针手算量级 K=1 约 350 kg、K=2 约 88 kg，无安全系数）；'
          + '这里不夹紧到 80，请显式给出 ≥ 反算值的截面或改用 Q235'
      );
    }
    columnSectionMm = frame.columnSectionMm;
  }
  const topLayerZMm = Math.round(inbound.beltHeightMm + (levels - 1) * layerPitchMm);
  return {
    config: normalized,
    levels,
    slotsPerLevel,
    layerPitchMm,
    panel,
    inbound,
    frameSectionMm: frame.sectionMm,
    requiredColumnSectionMm,
    columnSectionMm,
    columnSectionSource,
    columnHeightMm,
    topLayerZMm,
    liftTravelMm: Math.round((levels - 1) * layerPitchMm),
    postTopZMm: columnHeightMm
  };
}

/** 底层输送线（第 1 层）参数：塔身不复制皮带/滚筒/电机，只叠托架层。 */
function inboundConveyorParams(params: ResolvedBufferTowerParams) {
  return {
    lengthMm: params.inbound.lengthMm,
    widthMm: params.inbound.widthMm,
    beltHeightMm: params.inbound.beltHeightMm,
    pulleyDiameterMm: 50,
    beltThicknessMm: 4,
    frameSectionMm: params.frameSectionMm,
    layers: 1
  } as const;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 生成缓存塔整机零件表：底层输送线（复用 `buildConveyorParts(layers: 1)`）+ 塔身。
 *
 * 件数（16 层实测）：29（底架）+ 4 立柱 + 2 顶梁 + 15 层 × 7 + 2 导柱 + 2 链条 + 台 + 电机 = 146。
 * 第 1 层**不建托板**（它就是那条进出料输送线）——所以 `tray-*` 计数 = 层数 - 1，
 * `slots.fromGeometry` 的派生式必须把这一层加回来（见 `bufferTowerSlots`）。
 */
export function buildBufferTowerParts(params: ResolvedBufferTowerParams): ConveyorPart[] {
  const base = buildConveyorParts(inboundConveyorParams(params));
  const parts: ConveyorPart[] = [...base];
  const section = params.frameSectionMm;
  const columnSection = params.columnSectionMm;
  const lengthMm = params.inbound.lengthMm;
  const widthMm = params.inbound.widthMm;
  const halfL = lengthMm / 2;
  const halfW = widthMm / 2;
  const outerY = halfW + section / 2 + 15;
  // 立柱中心：**内侧面**与 40 型材柱的内侧面齐平（柱加宽只朝外长），否则 80 柱会压到
  // 纵梁外侧的张紧滑座/地脚/减速电机上（实测 3 类新重叠，全部不是装配连接）。
  const columnY = outerY + section / 2 + 40 + (columnSection - section) / 2;
  // 立柱中心 X：比 8 层建造器再收 120 mm。底层输送线的减速电机外挂在 x ∈ [半长-200, 半长-40]
  // 的纵梁外侧，40 柱刚好从它内侧 5 mm 让过去；柱加宽到 80 后再占同一 X 位就会真的穿过电机箱
  //（实测 1 对 column×gearmotor 重叠，不是装配连接）。所以塔架往里收一个柱位，不压底层件。
  const columnX = halfL - 240;
  const columnH = params.columnHeightMm;

  // 1) 缓存立柱：4 根（截面按柱高反算，见 bufferTowerParamsFromConfig）
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
      spec: `${columnSection}×${columnSection} × ${Math.round(columnH)}`,
      features: [{ id: `column-${label}-body`, type: 'box', name: '型材', params: { length: columnSection, width: columnSection, height: columnH } }],
      transform: { x: round(x), y: round(y), z: round(columnH / 2), rz: 0 }
    });
  });

  // 2) 顶部横梁：把四根立柱在 Y 向连成门架，托架层才有支点
  for (const [label, sign] of [['front', -1], ['back', 1]] as const) {
    parts.push({
      id: `top-beam-${label}`,
      name: `顶部横梁（${label === 'front' ? '前' : '后'}）`,
      material: 'AL6063',
      spec: `${columnSection}×${columnSection} × ${Math.round(lengthMm - 200)}`,
      features: [{ id: `top-beam-${label}-body`, type: 'box', name: '横梁', params: { length: lengthMm - 240, width: columnSection, height: columnSection } }],
      transform: { x: 0, y: sign * round(columnY), z: round(params.topLayerZMm + 200), rz: 0 }
    });
  }

  // 3) 逐层储位：第 2 层起（第 1 层就是底层输送线）
  for (let level = 2; level <= params.levels; level += 1) {
    const layerZ = params.inbound.beltHeightMm + (level - 1) * params.layerPitchMm;
    // 托条：两根沿 X，托住托板两侧长边
    for (const [label, sign] of [['left', -1], ['right', 1]] as const) {
      parts.push({
        id: `tray-rail-${level}-${label}`,
        name: `第 ${level} 层托条（${label === 'left' ? '左' : '右'}）`,
        material: 'AL6063',
        spec: `${section}×${section} × ${Math.round(lengthMm - 320)}`,
        features: [{ id: `tray-rail-${level}-${label}-body`, type: 'box', name: '托条', params: { length: lengthMm - 320, width: section, height: section } }],
        transform: { x: 0, y: sign * round(halfW * 0.55), z: round(layerZ - section / 2), rz: 0 }
      });
    }
    // 托板：放在托条上，留 5 mm 高度间隙（与 8 层建造器同口径，避免和托条共面被判干涉）
    parts.push({
      id: `tray-${level}`,
      name: `第 ${level} 层托板`,
      material: 'Q235',
      spec: `3 × ${Math.round(widthMm * 0.9)} × ${Math.round(lengthMm - 340)}`,
      features: [{ id: `tray-${level}-body`, type: 'box', name: '托板', params: { length: lengthMm - 340, width: round(widthMm * 0.9), height: 3 } }],
      transform: { x: 0, y: 0, z: round(layerZ + 3 + 2), rz: 0 }
    });
    // 层内传动辊：夹在两根托条之间（辊长按托条内宽取，两侧各留 5 mm）
    const railCenterY = round(halfW * 0.55);
    const rollerLengthMm = Math.round(2 * (railCenterY - section / 2) - 10);
    const trayBottomZ = layerZ + 3 + 2 - 1.5;
    const rollerCenterZ = round(trayBottomZ - 50 / 2);
    for (const [label, sign] of rollerLengthMm >= 60 ? [['in', -1], ['out', 1]] as const : []) {
      parts.push({
        id: `tray-roller-${level}-${label}`,
        name: `第 ${level} 层传动辊（${label === 'in' ? '进' : '出'}）`,
        material: 'STEEL45',
        spec: `φ50 × ${rollerLengthMm}`,
        massOverrideKg: 2.4,
        features: [{ id: `tray-roller-${level}-${label}-body`, type: 'cylinder', name: '辊筒', params: { diameter: 50, height: rollerLengthMm, axis: 'y' } }],
        transform: { x: sign * round(halfL - 220), y: 0, z: rollerCenterZ, rz: 0 }
      });
    }
    // 出口挡停：装在托板上方，挡住托盘
    parts.push({
      id: `stop-${level}`,
      name: `第 ${level} 层挡停板`,
      material: 'Q235',
      spec: `3 × ${Math.round(widthMm * 0.8)} × 60`,
      features: [{ id: `stop-${level}-body`, type: 'box', name: '挡停板', params: { length: 3, width: round(widthMm * 0.8), height: 60 } }],
      transform: { x: round(halfL - 190), y: 0, z: round(layerZ + 36), rz: 0 }
    });
    // 层到位检测：每层一只（件表里有，IO 草案仍是 9 点/null，见边界声明）
    parts.push({
      id: `layer-sensor-${level}`,
      name: `第 ${level} 层到位光电`,
      material: 'Q235',
      spec: 'M12 漫反射光电',
      massOverrideKg: 0.08,
      features: [{ id: `layer-sensor-${level}-body`, type: 'cylinder', name: 'M12 光电', params: { diameter: 12, height: 40, axis: 'y' } }],
      transform: { x: round(-halfL + 300), y: round(halfW + 12), z: round(layerZ + 30), rz: 0 }
    });
  }

  // 4) 升降机构：2 根导柱（到顶）+ 升降台 + 升降电机 + 2 条链条
  //
  // 导柱顶 = 柱高 = 顶层托板 + 240：旧建造器 `travel + 320` 恒比顶层低 560 mm，
  // 「16 个货位看得见、够不着」。这里按顶层反算，postTop 与柱顶齐平（余量刚好 240）。
  const mastY = columnY + columnSection / 2 + 5 + section / 2;
  const postH = params.postTopZMm;
  const chainLength = params.liftTravelMm + 200;
  for (const [label, sign] of [['left', -1], ['right', 1]] as const) {
    parts.push({
      id: `lift-post-${label}`,
      name: `升降导柱（${label === 'left' ? '左' : '右'}）`,
      material: 'STEEL45',
      spec: `φ${section} × ${Math.round(postH)}`,
      features: [{ id: `lift-post-${label}-body`, type: 'cylinder', name: '导柱', params: { diameter: section, height: postH, axis: 'z' } }],
      transform: { x: round(-halfL + 60), y: sign * round(mastY), z: round(postH / 2), rz: 0 }
    });
    parts.push({
      id: `lift-chain-${label}`,
      name: `升降链条（${label === 'left' ? '左' : '右'}）`,
      material: 'STEEL45',
      spec: `8B 单排 × ${Math.round(chainLength)}`,
      massOverrideKg: 1.6,
      features: [{ id: `lift-chain-${label}-body`, type: 'box', name: '链条', params: { length: 10, width: 12, height: chainLength } }],
      transform: { x: round(-halfL + 60), y: sign * round(mastY), z: round(chainLength / 2 + 90), rz: 0 }
    });
  }
  parts.push({
    id: 'lift-platform',
    name: '升降台',
    material: 'Q235',
    spec: `${Math.round(widthMm * 0.9)} × 320 × 16 · 单台面示意，服务第 1~${params.levels} 层（serveLevelRange）`,
    features: [
      { id: 'lift-platform-body', type: 'box', name: '台面', params: { length: 320, width: round(widthMm * 0.9), height: 16 } },
      { id: 'lift-platform-guide', type: 'box', name: '导向块', params: { length: 60, width: 60, height: 40 } }
    ],
    transform: { x: round(-halfL + 240), y: 0, z: round(params.inbound.beltHeightMm + params.layerPitchMm * 0.5), rz: 0 },
    // 只做归属标注（不参与运动学）：运动轴由 machine-geometry 的塔分派显式给出。
    actuatorId: 'tower-lift'
  });
  parts.push({
    id: 'lift-motor',
    name: '升降减速电机',
    material: 'Q235',
    spec: '0.75 kW · i=40 · 带制动',
    massOverrideKg: 12.5,
    features: [
      { id: 'lift-motor-body', type: 'box', name: '电机+减速箱', params: { length: 180, width: 140, height: 160 } },
      { id: 'lift-motor-shaft', type: 'cylinder', name: '输出轴', params: { diameter: 25, height: 70, axis: 'y', at: [0, -60, 0] } }
    ],
    transform: {
      x: round(-halfL + 60),
      y: round(-(mastY + columnSection / 2 + 5 + 70)),
      z: round(params.inbound.beltHeightMm),
      rz: 0
    },
    actuatorId: 'tower-lift'
  });

  return parts;
}

export interface BufferTowerSlots {
  /** 由零件表派生：层数 × 每层托板件数 × 塔数组数（三项全部数出来的，没有一项抄配置） */
  fromGeometry: number;
  /** 配置声明的容量（towers × slotsPerTower） */
  claimed: number;
  /** fromGeometry === claimed（不成立时本函数抛错，不会返回 false） */
  aligned: boolean;
  /** 需要扣掉的进出料层数（第 1 层） */
  transferLevels: number;
  /** 真正能存料的层数：fromGeometry − towersFromGeometry × transferLevels */
  usableStorage: number;
  /** 派生用到的中间量，便于复核 */
  levelsFromGeometry: number;
  /** 每层托板件数 = 每层储位数（几何派生，不是 `params.slotsPerLevel` 回声） */
  slotsPerLevelFromGeometry: number;
  /** 由立柱组数派生（4 根/塔）：双塔先撞 NOT_IMPLEMENTED，故恒为 1 */
  towersFromGeometry: number;
  /** 配置回显（**不参与派生**） */
  levels: number;
  /** 配置回显（**不参与派生**） */
  slotsPerLevel: number;
  trayCount: number;
  sensorCount: number;
  /** 逐层件数核对表，给回执与排错用 */
  layerTrace: string[];
}

/**
 * 逐层件族表：`perLevel` 是每层应有件数，`optional` 表示条件件（托条内宽太窄时不建传动辊）。
 * 这四族各自独立产出，整层一起丢时不会「两边同减 1」互相抵消 —— 那正是旧实现的漏洞。
 */
const SLOT_FAMILIES: readonly {
  key: string;
  label: string;
  pattern: RegExp;
  perLevel: number;
  optional?: boolean;
}[] = [
  { key: 'tray', label: '托板 tray-*', pattern: /^tray-(\d+)$/, perLevel: 1 },
  { key: 'trayRail', label: '托条 tray-rail-*', pattern: /^tray-rail-(\d+)-(?:left|right)$/, perLevel: 2 },
  { key: 'stop', label: '挡停 stop-*', pattern: /^stop-(\d+)$/, perLevel: 1 },
  { key: 'layerSensor', label: '层光电 layer-sensor-*', pattern: /^layer-sensor-(\d+)$/, perLevel: 1 },
  { key: 'trayRoller', label: '层传动辊 tray-roller-*', pattern: /^tray-roller-(\d+)-(?:in|out)$/, perLevel: 2, optional: true }
];

/**
 * `slots` 的唯一派生口。**三项都从零件表数出来，一项都不抄配置**：
 * - 层数：托板件族覆盖第 2..N 层（第 1 层是进出料输送线，没有托板），再加回 `transferLevel`；
 * - 每层位数：每层托板件数（一块托板 = 一个储位）。旧实现直接乘 `params.slotsPerLevel`，
 *   那是**参数回声**——配置写 2 就会凭空多算一倍；本期 `NOT_IMPLEMENTED` 把 2 锁死，
 *   两者曾经恰好相等，但那是巧合，不是校验；
 * - 塔数：4 根立柱为一塔，按组数数出来（双塔会先撞 NOT_IMPLEMENTED）。
 *
 * 完整性判定（P1-1 的要害）：每一层都必须在**四个独立件族**里各就各位。
 * 旧实现只比「托板件数 vs 层光电件数」，而这两族在同一个 for 循环体里产出：
 * 整层一起丢时两边同时 −1，校验恒相等 → 146→139 件仍 `ok:true` + `aligned:false`。
 * 现在缺层 / 多件 / 多余层号 / 每层件数不对**一律抛 `BufferTowerGeometryError`**（内部缺陷，不是参数问题）。
 */
export function bufferTowerSlots(params: ResolvedBufferTowerParams, parts: readonly ConveyorPart[]): BufferTowerSlots {
  const expectedLevels = Array.from({ length: Math.max(0, params.levels - 1) }, (_, index) => index + 2);
  const expectedSet = new Set(expectedLevels);
  const countsByFamily = new Map<string, Map<number, number>>();
  for (const family of SLOT_FAMILIES) {
    const counts = new Map<number, number>();
    for (const part of parts) {
      const match = family.pattern.exec(part.id);
      if (!match) continue;
      const level = Number(match[1]);
      counts.set(level, (counts.get(level) ?? 0) + 1);
    }
    countsByFamily.set(family.key, counts);
  }

  for (const family of SLOT_FAMILIES) {
    const counts = countsByFamily.get(family.key) ?? new Map<number, number>();
    if (!family.optional) {
      const missing = expectedLevels.filter((level) => !counts.has(level));
      const extra = [...counts.keys()].filter((level) => !expectedSet.has(level)).sort((a, b) => a - b);
      if (missing.length > 0 || extra.length > 0) {
        throw new BufferTowerGeometryError(
          `缓存塔零件表与参数不一致：${family.label} `
            + `${missing.length > 0 ? `缺第 ${missing.join('、')} 层` : ''}`
            + `${extra.length > 0 ? `${missing.length > 0 ? '，' : ''}多出第 ${extra.join('、')} 层` : ''}`
            + `（参数 ${params.levels} 层 ⇒ 应有第 2~${params.levels} 层；整层丢件必须报错，不能靠别的件族同时 −1 自证）`
        );
      }
      const wrong = expectedLevels.filter((level) => counts.get(level) !== family.perLevel);
      if (wrong.length > 0) {
        throw new BufferTowerGeometryError(
          `缓存塔零件表自相矛盾：${family.label} 每层应 ${family.perLevel} 件，`
            + `第 ${wrong.map((level) => `${level} 层（${counts.get(level) ?? 0} 件）`).join('、')}不符`
        );
      }
    }
  }

  // 条件件（传动辊）：各层必须一致，且只能是 0 或 2（一条进一条出）
  const rollerCounts = countsByFamily.get('trayRoller') ?? new Map<number, number>();
  const rollerPerLevel = new Set(expectedLevels.map((level) => rollerCounts.get(level) ?? 0));
  const rollerBad = [...rollerPerLevel].filter((count) => count !== 0 && count !== 2);
  if (rollerPerLevel.size > 1 || rollerBad.length > 0) {
    throw new BufferTowerGeometryError(
      `缓存塔零件表自相矛盾：层传动辊应各层一致且为 0 或 2 件，实际各层件数 {${[...rollerPerLevel].join('、')}}`
    );
  }

  const trayCounts = countsByFamily.get('tray') ?? new Map<number, number>();
  const sensorCounts = countsByFamily.get('layerSensor') ?? new Map<number, number>();
  const transferLevels = params.config.transferLevel;
  const levelsFromGeometry = trayCounts.size + transferLevels;
  if (levelsFromGeometry !== params.levels) {
    throw new BufferTowerGeometryError(
      `缓存塔几何层数 ${levelsFromGeometry}（托板 ${trayCounts.size} 层 + 进出料位 ${transferLevels}）≠ 参数 ${params.levels} 层`
    );
  }
  const columnCount = parts.filter((part) => /^column-(fl|fr|bl|br)$/.test(part.id)).length;
  const towersFromGeometry = columnCount / 4;
  if (!Number.isSafeInteger(towersFromGeometry) || towersFromGeometry !== params.config.towers) {
    throw new BufferTowerGeometryError(
      `缓存塔立柱 ${columnCount} 根 ⇒ ${towersFromGeometry} 塔，与配置声明 ${params.config.towers} 塔不一致（4 根/塔）`
    );
  }
  const slotsPerLevelFromGeometry = trayCounts.get(2) ?? 0;
  const fromGeometry = levelsFromGeometry * slotsPerLevelFromGeometry * towersFromGeometry;
  const claimed = params.config.towers * params.config.slotsPerTower;
  if (fromGeometry !== claimed) {
    throw new BufferTowerGeometryError(
      `缓存塔零件表与容量声明不一致：${levelsFromGeometry} 层 × ${slotsPerLevelFromGeometry} 位/层 × ${towersFromGeometry} 塔`
        + ` = ${fromGeometry} ≠ 声明 ${claimed}（towers ${params.config.towers} × slotsPerTower ${params.config.slotsPerTower}）`
    );
  }
  return {
    fromGeometry,
    claimed,
    aligned: true,
    transferLevels,
    usableStorage: fromGeometry - towersFromGeometry * transferLevels,
    levelsFromGeometry,
    slotsPerLevelFromGeometry,
    towersFromGeometry,
    levels: params.levels,
    slotsPerLevel: params.slotsPerLevel,
    trayCount: trayCounts.size,
    sensorCount: sensorCounts.size,
    layerTrace: expectedLevels.map((level) => `第 ${level} 层：托板 1/托条 2/挡停 1/光电 1/辊 ${rollerCounts.get(level) ?? 0}`)
  };
}

/** 底层输送线参数对外复用（machine-geometry 需要一个 `ConveyorParams` 做映射）。 */
export function bufferTowerInboundParams(params: ResolvedBufferTowerParams) {
  return inboundConveyorParams(params);
}
