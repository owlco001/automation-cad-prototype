/**
 * 整机模型构建器注册表。
 *
 * 目的：智能体只看到一个工具 `build_machine_model`，机型差异由这里的映射决定；
 * 以后加链板线/滚筒线/转盘机只是加一条映射，不新增工具。
 *
 * 两种引擎：
 * - `parametric`：按尺寸生成参数化装配，交 build123d 内核布尔求并 + 逐件导出 STEP/STL，
 *   拿到真实体积/质量/包围盒（适合按尺寸驱动的整机，如皮带输送线）。
 * - `rules`：几何由 machine/geometry.ts 按「工位 + 机构」规则摆放（现有五类工艺走这条），
 *   速度快、带特征树，但模型是标准件外形占位，不进内核。
 */

import type { MachineProcess, ModelProcess } from './spec.ts';
import { DEFAULT_CONVEYOR, type ConveyorParams } from './conveyor-assembly.ts';
import {
  BUFFER_TOWER_INBOUND_LIMITS,
  BUFFER_TOWER_MAX_PITCH_MM,
  BUFFER_TOWER_PANEL_LIMITS,
  BUFFER_TOWER_PITCH_CLEARANCE_MM,
  BUFFER_TOWER_SECTION_LIMITS,
  MAX_BUFFER_TOWER_LEVELS,
  isBufferTowerConfig,
  normalizeBufferTowerConfig,
  type MachineBufferTowerConfig
} from './buffer-tower-assembly.ts';

export type ModelEngine = 'parametric' | 'rules';

export interface ModelParamSpec {
  name: string;
  label: string;
  /** 默认值（mm / 无量纲） */
  defaultValue: number;
  min: number;
  max: number;
  unit: string;
}

export interface ModelBuilder {
  process: ModelProcess;
  engine: ModelEngine;
  label: string;
  /** 该机型可调参数；工具描述与参数校验都用它 */
  params: ModelParamSpec[];
  /** rules 引擎暂无独立构建器时给出的替代指引 */
  hint?: string;
  /**
   * 参数越界时的处理：`clamp`（默认，输送线旧行为）或 `reject`（缓存塔）。
   * 塔必须 reject：16 层被静默改成 8 层画出来就是另一台机器。
   */
  rangePolicy?: 'clamp' | 'reject';
}

const CONVEYOR_PARAMS: ModelParamSpec[] = [
  { name: 'lengthMm', label: '线体总长', defaultValue: DEFAULT_CONVEYOR.lengthMm, min: 400, max: 12000, unit: 'mm' },
  { name: 'widthMm', label: '皮带有效宽度', defaultValue: DEFAULT_CONVEYOR.widthMm, min: 100, max: 1200, unit: 'mm' },
  { name: 'beltHeightMm', label: '皮带面高度', defaultValue: DEFAULT_CONVEYOR.beltHeightMm, min: 300, max: 1400, unit: 'mm' },
  { name: 'pulleyDiameterMm', label: '滚筒直径', defaultValue: DEFAULT_CONVEYOR.pulleyDiameterMm, min: 20, max: 200, unit: 'mm' },
  { name: 'beltThicknessMm', label: '皮带厚度', defaultValue: DEFAULT_CONVEYOR.beltThicknessMm, min: 1, max: 20, unit: 'mm' },
  { name: 'frameSectionMm', label: '型材截面', defaultValue: DEFAULT_CONVEYOR.frameSectionMm, min: 20, max: 100, unit: 'mm' },
  { name: 'layers', label: '缓存层数（1=普通线体，≥2=立体缓存）', defaultValue: DEFAULT_CONVEYOR.layers, min: 1, max: 8, unit: '层' },
  { name: 'layerPitchMm', label: '层间距', defaultValue: DEFAULT_CONVEYOR.layerPitchMm, min: 180, max: 900, unit: 'mm' },
  // 转向工位：0 = 不做；45/90/180 = 线体中段把工件就地旋转多少度
  { name: 'turnerAngleDeg', label: '转向角度（0=不做转向工位，90=旋转 90°）', defaultValue: DEFAULT_CONVEYOR.turnerAngleDeg, min: 0, max: 180, unit: '°' },
  // 顶升移载（直角移载）：板宽 > 0 才建移载单元（没板宽就没法算移载行程）。
  // 用板宽当开关而不是再加一个 0/1 开关：行程本来就是「板宽 + 结构间隙 + 余量」，
  // 没有板宽这个单元根本算不出来，给 0 就是「不做」。
  { name: 'transferPartWidthMm', label: '移载板宽（0=不做顶升移载；>0 建直角移载单元）', defaultValue: 0, min: 0, max: 1200, unit: 'mm' },
  { name: 'transferPartLengthMm', label: '移载板长（决定下游对接段宽度，0=按带宽推）', defaultValue: 0, min: 0, max: 4000, unit: 'mm' }
];

