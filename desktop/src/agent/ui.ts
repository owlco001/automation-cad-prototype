import {
  buildEntryButton,
  createDrawer,
  ensurePanelStyles,
  errorMessage,
  escapeHtml
} from '../ui/panels';
import { recordDiagnosticError } from '../shared/diagnostics.ts';
import {
  auditSummaryText,
  buildPlanPreview,
  buildReceipt,
  summarizeTurn,
  type Receipt
} from './preview.ts';
import { suggestFailure } from './suggest.ts';
import {
  aggregateDurationText,
  formatDuration,
  runningDurationText,
  stepLabel,
  stepResultText,
  summarizeArguments,
  type AgentProgressEvent
} from './feedback.ts';
import {
  auditArgsText,
  auditCsv,
  auditEntryJson,
  auditExportFileName,
  auditToolNames,
  filterAuditEntries,
  limitAuditEntries,
  type AuditResultFilter
} from './audit-view.ts';
import {
  describePlanStep,
  plan as buildAgentPlan,
  type AgentPlan,
  type PlanStep,
  type PlanStepResult
} from './planner.ts';
import { collectAgentContext, type AgentContext } from './context.ts';
import {
  suggestNextActions,
  type AdvisorProjectState,
  type AdvisorSuggestion
} from './advisor.ts';
import { READ_ONLY_TOOLS } from './router.ts';
import {
  RECIPES,
  checkRecipePreconditions,
  getRecipe,
  recipeRunToMarkdown,
  resolveRecipeArgs,
  type Recipe,
  type RecipeContext,
  type RecipeRunResult,
  type RecipeStep
} from './recipes.ts';
import { unwrapToolResultData } from './guard.ts';
import { parseFallbackCandidates } from './retry.ts';
import { formatTokenCount } from './budget.ts';
import { isAgentResumeEnabled } from '../modules/agent-resume-gate.ts';
import {
  RENDER_QUALITY_OPTIONS,
  UI_SCALE_OPTIONS,
  applyAppearance
} from '../ui/appearance.ts';

const AGENT_ICON = '<svg viewBox="0 0 16 16"><path d="M8 2.2a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4z"/><path d="M3 13.8c.4-2.5 2.4-4 5-4s4.6 1.5 5 4"/><path d="M2 3.2h1.2M12.8 3.2H14M2 12.8h1.2M12.8 12.8H14"/></svg>';
const CDP_PORT_TEXT = '9222';

interface AgentToolInfo {
  name: string;
  description: string;
}

interface AgentHistoryInfo {
  name: string;
  at: string;
  ok: boolean;
}

interface AgentInfo {
  host?: string;
  port?: number;
  url?: string;
  tokenFile?: string;
  toolCount?: number;
  tools?: AgentToolInfo[];
  history?: AgentHistoryInfo[];
  token?: string;
  lanEnabled?: boolean;
  allowlist?: string[];
  cdpPort?: number | null;
  cdpActive?: boolean;
  cdpRestartRequired?: boolean;
  lanAddress?: string | null;
  error?: string;
}

let drawer: ReturnType<typeof createDrawer> | null = null;
let refreshButton: HTMLButtonElement | null = null;
let body: HTMLElement | null = null;
let infoState: AgentInfo = {};
let llmState: DesktopAgentLlmConfig | null = null;
let appearanceState: DesktopAppearanceConfig | null = null;
let lanState: DesktopAgentLanAccess | null = null;
let messages: DesktopAgentChatMessage[] = [];
let thinking = false;
let apiKeyDirty = false;
let lastReceipt: Receipt | null = null;
let auditState: DesktopAgentAuditResult | null = null;
let auditLoading = false;
let auditFilterTool = '';
let auditFilterResult: AuditResultFilter = 'all';
let progressSteps: LiveProgress[] = [];
let progressTimer = 0;
let progressMetrics = new Map<string, { elapsedMs: number; ok: boolean; code: string; cacheHit: boolean }>();
let cancelRequested = false;
let disposeProgress: (() => void) | null = null;
let activeRunId = '';
let advisorSuggestions: AdvisorSuggestion[] = [];
const ignoredAdvisorIds = new Set<string>();
let advisorRefreshSeq = 0;
let usageState: DesktopAgentUsage | null = null;
import { formatLinkageView } from '../machine/linkage-view.ts';
import { renderLinkagePanelHtml } from './linkage-panel.ts';

const machineDesignCards = new Map<string, { design: Record<string, unknown> }>();
const appliedMachineCards = new Map<string, string>();

interface LiveProgress {
  key: string;
  runId: string;
  index: number;
  total: number;
  tool: string;
  argsSummary: string;
  startedAt: number;
  elapsedMs?: number;
  ok?: boolean;
  code?: string;
  message?: string;
  cacheHit?: boolean;
}

interface MultiPlanState {
  input: string;
  plan: AgentPlan;
  results: PlanStepResult[];
  next: number;
  running: boolean;
  feedback: string;
  tone: 'ok' | 'error' | '';
  dismissed: boolean;
  restoring?: boolean;
  restoredCheckpoint?: boolean;
  restoreBlocked?: boolean;
  requiresReplan?: boolean;
  /** 由建议卡片直接生成，单步也要显示计划确认卡片。 */
  fromSuggestion?: boolean;
}

let multiPlan: MultiPlanState | null = null;
let agentResumeModuleEnabled = false;
let planRestoreGeneration = 0;

interface RecipeUiState {
  selectedId: string;
  skipped: Set<string>;
  running: boolean;
  result: RecipeRunResult | null;
  feedback: string;
  tone: 'ok' | 'error' | '';
  live: Map<number, LiveProgress>;
}

const firstRecipeId = RECIPES[0]?.id ?? '';
let recipeUi: RecipeUiState = {
  selectedId: firstRecipeId,
  skipped: new Set<string>(),
  running: false,
  result: null,
  feedback: '',
  tone: '',
  live: new Map<number, LiveProgress>()
};

