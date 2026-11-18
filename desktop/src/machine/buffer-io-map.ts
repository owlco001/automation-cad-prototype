import { MAX_BUFFER_SLOTS, type BufferTowerConfig } from './buffer-tower.ts';

export interface BufferIoPointDraft {
  id: string;
  name: string;
  direction: 'input' | 'output';
  signal: string;
  address: null;
  safety: boolean;
}

export interface BufferIoMapDraft {
  schemaVersion: 1;
  points: BufferIoPointDraft[];
  warnings: string[];
}

export interface BufferIoMapValidation {
  ok: boolean;
  executable: false;
  errors: string[];
  warnings: string[];
}

export interface BufferIoPointSpec {
  id: string;
  name: string;
  direction: 'input' | 'output';
  signal: string;
  safety: boolean;
}

/**
 * 9 点逻辑信号规范表：草案的唯一事实来源。
 * 校验以本表为基准（缺项、多项、改名、改向、重复都会失败），
 * 地址仍必须由电气工程分配，安全点仍必须由独立安全回路实现。
 */
export const BUFFER_IO_POINT_SPEC: readonly BufferIoPointSpec[] = [
  { id: 'upstream-ready', name: '上游 Ready', direction: 'input', signal: 'UpstreamReady', safety: false },
  { id: 'upstream-request', name: '上游 Request', direction: 'output', signal: 'UpstreamRequest', safety: false },
  { id: 'downstream-ready', name: '下游 Ready', direction: 'input', signal: 'DownstreamReady', safety: false },
  { id: 'downstream-request', name: '下游 Request', direction: 'output', signal: 'DownstreamRequest', safety: false },
  { id: 'transfer-done', name: 'TransferDone', direction: 'input', signal: 'TransferDone', safety: false },
  { id: 'buffer-full', name: '缓存满料', direction: 'output', signal: 'BufferFull', safety: false },
  { id: 'buffer-empty', name: '缓存缺料', direction: 'output', signal: 'BufferEmpty', safety: false },
  { id: 'buffer-fault', name: '缓存故障', direction: 'input', signal: 'BufferFault', safety: true },
  { id: 'backpressure', name: '缓存背压', direction: 'output', signal: 'Backpressure', safety: false }
];

/** Drafts are intentionally non-executable until every address and safety boundary is engineered. */
export function validateBufferIoMapDraft(draft: BufferIoMapDraft): BufferIoMapValidation {
  if (!draft || draft.schemaVersion !== 1 || !Array.isArray(draft.points)) {
    return { ok: false, executable: false, errors: ['IO 草案格式无效。'], warnings: [] };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const points = draft.points;
  if (points.length !== BUFFER_IO_POINT_SPEC.length) {
    errors.push(`IO 草案必须恰好包含 ${BUFFER_IO_POINT_SPEC.length} 个逻辑点，当前 ${points.length} 个。`);
  }
  const specById = new Map(BUFFER_IO_POINT_SPEC.map((spec) => [spec.id, spec]));
  const specSignals = new Set(BUFFER_IO_POINT_SPEC.map((spec) => spec.signal));
  const seenIds = new Set<string>();
  const seenSignals = new Set<string>();

  for (const point of points) {
    const label = typeof point?.id === 'string' && point.id !== '' ? point.id : '(缺少 id)';
    if (typeof point?.id !== 'string' || point.id.trim() === '') errors.push('存在缺少 id 的点位。');
    else if (seenIds.has(point.id)) errors.push(`点位 id 重复：${point.id}。`);
    else seenIds.add(point.id);

    if (typeof point?.name !== 'string' || point.name.trim() === '') errors.push(`${label} 缺少点位名称。`);
    if (point?.direction !== 'input' && point?.direction !== 'output') {
      errors.push(`${label} 方向必须为 input 或 output，实际为 ${String(point?.direction)}。`);
    }
    if (typeof point?.signal !== 'string' || !specSignals.has(point.signal)) {
      errors.push(`${label} 使用了规范表之外的逻辑信号：${String(point?.signal)}。`);
    } else if (seenSignals.has(point.signal)) {
      errors.push(`逻辑信号重复：${point.signal}。`);
    } else {
      seenSignals.add(point.signal);
    }
    const spec = typeof point?.id === 'string' ? specById.get(point.id) : undefined;
    if (spec && point?.signal !== spec.signal) {
      // id↔signal 绑定必须显式校验：方向/安全位“跟着一起改”并不能让错绑变成合法。
      errors.push(`${label} 的逻辑信号应为 ${spec.signal}，实际为 ${String(point?.signal)}。`);
    }
    if (spec && point?.direction !== spec.direction) {
      errors.push(`${label} 方向应为 ${spec.direction}，实际为 ${String(point?.direction)}。`);
    }
    if (spec && point?.safety !== spec.safety) {
      errors.push(`${label} 安全属性与规范表不一致，必须为 ${spec.safety ? '安全相关' : '非安全相关'}。`);
    }
    // address 键缺失不能被当成“未分配”通过：草案必须显式写 address: null。
    if (!point || !Object.prototype.hasOwnProperty.call(point, 'address')) {
      errors.push(`${label} 缺少 address 字段，必须显式写 null 表示待电气工程分配。`);
    } else if (point.address === null) errors.push(`${label} 尚未分配 PLC 地址。`);
    else errors.push(`${label} 不允许在草案中预填地址，必须经电气工程审核后另行生成。`);
    if (point?.safety === true) warnings.push(`${label} 为安全相关信号，必须接入独立安全回路。`);
  }

  for (const spec of BUFFER_IO_POINT_SPEC) {
    if (!seenIds.has(spec.id)) errors.push(`缺少规范逻辑点：${spec.id}（${spec.signal}）。`);
  }

  return { ok: errors.length === 0, executable: false, errors, warnings };
}

/** Stable logical IO names only; null addresses must be assigned during hardware engineering. */
export function buildBufferIoMapDraft(config: BufferTowerConfig): BufferIoMapDraft {
  if (!config || (config.towerCount !== 1 && config.towerCount !== 2)) {
    throw new RangeError('缓存塔配置无效，无法生成 IO 草案：towerCount 必须为 1 或 2。');
  }
  if (!Number.isSafeInteger(config.slotsPerTower) || config.slotsPerTower < 1) {
    throw new RangeError('缓存塔配置无效，无法生成 IO 草案：slotsPerTower 必须为正整数。');
  }
  if (config.towerCount * config.slotsPerTower > MAX_BUFFER_SLOTS) {
    throw new RangeError(`缓存塔配置无效，无法生成 IO 草案：槽位总数 ${config.towerCount * config.slotsPerTower} 不得超过 ${MAX_BUFFER_SLOTS}。`);
  }
  const points: BufferIoPointDraft[] = BUFFER_IO_POINT_SPEC.map((spec) => ({
    id: spec.id, name: spec.name, direction: spec.direction, signal: spec.signal, address: null, safety: spec.safety
  }));
  return { schemaVersion: 1, points, warnings: ['逻辑点位草案未分配 PLC 地址；安全故障点不得由普通 DI 替代安全回路。'] };
}
