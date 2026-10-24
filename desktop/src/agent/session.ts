import type { CommandResult } from './commands.ts';
import type { AgentCommandExecutor } from './tools.ts';
import type { LlmChatResponse, LlmClient, LlmMessage, LlmToolCall } from './llm.ts';
import type { AgentAuditRecord } from './audit.ts';
import { describePlan, planReadOnly, routeIntent, READ_ONLY_TOOLS, requiresWriteConfirmation } from './router.ts';
import {
  emptyAgentContext,
  serializeAgentContext,
  type AgentContext
} from './context.ts';
import { AgentMemory, resultCode, summarizeToolCall } from './memory.ts';
import { serializeToolResult, toolResultByteLimit } from './trim.ts';
import {
  addTokenUsage,
  DEFAULT_SECTION_CAPS,
  DEFAULT_TOTAL_BUDGET,
  emptyTokenUsage,
  estimateCostView,
  estimateTokens,
  pack,
  type BudgetDrop,
  type BudgetOptions,
  type CostView,
  type PackedBudget,
  type PricingBook,
  type TokenUsage
} from './budget.ts';
import { DATA_POLICY_PROMPT, guardToolResult } from './guard.ts';
import { repairToolCall } from './repair.ts';
import { buildFallbackReply, buildRetryPrompt } from './retry.ts';
import {
  BYPASS_CONFIRMATION_NOTICE,
  detectBypassIntent,
  hasExplicitConsent,
  sanitizeConfirmationClaims,
  type BypassIntent
} from './policy.ts';
import {
  cancellationText,
  summarizeArguments,
  type AgentProgressEvent,
  type CompletedStep
} from './feedback.ts';
import {
  DEFAULT_MAX_TOOL_CALLS_PER_TURN,
  TurnCallDeduper,
  type DedupeDecision
} from './dedupe.ts';
import {
  DEFAULT_PARALLEL_CONCURRENCY,
  planExecutionBatches,
  runReadOnlyBatch,
  type BatchStep
} from './parallel.ts';
import { DEFAULT_RESULT_CACHE_TTL_MS, ToolResultCache } from './cache.ts';
import {
  AgentThread,
  augmentContextWithThreadReference,
  completedToThreadSteps,
  denialTarget,
  findDenial,
  formatThreadContext,
  normalizeDenials,
  projectFingerprint,
  removeDenial,
  type DenialReason,
  type PendingConfirm,
  type ThreadDenial,
  type ThreadState
} from './thread.ts';

export interface AgentSessionOptions {
  llm: LlmClient;
  bus: AgentCommandExecutor;
  confirmWrite(
    name: string,
    args: Record<string, unknown>,
    context?: ConfirmWriteContext
  ): Promise<boolean>;
  maxIterations?: number;
  historyLimit?: number;
  /** 审计回调：主进程写 agent-audit.jsonl；不传则不记录。 */
  audit?: (record: AgentAuditRecord) => void;
  /** 模型不可用时是否走离线规则路由（只读工具）；默认开启。 */
  offlineFallback?: boolean;
  /** 每轮对话开始时采集 UI 上下文；失败按空快照处理，不阻断对话。 */
  contextProvider?: () => AgentContext | null | Promise<AgentContext | null>;
  /** 工具参数 JSON Schema（name → schema）；用于模型脏输出纠错。 */
  toolSchemas?: Record<string, unknown> | ((name: string) => unknown);
  /** 多轮状态存储；主进程让对话与计划共享同一个实例。 */
  thread?: AgentThread;
  /** 模型名，用于价格表匹配与侧栏成本展示。 */
  model?: string;
  /** 模型价格表；未传时成本显示「—」。 */
  pricing?: PricingBook | null;
  /** 上下文预算档位；默认总量 12k tokens。 */
  budget?: BudgetOptions;
  /** 单轮工具调用上限；默认 12。 */
  toolCallLimit?: number;
  /** 只读工具并发度；默认 3。 */
  parallelConcurrency?: number;
  /** 会话结果缓存 TTL；默认 30 秒。 */
  cacheTtlMs?: number;
  /** 可注入时钟，供缓存 TTL 测试。 */
  now?: () => number;
}

export type ConfirmWrite = AgentSessionOptions['confirmWrite'];

export interface ConfirmWriteContext {
  /** 本轮用户文本命中了绕过确认意图；写工具仍必须由用户确认。 */
  bypass: boolean;
  phrase?: string;
  /** 供确认弹窗追加的固定文案。 */
  notice?: string;
}

export interface AgentRunOptions {
  signal?: AbortSignal;
  onProgress?: (event: AgentProgressEvent) => void;
  /** 由主进程生成，用于 UI 丢弃上一轮迟到的进度事件。 */
  runId?: string;
}

/** 最近一次回复的通道：在线模型 / 离线规则。UI 用它显示统一回执。 */
export type AgentReplyMode = 'online' | 'offline';

export interface AgentEfficiencySnapshot {
  toolCalls: number;
  executed: number;
  reused: number;
  overflows: number;
  cacheHits: number;
  parallelBatches: number;
  maxConcurrency: number;
}

export interface AgentUsageSnapshot {
  model: string;
  turn: TokenUsage;
  session: TokenUsage;
  cost: {
    turn: CostView;
    session: CostView;
  };
  /** 最近一次装包结果（system/selection/memory/docs 段）。 */
  budget?: {
    used: number;
    dropped: BudgetDrop[];
  };
}

export function emptyAgentUsage(model = ''): AgentUsageSnapshot {
  return {
    model: model || 'unknown',
    turn: emptyTokenUsage(),
    session: emptyTokenUsage(),
    cost: {
      turn: { known: false, currency: 'CNY', amount: null, display: '—' },
      session: { known: false, currency: 'CNY', amount: null, display: '—' }
    }
  };
}

const COMMAND_ALIASES: Record<string, string> = {
  run_interference_check: 'run_interference'
};

function markReusedResult(
  result: unknown,
  source: 'dedupe' | 'cache'
): Record<string, unknown> {
  const base = isRecord(result)
    ? { ...result }
    : { ok: true, data: result };
  return {
    ...base,
    reused: true,
    reuseSource: source,
    ...(source === 'cache' ? { cacheHit: true } : {})
  };
}

class AgentAborted extends Error {
  constructor() {
    super('aborted');
    this.name = 'AgentAborted';
  }
}

/** 会话被取消时抛出；completed 只包含已结束的步骤，不含被中断的当前步。 */
export class AgentCancelledError extends Error {
  readonly completedSteps: CompletedStep[];
  readonly currentTool: string | undefined;
  readonly currentToolMayWrite: boolean;

  constructor(completedSteps: CompletedStep[], currentTool?: string, currentToolMayWrite = false) {
    super(cancellationText({ completed: completedSteps, ...(currentTool ? { currentTool } : {}), currentToolMayWrite }));
    this.name = 'AgentCancelledError';
    this.completedSteps = completedSteps.map((item) => ({ ...item }));
    this.currentTool = currentTool;
    this.currentToolMayWrite = currentToolMayWrite;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AgentAborted();
}

/** 只用于中断「等待」；底层命令若已越过不可中断点，按已完成结果处理。 */
function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new AgentAborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new AgentAborted());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

