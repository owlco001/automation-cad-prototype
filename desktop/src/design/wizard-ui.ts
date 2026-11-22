import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import styles from './wizard.css?inline';
import type { Placement } from '../enclosure/layout.ts';
import { buildEntryButton } from '../ui/panels.ts';
import { applyAxisValue, buildThreeMachine, disposeThreeMachine, type ThreeMachine } from '../machine/geometry-three.ts';
import { geometryToStl, partWorldTriangles } from '../machine/geometry-export.ts';
import { completeDesign } from './synthesis.ts';
import { toCsv, type BomRow } from '../export/bom.ts';
import { renderReportHtml } from '../export/report.ts';
import { generateProject } from '../plcgen/generate.ts';
import { buildMachineCircuit } from '../elec/machine-circuit.ts';
import { renderSheet } from '../elec/sheet.ts';
import { buildMachineIoMap } from '../machine/io-map.ts';
import { selectMotorProtection } from '../elec/protection.ts';
import type { ComponentPart } from '../shared/types.ts';
import type { MachineDesign } from '../machine/synth.ts';
import { MAX_ACTUATOR_TRAVEL_MM, MIN_ACTUATOR_TRAVEL_MM, validateMachineConfig } from '../commission/machine-config.ts';
import { actuatorRotationRangeInputError, actuatorTravelInputError, guardMotionInputs, renderActuatorTravelCell } from './actuator-travel-ui.ts';
import { generateCandidates, withReviewedCycle } from './candidates.ts';
import { syncDesignBom } from './bom-sync.ts';
import { autoLayout, inspectLayout, movePlacement, placementSnapshotFingerprint, setPlacementCoordinate, type DesignCanvasSize } from './layout.ts';
import { clampDesignCanvasZoom, designCanvasSvgDimensions, stepDesignCanvasZoom } from './canvas-viewport.ts';
import { buildCycleEngineeringNote, isDesignReviewCurrent, reviewDesign, type DesignReview } from './review.ts';
import { canSaveAsConcept, projectGeometryReviewFrom, type DesignSceneInfo } from './geometry-review.ts';
import { annotateBomRowsForGeometryReview, annotatePlcFilesForGeometryReview, canExportDesignDeliverables, geometryReviewExportNotes } from './geometry-review-export.ts';
import { saveDesignProject } from './save-service.ts';
import { DraftPersistence, type DraftSaveState } from './draft-persistence.ts';
import { buildStationCycleReport, renderStationCycleEditor } from './station-cycle.ts';
import { assessMachineFootprint, footprintAssessmentText, geometryForDesign, withFootprintAssessment, withGeometryAssessment } from './footprint.ts';
import { geometryPlanRoleColor, geometryPlanStationColor, projectMachineGeometryTopView, renderGeometryTopViewSvg } from './geometry-plan-view.ts';
import { analyzeConceptMotionEnvelopes, motionEnvelopeColor, renderMotionEnvelopePanel } from './motion-envelope.ts';
import { withStationGeometryOffset } from '../machine/station-layout.ts';
import { layoutHistory } from '../orbit/ui.ts';
import { applyLayoutSnapshot, layoutSnapshot } from '../layout-editor/model.ts';
import type { LayoutEditorHandle, LayoutEditorHost } from '../layout-editor/ui.ts';
import { createStationIdentity, stationIdentitiesFor } from '../machine/station-identity.ts';
import {
  briefToMachineBrief, canAdvance, DESIGN_STEPS, DESIGN_STEP_LABELS, shanghaiIso,
  emptyBrief, initialDraft, nextStep, parseDesignDraft, prevStep,
  mergeStationDrafts, resetActuatorTravelOnKindChange, selectCandidate, stationsFromDesign, validateStep, withBrief, withCandidates, withPendingBrief, withPlacements,
  withStations, type ActuatorDraft, type DesignDraft, type DesignProcess, type IncomingForm,
  type LoadingMethod, type MachineBriefInput, type StationDraft
} from './wizard-state.ts';
import {
  allocateActuatorPoints, allocateSensorPoint, allPoints, bindPartFields, filterPartsForKind,
  designIssueTargetFromPath, filterSensorParts, validatePartBindings, validatePointConflicts,
  type DesignPartIssue
} from './parts.ts';

/**
 * 整机布局 3D 编辑（可选模块 `design.layout-editor`）的宿主端口。
 *
 * 向导只在第 4 步渲染入口并在点击时取编辑器，不再静态 import 编辑器实现；
 * 实现方负责按需加载分块、注入样式并返回可用的编辑器句柄。
 */
export interface LayoutEditorPort {
  /** 模块开关；关闭时不渲染第 4 步的「3D 布局编辑」按钮（与迁出前一致）。 */
  isEnabled(): boolean;
  /** 按需打开；不可用时抛错（消息里带失败码），由向导在原位显示并允许重试。 */
  open(host: LayoutEditorHost): Promise<LayoutEditorHandle | null>;
}

export interface DesignWizardOptions {
  onSaved(id: string): Promise<void>;
  openProject(id: string): Promise<unknown>;
  sceneInfo(): DesignSceneInfo;
  importCad(): Promise<boolean>;
  notify(message: string, error?: boolean): void;
  layoutEditor?: LayoutEditorPort;
}

let activeWizard: { open(): void; close(): Promise<void> } | null = null;
const roleLabels = {
  frame: '机架', transfer: '输送/移载', plate: '底板', structure: '结构',
  fixture: '治具', actuator: '执行机构', sensor: '传感器', safety: '安全'
} as const;

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function numberText(value: number): string { return Number.isFinite(value) ? String(value) : ''; }
function geometryFor(design: MachineDesign): ReturnType<typeof geometryForDesign> {
  return geometryForDesign(design);
}
function bomRows(design: MachineDesign): BomRow[] {
  return design.bomDraft.items.map((item, index) => ({ index: index + 1, name: item.name, model: item.model ?? '待选型', quantity: item.qty, material: item.kind === 'electrical' ? '电气件' : '标准件', ...(item.note ? { note: item.note } : {}) }));
}

function renderDesignPartIssues(issues: readonly DesignPartIssue[]): string {
  if (issues.length === 0) return '';
  return `<div class="design-errors" aria-label="元件与点位校验错误">${issues.map((issue) => `<button type="button" class="design-issue-link" data-issue-path="${escapeHtml(issue.path)}" aria-label="定位到：${escapeHtml(issue.message)}"><code>${escapeHtml(issue.code)}</code> ${escapeHtml(issue.message)} <span class="design-issue-action">定位字段 →</span></button>`).join('')}</div>`;
}

