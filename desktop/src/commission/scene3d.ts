import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { probeWebGL } from '../cad/webgl.ts';
import { axisPose } from '../cad/kinematics.ts';
import {
  partToAxis,
  type KinematicsAnnotation,
  type MovingPart
} from '../cad/kinematics-ui.ts';
import { type ActuatorConfig, type MachineConfig, validateMachineConfig } from './machine-config.ts';
import { generateMachineGeometry, type GeomLayout, type MachineGeometry, type Vec3 } from '../machine/geometry.ts';
import {
  applyAxisValue,
  buildThreeMachine,
  disposeThreeMachine,
  type ThreeActuatorNode,
  type ThreeMachine
} from '../machine/geometry-three.ts';

// 诚实边界：这里的“联动”来自 machine-config.ts 中的点位/执行机构配置。
// STEP 文件只提供几何，没有轴类型、行程、方向或运动学关系，因此本场景不会从 STEP
// 自动识别机构。场景几何由 machine/geometry.ts 按配置生成参数化整机（机架、工位底板、
// 门架、气缸缸体+活塞杆、夹爪、旋转台、传感器、安全光栅、输送线/分度转盘，单位 mm），
// 运动件按生成器给出的轴向与行程动画；不是任意 STEP 自动联动。

export interface Commission3DStats {
  frames: number;
  ticks: number;
  /** 基座数 + 执行机构数，传感器不计入部件数。 */
  parts: number;
  stations: number;
  sensors: number;
  actuators: number;
  webgl: boolean;
  enabled: boolean;
  active: boolean;
  /** 参数化几何零件数（机架/底板/门架/机构/传感器等全部实体）。 */
  geometryParts: number;
  /** 外形包络 mm（X × Y × Z）。 */
  envelopeMm: Vec3;
  layout: GeomLayout;
  /** 实际写入 three.js 的变换次数；相同值会被跳过。 */
  transformUpdates: number;
}

export interface CommissionKinematicsMode {
  mode: 'annotation' | 'config';
  reason: string;
  parts: number;
  sourceFile: string;
}

interface AnnotationVisual {
  part: MovingPart;
  mesh: THREE.Mesh;
  basePosition: THREE.Vector3;
}

export interface ActuatorMotionSnapshot {
  id: string;
  kind: ActuatorConfig['kind'];
  /** cylinder: 0~1；gripper: 0~1（1 为闭合）；rotary: 0~90 度。 */
  target: number;
  value: number;
  from: number;
  startedAt: number;
  durationMs: number;
}

interface MutableMotion extends ActuatorMotionSnapshot {
  startedFrom: number;
}

interface ActuatorVisual {
  config: ActuatorConfig;
  group: THREE.Group;
  node: ThreeActuatorNode;
}

interface SensorVisual {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  onColor: THREE.Color;
}

interface HighlightMaterial {
  material: THREE.MeshStandardMaterial;
  color: THREE.Color;
  emissive: THREE.Color;
  emissiveIntensity: number;
}

type PointValues = Record<string, boolean | number>;

const BACKGROUND = 0x2a2d31;
const SENSOR_OFF = new THREE.Color(0x5d666e);
const SENSOR_DEFAULT_ON = new THREE.Color(0x2dd4bf);
const FAULT_COLOR = 0xff4d4f;
/** 场景中整机最大边长（场景单位）；mm → 场景单位的比例由几何包络反算。 */
const SCENE_SPAN = 6;

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function pointIsOn(values: PointValues, point: string | undefined): boolean {
  if (!point) return false;
  return values[point] === true || values[point.toUpperCase()] === true;
}

/**
 * 与 Three.js 解耦的逐轴状态机，便于用假 clock 验证目标值与插值。
 * 气缸未收到伸展/缩回信号时保持当前目标；两者同时为 true 时缩回优先。
 */
export class MachineMotion {
  private readonly config: MachineConfig;
  private readonly clock: () => number;
  private readonly states = new Map<string, MutableMotion>();
  private readonly sensorStates = new Map<string, boolean>();
  private readonly active = new Set<string>();