/**
 * 缓存塔参数（扁平前缀组）。
 *
 * 为什么不用嵌套对象：`normalizeModelParams` / 工具 schema / 回执都是**扁平数字表**，
 * 塞一棵三层树进去会让「越界怎么报、未知键怎么回」全部失控。这里只保留
 * `bufferTowerGeometry` 白名单里的几何键；容量身份（towers / slotsPerTower）由
 * levels × slotsPerLevel(=1) 派生，**不给入参**——给了就有人拿它去骗容量算式。
 *
 * min/max 直接引用 `buffer-tower-assembly` 的尺寸上下限：一处声明，两处判定不许漂移。
 * 注意这组区间只是**单字段**边界；跨字段不变量（层距 ≥ 板厚+130、进料 ≥ 板长+120、
 * levels×slotsPerLevel=slotsPerTower）由 `bufferTowerParamsFromConfig` 判，同样 fail-loud。
 */
export const BUFFER_TOWER_PARAMS: ModelParamSpec[] = [
  { name: 'levels', label: '塔层数（含第 1 层进出料，≥2）', defaultValue: 16, min: 2, max: MAX_BUFFER_TOWER_LEVELS, unit: '层' },
  { name: 'layerPitchMm', label: '层距', defaultValue: 180, min: BUFFER_TOWER_PANEL_LIMITS.thicknessMm[0] + BUFFER_TOWER_PITCH_CLEARANCE_MM, max: BUFFER_TOWER_MAX_PITCH_MM, unit: 'mm' },
  { name: 'panelLengthMm', label: '板材长', defaultValue: 2278, min: BUFFER_TOWER_PANEL_LIMITS.lengthMm[0], max: BUFFER_TOWER_PANEL_LIMITS.lengthMm[1], unit: 'mm' },
  { name: 'panelWidthMm', label: '板材宽', defaultValue: 1134, min: BUFFER_TOWER_PANEL_LIMITS.widthMm[0], max: BUFFER_TOWER_PANEL_LIMITS.widthMm[1], unit: 'mm' },
  { name: 'panelThicknessMm', label: '板材厚', defaultValue: 35, min: BUFFER_TOWER_PANEL_LIMITS.thicknessMm[0], max: BUFFER_TOWER_PANEL_LIMITS.thicknessMm[1], unit: 'mm' },
  { name: 'panelMassKg', label: '单板质量（0=未称重）', defaultValue: 32, min: BUFFER_TOWER_PANEL_LIMITS.massKg[0], max: BUFFER_TOWER_PANEL_LIMITS.massKg[1], unit: 'kg' },
  { name: 'inboundLengthMm', label: '底层进料线长', defaultValue: 2400, min: BUFFER_TOWER_INBOUND_LIMITS.lengthMm[0], max: BUFFER_TOWER_INBOUND_LIMITS.lengthMm[1], unit: 'mm' },
  { name: 'inboundWidthMm', label: '底层进料线宽', defaultValue: 1200, min: BUFFER_TOWER_INBOUND_LIMITS.widthMm[0], max: BUFFER_TOWER_INBOUND_LIMITS.widthMm[1], unit: 'mm' },
  { name: 'beltHeightMm', label: '进料皮带面高', defaultValue: 900, min: BUFFER_TOWER_INBOUND_LIMITS.beltHeightMm[0], max: BUFFER_TOWER_INBOUND_LIMITS.beltHeightMm[1], unit: 'mm' },
  { name: 'sectionMm', label: '底层型材截面', defaultValue: 40, min: BUFFER_TOWER_SECTION_LIMITS.sectionMm[0], max: BUFFER_TOWER_SECTION_LIMITS.sectionMm[1], unit: 'mm' }
];

