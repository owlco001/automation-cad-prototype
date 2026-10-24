import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CadImportResult, CadMeshData } from '../shared/types.ts';
import { boundsFromPositions, type InterferencePart } from '../mech/interference.ts';
import { probeWebGL } from './webgl.ts';
import { buildPartMeta, planFrame, type FrustumPlane, type LodLevel, type PartMeta } from './render-plan.ts';
import {
  boxProxyGeometry,
  buildRenderOps,
  centerGeometry,
  decimateMesh,
  describeRenderOps,
  type RenderOps
} from './render-batch.ts';
import { assertBomRowCount } from '../shared/input-limits.ts';
import { stageCadLoad, type LoadedPart } from './load-candidate.ts';

export interface CadSelectionInfo {
  index: number;
  name: string;
  triangleCount: number;
  dimensions: [number, number, number];
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

export interface CadScenePart {
  name: string;
  triangles: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

export interface CadBomRow {
  no: number;
  name: string;
  spec: string;
  qty: number;
  mat: string;
  note?: string;
  partId?: string;
  category?: string;
  source?: string;
}

export interface CadKinematicsMesh {
  id: number;
  name: string;
  stableObjectId?: string;
  triangles: number;
  center: [number, number, number];
  size: [number, number, number];
}

export interface CadKinematicsGeometry extends CadKinematicsMesh {
  path?: string[];
  positions: Float32Array;
}

export interface CadPortableViewState {
  schemaVersion: 1;
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fovDeg: number;
  wireframe: boolean;
}

export interface CadKinematicsPose {
  offset: [number, number, number];
  rotationRad: number;
  axis: 'x' | 'y' | 'z';
}

export interface CadViewerOptions {
  container: HTMLElement;
  partsElement: HTMLElement;
  detailElement: HTMLElement;
  onStats?: (text: string) => void;
  onSelect?: (info: CadSelectionInfo | null) => void;
}

const DEFAULT_COLORS = [0x7f8b96, 0x9aa6b2, 0xb5a078, 0x6f9e9a, 0xa77e8d, 0x8e9b74];

export class CadViewer {
  private readonly container: HTMLElement;
  private readonly partsElement: HTMLElement;
  private readonly detailElement: HTMLElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1_000_000);
  private renderer: THREE.WebGLRenderer | null = null;
  private controls: OrbitControls | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private resizeObserver: ResizeObserver | null = null;
  private readonly group = new THREE.Group();
  /** 实例化与 LOD 代理的渲染对象放这里；原始 mesh 仍保留，负责拾取、导出与运动学 */
  private readonly batchGroup = new THREE.Group();
  /** 参数化重建前的旧模型，半透明叠加对比。不参与拾取。 */
  private readonly ghostGroup = new THREE.Group();
  /** 参数化生成体独立显示；不进入原 CAD 的拾取、BOM、运动学或导出数据。 */
  private readonly parametricOverlayGroup = new THREE.Group();
  private metas: PartMeta[] = [];
  private metaByIndex = new Map<number, PartMeta>();
  private renderOps: RenderOps | null = null;
  private originalGeometries = new Map<number, THREE.BufferGeometry>();
  private lodGeometries = new Map<string, THREE.BufferGeometry>();
  private instanceGeometries = new Map<string, THREE.BufferGeometry>();
  private planDirty = false;
  private lastPlanMs = 0;
  private planCount = 0;
  private readonly selectionBox = new THREE.Box3();
  private selectionHelper: THREE.Box3Helper | null = null;
  private featureHelper: THREE.Box3Helper | null = null;
  private grid: THREE.GridHelper | null = null;
  private parts: LoadedPart[] = [];
  private modelParts: InterferencePart[] = [];
  private draftBomRows: Array<Omit<CadBomRow, 'no'>> = [];
  private importedResult: CadImportResult | null = null;
  private selected: number | null = null;
  private pointerDown = { x: 0, y: 0 };
  private wireframe = false;
  private active = false;
  private degraded = false;
  private fallbackElement: HTMLElement | null = null;
  private onStats: ((text: string) => void) | undefined;
  private onSelect: ((info: CadSelectionInfo | null) => void) | undefined;
  private animationRunning = false;

  constructor(options: CadViewerOptions) {
    this.container = options.container;
    this.partsElement = options.partsElement;
    this.detailElement = options.detailElement;
    this.onStats = options.onStats;
    this.onSelect = options.onSelect;
    this.scene.background = new THREE.Color(0x2a2d31);
    this.scene.add(this.group);
    this.scene.add(this.batchGroup);
    this.ghostGroup.name = 'parametric-ghost';
    this.scene.add(this.ghostGroup);
    this.parametricOverlayGroup.name = 'parametric-overlay';
    this.scene.add(this.parametricOverlayGroup);
    this.scene.add(new THREE.HemisphereLight(0xf1f5f9, 0x2a2d31, 1.35));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(1, -1.4, 2);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xb9c6d2, 0.65);
    fill.position.set(-1.4, 1, 0.7);
    this.scene.add(fill);

    this.camera.up.set(0, 0, 1);
    const capability = probeWebGL(() => document.createElement('canvas'));
    if (!capability.ok) {
      this.enterDegradedMode(capability.reason ?? 'WebGL 不可用', null);
      return;
    }

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch (error) {
      this.enterDegradedMode(
        error instanceof Error ? error.message : String(error),
        null
      );
      return;
    }
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'cad-canvas';
    this.container.appendChild(renderer.domElement);

    const controls = new OrbitControls(this.camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN
    };
    this.controls = controls;
    controls.addEventListener('change', () => {
      this.planDirty = true;
    });

    const selectionHelper = new THREE.Box3Helper(this.selectionBox, 0x14b8a6);
    selectionHelper.visible = false;
    selectionHelper.renderOrder = 20;
    const helperMaterial = selectionHelper.material as THREE.LineBasicMaterial;
    helperMaterial.depthTest = false;
    helperMaterial.transparent = true;
    helperMaterial.opacity = 0.9;
    this.selectionHelper = selectionHelper;
    this.scene.add(selectionHelper);

    const featureHelper = new THREE.Box3Helper(new THREE.Box3(), 0xf5b942);
    featureHelper.visible = false;
    featureHelper.renderOrder = 21;
    const featureMaterial = featureHelper.material as THREE.LineBasicMaterial;
    featureMaterial.depthTest = false;
    featureMaterial.transparent = true;
    featureMaterial.opacity = 0.95;
    this.featureHelper = featureHelper;
    this.scene.add(featureHelper);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    renderer.domElement.addEventListener('pointerdown', this.handlePointerDown);
    renderer.domElement.addEventListener('pointerup', this.handlePointerUp);
    this.partsElement.addEventListener('click', this.handlePartClick);
    this.resize();
  }