  constructor(config: MachineConfig, clock: () => number = defaultNow) {
    this.config = config;
    this.clock = clock;
    for (const actuator of config.actuators) {
      this.states.set(actuator.id, {
        id: actuator.id,
        kind: actuator.kind,
        target: 0,
        value: 0,
        from: 0,
        startedFrom: 0,
        startedAt: clock(),
        durationMs: actuator.durationMs ?? 400
      });
    }
    for (const sensor of config.sensors) this.sensorStates.set(sensor.point.toUpperCase(), false);
  }

  update(values: PointValues, now: number = this.clock()): boolean {
    let changed = false;
    for (const actuator of this.config.actuators) {
      const state = this.states.get(actuator.id);
      if (!state) continue;
      const nextTarget = this.targetFor(actuator, state.target, values);
      if (nextTarget !== state.target) {
        state.startedFrom = state.value;
        state.from = state.value;
        state.startedAt = now;
        state.target = nextTarget;
        this.active.add(actuator.id);
        changed = true;
      }
    }
    for (const sensor of this.config.sensors) {
      const key = sensor.point.toUpperCase();
      const on = pointIsOn(values, sensor.point);
      if (this.sensorStates.get(key) !== on) changed = true;
      this.sensorStates.set(key, on);
    }
    return changed;
  }

  advance(now: number = this.clock()): void {
    for (const id of this.active) {
      const state = this.states.get(id);
      if (!state) {
        this.active.delete(id);
        continue;
      }
      const elapsed = Math.max(0, now - state.startedAt);
      const ratio = Math.min(1, elapsed / Math.max(1, state.durationMs));
      const eased = ratio * ratio * (3 - 2 * ratio);
      state.value = ratio >= 1 ? state.target : state.startedFrom + (state.target - state.startedFrom) * eased;
      if (ratio >= 1) this.active.delete(id);
    }
  }

  snap(): void {
    for (const state of this.states.values()) state.value = state.target;
    this.active.clear();
  }

  getActuator(id: string): ActuatorMotionSnapshot | undefined {
    const state = this.states.get(id);
    return state ? { ...state } : undefined;
  }

  isSensorOn(point: string): boolean {
    return this.sensorStates.get(point.trim().toUpperCase()) === true;
  }

  private targetFor(actuator: ActuatorConfig, current: number, values: PointValues): number {
    if (actuator.kind === 'cylinder') {
      let target = current;
      if (pointIsOn(values, actuator.extendPoint)) target = 1;
      if (pointIsOn(values, actuator.retractPoint)) target = 0;
      return target;
    }
    if (actuator.kind === 'gripper') return pointIsOn(values, actuator.gripPoint) ? 1 : 0;
    return pointIsOn(values, actuator.point) ? 90 : 0;
  }
}

/**
 * 联动帧 → 场景坐标（纯函数，便于单测）。
 * 场景里 mm→m：x 直接映射、y↔z 互换并取反（与 basePosition 的换算口径一致）。
 * 这里**只做换算**，不插值、不推导运动——位移由 desktop 的 linkage 算好再传进来。
 */
export function linkagePosition(
  base: readonly number[],
  offsetMm: readonly number[] | undefined,
  scale: number
): [number, number, number] {
  const [bx = 0, by = 0, bz = 0] = base;
  const [dx = 0, dy = 0, dz = 0] = offsetMm ?? [];
  return [bx + dx * scale, by + dz * scale, bz - dy * scale];
}

