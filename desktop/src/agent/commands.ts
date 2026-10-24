import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import type { PackRegistry } from '../packs/registry';
import type { ComponentPart } from '../shared/types.ts';
import { CAD_EXTENSIONS, isCadExtension } from '../shared/cad.ts';
import {
  runElectricalCheck,
  type CircuitCheck,
  type ElecDocument,
  type Load,
  type Phase,
  type PowerOptions,
  type Wire
} from '../elec/check.ts';
import { runCostTool, CostToolError } from '../cost/agent.ts';
import type { Issue, PlcGenConfig } from '../plcgen/types.ts';
import { summarizeVerification, verifyGenerated, type VerifyOptions } from '../plcgen/verify.ts';
import { generateProject } from '../plcgen/generate.ts';
import { planPlcExportDirectory } from '../plcgen/export.ts';
import {
  buildCostExport,
  CostExportError,
  planArtifactExportName,
  type CostExportSaveResult
} from '../cost/export.ts';
import { createZip } from '../shared/zip.ts';
import { recordDiagnosticError } from '../shared/diagnostics.ts';
import { resolvePartReference } from './placement.ts';
import { checkExportTargetPath } from './policy.ts';
import { parseMachineBrief } from '../machine/spec.ts';
import { synthMachine } from '../machine/synth.ts';
import { estimatePower } from '../machine/power.ts';
import { estimateCost, readMachinePricing } from '../machine/cost-model.ts';
import { validatePricebook, type Pricebook } from '../cost/pricebook.ts';
import {
  activeMachinePath,
  buildMachineBomRows,
  machineBomDraftPath,
  machineDesignPath,
  machineDesignContent,
  machineGeometryPaths,
  readActiveMachineDesign,
  readBase64IfExists,
  readActivePointer,
  readStoredMachineDesign,
  readTextIfExists,
  renderMachineBomCsv,
  restoreBase64,
  restoreText,
  sanitizeMachineId,
  validateMachineDesign,
  writeActivePointer,
  writeBytes,
  writeText,
  type MachineBomRow,
  type NormalizedMachineDesign,
  type StoredMachineDesign
} from '../machine/store.ts';
import { buildMachineIoMap } from '../machine/io-map.ts';
import { AGENT_COMMAND_MODULES, moduleDisabledResult, moduleIsEnabled, type ModuleEnabledReader } from '../modules/tool-gates.ts';
import { COST_ESTIMATION_MODULE_ID } from '../modules/cost-estimation-gate.ts';
import { PARAMETRIC_IMPORT_MODULE_ID, PARAMETRIC_MODULE_DISABLED_MESSAGE } from '../modules/parametric-gate.ts';
import { generateMachineGeometry, summarizeGeometry } from '../machine/geometry.ts';
import {
  buildMachineSolids,
  geometryToGltf,
  geometryToSidecarAssemblies,
  geometryToStl,
  type SolidBuildResult
} from '../machine/geometry-export.ts';
import type { AssemblyDoc } from '../parametric/features.ts';

export interface Bridge {
  call<T>(method: string, args?: unknown): Promise<T>;
}

export interface CommandError {
  code: string;
  message: string;
}

export interface CommandResult {
  ok: boolean;
  data?: unknown;
  error?: CommandError;
}

export interface CommandHistoryEntry {
  name: string;
  at: string;
  ok: boolean;
  /** 人类可读摘要；对象类操作附带 `[target=kind:id:label]`，供指代消解回退。 */
  summary?: string;
}

export interface CommandContext {
  registry: PackRegistry;
  bridge: Bridge;
  /** 主进程注入的可选模块状态；模块状态未就绪或读取失败时失败关闭。 */
  isModuleEnabled?: ModuleEnabledReader;
  /** 读取内置价格簿（主进程注入）；返回原始 JSON 或已校验对象 */
  loadBuiltinPricebook?: () => unknown;
  /** HTML → PDF 字节（主进程注入，复用 A4 打印管线）；PDF 导出用。 */
  renderCostPdf?: (html: string) => Promise<Uint8Array>;
  /** 固定导出根目录（userData/exports）；export_files 与 run_plc_generate 用。 */
  exportsRoot?: string;
  /** 用户数据根目录（userData）；apply_machine_design 用。 */
  userDataRoot?: string;
  /** build123d sidecar 实体化（主进程注入，内核未就绪时返回 ok:false）；apply_machine_design withSolids 用。 */
  buildSolids?: (doc: AssemblyDoc) => Promise<SolidBuildResult>;
  /** HTML → PDF 字节（A3 横向装配报告）；export_files 的 pdf 用。 */
  renderReportPdf?: (html: string) => Promise<Uint8Array>;
  /** 可注入的时钟；测试用，缺省当前时间。 */
  now?: () => Date;
}

export interface CommandBusOptions {
  isModuleEnabled?: ModuleEnabledReader;
  loadBuiltinPricebook?: () => unknown;
  renderCostPdf?: (html: string) => Promise<Uint8Array>;
  exportsRoot?: string;
  userDataRoot?: string;
  renderReportPdf?: (html: string) => Promise<Uint8Array>;
  buildSolids?: (doc: AssemblyDoc) => Promise<SolidBuildResult>;
  now?: () => Date;
}

interface CommandRunResult extends CommandResult {
  undoToken?: unknown;
}

export interface Command {
  name: string;
  run(args: Record<string, unknown>, ctx: CommandContext, signal?: AbortSignal): Promise<CommandRunResult>;
  undo?(token: unknown, ctx: CommandContext): Promise<unknown>;
}

interface UndoRecord {
  command: Command;
  token: unknown;
}

interface BridgeFailure {
  ok: false;
  message?: string;
}

interface InsertBridgeResult {
  ok: boolean;
  meshIndex?: number;
  name?: string;
  message?: string;
}

interface ImportBridgeResult {
  ok: boolean;
  meshCount?: number;
  triangleCount?: number;
  message?: string;
}

interface InterferenceBridgeItem {
  a: string;
  b: string;
  volume: number;
  severity: string;
}

/** 渲染层 suggestKinematics 的返回；建议对象原样透传，由 suggest_kinematics 工具压缩。 */
interface KinematicsSuggestBridgeResult {
  sourceFile?: string;
  meshes?: number;
  existingParts?: number;
  summary?: string;
  stats?: Record<string, number>;
  suggestions: unknown[];
  lowConfidence: unknown[];
  skipped?: { name: string; reason: string }[];
}

interface InterferenceBridgeResult {
  hits: number;
  items: InterferenceBridgeItem[];
}

interface PlacementBridgeResult {
  ok: boolean;
  placement?: {
    id: string;
    partId: string;
    model: string;
    x: number;
    y: number;
    w: number;
    h: number;
    railId?: string;
  };
  warnings?: Array<{ code: 'OVERLAP' | 'OUT_OF_BOUNDS'; message: string }>;
  code?: string;
  message?: string;
}

export interface BridgeWindow {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed?(): boolean;
    executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  };
}

const BRIDGE_METHODS = new Set([
  'ready',
  'getScene',
  'getSelection',
  'getBom',
  'insertComponent',
  'removeComponent',
  'placeEnclosurePart',
  'removeEnclosurePart',
  'runInterference',
  'suggestKinematics',
  'getPlcGenConfig',
  'importPath',
  'exportCostFile',
  'getProjectContext',
  'updateComponent',
  'removeProjectComponent',
  'restoreProjectComponent',
  'exportArtifact',
  'applyMachineConfig',
  'appendMachineBomRows',
  'removeMachineBomRows'
]);

export const SIMPLE_BOM_NOTE = '简化 BOM：由当前 CAD 零件与已插入占位件生成；型号取零件名称，材料统一记为“—”。';

export class CommandFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CommandFailure';
    this.code = code;
  }
}

function failed(code: string, message: string): CommandResult {
  return { ok: false, error: { code, message } };
}

function errorResult(error: unknown, fallbackCode = 'COMMAND_FAILED'): CommandResult {
  if (error instanceof CommandFailure) return failed(error.code, error.message);
  return failed(fallbackCode, error instanceof Error ? error.message : String(error));
}

function cleanTargetPart(value: string): string {
  return value.replace(/[\[\]:\r\n]/g, ' ').trim().slice(0, 60);
}

function targetMarker(kind: string, id: string, label: string): string {
  const safeId = cleanTargetPart(id);
  const safeLabel = cleanTargetPart(label) || safeId;
  return safeId ? ` [target=${kind}:${safeId}:${safeLabel}]` : '';
}