function serviceAddress(info: AgentInfo): string {
  if (info.host && info.port) return `${info.host}:${info.port}`;
  if (info.url) return info.url.replace(/^https?:\/\//, '');
  return '—';
}

function appearanceScale(): number {
  return appearanceState?.uiScale ?? 1.15;
}

function appearanceQuality(): 'flow' | 'standard' | 'high' {
  return appearanceState?.renderQuality ?? 'standard';
}

function lanAllowlistText(): string {
  return (lanState?.config.allowlist ?? infoState.allowlist ?? ['192.168.0.0/16']).join('\n');
}

function renderQualityText(): string {
  const diagnostics = window.AutomationCadOrbit?.renderQuality();
  if (!diagnostics) return '渲染质量设置会在 3D 视口就绪后应用。';
  const auto = diagnostics.autoDowngraded
    ? `；零件 ${diagnostics.parts} > 1500，已自动降级（autoDowngraded）`
    : '';
  return `当前 ${diagnostics.quality} · 像素比 ${diagnostics.pixelRatio} · 拖动 ${diagnostics.draggingPixelRatio} · 抗锯齿 ${diagnostics.antialias ? '开' : '关'}${auto}`;
}

function cdpStatusText(): string {
  const config = lanState?.config.cdpEnabled ?? false;
  const active = lanState?.cdpActive ?? infoState.cdpActive ?? false;
  const port = lanState?.cdpPort ?? infoState.cdpPort;
  if (!config && !active) return 'CDP：关闭';
  const lanAddress = lanState?.lanAddress ?? infoState.lanAddress ?? null;
  const address = lanAddress ? `${lanAddress}:${port ?? CDP_PORT_TEXT}` : '未检测到局域网 IP';
  if (active) return `CDP：已转发 0.0.0.0:${port ?? CDP_PORT_TEXT} → 127.0.0.1:9229 · 内网地址：${address}`;
  if (lanState?.cdpError) return `CDP：启动失败（${lanState.cdpError}）`;
  return `CDP：已配置 ${port ?? CDP_PORT_TEXT}，内部 9229 未就绪（请确认应用以普通模式启动）`;
}

function timeText(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString('zh-CN', { hour12: false });
}

function fieldElement(id: string): HTMLInputElement | HTMLTextAreaElement | null {
  return body?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`) ?? null;
}

function setStatus(id: string, text: string, isError = false): void {
  const element = body?.querySelector<HTMLElement>(`#${id}`);
  if (!element) return;
  element.textContent = text;
  element.classList.toggle('is-error', isError);
  element.classList.toggle('is-ok', !isError && Boolean(text));
}

function renderShell(): void {
  if (!body) return;
  const tools = Array.isArray(infoState.tools) ? infoState.tools : [];
  const history = Array.isArray(infoState.history) ? infoState.history.slice(-5).reverse() : [];
  const toolCount = infoState.toolCount ?? tools.length;
  body.innerHTML = `
    <div class="acp-section-title">建议 <b id="agentAdvisorCount">—</b></div>
    <div class="acp-advisor" id="agentAdvisorList" aria-live="polite"></div>
    <div class="acp-section-title">对话 <b id="agentChatCount">0</b></div>
    <div class="acp-chat-log" id="agentChatLog">
      <div class="acp-empty">输入任务后，智能体会按需调用工具。写操作会先弹出确认。</div>
    </div>
    <div class="acp-field">
      <span>消息</span>
      <textarea class="acp-textarea acp-chat-input" id="agentChatInput" rows="3" maxlength="20000" placeholder="例如：搜索 SMC 气缸并插入一个占位件"></textarea>
      <div class="acp-row">
        <button type="button" class="acp-btn acp-btn-primary" id="agentChatSend">发送</button>
        <button type="button" class="acp-btn acp-btn-danger" id="agentChatCancel" hidden>取消执行</button>
        <button type="button" class="acp-btn" id="agentChatClear">清空</button>
        <span class="acp-pill" id="agentChatStatus">就绪</span>
      </div>
      <div class="acp-note acp-chat-feedback" id="agentChatFeedback" hidden></div>
      <div class="acp-progress" id="agentProgress" hidden>
        <div class="acp-progress-head">
          <span>执行进度</span>
          <span class="acp-progress-clock" id="agentProgressClock"></span>
        </div>
        <div class="acp-progress-list" id="agentProgressList"></div>
      </div>
      <div class="acp-plan-preview is-none" id="agentPlanPreview">
        <div class="acp-plan-title" id="agentPlanTitle">等待输入</div>
        <div class="acp-plan-detail" id="agentPlanDetail">预览不会执行任何命令；输入后会显示将要调用的工具。</div>
        <div class="acp-plan-hint" id="agentPlanHint"></div>
      </div>
      <div class="acp-plan-card" id="agentPlanCard" hidden>
        <div class="acp-plan-card-head">
          <span class="acp-plan-card-title" id="agentPlanCardTitle">多步计划</span>
          <span class="acp-pill" id="agentPlanCardMeta"></span>
        </div>
        <div class="acp-plan-list" id="agentPlanList"></div>
        <div class="acp-plan-feedback" id="agentPlanFeedback" hidden></div>
        <div class="acp-plan-actions" id="agentPlanActions">
          <button type="button" class="acp-btn acp-btn-primary" id="agentPlanRunAll">全部执行</button>
          <button type="button" class="acp-btn" id="agentPlanRunStep">逐步执行</button>
          <button type="button" class="acp-btn" id="agentPlanReplan" hidden>丢弃旧进度并以当前计划重新开始</button>
          <button type="button" class="acp-btn" id="agentPlanCancel">取消</button>
        </div>
      </div>
    </div>

    <div class="acp-section-title">流程 <b id="agentRecipeCount">${RECIPES.length} 个模板</b></div>
    <div class="acp-recipe" id="agentRecipePanel" data-recipe-id="${escapeHtml(recipeUi.selectedId)}">
      <div class="acp-row acp-recipe-pick">
        <select class="acp-input" id="agentRecipeSelect" aria-label="选择流程模板">
          ${RECIPES.map((recipe) => `<option value="${escapeHtml(recipe.id)}">${escapeHtml(recipe.title)}</option>`).join('')}
        </select>
        <span class="acp-pill" id="agentRecipeEstimate">≈ —</span>
      </div>
      <div class="acp-note" id="agentRecipeSummary"></div>
      <div class="acp-recipe-preconditions" id="agentRecipePreconditions"></div>
      <div class="acp-recipe-steps" id="agentRecipeSteps"></div>
      <label class="acp-note acp-recipe-remember">
        <input type="checkbox" id="agentRecipeRemember"> 本流程内同类操作不再询问（默认关）
      </label>
      <div class="acp-row">
        <button type="button" class="acp-btn acp-btn-primary" id="agentRecipeStart">开始</button>
        <button type="button" class="acp-btn" id="agentRecipeCancel" hidden>取消流程</button>
        <button type="button" class="acp-btn" id="agentRecipeExport" hidden>导出本次执行记录</button>
      </div>
      <div class="acp-recipe-feedback" id="agentRecipeFeedback" hidden></div>
      <div class="acp-recipe-result" id="agentRecipeResult"></div>
    </div>

    <div class="acp-section-title">模型设置 <b>OpenAI 兼容</b></div>
    <div class="acp-field">
      <span>baseUrl</span>
      <input class="acp-input" id="agentLlmBaseUrl" type="url" autocomplete="off" spellcheck="false">
    </div>
    <div class="acp-field">
      <span>model</span>
      <input class="acp-input" id="agentLlmModel" type="text" autocomplete="off" spellcheck="false">
    </div>
    <div class="acp-field">
      <span>apiKey</span>
      <input class="acp-input" id="agentLlmApiKey" type="password" autocomplete="new-password" spellcheck="false" placeholder="输入新密钥；留空保留原值">
    </div>
    <div class="acp-field">
      <span>最大轮数</span>
      <input class="acp-input" id="agentLlmMaxIterations" type="number" min="1" max="50" step="1">
    </div>
    <div class="acp-row">
      <button type="button" class="acp-btn acp-btn-primary" id="agentLlmSave">保存</button>
      <button type="button" class="acp-btn" id="agentLlmTest">测试连接</button>
      <span class="acp-pill" id="agentLlmStatus"></span>
    </div>

    <div class="acp-section-title">界面与渲染 <b>立即生效</b></div>
    <div class="acp-field">
      <span>界面缩放（默认 115%）</span>
      <select class="acp-input" id="agentUiScale" aria-label="界面缩放">
        ${UI_SCALE_OPTIONS.map((option) => `<option value="${option.value}" ${appearanceScale() === option.value ? 'selected' : ''}>${option.label}</option>`).join('')}
      </select>
      <div class="acp-note">通过注入 CSS 变量缩放原型，不改根样式；切换后自动触发布局与 3D 视口 resize。</div>
    </div>
    <div class="acp-field">
      <span>3D 渲染质量</span>
      <select class="acp-input" id="agentRenderQuality" aria-label="3D 渲染质量">
        ${RENDER_QUALITY_OPTIONS.map((option) => `<option value="${option.value}" ${appearanceQuality() === option.value ? 'selected' : ''}>${option.label}</option>`).join('')}
      </select>
      <div class="acp-note" id="agentRenderQualityInfo">${escapeHtml(renderQualityText())}</div>
    </div>
    <div class="acp-row">
      <span class="acp-pill" id="agentAppearanceStatus"></span>
    </div>

    <div class="acp-section-title">本机服务 <b>${toolCount} 个工具</b></div>
    <div class="acp-field">
      <span>token 文件路径（不显示 token）</span>
      <div class="acp-note">${escapeHtml(infoState.tokenFile || '—')}</div>
    </div>
    <div class="acp-note">服务：${escapeHtml(serviceAddress(infoState))} · HTTP JSON-RPC · ${lanState?.config.enabled || infoState.lanEnabled ? '局域网已启用' : '仅监听本机'}</div>

    <div class="acp-section-title">局域网联调 <b>${lanState?.config.enabled || infoState.lanEnabled ? '已启用' : '默认关闭'}</b></div>
    <div class="acp-warning">
      <b>安全警告</b>：启用局域网访问会让白名单内的设备获得与 token 等价的 Agent 能力。写工具仍会在本机弹窗确认，远程不能静默写入。不要把 7420 端口暴露到公网。
    </div>
    <label class="acp-switch acp-switch-block">
      <input type="checkbox" id="agentLanEnabled" ${lanState?.config.enabled || infoState.lanEnabled ? 'checked' : ''}>
      允许局域网访问 Agent（默认关闭）
    </label>
    <div class="acp-field">
      <span>来源白名单（逗号或换行分隔 CIDR / 单 IP；回环永远放行）</span>
      <textarea class="acp-textarea" id="agentLanAllowlist" rows="3" spellcheck="false" placeholder="192.168.0.0/16">${escapeHtml(lanAllowlistText())}</textarea>
    </div>
    <div class="acp-field">
      <span>当前监听地址</span>
      <div class="acp-note" id="agentLanListen">${escapeHtml(serviceAddress(infoState))} · ${lanState?.config.enabled || infoState.lanEnabled ? '0.0.0.0（局域网可达）' : '127.0.0.1（仅本机）'}</div>
    </div>
    <div class="acp-field">
      <span>完整 token（默认隐藏；仅本机受信页面可读）</span>
      <code class="acp-token" id="agentLanToken" hidden>${escapeHtml(lanState?.token ?? infoState.token ?? '—')}</code>
      <div class="acp-row">
        <button type="button" class="acp-btn" id="agentLanTokenToggle">显示 token</button>
        <button type="button" class="acp-btn" id="agentLanTokenCopy">复制 token</button>
        <button type="button" class="acp-btn" id="agentLanTokenRotate">重新生成 token</button>
        <span class="acp-note">token 文件：${escapeHtml(infoState.tokenFile || '—')}</span>
      </div>
    </div>
    <div class="acp-field">
      <span>示例探测命令（把 &lt;局域网IP&gt; 换成当前机器地址）</span>
      <pre class="acp-command" id="agentLanCommand">node desktop/scripts/lan-debug-probe.mjs --url http://&lt;局域网IP&gt;:${escapeHtml(String(infoState.port ?? 7420))} --token-file ${escapeHtml(infoState.tokenFile || '<userData>/agent-token')}</pre>
    </div>
    <label class="acp-switch acp-switch-block">
      <input type="checkbox" id="agentCdpEnabled" ${lanState?.config.cdpEnabled ? 'checked' : ''}>
      允许远程调试 CDP（来源走白名单）
    </label>
    <div class="acp-warning is-critical">
      <b>CDP 高风险</b>：启用后由本机转发器把 <code>0.0.0.0:${CDP_PORT_TEXT}</code> 转发到回环 <code>127.0.0.1:9229</code>，来源必须命中白名单。任何能访问该端口的白名单设备都可接管渲染进程，仅在受信局域网临时开启。
    </div>
    <div class="acp-note" id="agentCdpStatus">${escapeHtml(cdpStatusText())}</div>
    <div class="acp-note" id="agentCdpAddress">内网地址：${escapeHtml(lanState?.lanAddress ?? infoState.lanAddress ?? '未检测到局域网 IP')}:${CDP_PORT_TEXT}</div>
    <div class="acp-row">
      <button type="button" class="acp-btn acp-btn-primary" id="agentLanSave">保存并重启 Agent</button>
      <span class="acp-pill" id="agentLanStatus"></span>
    </div>

    <div class="acp-section-title">工具列表 <b>${toolCount}</b></div>
    ${tools.length === 0 ? '<div class="acp-empty">尚无工具注册</div>' : tools.map((tool) => `
      <div class="acp-pack-row">
        <div class="acp-pack-main">
          <div>
            <div class="acp-pack-name">${escapeHtml(tool.name)}</div>
            <div class="acp-pack-meta">${escapeHtml(tool.description)}</div>
          </div>
          <span class="acp-pill is-ok">可用</span>
        </div>
      </div>`).join('')}

    <div class="acp-section-title">最近命令 <b>${history.length}/5</b></div>
    ${history.length === 0 ? '<div class="acp-empty">尚无命令历史。工具调用后会在此显示名称、时间与结果。</div>' : history.map((entry) => `
      <div class="acp-pack-row">
        <div class="acp-pack-main">
          <div>
            <div class="acp-pack-name">${escapeHtml(entry.name)}</div>
            <div class="acp-pack-meta">${escapeHtml(timeText(entry.at))}</div>
          </div>
          <span class="acp-pill ${entry.ok ? 'is-ok' : 'is-error'}">${entry.ok ? '成功' : '失败'}</span>
        </div>
      </div>`).join('')}

    <div class="acp-section-title">审计 <b id="agentAuditCount">—</b></div>
    <div class="acp-audit-controls">
      <select class="acp-input acp-audit-select" id="agentAuditToolFilter" aria-label="按工具筛选">
        <option value="">全部工具</option>
      </select>
      <select class="acp-input acp-audit-select" id="agentAuditResultFilter" aria-label="按结果筛选">
        <option value="all">全部结果</option>
        <option value="ok">仅成功</option>
        <option value="fail">仅失败</option>
      </select>
      <button type="button" class="acp-btn" id="agentAuditExport">导出 CSV</button>
    </div>
    <div class="acp-audit-list" id="agentAuditList"><div class="acp-empty">正在读取审计…</div></div>
    <div class="acp-row">
      <button type="button" class="acp-btn" id="agentAuditRefresh">刷新审计</button>
      <span class="acp-note" id="agentAuditSummary"></span>
    </div>
    <div class="acp-note" id="agentAuditHint">审计只记录工具名、结果、耗时与脱敏后的参数；最多显示最近 200 条。</div>

    <div class="acp-section-title">上下文成本 <b id="agentUsageModel">—</b></div>
    <div class="acp-usage" id="agentUsage">
      <div class="acp-usage-row">
        <span>本轮</span>
        <b id="agentTurnTokens">—</b>
        <span class="acp-usage-cost" id="agentTurnCost">—</span>
      </div>
      <div class="acp-usage-meta" id="agentTurnUsageMeta">输入 — · 输出 —</div>
      <div class="acp-usage-row">
        <span>本会话</span>
        <b id="agentSessionTokens">—</b>
        <span class="acp-usage-cost" id="agentSessionCost">—</span>
      </div>
      <div class="acp-usage-meta" id="agentSessionUsageMeta">输入 — · 输出 —</div>
      <div class="acp-note" id="agentUsageNote">端点回传 usage 时为真实值；缺失时标注「估算」。未知模型费用显示 —。</div>
    </div>
  `;

  bindControls();
  fillConfig();
  renderMessages();
  renderPreview();
  renderRecipe();
  renderAudit();
  renderAdvisor();
  renderUsage();
  updateBusyState();
}

function fillConfig(): void {
  if (!llmState) return;
  const baseUrl = fieldElement('agentLlmBaseUrl');
  const model = fieldElement('agentLlmModel');
  const apiKey = fieldElement('agentLlmApiKey');
  const maxIterations = fieldElement('agentLlmMaxIterations');
  if (baseUrl) baseUrl.value = llmState.baseUrl;
  if (model) model.value = llmState.model;
  if (apiKey) apiKey.value = llmState.apiKey;
  if (maxIterations) maxIterations.value = String(llmState.maxIterations);
  apiKeyDirty = false;
}

function toolResultMap(): Map<string, DesktopAgentChatMessage> {
  const map = new Map<string, DesktopAgentChatMessage>();
  for (const message of messages) {
    if (message.role === 'tool' && message.tool_call_id) map.set(message.tool_call_id, message);
  }
  return map;
}

function summaryText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function argumentsSummary(raw: string): string {
  if (!raw.trim()) return '无参数';
  try {
    const parsed = JSON.parse(raw) as unknown;
    return summarizeArguments(parsed);
  } catch {
    return summarizeArguments(raw);
  }
}

interface ToolOutcome {
  ok: boolean;
  code: string;
  message: string;
  detail: string;
}

function parseToolOutcome(content: string | null | undefined): ToolOutcome {
  const wrapper = content ?? '';
  const raw = unwrapToolResultData(wrapper) ?? wrapper;
  let untrusted = false;
  try {
    const envelope = JSON.parse(wrapper) as unknown;
    untrusted =
      typeof envelope === 'object' && envelope !== null &&
      (envelope as Record<string, unknown>).kind === 'tool_result_data' &&
      (envelope as Record<string, unknown>).untrusted === true;
  } catch (error) {
    // 不是数据块时按普通结果处理。
    console.debug(`[AGENT_UI_BLOCK_PARSE_FALLBACK]`, { site: 'desktop/src/agent/ui.ts:414' }, error);
  }
  const prefix = untrusted ? '[不可信数据] ' : '';
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const ok = record.ok !== false;
      const error = typeof record.error === 'object' && record.error !== null
        ? record.error as Record<string, unknown>
        : null;
      const code = typeof record.code === 'string'
        ? record.code
        : error && typeof error.code === 'string'
          ? error.code
          : ok ? 'OK' : 'FAILED';
      const message = typeof record.message === 'string'
        ? record.message
        : error && typeof error.message === 'string'
          ? error.message
          : '';
      return { ok, code, message, detail: `${prefix}${summaryText(raw, 260)}` };
    }
  } catch (error) {
    // 非 JSON 结果按成功展示原文，不臆断错误码。
    console.debug(`[AGENT_UI_RESULT_JSON_FALLBACK]`, { site: 'desktop/src/agent/ui.ts:438' }, error);
  }
  return { ok: true, code: 'OK', message: '', detail: `${prefix}${summaryText(raw, 260)}` };
}

function failureSuggestionHtml(input: {
  tool: string;
  args: Record<string, unknown>;
  code: string;
  message?: string;
}): string {
  const suggestion = suggestFailure(input);
  return `<div class="acp-tool-advice">
        <div class="acp-tool-advice-title">建议：${escapeHtml(suggestion.advice)}</div>
        <ul>${suggestion.alternatives.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
      </div>`;
}

function parseMachineCard(result: DesktopAgentChatMessage | undefined): {
  design: Record<string, unknown>;
  config: Record<string, unknown>;
  warnings: string[];
  cycle: Record<string, unknown> | null;
  power: Record<string, unknown> | null;
  cost: Record<string, unknown> | null;
} | null {
  if (!result) return null;
  const raw = unwrapToolResultData(result.content) ?? result.content ?? '';
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.ok === false) return null;
    const design = record.design;
    if (typeof design !== 'object' || design === null || Array.isArray(design)) return null;
    const designRecord = design as Record<string, unknown>;
    const config = designRecord.config;
    if (typeof config !== 'object' || config === null || Array.isArray(config)) return null;
    return {
      design: designRecord,
      config: config as Record<string, unknown>,
      warnings: Array.isArray(designRecord.warnings)
        ? designRecord.warnings.filter((value): value is string => typeof value === 'string')
        : [],
      cycle: typeof designRecord.cycle === 'object' && designRecord.cycle !== null && !Array.isArray(designRecord.cycle)
        ? designRecord.cycle as Record<string, unknown>
        : null,
      power: typeof designRecord.power === 'object' && designRecord.power !== null && !Array.isArray(designRecord.power)
        ? designRecord.power as Record<string, unknown>
        : null,
      cost: typeof designRecord.cost === 'object' && designRecord.cost !== null && !Array.isArray(designRecord.cost)
        ? designRecord.cost as Record<string, unknown>
        : null
    };
  } catch (error) {
    recordDiagnosticError('MACHINE_CARD_PARSE_FAILED', error, {
      site: 'desktop/src/agent/ui.ts',
      contentChars: raw.length
    });
    return null;
  }
}