  setActive(active: boolean): void {
    if (this.degraded || !this.renderer) return;
    this.active = active;
    if (active && !this.animationRunning) {
      this.animationRunning = true;
      this.renderer.setAnimationLoop(this.renderFrame);
    } else if (!active && this.animationRunning) {
      this.animationRunning = false;
      this.renderer.setAnimationLoop(null);
    }
    if (active) this.resize();
  }

  load(result: CadImportResult, fileName: string, options: { ghost?: boolean } = {}): void {
    // 超过 5000 行的 BOM 会拖垮侧栏与导出，解析后立即拒绝并给出拆分建议。
    assertBomRowCount(result.meshes.length);
    const modelParts = result.meshes.map((mesh) => ({
      name: mesh.name,
      bbox: boundsFromPositions(mesh.positions)
    }));
    if (!this.degraded) {
      // Build all fallible mesh resources before clearing the active document.
      const candidate = stageCadLoad(result, this.wireframe);
      let installed = false;
      try {
        if (options.ghost === true) this.captureGhost();
        else this.clearGhost();
        this.clearModel({ notify: false });
        this.parts = candidate.parts;
        this.parts.forEach((part) => this.group.add(part.mesh));
        this.importedResult = result;
        this.modelParts = modelParts;
        installed = true;

        this.renderPartList();
        this.fit();
        this.rebuildPlanState(candidate.metas);
        const bounds = this.totalBounds();
        const size = bounds.getSize(new THREE.Vector3());
        this.onStats?.(
          `${fileName} · ${result.stats.meshCount} 个零件 · ${result.stats.triangleCount.toLocaleString('zh-CN')} 个三角面 · ` +
          `${size.x.toFixed(3)} × ${size.y.toFixed(3)} × ${size.z.toFixed(3)} mm · ${result.stats.format}`
        );
        this.renderDetail(null);
      } finally {
        if (!installed) candidate.dispose();
      }
      return;
    }

    if (options.ghost === true) this.captureGhost();
    else this.clearGhost();
    this.clearModel();
    this.importedResult = result;
    this.modelParts = modelParts;
    this.loadDegraded(result, fileName);
  }

  /** 把当前模型复制为半透明幽灵层，用于参数化重建前后对比。 */
  captureGhost(): void {
    this.clearGhost();
    const datas: CadMeshData[] = this.parts.length > 0
      ? this.parts.map((part) => ({ ...part.data }))
      : this.importedResult?.meshes ?? [];
    datas.forEach((data, index) => {
      if (data.positions.length < 9) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(data.positions.slice(), 3));
      if (data.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals.slice(), 3));
      if (data.indices) geometry.setIndex(new THREE.BufferAttribute(data.indices.slice(), 1));
      if (!data.normals) geometry.computeVertexNormals();
      if (this.parts[index]) geometry.applyMatrix4(this.parts[index]!.mesh.matrixWorld);
      const material = new THREE.MeshStandardMaterial({
        color: 0x9aa6b2,
        metalness: 0.1,
        roughness: 0.8,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `ghost-${data.name}`;
      mesh.renderOrder = 2;
      this.ghostGroup.add(mesh);
    });
    this.ghostGroup.visible = true;
  }

  clearGhost(): void {
    for (const child of [...this.ghostGroup.children]) {
      this.ghostGroup.remove(child);
      const mesh = child as THREE.Mesh;
      mesh.geometry.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else material.dispose();
    }
  }

  setGhostVisible(visible: boolean): void {
    this.ghostGroup.visible = visible;
  }

  ghostVisible(): boolean {
    return this.ghostGroup.visible && this.ghostGroup.children.length > 0;
  }

  /**
   * 显示参数化 sidecar 输出为独立只读叠加体；不清空当前导入 CAD，也不加入 parts。
   * 原 STEP/B-rep 仍只是网格参考，叠加体不会被误认为已编辑的原始 CAD 特征。
   */
  setParametricOverlay(result: CadImportResult, options: { visible?: boolean } = {}): boolean {
    assertBomRowCount(result.meshes.length);
    this.clearParametricOverlay();
    if (this.degraded) return false;

    result.meshes.forEach((data, index) => {
      if (data.positions.length < 9) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(data.positions.slice(), 3));
      if (data.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals.slice(), 3));
      if (data.indices) geometry.setIndex(new THREE.BufferAttribute(data.indices.slice(), 1));
      if (!data.normals) geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      const material = new THREE.MeshStandardMaterial({
        color: 0xf0b64d,
        metalness: 0.12,
        roughness: 0.6,
        transparent: true,
        opacity: 0.58,
        depthWrite: false,
        wireframe: this.wireframe,
        side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `parametric-${data.name || `实体 ${index + 1}`}`;
      mesh.userData.parametricOverlay = true;
      mesh.renderOrder = 3;
      this.parametricOverlayGroup.add(mesh);
    });

    this.parametricOverlayGroup.visible = options.visible !== false;
    this.planDirty = true;
    if (this.parametricOverlayGroup.children.length === 0) return false;
    this.fit();
    return true;
  }

  clearParametricOverlay(): void {
    for (const child of [...this.parametricOverlayGroup.children]) {
      this.parametricOverlayGroup.remove(child);
      const mesh = child as THREE.Mesh;
      mesh.geometry.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else material.dispose();
    }
    this.parametricOverlayGroup.visible = true;
    this.planDirty = true;
  }

  setParametricOverlayVisible(visible: boolean): boolean {
    if (this.parametricOverlayGroup.children.length === 0) return false;
    this.parametricOverlayGroup.visible = visible;
    this.planDirty = true;
    return true;
  }

  hasParametricOverlay(): boolean {
    return this.parametricOverlayGroup.children.length > 0;
  }

  parametricOverlayVisible(): boolean {
    return this.parametricOverlayGroup.visible && this.hasParametricOverlay();
  }

  /** 高亮参数化特征的大致包围盒（无独立网格时的最小可用反馈）。 */
  highlightBounds(bounds: { min: [number, number, number]; max: [number, number, number] } | null, focus = false): boolean {
    if (this.degraded || !this.featureHelper) return false;
    if (!bounds) {
      this.featureHelper.visible = false;
      return false;
    }
    const box = new THREE.Box3(
      new THREE.Vector3(bounds.min[0], bounds.min[1], bounds.min[2]),
      new THREE.Vector3(bounds.max[0], bounds.max[1], bounds.max[2])
    );
    if (box.isEmpty()) {
      this.featureHelper.visible = false;
      return false;
    }
    this.featureHelper.box.copy(box);
    this.featureHelper.visible = true;
    if (focus && this.controls) {
      const center = box.getCenter(new THREE.Vector3());
      const offset = this.camera.position.clone().sub(this.controls.target);
      this.controls.target.copy(center);
      this.camera.position.copy(center).add(offset);
      this.controls.update();
    }
    return true;
  }

