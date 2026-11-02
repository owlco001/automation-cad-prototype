export type FeatureType = 'box' | 'cylinder' | 'holes' | 'counterbore' | 'slot' | 'fillet';

/** cylinder 的轴向：z 竖直（默认），x/y 横轴（滚筒、传动轴、销轴）。 */
export type CylinderAxis = 'x' | 'y' | 'z';
export const CYLINDER_AXES: readonly CylinderAxis[] = ['x', 'y', 'z'] as const;

export interface FeatureNode {
  id: string;
  type: FeatureType;
  name: string;
  params: Record<string, unknown>;
  suppressed?: boolean;
}

export interface FeatureDoc {
  schemaVersion: 1;
  sourceFile?: string;
  features: FeatureNode[];
  updatedAt: string;
}

export interface InstanceTransform {
  x: number;
  y: number;
  z: number;
  rz: number;
}

/** 装配里的一个实体：独立特征列表 + 相对装配原点的变换。 */
export interface PartInstance {
  id: string;
  name: string;
  partId?: string;
  transform: InstanceTransform;
  features: FeatureNode[];
}

/** 装配文档；schemaVersion 2 用于区分旧的单件 FeatureDoc。 */
export interface AssemblyDoc {
  schemaVersion: 1 | 2;
  sourceFile?: string;
  instances: PartInstance[];
  updatedAt: string;
}

export interface CompiledInstance {
  id: string;
  name: string;
  partId?: string;
  transform: InstanceTransform;
  ops: Array<Record<string, unknown>>;
}

export interface CompiledAssembly {
  /** 所有实体算子按实体顺序拼接，便于旧消费者观察全量操作。 */
  ops: Array<Record<string, unknown>>;
  /** 每实体独立算子与基础变换；sidecar 优先使用此字段。 */
  instances: CompiledInstance[];
}

export const ASSEMBLY_SCHEMA_VERSION = 2 as const;
// 与 sidecar 的 MAX_INSTANCES 对齐：整机装配不止 50 件（立体缓存 56 件、光伏缓存堆叠 94 件）
export const MAX_ASSEMBLY_INSTANCES = 200;
/** 单次 POST /build 的实体数：内核一次布尔求和太多件会明显变慢，逐块提交更稳 */
export const MAX_ASSEMBLY_CHUNK = 50;

type UnknownRecord = Record<string, unknown>;

const FEATURE_TYPES: readonly FeatureType[] = ['box', 'cylinder', 'holes', 'counterbore', 'slot', 'fillet'];
const TIMEZONE_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function formatMm(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(Math.round(value * 100) / 100);
}

function featureLabel(node: UnknownRecord, index: number): string {
  const name = typeof node.name === 'string' && node.name.trim() ? node.name.trim() : '未命名';
  return `第 ${index + 1} 个特征（${name}）`;
}

function paramNumber(
  params: UnknownRecord,
  key: string,
  label: string,
  errors: string[],
  options: { allowZero?: boolean; allowNegative?: boolean } = {}
): number | null {
  const value = params[key];
  if (value === undefined) {
    errors.push(`缺少必填参数：${label}.${key}`);
    return null;
  }
  if (!isFiniteNumber(value)) {
    errors.push(`${label}：参数「${key}」必须是数字`);
    return null;
  }
  if (options.allowNegative ? value === 0 : options.allowZero ? value < 0 : value <= 0) {
    const rule = options.allowNegative ? '不能为 0' : options.allowZero ? '不能为负数' : '必须大于 0';
    errors.push(`${label}：参数「${key}」${rule}`);
    return null;
  }
  return value;
}

function vector3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [x, y, z] = value;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) return null;
  return [x, y, z];
}

function positionsOf(value: unknown): Array<[number, number]> | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const positions: Array<[number, number]> = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2) return null;
    const [x, y] = item;
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
    positions.push([x, y]);
  }
  return positions;
}

