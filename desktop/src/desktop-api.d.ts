type DesktopUpdateChannel = 'stable' | 'beta';
type DesktopUpdateStatus = 'disabled' | 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';

interface DesktopUpdateSnapshot {
  status: DesktopUpdateStatus;
  currentVersion: string;
  channel: DesktopUpdateChannel;
  availableVersion?: string;
  releaseName?: string;
  releaseNotes?: string;
  progress?: { percent: number; transferred: number; total: number; bytesPerSecond: number };
  message: string;
}

interface DesktopVersion {
  app: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
}

/** 机型库索引项（主进程 `library:list` 的条目形状，与 src/machine/library.ts 一致）。 */
interface MachineLibraryEntryInfo {
  id: string;
  name: string;
  version: string;
  updatedAt: string;
  sizeBytes: number;
  source: 'local' | 'remote' | string;
}

/** 机型库 IPC 的失败形状：只有码与给用户看的文案，没有堆栈。 */
interface MachineLibraryIpcFailure {
  ok: false;
  code: string;
  message: string;
  hint?: string;
}

interface DesktopPackInfo {
  id: string;
  name: string;
  vendor: string;
  version: string;
  description?: string;
  license?: string;
  enabled: boolean;
  builtin: boolean;
  partCount: number;
  categories: string[];
  error?: string;
}

interface DesktopComponentPart {
  symbol?: string;
  dims?: { w: number; h: number; d: number; source?: string; estimated?: true };
  railMount?: boolean;
  moduleWidth?: number;
  id: string;
  model: string;
  category: string;
  vendor?: string;
  specs: Record<string, string | number>;
  asset?: string;
  thumbnail?: string;
  price?: number;
  packId?: string;
  packName?: string;
}

interface DesktopFactoryResult<T> {
  ok: boolean;
  data?: T;
  code?: string;
  message?: string;
}

interface DesktopFactoryStatusInfo {
  kind: 'demo' | 'opcua' | 'mqtt' | null;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  config?: Record<string, unknown>;
  connectedAt?: string;
  error?: string;
}

interface DesktopTagNode {
  id: string;
  name: string;
  kind?: 'station' | 'folder' | 'tag';
  dataType?: 'boolean' | 'number' | 'string' | 'unknown';
  unit?: string;
  writable?: boolean;
  station?: string;
  children?: DesktopTagNode[];
}

interface DesktopTagValue {
  id: string;
  value: unknown;
  quality: 'good' | 'bad' | 'uncertain';
  timestamp: string;
  dataType?: 'boolean' | 'number' | 'string' | 'unknown';
  unit?: string;
}

type DesktopPlcKind = 'sim' | 'modbus';
type DesktopPlcStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
type DesktopPlcValue = boolean | number;

interface DesktopPlcPoint {
  id: string;
  name: string;
  area: 'coil' | 'discrete' | 'holding' | 'input';
  address: number;
  dataType: 'bool' | 'int16' | 'uint16';
  writable?: boolean;
  unit?: string;
}

interface DesktopPlcConfig {
  kind: DesktopPlcKind;
  host?: string;
  port?: number;
  unitId?: number;
  points: DesktopPlcPoint[];
  pollMs?: number;
  rules?: Array<Record<string, unknown>>;
  initialValues?: Record<string, DesktopPlcValue>;
}

interface DesktopPlcStatusInfo {
  kind: DesktopPlcKind | null;
  status: DesktopPlcStatus;
  config?: DesktopPlcConfig;
  connectedAt?: string;
  error?: string;
}

interface DesktopSyncPublicConfig {
  baseUrl: string;
  deviceId: string;
  projectId: string;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyMasked: string;
}

interface DesktopSyncResult {
  ok: boolean;
  code?: string;
  packageId?: string;
  version?: number;
  duplicated?: boolean;
  message?: string;
  stage?: '打包' | '连接' | '上传' | '解析';
}

interface DesktopSyncPackageSummary {
  packageId: string;
  projectId: string;
  version: number;
  bomSha256: string;
  createdAt: string;
  uploadedBy?: string;
}

interface DesktopSyncListResult {
  ok: boolean;
  items?: DesktopSyncPackageSummary[];
  message?: string;
}

interface DesktopSyncDiffResult {
  ok: boolean;
  diff?: {
    base: { packageId: string; version: number };
    bomAdded: unknown[];
    bomRemoved: unknown[];
    bomChanged: unknown[];
    filesAdded: string[];
    filesChanged: string[];
    filesRemoved: string[];
  };
  message?: string;
}

interface DesktopSyncUploadPayload {
  projectName: string;
  bomCsv: string | Uint8Array;
  reportHtml: string;
  glb: Uint8Array;
  dxf: string | Uint8Array;
  bom: Array<{ no: number; name: string; spec: string; qty: number; mat: string; remark?: string }>;
  plc?: {
    target: 'generic' | 's7-1200' | 's7-1500' | 'codesys';
    generatedVersion: string;
    machineId: string;
    programFiles: Array<{ path: string; content: string }>;
    mappingCsv: string;
  };
}

interface DesktopSyncDownloadCandidateResult {
  ok: boolean;
  candidate?: {
    manifest: unknown;
    plc?: {
      target: 'generic' | 's7-1200' | 's7-1500' | 'codesys';
      generatedVersion: string;
      machineId: string;
      programFiles: Array<{ path: string; content: string }>;
      mappingCsv: string;
    };
    machineContextStatus: 'not-applicable' | 'unavailable' | 'matched';
    requiresExplicitApply: true;
  };
  bytes?: number;
  sha256?: string;
  etag?: string;
  message?: string;
  stage?: '下载' | '解析';
  code?: string;
}

type DesktopParametricStatus = 'stopped' | 'starting' | 'ready' | 'unavailable' | 'crashed';

interface DesktopParametricStatusInfo {
  status: DesktopParametricStatus;
  message: string;
  version?: string;
}

interface DesktopParametricStartResult extends DesktopParametricStatusInfo {
  ok: boolean;
  code?: 'MODULE_DISABLED';
}

interface DesktopParametricBuildResult {
  ok: boolean;
  code?: 'MODULE_DISABLED' | 'UNAVAILABLE' | 'TIMEOUT' | 'BUILD_FAILED';
  message?: string;
  stats?: Record<string, unknown>;
  buildMs?: number;
  files?: Record<string, unknown>;
}

interface DesktopFreecadInfo {
  available: boolean;
  path: string | null;
  version: string | null;
  source: 'configured' | 'env' | 'detected' | null;
  reason: string;
  installHint: string;
  checkedAt: string | null;
}

type DesktopDrawingFormat = 'pdf' | 'dxf' | 'svg' | 'fcstd';

interface DesktopDrawingsFailure {
  ok: false;
  code: string;
  message: string;
  info?: DesktopFreecadInfo;
}

interface DesktopDrawingPartResult {
  partId: string;
  ok: boolean;
  files: Partial<Record<DesktopDrawingFormat, string>>;
  warnings: string[];
  error?: string;
  paper?: string;
  scale?: string;
}

