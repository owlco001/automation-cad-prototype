import type { BufferQueueState, BufferSlot } from './buffer-tower.ts';
import { bufferQueueIo, dequeueBufferItem, enqueueBufferItem, removeBufferItem } from './buffer-tower.ts';

export type BufferControlMode = 'READY' | 'REQUEST' | 'TRANSFER' | 'BACKPRESSURE' | 'FAULT_OVER';

export interface BufferControlInput {
  queue: BufferQueueState;
  upstreamReady: boolean;
  downstreamReady: boolean;
  transferDone: boolean;
  fault: boolean;
}

export interface BufferControlState {
  mode: BufferControlMode;
  upstreamPermit: boolean;
  downstreamPermit: boolean;
  full: boolean;
  empty: boolean;
  reason: string;
}

/**
 * 单帧电平映射（兼容契约，保持不变）。
 * 纯只读判断：不驱动 PLC 输出、不改队列、无状态记忆。
 * 它不表达故障锁存、转移超时、TransferDone 幂等与单执行器仲裁，
 * 需要事件序列时请使用 `stepBufferControl`。
 */
export function evaluateBufferControl(input: BufferControlInput): BufferControlState {
  if (!input || !input.queue) throw new RangeError('必须提供缓存队列状态。');
  const io = bufferQueueIo(input.queue);
  if (input.fault) return { mode: 'FAULT_OVER', upstreamPermit: false, downstreamPermit: false, full: io.full, empty: io.empty, reason: '缓存故障，停止进出料并等待人工复位。' };
  if (io.full) return { mode: 'BACKPRESSURE', upstreamPermit: false, downstreamPermit: input.downstreamReady && !io.empty, full: true, empty: false, reason: '缓存已满，向上游施加背压。' };
  if (input.downstreamReady && !io.empty) {
    if (!input.transferDone) return { mode: 'TRANSFER', upstreamPermit: input.upstreamReady, downstreamPermit: true, full: false, empty: false, reason: '下游已就绪，等待本次转移完成。' };
    return { mode: 'REQUEST', upstreamPermit: input.upstreamReady, downstreamPermit: true, full: false, empty: false, reason: '转移完成，可请求下一件。' };
  }
  if (io.empty) return { mode: 'READY', upstreamPermit: input.upstreamReady, downstreamPermit: false, full: false, empty: true, reason: '缓存为空，仅允许上游在就绪时入料。' };
  return { mode: 'REQUEST', upstreamPermit: input.upstreamReady, downstreamPermit: false, full: false, empty: false, reason: '等待下游就绪。' };
}

/**
 * 事件名语义固定：
 * - `CONTENTION_*` 的事件名表示“获得唯一执行权”的一侧，只在两侧**都真的要做动作**时产生
 *   （下游有料可出、上游有来料要入），不代表另一侧被禁止请求。
 * - `TRANSFER_DONE_IGNORED` 覆盖重复/回退的完成计数、故障锁存期间的完成脉冲，
 *   以及电平语义下没有在途转移的完成。
 * - `TRANSFER_DONE_UNSOLICITED` 表示没有本层发起的转移却收到完成信号：不消费队列，但消费该计数。
 * - `ITEM_REJECTED_FULL` / `ITEM_REJECTED_BUSY` / `ITEM_REJECTED_UPSTREAM_NOT_READY` / `ITEM_REJECTED_DUPLICATE`
 *   区分“缓存已满”“执行器被出料占用”“上游未就绪”“件号与在库件重复”。
 * - `ITEM_STATE_UNKNOWN` 表示转移被打断且件状态未知：队列不变、不自动重发，必须显式 `reconcile`。
 * - `RECONCILE_REQUIRED` 表示存在未对账件时复位被拒（复位不会静默解除未知状态）。
 * - `TRANSFER_SEQ_GAP` 表示完成计数**跳号**（`seq > seen + 1`）：本次完成被**拒绝**，
 *   既不销账也不推进计数；必须核对 PLC 计数后用 `transferSeqRebase` 显式重基（只允许下抬）。
 *   陈旧序号（重基后被重新打开的旧计数）走的就是这一条，不允许静默少算一件。
 * - `TRANSFER_SEQ_REBASED` / `TRANSFER_SEQ_REBASE_BLOCKED` 为完成计数的显式安全重基。
 */