export const MODEL_BUILDERS: Partial<Record<ModelProcess, ModelBuilder>> = {
  conveyor: {
    process: 'conveyor',
    engine: 'parametric',
    label: '输送线 / 立体缓存（参数化内核：逐件真实零件 → STEP/STL；layers≥2 出多层缓存）',
    params: CONVEYOR_PARAMS
  },
  /**
   * 缓存塔：与 `conveyor.layers` 是两套语义（塔的物理层数 ≠ 输送线的多层缓存）。
   * 几何走 `buffer-tower-assembly`（146 件 / 16 层），不复制 `conveyor-assembly` 的
   * layers 分支，也不放宽它 1–8 的上限。
   */
  'buffer-tower': {
    process: 'buffer-tower',
    engine: 'parametric',
    label: '缓存塔 / 立体库（塔身建造器：逐层托架 + 升降轴 → STEP/STL；levels≥2，与输送线 layers 语义无关）',
    params: BUFFER_TOWER_PARAMS,
    rangePolicy: 'reject'
  }
};

/** 只做规则几何、没有参数化构建器的工艺：给出替代入口，避免工具假装能建。 */
export const RULES_ONLY_PROCESSES: MachineProcess[] = ['screw', 'dispense', 'assembly', 'inspection', 'packaging'];

export function pickModelBuilder(process: string | null | undefined): ModelBuilder | null {
  if (!process) return null;
  // 塔是 ModelProcess 而不是 MachineProcess（它没有 synth 模板/节拍基数），
  // 所以索引也用 ModelProcess：写成 MachineProcess 会让人以为塔是普通工艺。
  return MODEL_BUILDERS[process as ModelProcess] ?? null;
}

export interface ModelDispatchRequest {
  process?: unknown;
  /** 扁平参数表（输送线用；塔只在没有 design/config 时才用它派生） */
  params?: unknown;
  design?: unknown;
  config?: unknown;
}

/**
 * 整机建模的**统一分派判据**（命令层 / 渲染层 / 几何层同一份）。
 *
 * 规则（每条都对应过一个真实故障）：
 * 0. **形状先判**：`design`/`config`/`design.config`/`params` 只要给了就必须是**非数组对象**。
 *    以前 `design:[1,2]` 在脚本 API 侧一路 `ok:true` → 出 29 件输送线（严格模式只数件数，
 *    不数「用户给的是不是一台机器」）；数组/字符串/数字没有任何一条能得到正确模型。
 *    `process` 同口径：给了就必须是**非空字符串**（`process:123` / `{}` / `'   '` / `null`
 *    以前被静默当「没写」→ 按 conveyor 建 29 件并 `ok:true`），见下方规则 P。
 * 1. 塔的判别字段只有 `config.bufferTower.kind === 'tower'`（见 `isBufferTowerConfig`），
 *    不按 `formId`、不按「参数里有没有 panel」猜；
 * 2. `design` / `config` 里是塔 → **必须走塔**，哪怕调用方没写 `process`：默认值
 *    `'conveyor'` 不是「用户说要输送线」，拿它把塔降级成 29 件底层线正是要消灭的静默错；
 * 3. 调用方**显式**写了非塔 `process` 又给了塔 design → 冲突，显式拒（两个来源不一致时
 *    任选一个都会「画一套、落盘一套」）；
 * 4. 显式写了塔 `process` 但 design/config 里没有 `bufferTower` → 显式拒（不从 formId 猜）；
 * 5. `bufferTower` 键**存在但不是塔**（`kind` 拼成 `'Tower'`/漏写/写成别的机型）→ 显式拒。
 *    「存在」永远不是「当成没有」：同一份 config 在 `apply_machine_design` 侧
 *    （`normalizeBufferTowerConfig`）会直接报「kind 必须是 'tower'」，到这里却静默降级成
 *    29 件底层输送线并把 `ok:true` 回给智能体 —— 用户看到的是一台「参数没生效但看不出来」的线体。
 * 6. **机型必须真的有生成器**：`process` 只能落在 `MODEL_BUILDERS` 里（conveyor /
 *    buffer-tower）。以前 `process:'screw'` 一路 ok 到渲染层才报 `NO_PARAMETRIC_BUILDER`，
 *    命令层看起来「接受了」；现在同一份判据直接拒，bridge 0 次。
 * 7. **`design` 与 `config` 只能二选一**（config 是 design.config 的简写）：两个都给时
 *    两份配置都可能被读，谁赢都说不清 —— 命令层早就拒，这里补上脚本 API 这条缝。
 * 8. **塔 + `params` 双源 → 拒**：塔几何只认 `design.config.bufferTower`/`config.bufferTower`，
 *    `params` 里的键（无论塔参数还是 lengthMm 这类输送线参数）都会被静默丢掉。
 * 9. **非塔 design/config → 拒**：现在的整机建模器只把 `design/config` 当塔的来源；
 *    输送线参数只从 `params` 读。以前 `process:'conveyor' + config.conveyor{lengthMm:6000}`
 *    实测 `ok:true` 但建的是默认 2000×300 —— `config.conveyor` 被完全忽略且没有任何提示。
 *    要么拒（现在这样），要么真的读进来；没有第三条路。
 */
