import type { PlcConfig, PlcKind, PlcPoint, PlcStatus, PlcValue } from '../plc/types.ts';
import {
  buildEntryButton,
  createDrawer,
  ensurePanelStyles,
  errorMessage,
  escapeHtml,
  notify
} from '../ui/panels';
import { createSimulatorConfig, COMMISSION_CASES, COMMISSION_POINTS, POWER_UP_STEPS } from './standard.ts';
import { runSequence, type SequenceIo, type SequenceResult, type Step, type StepResult } from './sequence.ts';
import { describeCommissionCompatibility, validateCommissionSteps } from './compatibility.ts';
import { diagnose, type Diagnosis } from './diagnose.ts';
import { recordDiagnosticError } from '../shared/diagnostics.ts';
import { demoMachineConfig, validateMachineConfig, type MachineConfig } from './machine-config.ts';
import { buildMachineIoMap, type MachineIoMapRow } from '../machine/io-map.ts';
import { registerLinkagePoseBridge } from './linkage-bridge.ts';
import { createScene3D, type Commission3DStats, type CommissionKinematicsMode, type CommissionScene3D } from './scene3d.ts';
import type { GeomLayout } from '../machine/geometry.ts';
import type { KinematicsAnnotation } from '../cad/kinematics-ui.ts';
import { toStepReport, type CommissionCaseReport, type CommissionReport } from './types.ts';
import commissionStyles from './commission.css?inline';

/**
 * 把当前 3D 场景暴露给联动面板（src/agent/ui.ts 里的播放按钮）：
 * 每次调用现取 scene3d，视口重建后不会指向已 dispose 的旧实例（见 linkage-bridge.ts 单测）。
 */
function exposeLinkagePoseBridge(): void {
  registerLinkagePoseBridge(window as any, () => scene3d);
}

const COMMISSION_ICON = '<svg viewBox="0 0 16 16"><path d="M2.5 13.5h11M4 13.5V8h2.5v5.5M8 13.5V4.5h2.5v9M11.5 13.5V6.5H14v7"/><path d="M3.5 5.5l2.5-2 2 1.2 3.5-2.5"/></svg>';
let machineConfig = demoMachineConfig();
let machineIoRows: MachineIoMapRow[] = buildMachineIoMap(machineConfig).rows;
let machineLayout: GeomLayout | null = null;

function machineSummary(): string {
  const base = `机型：${machineConfig.name} · ${machineConfig.stations.length} 工位 · ${machineConfig.actuators.length} 执行机构 · ${machineConfig.sensors.length} 传感器`;
  const geometry = scene3d?.machineGeometry();
  if (!geometry) return base;
  const [x, y, z] = geometry.envelope.map((value) => Math.round(value));
  return `${base} · 参数化几何 ${geometry.parts.length} 件 · 外形 ${x}×${y}×${z} mm`;
}

const STATUS_LABEL: Record<PlcStatus, string> = {
  disconnected: '未连接',
  connecting: '连接中…',
  connected: '已连接',
  error: '连接异常'
};

interface PanelOptions {
  onExportReport(report: CommissionReport): Promise<void>;
}

interface Elements {
  drawer: HTMLElement;
  kind: HTMLSelectElement;
  hostField: HTMLElement;
  host: HTMLInputElement;
  portField: HTMLElement;
  port: HTMLInputElement;
  unitField: HTMLElement;
  unitId: HTMLInputElement;
  connect: HTMLButtonElement;
  disconnect: HTMLButtonElement;
  status: HTMLElement;
  lamp: HTMLElement;
  statusText: HTMLElement;
  statusDetail: HTMLElement;
  pointsBody: HTMLElement;
  powerList: HTMLElement;
  powerRun: HTMLButtonElement;
  powerStep: HTMLButtonElement;
  powerSummary: HTMLElement;
  cases: HTMLElement;
  casesRun: HTMLButtonElement;
  caseResults: HTMLElement;
  monitorBody: HTMLElement;
  scene3dHost: HTMLElement;
  scene3dMode: HTMLElement;
  scene3dToggle: HTMLInputElement;
  diagnosis: HTMLElement;
  diagnosisSummary: HTMLElement;
  export: HTMLButtonElement;
  summary: HTMLElement;
}

export interface CommissionPanelHandle {
  open(): void;
  getReport(): CommissionReport;
  getMachineConfig(): MachineConfig;
  /** 切换到新的机型配置；传 null 恢复内置 4 工位样机。 */
  setMachineConfig(config: MachineConfig | null, layout?: GeomLayout | null): void;
  setKinematics(annotation: KinematicsAnnotation | null): void;
  runPowerUp(): Promise<boolean>;
  runCase(id: string): Promise<boolean>;
  runAllCases(): Promise<boolean>;
  /** 仅控制测试执行，不改变实时 PLC 连接或点位权限。 */
  setIoTestsEnabled(enabled: boolean): void;
  ioTestsEnabled(): boolean;
  /** 页面关闭时释放 3D 场景、ResizeObserver 与动画循环；可重复调用。 */
  dispose(): void;
}

let elements: Elements | null = null;
let optionsRef: PanelOptions | null = null;
let drawerHandle: ReturnType<typeof createDrawer> | null = null;
let points: PlcPoint[] = COMMISSION_POINTS.map((point) => ({ ...point }));
let simConfig: PlcConfig = createSimulatorConfig();
let lastStatus: { kind: PlcKind | null; status: PlcStatus; error?: string } = {
  kind: null,
  status: 'disconnected'
};
let values = new Map<string, PlcValue>();
let powerResults: (StepResult | undefined)[] = POWER_UP_STEPS.map(() => undefined);
let powerCursor = 0;
let caseReports = new Map<string, SequenceResult>();
let running = false;
let ioTestsEnabled = true;
let listening = false;
let loaded = false;
let scene3d: CommissionScene3D | null = null;
let scene3dObserver: MutationObserver | null = null;
let lastDiagnoses: Diagnosis[] = [];

function desktop() {
  return window.desktop;
}