function historyObjectTarget(
  name: string,
  args: Record<string, unknown>,
  result?: unknown
): { kind: 'component' | 'placement'; id: string; label: string } | null {
  if (!['insert_component', 'place_component', 'update_component', 'remove_component'].includes(name)) return null;
  const data = isRecord(result) && isRecord(result.data) ? result.data : null;
  const argsPart = typeof args.partId === 'string' ? args.partId : typeof args.ref === 'string' ? args.ref : '';
  if (name === 'place_component') {
    const placement = data && isRecord(data.placement) ? data.placement : null;
    const id = placement && typeof placement.id === 'string' ? placement.id : '';
    const label = placement
      ? (typeof placement.tag === 'string' && placement.tag)
        || (typeof placement.model === 'string' && placement.model)
        || (typeof placement.partId === 'string' && placement.partId)
        || argsPart
      : argsPart;
    return id ? { kind: 'placement', id, label: String(label || id) } : null;
  }
  const id = argsPart || (data && typeof data.name === 'string' ? data.name : '');
  if (!id) return null;
  const label = (data && typeof data.name === 'string' && data.name) || argsPart || id;
  return { kind: 'component', id, label: String(label) };
}

/** 命令历史摘要：只保留白名单参数，绝不把密钥写进历史。 */
export function summarizeCommandResult(
  name: string,
  args: Record<string, unknown>,
  result?: unknown
): string {
  const ok = !isRecord(result) || result.ok !== false;
  const parts: string[] = [];
  for (const key of ['partId', 'ref', 'q', 'category', 'format', 'model', 'qty', 'x', 'y']) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') parts.push(`${key}=${cleanTargetPart(value)}`);
    else if (typeof value === 'number' || typeof value === 'boolean') parts.push(`${key}=${value}`);
  }
  const target = historyObjectTarget(name, args, result);
  const detail = parts.length > 0 ? `（${parts.join(', ')}）` : '';
  return `${name}${detail}${ok ? ' 成功' : ' 失败'}${target ? targetMarker(target.kind, target.id, target.label) : ''}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBridgeFailure(value: unknown): value is BridgeFailure {
  return isRecord(value) && value.ok === false;
}

function bridgeFailureMessage(value: unknown, fallback: string): string {
  return isBridgeFailure(value) && typeof value.message === 'string' && value.message.trim()
    ? value.message
    : fallback;
}

function requiredString(args: Record<string, unknown>, key: string, label: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new CommandFailure('INVALID_ARGUMENT', `${label}不能为空`);
  }
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function requiredNumber(args: Record<string, unknown>, key: string, label: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CommandFailure('INVALID_ARGUMENT', `${label}必须是毫米数值`);
  }
  return value;
}

export class CommandBus {
  private readonly context: CommandContext;
  private readonly commands = new Map<string, Command>();
  private readonly records: CommandHistoryEntry[] = [];
  private readonly undoStack: UndoRecord[] = [];

  constructor(context: CommandContext) {
    this.context = context;
  }

  register(command: Command): void {
    if (this.commands.has(command.name)) {
      throw new Error(`重复注册命令：${command.name}`);
    }
    this.commands.set(command.name, command);
  }

  async execute(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<CommandResult> {
    const command = this.commands.get(name);
    if (!command) {
      return failed('UNKNOWN_COMMAND', `未知命令：${name}`);
    }
    const moduleId = AGENT_COMMAND_MODULES[name];
    if (moduleId && !moduleIsEnabled(moduleId, this.context.isModuleEnabled)) {
      const disabled = moduleDisabledResult(moduleId);
      return failed(disabled.code, disabled.message);
    }
    if (signal?.aborted) return failed('CANCELLED', '已取消，未执行该命令');

    let result: CommandRunResult;
    try {
      result = await command.run(args, this.context, signal);
    } catch (error) {
      if (signal?.aborted) {
        this.record(name, false, summarizeCommandResult(name, args, { ok: false }));
        return failed('CANCELLED', '已取消，未执行该命令');
      }
      this.record(name, false, summarizeCommandResult(name, args, { ok: false }));
      return errorResult(error);
    }
    if (signal?.aborted) {
      this.record(name, false, summarizeCommandResult(name, args, { ok: false }));
      return failed('CANCELLED', '已取消');
    }

    const ok = result.ok === true;
    this.record(name, ok, summarizeCommandResult(name, args, result));
    if (!ok) {
      return {
        ok: false,
        error: result.error ?? { code: 'COMMAND_FAILED', message: '命令执行失败' }
      };
    }

    if (command.undo && result.undoToken !== undefined) {
      this.undoStack.push({ command, token: result.undoToken });
    }
    return {
      ok: true,
      ...(result.data !== undefined ? { data: result.data } : {})
    };
  }

  async undoLast(signal?: AbortSignal): Promise<CommandResult> {
    if (signal?.aborted) return failed('CANCELLED', '已取消，未执行撤销');
    const record = this.undoStack.pop();
    if (!record) {
      return failed('NOTHING_TO_UNDO', '没有可撤销的命令');
    }
    if (!record.command.undo) {
      return failed('UNDO_UNAVAILABLE', `命令不可撤销：${record.command.name}`);
    }
    try {
      const detail = await record.command.undo(record.token, this.context);
      return {
        ok: true,
        data: {
          command: record.command.name,
          ...(isRecord(detail) ? detail : {})
        }
      };
    } catch (error) {
      this.undoStack.push(record);
      return errorResult(error, 'UNDO_FAILED');
    }
  }

  history(): CommandHistoryEntry[] {
    return this.records.map((record) => ({ ...record }));
  }

  private record(name: string, ok: boolean, summary?: string): void {
    this.records.push({
      name,
      at: new Date().toISOString(),
      ok,
      ...(summary ? { summary } : {})
    });
    if (this.records.length > 200) this.records.splice(0, this.records.length - 200);
  }
}

export class RendererBridge implements Bridge {
  private readonly getWindow: () => BridgeWindow | null;
  private readonly timeoutMs: number;

  constructor(getWindow: () => BridgeWindow | null, timeoutMs = 10_000) {
    this.getWindow = getWindow;
    this.timeoutMs = timeoutMs;
  }

  async call<T>(method: string, args?: unknown): Promise<T> {
    if (!BRIDGE_METHODS.has(method)) {
      throw new CommandFailure('INVALID_METHOD', `不支持的渲染桥方法：${method}`);
    }
    const window = this.getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed?.()) {
      throw new CommandFailure('RENDERER_UNAVAILABLE', '渲染层窗口不存在或已销毁');
    }

    const serializedArgs = args === undefined
      ? ''
      : Array.isArray(args)
        ? args.map((value) => JSON.stringify(value)).join(', ')
        : JSON.stringify(args);
    const script = `(async () => {
      const bridge = window.__AgentBridge;
      if (!bridge || typeof bridge.${method} !== 'function') {
        return { ok: false, message: '渲染层尚未就绪' };
      }
      return await bridge.${method}(${serializedArgs});
    })()`;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new CommandFailure(
            'RENDERER_TIMEOUT',
            `渲染层调用超时（${Math.round(this.timeoutMs / 1000)} 秒）：${method}`
          ));
        }, this.timeoutMs);
      });
      return await Promise.race([
        window.webContents.executeJavaScript(script) as Promise<T>,
        timeout
      ]);
    } catch (error) {
      if (error instanceof CommandFailure) throw error;
      throw new CommandFailure(
        'RENDERER_ERROR',
        `渲染层调用失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function registerInsertCommand(bus: CommandBus): void {
  bus.register({
    name: 'insert_component',
    async run(args, ctx) {
      const partId = requiredString(args, 'partId', 'partId');
      const part = ctx.registry.listParts().find((candidate) => candidate.id === partId);
      if (!part) {
        throw new CommandFailure('PART_NOT_FOUND', `元器件不存在：${partId}`);
      }
      const requestedName = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined;
      const name = requestedName ?? part.model;
      const payload = {
        id: part.id,
        model: name,
        category: part.category,
        ...(part.vendor ? { vendor: part.vendor } : {})
      };
      const result = await ctx.bridge.call<InsertBridgeResult>('insertComponent', [payload]);
      if (!result || result.ok !== true) {
        throw new CommandFailure('RENDERER_ERROR', bridgeFailureMessage(result, `插入元器件失败：${name}`));
      }
      if (!Number.isInteger(result.meshIndex) || (result.meshIndex ?? -1) < 0) {
        throw new CommandFailure('RENDERER_ERROR', '渲染层未返回有效的 meshIndex');
      }
      const meshIndex = result.meshIndex as number;
      return {
        ok: true,
        data: { partId, meshIndex, name: result.name ?? name },
        undoToken: meshIndex
      };
    },
    async undo(token, ctx) {
      const meshIndex = typeof token === 'number' ? token : Number(token);
      if (!Number.isInteger(meshIndex)) throw new CommandFailure('UNDO_FAILED', '撤销令牌无效');
      const result = await ctx.bridge.call<{ ok: boolean; message?: string }>('removeComponent', [meshIndex]);
      if (!result || result.ok !== true) {
        throw new CommandFailure('UNDO_FAILED', bridgeFailureMessage(result, '撤销插入失败'));
      }
    }
  });
}