export type ModelDispatch =
  | { ok: true; process: ModelProcess; tower: boolean; explicitProcess: boolean }
  | { ok: false; message: string };

/** 形状回显：错误消息里不能只说「必须是对象」，要让人知道收到的是什么。 */
function describeShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `数组(${value.length} 项)`;
  return typeof value;
}

/** `bufferTower` 键存在且不是 null/undefined（显式 null 当「没给」，与命令层口径一致）。 */
function hasBufferTowerBlock(config: Record<string, unknown> | null): boolean {
  if (!config || !Object.prototype.hasOwnProperty.call(config, 'bufferTower')) return false;
  return config.bufferTower !== undefined && config.bufferTower !== null;
}

export function resolveModelDispatch(request: ModelDispatchRequest): ModelDispatch {
  // ---- 规则 P：`process` 只要给了，就必须是非空字符串 ----
  // 以前 `typeof request.process === 'string' ? … : ''` 把 `process:123` / `process:{}` /
  // `process:'   '` 一律当「没写 process」→ 静默按 conveyor 建 29 件底层线并回 ok:true。
  // design/config/params 都做了形状先判，process 是漏掉的那一个；命令层、渲染层、脚本
  // API 共用这份判据，所以在这里一次收口（工具层 schema 侧同样拒，两边口径一致）。
  if (request.process !== undefined) {
    const ok = typeof request.process === 'string' && request.process.trim().length > 0;
    if (!ok) {
      const received = request.process === null
        ? 'null'
        : (typeof request.process === 'string'
          ? `空白字符串 ${JSON.stringify(request.process)}`
          : describeShape(request.process));
      return {
        ok: false,
        message: `process 必须是非空字符串（机型名，如 conveyor / buffer-tower）：收到 ${received}；`
          + '非字符串/空白会被当成「没写 process」静默按 conveyor 建 29 件底层线（要按缺省走直接省略这个键）'
      };
    }
  }
  const rawProcess = typeof request.process === 'string' ? request.process.trim() : '';
  const explicitProcess = rawProcess.length > 0;
  const declared = explicitProcess ? rawProcess : 'conveyor';

  // ---- 规则 0：形状（null/undefined 当没给；给了就必须是 record）----
  const designProvided = request.design !== undefined && request.design !== null;
  const configProvided = request.config !== undefined && request.config !== null;
  if (designProvided && !isRecordValue(request.design)) {
    return {
      ok: false,
      message: `design 必须是非数组对象（design_machine 返回的完整方案）：收到 ${describeShape(request.design)}；`
        + '数组/字符串会被当成「没有 design」静默出默认输送线'
    };
  }
  if (configProvided && !isRecordValue(request.config)) {
    return {
      ok: false,
      message: `config 必须是非数组对象（机型配置，塔块在 config.bufferTower）：收到 ${describeShape(request.config)}`
    };
  }
  if (designProvided) {
    const rawDesignConfig = (request.design as Record<string, unknown>).config;
    if (rawDesignConfig !== undefined && rawDesignConfig !== null && !isRecordValue(rawDesignConfig)) {
      return {
        ok: false,
        message: `design.config 必须是非数组对象（机型配置）：收到 ${describeShape(rawDesignConfig)}`
      };
    }
  }
  if (request.params !== undefined && request.params !== null && !isRecordValue(request.params)) {
    return {
      ok: false,
      message: `params 必须是非数组对象（扁平参数表，如 {lengthMm:2400}）：收到 ${describeShape(request.params)}`
    };
  }
  if (designProvided && configProvided) {
    return {
      ok: false,
      message: 'design 与 config 只能二选一（config 是「只有机型配置」的简写）：两个都给时无法判定以哪份为准'
    };
  }

  // ---- 规则 6：机型必须有生成器（不只「不是塔」就算过）----
  const builder = pickModelBuilder(declared);
  if (!builder) {
    const rulesHint = RULES_ONLY_PROCESSES.includes(declared as MachineProcess)
      ? '；该工艺属于「工位 + 机构」规则几何，请用 apply_machine_design'
      : '';
    return {
      ok: false,
      message: `「${declared}」暂无参数化整机生成器${rulesHint}；本工具只支持 ${Object.keys(MODEL_BUILDERS).join('、')}`
        + '（缓存塔由 config.bufferTower.kind=\'tower\' 派生，不靠 process 值猜）'
    };
  }

  const designConfig = isRecordValue(request.design) && isRecordValue((request.design as Record<string, unknown>).config)
    ? (request.design as Record<string, unknown>).config as Record<string, unknown>
    : null;
  const designTower = isBufferTowerConfig(designConfig?.bufferTower);
  const bareConfig = isRecordValue(request.config) ? request.config : null;
  const bareConfigTower = isBufferTowerConfig(bareConfig?.bufferTower);
  const sourceTower = designTower || bareConfigTower;
  const sourceLabel = designTower ? 'design.config.bufferTower' : 'config.bufferTower';
  // null 一律当「没给」：显式 null 不能算「给了 design」而触发非塔拒绝。
  const hasDesignSource = designProvided || configProvided;

  if (!sourceTower) {
    const stray = hasBufferTowerBlock(designConfig) ? 'design.config.bufferTower' : (hasBufferTowerBlock(bareConfig) ? 'config.bufferTower' : null);
    if (stray) {
      const block = (stray.startsWith('design') ? designConfig : bareConfig) as Record<string, unknown>;
      const kind = isRecordValue(block?.bufferTower) ? ((block.bufferTower as Record<string, unknown>).kind ?? null) : null;
      return {
        ok: false,
        message: `${stray} 存在但 kind !== 'tower'（收到 ${JSON.stringify(kind)}）：`
          + '塔块要么完整成立（kind="tower"）、要么整块不要给；'
          + '按「没有塔」静默降级会建出 29 件底层输送线，不是这台缓存塔'
      };
    }
  }

  if (sourceTower && explicitProcess && declared !== 'buffer-tower') {
    return {
      ok: false,
      message: `process=${declared} 与 ${sourceLabel}.kind='tower' 冲突：塔几何只能按 process='buffer-tower' 建，`
        + '或去掉 process 让塔配置决定；按输送线建出来是 29 件底层线，不是这台塔'
    };
  }
  if (!sourceTower && hasDesignSource && declared === 'buffer-tower') {
    return {
      ok: false,
      message: 'design.config.bufferTower 缺失：缓存塔几何只能由它派生（不从 formId/conveyor 猜）'
    };
  }
  const tower = declared === 'buffer-tower' || sourceTower;

  // ---- 规则 8：塔 + params 双源（params 会被静默丢掉）----
  const paramsGiven = isRecordValue(request.params) && Object.keys(request.params).length > 0;
  if (tower && sourceTower && paramsGiven) {
    const keys = Object.keys(request.params as Record<string, unknown>);
    return {
      ok: false,
      message: `params（${keys.join('、')}）与 ${sourceLabel} 同时给了：塔几何只认 ${sourceLabel}，`
        + '这些参数会被静默丢掉（结果就是「画一套、落盘一套」）；删掉 params，或只保留一个来源'
    };
  }

  // ---- 规则 9：非塔 design/config 一律显式拒（否则 config.conveyor 被静默忽略）----
  if (!tower && hasDesignSource) {
    const conveyorBlock = isRecordValue(designConfig?.conveyor) ? designConfig?.conveyor : (isRecordValue(bareConfig?.conveyor) ? bareConfig?.conveyor : null);
    return {
      ok: false,
      message: conveyorBlock
        ? 'design/config 里的 config.conveyor 不会被整机建模器读取：输送线尺寸目前只从 params 取'
          + '（lengthMm/widthMm/beltHeightMm/layers…）。静默放行会建出默认 2000×300 的 29 件底层线，'
          + '与 design 里写的尺寸不一致；请把尺寸放进 params'
        : 'design/config 里没有塔块（config.bufferTower.kind=\'tower\'）：整机建模器不从 design 猜机型，'
          + '非塔机型请只给 params；按「没有塔」静默放行会建出默认 2000×300 的 29 件线'
    };
  }

  return { ok: true, process: (tower ? 'buffer-tower' : declared) as ModelProcess, tower, explicitProcess };
}