function ensureStyles(): void {
  ensurePanelStyles();
  if (document.getElementById('commission-panel-styles')) return;
  const style = document.createElement('style');
  style.id = 'commission-panel-styles';
  style.textContent = commissionStyles;
  document.head.appendChild(style);
}

function setMessage(message: string, error = false): void {
  if (!elements) return;
  elements.summary.textContent = message;
  elements.summary.classList.toggle('is-error', error);
  if (message) notify(message, error);
}

function formatValue(value: PlcValue | undefined, unit?: string): string {
  if (value === undefined) return '—';
  const text = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
  return unit ? `${text} ${unit}` : text;
}

function livePointValues(): Record<string, boolean | number> {
  const snapshot: Record<string, boolean | number> = {};
  for (const point of points) {
    const value = values.get(point.id);
    if (typeof value === 'boolean' || typeof value === 'number') snapshot[point.id] = value;
  }
  return snapshot;
}

function expectedForStep(step: Step, result: StepResult): { point: string; value: PlcValue } | undefined {
  if (!step.point) return undefined;
  if (step.action === 'wait' && step.expect !== undefined) return { point: step.point, value: step.expect };
  if (step.action === 'set' && step.value !== undefined && result.expected.includes('=')) return { point: step.point, value: step.value };
  return undefined;
}

function faultPoint(diagnoses: Diagnosis[], step: Step, snapshot: Record<string, boolean | number>): string | undefined {
  const diagnosis = diagnoses[0];
  if (!diagnosis) return step.point;
  if (diagnosis.code === 'SAFETY_LOOP_OPEN') {
    if (snapshot.X8 === false) return 'X8';
    if (snapshot.X9 === true) return 'X9';
    if (snapshot.X14 === true) return 'X14';
    return 'X8';
  }
  if (diagnosis.code === 'AIR_PRESSURE_LOW') return 'X3';
  if (diagnosis.code === 'DUAL_SENSOR') return snapshot.X6 === true ? 'X6' : 'X7';
  return step.point;
}

function handleStepResult(result: StepResult, step: Step): void {
  const snapshot = livePointValues();
  scene3d?.update(snapshot);
  if (result.pass) return;
  const expected = expectedForStep(step, result);
  const diagnoses = diagnose({
    step: result,
    points: snapshot,
    ...(expected ? { expected } : {}),
    ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
    commOk: lastStatus.status === 'connected'
  });
  lastDiagnoses = diagnoses;
  renderDiagnosis(diagnoses);
  const point = faultPoint(diagnoses, step, snapshot);
  if (point) scene3d?.highlight(point, true);
}

function currentConfig(kind: PlcKind): PlcConfig {
  const config: PlcConfig = {
    kind,
    points: points.map((point) => ({ ...point })),
    pollMs: 100
  };
  if (kind === 'modbus') {
    const host = elements?.host.value.trim() ?? '';
    if (!host) throw new Error('请填写 Modbus TCP 主机地址，例如 192.168.1.10');
    const port = Number(elements?.port.value ?? 502);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PLC 端口必须是 1 ~ 65535 的整数');
    const unitId = Number(elements?.unitId.value ?? 1);
    if (!Number.isInteger(unitId) || unitId < 0 || unitId > 255) throw new Error('PLC 站号必须是 0 ~ 255 的整数');
    config.host = host;
    config.port = port;
    config.unitId = unitId;
  } else {
    config.rules = (simConfig.rules ?? createSimulatorConfig().rules ?? []).map((rule) => ({ ...rule }));
    config.initialValues = { ...(simConfig.initialValues ?? createSimulatorConfig().initialValues ?? {}) };
  }
  return config;
}

function sequenceCompatibility(steps: readonly Step[]) {
  return validateCommissionSteps(steps, machineIoRows, points);
}

function guardSequenceCompatibility(steps: readonly Step[]): boolean {
  const result = sequenceCompatibility(steps);
  if (result.compatible) return true;
  setMessage(describeCommissionCompatibility(result), true);
  return false;
}

function updateKindFields(): void {
  if (!elements) return;
  const modbus = elements.kind.value === 'modbus';
  elements.hostField.hidden = !modbus;
  elements.portField.hidden = !modbus;
  elements.unitField.hidden = !modbus;
}

function renderStatus(status: { kind: PlcKind | null; status: PlcStatus; error?: string }): void {
  if (!elements) return;
  lastStatus = status;
  elements.lamp.dataset.state = status.status;
  elements.statusText.textContent = `${status.kind ?? 'PLC'} · ${STATUS_LABEL[status.status]}`;
  elements.statusDetail.textContent = status.error ? status.error : status.status === 'connected' ? '实时值已订阅' : '未建立通信';
  elements.status.classList.toggle('is-error', status.status === 'error');
  elements.connect.disabled = running || status.status === 'connected' || status.status === 'connecting';
  elements.disconnect.disabled = running || (status.status !== 'connected' && status.status !== 'error');
}

function renderPoints(): void {
  if (!elements) return;
  elements.pointsBody.innerHTML = points.map((point) => `<tr data-plc-point="${escapeHtml(point.id)}">
    <td class="mono">${escapeHtml(point.id)}</td>
    <td>${escapeHtml(point.name)}</td>
    <td class="mono">${point.area}</td>
    <td><input type="number" min="0" max="65535" step="1" data-point-address="${escapeHtml(point.id)}" value="${point.address}" aria-label="${escapeHtml(point.name)} 地址"></td>
    <td class="mono">${point.dataType}${point.writable ? ' · W' : ''}</td>
  </tr>`).join('');
  renderMonitor();
}

