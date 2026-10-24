import type { PackRegistry } from '../packs/registry';
import type { ComponentPart } from '../shared/types';
import type { CommandHistoryEntry, CommandResult } from './commands';
import { resolvePartReference } from './placement.ts';
import { checkExportTargetPath } from './policy.ts';
import type { PlcGenConfig } from '../plcgen/types.ts';
import { summarizeVerification, verifyGenerated, type VerifyOptions } from '../plcgen/verify.ts';
import { searchDocs } from './kb/search.ts';
import {
  DEFAULT_NOTE_CYCLE,
  DEFAULT_NOTE_STATIONS,
  parseMachineBrief,
  MACHINE_STATIONS_MAX,
  MACHINE_STATIONS_MIN
} from '../machine/spec.ts';
import { summarizeMachineDesign, synthMachine } from '../machine/synth.ts';
import { mapMachineBom } from '../machine/bom-map.ts';
import { estimatePower } from '../machine/power.ts';
import { estimateCost, readMachinePricing } from '../machine/cost-model.ts';
import { validatePricebook, type Pricebook } from '../cost/pricebook.ts';
import { buildClarify } from '../machine/clarify.ts';
import { generateMachineGeometry, summarizeGeometry } from '../machine/geometry.ts';
import { AGENT_TOOL_MODULES, moduleDisabledResult, moduleIsEnabled, type ModuleEnabledReader } from '../modules/tool-gates.ts';

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
}

export interface AgentCommandExecutor {
  execute(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<CommandResult>;
  undoLast(signal?: AbortSignal): Promise<CommandResult>;
  history?(): CommandHistoryEntry[];
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

const SUGGEST_KINEMATICS_SCHEMA = {
  type: 'object',
  properties: {
    includeLow: { type: 'boolean', description: '是否同时返回低置信度建议（默认 true）', default: true },
    limit: { type: 'integer', minimum: 1, maximum: 30, description: '每档最多返回几条，1–30，默认 20', default: 20 }
  },
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

const SEARCH_DOCS_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: '要查的文档问题或关键词，如「导轨」「干涉」「D2 决策」' },
    limit: { type: 'integer', minimum: 1, maximum: 5, description: '返回条数，默认 3，最多 5' }
  },
  required: ['query'],
  additionalProperties: false
};

const DESIGN_MACHINE_SCHEMA = {
  type: 'object',
  properties: {
    brief: {
      type: 'string',
      minLength: 1,
      description: '中文机型需求，例如「设计一台三工位锁螺丝机，节拍 20 件/分钟，用 750W 伺服」'
    },
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
  return {
    ok: false,
    code: result.error?.code ?? 'COMMAND_FAILED',
    message: result.error?.message ?? '命令执行失败'
  };
}

function commandSuccess(result: CommandResult): Record<string, unknown> {
  if (!result.ok) return commandFailure(result);
  return {
    ok: true,
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
        return { ok: true, count: components.length, components };
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
        return { ok: true, query: q, count: components.length, components };
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
        return { ok: true, query, hits };
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
          const design = synthMachine(brief, {
            ...(stationCount !== undefined ? { stationCount } : {}),
            ...(cyclePerMin !== undefined ? { cyclePerMin } : {}),
            parts,
            pricing: pricingLoad.pricing,
            pricingAssumptions: pricingLoad.assumptions,
            ...(builtinPricebook ? { builtinPricebook } : {})
          });
          let mapped = false;
          try {
            const bomMapping = mapMachineBom(design, parts);
            design.bomDraft = { items: bomMapping.items };
            mapped = true;
            if (bomMapping.pending.length > 0) {
              design.warnings.push(...bomMapping.pending.map((entry) => `${entry.name}：${entry.reason}`));
            }
            design.warnings.push(...bomMapping.notices);
          } catch (error) {
            // 精简测试注册表或自定义元件包可能不含完整型号；保留通用 BOM 草案。
            console.warn(`[MACHINE_BOM_MAPPING_FAILED]`, { site: 'desktop/src/agent/tools.ts:654' }, error);
          }

          const selectedBreakerA = mainBreakerRating(design, parts);
          design.power = estimatePower(design, {
            parts,
            voltage: design.power.voltage,
            simultaneity: pricingLoad.pricing.power.simultaneity,
            loadFactor: pricingLoad.pricing.power.loadFactor,
            efficiency: pricingLoad.pricing.power.efficiency,
            cosPhi: pricingLoad.pricing.power.cosPhi,
            ...(selectedBreakerA !== undefined ? { selectedBreakerA } : {}),
            assumptions: pricingLoad.assumptions
          });
          design.cost = estimateCost(design, {
            parts,
            pricing: pricingLoad.pricing,
            pricingAssumptions: pricingLoad.assumptions,
            ...(builtinPricebook ? { builtinPricebook } : {})
          });
          design.assumptions.push(...pricingLoad.warnings);
          return {
            ok: true,
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
            geometry: summarizeGeometry(generateMachineGeometry(design)),
            needs: clarify.needs,
            question: clarify.question
          };
        } catch (error) {
          return {
            ok: false,
            code: 'INVALID_ARGUMENT',
            message: error instanceof Error ? error.message : String(error)
          };
        }
      }
    });

    this.add({
      name: 'apply_machine_design',
      description:
        '把机型方案写入 userData/machine/<id>.json 并把当前工程指向它；brief 与完整 design 二选一。需要用户确认，可用 undo_last 撤销。默认把 bomDraft 追加到 BOM 草稿（withBom=true），可选生成 PLC 点位映射 io-map.csv（withPlc=true）；默认生成参数化整机几何（geometry.json / model.stl / model.gltf / sidecar-assembly.json，withGeometry=true），withSolids=true 时在 build123d 内核可用时实体化为 STEP；成功后 3D 联调视图切到新配置的真实几何。',
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
      name: 'run_interference_check',
      description: '对当前装配体执行包围盒级干涉初筛，返回命中数与前 20 条。',
      inputSchema: EMPTY_SCHEMA,
      handler: async () => {
        const result = await this.execute('run_interference');
        if (!result) return this.unavailable();
        if (!result.ok) return commandFailure(result);
        const data = isRecord(result.data) ? result.data : {};
        const items = Array.isArray(data.items) ? data.items.slice(0, 20) : [];
        return {
          ok: true,
          hits: Number(data.hits ?? items.length),
          items
        };
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
      description: '按线号/负载/回路数据执行电气校验：线号合规、功率统计（kW·kVA、分相电流、主断路器与进线建议、24V 余量）、导线截面与断路器配合，按严重级别返回问题清单。',
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
          truncated: findings.length > 50
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