function renderMachineCard(call: DesktopAgentToolCall, result: DesktopAgentChatMessage | undefined): string {
  if (call.function.name !== 'design_machine') return '';
  const card = parseMachineCard(result);
  if (!card) return '';
  machineDesignCards.set(call.id, { design: card.design });
  const appliedName = appliedMachineCards.get(call.id);
  const stations = Array.isArray(card.config.stations) ? card.config.stations.length : 0;
  const actuators = Array.isArray(card.config.actuators) ? card.config.actuators.length : 0;
  const sensors = Array.isArray(card.config.sensors) ? card.config.sensors.length : 0;
  const name = typeof card.config.name === 'string' ? card.config.name : '机型方案';
  const perMin = typeof card.cycle?.perMin === 'number' ? card.cycle.perMin : null;
  const seconds = typeof card.cycle?.estimatedSecondsPerPiece === 'number'
    ? card.cycle.estimatedSecondsPerPiece
    : typeof card.cycle?.secondsPerPiece === 'number'
      ? card.cycle.secondsPerPiece
      : null;
  const throughput = typeof card.cycle?.throughputPerMin === 'number' ? card.cycle.throughputPerMin : null;
  const mode = card.cycle?.mode === 'parallel'
    ? '同工序并行'
    : card.cycle?.mode === 'linear' || card.cycle?.mode === 'line'
      ? '流水线分工序'
      : card.cycle?.mode === 'dial'
        ? '转盘分度'
        : card.cycle?.mode === 'cell'
          ? '单元式'
          : card.cycle?.mode === 'single'
            ? '单工位'
            : null;
  const targetSeconds = typeof card.cycle?.secondsPerPiece === 'number' ? card.cycle.secondsPerPiece : null;
  const estimate = throughput ?? seconds;
  const estimateUnit = throughput === null ? '估算秒/件' : '估算件/分钟';
  const estimateTitle = [
    mode,
    targetSeconds === null ? null : `目标 ${targetSeconds.toFixed(2)} 秒/件`
  ].filter(Boolean).join('；');
  const kw = typeof card.power?.totalKw === 'number'
    ? card.power.totalKw
    : typeof card.power?.va === 'number'
      ? card.power.va / 1000
      : null;
  const currentA = typeof card.power?.currentA === 'number' ? card.power.currentA : null;
  const breaker = typeof card.power?.breakerSuggestion === 'object' && card.power.breakerSuggestion !== null
    && !Array.isArray(card.power.breakerSuggestion)
    ? card.power.breakerSuggestion as Record<string, unknown>
    : null;
  const breakerRating = typeof breaker?.rating === 'number' ? breaker.rating : null;
  const breakerPoles = typeof breaker?.poles === 'number' ? breaker.poles : null;
  const dc24 = typeof card.power?.dc24 === 'object' && card.power.dc24 !== null && !Array.isArray(card.power.dc24)
    ? card.power.dc24 as Record<string, unknown>
    : null;
  const dc24Margin = typeof dc24?.marginPct === 'number' ? dc24.marginPct : null;
  const cost = card.cost;
  const powerWarnings = Array.isArray(card.power?.warnings)
    ? card.power.warnings.filter((value): value is string => typeof value === 'string')
    : [];
  const costWarnings = Array.isArray(card.cost?.warnings)
    ? card.cost.warnings.filter((value): value is string => typeof value === 'string')
    : [];
  const money = (value: unknown): string | null => typeof value === 'number' && Number.isFinite(value)
    ? `¥${Math.round(value).toLocaleString('zh-CN')}`
    : null;
  const material = money(cost?.material);
  const electrical = money(cost?.electrical);
  const labor = money(cost?.labor);
  const total = money(cost?.total);
  const missingCount = typeof cost?.missingCount === 'number' ? cost.missingCount : null;
  const rawPriceMeta = typeof cost?.priceMeta === 'object' && cost.priceMeta !== null
    && !Array.isArray(cost.priceMeta)
    ? cost.priceMeta as Record<string, unknown>
    : null;
  const pricedCount = typeof rawPriceMeta?.pricedCount === 'number' ? rawPriceMeta.pricedCount : null;
  const totalCount = typeof rawPriceMeta?.totalCount === 'number' ? rawPriceMeta.totalCount : null;
  const coveragePct = typeof rawPriceMeta?.coveragePct === 'number' ? rawPriceMeta.coveragePct : null;
  const staleCount = Array.isArray(rawPriceMeta?.stale) ? rawPriceMeta.stale.length : 0;
  const unknownSourceCount = Array.isArray(rawPriceMeta?.unknownSource)
    ? rawPriceMeta.unknownSource.length
    : 0;
  const coverage = coveragePct === null
    ? '—'
    : Number.isInteger(coveragePct)
      ? String(coveragePct)
      : coveragePct.toFixed(1);
  const priceMetaText = pricedCount !== null && totalCount !== null && coveragePct !== null
    ? `已计价 ${pricedCount}/${totalCount} 行（覆盖率 ${coverage}%）、缺价 ${missingCount ?? 0} 项、过期 ${staleCount} 项` +
      `${unknownSourceCount > 0 ? `、来源不明 ${unknownSourceCount} 项` : ''}`
    : null;
  const costLine = total
    ? `<div class="acp-machine-cost"><span>成本粗估（非报价）</span>` +
      `<span>材料 ${escapeHtml(material ?? '—')}</span>` +
      `<span>电气 ${escapeHtml(electrical ?? '—')}</span>` +
      `<span>人工 ${escapeHtml(labor ?? '—')}</span>` +
      `<span>合计 <b>${escapeHtml(total)}</b></span>` +
      `${priceMetaText ? `<span class="acp-machine-cost-meta">${escapeHtml(priceMetaText)}</span>` : ''}` +
      `${missingCount !== null && missingCount > 0
        ? `<span class="acp-machine-cost-missing">${missingCount} 项缺价，合计为不完全统计</span>`
        : ''}</div>`
    : '';
  const form = typeof card.design.form === 'object' && card.design.form !== null && !Array.isArray(card.design.form)
    ? card.design.form as Record<string, unknown>
    : null;
  const formName = typeof form?.name === 'string' ? form.name : null;
  const formId = typeof form?.id === 'string' ? form.id : null;
  const formRationale = typeof form?.rationale === 'string' ? form.rationale : null;
  const formAlternatives = Array.isArray(form?.alternatives)
    ? form.alternatives.filter((entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry))
    : [];
  const formBlock = formName
    ? `<div class="acp-machine-form">
        <div class="acp-machine-form-name">形态：${escapeHtml(formName)}${formId ? ` · ${escapeHtml(formId)}` : ''}</div>
        ${formRationale ? `<div class="acp-machine-form-why">${escapeHtml(formRationale)}</div>` : ''}
        ${formAlternatives.length > 0 ? `<div class="acp-machine-form-alts">备选：${formAlternatives.map((entry) =>
          `${escapeHtml(String(entry.name ?? entry.id ?? ''))}（${escapeHtml(String(entry.difference ?? ''))}）`
        ).join('；')}</div>` : ''}
      </div>`
    : '';
  const warningTexts = [
    ...card.warnings,
    ...powerWarnings.map((warning) => `功率：${warning}`),
    ...costWarnings.map((warning) => `成本：${warning}`)
  ].filter((warning, index, all) => all.indexOf(warning) === index);
  const warnings = warningTexts.length > 0
    ? warningTexts.map((warning) => `<div class="acp-machine-warning">⚠ ${escapeHtml(warning)}</div>`).join('')
    : '<div class="acp-machine-warning is-ok">无已知警告；选型、强度与安全仍需人工确认。</div>';
  return `<div class="acp-machine-card" data-machine-card="${escapeHtml(call.id)}">
      <div class="acp-machine-card-head">
        <span class="acp-machine-title">机型方案卡 · ${escapeHtml(name)}</span>
        <span class="acp-pill ${appliedName ? 'is-ok' : 'is-warn'}">${appliedName ? `已应用：${escapeHtml(appliedName)}` : '未应用'}</span>
      </div>
      <div class="acp-machine-stats">
        <span><b>${stations}</b> 工位</span>
        <span><b>${actuators}</b> 执行机构</span>
        <span><b>${sensors}</b> 传感器</span>
        <span><b>${perMin === null ? '—' : perMin}</b> 件/分钟</span>
        <span title="${escapeHtml(estimateTitle)}"><b>${estimate === null ? '—' : estimate.toFixed(2)}</b> ${estimateUnit}</span>
        <span><b>${kw === null ? '—' : kw.toFixed(2)}</b> kW</span>
        <span><b>${currentA === null ? '—' : currentA.toFixed(1)}</b> A</span>
        <span><b>${breakerRating === null ? '—' : `${breakerRating}A/${breakerPoles ?? 1}P`}</b> 断路器建议</span>
        <span><b>${dc24Margin === null ? '—' : `${dc24Margin.toFixed(0)}%`}</b> 24V 余量</span>
      </div>
      ${costLine}
      ${formBlock}
      <div class="acp-machine-warnings">${warnings}</div>
      <div class="acp-machine-actions">
        <button type="button" class="acp-btn acp-btn-primary" data-apply-machine="${escapeHtml(call.id)}" ${appliedName ? 'disabled' : ''}>
          ${appliedName ? '已应用到工程' : '应用到工程'}
        </button>
        <span class="acp-machine-hint">确认后写入 machine/&lt;id&gt;.json，并刷新 3D / BOM</span>
        <button type="button" class="acp-btn" data-linkage-machine="${escapeHtml(call.id)}">联动调试…</button>
      </div>
      <div class="acp-linkage-slot" data-linkage-slot="${escapeHtml(call.id)}"></div>
    </div>`;
}

/**
 * 联动调试：结论/步序全由主进程跑 CLI 得到，前端只做时间轴推进。
 * 没有帧就不给「播放」假象——按钮禁用并说明原因。
 */
async function openMachineLinkage(callId: string): Promise<void> {
  const card = machineDesignCards.get(callId);
  const slot = body?.querySelector<HTMLElement>(`[data-linkage-slot="${CSS.escape(callId)}"]`);
  const machine = (window as any).machine;
  if (!card || !slot || !machine) return;
  const brief = typeof (card.design as any).brief === 'string' && (card.design as any).brief.trim()
    ? String((card.design as any).brief)
    : String((card.design as any).name ?? '整机方案');
  slot.innerHTML = '<div class="acp-linkage-loading">正在生成联动时间线…</div>';
  try {
    const linkage = await machine.linkage(brief);
    const frames: any[] = Array.isArray(linkage?.frames) ? linkage.frames : [];
    const view = formatLinkageView(linkage);
    const reason = frames.length === 0
      ? (linkage?.cycleMs ? '主进程没有返回帧（需 --linkage-frames）' : '方案缺循环时间，无法生成帧')
      : undefined;
    slot.innerHTML = renderLinkagePanelHtml(view, { canPlay: frames.length > 0, disabledReason: reason });
    const play = slot.querySelector<HTMLButtonElement>('[data-linkage-play]');
    const clock = slot.querySelector<HTMLElement>('[data-linkage-clock]');
    if (!play || !clock || frames.length === 0) return;
    play.addEventListener('click', () => {
      play.disabled = true;
      const started = performance.now();
      const total = Number(linkage?.cycleMs ?? 0);
      const tick = (now: number) => {
        const tMs = total > 0 ? Math.min(total, now - started) : 0;
        clock.textContent = `${Math.round(tMs)} / ${total} ms`;
        const frame = frames.filter((f) => Number(f?.tMs ?? 0) <= tMs).pop() ?? frames[0];
        slot.querySelectorAll<HTMLElement>('[data-linkage-step]').forEach((row) => {
          row.classList.toggle('is-active', Number(row.dataset.linkageStep) === Number(frame?.stepNo));
        });
        // 3D 视口挂上了就套位姿；没挂上就只走时间轴，不假装动过
        const apply = (window as any).__cadApplyLinkagePose;
        // CLI 的帧把 offsets/rotZDeg 放在顶层（不是 frame.pose）；两种形状都认，别静默不动
        const pose = (frame as any)?.pose ?? { offsets: (frame as any)?.offsets, rotZDeg: (frame as any)?.rotZDeg };
        if (typeof apply === 'function' && pose) apply(pose);
        if (tMs < total) requestAnimationFrame(tick);
        else play.disabled = false;
      };
      requestAnimationFrame(tick);
    });
  } catch (error) {
    slot.innerHTML = `<div class="acp-linkage-error">联动不可用：${escapeHtml((error as Error).message)}`
      + '<button type="button" class="acp-btn" data-linkage-machine="' + escapeHtml(callId) + '">重试</button></div>';
  }
}

async function applyMachineDesignCard(callId: string): Promise<void> {
  const card = machineDesignCards.get(callId);
  if (!card || !window.desktop) return;
  if (thinking || multiPlan?.running || recipeUi.running) {
    chatFeedback('当前有任务正在执行，完成后再应用方案。', true);
    return;
  }
  const button = body?.querySelector<HTMLButtonElement>(`[data-apply-machine="${CSS.escape(callId)}"]`);
  if (button) button.disabled = true;
  try {
    const result = await window.desktop.agent.plan.execute({
      plan: {
        steps: [{
          tool: 'apply_machine_design',
          args: { design: card.design, withBom: true, withPlc: true },
          why: '把机型方案写入当前工程并刷新 3D/BOM/IO',
          readOnly: false
        }],
        confidence: 1
      }
    });
    if (!result.confirmed) {
      chatFeedback(result.confirmOutcome === 'timeout' ? '确认超时，未写入工程。' : '已取消，未写入工程。');
      if (button) button.disabled = false;
      return;
    }
    const step = result.results[0];
    if (!result.ok || !step?.ok) {
      chatFeedback(step?.message ?? result.summary ?? '应用失败，未写入工程。', true);
      if (button) button.disabled = false;
      return;
    }
    const data = step.data && typeof step.data === 'object' ? step.data as Record<string, unknown> : {};
    const name = typeof data.name === 'string' && data.name
      ? data.name
      : typeof (card.design.config as Record<string, unknown> | undefined)?.name === 'string'
        ? String((card.design.config as Record<string, unknown>).name)
        : '机型方案';
    appliedMachineCards.set(callId, name);
    renderMessages();
    chatFeedback(`已应用：${name}`);
    void refreshAdvisor();
  } catch (error) {
    chatFeedback(`应用失败：${errorMessage(error)}`, true);
    if (button) button.disabled = false;
  }
}