export type BufferControlEvent =
  | 'FAULT_LATCHED'
  | 'FAULT_CLEARED'
  | 'FAULT_RESET_BLOCKED'
  | 'RECONCILE_REQUIRED'
  | 'RECONCILE_IGNORED'
  | 'ITEM_STATE_UNKNOWN'
  | 'ITEM_RECONCILED_CONFIRMED'
  | 'ITEM_RECONCILED_ABORTED'
  | 'TRANSFER_SEQ_REBASED'
  | 'TRANSFER_SEQ_REBASE_BLOCKED'
  | 'TRANSFER_STARTED'
  | 'TRANSFER_TIMEOUT'
  | 'TRANSFER_DONE_ACCEPTED'
  | 'TRANSFER_DONE_IGNORED'
  | 'TRANSFER_DONE_UNSOLICITED'
  | 'TRANSFER_SEQ_GAP'
  | 'CONTENTION_UPSTREAM'
  | 'CONTENTION_DOWNSTREAM'
  | 'ITEM_ACCEPTED'
  | 'ITEM_REJECTED_FULL'
  | 'ITEM_REJECTED_BUSY'
  | 'ITEM_REJECTED_UPSTREAM_NOT_READY'
  | 'ITEM_REJECTED_DUPLICATE';

export type BufferControlFaultCode = 'NONE' | 'FAULT_OVER' | 'TRANSFER_TIMEOUT';

/** 未知件（转移被打断）的来源；与 `unreconciledItemId` 同时出现或同时为空。 */
export type BufferUnreconciledReason = 'FAULT' | 'TRANSFER_TIMEOUT';

/**
 * 跨调用记忆。只保存纯数据，不保存定时器、句柄或设备状态。
 * `transferSeqSeen` 为已消费的完成计数；`0` 表示尚未见过任何完成。
 * `unreconciledItemId` 记录“转移被打断、件在不在缓存机里未知”的件：
 * 必须显式 `reconcile: 'confirmed' | 'aborted'` 才能清除；复位不会自动清除。
 */
export interface BufferControlMemory {
  faultLatched: boolean;
  faultCode: BufferControlFaultCode;
  transferSeqSeen: number;
  transferActive: boolean;
  transferStartedAtSec: number | null;
  transferItemId: string | null;
  unreconciledItemId: string | null;
  unreconciledReason: BufferUnreconciledReason | null;
  prevReset: boolean;
  prevTransferDone: boolean;
  lastStepSec: number | null;
  contention: 'upstream' | 'downstream' | null;
}

export interface BufferControlStepInput extends BufferControlInput {
  /** 人工复位按钮；只有上升沿生效，且存在未对账件时会被拒。 */
  reset: boolean;
  /** 调用方提供的单调时钟（秒），回退即报错。 */
  nowSec: number;
  /** 转移允许时间（秒），必须大于零。 */
  transferTimeoutSec: number;
  /** PLC/上位机侧完成计数；给出时按严格递增判幂等，缺省退化为上升沿。 */
  transferSeq?: number;
  /** 上游来料件号；本层只在仲裁允许时入队，不连接真实输送。 */
  incomingItemId?: string;
  /**
   * 完成信号语义。`edge`（缺省）= 上升沿，“高电平不能重复代表新完成”；
   * `level` = Done 电平常高（完成由 PLC 保持），每个在途转移只接受一次。
   * `level` 必须由调用方显式声明：它是对现场握手方式的断言，不是默认放宽。
   */
  transferDoneMode?: 'edge' | 'level';
  /**
   * 显式把完成计数**下抬**（PLC 重启 / 计数归零后使用），只允许 `<= transferSeqSeen`。
   * 前置条件（全部为真才生效，否则记 `TRANSFER_SEQ_REBASE_BLOCKED`）：无锁存故障、无在途转移、
   * `transferDone` 为低，且**现场已确认** PLC 侧计数已归零/已按目标值同步、上一轮已完成脉冲已排空。
   * 不允许上抬（`> transferSeqSeen`）：那会把陈旧完成序号重新变成“可接受”，
   * 从而把一件没有真实完成的料从逻辑队列里销掉（少算）。
   * 本函数不会因为看到“回退的序号”就自动重基或自动吞掉重放。
   */
  transferSeqRebase?: number;
  /**
   * 未知件对账（人工确认后的显式动作）：
   * - `confirmed`：件已离开缓存机 → 出队并释放槽位；
   * - `aborted`：件未离开缓存机 → 留队，允许后续按正常流程重新发起转移。
   * 没有未对账件时给出该参数只记 `RECONCILE_IGNORED`，不改队列。
   */
  reconcile?: 'confirmed' | 'aborted';
}