function collectPlate(doc: FeatureDoc): { minX: number; maxX: number; minY: number; maxY: number; thickness: number } | null {
  let plate: { minX: number; maxX: number; minY: number; maxY: number; thickness: number } | null = null;
  for (const node of Array.isArray(doc.features) ? doc.features : []) {
    if (!isRecord(node) || node.type !== 'box' || node.suppressed === true) continue;
    const params = isRecord(node.params) ? node.params : {};
    const length = params.length;
    const width = params.width;
    const height = params.height;
    if (!positiveNumber(length) || !positiveNumber(width) || !positiveNumber(height)) continue;
    const centered = params.centered !== false;
    const minX = centered ? -length / 2 : 0;
    const minY = centered ? -width / 2 : 0;
    if (!plate) {
      plate = { minX, maxX: minX + length, minY, maxY: minY + width, thickness: height };
    } else {
      plate.thickness = Math.min(plate.thickness, height);
    }
  }
  return plate;
}

/**
 * 螺纹孔（可选，只影响工程图标注，不改 sidecar 几何：diameter 即螺纹底孔径）：
 * thread 如 M6 / M8x1（空串视为光孔）；threadDepth 为螺纹有效深度，不得超过定深孔深。
 */
function validateThread(params: UnknownRecord, label: string, diameter: number | null, errors: string[]): void {
  const raw = params.thread;
  const hasThread = raw !== undefined && raw !== '';
  if (hasThread) {
    const match = typeof raw === 'string' ? /^M(\d+(?:\.\d+)?)(?:[x×*]\d+(?:\.\d+)?)?$/i.exec(raw.trim().replace(/\s+/g, '')) : null;
    if (!match) {
      errors.push(`${label}：参数「thread」必须是螺纹规格（如 M6、M8x1）`);
    } else if (diameter !== null && diameter >= Number(match[1])) {
      errors.push(`${label}：螺纹底孔径 ${formatMm(diameter)} mm 必须小于公称直径 ${match[1]} mm`);
    }
  }
  const depth = params.threadDepth;
  if (depth === undefined || depth === '') return;
  if (!positiveNumber(depth)) {
    errors.push(`${label}：参数「threadDepth」必须大于 0`);
    return;
  }
  if (!hasThread) errors.push(`${label}：填写了螺纹深但没有螺纹规格`);
  if (positiveNumber(params.depth) && depth > params.depth) {
    errors.push(`${label}：螺纹深 ${formatMm(depth)} mm 超过孔深 ${formatMm(params.depth)} mm`);
  }
}

/** 判断输入是否为装配文档（存在 instances 数组）。 */
export function isAssemblyDoc(value: unknown): value is AssemblyDoc {
  return isRecord(value) && Array.isArray(value.instances);
}

function transformOf(value: unknown): InstanceTransform | null {
  if (!isRecord(value)) return null;
  const { x, y, z, rz } = value;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) return null;
  const rotation = rz === undefined ? 0 : rz;
  if (!isFiniteNumber(rotation)) return null;
  return { x, y, z, rz: rotation };
}