function renderMonitor(): void {
  if (!elements) return;
  elements.monitorBody.innerHTML = points.map((point) => {
    const value = values.get(point.id);
    const force = point.writable
      ? `<div class="commission-force"><input type="text" data-force-input="${escapeHtml(point.id)}" value="${escapeHtml(value === undefined ? '' : String(value))}" aria-label="${escapeHtml(point.name)} 强制值"><button type="button" data-force-point="${escapeHtml(point.id)}">强制</button></div>`
      : '<span class="commission-badge">只读</span>';
    return `<tr data-monitor-point="${escapeHtml(point.id)}">
      <td class="mono">${escapeHtml(point.id)}</td>
      <td>${escapeHtml(point.name)}</td>
      <td class="commission-monitor-value">${escapeHtml(formatValue(value, point.unit))}</td>
      <td>${force}</td>
    </tr>`;
  }).join('');
}

function updateMonitorValue(id: string, value: PlcValue): void {
  values.set(id, value);
  if (!elements) return;
  const point = points.find((entry) => entry.id === id);
  const row = elements.monitorBody.querySelector<HTMLElement>(`[data-monitor-point="${cssEscape(id)}"]`);
  const cell = row?.querySelector<HTMLElement>('.commission-monitor-value');
  if (cell) cell.textContent = formatValue(value, point?.unit);
  const input = row?.querySelector<HTMLInputElement>(`[data-force-input="${cssEscape(id)}"]`);
  if (input && document.activeElement !== input) input.value = String(value);
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

function stepState(index: number): { state: string; glyph: string; time: string; message: string } {
  const result = powerResults[index];
  if (!result) return { state: '', glyph: String(index + 1), time: '待执行', message: '' };
  return {
    state: result.pass ? 'pass' : 'fail',
    glyph: result.pass ? '✓' : '×',
    time: `${result.durationMs} ms`,
    message: result.message ?? ''
  };
}

function renderPowerSteps(): void {
  if (!elements) return;
  const compatibility = sequenceCompatibility(POWER_UP_STEPS);
  elements.powerList.innerHTML = POWER_UP_STEPS.map((step, index) => {
    const state = stepState(index);
    return `<div class="commission-step" data-power-step="${escapeHtml(step.id)}" data-state="${state.state}">
      <span class="commission-step-status">${state.glyph}</span>
      <span>${escapeHtml(step.name)}</span>
      <em>${escapeHtml(state.time)}</em>
      ${state.message ? `<div class="commission-step-msg">${escapeHtml(state.message)}</div>` : ''}
    </div>`;
  }).join('') + (compatibility.compatible ? '' : `<div class="commission-map-warning" role="note">${escapeHtml(describeCommissionCompatibility(compatibility))}</div>`);
  const passed = powerResults.filter((result) => result?.pass === true).length;
  elements.powerSummary.innerHTML = `<span class="acp-pill ${passed === POWER_UP_STEPS.length ? 'is-ok' : ''}">${passed}/${POWER_UP_STEPS.length} 通过</span><span class="acp-pill">逐步执行 ${Math.min(powerCursor + 1, POWER_UP_STEPS.length)}/${POWER_UP_STEPS.length}</span>`;
  elements.powerStep.textContent = powerCursor >= POWER_UP_STEPS.length ? '重新逐步执行' : `执行第 ${powerCursor + 1} 步`;
  elements.powerStep.disabled = !ioTestsEnabled || running || !compatibility.compatible;
  elements.powerRun.disabled = !ioTestsEnabled || running || !compatibility.compatible;
}

function renderCases(): void {
  if (!elements) return;
  elements.cases.innerHTML = COMMISSION_CASES.map((testCase) => {
    const report = caseReports.get(testCase.id);
    const compatibility = sequenceCompatibility(testCase.steps);
    const badge = report
      ? `<span class="commission-badge ${report.pass ? 'pass' : 'fail'}">${report.pass ? '通过' : '失败'}</span>`
      : compatibility.compatible
        ? '<span class="commission-badge">未执行</span>'
        : '<span class="commission-badge fail">已禁用</span>';
    return `<article class="commission-case" data-commission-case="${escapeHtml(testCase.id)}">
      <div class="commission-case-head"><b>${escapeHtml(testCase.name)}</b>${badge}<span>${testCase.steps.length} 步</span></div>
      <p>${escapeHtml(testCase.description)}</p>
      ${compatibility.compatible ? '' : `<div class="commission-map-warning" role="note">${escapeHtml(describeCommissionCompatibility(compatibility))}</div>`}
      <div class="commission-case-actions"><button type="button" class="acp-btn" data-run-case="${escapeHtml(testCase.id)}" ${!ioTestsEnabled || running || !compatibility.compatible ? 'disabled' : ''}>单跑</button></div>
    </article>`;
  }).join('');
  elements.casesRun.disabled = !ioTestsEnabled || running || COMMISSION_CASES.some((testCase) => !sequenceCompatibility(testCase.steps).compatible);
}

function applyIoTestModuleState(): void {
  const drawer = drawerHandle?.body;
  if (!drawer) return;
  drawer.querySelectorAll<HTMLElement>('[data-commission-io-test]').forEach((node) => {
    node.hidden = !ioTestsEnabled;
  });
  const notice = drawer.querySelector<HTMLElement>('[data-commission-io-test-disabled]');
  if (notice) notice.hidden = ioTestsEnabled;
  renderPowerSteps();
  renderCases();
}

function requireIoTestsEnabled(): boolean {
  if (ioTestsEnabled) return true;
  setMessage('联调 IO 测试模块当前已关闭；启用后才能执行上电流程或联调用例。', true);
  return false;
}

function renderCaseResults(): void {
  if (!elements) return;
  const rows: string[] = [];
  for (const testCase of COMMISSION_CASES) {
    const report = caseReports.get(testCase.id);
    if (!report) continue;
    for (const result of report.results) {
      rows.push(`<tr data-case-id="${escapeHtml(testCase.id)}">
        <td>${escapeHtml(testCase.name)}</td>
        <td>${escapeHtml(result.name)}</td>
        <td><span class="commission-badge ${result.pass ? 'pass' : 'fail'}">${result.pass ? 'PASS' : 'FAIL'}</span></td>
        <td class="mono">${escapeHtml(result.expected)}</td>
        <td class="mono">${escapeHtml(result.actual)}</td>
        <td class="mono">${result.durationMs} ms</td>
      </tr>`);
    }
  }
  elements.caseResults.innerHTML = rows.length > 0
    ? rows.join('')
    : '<tr><td colspan="6" style="color:#6e777f;text-align:center;padding:12px">尚未运行用例。单跑会自动补执行上电流程。</td></tr>';
}

function renderSceneMode(): void {
  if (!elements) return;
  const mode: CommissionKinematicsMode = scene3d?.kinematicsMode() ?? {
    mode: 'config',
    reason: '3D 场景尚未就绪',
    parts: 0,
    sourceFile: ''
  };
  elements.scene3dMode.dataset.mode = mode.mode;
  elements.scene3dMode.textContent =
    mode.mode === 'annotation'
      ? `标注驱动 · ${mode.sourceFile || '未命名文件'} · ${mode.parts} 个动件`
      : `配置驱动 · ${mode.reason}`;
}

function setKinematics(annotation: KinematicsAnnotation | null): void {
  scene3d?.setKinematics(annotation);
  renderSceneMode();
}

function renderDiagnosis(diagnoses: Diagnosis[]): void {
  if (!elements) return;
  elements.diagnosisSummary.textContent = diagnoses.length > 0 ? `${diagnoses.length} 项结论` : '待运行';
  if (diagnoses.length === 0) {
    elements.diagnosis.innerHTML = '<div class="commission-diagnosis-empty">执行失败后显示可执行的故障排查结论。</div>';
    return;
  }
  elements.diagnosis.innerHTML = diagnoses.map((diagnosis) => {
    const confidence = Math.round(diagnosis.confidence * 100);
    return `<article class="commission-diagnosis-card" data-diagnosis-code="${escapeHtml(diagnosis.code)}" data-severity="${diagnosis.severity}">
      <div class="commission-diagnosis-head">
        <b>${escapeHtml(diagnosis.title)}</b>
        <span>置信度 ${confidence}%</span>
      </div>
      <ul class="commission-diagnosis-evidence">${diagnosis.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
      <div class="commission-diagnosis-actions"><span>排查步骤</span><ol>${diagnosis.actions.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol></div>
    </article>`;
  }).join('');
}

function resetDiagnosis(): void {
  lastDiagnoses = [];
  scene3d?.clearHighlight();
  renderDiagnosis([]);
}

function makeIo(): SequenceIo {
  const api = desktop();
  if (!api) throw new Error('联调面板仅在桌面版可用');
  return {
    pollMs: 50,
    async read(id) {
      if (!ioTestsEnabled) throw new Error('联调 IO 测试模块已关闭，已停止后续测试点位读取');
      const result = await api.plc.read(id);
      if (!result.ok || result.data === undefined) throw new Error(result.message ?? `读取点位「${id}」失败`);
      updateMonitorValue(id, result.data);
      return result.data;
    },
    async write(id, value) {
      if (!ioTestsEnabled) throw new Error('联调 IO 测试模块已关闭，已停止后续测试点位写入');
      const result = await api.plc.write(id, value);
      if (!result.ok) throw new Error(result.message ?? `写入点位「${id}」失败`);
    },
    async readAll() {
      if (!ioTestsEnabled) throw new Error('联调 IO 测试模块已关闭，已停止后续测试点位读取');
      const result = await api.plc.readAll();
      if (!result.ok || !result.data) throw new Error(result.message ?? '读取全部点位失败');
      for (const [id, value] of Object.entries(result.data)) updateMonitorValue(id, value);
      return result.data;
    },
    onStep: handleStepResult
  };
}

function powerPassed(): boolean {
  return powerResults.length === POWER_UP_STEPS.length && powerResults.every((result) => result?.pass === true);
}

async function connect(): Promise<void> {
  const api = desktop();
  if (!api || !elements) {
    setMessage('联调面板仅在桌面版可用。', true);
    return;
  }
  let config: PlcConfig;
  try {
    config = currentConfig(elements.kind.value as PlcKind);
  } catch (error) {
    setMessage(errorMessage(error), true);
    return;
  }
  running = true;
  renderStatus({ kind: config.kind, status: 'connecting' });
  renderCases();
  try {
    const result = await api.plc.connect(config);
    running = false;
    if (!result.ok || !result.data) {
      renderStatus({ kind: config.kind, status: 'error', ...(result.message ? { error: result.message } : {}) });
      setMessage(result.message ?? 'PLC 连接失败', true);
      renderCases();
      return;
    }
    renderStatus(result.data);
    powerResults = POWER_UP_STEPS.map(() => undefined);
    powerCursor = 0;
    caseReports = new Map();
    resetDiagnosis();
    renderPowerSteps();
    renderCases();
    renderCaseResults();
    const all = await api.plc.readAll();
    if (all.ok && all.data) {
      values = new Map();
      for (const [id, value] of Object.entries(all.data)) updateMonitorValue(id, value);
      scene3d?.update(livePointValues());
    }
    setMessage(`PLC 已连接：${config.kind === 'sim' ? '内置仿真器' : `${config.host}:${config.port}`}`);
    renderCases();
  } catch (error) {
    running = false;
    renderStatus({ kind: config.kind, status: 'error', error: errorMessage(error) });
    setMessage(`PLC 连接失败：${errorMessage(error)}`, true);
    renderCases();
  }
}

async function disconnect(): Promise<void> {
  const api = desktop();
  if (!api) return;
  running = true;
  renderCases();
  try {
    const result = await api.plc.disconnect();
    running = false;
    values = new Map();
    renderMonitor();
    if (!result.ok || !result.data) {
      setMessage(result.message ?? '断开失败', true);
      renderCases();
      return;
    }
    renderStatus(result.data);
    setMessage('PLC 已断开');
    renderCases();
  } catch (error) {
    running = false;
    setMessage(`断开失败：${errorMessage(error)}`, true);
    renderCases();
  }
}

async function runPowerUp(): Promise<boolean> {
  if (!requireIoTestsEnabled()) return false;
  if (running) return false;
  if (!guardSequenceCompatibility(POWER_UP_STEPS)) return false;
  const api = desktop();
  if (!api || lastStatus.status !== 'connected') {
    setMessage('请先连接 PLC，再执行上电流程。', true);
    return false;
  }
  running = true;
  resetDiagnosis();
  powerResults = POWER_UP_STEPS.map(() => undefined);
  powerCursor = 0;
  renderPowerSteps();
  renderCases();
  try {
    const result = await runSequence(POWER_UP_STEPS, makeIo());
    powerResults = POWER_UP_STEPS.map((step) => result.results.find((item) => item.stepId === step.id));
    powerCursor = result.results.filter((item) => item.pass).length;
    renderPowerSteps();
    setMessage(result.pass
      ? '上电流程全部通过，设备已就绪。'
      : result.failure?.message ?? '上电流程失败', !result.pass);
    return result.pass;
  } catch (error) {
    recordDiagnosticError('COMMISSION_POWER_UP_FAILED', error, { site: 'desktop/src/commission/ui.ts' });
    setMessage(`上电流程异常：${errorMessage(error)}。请检查 PLC 连接与点位配置后重试。`, true);
    return false;
  } finally {
    running = false;
    renderPowerSteps();
    renderCases();
  }
}

async function runPowerStep(): Promise<boolean> {
  if (!requireIoTestsEnabled()) return false;
  if (running) return false;
  if (!guardSequenceCompatibility(POWER_UP_STEPS)) return false;
  const api = desktop();
  if (!api || lastStatus.status !== 'connected') {
    setMessage('请先连接 PLC，再执行上电流程。', true);
    return false;
  }
  if (powerCursor >= POWER_UP_STEPS.length) {
    powerResults = POWER_UP_STEPS.map(() => undefined);
    powerCursor = 0;
  }
  const index = powerCursor;
  const step = POWER_UP_STEPS[index];
  if (!step) return powerPassed();
  running = true;
  resetDiagnosis();
  renderPowerSteps();
  renderCases();
  try {
    const result = await runSequence([step], makeIo());
    const stepResult = result.results[0];
    powerResults[index] = stepResult;
    if (stepResult?.pass) powerCursor += 1;
    renderPowerSteps();
    setMessage(stepResult?.pass ? `${step.name} 通过` : stepResult?.message ?? `${step.name} 失败`, !stepResult?.pass);
    return powerPassed();
  } catch (error) {
    recordDiagnosticError('COMMISSION_POWER_STEP_FAILED', error, { site: 'desktop/src/commission/ui.ts', step: step.name });
    setMessage(`${step.name} 异常：${errorMessage(error)}。请检查该步骤点位后重试。`, true);
    return false;
  } finally {
    running = false;
    renderPowerSteps();
    renderCases();
  }
}

async function ensureReady(): Promise<boolean> {
  if (powerPassed()) return true;
  notify('设备未就绪，先自动执行上电流程…');
  return await runPowerUp();
}

async function runCaseById(id: string): Promise<boolean> {
  if (!requireIoTestsEnabled()) return false;
  if (running) return false;
  const testCase = COMMISSION_CASES.find((entry) => entry.id === id);
  if (!testCase) {
    setMessage(`用例不存在：${id}`, true);
    return false;
  }
  if (!guardSequenceCompatibility(testCase.steps)) return false;
  if (!(await ensureReady())) return false;
  if (!requireIoTestsEnabled()) return false;
  running = true;
  resetDiagnosis();
  renderCases();
  renderPowerSteps();
  try {
    const result = await runSequence(testCase.steps, makeIo());
    caseReports.set(id, result);
    renderCaseResults();
    setMessage(result.pass ? `用例「${testCase.name}」通过` : result.failure?.message ?? `用例「${testCase.name}」失败`, !result.pass);
    return result.pass;
  } catch (error) {
    recordDiagnosticError('COMMISSION_CASE_FAILED', error, { site: 'desktop/src/commission/ui.ts', caseName: testCase.name });
    setMessage(`用例「${testCase.name}」异常：${errorMessage(error)}。请检查点位与节拍配置后重试。`, true);
    return false;
  } finally {
    running = false;
    renderCases();
    renderPowerSteps();
  }
}

async function runAllCases(): Promise<boolean> {
  if (!requireIoTestsEnabled()) return false;
  if (running) return false;
  const incompatibleCase = COMMISSION_CASES.find((testCase) => !sequenceCompatibility(testCase.steps).compatible);
  if (incompatibleCase) {
    guardSequenceCompatibility(incompatibleCase.steps);
    return false;
  }
  if (!(await ensureReady())) return false;
  if (!requireIoTestsEnabled()) return false;
  running = true;
  resetDiagnosis();
  caseReports = new Map();
  renderCaseResults();
  renderCases();
  renderPowerSteps();
  let allPass = true;
  try {
    for (const testCase of COMMISSION_CASES) {
      const result = await runSequence(testCase.steps, makeIo());
      caseReports.set(testCase.id, result);
      renderCaseResults();
      if (!result.pass) {
        allPass = false;
        setMessage(`用例「${testCase.name}」失败，已停止全跑：${result.failure?.message ?? '未知原因'}`, true);
        break;
      }
    }
    if (allPass) setMessage('3 条联调用例全部通过。');
    return allPass;
  } catch (error) {
    recordDiagnosticError('COMMISSION_RUN_ALL_FAILED', error, { site: 'desktop/src/commission/ui.ts' });
    setMessage(`用例全跑异常：${errorMessage(error)}。已保留当前结果，请修复后重新运行。`, true);
    return false;
  } finally {
    running = false;
    renderCases();
    renderPowerSteps();
  }
}

function snapshotPoints(): CommissionReport['points'] {
  return points.map((point) => ({
    id: point.id,
    name: point.name,
    value: values.get(point.id) ?? (point.dataType === 'bool' ? false : 0),
    ...(point.unit ? { unit: point.unit } : {})
  }));
}

function buildCaseReports(): CommissionCaseReport[] {
  return COMMISSION_CASES.map((testCase) => {
    const result = caseReports.get(testCase.id);
    if (!result) return null;
    return {
      id: testCase.id,
      name: testCase.name,
      pass: result.pass,
      at: result.finishedAt,
      durationMs: result.durationMs,
      results: result.results.map(toStepReport)
    };
  }).filter((entry): entry is CommissionCaseReport => entry !== null);
}

function getReport(): CommissionReport {
  const now = new Date().toISOString();
  const startedAt = powerResults.find((result) => result !== undefined)?.at ?? now;
  return {
    plcKind: lastStatus.kind,
    plcStatus: lastStatus.status,
    startedAt,
    completedAt: now,
    powerUp: {
      pass: powerPassed(),
      results: powerResults.filter((result): result is StepResult => result !== undefined).map(toStepReport)
    },
    cases: buildCaseReports(),
    points: snapshotPoints()
  };
}

async function exportReport(): Promise<void> {
  if (!optionsRef) return;
  try {
    await optionsRef.onExportReport(getReport());
    setMessage('联调报告已导出为 PDF。');
  } catch (error) {
    setMessage(`联调报告导出失败：${errorMessage(error)}`, true);
  }
}

async function forcePoint(id: string): Promise<void> {
  const api = desktop();
  if (!api || !elements) return;
  const point = points.find((entry) => entry.id === id);
  if (!point) return;
  const input = elements.monitorBody.querySelector<HTMLInputElement>(`[data-force-input="${cssEscape(id)}"]`);
  const raw = input?.value.trim() ?? '';
  let value: PlcValue;
  if (point.dataType === 'bool') {
    const normalized = raw.toLowerCase();
    if (['true', '1', '是', 'on'].includes(normalized)) value = true;
    else if (['false', '0', '否', 'off'].includes(normalized)) value = false;
    else {
      setMessage(`点位「${id}」需要布尔值（true/false），收到：${raw}`, true);
      return;
    }
  } else {
    value = Number(raw);
    if (!Number.isInteger(value)) {
      setMessage(`点位「${id}」需要整数，收到：${raw}`, true);
      return;
    }
  }
  const current = values.get(id);
  if (!window.confirm(`确定强制写入点位「${point.name}」吗？\n\n当前值：${formatValue(current, point.unit)}\n写入值：${formatValue(value, point.unit)}`)) return;
  try {
    const result = await api.plc.force(id, value);
    if (!result.ok) {
      setMessage(result.message ?? '强制写入失败', true);
      return;
    }
    updateMonitorValue(id, value);
    setMessage(`点位「${id}」已强制写入 ${formatValue(value, point.unit)}`);
  } catch (error) {
    setMessage(`强制写入失败：${errorMessage(error)}`, true);
  }
}

async function loadSavedConfig(): Promise<void> {
  const api = desktop();
  if (!api || !elements || loaded) return;
  loaded = true;
  try {
    const result = await api.plc.getConfig();
    if (result.ok && result.data) {
      const config = result.data as unknown as PlcConfig;
      if (Array.isArray(config.points) && config.points.length > 0) points = config.points.map((point) => ({ ...point }));
      if (config.kind === 'sim') simConfig = config;
      elements.kind.value = config.kind;
      if (config.host) elements.host.value = config.host;
      if (config.port) elements.port.value = String(config.port);
      if (config.unitId !== undefined) elements.unitId.value = String(config.unitId);
    }
  } catch (error) {
    setMessage(`读取 PLC 配置失败：${errorMessage(error)}`, true);
  }
  renderPoints();
  renderPowerSteps();
  renderCases();
  updateKindFields();
  try {
    const status = await api.plc.status();
    if (status.ok && status.data) {
      renderStatus(status.data);
      if (status.data.status === 'connected') {
        const all = await api.plc.readAll();
        if (all.ok && all.data) for (const [id, value] of Object.entries(all.data)) updateMonitorValue(id, value);
      }
    }
  } catch (error) {
    setMessage(`读取 PLC 状态失败：${errorMessage(error)}`, true);
  }
}

function bindEvents(): void {
  if (!elements) return;
  elements.kind.addEventListener('change', updateKindFields);
  elements.connect.addEventListener('click', () => void connect());
  elements.disconnect.addEventListener('click', () => void disconnect());
  elements.powerRun.addEventListener('click', () => void runPowerUp());
  elements.powerStep.addEventListener('click', () => void runPowerStep());
  elements.casesRun.addEventListener('click', () => void runAllCases());
  elements.scene3dToggle.addEventListener('change', () => {
    scene3d?.setEnabled(elements?.scene3dToggle.checked ?? true);
  });
  elements.export.addEventListener('click', () => void exportReport());
  elements.pointsBody.addEventListener('change', (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('[data-point-address]');
    if (!input) return;
    const id = input.dataset.pointAddress;
    if (!id) return;
    const point = points.find((entry) => entry.id === id);
    const address = Number(input.value);
    if (!point) return;
    if (!Number.isInteger(address) || address < 0 || address > 65535) {
      setMessage(`点位「${id}」地址必须是 0 ~ 65535 的整数`, true);
      input.value = String(point.address);
      return;
    }
    point.address = address;
    setMessage(`点位「${id}」地址已改为 ${address}，重新连接后生效。`);
  });
  elements.cases.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-run-case]');
    if (button?.dataset.runCase) void runCaseById(button.dataset.runCase);
  });
  elements.monitorBody.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-force-point]');
    if (button?.dataset.forcePoint) void forcePoint(button.dataset.forcePoint);
  });
}