const SYSTEM_PROMPT = [
  '你是 AutomationCAD 的桌面智能体。',
  '可以使用工具查询元器件、读取工程上下文/BOM、导入 CAD、插入/修改/移除元件、在底板放置元件、执行干涉初筛、生成 PLC 工程、生成成本报告并导出文件、撤销。',
  '当用户要求查询、计算、修改、生成或导出时，应直接调用已注册工具，不要只给出操作建议。',
  '只读工具会读取当前文档；缺少显式参数时先调用只读工具或 get_project_context，再根据结果决定能否继续，不要凭猜测填参数。',
  '导入 CAD 时若用户未给路径，先使用上下文或最近操作中的 STEP/IGES 文件路径；确实没有才追问。',
  '生成 BOM 使用 get_bom；只有用户明确要求导出/下载文件时才调用 export_files。',
  '缺少外形尺寸只影响底板绘制与几何校核，不得因此拒绝导出 BOM、PDF 或成本报告；应在结果里提示「N 个件无尺寸」并照常完成导出。',
  '只有会造成元件重叠、覆盖已存在文件或破坏数据时才暂停并请求用户确认；其余情况按用户指令继续执行，不要自行降级为「只给建议」。',
  '电气合规、线号或载流量问题直接调用 run_electrical_check；工具会读取当前电气文档，不要先用 BOM 推断缺少数据。',
  '涉及「怎么操作 / 限制 / 决策依据 / 为什么」时先调用 search_docs 查本地项目文档；答案要引用返回的 source 与 heading。没有命中就明确说查不到，禁止凭空编造。',
  '位号明确时直接调用 update_component / remove_component，由工具校验目标；不要仅凭猜测跳过写操作。',
  '用户说“生成 PLC 程序”并要求落盘时用 run_plc_generate；verify_plc_program 只用于模拟验证。',
  '机型设计先调用 design_machine；若结果 needs 非空，最多追问一次 question（问题里已带默认值），同一方案不要重复追问。用户未回答或要求按默认继续时，直接采用返回的 design，并在回复中转述 assumptions 中的缺省项。',
  '工具结果会以 JSON 数据块返回；失败时根据错误码向用户解释，不要编造执行结果。',
  '涉及修改装配体或写文件的操作会先请求用户确认。',
  DATA_POLICY_PROMPT
].join('');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error('工具参数必须是 JSON 对象');
  return parsed;
}

function failedTool(code: string, message: string): Record<string, unknown> {
  return { ok: false, error: { code, message } };
}

function docsSourceCount(result: unknown): number | undefined {
  if (!isRecord(result)) return undefined;
  const data = isRecord(result.data) ? result.data : result;
  const hits = Array.isArray(data.hits) ? data.hits : Array.isArray(result.hits) ? result.hits : null;
  return hits ? hits.length : undefined;
}

type PreparedToolCalls =
  | { ok: true; calls: LlmToolCall[]; repairs: string[] }
  | { ok: false; reason: string; repairs: string[] };

export class AgentSession {
  private readonly llm: LlmClient;
  private readonly bus: AgentCommandExecutor;
  private readonly confirmWrite: ConfirmWrite;
  private readonly maxIterations: number;
  private readonly historyLimit: number;
  private readonly audit: ((record: AgentAuditRecord) => void) | undefined;
  private readonly offlineFallback: boolean;
  private readonly contextProvider: AgentSessionOptions['contextProvider'];
  private readonly toolSchemas: AgentSessionOptions['toolSchemas'];
  private readonly thread: AgentThread;
  private readonly model: string;
  private readonly pricing: PricingBook | null;
  private readonly budget: BudgetOptions;
  private readonly dedupe: TurnCallDeduper;
  private readonly cache: ToolResultCache;
  private readonly parallelConcurrency: number;
  private readonly toolCallLimit: number;
  private readonly memory = new AgentMemory();
  private parallelBatches = 0;
  private maxParallelConcurrency = 0;
  private cacheHits = 0;
  private threadPrevious: ThreadState | null = null;
  private pendingConfirm: PendingConfirm | undefined;
  private denials: ThreadDenial[] = [];
  private currentTurnId = 0;
  private turnText = '';
  private turnContextReady = false;
  private messages: LlmMessage[] = [];
  private replyMode: AgentReplyMode = 'online';
  private turnContext: AgentContext = emptyAgentContext();
  private bypassIntent: BypassIntent | null = null;
  private readonly deniedWriteTools = new Set<string>();
  private turnUsage: TokenUsage = emptyTokenUsage();
  private sessionUsage: TokenUsage = emptyTokenUsage();
  private lastRequestUsage: TokenUsage | null = null;
  private lastBudget: PackedBudget | null = null;

  constructor(options: AgentSessionOptions) {
    this.llm = options.llm;
    this.bus = options.bus;
    this.confirmWrite = options.confirmWrite;
    this.maxIterations = Math.max(1, Math.trunc(options.maxIterations ?? 6));
    this.historyLimit = Math.max(2, Math.trunc(options.historyLimit ?? 20));
    this.audit = options.audit;
    this.offlineFallback = options.offlineFallback !== false;
    this.contextProvider = options.contextProvider;
    this.toolSchemas = options.toolSchemas;
    this.thread = options.thread ?? new AgentThread();
    this.model = options.model?.trim() ?? '';
    this.pricing = options.pricing ?? null;
    this.budget = options.budget ?? {};
    this.toolCallLimit = Math.max(1, Math.trunc(options.toolCallLimit ?? DEFAULT_MAX_TOOL_CALLS_PER_TURN));
    this.dedupe = new TurnCallDeduper({
      maxCalls: this.toolCallLimit,
      isWrite: (tool) => !READ_ONLY_TOOLS.has(tool)
    });
    this.cache = new ToolResultCache({
      ttlMs: options.cacheTtlMs ?? DEFAULT_RESULT_CACHE_TTL_MS,
      ...(options.now ? { now: options.now } : {})
    });
    this.parallelConcurrency = Math.max(
      1,
      Math.trunc(options.parallelConcurrency ?? DEFAULT_PARALLEL_CONCURRENCY)
    );
  }

  private recordAudit(record: AgentAuditRecord): void {
    if (!this.audit) return;
    const request = this.lastRequestUsage;
    const withTokens: AgentAuditRecord = record.source === 'llm' && request
      ? {
          ...record,
          promptTokens: record.promptTokens ?? request.promptTokens,
          completionTokens: record.completionTokens ?? request.completionTokens,
          estimated: record.estimated ?? request.estimated
        }
      : record;
    try {
      this.audit(withTokens);
    } catch (error) {
      // 审计失败不阻断对话，但必须留下可诊断的告警。
      console.warn('[agent] 审计写入失败', error);
    }
  }