export interface BufferControlStepState extends BufferControlState {
  faultLatched: boolean;
  faultCode: BufferControlFaultCode;
  transferActive: boolean;
  transferItemId: string | null;
  transferElapsedSec: number | null;
  transferSeqSeen: number;
  contention: 'upstream' | 'downstream' | null;
  stepSec: number;
  /** 本步内唯一执行器实际做的事：出料、进料或空闲。 */
  actuator: 'idle' | 'intake' | 'discharge';
  /**
   * 本拍是否因「刚复位/刚对账/刚重基」而冻结出料仲裁。
   * 为 true 时本拍不会发起转移（进料仍按正常规则判定），下一个扫描周期才允许重新发起。
   */
  arbitrationHeld: boolean;
  /** 转移被打断后状态未知、尚未对账的件号；复位不会清空它。 */
  unreconciledItemId: string | null;
  unreconciledReason: BufferUnreconciledReason | null;
  /** 是否必须显式对账后才能复位恢复。 */
  reconcileRequired: boolean;
  /** 本步使用的完成信号语义。 */
  transferDoneMode: 'edge' | 'level';
}

export interface BufferControlStepResult {
  state: BufferControlStepState;
  memory: BufferControlMemory;
  queue: BufferQueueState;
  events: BufferControlEvent[];
}

export function createBufferControlMemory(): BufferControlMemory {
  return {
    faultLatched: false,
    faultCode: 'NONE',
    transferSeqSeen: 0,
    transferActive: false,
    transferStartedAtSec: null,
    transferItemId: null,
    unreconciledItemId: null,
    unreconciledReason: null,
    prevReset: false,
    prevTransferDone: false,
    lastStepSec: null,
    contention: null
  };
}

const FAULT_CODES: readonly BufferControlFaultCode[] = ['NONE', 'FAULT_OVER', 'TRANSFER_TIMEOUT'];
const UNRECONCILED_REASONS: readonly BufferUnreconciledReason[] = ['FAULT', 'TRANSFER_TIMEOUT'];

/**
 * 记忆是明文纯数据、设计上可持久化，因此必须逐字段校验而不是“抽查 4 个字段”。
 * 只有本轮新增的 `unreconciled*` 字段允许缺省（按 null 归一，兼容旧快照）；
 * 其它字段一旦缺失或自相矛盾就抛 RangeError，绝不让 `transferActive:true` 却无开始时间的记忆
 * 悄悄进入“永不超时”的状态。
 */
function normalizeMemory(memory: BufferControlMemory): BufferControlMemory {
  if (!memory || typeof memory !== 'object') throw new RangeError('必须提供缓存控制记忆。');
  const normalized: BufferControlMemory = {
    ...memory,
    unreconciledItemId: memory.unreconciledItemId ?? null,
    unreconciledReason: memory.unreconciledReason ?? null
  };
  if (typeof normalized.faultLatched !== 'boolean' || typeof normalized.transferActive !== 'boolean'
    || typeof normalized.prevReset !== 'boolean' || typeof normalized.prevTransferDone !== 'boolean') {
    throw new RangeError('缓存控制记忆字段无效：布尔字段必须为布尔值。');
  }
  if (!FAULT_CODES.includes(normalized.faultCode)) {
    throw new RangeError(`缓存控制记忆的 faultCode 无效：${String(normalized.faultCode)}。`);
  }
  if (normalized.faultLatched !== (normalized.faultCode !== 'NONE')) {
    throw new RangeError('缓存控制记忆自相矛盾：faultLatched 与 faultCode 必须同时成立。');
  }
  if (!Number.isSafeInteger(normalized.transferSeqSeen) || normalized.transferSeqSeen < 0) {
    throw new RangeError('transferSeqSeen 必须是非负安全整数。');
  }
  if (normalized.lastStepSec !== null && (typeof normalized.lastStepSec !== 'number' || !Number.isFinite(normalized.lastStepSec))) {
    throw new RangeError('lastStepSec 必须为有限秒数或 null。');
  }
  if (normalized.contention !== null && normalized.contention !== 'upstream' && normalized.contention !== 'downstream') {
    throw new RangeError('contention 必须为 upstream / downstream / null。');
  }
  const started = normalized.transferStartedAtSec;
  const itemId = normalized.transferItemId;
  if (started !== null && (typeof started !== 'number' || !Number.isFinite(started))) {
    throw new RangeError('transferStartedAtSec 必须为有限秒数或 null。');
  }
  if (itemId !== null && (typeof itemId !== 'string' || itemId.trim() === '')) {
    throw new RangeError('transferItemId 必须为非空字符串或 null。');
  }
  if (normalized.transferActive !== (started !== null) || normalized.transferActive !== (itemId !== null)) {
    throw new RangeError('缓存控制记忆自相矛盾：transferActive 必须与 transferStartedAtSec、transferItemId 同时成立。');
  }
  const unreconciledId = normalized.unreconciledItemId;
  if (unreconciledId !== null && (typeof unreconciledId !== 'string' || unreconciledId.trim() === '')) {
    throw new RangeError('unreconciledItemId 必须为非空字符串或 null。');
  }
  if (normalized.unreconciledReason !== null && !UNRECONCILED_REASONS.includes(normalized.unreconciledReason)) {
    throw new RangeError(`unreconciledReason 无效：${String(normalized.unreconciledReason)}。`);
  }
  if ((unreconciledId === null) !== (normalized.unreconciledReason === null)) {
    throw new RangeError('unreconciledItemId 与 unreconciledReason 必须同时存在或同时为空。');
  }
  return normalized;
}

