import { validateMachineConfig, type MachineConfig } from '../commission/machine-config.ts';
import { validateMachineDesign, type StoredMachineDesign } from '../machine/design-validation.ts';
import { deserializeDoc } from '../parametric/model.ts';
import { deserializeAnnotation } from '../cad/kinematics-ui.ts';
import { parsePlcConfig } from '../plc/config.ts';
import type { PlcPoint } from '../plc/types.ts';

export const MAX_PROJECT_SNAPSHOT_BYTES = 10 * 1024 * 1024;

export interface ProjectViewState {
  schemaVersion: 1;
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fovDeg: number;
  wireframe: boolean;
}

/** Local workspace state; projectId is the session binding, not a portable CAD id.
 * meshSignature is SHA-256 over the exact saved per-part STL buffers in order.
 * Annotations (including v1 mesh indices) may only be applied after that match.
 * Global settings, credentials, and live PLC connections never belong here.
 */
export interface ProjectSnapshot {
  schemaVersion: 1;
  projectId: string;
  sourceName: string;
  machineConfig: MachineConfig | null;
  machineDesign: StoredMachineDesign | null;
  featureTreeJson: string | null;
  kinematicsJson: string | null;
  viewState: ProjectViewState | null;
  meshSignature: string;
  ioPoints: PlcPoint[] | null;
}

type RecordValue = Record<string, unknown>;
function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as RecordValue;
}
function keys(value: RecordValue, required: string[], optional: string[] = []): void {
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error('Unknown or missing snapshot fields');
  }
}
function text(value: unknown, label: string, max = 1024, nonempty = true): string {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

/** Reject non-JSON input before stringify can silently discard or transform it. */
function jsonClone(value: unknown): unknown {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 500000 || depth > 64) throw new Error('Snapshot JSON is too complex');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || !item) throw new Error('Snapshot must contain only JSON values');
    if (ancestors.has(item)) throw new Error('Snapshot must not contain cycles');
    const proto = Object.getPrototypeOf(item);
    if (Object.getOwnPropertySymbols(item).length) throw new Error('Snapshot must not contain symbol properties');
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) throw new Error('Snapshot must contain plain JSON objects');
    ancestors.add(item);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) visit(item[index], depth + 1);
    } else {
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
        if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Snapshot must contain JSON data properties');
        if (/^(?:__proto__|prototype|constructor|password|passwd|secret|token|apiKey|api_key|authorization|credentials?|host|port|connection|connections|transport|runtime|socket)$/i.test(key)) {
          throw new Error(`Snapshot contains forbidden runtime or credential field: ${key}`);
        }
        visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > MAX_PROJECT_SNAPSHOT_BYTES) throw new Error('Snapshot exceeds 10 MiB');
  return JSON.parse(serialized) as unknown;
}