export interface NormalizedModelParams {
  ok: boolean;
  /** 夹紧/补默认后的参数（仅 build 支持的键） */
  params: Record<string, number>;
  message?: string;
  /** 被忽略的未知键，回给调用方而不是静默丢弃 */
  ignored: string[];
}

/** 参数校验：未知键要报出来；数字越界夹到区间并在 message 里说明。 */
export function normalizeModelParams(builder: ModelBuilder, input: unknown): NormalizedModelParams {
  const source = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const params: Record<string, number> = {};
  const ignored: string[] = [];
  const notes: string[] = [];
  const known = new Set(builder.params.map((spec) => spec.name));
  const strict = builder.rangePolicy === 'reject';

  for (const key of Object.keys(source)) {
    if (!known.has(key)) ignored.push(key);
  }
  // 严格机型：未知键不是「忽略并提示」，而是拒绝。塔的容量身份（towers/slotsPerTower）
  // 一旦从参数进来就能绕过 levels×slotsPerLevel 算式，把 16 位说成 8 位。
  if (strict && ignored.length > 0) {
    return {
      ok: false,
      params: {},
      ignored,
      message: `「${builder.process}」不接受参数 ${ignored.join('、')}：可用参数只有 ${[...known].join('、')}`
    };
  }

  for (const spec of builder.params) {
    const raw = source[spec.name];
    if (raw === undefined || raw === null) {
      params[spec.name] = spec.defaultValue;
      continue;
    }
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(value)) {
      return { ok: false, params: {}, ignored, message: `${spec.label}（${spec.name}）必须是数字` };
    }
    if (value < spec.min || value > spec.max) {
      // 严格机型 fail-loud：不夹紧。16 层被静默改成 8 层，画出来是另一台机器。
      if (strict) {
        return {
          ok: false,
          params: {},
          ignored,
          message: `${spec.label}（${spec.name}）${value} ${spec.unit} 超出 ${spec.min}~${spec.max}：`
            + `「${builder.process}」参数不夹紧（夹紧会得到一架外形相似、容量不同的机器），请显式改参数`
        };
      }
      const clamped = Math.min(spec.max, Math.max(spec.min, value));
      notes.push(`${spec.label} ${value} ${spec.unit} 超出 ${spec.min}~${spec.max}，按 ${clamped} 处理`);
      params[spec.name] = clamped;
      continue;
    }
    params[spec.name] = value;
  }

  if (ignored.length > 0) notes.push(`忽略未知参数：${ignored.join('、')}`);
  return {
    ok: true,
    params,
    ignored,
    ...(notes.length > 0 ? { message: notes.join('；') } : {})
  };
}