interface DesktopDrawingJobSnapshot {
  jobId: string;
  label: string;
  state: 'queued' | 'preparing' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'timeout';
  total: number;
  done: number;
  currentPartId: string | null;
  message: string;
  createdAt: string;
  finishedAt: string | null;
  outcome?: {
    jobId: string;
    state: string;
    message: string;
    freecadVersion?: string;
    parts: Array<{ part: { partKey: string; partId: string; name: string }; result: DesktopDrawingPartResult; stepSha256?: string }>;
    stderrTail: string;
    durationMs: number;
  };
}

interface DesktopDrawingManifestEntry {
  partKey: string;
  partId: string;
  name: string;
  fingerprint: string;
  geometryHash: string;
  fileStem: string;
  files: Partial<Record<DesktopDrawingFormat, string>>;
  stepSha256?: string;
  paper?: string;
  scale?: string;
  bbox?: [number, number, number];
  warnings: string[];
  generatedAt: string;
  freecadVersion?: string;
  scriptVersion: string;
  jobId: string;
  lastError?: string;
}

interface DesktopDrawingManifest {
  schemaVersion: 1;
  projectKey: string;
  updatedAt: string;
  entries: Record<string, DesktopDrawingManifestEntry>;
}

interface DesktopDrawingsGenerateRequest {
  projectKey: string;
  doc: unknown;
  instanceIds?: string[];
  onlyStale?: boolean;
  meta?: Record<string, { material?: string; drawingNo?: string; scale?: string; paper?: 'auto' | 'A4' | 'A3' }>;
  titleBlock?: { designer?: string; company?: string; date?: string };
  options?: { formats?: DesktopDrawingFormat[]; paper?: 'auto' | 'A4' | 'A3'; scale?: string; iso?: boolean; hiddenLines?: boolean };
}

interface DesktopAgentToolInfo {
  name: string;
  description: string;
}

interface DesktopAgentHistoryEntry {
  name: string;
  at: string;
  ok: boolean;
}

interface DesktopAgentInfo {
  host?: string;
  port?: number;
  url?: string;
  tokenFile?: string;
  toolCount?: number;
  tools?: DesktopAgentToolInfo[];
  history?: DesktopAgentHistoryEntry[];
  lanAddress?: string | null;
  error?: string;
}

interface DesktopRenderStats {
  glRenderer: string;
  isSoftware: boolean;
  pixelRatio: number;
  quality: 'flow' | 'standard' | 'high';
  partCount: number;
  triangleCount: number;
  dragFrames: number;
  dragAvgFrameMs: number;
  dragMaxFrameMs: number;
  dragDroppedFrames: number;
  lastDragAt: string | null;
}

interface DesktopAgentLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxIterations: number;
  hasApiKey: boolean;
}

interface DesktopAgentToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface DesktopAgentChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: DesktopAgentToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface DesktopAgentTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 端点未回传 usage 时为 true（按字符数估算）。 */
  estimated: boolean;
  requests: number;
}

interface DesktopAgentCostView {
  known: boolean;
  currency: string;
  amount: number | null;
  /** 已知模型 "¥0.0000"，未知模型 "—"。 */
  display: string;
}

interface DesktopAgentUsage {
  model: string;
  turn: DesktopAgentTokenUsage;
  session: DesktopAgentTokenUsage;
  cost: {
    turn: DesktopAgentCostView;
    session: DesktopAgentCostView;
  };
  budget?: {
    used: number;
    dropped: Array<{ section: string; reason: string; code: string }>;
  };
}

interface DesktopAgentChatOutcome {
  iterations: number;
  budget: { base: number; effective: number; reason: string };
  /** 被预算截断 / 只读空转提前收尾；未截断时缺省。 */
  stopped?: 'iteration_limit' | 'repeated_reads';
  /** 截断后「继续」该补的那一步（≤200 字）。 */
  pendingHint?: string;
  /** 人能直接读的一行结论，仅在 stopped 存在时出现。 */
  continueHint?: string;
  /** 点【继续】时该发的原文，仅在 stopped 存在时出现。 */
  nextAction?: string;
}

interface DesktopAgentChatResult {
  ok: boolean;
  reply?: string;
  message?: string;
  cancelled?: boolean;
  completedSteps?: AgentCompletedStep[];
  /** 本轮走的通道：在线模型 / 离线规则（P7-A-2 统一回执） */
  mode?: 'online' | 'offline';
  elapsedMs?: number;
  /** 本轮/本会话 tokens 与估算费用。 */
  tokens?: DesktopAgentUsage;
  /**
   * 本轮收尾信息（预算 / 停止原因 / pendingHint）。可选：旧主进程不发这个字段，
   * 界面按「没有提示」处理。`stopped` 存在时另带 `continueHint` 与 `nextAction`。
   */
  outcome?: DesktopAgentChatOutcome;
  messages: DesktopAgentChatMessage[];
}

interface DesktopAgentPlanStep {
  tool: string;
  args: Record<string, unknown>;
  why: string;
  readOnly: boolean;
  missing?: string[];
}

interface DesktopAgentPlan {
  steps: DesktopAgentPlanStep[];
  confidence: number;
  refused?: boolean;
  reason?: string;
  suggestions?: string[];
  warnings?: string[];
}

interface DesktopAgentPlanStepResult {
  index: number;
  step: number;
  tool: string;
  ok: boolean;
  code: string;
  message?: string;
  elapsedMs: number;
  data?: unknown;
}

interface DesktopAgentPlanExecuteResult {
  ok: boolean;
  confirmationRequired: boolean;
  confirmed: boolean;
  confirmOutcome?: 'allowed' | 'denied' | 'timeout' | 'aborted' | 'unavailable' | 'error';
  cancelled?: boolean;
  refused?: boolean;
  resumedFrom?: number;
  skippedSteps?: number;
  stale?: boolean;
  changed?: string[];
  failedAt?: number;
  failedIndex?: number;
  failedTool?: string;
  results: DesktopAgentPlanStepResult[];
  totalMs: number;
  summary: string;
  undoHint?: string;
}

interface DesktopAgentRecipeStepResult {
  index: number;
  step: number;
  stepId: string;
  title: string;
  tool: string;
  ok: boolean;
  skipped: boolean;
  code: string;
  message?: string;
  elapsedMs: number;
  args?: Record<string, unknown>;
  data?: unknown;
  suggestion?: string;
}

interface DesktopAgentDesignReviewItem {
  area: '结构' | '干涉' | '电气' | '成本';
  status: 'pass' | 'warn' | 'fail' | 'na';
  title: string;
  evidence: string;
  suggestion: string;
}

/** 汇总器结论：`review-design` 配方为设计评审（条款见 src/agent/design-review.ts）。 */
interface DesktopAgentDesignReview {
  verdict: 'PASS' | 'WARN' | 'FAIL';
  items: DesktopAgentDesignReviewItem[];
  summary: string;
}