function renderToolCard(call: DesktopAgentToolCall, result: DesktopAgentChatMessage | undefined): string {
  let status = '待执行';
  let tone = 'is-warn';
  let detail = '';
  let meta = `参数：${argumentsSummary(call.function.arguments)}`;
  let advice = '';
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(call.function.arguments || '{}') as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } catch {
    args = {};
  }
  if (result) {
    const outcome = parseToolOutcome(result.content);
    const metrics = progressMetrics.get(call.id);
    status = outcome.ok ? '成功' : '失败';
    tone = outcome.ok ? 'is-ok' : 'is-error';
    detail = outcome.detail;
    meta = `参数：${argumentsSummary(call.function.arguments)} · 耗时 ${formatDuration(metrics?.elapsedMs)} · 结果码 ${outcome.code}${metrics?.cacheHit ? ' · 已复用' : ''}`;
    if (!outcome.ok) {
      advice = failureSuggestionHtml({
        tool: call.function.name,
        args,
        code: outcome.code,
        ...(outcome.message ? { message: outcome.message } : {})
      });
    }
  }
  return `
    <div class="acp-chat-tool ${tone}" data-tool-call-id="${escapeHtml(call.id)}">
      <div class="acp-chat-tool-head">
        <span class="acp-pack-name">${result ? (tone === 'is-ok' ? '✓ ' : '× ') : ''}${escapeHtml(call.function.name)}</span>
        <span class="acp-pill ${tone}">${status}</span>
      </div>
      <div class="acp-pack-meta">${escapeHtml(meta)}</div>
      ${detail ? `<div class="acp-pack-meta">结果：${escapeHtml(detail)}</div>` : ''}
      ${advice}
    </div>${renderMachineCard(call, result)}`;
}

function progressKey(event: DesktopAgentProgressEvent): string {
  return `${event.runId}:${event.callId ?? event.index}`;
}

function stopProgressTicker(): void {
  if (!progressTimer) return;
  window.clearInterval(progressTimer);
  progressTimer = 0;
}

function startProgressTicker(): void {
  if (progressTimer) return;
  progressTimer = window.setInterval(() => {
    if (!progressSteps.some((step) => step.elapsedMs === undefined)) {
      stopProgressTicker();
      return;
    }
    renderProgress();
  }, 500);
}

function applyProgress(event: DesktopAgentProgressEvent): void {
  if (!event || typeof event.runId !== 'string' || typeof event.tool !== 'string') return;
  if (activeRunId && activeRunId !== event.runId) return;
  activeRunId = event.runId;
  const key = progressKey(event);
  const existing = progressSteps.find((step) => step.key === key);
  const next: LiveProgress = {
    key,
    runId: event.runId,
    index: event.index,
    total: event.total,
    tool: event.tool,
    argsSummary: event.argsSummary || '无参数',
    startedAt: event.startedAt,
    ...(event.elapsedMs !== undefined ? { elapsedMs: event.elapsedMs } : {}),
    ...(event.ok !== undefined ? { ok: event.ok } : {}),
    ...(event.code ? { code: event.code } : {}),
    ...(event.message ? { message: event.message } : {}),
    ...(event.cacheHit === true ? { cacheHit: true } : {})
  };
  if (existing) Object.assign(existing, next);
  else progressSteps.push(next);
  if (event.phase === 'end' && event.callId) {
    progressMetrics.set(event.callId, {
      elapsedMs: event.elapsedMs ?? 0,
      ok: event.ok === true,
      code: event.code ?? (event.ok ? 'OK' : 'FAILED'),
      cacheHit: event.cacheHit === true
    });
  }
  if (event.source === 'recipe') {
    recipeUi.live.set(event.index, next);
    renderRecipe();
  }
  renderProgress();
  if (event.phase === 'end') void refreshAdvisor();
  if (progressSteps.some((step) => step.elapsedMs === undefined)) startProgressTicker();
}

function renderProgress(): void {
  const box = body?.querySelector<HTMLElement>('#agentProgress');
  const list = body?.querySelector<HTMLElement>('#agentProgressList');
  const clock = body?.querySelector<HTMLElement>('#agentProgressClock');
  if (!box || !list) return;
  box.hidden = progressSteps.length === 0;
  if (progressSteps.length === 0) {
    list.innerHTML = '';
    if (clock) clock.textContent = '';
    return;
  }
  const running = progressSteps.find((step) => step.elapsedMs === undefined);
  if (clock) {
    clock.textContent = running ? runningDurationText(running.startedAt) : '';
    clock.classList.toggle('is-long', Boolean(running && Date.now() - running.startedAt >= 10_000));
  }
  const completed: number[] = [];
  const cards: string[] = [];
  for (const step of progressSteps) {
    if (step.elapsedMs === undefined) {
      cards.push(`<div class="acp-progress-step is-running" data-tool="${escapeHtml(step.tool)}">
        <div class="acp-progress-step-head">
          <span class="acp-progress-icon">…</span>
          <span class="acp-progress-title">${escapeHtml(stepLabel(step.index, step.total, step.tool))}</span>
          <span class="acp-progress-time">${escapeHtml(runningDurationText(step.startedAt))}</span>
        </div>
        <div class="acp-progress-args">参数：${escapeHtml(step.argsSummary)}</div>
      </div>`);
      continue;
    }
    const ok = step.ok === true;
    const cancelled = step.code === 'CANCELLED';
    completed.push(step.elapsedMs);
    cards.push(`<div class="acp-progress-step ${cancelled ? 'is-warn' : ok ? 'is-ok' : 'is-error'}" data-tool="${escapeHtml(step.tool)}" data-code="${escapeHtml(step.code ?? '')}">
      <div class="acp-progress-step-head">
        <span class="acp-progress-icon">${cancelled ? '!' : ok ? '✓' : '×'}</span>
        <span class="acp-progress-title">${escapeHtml(cancelled
          ? `${step.tool} · 已取消 · 耗时 ${formatDuration(step.elapsedMs)}`
          : `${stepResultText({ tool: step.tool, ok, elapsedMs: step.elapsedMs, ...(step.code ? { code: step.code } : {}) })}${step.cacheHit ? ' · 已复用' : ''}`)}</span>
      </div>
      <div class="acp-progress-args">参数：${escapeHtml(step.argsSummary)}</div>
      ${step.message ? `<div class="acp-progress-message">${escapeHtml(step.message)}</div>` : ''}
    </div>`);
    if (completed.length > 0 && completed.length % 3 === 0) {
      const aggregate = aggregateDurationText(completed);
      if (aggregate) cards.push(`<div class="acp-progress-aggregate">${escapeHtml(aggregate)}</div>`);
    }
  }
  list.innerHTML = cards.join('');
}

function resetProgress(): void {
  stopProgressTicker();
  progressSteps = [];
  progressMetrics = new Map();
  activeRunId = '';
  renderProgress();
}

async function cancelExecution(): Promise<void> {
  if (!window.desktop || cancelRequested) return;
  const planRunning = multiPlan?.running === true;
  if (!thinking && !planRunning) return;
  cancelRequested = true;
  chatFeedback('正在取消当前工具…');
  updateBusyState();
  try {
    if (planRunning) await window.desktop.agent.plan.cancel();
    else await window.desktop.agent.chat.cancel();
  } catch (error) {
    chatFeedback(`取消失败：${errorMessage(error)}`, true);
    cancelRequested = false;
    updateBusyState();
  }
}

function renderAssistantBubble(content: string): string {
  const candidates = parseFallbackCandidates(content);
  const visible = candidates.length > 0
    ? content.split(/\r?\n/).filter((line) => !/^候选\s*[12]\s*[：:]/.test(line)).join('\n').trim()
    : content;
  const buttons = candidates.length > 0
    ? `<div class="acp-chat-candidates">${candidates.map((command, index) => `<button type="button" class="acp-chat-candidate" data-candidate="${escapeHtml(command)}">${index + 1}. ${escapeHtml(command)}</button>`).join('')}</div>`
    : '';
  return `<div class="acp-chat-bubble">${escapeHtml(visible)}${buttons}</div>`;
}

function renderMessages(): void {
  const log = body?.querySelector<HTMLElement>('#agentChatLog');
  const count = body?.querySelector<HTMLElement>('#agentChatCount');
  if (!log) return;
  if (messages.length === 0) {
    log.innerHTML = '<div class="acp-empty">输入任务后，智能体会按需调用工具。写操作会先弹出确认。</div>';
    if (count) count.textContent = '0';
    return;
  }

  const results = toolResultMap();
  const rendered = new Set<string>();
  const blocks: string[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      blocks.push(`<div class="acp-chat-msg is-user"><div class="acp-chat-role">你</div><div class="acp-chat-bubble">${escapeHtml(message.content ?? '')}</div></div>`);
      continue;
    }
    if (message.role === 'assistant') {
      if (message.content) {
        blocks.push(`<div class="acp-chat-msg is-assistant"><div class="acp-chat-role">助手</div>${renderAssistantBubble(message.content)}</div>`);
      }
      for (const call of message.tool_calls ?? []) {
        rendered.add(call.id);
        blocks.push(renderToolCard(call, results.get(call.id)));
      }
      continue;
    }
    if (message.role === 'tool' && message.tool_call_id && !rendered.has(message.tool_call_id)) {
      const id = message.tool_call_id;
      const name = message.name ?? 'tool';
      blocks.push(renderToolCard({ id, type: 'function', function: { name, arguments: '{}' } }, message));
    }
  }
  if (lastReceipt) {
    blocks.push(`<div class="acp-chat-receipt ${lastReceipt.tone}">
      <div class="acp-chat-receipt-head">${escapeHtml(lastReceipt.text)}</div>
      <div class="acp-pack-meta">${escapeHtml(lastReceipt.note)}</div>
    </div>`);
  }
  log.innerHTML = blocks.join('');
  log.scrollTop = log.scrollHeight;
  if (count) count.textContent = String(messages.length);
}

/** 计划预览：只读 / 写操作 / 无法识别 三种底色，绝不触发执行。 */
function renderPreview(): void {
  const box = body?.querySelector<HTMLElement>('#agentPlanPreview');
  if (!box) return;
  const text = fieldElement('agentChatInput')?.value ?? '';
  const context = currentAgentContext();
  const preview = buildPlanPreview(text, context);
  box.classList.remove('is-none', 'is-read', 'is-write');
  box.classList.add(`is-${preview.tone}`);
  const title = body?.querySelector<HTMLElement>('#agentPlanTitle');
  const detail = body?.querySelector<HTMLElement>('#agentPlanDetail');
  const hint = body?.querySelector<HTMLElement>('#agentPlanHint');
  if (title) title.textContent = preview.tone === 'none' ? preview.title : `${preview.title}（${preview.intentLabel}）`;
  if (detail) detail.textContent = preview.detail;
  if (hint) hint.textContent = preview.hint;
  box.dataset.tool = preview.tool ?? '';
  box.dataset.readOnly = preview.readOnly ? '1' : '0';
  box.dataset.offline = preview.offlineAllowed ? '1' : '0';
  box.dataset.resolvedFrom = preview.resolvedFrom ?? '';
  box.dataset.resolvedLabel = preview.resolvedLabel ?? '';
  refreshMultiPlan(text, context);
}

/** 只读采集现有 UI 状态；不新增全局单例，采集失败时返回空上下文。 */
function currentAgentContext(): AgentContext {
  let raw: unknown = null;
  try {
    raw = window.__AgentBridge?.getProjectContext?.() ?? null;
  } catch {
    raw = null;
  }
  return collectAgentContext({ projectContext: () => raw });
}

/**
 * 流程预览与执行需要比对话更多的上下文：CAD 源路径与 BOM 行。
 * 这些信息只用于模板占位符解析，不写入磁盘。
 */
function currentRecipeContext(): RecipeContext {
  const base = currentAgentContext();
  let cadPath = '';
  try {
    const scene = window.__AgentBridge?.getScene?.() as unknown;
    if (scene && typeof scene === 'object' && !('message' in scene)) {
      const source = (scene as Record<string, unknown>).source;
      if (typeof source === 'string') cadPath = source;
    }
  } catch {
    cadPath = '';
  }
  let bom: unknown[] = [];
  try {
    const rows = window.__AgentBridge?.getBom?.() as unknown;
    if (Array.isArray(rows)) bom = rows;
  } catch {
    bom = [];
  }
  return { ...base, cadPath, bom } as RecipeContext;
}

function recipeStepIcon(index: number, step: RecipeStep, skipped: boolean): { tone: string; icon: string } {
  const result = recipeUi.result?.results.find((item) => item.stepId === step.id);
  if (result) {
    if (result.skipped) return { tone: 'is-skip', icon: '—' };
    return result.ok ? { tone: 'is-done', icon: '✓' } : { tone: 'is-fail', icon: '×' };
  }
  if (skipped) return { tone: 'is-skip', icon: '—' };
  const live = recipeUi.live.get(index + 1);
  if (live && live.elapsedMs === undefined) return { tone: 'is-running', icon: '…' };
  if (live && live.ok === false) return { tone: 'is-fail', icon: '×' };
  if (live && live.ok === true) return { tone: 'is-done', icon: '✓' };
  return { tone: 'is-pending', icon: String(index + 1) };
}