  fit(): void {
    if (this.degraded || !this.controls) return;
    const bounds = this.totalBounds();
    if (bounds.isEmpty()) {
      this.camera.position.set(760, -760, 620);
      this.camera.near = 0.1;
      this.camera.far = 100_000;
      this.camera.updateProjectionMatrix();
      this.controls.target.set(0, 0, 0);
      this.controls.update();
      this.updateGrid(new THREE.Vector3(600, 600, 600));
      return;
    }

    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 0.5);
    const distance = (radius / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.28;
    const direction = new THREE.Vector3(1, -1.2, 0.85).normalize();
    this.camera.position.copy(sphere.center).addScaledVector(direction, distance);
    this.camera.near = Math.max(radius / 10_000, 0.001);
    this.camera.far = Math.max(radius * 100, 1000);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(sphere.center);
    this.controls.update();
    this.updateGrid(sphere.center, radius * 2.4);
  }

  /** 当前帧渲染计划的中文概要（Agent / 调试面板用） */
  getRenderPlanText(): string | null {
    return this.renderOps ? describeRenderOps(this.renderOps) : null;
  }

  /** 立即重算一次渲染计划（插入/删除零件后调用） */
  refreshRenderPlan(): void {
    this.planDirty = false;
    this.replan();
  }

  private rebuildPlanState(precomputedMetas?: PartMeta[]): void {
    this.metas = precomputedMetas ?? [];
    this.metaByIndex.clear();
    if (!precomputedMetas) {
      this.parts.forEach((part, index) => {
        const positions = part.data.positions;
        if (!positions || positions.length < 9) return; // 占位件 / 空几何不参与规划
        const meta = buildPartMeta(
          {
            name: part.data.name,
            positions,
            indices: part.data.indices ?? null,
            ...(part.data.color ? { color: part.data.color } : {})
          },
          index
        );
        if (meta.triangleCount > 0) this.metas.push(meta);
      });
    }
    this.metas.forEach((meta) => this.metaByIndex.set(meta.index, meta));
    this.replan();
  }

  private replan(): void {
    if (this.degraded || !this.renderer) return;
    this.planDirty = false;
    this.lastPlanMs = Date.now();
    if (this.metas.length === 0) {
      this.renderOps = null;
      this.clearBatches();
      return;
    }
    this.planCount += 1;
    this.camera.updateMatrixWorld();
    const plan = planFrame(this.metas, {
      position: { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z },
      fovDeg: this.camera.fov,
      planes: this.frustumPlanes()
    });
    const ops = buildRenderOps(plan, this.metas);
    this.renderOps = ops;
    this.applyRenderOps(ops);
    this.refreshInstanceMatrices();
  }

  /** 从相机投影矩阵提取 6 个视锥平面（Gribb–Hartmann），避免引入额外依赖 */
  private frustumPlanes(): FrustumPlane[] {
    this.camera.updateMatrixWorld();
    const matrix = new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    const e = matrix.elements;
    const rows: number[][] = [
      [e[0] ?? 0, e[4] ?? 0, e[8] ?? 0, e[12] ?? 0],
      [e[1] ?? 0, e[5] ?? 0, e[9] ?? 0, e[13] ?? 0],
      [e[2] ?? 0, e[6] ?? 0, e[10] ?? 0, e[14] ?? 0],
      [e[3] ?? 0, e[7] ?? 0, e[11] ?? 0, e[15] ?? 0]
    ];
    const planeAt = (row: number[] | undefined, sign: number): FrustumPlane => {
      const r = row ?? [0, 0, 1, 0];
      const nx = (r[0] ?? 0) * sign;
      const ny = (r[1] ?? 0) * sign;
      const nz = (r[2] ?? 0) * sign;
      const length = Math.hypot(nx, ny, nz) || 1;
      return {
        normal: { x: nx / length, y: ny / length, z: nz / length },
        constant: ((r[3] ?? 0) * sign) / length
      };
    };
    return [
      planeAt(rows[3], 1), // 近
      planeAt(rows[3], -1), // 远
      planeAt(rows[0], 1), // 左
      planeAt(rows[0], -1), // 右
      planeAt(rows[1], 1), // 下
      planeAt(rows[1], -1) // 上
    ];
  }

  private applyRenderOps(ops: RenderOps): void {
    const hidden = new Set(ops.hidden);
    for (const part of this.parts) part.mesh.visible = true;
    for (const index of hidden) {
      const part = this.parts[index];
      if (part) part.mesh.visible = false;
    }

    this.clearBatches();

    const instancedParts = new Set<number>();
    for (const op of ops.ops) {
      if (op.kind === 'instance') {
        const firstIndex = op.partIndices[0];
        const firstPart = firstIndex === undefined ? undefined : this.parts[firstIndex];
        if (!firstPart) continue;
        const geometry = this.instanceGeometryFor(op.signature, op.partIndices, op.centers);
        if (!geometry) continue;
        const material = firstPart.mesh.material as THREE.Material;
        const instanced = new THREE.InstancedMesh(geometry, material, op.partIndices.length);
        instanced.name = `实例:${op.signature.slice(0, 8)}`;
        instanced.userData.partIndices = [...op.partIndices];
        instanced.userData.centers = op.centers.map((center) => new THREE.Vector3(center.x, center.y, center.z));
        instanced.userData.instanced = true;
        this.batchGroup.add(instanced);
        for (const index of op.partIndices) instancedParts.add(index);
      } else {
        const part = this.parts[op.partIndex];
        if (!part) continue;
        part.mesh.geometry = this.geometryForLod(op.partIndex, op.lod);
      }
    }
    // 上了实例化的零件隐藏原始 mesh，避免重复绘制（几何仍保留给拾取/导出）
    for (const index of instancedParts) {
      const part = this.parts[index];
      if (part) part.mesh.visible = false;
    }
  }