function registerPlaceCommand(bus: CommandBus): void {
  bus.register({
    name: 'place_component',
    async run(args, ctx) {
      const partId = requiredString(args, 'partId', 'partId');
      const part = ctx.registry.listParts().find((candidate) => candidate.id === partId);
      if (!part) {
        throw new CommandFailure('PART_NOT_FOUND', `元器件不存在：${partId}`);
      }
      const dims = part.dims;
      if (!dims || !(dims.w > 0) || !(dims.h > 0)) {
        throw new CommandFailure(
          'NO_DIMENSIONS',
          `元器件 ${part.model} 缺少外形尺寸（dims.w/dims.h），无法放置到底板`
        );
      }
      const x = requiredNumber(args, 'x', 'x 坐标');
      const y = requiredNumber(args, 'y', 'y 坐标');
      const rotate = args.rotate === true;
      const railSnap = args.railSnap !== false;
      const result = await ctx.bridge.call<PlacementBridgeResult>('placeEnclosurePart', {
        partId,
        x,
        y,
        rotate,
        railSnap
      });
      if (!result || result.ok !== true) {
        const code = result?.code === 'NO_DIMENSIONS' ? 'NO_DIMENSIONS' : 'RENDERER_ERROR';
        throw new CommandFailure(code, bridgeFailureMessage(result, `放置元器件失败：${part.model}`));
      }
      const placement = result.placement;
      if (!placement || typeof placement.id !== 'string' || !placement.id.trim()) {
        throw new CommandFailure('RENDERER_ERROR', '渲染层未返回有效的放置 id');
      }
      return {
        ok: true,
        data: {
          partId,
          placementId: placement.id,
          placement,
          warnings: Array.isArray(result.warnings) ? result.warnings : []
        },
        undoToken: placement.id
      };
    },
    async undo(token, ctx) {
      const placementId = typeof token === 'string' ? token.trim() : '';
      if (!placementId) throw new CommandFailure('UNDO_FAILED', '撤销令牌无效');
      const result = await ctx.bridge.call<{ ok: boolean; message?: string }>('removeEnclosurePart', [placementId]);
      if (!result || result.ok !== true) {
        throw new CommandFailure('UNDO_FAILED', bridgeFailureMessage(result, '撤销底板放置失败'));
      }
      return { removed: placementId };
    }
  });
}

function registerImportCommand(bus: CommandBus): void {
  bus.register({
    name: 'import_cad',
    async run(args, ctx) {
      const path = requiredString(args, 'path', 'CAD 文件路径');
      const extension = extname(path).toLowerCase();
      if (!isCadExtension(extension)) {
        throw new CommandFailure(
          'UNSUPPORTED_FORMAT',
          `不支持的 CAD 格式：${extension || '(无扩展名)'}；允许 ${CAD_EXTENSIONS.join(' / ')}`
        );
      }
      if (!existsSync(path) || !statSync(path).isFile()) {
        throw new CommandFailure('FILE_NOT_FOUND', `CAD 文件不存在：${path}`);
      }
      const result = await ctx.bridge.call<ImportBridgeResult>('importPath', [path]);
      if (!result || result.ok !== true) {
        throw new CommandFailure('IMPORT_FAILED', bridgeFailureMessage(result, `导入 CAD 失败：${path}`));
      }
      return {
        ok: true,
        data: {
          path,
          meshCount: Number(result.meshCount ?? 0),
          triangleCount: Number(result.triangleCount ?? 0)
        }
      };
    }
  });
}

function registerReadCommands(bus: CommandBus): void {
  bus.register({
    name: 'list_components',
    async run(args, ctx) {
      const filter: { q?: string; category?: string; packId?: string } = {};
      const q = optionalString(args, 'q');
      const category = optionalString(args, 'category');
      const packId = optionalString(args, 'packId');
      if (q) filter.q = q;
      if (category) filter.category = category;
      if (packId) filter.packId = packId;
      const components = ctx.registry.listParts(filter);
      return { ok: true, data: { count: components.length, components } };
    }
  });

  bus.register({
    name: 'search_components',
    async run(args, ctx) {
      const q = requiredString(args, 'q', 'q');
      const filter: { q: string; category?: string; packId?: string } = { q };
      const category = optionalString(args, 'category');
      const packId = optionalString(args, 'packId');
      if (category) filter.category = category;
      if (packId) filter.packId = packId;
      const components = ctx.registry.listParts(filter);
      return { ok: true, data: { query: q, count: components.length, components } };
    }
  });

  bus.register({
    name: 'get_bom',
    async run(_args, ctx) {
      const rows = await ctx.bridge.call<unknown>('getBom');
      if (!Array.isArray(rows)) {
        throw new CommandFailure('RENDERER_ERROR', bridgeFailureMessage(rows, '读取 BOM 失败'));
      }
      return { ok: true, data: { rows, note: SIMPLE_BOM_NOTE } };
    }
  });

  bus.register({
    name: 'suggest_kinematics',
    async run(_args, ctx) {
      const result = await ctx.bridge.call<KinematicsSuggestBridgeResult>('suggestKinematics');
      if (!result || isBridgeFailure(result) || !Array.isArray(result.suggestions) || !Array.isArray(result.lowConfidence)) {
        throw new CommandFailure('RENDERER_ERROR', bridgeFailureMessage(result, '运动件自动识别失败'));
      }
      return { ok: true, data: result };
    }
  });

  bus.register({
    name: 'run_interference',
    async run(_args, ctx) {
      const result = await ctx.bridge.call<InterferenceBridgeResult>('runInterference');
      if (!result || isBridgeFailure(result) || !Array.isArray(result.items)) {
        throw new CommandFailure('RENDERER_ERROR', bridgeFailureMessage(result, '干涉检查失败'));
      }
      return {
        ok: true,
        data: {
          hits: Number(result.hits ?? result.items.length),
          items: result.items
        }
      };
    }
  });
}

function optionalArray(args: Record<string, unknown>, key: string, label: string): unknown[] {
  const value = args[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new CommandFailure('INVALID_ARGUMENT', `${label} 必须是数组`);
  }
  return value;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberOf(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CommandFailure('INVALID_ARGUMENT', `${label} 必须是数字`);
  }
  return parsed;
}

const PHASES: readonly Phase[] = ['3P', 'L1', 'L2', 'L3', 'DC24'];

function parseElecDocument(args: Record<string, unknown>): ElecDocument {
  const wires: Wire[] = optionalArray(args, 'wires', 'wires').map((item, index) => {
    if (!isRecord(item)) throw new CommandFailure('INVALID_ARGUMENT', `wires[${index}] 必须是对象`);
    const section = numberOf(item.sectionMm2, `wires[${index}].sectionMm2`);
    const current = numberOf(item.currentA, `wires[${index}].currentA`);
    return {
      no: textOf(item.no),
      net: textOf(item.net),
      potential: textOf(item.potential),
      from: textOf(item.from),
      to: textOf(item.to),
      ...(section !== undefined ? { sectionMm2: section } : {}),
      ...(current !== undefined ? { currentA: current } : {})
    };
  });

  const loads: Load[] = optionalArray(args, 'loads', 'loads').map((item, index) => {
    if (!isRecord(item)) throw new CommandFailure('INVALID_ARGUMENT', `loads[${index}] 必须是对象`);
    const tag = textOf(item.tag) || `#${index + 1}`;
    const powerKw = numberOf(item.powerKw, `loads[${index}].powerKw`);
    if (powerKw === undefined) {
      throw new CommandFailure('INVALID_ARGUMENT', `缺少必填参数：loads[${index}].powerKw`);
    }
    const phase = textOf(item.phase) || '3P';
    if (!PHASES.includes(phase as Phase)) {
      throw new CommandFailure('INVALID_ARGUMENT', `loads[${index}].phase 只能是 ${PHASES.join(' / ')}`);
    }
    const cosPhi = numberOf(item.cosPhi, `loads[${index}].cosPhi`);
    const efficiency = numberOf(item.efficiency, `loads[${index}].efficiency`);
    const quantity = numberOf(item.quantity, `loads[${index}].quantity`);
    return {
      tag,
      powerKw,
      phase: phase as Phase,
      ...(cosPhi !== undefined ? { cosPhi } : {}),
      ...(efficiency !== undefined ? { efficiency } : {}),
      ...(quantity !== undefined ? { quantity } : {})
    };
  });

  const circuits: CircuitCheck[] = optionalArray(args, 'circuits', 'circuits').map((item, index) => {
    if (!isRecord(item)) throw new CommandFailure('INVALID_ARGUMENT', `circuits[${index}] 必须是对象`);
    const wireNo = textOf(item.wireNo);
    const currentA = numberOf(item.currentA, `circuits[${index}].currentA`);
    if (!wireNo) throw new CommandFailure('INVALID_ARGUMENT', `缺少必填参数：circuits[${index}].wireNo`);
    if (currentA === undefined) throw new CommandFailure('INVALID_ARGUMENT', `缺少必填参数：circuits[${index}].currentA`);
    const sectionMm2 = numberOf(item.sectionMm2, `circuits[${index}].sectionMm2`);
    const breakerA = numberOf(item.breakerA, `circuits[${index}].breakerA`);
    return {
      wireNo,
      currentA,
      ...(sectionMm2 !== undefined ? { sectionMm2 } : {}),
      ...(breakerA !== undefined ? { breakerA } : {})
    };
  });

  const rawOptions = args.options;
  let options: PowerOptions | undefined;
  if (isRecord(rawOptions)) {
    const voltage3P = numberOf(rawOptions.voltage3P, 'options.voltage3P');
    const voltage1P = numberOf(rawOptions.voltage1P, 'options.voltage1P');
    const voltageDc = numberOf(rawOptions.voltageDc, 'options.voltageDc');
    const demandFactor = numberOf(rawOptions.demandFactor, 'options.demandFactor');
    const psuRatedA = numberOf(rawOptions.psuRatedA, 'options.psuRatedA');
    options = {
      ...(voltage3P !== undefined ? { voltage3P } : {}),
      ...(voltage1P !== undefined ? { voltage1P } : {}),
      ...(voltageDc !== undefined ? { voltageDc } : {}),
      ...(demandFactor !== undefined ? { demandFactor } : {}),
      ...(psuRatedA !== undefined ? { psuRatedA } : {})
    };
  } else if (rawOptions !== undefined && rawOptions !== null) {
    throw new CommandFailure('INVALID_ARGUMENT', 'options 必须是对象');
  }

  return {
    wires,
    loads,
    circuits,
    ...(options !== undefined ? { options } : {})
  };
}