/** 渲染端把参数喂给零件生成器时用的类型收窄。 */
export function toConveyorParams(params: Record<string, number>): ConveyorParams {
  return {
    lengthMm: params.lengthMm ?? DEFAULT_CONVEYOR.lengthMm,
    widthMm: params.widthMm ?? DEFAULT_CONVEYOR.widthMm,
    beltHeightMm: params.beltHeightMm ?? DEFAULT_CONVEYOR.beltHeightMm,
    pulleyDiameterMm: params.pulleyDiameterMm ?? DEFAULT_CONVEYOR.pulleyDiameterMm,
    beltThicknessMm: params.beltThicknessMm ?? DEFAULT_CONVEYOR.beltThicknessMm,
    frameSectionMm: params.frameSectionMm ?? DEFAULT_CONVEYOR.frameSectionMm,
    layers: params.layers ?? DEFAULT_CONVEYOR.layers,
    layerPitchMm: params.layerPitchMm ?? DEFAULT_CONVEYOR.layerPitchMm,
    turnerAngleDeg: params.turnerAngleDeg ?? DEFAULT_CONVEYOR.turnerAngleDeg,
    transferPartWidthMm: params.transferPartWidthMm ?? 0,
    transferPartLengthMm: params.transferPartLengthMm ?? 0
  };
}

/* ------------------------------------------------------------------ *
 * 缓存塔（buffer-tower）：扁平参数 ⇄ config.bufferTower
 * ------------------------------------------------------------------ */

/** 塔参数键（与 `BUFFER_TOWER_PARAMS` 同源，两处清单不许各自维护）。 */
const BUFFER_TOWER_PARAM_NAMES = new Set(BUFFER_TOWER_PARAMS.map((spec) => spec.name));