export class CommissionScene3D {
  private readonly container: HTMLElement;
  private readonly config: MachineConfig;
  private readonly clock: () => number;
  private readonly motion: MachineMotion;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.05, 200);
  private readonly controlsRoot = new THREE.Group();
  private renderer: THREE.WebGLRenderer | null = null;
  private controls: OrbitControls | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private animationRunning = false;
  private initialized = false;
  private degraded = false;
  private enabled = true;
  private active = false;
  private latestValues: PointValues = {};
  private frames = 0;
  private ticks = 0;
  private highlightedPoint: string | null = null;
  private highlightedMaterials: HighlightMaterial[] = [];
  private readonly stationGroups = new Map<string, THREE.Group>();
  private readonly actuatorVisuals = new Map<string, ActuatorVisual>();
  private readonly sensorVisuals = new Map<string, SensorVisual>();
  private readonly targets = new Map<string, THREE.Object3D[]>();
  private geometry: MachineGeometry | null = null;
  private machine: ThreeMachine | null = null;
  private geometryScale = 1;
  private transformUpdates = 0;
  private readonly sensorOff = new THREE.Color(0x000000);
  private annotation: KinematicsAnnotation | null = null;
  private annotationVisuals: AnnotationVisual[] = [];
  /**
   * 整机机体网格（按零件 id 索引）。此前场景里只有 annotationVisuals（运动学标注盒），
   * 联动帧的 offsets 用的是**机体零件 id**，所以怎么接都动不到真实零件。
   */
  private bodyMeshes = new Map<string, { mesh: THREE.Mesh; base: THREE.Vector3 }>();
  private annotationGroup: THREE.Group | null = null;
  private annotationScale = 1;
  private layoutOverride: GeomLayout | null;
  private kinematics: CommissionKinematicsMode = {
    mode: 'config',
    reason: '尚未加载运动学标注',
    parts: 0,
    sourceFile: ''
  };

  constructor(
    container: HTMLElement,
    config: MachineConfig,
    clock: () => number = defaultNow,
    layout: GeomLayout | null = null
  ) {
    this.container = container;
    this.config = validateMachineConfig(config);
    this.clock = clock;
    this.layoutOverride = layout;
    this.motion = new MachineMotion(this.config, clock);
    this.scene.background = new THREE.Color(BACKGROUND);
    this.scene.add(this.controlsRoot);
    this.buildLights();
    this.buildModel();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.sync();
  }

  setActive(active: boolean): void {
    this.active = active;
    this.sync();
  }

  update(values: PointValues): void {
    this.latestValues = { ...values };
    const now = this.clock();
    if (this.enabled) {
      this.ticks += 1;
      this.frames += 1;
    }
    const changed = this.motion.update(values, now);
    if (this.degraded || !this.renderer) this.motion.snap();
    else this.motion.advance(now);
    if (changed) this.paintSensors();
    this.applyTransforms();
  }

  highlight(pointId: string, on: boolean): void {
    const normalized = pointId.trim().toUpperCase();
    if (!on) {
      if (this.highlightedPoint === normalized) this.clearHighlight();
      return;
    }
    this.clearHighlight();
    const targets = this.targets.get(normalized) ?? [];
    for (const target of targets) {
      target.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) {
          if (!(material instanceof THREE.MeshStandardMaterial)) continue;
          this.highlightedMaterials.push({
            material,
            color: material.color.clone(),
            emissive: material.emissive.clone(),
            emissiveIntensity: material.emissiveIntensity
          });
          material.color.setHex(FAULT_COLOR);
          material.emissive.setHex(0x8f1114);
          material.emissiveIntensity = 0.8;
          material.needsUpdate = true;
        }
      });
    }
    this.highlightedPoint = normalized;
  }

  clearHighlight(): void {
    for (const entry of this.highlightedMaterials) {
      entry.material.color.copy(entry.color);
      entry.material.emissive.copy(entry.emissive);
      entry.material.emissiveIntensity = entry.emissiveIntensity;
      entry.material.needsUpdate = true;
    }
    this.highlightedMaterials = [];
    this.highlightedPoint = null;
  }

  /**
   * 标注驱动优先：只要标注完整（网格、行程、点位都有效），就隐藏配置生成的执行机构；
   * 否则保留配置驱动，并通过 kinematicsMode() 暴露黄色提示原因。
   */
  setKinematics(annotation: KinematicsAnnotation | null): void {
    this.annotation = annotation;
    this.kinematics = this.evaluateKinematics(annotation);
    this.rebuildAnnotationVisuals();
    this.applyTransforms();
  }

  kinematicsMode(): CommissionKinematicsMode {
    return { ...this.kinematics };
  }

  stats(): Commission3DStats {
    return {
      frames: this.frames,
      ticks: this.ticks,
      parts: this.stationGroups.size + this.actuatorVisuals.size,
      stations: this.config.stations.length,
      sensors: this.sensorVisuals.size,
      actuators: this.actuatorVisuals.size,
      webgl: Boolean(this.renderer) && !this.degraded,
      enabled: this.enabled,
      active: this.active,
      geometryParts: this.geometry?.parts.length ?? 0,
      envelopeMm: this.geometry ? [...this.geometry.envelope] : [0, 0, 0],
      layout: this.geometry?.layout ?? 'single',
      transformUpdates: this.transformUpdates
    };
  }

  /** 当前场景使用的参数化几何（mm，Z 向上）；供导出与调试读取。 */
  machineGeometry(): MachineGeometry | null {
    return this.geometry;
  }

  motionState(actuatorId: string): ActuatorMotionSnapshot | undefined {
    return this.motion.getActuator(actuatorId);
  }

  sensorOn(point: string): boolean {
    return this.motion.isSensorOn(point);
  }

  dispose(): void {
    this.stopAnimation();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.controls?.dispose();
    this.controls = null;
    if (this.machine) {
      disposeThreeMachine(this.machine);
      this.machine = null;
    }
    // GridHelper 等场景直属资源不在 ThreeMachine 内，单独清理。
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) {
        for (const entry of material) entry.dispose();
      } else {
        material?.dispose();
      }
    });
    this.scene.clear();
    this.stationGroups.clear();
    this.actuatorVisuals.clear();
    this.sensorVisuals.clear();
    this.targets.clear();
    this.highlightedMaterials = [];
    this.geometry = null;
    this.renderer?.dispose();
    if (this.renderer?.domElement.parentElement === this.container) this.container.removeChild(this.renderer.domElement);
    this.renderer = null;
  }

  private evaluateKinematics(annotation: KinematicsAnnotation | null): CommissionKinematicsMode {
    if (!annotation || annotation.parts.length === 0) {
      return { mode: 'config', reason: '尚未加载运动学标注', parts: 0, sourceFile: '' };
    }
    const points = new Set<string>();
    for (const actuator of this.config.actuators) {
      for (const point of [actuator.extendPoint, actuator.retractPoint, actuator.gripPoint, actuator.point]) {
        if (point) points.add(point.trim().toUpperCase());
      }
    }
    for (const part of annotation.parts) {
      if (part.meshIds.length === 0) {
        return { mode: 'config', reason: `动件「${part.name}」未关联网格`, parts: annotation.parts.length, sourceFile: annotation.sourceFile };
      }
      if (part.kind === 'linear' && !(part.travelMm > 0)) {
        return { mode: 'config', reason: `动件「${part.name}」行程为 0`, parts: annotation.parts.length, sourceFile: annotation.sourceFile };
      }
      if (part.kind === 'rotary' && part.rangeDeg === 0) {
        return { mode: 'config', reason: `动件「${part.name}」角度为 0`, parts: annotation.parts.length, sourceFile: annotation.sourceFile };
      }
      if (!part.point.trim()) {
        return { mode: 'config', reason: `动件「${part.name}」未绑定点位`, parts: annotation.parts.length, sourceFile: annotation.sourceFile };
      }
      if (!points.has(part.point.trim().toUpperCase())) {
        return { mode: 'config', reason: `动件「${part.name}」点位不在机型配置中`, parts: annotation.parts.length, sourceFile: annotation.sourceFile };
      }
    }
    return {
      mode: 'annotation',
      reason: '',
      parts: annotation.parts.length,
      sourceFile: annotation.sourceFile
    };
  }

  private rebuildAnnotationVisuals(): void {
    if (this.annotationGroup) {
      this.controlsRoot.remove(this.annotationGroup);
      this.annotationGroup.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          node.geometry.dispose();
          const materials = Array.isArray(node.material) ? node.material : [node.material];
          for (const material of materials) material.dispose();
        }
      });
      this.annotationGroup = null;
    }
    this.annotationVisuals = [];
    for (const visual of this.actuatorVisuals.values()) visual.group.visible = this.kinematics.mode === 'config';
    if (!this.annotation || this.kinematics.mode !== 'annotation') {
      this.scene.updateMatrixWorld(true);
      return;
    }
    const group = new THREE.Group();
    group.name = 'kinematics-annotation';
    const parts = this.annotation.parts;
    const overall = new THREE.Box3();
    for (const part of parts) {
      const center = new THREE.Vector3(part.center[0], part.center[1], part.center[2]);
      const half = new THREE.Vector3(Math.max(part.size[0], 0.1), Math.max(part.size[1], 0.1), Math.max(part.size[2], 0.1)).multiplyScalar(0.5);
      overall.expandByPoint(center.clone().sub(half));
      overall.expandByPoint(center.clone().add(half));
    }
    const origin = overall.getCenter(new THREE.Vector3());
    const span = overall.getSize(new THREE.Vector3());
    this.annotationScale = 3.6 / Math.max(span.x, span.y, span.z, 1);
    const colors = [0x2dd4bf, 0x60a5fa, 0xf59e0b, 0xa78bfa, 0xf472b6, 0x84cc16];
    parts.forEach((part, index) => {
      const size = new THREE.Vector3(Math.max(part.size[0], 0.1), Math.max(part.size[1], 0.1), Math.max(part.size[2], 0.1)).multiplyScalar(this.annotationScale);
      const material = new THREE.MeshStandardMaterial({
        color: colors[index % colors.length] ?? 0x2dd4bf,
        metalness: 0.12,
        roughness: 0.52
      });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
      const basePosition = new THREE.Vector3(
        (part.center[0] - origin.x) * this.annotationScale,
        0.65 + (part.center[2] - origin.z) * this.annotationScale,
        -(part.center[1] - origin.y) * this.annotationScale
      );
      mesh.position.copy(basePosition);
      group.add(mesh);
      this.annotationVisuals.push({ part, mesh, basePosition });
    });
    this.controlsRoot.add(group);
    this.annotationGroup = group;
    this.applyAnnotationTransforms();
  }


  private applyAnnotationTransforms(): void {
    for (const visual of this.annotationVisuals) {
      const part = visual.part;
      const axis = partToAxis(part);
      const point = part.point.trim();
      const pose = axisPose(axis, point ? { [point]: true } : {});
      const offset = new THREE.Vector3(
        pose.offset[0] * this.annotationScale,
        pose.offset[2] * this.annotationScale,
        -pose.offset[1] * this.annotationScale
      );
      const sign = (part.rangeDeg < 0 ? -1 : 1) * (part.direction === -1 ? -1 : 1);
      const rotationRad = part.kind === 'rotary' ? pose.rotationRad * sign : 0;
      const axisVector =
        part.axis === 'x' ? new THREE.Vector3(1, 0, 0) : part.axis === 'y' ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
      visual.mesh.quaternion.setFromAxisAngle(axisVector, rotationRad);
      visual.mesh.position.copy(visual.basePosition).add(offset);
    }
  }


  /**
   * 按整机几何零件建机体网格（box 示意），返回建成的件数。
   * 只做 id→mesh 映射，位姿仍由 applyLinkagePose 套用，不在这里算运动。
   */
  buildMachineBody(parts: Array<{ id: string; center: number[]; size: number[] }>): number {
    this.bodyMeshes.clear();
    let built = 0;
    for (const part of parts ?? []) {
      const size = part?.size ?? [0, 0, 0];
      if (!part?.id || size.some((value) => !(Number(value) > 0))) continue;
      const [w = 0, h = 0, d = 0] = size;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w * this.annotationScale, h * this.annotationScale, d * this.annotationScale),
        new THREE.MeshStandardMaterial({ color: 0x93a4b8, metalness: 0.15, roughness: 0.6 })
      );
      const base = new THREE.Vector3(
        (part.center?.[0] ?? 0) * this.annotationScale,
        (part.center?.[2] ?? 0) * this.annotationScale,
        -(part.center?.[1] ?? 0) * this.annotationScale
      );
      mesh.position.copy(base);
      this.scene?.add(mesh);
      this.bodyMeshes.set(String(part.id), { mesh, base });
      built += 1;
    }
    return built;
  }

  /**
   * 应用一帧联动位姿（来自 desktop `poseAt()`）：只套用位移/转角，不在这里算运动。
   * 返回真正被摆动的零件数，便于自检断言。
   */
  applyLinkagePose(pose: { offsets?: Record<string, number[]>; rotZDeg?: Record<string, number> } = {}): number {
    const offsets = pose.offsets ?? {};
    const rotations = pose.rotZDeg ?? {};
    let applied = 0;
    // 机体零件优先：联动帧的 id 来自整机几何（st1-gripper-1-jaw-l 这类）
    for (const [id, entry] of this.bodyMeshes) {
      const offset = offsets[id];
      const position = linkagePosition([entry.base.x, entry.base.y, entry.base.z], offset, 1);
      entry.mesh.position.set(position[0], position[1], position[2]);
      const deg = rotations[id] ?? 0;
      entry.mesh.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (deg * Math.PI) / 180);
      if (Array.isArray(offset)) applied += 1;
    }
    for (const visual of this.annotationVisuals) {
      const id = String((visual.part as any).id ?? (visual.part as any).partId ?? '');
      const position = linkagePosition(
        [visual.basePosition.x, visual.basePosition.y, visual.basePosition.z],
        offsets[id],
        this.annotationScale
      );
      visual.mesh.position.set(position[0], position[1], position[2]);
      if (Array.isArray(offsets[id])) applied += 1;
      const deg = rotations[id] ?? 0;
      visual.mesh.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (deg * Math.PI) / 180);
    }
    return applied;
  }

  /** 自检/冒烟用：读回每个零件当前场景坐标，证明位姿真的被套用了 */
  debugPositions(): Record<string, [number, number, number]> {
    const out: Record<string, [number, number, number]> = {};
    for (const [id, entry] of this.bodyMeshes) {
      const p = entry.mesh.position;
      out[id] = [p.x, p.y, p.z];
    }
    for (const visual of this.annotationVisuals) {
      const id = String((visual.part as any).id ?? (visual.part as any).partId ?? '');
      const p = visual.mesh.position;
      out[id] = [p.x, p.y, p.z];
    }
    return out;
  }

  private sync(): void {
    const shouldRun = this.enabled && this.active;
    if (shouldRun && !this.initialized) this.initialize();
    if (shouldRun && this.renderer) {
      this.renderer.domElement.style.display = 'block';
      this.resize();
      this.update(this.latestValues);
      if (!this.animationRunning) {
        this.animationRunning = true;
        this.renderer.setAnimationLoop(this.animate);
      }
    } else {
      this.stopAnimation();
    }
  }

  private initialize(): void {
    this.initialized = true;
    const capability = probeWebGL(() => document.createElement('canvas'));
    if (!capability.ok) {
      this.enterDegradedMode(capability.reason ?? 'WebGL 不可用');
      return;
    }
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch (error) {
      this.enterDegradedMode(error instanceof Error ? error.message : String(error));
      return;
    }
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'commission-3d-canvas';
    renderer.domElement.style.touchAction = 'none';
    this.container.appendChild(renderer.domElement);

    const controls = new OrbitControls(this.camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    const targetY = this.geometry ? (this.geometry.envelope[2] * this.geometryScale) / 2 : 0.65;
    controls.minDistance = 2;
    controls.maxDistance = 32;
    controls.target.set(0, targetY, 0);
    controls.update();
    this.controls = controls;

    this.camera.position.set(5.6, targetY + 4.4, 6.4);
    this.camera.lookAt(0, targetY, 0);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.container);
    }
    this.resize();
  }

  private enterDegradedMode(reason: string): void {
    this.degraded = true;
    this.initialized = true;
    this.stopAnimation();
    this.container.innerHTML = '';
    const fallback = document.createElement('div');
    fallback.className = 'commission-3d-fallback';
    fallback.dataset.reason = reason;
    fallback.innerHTML = '<strong>当前环境不支持 WebGL</strong><span>3D 联动已停用，联调与故障诊断仍可正常使用。</span>';
    this.container.appendChild(fallback);
  }

  private stopAnimation(): void {
    if (!this.animationRunning) return;
    this.animationRunning = false;
    this.renderer?.setAnimationLoop(null);
    if (this.renderer) this.renderer.domElement.style.display = 'none';
  }

  private resize(): void {
    if (!this.renderer) return;
    const width = Math.max(1, Math.floor(this.container.clientWidth));
    const height = Math.max(1, Math.floor(this.container.clientHeight || 240));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private readonly animate = (time: number): void => {
    if (!this.renderer || !this.enabled || !this.active) return;
    this.motion.advance(time);
    this.applyTransforms();
    this.controls?.update();
    this.renderer.render(this.scene, this.camera);
    this.ticks += 1;
    this.frames += 1;
  };

  private applyTransforms(): void {
    if (this.kinematics.mode === 'annotation') {
      this.applyAnnotationTransforms();
      return;
    }
    for (const visual of this.actuatorVisuals.values()) {
      const state = this.motion.getActuator(visual.config.id);
      if (!state) continue;
      if (applyAxisValue(visual.node, state.value)) this.transformUpdates += 1;
    }
  }

  private paintSensors(): void {
    for (const sensor of this.config.sensors) {
      const key = sensor.point.toUpperCase();
      if (this.highlightedPoint === key) continue;
      const visual = this.sensorVisuals.get(key);
      if (!visual) continue;
      const on = this.motion.isSensorOn(sensor.point);
      visual.material.color.copy(on ? visual.onColor : SENSOR_OFF);
      visual.material.emissive.copy(on ? visual.onColor : this.sensorOff);
      visual.material.emissiveIntensity = on ? 1.15 : 0.05;
    }
  }

  private addTarget(key: string, objects: THREE.Object3D[]): void {
    this.targets.set(key, objects);
    this.targets.set(key.toUpperCase(), objects);
  }

  private buildLights(): void {
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.35));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(4.5, 7, 5.5);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x9ab5c7, 0.8);
    fill.position.set(-5, 3, -4);
    this.scene.add(fill);
  }

  private buildModel(): void {
    if (this.machine) {
      this.controlsRoot.remove(this.machine.root);
      disposeThreeMachine(this.machine);
      this.machine = null;
    }
    const geometry = generateMachineGeometry(this.config, this.layoutOverride ? { layout: this.layoutOverride } : {});
    const machine = buildThreeMachine(geometry, { targetSpan: SCENE_SPAN, sensorOffColor: SENSOR_OFF });
    this.geometry = geometry;
    this.machine = machine;
    this.geometryScale = machine.scale;

    const span = Math.max(geometry.envelope[0], geometry.envelope[1]) * machine.scale;
    const grid = new THREE.GridHelper(Math.max(9, Math.ceil(span + 3)), 32, 0x5d6770, 0x3a4047);
    grid.position.y = -0.002;
    this.controlsRoot.add(grid);
    this.controlsRoot.add(machine.root);

    for (const station of geometry.stations) {
      const group = machine.stationGroups.get(station.id);
      if (!group) continue;
      this.stationGroups.set(station.name, group);
      const plate = group.children.find((child) => child.name === `${station.id}-plate`);
      this.addTarget(station.name, [plate ?? group]);
    }

    for (const actuator of this.config.actuators) {
      const node = machine.actuators.get(actuator.id);
      if (!node) continue;
      this.actuatorVisuals.set(actuator.id, { config: actuator, group: node.group, node });
      this.addTarget(actuator.id, [node.group]);
      for (const point of [actuator.extendPoint, actuator.retractPoint, actuator.gripPoint, actuator.point]) {
        if (point) this.addTarget(point, [node.group]);
      }
    }

    for (const sensor of this.config.sensors) {
      const key = sensor.point.toUpperCase();
      const node = machine.sensors.get(key);
      if (!node || node.meshes.length === 0) continue;
      const [first] = node.meshes as [THREE.Mesh, ...THREE.Mesh[]];
      this.sensorVisuals.set(key, {
        mesh: first,
        material: node.material,
        onColor: new THREE.Color(sensor.color ?? SENSOR_DEFAULT_ON)
      });
      const partTargets = this.targets.get(sensor.part) ?? this.targets.get(sensor.part.toUpperCase()) ?? [];
      this.addTarget(sensor.point, [...node.meshes, ...partTargets]);
    }

    this.paintSensors();
    this.applyTransforms();
  }
}

export function createScene3D(
  container: HTMLElement,
  config: MachineConfig,
  clock?: () => number,
  layout?: GeomLayout | null
): CommissionScene3D {
  return new CommissionScene3D(container, config, clock, layout ?? null);
}