function registerElectricalCheckCommand(bus: CommandBus): void {
  bus.register({
    name: 'run_electrical_check',
    async run(args) {
      const doc = parseElecDocument(args);
      if (doc.wires?.length === 0 && doc.loads?.length === 0 && doc.circuits?.length === 0) {
        throw new CommandFailure(
          'INVALID_ARGUMENT',
          '电气校验需要至少一条 wires / loads / circuits 数据'
        );
      }
      const result = runElectricalCheck(doc);
      return {
        ok: true,
        data: {
          counts: result.counts,
          summary: result.summary,
          findings: result.findings
        }
      };
    }
  });
}

function registerCostCommand(bus: CommandBus): void {
  bus.register({
    name: 'run_cost_report',
    async run(args, ctx) {
      if (!moduleIsEnabled(COST_ESTIMATION_MODULE_ID, ctx.isModuleEnabled)) {
        throw new CommandFailure('MODULE_DISABLED', moduleDisabledResult(COST_ESTIMATION_MODULE_ID).message);
      }
      // 未显式给 bom 时回落到当前场景 BOM；场景 BOM 没有物料号，引擎会如实记为「缺物料号」。
      let sceneBom: unknown;
      if (!(Array.isArray(args.bom) && args.bom.length > 0)) {
        const rows = await ctx.bridge.call<unknown>('getBom');
        if (!moduleIsEnabled(COST_ESTIMATION_MODULE_ID, ctx.isModuleEnabled)) {
          throw new CommandFailure('MODULE_DISABLED', moduleDisabledResult(COST_ESTIMATION_MODULE_ID).message);
        }
        if (!Array.isArray(rows)) {
          throw new CommandFailure('RENDERER_ERROR', bridgeFailureMessage(rows, '读取当前 BOM 失败'));
        }
        sceneBom = rows;
      }
      try {
        const deps: { sceneBom?: unknown; loadBuiltinPricebook?: () => unknown } = {};
        if (sceneBom !== undefined) deps.sceneBom = sceneBom;
        if (ctx.loadBuiltinPricebook) deps.loadBuiltinPricebook = ctx.loadBuiltinPricebook;
        return { ok: true, data: runCostTool(args, deps) };
      } catch (error) {
        if (error instanceof CostToolError) throw new CommandFailure(error.code, error.message);
        throw error;
      }
    }
  });
}

function verifyOptionsFromArgs(args: Record<string, unknown>): VerifyOptions {
  const options: VerifyOptions = {};
  const timeScale = numberOf(args.timeScale, 'timeScale');
  if (timeScale !== undefined && timeScale > 0) options.timeScale = timeScale;
  for (const key of ['safetyTripAtStep', 'sensorConflictAtStep'] as const) {
    const raw = args[key];
    if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) options[key] = raw;
  }
  return options;
}

function registerPlcVerifyCommand(bus: CommandBus): void {
  bus.register({
    name: 'verify_plc_program',
    async run(args, ctx) {
      let config: PlcGenConfig | null = null;
      if (isRecord(args.config)) {
        config = args.config as unknown as PlcGenConfig;
      } else {
        const current = await ctx.bridge.call<unknown>('getPlcGenConfig');
        if (isRecord(current) && isBridgeFailure(current)) {
          throw new CommandFailure('RENDERER_ERROR', bridgeFailureMessage(current, '读取当前 PLC 机型配置失败'));
        }
        if (!isRecord(current)) {
          throw new CommandFailure('NO_CONFIG', '桌面当前没有可验证的 PLC 机型配置；请先完成机型/联调配置');
        }
        config = current as unknown as PlcGenConfig;
      }
      try {
        return { ok: true, data: summarizeVerification(verifyGenerated(config, verifyOptionsFromArgs(args))) };
      } catch (error) {
        throw new CommandFailure('VERIFY_FAILED', error instanceof Error ? error.message : String(error));
      }
    }
  });
}

function optionalBoolean(args: Record<string, unknown>, key: string, label: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new CommandFailure('INVALID_ARGUMENT', `${label} 必须是布尔值`);
  return value;
}

const COMPONENT_TARGETS = new Set(['auto', 'plate', 'bom']);
const EXPORT_KINDS = new Set(['pdf', 'dxf', 'glb', 'bom']);
const PLC_TARGETS = new Set(['generic', 's7-1200', 's7-1500', 'codesys']);

function componentTarget(args: Record<string, unknown>): 'auto' | 'plate' | 'bom' {
  const value = args.target;
  if (value === undefined || value === null) return 'auto';
  if (typeof value !== 'string' || !COMPONENT_TARGETS.has(value)) {
    throw new CommandFailure('INVALID_ARGUMENT', 'target 只能是 auto / plate / bom');
  }
  return value as 'auto' | 'plate' | 'bom';
}

function componentReference(args: Record<string, unknown>): { partId?: string; ref?: string } {
  const partId = optionalString(args, 'partId');
  const ref = optionalString(args, 'ref') ?? optionalString(args, 'designator') ?? optionalString(args, 'tag');
  if (!partId && !ref) {
    throw new CommandFailure('INVALID_ARGUMENT', '必须提供 partId 或位号（ref / designator / tag）之一');
  }
  return {
    ...(partId ? { partId } : {}),
    ...(ref ? { ref } : {})
  };
}

function registerProjectContextCommand(bus: CommandBus): void {
  bus.register({
    name: 'get_project_context',
    async run(_args, ctx) {
      const raw = await ctx.bridge.call<unknown>('getProjectContext');
      if (isRecord(raw) && isBridgeFailure(raw)) {
        throw new CommandFailure('RENDERER_ERROR', bridgeFailureMessage(raw, '读取工程上下文失败'));
      }
      const data = isRecord(raw) ? raw : {};
      const nullable = (value: unknown): unknown => (value === undefined ? null : value);
      const recentActions = bus.history()
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
        data: {
          domain: nullable(data.domain),
          view: nullable(data.view),
          selection: nullable(data.selection),
          machine: nullable(data.machine),
          plate: nullable(data.plate),
          units: nullable(data.units),
          recentActions
        }
      };
    }
  });
}

