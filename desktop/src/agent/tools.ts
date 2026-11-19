import type { PackRegistry } from '../packs/registry';
import type { ComponentPart } from '../shared/types';
import type { CommandHistoryEntry, CommandResult } from './commands';
import { resolvePartReference } from './placement.ts';
import { listResult } from './trim.ts';
import { checkExportTargetPath } from './policy.ts';
import type { PlcGenConfig } from '../plcgen/types.ts';
import { summarizeVerification, verifyGenerated, type VerifyOptions } from '../plcgen/verify.ts';
import { searchDocs } from './kb/search.ts';
import { analyzeBufferCapacity, type BufferCapacityInput } from '../machine/buffer-capacity.ts';
import { MAX_BUFFER_SLOTS, bufferQueueIo, createBufferQueue, type BufferTowerConfig } from '../machine/buffer-tower.ts';
import { createBufferControlMemory, stepBufferControl } from '../machine/buffer-control.ts';
import { mapBufferIoSignals } from '../machine/buffer-io.ts';
import { buildBufferIoMapDraft, validateBufferIoMapDraft } from '../machine/buffer-io-map.ts';
import {
  DEFAULT_NOTE_CYCLE,
  DEFAULT_NOTE_STATIONS,
  parseMachineBrief,
  MACHINE_STATIONS_MAX,
  MACHINE_STATIONS_MIN
} from '../machine/spec.ts';
import { summarizeMachineDesign } from '../machine/synth.ts';
import { mapMachineBom } from '../machine/bom-map.ts';
import { estimatePower } from '../machine/power.ts';
import { readMachinePricing } from '../../electron/pricing.ts';
import { completeDesign } from '../design/synthesis.ts';
import { validatePricebook, type Pricebook } from '../cost/pricebook.ts';
import { buildClarify } from '../machine/clarify.ts';
import { summarizeGeometry } from '../machine/geometry.ts';
import { partWorldBounds, resolveMachineGeometry, type ResolvedMachineGeometry } from '../machine/machine-geometry.ts';
import { buildConveyorParts, conveyorEnvelope, type ConveyorPart } from '../machine/conveyor-assembly.ts';
import {
  BufferTowerConfigError,
  BufferTowerGeometryError,
  bufferTowerInboundParams,
  bufferTowerParamsFromConfig,
  bufferTowerSlots,
  buildBufferTowerParts,
  type MachineBufferTowerConfig,
  type ResolvedBufferTowerParams
} from '../machine/buffer-tower-assembly.ts';
import { validateMachineConfig } from '../commission/machine-config.ts';
import { AGENT_TOOL_MODULES, moduleDisabledResult, moduleIsEnabled, type ModuleEnabledReader } from '../modules/tool-gates.ts';
import { describeRenderStats, normalizeRenderStats } from '../shared/render-stats.ts';

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>): Promise<unknown>;
}

export interface AgentToolSummary {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AgentToolsOptions {
  /** userData 根目录；读取 machine-pricing.json 用。 */
  userDataRoot?: string;
  /** 主进程注入的内置价格簿读取器。 */
  loadBuiltinPricebook?: () => unknown;
  /** 主进程的可选模块状态镜像；未就绪或状态读取失败时 PLC 能力失败关闭。 */
  isModuleEnabled?: ModuleEnabledReader;
  /** 主进程缓存的渲染指标；桌面内由 orbit 上报，独立 MCP 进程返回不可用。 */
  getRenderStats?: () => unknown;
}

export interface AgentCommandExecutor {
  execute(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<CommandResult>;
  undoLast(signal?: AbortSignal): Promise<CommandResult>;
  history?(): CommandHistoryEntry[];
  /**
   * 写后自动验证通道（只读 `validate_machine_design`）。
   *
   * AgentSession 在 apply_machine_design / repair_plc_config / run_plc_generate 成功后
   * 调它做机制层复查。主进程用命令总线实现；没有实现的执行器不会附 `verification`
   * （如实记 ok:null，不伪造「已验证」）。
   */
  validateMachineDesign?(signal?: AbortSignal): Promise<CommandResult>;
}

const COMPONENT_FILTER_SCHEMA = {
  type: 'object',
  properties: {
    q: { type: 'string', description: '全文搜索词' },
    category: { type: 'string', description: '类别精确筛选' },
    packId: { type: 'string', description: '数据包 id 筛选' }
  },
  additionalProperties: false
};

const EMPTY_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false
};

const CAPTURE_VIEW_SCHEMA = {
  type: 'object',
  properties: {
    view: {
      type: 'string',
      enum: ['3d', 'linkage', 'library', 'exports'],
      description: '要截的界面：3d=3D 视口，linkage=联调抽屉（3D 联动），library=机型库抽屉，exports=导出菜单；默认 3d',
      default: '3d'
    },
    width: { type: 'integer', minimum: 320, maximum: 3840, description: '截图宽度（像素），默认 1600', default: 1600 },
    height: { type: 'integer', minimum: 240, maximum: 2160, description: '截图高度（像素），默认 1000', default: 1000 },
    region: {
      type: 'object',
      description:
        '只截一块局部（**原图像素坐标，原点在图像左上**；实际可用范围以返回的 sourceSize 为准 —— 高 DPI 屏比 1600x1000 大）。方案卡小字、表格数值、状态标签读不清时用它放大：裁剪先于缩放，越界按真实图像尺寸夹紧并在返回里给 clamped/region/sourceSize',
      properties: {
        x: { type: 'integer', description: '左上角 x（原图像素，>=0；上界为 sourceSize.w），默认 0' },
        y: { type: 'integer', description: '左上角 y（原图像素，>=0；上界为 sourceSize.h），默认 0' },
        w: { type: 'integer', minimum: 32, maximum: 3840, description: '宽度（原图像素，至少 32；超过 sourceSize.w 会被夹紧）' },
        h: { type: 'integer', minimum: 32, maximum: 2160, description: '高度（原图像素，至少 32；超过 sourceSize.h 会被夹紧）' }
      },
      required: ['w', 'h'],
      additionalProperties: false
    },
    scale: {
      type: 'number',
      minimum: 0.5,
      maximum: 3,
      description: '裁出局部后的放大倍数（0.5–3，默认 1；返回里的 scale 是实际生效倍数，放大后最多 400 万像素）；最终仍按长边 <=1024 / <=400 KB 回灌',
      default: 1
    }
  },
  additionalProperties: false
};

const INTERFERENCE_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    states: {
      type: 'array',
      items: { type: 'string', enum: ['rest', 'lift', 'sweep', 'push'] },
      description:
        '要查的位姿：rest=静态位姿，lift=顶升到位，sweep=按 10 mm 逐步顶升到行程，'
        + 'push=顶升移载「顶升到位 + 沿 +Y 推出到位」的复合位姿。不传=旧行为（只查当前场景静态位姿）'
    },
    requirePanel: {
      type: 'boolean',
      description:
        '要求校验板承托 / 升降通道（只对 states 有意义）：true 时启用严格输入校验（缺 states、无板、非缓存塔均 INVALID_ARGUMENT）；缓存塔本来就会回 panelSupport / panelFeasibility / panelChannelNote（只读诊断字段），不是此标志打开的字段开关；'
        + '几何里没有板占位体、或机型不是缓存塔 → INVALID_ARGUMENT（不做「查不到 → 绿」）。'
        + '口径边界（生产缓存塔）：几何**包含真实板**（workpiece-plate 进 geometry.parts、参与 rest/lift/sweep 的 AABB），'
        + '因此 panelSupport/panelFeasibility 的 mode 可以是 verified —— verified 只说明「行表来自几何 + 碰撞集里有同一工件身份的这块板（含朝向）」，'
        + '不是可行性结论、也不是承载认证：该塔 rest 承托 unsupported（单条整带）、carried diagnostic-only（板不随塔轴移动、位移缺失）、'
        + 'feasible=false，blockers 为 load-passes-shelf + stroke-shortfall。'
        + '碰撞集判定认的是**同一件成员**：同 id + role=workpiece + box 尺寸/中心在 ±EPS 内一致 + rotationZDeg 有限且与占位体周期等价，缺一即不算 —— '
        + 'id 相同但 role/尺寸/中心/朝向不符的件不是同一件成员，不计入碰撞集（只同 id 不够）。行表来自调用方时也仍是 diagnostic-only。'
        + '该字段只给几何诊断读数，不是结构验收：不要据此对外称可落地，也不要当结构结论引用。'
    }
  },
  additionalProperties: false
};

const SUGGEST_KINEMATICS_SCHEMA = {
  type: 'object',
  properties: {
    includeLow: { type: 'boolean', description: '是否同时返回低置信度建议（默认 true）', default: true },
    limit: { type: 'integer', minimum: 1, maximum: 30, description: '每档最多返回几条，1–30，默认 20', default: 20 }
  },
  additionalProperties: false
};

const GET_TOOL_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    resultId: {
      type: 'string',
      description: '截断回执里的 16 位十六进制 resultId（形如 3f2a9c11d4e5b6a7），原样传入'
    },
    offset: {
      type: 'integer',
      minimum: 0,
      description: '按 UTF-8 字节计的起点，默认 0；续读请用回执的 nextOffset',
      default: 0
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 16384,
      description: '本次最多读多少字节，默认 10240，上限 16384（超过按 16384 处理）',
      default: 10240
    }
  },
  required: ['resultId'],
  additionalProperties: false
};

/** suggest_kinematics 输出给模型的单条建议：只留判断与复核需要的字段。 */
export function compactKinematicsSuggestion(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  const num = (input: unknown): number => (typeof input === 'number' && Number.isFinite(input) ? input : 0);
  const kind = value.kind === 'rotary' ? 'rotary' : 'linear';
  const meshNames = Array.isArray(value.meshNames) ? value.meshNames.filter((name) => typeof name === 'string').slice(0, 6) : [];
  return {
    id: value.id,
    name: typeof value.name === 'string' ? value.name : '',
    category: typeof value.category === 'string' ? value.category : '',
    kind,
    axis: `${num(value.direction) < 0 ? '-' : '+'}${typeof value.axis === 'string' ? value.axis.toUpperCase() : '?'}`,
    // 水平偏角（deg）：斜装的夹爪/气缸不在 ±X/±Y/±Z 上，不带上这个字段模型复述方向时会把偏角丢掉
    ...(Number.isFinite(num(value.yawDeg)) && num(value.yawDeg) !== 0 ? { yawDeg: num(value.yawDeg) } : {}),
    ...(kind === 'rotary' ? { rangeDeg: num(value.rangeDeg) } : { travelMm: num(value.travelMm) }),
    strokeSource: typeof value.strokeSource === 'string' ? value.strokeSource : 'none',
    modelCode: typeof value.modelCode === 'string' ? value.modelCode : '',
    station: typeof value.station === 'string' ? value.station : '',
    point: typeof value.point === 'string' ? value.point : '',
    confidence: Math.round(num(value.confidence) * 100) / 100,
    level: value.level === 'high' ? 'high' : 'low',
    reason: typeof value.reason === 'string' ? value.reason : '',
    meshNames
  };
}

const GET_RECENT_AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: '最多返回几条，默认 10，上限 50（传更大按 50 处理并置 truncated=true）',
      default: 10
    },
    tool: {
      type: 'string',
      description: '按工具名精确过滤，例如 run_plc_generate（不要写前缀，不做模糊匹配）'
    },
    onlyFailed: {
      type: 'boolean',
      description: '只看 ok:false 的失败记录；排查「上次为什么不行」时传 true',
      default: false
    },
    sinceMinutes: {
      type: 'integer',
      minimum: 1,
      maximum: 10080,
      description: '回看时间窗（分钟），默认 1440（一天），上限 10080（七天）',
      default: 1440
    }
  },
  additionalProperties: false
};

const PLACE_COMPONENT_SCHEMA = {
  type: 'object',
  properties: {
    partId: { type: 'string', description: '数据包中的元器件 id；也接受唯一命中的型号' },
    x: { type: 'number', description: '放置位置左上角 X（mm）' },
    y: { type: 'number', description: '放置位置左上角 Y（mm）' },
    rotate: { type: 'boolean', description: '是否旋转 90°（宽高互换）', default: false },
    railSnap: { type: 'boolean', description: '导轨安装件是否吸附到最近导轨', default: true }
  },
  required: ['partId', 'x', 'y'],
  additionalProperties: false
};

const UPDATE_COMPONENT_SCHEMA = {
  type: 'object',
  properties: {
    partId: { type: 'string', description: '目标元件的物料号；与位号 ref 二选一' },
    ref: { type: 'string', description: '位号：底板放置 id 或 BOM 行号/零件名' },
    designator: { type: 'string', description: '位号别名，等同 ref' },
    tag: { type: 'string', description: '位号别名，等同 ref' },
    model: { type: 'string', description: '改后的型号或物料号；必须在已启用数据包中存在' },
    newModel: { type: 'string', description: 'model 的别名' },
    qty: { type: 'integer', minimum: 1, description: '改后的数量（正整数）' },
    remark: { type: 'string', description: '改后的备注；空字符串表示清空' },
    note: { type: 'string', description: 'remark 的别名' },
    target: {
      type: 'string',
      enum: ['auto', 'plate', 'bom'],
      description: '目标位置：auto 先找底板再找 BOM；默认 auto'
    }
  },
  additionalProperties: false
};

const REMOVE_COMPONENT_SCHEMA = {
  type: 'object',
  properties: {
    partId: { type: 'string', description: '目标元件的物料号；与位号 ref 二选一' },
    ref: { type: 'string', description: '位号：底板放置 id 或 BOM 行号/零件名' },
    designator: { type: 'string', description: '位号别名，等同 ref' },
    tag: { type: 'string', description: '位号别名，等同 ref' },
    target: {
      type: 'string',
      enum: ['auto', 'plate', 'bom'],
      description: '移除位置：auto 先找底板再找 BOM；默认 auto'
    }
  },
  additionalProperties: false
};

const PLC_GENERATE_SCHEMA = {
  type: 'object',
  properties: {
    config: {
      type: 'object',
      description: '机型 + PLC 配置；缺省读取桌面当前机型',
      additionalProperties: true
    },
    target: {
      type: 'string',
      enum: ['generic', 's7-1200', 's7-1500', 'codesys'],
      description: '生成目标；默认 generic，仅影响 README 与命名，不改变 ST 内容'
    },
    namePrefix: { type: 'string', description: '命名前缀；缺省按机型生成' },
    sequenceTimeoutMs: { type: 'number', description: '自动序列单步默认超时（ms），默认 5000' }
  },
  additionalProperties: false
};