export function initDesignWizard(options: DesignWizardOptions): { open(): void; close(): Promise<void> } {
  if (activeWizard) return activeWizard;
  // 捕获一次：第 4 步模板里有同名局部 `options`（下拉选项），不能直接用 options.layoutEditor。
  const layoutEditorPort = options.layoutEditor;
  let draft = initialDraft();
  let savedDraft = false;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let isLoading = false;
  let isClosing = false;
  let library: ComponentPart[] = [];
  let designSettings: { pricing?: import('../machine/cost-model.ts').MachinePricingLoad; builtinPricebook?: import('../cost/pricebook.ts').Pricebook } = {};
  let selectedStation = 0;
  let selectedGeometryStationId: string | null = null;
  let selectedPlacementId: string | null = null;
  let layoutZoom = 1;
  let layoutScroll = { left: 0, top: 0 };
  let review: DesignReview | null = null;
  let notice = '';
  /** 3D 布局编辑器的当前句柄；分块按需加载，未打开时保持 null。 */
  let layoutEditorHandle: LayoutEditorHandle | null = null;
  /** 3D 布局编辑器加载/打开失败的原位提示（含失败码，可点击重试）。 */
  let layoutEditorNotice = '';
  let finishActiveDrag: (() => void) | null = null;
  let finishActiveGeometryDrag: (() => void) | null = null;
  let partPicker: { station: number; kind: 'actuator' | 'sensor'; index: number } | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let controls: OrbitControls | null = null;
  let threeMachine: ThreeMachine | null = null;
  let animation = 0;
  let resizeObserver: ResizeObserver | null = null;
  let loadVersion = 0;
  const persistence = new DraftPersistence<DesignDraft>(async (snapshot) => {
    if (!window.desktop?.design) throw new Error('当前环境无法保存设计草稿');
    const result = await window.desktop.design.saveDraft(snapshot);
    if (!result.ok) throw new Error(result.message ?? '草稿保存失败');
  }, clone, (state) => {
    if (state.status === 'saved') {
      savedDraft = true;
      updateEntry();
    }
    updateSaveState(state);
  });
  const style = document.createElement('style');
  style.id = 'design-wizard-styles';
  style.textContent = styles;
  document.head.appendChild(style);
  const root = document.createElement('section');
  root.id = 'designWizard';
  root.className = 'design-wizard';
  root.hidden = true;
  root.setAttribute('aria-label', '整机设计五步向导');
  document.body.appendChild(root);
  const entry = buildEntryButton('designWizardEntry', '整机设计', '<svg viewBox="0 0 16 16"><path d="M2 12V5l6-3 6 3v7l-6 3zM2 5l6 3 6-3M8 8v7"/></svg>', () => open());
  entry?.classList.add('design-entry');
  const preview = document.createElement('div');
  preview.className = 'design-preview-modal';
  preview.hidden = true;
  preview.innerHTML = '<div class="design-preview-dialog" role="dialog" aria-modal="true" aria-label="整机 3D 预览"><div class="design-preview-head"><h3 id="designPreviewTitle">3D 预览</h3><button type="button" class="design-button" id="designPreviewClose">关闭</button></div><div class="design-preview-host" id="designPreviewHost"></div><div class="design-motion-controls"><label>运动轴<select id="designPreviewAxis" aria-label="选择预览运动轴"></select></label><label>运动位置（从原位到全行程）<input id="designPreviewMotion" type="range" min="0" max="100" step="1" value="0"></label><output id="designPreviewMotionValue" aria-live="polite">原位</output></div><p class="design-preview-note">鼠标拖动旋转、滚轮缩放。当前为概念估算占位体，未按元件型号真实包络建模，也不替代安装、实体干涉与强度校核。</p></div>';
  root.appendChild(preview);
  preview.querySelector('#designPreviewClose')?.addEventListener('click', closePreview);
  preview.querySelector('#designPreviewAxis')?.addEventListener('change', () => {
    const slider = preview.querySelector<HTMLInputElement>('#designPreviewMotion');
    if (slider) slider.value = '0';
    updatePreviewMotion();
  });
  preview.querySelector('#designPreviewMotion')?.addEventListener('input', updatePreviewMotion);

  function updateEntry(): void {
    if (!entry) return;
    const label = savedDraft && draft.brief.name ? `继续设计（第 ${draft.step} 步）` : '整机设计';
    const text = entry.querySelector('span');
    if (text) text.textContent = label;
    entry.title = label;
    entry.setAttribute('aria-label', label);
  }
  function updateSaveState(state: DraftSaveState = persistence.state): void {
    const label = root.querySelector<HTMLElement>('#designSaveState');
    const retry = root.querySelector<HTMLButtonElement>('#designRetrySave');
    if (!label || !retry) return;
    label.dataset.state = state.status;
    if (state.status === 'idle') label.textContent = savedDraft ? `草稿已保存 · ${draft.updatedAt}` : '编辑后自动保存';
    else if (state.status === 'pending') label.textContent = '有修改，等待保存…';
    else if (state.status === 'saving') label.textContent = '正在保存草稿…';
    else if (state.status === 'error') label.textContent = `保存失败：${state.error}`;
    else label.textContent = `草稿已保存 · ${escapeHtml(draft.updatedAt)}`;
    retry.hidden = state.status !== 'error';
  }
  async function flushDraft(): Promise<void> {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    await persistence.flush();
    updateSaveState();
  }
  function markDraftChanged(immediate = false): void {
    persistence.markDirty(draft);
    updateSaveState();
    if (saveTimer) clearTimeout(saveTimer);
    if (immediate) {
      void flushDraft().catch(() => undefined);
    } else {
      saveTimer = setTimeout(() => {
        saveTimer = null;
        void flushDraft().catch(() => undefined);
      }, 250);
    }
  }
  async function commit(next: DesignDraft, persist = true): Promise<void> {
    draft = next;
    if (persist) {
      markDraftChanged(true);
      await flushDraft();
    }
    render();
  }
  function closePreview(): void {
    preview.hidden = true;
    cancelAnimationFrame(animation);
    resizeObserver?.disconnect();
    resizeObserver = null;
    controls?.dispose();
    controls = null;
    if (threeMachine) disposeThreeMachine(threeMachine);
    threeMachine = null;
    renderer?.dispose();
    renderer?.domElement.remove();
    renderer = null;
    scene = null;
  }
  function updatePreviewMotion(): void {
    const select = preview.querySelector<HTMLSelectElement>('#designPreviewAxis');
    const slider = preview.querySelector<HTMLInputElement>('#designPreviewMotion');
    const output = preview.querySelector<HTMLOutputElement>('#designPreviewMotionValue');
    const node = select ? threeMachine?.actuators.get(select.value) : undefined;
    if (!node || !slider || !output) return;
    const ratio = Number(slider.value) / 100;
    const position = node.axis.kind === 'rotary' ? ratio * node.axis.rangeDeg : ratio;
    applyAxisValue(node, position);
    output.value = node.axis.kind === 'rotary'
      ? `${position.toFixed(1)}° / ${node.axis.rangeDeg}°`
      : `${(ratio * node.axis.strokeMm).toFixed(1)} / ${node.axis.strokeMm} mm`;
  }
  function setPreviewMotionAxes(design: MachineDesign, geometry: ReturnType<typeof geometryForDesign>): void {
    const select = preview.querySelector<HTMLSelectElement>('#designPreviewAxis');
    const slider = preview.querySelector<HTMLInputElement>('#designPreviewMotion');
    const output = preview.querySelector<HTMLOutputElement>('#designPreviewMotionValue');
    if (!select || !slider || !output) return;
    select.innerHTML = geometry.moving.map((axis) => {
      const actuator = design.config.actuators.find((item) => item.id === axis.actuatorId);
      const motion = axis.kind === 'rotary' ? `0–${axis.rangeDeg}°` : `${axis.strokeMm} mm`;
      return `<option value="${escapeHtml(axis.actuatorId)}">${escapeHtml(actuator?.name ?? axis.actuatorId)} · ${motion}</option>`;
    }).join('');
    const disabled = geometry.moving.length === 0;
    select.disabled = disabled;
    slider.disabled = disabled;
    slider.value = '0';
    output.value = disabled ? '无可预览运动轴' : '原位';
    if (!disabled) updatePreviewMotion();
  }
  function openPreview(design: MachineDesign): void {
    closePreview();
    preview.hidden = false;
    const host = preview.querySelector<HTMLElement>('#designPreviewHost');
    if (!host) return;
    const title = preview.querySelector('#designPreviewTitle');
    if (title) title.textContent = `${design.form.name} · 3D 预览`;
    const geometry = geometryFor(design);
    const note = preview.querySelector<HTMLElement>('.design-preview-note');
    const modelWarning = geometry.warnings.find((line) => line.includes('型号绑定未联动到 CAD 几何'));
    if (note) note.textContent = modelWarning
      ? `鼠标拖动旋转、滚轮缩放。当前为概念估算占位体，未按型号真实包络建模；${modelWarning} 不替代安装、干涉与强度校核。`
      : '鼠标拖动旋转、滚轮缩放。当前为概念估算占位体，不代表具体型号包络，也不替代安装、干涉与强度校核。';
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      host.appendChild(renderer.domElement);
      scene = new THREE.Scene();
      scene.background = new THREE.Color('#eaf0f2');
      camera = new THREE.PerspectiveCamera(38, 1, 0.01, 300);
      camera.position.set(8, 7, 10);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x66747c, 2.3));
      const light = new THREE.DirectionalLight(0xffffff, 2.4);
      light.position.set(5, 10, 8);
      scene.add(light);
      scene.add(new THREE.GridHelper(20, 20, 0x8da7ad, 0xc3d0d5));
      threeMachine = buildThreeMachine(geometry, { targetSpan: 7 });
      setPreviewMotionAxes(design, geometry);
      scene.add(threeMachine.root);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.target.set(0, 1, 0);
      controls.update();
      const resize = (): void => {
        if (!renderer || !camera || host.clientWidth === 0 || host.clientHeight === 0) return;
        renderer.setSize(host.clientWidth, host.clientHeight, false);
        camera.aspect = host.clientWidth / host.clientHeight;
        camera.updateProjectionMatrix();
      };
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(host);
      resize();
      const frame = (): void => {
        if (preview.hidden) return;
        controls?.update();
        if (renderer && scene && camera) renderer.render(scene, camera);
        animation = requestAnimationFrame(frame);
      };
      frame();
    } catch (error) {
      host.textContent = `3D 预览不可用：${errorMessage(error)}`;
      options.notify(`3D 预览不可用：${errorMessage(error)}`, true);
    }
  }
  function field(name: string, label: string, control: string, example: string, wide = false): string {
    return `<label class="design-field${wide ? ' wide' : ''}" data-field="${name}"><span>${label}</span>${control}<small>${example}</small><span class="design-error" data-error-for="${name}"></span></label>`;
  }
  function renderBrief(): string {
    const brief = draft.pendingBrief ?? draft.brief;
    const vendors = [...new Set(library.map((part) => part.vendor).filter((vendor): vendor is string => Boolean(vendor)))].sort();
    return `<h2>第 1 步 · 需求</h2><p class="design-help">从产品与工艺开始，后续每一步都能回退。留空工位数和占地，将使用方案推荐值。</p><form class="design-form" id="designBriefForm" novalidate>
      ${field('name', '产品/机型名称 *', `<input name="name" value="${escapeHtml(brief.name)}" placeholder="例如：连接器自动锁螺丝机" required>`, '必填；示例：连接器自动锁螺丝机', true)}
      ${field('incoming', '来料形式', `<select name="incoming">${[['bulk','散料'],['tray','托盘'],['aligned','整列'],['reel','卷料']].map(([key,label]) => `<option value="${key}" ${brief.incoming === key ? 'selected' : ''}>${label}</option>`).join('')}</select>`, '示例：振动盘供给的散料')}
      ${field('process', '工艺类型', `<select name="process">${[['screw','锁螺丝'],['dispense','点胶'],['inspection','检测'],['assembly','装配'],['packaging','包装']].map(([key,label]) => `<option value="${key}" ${brief.process === key ? 'selected' : ''}>${label}</option>`).join('')}</select>`, '使用现有 5 类工艺模板')}
      ${field('cyclePerMin', '目标产能（件/分钟）*', `<input name="cyclePerMin" type="number" min="0.01" step="0.1" value="${numberText(brief.cyclePerMin)}">`, '必须大于 0；示例：20')}
      ${field('stations', '期望工位数', `<input name="stations" type="number" min="1" max="12" step="1" value="${brief.stations ?? ''}" placeholder="自动推荐">`, '1–12 的整数，可留空')}
      ${field('load', '上下料方式', `<select name="load">${[['manual','人工'],['conveyor','输送线'],['robot','机械手']].map(([key,label]) => `<option value="${key}" ${brief.load === key ? 'selected' : ''}>${label}</option>`).join('')}</select>`, '示例：机械手上下料')}
      ${field('footprint', '占地限制：长 × 宽（mm）', `<div class="design-inline"><input name="lengthMm" type="number" min="1" value="${brief.footprint?.lengthMm ?? ''}" placeholder="长，例如 3000"><span>×</span><input name="widthMm" type="number" min="1" value="${brief.footprint?.widthMm ?? ''}" placeholder="宽，例如 1800"></div>`, '可留空；需同时填写两个正数')}
      ${field('voltage', '供电制式', `<select name="voltage"><option value="380VAC" ${brief.voltage === '380VAC' ? 'selected' : ''}>380VAC</option><option value="220VAC" ${brief.voltage === '220VAC' ? 'selected' : ''}>220VAC</option></select>`, '影响功率/电流估算')}
      ${field('brand', '品牌偏好', `<select name="brand"><option value="">不限</option>${vendors.map((vendor) => `<option value="${escapeHtml(vendor)}" ${brief.brand === vendor ? 'selected' : ''}>${escapeHtml(vendor)}</option>`).join('')}</select>`, '可留空；来自已启用元件库 vendor')}
    </form><section class="design-brief-stale" data-brief-stale hidden role="status" aria-live="polite"><strong>需求已修改；当前方案尚未重算</strong><p data-brief-stale-summary></p><p>关闭向导会自动保存这次需求编辑，原方案与布局仍可恢复。确认替换前，不会清除任何现有成果。</p><div class="design-brief-actions"><button type="button" class="design-button primary" data-action="recompute-brief" hidden>按新需求重算并替换</button><button type="button" class="design-button" data-action="restore-brief" hidden>撤销需求修改，恢复原需求</button></div></section>${notice ? `<div class="design-notice">${escapeHtml(notice)}</div>` : ''}`;
  }
  function renderCandidates(): string {
    return `<h2>第 2 步 · 方案对比</h2><p class="design-help">同一需求、同一 synthMachine 算法生成 3 个不同形态。点击卡片选择主方案；假设与警告全部展开。</p><div class="design-candidates">${(draft.candidates ?? []).map((candidate, index) => {
      const geometry = geometryFor(candidate);
      const footprintAssessment = assessMachineFootprint(draft.brief.footprint, geometry.envelope);
      const selected = draft.selectedIndex === index;
      return `<article class="design-candidate ${selected ? 'selected' : ''}" data-candidate="${index}" tabindex="0" role="button" aria-pressed="${selected}"><h3>${escapeHtml(candidate.form.name)}</h3><div class="design-candidate-id">${escapeHtml(candidate.form.id)}</div><div class="design-metrics">
        <div><span>工位数</span><b>${candidate.config.stations.length}</b></div><div><span>模型估算产能</span><b class="${candidate.cycle.meetsTarget ? '' : 'design-bad'}">${candidate.cycle.partsPerMinute.toFixed(2)} 件/分钟 · ${candidate.cycle.meetsTarget ? '估算覆盖目标（待实测）' : '估算低于目标'}</b></div>
        <div><span>占地限制 · CAD 估算包络</span><b class="${footprintAssessment.status === 'exceeds' ? 'design-bad' : ''}">${escapeHtml(footprintAssessmentText(footprintAssessment))}</b></div><div><span>装机功率 / 电流</span><b>${candidate.power.totalKw.toFixed(2)} kW / ${candidate.power.currentA.toFixed(2)} A</b></div>
        <div><span>成本合计</span><b>¥${candidate.cost.total.toFixed(2)}</b></div><div><span>缺价 / BOM</span><b>${candidate.cost.missingCount} 项 / ${candidate.bomDraft.items.length} 行</b></div>
        <div><span>警告条数</span><b>${candidate.warnings.length}</b></div><button type="button" class="design-button" data-preview="${index}">查看 3D 预览</button></div>
        <h3>设计假设（${candidate.assumptions.length}）</h3><ul class="design-text-list">${candidate.assumptions.map((line) => `<li>${escapeHtml(line)}</li>`).join('') || '<li>无</li>'}</ul>
        <h3>警告（${candidate.warnings.length}）</h3><ul class="design-text-list warnings">${candidate.warnings.map((line) => `<li>${escapeHtml(line)}</li>`).join('') || '<li>无</li>'}</ul></article>`;
    }).join('')}</div>`;
  }
  function renderStations(): string {
    const station = draft.stations[selectedStation];
    const issues = [...validatePartBindings(draft.stations, library), ...validatePointConflicts(draft.stations)];
    const layout = draft.design?.cycle.mode ?? 'linear';
    return `<h2>第 3 步 · 工位与元件</h2><p class="design-help">直接编辑工位、周期和元件。每站完整周期只有在明确确认公共等待、移载、上下料/转盘分度已计入后，才会用于人工节拍；单个动作的 durationMs 不会被误当成整机节拍。并行/单元布局目前缺少每通道映射，人工周期只记录、不参与目标判定。工位上移/下移和改名会保留固定身份；新增工位采用新身份，删除只丢弃该工位偏移。</p>${draft.stationIdentityNotice ? `<div class="design-notice" role="status">${escapeHtml(draft.stationIdentityNotice)}</div>` : ''}<div class="design-stations-layout"><aside class="design-panel"><button class="design-button" type="button" data-action="add-station">＋ 添加工位</button><div id="designStationList">${draft.stations.map((item, index) => `<div class="design-station-item ${index === selectedStation ? 'active' : ''}" data-station="${index}"><span class="grow">${escapeHtml(item.name)}<small> · ${item.actuators.length} 机构 / ${item.sensors.length} 传感</small></span><button class="design-icon-button" data-move-station="${index}" data-direction="-1" title="上移">↑</button><button class="design-icon-button" data-move-station="${index}" data-direction="1" title="下移">↓</button><button class="design-icon-button" data-delete-station="${index}" title="删除">×</button></div>`).join('')}</div></aside><div class="design-panel">${station ? `<div class="design-inline"><input aria-label="工位名称" id="designStationName" value="${escapeHtml(station.name)}"><span>执行机构 ${station.actuators.length} · 传感器 ${station.sensors.length}</span></div>${renderStationCycleEditor(station, selectedStation, layout, draft.stations.length)}
      <div class="design-notice">气缸/夹爪直线行程以 mm 输入（${MIN_ACTUATOR_TRAVEL_MM}–${MAX_ACTUATOR_TRAVEL_MM}）；旋转轴分度角以 ° 输入（0.1–360°，默认 90°）。默认值标为方案/系统估算，手工输入标为工程师输入·待复核；这些参数只驱动概念估算占位几何与运动预览，不代表型号、安装或制造数据。</div>
      <h3>执行机构 <button class="design-button" type="button" data-action="add-actuator">＋ 添加</button> <button class="design-button" type="button" data-preview-current>预览当前几何与运动</button></h3><div class="design-table-wrap"><table class="design-table"><thead><tr><th>名称</th><th>类型</th><th>绑定型号</th><th>行程（mm）/分度角（°）</th><th>伸出点位</th><th>缩回点位</th><th>夹紧点位</th><th>旋转点位</th><th>元件库</th><th></th></tr></thead><tbody>${station.actuators.map((item, index) => `<tr><td><input data-actuator="${index}" data-key="name" value="${escapeHtml(item.name)}"></td><td><select data-actuator="${index}" data-key="kind"><option value="cylinder" ${item.kind === 'cylinder' ? 'selected' : ''}>气缸</option><option value="gripper" ${item.kind === 'gripper' ? 'selected' : ''}>夹爪</option><option value="rotary" ${item.kind === 'rotary' ? 'selected' : ''}>旋转</option></select></td><td><input data-actuator="${index}" data-key="model" value="${escapeHtml(item.model ?? '')}" placeholder="待选型"></td><td class="design-travel-cell">${renderActuatorTravelCell(item, index)}</td><td><input data-actuator="${index}" data-key="extendPoint" value="${escapeHtml(item.extendPoint ?? '')}"></td><td><input data-actuator="${index}" data-key="retractPoint" value="${escapeHtml(item.retractPoint ?? '')}"></td><td><input data-actuator="${index}" data-key="gripPoint" value="${escapeHtml(item.gripPoint ?? '')}"></td><td>${item.kind === 'rotary' || item.point !== undefined ? `<input data-actuator="${index}" data-key="point" value="${escapeHtml(item.point ?? '')}">` : '—'}</td><td><button class="design-button" data-pick-part="actuator" data-index="${index}">选择</button></td><td><button class="design-icon-button" data-delete-actuator="${index}">×</button></td></tr>`).join('')}</tbody></table></div>
      <h3>传感器 <button class="design-button" type="button" data-action="add-sensor">＋ 添加</button></h3><div class="design-table-wrap"><table class="design-table"><thead><tr><th>点位</th><th>安装工位</th><th>绑定型号</th><th>元件库</th><th></th></tr></thead><tbody>${station.sensors.map((item, index) => `<tr><td><input data-sensor="${index}" data-key="point" value="${escapeHtml(item.point)}"></td><td>${escapeHtml(station.name)}</td><td><input data-sensor="${index}" data-key="model" value="${escapeHtml(item.model ?? '')}" placeholder="待选型"></td><td><button class="design-button" data-pick-part="sensor" data-index="${index}">选择</button></td><td><button class="design-icon-button" data-delete-sensor="${index}">×</button></td></tr>`).join('')}</tbody></table></div>` : '<p>请添加工位。</p>'}${renderPartPicker()}${renderDesignPartIssues(issues)}</div></div>`;
  }
  function renderPartPicker(): string {
    if (!partPicker) return '';
    const station = draft.stations[partPicker.station];
    const item = partPicker.kind === 'actuator' ? station?.actuators[partPicker.index] : station?.sensors[partPicker.index];
    const filtered = partPicker.kind === 'actuator' ? filterPartsForKind(library, (item as ActuatorDraft)?.kind ?? 'cylinder') : filterSensorParts(library);
    const categories = [...new Set(filtered.map((part) => part.category))].sort();
    return `<div class="design-part-picker"><b>从元件库绑定型号</b><div class="design-part-tools"><input id="designPartSearch" placeholder="搜索型号 / 名称 / 品牌" value=""><select id="designPartCategory"><option value="">全部分类</option>${categories.map((category) => `<option>${escapeHtml(category)}</option>`).join('')}</select></div><div id="designPartResults" data-total="${filtered.length}"></div></div>`;
  }
  function renderPartResults(): void {
    const host = root.querySelector('#designPartResults');
    if (!host || !partPicker) return;
    const query = (root.querySelector<HTMLInputElement>('#designPartSearch')?.value ?? '').trim().toLowerCase();
    const category = root.querySelector<HTMLSelectElement>('#designPartCategory')?.value ?? '';
    const station = draft.stations[partPicker.station];
    const item = partPicker.kind === 'actuator' ? station?.actuators[partPicker.index] : station?.sensors[partPicker.index];
    const candidates = (partPicker.kind === 'actuator' ? filterPartsForKind(library, (item as ActuatorDraft)?.kind ?? 'cylinder') : filterSensorParts(library))
      .filter((part) => (!category || part.category === category) && (!query || `${part.model} ${part.category} ${part.vendor ?? ''} ${part.id}`.toLowerCase().includes(query)));
    host.innerHTML = `<p>共 ${candidates.length} 条${candidates.length > 20 ? '，仅显示前 20 条' : ''}</p><div class="design-part-list">${candidates.slice(0, 20).map((part) => `<button type="button" class="design-part" data-bind-part="${escapeHtml(part.id)}" data-pack="${escapeHtml(part.packId ?? '')}"><b>${escapeHtml(part.model)}</b><small>${escapeHtml(part.vendor ?? '—')} · ${escapeHtml(part.category)} · ${escapeHtml(part.packId ?? '')}</small></button>`).join('')}</div>`;
  }
  function canvasSize(): DesignCanvasSize {
    if (draft.brief.footprint) return { width: draft.brief.footprint.lengthMm, height: draft.brief.footprint.widthMm };
    if (draft.design) {
      const envelope = geometryFor(draft.design).envelope;
      return { width: Math.ceil(envelope[0] / 35) * 35, height: Math.ceil(envelope[1] / 35) * 35 };
    }
    return { width: 2100, height: 1050 };
  }
  function geometryPlanMetrics(projection: Extract<ReturnType<typeof projectMachineGeometryTopView>, { status: 'ready' }>): string {
    return `当前几何 AABB 范围：X ${numberText(projection.bounds.minX)} ～ ${numberText(projection.bounds.maxX)} mm；Y ${numberText(projection.bounds.minY)} ～ ${numberText(projection.bounds.maxY)} mm。跨度 ${numberText(projection.widthMm)} × ${numberText(projection.depthMm)} mm · ${projection.partCount} 个零件 · ${projection.stations.length} 个工位。`;
  }
  function renderGeometryPlanView(): string {
    const blocked = (reason: string): string => `<section class="design-geometry-plan blocked" data-geometry-plan-status="blocked" role="status"><h3>当前几何无法生成可信的俯视包络或安全编辑工位</h3><p>${escapeHtml(reason)}</p><p>真实几何工位编辑已阻断；二维手工预排布仍可独立编辑，不会用 placements 替代或驱动 3D。</p></section>`;
    if (!draft.design) return blocked('当前没有已选设计或可投影的参数化几何。');
    try {
      const geometry = geometryFor(draft.design);
      const projection = projectMachineGeometryTopView(geometry);
      if (projection.status === 'blocked') return blocked(projection.reason);
      const motionAnalysis = analyzeConceptMotionEnvelopes(geometry);
      const roles: Array<[keyof typeof roleLabels, string]> = Object.entries(roleLabels) as Array<[keyof typeof roleLabels, string]>;
      const roleLegend = roles.map(([role, label]) => `<span><i style="--geometry-color:${geometryPlanRoleColor(role)}"></i>${label}</span>`).join('');
      const stationLegend = projection.stations.map((station, index) => `<span><i class="station" style="--geometry-color:${geometryPlanStationColor(index)}"></i>${escapeHtml(station.name)} · ${station.partCount} 件</span>`).join('');
      const motionLegend = motionAnalysis.status === 'computed'
        ? motionAnalysis.axes.map((axis, index) => axis.coverage === 'covered' ? `<span><i class="motion" style="--motion-color:${motionEnvelopeColor(index)}"></i>${escapeHtml(axis.actuatorId)} 运动包络</span>` : '').join('')
        : '<span><i class="motion" style="--motion-color:#c2410c"></i>运动包络未生成</span>';
      const activeStation = projection.stations.find((station) => station.id === selectedGeometryStationId) ?? projection.stations[0];
      if (!activeStation) return blocked('当前几何没有可选工位。');
      selectedGeometryStationId = activeStation.id;
      const activeStationIndex = Number(activeStation.id.slice(2)) - 1;
      const stationIdentity = stationIdentitiesFor(draft.design.config.id, draft.design.config.stations.length, draft.design.stationIdentities)[activeStationIndex];
      const identityNotice = draft.stationIdentityNotice ?? draft.design.stationGeometryWarning;
      const offset = draft.design.stationGeometryLayout?.offsets.find((item) => item.stationIdentity === stationIdentity) ?? { xMm: 0, yMm: 0 };
      const options = projection.stations.map((station) => `<option value="${escapeHtml(station.id)}" ${station.id === activeStation.id ? 'selected' : ''}>${escapeHtml(station.name)} · ${station.partCount} 件 · ${escapeHtml(station.id)}</option>`).join('');
      return `<section class="design-geometry-plan" data-geometry-plan-status="ready" data-geometry-part-count="${projection.partCount}">
        <h3>当前 3D 几何俯视 · 毫米 AABB · 可编辑工位平移</h3>
        <p class="design-geometry-plan-note">图形由当前 MachineGeometry 的零件形状尺寸、世界毫米中心与绕 Z 旋转计算；世界 X 向右、Y 向上。选定一个工位后输入全局 X/Y 平移，或在该工位零件/虚线框上拖动；这会重算同一份几何中的 stationId 组零件、工位原点与运动轴枢轴，不会修改尺寸、形状、行程或手工 placements。改名或重排按固定身份保留偏移；删除仅清除被删身份的偏移，新工位从生成器原点开始。内部 stN 会随顺序变化，不是持久身份。需求重算会生成新身份，不按名称或序号猜迁移；如有旧版偏移，提示会说明已安全清除。</p>
        <div class="design-geometry-station-editor" role="group" aria-label="真实 MachineGeometry 工位毫米平移">
          <label>明确选择工位<select id="geometryStationSelect" aria-label="选择要平移的几何工位">${options}</select></label>
          <label>X 平移（mm）<input type="number" step="any" data-geometry-station-offset="x" aria-label="所选工位 X 平移毫米" value="${numberText(offset.xMm)}"></label>
          <label>Y 平移（mm）<input type="number" step="any" data-geometry-station-offset="y" aria-label="所选工位 Y 平移毫米" value="${numberText(offset.yMm)}"></label>
          <button type="button" class="design-button primary" data-geometry-offset-apply>应用到当前几何</button>
          <button type="button" class="design-button" data-preview-current>预览当前 3D 几何</button>
          ${layoutEditorPort?.isEnabled() ? '<button type="button" class="design-button primary design-geometry-3d-entry" data-layout-editor-open title="在 3D 视口中直接拖动/旋转工位、对齐分布、吸附与干涉提示">3D 布局编辑</button>' : ''}
          <small>拖动标尺：SVG 坐标单位为 mm；图中网格按比例显示。偏移是相对生成器原始工位位置的绝对 X/Y 值。</small>
        </div>
        ${layoutEditorNotice ? `<div class="design-notice" role="status"><span>${escapeHtml(layoutEditorNotice)}</span> <button type="button" class="design-button" data-layout-editor-retry>重试</button></div>` : ''}
        ${identityNotice ? `<div class="design-notice" role="status">${escapeHtml(identityNotice)}</div>` : ''}
        ${notice ? `<div class="design-notice" role="status">${escapeHtml(notice)}</div>` : ''}
        <p class="design-geometry-plan-metrics" data-geometry-plan-envelope>${geometryPlanMetrics(projection)}</p>
        <div class="design-geometry-plan-canvas" aria-label="可拖动的真实几何毫米俯视">${renderGeometryTopViewSvg(projection, { selectedStationId: activeStation.id, showMillimeterRuler: true, motionAnalysis })}</div>
        <div class="design-geometry-plan-legend" aria-label="俯视包络图例">${roleLegend}${stationLegend}${motionLegend}</div>
        ${renderMotionEnvelopePanel(motionAnalysis)}
        <p class="design-geometry-plan-caveat">工程边界：输入几何仍是概念估算占位体，并非型号级外形。部件矩形是几何 AABB，可能大于真实轮廓；不代表安装净距、可达性、干涉或工程签核。下方二维预排布是另一种示意卡片视图，仍与本几何编辑相互独立；保存工程和每件 STL 使用当前几何偏移。</p>
      </section>`;
    } catch (error) {
      return blocked(`几何生成或校验失败：${errorMessage(error)}`);
    }
  }
  function renderLayout(): string {
    const size = canvasSize();
    const report = inspectLayout(draft.placements, size);
    const confirmationCurrent = report.overlaps.length > 0 && report.outOfBounds.length === 0 &&
      draft.layoutOverlapConfirmationFingerprint === placementSnapshotFingerprint(draft.placements);
    const scale = Math.min(1, 1000 / size.width);
    const overlapIds = new Set(report.overlaps.flatMap((pair) => [pair.a, pair.b]));
    const outIds = new Set(report.outOfBounds);
    const rails = Array.from({ length: Math.floor(size.height / 35) + 1 }, (_, index) => `<line class="design-rail" x1="0" y1="${index * 35}" x2="${size.width}" y2="${index * 35}"/>`).join('');
    const activePlacement = draft.placements.find((item) => item.id === selectedPlacementId) ?? draft.placements[0] ?? null;
    selectedPlacementId = activePlacement?.id ?? null;
    const placementContext = activePlacement
      ? activePlacement.id.startsWith('station:') ? '工位' : `${activePlacement.note ?? '未归属工位'} · ${activePlacement.tag ?? '元件'}`
      : '';
    const conflictList = report.overlaps.length ? `<section class="design-notice design-conflicts design-layout-conflicts" aria-labelledby="designLayoutConflictHeading"><h3 id="designLayoutConflictHeading">二维矩形重叠冲突（${report.overlaps.length} 对）</h3><p>下列对象在二维布局平面上相交。此项仅为二维矩形布局检查，不是 3D 几何干涉结论，也不会改变 3D 预览或 STL。</p><ul>${report.overlaps.map((pair) => {
      const left = draft.placements.find((item) => item.id === pair.a);
      const right = draft.placements.find((item) => item.id === pair.b);
      const describe = (item: typeof left, id: string): string => item
        ? `${escapeHtml(item.model || id)}（ID ${escapeHtml(id)}，X ${numberText(item.x)} / Y ${numberText(item.y)} mm）`
        : escapeHtml(id);
      return `<li>${describe(left, pair.a)} ↔ ${describe(right, pair.b)}</li>`;
    }).join('')}</ul>${report.outOfBounds.length
      ? '<p class="design-layout-blocked" role="alert">当前布局含越界项，必须先调整回画布内；越界时不能确认或继续。</p>'
      : `<label class="design-layout-overlap-confirm"><input type="checkbox" data-layout-overlap-confirmation aria-label="已核对当前二维布局重叠冲突并确认继续" ${confirmationCurrent ? 'checked' : ''}><span>我已核对以上冲突对象，并确认按当前二维布局继续</span></label><p class="design-layout-confirm-state" role="status">${confirmationCurrent ? '当前 placements 快照已确认；任何坐标或布局变更都会要求重新确认。' : '请先核对冲突对象并勾选确认框，之后才能进入下一步。'}</p>`}</section>` : '';
    return `<h2>第 4 步 · 布局</h2><p class="design-help">毫米坐标；拖动按 35 mm 导轨网格吸附，或选中布局项后直接输入毫米坐标。存在重叠时必须检查冲突对象并主动确认；越界始终阻断。</p><div class="design-notice design-layout-semantics" role="note"><strong>二维预排布 · 示意卡片：</strong>矩形尺寸仅为示意卡片；毫米坐标只代表二维预排布，不代表组件实际外形、安装包络或三维几何。示意卡片占画布比例按卡片矩形面积合计计算，重叠矩形可能重复计入，不能视为真实利用率或物理占地。坐标只写入工程 design.json，不驱动 3D 预览或整机/单件 STL。</div><div class="design-layout-tools"><button type="button" class="design-button" data-action="auto-layout">自动布局</button><b>${size.width} × ${size.height} mm</b><span>示意卡片占画布比例 ${report.utilization}%</span><span>已放置 ${report.placements}（工位 ${report.stations}）</span><span>重叠 ${report.overlaps.length}</span><span>越界 ${report.outOfBounds.length}</span></div><div class="design-layout-coordinate-editor" role="group" aria-label="精确毫米坐标编辑">${activePlacement ? `<div class="design-layout-selected"><strong>正在编辑：${escapeHtml(activePlacement.model || activePlacement.id)}</strong><small>${escapeHtml(placementContext)} · ID ${escapeHtml(activePlacement.id)}</small></div><label>X 坐标 (mm)<input type="number" step="any" data-placement-coordinate="x" aria-label="当前布局项 X 坐标（毫米）" value="${numberText(activePlacement.x)}"></label><label>Y 坐标 (mm)<input type="number" step="any" data-placement-coordinate="y" aria-label="当前布局项 Y 坐标（毫米）" value="${numberText(activePlacement.y)}"></label>` : '<p>当前没有布局项；请先回到第 3 步配置工位。</p>'}</div>${report.outOfBounds.length ? `<div class="design-errors" role="alert">越界：${report.outOfBounds.map(escapeHtml).join('、')}；请先调整坐标，越界为硬阻断。</div>` : ''}${conflictList}<div class="design-canvas"><svg id="designLayoutSvg" width="${size.width * scale}" height="${size.height * scale}" viewBox="0 0 ${size.width} ${size.height}" data-scale="${scale}" aria-label="整机毫米布局画布"><rect width="${size.width}" height="${size.height}" fill="#f8fbfb" stroke="#8aa4ad"/>${rails}${draft.placements.map((item) => {
      const selected = item.id === activePlacement?.id;
      const kind = item.id.startsWith('station:') ? '工位' : item.tag ?? '元件';
      return `<g data-placement="${escapeHtml(item.id)}" role="button" tabindex="0" aria-pressed="${selected}" aria-label="选择布局项 ${escapeHtml(item.model)}，${escapeHtml(kind)}，坐标 ${numberText(item.x)}、${numberText(item.y)} 毫米"><rect class="design-placement ${item.id.startsWith('station:') ? '' : 'part'} ${selected ? 'selected' : ''} ${overlapIds.has(item.id) ? 'overlap' : ''} ${outIds.has(item.id) ? 'outside' : ''}" x="${item.x}" y="${item.y}" width="${item.w}" height="${item.h}" rx="3"/><text class="design-placement-label" x="${item.x + 7}" y="${item.y + 20}">${escapeHtml(item.model)}</text><text class="design-placement-label" x="${item.x + 7}" y="${item.y + 37}" font-size="9">${numberText(item.x)}, ${numberText(item.y)} mm</text></g>`;
    }).join('')}</svg></div>${renderGeometryPlanView()}`;
  }
  function renderReview(): string {
    const currentReview = review && draft.design && reviewIsCurrent(review, draft.design) ? review : null;
    const scene = options.sceneInfo();
    const sceneParts = currentSceneParts();
    const inspectable = sceneParts.length > 0 && scene.source !== 'empty' && scene.source !== 'concept-placeholder';
    const conceptAllowed = Boolean(currentReview && canSaveAsConcept(currentReview));
    const exportAllowed = Boolean(currentReview && canExportDesignDeliverables(currentReview));
    const identityNotice = draft.stationIdentityNotice ?? draft.design?.stationGeometryWarning;
    const disabled = exportAllowed ? '' : 'disabled';
    const geometryStatus = (currentReview?.geometryCheck === 'not-executed'
      ? '<aside class="design-geometry-status unverified" role="status"><b>3D/干涉校核未执行/未验证</b><p>当前没有可检查的 CAD 几何。空场景仍是校核错误；只有显式保存为概念版才可继续。向导生成的 STL 只是概念估算占位体，不能用于型号级 CAD 校核。</p></aside>'
      : currentReview?.geometryCheck === 'aabb-screened'
        ? `<aside class="design-geometry-status screened" role="status"><b>仅完成包围盒级干涉初筛（${sceneParts.length} 件）</b><p>这不是 B-rep 精检、型号级实体验证或工程签核。保存工程后，项目中的向导 STL 仍是概念占位体。</p></aside>`
        : !inspectable
          ? '<aside class="design-geometry-status unverified" role="note"><b>当前没有可用于 3D/干涉校核的 CAD 几何</b><p>可先保存概念方案；随后导入 CAD 并返回本向导重新校核。</p></aside>'
          : '<aside class="design-geometry-status unverified" role="note"><b>本次 CAD 尚未对当前设计重新校核</b><p>请运行一键校核；导入几何只提供包围盒级初筛，不代表精检或工程签核。</p></aside>') + '<p class="design-help">导出仅生成文件，不代表验收或发布；概念未校核/仅 AABB 初筛标识会随文件保留。</p>';
    const importButton = !inspectable
      ? '<button class="design-button" type="button" data-action="import-cad-review">导入 CAD 并返回校核</button>'
      : '';
    const saveLabel = conceptAllowed ? '保存为概念工程（3D/干涉未验证）' : '保存为工程';
    const saveDisabled = !currentReview || (currentReview.errors > 0 && !conceptAllowed);
    return `<h2>第 5 步 · 校核与产出</h2><p class="design-help">除唯一的“干涉初筛未执行”错误外，其他错误仍阻断保存。显式概念保存不会把校核降为 warning 或通过。产出一律调用现有 BOM、PLC、电气与 PDF 能力；工程内 STL 仍是概念占位几何：第 4 步的二维 placements 不驱动 3D/STL，真实工位 X/Y 偏移会进入保存工程与 STL。</p>${identityNotice ? `<div class="design-notice" role="status"><strong>工位几何提示：</strong>${escapeHtml(identityNotice)} 如需调整，请返回第 4 步核对并重新定位；修改后重新运行一键校核。</div>` : ''}<button class="design-button primary" type="button" data-action="run-review">一键校核</button>${geometryStatus}${importButton}${currentReview ? `<p>错误 ${currentReview.errors} · 警告 ${currentReview.warnings} · 通过 ${currentReview.passed}</p><div class="design-review-groups">${(['error','warning','pass'] as const).map((severity) => `<section class="design-review-group ${severity}"><h3>${severity === 'error' ? '错误（阻断）' : severity === 'warning' ? '警告（可继续）' : '通过'}</h3>${currentReview.items.filter((item) => item.severity === severity).map((item) => `<div class="design-review-item"><b>${escapeHtml(item.title)}</b><p>${escapeHtml(item.detail)}</p></div>`).join('') || '<p>无</p>'}</section>`).join('')}</div>` : '<p class="design-help">尚未校核当前设计，或设计配置/BOM 已变更；请重新运行一键校核后再导出。</p>'}<h3>交付产出</h3><div class="design-deliverables"><button class="design-button" data-output="bom" ${disabled}>生成 BOM</button><button class="design-button" data-output="plc" ${disabled}>生成 PLC 工程</button><button class="design-button" data-output="elec" ${disabled}>生成电气原理图</button><button class="design-button" data-output="pdf" ${disabled}>导出 PDF 报告</button></div><div id="designOutput" class="design-output"></div><button class="design-button primary" data-action="save-project" ${saveDisabled ? 'disabled' : ''}>${saveLabel}</button>`;
  }
  function renderErrors(): string {
    const errors = validateStep(draft);
    return errors.length ? `<div class="design-errors" id="designValidationErrors">${errors.map((error) => `<div>${escapeHtml(error)}</div>`).join('')}</div>` : '';
  }
  function render(): void {
    if (root.hidden) return;
    closePreview();
    selectedStation = Math.min(selectedStation, Math.max(0, draft.stations.length - 1));
    const content = draft.step === 1 ? renderBrief() : draft.step === 2 ? renderCandidates() : draft.step === 3 ? renderStations() : draft.step === 4 ? renderLayout() : renderReview();
    root.innerHTML = `<header class="design-header"><div><h1>整机设计</h1><p>设计入口 · 从需求到可交付工程</p></div><div class="design-header-actions"><button class="design-button danger" data-action="discard">放弃草稿</button><button class="design-button" data-action="close" aria-label="保存并关闭设计向导">保存并关闭 Esc</button></div></header><ol class="design-steps">${DESIGN_STEPS.map((step) => `<li class="${draft.step === step ? 'active' : draft.step > step ? 'done' : ''}" data-step="${step}"><span class="design-step-number">${step}</span>${DESIGN_STEP_LABELS[step]}</li>`).join('')}</ol><main class="design-main"><div class="design-content">${content}${draft.step < 5 ? renderErrors() : ''}</div></main><footer class="design-footer"><span id="designSaveState" class="design-save-state" role="status" aria-live="polite"></span><button id="designRetrySave" type="button" class="design-button" data-action="retry-save" hidden>重试保存</button><span class="spacer"></span><button class="design-button" data-action="prev" ${draft.step === 1 ? 'disabled' : ''}>上一步</button><button class="design-button primary" data-action="next" ${draft.step === 5 ? 'disabled' : ''} title="${canAdvance(draft) ? '' : '点击后校验当前步骤'}">下一步</button></footer>`;
    root.appendChild(preview);
    updateBriefChangeStatus();
    bindEvents();
    updateSaveState();
    if (partPicker) renderPartResults();
  }
  function setLayoutZoom(value: number): void {
    const previous = layoutZoom;
    layoutZoom = clampDesignCanvasZoom(value);
    const canvas = root.querySelector<HTMLElement>('.design-canvas');
    const svg = root.querySelector<SVGSVGElement>('#designLayoutSvg');
    if (canvas && svg) {
      const size = canvasSize();
      const dimensions = designCanvasSvgDimensions(size, Math.min(1, 1000 / size.width), layoutZoom);
      const changed = layoutZoom !== previous;
      svg.setAttribute('width', String(dimensions.width));
      svg.setAttribute('height', String(dimensions.height));
      if (changed) {
        const factor = layoutZoom / previous;
        canvas.scrollLeft = Math.max(0, (canvas.scrollLeft + canvas.clientWidth / 2) * factor - canvas.clientWidth / 2);
        canvas.scrollTop = Math.max(0, (canvas.scrollTop + canvas.clientHeight / 2) * factor - canvas.clientHeight / 2);
      } else {
        canvas.scrollLeft = layoutScroll.left;
        canvas.scrollTop = layoutScroll.top;
      }
      layoutScroll = { left: canvas.scrollLeft, top: canvas.scrollTop };
    }
    const label = root.querySelector<HTMLOutputElement>('[data-layout-zoom-level]');
    if (label) label.value = `${Math.round(layoutZoom * 100)}%`;
    const out = root.querySelector<HTMLButtonElement>('[data-layout-zoom="out"]');
    const reset = root.querySelector<HTMLButtonElement>('[data-layout-zoom="reset"]');
    const inside = root.querySelector<HTMLButtonElement>('[data-layout-zoom="in"]');
    if (out) out.disabled = layoutZoom <= 0.5;
    if (reset) reset.disabled = layoutZoom === 1;
    if (inside) inside.disabled = layoutZoom >= 3;
  }
  function mountLayoutZoomControls(): void {
    const tools = root.querySelector<HTMLElement>('.design-layout-tools');
    if (!tools || tools.querySelector('[data-layout-zoom-controls]')) return;
    const group = document.createElement('div');
    group.className = 'design-zoom-tools';
    group.dataset.layoutZoomControls = '';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', '布局画布缩放');
    group.innerHTML = '<button type="button" class="design-button" data-layout-zoom="out" aria-label="缩小画布" title="缩小（−）">−</button><output data-layout-zoom-level aria-live="polite">100%</output><button type="button" class="design-button" data-layout-zoom="in" aria-label="放大画布" title="放大（+）">＋</button><button type="button" class="design-button" data-layout-zoom="reset" title="重置缩放（0）">重置</button><span>滚动条平移 · + / − 缩放</span>';
    tools.appendChild(group);
    group.querySelectorAll<HTMLButtonElement>('[data-layout-zoom]').forEach((button) => button.addEventListener('click', () => {
      const action = button.dataset.layoutZoom;
      setLayoutZoom(action === 'reset' ? 1 : stepDesignCanvasZoom(layoutZoom, action === 'in' ? 1 : -1));
    }));
    root.querySelector('.design-canvas')?.addEventListener('scroll', (event) => {
      const canvas = event.currentTarget as HTMLElement;
      layoutScroll = { left: canvas.scrollLeft, top: canvas.scrollTop };
    });
    setLayoutZoom(layoutZoom);
  }
  function focusIssue(path: string): void {
    const target = designIssueTargetFromPath(path);
    const station = target ? draft.stations[target.stationIndex] : undefined;
    const items = target?.itemType === 'actuator' ? station?.actuators : station?.sensors;
    if (!target || !station || !items?.[target.itemIndex]) return;
    selectedStation = target.stationIndex;
    partPicker = null;
    render();
    const rowSelector = target.itemType === 'actuator'
      ? `[data-actuator="${target.itemIndex}"]`
      : `[data-sensor="${target.itemIndex}"]`;
    const field = root.querySelector<HTMLInputElement | HTMLSelectElement>(`${rowSelector}[data-key="${target.field}"]`);
    if (!field) return;
    field.focus({ preventScroll: true });
    field.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  function readBrief(): MachineBriefInput {
    const form = root.querySelector<HTMLFormElement>('#designBriefForm');
    if (!form) return draft.brief;
    const data = new FormData(form);
    const numberValue = (name: string): number => Number(data.get(name));
    const length = numberValue('lengthMm');
    const width = numberValue('widthMm');
    return {
      name: String(data.get('name') ?? '').trim(), incoming: String(data.get('incoming')) as IncomingForm,
      process: String(data.get('process')) as DesignProcess, cyclePerMin: numberValue('cyclePerMin'),
      stations: String(data.get('stations') ?? '').trim() ? numberValue('stations') : null,
      load: String(data.get('load')) as LoadingMethod,
      footprint: String(data.get('lengthMm') ?? '').trim() || String(data.get('widthMm') ?? '').trim() ? { lengthMm: length, widthMm: width } : null,
      voltage: String(data.get('voltage')) === '220VAC' ? '220VAC' : '380VAC',
      brand: String(data.get('brand') ?? '').trim() || null
    };
  }
  function hasExistingBriefResults(value: DesignDraft = draft): boolean {
    return Boolean(value.candidates?.length || value.design || value.placements.length);
  }
  function updateBriefChangeStatus(): void {
    const panel = root.querySelector<HTMLElement>('[data-brief-stale]');
    if (!panel) return;
    const pending = draft.pendingBrief;
    const hasResults = hasExistingBriefResults();
    panel.hidden = !pending || !hasResults;
    const summary = panel.querySelector<HTMLElement>('[data-brief-stale-summary]');
    const recompute = panel.querySelector<HTMLButtonElement>('[data-action="recompute-brief"]');
    const restore = panel.querySelector<HTMLButtonElement>('[data-action="restore-brief"]');
    if (summary && pending && hasResults) {
      const selected = draft.design?.form.name ?? '尚未选择';
      const nextValues = [
        `新需求：${pending.name || '未命名'}，${pending.cyclePerMin} 件/分钟，${pending.stations ?? '自动推荐'} 工位。`,
        `当前主方案“${selected}”和 ${draft.candidates?.length ?? 0} 个旧候选将被替换，${draft.placements.length} 项二维布局将清空。`,
        '与新方案同名的工位编辑会尽可能保留；布局需重新检查和保存。'
      ];
      summary.textContent = nextValues.join(' ');
    } else if (summary) {
      summary.textContent = '';
    }
    if (recompute) recompute.hidden = !pending || !hasResults;
    if (restore) restore.hidden = !pending || !hasResults;
  }
  function buildCandidatesForBrief(brief: MachineBriefInput): MachineDesign[] {
    const machineBrief = briefToMachineBrief(brief);
    return generateCandidates(machineBrief).map((candidate) => {
      const completed = completeDesign(machineBrief, library, {
        formId: candidate.form.id,
        stationCount: candidate.config.stations.length,
        ...(designSettings.pricing ? { pricingLoad: designSettings.pricing } : {}),
        ...(designSettings.builtinPricebook ? { builtinPricebook: designSettings.builtinPricebook } : {})
      });
      const assessment = assessMachineFootprint(machineBrief.footprint, geometryFor(completed).envelope);
      return withGeometryAssessment(withFootprintAssessment(completed, assessment));
    });
  }
  function installCandidatesForBrief(brief: MachineBriefInput, candidates: MachineDesign[]): number {
    const previous = draft.stations;
    let next = withBrief(draft, brief);
    next = withCandidates(next, candidates);
    next = selectCandidate(next, 0);
    const merged = mergeStationDrafts(next.stations, previous);
    next = withStations(next, merged.stations);
    draft = next;
    return merged.kept;
  }
  async function recomputePendingBrief(): Promise<void> {
    if (isClosing) return;
    syncEditedDraft();
    const pending = draft.pendingBrief;
    if (!pending || !hasExistingBriefResults()) return;

    const errors = validateStep(withBrief(draft, pending));
    if (errors.length) {
      showBriefErrors(errors);
      return;
    }

    let candidates: MachineDesign[];
    try {
      candidates = buildCandidatesForBrief(pending);
    } catch (error) {
      options.notify(`新需求方案计算失败；原方案和布局仍保留：${errorMessage(error)}`, true);
      return;
    }

    const selected = draft.design?.form.name ?? '尚未选择';
    const hadGeometryOffsets = (draft.design?.stationGeometryLayout?.offsets.length ?? 0) > 0;
    const candidateNames = candidates.map((candidate, index) => `${index + 1}. ${candidate.form.name}`).join('\n');
    const confirmation = [
      '按新需求重新计算并替换当前设计？',
      '',
      `当前主方案“${selected}”及 ${draft.candidates?.length ?? 0} 个旧候选将被替换。`,
      `当前 ${draft.placements.length} 项二维布局将清空；同名工位的机构、传感器等编辑会尽可能保留。`,
      hadGeometryOffsets ? '旧几何工位偏移将全部清空；新方案按新工位身份重新定位，不会把偏移套到其他工位。' : '新方案将重新生成工位身份；如有需要，请在第 4 步重新设置工位偏移。',
      '',
      `新候选方案：\n${candidateNames}`,
      '',
      '取消后原方案和布局保持不变，待编辑需求仍会自动保存。'
    ].join('\n');
    if (!window.confirm(confirmation)) return;

    try {
      const kept = installCandidatesForBrief(pending, candidates);
      draft = nextStep(draft);
      review = null;
      notice = `已按新需求重算并替换旧方案；旧二维布局已清空，按名称保留 ${kept} 个工位的编辑明细${hadGeometryOffsets ? '；旧工位偏移已清空，请按新身份重新定位' : ''}。`;
      markDraftChanged(true);
      await flushDraft();
      render();
    } catch (error) {
      options.notify(`替换失败：${errorMessage(error)}`, true);
      render();
    }
  }
  function showBriefErrors(errors: string[]): void {
    const rules: [string, RegExp][] = [['name', /产品\/机型/], ['cyclePerMin', /目标产能/], ['stations', /工位数/], ['footprint', /占地/]];
    for (const [name, pattern] of rules) {
      const message = errors.find((error) => pattern.test(error));
      root.querySelector(`[data-field="${name}"]`)?.classList.toggle('invalid', Boolean(message));
      const target = root.querySelector(`[data-error-for="${name}"]`);
      if (target) target.textContent = message ?? '';
    }
    options.notify(errors[0] ?? '请完善需求', true);
  }
  function updateStationDrafts(stations: StationDraft[]): void {
    const previousDesign = draft.design;
    const previousIndex = selectedGeometryStationId?.match(/^st([1-9][0-9]*)$/)?.[1];
    const previousIdentity = previousDesign && previousIndex
      ? stationIdentitiesFor(previousDesign.config.id, previousDesign.config.stations.length, previousDesign.stationIdentities)[Number(previousIndex) - 1]
      : undefined;
    draft = withStations(draft, stations);
    const nextIndex = previousIdentity ? draft.design?.stationIdentities?.indexOf(previousIdentity) ?? -1 : -1;
    selectedGeometryStationId = nextIndex >= 0 ? `st${nextIndex + 1}` : null;
    if (draft.stationIdentityNotice) notice = draft.stationIdentityNotice;
  }
  function updateDesignFromStations(): void {
    if (!draft.design) return;
    updateStationDrafts(draft.stations);
    if (draft.design) {
      const assessment = assessMachineFootprint(draft.brief.footprint, geometryFor(draft.design).envelope);
      draft.design = withGeometryAssessment(withFootprintAssessment(draft.design, assessment));
    }
    review = null;
  }
  function updateGeometryStationOffset(stationId: string, xMm: number, yMm: number): boolean {
    if (!draft.design) return false;
    try {
      const source = geometryFor(draft.design);
      const updated = withStationGeometryOffset(draft.design, source, stationId, xMm, yMm);
      const geometry = geometryFor(updated);
      draft.design = withGeometryAssessment(withFootprintAssessment(
        updated,
        assessMachineFootprint(draft.brief.footprint, geometry.envelope)
      ));
      review = null;
      return true;
    } catch (error) {
      options.notify(`工位几何平移未应用：${errorMessage(error)}`, true);
      return false;
    }
  }
  /** 整机布局写回：与 X/Y 输入、俯视拖动、3D 布局编辑共用同一份 MachineDesign 主数据。 */
  function applyLayoutDesign(updated: MachineDesign): void {
    const geometry = geometryFor(updated);
    draft.design = withGeometryAssessment(withFootprintAssessment(updated, assessMachineFootprint(draft.brief.footprint, geometry.envelope)));
    review = null;
  }
  /** 记入与主视口共用的撤销时间线（快照只含工位位姿，绑定方案与稳定身份）。 */
  function recordLayoutEdit(before: MachineDesign | null, label: string, mergeKey?: string): void {
    if (!before || !draft.design) return;
    layoutHistory.record({ label, before: layoutSnapshot(before), after: layoutSnapshot(draft.design), at: Date.now(), ...(mergeKey ? { mergeKey } : {}) });
  }
  function closeLayoutEditorHandle(): void {
    layoutEditorHandle?.close();
    layoutEditorHandle = null;
  }
  function openLayoutEditorForDraft(): void {
    if (!draft.design) { options.notify('请先选择方案，再编辑整机布局。', true); return; }
    const port = options.layoutEditor;
    if (!port) {
      layoutEditorNotice = '整机布局 3D 编辑模块未加载（CHUNK_BRIDGE_UNAVAILABLE）：当前桌面外壳不提供模块分块。';
      render();
      return;
    }
    void port.open({
      getDesign: () => draft.design ?? null,
      commit: (next, label, mergeKey) => {
        const before = draft.design ?? null;
        if (!before) return false;
        applyLayoutDesign(next);
        recordLayoutEdit(before, label, mergeKey);
        notice = `3D 布局编辑：${label}；旧校核已失效，保存与 STL 使用当前几何。`;
        markDraftChanged(true);
        render();
        return true;
      },
      footprintRequirement: () => draft.brief.footprint ?? null,
      notify: options.notify
    }).then((handle) => {
      if (!handle) {
        layoutEditorNotice = '整机布局 3D 编辑未启动（CHUNK_UNAVAILABLE）：分块没有返回编辑器句柄。';
        render();
        return;
      }
      layoutEditorHandle = handle;
      if (layoutEditorNotice) {
        layoutEditorNotice = '';
        render();
      }
    }).catch((error: unknown) => {
      layoutEditorNotice = `整机布局 3D 编辑模块未加载：${errorMessage(error)}`;
      render();
    });
  }
  layoutHistory.setApplier((snapshot, label) => {
    if (!draft.design) return false;
    const next = applyLayoutSnapshot(draft.design, snapshot);
    if (!next) return false;
    applyLayoutDesign(next);
    notice = `已撤销/重做布局：${label}`;
    markDraftChanged(true);
    render();
    layoutEditorHandle?.refresh();
    return true;
  });
  function currentSceneParts() {
    const source = options.sceneInfo().source;
    if (source === 'empty' || source === 'concept-placeholder') return [];
    return window.__AgentBridge?.ready() ? window.__AgentBridge.getSceneParts() : [];
  }
  function reviewIsCurrent(candidate: DesignReview | null, design: MachineDesign): boolean {
    return isDesignReviewCurrent(candidate, design, currentSceneParts(), library,
      designSettings.pricing?.pricing, designSettings.builtinPricebook, draft.stations);
  }
  function syncEditedDraft(): void {
    const before = JSON.stringify({ ...draft, updatedAt: '' });
    if (draft.step === 1) {
      const brief = readBrief();
      if (JSON.stringify(brief) !== JSON.stringify(draft.pendingBrief ?? draft.brief)) {
        draft = withPendingBrief(draft, brief);
        updateBriefChangeStatus();
      }
    } else if (draft.step === 3) updateDesignFromStations();
    const after = JSON.stringify({ ...draft, updatedAt: '' });
    if (before !== after) markDraftChanged();
  }
  async function advance(): Promise<void> {
    try {
      if (!guardMotionInputs(root, (message) => options.notify(message, true))) return;
      syncEditedDraft();
      const validationDraft = draft.step === 1 && draft.pendingBrief ? withBrief(draft, draft.pendingBrief) : draft;
      let errors = validateStep(validationDraft);
      if (draft.step === 3) {
        const issues = [...validatePartBindings(draft.stations, library), ...validatePointConflicts(draft.stations)];
        errors = [...errors, ...issues.map((issue) => issue.message)];
      }
      if (draft.step === 4) {
        const report = inspectLayout(draft.placements, canvasSize());
        if (report.outOfBounds.length) errors.push(`布局越界：${report.outOfBounds.join('、')}；越界为硬阻断，不能确认后继续`);
        if (report.overlaps.length > 0 &&
            draft.layoutOverlapConfirmationFingerprint !== placementSnapshotFingerprint(draft.placements)) {
          errors.push('布局存在二维重叠冲突：请核对冲突对象并勾选确认后再继续');
        }
      }
      if (errors.length) {
        if (draft.step === 1) showBriefErrors(errors);
        else options.notify(errors.join('；'), true);
        render();
        return;
      }
      if (draft.step === 1) {
        if (draft.pendingBrief && hasExistingBriefResults()) {
          options.notify('当前方案与已编辑需求不一致；请先查看影响并点击“按新需求重算并替换”，或撤销需求修改。', true);
          render();
          return;
        }
        if (draft.pendingBrief || !hasExistingBriefResults()) {
          const brief = draft.pendingBrief ?? draft.brief;
          const candidates = buildCandidatesForBrief(brief);
          const previousCount = draft.stations.length;
          const kept = installCandidatesForBrief(brief, candidates);
          notice = previousCount ? `需求已应用并重新生成候选；按名称保留 ${kept} 个工位的编辑明细。` : '';
        }
      } else if (draft.step === 3 && draft.placements.length === 0) {
        draft = withPlacements(draft, autoLayout(draft.stations, canvasSize()));
      }
      draft = nextStep(draft);
      markDraftChanged(true);
      await flushDraft();
      render();
    } catch (error) {
      console.error('[design-wizard] advance failed', error);
      render();
      options.notify(errorMessage(error), true);
    }
  }
  async function discard(): Promise<void> {
    if (!window.confirm('确定放弃当前整机设计草稿？此操作不可撤销。')) return;
    finishActiveGeometryDrag?.();
    try {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      isClosing = true;
      root.inert = true;
      root.setAttribute('aria-busy', 'true');
      await persistence.waitForCurrentWrite();
      if (!window.desktop?.design) throw new Error('当前环境无法清除设计草稿');
      const result = await window.desktop.design.clearDraft();
      if (!result.ok) throw new Error('草稿删除失败');
      persistence.reset();
      layoutHistory.clear();
      closeLayoutEditorHandle();
      draft = initialDraft();
      savedDraft = false;
      review = null;
      notice = '';
      selectedStation = 0;
      updateEntry();
      render();
    } catch (error) {
      options.notify(`放弃草稿失败：${errorMessage(error)}`, true);
      render();
    } finally {
      isClosing = false;
      root.inert = false;
      root.removeAttribute('aria-busy');
    }
  }
  function stationAction(action: string): void {
    const stations = clone(draft.stations);
    if (action === 'add-station') {
      const index = stations.length + 1;
      stations.push({ id: createStationIdentity(), name: `工位 ${index}`, actuators: [], sensors: [] });
      selectedStation = stations.length - 1;
    } else if (action === 'add-actuator') {
      const station = stations[selectedStation];
      if (!station) return;
      const index = station.actuators.length;
      const kind = 'cylinder';
      station.actuators.push({ id: `actuator-${Date.now()}`, name: `气缸 ${index + 1}`, kind, station: station.name, ...allocateActuatorPoints(selectedStation, index, kind, allPoints(stations)) });
    } else if (action === 'add-sensor') {
      const station = stations[selectedStation];
      if (!station) return;
      const point = allocateSensorPoint(selectedStation, station.sensors.length + 1, 'proximity', allPoints(stations));
      station.sensors.push({ point, station: station.name, part: station.actuators[0]?.id ?? station.name });
    }
    updateStationDrafts(stations);
    updateDesignFromStations();
    markDraftChanged(true);
    render();
  }
  async function output(kind: string): Promise<void> {
    if (!draft.design) return;
    const outputNode = root.querySelector('#designOutput');
    if (!review || !reviewIsCurrent(review, draft.design)) {
      options.notify('设计配置或 BOM 已变化，请先运行一键校核。', true);
      if (outputNode) outputNode.textContent = '当前设计尚无有效校核结果，未生成产物。';
      return;
    }
    if (!canExportDesignDeliverables(review)) {
      const blocker = review.items.find((item) => item.severity === 'error');
      const message = `存在其他阻断错误，不能导出产物${blocker ? `：${blocker.title}` : ''}。仅“干涉初筛未执行”这一项错误可显式导出概念版。`;
      options.notify(message, true);
      if (outputNode) outputNode.textContent = message;
      return;
    }
    try {
      const design = draft.design;
      const geometryReview = projectGeometryReviewFrom(review, options.sceneInfo(), currentSceneParts().length);
      if (kind === 'bom') {
        const rows = bomRows(design);
        const annotatedRows = annotateBomRowsForGeometryReview(rows, geometryReview);
        const noteHeader = rows.length === 0
          ? `备注（${geometryReviewExportNotes(geometryReview).bom}）`
          : undefined;
        const csv = toCsv(annotatedRows, noteHeader ? { noteHeader } : {});
        const result = await window.desktop?.exportCostFile({ format: 'csv', fileName: `${draft.brief.name}-BOM.csv`, data: csv, suggestedName: `${draft.brief.name}-BOM` });
        if (!result?.ok) throw new Error(result?.message ?? 'BOM 导出失败');
        const drawer = document.createElement('aside');
        drawer.className = 'design-bom-drawer';
        drawer.innerHTML = `<header><h3>BOM · ${design.bomDraft.items.length} 行</h3><button class="design-button">关闭</button></header><p>已落盘：${escapeHtml(result.path ?? '')}</p><div class="design-table-wrap"><table class="design-table"><thead><tr><th>名称</th><th>型号</th><th>数量</th></tr></thead><tbody>${design.bomDraft.items.map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.model ?? '待选型')}</td><td>${item.qty}</td></tr>`).join('')}</tbody></table></div>`;
        drawer.querySelector('button')?.addEventListener('click', () => drawer.remove());
        root.appendChild(drawer);
        if (outputNode) outputNode.textContent = `BOM 已生成：${result.path ?? ''}`;
      } else if (kind === 'plc') {
        const generated = generateProject({ config: design.config, target: 'generic', bom: bomRows(design) });
        if (!generated.ok) throw new Error(generated.errors.map((issue) => issue.message).join('；'));
        const files = [...annotatePlcFilesForGeometryReview(generated.files, geometryReview), { path: 'design-io-map.csv', content: buildMachineIoMap(design.config).csv }];
        const result = await window.desktop?.plcgen.exportProject({ machineName: draft.brief.name, target: 'generic', files });
        if (!result?.ok) throw new Error(result?.message ?? 'PLC 导出失败');
        if (outputNode) outputNode.textContent = `PLC 工程已生成（${files.length} 个文件）：${result.zipPath ?? result.path ?? ''}`;
      } else if (kind === 'elec') {
        const protection = selectMotorProtection(design.power.totalKw);
        const circuit = buildMachineCircuit({ project: draft.brief.name, drive: { powerKw: design.power.totalKw, rpm: 1400, ratio: 18 }, sensors: design.config.sensors.map((sensor, index) => ({ tag: `-SQ${index + 1}`, label: sensor.point, address: `I0.${index % 8}` })), controls: { estop: true, startStop: true, lamp: true }, selection: protection, drawingNo: 'EL-DESIGN-001' });
        const sheet = renderSheet(circuit, { project: draft.brief.name, drawingNo: 'EL-DESIGN-001', page: '1 / 1', date: new Date().toISOString().slice(0, 10), notes: [`${design.power.totalKw.toFixed(2)} kW · ${design.power.currentA.toFixed(2)} A · ${design.config.stations.length} 工位`, ...geometryReviewExportNotes(geometryReview).svg] });
        const result = await window.desktop?.exportFile(`${draft.brief.name}-电气原理图.svg`, sheet.svg);
        if (result?.canceled) return;
        if (outputNode) outputNode.textContent = `电气原理图已生成：${result?.path ?? ''}\n${sheet.deliverable ? 'ERC 与布局检查通过' : `仍有 ${sheet.issues.length} 条图面提示，请复核`}`;
      } else if (kind === 'pdf') {
        const stationCycle = buildStationCycleReport(review.cycle, draft.stations, design.cycle.perMin);
        const cycleNote = buildCycleEngineeringNote(design, review.cycle.source);
        const engineeringNotes = cycleNote.kind === 'warning'
          ? { assumptions: design.assumptions, warnings: [...design.warnings, cycleNote.detail] }
          : { assumptions: [...design.assumptions, cycleNote.detail], warnings: design.warnings };
        const html = renderReportHtml({ project: { name: draft.brief.name, code: design.config.id, date: new Date().toISOString().slice(0, 10) }, bom: bomRows(design), interference: review.interference, stress: [], stationCycle, engineeringNotes, geometryReview, note: `整机设计：${design.form.name}；${review.power.totalKw} kW / ${review.power.currentA} A；成本 ¥${review.cost.total}。` });
        const result = await window.desktop?.exportReport({ html, projectName: draft.brief.name, page: { size: 'A3', landscape: true } });
        if (outputNode) outputNode.textContent = `PDF 报告已导出：${result?.path ?? ''}`;
      }
    } catch (error) { if (outputNode) outputNode.textContent = `失败：${errorMessage(error)}`; options.notify(errorMessage(error), true); }
  }
  async function importCadAndReturn(): Promise<void> {
    if (isClosing) return;
    isClosing = true;
    root.inert = true;
    root.setAttribute('aria-busy', 'true');
    try {
      syncEditedDraft();
      await flushDraft();
      closePreview();
      root.hidden = true;
      updateEntry();
      const imported = await options.importCad();
      if (imported) {
        review = null;
        notice = 'CAD 已导入。当前设计尚未重新校核，请运行一键校核后保存。';
      } else {
        notice = '未完成 CAD 导入；设计草稿仍保留，可稍后重试。';
      }
    } catch (error) {
      notice = `CAD 导入未完成；设计草稿仍保留：${errorMessage(error)}`;
      options.notify(notice, true);
    } finally {
      root.hidden = false;
      isClosing = false;
      root.inert = false;
      root.removeAttribute('aria-busy');
      render();
    }
  }
  async function saveProject(): Promise<void> {
    if (!draft.design || isClosing) return;
    const currentReview = review && reviewIsCurrent(review, draft.design) ? review : null;
    if (!currentReview) { options.notify('设计配置或 BOM 已变化，请先运行一键校核', true); return; }
    const conceptSave = canSaveAsConcept(currentReview);
    if (currentReview.errors && !conceptSave) { options.notify('存在阻断错误，不能保存为工程', true); return; }
    const geometryReview = projectGeometryReviewFrom(currentReview, options.sceneInfo(), currentSceneParts().length);
    isClosing = true;
    root.inert = true;
    root.setAttribute('aria-busy', 'true');
    try {
      validateMachineConfig(draft.design.config);
      const design = withReviewedCycle(draft.design, currentReview.cycle);
      draft.design = design;
      draft = { ...draft, updatedAt: shanghaiIso() };
      markDraftChanged(true);
      await flushDraft();
      const geometry = geometryFor(design);
      const stlData = geometryToStl(geometry);
      const result = await saveDesignProject((payload) => window.desktop!.projects.save(payload), async () => {
        if (conceptSave) return;
        const cleared = await window.desktop!.design.clearDraft();
        if (!cleared.ok) throw new Error('草稿删除失败');
      }, {
        name: draft.brief.name, process: draft.brief.process, params: { cyclePerMin: draft.brief.cyclePerMin, stations: draft.stations.length, lengthMm: geometry.envelope[0], widthMm: geometry.envelope[1] },
        parts: geometry.parts.length, massKg: null, envelope: geometry.envelope, material: [], design, config: design.config, geometryReview, stlData,
        placements: draft.placements,
        partData: geometry.parts.map((part) => ({ name: `${part.id}.stl`, data: geometryToStl({ ...geometry, parts: [part] }) }))
      });
      if (!result.ok || !result.id) throw new Error(result.message ?? '工程保存失败');
      const id = result.id;
      if (conceptSave) {
        savedDraft = true;
        persistence.markSaved(draft);
        await options.onSaved(id);
        notice = '概念工程已保存；3D/干涉校核未执行/未验证。可直接导入 CAD 并返回校核。';
        render();
        options.notify(notice);
        return;
      }
      savedDraft = false;
      persistence.reset();
      window.__AgentBridge?.applyMachineConfig({ config: design.config, layout: design.form.geometry.kind === 'conveyor' ? 'linear' : design.form.geometry.kind });
      window.__AgentBridge?.appendMachineBomRows({ source: 'design-wizard', batchId: `design-${id}`, rows: bomRows(design).map((row) => ({ no: row.index, name: row.name, spec: row.model, qty: row.quantity, mat: row.material, ...(row.note ? { note: row.note } : {}) })) });
      await options.onSaved(id);
      await options.openProject(id);
      closePreview();
      root.hidden = true;
      updateEntry();
    } catch (error) { options.notify(`保存失败：${errorMessage(error)}`, true); }
    finally {
      isClosing = false;
      root.inert = false;
      root.removeAttribute('aria-busy');
    }
  }
  function bindEvents(): void {
    mountLayoutZoomControls();
    const briefForm = root.querySelector<HTMLFormElement>('#designBriefForm');
    const captureBrief = (immediate: boolean): void => {
      const brief = readBrief();
      if (JSON.stringify(brief) !== JSON.stringify(draft.pendingBrief ?? draft.brief)) {
        draft = withPendingBrief(draft, brief);
        updateBriefChangeStatus();
        markDraftChanged(immediate);
      } else if (immediate && persistence.hasPendingChanges) {
        void flushDraft().catch(() => undefined);
      }
    };
    briefForm?.addEventListener('input', () => captureBrief(false));
    briefForm?.addEventListener('change', () => captureBrief(true));
    root.querySelectorAll<HTMLButtonElement>('[data-issue-path]').forEach((button) => button.addEventListener('click', () => focusIssue(button.dataset.issuePath ?? '')));
    root.querySelectorAll<HTMLElement>('[data-action]').forEach((button) => button.addEventListener('click', () => {
      if (isClosing) return;
      const action = button.dataset.action;
      if (action === 'close') void close(); else if (action === 'discard') void discard();
      else if (action === 'retry-save') void flushDraft().catch(() => undefined);
      else if (action === 'recompute-brief') void recomputePendingBrief();
      else if (action === 'restore-brief') {
        syncEditedDraft();
        if (draft.pendingBrief) {
          draft = withPendingBrief(draft, draft.brief);
          notice = '已撤销需求修改；原方案、工位编辑和二维布局均保留。';
          updateBriefChangeStatus();
          markDraftChanged(true);
          render();
        }
      }
      else if (action === 'next') void advance(); else if (action === 'prev') {
        syncEditedDraft();
        draft = prevStep(draft);
        markDraftChanged(true);
        void flushDraft().then(render).catch((error: unknown) => { render(); options.notify(errorMessage(error), true); });
      }
      else if (action === 'auto-layout') { draft = withPlacements(draft, autoLayout(draft.stations, canvasSize())); markDraftChanged(true); render(); }
      else if (action === 'run-review' && draft.design) {
        draft.design = withGeometryAssessment(syncDesignBom(draft.design));
        const scene = currentSceneParts();
        review = reviewDesign(draft.design, scene, library, designSettings.pricing?.pricing, designSettings.builtinPricebook, draft.stations);
        draft.design = { ...withReviewedCycle(draft.design, review.cycle), power: review.power, cost: review.cost };
        draft = { ...draft, updatedAt: shanghaiIso() };
        markDraftChanged(true);
        render();
      }
      else if (action === 'save-project') void saveProject();
      else if (action === 'import-cad-review') void importCadAndReturn();
      else if (action) stationAction(action);
    }));
    root.querySelectorAll<HTMLElement>('[data-output]').forEach((button) => button.addEventListener('click', () => void output(button.dataset.output ?? '')));
    root.querySelector<HTMLInputElement>('[data-layout-overlap-confirmation]')?.addEventListener('change', (event) => {
      const checkbox = event.currentTarget as HTMLInputElement;
      const report = inspectLayout(draft.placements, canvasSize());
      if (!checkbox.checked) {
        delete draft.layoutOverlapConfirmationFingerprint;
      } else if (report.overlaps.length > 0 && report.outOfBounds.length === 0) {
        draft.layoutOverlapConfirmationFingerprint = placementSnapshotFingerprint(draft.placements);
      } else {
        options.notify('布局越界或已无重叠；请先修正布局后再确认。', true);
        render();
        return;
      }
      draft = { ...draft, updatedAt: shanghaiIso() };
      markDraftChanged(true);
      render();
    });
    root.querySelectorAll<HTMLElement>('[data-preview]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); const design = draft.candidates?.[Number(button.dataset.preview)]; if (design) openPreview(design); }));
    root.querySelectorAll<HTMLElement>('[data-preview-current]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); if (draft.design) openPreview(draft.design); }));
    root.querySelector<HTMLElement>('[data-layout-editor-open]')?.addEventListener('click', (event) => { event.stopPropagation(); openLayoutEditorForDraft(); });
    root.querySelector<HTMLElement>('[data-layout-editor-retry]')?.addEventListener('click', (event) => { event.stopPropagation(); openLayoutEditorForDraft(); });
    root.querySelectorAll<HTMLElement>('[data-candidate]').forEach((card) => card.addEventListener('click', () => {
      const index = Number(card.dataset.candidate) as 0 | 1 | 2;
      const preserved = draft.stations;
      const hadGeometryOffsets = (draft.design?.stationGeometryLayout?.offsets.length ?? 0) > 0;
      draft = selectCandidate(draft, index);
      layoutHistory.clear();
      const merged = mergeStationDrafts(draft.stations, preserved);
      draft = withStations(draft, merged.stations);
      if (hadGeometryOffsets) {
        selectedGeometryStationId = null;
        notice = '已切换候选方案；旧工位几何偏移不会跨候选保留，请按新几何重新定位。';
      }
      review = null;
      markDraftChanged(true);
      render();
    }));
    root.querySelectorAll<HTMLElement>('[data-station]').forEach((item) => item.addEventListener('click', (event) => { if ((event.target as HTMLElement).closest('button')) return; selectedStation = Number(item.dataset.station); render(); }));
    const stationNameInput = root.querySelector<HTMLInputElement>('#designStationName');
    const updateStationName = (immediate: boolean): void => {
      const station = draft.stations[selectedStation];
      if (!station || !stationNameInput || station.name === stationNameInput.value) {
        if (immediate && persistence.hasPendingChanges) void flushDraft().catch(() => undefined);
        return;
      }
      station.name = stationNameInput.value;
      updateDesignFromStations();
      markDraftChanged(immediate);
    };
    stationNameInput?.addEventListener('input', () => updateStationName(false));
    stationNameInput?.addEventListener('change', () => { updateStationName(true); render(); });
    root.querySelectorAll<HTMLInputElement>('[data-station-cycle]').forEach((input) => {
      const updateCycleTime = (immediate: boolean): void => {
        const station = draft.stations[Number(input.dataset.stationCycle)];
        if (!station) return;
        const raw = input.value.trim();
        if (!raw) {
          station.cycleTime = null;
        } else {
          const seconds = input.valueAsNumber;
          if (Number.isFinite(seconds)) {
            station.cycleTime = {
              seconds,
              sharedTimeConfirmed: station.cycleTime?.sharedTimeConfirmed === true,
              source: 'engineer-input',
              verification: 'pending-measurement'
            };
          }
        }
        updateDesignFromStations();
        markDraftChanged(immediate);
      };
      input.addEventListener('input', () => updateCycleTime(false));
      input.addEventListener('change', () => { updateCycleTime(true); render(); });
    });
    root.querySelectorAll<HTMLInputElement>('[data-cycle-coverage]').forEach((input) => {
      input.addEventListener('change', () => {
        const station = draft.stations[Number(input.dataset.cycleCoverage)];
        const cycleTime = station?.cycleTime;
        if (!station || !cycleTime || !Number.isFinite(cycleTime.seconds) || cycleTime.seconds <= 0) return;
        station.cycleTime = { ...cycleTime, sharedTimeConfirmed: input.checked };
        updateDesignFromStations();
        markDraftChanged(true);
        render();
      });
    });
    root.querySelectorAll<HTMLElement>('[data-move-station]').forEach((button) => button.addEventListener('click', () => {
      const from = Number(button.dataset.moveStation);
      const to = from + Number(button.dataset.direction);
      if (to < 0 || to >= draft.stations.length) return;
      const stations = clone(draft.stations);
      const [item] = stations.splice(from, 1);
      if (item) stations.splice(to, 0, item);
      selectedStation = to;
      updateStationDrafts(stations);
      updateDesignFromStations();
      markDraftChanged(true);
      render();
    }));
    root.querySelectorAll<HTMLElement>('[data-delete-station]').forEach((button) => button.addEventListener('click', () => {
      const deletedIndex = Number(button.dataset.deleteStation);
      draft.stations.splice(deletedIndex, 1);
      selectedStation = draft.stations.length === 0 ? 0 : Math.min(deletedIndex, draft.stations.length - 1);
      updateDesignFromStations();
      markDraftChanged(true);
      render();
    }));
    for (const type of ['actuator', 'sensor'] as const) {
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`[data-${type}][data-key]`).forEach((input) => {
        const updateItem = (immediate: boolean): boolean => {
        const station = draft.stations[selectedStation]; if (!station) return false;
        const index = Number(input.dataset[type]); const item = type === 'actuator' ? station.actuators[index] : station.sensors[index];
        if (!item) return false;
        const key = input.dataset.key ?? '';
        if (type === 'actuator' && (key === 'travelMm' || key === 'rotationRangeDeg') && input instanceof HTMLInputElement) {
          const actuator = item as ActuatorDraft;
          const rotary = key === 'rotationRangeDeg';
          const error = rotary ? actuatorRotationRangeInputError(input.valueAsNumber) : actuatorTravelInputError(input.valueAsNumber);
          const errorLabel = root.querySelector<HTMLElement>(`[data-motion-error="${index}"]`);
          const sourceLabel = root.querySelector<HTMLElement>(`[data-motion-status="${index}"]`);
          input.setCustomValidity(error ?? '');
          input.setAttribute('aria-invalid', error ? 'true' : 'false');
          if (error) {
            if (errorLabel) errorLabel.textContent = error;
            if (sourceLabel) sourceLabel.textContent = '输入无效，尚未应用';
            if (immediate) options.notify(error, true);
            return false;
          }
          if (errorLabel) errorLabel.textContent = '';
          if (sourceLabel) sourceLabel.textContent = '工程师输入·待复核';
          if (rotary) {
            actuator.rotationRangeDeg = input.valueAsNumber;
            actuator.rotationRangeSource = 'engineer-input';
          } else {
            actuator.travelMm = input.valueAsNumber;
            actuator.travelSource = 'engineer-input';
          }
        } else if (key === 'kind' && type === 'actuator') {
          const actuator = item as ActuatorDraft;
          actuator.kind = input.value as ActuatorDraft['kind'];
          resetActuatorTravelOnKindChange(actuator);
          delete actuator.extendPoint; delete actuator.retractPoint; delete actuator.gripPoint; delete actuator.point;
          delete actuator.model; delete actuator.partId; delete actuator.packId;
          Object.assign(actuator, allocateActuatorPoints(selectedStation, index, actuator.kind, allPoints(draft.stations)));
        } else {
          (item as unknown as Record<string, string>)[key] = input.value;
          if (key === 'model') { delete item.partId; delete item.packId; }
        }
        updateDesignFromStations();
        markDraftChanged(immediate);
        return true;
        };
        input.addEventListener('input', () => updateItem(false));
        input.addEventListener('change', () => { if (updateItem(true)) render(); });
      });
      root.querySelectorAll<HTMLElement>(`[data-delete-${type}]`).forEach((button) => button.addEventListener('click', () => {
        const station = draft.stations[selectedStation]; if (!station) return;
        (type === 'actuator' ? station.actuators : station.sensors).splice(Number(button.dataset[`delete${type[0]?.toUpperCase()}${type.slice(1)}`]), 1);
        updateDesignFromStations();
        markDraftChanged(true);
        render();
      }));
    }
    root.querySelectorAll<HTMLElement>('[data-pick-part]').forEach((button) => button.addEventListener('click', () => { partPicker = { station: selectedStation, kind: button.dataset.pickPart as 'actuator' | 'sensor', index: Number(button.dataset.index) }; render(); }));
    root.querySelector('#designPartSearch')?.addEventListener('input', renderPartResults);
    root.querySelector('#designPartCategory')?.addEventListener('change', renderPartResults);
    root.querySelectorAll<HTMLElement>('[data-bind-part]').forEach((button) => button.addEventListener('click', () => {
      if (!partPicker) return;
      const part = library.find((item) => item.id === button.dataset.bindPart && (item.packId ?? '') === (button.dataset.pack ?? ''));
      const station = draft.stations[partPicker.station]; if (!part || !station) return;
      const item = partPicker.kind === 'actuator' ? station.actuators[partPicker.index] : station.sensors[partPicker.index];
      if (item) Object.assign(item, bindPartFields(part));
      partPicker = null; updateDesignFromStations(); markDraftChanged(true); render();
    }));
    root.querySelector<HTMLSelectElement>('#geometryStationSelect')?.addEventListener('change', (event) => {
      selectedGeometryStationId = (event.currentTarget as HTMLSelectElement).value;
      render();
    });
    root.querySelector<HTMLButtonElement>('[data-geometry-offset-apply]')?.addEventListener('click', () => {
      const stationId = selectedGeometryStationId;
      const xInput = root.querySelector<HTMLInputElement>('[data-geometry-station-offset="x"]');
      const yInput = root.querySelector<HTMLInputElement>('[data-geometry-station-offset="y"]');
      const xMm = xInput?.valueAsNumber ?? Number.NaN;
      const yMm = yInput?.valueAsNumber ?? Number.NaN;
      if (!stationId || !Number.isFinite(xMm) || !Number.isFinite(yMm)) {
        options.notify('请先选择工位，并输入有限的 X/Y 毫米平移。', true);
        return;
      }
      const beforeApply = draft.design ?? null;
      if (!updateGeometryStationOffset(stationId, xMm, yMm)) { render(); return; }
      recordLayoutEdit(beforeApply, `${stationId} X/Y = ${xMm}, ${yMm}`);
      notice = `已更新 ${stationId} 的真实几何平移；旧校核已失效。保存与 STL 将使用当前 MachineGeometry。`;
      markDraftChanged(true);
      render();
    });
    const geometryCanvas = root.querySelector<HTMLDivElement>('.design-geometry-plan-canvas');
    geometryCanvas?.addEventListener('pointerdown', (event) => {
      if (!draft.design || !selectedGeometryStationId) return;
      const target = event.target instanceof Element ? event.target : null;
      const outline = target?.closest<SVGGElement>('[data-geometry-station-id]');
      const part = target?.closest<SVGElement>('[data-station-id]');
      const hitStationId = part?.dataset.stationId ?? outline?.dataset.geometryStationId;
      if (hitStationId !== selectedGeometryStationId) return;
      const svg = geometryCanvas.querySelector<SVGSVGElement>('#designGeometryTopView');
      const matrix = svg?.getScreenCTM();
      if (!svg || !matrix) return;
      event.preventDefault();
      const inverse = matrix.inverse();
      const point = svg.createSVGPoint();
      point.x = event.clientX;
      point.y = event.clientY;
      const start = point.matrixTransform(inverse);
      const stationId = selectedGeometryStationId;
      const station = geometryFor(draft.design).stations.find((item) => item.id === stationId);
      const stationIdentity = stationIdentitiesFor(draft.design.config.id, draft.design.config.stations.length, draft.design.stationIdentities)[station?.index ?? -1];
      const existing = draft.design.stationGeometryLayout?.offsets.find((item) => item.stationIdentity === stationIdentity);
      const baseX = existing?.xMm ?? 0;
      const baseY = existing?.yMm ?? 0;
      const dragBefore = draft.design ?? null;
      let changed = false;
      let lastX = baseX;
      let lastY = baseY;
      const pointerId = event.pointerId;
      try { geometryCanvas.setPointerCapture(pointerId); } catch { /* Pointer capture may be unavailable in a test DOM. */ }
      const move = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== pointerId) return;
        point.x = moveEvent.clientX;
        point.y = moveEvent.clientY;
        const current = point.matrixTransform(inverse);
        const xMm = Math.round((baseX + current.x - start.x) * 1000) / 1000;
        const yMm = Math.round((baseY - current.y + start.y) * 1000) / 1000;
        if (Math.abs(xMm - lastX) < 0.001 && Math.abs(yMm - lastY) < 0.001) return;
        const priorDesign = draft.design;
        if (!updateGeometryStationOffset(stationId, xMm, yMm) || !draft.design) return;
        const projection = projectMachineGeometryTopView(geometryFor(draft.design));
        if (projection.status === 'blocked') {
          if (priorDesign) draft.design = priorDesign;
          return;
        }
        geometryCanvas.innerHTML = renderGeometryTopViewSvg(projection, { selectedStationId: stationId, showMillimeterRuler: true });
        const metrics = root.querySelector<HTMLElement>('[data-geometry-plan-envelope]');
        if (metrics) metrics.textContent = geometryPlanMetrics(projection);
        const xInput = root.querySelector<HTMLInputElement>('[data-geometry-station-offset="x"]');
        const yInput = root.querySelector<HTMLInputElement>('[data-geometry-station-offset="y"]');
        if (xInput) xInput.value = String(xMm);
        if (yInput) yInput.value = String(yMm);
        changed = true;
        lastX = xMm;
        lastY = yMm;
      };
      const finish = (): void => {
        geometryCanvas.removeEventListener('pointermove', move);
        geometryCanvas.removeEventListener('pointerup', finish);
        geometryCanvas.removeEventListener('pointercancel', finish);
        try { if (geometryCanvas.hasPointerCapture(pointerId)) geometryCanvas.releasePointerCapture(pointerId); } catch { /* Ignore a detached capture target. */ }
        if (finishActiveGeometryDrag === finish) finishActiveGeometryDrag = null;
        if (!changed) return;
        recordLayoutEdit(dragBefore, `拖动 ${station?.name ?? stationId}（俯视）`);
        notice = `已拖动 ${station?.name ?? stationId}：X ${lastX} mm / Y ${lastY} mm；旧校核已失效。`;
        markDraftChanged(true);
        render();
      };
      finishActiveGeometryDrag = finish;
      geometryCanvas.addEventListener('pointermove', move);
      geometryCanvas.addEventListener('pointerup', finish);
      geometryCanvas.addEventListener('pointercancel', finish);
    });
    root.querySelectorAll<HTMLInputElement>('[data-placement-coordinate]').forEach((input) => {
      const applyCoordinate = (immediate: boolean): boolean => {
        const axis = input.dataset.placementCoordinate;
        if (axis !== 'x' && axis !== 'y') return false;
        const current = draft.placements.find((item) => item.id === selectedPlacementId);
        const value = input.value.trim() ? input.valueAsNumber : Number.NaN;
        if (!current || !Number.isFinite(value)) return false;
        const replacement = setPlacementCoordinate(current, axis, value);
        if (replacement[axis] === current[axis]) {
          if (immediate && persistence.hasPendingChanges) void flushDraft().catch(() => undefined);
          return true;
        }
        draft = withPlacements(draft, draft.placements.map((item) => item.id === current.id ? replacement : item));
        markDraftChanged(immediate);
        return true;
      };
      input.addEventListener('input', () => { applyCoordinate(false); });
      input.addEventListener('change', () => {
        if (!applyCoordinate(true)) {
          options.notify('请输入有效的毫米坐标。', true);
          render();
          return;
        }
        render();
      });
    });
    root.querySelectorAll<SVGGElement>('[data-placement]').forEach((group) => group.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      const id = group.dataset.placement;
      if (!id) return;
      selectedPlacementId = id;
      render();
      [...root.querySelectorAll<SVGGElement>('[data-placement]')].find((candidate) => candidate.dataset.placement === id)?.focus();
    }));
    const svg = root.querySelector<SVGSVGElement>('#designLayoutSvg');
    svg?.addEventListener('pointerdown', (event) => {
      const group = (event.target as Element).closest<SVGGElement>('[data-placement]');
      if (!group || !svg) return;
      event.preventDefault();
      const id = group.dataset.placement;
      const item = draft.placements.find((placement) => placement.id === id); if (!item) return;
      selectedPlacementId = item.id;
      group.querySelector('rect')?.classList.add('selected');
      const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
      const start = point.matrixTransform(svg.getScreenCTM()?.inverse());
      const origin = { x: item.x, y: item.y };
      group.setPointerCapture(event.pointerId);
      const move = (moveEvent: PointerEvent): void => {
        point.x = moveEvent.clientX; point.y = moveEvent.clientY;
        const current = point.matrixTransform(svg.getScreenCTM()?.inverse());
        const replacement = movePlacement(item, origin.x + current.x - start.x, origin.y + current.y - start.y);
        draft.placements = draft.placements.map((placement) => placement.id === id ? replacement : placement);
        const rect = group.querySelector('rect'); const texts = group.querySelectorAll('text');
        rect?.setAttribute('x', String(replacement.x)); rect?.setAttribute('y', String(replacement.y));
        texts[0]?.setAttribute('x', String(replacement.x + 7)); texts[0]?.setAttribute('y', String(replacement.y + 20));
        texts[1]?.setAttribute('x', String(replacement.x + 7)); texts[1]?.setAttribute('y', String(replacement.y + 37));
        if (texts[1]) texts[1].textContent = `${replacement.x}, ${replacement.y} mm`;
      };
      const finish = (): void => {
        group.removeEventListener('pointermove', move);
        group.removeEventListener('pointerup', finish);
        group.removeEventListener('pointercancel', finish);
        if (finishActiveDrag === finish) finishActiveDrag = null;
        draft = withPlacements(draft, draft.placements);
        markDraftChanged(true);
        render();
      };
      finishActiveDrag = finish;
      group.addEventListener('pointermove', move);
      group.addEventListener('pointerup', finish);
      group.addEventListener('pointercancel', finish);
    });
  }
  async function close(): Promise<void> {
    if (root.hidden) return;
    closeLayoutEditorHandle();
    if (isLoading) {
      loadVersion += 1;
      isLoading = false;
      root.hidden = true;
      root.inert = false;
      root.removeAttribute('aria-busy');
      return;
    }
    if (isClosing) return;
    isClosing = true;
    root.inert = true;
    root.setAttribute('aria-busy', 'true');
    try {
      finishActiveDrag?.();
      finishActiveGeometryDrag?.();
      syncEditedDraft();
      await flushDraft();
      closePreview();
      root.hidden = true;
      updateEntry();
    } catch (error) {
      updateSaveState();
      options.notify(`草稿未能保存，向导仍保持打开：${errorMessage(error)}`, true);
    } finally {
      isClosing = false;
      root.inert = false;
      root.removeAttribute('aria-busy');
    }
  }
  async function open(): Promise<void> {
    if (!root.hidden) return;
    const version = ++loadVersion;
    root.hidden = false;
    isLoading = true;
    root.inert = true;
    closePreview();
    root.setAttribute('aria-busy', 'true');
    root.innerHTML = '<main class="design-main"><p class="design-help" role="status" aria-live="polite">正在读取设计草稿…</p></main>';
    try {
      const [parts, stored, settings] = await Promise.all([window.desktop?.packs.listParts() ?? Promise.resolve([]), window.desktop?.design.loadDraft() ?? Promise.resolve({ draft: null, recovered: false }), window.desktop?.design.settings() ?? Promise.resolve({ ok: false } as { ok: boolean; pricing?: import('../machine/cost-model.ts').MachinePricingLoad; builtinPricebook?: import('../cost/pricebook.ts').Pricebook })]);
      if (settings.ok) designSettings = { ...(settings.pricing ? { pricing: settings.pricing } : {}), ...(settings.builtinPricebook ? { builtinPricebook: settings.builtinPricebook } : {}) };
      if (version !== loadVersion) return;
      library = parts;
      if (stored.draft) {
        draft = parseDesignDraft(stored.draft);
        savedDraft = true;
        persistence.markSaved(draft);
      } else {
        draft = initialDraft();
        savedDraft = false;
        persistence.reset();
      }
      if (stored.recovered) {
        notice = '草稿文件损坏，已安全回落到第 1 步。';
        markDraftChanged(true);
      }
      if (draft.step === 2 && !draft.design && draft.candidates?.[0]) {
        draft = selectCandidate(draft, 0);
        markDraftChanged(true);
      }
      isLoading = false;
      root.inert = false;
      root.removeAttribute('aria-busy');
      updateEntry(); render();
    } catch (error) {
      if (version !== loadVersion) return;
      isLoading = false;
      root.inert = false;
      root.removeAttribute('aria-busy');
      options.notify(`读取设计草稿失败：${errorMessage(error)}`, true);
      render();
    }
  }
  document.addEventListener('keydown', (event) => {
    if (root.hidden) return;
    if (event.key === 'Escape') {
      if (!preview.hidden) closePreview(); else void close();
      event.stopPropagation();
      return;
    }
    if (draft.step !== 4 || !preview.hidden || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]'))) return;
    if (event.key === '+' || event.key === '=' || event.code === 'NumpadAdd') {
      event.preventDefault();
      setLayoutZoom(stepDesignCanvasZoom(layoutZoom, 1));
    } else if (event.key === '-' || event.key === '_' || event.code === 'NumpadSubtract') {
      event.preventDefault();
      setLayoutZoom(stepDesignCanvasZoom(layoutZoom, -1));
    } else if (event.key === '0' || event.code === 'Numpad0') {
      event.preventDefault();
      setLayoutZoom(1);
    }
  }, true);
  activeWizard = { open: () => void open(), close };
  updateEntry();
  return activeWizard;
}