function towerParamOrDefault(params: Record<string, number>, name: string): number {
  const value = params[name];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return BUFFER_TOWER_PARAMS.find((spec) => spec.name === name)?.defaultValue ?? 0;
}

/**
 * 扁平参数 → `config.bufferTower`（只做**形状**装配，不判跨字段不变量）。
 *
 * 容量身份在这里派生而不是收参数：`slotsPerTower = levels × slotsPerLevel(1)`。
 * 想表达「每层 2 位」就必须来改这段代码（本期 `NOT_IMPLEMENTED`），
 * 而不是传一个 `slotsPerTower=32` 让算式自己骗自己。
 * 真正的判定在 `bufferTowerParamsFromConfig`（同一份 fail-loud 不变量），这里不重复。
 */
export function toBufferTowerConfig(params: Record<string, number>): MachineBufferTowerConfig {
  const levels = Math.round(towerParamOrDefault(params, 'levels'));
  return {
    kind: 'tower',
    towers: 1,
    slotsPerTower: levels,
    levels,
    slotsPerLevel: 1,
    layerPitchMm: towerParamOrDefault(params, 'layerPitchMm'),
    panel: {
      lengthMm: towerParamOrDefault(params, 'panelLengthMm'),
      widthMm: towerParamOrDefault(params, 'panelWidthMm'),
      thicknessMm: towerParamOrDefault(params, 'panelThicknessMm'),
      massKg: towerParamOrDefault(params, 'panelMassKg')
    },
    inbound: {
      lengthMm: towerParamOrDefault(params, 'inboundLengthMm'),
      widthMm: towerParamOrDefault(params, 'inboundWidthMm'),
      beltHeightMm: towerParamOrDefault(params, 'beltHeightMm')
    },
    frame: { material: 'AL6063', sectionMm: towerParamOrDefault(params, 'sectionMm') },
    transferLevel: 1
  };
}

/**
 * `config.bufferTower` → 扁平参数回声。
 *
 * 用途只有两个：工程记录的 `params`（只收数字，见 `projects.ts`）与回执里的参数表。
 * **它不是几何来源**——几何只认 config（`bufferTowerParamsFromConfig`），
 * 否则「记录里 16 层、画出来 8 层」这种分叉会重新长出来。
 */
export function bufferTowerModelParams(config: MachineBufferTowerConfig): Record<string, number> {
  return {
    levels: config.levels,
    layerPitchMm: config.layerPitchMm,
    panelLengthMm: config.panel.lengthMm,
    panelWidthMm: config.panel.widthMm,
    panelThicknessMm: config.panel.thicknessMm,
    panelMassKg: config.panel.massKg,
    inboundLengthMm: config.inbound.lengthMm,
    inboundWidthMm: config.inbound.widthMm,
    beltHeightMm: config.inbound.beltHeightMm,
    sectionMm: config.frame.sectionMm
  };
}

/**
 * 由塔配置合成一份**最小可落盘** design。
 *
 * 为什么必须合成而不是「参数存不下来就算」：`projects.save` 的 `params` 只收数字，
 * `panel/inbound/frame` 是三层对象，走 params 会被静默过滤掉 —— 重开工程只剩
 * `levels/layerPitchMm`，用户以为参数在、其实几何参数已经丢了。
 *
 * 字段给到刚好能过 `validateMachineDesign`：塔的第 1 层就是那条输送线，动作在驱动
 * 电机上，所以 `actuators: []`；`conveyor` 故意**不给**——`bufferTower` 与
 * `conveyor.layers>1` 并存是配置层明令禁止的（`BUFFER_TOWER_INVALID`）。
 */
export function buildBufferTowerDesign(config: MachineBufferTowerConfig): Record<string, unknown> {
  return {
    config: {
      id: `buffer-tower-${config.levels}l`,
      name: `缓存塔 ${config.levels} 层`,
      stations: ['进出料'],
      actuators: [],
      sensors: [],
      bufferTower: config
    }
  };
}

export interface BufferTowerModelRequest {
  params?: unknown;
  config?: unknown;
  design?: unknown;
}

/**
 * 解析结果。判别式 union 而不是全可选字段：`ok:true` 时 `config/design` 必然存在，
 * 调用方不需要 `!` 断言（断言正是「参数丢了却照画」那类 bug 的温床）。
 */