const VALIDATE_MACHINE_DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    config: {
      type: 'object',
      description: '待校验的机型 config；缺省校验当前 active 机型。可直接传 design_machine 返回的 config，或整份方案（取其中 config）',
      additionalProperties: true
    }
  },
  additionalProperties: false
};

const REPAIR_PLC_CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    dryRun: {
      type: 'boolean',
      description: '只预览要补什么、不写盘；默认 true。确认补齐才传 false',
      default: true
    }
  },
  additionalProperties: false
};

const EXPORT_FILES_SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['pdf', 'dxf', 'glb', 'bom'],
      description: '导出内容：pdf 为 A3 装配报告，dxf 为三视图，glb 为网格，bom 为 CSV'
    },
    fileName: {
      type: 'string',
      description: '可选，只给文件名（不含目录）；路径/盘符/UNC/../ 默认返回 TARGET_PATH_UNSUPPORTED，扩展名按 kind 强制为 .pdf/.dxf/.glb/.csv'
    },
    overwrite: {
      type: 'boolean',
      description: '可选，默认 false；同名文件存在时追加 (1)、(2)，为 true 时直接覆盖'
    },
    allowSanitize: {
      type: 'boolean',
      description: '可选，默认 false；仅当用户明确表示“随便放哪都行”时设为 true，系统净化路径后写入 userData/exports/'
    }
  },
  required: ['kind'],
  additionalProperties: false
};

const LIST_MACHINE_LIBRARY_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false
};

const SAVE_MACHINE_TO_LIBRARY_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '入库机型 id；缺省取当前 active 机型，显式给则把该 id 的已落盘方案入库（另存为）' },
    name: { type: 'string', description: '可选，入库显示名；缺省沿用方案名' },
    version: { type: 'string', description: '可选，包版本号，默认 1.0.0' },
    overwrite: { type: 'boolean', description: '默认 false；同名机型已存在时返回 LIBRARY_EXISTS，只有显式 true 才覆盖', default: false }
  },
  additionalProperties: false
};

const LOAD_MACHINE_FROM_LIBRARY_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '机型库里的机型 id（先用 list_machine_library 查）' }
  },
  required: ['id'],
  additionalProperties: false
};

const EXPORT_MACHINE_PACKAGE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '机型库里的机型 id' },
    targetPath: {
      type: 'string',
      description: '可选，导出文件路径；相对路径按 userData/exports 解析，绝对路径也必须落在 userData/exports 下，越界返回 LIBRARY_BAD_PATH；缺省 userData/exports/machines/<id>.machine.zip'
    }
  },
  required: ['id'],
  additionalProperties: false
};

const LIST_MACHINE_SOURCES_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false
};

const DOWNLOAD_MACHINE_FROM_SOURCE_SCHEMA = {
  type: 'object',
  properties: {
    sourceId: { type: 'string', description: '来源 id（userData/machine-library/sources.json 里的 sources[].id，先用 list_machine_sources 查）' },
    machineId: { type: 'string', description: '目录里的机型 id（与来源一起唯一确定一台机器，必须先 list_machine_sources 查）' }
  },
  required: ['sourceId', 'machineId'],
  additionalProperties: false
};

const SEARCH_DOCS_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '要查的文档问题或关键词，如「导轨」「干涉」「D2 决策」' },
    limit: { type: 'integer', minimum: 1, maximum: 5, description: '返回条数，默认 3，最多 5' }
  },
  required: ['query'],
  additionalProperties: false
};

const BUFFER_CAPACITY_SCHEMA = {
  type: 'object',
  properties: {
    upstreamCycleSec: { type: 'number', exclusiveMinimum: 0 },
    downstreamCycleSec: { type: 'number', exclusiveMinimum: 0 },
    downstreamStopSec: { type: 'number', minimum: 0 },
    initialOccupancy: { type: 'integer', minimum: 0 },
    inTransit: { type: 'integer', minimum: 0 },
    reserveSlots: { type: 'integer', minimum: 0 },
    capacity: { type: 'integer', minimum: 0 }
  },
  required: ['upstreamCycleSec', 'downstreamCycleSec', 'downstreamStopSec', 'initialOccupancy', 'inTransit', 'reserveSlots'],
  additionalProperties: false
};

/**
 * 缓存塔几何入参。与 `bufferTower`（纯数据槽位）并列、不合并：
 * 前者是「容量身份」，后者是「塔身几何」。两者同时出现时要求
 * `levels × slotsPerLevel === slotsPerTower`，否则回 `INVALID_ARGUMENT`（带算式，不夹紧）。
 */
const BUFFER_TOWER_GEOMETRY_SCHEMA = {
  type: 'object',
  properties: {
    levels: { type: 'integer', minimum: 2, maximum: 64, description: '物理层数（含第 1 层进出料输送线）' },
    slotsPerLevel: {
      type: 'integer',
      minimum: 1,
      maximum: 8,
      description: '每层储位数；本期几何只做 1 位。每层多位需要伸缩叉/穿梭车（进料线要 ≥4.9 m），请求更大值会被明确拒建，不按 1 位静默建'
    },
    layerPitchMm: { type: 'number', minimum: 165, maximum: 600, description: '层距 mm，缺省 180；必须 ≥ 板厚+130' },
    panel: {
      type: 'object',
      properties: {
        lengthMm: { type: 'number', exclusiveMinimum: 0 },
        widthMm: { type: 'number', exclusiveMinimum: 0 },
        thicknessMm: { type: 'number', exclusiveMinimum: 0 },
        massKg: { type: 'number', minimum: 0 }
      },
      required: ['lengthMm', 'widthMm', 'thicknessMm', 'massKg'],
      additionalProperties: false
    },
    inbound: {
      type: 'object',
      properties: {
        lengthMm: { type: 'number', exclusiveMinimum: 0, description: '底层输送线长；必须 ≥ 板长+120' },
        widthMm: { type: 'number', exclusiveMinimum: 0 },
        beltHeightMm: { type: 'number', exclusiveMinimum: 0 }
      },
      required: ['lengthMm', 'widthMm', 'beltHeightMm'],
      additionalProperties: false
    },
    frame: {
      type: 'object',
      properties: {
        material: { type: 'string', enum: ['AL6063', 'Q235'] },
        sectionMm: { type: 'number', exclusiveMinimum: 0, description: '底层输送型材截面（40 = 4040）' },
        columnSectionMm: { type: 'number', exclusiveMinimum: 0, description: '立柱截面；缺省按柱高反算（max(型材截面, ceil5(柱高/48))），显式值只能更大' }
      },
      additionalProperties: false
    }
  },
  required: ['levels', 'slotsPerLevel', 'panel', 'inbound'],
  additionalProperties: false,
  description:
    '缓存塔塔身几何（可选）。出现时必须同时给 bufferTower，且 levels×slotsPerLevel === slotsPerTower（单塔）。'
    + '返回 slots（fromGeometry 由 tray-* 件计数派生）/geometry/structure/capabilityBoundary；'
    + '几何是静态概念件，结构只做屈曲手算量级标注，不是验收。'
} as const;

/** design_machine 缓存快照使用的假设转移超时（秒）：只用于让单步快照可解释，不是现场设定值。 */
const BUFFER_SNAPSHOT_TRANSFER_TIMEOUT_SEC = 30;

/**
 * `bufferTowerGeometry` 的**入参白名单**（形状之后、归一化之前的唯一一道显式门）。
 *
 * 为什么需要它：JSON Schema 的 `additionalProperties:false` 只约束契约端正的客户端，
 * MCP / LLM 侧、以及进程内 `AgentTools.call`（直接 `handler(args)`，**不跑 schema 校验**）
 * 都可能塞多余键。旧实现把这些键 `...(towerGeometryInput)` 展开在 `towers`/`slotsPerTower`
 * **之后**，于是 `{levels:2, slotsPerTower:2}` 会静默改写容量身份：调用方声明 16 位，
 * 回执写回 2 位，且没有任何告警——「参数不生效却看不出来」的反向版本（多出来的键生效了）。
 *
 * 现在：不在白名单里的键直接拒绝（`CONFIG_SHAPE` → `INVALID_ARGUMENT`），
 * 容量身份只能由 `bufferTower` 给，几何只负责 `levels/slotsPerLevel/layerPitchMm/panel/inbound/frame`。
 */
const TOWER_GEOMETRY_KEYS = ['levels', 'slotsPerLevel', 'layerPitchMm', 'panel', 'inbound', 'frame'] as const;
const TOWER_PANEL_KEYS = ['lengthMm', 'widthMm', 'thicknessMm', 'massKg'] as const;
const TOWER_INBOUND_KEYS = ['lengthMm', 'widthMm', 'beltHeightMm'] as const;
const TOWER_FRAME_KEYS = ['material', 'sectionMm', 'columnSectionMm'] as const;

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new BufferTowerConfigError(
      'CONFIG_SHAPE',
      `${label} 不接受键 ${unknown.join('、')}：只允许 ${allowed.join(' / ')}`
        + (unknown.some((key) => key === 'towers' || key === 'slotsPerTower' || key === 'towerCount')
          ? '；容量身份（塔数/每塔储位）只能由 bufferTower 给，几何入参不许改写它'
          : '')
    );
  }
}

/**
 * 只挑出塔几何认识的键，**逐层白名单**（含 panel/inbound/frame 三个子块）。
 * 返回的对象只含白名单键，调用方按显式字段赋值（不再 spread 进 bufferTower）。
 */
function coerceTowerGeometryInput(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BufferTowerConfigError('CONFIG_SHAPE', 'bufferTowerGeometry 必须是对象');
  }
  const record = raw as Record<string, unknown>;
  rejectUnknownKeys(record, TOWER_GEOMETRY_KEYS, 'bufferTowerGeometry');
  const pickBlock = (key: 'panel' | 'inbound' | 'frame', allowed: readonly string[]): Record<string, unknown> | undefined => {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new BufferTowerConfigError('CONFIG_SHAPE', `bufferTowerGeometry.${key} 必须是对象`);
    }
    const block = value as Record<string, unknown>;
    rejectUnknownKeys(block, allowed, `bufferTowerGeometry.${key}`);
    return block;
  };
  const panel = pickBlock('panel', TOWER_PANEL_KEYS);
  const inbound = pickBlock('inbound', TOWER_INBOUND_KEYS);
  const frame = pickBlock('frame', TOWER_FRAME_KEYS);
  return {
    levels: record.levels,
    slotsPerLevel: record.slotsPerLevel,
    ...(record.layerPitchMm !== undefined ? { layerPitchMm: record.layerPitchMm } : {}),
    ...(panel !== undefined ? { panel } : {}),
    ...(inbound !== undefined ? { inbound } : {}),
    ...(frame !== undefined ? { frame } : {})
  };
}

/** 快照回显的槽位上限：1×512 全量回显会把 44 KB 塞进 agent 上下文，超出部分只给计数。 */
const BUFFER_SLOT_ECHO_LIMIT = 16;

const DESIGN_MACHINE_SCHEMA = {
  type: 'object',
  properties: {
    brief: {
      type: 'string',
      minLength: 1,
      description: '中文机型需求，例如「设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服」'
    },
    buffer: { ...BUFFER_CAPACITY_SCHEMA, description: '缓存机容量核算：明确上下游秒/件、下游停机秒数、初始库存、在途件、预留槽和实际容量；结果不证明FIFO或几何已实现。' },
    bufferTower: {
      type: 'object',
      properties: {
        towerCount: { type: 'integer', minimum: 1, maximum: 2 },
        slotsPerTower: { type: 'integer', minimum: 1, maximum: MAX_BUFFER_SLOTS }
      },
      required: ['towerCount', 'slotsPerTower'],
      additionalProperties: false,
      // 单塔上限 512，但总量上限也是 512：两塔时每塔最多 256。
      // 顶层 properties 保留 512 以表达“单塔绝对上限”，组合约束放在 allOf 里，
      // 标准 JSON Schema 客户端（MCP/LLM 侧）能在调用前就拦住 2×300 这类越界。
      allOf: [
        {
          if: { properties: { towerCount: { const: 2 } }, required: ['towerCount'] },
          then: { properties: { slotsPerTower: { maximum: MAX_BUFFER_SLOTS / 2 } } }
        }
      ],
      description: `缓存塔纯数据排布预览；只生成空队列 FIFO 槽位模型。总槽位上限 ${MAX_BUFFER_SLOTS}（towerCount=2 时每塔最多 ${MAX_BUFFER_SLOTS / 2}，单塔最多 ${MAX_BUFFER_SLOTS}），不代表真实机械或安全验收。返回值为单个扫描周期的快照，握手输入是显式假设而非现场状态。`
    },
    bufferTowerGeometry: BUFFER_TOWER_GEOMETRY_SCHEMA,
    stationCount: {
      type: 'integer',
      minimum: MACHINE_STATIONS_MIN,
      maximum: MACHINE_STATIONS_MAX,
      description: '覆盖 brief 中的工位数，1–12'
    },
    cyclePerMin: {
      type: 'number',
      exclusiveMinimum: 0,
      description: '覆盖 brief 中的目标节拍（件/分钟）'
    }
  },
  required: ['brief'],
  additionalProperties: false
};

/**
 * 缓存塔几何回执（`design_machine` 的 `bufferTowerGeometry`）。
 *
 * 四条硬约束（写作时就定了，别在别处另算一份）：
 * 1. `slots.fromGeometry` **从零件表派生**（层数 × 每层托板件数 × 立柱塔数），三项都不抄配置——
 *    参数回声会让「16 层配置 / 8 层几何」自证对齐；缺层/多件由 `bufferTowerSlots` 抛错；
 * 2. `massKg` 一律 `null` + `massSource: 'not-measured'`：本工具不跑内核，不给估算值
 *    （真实质量只能由真 B-Rep 的 regen 产出）；
 * 3. `capabilityBoundary` 里的能力项全 `false`，并原样带安全边界原文——
 *    「16 位几何存在」不等于「16 个可服务储位」「结构已校核」「缓存机已实现」；
 * 4. 回执里任何「派生量」都要能从件表或参数复算（`partBreakdown` 的底架项独立再建一次，
 *    `postReachMm` 从实体包围盒量，不是 `postTop − topLayerZ` 的定义回声）。
 */
