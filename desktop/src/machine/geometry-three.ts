// MachineGeometry → three.js 场景树。与导出共用 partLocalMesh，保证「看到的 = 导出的」。
// 根节点绕 X 轴 -90°（Z 向上 → Y 向上）并按 scale 缩放到场景单位；子节点保持 mm 数据。
// 运动件按 GeomMovingAxis 分组：linear / gripper 用平移子组，rotary 用位于转轴的枢轴组。

import * as THREE from 'three';
import type { GeomMovingAxis, GeomPart, MachineGeometry } from './geometry.ts';
import { partLocalMesh } from './geometry-export.ts';

export interface ThreeActuatorNode {
  axis: GeomMovingAxis;
  group: THREE.Group;
  /** linear：整体平移组；rotary：枢轴组；gripper：未使用（见 jaws）。 */
  mover: THREE.Group | null;
  jaws: { group: THREE.Group; sign: 1 | -1 }[];
  /** 上一次应用的归一化值；相同值不重复写矩阵。 */
  lastValue?: number;
  /** rotary 单位轴缓存，避免每帧分配 Vector3。 */
  axisUnit?: THREE.Vector3;
}

export interface ThreeSensorNode {
  point: string;
  meshes: THREE.Mesh[];
  material: THREE.MeshStandardMaterial;
}

export interface ThreeMachine {
  root: THREE.Group;
  scale: number;
  stationGroups: Map<string, THREE.Group>;
  actuators: Map<string, ThreeActuatorNode>;
  sensors: Map<string, ThreeSensorNode>;
  meshCount: number;
}

function geometryKey(part: GeomPart): string {
  const shape = part.shape;
  if (shape.type === 'box') return `box:${shape.size.join(',')}`;
  return `cylinder:${shape.radius},${shape.length},${shape.axis}`;
}