/**
 * 队列形状校验：`bufferQueueIo` 只看 occupied 计数，畸形队列会表现为
 * “full 且 empty”或永久背压，而不是报错。这里把纯数据结构的不变量讲清楚：
 * 队列件号非空且不重复、槽位字段完整、占用槽位与队列一一对应、nextTower 指向存在的塔。
 */
function assertQueueShape(queue: BufferQueueState): void {
  if (!queue || typeof queue !== 'object') throw new RangeError('必须提供缓存队列状态。');
  if (!Array.isArray(queue.queue) || !Array.isArray(queue.slots)) {
    throw new RangeError('缓存队列状态无效：queue 与 slots 必须为数组。');
  }
  if (queue.slots.length === 0) throw new RangeError('缓存队列状态无效：slots 不能为空。');
  if (queue.nextTower !== 'A' && queue.nextTower !== 'B') {
    throw new RangeError('缓存队列状态无效：nextTower 必须为 A 或 B。');
  }
  const queued = new Set<string>();
  for (const id of queue.queue) {
    if (typeof id !== 'string' || id.trim() === '') throw new RangeError('缓存队列状态无效：队列件号必须为非空字符串。');
    if (queued.has(id)) throw new RangeError(`缓存队列状态无效：队列件号重复（${id}）。`);
    queued.add(id);
  }
  const towers = new Set<string>();
  const slotIds = new Set<string>();
  const levels = new Set<string>();
  let occupied = 0;
  for (const slot of queue.slots as BufferSlot[]) {
    if (!slot || typeof slot !== 'object' || (slot.tower !== 'A' && slot.tower !== 'B')
      || !Number.isSafeInteger(slot.level) || slot.level < 1 || typeof slot.occupied !== 'boolean') {
      throw new RangeError('缓存队列状态无效：槽位字段不完整（tower/level/occupied）。');
    }
    const levelKey = `${slot.tower}${slot.level}`;
    if (levels.has(levelKey)) throw new RangeError(`缓存队列状态无效：槽位重复（${levelKey}）。`);
    levels.add(levelKey);
    towers.add(slot.tower);
    if (slot.occupied) {
      occupied += 1;
      if (typeof slot.itemId !== 'string' || slot.itemId.trim() === '') {
        throw new RangeError(`缓存队列状态无效：占用槽位 ${levelKey} 缺少件号。`);
      }
      if (!queued.has(slot.itemId)) throw new RangeError(`缓存队列状态无效：槽位件号 ${slot.itemId} 不在队列中。`);
      if (slotIds.has(slot.itemId)) throw new RangeError(`缓存队列状态无效：槽位件号重复（${slot.itemId}）。`);
      slotIds.add(slot.itemId);
    } else if (slot.itemId !== null) {
      throw new RangeError(`缓存队列状态无效：未占用槽位 ${levelKey} 不得带件号。`);
    }
  }
  if (!towers.has(queue.nextTower)) {
    throw new RangeError(`缓存队列状态无效：nextTower 指向不存在的塔（${queue.nextTower}）。`);
  }
  if (occupied !== queue.queue.length) {
    throw new RangeError(`缓存队列状态无效：队列件数 ${queue.queue.length} 与占用槽位 ${occupied} 不一致。`);
  }
}