  /** 最近一次/本会话的 token 与估算费用；IPC 直接透传给侧栏。 */
  usage(): AgentUsageSnapshot {
    const turn = { ...this.turnUsage };
    const session = { ...this.sessionUsage };
    return {
      model: this.model || 'unknown',
      turn,
      session,
      cost: {
        turn: estimateCostView(this.pricing, this.model, turn.promptTokens, turn.completionTokens),
        session: estimateCostView(this.pricing, this.model, session.promptTokens, session.completionTokens)
      },
      ...(this.lastBudget
        ? { budget: { used: this.lastBudget.used, dropped: this.lastBudget.dropped.slice() } }
        : {})
    };
  }

  /** 最近一次系统上下文装包结果（供诊断/冒烟读取）。 */
  budgetSnapshot(): PackedBudget | null {
    return this.lastBudget;
  }

  /** 本轮执行效率快照：去重、缓存与并行度，供诊断/冒烟读取。 */
  efficiency(): AgentEfficiencySnapshot {
    const stats = this.dedupe.stats();
    return {
      ...stats,
      cacheHits: this.cacheHits,
      parallelBatches: this.parallelBatches,
      maxConcurrency: this.maxParallelConcurrency
    };
  }

  private estimatePromptTokens(messages: LlmMessage[]): number {
    const history = messages.map((message) => {
      const calls = message.tool_calls ? JSON.stringify(message.tool_calls) : '';
      return `${message.role}\n${message.content ?? ''}\n${calls}`;
    }).join('\n');
    let schemaText = '';
    if (this.toolSchemas) {
      if (typeof this.toolSchemas === 'function') {
        schemaText = '';
      } else {
        try {
          schemaText = JSON.stringify(this.toolSchemas);
        } catch {
          schemaText = '';
        }
      }
    }
    return estimateTokens(history) + estimateTokens(schemaText);
  }

  private recordLlmUsage(messages: LlmMessage[], response: LlmChatResponse): void {
    const real = response.usage;
    const prompt = real?.promptTokens ?? this.estimatePromptTokens(messages);
    const completionText = `${response.content}\n${JSON.stringify(response.toolCalls)}`;
    const completion = real?.completionTokens ?? estimateTokens(completionText);
    const estimated = real?.promptTokens === undefined || real?.completionTokens === undefined;
    const usage: TokenUsage = {
      promptTokens: Math.max(0, Math.trunc(prompt)),
      completionTokens: Math.max(0, Math.trunc(completion)),
      totalTokens: Math.max(0, Math.trunc(prompt)) + Math.max(0, Math.trunc(completion)),
      estimated,
      requests: 1
    };
    this.turnUsage = addTokenUsage(this.turnUsage, usage);
    this.sessionUsage = addTokenUsage(this.sessionUsage, usage);
    this.lastRequestUsage = usage;
  }

  private async callLlm(messages: LlmMessage[], signal?: AbortSignal): Promise<LlmChatResponse> {
    const response = await withAbort(this.llm.chat(messages), signal);
    this.recordLlmUsage(messages, response);
    return response;
  }