/** 校验整棵装配，逐实体复用特征树校验并补充实体级规则。 */
export function validateAssembly(assembly: AssemblyDoc): string[] {
  const errors: string[] = [];
  const raw = assembly as unknown;
  if (!isRecord(raw) || !Array.isArray(raw.instances)) {
    errors.push('装配格式无效：instances 必须是数组');
    return errors;
  }
  const instances = raw.instances;
  if (instances.length === 0) errors.push('装配为空，至少需要一个实体');
  if (instances.length > MAX_ASSEMBLY_INSTANCES) {
    errors.push(`装配最多支持 ${MAX_ASSEMBLY_INSTANCES} 个实体（当前 ${instances.length} 个）`);
  }
  const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt.trim()
    ? raw.updatedAt
    : '1970-01-01T00:00:00Z';
  const ids = new Map<string, number>();

  instances.forEach((value, index) => {
    if (!isRecord(value)) {
      errors.push(`第 ${index + 1} 个实体：必须是对象`);
      return;
    }
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    const rawName = typeof value.name === 'string' ? value.name.trim() : '';
    const label = `第 ${index + 1} 个实体${rawName ? `（${rawName}）` : ''}`;
    if (!id) {
      errors.push(`缺少必填参数：${label}.id`);
    } else if (ids.has(id)) {
      errors.push(`${label}：id「${id}」与第 ${(ids.get(id) ?? index) + 1} 个实体重复`);
    } else {
      ids.set(id, index);
    }
    if (!rawName) errors.push(`缺少必填参数：${label}.name`);
    if (value.partId !== undefined && typeof value.partId !== 'string') {
      errors.push(`${label}：partId 必须是字符串`);
    }
    if (transformOf(value.transform) === null) {
      errors.push(`${label}：transform 必须包含数字 x / y / z（rz 可省略，省略按 0）`);
    }
    if (!Array.isArray(value.features)) {
      errors.push(`${label}：features 必须是数组`);
      return;
    }
    const featureErrors = validateFeatureDoc({
      schemaVersion: 1,
      features: value.features as FeatureNode[],
      updatedAt
    });
    for (const message of featureErrors) errors.push(`${label}：${message}`);
  });

  if (typeof raw.updatedAt !== 'string' || !raw.updatedAt.trim()) {
    errors.push('updatedAt 必须带时区（如 2026-10-23T12:00:00+08:00）');
  } else if (!TIMEZONE_PATTERN.test(raw.updatedAt) || Number.isNaN(Date.parse(raw.updatedAt))) {
    errors.push('updatedAt 必须带时区（如 2026-10-23T12:00:00+08:00）');
  }
  return errors;
}