/** 流程卡片：模板下拉 → 前置条件/步骤预览（可取消勾选）→ 开始 → 结果与导出。 */
function renderRecipe(): void {
  const panel = body?.querySelector<HTMLElement>('#agentRecipePanel');
  if (!panel) return;
  const recipe = getRecipe(recipeUi.selectedId) ?? RECIPES[0];
  if (!recipe) return;
  panel.dataset.recipeId = recipe.id;
  panel.dataset.running = recipeUi.running ? '1' : '0';
  const select = body?.querySelector<HTMLSelectElement>('#agentRecipeSelect');
  if (select) select.value = recipe.id;
  const estimate = body?.querySelector<HTMLElement>('#agentRecipeEstimate');
  if (estimate) estimate.textContent = `≈ ${recipe.estimatedSeconds}s`;
  const summary = body?.querySelector<HTMLElement>('#agentRecipeSummary');
  if (summary) summary.textContent = recipe.summary;

  const ctx = currentRecipeContext();
  const pre = checkRecipePreconditions(recipe, ctx);
  const preBox = body?.querySelector<HTMLElement>('#agentRecipePreconditions');
  if (preBox) {
    if (recipe.preconditions.length === 0) {
      preBox.innerHTML = '<div class="acp-recipe-pre is-ok"><span>✓ 无前置条件</span><span>可直接开始</span></div>';
    } else {
      preBox.innerHTML = recipe.preconditions.map((rule) => {
        const met = !pre.missing.some((item) => item.id === rule.id);
        return `<div class="acp-recipe-pre ${met ? 'is-ok' : 'is-error'}">
          <span>${met ? '✓' : '×'} ${escapeHtml(rule.label)}</span>
          <span>${escapeHtml(met ? '已满足' : rule.action)}</span>
        </div>`;
      }).join('');
    }
  }

  const stepsBox = body?.querySelector<HTMLElement>('#agentRecipeSteps');
  if (stepsBox) {
    stepsBox.innerHTML = recipe.steps.map((step, index) => {
      const skipped = recipeUi.skipped.has(step.id);
      const status = recipeStepIcon(index, step, skipped);
      const resolved = resolveRecipeArgs(step.args, ctx);
      const missing = resolved.missing.length > 0
        ? `<span class="acp-plan-missing">缺 ${escapeHtml(resolved.missing.join('、'))}</span>`
        : '';
      const readOnly = READ_ONLY_TOOLS.has(step.tool);
      return `<label class="acp-recipe-step ${status.tone}">
        <input type="checkbox" data-recipe-step="${escapeHtml(step.id)}" ${skipped ? '' : 'checked'} ${recipeUi.running ? 'disabled' : ''}>
        <span class="acp-recipe-step-icon">${status.icon}</span>
        <span class="acp-plan-step-main">
          <span class="acp-plan-step-head"><b>${index + 1}. ${escapeHtml(step.title)}</b>${missing}<span class="acp-plan-io">${readOnly ? '只读' : '写'}</span></span>
          <span class="acp-plan-step-args">${escapeHtml(step.tool)} · ${escapeHtml(summarizeArguments(resolved.args))}</span>
          <span class="acp-plan-step-why">${escapeHtml(step.why)}</span>
        </span>
      </label>`;
    }).join('');
  }

  const feedback = body?.querySelector<HTMLElement>('#agentRecipeFeedback');
  if (feedback) {
    feedback.hidden = !recipeUi.feedback;
    feedback.textContent = recipeUi.feedback;
    feedback.classList.toggle('is-error', recipeUi.tone === 'error');
    feedback.classList.toggle('is-ok', recipeUi.tone === 'ok');
  }

  const resultBox = body?.querySelector<HTMLElement>('#agentRecipeResult');
  const result = recipeUi.result;
  if (resultBox) {
    if (!result) {
      resultBox.innerHTML = '';
    } else {
      const completed = result.completed.length > 0
        ? result.completed.map((item) => `✓ 第 ${item.step} 步 ${escapeHtml(item.title)}（${formatDuration(item.elapsedMs)}）`).join('<br>')
        : '无';
      const skipped = result.skipped.length > 0
        ? `<div class="acp-note">已跳过：${result.skipped.map((item) => escapeHtml(item.title)).join('、')}</div>`
        : '';
      resultBox.innerHTML = `<div class="acp-recipe-summary ${result.ok ? 'is-ok' : 'is-error'}">${escapeHtml(result.summary)}</div>
        <div class="acp-note">总耗时 ${formatDuration(result.totalMs)} · 完成 ${result.completed.length} 步${result.skipped.length > 0 ? ` · 跳过 ${result.skipped.length} 步` : ''}</div>
        <div class="acp-recipe-completed">${completed}</div>
        ${skipped}
        ${result.report ? `<pre class="acp-recipe-report">${escapeHtml(result.report)}</pre>` : ''}`;
    }
  }

  const start = body?.querySelector<HTMLButtonElement>('#agentRecipeStart');
  if (start) {
    start.disabled = recipeUi.running;
    start.textContent = recipeUi.running ? '执行中…' : '开始';
  }
  const cancel = body?.querySelector<HTMLButtonElement>('#agentRecipeCancel');
  if (cancel) cancel.hidden = !recipeUi.running;
  const exportButton = body?.querySelector<HTMLButtonElement>('#agentRecipeExport');
  if (exportButton) exportButton.hidden = !result;
  const remember = body?.querySelector<HTMLInputElement>('#agentRecipeRemember');
  if (remember) remember.disabled = recipeUi.running;
}

async function startRecipe(): Promise<void> {
  if (!window.desktop || recipeUi.running) return;
  const recipe = getRecipe(recipeUi.selectedId);
  if (!recipe) return;
  if (thinking || multiPlan?.running) {
    recipeUi.feedback = '当前有对话或计划正在执行，完成后再启动流程。';
    recipeUi.tone = 'error';
    renderRecipe();
    return;
  }
  const remember = body?.querySelector<HTMLInputElement>('#agentRecipeRemember')?.checked === true;
  recipeUi.running = true;
  recipeUi.result = null;
  recipeUi.live.clear();
  recipeUi.feedback = `正在执行「${recipe.title}」…`;
  recipeUi.tone = '';
  resetProgress();
  renderRecipe();
  updateBusyState();
  try {
    const result = await window.desktop.agent.recipe.execute({
      recipeId: recipe.id,
      context: { ...currentRecipeContext() },
      skipSteps: [...recipeUi.skipped],
      rememberSameKind: remember
    });
    recipeUi.result = result;
    recipeUi.feedback = result.summary;
    recipeUi.tone = result.ok ? 'ok' : 'error';
    if (!result.ok) chatFeedback(result.summary, true);
  } catch (error) {
    recipeUi.feedback = `流程执行失败：${errorMessage(error)}`;
    recipeUi.tone = 'error';
  } finally {
    recipeUi.running = false;
    renderRecipe();
    updateBusyState();
    void loadAudit();
    void refreshAdvisor();
  }
}

async function cancelRecipe(): Promise<void> {
  if (!window.desktop || !recipeUi.running) return;
  recipeUi.feedback = '正在取消流程…';
  recipeUi.tone = 'error';
  renderRecipe();
  try {
    await window.desktop.agent.recipe.cancel();
  } catch (error) {
    recipeUi.feedback = `取消失败：${errorMessage(error)}`;
    recipeUi.tone = 'error';
    renderRecipe();
  }
}