  history(): LlmMessage[] {
    return this.messages.map((message) => ({
      ...message,
      ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call) => ({ ...call, function: { ...call.function } })) } : {})
    }));
  }

  clear(): void {
    this.messages = [];
    this.replyMode = 'online';
    this.turnContext = emptyAgentContext();
    this.bypassIntent = null;
    this.deniedWriteTools.clear();
    this.memory.clear();
    this.dedupe.clear();
    this.cache.clear();
    this.parallelBatches = 0;
    this.maxParallelConcurrency = 0;
    this.cacheHits = 0;
    this.thread.clear();
    this.threadPrevious = null;
    this.pendingConfirm = undefined;
    this.denials = [];
    this.currentTurnId = 0;
    this.turnText = '';
    this.turnContextReady = false;
    this.turnUsage = emptyTokenUsage();
    this.sessionUsage = emptyTokenUsage();
    this.lastRequestUsage = null;
    this.lastBudget = null;
  }

  /** 供 UI / IPC / 测试读取的上一轮状态快照；只读拷贝。 */
  threadState(): ThreadState | null {
    return this.thread.read();
  }

  /** 最近一次 `run()` 走的是哪条通道；离线降级时返回 'offline'。 */
  mode(): AgentReplyMode {
    return this.replyMode;
  }

  private push(message: LlmMessage): void {
    this.messages.push(message);
    if (this.messages.length > this.historyLimit) {
      this.messages.splice(0, this.messages.length - this.historyLimit);
    }
  }

  private systemPrompt(): LlmMessage {
    const packed = serializeAgentContext(this.turnContext);
    const memory = this.memory.prompt();
    const thread = formatThreadContext(this.threadPrevious, this.turnContextReady ? this.turnContext : null);
    const budgeted = pack({
      system: SYSTEM_PROMPT,
      selection: [thread, packed.text].filter(Boolean).join('\n\n'),
      memory
    }, this.budget);
    this.lastBudget = budgeted;
    return { role: 'system', content: budgeted.text };
  }

  private messageTokenText(message: LlmMessage): string {
    const calls = message.tool_calls ? JSON.stringify(message.tool_calls) : '';
    return `${message.role}\n${message.content ?? ''}\n${calls}`;
  }

  /** 历史按「用户轮次」成组丢弃，避免拆散 assistant/tool 协议对。 */
  private budgetedMessages(): LlmMessage[] {
    const cap = Math.max(200, Math.trunc(this.budget.caps?.history ?? DEFAULT_SECTION_CAPS.history));
    const total = Math.max(1, Math.trunc(this.budget.total ?? DEFAULT_TOTAL_BUDGET));
    const groups: LlmMessage[][] = [];
    for (const message of this.messages) {
      if (message.role === 'user' || groups.length === 0) groups.push([]);
      groups[groups.length - 1]!.push(message);
    }
    const render = (): LlmMessage[] => groups.flat().map((message) => ({
      ...message,
      ...(message.tool_calls
        ? { tool_calls: message.tool_calls.map((call) => ({ ...call, function: { ...call.function } })) }
        : {})
    }));
    const over = (): boolean => {
      const history = render();
      const historyText = history.map((message) => this.messageTokenText(message)).join('\n');
      const systemText = this.lastBudget?.text ?? '';
      const systemTokens = estimateTokens(systemText);
      const historyTokens = estimateTokens(historyText);
      return historyTokens > cap || systemTokens + historyTokens > total;
    };
    while (groups.length > 1 && over()) groups.shift();
    return render();
  }

  private context(): LlmMessage[] {
    return [
      this.systemPrompt(),
      ...this.budgetedMessages()
    ];
  }

  private toolSchema(name: string): Record<string, unknown> | undefined {
    const source = typeof this.toolSchemas === 'function'
      ? this.toolSchemas(name)
      : this.toolSchemas?.[name];
    return isRecord(source) ? source : undefined;
  }

  /** 对模型返回的每个工具调用做结构修复 + schema 校验；任一失败则整轮重试。 */
  private prepareToolCalls(calls: LlmToolCall[]): PreparedToolCalls {
    const repaired: LlmToolCall[] = [];
    const repairs: string[] = [];
    for (const call of calls) {
      const result = repairToolCall(call.function.arguments, this.toolSchema(call.function.name), {
        ...(this.turnContext.selection ? { selection: this.turnContext.selection } : {})
      });
      if (!result.ok || !result.call) {
        const message = result.error?.message ?? '工具参数无法解析';
        return { ok: false, reason: `${call.function.name}: ${message}`, repairs };
      }
      for (const note of result.repairs) repairs.push(`${call.function.name}: ${note}`);
      repaired.push({
        ...call,
        function: { name: call.function.name, arguments: JSON.stringify(result.call.args) }
      });
    }
    return { ok: true, calls: repaired, repairs };
  }

  /** 重试上下文：把上一次无效输出作为普通 assistant 文本回灌，再追加纠错指令。 */
  private retryContext(reason: string, invalid: LlmToolCall[]): LlmMessage[] {
    const summary = invalid
      .map((call) => `${call.function.name} ${call.function.arguments}`)
      .join('\n')
      .slice(0, 800);
    return [
      ...this.context(),
      { role: 'assistant', content: `上次工具调用输出：\n${summary}` },
      { role: 'user', content: buildRetryPrompt(reason) }
    ];
  }

  private respondFallback(userText: string, reason: string): string {
    const reply = sanitizeConfirmationClaims(buildFallbackReply(reason, userText));
    this.push({ role: 'assistant', content: reply });
    return reply;
  }

  private emitProgress(
    onProgress: AgentRunOptions['onProgress'],
    event: AgentProgressEvent
  ): void {
    if (!onProgress) return;
    try {
      onProgress(event);
    } catch (error) {
      // 进度展示失败不能影响工具执行。
      console.warn(`[SESSION_PROGRESS_UI_FAILED]`, { site: 'desktop/src/agent/session.ts:606' }, error);
    }
  }

  private denialTargetFor(args: Record<string, unknown>): string | undefined {
    return denialTarget(args, this.turnContextReady ? this.turnContext : null);
  }

  /** 追加一条跨轮拒绝记忆；同工具同目标由 normalizeDenials 后者覆盖并限长。 */
  private recordDenial(
    reason: DenialReason,
    tool: string,
    target: string | undefined
  ): ThreadDenial {
    const denial: ThreadDenial = {
      tool,
      ...(target ? { target } : {}),
      at: new Date().toISOString(),
      reason,
      turnId: String(this.currentTurnId)
    };
    this.denials = normalizeDenials([...this.denials, denial]);
    return denial;
  }

  private clearDenial(tool: string, target: string | undefined): ThreadDenial | null {
    const prior = findDenial(this.denials, tool, target);
    if (!prior) return null;
    this.denials = removeDenial(this.denials, tool, target);
    return prior;
  }

  private async executeTool(
    call: LlmToolCall,
    context: {
      runId: string;
      index: number;
      total: number;
      completed: CompletedStep[];
      signal?: AbortSignal;
      onProgress?: AgentRunOptions['onProgress'];
    },
    options: {
      args?: Record<string, unknown>;
      synthetic?: {
        result: unknown;
        code: string;
        message?: string;
        cacheHit?: boolean;
        reuse?: 'dedupe' | 'cache';
      };
    } = {}
  ): Promise<unknown> {
    const name = call.function.name;
    const startedAt = Date.now();
    let args: Record<string, unknown> = {};
    try {
      if (options.synthetic) {
        args = options.args ? { ...options.args } : {};
      } else {
        args = options.args ? { ...options.args } : parseArguments(call.function.arguments);
      }
    } catch (error) {
      this.emitProgress(context.onProgress, {
        runId: context.runId,
        phase: 'start',
        index: context.index,
        total: context.total,
        tool: name,
        argsSummary: summarizeArguments(call.function.arguments),
        startedAt,
        callId: call.id,
        source: 'chat'
      });
      const message = `工具参数不是合法 JSON：${error instanceof Error ? error.message : String(error)}`;
      this.memory.record(summarizeToolCall(name, {}, failedTool('INVALID_ARGUMENT', '参数不是合法 JSON')));
      this.recordAudit({
        tool: name,
        ok: false,
        code: 'INVALID_ARGUMENT',
        source: 'llm',
        message,
        elapsedMs: Date.now() - startedAt
      });
      this.emitProgress(context.onProgress, {
        runId: context.runId,
        phase: 'end',
        index: context.index,
        total: context.total,
        tool: name,
        argsSummary: summarizeArguments(call.function.arguments),
        startedAt,
        callId: call.id,
        elapsedMs: Date.now() - startedAt,
        ok: false,
        code: 'INVALID_ARGUMENT',
        message,
        source: 'chat'
      });
      context.completed.push({ step: context.index, tool: name, args: {}, ok: false, code: 'INVALID_ARGUMENT', wrote: false });
      return failedTool('INVALID_ARGUMENT', message);
    }

    const argsSummary = summarizeArguments(args);
    const denialKey = this.denialTargetFor(args);
    this.emitProgress(context.onProgress, {
      runId: context.runId,
      phase: 'start',
      index: context.index,
      total: context.total,
      tool: name,
      argsSummary,
      startedAt,
      callId: call.id,
      source: 'chat'
    });

    const finish = (
      ok: boolean,
      code: string,
      message?: string,
      extras: {
        docsSources?: number;
        target?: string;
        denialReason?: DenialReason;
        deniedTurnId?: string;
        consent?: boolean;
        cacheHit?: boolean;
      } = {}
    ): void => {
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      this.recordAudit({
        tool: name,
        ok,
        source: 'llm',
        args,
        elapsedMs,
        ...(code !== 'OK' ? { code } : {}),
        ...(message ? { message } : {}),
        ...(extras.docsSources !== undefined ? { docsSources: extras.docsSources } : {}),
        ...(extras.target ? { target: extras.target } : {}),
        ...(extras.denialReason ? { denialReason: extras.denialReason } : {}),
        ...(extras.deniedTurnId ? { deniedTurnId: extras.deniedTurnId } : {}),
        ...(extras.consent !== undefined ? { consent: extras.consent } : {}),
        ...(extras.cacheHit === true ? { cacheHit: true } : {})
      });
      this.emitProgress(context.onProgress, {
        runId: context.runId,
        phase: 'end',
        index: context.index,
        total: context.total,
        tool: name,
        argsSummary,
        startedAt,
        callId: call.id,
        elapsedMs,
        ok,
        code,
        ...(message ? { message } : {}),
        source: 'chat',
        ...(extras.cacheHit === true ? { cacheHit: true } : {})
      });
      if (code !== 'CANCELLED') {
        context.completed.push({
          step: context.index,
          tool: name,
          args: { ...args },
          ok,
          code,
          wrote: ok && requiresWriteConfirmation(name)
        });
      }
    };

    try {
      throwIfAborted(context.signal);
      if (options.synthetic) {
        const synthetic = options.synthetic;
        const result = synthetic.reuse
          ? markReusedResult(synthetic.result, synthetic.reuse)
          : synthetic.result;
        const code = synthetic.code;
        if (synthetic.cacheHit) this.cacheHits += 1;
        this.memory.record(summarizeToolCall(name, args, result));
        finish(
          code === 'OK',
          code,
          synthetic.message,
          synthetic.cacheHit ? { cacheHit: true } : {}
        );
        return result;
      }
      if (requiresWriteConfirmation(name)) {
        // 硬边界：无论用户文本、模型输出或调用路径如何，写工具必须先拿到明确确认。
        const priorDenial = findDenial(this.denials, name, denialKey);
        if (priorDenial && priorDenial.reason !== 'timeout') {
          if (!hasExplicitConsent(this.turnText)) {
            const message = priorDenial.reason === 'user'
              ? `你在第 ${priorDenial.turnId} 轮拒绝过这个操作，需要明确同意才会重试`
              : `该操作在第 ${priorDenial.turnId} 轮被策略拦截过，需要明确同意才会重试`;
            this.memory.record(summarizeToolCall(name, args, { ok: false, code: 'USER_DENIED_PREVIOUSLY' }));
            finish(false, 'USER_DENIED_PREVIOUSLY', message, {
              ...(denialKey ? { target: denialKey } : {}),
              denialReason: priorDenial.reason,
              deniedTurnId: priorDenial.turnId
            });
            return {
              ok: false,
              code: 'USER_DENIED_PREVIOUSLY',
              message,
              ...(denialKey ? { target: denialKey } : {}),
              denialReason: priorDenial.reason,
              deniedTurnId: priorDenial.turnId
            };
          }
          // 明确同意只解除拒绝记忆；下面仍要重新走确认流程，确认框不会因此被跳过。
          this.clearDenial(name, denialKey);
          this.recordAudit({
            tool: name,
            ok: true,
            code: 'DENIAL_CLEARED',
            source: 'llm',
            args,
            ...(denialKey ? { target: denialKey } : {}),
            denialReason: priorDenial.reason,
            deniedTurnId: priorDenial.turnId,
            consent: true,
            message: '用户本轮明确同意，已解除拒绝记忆并重新请求确认'
          });
        }
        if (this.deniedWriteTools.has(name)) {
          const message = `本轮已拒绝 ${name}，后续同名写操作不再重复弹窗`;
          this.memory.record(summarizeToolCall(name, args, { ok: false, code: 'USER_DENIED' }));
          finish(false, 'USER_DENIED', message);
          return { ok: false, code: 'USER_DENIED', message };
        }
        if (typeof this.confirmWrite !== 'function') {
          const message = '写操作缺少确认回调，已拒绝执行';
          this.recordDenial('policy', name, denialKey);
          this.memory.record(summarizeToolCall(name, args, { ok: false, code: 'CONFIRMATION_REQUIRED' }));
          finish(false, 'CONFIRMATION_REQUIRED', message, {
            ...(denialKey ? { target: denialKey } : {}),
            denialReason: 'policy',
            deniedTurnId: String(this.currentTurnId)
          });
          return { ok: false, code: 'CONFIRMATION_REQUIRED', message };
        }

        const bypass = this.bypassIntent;
        if (bypass) {
          this.recordAudit({
            tool: name,
            ok: false,
            code: 'BYPASS_ATTEMPT',
            source: 'llm',
            args,
            phrase: bypass.phrase,
            message: `检测到绕过确认意图「${bypass.phrase}」；仍强制请求确认`
          });
        }

        let allowed = false;
        try {
          allowed = await withAbort(
            this.confirmWrite(name, args, {
              bypass: bypass !== null,
              ...(bypass ? { phrase: bypass.phrase, notice: BYPASS_CONFIRMATION_NOTICE } : {})
            }),
            context.signal
          );
        } catch (error) {
          if (error instanceof AgentAborted) {
            this.pendingConfirm = {
              tool: name,
              args: { ...args },
              stepIndex: Math.max(0, context.index - 1),
              reason: 'cancelled'
            };
            finish(false, 'CANCELLED', '已取消');
            throw new AgentCancelledError(context.completed, name, false);
          }
          const message = `确认对话框失败：${error instanceof Error ? error.message : String(error)}`;
          const timeout = /timeout|timed out|超时|ETIMEDOUT/i.test(message);
          if (timeout) {
            this.pendingConfirm = {
              tool: name,
              args: { ...args },
              stepIndex: Math.max(0, context.index - 1),
              reason: 'timeout',
              message
            };
            this.memory.record(summarizeToolCall(name, args, { ok: false, code: 'CONFIRM_TIMEOUT' }));
            const timeoutDenial = this.recordDenial('timeout', name, denialKey);
            finish(false, 'CONFIRM_TIMEOUT', message, {
              ...(denialKey ? { target: denialKey } : {}),
              denialReason: 'timeout',
              deniedTurnId: timeoutDenial.turnId
            });
            return { ok: false, code: 'CONFIRM_TIMEOUT', message };
          }
          const denial = this.recordDenial('user', name, denialKey);
          this.memory.record(summarizeToolCall(name, args, { ok: false, code: 'USER_DENIED' }));
          finish(false, 'USER_DENIED', message, {
            ...(denialKey ? { target: denialKey } : {}),
            denialReason: denial.reason,
            deniedTurnId: denial.turnId
          });
          return { ok: false, code: 'USER_DENIED', message };
        }
        if (allowed !== true) {
          const denial = this.recordDenial('user', name, denialKey);
          this.deniedWriteTools.add(name);
          this.memory.record(summarizeToolCall(name, args, { ok: false, code: 'USER_DENIED' }));
          finish(false, 'USER_DENIED', '用户拒绝执行该工具', {
            ...(denialKey ? { target: denialKey } : {}),
            denialReason: denial.reason,
            deniedTurnId: denial.turnId
          });
          return { ok: false, code: 'USER_DENIED', message: '用户拒绝执行该工具' };
        }
        // 超时后的再次确认成功：清掉旧的超时记忆，下一轮提示不再重复催促。
        this.clearDenial(name, denialKey);
      }

      if (context.signal?.aborted) {
        finish(false, 'CANCELLED', '已取消');
        throw new AgentCancelledError(context.completed, name, false);
      }
      const command = COMMAND_ALIASES[name] ?? name;
      if (requiresWriteConfirmation(name)) this.cache.invalidateAfterWrite(name);
      const result = await withAbort(
        name === 'undo_last'
          ? this.bus.undoLast(context.signal)
          : this.bus.execute(command, args, context.signal),
        context.signal
      );
      if (requiresWriteConfirmation(name)) this.cache.invalidateAfterWrite(name);
      this.memory.record(summarizeToolCall(name, args, result));
      const code = result.ok ? 'OK' : (result.error?.code ?? 'COMMAND_FAILED');
      const policyDenial = !result.ok && (code === 'TARGET_PATH_UNSUPPORTED' || code === 'POLICY_DENIED')
        ? this.recordDenial('policy', name, denialKey)
        : null;
      const sources = name === 'search_docs' ? docsSourceCount(result) : undefined;
      finish(
        result.ok,
        code,
        result.ok ? undefined : result.error?.message,
        {
          ...(sources !== undefined ? { docsSources: sources } : {}),
          ...(policyDenial
            ? {
                ...(denialKey ? { target: denialKey } : {}),
                denialReason: 'policy' as const,
                deniedTurnId: policyDenial.turnId
              }
            : {})
        }
      );

      if (name === 'run_interference_check' && result.ok && isRecord(result.data) && Array.isArray(result.data.items)) {
        return {
          ok: true,
          hits: Number(result.data.hits ?? result.data.items.length),
          items: result.data.items.slice(0, 20)
        };
      }
      return result;
    } catch (error) {
      if (error instanceof AgentCancelledError) throw error;
      if (error instanceof AgentAborted) {
        finish(false, 'CANCELLED', '已取消');
        throw new AgentCancelledError(context.completed, name, requiresWriteConfirmation(name));
      }
      const message = error instanceof Error ? error.message : String(error);
      this.memory.record(summarizeToolCall(name, args, { ok: false, code: 'TOOL_EXECUTION_FAILED' }));
      finish(false, 'TOOL_EXECUTION_FAILED', message);
      return failedTool('TOOL_EXECUTION_FAILED', message);
    }
  }

  private async executeToolBatch(
    calls: readonly LlmToolCall[],
    context: {
      runId: string;
      completed: CompletedStep[];
      signal?: AbortSignal;
      onProgress?: AgentRunOptions['onProgress'];
    }
  ): Promise<unknown[]> {
    const prepared = calls.map((call) => {
      try {
        return { call, args: parseArguments(call.function.arguments), valid: true as const };
      } catch {
        return {
          call,
          args: {} as Record<string, unknown>,
          valid: false as const,
          key: `invalid:${call.id}:${call.function.arguments}`
        };
      }
    });
    const results = new Array<unknown>(calls.length);
    let start = 0;
    let afterWrite = false;
    for (const [index, item] of prepared.entries()) {
      if (READ_ONLY_TOOLS.has(item.call.function.name)) continue;
      if (start < index) {
        await this.executeToolSegment(prepared.slice(start, index), start, results, calls.length, context, afterWrite);
      }
      await this.executeToolSegment([item], index, results, calls.length, context, afterWrite);
      // 写后不得复用写前的只读结果；同一响应内后续只读也全部串行。
      this.dedupe.invalidateResults();
      afterWrite = true;
      start = index + 1;
    }
    if (start < prepared.length) {
      await this.executeToolSegment(prepared.slice(start), start, results, calls.length, context, afterWrite);
    }
    if (context.signal?.aborted) throw new AgentCancelledError(context.completed);
    context.completed.sort((left, right) => left.step - right.step);
    return results;
  }

  private async executeToolSegment(
    prepared: Array<{
      call: LlmToolCall;
      args: Record<string, unknown>;
      valid: boolean;
      key?: string;
    }>,
    offset: number,
    results: unknown[],
    total: number,
    context: {
      runId: string;
      completed: CompletedStep[];
      signal?: AbortSignal;
      onProgress?: AgentRunOptions['onProgress'];
    },
    serialOnly: boolean
  ): Promise<void> {
    const decisions = this.dedupe.plan(prepared.map((item) => ({
      tool: item.call.function.name,
      args: item.args,
      ...(item.valid ? {} : { dedupe: false, key: item.key })
    }))).map((decision) => ({
      ...decision,
      index: offset + decision.index,
      ...(decision.duplicateOf !== undefined ? { duplicateOf: offset + decision.duplicateOf } : {})
    }));
    const fingerprint = projectFingerprint(this.turnContext);
    const executions: Array<{ prepared: (typeof prepared)[number]; decision: DedupeDecision }> = [];
    const duplicates: Array<{ prepared: (typeof prepared)[number]; decision: DedupeDecision; source: number }> = [];

    for (const decision of decisions) {
      const item = prepared[decision.index - offset]!;
      const call = item.call;
      const progress = {
        runId: context.runId,
        index: decision.index + 1,
        total,
        completed: context.completed,
        ...(context.signal ? { signal: context.signal } : {}),
        ...(context.onProgress ? { onProgress: context.onProgress } : {})
      };
      if (decision.action === 'overflow') {
        const message = `本轮工具调用超过上限 ${this.toolCallLimit} 次；请拆分为多轮再试（多余调用未执行）`;
        results[decision.index] = await this.executeTool(call, progress, {
          ...(item.valid ? { args: item.args } : {}),
          synthetic: {
            result: { ok: false, code: 'TOO_MANY_TOOL_CALLS', message, error: { code: 'TOO_MANY_TOOL_CALLS', message } },
            code: 'TOO_MANY_TOOL_CALLS',
            message
          }
        });
        continue;
      }

      if (decision.action === 'reuse' && decision.hasResult) {
        results[decision.index] = await this.executeTool(call, progress, {
          ...(item.valid ? { args: item.args } : {}),
          synthetic: {
            result: decision.result,
            code: resultCode(decision.result),
            message: '已复用（本轮重复调用，未再次执行）',
            cacheHit: true,
            reuse: 'dedupe'
          }
        });
        continue;
      }

      if (decision.action === 'reuse' && decision.duplicateOf !== undefined) {
        duplicates.push({ prepared: item, decision, source: decision.duplicateOf });
        continue;
      }

      if (READ_ONLY_TOOLS.has(call.function.name) && item.valid) {
        const hit = this.cache.get(call.function.name, item.args, fingerprint);
        if (hit.hit) {
          const result = await this.executeTool(call, progress, {
            args: item.args,
            synthetic: {
              result: hit.result,
              code: resultCode(hit.result),
              message: '已复用（会话缓存命中，未再次执行）',
              cacheHit: true,
              reuse: 'cache'
            }
          });
          this.dedupe.complete(decision, result);
          results[decision.index] = result;
          continue;
        }
      }

      executions.push({ prepared: item, decision });
    }

    const steps: BatchStep[] = executions.map((item) => ({
      tool: item.prepared.call.function.name,
      args: item.prepared.args,
      readOnly: READ_ONLY_TOOLS.has(item.prepared.call.function.name),
      index: item.decision.index
    }));
    const batches = serialOnly
      ? executions.map((_item, index) => ({ indexes: [index], concurrent: false, reason: 'write-barrier' as const }))
      : planExecutionBatches(steps);

    for (const batch of batches) {
      if (context.signal?.aborted) throw new AgentCancelledError(context.completed);
      const items = batch.indexes.map((stepIndex) => executions[stepIndex]!);
      if (batch.concurrent) {
        this.parallelBatches += 1;
        const summary = await runReadOnlyBatch(items, async (item) => {
          const progress = {
            runId: context.runId,
            index: item.decision.index + 1,
            total,
            completed: context.completed,
            ...(context.signal ? { signal: context.signal } : {}),
            ...(context.onProgress ? { onProgress: context.onProgress } : {})
          };
          return await this.executeTool(
            item.prepared.call,
            progress,
            item.prepared.valid ? { args: item.prepared.args } : {}
          );
        }, { concurrency: this.parallelConcurrency });
        this.maxParallelConcurrency = Math.max(this.maxParallelConcurrency, summary.maxConcurrency);
        for (const settled of summary.results) {
          const item = items[settled.index]!;
          const index = item.decision.index;
          if (settled.ok) {
            const result = settled.value;
            results[index] = result;
            this.dedupe.complete(item.decision, result);
            if (READ_ONLY_TOOLS.has(item.prepared.call.function.name) && item.prepared.valid) {
              this.cache.set(item.prepared.call.function.name, item.prepared.args, fingerprint, result);
            }
            continue;
          }
          const error = settled.error;
          if (error instanceof AgentCancelledError) throw error;
          if (error instanceof AgentAborted || context.signal?.aborted) {
            throw new AgentCancelledError(context.completed);
          }
          const message = error instanceof Error ? error.message : String(error);
          const result = failedTool('TOOL_EXECUTION_FAILED', message);
          this.recordAudit({
            tool: item.prepared.call.function.name,
            ok: false,
            code: 'TOOL_EXECUTION_FAILED',
            source: 'llm',
            args: item.prepared.args,
            message,
            elapsedMs: 0
          });
          results[index] = result;
          this.dedupe.complete(item.decision, result);
        }
        continue;
      }

      for (const item of items) {
        const progress = {
          runId: context.runId,
          index: item.decision.index + 1,
          total,
          completed: context.completed,
          ...(context.signal ? { signal: context.signal } : {}),
          ...(context.onProgress ? { onProgress: context.onProgress } : {})
        };
        const result = await this.executeTool(
          item.prepared.call,
          progress,
          item.prepared.valid ? { args: item.prepared.args } : {}
        );
        results[item.decision.index] = result;
        this.dedupe.complete(item.decision, result);
        if (READ_ONLY_TOOLS.has(item.prepared.call.function.name) && item.prepared.valid) {
          this.cache.set(item.prepared.call.function.name, item.prepared.args, fingerprint, result);
        }
      }
    }

    for (const duplicate of duplicates) {
      const index = duplicate.decision.index;
      const source = results[duplicate.source];
      const progress = {
        runId: context.runId,
        index: index + 1,
        total,
        completed: context.completed,
        ...(context.signal ? { signal: context.signal } : {}),
        ...(context.onProgress ? { onProgress: context.onProgress } : {})
      };
      results[index] = await this.executeTool(duplicate.prepared.call, progress, {
        ...(duplicate.prepared.valid ? { args: duplicate.prepared.args } : {}),
        synthetic: {
          result: source ?? failedTool('TOOL_EXECUTION_FAILED', '同轮首次调用没有返回结果'),
          code: source === undefined ? 'TOOL_EXECUTION_FAILED' : resultCode(source),
          message: source === undefined ? '同轮首次调用没有返回结果' : '已复用（本轮重复调用，未再次执行）',
          cacheHit: true,
          reuse: 'dedupe'
        }
      });
    }
  }

  /**
   * 模型不可用（断网/超时/未配密钥）时的离线通道：只走规则路由的只读工具。
   * 写操作一律不执行，只回一句“需要联网确认”，避免离线状态下误改文档。
   */
  private async runOffline(
    text: string,
    options: AgentRunOptions,
    completed: CompletedStep[]
  ): Promise<string | null> {
    if (!this.offlineFallback) return null;
    const plan = planReadOnly(text, this.turnContext);
    if (!plan) return null;
    if (requiresWriteConfirmation(plan.tool)) {
      const reply = '当前模型不可用，写操作必须联网并经用户确认，未执行。';
      this.push({ role: 'assistant', content: reply });
      return reply;
    }
    const startedAt = Date.now();
    const runId = options.runId ?? 'offline';
    const argsSummary = summarizeArguments(plan.args);
    this.emitProgress(options.onProgress, {
      runId,
      phase: 'start',
      index: 1,
      total: 1,
      tool: plan.tool,
      argsSummary,
      startedAt,
      source: 'chat'
    });
    let result: CommandResult;
    try {
      throwIfAborted(options.signal);
      result = await withAbort(
        plan.tool === 'undo_last'
          ? this.bus.undoLast(options.signal)
          : this.bus.execute(plan.tool, plan.args, options.signal),
        options.signal
      );
    } catch (error) {
      if (error instanceof AgentAborted) {
        this.emitProgress(options.onProgress, {
          runId,
          phase: 'end',
          index: 1,
          total: 1,
          tool: plan.tool,
          argsSummary,
          startedAt,
          elapsedMs: Date.now() - startedAt,
          ok: false,
          code: 'CANCELLED',
          message: '已取消',
          source: 'chat'
        });
        throw new AgentCancelledError(completed, plan.tool, requiresWriteConfirmation(plan.tool));
      }
      const message = error instanceof Error ? error.message : String(error);
      this.recordAudit({
        tool: plan.tool,
        ok: false,
        code: 'OFFLINE_FAILED',
        source: 'offline',
        args: plan.args,
        message,
        elapsedMs: Date.now() - startedAt
      });
      return `模型暂不可用，已按离线规则尝试 ${plan.tool}，但执行失败：${message}`;
    }
    const code = result.ok ? 'OK' : (result.error?.code ?? 'COMMAND_FAILED');
    this.recordAudit({
      tool: plan.tool,
      ok: result.ok,
      source: 'offline',
      args: plan.args,
      elapsedMs: Date.now() - startedAt,
      ...(result.ok ? {} : { code })
    });
    this.emitProgress(options.onProgress, {
      runId,
      phase: 'end',
      index: 1,
      total: 1,
      tool: plan.tool,
      argsSummary,
      startedAt,
      elapsedMs: Date.now() - startedAt,
      ok: result.ok,
      code,
      ...(result.ok ? {} : { message: result.error?.message ?? '未知错误' }),
      source: 'chat'
    });
    completed.push({ step: 1, tool: plan.tool, args: { ...plan.args }, ok: result.ok, code, wrote: result.ok && requiresWriteConfirmation(plan.tool) });
    this.memory.record(summarizeToolCall(plan.tool, plan.args, result));
    if (!result.ok) {
      return `模型暂不可用，离线规则已调用 ${plan.tool}，但返回失败：${result.error?.message ?? '未知错误'}`;
    }
    const detail = result.data === undefined ? '' : serializeToolResult(result.data, toolResultByteLimit(plan.tool)).text;
    const summary = detail.length > 600 ? `${detail.slice(0, 600)}…` : detail;
    const reference = plan.resolvedFrom
      ? `已使用${plan.resolvedFrom === 'selection' ? '选中对象' : plan.resolvedFrom === 'recent' ? '最近操作对象' : '底板对象'}：${plan.resolvedLabel ?? ''}`
      : '';
    return [
      '当前模型不可用，已切换为离线规则路由（只执行只读工具，写操作需要联网确认）。',
      reference,
      `已执行：${describePlan(plan)}`,
      summary ? `结果：${summary}` : ''
    ].filter(Boolean).join('\n');
  }

  async run(userText: string, options: AgentRunOptions = {}): Promise<string> {
    const text = userText.trim();
    if (!text) throw new Error('请输入要发送给智能体的内容');
    const runId = options.runId ?? `chat-${Date.now()}`;
    const completed: CompletedStep[] = [];
    // 先读取上一轮快照，再开始本轮；本轮结束后由 finally 路径统一覆盖。
    this.threadPrevious = this.thread.read();
    this.currentTurnId = (this.threadPrevious?.turnId ?? 0) + 1;
    this.turnText = text;
    this.denials = normalizeDenials(this.threadPrevious?.denials ?? []);
    this.pendingConfirm = undefined;
    this.bypassIntent = detectBypassIntent(text);
    this.deniedWriteTools.clear();
    this.replyMode = 'online';
    this.turnUsage = emptyTokenUsage();
    this.lastRequestUsage = null;
    this.dedupe.clear();
    this.parallelBatches = 0;
    this.maxParallelConcurrency = 0;
    this.cacheHits = 0;
    this.turnContext = emptyAgentContext();
    this.turnContextReady = false;
    if (this.contextProvider) {
      try {
        this.turnContext = await this.contextProvider() ?? emptyAgentContext();
      } catch {
        this.turnContext = emptyAgentContext();
      }
    }
    this.turnContext = augmentContextWithThreadReference(text, this.turnContext, this.threadPrevious);
    this.turnContextReady = true;
    this.push({ role: 'user', content: text });

    try {
      const reply = await this.runLoop(text, options, completed, runId);
      this.commitThreadTurn(text, completed, reply);
      return reply;
    } catch (error) {
      const steps = error instanceof AgentCancelledError ? error.completedSteps : completed;
      this.commitThreadTurn(text, steps, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private commitThreadTurn(text: string, completed: readonly CompletedStep[], reply: string): void {
    this.thread.finish({
      intent: routeIntent(text).intent,
      context: this.turnContext,
      completedSteps: completedToThreadSteps(completed),
      reply,
      source: 'chat',
      denials: this.denials,
      ...(this.pendingConfirm ? { pendingConfirm: this.pendingConfirm } : {})
    });
  }

  private async runLoop(
    text: string,
    options: AgentRunOptions,
    completed: CompletedStep[],
    runId: string
  ): Promise<string> {
    let retryUsed = false;
    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      if (options.signal?.aborted) throw new AgentCancelledError(completed);
      let response;
      try {
        response = await this.callLlm(this.context(), options.signal);
      } catch (error) {
        if (error instanceof AgentAborted || options.signal?.aborted) throw new AgentCancelledError(completed);
        const offline = await this.runOffline(text, { ...options, runId }, completed);
        if (offline) {
          this.replyMode = 'offline';
          const reply = sanitizeConfirmationClaims(offline);
          this.push({ role: 'assistant', content: reply });
          return reply;
        }
        throw error;
      }
      if (response.toolCalls.length === 0) {
        const reply = sanitizeConfirmationClaims(response.content.trim());
        this.push({ role: 'assistant', content: reply });
        return reply;
      }

      const originalCalls = response.toolCalls;
      const checked = this.prepareToolCalls(originalCalls);
      let calls: LlmToolCall[];
      if (!checked.ok) {
        const reason = checked.reason;
        const toolNames = originalCalls.map((call) => call.function.name).join(',');
        this.recordAudit({
          tool: toolNames,
          ok: false,
          code: 'TOOL_CALL_INVALID',
          source: 'llm',
          message: reason,
          reason,
          retries: retryUsed ? 1 : 0
        });
        if (retryUsed) {
          this.recordAudit({
            tool: toolNames,
            ok: false,
            code: 'TOOL_CALL_FALLBACK',
            source: 'llm',
            message: reason,
            reason,
            retries: 1
          });
          return this.respondFallback(text, reason);
        }

        retryUsed = true;
        let retryResponse;
        try {
          retryResponse = await this.callLlm(this.retryContext(reason, originalCalls), options.signal);
        } catch (error) {
          if (error instanceof AgentAborted || options.signal?.aborted) throw new AgentCancelledError(completed);
          const offline = await this.runOffline(text, { ...options, runId }, completed);
          if (offline) {
            this.replyMode = 'offline';
            const reply = sanitizeConfirmationClaims(offline);
            this.push({ role: 'assistant', content: reply });
            return reply;
          }
          throw error;
        }
        if (retryResponse.toolCalls.length === 0) {
          const reply = sanitizeConfirmationClaims(retryResponse.content.trim());
          if (reply) {
            this.recordAudit({
              tool: toolNames,
              ok: true,
              code: 'TOOL_CALL_RETRY_TEXT',
              source: 'llm',
              message: reason,
              reason,
              retries: 1
            });
            this.push({ role: 'assistant', content: reply });
            return reply;
          }
          this.recordAudit({
            tool: toolNames,
            ok: false,
            code: 'TOOL_CALL_FALLBACK',
            source: 'llm',
            message: reason,
            reason,
            retries: 1
          });
          return this.respondFallback(text, reason);
        }

        const retried = this.prepareToolCalls(retryResponse.toolCalls);
        if (!retried.ok) {
          this.recordAudit({
            tool: retryResponse.toolCalls.map((call) => call.function.name).join(','),
            ok: false,
            code: 'TOOL_CALL_FALLBACK',
            source: 'llm',
            message: retried.reason,
            reason: retried.reason,
            retries: 1
          });
          return this.respondFallback(text, retried.reason);
        }
        this.recordAudit({
          tool: retryResponse.toolCalls.map((call) => call.function.name).join(','),
          ok: true,
          code: 'TOOL_CALL_RETRY_OK',
          source: 'llm',
          message: reason,
          reason,
          retries: 1,
          ...(retried.repairs.length > 0 ? { repairs: retried.repairs } : {})
        });
        response = retryResponse;
        calls = retried.calls;
      } else {
        calls = checked.calls;
        if (checked.repairs.length > 0) {
          this.recordAudit({
            tool: calls.map((call) => call.function.name).join(','),
            ok: true,
            code: 'TOOL_CALL_REPAIRED',
            source: 'llm',
            message: checked.repairs.join('; '),
            repairs: checked.repairs,
            retries: 0
          });
        }
      }

      this.push({
        role: 'assistant',
        content: sanitizeConfirmationClaims(response.content.trim()) || null,
        tool_calls: calls.map((call) => ({
          ...call,
          function: { ...call.function }
        }))
      });

      if (options.signal?.aborted) throw new AgentCancelledError(completed);
      const results = await this.executeToolBatch(calls, {
        runId,
        completed,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress ? { onProgress: options.onProgress } : {})
      });
      for (const [index, call] of calls.entries()) {
        this.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: guardToolResult(
            serializeToolResult(results[index], toolResultByteLimit(call.function.name)).text,
            call.function.name
          ).text
        });
      }
      if (options.signal?.aborted) throw new AgentCancelledError(completed);
    }

    const reply = sanitizeConfirmationClaims(`已达到最大工具调用轮数（${this.maxIterations}），请缩小任务范围`);
    this.push({ role: 'assistant', content: reply });
    return reply;
  }
}