/** 校验单个实体特征列表。 */
function validateFeatureDoc(doc: FeatureDoc): string[] {
  const errors: string[] = [];
  const raw = doc as unknown;
  if (!isRecord(raw) || !Array.isArray(raw.features)) {
    errors.push('特征树格式无效：features 必须是数组');
    return errors;
  }
  const features = raw.features;
  if (features.length === 0) errors.push('特征树为空，至少需要一个特征');

  const ids = new Map<string, number>();
  let plate: ReturnType<typeof collectPlate> = null;
  try {
    plate = collectPlate(raw as unknown as FeatureDoc);
  } catch {
    plate = null;
  }

  features.forEach((value, index) => {
    if (!isRecord(value)) {
      errors.push(`第 ${index + 1} 个特征：必须是对象`);
      return;
    }
    const label = featureLabel(value, index);
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    if (!id) {
      errors.push(`缺少必填参数：${label}.id`);
    } else if (ids.has(id)) {
      errors.push(`${label}：id「${id}」与第 ${(ids.get(id) ?? index) + 1} 个特征重复`);
    } else {
      ids.set(id, index);
    }

    const type = value.type;
    if (typeof type !== 'string' || !FEATURE_TYPES.includes(type as FeatureType)) {
      errors.push(`${label}：未知特征类型「${String(type ?? '')}」`);
      return;
    }
    const params = isRecord(value.params) ? value.params : {};
    if (!isRecord(value.params)) errors.push(`${label}：参数 params 必须是对象`);

    if (type === 'box') {
      paramNumber(params, 'length', label, errors);
      paramNumber(params, 'width', label, errors);
      paramNumber(params, 'height', label, errors);
      if (params.centered !== undefined && typeof params.centered !== 'boolean') {
        errors.push(`${label}：参数「centered」必须是布尔值`);
      }
      return;
    }

    if (type === 'cylinder') {
      paramNumber(params, 'diameter', label, errors);
      paramNumber(params, 'height', label, errors);
      if (params.at !== undefined && vector3(params.at) === null) {
        errors.push(`${label}：参数「at」必须是 3 个数字组成的数组`);
      }
      // axis：圆柱轴向，缺省 z。内核支持 x/y/z（横轴滚筒、传动轴必须带 axis），值域外一律报错，
      // 不静默回落成 z —— 静默回落会让横轴件悄悄变成竖直圆柱，比报错更难查。
      if (params.axis !== undefined && !CYLINDER_AXES.includes(params.axis as CylinderAxis)) {
        errors.push(`${label}：参数「axis」只能是 x / y / z（收到「${String(params.axis)}」）`);
      }
      return;
    }

    if (type === 'holes') {
      const diameter = paramNumber(params, 'diameter', label, errors);
      const positions = positionsOf(params.positions);
      if (params.positions === undefined) {
        errors.push(`缺少必填参数：${label}.positions`);
      } else if (!Array.isArray(params.positions)) {
        errors.push(`${label}：参数「positions」必须是孔位数组`);
      } else if (params.positions.length === 0) {
        errors.push(`${label}：孔位不能为空`);
      } else if (positions === null) {
        errors.push(`${label}：参数「positions」必须是 [x, y] 二元数组`);
      }
      if (params.depth !== undefined && params.depth !== 'through' && !positiveNumber(params.depth)) {
        errors.push(`${label}：参数「depth」必须是 through 或大于 0 的数字`);
      }
      validateThread(params, label, diameter, errors);
      if (positions && plate) {
        const outside = positions.find(([x, y]) =>
          x < plate.minX || x > plate.maxX || y < plate.minY || y > plate.maxY);
        if (outside) {
          errors.push(`${label}：孔 (${formatMm(outside[0])}, ${formatMm(outside[1])}) 在底板包围盒外`);
        }
      }
      if (positions && diameter !== null) {
        for (let first = 0; first < positions.length; first += 1) {
          for (let second = first + 1; second < positions.length; second += 1) {
            const a = positions[first]!;
            const b = positions[second]!;
            const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
            if (distance < diameter) {
              errors.push(`${label}：孔间距 ${formatMm(distance)} mm 小于孔径 ${formatMm(diameter)} mm`);
            }
          }
        }
      }
      return;
    }

    if (type === 'counterbore') {
      // 沉头孔 = 通孔（或定深孔）+ 顶面下沉的沉窝；几何上两条圆柱相减，必须保证沉窝比通孔大。
      const diameter = paramNumber(params, 'diameter', label, errors);
      const cbDiameter = paramNumber(params, 'cbDiameter', label, errors);
      const cbDepth = paramNumber(params, 'cbDepth', label, errors);
      const positions = positionsOf(params.positions);
      if (params.positions === undefined) {
        errors.push(`缺少必填参数：${label}.positions`);
      } else if (!Array.isArray(params.positions)) {
        errors.push(`${label}：参数「positions」必须是孔位数组`);
      } else if (params.positions.length === 0) {
        errors.push(`${label}：孔位不能为空`);
      } else if (positions === null) {
        errors.push(`${label}：参数「positions」必须是 [x, y] 二元数组`);
      }
      if (params.depth !== undefined && params.depth !== 'through' && !positiveNumber(params.depth)) {
        errors.push(`${label}：参数「depth」必须是 through 或大于 0 的数字`);
      }
      if (diameter !== null && cbDiameter !== null && cbDiameter <= diameter) {
        errors.push(
          `${label}：沉头直径 ${formatMm(cbDiameter)} mm 必须大于通孔直径 ${formatMm(diameter)} mm（否则切不出台阶）`
        );
      }
      if (cbDepth !== null && plate && cbDepth >= plate.thickness) {
        errors.push(
          `${label}：沉头深 ${formatMm(cbDepth)} mm 不小于板厚 ${formatMm(plate.thickness)} mm，会切穿板面`
        );
      }
      if (positions && plate) {
        const oversized = positions.find(([x, y]) => {
          const radius = (cbDiameter ?? diameter ?? 0) / 2;
          return x - radius < plate.minX || x + radius > plate.maxX || y - radius < plate.minY || y + radius > plate.maxY;
        });
        if (oversized) {
          errors.push(`${label}：沉窝 (${formatMm(oversized[0])}, ${formatMm(oversized[1])}) 超出底板边界（含沉头半径）`);
        }
      }
      if (positions && cbDiameter !== null) {
        for (let first = 0; first < positions.length; first += 1) {
          for (let second = first + 1; second < positions.length; second += 1) {
            const a = positions[first]!;
            const b = positions[second]!;
            const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
            if (distance < cbDiameter) {
              errors.push(`${label}：沉窝间距 ${formatMm(distance)} mm 小于沉头直径 ${formatMm(cbDiameter)} mm，台阶会相互切穿`);
            }
          }
        }
      }
      return;
    }

    if (type === 'slot') {
      paramNumber(params, 'length', label, errors);
      paramNumber(params, 'width', label, errors);
      return;
    }

    const radius = paramNumber(params, 'radius', label, errors);
    if (params.edges !== undefined && params.edges !== '|Z' && params.edges !== 'all') {
      errors.push(`${label}：参数「edges」必须是 |Z 或 all`);
    }
    if (radius !== null && plate && radius > plate.thickness / 2) {
      errors.push(
        `${label}：圆角半径 ${formatMm(radius)} mm 超过最小板厚 ${formatMm(plate.thickness)} mm 的一半（${formatMm(plate.thickness / 2)} mm）`
      );
    }
  });

  const updatedAt = raw.updatedAt;
  if (typeof updatedAt !== 'string' || !updatedAt.trim()) {
    errors.push('updatedAt 必须带时区（如 2026-10-23T12:00:00+08:00）');
  } else if (!TIMEZONE_PATTERN.test(updatedAt) || Number.isNaN(Date.parse(updatedAt))) {
    errors.push('updatedAt 必须带时区（如 2026-10-23T12:00:00+08:00）');
  }
  return errors;
}

