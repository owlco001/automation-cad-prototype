// 构件库：整机设计时「能从库里拖一个出来」的构件类型。
//
// 为什么放在 desktop 而不是 Qt：几何事实源只有一处。Qt 只负责展示与拖拽，
// 构件定义、默认尺寸、插入后的几何重算都在这里，否则会出现第二套几何口径。

import type { GeomPart, GeomRole, GeomBomGroup } from './geometry.ts';

export interface CatalogEntry {
  /** 稳定的类型键，写进 partId（user-<type>-<n>） */
  type: string;
  label: string;
  role: GeomRole;
  bomGroup: GeomBomGroup;
  shape: GeomPart['shape'];
  /** 插入时相对落点的偏移：让构件「底面贴地」而不是中心贴地 */
  groundOffsetMm: number;
  color: string;
  material: string;
}

export const CATALOG: CatalogEntry[] = [
  { type: 'upright', label: '机架立柱 60×60×830', role: 'frame', bomGroup: 'structure',
    shape: { type: 'box', size: [60, 60, 830] }, groundOffsetMm: 415, color: '#8a949c', material: 'Q235' },
  { type: 'beam', label: '横梁 960×60×40', role: 'frame', bomGroup: 'structure',
    shape: { type: 'box', size: [960, 60, 40] }, groundOffsetMm: 0, color: '#8a949c', material: 'Q235' },
  { type: 'conveyor', label: '输送段 600×300×60', role: 'transfer', bomGroup: 'structure',
    shape: { type: 'box', size: [600, 300, 60] }, groundOffsetMm: 30, color: '#6f7b85', material: '铝型材' },
  { type: 'slide', label: '滑台气缸（占位）', role: 'actuator', bomGroup: 'actuator:cylinder',
    shape: { type: 'box', size: [80, 60, 120] }, groundOffsetMm: 60, color: '#4d7ea8', material: '铝合金' },
  { type: 'gripper', label: '气爪（占位）', role: 'actuator', bomGroup: 'actuator:gripper',
    shape: { type: 'box', size: [70, 70, 60] }, groundOffsetMm: 30, color: '#3f6fa0', material: '铝合金' },
  { type: 'sensor', label: '到位检测（占位）', role: 'sensor', bomGroup: 'sensor:proximity',
    shape: { type: 'box', size: [20, 20, 40] }, groundOffsetMm: 20, color: '#c08a3e', material: 'ABS' }
];

export function catalogFor(type: string): CatalogEntry | undefined {
  return CATALOG.find((entry) => entry.type === type);
}

export interface InsertRequest {
  type: string;
  /** 落点（mm，世界坐标） */
  at: [number, number, number];
  /** 已有零件 id，用来生成不重复的编号 */
  existingIds: string[];
}

export interface InsertResult {
  ok: boolean;
  part?: GeomPart;
  reason?: string;
}

/**
 * 生成一个待插入的零件（纯函数，不碰几何求解）。
 * 落点按「底面贴地」解释：传进来的 y/z 不变，z 减去 groundOffset，让构件坐在落点上。
 */
export function buildInsertPart(request: InsertRequest): InsertResult {
  const entry = catalogFor(request.type);
  if (!entry) {
    return { ok: false, reason: `构件库里没有类型 ${request.type}（可用：${CATALOG.map((item) => item.type).join('、')}）` };
  }
  const [x, y, z] = request.at;
  if (![x, y, z].every((value) => Number.isFinite(value))) {
    return { ok: false, reason: '落点坐标必须是数字' };
  }
  let index = 1;
  const taken = new Set(request.existingIds);
  while (taken.has(`user-${entry.type}-${index}`)) index += 1;
  const id = `user-${entry.type}-${index}`;
  return {
    ok: true,
    part: {
      id,
      name: entry.label,
      role: entry.role,
      shape: entry.shape,
      center: [x, y, z + entry.groundOffsetMm],
      rotationZDeg: 0,
      color: entry.color,
      material: entry.material,
      bomGroup: entry.bomGroup,
      estimated: true
    } as GeomPart
  };
}