function assertStepInput(input: BufferControlStepInput, memory: BufferControlMemory): void {
  if (!input || typeof input !== 'object' || !input.queue) throw new RangeError('必须提供缓存队列状态。');
  assertQueueShape(input.queue);
  for (const name of ['upstreamReady', 'downstreamReady', 'transferDone', 'fault', 'reset'] as const) {
    if (typeof input[name] !== 'boolean') throw new RangeError(`${name} 必须为布尔值。`);
  }
  if (typeof input.nowSec !== 'number' || !Number.isFinite(input.nowSec)) {
    throw new RangeError('nowSec 必须是有限秒数。');
  }
  if (typeof input.transferTimeoutSec !== 'number' || !Number.isFinite(input.transferTimeoutSec) || input.transferTimeoutSec <= 0) {
    throw new RangeError('transferTimeoutSec 必须是大于零的有限秒数。');
  }
  if (memory.lastStepSec !== null && input.nowSec < memory.lastStepSec) {
    throw new RangeError(`nowSec 必须单调不减：上一步 ${memory.lastStepSec}，当前 ${input.nowSec}。`);
  }
  if (input.transferSeq !== undefined && (!Number.isSafeInteger(input.transferSeq) || input.transferSeq < 0)) {
    throw new RangeError('transferSeq 必须是非负安全整数。');
  }
  if (input.transferSeqRebase !== undefined && (!Number.isSafeInteger(input.transferSeqRebase) || input.transferSeqRebase < 0)) {
    throw new RangeError('transferSeqRebase 必须是非负安全整数。');
  }
  if (input.incomingItemId !== undefined && (typeof input.incomingItemId !== 'string' || input.incomingItemId.trim() === '')) {
    throw new RangeError('incomingItemId 必须为非空字符串。');
  }
  if (input.transferDoneMode !== undefined && input.transferDoneMode !== 'edge' && input.transferDoneMode !== 'level') {
    throw new RangeError('transferDoneMode 必须为 edge 或 level。');
  }
  if (input.reconcile !== undefined && input.reconcile !== 'confirmed' && input.reconcile !== 'aborted') {
    throw new RangeError('reconcile 必须为 confirmed 或 aborted。');
  }
  if (memory.unreconciledItemId !== null && !input.queue.queue.includes(memory.unreconciledItemId)) {
    throw new RangeError(`未对账件 ${memory.unreconciledItemId} 不在队列中：记忆与队列不一致，不能自动对账。`);
  }
  if (memory.transferActive && memory.transferItemId !== null && !input.queue.queue.includes(memory.transferItemId)) {
    throw new RangeError(`在途转移件 ${memory.transferItemId} 不在队列中：记忆与队列不一致。`);
  }
}

/**
 * 消费完成计数：**严格 +1**，这是除显式重基外唯一推进 `transferSeqSeen` 的路径。
 * - `seq === seen + 1`：接受并推进，返回 true；
 * - `seq <= seen`：陈旧/重复，返回 false（调用方按 `TRANSFER_DONE_IGNORED` 处理，不改计数）；
 * - `seq > seen + 1`：跳号，记 `TRANSFER_SEQ_GAP` 并**拒绝**（不销账、不推进、返回 false）。
 *
 * 为什么跳号必须拒绝而不是“接受并记个事件”：`transferSeqSeen` 是完成归属的唯一证据。
 * 重基（或对账 aborted 后重新发起）会让旧序号重新满足“大于 seen”，如果跳号也照单接受，
 * 一件**没有真实完成**的料就会被从逻辑队列里销掉（静默少算一件）。宁可拒绝并让人工核对，
 * 也不要用“记了事件”掩盖一次错误销账。
 */
function consumeSeq(next: BufferControlMemory, seq: number, events: BufferControlEvent[]): boolean {
  const delta = seq - next.transferSeqSeen;
  if (delta <= 0) return false;
  if (delta > 1) {
    events.push('TRANSFER_SEQ_GAP');
    return false;
  }
  next.transferSeqSeen = seq;
  return true;
}