function tuple(value: unknown, label: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e12)) {
    throw new Error(`${label} must contain three finite coordinates`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

export function parseProjectViewState(value: unknown): ProjectViewState {
  const raw = record(value, 'viewState');
  keys(raw, ['schemaVersion', 'position', 'target', 'up', 'fovDeg', 'wireframe']);
  if (raw.schemaVersion !== 1) throw new Error('Unsupported viewState schemaVersion');
  const position = tuple(raw.position, 'position');
  const target = tuple(raw.target, 'target');
  const up = tuple(raw.up, 'up');
  const direction = position.map((n, index) => n - target[index]!);
  if (Math.hypot(...direction) < 1e-9 || Math.hypot(...up) < 1e-9) throw new Error('Degenerate camera view');
  const cross = [direction[1]! * up[2] - direction[2]! * up[1], direction[2]! * up[0] - direction[0]! * up[2], direction[0]! * up[1] - direction[1]! * up[0]];
  if (Math.hypot(...cross) / (Math.hypot(...direction) * Math.hypot(...up)) < 1e-9) throw new Error('Camera up is parallel to view direction');
  if (typeof raw.fovDeg !== 'number' || !Number.isFinite(raw.fovDeg) || raw.fovDeg < 1 || raw.fovDeg > 179 || typeof raw.wireframe !== 'boolean') throw new Error('Invalid viewState camera settings');
  return { schemaVersion: 1, position, target, up, fovDeg: raw.fovDeg, wireframe: raw.wireframe };
}

function featureTree(value: unknown): string | null {
  if (value === null) return null;
  const input = text(value, 'featureTreeJson', MAX_PROJECT_SNAPSHOT_BYTES);
  const raw = record(jsonClone(JSON.parse(input)), 'featureTree');
  const assembly = Array.isArray(raw.instances);
  keys(raw, assembly ? ['schemaVersion', 'instances', 'updatedAt'] : ['schemaVersion', 'features', 'updatedAt'], ['sourceFile']);
  const features = (items: unknown): void => {
    if (!Array.isArray(items)) throw new Error('Invalid features');
    for (const item of items) {
      const node = record(item, 'feature');
      keys(node, ['id', 'type', 'name', 'params'], ['suppressed']);
      const allowed: Record<string, string[]> = { box: ['length', 'width', 'height', 'centered'], cylinder: ['diameter', 'height', 'at', 'axis'], holes: ['diameter', 'positions', 'depth', 'thread', 'threadDepth'], counterbore: ['diameter', 'cbDiameter', 'cbDepth', 'positions', 'depth', 'thread', 'threadDepth'], slot: ['length', 'width'], fillet: ['radius', 'edges'] };
      const params = record(node.params, 'feature params');
      if (typeof node.type !== 'string' || !Object.hasOwn(allowed, node.type) || Object.keys(params).some((key) => !allowed[node.type as string]!.includes(key))) throw new Error('Unknown feature parameters');
    }
  };
  if (assembly) {
    for (const item of raw.instances as unknown[]) {
      const instance = record(item, 'instance');
      keys(instance, ['id', 'name', 'transform', 'features'], ['partId']);
      keys(record(instance.transform, 'transform'), ['x', 'y', 'z'], ['rz']);
      features(instance.features);
    }
  } else features(raw.features);
  const parsed = deserializeDoc(input);
  if (!parsed.ok || !parsed.doc) throw new Error(`Invalid feature tree: ${parsed.errors.join('; ')}`);
  return input;
}

function kinematics(value: unknown): string | null {
  if (value === null) return null;
  const input = text(value, 'kinematicsJson', MAX_PROJECT_SNAPSHOT_BYTES);
  const raw = record(jsonClone(JSON.parse(input)), 'kinematics');
  keys(raw, raw.version === 2 ? ['version', 'projectId', 'sourceFile', 'parts'] : ['version', 'sourceFile', 'parts']);
  if (!Array.isArray(raw.parts)) throw new Error('Invalid annotation parts');
  const required = ['id', 'name', 'meshIds', 'meshNames', 'center', 'size', 'kind', 'axis', 'direction', 'travelMm', 'retractedMm', 'rangeDeg', 'retractedDeg', 'point', 'role'];
  const ids = new Set<string>();
  for (const item of raw.parts) {
    const part = record(item, 'annotation part');
    keys(part, raw.version === 2 ? [...required, 'meshObjectIds'] : required, ['yawDeg']);
    const id = text(part.id, 'annotation part id', 256);
    if (ids.has(id)) throw new Error('Duplicate annotation part id');
    ids.add(id);
    text(part.name, 'annotation part name');
    text(part.point, 'annotation point', 256, false);
    tuple(part.center, 'annotation center');
    const size = tuple(part.size, 'annotation size');
    if (size.some((n) => n < 0)) throw new Error('Invalid annotation size');
    if (!Array.isArray(part.meshIds) || !part.meshIds.length || part.meshIds.some((n) => typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
      || new Set(part.meshIds).size !== part.meshIds.length) throw new Error('Invalid annotation meshIds');
    if (!Array.isArray(part.meshNames) || part.meshNames.some((name) => typeof name !== 'string')) throw new Error('Invalid annotation meshNames');
    if (part.direction !== 1 && part.direction !== -1) throw new Error('Invalid annotation direction');
    if (!['', 'extend', 'retract', 'rotate'].includes(part.role as string)) throw new Error('Invalid annotation role');
    for (const key of ['travelMm', 'retractedMm', 'rangeDeg', 'retractedDeg', ...(part.yawDeg === undefined ? [] : ['yawDeg'])]) {
      if (typeof part[key] !== 'number' || !Number.isFinite(part[key])) throw new Error(`Invalid annotation ${key}`);
    }
    if (raw.version === 2 && (!Array.isArray(part.meshObjectIds) || part.meshObjectIds.length !== part.meshIds.length
      || part.meshObjectIds.some((id) => typeof id !== 'string' || !/^cadobj-[a-f0-9]{64}$/.test(id)))) throw new Error('Invalid annotation stable mesh ids');
  }
  const parsed = deserializeAnnotation(input);
  if (!parsed.ok || !parsed.annotation) throw new Error(`Invalid kinematics: ${parsed.issues.map((issue) => issue.message).join('; ')}`);
  return input;
}

function points(value: unknown): PlcPoint[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 10000) throw new Error('ioPoints must be a bounded array');
  if (value.length === 0) return [];
  for (const item of value) {
    const point = record(item, 'ioPoint');
    keys(point, ['id', 'name', 'area', 'address', 'dataType'], ['writable', 'unit']);
    text(point.id, 'ioPoint id', 256);
    text(point.name, 'ioPoint name', 256);
    if (point.unit !== undefined) text(point.unit, 'unit', 128, false);
    if (point.writable !== undefined && typeof point.writable !== 'boolean') throw new Error('Invalid point writable');
  }
  const parsed = parsePlcConfig({ kind: 'sim', points: value }).points;
  const names = new Set<string>();
  const addresses = new Set<string>();
  for (const point of parsed) {
    const address = `${point.area}:${point.address}`;
    if (names.has(point.name) || addresses.has(address)) throw new Error('Duplicate ioPoint name or address');
    names.add(point.name);
    addresses.add(address);
  }
  return parsed.map((point, index) => ({ ...point, ...(typeof (value[index] as RecordValue).writable === 'boolean' ? { writable: (value[index] as RecordValue).writable as boolean } : {}) }));
}

export function parseProjectSnapshot(value: unknown): ProjectSnapshot {
  const raw = record(jsonClone(value), 'snapshot');
  keys(raw, ['schemaVersion', 'projectId', 'sourceName', 'machineConfig', 'machineDesign', 'featureTreeJson', 'kinematicsJson', 'viewState', 'meshSignature', 'ioPoints']);
  if (raw.schemaVersion !== 1) throw new Error('Unsupported project snapshot schemaVersion');
  const projectId = text(raw.projectId, 'projectId', 256);
  const sourceName = text(raw.sourceName, 'sourceName', 4096, false);
  if (typeof raw.meshSignature !== 'string' || !/^[a-f0-9]{64}$/i.test(raw.meshSignature)) throw new Error('meshSignature must be a SHA-256 hex digest');
  const machineConfig = raw.machineConfig === null ? null : validateMachineConfig(raw.machineConfig);
  let machineDesign: StoredMachineDesign | null = null;
  if (raw.machineDesign !== null) {
    const design = record(raw.machineDesign, 'machineDesign');
    keys(design, ['schemaVersion', 'kind', 'id', 'name', 'appliedAt', 'config', 'stationIdentities', 'points', 'warnings', 'assumptions'], ['stationGeometryLayout', 'stationGeometryWarning', 'cycle', 'power', 'cost', 'bomDraft', 'form']);
    if (design.schemaVersion !== 1 || design.kind !== 'machine-design') throw new Error('Invalid stored machine design');
    const normalized = validateMachineDesign(design);
    machineDesign = { ...normalized, schemaVersion: 1, kind: 'machine-design', id: text(design.id, 'design id', 256), name: text(design.name, 'design name', 1024), appliedAt: text(design.appliedAt, 'design appliedAt', 128, false) };
  }
  const snapshot: ProjectSnapshot = { schemaVersion: 1, projectId, sourceName, machineConfig, machineDesign, featureTreeJson: featureTree(raw.featureTreeJson), kinematicsJson: kinematics(raw.kinematicsJson), viewState: raw.viewState === null ? null : parseProjectViewState(raw.viewState), meshSignature: raw.meshSignature.toLowerCase(), ioPoints: points(raw.ioPoints) };
  return jsonClone(snapshot) as ProjectSnapshot;
}