interface DesktopAgentRecipeRunResult {
  ok: boolean;
  code: string;
  recipeId: string;
  recipeTitle: string;
  runId: string;
  results: DesktopAgentRecipeStepResult[];
  completed: DesktopAgentRecipeStepResult[];
  kept: DesktopAgentRecipeStepResult[];
  skipped: DesktopAgentRecipeStepResult[];
  failedStep?: DesktopAgentRecipeStepResult;
  failedAt?: number;
  failedTool?: string;
  errorCode?: string;
  suggestion?: string;
  missing?: string[];
  suggestions?: string[];
  preconditionFailed?: boolean;
  totalMs: number;
  summary: string;
  report: string;
  confirmations?: number;
  /** `onError:'collect'` 时收集到的失败步骤（流程没中断，结论看 aggregate）。 */
  stepFailures?: DesktopAgentRecipeStepResult[];
  /** 汇总器输出；设计评审为 DesktopAgentDesignReview。 */
  aggregate?: DesktopAgentDesignReview | unknown;
  error?: { code: string; message: string; missing?: string[]; suggestions?: string[] };
}

interface DesktopAgentAuditEntry {
  at: string;
  tool: string;
  ok: boolean;
  code?: string;
  source?: 'llm' | 'offline' | 'rpc' | 'mcp' | 'plan' | 'recipe';
  args?: Record<string, unknown>;
  message?: string;
  elapsedMs?: number;
  cacheHit?: boolean;
}

interface DesktopAgentAuditResult {
  ok: boolean;
  entries?: DesktopAgentAuditEntry[];
  /** 文件中的总条数；entries 只保留最近 200 条。 */
  total?: number;
  /** 因 200 条上限而丢弃的更早记录数。 */
  dropped?: number;
  summary?: {
    total: number;
    failed: number;
    tools: Record<string, number>;
    lastAt: string | null;
  };
  message?: string;
}

interface DesktopAgentLlmTestResult {
  ok: boolean;
  message: string;
  model?: string;
}

interface AgentCompletedStep {
  step: number;
  tool: string;
  ok: boolean;
  code?: string;
  wrote: boolean;
}

interface DesktopAgentProgressEvent {
  runId: string;
  phase: 'start' | 'end' | 'skip';
  index: number;
  total: number;
  tool: string;
  argsSummary: string;
  startedAt: number;
  callId?: string;
  stepId?: string;
  title?: string;
  elapsedMs?: number;
  ok?: boolean;
  code?: string;
  message?: string;
  source?: 'chat' | 'plan' | 'recipe';
  cacheHit?: boolean;
}

interface AgentBridgeFailure {
  ok: false;
  message: string;
}

interface AgentBridgeScenePart {
  name: string;
  triangles: number;
  bbox: { min: number[]; max: number[] };
}

interface AgentBridgeBomRow {
  no: number;
  name: string;
  spec: string;
  qty: number;
  mat: string;
  note?: string;
  partId?: string;
}

interface AgentKinematicsSuggestBridgeResult {
  sourceFile: string;
  meshes: number;
  existingParts: number;
  summary: string;
  stats: { meshes: number; classified: number; groups: number; high: number; low: number; skipped: number };
  suggestions: import('./cad/kinematics-auto').KinematicsSuggestion[];
  lowConfidence: import('./cad/kinematics-auto').KinematicsSuggestion[];
  skipped: { name: string; reason: string }[];
}

interface AgentBridgeApi {
  ready(): boolean;
  getScene(): { parts: AgentBridgeScenePart[]; source: string | null } | AgentBridgeFailure;
  getSelection(): { name: string; bbox: number[] } | AgentBridgeFailure | null;
  getBom(): AgentBridgeBomRow[] | AgentBridgeFailure;
  getSceneParts(): import('./mech/interference').InterferencePart[];
  appendMachineBomRows(payload: unknown): { ok: boolean; added?: number; total?: number; message?: string } | Promise<{ ok: boolean; added?: number; total?: number; message?: string }>;
  applyMachineConfig(payload: unknown): { ok: boolean; message?: string };
  getPlcGenConfig(): import('./plcgen/types').PlcGenConfig | AgentBridgeFailure | null;
  getProjectContext(): {
    domain: string | null;
    view: string | null;
    selection: {
      kind: 'component' | 'mesh' | 'placement' | 'feature';
      id: string;
      label: string;
      name?: string;
      bbox?: number[];
    } | null;
    machine: { id: string; name: string; stations: number; actuators: number; sensors: number } | null;
    plate: {
      width: number;
      height: number;
      rails: unknown[];
      placed?: number;
      overlaps?: number;
      placements?: Array<{
        id: string;
        partId: string;
        model: string;
        x: number;
        y: number;
        w: number;
        h: number;
        tag?: string;
      }>;
    } | null;
    units: string | null;
    recentActions?: Array<{ tool?: string; name?: string; summary?: string; at: string }>;
  } | AgentBridgeFailure;
  /** 完整项目状态的 SHA-256 摘要；不可读取或无法摘要时返回 null。 */
  getProjectCheckpointFingerprint(): Promise<string | null>;
  getAdvisorState(): import('./agent/advisor').AdvisorProjectState | AgentBridgeFailure;
  markPlcGenerated(): { ok: boolean };
  /** 当前电气图纸的校验数据（与电气域画布、__ElecDocProvider 同源）；Agent run_electrical_check 不传数据时用 */
  getElecDocument?(): { ok: true; document: import('./elec/check').ElecDocument; source: Record<string, unknown> } | AgentBridgeFailure;
  insertComponent(part: {
    id: string;
    model: string;
    vendor?: string;
    category: string;
    /** 真实外形（mm）：渲染层按此建占位盒，缺项回落 20mm 方块。 */
    dimsMm?: { w: number; h: number; d: number };
  }): { ok: boolean; meshIndex?: number; name?: string; message?: string };
  removeComponent(meshIndex: number): { ok: boolean; message?: string };
  placeEnclosurePart(payload: {
    partId: string;
    x: number;
    y: number;
    rotate?: boolean;
    railSnap?: boolean;
  }): Promise<
    | {
        ok: true;
        placement: { id: string; partId: string; model: string; x: number; y: number; w: number; h: number; railId?: string };
        warnings: Array<{ code: 'OVERLAP' | 'OUT_OF_BOUNDS'; message: string }>;
      }
    | { ok: false; code?: string; message: string }
  >;
  removeEnclosurePart(placementId: string): { ok: boolean; message?: string };
  updateComponent(payload: {
    target?: 'auto' | 'plate' | 'bom';
    ref?: string;
    matchPartId?: string;
    model?: string;
    newPartId?: string;
    qty?: number;
    remark?: string;
    w?: number;
    h?: number;
  }): {
    ok: boolean;
    code?: string;
    message?: string;
    location?: 'plate' | 'bom';
    targetRef?: string;
    before?: Record<string, unknown>;
    updated?: Record<string, unknown>;
  };
  removeProjectComponent(payload: {
    target?: 'auto' | 'plate' | 'bom';
    ref?: string;
    matchPartId?: string;
  }): {
    ok: boolean;
    code?: string;
    message?: string;
    location?: 'plate' | 'bom';
    targetRef?: string;
    removed?: Record<string, unknown>;
    undoToken?: string;
  };
  restoreProjectComponent(token: string): { ok: boolean; code?: string; message?: string };
  exportArtifact(payload: { kind: 'pdf' | 'dxf' | 'glb' | 'bom' }): Promise<{
    ok: boolean;
    code?: string;
    message?: string;
    kind?: string;
    data?: string;
    encoding?: 'utf8' | 'base64';
    suggestedName?: string;
  }>;
  runInterference(): { hits: number; items: { a: string; b: string; volume: number; severity: string }[] } | AgentBridgeFailure;
  /** 运动件自动识别：只生成建议并刷新标注抽屉的建议列表，从不写入标注。 */
  suggestKinematics(): AgentKinematicsSuggestBridgeResult | AgentBridgeFailure;
  importPath(path: string): Promise<{ ok: boolean; meshCount?: number; triangleCount?: number; message?: string }>;
  /** B-Rep 精确干涉（OCP 布尔，真体积）；不做 AABB 初筛。 */
  brepInterference(payload: { stepPath: string; timeoutMs?: number; maxParts?: number }): Promise<{
    ok: boolean;
    code?: string;
    message?: string;
    parts?: number;
    candidates?: number;
    checks?: number;
    hits?: Array<{ a: string; b: string; volumeMm3: number; ratio: number; severity: string }>;
    elapsedMs?: number;
    tolerances?: { volumeMm3: number; ratio: number };
  }>;
  /** 工程零件清单 CSV → userData/exports（不接任意绝对路径）。 */
  exportPartsCsv(payload: { fileName?: string; suggestedName?: string; data: string; rows?: number }): Promise<{
    ok: boolean;
    path?: string;
    bytes?: number;
    rows?: number | null;
    code?: string;
    message?: string;
  }>;
  exportCostFile(payload: {
    format: 'pdf' | 'csv';
    fileName?: string;
    overwrite?: boolean;
    data: string;
    encoding: 'base64' | 'utf8';
    suggestedName?: string;
  }): Promise<{ ok: boolean; path?: string; bytes?: number; code?: string; message?: string }>;
}