function bindDesktopEvents(): void {
  const api = desktop();
  if (!api || listening) return;
  listening = true;
  api.plc.onStatus((status) => {
    renderStatus(status);
    if (status.status === 'error' && status.error) setMessage(status.error, true);
  });
  api.plc.onValues((incoming) => {
    for (const [id, value] of Object.entries(incoming)) updateMonitorValue(id, value);
    scene3d?.update(livePointValues());
  });
}

function buildPanel(): void {
  ensureStyles();
  const entry = buildEntryButton('commissionEntryButton', '联调', COMMISSION_ICON, () => {
    drawerHandle?.open();
    scene3d?.setActive(true);
    void loadSavedConfig();
  });
  if (!entry) return;
  const drawer = createDrawer('commissionDrawer', '通电联调', 'PLC 仿真 / Modbus TCP · 6 步上电 · 3 条用例 · 联调报告');
  drawerHandle = drawer;
  drawer.root.classList.add('commission-drawer');
  drawer.body.innerHTML = `
    <div class="commission-panel">
      <div class="commission-status" id="commissionStatusBar">
        <span class="commission-lamp" id="commissionLamp" data-state="disconnected"></span>
        <span id="commissionStatusText">PLC · 未连接</span>
        <strong id="commissionStatusDetail">未建立通信</strong>
      </div>
      <div class="acp-section-title"><span>3D 联动</span><label class="acp-switch"><input type="checkbox" id="commission3dToggle" checked>启用</label></div>
      <div class="acp-note" id="commission3dMachine">${machineSummary()}</div>
      <div class="commission-3d-mode" id="commission3dMode" data-mode="config">配置驱动 · 尚未加载运动学标注</div>
      <div class="commission-3d" id="commission3dHost"></div>
      <div class="acp-section-title"><span>PLC 连接</span><b>28 点位</b></div>
      <div class="acp-field">
        <span>适配器</span>
        <select class="acp-select" id="commissionKind">
          <option value="sim">内置 PLC 仿真器（开箱即用）</option>
          <option value="modbus">Modbus TCP</option>
        </select>
      </div>
      <div class="commission-grid">
        <div class="acp-field" id="commissionHostField" hidden><span>主机</span><input class="acp-input" id="commissionHost" placeholder="192.168.1.10" autocomplete="off"></div>
        <div class="acp-field" id="commissionPortField" hidden><span>端口</span><input class="acp-input" id="commissionPort" type="number" min="1" max="65535" value="502"></div>
        <div class="acp-field" id="commissionUnitField" hidden><span>站号 unitId</span><input class="acp-input" id="commissionUnitId" type="number" min="0" max="255" value="1"></div>
      </div>
      <div class="commission-actions">
        <button type="button" class="acp-btn acp-btn-primary" id="commissionConnect">连接</button>
        <button type="button" class="acp-btn" id="commissionDisconnect" disabled>断开</button>
        <span class="acp-row-end" id="commissionSummary"></span>
      </div>
      <div class="acp-section-title"><span>点位表</span><b>地址可编辑</b></div>
      <div class="commission-table-scroll"><table class="commission-table">
        <thead><tr><th>ID</th><th>名称</th><th>区</th><th>地址</th><th>类型</th></tr></thead>
        <tbody id="commissionPoints"></tbody>
      </table></div>

      <div class="acp-note" data-commission-io-test-disabled hidden>联调 IO 测试模块已关闭；PLC 连接、点位读写与实时监视仍可使用。</div>
      <div data-commission-io-test>
      <div class="acp-section-title"><span>上电流程</span><b>6 步</b></div>
      <div id="commissionPowerSteps"></div>
      <div class="commission-actions">
        <button type="button" class="acp-btn acp-btn-primary" id="commissionPowerRun">一键执行</button>
        <button type="button" class="acp-btn" id="commissionPowerStep">执行第 1 步</button>
        <span class="acp-row-end" id="commissionPowerSummary"></span>
      </div>

      <div class="acp-section-title"><span>联调用例</span><b>3 条</b></div>
      <div id="commissionCases"></div>
      <div class="commission-actions"><button type="button" class="acp-btn acp-btn-primary" id="commissionCasesRun">全跑 3 条用例</button></div>
      <div class="commission-result-wrap" style="margin-top:8px"><table class="commission-table">
        <thead><tr><th>用例</th><th>阶段</th><th>结果</th><th>期望</th><th>实际</th><th>耗时</th></tr></thead>
        <tbody id="commissionCaseResults"></tbody>
      </table></div>

      <div class="acp-section-title"><span>故障诊断</span><b id="commissionDiagnosisSummary">待运行</b></div>
      <div class="commission-diagnosis" id="commissionDiagnosis"></div>
      </div>

      <div class="acp-section-title"><span>点位监视</span><b>实时 · 强制写入</b></div>
      <div class="commission-table-scroll"><table class="commission-table">
        <thead><tr><th>ID</th><th>名称</th><th>实时值</th><th>强制</th></tr></thead>
        <tbody id="commissionMonitor"></tbody>
      </table></div>
      <div class="commission-actions"><button type="button" class="acp-btn" id="commissionExport">导出联调报告 PDF</button></div>
      <div class="acp-note">仿真模式内置串联、自锁、500ms 定时器逻辑；Modbus TCP 使用 FC01/02/03/04/05/06，连接 5 秒超时。强制写入会二次确认，仿真强制值不会被规则覆盖。切换适配器会先断开旧连接。</div>
    </div>`;
  drawer.footer.innerHTML = '<span class="acp-pill">独立 PLC 模块</span><span class="acp-pill">操作超时 10 秒</span><span class="acp-pill">PDF 联调章节</span>';

  const get = <T extends HTMLElement>(selector: string): T => {
    const node = drawer.body.querySelector<T>(selector);
    if (!node) throw new Error(`联调面板节点缺失：${selector}`);
    return node;
  };
  elements = {
    drawer: drawer.root,
    kind: get<HTMLSelectElement>('#commissionKind'),
    hostField: get<HTMLElement>('#commissionHostField'),
    host: get<HTMLInputElement>('#commissionHost'),
    portField: get<HTMLElement>('#commissionPortField'),
    port: get<HTMLInputElement>('#commissionPort'),
    unitField: get<HTMLElement>('#commissionUnitField'),
    unitId: get<HTMLInputElement>('#commissionUnitId'),
    connect: get<HTMLButtonElement>('#commissionConnect'),
    disconnect: get<HTMLButtonElement>('#commissionDisconnect'),
    status: get<HTMLElement>('#commissionStatusBar'),
    lamp: get<HTMLElement>('#commissionLamp'),
    statusText: get<HTMLElement>('#commissionStatusText'),
    statusDetail: get<HTMLElement>('#commissionStatusDetail'),
    pointsBody: get<HTMLElement>('#commissionPoints'),
    powerList: get<HTMLElement>('#commissionPowerSteps'),
    powerRun: get<HTMLButtonElement>('#commissionPowerRun'),
    powerStep: get<HTMLButtonElement>('#commissionPowerStep'),
    powerSummary: get<HTMLElement>('#commissionPowerSummary'),
    cases: get<HTMLElement>('#commissionCases'),
    casesRun: get<HTMLButtonElement>('#commissionCasesRun'),
    caseResults: get<HTMLElement>('#commissionCaseResults'),
    monitorBody: get<HTMLElement>('#commissionMonitor'),
    scene3dHost: get<HTMLElement>('#commission3dHost'),
    scene3dMode: get<HTMLElement>('#commission3dMode'),
    scene3dToggle: get<HTMLInputElement>('#commission3dToggle'),
    diagnosis: get<HTMLElement>('#commissionDiagnosis'),
    diagnosisSummary: get<HTMLElement>('#commissionDiagnosisSummary'),
    export: get<HTMLButtonElement>('#commissionExport'),
    summary: get<HTMLElement>('#commissionSummary')
  };
  scene3d = createScene3D(elements.scene3dHost, machineConfig);
  exposeLinkagePoseBridge();
  const machineNote = drawer.root.querySelector<HTMLElement>('#commission3dMachine');
  if (machineNote) machineNote.textContent = machineSummary();
  scene3d.setEnabled(elements.scene3dToggle.checked);
  scene3d.setActive(drawer.isOpen());
  renderSceneMode();
  scene3dObserver?.disconnect();
  scene3dObserver = new MutationObserver(() => scene3d?.setActive(drawer.isOpen()));
  scene3dObserver.observe(drawer.root, { attributes: true, attributeFilter: ['hidden', 'class'] });
  bindEvents();
  bindDesktopEvents();
  renderPoints();
  renderPowerSteps();
  renderCases();
  renderCaseResults();
  renderDiagnosis([]);
  renderStatus(lastStatus);
  updateKindFields();
}