export type BufferTowerModelResolution =
  | {
    ok: true;
    /** 权威塔配置（形状已归一化；跨字段不变量由 bufferTowerParamsFromConfig 判） */
    config: MachineBufferTowerConfig;
    /** 落盘 design：`design.config.bufferTower` 与 config 是同一份 */
    design: Record<string, unknown>;
    /** 扁平参数回声（写进工程记录 / 回执） */
    params: Record<string, number>;
    /** 参数从哪来：调用方的 design/config，还是扁平参数 */
    source: 'design' | 'params';
  }
  | { ok: false; message: string; params: Record<string, number> };

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 形状归一（只补缺省，不判不变量）——与塔身建造器共用同一套规则。 */
function towerConfigFromUnknown(raw: unknown, where: string): MachineBufferTowerConfig | string {
  if (!isRecordValue(raw)) return `${where} 必须是对象`;
  if (raw.kind !== 'tower') return `${where}.kind 必须是 'tower'（收到 ${JSON.stringify(raw.kind)}）`;
  // 形状错（缺 panel/inbound、字段不是数字）在这里就要现眼，不能等到几何出口
  try {
    return normalizeBufferTowerConfig(raw);
  } catch (error) {
    if (error instanceof Error) return `${where}：${error.message}`;
    throw error;
  }
}

/**
 * 解析 `build_machine_model` 的塔入参：`design.config.bufferTower`（权威）或扁平参数（合成）。
 *
 * 三条硬规则：
 * 1. 两个来源**不许同时**给塔参数——「参数一条、落盘一条」必然分叉；
 * 2. 扁平参数走严格校验（`rangePolicy: 'reject'`），越界/未知键直接拒，不夹紧；
 * 3. 不给 design 时**合成**一份最小 design，保证 `panel/inbound/frame` 能落盘。
 *
 * 返回 `ok:false` 而不是抛错：这条函数要给渲染层回 `INVALID_ARGUMENT`，不该让异常
 * 穿过 `build_machine_model` 变成「建模失败」。
 */
export function resolveBufferTowerModelInput(request: BufferTowerModelRequest): BufferTowerModelResolution {
  const builder = MODEL_BUILDERS['buffer-tower'];
  if (!builder) return { ok: false, message: '注册表缺少 buffer-tower 构建器（内部缺陷）', params: {} };
  const rawParams = isRecordValue(request.params) ? request.params : {};
  const designRaw = request.design !== undefined
    ? request.design
    : (request.config !== undefined ? { config: request.config } : undefined);

  if (designRaw !== undefined) {
    if (!isRecordValue(designRaw) || !isRecordValue(designRaw.config)) {
      return { ok: false, message: 'design/config 必须是对象，且 design.config 必须是机型配置对象', params: {} };
    }
    const rawTower = designRaw.config.bufferTower;
    if (rawTower === undefined || rawTower === null) {
      return {
        ok: false,
        message: 'design.config.bufferTower 缺失：缓存塔几何只能由它派生（不从 formId/conveyor 猜）',
        params: {}
      };
    }
    const conflicting = Object.keys(rawParams).filter((key) => BUFFER_TOWER_PARAM_NAMES.has(key));
    if (conflicting.length > 0) {
      return {
        ok: false,
        message: `params 与 design.config.bufferTower 同时给了塔参数（${conflicting.join('、')}）：只能有一个来源，`
          + '否则「画出来一套、落盘一套」',
        params: {}
      };
    }
    const parsed = towerConfigFromUnknown(rawTower, 'design.config.bufferTower');
    if (typeof parsed === 'string') return { ok: false, message: parsed, params: {} };
    return {
      ok: true,
      config: parsed,
      design: designRaw,
      params: bufferTowerModelParams(parsed),
      source: 'design'
    };
  }

  const normalized = normalizeModelParams(builder, rawParams);
  // `NormalizedModelParams.message` 是可选（成功分支没有它），而失败分支要求 string：
  // 判定失败时 normalizeModelParams 一定给了 message，但类型上没保证，这里兜一个常量
  // 而不是用 `!` 断言（断言正是「参数丢了却照画」那类 bug 的温床）。
  if (!normalized.ok) return { ok: false, message: normalized.message ?? '缓存塔参数无效', params: {} };
  const config = toBufferTowerConfig(normalized.params);
  return {
    ok: true,
    config,
    design: buildBufferTowerDesign(config),
    params: normalized.params,
    source: 'params'
  };
}