/**
 * 纯数据单步状态机：一次调用 = 一个扫描周期。
 * 规则（与 `evaluateBufferControl` 并存，互不替代）：
 * 1. 故障只锁存；故障信号回落不清除，必须 `reset` 上升沿且 `fault=false` 才清除。
 * 2. 转移超过 `transferTimeoutSec` 立刻锁存 `TRANSFER_TIMEOUT`，迟到的完成脉冲不得消费队列。
 * 3. 转移被故障/超时打断时，`unreconciledItemId` 记录状态未知的件：队列不动、不自动重发，
 *    复位被 `RECONCILE_REQUIRED` 拒绝，直到显式 `reconcile`。
 * 4. `transferDone` 按序列号**严格 +1** 幂等（跳号拒绝、不销账，见 `consumeSeq`）；无序列号时缺省用
 *    上升沿，`transferDoneMode:'level'` 为显式电平语义（每个在途转移只接受一次）；未发起的完成只记事件、不动队列。
 * 5. 故障锁存期间收到的完成**不消费**计数，避免复位后把真实重放静默吞掉。
 * 6. 计数的复位（PLC 重启）只能通过 `transferSeqRebase` 显式安全重基，且只允许下抬到 `<= seen`。
 * 7. 单执行器：同一周期内上游进料与下游出料互斥，同时请求时下游（已有料可转）优先；
 *    争用事件只在两侧都真的有动作请求时产生。
 * 8. **复位/对账/重基当拍不启动转移**：这三类人工动作之后至少空一个扫描周期再发起出料
 *    （`arbitrationHeld=true`），给监督与联锁留一拍；进料仍按正常规则判定，不吞来料。
 * 9. 本步返回新记忆与新队列，入参对象不被修改；时间回退、非法超时、非法计数、畸形队列一律抛 RangeError。
 * 本函数不写任何 IO、不连接设备、不代表已实现 PLC 程序或安全回路。
 */