interface DesktopPlcGenHistoryFile {
  path: string;
  lines: number;
  bytes: number;
}

interface DesktopPlcGenHistoryEntry {
  at: string;
  inputHash: string;
  files: number;
  target: string;
  namePrefix: string;
  fileList: DesktopPlcGenHistoryFile[];
  zipPath?: string;
}

interface DesktopPlcGenExportResult {
  ok: boolean;
  path?: string;
  zipPath?: string;
  bytes?: number;
  files?: number;
  code?: string;
  message?: string;
}

interface DesktopModuleStatus {
  id: string;
  name: string;
  version: string;
  apiCompatibility: { min: number; max: number };
  dependencies: string[];
  requiredCapabilities: string[];
  description: string;
  kind: 'core' | 'optional';
  defaultEnabled: boolean;
  implemented: boolean;
  status: 'enabled' | 'disabled' | 'unavailable';
  enabled: boolean;
  reason: string | null;
}

interface DesktopProjectArchivePreview {
  project: {
    id: string;
    name: string;
    identity?: {
      sourceName: string;
      sourceSha256: string;
      sourceSize: number;
      modelObjects: Array<{ objectId: string; name: string; path: string[]; geometrySha256: string }>;
    };
  };
  appVersion: string;
  createdAt: string;
  schemaVersion: number;
  coreSchemaVersion: number;
  state: { featureTree: boolean; kinematics: boolean; viewState: boolean };
  omittedState: string[];
  dependencies: Array<{ originalName: string; format: string; size: number; sha256: string }>;
  integrity: { algorithm: string; scope: string; authenticity: string };
  restoreMode: 'archive-api-only';
  unsupported: string[];
}

type DesktopProjectArchiveResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'MODULE_DISABLED' | 'CANCELED' | 'FAILED'; stage?: string; message: string };

interface DesktopProjectExportSnapshot {
  projectId: string;
  sourceName: string;
  sourceSha256: string;
  sourceSize: number;
  modelObjects: Array<{ objectId: string; name: string; path: string[]; geometrySha256: string }>;
  featureTreeJson: string | null;
  kinematicsJson: string | null;
  viewStateJson: string | null;
  excludedState: string[];
}

interface DesktopAppearanceConfig {
  uiScale: number;
  renderQuality: 'flow' | 'standard' | 'high';
}

interface DesktopAgentLanAccess {
  ok: boolean;
  config: {
    enabled: boolean;
    allowlist: string[];
    cdpEnabled: boolean;
  };
  token: string;
  info: DesktopAgentInfo;
  cdpPort: number | null;
  cdpActive: boolean;
  cdpRestartRequired: boolean;
  lanAddress: string | null;
  cdpError?: string;
  message?: string;
}

type DesktopProjectGeometryReview =
  | { status: 'not-executed'; partCount: 0 }
  | { status: 'aabb-screened'; partCount: number; method: 'AABB'; sourceName?: string; checkedAt: string };

interface DesktopDesignProjectSaveInput {
  name: string;
  process: string;
  params?: Record<string, number>;
  parts: number;
  massKg?: number | null;
  envelope?: [number, number, number] | null;
  material?: string[];
  stepPath?: string | null;
  stlPath?: string | null;
  partPaths?: Array<{ name: string; path: string }>;
  design?: unknown;
  config?: unknown;
  geometryReview?: DesktopProjectGeometryReview;
  stlData?: Uint8Array;
  partData?: Array<{ name: string; data: Uint8Array; path?: string[] }>;
  placements?: unknown[];
}

interface DesktopDesignProjectRecord {
  id: string;
  name: string;
  process: string;
  params: Record<string, number>;
  parts: number;
  massKg: number | null;
  envelope: [number, number, number] | null;
  material: string[];
  createdAt: string;
  partsList: Array<{ file: string; name: string }>;
  hasStep: boolean;
  hasStl: boolean;
  bytes: number;
  design?: unknown;
  geometryReview?: DesktopProjectGeometryReview;
}

interface DesktopProjectLayoutPlacement {
  id: string;
  partId: string;
  model: string;
  x: number;
  y: number;
  w: number;
  h: number;
  railId?: string;
  tag?: string;
  qty?: number;
  note?: string;
}