function registerUpdateComponentCommand(bus: CommandBus): void {
  bus.register({
    name: 'update_component',
    async run(args, ctx) {
      const target = componentTarget(args);
      const reference = componentReference(args);
      const model = optionalString(args, 'model') ?? optionalString(args, 'newModel');
      const rawQty = args.qty;
      const qty = rawQty === undefined || rawQty === null ? undefined : numberOf(rawQty, 'qty');
      if (qty !== undefined && (!Number.isInteger(qty) || qty <= 0)) {
        throw new CommandFailure('INVALID_ARGUMENT', 'qty 必须是大于 0 的整数');
      }
      const remarkValue = typeof args.remark === 'string'
        ? args.remark
        : typeof args.note === 'string'
          ? args.note
          : undefined;
      const remark = remarkValue === undefined ? undefined : remarkValue.trim();
      if (model === undefined && qty === undefined && remark === undefined) {
        throw new CommandFailure('INVALID_ARGUMENT', '至少提供 model / qty / remark 之一');
      }

      const warnings: Issue[] = [];
      let replacement: { id: string; model: string; dims?: { w: number; h: number } } | undefined;
      if (model !== undefined) {
        const resolution = resolvePartReference(ctx.registry.listParts(), model);
        if (!resolution.ok) {
          throw new CommandFailure(resolution.code, resolution.message);
        }
        const dims = resolution.part.dims;
        if (!dims || !(dims.w > 0) || !(dims.h > 0)) {
          warnings.push({
            code: 'NO_DIMENSIONS',
            message: `新件 ${resolution.part.model} 缺少外形尺寸（dims.w/dims.h），底板尺寸保持原值，请人工复核`
          });
          replacement = { id: resolution.part.id, model: resolution.part.model };
        } else {
          replacement = {
            id: resolution.part.id,
            model: resolution.part.model,
            dims: { w: dims.w, h: dims.h }
          };
        }
      }

      const payload: Record<string, unknown> = {
        target,
        ...(reference.partId ? { matchPartId: reference.partId } : {}),
        ...(reference.ref ? { ref: reference.ref } : {}),
        ...(qty !== undefined ? { qty } : {}),
        ...(remark !== undefined ? { remark } : {}),
        ...(replacement
          ? {
              model: replacement.model,
              newPartId: replacement.id,
              ...(replacement.dims ? { w: replacement.dims.w, h: replacement.dims.h } : {})
            }
          : {})
      };
      const result = await ctx.bridge.call<unknown>('updateComponent', payload);
      if (!isRecord(result) || result.ok !== true) {
        throw new CommandFailure(
          isRecord(result) && typeof result.code === 'string' ? result.code : 'RENDERER_ERROR',
          bridgeFailureMessage(result, '更新元器件失败')
        );
      }
      const before = isRecord(result.before) ? result.before : null;
      const location = result.location === 'bom' ? 'bom' : 'plate';
      const targetRef = typeof result.targetRef === 'string' ? result.targetRef : reference.ref ?? reference.partId ?? '';
      const bridgeWarnings = Array.isArray(result.warnings) ? result.warnings : [];
      return {
        ok: true,
        data: {
          location,
          updated: isRecord(result.updated) ? result.updated : {},
          warnings: [...warnings, ...bridgeWarnings]
        },
        undoToken: before ? { target: location, targetRef, before } : undefined
      };
    },
    async undo(token, ctx) {
      if (!isRecord(token) || !isRecord(token.before)) {
        throw new CommandFailure('UNDO_FAILED', '撤销令牌无效');
      }
      const before = token.before;
      const payload: Record<string, unknown> = {
        target: token.target === 'bom' ? 'bom' : 'plate',
        ref: typeof token.targetRef === 'string' ? token.targetRef : '',
        restore: true,
        ...(typeof before.model === 'string' ? { model: before.model } : {}),
        ...(typeof before.partId === 'string' ? { newPartId: before.partId } : {}),
        ...(typeof before.qty === 'number' ? { qty: before.qty } : {}),
        ...(typeof before.note === 'string' ? { remark: before.note } : { remark: '' }),
        ...(typeof before.w === 'number' ? { w: before.w } : {}),
        ...(typeof before.h === 'number' ? { h: before.h } : {})
      };
      const result = await ctx.bridge.call<unknown>('updateComponent', payload);
      if (!isRecord(result) || result.ok !== true) {
        throw new CommandFailure('UNDO_FAILED', bridgeFailureMessage(result, '撤销元器件修改失败'));
      }
    }
  });
}

function registerRemoveComponentCommand(bus: CommandBus): void {
  bus.register({
    name: 'remove_component',
    async run(args, ctx) {
      const target = componentTarget(args);
      const reference = componentReference(args);
      const result = await ctx.bridge.call<unknown>('removeProjectComponent', {
        target,
        ...(reference.partId ? { matchPartId: reference.partId } : {}),
        ...(reference.ref ? { ref: reference.ref } : {})
      });
      if (!isRecord(result) || result.ok !== true) {
        throw new CommandFailure(
          isRecord(result) && typeof result.code === 'string' ? result.code : 'NOT_PLACED',
          bridgeFailureMessage(result, '元器件不在底板或 BOM 中')
        );
      }
      return {
        ok: true,
        data: {
          location: result.location === 'bom' ? 'bom' : 'plate',
          ref: typeof result.targetRef === 'string' ? result.targetRef : reference.ref ?? reference.partId ?? '',
          removed: isRecord(result.removed) ? result.removed : {}
        },
        undoToken: typeof result.undoToken === 'string' ? result.undoToken : undefined
      };
    },
    async undo(token, ctx) {
      if (typeof token !== 'string' || !token.trim()) {
        throw new CommandFailure('UNDO_FAILED', '撤销令牌无效');
      }
      const result = await ctx.bridge.call<unknown>('restoreProjectComponent', [token]);
      if (!isRecord(result) || result.ok !== true) {
        throw new CommandFailure('UNDO_FAILED', bridgeFailureMessage(result, '恢复元器件失败'));
      }
    }
  });
}

function plcConfigFromArgs(args: Record<string, unknown>, ctx: CommandContext): Promise<PlcGenConfig> | PlcGenConfig {
  if (isRecord(args.config)) return args.config as unknown as PlcGenConfig;
  return (async () => {
    const current = await ctx.bridge.call<unknown>('getPlcGenConfig');
    if (isRecord(current) && isBridgeFailure(current)) {
      throw new CommandFailure('RENDERER_ERROR', bridgeFailureMessage(current, '读取当前 PLC 机型配置失败'));
    }
    if (!isRecord(current)) {
      throw new CommandFailure('NO_CONFIG', '桌面当前没有可生成的 PLC 机型配置；请先完成机型/联调配置');
    }
    return current as unknown as PlcGenConfig;
  })();
}