export function initCommissionPanel(options: PanelOptions): CommissionPanelHandle {
  optionsRef = options;
  buildPanel();
  const applyMachineConfig = (config: MachineConfig | null, layout?: GeomLayout | null): void => {
    let nextConfig: MachineConfig;
    let nextIoRows: MachineIoMapRow[];
    try {
      nextConfig = config ? validateMachineConfig(config) : demoMachineConfig();
      nextIoRows = buildMachineIoMap(nextConfig).rows;
    } catch (error) {
      const message = `机型 IO 映射无效：${errorMessage(error)}。请修正缺失或重复点位后再联调。`;
      setMessage(message, true);
      throw new Error(message);
    }
    machineConfig = nextConfig;
    machineIoRows = nextIoRows;
    machineLayout = config ? (layout ?? null) : null;
    powerResults = POWER_UP_STEPS.map(() => undefined);
    powerCursor = 0;
    caseReports = new Map();
    resetDiagnosis();
    if (!elements) return;
    scene3d?.dispose();
    elements.scene3dHost.innerHTML = '';
    scene3d = createScene3D(elements.scene3dHost, machineConfig, undefined, machineLayout);
    exposeLinkagePoseBridge();
    const summary = elements.drawer.querySelector<HTMLElement>('#commission3dMachine');
    if (summary) summary.textContent = machineSummary();
    scene3d.setEnabled(elements.scene3dToggle.checked);
    scene3d.setActive(drawerHandle?.isOpen() ?? false);
    renderSceneMode();
    renderPowerSteps();
    renderCases();
    renderCaseResults();
  };
  const handle: CommissionPanelHandle = {
    open(): void {
      drawerHandle?.open();
      scene3d?.setActive(true);
      void loadSavedConfig();
    },
    getReport,
    getMachineConfig: (): MachineConfig => machineConfig,
    setMachineConfig: applyMachineConfig,
    setKinematics,
    runPowerUp,
    runCase: runCaseById,
    runAllCases,
    setIoTestsEnabled(enabled: boolean): void {
      ioTestsEnabled = enabled === true;
      applyIoTestModuleState();
    },
    ioTestsEnabled: (): boolean => ioTestsEnabled,
    dispose(): void {
      scene3dObserver?.disconnect();
      scene3dObserver = null;
      scene3d?.dispose();
      scene3d = null;
    }
  };
  Object.defineProperty(window, '__Commission3D', {
    value: Object.freeze({
      stats: (): Commission3DStats => scene3d?.stats() ?? {
        frames: 0,
        ticks: 0,
        parts: 0,
        stations: 0,
        sensors: 0,
        actuators: 0,
        webgl: false,
        enabled: false,
        active: false,
        geometryParts: 0,
        envelopeMm: [0, 0, 0],
        layout: 'single',
        transformUpdates: 0
      },
      update: (incoming: Record<string, boolean | number>): void => scene3d?.update(incoming),
      highlight: (pointId: string, on: boolean): void => scene3d?.highlight(pointId, on),
      kinematicsMode: (): CommissionKinematicsMode => scene3d?.kinematicsMode() ?? {
        mode: 'config',
        reason: '3D 场景尚未就绪',
        parts: 0,
        sourceFile: ''
      },
      lastDiagnosis: (): Diagnosis[] => lastDiagnoses.map((diagnosis) => ({
        ...diagnosis,
        evidence: [...diagnosis.evidence],
        actions: [...diagnosis.actions]
      }))
    }),
    writable: false,
    configurable: false,
    enumerable: false
  });
  window.AutomationCadCommission = handle;
  return handle;
}
