export type BufferTowerId = 'A' | 'B';

export interface BufferTowerConfig {
  towerCount: 1 | 2;
  slotsPerTower: number;
}

export interface BufferSlot {
  tower: BufferTowerId;
  level: number;
  occupied: boolean;
  itemId: string | null;
}

export interface BufferQueueState {
  queue: string[];
  slots: BufferSlot[];
  nextTower: BufferTowerId;
}

export type BufferQueueResult =
  | { ok: true; itemId: string; slot: BufferSlot; state: BufferQueueState }
  | { ok: false; reason: 'FULL' | 'EMPTY'; state: BufferQueueState };

/** 单台缓存机的逻辑槽位总数上限；只为拦住明显失控的入参，不代表机械可实现容量。 */
export const MAX_BUFFER_SLOTS = 512;

function assertConfig(config: BufferTowerConfig): void {
  if (!config || (config.towerCount !== 1 && config.towerCount !== 2)) throw new RangeError('towerCount 必须为 1 或 2。');
  if (!Number.isSafeInteger(config.slotsPerTower) || config.slotsPerTower <= 0) throw new RangeError('slotsPerTower 必须为正整数。');
  const total = config.towerCount * config.slotsPerTower;
  if (!Number.isSafeInteger(total) || total > MAX_BUFFER_SLOTS) {
    throw new RangeError(`缓存槽位总数不得超过 ${MAX_BUFFER_SLOTS}。`);
  }
}

function towerIds(state: BufferQueueState): Set<BufferTowerId> {
  return new Set(state.slots.map((slot) => slot.tower));
}

/** 下一件应落位的塔；单塔时恒为该塔，不再返回不存在的 'B'。 */
function nextTowerAfter(state: BufferQueueState, usedTower: BufferTowerId): BufferTowerId {
  const other: BufferTowerId = usedTower === 'A' ? 'B' : 'A';
  return towerIds(state).has(other) ? other : usedTower;
}

function cloneState(state: BufferQueueState): BufferQueueState {
  return { queue: [...state.queue], slots: state.slots.map((slot) => ({ ...slot })), nextTower: state.nextTower };
}

export function createBufferQueue(config: BufferTowerConfig): BufferQueueState {
  assertConfig(config);
  const towers: BufferTowerId[] = config.towerCount === 2 ? ['A', 'B'] : ['A'];
  return {
    queue: [],
    nextTower: 'A',
    slots: towers.flatMap((tower) => Array.from({ length: config.slotsPerTower }, (_, index) => ({
      tower, level: index + 1, occupied: false, itemId: null
    })))
  };
}

function availableSlot(state: BufferQueueState): BufferSlot | null {
  const towerOrder: BufferTowerId[] = state.nextTower === 'A' ? ['A', 'B'] : ['B', 'A'];
  for (const tower of towerOrder) {
    const slot = state.slots.find((candidate) => candidate.tower === tower && !candidate.occupied);
    if (slot) return slot;
  }
  return null;
}

export function enqueueBufferItem(state: BufferQueueState, itemId: string): BufferQueueResult {
  if (typeof itemId !== 'string' || itemId.trim() === '') throw new RangeError('itemId 必须为非空字符串。');
  if (state.queue.includes(itemId)) throw new RangeError(`itemId 重复：${itemId}`);
  const next = cloneState(state);
  const slot = availableSlot(next);
  if (!slot) return { ok: false, reason: 'FULL', state: next };
  slot.occupied = true;
  slot.itemId = itemId;
  next.queue.push(itemId);
  next.nextTower = nextTowerAfter(next, slot.tower);
  return { ok: true, itemId, slot: { ...slot }, state: next };
}

export function dequeueBufferItem(state: BufferQueueState): BufferQueueResult {
  const next = cloneState(state);
  const itemId = next.queue.shift();
  if (itemId === undefined) return { ok: false, reason: 'EMPTY', state: next };
  const slot = next.slots.find((candidate) => candidate.itemId === itemId);
  if (!slot) throw new Error(`队列与槽位状态不一致：${itemId}`);
  slot.occupied = false;
  slot.itemId = null;
  next.nextTower = slot.tower;
  return { ok: true, itemId, slot: { ...slot }, state: next };
}

/**
 * 按件号移除一件并释放它占用的槽位。
 * 只用于转移结果对账（confirmed）：调用方必须先确认该件真的离开了缓存机。
 * 件号不在队列或槽位与队列不一致时抛 RangeError/Error，不静默修补。
 */
export function removeBufferItem(state: BufferQueueState, itemId: string): BufferQueueState {
  if (typeof itemId !== 'string' || itemId.trim() === '') throw new RangeError('itemId 必须为非空字符串。');
  if (!Array.isArray(state?.queue) || !Array.isArray(state?.slots)) throw new RangeError('缓存队列状态无效。');
  if (!state.queue.includes(itemId)) throw new RangeError(`队列中不存在件号：${itemId}`);
  const next = cloneState(state);
  next.queue.splice(next.queue.indexOf(itemId), 1);
  const slot = next.slots.find((candidate) => candidate.itemId === itemId);
  if (!slot) throw new Error(`队列与槽位状态不一致：${itemId}`);
  slot.occupied = false;
  slot.itemId = null;
  next.nextTower = slot.tower;
  return next;
}

export function bufferQueueIo(state: BufferQueueState): {
  full: boolean; empty: boolean; occupied: number; free: number; nextTower: BufferTowerId;
} {
  const occupied = state.slots.filter((slot) => slot.occupied).length;
  return { full: occupied === state.slots.length, empty: occupied === 0, occupied, free: state.slots.length - occupied, nextTower: state.nextTower };
}