function createPartGeometry(part: GeomPart, segments: number): THREE.BufferGeometry {
  const local = partLocalMesh(part, segments);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(local.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(local.normals, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function partMesh(part: GeomPart, material: THREE.Material, geometry: THREE.BufferGeometry): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = part.id;
  mesh.position.set(part.center[0], part.center[1], part.center[2]);
  mesh.rotation.z = THREE.MathUtils.degToRad(part.rotationZDeg);
  mesh.userData.partId = part.id;
  if (part.sensorPoint) mesh.userData.pointId = part.sensorPoint;
  // 静态零件的矩阵在整棵场景建好后统一冻结；随动件保留自动更新。
  mesh.updateMatrix();
  return mesh;
}

function materialKey(part: GeomPart): string {
  return `${part.role}|${part.color}`;
}

function createMaterial(part: GeomPart): THREE.MeshStandardMaterial {
  const metal = part.role === 'actuator' ? 0.55 : part.role === 'frame' || part.role === 'structure' ? 0.35 : 0.15;
  return new THREE.MeshStandardMaterial({ color: new THREE.Color(part.color), metalness: metal, roughness: 0.5 });
}

export function buildThreeMachine(
  geometry: MachineGeometry,
  options: { targetSpan?: number; segments?: number; sensorOffColor?: THREE.Color } = {}
): ThreeMachine {
  const segments = options.segments ?? 20;
  const span = Math.max(geometry.envelope[0], geometry.envelope[1], geometry.envelope[2], 1);
  const scale = (options.targetSpan ?? 6) / span;
  const root = new THREE.Group();
  root.name = `machine-geometry:${geometry.machineId}`;
  root.rotation.x = -Math.PI / 2;
  root.scale.setScalar(scale);

  const machineGroup = new THREE.Group();
  machineGroup.name = 'machine-static';
  root.add(machineGroup);

  const stationGroups = new Map<string, THREE.Group>();
  for (const station of geometry.stations) {
    const group = new THREE.Group();
    group.name = `station:${station.id}`;
    root.add(group);
    stationGroups.set(station.id, group);
  }

  const actuators = new Map<string, ThreeActuatorNode>();
  const movingByPart = new Map<string, { node: ThreeActuatorNode; jaw?: number }>();
  for (const axis of geometry.moving) {
    const group = new THREE.Group();
    group.name = `actuator:${axis.actuatorId}`;
    const stationGroup = stationGroups.get(axis.stationId) ?? root;
    stationGroup.add(group);
    const node: ThreeActuatorNode = { axis, group, mover: null, jaws: [] };
    if (axis.kind === 'gripper') {
      for (const jaw of axis.jaws ?? []) {
        const jawGroup = new THREE.Group();
        jawGroup.name = `jaw:${jaw.partId}`;
        group.add(jawGroup);
        node.jaws.push({ group: jawGroup, sign: jaw.sign });
        movingByPart.set(jaw.partId, { node, jaw: node.jaws.length - 1 });
      }
    } else {
      const mover = new THREE.Group();
      mover.name = axis.kind === 'rotary' ? `pivot:${axis.actuatorId}` : `slide:${axis.actuatorId}`;
      if (axis.kind === 'rotary') mover.position.set(axis.pivot[0], axis.pivot[1], axis.pivot[2]);
      group.add(mover);
      node.mover = mover;
      for (const partId of axis.partIds) movingByPart.set(partId, { node });
    }
    actuators.set(axis.actuatorId, node);
  }

  const sensors = new Map<string, ThreeSensorNode>();
  const geometryCache = new Map<string, THREE.BufferGeometry>();
  const materialCache = new Map<string, THREE.MeshStandardMaterial>();
  const geometryOf = (part: GeomPart): THREE.BufferGeometry => {
    const key = geometryKey(part);
    let entry = geometryCache.get(key);
    if (!entry) {
      entry = createPartGeometry(part, segments);
      geometryCache.set(key, entry);
    }
    return entry;
  };
  const materialOf = (part: GeomPart): THREE.MeshStandardMaterial => {
    const key = materialKey(part);
    let entry = materialCache.get(key);
    if (!entry) {
      entry = createMaterial(part);
      materialCache.set(key, entry);
    }
    return entry;
  };
  let meshCount = 0;
  for (const part of geometry.parts) {
    // 工件（板）不画：3D 视口画的是机台，工件是料。它只进干涉模型（见 machine-geometry 的工件占位体），
    // 放进场景会让「同一个机型」的视图多出一块没有件号的实体，视觉上等于改 UI。
    if (part.role === 'workpiece') continue;
    if (part.sensorPoint && (part.role === 'sensor' || part.role === 'safety')) {
      const key = part.sensorPoint.toUpperCase();
      let sensor = sensors.get(key);
      if (!sensor) {
        sensor = {
          point: part.sensorPoint,
          meshes: [],
          material: new THREE.MeshStandardMaterial({
            color: options.sensorOffColor?.clone() ?? new THREE.Color(part.color),
            emissive: 0x000000,
            emissiveIntensity: 0.05,
            metalness: 0.1,
            roughness: 0.35
          })
        };
        sensors.set(key, sensor);
      }
      const mesh = partMesh(part, sensor.material, geometryOf(part));
      sensor.meshes.push(mesh);
      (stationGroups.get(part.stationId ?? '') ?? machineGroup).add(mesh);
      meshCount += 1;
      continue;
    }
    const mesh = partMesh(part, materialOf(part), geometryOf(part));
    meshCount += 1;
    const moving = movingByPart.get(part.id);
    if (moving) {
      if (moving.jaw !== undefined) {
        moving.node.jaws[moving.jaw]?.group.add(mesh);
      } else if (moving.node.mover) {
        if (moving.node.axis.kind === 'rotary') {
          const pivot = moving.node.axis.pivot;
          mesh.position.set(part.center[0] - pivot[0], part.center[1] - pivot[1], part.center[2] - pivot[2]);
        }
        moving.node.mover.add(mesh);
      }
      continue;
    }
    if (part.actuatorId && actuators.has(part.actuatorId)) {
      actuators.get(part.actuatorId)?.group.add(mesh);
    } else if (part.stationId && stationGroups.has(part.stationId)) {
      stationGroups.get(part.stationId)?.add(mesh);
    } else {
      machineGroup.add(mesh);
    }
  }

  // 一次性建立静态矩阵；动画只重算 mover/jaw 子树，避免整棵 3000 件场景每帧重建矩阵。
  root.updateMatrixWorld(true);
  const dynamic = new Set<THREE.Object3D>();
  for (const node of actuators.values()) {
    if (node.mover) dynamic.add(node.mover);
    for (const jaw of node.jaws) dynamic.add(jaw.group);
  }
  root.traverse((object) => {
    if (dynamic.has(object)) return;
    for (let ancestor = object.parent; ancestor; ancestor = ancestor.parent) {
      if (dynamic.has(ancestor)) return;
    }
    object.updateMatrix();
    object.matrixAutoUpdate = false;
  });

  return { root, scale, stationGroups, actuators, sensors, meshCount };
}

/**
 * 把 MachineMotion 的状态值作用到场景：
 * linear value 0~1（伸出比例）；gripper value 0~1（1 为闭合）；rotary value 为角度（0~rangeDeg）。
 */
export function applyAxisValue(node: ThreeActuatorNode, value: number): boolean {
  const axis = node.axis;
  const normalized = axis.kind === 'rotary'
    ? Math.max(0, Math.min(axis.rangeDeg || 90, value))
    : Math.max(0, Math.min(1, value));
  if (node.lastValue !== undefined && Math.abs(node.lastValue - normalized) < 1e-6) return false;
  node.lastValue = normalized;
  if (axis.kind === 'linear' && node.mover) {
    const distance = normalized * axis.strokeMm;
    node.mover.position.set(axis.axis[0] * distance, axis.axis[1] * distance, axis.axis[2] * distance);
  } else if (axis.kind === 'gripper') {
    const distance = (normalized * axis.strokeMm) / 2;
    for (const jaw of node.jaws) {
      jaw.group.position.set(axis.axis[0] * distance * jaw.sign, axis.axis[1] * distance * jaw.sign, axis.axis[2] * distance * jaw.sign);
    }
  } else if (axis.kind === 'rotary' && node.mover) {
    node.axisUnit ??= new THREE.Vector3(axis.axis[0], axis.axis[1], axis.axis[2]).normalize();
    node.mover.quaternion.setFromAxisAngle(node.axisUnit, THREE.MathUtils.degToRad(normalized));
  }
  return true;
}

/** 释放整机场景的共享几何、材质与组层级；共享资源只释放一次。 */
export function disposeThreeMachine(machine: ThreeMachine): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  machine.root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const entry of material) materials.add(entry);
    } else if (material) {
      materials.add(material);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  machine.root.removeFromParent();
  machine.root.clear();
  machine.stationGroups.clear();
  machine.actuators.clear();
  machine.sensors.clear();
}