function registerPlcGenerateCommand(bus: CommandBus): void {
  bus.register({
    name: 'run_plc_generate',
    async run(args, ctx) {
      const config = await plcConfigFromArgs(args, ctx);
      const target = args.target === undefined ? undefined : args.target;
      if (target !== undefined && (typeof target !== 'string' || !PLC_TARGETS.has(target))) {
        throw new CommandFailure('INVALID_ARGUMENT', 'target 只能是 generic / s7-1200 / s7-1500 / codesys');
      }
      const namePrefix = optionalString(args, 'namePrefix');
      const sequenceTimeoutMs = numberOf(args.sequenceTimeoutMs, 'sequenceTimeoutMs');
      if (sequenceTimeoutMs !== undefined && sequenceTimeoutMs <= 0) {
        throw new CommandFailure('INVALID_ARGUMENT', 'sequenceTimeoutMs 必须大于 0');
      }
      const generated = generateProject({
        config,
        ...(target ? { target: target as 'generic' | 's7-1200' | 's7-1500' | 'codesys' } : {}),
        ...(namePrefix ? { namePrefix } : {}),
        ...(sequenceTimeoutMs !== undefined ? { sequenceTimeoutMs } : {})
      });
      if (!generated.ok) {
        const first = generated.errors[0];
        throw new CommandFailure(
          'PRECHECK_FAILED',
          `PLC 预检未通过（${generated.errors.length} 个错误）${first ? `：${first.message}` : ''}，未写入任何文件`
        );
      }
      if (!ctx.exportsRoot) {
        throw new CommandFailure('WRITE_FAILED', '导出目录未配置，无法写入 PLC 工程');
      }
      const exportsRoot = join(ctx.exportsRoot, 'plc');
      const plan = planPlcExportDirectory({
        exportsRoot,
        machineName: config.name || config.id || 'PLC',
        now: ctx.now?.() ?? new Date(),
        exists: existsSync
      });
      try {
        mkdirSync(plan.path, { recursive: true });
        const files = generated.files.map((file) => {
          const targetPath = resolve(plan.path, file.path);
          if (!targetPath.startsWith(resolve(plan.path) + sep)) {
            throw new CommandFailure('WRITE_FAILED', `PLC 文件路径越界：${file.path}`);
          }
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, file.content, 'utf8');
          const normalized = file.content.endsWith('\n') ? file.content.slice(0, -1) : file.content;
          return {
            path: file.path,
            bytes: Buffer.byteLength(file.content, 'utf8'),
            lines: normalized.split('\n').length
          };
        });
        const zip = createZip(generated.files);
        writeFileSync(plan.zipPath, zip);
        try {
          await ctx.bridge.call('markPlcGenerated');
        } catch (error) {
          // 建议区状态是可降级信息，不能因标记失败影响已完成的 PLC 落盘。
          console.warn(`[PLC_SUGGESTION_UI_FAILED]`, { site: 'desktop/src/agent/commands.ts:1165' }, error);
        }
        return {
          ok: true,
          data: {
            path: plan.path,
            zipPath: plan.zipPath,
            fileCount: files.length,
            files,
            precheck: {
              errors: generated.precheck.errors,
              warnings: generated.precheck.warnings
            },
            stats: generated.stats
          }
        };
      } catch (error) {
        if (error instanceof CommandFailure) throw error;
        throw new CommandFailure('WRITE_FAILED', `PLC 工程写入失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
}

interface MachineApplyUndoToken {
  machineId: string;
  machineFile: string;
  activeFile: string;
  activeText: string | null;
  designText: string | null;
  bomPath?: string;
  bomText?: string | null;
  plcPath?: string;
  plcText?: string | null;
  previousConfig: StoredMachineDesign['config'] | null;
  previousLayout: string | null;
  batchId: string;
  withBom: boolean;
  /** 几何产物撤销快照：路径 + 旧内容 base64（null 表示原先不存在）。 */
  geometryFiles?: { path: string; previous: string | null }[];
}


function machineMainBreakerRating(
  design: NormalizedMachineDesign,
  parts: readonly ComponentPart[]
): number | undefined {
  const breaker = design.bomDraft?.items.find((item) => /总进线断路器/.test(item.name));
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

function registerMachineApplyCommand(bus: CommandBus): void {
  bus.register({
    name: 'apply_machine_design',
    async run(args, ctx) {
      const brief = optionalString(args, 'brief');
      const rawDesign = args.design;
      if (brief && rawDesign !== undefined) {
        throw new CommandFailure('INVALID_ARGUMENT', 'brief 与 design 只能二选一');
      }
      if (!brief && rawDesign === undefined) {
        throw new CommandFailure('INVALID_ARGUMENT', '必须提供 brief 或 design 之一');
      }
      if (args.name !== undefined && (typeof args.name !== 'string' || !args.name.trim())) {
        throw new CommandFailure('INVALID_ARGUMENT', 'name 必须是非空字符串');
      }
      const name = optionalString(args, 'name');
      const overwrite = optionalBoolean(args, 'overwrite', 'overwrite') === true;
      const withBom = optionalBoolean(args, 'withBom', 'withBom') ?? true;
      const withPlc = optionalBoolean(args, 'withPlc', 'withPlc') ?? false;
      const withGeometry = optionalBoolean(args, 'withGeometry', 'withGeometry') ?? true;
      const withSolids = optionalBoolean(args, 'withSolids', 'withSolids') ?? false;
      if (withSolids && !withGeometry) {
        throw new CommandFailure('INVALID_ARGUMENT', 'withSolids 需要 withGeometry=true');
      }
      if (withSolids && !moduleIsEnabled(PARAMETRIC_IMPORT_MODULE_ID, ctx.isModuleEnabled)) {
        throw new CommandFailure('MODULE_DISABLED', PARAMETRIC_MODULE_DISABLED_MESSAGE);
      }
      if (!ctx.userDataRoot) {
        throw new CommandFailure('WRITE_FAILED', '用户数据目录未配置，无法写入机型方案');
      }

      let normalized;
      let pricingAssumptions: readonly string[] = [];
      try {
        const parts = ctx.registry.listParts();
        const pricingLoad = readMachinePricing(ctx.userDataRoot);
        pricingAssumptions = pricingLoad.assumptions;
        if (brief) {
          const design = synthMachine(parseMachineBrief(brief), {
            ...(name ? { name } : {}),
            parts,
            pricing: pricingLoad.pricing,
            pricingAssumptions: pricingLoad.assumptions
          });
          normalized = validateMachineDesign(design);
        } else {
          normalized = validateMachineDesign(rawDesign);
        }

        let builtinPricebook: Pricebook | undefined;
        try {
          if (ctx.loadBuiltinPricebook) builtinPricebook = validatePricebook(ctx.loadBuiltinPricebook());
        } catch (error) {
          recordDiagnosticError('MACHINE_COST_PRICEBOOK_FAILED', error, { site: 'desktop/src/agent/commands.ts' });
        }
        const selectedBreakerA = machineMainBreakerRating(normalized, parts);
        normalized.power = estimatePower(normalized, {
          parts,
          voltage: normalized.power?.voltage ?? '380VAC',
          simultaneity: pricingLoad.pricing.power.simultaneity,
          loadFactor: pricingLoad.pricing.power.loadFactor,
          efficiency: pricingLoad.pricing.power.efficiency,
          cosPhi: pricingLoad.pricing.power.cosPhi,
          ...(selectedBreakerA !== undefined ? { selectedBreakerA } : {}),
          assumptions: pricingLoad.assumptions
        });
        normalized.cost = estimateCost(normalized, {
          parts,
          pricing: pricingLoad.pricing,
          pricingAssumptions: pricingLoad.assumptions,
          ...(builtinPricebook ? { builtinPricebook } : {})
        });
      } catch (error) {
        throw new CommandFailure(
          'INVALID_ARGUMENT',
          `机型方案校验失败：${error instanceof Error ? error.message : String(error)}`
        );
      }

      if (name) normalized.config.name = name;
      const machineId = sanitizeMachineId(normalized.config.id);
      normalized.config.id = machineId;
      const machineFile = machineDesignPath(ctx.userDataRoot, machineId);
      const designContent = machineDesignContent(normalized);
      const designHash = createHash('sha256').update(designContent).digest('hex').slice(0, 12);
      const existingDesign = existsSync(machineFile)
        ? readStoredMachineDesign(ctx.userDataRoot, machineId)
        : null;
      const idempotent = existingDesign !== null && machineDesignContent(existingDesign) === designContent;
      if (existsSync(machineFile) && !overwrite && !idempotent) {
        throw new CommandFailure(
          'FILE_EXISTS',
          `机型方案已存在：${machineId}；如需覆盖请显式传入 overwrite=true`
        );
      }
      if (idempotent) {
        // 相同方案重复应用：不重写文件、不追加 BOM、不动 appliedAt；只确保当前渲染层已切到该方案。
        let sceneRefreshed = false;
        try {
          const refreshed = await ctx.bridge.call<{ ok?: boolean; message?: string }>('applyMachineConfig', {
            config: normalized.config,
            machineId,
            name: normalized.config.name,
            layout: normalized.form?.geometry?.kind ?? null
          });
          sceneRefreshed = refreshed?.ok !== false;
        } catch (error) {
          recordDiagnosticError('MACHINE_SCENE_REFRESH_FAILED', error, { machineId, phase: 'idempotent-apply' });
        }
        const bomRows = buildMachineBomRows(normalized);
        return {
          ok: true,
          data: {
            machineId,
            name: normalized.config.name,
            stations: normalized.config.stations.length,
            actuators: normalized.config.actuators.length,
            sensors: normalized.config.sensors.length,
            warnings: [...normalized.warnings],
            activePath: activeMachinePath(ctx.userDataRoot),
            designPath: machineFile,
            sceneRefreshed,
            idempotent: true,
            ...(withBom ? {
              bomPath: machineBomDraftPath(ctx.userDataRoot, machineId),
              bom: { count: bomRows.length, added: 0, source: 'machine-design' }
            } : {})
          }
        };
      }

      const now = ctx.now?.() ?? new Date();
      const appliedAt = now.toISOString();
      const previousPointer = readActivePointer(ctx.userDataRoot);
      const previousDesign = previousPointer
        ? readStoredMachineDesign(ctx.userDataRoot, previousPointer.machineId)
        : readActiveMachineDesign(ctx.userDataRoot);
      const activeFile = activeMachinePath(ctx.userDataRoot);
      const activeText = readTextIfExists(activeFile);
      const designText = readTextIfExists(machineFile);
      const stored: StoredMachineDesign = {
        ...normalized,
        schemaVersion: 1,
        kind: 'machine-design',
        id: machineId,
        name: normalized.config.name,
        appliedAt
      };

      try {
        writeText(machineFile, `${JSON.stringify(stored, null, 2)}\n`);
        writeActivePointer(ctx.userDataRoot, {
          schemaVersion: 1,
          machineId,
          name: stored.name,
          file: `machine/${machineId}.json`,
          appliedAt
        });
      } catch (error) {
        throw new CommandFailure(
          'WRITE_FAILED',
          `机型方案写入失败：${error instanceof Error ? error.message : String(error)}`
        );
      }

      const warnings = [...normalized.warnings];
      const bomRows: MachineBomRow[] = buildMachineBomRows(normalized);
      const batchId = `machine-${machineId}-${designHash}`;
      let bomPath: string | undefined;
      let bomText: string | null | undefined;
      let bomAdded = 0;
      if (withBom) {
        bomPath = machineBomDraftPath(ctx.userDataRoot, machineId);
        bomText = readTextIfExists(bomPath);
        try {
          writeText(bomPath, renderMachineBomCsv(bomRows));
        } catch (error) {
          warnings.push(`BOM 草稿写入失败：${error instanceof Error ? error.message : String(error)}`);
        }
        if (bomRows.length > 0) {
          try {
            const appended = await ctx.bridge.call<{ ok?: boolean; added?: number; message?: string }>(
              'appendMachineBomRows',
              {
                batchId,
                source: 'machine-design',
                rows: bomRows.map((row, index) => ({
                  no: index + 1,
                  name: row.name,
                  spec: row.model,
                  qty: row.qty,
                  mat: '—',
                  category: row.category,
                  source: row.source,
                  ...(row.note ? { note: row.note } : {})
                }))
              }
            );
            if (appended?.ok === false) {
              warnings.push(`BOM 草稿追加失败：${appended.message ?? '渲染层未返回原因'}`);
            } else {
              bomAdded = Number(appended?.added ?? bomRows.length);
            }
          } catch (error) {
            warnings.push(`BOM 草稿追加失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      let plcPath: string | undefined;
      let plcText: string | null | undefined;
      let plcPoints = 0;
      if (withPlc) {
        const exportsRoot = ctx.exportsRoot ?? join(ctx.userDataRoot, 'exports');
        plcPath = join(exportsRoot, 'plc', machineId, 'io-map.csv');
        plcText = readTextIfExists(plcPath);
        try {
          const ioMap = buildMachineIoMap(normalized.config);
          plcPoints = ioMap.rows.length;
          writeText(plcPath, ioMap.csv);
        } catch (error) {
          throw new CommandFailure(
            'WRITE_FAILED',
            `PLC 点位映射写入失败：${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      const geometryFiles: { path: string; previous: string | null }[] = [];
      let geometryResult: Record<string, unknown> | undefined;
      if (withGeometry) {
        const paths = machineGeometryPaths(ctx.userDataRoot, machineId);
        const snapshot = (path: string): void => {
          if (!geometryFiles.some((entry) => entry.path === path)) {
            geometryFiles.push({ path, previous: readBase64IfExists(path) });
          }
        };
        try {
          const geometry = generateMachineGeometry(normalized);
          const bundle = geometryToSidecarAssemblies(geometry, { updatedAt: appliedAt });
          for (const path of [paths.json, paths.stl, paths.gltf, paths.sidecar]) snapshot(path);
          writeText(paths.json, `${JSON.stringify(geometry, null, 2)}\n`);
          const stl = geometryToStl(geometry);
          writeBytes(paths.stl, stl);
          writeText(paths.gltf, JSON.stringify(geometryToGltf(geometry)));
          writeText(paths.sidecar, `${JSON.stringify(bundle, null, 2)}\n`);
          const summary = summarizeGeometry(geometry);
          let solids: Record<string, unknown> | undefined;
          if (withSolids) {
            const report = await buildMachineSolids(bundle, ctx.buildSolids);
            const stepPaths: string[] = [];
            if (report.mode === 'solids') {
              // 上一次 apply 可能留下更多分块的 part-N.step：先全部入撤销快照再清掉，
              // 避免旧 STEP 混进本次整机（撤销时按快照逐个恢复）。
              const stale = existsSync(paths.solidsDir)
                ? readdirSync(paths.solidsDir).filter((name) => /^part-\d+\.step$/.test(name))
                : [];
              for (const name of stale) {
                const stalePath = join(paths.solidsDir, name);
                snapshot(stalePath);
                rmSync(stalePath, { force: true });
              }
              report.stepFiles.forEach((source, index) => {
                const target = join(paths.solidsDir, `part-${index + 1}.step`);
                try {
                  const bytes = readFileSync(source);
                  snapshot(target);
                  writeBytes(target, bytes);
                  stepPaths.push(target);
                } catch (error) {
                  warnings.push(`STEP 文件复制失败：${error instanceof Error ? error.message : String(error)}`);
                }
              });
              if (bundle.approximated.length > 0) {
                const names = bundle.approximated.slice(0, 8).map((id) => geometry.parts.find((part) => part.id === id)?.name ?? id);
                warnings.push(
                  `STEP 实体化把 ${bundle.approximated.length} 个水平圆柱按等截面方棒近似（${names.join('、')}${bundle.approximated.length > 8 ? ' 等' : ''}）；STL/glTF 网格不受影响`
                );
              }
            } else {
              warnings.push(report.message);
            }
            solids = { mode: report.mode, chunks: report.chunks, built: report.built, stepPaths, message: report.message };
          }
          geometryResult = {
            ...summary,
            stlBytes: stl.byteLength,
            sidecarChunks: bundle.chunks.length,
            approximated: bundle.approximated.length,
            approximatedIds: bundle.approximated,
            jsonPath: paths.json,
            stlPath: paths.stl,
            gltfPath: paths.gltf,
            sidecarPath: paths.sidecar,
            ...(solids ? { solids } : {})
          };
          warnings.push(...geometry.warnings);
        } catch (error) {
          for (const entry of geometryFiles) restoreBase64(entry.path, entry.previous);
          geometryFiles.length = 0;
          warnings.push(`参数化几何生成失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }

      let sceneRefreshed = false;
      try {
        const refreshed = await ctx.bridge.call<{ ok?: boolean; message?: string }>('applyMachineConfig', {
          config: normalized.config,
          machineId,
          name: stored.name,
          layout: normalized.form?.geometry?.kind ?? null
        });
        if (refreshed?.ok === false) {
          warnings.push(`3D 联调视图刷新失败：${refreshed.message ?? '渲染层未返回原因'}`);
        } else {
          sceneRefreshed = true;
        }
      } catch (error) {
        warnings.push(`3D 联调视图刷新失败：${error instanceof Error ? error.message : String(error)}`);
      }

      const undoToken: MachineApplyUndoToken = {
        machineId,
        machineFile,
        activeFile,
        activeText,
        designText,
        previousConfig: previousDesign?.config ?? null,
        previousLayout: previousDesign?.form?.geometry?.kind ?? null,
        batchId,
        withBom,
        ...(bomPath !== undefined ? { bomPath } : {}),
        ...(withBom ? { bomText: bomText ?? null } : {}),
        ...(plcPath !== undefined ? { plcPath } : {}),
        ...(withPlc ? { plcText: plcText ?? null } : {}),
        ...(geometryFiles.length > 0 ? { geometryFiles } : {})
      };

      return {
        ok: true,
        data: {
          machineId,
          name: stored.name,
          stations: normalized.config.stations.length,
          actuators: normalized.config.actuators.length,
          sensors: normalized.config.sensors.length,
          warnings,
          activePath: activeFile,
          designPath: machineFile,
          sceneRefreshed,
          ...(withBom ? {
            bomPath,
            bom: { count: bomRows.length, added: bomAdded, source: 'machine-design' }
          } : {}),
          ...(withPlc ? {
            plcPath,
            plc: { points: plcPoints }
          } : {}),
          ...(geometryResult ? { geometry: geometryResult } : {})
        },
        undoToken
      };
    },
    async undo(token, ctx) {
      const undo = token as MachineApplyUndoToken;
      if (!undo || typeof undo !== 'object' || !undo.machineId) {
        throw new CommandFailure('UNDO_FAILED', '撤销令牌无效');
      }
      restoreText(undo.machineFile, undo.designText);
      restoreText(undo.activeFile, undo.activeText);
      if (undo.bomPath) restoreText(undo.bomPath, undo.bomText ?? null);
      if (undo.plcPath) restoreText(undo.plcPath, undo.plcText ?? null);
      for (const entry of undo.geometryFiles ?? []) restoreBase64(entry.path, entry.previous);
      if (undo.withBom) {
        try {
          await ctx.bridge.call('removeMachineBomRows', { batchId: undo.batchId });
        } catch (error) {
          // BOM 行是内存草稿；撤销文件与 active 指针优先，渲染层不可用时不阻断。
          recordDiagnosticError('MACHINE_BOM_UNDO_FAILED', error, { machineId: undo.machineId });
        }
      }
      try {
        await ctx.bridge.call('applyMachineConfig', {
          config: undo.previousConfig,
          name: undo.previousConfig?.name ?? null,
          layout: undo.previousLayout
        });
      } catch (error) {
        // 3D 刷新失败不回滚已恢复的文件状态。
        recordDiagnosticError('MACHINE_SCENE_RESTORE_FAILED', error, { machineId: undo.machineId });
      }
      return {
        machineId: undo.machineId,
        restored: undo.previousConfig?.name ?? null
      };
    }
  });
}

function registerExportFilesCommand(bus: CommandBus): void {
  bus.register({
    name: 'export_files',
    async run(args, ctx) {
      const kind = args.kind;
      if (typeof kind !== 'string' || !EXPORT_KINDS.has(kind)) {
        throw new CommandFailure('UNSUPPORTED_FORMAT', '导出格式仅支持 pdf / dxf / glb / bom');
      }
      if (args.fileName !== undefined && args.fileName !== null && typeof args.fileName !== 'string') {
        throw new CommandFailure('INVALID_ARGUMENT', 'fileName 必须是字符串');
      }
      const overwrite = optionalBoolean(args, 'overwrite', 'overwrite') ?? false;
      const allowSanitize = optionalBoolean(args, 'allowSanitize', 'allowSanitize') ?? false;
      const targetCheck = checkExportTargetPath(args.fileName, allowSanitize);
      if (!targetCheck.ok) {
        throw new CommandFailure('TARGET_PATH_UNSUPPORTED', targetCheck.message ?? '目标路径不受支持');
      }
      if (!ctx.exportsRoot) {
        throw new CommandFailure('WRITE_FAILED', '导出目录未配置，无法写入文件');
      }

      const built = await ctx.bridge.call<unknown>('exportArtifact', { kind });
      if (!isRecord(built) || built.ok !== true) {
        throw new CommandFailure(
          isRecord(built) && typeof built.code === 'string' ? built.code : 'EXPORT_FAILED',
          bridgeFailureMessage(built, '生成导出内容失败')
        );
      }
      if (typeof built.data !== 'string') {
        throw new CommandFailure('EXPORT_FAILED', '导出内容必须由渲染层以字符串返回');
      }
      const suggestedName = typeof built.suggestedName === 'string' && built.suggestedName.trim()
        ? built.suggestedName.trim()
        : `导出文件.${kind === 'bom' ? 'csv' : kind}`;
      try {
        mkdirSync(ctx.exportsRoot, { recursive: true });
        const planned = planArtifactExportName({
          directory: ctx.exportsRoot,
          kind: kind as 'pdf' | 'dxf' | 'glb' | 'bom',
          fileName: args.fileName,
          suggestedName,
          overwrite,
          exists: existsSync
        });
        let bytes: Uint8Array;
        if (kind === 'pdf') {
          if (!ctx.renderReportPdf) {
            throw new CommandFailure('WRITE_FAILED', 'PDF 渲染管线不可用，请改用 dxf / glb / bom');
          }
          bytes = await ctx.renderReportPdf(built.data);
        } else if (kind === 'glb') {
          if (built.encoding !== 'base64') {
            throw new CommandFailure('EXPORT_FAILED', 'GLB 导出必须使用 base64 编码');
          }
          bytes = new Uint8Array(Buffer.from(built.data, 'base64'));
        } else {
          bytes = new TextEncoder().encode(built.data);
        }
        if (bytes.byteLength === 0) {
          throw new CommandFailure('EXPORT_FAILED', '导出内容为空，未写入文件');
        }
        writeFileSync(planned.path, bytes);
        return {
          ok: true,
          data: {
            path: planned.path,
            bytes: bytes.byteLength,
            kind,
            fileName: planned.name,
            ...(targetCheck.sanitized ? { sanitized: true } : {})
          }
        };
      } catch (error) {
        if (error instanceof CommandFailure) throw error;
        if (error instanceof CostExportError) throw new CommandFailure(error.code, error.message);
        throw new CommandFailure('WRITE_FAILED', `导出写入失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
}

function registerCostExportCommand(bus: CommandBus): void {
  bus.register({
    name: 'export_cost_report',
    async run(args, ctx) {
      if (!moduleIsEnabled(COST_ESTIMATION_MODULE_ID, ctx.isModuleEnabled)) {
        throw new CommandFailure('MODULE_DISABLED', moduleDisabledResult(COST_ESTIMATION_MODULE_ID).message);
      }
      if (args.format !== 'pdf' && args.format !== 'csv') {
        throw new CommandFailure('UNSUPPORTED_FORMAT', '导出格式仅支持 pdf 或 csv');
      }
      if (args.fileName !== undefined && args.fileName !== null && typeof args.fileName !== 'string') {
        throw new CommandFailure('INVALID_ARGUMENT', 'fileName 必须是字符串');
      }
      const allowSanitize = optionalBoolean(args, 'allowSanitize', 'allowSanitize') ?? false;
      const targetCheck = checkExportTargetPath(args.fileName, allowSanitize);
      if (!targetCheck.ok) {
        throw new CommandFailure('TARGET_PATH_UNSUPPORTED', targetCheck.message ?? '目标路径不受支持');
      }

      // 复用 run_cost_report 的取数路径：显式 bom 不读场景；否则先取场景 BOM。
      let sceneBom: unknown;
      let projectName: string | undefined;
      if (!(Array.isArray(args.bom) && args.bom.length > 0)) {
        const rows = await ctx.bridge.call<unknown>('getBom');
        if (!moduleIsEnabled(COST_ESTIMATION_MODULE_ID, ctx.isModuleEnabled)) {
          throw new CommandFailure('MODULE_DISABLED', moduleDisabledResult(COST_ESTIMATION_MODULE_ID).message);
        }
        if (!Array.isArray(rows)) {
          throw new CommandFailure('RENDERER_ERROR', bridgeFailureMessage(rows, '读取当前 BOM 失败'));
        }
        sceneBom = rows;
        try {
          const scene = await ctx.bridge.call<{ source?: unknown } | null>('getScene');
          if (!moduleIsEnabled(COST_ESTIMATION_MODULE_ID, ctx.isModuleEnabled)) {
            throw new CommandFailure('MODULE_DISABLED', moduleDisabledResult(COST_ESTIMATION_MODULE_ID).message);
          }
          const source = scene && typeof scene === 'object' ? scene.source : undefined;
          if (typeof source === 'string' && source.trim()) {
            projectName = basename(source.trim(), extname(source.trim()));
          }
        } catch (error) {
          if (error instanceof CommandFailure) throw error;
          // 项目名只影响默认文件名，取不到时回落「机台」，不阻塞导出。
          console.debug(`[EXPORT_PROJECT_NAME_FALLBACK]`, { site: 'desktop/src/agent/commands.ts:1683' }, error);
        }
      }

      try {
        const data = await buildCostExport(args, {
          ...(sceneBom !== undefined ? { sceneBom } : {}),
          ...(ctx.loadBuiltinPricebook ? { loadBuiltinPricebook: ctx.loadBuiltinPricebook } : {}),
          ...(projectName ? { projectName } : {}),
          ...(ctx.renderCostPdf ? { renderPdf: ctx.renderCostPdf } : {}),
          saveFile: async (payload) => {
            if (!moduleIsEnabled(COST_ESTIMATION_MODULE_ID, ctx.isModuleEnabled)) {
              return moduleDisabledResult(COST_ESTIMATION_MODULE_ID);
            }
            const binary = typeof payload.data !== 'string';
            if (binary) {
              const bytes = payload.data as Uint8Array;
              const result = await ctx.bridge.call<CostExportSaveResult>('exportCostFile', {
                format: payload.format,
                ...(payload.fileName ? { fileName: payload.fileName } : {}),
                overwrite: payload.overwrite,
                data: Buffer.from(bytes).toString('base64'),
                encoding: 'base64',
                suggestedName: payload.suggestedName
              });
              return result ?? { ok: false, code: 'WRITE_FAILED', message: '渲染层未返回落盘结果' };
            }
            const result = await ctx.bridge.call<CostExportSaveResult>('exportCostFile', {
              format: payload.format,
              ...(payload.fileName ? { fileName: payload.fileName } : {}),
              overwrite: payload.overwrite,
              data: payload.data,
              encoding: 'utf8',
              suggestedName: payload.suggestedName
            });
            return result ?? { ok: false, code: 'WRITE_FAILED', message: '渲染层未返回落盘结果' };
          }
        });
        if (!moduleIsEnabled(COST_ESTIMATION_MODULE_ID, ctx.isModuleEnabled)) {
          throw new CommandFailure('MODULE_DISABLED', moduleDisabledResult(COST_ESTIMATION_MODULE_ID).message);
        }
        return { ok: true, data };
      } catch (error) {
        if (error instanceof CostExportError) {
          throw new CommandFailure(error.code, error.message);
        }
        throw error;
      }
    }
  });
}

export function createAgentCommandBus(
  registry: PackRegistry,
  bridge: Bridge,
  options: CommandBusOptions = {}
): CommandBus {
  const context: CommandContext = { registry, bridge };
  if (options.isModuleEnabled) context.isModuleEnabled = options.isModuleEnabled;
  if (options.loadBuiltinPricebook) context.loadBuiltinPricebook = options.loadBuiltinPricebook;
  if (options.renderCostPdf) context.renderCostPdf = options.renderCostPdf;
  if (options.exportsRoot) context.exportsRoot = options.exportsRoot;
  if (options.userDataRoot) context.userDataRoot = options.userDataRoot;
  if (options.renderReportPdf) context.renderReportPdf = options.renderReportPdf;
  if (options.buildSolids) context.buildSolids = options.buildSolids;
  if (options.now) context.now = options.now;
  const bus = new CommandBus(context);
  registerInsertCommand(bus);
  registerPlaceCommand(bus);
  registerImportCommand(bus);
  registerReadCommands(bus);
  registerProjectContextCommand(bus);
  registerUpdateComponentCommand(bus);
  registerRemoveComponentCommand(bus);
  registerElectricalCheckCommand(bus);
  registerCostCommand(bus);
  registerCostExportCommand(bus);
  registerPlcVerifyCommand(bus);
  registerPlcGenerateCommand(bus);
  registerMachineApplyCommand(bus);
  registerExportFilesCommand(bus);
  return bus;
}

export { planExportName, buildCostExport } from '../cost/export.ts';