function buildBufferTowerGeometryReceipt(
  params: ResolvedBufferTowerParams,
  parts: readonly ConveyorPart[],
  resolved: ResolvedMachineGeometry,
  machineBom: { rows: number; costTotal: number | null }
): Record<string, unknown> {
  const slots = bufferTowerSlots(params, parts);
  const envelope = conveyorEnvelope(parts);
  const round1 = (value: number): number => Math.round(value * 10) / 10;
  // 件数构成**按件号数**，不按算术猜：回执里的分解必须能逐件对上 STEP/BOM
  const countBy = (pattern: RegExp): number => parts.filter((part) => pattern.test(part.id)).length;
  // 底架真值独立再建一次（`layers: 1` 的同一条输送线），**不用**「总件数 − 塔身件数」倒算：
  // 那个式子在任何建造器改动下都恒成立，等于零信息量。
  const baseParts = buildConveyorParts(bufferTowerInboundParams(params));
  const baseIds = new Set(baseParts.map((part) => part.id));
  const baseConveyor = baseParts.length;
  const breakdown = {
    baseConveyor,
    columns: countBy(/^column-/),
    topBeams: countBy(/^top-beam-/),
    trayRails: countBy(/^tray-(rail)-/),
    trays: countBy(/^tray-\d+$/),
    trayRollers: countBy(/^tray-roller-/),
    stops: countBy(/^stop-/),
    layerSensors: countBy(/^layer-sensor-/),
    liftPosts: countBy(/^lift-post-/),
    liftChains: countBy(/^lift-chain-/),
    liftPlatforms: countBy(/^lift-platform$/),
    liftMotors: countBy(/^lift-motor$/)
  };
  const breakdownSum = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  if (breakdownSum !== parts.length) {
    throw new BufferTowerGeometryError(
      `缓存塔件数分解与零件表不符：分解合计 ${breakdownSum} ≠ 零件 ${parts.length}（回执不能自己凑数）`
    );
  }
  // 导柱净余量：从**实体**包围盒量（导柱顶 − 顶层托板上表面），不拿 postTop − topLayerZ 自证
  const boundsOf = (predicate: (id: string) => boolean): number[] => parts
    .filter((part) => predicate(part.id))
    .map((part) => partWorldBounds(part).max[2]);
  const postTops = boundsOf((id) => /^lift-post-/.test(id));
  const trayTops = boundsOf((id) => /^tray-\d+$/.test(id));
  if (postTops.length === 0 || trayTops.length === 0) {
    throw new BufferTowerGeometryError('缓存塔缺 lift-post-* 或 tray-*：导柱净余量无法从实体几何量出来');
  }
  const postTopZ = Math.max(...postTops);
  const topTrayTopZ = Math.max(...trayTops);
  const postReachMm = round1(postTopZ - topTrayTopZ);
  // 结构余量必须含板料载荷：15 个储位 × 32 kg 不在几何质量里，只算塔身自重会把缺口说小 3 倍
  const panelLoadKg = Math.round(slots.usableStorage * params.panel.massKg);
  const selfWeightPerColumnT = 0.41;
  const panelLoadPerColumnKg = Math.round(panelLoadKg / slots.towersFromGeometry / 4);
  const columnLoadT = Math.round((selfWeightPerColumnT + panelLoadPerColumnKg / 1000) * 100) / 100;
  const allowableT = 0.36;
  const overPercent = Math.round((columnLoadT / allowableT - 1) * 100);
  const towerParts = parts.length - baseConveyor;
  return {
    readOnly: true,
    // 归一化后的配置原样回显；与 design.config.bufferTower 是同一份（apply 时不需要重算）
    config: params.config,
    slots: {
      fromGeometry: slots.fromGeometry,
      claimed: slots.claimed,
      aligned: slots.aligned,
      transferLevels: slots.transferLevels,
      usableStorage: slots.usableStorage,
      levels: slots.levels,
      slotsPerLevel: slots.slotsPerLevel,
      levelsFromGeometry: slots.levelsFromGeometry,
      slotsPerLevelFromGeometry: slots.slotsPerLevelFromGeometry,
      towersFromGeometry: slots.towersFromGeometry,
      trayCount: slots.trayCount,
      layerSensorCount: slots.sensorCount,
      derivation: `托板 ${slots.trayCount} 层 + 第 1 层进出料位 ${slots.transferLevels} = ${slots.levelsFromGeometry} 层，`
        + `× 每层托板 ${slots.slotsPerLevelFromGeometry} 件（= 每层储位）× 立柱 ${slots.towersFromGeometry} 塔 = ${slots.fromGeometry}；`
        + `可用储位 = ${slots.fromGeometry} − ${slots.transferLevels} = ${slots.usableStorage}（第 1 层兼作进出料工位）。`
        + `层完整性：第 2~${slots.levelsFromGeometry} 层逐层核对托板 1 / 托条 2 / 挡停 1 / 光电 1（缺层或多件直接抛错，不再只比两族件数）`,
      layerAudit: {
        levelsChecked: slots.levelsFromGeometry - slots.transferLevels,
        families: ['tray', 'tray-rail', 'stop', 'layer-sensor'],
        rowsSample: slots.layerTrace.slice(0, 2),
        statement: '任一层缺件或多件 → design_machine 回 INTERNAL_ERROR（建造器缺陷），不会给出 aligned:false 的 ok:true'
      }
    },
    geometry: {
      source: resolved.source,
      // 装配件数（BOM/STEP 口径，来自 TS 零件表）与几何刚体数分开报
      partCount: parts.length,
      geometryPartCount: resolved.partCount,
      envelopeMm: envelope,
      movingAxes: resolved.geometry.moving.length,
      liftStrokeMm: params.liftTravelMm,
      levels: params.levels,
      layerPitchMm: params.layerPitchMm,
      partBreakdown: {
        ...breakdown,
        sum: breakdownSum,
        basePartsMatched: parts.filter((part) => baseIds.has(part.id)).length,
        towerParts,
        note: `底架 ${baseConveyor} 件是**另外再建一次** layers:1 输送线数出来的（不是 parts.length − 塔身件数）；塔身 ${towerParts} 件逐族计数`
      },
      // 不跑内核就不给质量。估算值会被当成「实测」，混进成本/吊装/楼板核算。
      massKg: null,
      massSource: 'not-measured' as const,
      massNote: '本工具不跑建模内核：质量必须由真 B-Rep（regen/STEP）回传体积后按密度算，这里不给估算值'
    },
    /**
     * BOM / 成本覆盖度（P2-6）：回执里 146 件装配 + 1 块板（碰撞几何 147 刚体）、8 行 BOM 是两台机器的清单。
     * 本轮**不**把塔身塞进 `design.bomDraft`（那会改成本口径与价格簿匹配），而是显式标注
     * 「机器 BOM 只覆盖底架、塔身见 geometry.structureBom」，让 cost.total 不被当整机成本。
     */
    bomCoverage: {
      machineBomRows: machineBom.rows,
      machineBomCoversTower: false as const,
      machineBomScope: '底层输送线（第 1 层）' as const,
      geometryPartCount: parts.length,
      towerPartsNotInMachineBom: towerParts,
      geometryStructureBomRows: resolved.geometry.structureBom.length,
      costTotal: machineBom.costTotal,
      costScope: 'base-conveyor-only' as const,
      /// 「不适用」必须写清楚是哪一项不适用：成本不能代表整机，几何零件表可以
      notApplicable: ['cost.total（只算底架输送线，不含塔身）', 'design.bomDraft 作为整机采购清单'],
      note: `design.bomDraft 只有 ${machineBom.rows} 行（底架输送线口径），不含塔身 ${towerParts} 件；`
        + `完整件表见 geometry.partBreakdown / 几何 structureBom（${resolved.geometry.structureBom.length} 行分组）。`
        + '塔身接 BOM 生成器是下一轮的事，本轮不伪造成本'
    },
    structure: {
      columnHeightMm: params.columnHeightMm,
      columnSectionMm: params.columnSectionMm,
      columnSectionRecommendedMm: params.requiredColumnSectionMm,
      columnSectionSource: params.columnSectionSource,
      frameSectionMm: params.frameSectionMm,
      liftTravelMm: params.liftTravelMm,
      topLayerZMm: params.topLayerZMm,
      /** 导柱顶：从 `lift-post-*` 实体包围盒量（= 柱高），不是参数回显 */
      postTopZMm: postTopZ,
      /** 顶层托板上表面：从 `tray-*` 实体包围盒量（3606.5，比层平面 3600 高 6.5 = 托板厚 3 + 5 装配间隙 /2 口径） */
      topTrayTopZMm: topTrayTopZ,
      /**
       * 导柱顶 − 顶层托板**上表面**（实体口径）= 233.5 mm。
       * 旧字段用 `postTopZMm − topLayerZMm` 算，而这两者本来就是同一条算式里定义的
       * （postTop = 柱高 = topLayer + 240），只能得出 240 —— 定义回声，不是量出来的。
       */
      postReachMm,
      postReachBasis: 'entity-bounds' as const,
      /** 同一余量的「层平面口径」（= 建造器的 240 设计值），供对照；实体口径比它少 6.5 mm */
      postReachPlaneMm: round1(params.postTopZMm - params.topLayerZMm),
      inboundBeltHeightMm: params.inbound.beltHeightMm,
      loadPerColumnKg: null,
      staticOnly: true as const,
      accepted: false as const,
      notes: [
        `立柱截面按柱高反算：max(型材截面 ${params.frameSectionMm}, ceil5(${params.columnHeightMm}/48)) = ${params.requiredColumnSectionMm} mm`
          + `（本次 ${params.columnSectionSource === 'derived' ? '由建造器取反算值' : '为显式给出值'} ${params.columnSectionMm} mm）；`
          + '反算只解决「40 柱在这个高度差一个量级」，不等于截面够了',
        '屈曲只是手算量级（AL6063、两端铰接 K=1 / 门架 K≈2）：40×40×2 在 3.84 m 时临界约 350 kg（K=1）、88 kg（K=2），'
          + '80×80×3 约 1092 kg（K=2）。按探针口径（特征体积×密度，不是 B-Rep 实测）16 层塔身自重约 1.63 t、四柱均分约 0.41 t/柱；'
          + '80×80×3 在 K=2 + 安全系数 3 下许用约 0.36 t。'
          + `**两种口径必须分开读**：只看自重差约 13%；但 ${slots.usableStorage} 个储位的板料（${params.panel.massKg} kg/件，`
          + `共 ${panelLoadKg} kg，不在几何质量里）加进来后是 ${selfWeightPerColumnT} + ${panelLoadPerColumnKg}/1000 = ${columnLoadT} t/柱，`
          + `超许用约 ${overPercent}% —— 板料把缺口从 13% 放大到 ${overPercent}%，不能说成「差不多够」。`
          + '**结论：定截面必须做正式校核（或改 Q235 / 加斜撑 / 做落地基座）。**未做风载/地震/螺栓/焊缝/疲劳/挠度组合。',
        `导柱净余量按**实体**量：导柱顶 ${postTopZ} − 顶层托板上表面 ${topTrayTopZ} = ${postReachMm} mm`
          + `（层平面口径 ${params.postTopZMm} − ${params.topLayerZMm} = 240，差 6.5 mm 来自「托板中心 vs 托板上表面」）。`
          + '旧 conveyor-assembly 的 8 层路径导柱顶恒比顶层低 560 mm，那是既有缺陷，本次不复制也不修它。',
        '**层间没有横梁/支撑（显式声明）**：塔身只有顶部 2 根横梁；15 层托条两端与立柱在几何上不相接'
          + '（`tray-rail` 在 y∈[−350,−310]，立柱在 y∈[−755,−675]，间隙 325 mm），`conveyorJoints` 里 rail×column 为 0 对。'
          + 'JOINT_RULES 里「托条两端搭在缓存立柱上」是**连接语义**，不是几何事实。'
          + '这条既有缺陷从 8 层建造器就在（旧路径同样悬空），塔把它放大到 3.84 m/15 层；要变成可制造件必须补层间横梁或托架挂耳（会改件数与包络）。',
        `升降轴：tower-lift，行程 ${params.liftTravelMm} mm = (${params.levels}−1) × ${params.layerPitchMm}，`
          + '行程来自几何标注（config.actuators 为空），状态化干涉里 `lift.strokeSource=geometry`。'
          + `台面建模在 beltHeight + 层距/2（层间中间位，非层平面），按行程平移终点比顶层平面高 90 mm；`
          + '且台面在托板投影内、层托板是整块板 —— **没有升降通道**，sweep 逐层扫掠会把 lift-platform × tray-* 报为命中（真实机构缺口，未解决）',
        `总高 ${params.columnHeightMm} mm：稳定性、消防/通道净高、检修平台与登高作业无法由静态几何回答，必须由人工/结构专业确认。`
      ],
      /** 塔身缺件清单（显式「不适用/未建」）：供下游别把结构件当已建 */
      notModeled: [
        '层间横梁/托架挂耳（托条目前悬空，见 notes）',
        '升降通道（台面与层托板投影重叠，sweep 会命中）',
        '防坠/抱闸、层定位机构、拖链与线缆',
        '安全门/光幕/急停回路'
      ]
    },

    capabilityBoundary: {
      geometryKind: 'static-concept' as const,
      acceptanceStatus: 'not-accepted' as const,
      dynamicInterferenceChecked: false as const,
      structuralChecked: false as const,
      fireComplianceChecked: false as const,
      ioAddressesAssigned: false as const,
      plcProgramIncluded: false as const,
      safetyCircuitIncluded: false as const,
      throughputVerified: false as const,
      slotClaim: {
        total: slots.fromGeometry,
        usable: slots.usableStorage,
        message: `${slots.fromGeometry} 位 = 零件表里的 ${slots.fromGeometry} 个货位（含第 1 层进出料位），`
          + `不是 ${slots.fromGeometry} 个已验证可服务储位；真实可服务储位 ${slots.usableStorage} 个`
      },
      /**
       * 状态化干涉的**可用性**（不是"已校核"）：
       * 轴已接进 `resolveLiftAxis`（strokeSource=geometry），所以 lift/sweep 能跑；
       * 但台面没有升降通道、sweep 会把台面×托板报为命中 —— 这不是验收结论，是缺口证据。
       */
      dynamicInterference: {
        statesAvailable: ['rest', 'lift', 'sweep'] as const,
        statesUnavailable: ['push'] as const,
        liftStrokeSource: 'geometry' as const,
        sweepDeclaredHits: 'lift-platform × tray-*（台面在托板投影内，无升降通道）',
        checkedForAcceptance: false as const
      },
      message:
        '本几何为静态概念模型：件的外形是参数化特征/包围盒，不是制造用 B-Rep 结论；'
        + 'lift/sweep 状态化干涉可跑（轴由几何标注、行程 strokeSource=geometry），但只做 AABB 初筛 + 解析式确认，'
        + '且台面没有升降通道（sweep 会把 lift-platform × tray-* 报为命中，属真实机构缺口）；push 不适用（无移载轴）；'
        + '结构强度/挠度/屈曲校核、防坠与抱闸、链条/丝杠载荷、双塔汇流争用、空托盘回流均未做；未生成 PLC 程序、未分配 IO 地址'
        + '（草案 executable=false）、未做安全回路；静态 AABB 命中不等于制造碰撞结论。'
        + '禁止宣称「16 位已实现/已验收」「结构已校核」「缓存机已实现」。'
    }
  };
}