async function exportRecipeRecord(): Promise<void> {
  if (!window.desktop || !recipeUi.result) return;
  const markdown = recipeRunToMarkdown(recipeUi.result);
  const safeTitle = (recipeUi.result.recipeTitle || recipeUi.result.recipeId).replace(/[\\/:*?"<>|]/g, '_');
  try {
    const result = await window.desktop.exportFile(`流程执行记录-${safeTitle}.md`, markdown);
    recipeUi.feedback = result.canceled ? '已取消导出，未写入文件。' : `已导出执行记录：${result.path ?? `流程执行记录-${safeTitle}.md`}`;
    recipeUi.tone = result.canceled ? '' : 'ok';
  } catch (error) {
    recipeUi.feedback = `导出失败：${errorMessage(error)}`;
    recipeUi.tone = 'error';
  }
  renderRecipe();
}

const EMPTY_ADVISOR_STATE: AdvisorProjectState = {
  bomRows: 0,
  unplaced: 0,
  conflicts: null,
  missingDimensions: 0,
  hasCadModel: false,
  elecCheckPassed: null,
  elecIssueCount: 0,
  costStale: false,
  plcGenerated: false
};

function advisorNumber(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function advisorStateFromBridge(value: unknown): AdvisorProjectState | null {
  if (!value || typeof value !== 'object' || !('bomRows' in value)) return null;
  const source = value as Record<string, unknown>;
  const conflicts = source.conflicts === null ? null : advisorNumber(source.conflicts);
  const elec = source.elecCheckPassed;
  return {
    bomRows: advisorNumber(source.bomRows),
    unplaced: advisorNumber(source.unplaced),
    conflicts,
    missingDimensions: advisorNumber(source.missingDimensions),
    hasCadModel: source.hasCadModel === true,
    elecCheckPassed: elec === true ? true : elec === false ? false : null,
    elecIssueCount: advisorNumber(source.elecIssueCount),
    costStale: source.costStale === true,
    plcGenerated: source.plcGenerated === true
  };
}

function bomPartIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const partId = (row as Record<string, unknown>).partId;
    if (typeof partId === 'string' && partId.trim()) ids.add(partId.trim());
  }
  return [...ids];
}

/**
 * 采集建议所需的状态摘要。桥不可用时返回空摘要，不让侧栏报错。
 * 缺尺寸数需要数据包的 dims，渲染层通过 `packs.listParts()` 只读补齐。
 */
async function collectAdvisorState(): Promise<AdvisorProjectState> {
  const bridge = window.__AgentBridge;
  if (!bridge) return { ...EMPTY_ADVISOR_STATE };
  let base: AdvisorProjectState | null = null;
  try {
    base = advisorStateFromBridge(bridge.getAdvisorState?.());
  } catch {
    base = null;
  }
  let bom: unknown = null;
  try {
    bom = bridge.getBom?.() ?? null;
  } catch {
    bom = null;
  }
  const state = base ?? { ...EMPTY_ADVISOR_STATE };
  let missingDimensions = state.missingDimensions;
  const partIds = bomPartIds(bom);
  if (partIds.length > 0) {
    try {
      const parts = await window.desktop?.packs.listParts();
      if (Array.isArray(parts)) {
        const dimsById = new Map(parts.map((part) => [part.id, part.dims] as const));
        missingDimensions = partIds.filter((id) => {
          const dims = dimsById.get(id);
          return !dims || !(dims.w > 0) || !(dims.h > 0);
        }).length;
      }
    } catch {
      missingDimensions = state.missingDimensions;
    }
  }
  return {
    ...state,
    bomRows: Array.isArray(bom) ? bom.length : state.bomRows,
    missingDimensions
  };
}

function renderAdvisor(): void {
  const list = body?.querySelector<HTMLElement>('#agentAdvisorList');
  const count = body?.querySelector<HTMLElement>('#agentAdvisorCount');
  if (!list) return;
  if (count) count.textContent = String(advisorSuggestions.length);
  if (advisorSuggestions.length === 0) {
    list.innerHTML = '<div class="acp-empty">当前没有需要处理的建议。工具执行后会自动刷新。</div>';
    return;
  }
  list.innerHTML = advisorSuggestions.map((suggestion) => {
    const action = suggestion.action.kind === 'ask'
      ? '填入输入框'
      : `计划确认 → ${suggestion.action.tool}`;
    return `<div class="acp-advisor-card" data-advisor-id="${escapeHtml(suggestion.id)}" role="button" tabindex="0">
      <div class="acp-advisor-card-head">
        <span class="acp-advisor-title">${escapeHtml(suggestion.title)}</span>
        <button type="button" class="acp-advisor-ignore" data-advisor-ignore="${escapeHtml(suggestion.id)}">忽略</button>
      </div>
      <div class="acp-advisor-why">${escapeHtml(suggestion.why)}</div>
      <div class="acp-advisor-action">${escapeHtml(action)}</div>
    </div>`;
  }).join('');
}

async function refreshAdvisor(): Promise<void> {
  const seq = ++advisorRefreshSeq;
  const context = currentAgentContext();
  let state: AdvisorProjectState;
  try {
    state = await collectAdvisorState();
  } catch {
    return;
  }
  if (seq !== advisorRefreshSeq || !body) return;
  advisorSuggestions = suggestNextActions(context, state, { ignored: ignoredAdvisorIds });
  renderAdvisor();
}

function ignoreAdvisorSuggestion(id: string): void {
  if (!id) return;
  ignoredAdvisorIds.add(id);
  advisorSuggestions = advisorSuggestions.filter((suggestion) => suggestion.id !== id);
  renderAdvisor();
}

function applyAdvisorSuggestion(id: string): void {
  const suggestion = advisorSuggestions.find((item) => item.id === id);
  if (!suggestion || !body || !window.desktop) return;
  if (suggestion.action.kind === 'ask') {
    const input = fieldElement('agentChatInput');
    if (!input) return;
    input.value = suggestion.action.prompt;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    chatFeedback(`已填入建议：${suggestion.title}`);
    return;
  }
  if (thinking || multiPlan?.running) {
    chatFeedback('当前有任务正在执行，完成后再试这条建议。', true);
    return;
  }
  const action = suggestion.action;
  const step: PlanStep = {
    tool: action.tool,
    args: { ...action.args },
    why: suggestion.why,
    readOnly: READ_ONLY_TOOLS.has(action.tool)
  };
  multiPlan = {
    input: `建议：${suggestion.title}`,
    plan: { steps: [step], confidence: 1 },
    results: [],
    next: 0,
    running: false,
    feedback: '点击「全部执行」确认后才会调用工具；写操作仍会再弹一次确认。',
    tone: '',
    dismissed: false,
    fromSuggestion: true
  };
  chatFeedback('');
  renderMultiPlan();
  if (isAgentResumeEnabled(() => agentResumeModuleEnabled)) void restoreMultiPlanCheckpoint(multiPlan);
  body.querySelector<HTMLElement>('#agentPlanCard')?.scrollIntoView({ block: 'nearest' });
}

function isMultiStepText(text: string): boolean {
  return /(?:然后|接着|之后|最后|并且|同时|再|并)/.test(text);
}

/** 输入变化时重建计划；执行中保持同一份计划，避免逐步执行被输入事件重置。 */
function refreshMultiPlan(text: string, context: AgentContext): void {
  if (multiPlan && multiPlan.input !== text && !multiPlan.running) multiPlan = null;
  if (!text) {
    if (!multiPlan?.running) multiPlan = null;
    renderMultiPlan();
    return;
  }
  if (!multiPlan) {
    const toolNames = Array.isArray(infoState.tools) && infoState.tools.length > 0
      ? infoState.tools.map((tool) => tool.name)
      : undefined;
    multiPlan = {
      input: text,
      plan: buildAgentPlan(text, { ...(toolNames ? { tools: toolNames } : {}), context }),
      results: [],
      next: 0,
      running: false,
      feedback: '',
      tone: '',
      dismissed: false
    };
    if (isAgentResumeEnabled(() => agentResumeModuleEnabled)) void restoreMultiPlanCheckpoint(multiPlan);
  }
  renderMultiPlan();
}

/** 只恢复已验证的可见状态；绝不在页面启动或计划卡创建后自动调用任何工具。 */
async function restoreMultiPlanCheckpoint(state: MultiPlanState | null): Promise<void> {
  if (!state || !window.desktop || state.plan.refused || !isAgentResumeEnabled(() => agentResumeModuleEnabled)) return;
  const generation = ++planRestoreGeneration;
  state.restoring = true;
  renderMultiPlan();
  try {
    const restored = await window.desktop.agent.plan.restore({ plan: state.plan });
    if (multiPlan !== state || generation !== planRestoreGeneration
        || !isAgentResumeEnabled(() => agentResumeModuleEnabled)) return;
    if (!restored.ok) {
      if (restored.available) {
        state.restoreBlocked = true;
        state.feedback = restored.message ?? '恢复记录无法验证；请丢弃旧进度后重新规划';
        state.tone = 'error';
      }
      return;
    }
    if (!restored.available) return;
    if (restored.blocked) {
      state.restoreBlocked = true;
      state.requiresReplan = restored.requiresReplan === true;
      state.feedback = restored.message ?? '恢复记录无法安全续跑；请丢弃旧进度后重新规划';
      state.tone = 'error';
      return;
    }
    const steps = restored.steps;
    if (!Array.isArray(steps) || !Number.isInteger(restored.cursor)
        || restored.cursor! < 0 || restored.cursor! > state.plan.steps.length
        || steps.length !== state.plan.steps.length
        || steps.some((step, index) => step.index !== index || step.tool !== state.plan.steps[index]?.tool)) {
      state.restoreBlocked = true;
      state.requiresReplan = true;
      state.feedback = '恢复步骤与当前计划不一致；请丢弃旧进度后重新规划';
      state.tone = 'error';
      return;
    }
    state.next = restored.cursor!;
    state.results = steps
      .filter((step) => step.state === 'completed')
      .map((step) => ({
        index: step.index,
        step: step.index + 1,
        tool: step.tool,
        ok: true,
        code: 'RESTORED_COMPLETED',
        message: '重启前已完成，恢复时不会重复执行',
        elapsedMs: 0
      }));
    state.restoredCheckpoint = true;
    const completedCount = state.results.length;
    state.feedback = state.next >= state.plan.steps.length
      ? `已恢复：全部 ${state.plan.steps.length} 步均已完成，不会再次执行。`
      : `已恢复进度：${completedCount} 步保持完成；后续步骤不会自动运行${restored.needsReconfirmation ? '，继续时写步骤仍需重新确认' : ''}。`;
    state.tone = 'ok';
  } catch (error) {
    if (multiPlan === state && generation === planRestoreGeneration
        && isAgentResumeEnabled(() => agentResumeModuleEnabled)) {
      state.restoreBlocked = true;
      state.requiresReplan = true;
      state.feedback = `恢复状态校验失败：${errorMessage(error)}；请丢弃旧进度后重新规划`;
      state.tone = 'error';
    }
  } finally {
    if (multiPlan === state && generation === planRestoreGeneration
        && isAgentResumeEnabled(() => agentResumeModuleEnabled)) {
      state.restoring = false;
      renderMultiPlan();
    }
  }
}

async function discardCheckpointAndReplan(): Promise<void> {
  const state = multiPlan;
  if (!isAgentResumeEnabled(() => agentResumeModuleEnabled)
      || !state || state.running || state.restoring || !state.restoreBlocked || !window.desktop) return;
  try {
    const cleared = await window.desktop.agent.plan.clearCheckpoint();
    if (!cleared.ok) throw new Error(cleared.message ?? '无法清除恢复记录');
    if (state.requiresReplan) {
      multiPlan = null;
      renderMultiPlan();
      chatFeedback('旧进度已清除。此前写操作结果无法确认；请检查当前工程并重新输入指令规划，不会续跑旧计划。', true);
      fieldElement('agentChatInput')?.focus();
      return;
    }
    if (!state.fromSuggestion) {
      const toolNames = Array.isArray(infoState.tools) && infoState.tools.length > 0
        ? infoState.tools.map((tool) => tool.name)
        : undefined;
      state.plan = buildAgentPlan(state.input, { ...(toolNames ? { tools: toolNames } : {}), context: currentAgentContext() });
    }
    state.results = [];
    state.next = 0;
    state.restoredCheckpoint = false;
    state.restoreBlocked = false;
    state.requiresReplan = false;
    state.feedback = '旧进度已丢弃；计划已重新核对。工具尚未执行，请再次确认后运行。';
    state.tone = '';
    renderMultiPlan();
  } catch (error) {
    state.feedback = `无法重新规划：${errorMessage(error)}`;
    state.tone = 'error';
    renderMultiPlan();
  }
}

export function setAgentResumeModuleEnabled(enabled: boolean): void {
  const wasEnabled = agentResumeModuleEnabled;
  agentResumeModuleEnabled = enabled === true;
  if (!agentResumeModuleEnabled) {
    planRestoreGeneration += 1;
    const state = multiPlan;
    if (state && (state.restoring || state.restoredCheckpoint || state.restoreBlocked)) {
      if (state.running) {
        state.restoring = false;
        state.restoredCheckpoint = false;
        state.restoreBlocked = false;
        state.requiresReplan = false;
        state.feedback = '跨重启恢复模块已关闭；磁盘中的旧 checkpoint 保留但不可使用。当前计划仍需逐步确认。';
        state.tone = '';
      } else {
        multiPlan = null;
        chatFeedback('跨重启恢复模块已关闭；旧 checkpoint 已保留但不可使用。请重新规划后再按常规确认执行。', true);
      }
    }
  } else if (!wasEnabled && multiPlan && !multiPlan.running) {
    // 仅校验并显示进度；工具仍须由用户显式点击执行，写步骤继续走原生确认。
    void restoreMultiPlanCheckpoint(multiPlan);
  }
  renderMultiPlan();
}

function stepTone(state: MultiPlanState, index: number): { tone: string; icon: string } {
  const result = state.results.find((item) => item.index === index);
  if (result) return result.ok ? { tone: 'is-done', icon: '✓' } : { tone: 'is-fail', icon: '×' };
  if (state.running && state.next === index) return { tone: 'is-running', icon: '…' };
  return { tone: 'is-pending', icon: String(index + 1) };
}

/** 多步计划卡片：只展示与触发执行，规划本身仍是纯函数。 */
function renderMultiPlan(): void {
  const card = body?.querySelector<HTMLElement>('#agentPlanCard');
  if (!card) return;
  const state = multiPlan;
  const show = Boolean(state && !state.dismissed && (
    state.plan.steps.length >= 2 ||
    (state.fromSuggestion === true && state.plan.steps.length > 0) ||
    (state.plan.refused === true && (isMultiStepText(state.input) || (state.plan.warnings?.length ?? 0) > 0))
  ));
  if (!state || !show) {
    card.hidden = true;
    card.dataset.steps = '0';
    return;
  }
  card.hidden = false;
  card.dataset.steps = String(state.plan.steps.length);
  card.dataset.running = state.running ? '1' : '0';
  const writeCount = state.plan.steps.filter((step) => !step.readOnly).length;
  const title = body?.querySelector<HTMLElement>('#agentPlanCardTitle');
  const meta = body?.querySelector<HTMLElement>('#agentPlanCardMeta');
  const list = body?.querySelector<HTMLElement>('#agentPlanList');
  const feedback = body?.querySelector<HTMLElement>('#agentPlanFeedback');
  const runAll = body?.querySelector<HTMLButtonElement>('#agentPlanRunAll');
  const runStep = body?.querySelector<HTMLButtonElement>('#agentPlanRunStep');
  const replan = body?.querySelector<HTMLButtonElement>('#agentPlanReplan');
  const cancel = body?.querySelector<HTMLButtonElement>('#agentPlanCancel');

  if (title) {
    title.textContent = state.restoring
      ? '多步计划 · 正在校验恢复记录'
      : state.restoreBlocked
        ? '多步计划 · 需要重新规划'
        : state.plan.refused
      ? '多步计划 · 未执行'
      : state.fromSuggestion
        ? `建议确认 · ${state.plan.steps.length} 步`
        : `多步计划 · ${state.plan.steps.length} 步`;
  }
  if (meta) {
    meta.textContent = state.plan.refused
      ? '已拒绝'
      : `${state.plan.steps.length} 步 · ${writeCount} 步写 · 置信度 ${(state.plan.confidence * 100).toFixed(0)}%`;
    meta.classList.toggle('is-error', state.plan.refused === true);
  }

  if (list) {
    if (state.plan.refused) {
      const reasons = [
        state.plan.reason ?? '规则未命中',
        ...(state.plan.warnings ?? []),
        ...(state.plan.suggestions ?? []).slice(0, 3).map((item) => `建议：${item}`)
      ];
      list.innerHTML = reasons.map((item) => `<div class="acp-plan-refused">${escapeHtml(item)}</div>`).join('');
    } else {
      list.innerHTML = state.plan.steps.map((step, index) => {
        const status = stepTone(state, index);
        const args = summarizeArguments(step.args);
        const missing = step.missing && step.missing.length > 0
          ? `<span class="acp-plan-missing">缺 ${escapeHtml(step.missing.join('、'))}</span>`
          : '';
        return `<div class="acp-plan-step ${status.tone}" data-step-index="${index + 1}" data-tool="${escapeHtml(step.tool)}">
          <span class="acp-plan-step-icon">${status.icon}</span>
          <span class="acp-plan-step-main">
            <span class="acp-plan-step-head"><b>${index + 1}. ${escapeHtml(step.tool)}</b>${missing}<span class="acp-plan-io">${step.readOnly ? '只读' : '写'}</span></span>
            <span class="acp-plan-step-args">${escapeHtml(args)}</span>
            <span class="acp-plan-step-why">${escapeHtml(step.why)}</span>
            ${step.resolvedFrom ? `<span class="acp-plan-basis">已使用${step.resolvedFrom === 'selection' ? '选中对象' : step.resolvedFrom === 'recent' ? '最近操作对象' : '底板对象'}：${escapeHtml(step.resolvedLabel ?? '')}</span>` : ''}
          </span>
        </div>`;
      }).join('') + (state.plan.warnings ?? []).map((warning) =>
        `<div class="acp-plan-warning">${escapeHtml(warning)}</div>`
      ).join('');
    }
  }

  if (feedback) {
    feedback.hidden = !state.feedback;
    feedback.textContent = state.feedback;
    feedback.classList.toggle('is-error', state.tone === 'error');
    feedback.classList.toggle('is-ok', state.tone === 'ok');
  }

  const refused = state.plan.refused === true;
  const completed = !refused && state.next >= state.plan.steps.length;
  if (runAll) {
    runAll.disabled = state.running || state.restoring === true || state.restoreBlocked === true || refused || completed;
    runAll.hidden = refused || state.restoreBlocked === true;
  }
  if (runStep) {
    runStep.disabled = state.running || state.restoring === true || state.restoreBlocked === true || refused || completed;
    runStep.hidden = refused || state.restoreBlocked === true;
    runStep.textContent = state.next === 0 ? '逐步执行' : (completed ? '已完成' : `下一步（${state.next + 1}/${state.plan.steps.length}）`);
  }
  if (replan) {
    replan.hidden = state.restoreBlocked !== true;
    replan.disabled = state.running || state.restoring === true;
  }
  if (cancel) {
    cancel.disabled = false;
    cancel.textContent = refused ? '关闭' : (state.running ? '取消执行' : '取消');
  }
}

async function runMultiPlan(mode: 'all' | 'step'): Promise<void> {
  const state = multiPlan;
  if (!state || state.running || state.restoring || state.restoreBlocked || thinking || recipeUi.running || state.plan.refused || !window.desktop) return;
  if (state.next >= state.plan.steps.length) return;
  state.running = true;
  state.feedback = '';
  state.tone = '';
  cancelRequested = false;
  resetProgress();
  renderMultiPlan();
  updateBusyState();
  try {
    const result = await window.desktop.agent.plan.execute({
      plan: state.plan,
      startAt: state.next,
      ...(mode === 'step' ? { maxSteps: 1 } : {})
    });
    const merged = new Map(state.results.map((item) => [item.index, item]));
    for (const item of result.results ?? []) merged.set(item.index, item);
    state.results = [...merged.values()].sort((left, right) => left.index - right.index);
    let completedPrefix = 0;
    while (state.results.some((item) => item.index === completedPrefix && item.ok)) completedPrefix += 1;
    state.next = completedPrefix;

    if (result.refused) {
      state.feedback = result.summary || '计划已拒绝';
      state.tone = 'error';
    } else if (result.cancelled) {
      state.feedback = result.summary || '已取消，未写入任何更改';
      if (result.undoHint) state.feedback += `；${result.undoHint}`;
      state.tone = 'error';
      chatFeedback(state.feedback, true);
    } else if (!result.ok) {
      const failed = result.results?.find((item) => !item.ok);
      state.next = typeof result.failedIndex === 'number' ? result.failedIndex : state.next;
      state.feedback = failed
        ? `第 ${failed.step} 步 ${failed.tool} 失败（${failed.code}）${failed.message ? `：${failed.message}` : ''}；后续步骤已停止`
        : (result.summary || '计划执行失败');
      if (failed) {
        const advice = suggestFailure({
          code: failed.code,
          ...(failed.message ? { message: failed.message } : {}),
          tool: failed.tool
        });
        state.feedback += `；建议：${advice.advice}`;
        if (advice.alternatives.length > 0) state.feedback += `；可选：${advice.alternatives.slice(0, 2).join(' / ')}`;
      }
      if (result.undoHint) state.feedback += `；${result.undoHint}`;
      state.tone = 'error';
      chatFeedback(state.feedback, true);
    } else {
      const lastIndex = result.results?.reduce((max, item) => Math.max(max, item.index), -1) ?? -1;
      state.next = Math.max(state.next, lastIndex + 1);
      state.feedback = result.summary || `已完成 ${state.next}/${state.plan.steps.length} 步`;
      if (result.undoHint) state.feedback += `；${result.undoHint}`;
      state.tone = 'ok';
      if (state.next >= state.plan.steps.length) chatFeedback('');
    }
  } catch (error) {
    state.feedback = `计划执行失败：${errorMessage(error)}`;
    state.tone = 'error';
    chatFeedback(state.feedback, true);
  } finally {
    state.running = false;
    cancelRequested = false;
    renderMultiPlan();
    updateBusyState();
    void loadAudit();
    void refreshAdvisor();
  }
}

async function cancelMultiPlan(): Promise<void> {
  if (!multiPlan) return;
  if (multiPlan.running) {
    if (!cancelRequested) {
      cancelRequested = true;
      multiPlan.feedback = '正在取消当前工具…';
      multiPlan.tone = 'error';
      renderMultiPlan();
      updateBusyState();
      try {
        await window.desktop?.agent.plan.cancel();
      } catch (error) {
        chatFeedback(`取消失败：${errorMessage(error)}`, true);
        cancelRequested = false;
        updateBusyState();
      }
    }
    return;
  }
  multiPlan.dismissed = true;
  multiPlan.feedback = '';
  multiPlan.tone = '';
  renderMultiPlan();
}

/** 审计面板：筛选 + 时间倒序 + 最近 200 条 + 单条 JSON + CSV 导出。 */
function auditEntriesForView(): DesktopAgentAuditEntry[] {
  const all = Array.isArray(auditState?.entries) ? auditState.entries : [];
  return filterAuditEntries(all, { result: auditFilterResult, ...(auditFilterTool ? { tool: auditFilterTool } : {}) });
}

function setAuditHint(text: string, isError = false): void {
  const hint = body?.querySelector<HTMLElement>('#agentAuditHint');
  if (!hint) return;
  hint.textContent = text;
  hint.classList.toggle('is-error', isError);
}

function renderAudit(): void {
  const list = body?.querySelector<HTMLElement>('#agentAuditList');
  const count = body?.querySelector<HTMLElement>('#agentAuditCount');
  const summaryElement = body?.querySelector<HTMLElement>('#agentAuditSummary');
  const toolSelect = body?.querySelector<HTMLSelectElement>('#agentAuditToolFilter');
  const resultSelect = body?.querySelector<HTMLSelectElement>('#agentAuditResultFilter');
  if (!list) return;
  if (auditLoading) {
    list.innerHTML = '<div class="acp-empty">正在读取审计…</div>';
    return;
  }
  if (!auditState) {
    list.innerHTML = '<div class="acp-empty">审计尚未读取</div>';
    return;
  }
  if (!auditState.ok) {
    list.innerHTML = `<div class="acp-note is-error">读取审计失败：${escapeHtml(auditState.message ?? '未知错误')}</div>`;
    if (count) count.textContent = '—';
    if (summaryElement) summaryElement.textContent = '';
    setAuditHint('读取审计失败，未展示任何记录。', true);
    return;
  }
  const all = Array.isArray(auditState.entries) ? auditState.entries : [];
  const tools = auditToolNames(all);
  if (auditFilterTool && !tools.includes(auditFilterTool)) auditFilterTool = '';
  if (toolSelect) {
    toolSelect.innerHTML = '<option value="">全部工具</option>' +
      tools.map((tool) => `<option value="${escapeHtml(tool)}">${escapeHtml(tool)}</option>`).join('');
    toolSelect.value = auditFilterTool;
  }
  if (resultSelect) resultSelect.value = auditFilterResult;
  if (count) count.textContent = String(auditState.total ?? auditState.summary?.total ?? all.length);
  if (summaryElement) summaryElement.textContent = auditSummaryText(auditState.summary);

  const filtered = auditEntriesForView();
  const limited = limitAuditEntries(filtered, 200);
  const dropped = (auditState.dropped ?? 0) + limited.dropped;
  const filterText = auditFilterTool || auditFilterResult !== 'all' ? `筛选后 ${filtered.length} 条` : `最近 ${limited.entries.length} 条`;
  if (dropped > 0) {
    setAuditHint(`已显示${filterText}；超过 200 条上限，更早 ${dropped} 条已丢弃（审计文件仍保留）。`);
  } else {
    setAuditHint(`审计只记录工具名、结果、耗时与脱敏后的参数；当前${filterText}。`);
  }
  if (limited.entries.length === 0) {
    list.innerHTML = all.length === 0
      ? '<div class="acp-empty">还没有工具调用记录。离线问答与模型调用都会写入审计。</div>'
      : '<div class="acp-empty">当前筛选条件下没有记录。</div>';
    return;
  }
  list.innerHTML = limited.entries.map((entry) => {
    const ok = entry.ok === true;
    const code = entry.code ?? (ok ? 'OK' : 'FAILED');
    return `<details class="acp-audit-row ${ok ? 'is-ok' : 'is-error'}">
      <summary>
        <span class="acp-audit-time">${escapeHtml(timeText(entry.at))}</span>
        <span class="acp-audit-tool">${escapeHtml(entry.tool)}</span>
        <span class="acp-audit-args">${escapeHtml(auditArgsText(entry))}</span>
        <span class="acp-audit-code">${escapeHtml(code)}${entry.cacheHit ? ' · 已复用' : ''}</span>
        <span class="acp-audit-elapsed">${escapeHtml(formatDuration(entry.elapsedMs))}</span>
      </summary>
      <pre class="acp-audit-json">${escapeHtml(auditEntryJson(entry))}</pre>
    </details>`;
  }).join('');
}

async function exportAuditCsv(): Promise<void> {
  if (!window.desktop) return;
  const entries = auditEntriesForView();
  if (entries.length === 0) {
    setAuditHint('当前筛选结果为空，没有可导出的审计记录。', true);
    return;
  }
  try {
    const result = await window.desktop.exportFile(auditExportFileName(), auditCsv(entries));
    if (result.canceled) setAuditHint('已取消导出，未写入文件。');
    else setAuditHint(`已导出 ${entries.length} 条审计记录：${result.path ?? auditExportFileName()}`);
  } catch (error) {
    setAuditHint(`导出失败：${errorMessage(error)}`, true);
  }
}

async function loadAudit(): Promise<void> {
  if (!window.desktop) return;
  auditLoading = true;
  renderAudit();
  try {
    auditState = await window.desktop.agent.audit.read();
  } catch (error) {
    auditState = { ok: false, message: errorMessage(error) };
  } finally {
    auditLoading = false;
    renderAudit();
  }
}

function updateBusyState(): void {
  const send = body?.querySelector<HTMLButtonElement>('#agentChatSend');
  const clear = body?.querySelector<HTMLButtonElement>('#agentChatClear');
  const cancel = body?.querySelector<HTMLButtonElement>('#agentChatCancel');
  const busy = thinking || multiPlan?.running === true || recipeUi.running;
  if (send) {
    send.disabled = busy;
    send.textContent = thinking ? '思考中…' : '发送';
  }
  if (clear) clear.disabled = busy;
  if (cancel) {
    cancel.hidden = !busy;
    cancel.disabled = cancelRequested;
    cancel.textContent = cancelRequested ? '取消中…' : '取消执行';
  }
  setStatus('agentChatStatus', busy ? (cancelRequested ? '取消中…' : '执行中…') : '就绪');
}

function chatFeedback(message: string, isError = false): void {
  const element = body?.querySelector<HTMLElement>('#agentChatFeedback');
  if (!element) return;
  element.hidden = !message;
  element.textContent = message;
  element.classList.toggle('is-error', isError);
}

/** 取最后一条用户消息之后的对话，用于统计本轮工具调用次数。 */
function lastTurnMessages(): Array<{ role: string; content?: string | null }> {
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === 'user') {
      start = index;
      break;
    }
  }
  return messages.slice(start).map((message) => ({ role: message.role, content: message.content }));
}