/** 兼容入口：FeatureDoc 走单件校验，AssemblyDoc 走装配校验。 */
export function validateFeatures(doc: FeatureDoc): string[];
export function validateFeatures(assembly: AssemblyDoc): string[];
export function validateFeatures(input: FeatureDoc | AssemblyDoc): string[];
export function validateFeatures(input: FeatureDoc | AssemblyDoc): string[] {
  return isAssemblyDoc(input) ? validateAssembly(input) : validateFeatureDoc(input);
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
  }
  return value;
}

/** 旧 FeatureDoc 自动包成单实体 AssemblyDoc；已有装配原样返回深拷贝。 */
export function toAssembly(doc: FeatureDoc | AssemblyDoc): AssemblyDoc {
  if (isAssemblyDoc(doc)) {
    const sourceFile = typeof doc.sourceFile === 'string' ? doc.sourceFile.trim() : '';
    return {
      schemaVersion: ASSEMBLY_SCHEMA_VERSION,
      ...(sourceFile ? { sourceFile } : {}),
      instances: clone(doc.instances),
      updatedAt: doc.updatedAt
    };
  }
  const sourceFile = typeof doc.sourceFile === 'string' ? doc.sourceFile.trim() : '';
  return {
    schemaVersion: ASSEMBLY_SCHEMA_VERSION,
    ...(sourceFile ? { sourceFile } : {}),
    instances: [{
      id: 'p1',
      name: '零件 1',
      transform: { x: 0, y: 0, z: 0, rz: 0 },
      features: clone(Array.isArray(doc.features) ? doc.features : [])
    }],
    updatedAt: doc.updatedAt
  };
}

