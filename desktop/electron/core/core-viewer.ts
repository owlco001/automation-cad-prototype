import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CorePreviewModel, CorePreviewMesh } from './cad-preview-format.mjs';

export interface CoreCadPreviewSummary {
  format: string;
  meshCount: number;
  triangleCount: number;
  bounds: [number, number, number];
}

export class CoreCadViewport {
  private readonly container: HTMLElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.001, 1_000_000_000);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  private activeModel: THREE.Group | null = null;
  private activeGeometries: THREE.BufferGeometry[] = [];
  private activeMaterials: THREE.Material[] = [];
  private lastSummary: CoreCadPreviewSummary | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.scene.background = new THREE.Color(0x252b33);
    this.camera.up.set(0, 0, 1);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x77818b, 2.0));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(1, -1.5, 2.2);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xc6d8ec, 0.8);
    fill.position.set(-1.2, 1.4, 0.7);
    this.scene.add(fill);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = 'core-cad-canvas';
    this.renderer.domElement.setAttribute('aria-label', '只读 CAD 三维预览；左键旋转，右键或中键平移，滚轮缩放');
    this.container.replaceChildren(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN
    };
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
    this.resize();
  }

  summary(): CoreCadPreviewSummary | null {
    return this.lastSummary;
  }

  load(model: CorePreviewModel): CoreCadPreviewSummary {
    const staged = this.createCandidate(model);
    const bounds = new THREE.Box3().setFromObject(staged.group);
    if (bounds.isEmpty()) {
      this.disposeCandidate(staged.geometries, staged.materials);
      throw new Error('模型没有可显示的三角网格。');
    }
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const dimensions: [number, number, number] = [size.x, size.y, size.z];
    const maxDimension = Math.max(size.x, size.y, size.z);
    const radius = Math.max(maxDimension * 0.75, 0.5);
    staged.group.position.sub(center);

    const oldModel = this.activeModel;
    const oldGeometries = this.activeGeometries;
    const oldMaterials = this.activeMaterials;
    this.scene.add(staged.group);
    this.activeModel = staged.group;
    this.activeGeometries = staged.geometries;
    this.activeMaterials = staged.materials;
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(radius * 1.7, -radius * 2.1, radius * 1.55);
    this.camera.near = Math.max(radius / 20_000, 0.00001);
    this.camera.far = Math.max(radius * 200, 10);
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = Math.max(radius * 0.005, 0.001);
    this.controls.maxDistance = Math.max(radius * 200, 10);
    this.controls.update();
    if (oldModel) this.scene.remove(oldModel);
    this.disposeCandidate(oldGeometries, oldMaterials);

    this.lastSummary = {
      format: model.format,
      meshCount: model.meshCount,
      triangleCount: model.triangleCount,
      bounds: dimensions
    };
    this.renderer.render(this.scene, this.camera);
    return this.lastSummary;
  }

  resetView(): void {
    if (!this.activeModel || !this.lastSummary) return;
    const radius = Math.max(...this.lastSummary.bounds) * 0.75 || 0.5;
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(radius * 1.7, -radius * 2.1, radius * 1.55);
    this.controls.update();
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.setAnimationLoop(null);
    if (this.activeModel) this.scene.remove(this.activeModel);
    this.disposeCandidate(this.activeGeometries, this.activeMaterials);
    this.renderer.dispose();
    this.container.replaceChildren();
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private createCandidate(model: CorePreviewModel): { group: THREE.Group; geometries: THREE.BufferGeometry[]; materials: THREE.Material[] } {
    const group = new THREE.Group();
    const geometries: THREE.BufferGeometry[] = [];
    const materials: THREE.Material[] = [];
    try {
      const meshObjects = model.meshes.map((mesh) => {
        const geometry = this.createGeometry(mesh);
        geometries.push(geometry);
        const color = new THREE.Color(mesh.color?.[0] ?? 0.56, mesh.color?.[1] ?? 0.65, mesh.color?.[2] ?? 0.75);
        const material = new THREE.MeshStandardMaterial({
          color,
          metalness: 0.12,
          roughness: 0.72,
          side: THREE.DoubleSide
        });
        materials.push(material);
        const object = new THREE.Mesh(geometry, material);
        object.name = mesh.name;
        return object;
      });

      if (model.nodes.length > 0) {
        const nodeObjects = model.nodes.map((node) => {
          const object = new THREE.Group();
          object.name = node.name;
          if (node.matrix) {
            object.matrix.fromArray(node.matrix);
            object.matrixAutoUpdate = false;
          } else {
            if (node.translation) object.position.fromArray(node.translation);
            if (node.rotation) object.quaternion.fromArray(node.rotation);
            if (node.scale) object.scale.fromArray(node.scale);
          }
          if (node.mesh !== undefined) {
            const meshIndexes = model.meshGroups?.[node.mesh] ?? [];
            for (const meshIndex of meshIndexes) {
              const mesh = meshObjects[meshIndex];
              if (!mesh) throw new Error('GLB node 引用了不存在的网格。');
              object.add(mesh.clone());
            }
          }
          return object;
        });
        model.nodes.forEach((node, index) => {
          const parent = nodeObjects[index];
          if (!parent) throw new Error('GLB node 无法建立层级。');
          for (const childIndex of node.children) {
            const child = nodeObjects[childIndex];
            if (!child) throw new Error('GLB node 子节点不存在。');
            parent.add(child);
          }
        });
        for (const rootIndex of model.sceneRoots) {
          const root = nodeObjects[rootIndex];
          if (!root) throw new Error('GLB 默认 scene 根节点不存在。');
          group.add(root);
        }
      } else {
        for (const mesh of meshObjects) group.add(mesh);
      }
      if (group.children.length === 0) throw new Error('模型没有可显示的三角网格。');
      return { group, geometries, materials };
    } catch (error) {
      this.disposeCandidate(geometries, materials);
      throw error;
    }
  }

  private createGeometry(mesh: CorePreviewMesh): THREE.BufferGeometry {
    if (mesh.positions.length < 9 || mesh.positions.length % 3 !== 0) throw new Error('模型顶点数据无效。');
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    if (mesh.normals && mesh.normals.length === mesh.positions.length) {
      geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
    } else {
      geometry.computeVertexNormals();
    }
    if (mesh.indices) geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private disposeCandidate(geometries: THREE.BufferGeometry[], materials: THREE.Material[]): void {
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
  }
}

export { parseCadPreview, CorePreviewSession } from './cad-preview-format.mjs';
export function createCadViewport(container: HTMLElement): CoreCadViewport {
  return new CoreCadViewport(container);
}