function renderUsage(): void {
  const usage = usageState;
  const model = body?.querySelector<HTMLElement>('#agentUsageModel');
  if (model) model.textContent = usage?.model && usage.model !== 'unknown' ? usage.model : '—';
  const setText = (id: string, text: string): void => {
    const element = body?.querySelector<HTMLElement>(`#${id}`);
    if (element) element.textContent = text;
  };
  if (!usage) {
    setText('agentTurnTokens', '—');
    setText('agentTurnCost', '—');
    setText('agentSessionTokens', '—');
    setText('agentSessionCost', '—');
    setText('agentTurnUsageMeta', '输入 — · 输出 —');
    setText('agentSessionUsageMeta', '输入 — · 输出 —');
    return;
  }
  const estimated = usage.turn.estimated ? ' · 估算' : '';
  setText('agentTurnTokens', `${formatTokenCount(usage.turn.totalTokens)} tokens${estimated}`);
  setText('agentTurnCost', usage.cost.turn.display);
  setText('agentTurnUsageMeta', `输入 ${formatTokenCount(usage.turn.promptTokens)} · 输出 ${formatTokenCount(usage.turn.completionTokens)} · ${usage.turn.requests} 次请求`);
  setText('agentSessionTokens', `${formatTokenCount(usage.session.totalTokens)} tokens`);
  setText('agentSessionCost', usage.cost.session.display);
  setText('agentSessionUsageMeta', `输入 ${formatTokenCount(usage.session.promptTokens)} · 输出 ${formatTokenCount(usage.session.completionTokens)} · ${usage.session.requests} 次请求`);
}

async function sendMessage(): Promise<void> {
  if (!body || thinking || multiPlan?.running || recipeUi.running) return;
  const input = fieldElement('agentChatInput');
  const text = input?.value.trim() ?? '';
  if (!text) return;
  if (!window.desktop) {
    chatFeedback('智能体对话仅在桌面版可用。', true);
    return;
  }
  thinking = true;
  chatFeedback('');
  if (input) input.value = '';
  cancelRequested = false;
  resetProgress();
  renderPreview();
  updateBusyState();
  const started = Date.now();
  try {
    const result = await window.desktop.agent.chat.send(text);
    messages = Array.isArray(result.messages) ? result.messages : messages;
    if (result.tokens) usageState = result.tokens;
    renderUsage();
    if (result.ok) {
      const turn = summarizeTurn(lastTurnMessages());
      lastReceipt = buildReceipt({
        mode: result.mode === 'offline' ? 'offline' : 'online',
        elapsedMs: typeof result.elapsedMs === 'number' ? result.elapsedMs : Date.now() - started,
        toolCalls: turn.toolCalls,
        failures: turn.failures
      });
    } else if (result.cancelled) {
      lastReceipt = null;
      chatFeedback(result.message || '已取消，未写入任何更改', true);
      void loadAudit();
    }
    renderMessages();
    if (!result.ok && !result.cancelled) {
      chatFeedback(result.message || '智能体请求失败', true);
    } else if (result.ok) {
      void loadAudit();
    }
  } catch (error) {
    chatFeedback(`智能体请求失败：${errorMessage(error)}`, true);
  } finally {
    thinking = false;
    cancelRequested = false;
    updateBusyState();
    void refreshAdvisor();
  }
}

async function clearMessages(): Promise<void> {
  if (!window.desktop) return;
  try {
    const result = await window.desktop.agent.chat.clear();
    messages = Array.isArray(result.messages) ? result.messages : [];
    lastReceipt = null;
    usageState = null;
    machineDesignCards.clear();
    appliedMachineCards.clear();
    renderMessages();
    renderUsage();
    chatFeedback('');
  } catch (error) {
    chatFeedback(`清空失败：${errorMessage(error)}`, true);
  }
}