const BUILD_MACHINE_MODEL_SCHEMA = {
  type: 'object',
  properties: {
    process: {
      type: 'string',
      description:
        '机型工艺；参数化建模支持 conveyor（皮带输送线 / 多层缓存）与 buffer-tower（缓存塔塔身，146 件 / 16 层）。'
        + '其余工艺请用 apply_machine_design。给了塔的 design/config 时可以省略（按塔建），'
        + '但显式写 process=conveyor 又给塔 design 会被判冲突拒绝'
    },
    params: {
      type: 'object',
      description:
        '机型参数（mm）。conveyor：lengthMm / widthMm / beltHeightMm / pulleyDiameterMm / beltThicknessMm / frameSectionMm，'
        + '多层缓存另加 layers（1~8，≥2 出多层）、layerPitchMm；缺省用默认值，**越界会夹紧**并在 warnings 里说明。'
        + 'buffer-tower：levels（2~64）/ layerPitchMm / panelLengthMm / panelWidthMm / panelThicknessMm / panelMassKg / '
        + 'inboundLengthMm / inboundWidthMm / beltHeightMm / sectionMm；塔参数**越界直接拒绝（不夹紧）**，'
        + '且 slotsPerTower / towers / transferLevel 不接受（容量由 levels 派生）',
      additionalProperties: true
    },
    design: {
      type: 'object',
      description:
        '上一步 design_machine 返回的完整方案。缓存塔的几何与落盘都以 design.config.bufferTower 为准；'
        + '与 params 里的塔参数只能有一个来源。与 config 二选一',
      additionalProperties: true
    },
    config: {
      type: 'object',
      description: '只给机型配置的简写（塔块在 config.bufferTower），等价于 design.config；与 design 二选一。',
      additionalProperties: true
    },
    brief: {
      type: 'string',
      description: '可选，需求原文。给了就自动取线体长/宽与「N 层」缓存层数，params 里显式给的键优先。缓存塔不支持 brief（显式拒绝）'
    },
    name: { type: 'string', description: '可选，模型显示名（写入零件树标题）' },
    load: { type: 'boolean', description: '默认 true；false 时只构建并返回统计，不把模型装进视口' }
  },
  required: [],
  additionalProperties: false
} as const;

const APPLY_MACHINE_DESIGN_SCHEMA = {
  type: 'object',
  properties: {
    brief: {
      type: 'string',
      minLength: 1,
      description: '机型需求；与完整 design 二选一，内部会先跑 synth'
    },
    design: {
      type: 'object',
      description: '上一步 design_machine 返回的完整 design；与 brief 二选一，避免重复合成',
      additionalProperties: true
    },
    name: { type: 'string', description: '可选，应用到工程后的机型名称' },
    overwrite: { type: 'boolean', description: '默认 false；同名机型文件存在时返回 FILE_EXISTS，true 才覆盖' },
    withBom: { type: 'boolean', description: '默认 true；把 bomDraft 追加到 BOM 草稿并写 bom-draft.csv' },
    withPlc: { type: 'boolean', description: '默认 false；生成 exports/plc/<machineId>/io-map.csv' },
    withGeometry: { type: 'boolean', description: '默认 true；生成参数化整机几何 machine/<id>/geometry.json、model.stl、model.gltf 与 sidecar-assembly.json' },
    withSolids: { type: 'boolean', description: '默认 false；build123d 内核可用时逐块实体化并写 solids/part-N.step，不可用时回退 TS 网格并给 warning' }
  },
  additionalProperties: false
};

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exportPathFailure(args: Record<string, unknown>): Record<string, unknown> | undefined {
  if (args.fileName !== undefined && args.fileName !== null && typeof args.fileName !== 'string') {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'fileName 必须是字符串' };
  }
  if (args.allowSanitize !== undefined && args.allowSanitize !== null && typeof args.allowSanitize !== 'boolean') {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'allowSanitize 必须是布尔值' };
  }
  const check = checkExportTargetPath(args.fileName, args.allowSanitize === true);
  return check.ok ? undefined : { ok: false, code: 'TARGET_PATH_UNSUPPORTED', message: check.message };
}

function commandFailure(result: CommandResult): Record<string, unknown> {
  const error = result.error;
  return {
    ok: false,
    code: error?.code ?? 'COMMAND_FAILED',
    message: error?.message ?? '命令执行失败',
    // hint 只有「下一步怎么做」的语义（例如覆盖要显式传 overwrite），不改变错误码。
    ...(error?.hint ? { hint: error.hint } : {})
  };
}

function commandSuccess(result: CommandResult): Record<string, unknown> {
  if (!result.ok) return commandFailure(result);
  return {
    ok: true,
    ...(result.cancellation ? { cancellation: result.cancellation } : {}),
    ...(isRecord(result.data) ? result.data : result.data === undefined ? {} : { data: result.data })
  };
}

const ELEC_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    wires: {
      type: 'array',
      description: '导线清单：no 线号、net 网络、potential 电位、from/to 端点，可选 sectionMm2/currentA',
      items: {
        type: 'object',
        properties: {
          no: { type: 'string' },
          net: { type: 'string' },
          potential: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          sectionMm2: { type: 'number' },
          currentA: { type: 'number' }
        }
      }
    },
    loads: {
      type: 'array',
      description: '负载清单：tag 编号、powerKw 额定功率、phase 取 3P/L1/L2/L3/DC24，可选 cosPhi/efficiency/quantity',
      items: {
        type: 'object',
        properties: {
          tag: { type: 'string' },
          powerKw: { type: 'number' },
          phase: { type: 'string', enum: ['3P', 'L1', 'L2', 'L3', 'DC24'] },
          cosPhi: { type: 'number' },
          efficiency: { type: 'number' },
          quantity: { type: 'number' }
        },
        required: ['powerKw']
      }
    },
    circuits: {
      type: 'array',
      description: '回路清单：wireNo 线号、currentA 工作电流，可选 sectionMm2 截面、breakerA 断路器',
      items: {
        type: 'object',
        properties: {
          wireNo: { type: 'string' },
          currentA: { type: 'number' },
          sectionMm2: { type: 'number' },
          breakerA: { type: 'number' }
        },
        required: ['wireNo', 'currentA']
      }
    },
    options: {
      type: 'object',
      description: '可选电气参数：voltage3P/voltage1P/voltageDc/demandFactor/psuRatedA',
      properties: {
        voltage3P: { type: 'number' },
        voltage1P: { type: 'number' },
        voltageDc: { type: 'number' },
        demandFactor: { type: 'number' },
        psuRatedA: { type: 'number' }
      }
    }
  },
  additionalProperties: false
};

const VERIFY_PLC_PROGRAM_SCHEMA = {
  type: 'object',
  properties: {
    config: {
      type: 'object',
      description: '机型 + PLC 配置（stations/actuators/sensors/safety/sequence）；缺省读取桌面当前机型'
    },
    timeScale: { type: 'number', description: '模拟加速倍率，默认 1；2 表示行程与等待时间减半' },
    safetyTripAtStep: { type: 'integer', description: '可选，在第 N 步开始前注入急停/安全门触发（1 起）' },
    sensorConflictAtStep: { type: 'integer', description: '可选，在第 N 步开始前注入传感器矛盾' }
  },
  additionalProperties: false
};

function verifyOptions(args: Record<string, unknown>): VerifyOptions {
  const options: VerifyOptions = {};
  const timeScale = getNumber(args.timeScale);
  if (timeScale !== undefined) options.timeScale = timeScale;
  for (const key of ['safetyTripAtStep', 'sensorConflictAtStep'] as const) {
    const value = args[key];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) options[key] = value;
  }
  return options;
}

const COST_REPORT_SCHEMA = {
  type: 'object',
  properties: {
    bom: {
      type: 'array',
      description: '物料明细；不传则使用当前场景 BOM（场景零件无物料号，会被计入「缺物料号」）',
      items: {
        type: 'object',
        properties: {
          partId: { type: 'string', description: '价格簿物料号，缺省则无法计价' },
          name: { type: 'string' },
          model: { type: 'string' },
          category: { type: 'string' },
          spec: { type: 'string' },
          specs: { type: 'object', description: '结构化规格，可含「接线点数」' },
          qty: { type: 'number', description: '正整数' },
          terminationPoints: { type: 'number' },
          assemblyMinutesPerUnit: { type: 'number' }
        },
        required: ['name', 'qty']
      }
    },
    pricebook: { type: 'object', description: '价格簿 JSON；缺省读取桌面版内置价格簿（示例条目不计价）' },
    placements: {
      type: 'array',
      description: '底板布置（毫米），用于线缆长度估算：id/partId/model/x/y/w/h',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          partId: { type: 'string' },
          model: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          w: { type: 'number' },
          h: { type: 'number' }
        },
        required: ['x', 'y']
      }
    },
    plate: {
      type: 'object',
      description: '底板尺寸（毫米）与导轨，用于导轨/线槽辅材估算',
      properties: {
        width: { type: 'number' },
        height: { type: 'number' },
        rails: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              y: { type: 'number' },
              height: { type: 'number' },
              label: { type: 'string' }
            }
          }
        }
      },
      required: ['width', 'height']
    },
    plc: {
      type: 'object',
      description: 'PLC 配置：ioPoints 点数 + modules 模块清单（partId/qty）',
      properties: {
        ioPoints: { type: 'number' },
        modules: {
          type: 'array',
          items: {
            type: 'object',
            properties: { partId: { type: 'string' }, qty: { type: 'number' } },
            required: ['partId']
          }
        }
      },
      required: ['modules']
    },
    options: {
      type: 'object',
      description: '报价参数：markupRate 加成率、taxRate 税率、freight 运费（元）',
      properties: {
        markupRate: { type: 'number' },
        taxRate: { type: 'number' },
        freight: { type: 'number' }
      }
    },
    overrides: { type: 'object', description: '按物料号手工改价：{ partId: 单价 }' },
    wireSection: { type: 'string', description: '线缆截面档位，如 "2.5"' },
    now: { type: 'string', description: '计算基准时间（ISO 8601），用于核对价格时效' }
  },
  additionalProperties: false
};

const COST_EXPORT_SCHEMA = {
  type: 'object',
  properties: {
    format: {
      type: 'string',
      enum: ['pdf', 'csv'],
      description: '导出格式：pdf 为 A4 纵向报告，csv 为 UTF-8 BOM（Excel 中文不乱码）'
    },
    fileName: {
      type: 'string',
      description: '可选，只给文件名（不含目录）；路径/盘符/UNC/../ 默认返回 TARGET_PATH_UNSUPPORTED，扩展名按 format 强制为 .pdf / .csv'
    },
    overwrite: {
      type: 'boolean',
      description: '可选，默认 false；同名文件存在时自动追加 (1)、(2)，为 true 时直接覆盖'
    },
    allowSanitize: {
      type: 'boolean',
      description: '可选，默认 false；仅当用户明确表示“随便放哪都行”时设为 true，系统净化路径后写入 userData/exports/'
    },
    ...COST_REPORT_SCHEMA.properties
  },
  required: ['format'],
  additionalProperties: false
};


function mainBreakerRating(
  design: { bomDraft?: { items?: readonly { name: string; partId?: string; packId?: string }[] } },
  parts: readonly ComponentPart[]
): number | undefined {
  const breaker = design.bomDraft?.items?.find((item) => /总进线断路器/.test(item.name));
  if (!breaker?.partId) return undefined;
  const part = parts.find((candidate) =>
    candidate.id === breaker.partId && (!breaker.packId || candidate.packId === breaker.packId)
  );
  const raw = part?.specs['额定电流'];
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string') {
    const match = raw.match(/(\d+(?:\.\d+)?)\s*A/i);
    if (match?.[1]) return Number(match[1]);
  }
  return undefined;
}

export class AgentTools {
  private readonly registry: PackRegistry;
  private readonly commands: AgentCommandExecutor | undefined;
  private readonly options: AgentToolsOptions;
  private readonly tools = new Map<string, AgentTool>();
  private signal: AbortSignal | undefined;

  constructor(registry: PackRegistry, commands?: AgentCommandExecutor, options: AgentToolsOptions = {}) {
    this.registry = registry;
    this.commands = commands;
    this.options = options;
    this.registerDefaults();
  }

  list(): AgentTool[] {
    return Array.from(this.tools.values()).filter((tool) => this.toolEnabled(tool.name));
  }

  summaries(): AgentToolSummary[] {
    return this.list().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async call(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`工具不存在：${name}`);
    const moduleId = AGENT_TOOL_MODULES[name];
    if (moduleId && !moduleIsEnabled(moduleId, this.options.isModuleEnabled)) {
      return moduleDisabledResult(moduleId);
    }
    const previous = this.signal;
    this.signal = signal;
    try {
      return await tool.handler(args);
    } finally {
      this.signal = previous;
    }
  }