function compileFeatureOps(features: readonly FeatureNode[]): Array<Record<string, unknown>> {
  const ops: Array<Record<string, unknown>> = [];
  for (const node of Array.isArray(features) ? features : []) {
    if (!isRecord(node) || node.suppressed === true) continue;
    const params = isRecord(node.params) ? node.params : {};
    const type = node.type;
    if (type === 'box') {
      ops.push({
        op: 'box',
        length: params.length,
        width: params.width,
        height: params.height,
        ...(typeof params.centered === 'boolean' ? { centered: params.centered } : {})
      });
    } else if (type === 'cylinder') {
      // axis 必须透传：内核 cylinder 按 axis 旋转展开（x/y 为横轴滚筒、传动轴）。
      // 之前这里丢掉 axis，横轴件到了 sidecar 全变成竖直圆柱；只在值域内透传，
      // 非法值由 validateFeatures 报错（compileOps 不替上游猜轴向）。
      const axis = CYLINDER_AXES.includes(params.axis as CylinderAxis) ? params.axis as CylinderAxis : undefined;
      ops.push({
        op: 'cylinder',
        diameter: params.diameter,
        height: params.height,
        ...(axis && axis !== 'z' ? { axis } : {}),
        ...(params.at !== undefined ? { at: clone(params.at) } : {})
      });
    } else if (type === 'holes') {
      ops.push({
        op: 'holes',
        diameter: params.diameter,
        positions: clone(params.positions),
        ...(params.depth !== undefined ? { depth: params.depth } : {})
      });
    } else if (type === 'counterbore') {
      ops.push({
        op: 'counterbore',
        diameter: params.diameter,
        cbDiameter: params.cbDiameter,
        cbDepth: params.cbDepth,
        positions: clone(params.positions),
        ...(params.depth !== undefined ? { depth: params.depth } : {})
      });
    } else if (type === 'slot') {
      ops.push({ op: 'slot', length: params.length, width: params.width });
    } else if (type === 'fillet') {
      ops.push({
        op: 'fillet',
        radius: params.radius,
        ...(params.edges !== undefined ? { edges: params.edges } : {})
      });
    } else {
      throw new Error(`未知特征类型「${String(type)}」`);
    }
  }
  return ops;
}

function compileTransform(value: unknown): InstanceTransform {
  const transform = transformOf(value);
  if (transform) return transform;
  if (!isRecord(value)) return { x: 0, y: 0, z: 0, rz: 0 };
  return {
    x: isFiniteNumber(value.x) ? value.x : 0,
    y: isFiniteNumber(value.y) ? value.y : 0,
    z: isFiniteNumber(value.z) ? value.z : 0,
    rz: isFiniteNumber(value.rz) ? value.rz : 0
  };
}

/** 将装配编译为 sidecar 白名单算子与每实体变换。 */
export function compileAssembly(assembly: AssemblyDoc): CompiledAssembly {
  const instances: CompiledInstance[] = [];
  for (const instance of Array.isArray(assembly?.instances) ? assembly.instances : []) {
    if (!isRecord(instance)) continue;
    const ops = compileFeatureOps(Array.isArray(instance.features) ? instance.features : []);
    instances.push({
      id: typeof instance.id === 'string' ? instance.id : '',
      name: typeof instance.name === 'string' ? instance.name : '',
      ...(typeof instance.partId === 'string' && instance.partId.trim()
        ? { partId: instance.partId.trim() }
        : {}),
      transform: compileTransform(instance.transform),
      ops
    });
  }
  return { ops: instances.flatMap((instance) => instance.ops), instances };
}

/** 兼容入口：旧 FeatureDoc 返回 ops 数组；AssemblyDoc 返回 ops + instances。 */
export function compileOps(doc: FeatureDoc): Array<Record<string, unknown>>;
export function compileOps(assembly: AssemblyDoc): CompiledAssembly;
export function compileOps(input: FeatureDoc | AssemblyDoc): Array<Record<string, unknown>> | CompiledAssembly;
export function compileOps(input: FeatureDoc | AssemblyDoc): Array<Record<string, unknown>> | CompiledAssembly {
  return isAssemblyDoc(input)
    ? compileAssembly(input)
    : compileFeatureOps(Array.isArray(input?.features) ? input.features : []);
}

/** 特征总数、预计孔数与抑制数；孔数只统计参与编译的孔位。 */
export function summarize(doc: FeatureDoc): { features: number; holes: number; suppressed: number } {
  const features = Array.isArray(doc?.features) ? doc.features : [];
  let holes = 0;
  let suppressed = 0;
  for (const node of features) {
    if (!isRecord(node)) continue;
    if (node.suppressed === true) {
      suppressed += 1;
      continue;
    }
    if (node.type === 'holes' && isRecord(node.params) && Array.isArray(node.params.positions)) {
      holes += node.params.positions.length;
    }
  }
  return { features: features.length, holes, suppressed };
}

export function emptyDoc(): FeatureDoc {
  return { schemaVersion: 1, features: [], updatedAt: new Date().toISOString() };
}