async function saveSettings(): Promise<void> {
  if (!window.desktop) return;
  const baseUrl = fieldElement('agentLlmBaseUrl')?.value.trim() ?? '';
  const model = fieldElement('agentLlmModel')?.value.trim() ?? '';
  const apiKey = fieldElement('agentLlmApiKey')?.value ?? '';
  const maxIterations = Number(fieldElement('agentLlmMaxIterations')?.value ?? '');
  const payload: Record<string, unknown> = { baseUrl, model, maxIterations };
  if (apiKeyDirty) payload.apiKey = apiKey;
  const button = body?.querySelector<HTMLButtonElement>('#agentLlmSave');
  if (button) button.disabled = true;
  setStatus('agentLlmStatus', '保存中…');
  try {
    llmState = await window.desktop.agent.saveLlmConfig(payload);
    fillConfig();
    messages = [];
    renderMessages();
    setStatus('agentLlmStatus', '已保存，对话已重置');
  } catch (error) {
    setStatus('agentLlmStatus', `保存失败：${errorMessage(error)}`, true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function testSettings(): Promise<void> {
  if (!window.desktop) return;
  const baseUrl = fieldElement('agentLlmBaseUrl')?.value.trim() ?? '';
  const model = fieldElement('agentLlmModel')?.value.trim() ?? '';
  const apiKey = fieldElement('agentLlmApiKey')?.value ?? '';
  const maxIterations = Number(fieldElement('agentLlmMaxIterations')?.value ?? '');
  const payload: Record<string, unknown> = { baseUrl, model, maxIterations };
  if (apiKeyDirty) payload.apiKey = apiKey;
  const button = body?.querySelector<HTMLButtonElement>('#agentLlmTest');
  if (button) button.disabled = true;
  setStatus('agentLlmStatus', '测试中…');
  try {
    const result = await window.desktop.agent.testLlm(payload);
    setStatus('agentLlmStatus', result.message, !result.ok);
  } catch (error) {
    setStatus('agentLlmStatus', `测试失败：${errorMessage(error)}`, true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function saveAppearance(patch: Partial<DesktopAppearanceConfig>): Promise<void> {
  if (!window.desktop) return;
  const select = body?.querySelector<HTMLSelectElement>(
    patch.uiScale === undefined ? '#agentRenderQuality' : '#agentUiScale'
  );
  if (select) select.disabled = true;
  setStatus('agentAppearanceStatus', '保存中…');
  try {
    const saved = await window.desktop.appearance.set(patch);
    appearanceState = saved;
    applyAppearance(saved);
    setStatus('agentAppearanceStatus', `已保存：缩放 ${Math.round(saved.uiScale * 100)}% · 渲染 ${saved.renderQuality}`);
    const info = body?.querySelector<HTMLElement>('#agentRenderQualityInfo');
    if (info) info.textContent = renderQualityText();
  } catch (error) {
    setStatus('agentAppearanceStatus', `保存失败：${errorMessage(error)}`, true);
  } finally {
    if (select) select.disabled = false;
  }
}

function toggleLanToken(): void {
  const token = body?.querySelector<HTMLElement>('#agentLanToken');
  const button = body?.querySelector<HTMLButtonElement>('#agentLanTokenToggle');
  if (!token || !button) return;
  token.hidden = !token.hidden;
  button.textContent = token.hidden ? '显示 token' : '隐藏 token';
}

async function copyLanToken(): Promise<void> {
  const token = body?.querySelector<HTMLElement>('#agentLanToken')?.textContent?.trim() ?? '';
  if (!token || token === '—') {
    setStatus('agentLanStatus', 'token 尚未就绪', true);
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(token);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = token;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    setStatus('agentLanStatus', 'token 已复制到剪贴板');
  } catch (error) {
    setStatus('agentLanStatus', `复制失败：${errorMessage(error)}`, true);
  }
}

async function rotateLanToken(): Promise<void> {
  if (!window.desktop) return;
  const confirmed = window.confirm(
    '重新生成 token？已连接的客户端会立刻失效，必须重新分发新 token 才能继续连接。确定继续？'
  );
  if (!confirmed) return;
  const button = body?.querySelector<HTMLButtonElement>('#agentLanTokenRotate');
  if (button) button.disabled = true;
  setStatus('agentLanStatus', '正在重新生成 token…');
  try {
    const result = await window.desktop.agent.lan.rotateToken();
    lanState = result;
    infoState = {
      ...infoState,
      ...(result.info.host ? { host: result.info.host } : {}),
      ...(result.info.port !== undefined ? { port: result.info.port } : {}),
      ...(result.info.url ? { url: result.info.url } : {}),
      ...(result.info.tokenFile ? { tokenFile: result.info.tokenFile } : {}),
      token: result.token,
      lanEnabled: result.config.enabled,
      allowlist: result.config.allowlist,
      cdpPort: result.cdpPort,
      cdpActive: result.cdpActive,
      cdpRestartRequired: result.cdpRestartRequired,
      lanAddress: result.lanAddress
    };
    renderShell();
    setStatus('agentLanStatus', result.message ?? (result.ok ? 'token 已重新生成' : '重新生成失败'), !result.ok);
  } catch (error) {
    setStatus('agentLanStatus', `重新生成失败：${errorMessage(error)}`, true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function saveLanAccess(): Promise<void> {
  if (!window.desktop) return;
  const enabled = body?.querySelector<HTMLInputElement>('#agentLanEnabled')?.checked === true;
  const allowlist = (fieldElement('agentLanAllowlist') as HTMLTextAreaElement | null)?.value ?? '';
  const cdpEnabled = body?.querySelector<HTMLInputElement>('#agentCdpEnabled')?.checked === true;
  const button = body?.querySelector<HTMLButtonElement>('#agentLanSave');
  if (button) button.disabled = true;
  setStatus('agentLanStatus', '保存并重启 Agent 中…');
  try {
    const result = await window.desktop.agent.lan.save({ enabled, allowlist, cdpEnabled });
    lanState = result;
    infoState = {
      ...infoState,
      ...(result.info.host ? { host: result.info.host } : {}),
      ...(result.info.port !== undefined ? { port: result.info.port } : {}),
      ...(result.info.url ? { url: result.info.url } : {}),
      ...(result.info.tokenFile ? { tokenFile: result.info.tokenFile } : {}),
      token: result.token,
      lanEnabled: result.config.enabled,
      allowlist: result.config.allowlist,
      cdpPort: result.cdpPort,
      cdpActive: result.cdpActive,
      cdpRestartRequired: result.cdpRestartRequired,
      lanAddress: result.lanAddress
    };
    renderShell();
    setStatus('agentLanStatus', result.message ?? (result.ok ? '已保存并重启 Agent' : '保存失败'), !result.ok);
  } catch (error) {
    setStatus('agentLanStatus', `保存失败：${errorMessage(error)}`, true);
  } finally {
    if (button) button.disabled = false;
  }
}

function bindControls(): void {
  body?.querySelector<HTMLButtonElement>('#agentChatSend')?.addEventListener('click', () => { void sendMessage(); });
  body?.querySelector<HTMLButtonElement>('#agentChatClear')?.addEventListener('click', () => { void clearMessages(); });
  body?.querySelector<HTMLSelectElement>('#agentRecipeSelect')?.addEventListener('change', (event) => {
    recipeUi.selectedId = (event.target as HTMLSelectElement).value;
    recipeUi.skipped.clear();
    recipeUi.result = null;
    recipeUi.live.clear();
    recipeUi.feedback = '';
    recipeUi.tone = '';
    renderRecipe();
  });
  body?.querySelector<HTMLElement>('#agentRecipeSteps')?.addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement;
    const id = target?.dataset?.recipeStep;
    if (!id) return;
    if (target.checked) recipeUi.skipped.delete(id);
    else recipeUi.skipped.add(id);
    renderRecipe();
  });
  body?.querySelector<HTMLButtonElement>('#agentRecipeStart')?.addEventListener('click', () => { void startRecipe(); });
  body?.querySelector<HTMLButtonElement>('#agentRecipeCancel')?.addEventListener('click', () => { void cancelRecipe(); });
  body?.querySelector<HTMLButtonElement>('#agentRecipeExport')?.addEventListener('click', () => { void exportRecipeRecord(); });
  body?.querySelector<HTMLButtonElement>('#agentPlanRunAll')?.addEventListener('click', () => { void runMultiPlan('all'); });
  body?.querySelector<HTMLButtonElement>('#agentPlanRunStep')?.addEventListener('click', () => { void runMultiPlan('step'); });
  body?.querySelector<HTMLButtonElement>('#agentPlanReplan')?.addEventListener('click', () => { void discardCheckpointAndReplan(); });
  body?.querySelector<HTMLButtonElement>('#agentPlanCancel')?.addEventListener('click', () => { void cancelMultiPlan(); });
  body?.querySelector<HTMLButtonElement>('#agentChatCancel')?.addEventListener('click', () => { void cancelExecution(); });
  body?.querySelector<HTMLButtonElement>('#agentLlmSave')?.addEventListener('click', () => { void saveSettings(); });
  body?.querySelector<HTMLButtonElement>('#agentLlmTest')?.addEventListener('click', () => { void testSettings(); });
  body?.querySelector<HTMLSelectElement>('#agentUiScale')?.addEventListener('change', (event) => {
    void saveAppearance({ uiScale: Number((event.target as HTMLSelectElement).value) });
  });
  body?.querySelector<HTMLSelectElement>('#agentRenderQuality')?.addEventListener('change', (event) => {
    void saveAppearance({ renderQuality: (event.target as HTMLSelectElement).value as 'flow' | 'standard' | 'high' });
  });
  body?.querySelector<HTMLButtonElement>('#agentLanTokenToggle')?.addEventListener('click', toggleLanToken);
  body?.querySelector<HTMLButtonElement>('#agentLanTokenCopy')?.addEventListener('click', () => { void copyLanToken(); });
  body?.querySelector<HTMLButtonElement>('#agentLanTokenRotate')?.addEventListener('click', () => { void rotateLanToken(); });
  body?.querySelector<HTMLButtonElement>('#agentLanSave')?.addEventListener('click', () => { void saveLanAccess(); });
  body?.querySelector<HTMLButtonElement>('#agentAuditRefresh')?.addEventListener('click', () => { void loadAudit(); });
  body?.querySelector<HTMLButtonElement>('#agentAuditExport')?.addEventListener('click', () => { void exportAuditCsv(); });
  body?.querySelector<HTMLSelectElement>('#agentAuditToolFilter')?.addEventListener('change', (event) => {
    auditFilterTool = (event.target as HTMLSelectElement).value;
    renderAudit();
  });
  body?.querySelector<HTMLSelectElement>('#agentAuditResultFilter')?.addEventListener('change', (event) => {
    auditFilterResult = (event.target as HTMLSelectElement).value as AuditResultFilter;
    renderAudit();
  });
  body?.querySelector<HTMLElement>('#agentChatLog')?.addEventListener('click', (event) => {
    const linkageButton = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-linkage-machine]');
    if (linkageButton) {
      void openMachineLinkage(linkageButton.dataset.linkageMachine ?? '');
      return;
    }
    const applyButton = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-apply-machine]');
    if (applyButton) {
      void applyMachineDesignCard(applyButton.dataset.applyMachine ?? '');
      return;
    }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-candidate]');
    if (!button) return;
    const input = fieldElement('agentChatInput');
    if (!input) return;
    input.value = button.dataset.candidate ?? '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    chatFeedback('已填入候选指令，按发送继续。');
  });
  body?.querySelector<HTMLTextAreaElement>('#agentChatInput')?.addEventListener('input', () => { renderPreview(); });
  body?.querySelector<HTMLInputElement>('#agentLlmApiKey')?.addEventListener('input', () => { apiKeyDirty = true; });
  body?.querySelector<HTMLTextAreaElement>('#agentChatInput')?.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void sendMessage();
    }
  });
  const advisorList = body?.querySelector<HTMLElement>('#agentAdvisorList');
  const handleAdvisorKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-advisor-ignore]')) return;
    const card = target.closest<HTMLElement>('[data-advisor-id]');
    if (!card) return;
    event.preventDefault();
    applyAdvisorSuggestion(card.dataset.advisorId ?? '');
  };
  advisorList?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const ignore = target.closest<HTMLElement>('[data-advisor-ignore]');
    if (ignore) {
      event.stopPropagation();
      ignoreAdvisorSuggestion(ignore.dataset.advisorIgnore ?? '');
      return;
    }
    const card = target.closest<HTMLElement>('[data-advisor-id]');
    if (card) applyAdvisorSuggestion(card.dataset.advisorId ?? '');
  });
  advisorList?.addEventListener('keydown', handleAdvisorKey);
}

async function refresh(): Promise<void> {
  if (!body) return;
  if (refreshButton) refreshButton.disabled = true;
  body.innerHTML = '<div class="acp-empty">正在读取智能体状态…</div>';
  try {
    if (!window.desktop) throw new Error('智能体面板仅在桌面版可用');
    const [info, config, chat, appearance, lan] = await Promise.all([
      window.desktop.agent.info() as Promise<AgentInfo>,
      window.desktop.agent.getLlmConfig(),
      window.desktop.agent.chat.history(),
      window.desktop.appearance.get(),
      window.desktop.agent.lan.get()
    ]);
    infoState = info;
    llmState = config;
    appearanceState = appearance;
    lanState = lan;
    applyAppearance(appearance);
    messages = Array.isArray(chat.messages) ? chat.messages : [];
    renderShell();
    void loadAudit();
    void refreshAdvisor();
  } catch (error) {
    infoState = { error: `读取智能体状态失败：${errorMessage(error)}` };
    body.innerHTML = `<div class="acp-status is-on is-error">${escapeHtml(infoState.error ?? '')}</div>
      <div class="acp-note">请检查主进程日志与 7420 端口占用情况。密钥只保存在本机 userData 中。</div>`;
  } finally {
    if (refreshButton) refreshButton.disabled = false;
  }
}

export function initAgentPanel(): void {
  if (drawer) return;
  ensurePanelStyles();
  disposeProgress?.();
  disposeProgress = window.desktop?.agent.onProgress?.(applyProgress) ?? null;
  buildEntryButton('agentEntryButton', '智能体', AGENT_ICON, () => {
    if (!drawer) return;
    drawer.open();
    void refresh();
  });
  drawer = createDrawer('agentDrawer', '智能体', '对话 · 工具调用 · 模型设置');
  body = drawer.body;
  drawer.footer.innerHTML = '<button type="button" class="acp-btn acp-btn-primary" id="agentRefresh">刷新</button><span class="acp-pill">LLM 工具调用</span><span class="acp-pill">密钥仅主进程</span>';
  refreshButton = drawer.footer.querySelector<HTMLButtonElement>('#agentRefresh');
  refreshButton?.addEventListener('click', () => { void refresh(); });
  renderShell();
}