interface Window {
  desktop?: {
    version(): Promise<DesktopVersion>;
    appearance: {
      get(): Promise<DesktopAppearanceConfig>;
      set(config: Partial<DesktopAppearanceConfig>): Promise<DesktopAppearanceConfig>;
    };
    update: {
      state(): Promise<DesktopUpdateSnapshot>;
      setChannel(channel: DesktopUpdateChannel): Promise<DesktopUpdateSnapshot>;
      check(): Promise<DesktopUpdateSnapshot>;
      download(): Promise<DesktopUpdateSnapshot>;
      install(): Promise<DesktopUpdateSnapshot>;
      onState(callback: (state: DesktopUpdateSnapshot) => void): () => void;
    };
    extensionBaseUrl: string | null;
    openCadDialog(): Promise<{ canceled: boolean; filePaths: string[] }>;
    readFileBuffer(path: string): Promise<Uint8Array>;
    /**
     * 打开 2D 图纸。DXF 直接返回文本；DWG 需要外部转换器（ODA / LibreDWG），
     * 失败时 `ok:false` 且 `message` 给出可执行的安装指引。
     */
    openDrawing(path: string): Promise<
      | { ok: true; text: string; converter: string | null; source: 'dxf' | 'dwg'; message?: string }
      | { ok: false; message: string; converter: null; source: 'dxf' | 'dwg' }
    >;
    getPathForFile(file: File): string;
    exportFile(name: string, data: Uint8Array | string): Promise<{ canceled: boolean; path: string | null }>;
    exportReport(payload: { html: string; projectName?: string; page?: { size?: 'A3' | 'A4'; landscape?: boolean } }): Promise<{ path: string; htmlPath: string }>;
    /** B-Rep 精确干涉（OCP 布尔，真体积）；不做 AABB 初筛。 */
  brepInterference(payload: { stepPath: string; timeoutMs?: number; maxParts?: number }): Promise<{
    ok: boolean;
    code?: string;
    message?: string;
    parts?: number;
    candidates?: number;
    checks?: number;
    hits?: Array<{ a: string; b: string; volumeMm3: number; ratio: number; severity: string }>;
    elapsedMs?: number;
    tolerances?: { volumeMm3: number; ratio: number };
  }>;
  /** 工程零件清单 CSV → userData/exports（不接任意绝对路径）。 */
  exportPartsCsv(payload: { fileName?: string; suggestedName?: string; data: string; rows?: number }): Promise<{
    ok: boolean;
    path?: string;
    bytes?: number;
    rows?: number | null;
    code?: string;
    message?: string;
  }>;
  exportCostFile(payload: {
      format: 'pdf' | 'csv';
      fileName?: string;
      overwrite?: boolean;
      data: Uint8Array | string;
      suggestedName?: string;
    }): Promise<{ ok: boolean; path?: string; bytes?: number; code?: string; message?: string }>;
    cost: {
      pricebook(): Promise<{
        ok: boolean;
        code?: string;
        message?: string;
        book?: unknown;
        path?: string;
        currency?: string;
        updatedAt?: string;
        usableItems?: number;
        exampleItems?: number;
      }>;
      exportPanelPdf(payload: { html: string; projectName?: string; page?: { size?: 'A3' | 'A4'; landscape?: boolean } }): Promise<{
        ok: boolean;
        path?: string;
        htmlPath?: string;
        code?: string;
        message?: string;
      }>;
      exportPanelCsv(payload: { name: string; data: string }): Promise<{
        ok?: boolean;
        canceled?: boolean;
        path?: string | null;
        code?: string;
        message?: string;
      }>;
    };
    machine: {
      active(): Promise<{ ok: boolean; design?: unknown; message?: string }>;
      ioMap(): Promise<{
        ok: boolean;
        message?: string;
        machine?: { id: string; name: string; stations: number; actuators: number; sensors: number };
        rows?: Array<{
          point: string;
          address: string;
          direction: '输入' | '输出';
          ownerType: string;
          owner: string;
          type: string;
          station: string;
          comment: string;
        }>;
        csv?: string;
      }>;
    };
    packs: {
      list(): Promise<DesktopPackInfo[]>;
      chooseZip(): Promise<{ canceled: boolean; filePaths: string[] }>;
      importZip(path: string): Promise<DesktopPackInfo>;
      setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean }>;
      remove(id: string): Promise<{ ok: boolean }>;
      listParts(filter?: { q?: string; category?: string; packId?: string }): Promise<DesktopComponentPart[]>;
    };
    design: {
      settings(): Promise<{ ok: boolean; message?: string; pricing?: import('./machine/cost-model').MachinePricingLoad; builtinPricebook?: import('./cost/pricebook').Pricebook }>;
      loadDraft(): Promise<{ draft: unknown | null; recovered: boolean }>;
      saveDraft(draft: unknown): Promise<{ ok: boolean; message?: string }>;
      clearDraft(): Promise<{ ok: boolean }>;
    };
    /** 画布工作台草稿（userData/canvas-workbench-draft.json，0600，1.5MB 上限）。 */
    canvasDraft: {
      load(): Promise<{ draft: unknown | null; recovered: boolean; path: string }>;
      save(draft: unknown): Promise<{ ok: boolean; path?: string; bytes?: number; message?: string }>;
      clear(): Promise<{ ok: boolean }>;
    };
    /** 手工询价覆盖（userData/canvas-price-overrides.json，0600，256KB 上限）。 */
    canvasPricing: {
      load(): Promise<{ book: unknown | null; recovered: boolean; path: string }>;
      save(book: unknown): Promise<{ ok: boolean; path?: string; bytes?: number; message?: string }>;
      clear(): Promise<{ ok: boolean }>;
    };
    /** 画布方案库（userData/canvas-schemes.json，0600，4MB 上限）。 */
    canvasSchemes: {
      load(): Promise<{ library: unknown | null; recovered: boolean; path: string }>;
      save(library: unknown): Promise<{ ok: boolean; path?: string; bytes?: number; message?: string }>;
    };
    projects: {
      list(): Promise<DesktopDesignProjectRecord[]>;
      save(payload: DesktopDesignProjectSaveInput): Promise<{ ok: boolean; record?: DesktopDesignProjectRecord; message?: string }>;
      open(id: string): Promise<{ ok: boolean; record?: DesktopDesignProjectRecord; placements?: DesktopProjectLayoutPlacement[]; layoutEditable?: boolean; layoutFingerprint?: string; layoutMessage?: string; partPaths?: Array<{ name: string; path: string }>; stepPath?: string | null; message?: string }>;
      saveLayout(payload: { id: string; fingerprint: string; placements: DesktopProjectLayoutPlacement[] }): Promise<{ ok: boolean; conflict?: boolean; fingerprint?: string; message?: string }>;
      remove(id: string): Promise<{ ok: boolean; message?: string }>;
    };
    projectArchive: {
      exportProject(snapshot: DesktopProjectExportSnapshot): Promise<DesktopProjectArchiveResult<{
        path: string;
        bytes: number;
        sha256: string;
        projectName: string;
        dependencyName: string;
        projectId: string;
        includedState: { featureTree: boolean; kinematics: boolean; viewState: boolean };
        excludedState: string[];
      }>>;
      preview(): Promise<DesktopProjectArchiveResult<DesktopProjectArchivePreview>>;
    };
    modules: {
      syncPlcgenEnabled(enabled: boolean): boolean;
      syncElecValidationEnabled(enabled: boolean): boolean;
      syncCostEstimationEnabled(enabled: boolean): boolean;
      syncFactoryPlcSyncEnabled(enabled: boolean): boolean;
      syncParametricImportEnabled(enabled: boolean): boolean;
      syncAgentResumeEnabled(enabled: boolean): boolean;
      syncProjectPortableEnabled(enabled: boolean): boolean;
      syncSystemUpdateEnabled(enabled: boolean): boolean;
      syncDrawingsTechdrawEnabled?(enabled: boolean): boolean;
    };
    agent: {
      info(): Promise<DesktopAgentInfo>;
      /** 写操作确认请求（主进程 → 渲染进程）；返回取消订阅函数。 */
      onConfirmWrite(handler: (payload: { id: string; tool: string; summary: string; detail?: string; bypassNotice?: string }) => void): () => void;
      /** 回答写确认；remember=true 表示本会话内同名工具不再询问。 */
      replyConfirmWrite(payload: { id: string; allow: boolean; remember?: boolean }): void;
      getLlmConfig(): Promise<DesktopAgentLlmConfig>;
      saveLlmConfig(config: Record<string, unknown>): Promise<DesktopAgentLlmConfig>;
      testLlm(config?: Record<string, unknown>): Promise<DesktopAgentLlmTestResult>;
      chat: {
        send(text: string): Promise<DesktopAgentChatResult>;
        cancel(): Promise<{ ok: boolean; cancelled: boolean; message?: string }>;
        history(): Promise<{ ok: boolean; messages: DesktopAgentChatMessage[] }>;
        clear(): Promise<{ ok: boolean; messages: DesktopAgentChatMessage[] }>;
      };
      plan: {
        execute(payload: {
          plan: DesktopAgentPlan;
          startAt?: number;
          maxSteps?: number;
          resumeFrom?: number;
          resume?: boolean;
        }): Promise<DesktopAgentPlanExecuteResult>;
        restore(payload: { plan: DesktopAgentPlan }): Promise<{
          ok: boolean;
          available: boolean;
          disabled?: boolean;
          blocked?: boolean;
          requiresReplan?: boolean;
          message?: string;
          cursor?: number;
          steps?: Array<{ index: number; tool: string; wrote: boolean; state: 'pending' | 'running' | 'completed' | 'failed' | 'uncertain' }>;
          needsReconfirmation?: boolean;
        }>;
        clearCheckpoint(): Promise<{ ok: boolean; code?: string; message?: string }>;
        cancel(): Promise<{ ok: boolean; cancelled: boolean; message?: string }>;
      };
      recipe: {
        execute(payload: {
          recipeId: string;
          context?: Record<string, unknown>;
          skipSteps?: string[];
          rememberSameKind?: boolean;
        }): Promise<DesktopAgentRecipeRunResult>;
        cancel(): Promise<{ ok: boolean; cancelled: boolean; message?: string }>;
      };
      onProgress(callback: (progress: DesktopAgentProgressEvent) => void): () => void;
      audit: {
        read(): Promise<DesktopAgentAuditResult>;
      };
      lan: {
        get(): Promise<DesktopAgentLanAccess>;
        save(config: { enabled: boolean; allowlist: string[] | string; cdpEnabled: boolean }): Promise<DesktopAgentLanAccess>;
        rotateToken(): Promise<DesktopAgentLanAccess>;
      };
    };
    render: {
      stats(stats: DesktopRenderStats): Promise<{ ok: boolean; message?: string }>;
    };
    drawings?: {
      freecadStatus(): Promise<{ ok: true; info: DesktopFreecadInfo } | DesktopDrawingsFailure>;
      detectFreecad(): Promise<{ ok: true; info: DesktopFreecadInfo } | DesktopDrawingsFailure>;
      chooseFreecadPath(): Promise<{ ok: true; info: DesktopFreecadInfo } | DesktopDrawingsFailure>;
      setFreecadPath(path: string | null): Promise<{ ok: true; info: DesktopFreecadInfo } | DesktopDrawingsFailure>;
      generate(request: DesktopDrawingsGenerateRequest): Promise<
        | { ok: true; jobId: string; partKeys: string[]; skipped: Array<{ instanceId: string; name: string; reason: string }>; warnings: string[] }
        | DesktopDrawingsFailure
      >;
      cancel(jobId: string): Promise<{ ok: boolean }>;
      jobs(): Promise<{ ok: true; jobs: DesktopDrawingJobSnapshot[] } | DesktopDrawingsFailure>;
      list(projectKey: string): Promise<{ ok: true; projectKey: string; directory: string; manifest: DesktopDrawingManifest } | DesktopDrawingsFailure>;
      open(projectKey: string, partKey: string, format: DesktopDrawingFormat): Promise<{ ok: true } | DesktopDrawingsFailure>;
      reveal(projectKey: string, partKey?: string): Promise<{ ok: true } | DesktopDrawingsFailure>;
      onJob(callback: (snapshot: DesktopDrawingJobSnapshot) => void): () => void;
    };
    parametric: {
      status(): Promise<DesktopParametricStatusInfo>;
      start(): Promise<DesktopParametricStartResult>;
      build(doc: unknown, options?: { perPart?: boolean }): Promise<DesktopParametricBuildResult>;
      stop(): Promise<DesktopParametricStatusInfo>;
      onStatus(callback: (status: DesktopParametricStatusInfo) => void): () => void;
    };
    factory: {
      info(): Promise<unknown>;
      status(): Promise<DesktopFactoryResult<DesktopFactoryStatusInfo>>;
      list(): Promise<DesktopFactoryResult<{ kind: string; label: string }[]>>;
      getConfig(): Promise<DesktopFactoryResult<Record<string, unknown> | null>>;
      connect(config: unknown): Promise<DesktopFactoryResult<DesktopFactoryStatusInfo>>;
      disconnect(): Promise<DesktopFactoryResult<DesktopFactoryStatusInfo>>;
      browse(nodeId?: string): Promise<DesktopFactoryResult<DesktopTagNode[]>>;
      readTags(ids: string[]): Promise<DesktopFactoryResult<Record<string, DesktopTagValue>>>;
      writeTag(id: string, value: unknown): Promise<DesktopFactoryResult<null>>;
      subscribe(ids: string[]): Promise<DesktopFactoryResult<string[]>>;
      onValues(callback: (value: DesktopTagValue) => void): () => void;
      onStatus(callback: (status: DesktopFactoryStatusInfo) => void): () => void;
    };
    plc: {
      info(): Promise<unknown>;
      status(): Promise<DesktopFactoryResult<DesktopPlcStatusInfo>>;
      list(): Promise<DesktopFactoryResult<{ kind: DesktopPlcKind; label: string }[]>>;
      getConfig(): Promise<DesktopFactoryResult<DesktopPlcConfig | null>>;
      connect(config: DesktopPlcConfig): Promise<DesktopFactoryResult<DesktopPlcStatusInfo>>;
      disconnect(): Promise<DesktopFactoryResult<DesktopPlcStatusInfo>>;
      read(id: string): Promise<DesktopFactoryResult<DesktopPlcValue>>;
      readAll(): Promise<DesktopFactoryResult<Record<string, DesktopPlcValue>>>;
      write(id: string, value: DesktopPlcValue): Promise<DesktopFactoryResult<null>>;
      force(id: string, value: DesktopPlcValue): Promise<DesktopFactoryResult<null>>;
      onValues(callback: (values: Record<string, DesktopPlcValue>) => void): () => void;
      onStatus(callback: (status: DesktopPlcStatusInfo) => void): () => void;
    };
    plcgen: {
      history(): Promise<DesktopPlcGenHistoryEntry[]>;
      recordHistory(entry: DesktopPlcGenHistoryEntry): Promise<DesktopPlcGenHistoryEntry[] | { ok: false; code: 'MODULE_DISABLED'; message: string }>;
      exportProject(payload: {
        machineName: string;
        namePrefix?: string;
        target?: string;
        files: Array<{ path: string; content: string }>;
      }): Promise<DesktopPlcGenExportResult>;
      openExportDir(directory?: string): Promise<{ ok: boolean; path: string; message?: string }>;
    };
    sync: {
      getConfig(): Promise<DesktopSyncPublicConfig>;
      saveConfig(config: Record<string, unknown>): Promise<DesktopSyncPublicConfig>;
      test(): Promise<DesktopSyncResult>;
      upload(payload: DesktopSyncUploadPayload): Promise<DesktopSyncResult>;
      list(): Promise<DesktopSyncListResult>;
      diff(packageId: string): Promise<DesktopSyncDiffResult>;
      downloadCandidate(packageId: string, machineContext?: unknown): Promise<DesktopSyncDownloadCandidateResult>;
    };
    onNewDesign(callback: () => void): () => void;
    onOpenCad(callback: (payload: { path: string; source: string }) => void): () => void;
    onImportPack(callback: (payload: { path: string }) => void): () => void;
    onSetDomain(callback: (domain: 'mech' | 'elec') => void): () => void;
  };
  __ModuleRegistry?: {
    list(): DesktopModuleStatus[];
    getStatus(id: string): DesktopModuleStatus;
    setEnabled(id: string, enabled: boolean): DesktopModuleStatus[];
  };
  __AgentBridge?: AgentBridgeApi;
  /**
   * 机型库（preload 暴露，见 electron/preload.ts）。只有动作，没有 fs/path：
   * 导入导出时的文件选择与读写全在主进程。
   */
  __machineLibrary?: {
    list(): Promise<
      | { ok: true; entries: MachineLibraryEntryInfo[] }
      | MachineLibraryIpcFailure
    >;
    apply(id: string): Promise<{ ok: true; entry: MachineLibraryEntryInfo; design: unknown } | MachineLibraryIpcFailure>;
    importPackage(options?: { overwrite?: boolean }): Promise<
      | { ok: true; cancelled?: boolean; overwritten?: boolean; entry?: MachineLibraryEntryInfo }
      | MachineLibraryIpcFailure
    >;
    exportPackage(id: string): Promise<{ ok: true; cancelled?: boolean; path?: string; bytes?: number } | MachineLibraryIpcFailure>;
    remove(id: string): Promise<{ ok: true; entry?: MachineLibraryEntryInfo } | MachineLibraryIpcFailure>;
    /** 远程来源与可下载机型（只读；URL 与字节都在主进程） */
    sources(): Promise<
      | {
          ok: true;
          sources: Array<{
            id: string;
            name: string;
            url: string;
            enabled: boolean;
            allowFile: boolean;
            online: boolean;
            stale: boolean;
            machineCount: number;
            fetchedAt: string | null;
            errorCode?: string;
            errorMessage?: string;
          }>;
          machines: Array<{
            sourceId: string;
            sourceName: string;
            id: string;
            name: string;
            version: string;
            sizeBytes: number;
            sha256: string;
            minAppVersion?: string;
            tags?: string[];
            stale: boolean;
            installed: boolean;
          }>;
          stale: boolean;
        }
      | MachineLibraryIpcFailure
    >;
    /** 远程下载并入库；同名返回 LIBRARY_EXISTS（没有 overwrite 通道） */
    download(sourceId: string, machineId: string): Promise<
      | { ok: true; entry: MachineLibraryEntryInfo; bytes: number; sha256: string; stale: boolean; sourceId: string; sourceName: string }
      | MachineLibraryIpcFailure
    >;
  };
  __Commission3D?: {
    stats(): {
      frames: number;
      ticks: number;
      parts: number;
      stations: number;
      sensors: number;
      actuators: number;
      webgl: boolean;
      enabled: boolean;
      active: boolean;
    };
    update(values: Record<string, boolean | number>): void;
    highlight(pointId: string, on: boolean): void;
    kinematicsMode(): {
      mode: 'annotation' | 'config';
      reason: string;
      parts: number;
      sourceFile: string;
    };
    lastDiagnosis(): {
      code: string;
      title: string;
      severity: 'error' | 'warning';
      evidence: string[];
      actions: string[];
      confidence: number;
    }[];
  };
  ElecDomain?: {
    setDomain(domain: 'mech' | 'elec'): void;
    insertSymbol(key: string, opts?: { x?: number; y?: number }): { ok: boolean; tag?: string; id?: string; message?: string };
  };
  __Enclosure?: {
    add(partId: string, x?: number, y?: number): Promise<{
      id: string;
      partId: string;
      model: string;
      x: number;
      y: number;
      w: number;
      h: number;
      railId?: string;
    } | null>;
    place(partId: string, x?: number, y?: number, options?: { rotate?: boolean; railSnap?: boolean }): Promise<
      | {
          ok: true;
          placement: { id: string; partId: string; model: string; x: number; y: number; w: number; h: number; railId?: string };
          warnings: Array<{ code: 'OVERLAP' | 'OUT_OF_BOUNDS'; message: string }>;
        }
      | { ok: false; code: 'PART_NOT_FOUND' | 'NO_DIMENSIONS'; message: string }
    >;
    remove(placementId: string): { ok: boolean; message?: string };
    update(placementId: string, patch: Partial<import('./enclosure/layout').Placement>): {
      ok: boolean;
      placement?: import('./enclosure/layout').Placement;
      code?: string;
      message?: string;
    };
    restore(placement: import('./enclosure/layout').Placement): boolean;
    state(): {
      placed: number;
      overlap: number;
      collisions: number;
      ratio: number;
      usedMm2: number;
      plate: { width: number; height: number; rails: { id: string; y: number; height: number; label: string }[] };
      placements: { id: string; partId: string; model: string; x: number; y: number; w: number; h: number; railId?: string; tag?: string; qty?: number; note?: string }[];
    } | null;
    open(): void;
    close(): void;
    clear(): void;
  };
  __AUTOMATION_CAD_EXTENSION_READY__?: boolean;
  /** PLC 生成机型配置来源；优先于面板初始化参数。 */
  __PlcGenConfigProvider?: () => import('./plcgen/types').PlcGenConfig | null;
  /** PLC 生成面板：冒烟与命令式调用。 */
  __PlcGenPanel?: {
    open(): void;
    close(): void;
    hasConfig(): boolean;
    precheck(): Promise<import('./plcgen/types').PrecheckResult | null>;
    simulate(): Promise<import('./plcgen/verify').VerifyResult | null>;
    generate(): Promise<import('./plcgen/generate').GenerateProjectSuccess | null>;
    exportZip(): Promise<{ ok: boolean; path?: string; zipPath?: string; message?: string }>;
    openExportDir(): Promise<void>;
    history(): import('./plcgen/history').PlcHistoryEntry[];
    files(): import('./plcgen/types').GeneratedFile[];
    status(): string;
    uiState(): {
      open: boolean;
      hasConfig: boolean;
      generateDisabled: boolean;
      simulateDisabled?: boolean;
      verifyOk?: boolean | null;
      verifySteps?: number;
      verifyAlarms?: number;
      files: number;
      treeRows: number;
      history: number;
      previewPath: string | null;
      precheckErrors: number;
      enabled?: boolean;
      generated?: boolean;
      generatedAt?: string;
      stats: string;
    };
  };
  /** 电气校验数据源：由原理图侧注入，返回 null 表示暂无数据。 */
  __ElecDocProvider?: () => import('./elec/check').ElecDocument | null;
  /** 电气校验面板：脚本化运行与 PDF 导出（冒烟与 Agent 共用）。 */
  __ElecCheckPanel?: {
    open(): void;
    close(): void;
    run(doc: import('./elec/check').ElecDocument): Promise<import('./elec/check').ElecCheckResult | { ok: false; code: 'MODULE_DISABLED'; message: string } | null>;
    result(): import('./elec/check').ElecCheckResult | null;
    html(): string;
    exportPdf(): Promise<{ path: string; htmlPath: string }>;
    status(): string;
  };
  /** 成本估算数据源：BOM 行，由 CAD/机台配置侧注入。 */
  __CostBomProvider?: () => import('./cost/engine').CostBomRow[] | null;
  /** 成本估算价格簿：由外部价目表系统注入，优先于桌面内置价格簿。 */
  __CostPricebookProvider?: () => unknown | null;
  /** 成本估算面板：脚本化计算、报告 HTML/CSV 与导出（冒烟与后续 Agent 工具共用）。 */
  __CostPanel?: {
    open(): void | { ok: false; code: 'MODULE_DISABLED'; message: string };
    close(): void;
    setPricebook(value: unknown): { usable: number; examples: number };
    loadPricebookText(text: string, label?: string): { usable: number; examples: number };
    setBom(payload: Partial<import('./cost/engine').CostInput>, label?: string): { rows: number };
    run(input: Partial<import('./cost/engine').CostInput>): Promise<import('./cost/engine').CostReport | null | { ok: false; code: 'MODULE_DISABLED'; message: string }>;
    result(): import('./cost/engine').CostReport | null | { ok: false; code: 'MODULE_DISABLED'; message: string };
    state(): { hasReport: boolean; computedAt: string; bomSignature: string } | { ok: false; code: 'MODULE_DISABLED'; message: string };
    html(): string | { ok: false; code: 'MODULE_DISABLED'; message: string };
    csv(): string | { ok: false; code: 'MODULE_DISABLED'; message: string };
    exportPdf(): Promise<{ ok: boolean; path?: string; htmlPath?: string; code?: string; message?: string }>;
    exportCsv(): Promise<{ ok?: boolean; canceled?: boolean; path?: string | null; code?: string; message?: string }>;
    status(): string | { ok: false; code: 'MODULE_DISABLED'; message: string };
    pricebook(): { label: string; usable: number; examples: number } | null | { ok: false; code: 'MODULE_DISABLED'; message: string };
  };
  AutomationCadViewer?: {
    /** 渲染诊断：线框开关、材质、光照、相机（排查"看不见实体"用） */
    describeScene(): Record<string, unknown>;
    toggleWireframe(): boolean;
    open(): void;
    close(): void;
    importPath(path: string): Promise<void>;
    inspectPath(path: string): Promise<{ meshCount: number; triangleCount: number; elapsedMs: number; format: string }>;
    runInterference(parts?: { name: string; bbox: { min: [number, number, number]; max: [number, number, number] } }[]): { a: string; b: string; overlap: [number, number, number]; volumeApprox: number; center: [number, number, number]; severity: 'error' | 'warning' }[];
    exportMesh(format: 'glb' | 'obj'): Promise<{ format: string; size: number }>;
    exportData(format: 'csv' | 'xlsx' | 'dxf' | 'glb' | 'obj' | 'pdf'): Promise<{ format: string; size: number }>;
    exportReportPdf(): Promise<{ path: string; htmlPath: string }>;
  };
  AutomationCadKinematics?: {
    open(): void;
    close(): void;
    state(): {
      sourceFile: string;
      meshes: { id: number; name: string; triangles: number; center: [number, number, number]; size: [number, number, number] }[];
      parts: {
        id: string;
        name: string;
        meshIds: number[];
        meshNames: string[];
        center: [number, number, number];
        size: [number, number, number];
        kind: 'linear' | 'rotary';
        axis: 'x' | 'y' | 'z';
        direction: 1 | -1;
        travelMm: number;
        retractedMm: number;
        rangeDeg: number;
        retractedDeg: number;
        point: string;
        role: 'extend' | 'retract' | 'rotate' | '';
      }[];
      errors: number;
      warnings: number;
      ok: boolean;
    };
    addMovingPart(meshIds: readonly number[], name?: string): string;
    updatePart(id: string, patch: Record<string, unknown>): void;
    slide(id: string, percent: number): { percent: number; amount: number; unit: 'mm' | 'deg'; offset: [number, number, number]; rotationRad: number; source: string } | null;
    save(): boolean;
    getAnnotation(): {
      version: 1;
      sourceFile: string;
      parts: unknown[];
    };
    getValidation(): { ok: boolean; errors: unknown[]; warnings: unknown[] };
  };
  __Parametric?: {
    status(): Promise<DesktopParametricStatusInfo>;
    build(doc: unknown): Promise<DesktopParametricBuildResult>;
  };
  AutomationCadDrawings?: {
    state(): {
      enabled: boolean;
      freecadAvailable: boolean;
      freecadVersion: string | null;
      freecadReason: string;
      projectKey: string;
      parts: number;
      fresh: number;
      stale: number;
      missing: number;
      job: { jobId: string; state: string; done: number; total: number; message: string } | null;
      autoRegenerate: boolean;
    } | null;
    refresh(): Promise<void>;
    generate(scope: 'selected' | 'all' | 'stale'): Promise<{ ok: boolean; message: string; jobId?: string }>;
  };
  AutomationCadParametric?: {
    open(): void;
    close(): void;
    state(): {
      sourceFile: string;
      features: number;
      instances: number;
      bomRows: number;
      selected: string | null;
      validationErrors: number;
      status: DesktopParametricStatus;
      statusLabel: string;
      buildStatus: string;
      building: boolean;
      stlLoaded: boolean;
      ghost: boolean;
    };
    historyState(): { enabled: boolean; undoCount: number; redoCount: number };
    undo(): boolean;
    redo(): boolean;
    setSource(sourceFile: string): void;
    setDoc(doc: unknown): void;
    getDoc(): unknown;
    build(): Promise<DesktopParametricBuildResult>;
  };
  AutomationCadCommission?: {
    open(): void;
    getReport(): {
      plcKind: DesktopPlcKind | null;
      plcStatus: DesktopPlcStatus;
      startedAt: string;
      completedAt: string;
      powerUp: { pass: boolean; results: unknown[] };
      cases: unknown[];
      points: unknown[];
    };
    runPowerUp(): Promise<boolean>;
    runCase(id: string): Promise<boolean>;
    runAllCases(): Promise<boolean>;
  };
}

declare module '*?worker&inline' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