  private geometryForLod(partIndex: number, lod: LodLevel): THREE.BufferGeometry {
    const part = this.parts[partIndex];
    if (!part) return new THREE.BufferGeometry();
    if (lod === 0) return this.originalGeometryOf(partIndex, part.mesh.geometry);
    const meta = this.metaByIndex.get(partIndex);
    const key = `${partIndex}:${lod}`;
    const cached = this.lodGeometries.get(key);
    if (cached) return cached;
    if (lod === 2 && meta) {
      const buffer = boxProxyGeometry(meta);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(buffer.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(buffer.normals, 3));
      geometry.computeBoundingBox();
      this.lodGeometries.set(key, geometry);
      return geometry;
    }
    const simplified = decimateMesh(
      { positions: part.data.positions, normals: part.data.normals, indices: part.data.indices },
      0.35
    );
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(simplified.positions, 3));
    if (simplified.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(simplified.normals, 3));
    else geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    this.lodGeometries.set(key, geometry);
    return geometry;
  }

  private instanceGeometryFor(signature: string, partIndices: readonly number[], centers: readonly { x: number; y: number; z: number }[]): THREE.BufferGeometry | null {
    const cached = this.instanceGeometries.get(signature);
    if (cached) return cached;
    const firstIndex = partIndices[0];
    const center = centers[0];
    if (firstIndex === undefined || !center) return null;
    const source = this.parts[firstIndex];
    const meta = this.metaByIndex.get(firstIndex);
    if (!source || !meta) return null;
    const centered = centerGeometry(
      { positions: source.data.positions, normals: source.data.normals, indices: source.data.indices },
      meta.center
    );
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(centered.positions, 3));
    if (centered.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(centered.normals, 3));
    else geometry.computeVertexNormals();
    if (centered.indices) geometry.setIndex(new THREE.BufferAttribute(centered.indices, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    this.instanceGeometries.set(signature, geometry);
    return geometry;
  }

  /** 按零件当前变换刷新实例矩阵：几何已归零，因此 实例矩阵 = 零件矩阵 × 平移(中心) */
  private refreshInstanceMatrices(): void {
    const translation = new THREE.Matrix4();
    const target = new THREE.Matrix4();
    for (const child of this.batchGroup.children) {
      const instanced = child as THREE.InstancedMesh;
      if (!instanced.isInstancedMesh) continue;
      const centers = instanced.userData.centers as THREE.Vector3[] | undefined;
      const partIndices = instanced.userData.partIndices as number[] | undefined;
      if (!centers || !partIndices) continue;
      let count = 0;
      for (let instance = 0; instance < partIndices.length; instance += 1) {
        const part = this.parts[partIndices[instance] ?? -1];
        const center = centers[instance];
        if (!part || !center) continue;
        part.mesh.updateMatrix();
        translation.makeTranslation(center.x, center.y, center.z);
        target.multiplyMatrices(part.mesh.matrix, translation);
        instanced.setMatrixAt(count, target);
        count += 1;
      }
      instanced.count = count;
      instanced.instanceMatrix.needsUpdate = true;
      instanced.computeBoundingSphere();
    }
  }

  private originalGeometryOf(partIndex: number, current: THREE.BufferGeometry): THREE.BufferGeometry {
    const existing = this.originalGeometries.get(partIndex);
    if (existing) return existing;
    this.originalGeometries.set(partIndex, current);
    return current;
  }

  /** 把 LOD 替换掉的几何还原成原始几何；零件下标即将变化时必须先调用 */
  private restoreOriginalGeometries(): void {
    this.parts.forEach((part, index) => {
      const original = this.originalGeometries.get(index);
      if (original && original !== part.mesh.geometry) {
        part.mesh.geometry.dispose();
        part.mesh.geometry = original;
      }
    });
    this.originalGeometries.clear();
    for (const geometry of this.lodGeometries.values()) geometry.dispose();
    this.lodGeometries.clear();
  }

  private clearBatches(): void {
    for (const child of [...this.batchGroup.children]) {
      this.batchGroup.remove(child);
      const instanced = child as THREE.InstancedMesh;
      if (instanced.isInstancedMesh) instanced.dispose();
    }
  }

  private disposePlanCaches(): void {
    this.clearBatches();
    for (const geometry of this.lodGeometries.values()) geometry.dispose();
    this.lodGeometries.clear();
    for (const geometry of this.instanceGeometries.values()) geometry.dispose();
    this.instanceGeometries.clear();
    this.originalGeometries.clear();
    this.metas = [];
    this.metaByIndex.clear();
    this.renderOps = null;
  }

  toggleWireframe(): boolean {
    if (this.degraded) return false;
    this.wireframe = !this.wireframe;
    for (const part of this.parts) {
      const material = part.mesh.material as THREE.MeshStandardMaterial;
      material.wireframe = this.wireframe;
      material.needsUpdate = true;
    }
    return this.wireframe;
  }

  getModelParts(): InterferencePart[] {
    return this.modelParts.map((part) => ({
      name: part.name,
      bbox: {
        min: [...part.bbox.min],
        max: [...part.bbox.max]
      }
    }));
  }

  getSceneParts(): CadScenePart[] {
    return this.parts.map((part) => {
      const box = this.partBounds(part);
      return {
        name: part.data.name,
        triangles: part.triangleCount,
        bbox: {
          min: [box.min.x, box.min.y, box.min.z],
          max: [box.max.x, box.max.y, box.max.z]
        }
      };
    });
  }

  /**
   * 跨重启指纹专用的完整模型快照。调用方只在内存中计算哈希，禁止落盘原始 CAD/BOM 内容。
   * 复制 typed arrays，避免异步摘要期间模型编辑造成快照漂移。
   */
  getCheckpointFingerprintMaterial(): unknown {
    const loaded = this.parts.map((part) => {
      part.mesh.updateMatrix();
      return {
        name: part.data.name,
        positions: part.data.positions.slice(),
        normals: part.data.normals?.slice() ?? null,
        indices: part.data.indices?.slice() ?? null,
        color: part.data.color ? [...part.data.color] : null,
        path: part.data.path ? [...part.data.path] : null,
        matrix: part.mesh.matrix.toArray(),
        qty: part.qty ?? 1,
        partId: part.partId ?? null,
        note: part.note ?? null
      };
    });
    if (loaded.length > 0 || !this.importedResult) return loaded;
    // WebGL 降级模式仍保留了解析后的几何；没有可靠原始网格时由摘要器拒绝恢复。
    return this.importedResult.meshes.map((mesh) => ({
      name: mesh.name,
      positions: mesh.positions.slice(),
      normals: mesh.normals?.slice() ?? null,
      indices: mesh.indices?.slice() ?? null,
      color: mesh.color ? [...mesh.color] : null,
      path: mesh.path ? [...mesh.path] : null,
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      qty: 1,
      partId: null,
      note: null
    }));
  }

  getSelectionSnapshot(): { name: string; bbox: number[] } | null {
    if (this.selected === null) return null;
    const part = this.parts[this.selected];
    if (!part) return null;
    const box = this.partBounds(part);
    return {
      name: part.data.name,
      bbox: [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z]
    };
  }

  getBomRows(): CadBomRow[] {
    const rows: CadBomRow[] = this.modelParts.map((part, index) => ({
      no: index + 1,
      name: part.name,
      spec: part.name,
      qty: this.parts[index]?.qty ?? 1,
      mat: '—',
      ...(this.parts[index]?.note ? { note: this.parts[index]!.note } : {}),
      ...(this.parts[index]?.partId ? { partId: this.parts[index]!.partId } : {})
    }));
    for (const row of this.draftBomRows) {
      rows.push({ ...row, no: rows.length + 1 });
    }
    return rows;
  }

  /** Agent apply_machine_design：追加独立于 CAD 零件的 BOM 草稿行。 */
  appendDraftBomRows(rows: readonly Omit<CadBomRow, 'no'>[], batchId: string): number {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    if (typeof batchId !== 'string' || !batchId.trim()) throw new Error('BOM 批次 id 不能为空');
    // 同一批次重复应用是幂等操作：不重复追加行。
    if (this.draftBomRows.some((row) => (row as Omit<CadBomRow, 'no'> & { batchId?: string }).batchId === batchId)) {
      return 0;
    }
    assertBomRowCount(this.getBomRows().length, rows.length);
    const accepted: Array<Omit<CadBomRow, 'no'>> = [];
    for (const [index, row] of rows.entries()) {
      if (!row || typeof row.name !== 'string' || !row.name.trim()) {
        throw new Error(`BOM 草稿第 ${index + 1} 行缺少名称`);
      }
      const qty = Number(row.qty);
      if (!Number.isFinite(qty) || qty <= 0) throw new Error(`BOM 草稿第 ${index + 1} 行数量不合法`);
      accepted.push({
        ...row,
        name: row.name.trim(),
        spec: typeof row.spec === 'string' && row.spec.trim() ? row.spec.trim() : '模型待定',
        qty,
        mat: typeof row.mat === 'string' && row.mat.trim() ? row.mat.trim() : '—',
        source: row.source ?? 'machine-design',
        ...(row.note ? { note: row.note } : {}),
        ...(row.category ? { category: row.category } : {}),
        ...(row.partId ? { partId: row.partId } : {})
      });
    }
    this.draftBomRows.push(...accepted);
    const marker = accepted[0]?.source === 'machine-design' ? batchId : '';
    if (marker) {
      for (const row of this.draftBomRows.slice(-accepted.length)) {
        (row as Omit<CadBomRow, 'no'> & { batchId?: string }).batchId = marker;
      }
    }
    this.renderPartList();
    return accepted.length;
  }

  removeDraftBomRowsByBatch(batchId: string): number {
    const key = String(batchId ?? '').trim();
    if (!key) return 0;
    const before = this.draftBomRows.length;
    this.draftBomRows = this.draftBomRows.filter((row) => (
      (row as Omit<CadBomRow, 'no'> & { batchId?: string }).batchId !== key
    ));
    const removed = before - this.draftBomRows.length;
    if (removed > 0) this.renderPartList();
    return removed;
  }

  /** Agent update_component：按 0 基下标更新 BOM 行的型号/数量/备注。 */
  updateBomRow(index: number, patch: { model?: string; qty?: number; note?: string; partId?: string }): CadBomRow | null {
    const part = this.parts[index];
    const modelPart = this.modelParts[index];
    if (!part || !modelPart) return null;
    if (typeof patch.model === 'string' && patch.model.trim()) {
      const model = patch.model.trim();
      part.data.name = model;
      part.mesh.name = model;
      modelPart.name = model;
    }
    if (Number.isInteger(patch.qty) && Number(patch.qty) > 0) part.qty = Number(patch.qty);
    if (typeof patch.note === 'string') part.note = patch.note;
    if (typeof patch.partId === 'string' && patch.partId.trim()) part.partId = patch.partId.trim();
    this.renderPartList();
    return this.getBomRows()[index] ?? null;
  }

  /**
   * 从装配体移除并保留对象引用，供 remove_component 的撤销恢复。
   * 与 `removePart` 不同，这里不 dispose 几何/材质。
   */
  detachPart(index: number): { index: number; part: LoadedPart; modelPart: InterferencePart } | null {
    if (this.degraded || !Number.isInteger(index)) return null;
    const part = this.parts[index];
    const modelPart = this.modelParts[index];
    if (!part || !modelPart) return null;
    this.restoreOriginalGeometries();
    this.group.remove(part.mesh);
    this.parts.splice(index, 1);
    this.modelParts.splice(index, 1);
    this.parts.forEach((candidate, candidateIndex) => {
      candidate.mesh.userData.partIndex = candidateIndex;
    });
    this.selected = null;
    if (this.selectionHelper) this.selectionHelper.visible = false;
    this.renderPartList();
    this.renderDetail(null);
    this.syncPartCount();
    this.rebuildPlanState();
    return { index, part, modelPart };
  }

  restoreDetachedPart(snapshot: { index: number; part: LoadedPart; modelPart: InterferencePart }): boolean {
    if (!snapshot || !snapshot.part || !snapshot.modelPart) return false;
    const index = Math.min(Math.max(0, snapshot.index), this.parts.length);
    this.parts.splice(index, 0, snapshot.part);
    this.modelParts.splice(index, 0, snapshot.modelPart);
    this.group.add(snapshot.part.mesh);
    this.parts.forEach((candidate, candidateIndex) => {
      candidate.mesh.userData.partIndex = candidateIndex;
    });
    this.renderPartList();
    this.syncPartCount();
    this.rebuildPlanState();
    return true;
  }

  /** 只读采集 CAD viewer 当前相机，不提供档案恢复/应用入口。 */
  getPortableViewState(): CadPortableViewState | null {
    if (!this.controls || this.degraded) return null;
    const position = this.camera.position;
    const target = this.controls.target;
    const up = this.camera.up;
    return {
      schemaVersion: 1,
      position: [position.x, position.y, position.z],
      target: [target.x, target.y, target.z],
      up: [up.x, up.y, up.z],
      fovDeg: this.camera.fov,
      wireframe: this.wireframe
    };
  }

  /** 运动学标注网格树的数据源；id 使用 parts 索引。 */
  getKinematicsMeshes(): CadKinematicsMesh[] {
    if (this.parts.length === 0 && this.importedResult) {
      return this.importedResult.meshes.map((mesh, index) => {
        const bbox = boundsFromPositions(mesh.positions);
        const center: [number, number, number] = [
          (bbox.min[0] + bbox.max[0]) / 2,
          (bbox.min[1] + bbox.max[1]) / 2,
          (bbox.min[2] + bbox.max[2]) / 2
        ];
        const size: [number, number, number] = [
          bbox.max[0] - bbox.min[0],
          bbox.max[1] - bbox.min[1],
          bbox.max[2] - bbox.min[2]
        ];
        return {
          id: index,
          name: mesh.name,
          ...(mesh.stableObjectId ? { stableObjectId: mesh.stableObjectId } : {}),
          triangles: mesh.indices ? Math.floor(mesh.indices.length / 3) : Math.floor(mesh.positions.length / 9),
          center,
          size
        };
      });
    }
    return this.parts.map((part, index) => {
      const box = this.partBounds(part);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      return {
        id: index,
        name: part.data.name,
        ...(part.data.stableObjectId ? { stableObjectId: part.data.stableObjectId } : {}),
        triangles: part.triangleCount,
        center: [center.x, center.y, center.z],
        size: [size.x, size.y, size.z]
      };
    });
  }

  /**
   * 运动学自动识别的数据源：在 getKinematicsMeshes 基础上附带装配路径与原始顶点（世界坐标、只读引用，不拷贝）。
   * 智能体占位件（无几何意义）不参与识别。
   */
  getKinematicsGeometry(): CadKinematicsGeometry[] {
    const infos = this.getKinematicsMeshes();
    const datas: CadMeshData[] =
      this.parts.length === 0 && this.importedResult ? this.importedResult.meshes : this.parts.map((part) => part.data);
    const out: CadKinematicsGeometry[] = [];
    infos.forEach((info, index) => {
      const data = datas[index];
      const placeholder = this.parts[index]?.mesh.userData.placeholder === true;
      if (!data || placeholder) return;
      out.push({ ...info, ...(data.path ? { path: [...data.path] } : {}), positions: data.positions });
    });
    return out;
  }

  /** 按动件姿态移动/旋转网格；pivot 为合并包围盒中心。 */
  setKinematicsPose(
    meshIds: readonly number[],
    pose: CadKinematicsPose,
    pivot: [number, number, number]
  ): void {
    if (this.degraded) return;
    const pivotVector = new THREE.Vector3(pivot[0], pivot[1], pivot[2]);
    const offset = new THREE.Vector3(pose.offset[0], pose.offset[1], pose.offset[2]);
    const axisVector =
      pose.axis === 'x' ? new THREE.Vector3(1, 0, 0) : pose.axis === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    const rotation = new THREE.Quaternion().setFromAxisAngle(axisVector, pose.rotationRad);
    for (const id of meshIds) {
      const part = this.parts[id];
      if (!part) continue;
      const mesh = part.mesh;
      const basePosition = (mesh.userData.kinematicsBasePosition as THREE.Vector3 | undefined) ?? mesh.position.clone();
      const baseQuaternion =
        (mesh.userData.kinematicsBaseQuaternion as THREE.Quaternion | undefined) ?? mesh.quaternion.clone();
      const relative = basePosition.clone().sub(pivotVector).applyQuaternion(rotation);
      mesh.position.copy(relative.add(pivotVector).add(offset));
      mesh.quaternion.copy(rotation.clone().multiply(baseQuaternion));
      mesh.updateMatrixWorld(true);
    }
    this.refreshInstanceMatrices();
  }

  resetKinematics(meshIds: readonly number[]): void {
    if (this.degraded) return;
    for (const id of meshIds) {
      const part = this.parts[id];
      if (!part) continue;
      const mesh = part.mesh;
      const basePosition = (mesh.userData.kinematicsBasePosition as THREE.Vector3 | undefined) ?? mesh.position.clone();
      const baseQuaternion =
        (mesh.userData.kinematicsBaseQuaternion as THREE.Quaternion | undefined) ?? mesh.quaternion.clone();
      mesh.position.copy(basePosition);
      mesh.quaternion.copy(baseQuaternion);
      mesh.updateMatrixWorld(true);
    }
    this.refreshInstanceMatrices();
  }

  addPlaceholderPart(name: string, partId?: string): number {
    if (this.degraded || !this.renderer) {
      throw new Error('当前环境不支持 WebGL，无法插入占位件');
    }
    const displayName = name.trim();
    if (!displayName) throw new Error('占位件名称不能为空');

    const currentBounds = this.totalBounds();
    const centerX = currentBounds.isEmpty() ? 10 : currentBounds.max.x + 12;
    const geometry = new THREE.BoxGeometry(20, 20, 20);
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(DEFAULT_COLORS[this.parts.length % DEFAULT_COLORS.length] ?? 0x14b8a6),
      metalness: 0.22,
      roughness: 0.58,
      wireframe: this.wireframe,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = displayName;
    mesh.position.set(centerX, 0, 10);
    mesh.userData.placeholder = true;
    mesh.userData.kinematicsBasePosition = mesh.position.clone();
    mesh.userData.kinematicsBaseQuaternion = mesh.quaternion.clone();

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: 0x5eead4, transparent: true, opacity: 0.9 })
    );
    edges.name = `${displayName}-wire`;
    mesh.add(edges);
    mesh.updateMatrixWorld(true);

    const index = this.parts.length;
    mesh.userData.partIndex = index;
    const data: CadMeshData = {
      name: displayName,
      positions: new Float32Array(),
      normals: null,
      indices: null
    };
    this.parts.push({ data, mesh, triangleCount: 12, ...(partId ? { partId } : {}) });
    this.group.add(mesh);
    const box = this.partBounds({ data, mesh, triangleCount: 12 });
    this.modelParts.push({
      name: displayName,
      bbox: {
        min: [box.min.x, box.min.y, box.min.z],
        max: [box.max.x, box.max.y, box.max.z]
      }
    });
    this.renderPartList();
    this.syncPartCount();
    this.rebuildPlanState();
    this.selectPart(index);
    return index;
  }

  removePart(index: number): boolean {
    if (this.degraded || !Number.isInteger(index)) return false;
    const part = this.parts[index];
    if (!part) return false;

    this.restoreOriginalGeometries();
    this.group.remove(part.mesh);
    part.mesh.traverse((object) => {
      const renderable = object as THREE.Mesh;
      renderable.geometry?.dispose();
      const materials = Array.isArray(renderable.material) ? renderable.material : [renderable.material];
      for (const material of materials) {
        if (!material) continue;
        const shared = this.parts.some((candidate, candidateIndex) =>
          candidateIndex !== index && candidate.mesh.material === material
        );
        if (!shared) material.dispose();
      }
    });

    this.parts.splice(index, 1);
    this.modelParts.splice(index, 1);
    this.parts.forEach((candidate, candidateIndex) => {
      candidate.mesh.userData.partIndex = candidateIndex;
    });
    this.selected = null;
    if (this.selectionHelper) this.selectionHelper.visible = false;
    this.renderPartList();
    this.renderDetail(null);
    this.syncPartCount();
    this.rebuildPlanState();
    return true;
  }

  getExportRoot(): THREE.Object3D {
    if (this.parts.length > 0) return this.group;
    if (!this.importedResult) throw new Error('请先打开 CAD 文件再导出 3D 模型');
    const group = new THREE.Group();
    group.name = 'AutomationCAD-Model';
    this.importedResult.meshes.forEach((data, index) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(data.positions.slice(), 3));
      if (data.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals.slice(), 3));
      if (data.indices) geometry.setIndex(new THREE.BufferAttribute(data.indices.slice(), 1));
      if (!data.normals) geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ color: DEFAULT_COLORS[index % DEFAULT_COLORS.length] ?? 0x7f8b96 })
      );
      mesh.name = data.name;
      group.add(mesh);
    });
    return group;
  }

  highlightNames(names: readonly string[], focus = false): boolean {
    if (this.degraded || !this.selectionHelper) return false;
    const wanted = new Set(names);
    const indices: number[] = [];
    this.parts.forEach((part, index) => {
      if (wanted.has(part.data.name)) indices.push(index);
    });
    if (indices.length === 0) return false;

    const selection = new THREE.Box3();
    for (const index of indices) {
      const part = this.parts[index];
      if (!part) continue;
      part.mesh.geometry.computeBoundingBox();
      const box = part.mesh.geometry.boundingBox?.clone().applyMatrix4(part.mesh.matrixWorld);
      if (box) selection.union(box);
    }
    if (selection.isEmpty()) return false;

    this.selected = indices[0] ?? null;
    this.selectionBox.copy(selection);
    this.selectionHelper.box.copy(selection);
    this.selectionHelper.visible = true;
    this.partsElement.querySelectorAll('.cad-part-row').forEach((row) => {
      const index = Number((row as HTMLElement).dataset.partIndex);
      row.classList.toggle('is-selected', indices.includes(index));
    });
    const first = indices[0];
    if (first !== undefined) {
      const part = this.parts[first];
      if (part) this.renderDetail(this.selectionInfo(part, first));
    }
    if (focus && this.controls) {
      const center = selection.getCenter(new THREE.Vector3());
      const offset = this.camera.position.clone().sub(this.controls.target);
      this.controls.target.copy(center);
      this.camera.position.copy(center).add(offset);
      this.controls.update();
    }
    return true;
  }

  selectPart(index: number | null, focus = false): void {
    if (this.degraded) return;
    if (!this.selectionHelper) return;
    if (index === null || !this.parts[index]) {
      this.selected = null;
      this.selectionHelper.visible = false;
      this.partsElement.querySelectorAll('.cad-part-row').forEach((row) => row.classList.remove('is-selected'));
      this.renderDetail(null);
      return;
    }
    this.selected = index;
    const part = this.parts[index];
    if (!part) return;
    part.mesh.geometry.computeBoundingBox();
    if (part.mesh.geometry.boundingBox) {
      this.selectionBox.copy(part.mesh.geometry.boundingBox).applyMatrix4(part.mesh.matrixWorld);
      this.selectionHelper.box.copy(this.selectionBox);
      this.selectionHelper.visible = true;
    }
    this.partsElement.querySelectorAll('.cad-part-row').forEach((row) => {
      row.classList.toggle('is-selected', Number((row as HTMLElement).dataset.partIndex) === index);
    });
    if (focus) {
      const controls = this.controls;
      if (!controls) return;
      const center = this.selectionBox.getCenter(new THREE.Vector3());
      const currentOffset = this.camera.position.clone().sub(controls.target);
      controls.target.copy(center);
      this.camera.position.copy(center).add(currentOffset);
      controls.update();
    }
    this.renderDetail(this.selectionInfo(part, index));
  }

  dispose(): void {
    this.setActive(false);
    this.resizeObserver?.disconnect();
    if (this.renderer) {
      this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown);
      this.renderer.domElement.removeEventListener('pointerup', this.handlePointerUp);
    }
    this.partsElement.removeEventListener('click', this.handlePartClick);
    this.controls?.dispose();
    this.controls = null;
    this.clearModel();
    this.clearGhost();
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
      this.grid = null;
    }
    this.scene.clear();
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
    this.fallbackElement?.remove();
    this.fallbackElement = null;
  }

  private readonly renderFrame = (): void => {
    if (!this.active || !this.renderer || !this.controls) return;
    this.controls.update();
    if (this.planDirty && Date.now() - this.lastPlanMs > 150) this.replan();
    this.renderer.render(this.scene, this.camera);
  };

  private totalBounds(): THREE.Box3 {
    const bounds = new THREE.Box3();
    for (const part of this.parts) {
      const partBox = this.partBounds(part);
      if (!partBox.isEmpty()) bounds.union(partBox);
    }
    if (this.parametricOverlayGroup.visible) {
      this.parametricOverlayGroup.updateMatrixWorld(true);
      for (const child of this.parametricOverlayGroup.children) {
        const mesh = child as THREE.Mesh;
        mesh.geometry.computeBoundingBox();
        const box = mesh.geometry.boundingBox;
        if (box) bounds.union(box.clone().applyMatrix4(mesh.matrixWorld));
      }
    }
    return bounds;
  }

  private partBounds(part: LoadedPart): THREE.Box3 {
    part.mesh.updateMatrixWorld(true);
    part.mesh.geometry.computeBoundingBox();
    return part.mesh.geometry.boundingBox?.clone().applyMatrix4(part.mesh.matrixWorld) ?? new THREE.Box3();
  }

  private updateGrid(center: THREE.Vector3, radius?: number): void {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
    }
    const span = Math.max(radius ?? center.length() * 1.5, 20);
    const step = Math.pow(10, Math.floor(Math.log10(span / 10)));
    const size = Math.ceil(span / (step * 5)) * step * 10;
    this.grid = new THREE.GridHelper(size, 20, 0x59616a, 0x3b4046);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.position.set(center.x, center.y, center.z - span * 0.06);
    this.scene.add(this.grid);
  }

  private updateGridForSize(size: THREE.Vector3): void {
    const maxSize = Math.max(size.x, size.y, size.z, 10);
    this.updateGrid(new THREE.Vector3(), maxSize);
  }

  private resize(): void {
    if (!this.renderer) return;
    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.container.clientHeight, 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private renderPartList(): void {
    this.partsElement.innerHTML = '';
    this.parts.forEach((part, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'cad-part-row';
      row.dataset.partIndex = String(index);
      row.innerHTML = `<span class="cad-part-index">${String(index + 1).padStart(2, '0')}</span><span class="cad-part-name"></span><span class="cad-part-tris">${part.triangleCount}</span>`;
      const name = row.querySelector('.cad-part-name');
      if (name) name.textContent = part.data.name;
      this.partsElement.appendChild(row);
    });
  }

  private syncPartCount(): void {
    const count = document.getElementById('cadPartCount');
    if (count) count.textContent = String(this.parts.length);
  }

  private renderDetail(info: CadSelectionInfo | null): void {
    this.onSelect?.(info);
    if (!info) {
      this.detailElement.innerHTML = '<div class="cad-detail-empty">单击零件查看包围盒与尺寸</div>';
      return;
    }
    this.detailElement.innerHTML = `
      <div class="cad-detail-title"></div>
      <dl class="cad-detail-grid">
        <dt>尺寸</dt><dd>${info.dimensions.map((value) => value.toFixed(3)).join(' × ')} mm</dd>
        <dt>三角面</dt><dd>${info.triangleCount.toLocaleString('zh-CN')}</dd>
        <dt>X 范围</dt><dd>${info.bounds.min[0].toFixed(3)} → ${info.bounds.max[0].toFixed(3)}</dd>
        <dt>Y 范围</dt><dd>${info.bounds.min[1].toFixed(3)} → ${info.bounds.max[1].toFixed(3)}</dd>
        <dt>Z 范围</dt><dd>${info.bounds.min[2].toFixed(3)} → ${info.bounds.max[2].toFixed(3)}</dd>
      </dl>`;
    const title = this.detailElement.querySelector('.cad-detail-title');
    if (title) title.textContent = info.name;
  }

  private selectionInfo(part: LoadedPart, index: number): CadSelectionInfo {
    const box = this.partBounds(part);
    const size = box.getSize(new THREE.Vector3());
    return {
      index,
      name: part.data.name,
      triangleCount: part.triangleCount,
      dimensions: [size.x, size.y, size.z],
      bounds: {
        min: [box.min.x, box.min.y, box.min.z],
        max: [box.max.x, box.max.y, box.max.z]
      }
    };
  }

  private readonly handlePartClick = (event: Event): void => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>('.cad-part-row');
    if (!row) return;
    const index = Number(row.dataset.partIndex);
    if (Number.isInteger(index)) this.selectPart(index, true);
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    this.pointerDown = { x: event.clientX, y: event.clientY };
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (!this.renderer) return;
    if (event.button !== 0) return;
    const moved = Math.hypot(event.clientX - this.pointerDown.x, event.clientY - this.pointerDown.y);
    if (moved > 4) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const targets: THREE.Object3D[] = [
      ...this.group.children.filter((child) => child.visible),
      ...this.batchGroup.children
    ];
    const hit = this.raycaster.intersectObjects(targets, true)[0];
    if (!hit) {
      this.selectPart(null);
      return;
    }
    const object = hit.object as THREE.Object3D & { isInstancedMesh?: boolean };
    const instanceIndices = object.userData.partIndices as number[] | undefined;
    let index = Number(object.userData.partIndex);
    if (!Number.isInteger(index) && object.isInstancedMesh && hit.instanceId !== undefined && instanceIndices) {
      index = instanceIndices[hit.instanceId] ?? NaN;
    }
    if (Number.isInteger(index)) this.selectPart(index);
  };

  private clearModel(options: { notify?: boolean } = {}): void {
    this.selected = null;
    this.modelParts = [];
    this.importedResult = null;
    this.clearParametricOverlay();
    if (this.selectionHelper) this.selectionHelper.visible = false;
    if (this.featureHelper) this.featureHelper.visible = false;
    this.parts.forEach((part, index) => {
      const original = this.originalGeometries.get(index);
      if (original && original !== part.mesh.geometry) {
        part.mesh.geometry.dispose();
        part.mesh.geometry = original;
      }
      part.mesh.geometry.dispose();
      const material = part.mesh.material as THREE.Material;
      material.dispose();
      this.group.remove(part.mesh);
    });
    this.parts = [];
    this.disposePlanCaches();
    this.partsElement.innerHTML = '';
    if (options.notify !== false) this.renderDetail(null);
  }

  private enterDegradedMode(reason: string, result: CadImportResult | null, fileName?: string): void {
    this.degraded = true;
    this.container.innerHTML = '';
    const panel = document.createElement('div');
    panel.id = 'cadWebglFallback';
    panel.className = 'cad-webgl-fallback';
    panel.dataset.reason = reason;
    panel.dataset.meshCount = result ? String(result.stats.meshCount) : '0';
    panel.dataset.triangleCount = result ? String(result.stats.triangleCount) : '0';
    panel.innerHTML = `
      <div class="cad-fallback-ico">${this.fallbackIcon()}</div>
      <div class="cad-fallback-title">当前环境不支持 WebGL，无法显示 3D 模型</div>
      <div class="cad-fallback-sub">文件仍可在后台解析；以下为解析统计，3D 渲染已停用。</div>
      <dl class="cad-fallback-stats">
        <dt>文件</dt><dd data-cad-fallback="file">${fileName ? this.escapeHtml(fileName) : '未打开文件'}</dd>
        <dt>零件数</dt><dd data-cad-fallback="meshes">${result ? result.stats.meshCount : 0}</dd>
        <dt>三角面</dt><dd data-cad-fallback="triangles">${result ? result.stats.triangleCount.toLocaleString('zh-CN') : 0}</dd>
        <dt>包围盒</dt><dd data-cad-fallback="bounds">${result ? this.boundsText(result) : '—'}</dd>
        <dt>原因</dt><dd class="cad-fallback-reason">${this.escapeHtml(reason)}</dd>
      </dl>`;
    this.container.appendChild(panel);
    this.fallbackElement = panel;
    this.partsElement.innerHTML = '<div class="cad-parts-empty">WebGL 不可用，零件树暂停显示</div>';
    this.detailElement.innerHTML = '<div class="cad-detail-empty">当前环境不支持 3D 渲染，已切换为解析统计视图。</div>';
    if (result) {
      const bounds = this.rawBounds(result);
      this.onStats?.(
        `${fileName ?? 'CAD 文件'} · ${result.stats.meshCount} 个零件 · ` +
        `${result.stats.triangleCount.toLocaleString('zh-CN')} 个三角面 · ` +
        `${bounds.sizeText} mm · ${result.stats.format} · WebGL 不可用`
      );
    }
  }

  private loadDegraded(result: CadImportResult, fileName: string): void {
    const bounds = this.rawBounds(result);
    this.enterDegradedMode(this.fallbackElement?.dataset.reason ?? 'WebGL 不可用', result, fileName);
    const boundsCell = this.fallbackElement?.querySelector<HTMLElement>('[data-cad-fallback="bounds"]');
    if (boundsCell) boundsCell.textContent = `${bounds.sizeText} mm`;
  }

  private rawBounds(result: CadImportResult): {
    min: [number, number, number];
    max: [number, number, number];
    sizeText: string;
  } {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const mesh of result.meshes) {
      const positions = mesh.positions;
      for (let index = 0; index + 2 < positions.length; index += 3) {
        const x = positions[index]!;
        const y = positions[index + 1]!;
        const z = positions[index + 2]!;
        if (x < min[0]) min[0] = x;
        if (y < min[1]) min[1] = y;
        if (z < min[2]) min[2] = z;
        if (x > max[0]) max[0] = x;
        if (y > max[1]) max[1] = y;
        if (z > max[2]) max[2] = z;
      }
    }
    if (!Number.isFinite(min[0])) {
      return { min: [0, 0, 0], max: [0, 0, 0], sizeText: '0 × 0 × 0' };
    }
    const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    return { min, max, sizeText: size.map((value) => value.toFixed(3)).join(' × ') };
  }

  private boundsText(result: CadImportResult): string {
    return `${this.rawBounds(result).sizeText} mm`;
  }

  private escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => {
      const entities: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      };
      return entities[character] ?? character;
    });
  }

  private fallbackIcon(): string {
    return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.9l5.4 3.1v6L8 14.1 2.6 11V5z"/><path d="M8 8.1l5.4-3.1M8 8.1L2.6 5M8 8.1V14"/><path d="M3.4 12.6L12.6 3.4"/></svg>';
  }
}