  private add(tool: AgentTool): void {
    if (this.tools.has(tool.name)) throw new Error(`重复注册工具：${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  private toolEnabled(name: string): boolean {
    const moduleId = AGENT_TOOL_MODULES[name];
    return !moduleId || moduleIsEnabled(moduleId, this.options.isModuleEnabled);
  }

  private componentQuery(args: Record<string, unknown>): ComponentPart[] {
    const filter: { q?: string; category?: string; packId?: string } = {};
    const q = getString(args.q);
    const category = getString(args.category);
    const packId = getString(args.packId);
    if (q) filter.q = q;
    if (category) filter.category = category;
    if (packId) filter.packId = packId;
    return this.registry.listParts(filter);
  }

  private unavailable(): Record<string, unknown> {
    return {
      ok: false,
      code: 'AGENT_UNAVAILABLE',
      message: '命令总线未接入渲染层，请在 AutomationCAD 桌面应用内调用'
    };
  }

  private async execute(name: string, args: Record<string, unknown> = {}): Promise<CommandResult | null> {
    if (!this.commands) return null;
    return await this.commands.execute(name, args, this.signal);
  }

  private registerDefaults(): void {
    this.add({
      name: 'list_components',
      description: '列出已启用数据包中的元器件，可按类别和数据包筛选。',
      inputSchema: COMPONENT_FILTER_SCHEMA,
      handler: async (args) => {
        const components = this.componentQuery(args);
        // G2：统一 {items,total,truncated}；`components`/`count` 是保留一代的老字段。
        return { ok: true, ...listResult(components), count: components.length, components };
      }
    });

    this.add({
      name: 'search_components',
      description: '按型号、品牌、类别和规格搜索元器件。',
      inputSchema: {
        ...COMPONENT_FILTER_SCHEMA,
        required: ['q']
      },
      handler: async (args) => {
        const q = getString(args.q);
        if (!q) return { ok: false, code: 'INVALID_ARGUMENT', message: '缺少必填参数：q' };
        const components = this.componentQuery(args);
        return {
          ok: true,
          query: q,
          ...listResult(components),
          count: components.length,
          components
        };
      }
    });

    this.add({
      name: 'search_docs',
      description:
        '离线检索项目自带文档、截图索引与元件库分类（本地知识库）。涉及「怎么操作 / 限制 / 决策 / 为什么 / 缺尺寸怎么处理」时先查这里；只读、不联网，无命中返回空数组，不要编造。',
      inputSchema: SEARCH_DOCS_SCHEMA,
      handler: async (args) => {
        const query = getString(args.query);
        if (!query) return { ok: false, code: 'INVALID_ARGUMENT', message: '缺少必填参数：query' };
        if (args.limit !== undefined) {
          const limit = getNumber(args.limit);
          if (limit === undefined || !Number.isInteger(limit) || limit < 1 || limit > 5) {
            return { ok: false, code: 'INVALID_ARGUMENT', message: 'limit 必须是 1–5 的整数' };
          }
        }
        const limit = getNumber(args.limit);
        const hits = searchDocs(query, limit);
        // G2：统一列表形状；`hits` 是老字段名镜像（冒烟与既有调用方仍在读）。
        return { ok: true, query, ...listResult(hits), hits };
      }
    });

    this.add({
      name: 'design_machine',
      description:
        '从中文机型需求合成可确认的机型方案：工艺、工位、执行机构、传感器、节拍瓶颈、功率估算与 BOM 草案。只读，不写文件、不改当前工程；同时返回参数化整机几何摘要（布局、零件数、运动轴、外形包络 mm），几何为标准件外形、不含强度与干涉校核。',
      inputSchema: DESIGN_MACHINE_SCHEMA,
      handler: async (args) => {
        const briefText = getString(args.brief);
        if (!briefText) return { ok: false, code: 'INVALID_ARGUMENT', message: 'brief 不能为空' };

        let stationCount: number | undefined;
        if (args.stationCount !== undefined) {
          const value = getNumber(args.stationCount);
          if (value === undefined || !Number.isInteger(value) || value < MACHINE_STATIONS_MIN || value > MACHINE_STATIONS_MAX) {
            return {
              ok: false,
              code: 'INVALID_ARGUMENT',
              message: `stationCount 必须是 ${MACHINE_STATIONS_MIN}–${MACHINE_STATIONS_MAX} 的整数`
            };
          }
          stationCount = value;
        }

        let cyclePerMin: number | undefined;
        if (args.cyclePerMin !== undefined) {
          const value = getNumber(args.cyclePerMin);
          if (value === undefined || value <= 0) {
            return { ok: false, code: 'INVALID_ARGUMENT', message: 'cyclePerMin 必须是大于 0 的数字' };
          }
          cyclePerMin = value;
        }

        try {
          const bufferAnalysis = args.buffer === undefined ? undefined : analyzeBufferCapacity(args.buffer as BufferCapacityInput);
          const bufferTowerConfig = args.bufferTower === undefined ? undefined : args.bufferTower as BufferTowerConfig;
          // 塔身几何：单独一块入参。不塞进 bufferTower（容量身份）也不塞进 config.conveyor
          // （输送线的 1–8 层语义）。三者的关系只有一条：levels × slotsPerLevel === slotsPerTower。
          const towerGeometryInput = args.bufferTowerGeometry;
          let towerParams: ReturnType<typeof bufferTowerParamsFromConfig> | undefined;
          let towerParts: ConveyorPart[] | undefined;
          if (towerGeometryInput !== undefined) {
            if (bufferTowerConfig === undefined) {
              return {
                ok: false,
                code: 'INVALID_ARGUMENT',
                message: 'bufferTowerGeometry 必须与 bufferTower 同时给出：前者是塔身几何，后者是容量身份（towerCount/slotsPerTower），'
                  + '缺一个就无法核对「层数 × 每层位数 = 储位数」'
              };
            }
            // 形状**不再**指望 schema（进程内调用不跑 schema）：先按白名单挑键，多余键直接拒绝。
            // 容量身份（towers/slotsPerTower）只认 bufferTower，几何入参不能覆盖 —— 旧实现用
            // spread 把 geometry 的键放在容量身份之后，于是 `slotsPerTower:2` 能静默改掉 16。
            const geometryInput = coerceTowerGeometryInput(towerGeometryInput);
            // 显式字段赋值（不 spread 进 bufferTower）：多出来的键没有任何机会改写容量身份。
            towerParams = bufferTowerParamsFromConfig({
              bufferTower: {
                kind: 'tower',
                towers: bufferTowerConfig.towerCount,
                slotsPerTower: bufferTowerConfig.slotsPerTower,
                levels: geometryInput.levels,
                slotsPerLevel: geometryInput.slotsPerLevel,
                ...(geometryInput.layerPitchMm !== undefined ? { layerPitchMm: geometryInput.layerPitchMm } : {}),
                panel: geometryInput.panel,
                inbound: geometryInput.inbound,
                ...(geometryInput.frame !== undefined ? { frame: geometryInput.frame } : {})
              } as unknown as MachineBufferTowerConfig
            });
            towerParts = buildBufferTowerParts(towerParams);
          }
          // schema 无法表达"总量 ≤512"，这里先给出带两个乘数的明确回执，再交给纯数据层兜底。
          if (bufferTowerConfig !== undefined) {
            const towers = Number((bufferTowerConfig as { towerCount?: unknown }).towerCount);
            const perTower = Number((bufferTowerConfig as { slotsPerTower?: unknown }).slotsPerTower);
            if (Number.isSafeInteger(towers) && Number.isSafeInteger(perTower) && towers * perTower > MAX_BUFFER_SLOTS) {
              return {
                ok: false,
                code: 'INVALID_ARGUMENT',
                message: `缓存塔槽位总数 ${towers * perTower}（${towers}×${perTower}）不得超过 ${MAX_BUFFER_SLOTS}`
              };
            }
          }
          // 快照固定为「空队列 + 显式假设握手」，只推进一个扫描周期：
          // 不读设备状态、不写 IO、不产生任何“实时”读数。
          const handshake = { upstreamReady: true, downstreamReady: false, transferDone: false, fault: false };
          const bufferTower = bufferTowerConfig === undefined ? undefined : (() => {
            const state = createBufferQueue(bufferTowerConfig);
            const snapshot = stepBufferControl(createBufferControlMemory(), {
              queue: state, ...handshake, reset: false, nowSec: 0,
              transferTimeoutSec: BUFFER_SNAPSHOT_TRANSFER_TIMEOUT_SEC
            });
            const ioMapDraft = buildBufferIoMapDraft(bufferTowerConfig);
            const echoedSlots = state.slots.slice(0, BUFFER_SLOT_ECHO_LIMIT);
            return {
              readOnly: true as const,
              snapshotOf: 'empty-queue-assumed-handshake' as const,
              // 回显诊断假设：控制结论是在这些输入下算出来的，不是现场信号。
              assumedInputs: {
                ...handshake, reset: false, nowSec: 0, transferSeq: null,
                transferTimeoutSec: BUFFER_SNAPSHOT_TRANSFER_TIMEOUT_SEC
              },
              capabilityBoundary: {
                hardwareWired: false as const,
                plcProgramIncluded: false as const,
                plcAddressesAssigned: false as const,
                safetyCertified: false as const,
                queueModel: 'pure-data' as const,
                message: '该快照只演示纯数据队列与单步握手判定：未连接任何现场设备、未生成 PLC 程序、未分配 IO 地址、未经安全认证。'
              },
              config: bufferTowerConfig,
              limits: { slotCount: state.slots.length, maxSlots: MAX_BUFFER_SLOTS },
              io: bufferQueueIo(state),
              slots: echoedSlots,
              // 明确回显截断事实与总量，避免把“前 16 个槽位”误当成全部槽位。
              slotEcho: {
                returned: echoedSlots.length,
                total: state.slots.length,
                limit: BUFFER_SLOT_ECHO_LIMIT,
                truncated: echoedSlots.length < state.slots.length,
                message: echoedSlots.length < state.slots.length
                  ? `槽位明细仅回显前 ${BUFFER_SLOT_ECHO_LIMIT} 个（共 ${state.slots.length} 个），其余按计数与 limits 表达。`
                  : null
              },
              controlSnapshot: snapshot.state,
              signals: mapBufferIoSignals(snapshot.state, handshake),
              ioMapDraft,
              ioMapValidation: validateBufferIoMapDraft(ioMapDraft)
            };
          })();
          const bufferRequested = /缓存|FIFO|buffer/i.test(briefText);
          // 只要返回了缓存数字或缓存快照，就必须同时返回能力边界，不能依赖 brief 关键词。
          const bufferTouched = args.buffer !== undefined || args.bufferTower !== undefined;
          const bufferInputsEcho = args.buffer === undefined ? null : {
            upstreamCycleSec: (args.buffer as BufferCapacityInput).upstreamCycleSec ?? null,
            downstreamCycleSec: (args.buffer as BufferCapacityInput).downstreamCycleSec ?? null,
            downstreamStopSec: (args.buffer as BufferCapacityInput).downstreamStopSec ?? null,
            initialOccupancy: (args.buffer as BufferCapacityInput).initialOccupancy ?? null,
            inTransit: (args.buffer as BufferCapacityInput).inTransit ?? null,
            reserveSlots: (args.buffer as BufferCapacityInput).reserveSlots ?? null,
            capacity: (args.buffer as BufferCapacityInput).capacity ?? null
          };
          const brief = parseMachineBrief(briefText);
          const clarifyBrief = {
            ...brief,
            ...(stationCount !== undefined ? { stations: stationCount } : {}),
            ...(cyclePerMin !== undefined ? { cyclePerMin } : {}),
            notes: brief.notes.filter((note) =>
              !(stationCount !== undefined && note === DEFAULT_NOTE_STATIONS) &&
              !(cyclePerMin !== undefined && note === DEFAULT_NOTE_CYCLE)
            )
          };
          const clarify = buildClarify(clarifyBrief);
          const parts = this.registry.listParts();
          const pricingLoad = readMachinePricing(this.options.userDataRoot);
          let builtinPricebook: Pricebook | undefined;
          try {
            if (this.options.loadBuiltinPricebook) {
              builtinPricebook = validatePricebook(this.options.loadBuiltinPricebook());
            }
          } catch (error) {
            console.warn(`[MACHINE_COST_PRICEBOOK_FAILED]`, { site: 'desktop/src/agent/tools.ts:650' }, error);
          }
          const design = completeDesign(brief, parts, {
            ...(stationCount !== undefined ? { stationCount } : {}),
            ...(cyclePerMin !== undefined ? { cyclePerMin } : {}),
            pricingLoad,
            ...(builtinPricebook ? { builtinPricebook } : {})
          });
          // 摘要里的零件数必须来自唯一几何入口：输送类是 85 件参数化整机，
          // 不是 48 件代理体 —— 否则工具回执与评审/3D 又对不上。
          // 塔身几何：把归一化后的 config.bufferTower 写进 config（**不是**回执里临时拼一份），
          // apply/regen/干涉/3D 才会读同一份配置。同时把 config.conveyor 收敛成「第 1 层那条输送线」
          //（layers=1）：两份「层数」并存就是「参数不生效却看不出来」的老坑。
          if (towerParams !== undefined && towerParts !== undefined) {
            const towerConfig = towerParams.config;
            const previousLayers = design.config.conveyor?.layers;
            design.config = validateMachineConfig({
                ...design.config,
                bufferTower: towerConfig,
                conveyor: {
                  ...(design.config.conveyor ?? {}),
                  lengthMm: towerConfig.inbound.lengthMm,
                  widthMm: towerConfig.inbound.widthMm,
                  beltHeightMm: towerConfig.inbound.beltHeightMm,
                  frameSectionMm: towerConfig.frame.sectionMm,
                  layers: 1,
                  layerPitchMm: towerConfig.layerPitchMm
                }
              });
            if (previousLayers !== undefined && previousLayers > 1) {
              design.warnings.push(
                `缓存塔几何覆盖了 brief/方案推断的 conveyor.layers=${previousLayers}：`
                  + `塔的第 1 层就是这条底层输送线（layers=1），层数改由 config.bufferTower.levels=${towerConfig.levels} 表达`
              );
            }
            // BOM/成本口径：`design.bomDraft` 是机型方案的执行机构/传感器清单（底架输送线口径），
            // 不含塔身 117 件。不显式说，回执里「147 个碰撞刚体（146 装配 + 板）+ 8 行 BOM + cost.total」会被读成整机成本。
            const basePartCount = buildConveyorParts(bufferTowerInboundParams(towerParams)).length;
            const bomRows = Array.isArray(design.bomDraft?.items) ? design.bomDraft.items.length : 0;
            design.warnings.push(
              `BOM/成本未含塔身 ${towerParts.length - basePartCount} 件：design.bomDraft 只有 ${bomRows} 行（底架输送线口径），`
                + 'cost.total 只算这条底层输送线，不是整机成本；塔身件表见 bufferTowerGeometry.geometry.partBreakdown'
            );
            if (design.config.bufferTower === undefined) {
              return { ok: false, code: 'INTERNAL_ERROR', message: '缓存塔配置写回 config 后丢失：parseBufferTower 未保留 bufferTower 块' };
            }
          }
          const resolvedGeometry = resolveMachineGeometry(design);
          return {
            ok: true,
            // 原始需求随结果一起带回（**放在 design 外层**：design 的字段形状被
            // test/design/candidates.test.mjs 的 deepEqual 锁定）。联动调试要按同一句话
            // 重算时间线，否则面板只能拿机型名去重跑管线，算出来是另一台机器（步序/零件 id 全对不上）。
            brief: briefText,
            ...(bufferAnalysis ? { bufferAnalysis } : {}),
            ...(bufferTower ? { bufferTower } : {}),
            ...(towerParams !== undefined && towerParts !== undefined
              ? {
                bufferTowerGeometry: buildBufferTowerGeometryReceipt(towerParams, towerParts, resolvedGeometry, {
                  rows: Array.isArray(design.bomDraft?.items) ? design.bomDraft.items.length : 0,
                  costTotal: typeof design.cost?.total === 'number' ? design.cost.total : null
                })
              }
              : {}),
            ...(bufferTouched || bufferRequested ? { bufferCapability: {
              status: 'partial-concept-only',
              capacityVerified: false,
              capacityVerifiedReason: '工程未验收：容量只是在给定输入假设下算出的流量结论，不含真实节拍波动、机构吞吐与现场验收。',
              capacitySufficientFromInputs: bufferAnalysis?.capacitySufficient ?? null,
              fifoImplemented: false,
              geometrySlotsVerified: false,
              inputsEcho: bufferInputsEcho,
              message: '当前通用输送模板不是完整缓存机；层数不等于容量，单层槽位必须按工件长宽与间隙核算。bufferAnalysis仅核算流量，不能证明双塔、FIFO、托盘转移与安全已实现。',
              requiredInputs: args.buffer === undefined ? BUFFER_CAPACITY_SCHEMA.required : []
            } } : {}),
            design: {
              config: design.config,
              cycle: design.cycle,
              power: design.power,
              cost: design.cost,
              bomDraft: design.bomDraft,
              warnings: design.warnings,
              assumptions: design.assumptions,
              form: design.form
            },
            summary: summarizeMachineDesign(design),
            // 与评审/三态干涉/3D 同一份几何（输送类走参数化整机，其余走生成器）
            geometry: { ...summarizeGeometry(resolvedGeometry.geometry), source: resolvedGeometry.source },
            needs: clarify.needs,
            question: clarify.question
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // 三种情况必须分开，不能一律 INVALID_ARGUMENT：
          // - `BufferTowerConfigError.code === 'NOT_IMPLEMENTED'`：参数合法但本期几何不支持（双塔/每层多位）；
          // - 其余 `RangeError`：调用方参数越界（容量算式/层距/进料长度…），记 RANGE 日志，回 INVALID_ARGUMENT；
          // - 其它异常：**程序内部缺陷**。以前也回 INVALID_ARGUMENT，调用方会去改参数，
          //   而真正该做的是报缺陷——这里回 INTERNAL_ERROR 并给 hint，日志单独一条。
          if (error instanceof BufferTowerConfigError && error.code === 'NOT_IMPLEMENTED') {
            console.warn('[DESIGN_MACHINE_NOT_IMPLEMENTED]', { site: 'desktop/src/agent/tools.ts:design_machine' }, message);
            return { ok: false, code: 'NOT_IMPLEMENTED', message };
          }
          if (error instanceof RangeError) {
            // 缓存参数越界（RangeError）与内部程序缺陷分开记日志，回执 code 保持不变以免破坏调用方。
            console.warn('[DESIGN_MACHINE_RANGE_REJECTED]', { site: 'desktop/src/agent/tools.ts:design_machine' }, message);
            return {
              ok: false,
              code: 'INVALID_ARGUMENT',
              message
            };
          }
          console.warn('[DESIGN_MACHINE_FAILED]', { site: 'desktop/src/agent/tools.ts:design_machine' }, message);
          return {
            ok: false,
            code: 'INTERNAL_ERROR',
            message,
            hint: '这是软件内部异常（不是参数问题）：请不要改参数重试，直接反馈现场日志与机型 brief'
          };
        }
      }
    });

    this.add({
      name: 'apply_machine_design',
      description:
        '把机型方案写入 userData/machine/<id>.json 并把当前工程指向它；brief 与完整 design 二选一。需要用户确认，可用 undo_last 撤销。默认把 bomDraft 追加到 BOM 草稿（withBom=true），可选生成 PLC 点位映射 io-map.csv（withPlc=true）；默认生成参数化整机几何（geometry.json / model.stl / model.gltf / sidecar-assembly.json，withGeometry=true），withSolids=true 时在 build123d 内核可用时实体化为 STEP；成功后 3D 联调视图切到新配置的真实几何。口径：geometry.json 是碰撞几何（缓存塔含板时比装配件多 1，16 层 147 个刚体）；STL/glTF/sidecar（→STEP）是制造导出（缓存塔剔除板件，只出装配件，16 层 146）。',
      inputSchema: APPLY_MACHINE_DESIGN_SCHEMA,
      handler: async (args) => {
        const brief = getString(args.brief);
        const hasDesign = args.design !== undefined && args.design !== null;
        if (args.brief !== undefined && args.brief !== null && !brief) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'brief 不能为空' };
        }
        if (hasDesign && !isRecord(args.design)) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'design 必须是对象' };
        }
        if (Boolean(brief) === hasDesign) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'brief 与 design 必须二选一' };
        }
        if (args.name !== undefined && (typeof args.name !== 'string' || !args.name.trim())) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'name 必须是非空字符串' };
        }
        for (const key of ['overwrite', 'withBom', 'withPlc', 'withGeometry', 'withSolids'] as const) {
          if (args[key] !== undefined && args[key] !== null && typeof args[key] !== 'boolean') {
            return { ok: false, code: 'INVALID_ARGUMENT', message: `${key} 必须是布尔值` };
          }
        }
        const name = getString(args.name);
        const result = await this.execute('apply_machine_design', {
          ...(brief ? { brief } : {}),
          ...(hasDesign ? { design: args.design } : {}),
          ...(name ? { name } : {}),
          ...(args.overwrite === true ? { overwrite: true } : {}),
          ...(args.withBom !== undefined ? { withBom: args.withBom === true } : {}),
          ...(args.withPlc !== undefined ? { withPlc: args.withPlc === true } : {}),
          ...(args.withGeometry !== undefined && args.withGeometry !== null ? { withGeometry: args.withGeometry === true } : {}),
          ...(args.withSolids !== undefined && args.withSolids !== null ? { withSolids: args.withSolids === true } : {})
        });
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'list_machine_library',
      description:
        '只读列出本机机型库（userData/machine-library）里已有的机型包：id、名称、版本、包体字节数、来源（local/remote）与更新时间。统一返回 {items,total,truncated}，空库返回 items=[] 与 total=0，不报错；写库前先用它查 id。',
      inputSchema: LIST_MACHINE_LIBRARY_SCHEMA,
      handler: async () => {
        const result = await this.execute('list_machine_library', {});
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'save_machine_to_library',
      description:
        '把机型方案打包成 .machine.zip 存进本机机型库（含 config / geometry / bom.csv）。缺省存当前 active 机型；同名机型已存在时返回 LIBRARY_EXISTS 且绝不自动覆盖，确认要覆盖必须显式传 overwrite: true。需要用户确认。',
      inputSchema: SAVE_MACHINE_TO_LIBRARY_SCHEMA,
      handler: async (args) => {
        for (const key of ['id', 'name', 'version'] as const) {
          if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key].trim())) {
            return { ok: false, code: 'INVALID_ARGUMENT', message: `${key} 必须是非空字符串` };
          }
        }
        if (args.overwrite !== undefined && args.overwrite !== null && typeof args.overwrite !== 'boolean') {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'overwrite 必须是布尔值' };
        }
        const result = await this.execute('save_machine_to_library', {
          ...(getString(args.id) ? { id: getString(args.id) } : {}),
          ...(getString(args.name) ? { name: getString(args.name) } : {}),
          ...(getString(args.version) ? { version: getString(args.version) } : {}),
          ...(args.overwrite === true ? { overwrite: true } : {})
        });
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'load_machine_from_library',
      description:
        '从机型库加载一台机型：写回 userData/machine/<id>.json 与 active.json，BOM 草稿按包内 bom.csv 还原，并把 3D 联调视图切到该配置（applyMachineConfig）。需要用户确认；加载后当前工程指向该机型。',
      inputSchema: LOAD_MACHINE_FROM_LIBRARY_SCHEMA,
      handler: async (args) => {
        const id = getString(args.id);
        if (!id) return { ok: false, code: 'INVALID_ARGUMENT', message: '缺少必填参数：id' };
        const result = await this.execute('load_machine_from_library', { id });
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'export_machine_package',
      description:
        '把机型库里的机型导出成可分享的 .machine.zip，返回实际路径、字节数与 SHA-256。默认写 userData/exports/machines/<id>.machine.zip；targetPath 只接受 userData/exports 之内的位置（相对路径按 exports 解析），../、盘符或跳出 exports 返回 LIBRARY_BAD_PATH。需要用户确认。',
      inputSchema: EXPORT_MACHINE_PACKAGE_SCHEMA,
      handler: async (args) => {
        const id = getString(args.id);
        if (!id) return { ok: false, code: 'INVALID_ARGUMENT', message: '缺少必填参数：id' };
        if (args.targetPath !== undefined && args.targetPath !== null && typeof args.targetPath !== 'string') {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'targetPath 必须是字符串' };
        }
        const result = await this.execute('export_machine_package', {
          id,
          ...(getString(args.targetPath) ? { targetPath: getString(args.targetPath) } : {})
        });
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'list_machine_sources',
      description:
        '只读列机型库的远程来源（userData/machine-library/sources.json）与各自目录里的可下载机型：来源的在线状态（online/stale/errorCode）、机型 id/名称/版本/字节数/SHA-256/是否已在本机库（installed）。未配置来源时返回 sources=[]、items=[]，不报错；下载前先用它查 sourceId 与 machineId。只放行 https 目录源（本机开发可用 file + allowFile），目录缓存 10 分钟，拉不到时回退旧缓存并标 stale:true。',
      inputSchema: LIST_MACHINE_SOURCES_SCHEMA,
      handler: async () => {
        const result = await this.execute('list_machine_sources', {});
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'download_machine_from_source',
      description:
        '从远程来源下载一台机型并入库：流式下载（>50 MiB 立即中止）、边下边算 SHA-256 并与目录声明比对，通过后再走与本地导入同一套严格校验（条目白名单/路径穿越/原子落盘）。同名机型已存在时返回 LIBRARY_EXISTS 且**没有 overwrite 参数**（绝不自动覆盖，需先删除旧机型）。网络错误只重试 1 次（连接 5s / 总时长 60s），校验错误不重试。需要用户确认。',
      inputSchema: DOWNLOAD_MACHINE_FROM_SOURCE_SCHEMA,
      handler: async (args) => {
        const sourceId = getString(args.sourceId);
        if (!sourceId) return { ok: false, code: 'INVALID_ARGUMENT', message: '缺少必填参数：sourceId' };
        const machineId = getString(args.machineId);
        if (!machineId) return { ok: false, code: 'INVALID_ARGUMENT', message: '缺少必填参数：machineId' };
        const result = await this.execute('download_machine_from_source', { sourceId, machineId });
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'import_cad',
      description: '把 STEP/IGES/BREP/STL/OBJ/GLTF/GLB 文件导入当前查看会话。',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: '本机 CAD 文件绝对路径' } },
        required: ['path'],
        additionalProperties: false
      },
      handler: async (args) => {
        const result = await this.execute('import_cad', args);
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'get_bom',
      description: '读取当前装配体的简化 BOM（当前 CAD 零件 + 已插入占位件）。',
      inputSchema: EMPTY_SCHEMA,
      handler: async () => {
        const result = await this.execute('get_bom');
        return result ? commandSuccess(result) : this.unavailable();
      }
    });


    this.add({
      name: 'build_machine_model',
      description:
        '按机型参数生成整机 3D 模型并装配进当前视口：机型经注册表分发（conveyor / buffer-tower），走参数化内核（逐件实体 → 每件独立 STL），返回零件数、实体数、包络、总质量、BOM、STEP/STL 字节数。' +
        '可以直接给 brief（需求原文），工具会从里面取线体长/宽、「N 层」缓存层数，不必逐项填 params；params 显式给了就以 params 为准。' +
        'layers≥2 出立体缓存（底层输送 + 多层托架 + 升降机构），layers=1 是普通输送线。' +
        '缓存塔：给 process=\'buffer-tower\' 或直接给 design/config（design.config.bufferTower 是权威来源），出 146 件塔身（16 层；STL/STEP 件数同此，碰撞几何另加 1 块板 = 147 刚体）；' +
        '塔参数越界拒绝（不夹紧），process 与塔 design 冲突时显式拒绝而不是静默改建成 29 件底层输送线。' +
        'design/config 只对塔有意义：非塔机型请把尺寸放进 params（config.conveyor 不会被读取，会显式拒）；' +
        '塔也不要同时给 params（塔几何只认 config.bufferTower）。会落盘成工程。',
      inputSchema: BUILD_MACHINE_MODEL_SCHEMA,
      handler: async (args) => {
        if (args.process !== undefined && (typeof args.process !== 'string' || !args.process.trim())) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'process 必须是非空字符串' };
        }
        if (args.params !== undefined && args.params !== null && !isRecord(args.params)) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'params 必须是对象' };
        }
        if (args.design != null && !isRecord(args.design)) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'design 必须是对象（design_machine 返回的完整方案）' };
        }
        if (args.config != null && !isRecord(args.config)) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'config 必须是对象（塔块在 config.bufferTower）' };
        }
        if (args.name !== undefined && (typeof args.name !== 'string' || !args.name.trim())) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'name 必须是非空字符串' };
        }
        if (args.brief !== undefined && (typeof args.brief !== 'string' || !args.brief.trim())) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'brief 必须是非空字符串' };
        }
        if (args.load !== undefined && typeof args.load !== 'boolean') {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'load 必须是布尔值' };
        }
        const result = await this.execute('build_machine_model', {
          // 不在这里塞缺省 'conveyor'：塔的 design/config 在场时由命令层统一判分派，
          // 工具层先写死 conveyor 会把「只给 design」变成 process 冲突。
          ...(typeof args.process === 'string' ? { process: args.process.trim() } : {}),
          ...(typeof args.brief === 'string' && args.brief.trim() ? { brief: args.brief.trim() } : {}),
          ...(isRecord(args.params) ? { params: args.params } : {}),
          ...(isRecord(args.design) ? { design: args.design } : {}),
          ...(isRecord(args.config) ? { config: args.config } : {}),
          ...(typeof args.name === 'string' ? { name: args.name.trim() } : {}),
          ...(args.load === false ? { load: false } : {})
        });
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'build_canvas_assembly',
      description:
        '把当前画布方案（工位拓扑）生成整机 3D 示意装配工程并落盘：按每个工位的 dimsMm 与正交排布生成占位盒，返回工程 id、零件数、包络。' +
        '不含真实结构（孔/导轨/皮带都没有），质量为 null；要真实可制造几何请用 build_machine_model 或 apply_machine_design。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '工程名（默认取画布标题）' },
          open: { type: 'boolean', description: '是否生成后立即打开到视口，默认 true' },
          graph: {
            type: 'object',
            description: '可选：直接给 MachineGraph（nodes/edges）；不给则用当前画布草稿'
          }
        },
        additionalProperties: false
      },
      handler: async (args) => {
        if (args.name !== undefined && (typeof args.name !== 'string' || !args.name.trim())) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'name 必须是非空字符串' };
        }
        if (args.open !== undefined && typeof args.open !== 'boolean') {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'open 必须是布尔值' };
        }
        if (args.graph !== undefined && (typeof args.graph !== 'object' || args.graph === null || Array.isArray(args.graph))) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'graph 必须是 MachineGraph 对象' };
        }
        const result = await this.execute('build_canvas_assembly', {
          ...(typeof args.name === 'string' ? { name: args.name.trim() } : {}),
          ...(args.open === false ? { open: false } : {}),
          ...(args.graph !== undefined ? { graph: args.graph } : {})
        });
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'save_scene_as_project',
      description:
        '把当前视口里的模型逐件存成工程（出现在文件菜单，可再次打开、查零件树与包围盒）：逐件写 STL、包络取零件 AABB 并集。' +
        '质量恒为 null（导入网格没有材料/密度）。用于「导入 CAD 后落库」，不改动视口几何。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '工程名（默认取当前文件名 +「（导入）」）' }
        },
        additionalProperties: false
      },
      handler: async (args) => {
        if (args.name !== undefined && (typeof args.name !== 'string' || !args.name.trim())) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'name 必须是非空字符串' };
        }
        const result = await this.execute('save_scene_as_project', {
          ...(typeof args.name === 'string' ? { name: args.name.trim() } : {})
        });
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'get_render_stats',
      description:
        '读取当前 3D 视口的渲染指标：渲染器名称、是否软件渲染、像素比、质量档、零件/三角形数量，以及最近一次拖动的帧数、平均/最大帧时间。只读，用于定位「鼠标不跟手」是软件渲染、帧率还是装配体规模。',
      inputSchema: EMPTY_SCHEMA,
      handler: async () => {
        const stats = normalizeRenderStats(this.options.getRenderStats?.());
        return {
          ok: true,
          available: stats !== null,
          render: stats,
          conclusion: describeRenderStats(stats)
        };
      }
    });

    this.add({
      name: 'run_interference_check',
      description:
        '对装配体执行干涉检查。不传 states 时只查当前场景静态位姿（包围盒初筛，返回命中数与前 20 条，旧行为）。' +
        '传 states 时按当前 active 机型做位姿化检查：rest=静态、lift=顶升到位（可动件按 config 里真实行程平移）、sweep=按 10 mm 逐步顶升到行程、' +
        'push=顶升移载复合位姿（先按顶升轴抬到行程顶，再按移载轴沿 +Y **逐点**推到行程末端，行程同样读 config 的 travelMm）；' +
        '返回 {ok,reviewStatus,states:{rest|lift|sweep|push:{pairs,hits,screenHits,confirmedHits,mates,mm3,mm3Confirmed,mm3Screen,poseValidity,items}},lift:{...},push:{...}|null,workpiece:{...}|null,precision}。' +
        '工件（板）在移载机型上是一个**普通零件**（partId=workpiece-plate，尺寸由 conveyor.transferPartLengthMm/WidthMm/ThicknessMm 给，缺省 1200×800×35）：' +
        '它参与全部碰撞对，所以「板能不能从出料口推出去」是本工具能回答的问题；每态的 workpiecePairs/workpieceTouching 是「板真的在场」的证据。' +
        '口径：partCount（几何刚体数）含工件 +1，assemblyPartCount/BOM/成本**不含**工件；STL/STEP 制造导出按 machineExportParts（缓存塔剔除板件，件数 = assemblyPartCount，不是 partCount）。' +
        '口径必须按字段读：confirmedHits=解析式精确求交确认的实体重叠（唯一能否决出图的数字）；screenHits=只有包围盒依据或位姿不可达，只能当待复核；' +
        'mates=同轴嵌套配合（缸体×活塞杆这类，实体布尔必然重叠但不是干涉，不是缺陷）；mm3 含 declared/mate，只作量级参考。' +
        '顶升行程优先读 active 机型 config 的执行机构 travelMm（turner-lift）；config 里没有顶升机构时认几何标注了 strokeSource=geometry 的轴' +
        '（缓存塔 tower-lift，行程 = (层数−1)×层距），此时回执 lift.strokeSource=geometry，精度低于 config 行程；两种都没有才返回 STATE_UNAVAILABLE，绝不拿静态位姿冒充 lift；' +
        'directionOverridden=true 表示 config 方向与几何建模的伸出方向相反，该态是反向平移、位姿不可达。' +
        '要板承托/通道诊断时可加 requirePanel=true（须同时给 states）：该标志要求严格校验诊断适用条件（缺 states、无板、非缓存塔均为 INVALID_ARGUMENT）；缓存塔在缺省路径也会回这些只读诊断字段，requirePanel 不是字段开关。' +
        '几何无板或非缓存塔直接 INVALID_ARGUMENT。生产塔几何现在包含真实板（workpiece-plate 进 geometry.parts），所以 mode 可以是 verified；'
        + '但 verified 只说明「行表来自几何 + 碰撞集里有同一工件身份的这块板（含朝向）」，不是结构可行：rest unsupported（单条整带）、'
        + 'carried diagnostic-only（板不随塔轴移动、位移缺失）、feasible=false（load-passes-shelf + stroke-shortfall）；'
        + '判定认同一件成员（同 id + role=workpiece + box 尺寸/中心 ±EPS + rotationZDeg 有限且周期等价，缺一即不算；id 相同但 role/尺寸/中心/朝向不符 → 不是同一件成员，不计入碰撞集）。'
        + '板只在占位体里（parts 里没有同一工件身份的件）或行表来自调用方时仍 diagnostic-only。这些字段只是几何诊断，不构成结构结论。',
      inputSchema: INTERFERENCE_CHECK_SCHEMA,
      handler: async (args) => {
        if (args.states !== undefined && args.states !== null && !Array.isArray(args.states)) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'states 必须是数组（rest / lift / sweep / push）' };
        }
        if (args.requirePanel !== undefined && typeof args.requirePanel !== 'boolean') {
          return {
            ok: false,
            code: 'INVALID_ARGUMENT',
            message: 'requirePanel 必须是布尔值（true=要求承托/通道诊断，false 或省略=旧行为）'
          };
        }
        if (args.requirePanel === true && !Array.isArray(args.states)) {
          return {
            ok: false,
            code: 'INVALID_ARGUMENT',
            message: 'requirePanel 只在位姿化检查里成立：请同时传非空 states（rest / lift / sweep / push）',
            hint: '承托/通道要在几何上算，静态场景检查（不传 states）没有几何来源可查'
          };
        }
        const result = await this.execute('run_interference', {
          ...(Array.isArray(args.states) ? { states: args.states } : {}),
          ...(args.requirePanel === true ? { requirePanel: true } : {})
        });
        if (!result) return this.unavailable();
        if (!result.ok) return commandFailure(result);
        const data = isRecord(result.data) ? result.data : {};
        // 状态化结果本身就是终形状（可能带 ok:false + STATE_UNAVAILABLE/INVALID_ARGUMENT），原样返回：
        // panelSupport/panelFeasibility/panelChannelNote 不在这里挑字段，口径由 panel-channel.ts 定。
        if (isRecord(data.states) || data.ok === false) return data;
        const items = Array.isArray(data.items) ? data.items.slice(0, 20) : [];
        return {
          ok: true,
          hits: Number(data.hits ?? items.length),
          items
        };
      }
    });

    this.add({
      name: 'capture_view',
      description:
        '截取当前真实界面并落盘到 userData/agent-shots/<timestamp>-<view>.png，返回 {path,bytes,sha256,width,height,view}。' +
        '只读：不改工程。窗口未就绪或页面还停在首页时返回 VIEW_NOT_READY（不会返回首页截图冒充）；单张超过 5 MiB 会缩小重拍一次，仍超限返回 SHOT_TOO_LARGE。' +
        '字太小读不清时传 region:{x,y,w,h}（原图像素坐标、原点在图像左上，w/h>=32）只截这一块，裁剪先于缩放，再按 scale(0.5-3) 放大；上界是本次截图的**真实图像尺寸**（高 DPI 屏大于 1600x1000），越界按它夹紧并标 clamped=true；返回额外带 {region,clamped,scale,sourceSize}，可用范围以 sourceSize 为准。' +
        '给用户看画面、或需要自证「界面真的是这样」时用，拿到 sha256 后可让人在磁盘上复核。',
      inputSchema: CAPTURE_VIEW_SCHEMA,
      handler: async (args) => {
        const result = await this.execute('capture_view', args);
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'get_tool_result',
      description:
        '按 resultId 分批取回一个被截断的完整工具结果。工具结果超过单次上限时，回执会带 {truncated:true,resultId,bytes,hint}，' +
        '完整内容已落盘；用 hint 里的 offset 或回执的 nextOffset 续读，直到 eof=true，各片按顺序拼接即原文。' +
        '只读：不重跑原工具、不改工程；每个 resultId 对应一份固定内容，最多保留最近 50 个 / 32 MB。',
      inputSchema: GET_TOOL_RESULT_SCHEMA,
      handler: async (args) => {
        if (typeof args.resultId !== 'string' || !args.resultId.trim()) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'resultId 必须是截断回执里的 16 位十六进制字符串' };
        }
        for (const key of ['offset', 'limit'] as const) {
          const value = args[key];
          if (value === undefined || value === null) continue;
          const number = getNumber(value);
          if (number === undefined || !Number.isInteger(number) || number < (key === 'offset' ? 0 : 1)) {
            return {
              ok: false,
              code: 'INVALID_ARGUMENT',
              message: key === 'offset' ? 'offset 必须是不小于 0 的整数' : 'limit 必须是不小于 1 的整数'
            };
          }
        }
        for (const key of Object.keys(args)) {
          if (key !== 'resultId' && key !== 'offset' && key !== 'limit') {
            return { ok: false, code: 'INVALID_ARGUMENT', message: `未知参数：${key}` };
          }
        }
        const result = await this.execute('get_tool_result', args);
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'get_recent_audit',
      description:
        '读取**自己最近的工具调用审计**（最新在前）：工具名、结果码、耗时、自动验证结论与白名单参数。' +
        '用于「上次为什么不行 / 刚才那个错是什么」——`run_plc_generate`、`repair_plc_config`、`apply_machine_design` 失败后，先按工具名 + onlyFailed:true 查一次再决定怎么改，不要盲目重试同一组参数。' +
        '只读：不重跑工具、不改工程；返回 {items:[{ts,tool,code,ms,verified?,args}],total,truncated}，不含工具返回值内容、密钥与绝对路径（args 只保留 partId/ref/q/category/path/format/model/qty/x/y/rotate/railSnap）。' +
        '默认最近 1440 分钟 / 10 条，limit 上限 50，sinceMinutes 上限 10080。',
      inputSchema: GET_RECENT_AUDIT_SCHEMA,
      handler: async (args) => {
        for (const key of Object.keys(args)) {
          if (key !== 'limit' && key !== 'tool' && key !== 'onlyFailed' && key !== 'sinceMinutes') {
            return { ok: false, code: 'INVALID_ARGUMENT', message: `未知参数：${key}` };
          }
        }
        for (const key of ['limit', 'sinceMinutes'] as const) {
          const value = args[key];
          if (value === undefined || value === null) continue;
          const number = getNumber(value);
          if (number === undefined || !Number.isInteger(number)) {
            return { ok: false, code: 'INVALID_ARGUMENT', message: `${key} 必须是整数` };
          }
        }
        if (args.tool !== undefined && args.tool !== null && (typeof args.tool !== 'string' || !args.tool.trim())) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'tool 必须是非空字符串（按工具名精确匹配）' };
        }
        if (args.onlyFailed !== undefined && args.onlyFailed !== null && typeof args.onlyFailed !== 'boolean') {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'onlyFailed 必须是布尔值' };
        }
        const result = await this.execute('get_recent_audit', args);
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'suggest_kinematics',
      description:
        '对当前导入的 STEP 装配做运动件自动识别（按零件名/型号、装配层级、几何关系推断轴向、行程、置信度与 IO 点位）。只读：只生成建议并刷新运动标注抽屉的建议列表，从不写入标注；采纳必须由用户在抽屉里逐条确认并保存。',
      inputSchema: SUGGEST_KINEMATICS_SCHEMA,
      handler: async (args) => {
        if (args.includeLow !== undefined && typeof args.includeLow !== 'boolean') {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'includeLow 必须是布尔值' };
        }
        let limit = 20;
        if (args.limit !== undefined) {
          const value = getNumber(args.limit);
          if (value === undefined || !Number.isInteger(value) || value < 1 || value > 30) {
            return { ok: false, code: 'INVALID_ARGUMENT', message: 'limit 必须是 1–30 的整数' };
          }
          limit = value;
        }
        const result = await this.execute('suggest_kinematics');
        if (!result) return this.unavailable();
        if (!result.ok) return commandFailure(result);
        const data = isRecord(result.data) ? result.data : {};
        const meshes = Number(data.meshes ?? 0);
        const compact = (list: unknown): Record<string, unknown>[] =>
          (Array.isArray(list) ? list : [])
            .map(compactKinematicsSuggestion)
            .filter((item): item is Record<string, unknown> => item !== null);
        const high = compact(data.suggestions);
        const low = args.includeLow === false ? [] : compact(data.lowConfidence);
        return {
          ok: true,
          sourceFile: typeof data.sourceFile === 'string' ? data.sourceFile : '',
          meshes,
          existingParts: Number(data.existingParts ?? 0),
          summary: meshes === 0 ? '当前没有导入 CAD 模型，请先 import_cad 导入 STEP 装配' : String(data.summary ?? ''),
          stats: isRecord(data.stats) ? data.stats : {},
          suggestions: high.slice(0, limit),
          lowConfidence: low.slice(0, limit),
          truncated: high.length > limit || low.length > limit,
          skipped: Array.isArray(data.skipped) ? data.skipped.slice(0, 10) : [],
          applied: false,
          note: '仅为建议，未写入标注；请在「运动标注」抽屉逐条采纳，校验通过后保存。'
        };
      }
    });

    this.add({
      name: 'insert_component',
      description: '把数据包中的标准件作为占位件插入当前装配体。',
      inputSchema: {
        type: 'object',
        properties: {
          partId: { type: 'string', description: '数据包中的元器件 id' },
          name: { type: 'string', description: '可选的显示名称，缺省使用型号' }
        },
        required: ['partId'],
        additionalProperties: false
      },
      handler: async (args) => {
        const partId = getString(args.partId);
        if (!partId) return { ok: false, code: 'INVALID_ARGUMENT', message: '缺少必填参数：partId' };
        const part = this.registry.listParts().find((candidate) => candidate.id === partId);
        if (!part) return { ok: false, code: 'PART_NOT_FOUND', message: `元器件不存在：${partId}` };
        const name = getString(args.name);
        const result = await this.execute('insert_component', { partId, ...(name ? { name } : {}) });
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'place_component',
      description:
        '把元器件放到电箱底板指定坐标（mm）：可旋转 90°、导轨件可吸附；越界与重叠以 warnings 返回而不是直接拒绝。需要用户确认，可用 undo_last 撤销。',
      inputSchema: PLACE_COMPONENT_SCHEMA,
      handler: async (args) => {
        const partId = getString(args.partId);
        if (!partId) return { ok: false, code: 'INVALID_ARGUMENT', message: '缺少必填参数：partId' };
        const x = getNumber(args.x);
        const y = getNumber(args.y);
        if (x === undefined || y === undefined) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: '缺少必填参数：x/y（mm）' };
        }
        const resolution = resolvePartReference(this.registry.listParts(), partId);
        if (!resolution.ok) {
          return {
            ok: false,
            code: resolution.code,
            message: resolution.message,
            ...(resolution.candidates ? { candidates: resolution.candidates } : {})
          };
        }
        const part = resolution.part;
        const dims = part.dims;
        if (!dims || !(dims.w > 0) || !(dims.h > 0)) {
          return {
            ok: false,
            code: 'NO_DIMENSIONS',
            message: `元器件 ${part.model} 缺少外形尺寸（dims.w/dims.h），无法放置到底板`
          };
        }
        const result = await this.execute('place_component', {
          partId: part.id,
          x,
          y,
          rotate: args.rotate === true,
          railSnap: args.railSnap !== false
        });
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'run_electrical_check',
      description: '按线号/负载/回路数据执行电气校验：线号合规、功率统计（kW·kVA、分相电流、主断路器与进线建议、24V 余量）、导线截面与断路器配合，按严重级别返回问题清单。wires/loads/circuits 都不传时校验当前电气图纸（与电气域图纸、电气校验面板同源）。',
      inputSchema: ELEC_CHECK_SCHEMA,
      handler: async (args) => {
        const result = await this.execute('run_electrical_check', args);
        if (!result) return this.unavailable();
        if (!result.ok) return commandFailure(result);
        const data = isRecord(result.data) ? result.data : {};
        const findings = Array.isArray(data.findings) ? data.findings : [];
        const counts = isRecord(data.counts) ? data.counts : {};
        return {
          ok: true,
          counts: {
            error: Number(counts.error ?? 0),
            warning: Number(counts.warning ?? 0),
            info: Number(counts.info ?? 0)
          },
          summary: isRecord(data.summary) ? data.summary : {},
          findings: findings.slice(0, 50),
          truncated: findings.length > 50,
          ...(isRecord(data.source) ? { source: data.source } : {})
        };
      }
    });

    this.add({
      name: 'run_cost_report',
      description:
        '按 BOM 与价格簿计算机台硬件成本：硬件/辅材/人工小计、加成、税、运费与合计，附分类小计、缺价与告警；只读，不生成文件。未传 bom 时使用当前场景 BOM（场景零件没有物料号，会如实计入缺价而非按 0 处理）。',
      inputSchema: COST_REPORT_SCHEMA,
      handler: async (args) => {
        const result = await this.execute('run_cost_report', args);
        if (!result) return this.unavailable();
        return commandSuccess(result);
      }
    });

    this.add({
      name: 'export_cost_report',
      description:
        '按 BOM 与价格簿生成成本报告并写文件到用户数据目录 exports/（PDF 为 A4 纵向，CSV 带 UTF-8 BOM）。只接受纯文件名；绝对路径、盘符、UNC 与 ../ 默认返回 TARGET_PATH_UNSUPPORTED，只有 allowSanitize=true 才净化后落盘。需要用户确认；不会覆盖已有文件，除非 overwrite=true。返回实际落盘路径、字节数、明细行数与合计；未传 bom 时使用当前场景 BOM（可能全部缺物料号）。',
      inputSchema: COST_EXPORT_SCHEMA,
      handler: async (args) => {
        const pathFailure = exportPathFailure(args);
        if (pathFailure) return pathFailure;
        const result = await this.execute('export_cost_report', args);
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'verify_plc_program',
      description:
        '只读验证当前（或显式传入的）机型 PLC 生成程序：先跑预检，再生成 11 个文件并在内置模拟器执行联调序列，返回步骤、报警、耗时与失败原因。不落盘、不连接/写入真实 PLC。',
      inputSchema: VERIFY_PLC_PROGRAM_SCHEMA,
      handler: async (args) => {
        const config = isRecord(args.config) ? args.config as unknown as PlcGenConfig : null;
        const options = verifyOptions(args);
        if (config) {
          try {
            return summarizeVerification(verifyGenerated(config, options));
          } catch (error) {
            return {
              ok: false,
              code: 'VERIFY_FAILED',
              message: `验证失败：${error instanceof Error ? error.message : String(error)}`
            };
          }
        }
        const commandArgs: Record<string, unknown> = { ...options };
        const result = await this.execute('verify_plc_program', commandArgs);
        if (!result) return this.unavailable();
        if (!result.ok) return commandFailure(result);
        return result.data;
      }
    });

    this.add({
      name: 'get_project_context',
      description:
        '只读获取当前工程上下文：设计域、当前视图、选中对象、机型概要、底板尺寸与单位制，以及最近操作；缺失项返回 null，不猜测或编造。',
      inputSchema: EMPTY_SCHEMA,
      handler: async () => {
        const result = await this.execute('get_project_context');
        if (!result) return this.unavailable();
        if (!result.ok) return commandFailure(result);
        const data = isRecord(result.data) ? result.data : {};
        const history = this.commands?.history?.() ?? [];
        const recentActions = Array.isArray(data.recentActions) && data.recentActions.length > 0
          ? data.recentActions
          : history
              .filter((entry) => entry.name !== 'get_project_context')
              .slice(-5)
              .map((entry) => ({
                tool: entry.name,
                name: entry.name,
                summary: entry.summary ?? `${entry.name}${entry.ok ? ' 成功' : ' 失败'}`,
                at: entry.at
              }));
        return {
          ok: true,
          domain: data.domain ?? null,
          view: data.view ?? null,
          selection: data.selection ?? null,
          machine: data.machine ?? null,
          plate: data.plate ?? null,
          units: data.units ?? null,
          recentActions
        };
      }
    });

    this.add({
      name: 'update_component',
      description:
        '按 partId 或位号修改已有元器件的型号/数量/备注（底板或 BOM）；新型号必须存在于已启用数据包，否则返回 PART_NOT_FOUND；新件缺少外形尺寸时保留原尺寸并返回 NO_DIMENSIONS 告警。需要用户确认，可撤销。',
      inputSchema: UPDATE_COMPONENT_SCHEMA,
      handler: async (args) => {
        const partId = getString(args.partId);
        const ref = getString(args.ref) ?? getString(args.designator) ?? getString(args.tag);
        if (!partId && !ref) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: '必须提供 partId 或位号（ref）之一' };
        }
        const model = getString(args.model) ?? getString(args.newModel);
        const remark = typeof args.remark === 'string' ? args.remark : typeof args.note === 'string' ? args.note : undefined;
        const qty = getNumber(args.qty);
        if (qty !== undefined && (!Number.isInteger(qty) || qty <= 0)) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'qty 必须是大于 0 的整数' };
        }
        if (model === undefined && qty === undefined && remark === undefined) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: '至少提供 model / qty / remark 之一' };
        }
        if (args.target !== undefined && !['auto', 'plate', 'bom'].includes(String(args.target))) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'target 只能是 auto / plate / bom' };
        }
        const result = await this.execute('update_component', args);
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'remove_component',
      description:
        '按位号或 partId 从底板或 BOM 移除元器件；目标不存在时返回 NOT_PLACED；需要用户确认，可用 undo_last 撤销恢复。',
      inputSchema: REMOVE_COMPONENT_SCHEMA,
      handler: async (args) => {
        const partId = getString(args.partId);
        const ref = getString(args.ref) ?? getString(args.designator) ?? getString(args.tag);
        if (!partId && !ref) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: '必须提供 partId 或位号（ref）之一' };
        }
        if (args.target !== undefined && !['auto', 'plate', 'bom'].includes(String(args.target))) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'target 只能是 auto / plate / bom' };
        }
        const result = await this.execute('remove_component', args);
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'run_plc_generate',
      description:
        '按当前（或显式传入的）机型生成 11 个 PLC 工程文件并落盘到 userData/exports/plc/<机型>-<时间>/，同时写 ZIP；返回文件清单、预检结果与统计。预检有 error 时返回 PRECHECK_FAILED，不写任何文件。需要用户确认。',
      inputSchema: PLC_GENERATE_SCHEMA,
      handler: async (args) => {
        if (args.config !== undefined && !isRecord(args.config)) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'config 必须是对象' };
        }
        const target = getString(args.target);
        if (target !== undefined && !['generic', 's7-1200', 's7-1500', 'codesys'].includes(target)) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'target 只能是 generic / s7-1200 / s7-1500 / codesys' };
        }
        const namePrefix = getString(args.namePrefix);
        const sequenceTimeoutMs = getNumber(args.sequenceTimeoutMs);
        if (sequenceTimeoutMs !== undefined && sequenceTimeoutMs <= 0) {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'sequenceTimeoutMs 必须大于 0' };
        }
        const result = await this.execute('run_plc_generate', {
          ...(args.config !== undefined ? { config: args.config } : {}),
          ...(target ? { target } : {}),
          ...(namePrefix ? { namePrefix } : {}),
          ...(sequenceTimeoutMs !== undefined ? { sequenceTimeoutMs } : {})
        });
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'validate_machine_design',
      description:
        '只读自查机型方案：结构/字段/点位唯一/工位引用/执行机构 id 唯一/传感器 part 绑定，与 apply_machine_design 落盘、run_plc_generate 预检同一份判定源（machine/validate.ts）。缺省校验当前 active 机型；也可传 design_machine 返回的 config。返回 {ok,issues:[{code,path,message,hint}],summary:{errors,warnings}}；方案有问题返回 ok=false 而不是工具失败。只做结构与绑定校验，PLC 轴/信号预检仍要看 run_plc_generate。',
      inputSchema: VALIDATE_MACHINE_DESIGN_SCHEMA,
      handler: async (args) => {
        const result = await this.execute('validate_machine_design', {
          ...(args.config !== undefined ? { config: args.config } : {})
        });
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'repair_plc_config',
      description:
        '补齐当前 active 机型的 PLC 预检缺口（执行机构缺到位检测、缺急停/安全门回路），只加检测点与安全回路，不改已有执行机构与点位。默认 dryRun=true 只列 willAdd，不写盘；dryRun=false 才写回 userData/machine/<id>.json 并刷新联调配置，写前过 assertDesign。已补齐时 willAdd/added/remainingIssues 都为空，不报错。需要用户确认。',
      inputSchema: REPAIR_PLC_CONFIG_SCHEMA,
      handler: async (args) => {
        if (args.dryRun !== undefined && args.dryRun !== null && typeof args.dryRun !== 'boolean') {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'dryRun 必须是布尔值' };
        }
        const result = await this.execute('repair_plc_config', {
          ...(args.dryRun !== undefined && args.dryRun !== null ? { dryRun: args.dryRun === true } : {})
        });
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'export_files',
      description:
        '导出当前装配体为 pdf / dxf / glb / bom（BOM 为 CSV），写入 userData/exports/ 并返回实际路径与字节数。只接受纯文件名；绝对路径、盘符、UNC 与 ../ 默认返回 TARGET_PATH_UNSUPPORTED，只有 allowSanitize=true 才净化后落盘。文件名与 export_cost_report 共用同一净化/冲突规则；默认不覆盖，除非 overwrite=true。需要用户确认。',
      inputSchema: EXPORT_FILES_SCHEMA,
      handler: async (args) => {
        const kind = getString(args.kind);
        if (!kind || !['pdf', 'dxf', 'glb', 'bom'].includes(kind)) {
          return { ok: false, code: 'UNSUPPORTED_FORMAT', message: '导出格式仅支持 pdf / dxf / glb / bom' };
        }
        if (args.fileName !== undefined && args.fileName !== null && typeof args.fileName !== 'string') {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'fileName 必须是字符串' };
        }
        if (args.overwrite !== undefined && args.overwrite !== null && typeof args.overwrite !== 'boolean') {
          return { ok: false, code: 'INVALID_ARGUMENT', message: 'overwrite 必须是布尔值' };
        }
        const pathFailure = exportPathFailure(args);
        if (pathFailure) return pathFailure;
        const result = await this.execute('export_files', args);
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'get_agent_memory',
      description:
        '读取当前工程的跨会话项目记忆：最近 20 条**事实**（机型应用到工程 / 存入库 / 从库加载 / PLC 生成 / 补齐配置），每条含时间、类型、摘要与关联 id。只读，用于回答「你记得我上次做什么」「上次改的哪台机型」。记录里不含密钥与路径；不同工程分开存，互不串台。',
      inputSchema: EMPTY_SCHEMA,
      handler: async () => {
        const result = await this.execute('get_agent_memory');
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'clear_agent_memory',
      description:
        '清空**当前工程**的跨会话项目记忆（返回 cleared 条数）；其他工程不受影响，也不动机型库、工程文件与审计。这是写操作，需要用户确认。用户说「忘掉这个项目的记录」时用。',
      inputSchema: EMPTY_SCHEMA,
      handler: async () => {
        const result = await this.execute('clear_agent_memory');
        return result ? commandSuccess(result) : this.unavailable();
      }
    });

    this.add({
      name: 'undo_last',
      description: '撤销最近一次可撤销的写操作（占位件插入、底板放置、元器件修改/移除），返回被撤销的命令与 id。',
      inputSchema: EMPTY_SCHEMA,
      handler: async () => {
        if (!this.commands) return this.unavailable();
        return commandSuccess(await this.commands.undoLast());
      }
    });
  }
}