export function stepBufferControl(memory: BufferControlMemory, input: BufferControlStepInput): BufferControlStepResult {
  const base = normalizeMemory(memory);
  assertStepInput(input, base);

  const events: BufferControlEvent[] = [];
  const next: BufferControlMemory = { ...base, lastStepSec: input.nowSec };
  const transferDoneMode: 'edge' | 'level' = input.transferDoneMode ?? 'edge';
  let queue = input.queue;
  let actuator: BufferControlStepState['actuator'] = 'idle';
  /** 本拍刚复位/对账/重基 → 冻结出料仲裁一拍，不允许同一扫描周期重新发起转移（N1）。 */
  let arbitrationHeld = false;
  /** 对账这一步已经按归属处理过本拍的完成序号，主完成判定不再重复消费/记事件。 */
  let reconcileTookSeq = false;

  const resetEdge = input.reset && !base.prevReset;
  next.prevReset = input.reset;

  // 1. 故障输入只锁存，不清除；锁存瞬间进行中的转移变成“件状态未知”。
  if (input.fault && !next.faultLatched) {
    next.faultLatched = true;
    next.faultCode = 'FAULT_OVER';
    events.push('FAULT_LATCHED');
    if (next.transferActive && next.transferItemId !== null) {
      next.unreconciledItemId = next.transferItemId;
      next.unreconciledReason = 'FAULT';
      events.push('ITEM_STATE_UNKNOWN');
    }
    next.transferActive = false;
    next.transferStartedAtSec = null;
    next.transferItemId = null;
  }

  // 2. 超时判定在完成判定之前：超时优先，同一周期迟到的完成不得消费队列。
  if (!next.faultLatched && next.transferActive && next.transferStartedAtSec !== null
    && input.nowSec - next.transferStartedAtSec >= input.transferTimeoutSec) {
    next.faultLatched = true;
    next.faultCode = 'TRANSFER_TIMEOUT';
    events.push('TRANSFER_TIMEOUT');
    events.push('FAULT_LATCHED');
    if (next.transferItemId !== null) {
      next.unreconciledItemId = next.transferItemId;
      next.unreconciledReason = 'TRANSFER_TIMEOUT';
      events.push('ITEM_STATE_UNKNOWN');
    }
    next.transferActive = false;
    next.transferStartedAtSec = null;
    next.transferItemId = null;
  }

  // 3. 未知件对账：只有显式 confirmed/aborted 才能清掉这条记录。
  if (input.reconcile !== undefined) {
    if (next.unreconciledItemId === null) {
      events.push('RECONCILE_IGNORED');
    } else {
      if (input.reconcile === 'confirmed') {
        queue = removeBufferItem(queue, next.unreconciledItemId);
        events.push('ITEM_RECONCILED_CONFIRMED');
      } else {
        events.push('ITEM_RECONCILED_ABORTED');
      }
      // 对账时仍然可见的完成脉冲归属这次被打断的转移：走与正常完成**同一**口径（严格 +1 的
      // `consumeSeq`），避免它再被算到下一次转移上。对账不再直接赋值 `transferSeqSeen`（N6）：
      // 跳号同样记 `TRANSFER_SEQ_GAP` 并拒绝消费，否则这里就成了绕过跳号检查的后门。
      if (input.transferDone && input.transferSeq !== undefined) {
        reconcileTookSeq = true;
        consumeSeq(next, input.transferSeq, events);
      }
      next.unreconciledItemId = null;
      next.unreconciledReason = null;
      // 对账当拍不启动转移（N1）：人工确认之后至少空一个扫描周期。
      arbitrationHeld = true;
    }
  }

  // 4. 人工复位：上升沿且故障输入已消失才清除；有未对账件时明确拒绝，不静默解除未知状态。
  if (resetEdge) {
    if (input.fault) events.push('FAULT_RESET_BLOCKED');
    else if (next.faultLatched && next.unreconciledItemId !== null) events.push('RECONCILE_REQUIRED');
    else if (next.faultLatched) {
      next.faultLatched = false;
      next.faultCode = 'NONE';
      events.push('FAULT_CLEARED');
      // 复位当拍不启动转移（N1）：同一个报文里给“复位 + 下游就绪”时不再本拍就动。
      arbitrationHeld = true;
    }
  }

  // 5. 完成计数的显式安全重基：无故障、无在途转移、Done 为低、且只允许下抬到 <= seen。
  if (input.transferSeqRebase !== undefined) {
    if (next.faultLatched || next.transferActive || input.transferDone) {
      events.push('TRANSFER_SEQ_REBASE_BLOCKED');
    } else if (input.transferSeqRebase > next.transferSeqSeen) {
      // 上抬重基会把陈旧完成序号重新变成“可接受”（陈旧 seq 会销掉一件没完成的料），一律拒绝。
      events.push('TRANSFER_SEQ_REBASE_BLOCKED');
    } else if (next.transferSeqSeen !== input.transferSeqRebase) {
      next.transferSeqSeen = input.transferSeqRebase;
      events.push('TRANSFER_SEQ_REBASED');
      // 重基当拍不启动转移（N1）：计数前提刚被人工确认，先空一拍。
      arbitrationHeld = true;
    }
  }

  // 6. TransferDone 幂等与一次性消费：带序号时只接受严格 +1，跳号与陈旧序号一律拒绝。
  if (input.transferDone) {
    let fresh = false;
    if (input.transferSeq === undefined) {
      // 无序号：电平语义恒为“新完成”（由 transferActive 守卫成每个在途只一次），边沿语义看上升沿。
      fresh = transferDoneMode === 'level' || !base.prevTransferDone;
    } else if (!reconcileTookSeq) {
      // 本拍的序号已在第 3 步按“被打断转移的迟到完成”归属并消费过，这里不再算新完成。
      const delta = input.transferSeq - next.transferSeqSeen;
      if (delta > 1) events.push('TRANSFER_SEQ_GAP');
      else fresh = delta === 1;
    }
    if (!fresh || next.faultLatched) {
      // 重复/回退/跳号，或故障锁存期间：都不动队列（跳号的 TRANSFER_SEQ_GAP 已先行记录）。
      events.push('TRANSFER_DONE_IGNORED');
    } else {
      if (input.transferSeq !== undefined) consumeSeq(next, input.transferSeq, events);
      if (!next.transferActive) events.push('TRANSFER_DONE_UNSOLICITED');
      else {
        const dequeued = dequeueBufferItem(queue);
        if (dequeued.ok) {
          queue = dequeued.state;
          events.push('TRANSFER_DONE_ACCEPTED');
        } else {
          events.push('TRANSFER_DONE_UNSOLICITED');
        }
        next.transferActive = false;
        next.transferStartedAtSec = null;
        next.transferItemId = null;
      }
    }
  }
  next.prevTransferDone = input.transferDone;

  let contention: 'upstream' | 'downstream' | null = null;

  if (!next.faultLatched) {
    // 7. 单执行器仲裁：出料占用执行器时不允许同周期进料。
    const ioAfterCompletion = bufferQueueIo(queue);
    // 本拍刚复位/对账/重基时把出料请求压掉一拍：既不发起转移，也不虚构“上游争用胜出”。
    const downstreamWants = !arbitrationHeld && input.downstreamReady && !ioAfterCompletion.empty;
    const upstreamWants = input.upstreamReady && !ioAfterCompletion.full && input.incomingItemId !== undefined;
    if (!next.transferActive && downstreamWants) {
      next.transferActive = true;
      next.transferStartedAtSec = input.nowSec;
      next.transferItemId = queue.queue[0] ?? null;
      events.push('TRANSFER_STARTED');
    }
    if (downstreamWants && upstreamWants) {
      // 下游优先：只要下游有料可出，单执行器就归下游，因此争用的胜者只可能是 downstream；
      // 保留 upstream 分支只为表达“两侧同时有动作请求”这一事实，不虚构执行权转移。
      contention = next.transferActive ? 'downstream' : 'upstream';
      events.push(contention === 'downstream' ? 'CONTENTION_DOWNSTREAM' : 'CONTENTION_UPSTREAM');
    }
    const upstreamGranted = !next.transferActive && !ioAfterCompletion.full && input.upstreamReady;
    if (input.incomingItemId !== undefined) {
      if (queue.queue.includes(input.incomingItemId)) {
        // 件号与在库件重复是调用方错误：给出明确拒绝事件，不让 RangeError 穿透扫描周期。
        events.push('ITEM_REJECTED_DUPLICATE');
      } else if (upstreamGranted) {
        const enqueued = enqueueBufferItem(queue, input.incomingItemId);
        if (enqueued.ok) {
          queue = enqueued.state;
          actuator = 'intake';
          events.push('ITEM_ACCEPTED');
        } else {
          events.push('ITEM_REJECTED_FULL');
        }
      } else if (next.transferActive) {
        events.push('ITEM_REJECTED_BUSY');
      } else if (ioAfterCompletion.full) {
        events.push('ITEM_REJECTED_FULL');
      } else {
        events.push('ITEM_REJECTED_UPSTREAM_NOT_READY');
      }
    }
  }

  const io = bufferQueueIo(queue);
  if (next.transferActive) actuator = 'discharge';
  next.contention = contention;

  // 满料且正在出料时 mode 仍是 TRANSFER（执行器被占用是当下事实），
  // 背压由 full 单独表达，避免 BACKPRESSURE 掩盖“正在出料”这一帧。
  const mode: BufferControlMode = next.faultLatched ? 'FAULT_OVER'
    : next.transferActive ? 'TRANSFER'
      : io.full ? 'BACKPRESSURE'
        : io.empty ? 'READY'
          : 'REQUEST';
  const reason = next.faultLatched
    ? next.unreconciledItemId !== null
      ? '转移被打断且件状态未知：必须显式对账（confirmed/aborted）后才能复位恢复。'
      : next.faultCode === 'TRANSFER_TIMEOUT'
        ? '转移超时已锁存故障；必须人工复位后重新发起转移。'
        : '缓存故障已锁存；故障信号消失不会自动恢复，必须人工复位。'
    : arbitrationHeld ? '本拍刚完成复位/对账/重基：出料至少延后一个扫描周期再发起。'
      : mode === 'TRANSFER' ? (io.full
      ? '缓存已满且正在出料：上游继续背压，执行器由下游占用。'
      : '单一转移执行器已占用，本周期仅允许下游出料。')
      : mode === 'BACKPRESSURE' ? '缓存已满，向上游施加背压，仍允许下游出料。'
        : mode === 'READY' ? '缓存为空，仅允许上游在就绪时入料。'
          : '缓存有待出料件，等待下游就绪。';

  const transferElapsedSec = next.transferActive && next.transferStartedAtSec !== null
    ? input.nowSec - next.transferStartedAtSec : null;

  return {
    state: {
      mode,
      upstreamPermit: !next.faultLatched && !next.transferActive && !io.full && input.upstreamReady,
      downstreamPermit: !next.faultLatched && next.transferActive,
      full: io.full,
      empty: io.empty,
      reason,
      faultLatched: next.faultLatched,
      faultCode: next.faultCode,
      transferActive: next.transferActive,
      transferItemId: next.transferItemId,
      transferElapsedSec,
      transferSeqSeen: next.transferSeqSeen,
      contention,
      stepSec: input.nowSec,
      actuator,
      arbitrationHeld,
      unreconciledItemId: next.unreconciledItemId,
      unreconciledReason: next.unreconciledReason,
      reconcileRequired: next.unreconciledItemId !== null,
      transferDoneMode
    },
    memory: next,
    queue,
    events
  };
}
