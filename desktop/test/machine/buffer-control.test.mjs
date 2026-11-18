import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createBufferControlMemory, evaluateBufferControl, stepBufferControl
} from '../../src/machine/buffer-control.ts';
import { bufferQueueIo, createBufferQueue, enqueueBufferItem } from '../../src/machine/buffer-tower.ts';

const queued = (count = 1) => {
  let queue = createBufferQueue({ towerCount: 1, slotsPerTower: 2 });
  for (let index = 0; index < count; index += 1) queue = enqueueBufferItem(queue, `p${index + 1}`).state;
  return queue;
};

const stepInput = (queue, over = {}) => ({
  queue, upstreamReady: false, downstreamReady: false, transferDone: false, fault: false,
  reset: false, nowSec: 0, transferTimeoutSec: 5, ...over
});

/** 逐步推进的小夹具：记忆与队列在用例内保持连续，和真实调用方一致。 */
const harness = (count = 0, slotsPerTower = 2) => {
  const context = { memory: createBufferControlMemory(), queue: queued(count), steps: [] };
  if (slotsPerTower !== 2) {
    let queue = createBufferQueue({ towerCount: 1, slotsPerTower });
    for (let index = 0; index < count; index += 1) queue = enqueueBufferItem(queue, `p${index + 1}`).state;
    context.queue = queue;
  }
  context.run = (over = {}) => {
    const result = stepBufferControl(context.memory, stepInput(context.queue, over));
    context.memory = result.memory;
    context.queue = result.queue;
    context.steps.push(result);
    return result;
  };
  return context;
};

test('空缓存且上游就绪进入 READY', () => {
  const result = evaluateBufferControl({ queue: queued(0), upstreamReady: true, downstreamReady: false, transferDone: false, fault: false });
  assert.equal(result.mode, 'READY');
  assert.equal(result.upstreamPermit, true);
  assert.equal(result.empty, true);
});

test('有料且下游就绪先 TRANSFER，完成后 REQUEST', () => {
  const queue = queued(1);
  assert.equal(evaluateBufferControl({ queue, upstreamReady: true, downstreamReady: true, transferDone: false, fault: false }).mode, 'TRANSFER');
  assert.equal(evaluateBufferControl({ queue, upstreamReady: true, downstreamReady: true, transferDone: true, fault: false }).mode, 'REQUEST');
});

test('满缓存施加背压，故障优先进入 FAULT_OVER', () => {
  const queue = queued(2);
  const full = evaluateBufferControl({ queue, upstreamReady: true, downstreamReady: false, transferDone: false, fault: false });
  assert.equal(full.mode, 'BACKPRESSURE');
  assert.equal(full.upstreamPermit, false);
  const fault = evaluateBufferControl({ queue, upstreamReady: true, downstreamReady: true, transferDone: true, fault: true });
  assert.equal(fault.mode, 'FAULT_OVER');
  assert.equal(fault.downstreamPermit, false);
});

test('兼容契约：evaluateBufferControl 仍是单帧双许可电平映射，step 层才做互斥', () => {
  const queue = queued(1);
  const quiet = evaluateBufferControl({ queue, upstreamReady: true, downstreamReady: true, transferDone: false, fault: false });
  assert.equal(quiet.mode, 'TRANSFER');
  // 单帧函数没有状态记忆，也不仲裁：两侧许可可同时为 true，这是既有契约，不在此改动。
  assert.equal(quiet.upstreamPermit, true);
  assert.equal(quiet.downstreamPermit, true);
  const strict = stepBufferControl(createBufferControlMemory(), stepInput(queue, { upstreamReady: true, downstreamReady: true, incomingItemId: 'p2', nowSec: 0 }));
  assert.equal(strict.state.upstreamPermit, false);
  assert.equal(strict.state.downstreamPermit, true);
  assert.equal(strict.state.contention, 'downstream');
});

test('step：故障只锁存，故障信号回落不自动恢复，人工复位上升沿才清除', () => {
  const h = harness(0);
  const latched = h.run({ fault: true, upstreamReady: true, downstreamReady: true });
  assert.equal(latched.state.mode, 'FAULT_OVER');
  assert.deepEqual(latched.events, ['FAULT_LATCHED']);
  assert.equal(latched.state.faultLatched, true);
  assert.equal(latched.state.faultCode, 'FAULT_OVER');
  assert.equal(latched.state.upstreamPermit, false);
  assert.equal(latched.state.downstreamPermit, false);

  const cleared = h.run({ fault: false, upstreamReady: true });
  assert.equal(cleared.state.mode, 'FAULT_OVER');
  assert.deepEqual(cleared.events, []);
  assert.equal(cleared.state.faultLatched, true, '故障信号回落不得自动解锁');

  const reset = h.run({ fault: false, reset: true, upstreamReady: true });
  assert.deepEqual(reset.events, ['FAULT_CLEARED']);
  assert.equal(reset.state.mode, 'READY');
  assert.equal(reset.state.faultCode, 'NONE');
  assert.equal(reset.state.upstreamPermit, true);

  const held = h.run({ fault: false, reset: true, upstreamReady: true });
  assert.deepEqual(held.events, [], '复位保持高电平不应重复触发清除');
});

test('step：故障仍在时按下复位被拒，且需要重新按下才能清除', () => {
  const h = harness(0);
  assert.deepEqual(h.run({ fault: true }).events, ['FAULT_LATCHED']);
  const blocked = h.run({ fault: true, reset: true });
  assert.deepEqual(blocked.events, ['FAULT_RESET_BLOCKED']);
  assert.equal(blocked.state.faultLatched, true);

  const heldAcross = h.run({ fault: false, reset: true });
  assert.deepEqual(heldAcross.events, [], '故障期间按下的边沿已在被拒时消费，不能延迟生效');
  assert.equal(heldAcross.state.faultLatched, true);

  h.run({ fault: false, reset: false });
  const retried = h.run({ fault: false, reset: true });
  assert.deepEqual(retried.events, ['FAULT_CLEARED']);
  assert.equal(retried.state.mode, 'READY');
});

test('step：转移超时锁存 TRANSFER_TIMEOUT，迟到完成不消费队列，且必须显式对账', () => {
  const h = harness(1);
  const started = h.run({ downstreamReady: true, upstreamReady: true, nowSec: 0 });
  assert.deepEqual(started.events, ['TRANSFER_STARTED'], '上游没有来料参数时不产生争用事件');
  assert.equal(started.state.mode, 'TRANSFER');
  assert.equal(started.state.transferElapsedSec, 0);

  const waiting = h.run({ downstreamReady: true, nowSec: 4.9 });
  assert.deepEqual(waiting.events, []);
  assert.equal(waiting.state.mode, 'TRANSFER');
  assert.equal(waiting.state.transferElapsedSec, 4.9);

  const late = h.run({ downstreamReady: true, transferDone: true, transferSeq: 1, nowSec: 5 });
  assert.deepEqual(late.events, ['TRANSFER_TIMEOUT', 'FAULT_LATCHED', 'ITEM_STATE_UNKNOWN', 'TRANSFER_DONE_IGNORED']);
  assert.equal(late.state.mode, 'FAULT_OVER');
  assert.equal(late.state.faultCode, 'TRANSFER_TIMEOUT');
  assert.equal(late.state.downstreamPermit, false);
  assert.equal(late.state.unreconciledItemId, 'p1');
  assert.equal(late.state.unreconciledReason, 'TRANSFER_TIMEOUT');
  assert.equal(late.state.reconcileRequired, true);
  assert.equal(late.state.transferSeqSeen, 0, '故障期间的完成计数不得被消费，复位后重放仍按真实含义判定');
  assert.equal(bufferQueueIo(late.queue).occupied, 1, '超时后迟到的完成不得清空槽位');

  // 未对账就复位：明确拒绝，故障保持锁存。
  const blocked = h.run({ reset: true, nowSec: 6 });
  assert.deepEqual(blocked.events, ['RECONCILE_REQUIRED']);
  assert.equal(blocked.state.faultLatched, true);
  assert.equal(blocked.state.unreconciledItemId, 'p1');

  // 显式对账 aborted：件仍在缓存机里，队列不变。
  const reconciled = h.run({ reconcile: 'aborted', nowSec: 6.5 });
  assert.deepEqual(reconciled.events, ['ITEM_RECONCILED_ABORTED']);
  assert.equal(reconciled.state.reconcileRequired, false);
  assert.equal(bufferQueueIo(reconciled.queue).occupied, 1);

  const afterReset = h.run({ reset: true, nowSec: 7 });
  assert.deepEqual(afterReset.events, ['FAULT_CLEARED']);
  assert.equal(afterReset.state.mode, 'REQUEST');
  assert.equal(bufferQueueIo(afterReset.queue).occupied, 1, '复位只清故障，不丢料');

  const retried = h.run({ downstreamReady: true, nowSec: 8 });
  assert.deepEqual(retried.events, ['TRANSFER_STARTED']);
  assert.equal(retried.state.transferActive, true);
  assert.equal(retried.state.transferItemId, 'p1');
});

test('step：重复 TransferDone 幂等，同一序列号不得完成新的转移', () => {
  const h = harness(3, 4);
  assert.equal(h.run({ downstreamReady: true, nowSec: 0 }).events.includes('TRANSFER_STARTED'), true);
  const accepted = h.run({ transferDone: true, transferSeq: 1, nowSec: 1 });
  assert.deepEqual(accepted.events, ['TRANSFER_DONE_ACCEPTED']);
  assert.equal(bufferQueueIo(accepted.queue).occupied, 2);
  assert.equal(accepted.state.transferSeqSeen, 1);

  const duplicate = h.run({ transferDone: true, transferSeq: 1, nowSec: 2 });
  assert.deepEqual(duplicate.events, ['TRANSFER_DONE_IGNORED']);
  assert.equal(bufferQueueIo(duplicate.queue).occupied, 2, '重复完成不得再消费一件');

  const again = h.run({ transferDone: true, transferSeq: 1, nowSec: 3 });
  assert.deepEqual(again.events, ['TRANSFER_DONE_IGNORED']);

  // 新转移 + 陈旧序列号：旧计数先被判重，随后才发起转移，因此不得结束这次新转移。
  const restarted = h.run({ downstreamReady: true, transferDone: true, transferSeq: 1, nowSec: 4 });
  assert.deepEqual(restarted.events, ['TRANSFER_DONE_IGNORED', 'TRANSFER_STARTED']);
  assert.equal(restarted.state.transferActive, true);
  assert.equal(bufferQueueIo(restarted.queue).occupied, 2);

  const next = h.run({ transferDone: true, transferSeq: 2, nowSec: 5 });
  assert.deepEqual(next.events, ['TRANSFER_DONE_ACCEPTED']);
  assert.equal(bufferQueueIo(next.queue).occupied, 1);

  // 序列号回退同样忽略。
  const started2 = h.run({ downstreamReady: true, nowSec: 6 });
  assert.equal(started2.state.transferActive, true);
  const regressed = h.run({ transferDone: true, transferSeq: 2, nowSec: 7 });
  assert.deepEqual(regressed.events, ['TRANSFER_DONE_IGNORED']);
  assert.equal(regressed.state.transferActive, true);
});

test('step：完成计数跳号被拒绝（不销账、不推进），不再当成一次完成', () => {
  // 本轮改动：旧实现“接受跳号 + 记 TRANSFER_SEQ_GAP”。那会让一件没有真实完成的料被静默销账
  // （复审 N2 的实测：重基后陈旧 seq 被接受，occupied 1→0），所以改成**拒绝**，宁可停机等人核对。
  const h = harness(3, 4);
  h.run({ downstreamReady: true, nowSec: 0 });
  const gap = h.run({ transferDone: true, transferSeq: 3, nowSec: 1 });
  assert.deepEqual(gap.events, ['TRANSFER_SEQ_GAP', 'TRANSFER_DONE_IGNORED'], '跳号只记诊断，不销账');
  assert.equal(gap.state.transferSeqSeen, 0, '跳号不得推进计数');
  assert.equal(bufferQueueIo(gap.queue).occupied, 3, '跳号不得销掉一件没有真实完成的料');
  assert.equal(gap.state.transferActive, true, '在途转移保持，等待真实完成或超时');

  // 连续性检查：严格 +1 的那一次完成仍然正常接受（拒绝只针对跳号，不是把整条路径关死）。
  const real = harness(3, 4);
  real.run({ downstreamReady: true, nowSec: 0 });
  const ok = real.run({ transferDone: true, transferSeq: 1, nowSec: 1 });
  assert.deepEqual(ok.events, ['TRANSFER_DONE_ACCEPTED']);
  assert.equal(bufferQueueIo(ok.queue).occupied, 2);

  // 恢复路径：跳号意味着计数与队列已失步，现场必须把 PLC 计数归零后再显式重基（只允许下抬），
  // 不允许把记忆上抬到 3 去“对齐”一个已经跑偏的计数器。
  const blockedUp = h.run({ transferDone: false, transferSeqRebase: 3, nowSec: 2 });
  assert.deepEqual(blockedUp.events, ['TRANSFER_SEQ_REBASE_BLOCKED']);
  assert.equal(blockedUp.state.transferSeqSeen, 0);
});

test('step：未发起转移就收到 TransferDone 只记事件，不消费队列', () => {
  const h = harness(1);
  const unsolicited = h.run({ transferDone: true, transferSeq: 1, nowSec: 0 });
  assert.deepEqual(unsolicited.events, ['TRANSFER_DONE_UNSOLICITED']);
  assert.equal(bufferQueueIo(unsolicited.queue).occupied, 1);
  assert.equal(unsolicited.state.transferSeqSeen, 1, '无主完成也要消费计数，避免重复脉冲反复触发');
  const replay = h.run({ transferDone: true, transferSeq: 1, nowSec: 1 });
  assert.deepEqual(replay.events, ['TRANSFER_DONE_IGNORED']);
});

test('step：无序列号时按上升沿判重', () => {
  const h = harness(2);
  h.run({ downstreamReady: true, nowSec: 0 });
  assert.deepEqual(h.run({ transferDone: true, nowSec: 1 }).events, ['TRANSFER_DONE_ACCEPTED']);
  assert.deepEqual(h.run({ transferDone: true, nowSec: 2 }).events, ['TRANSFER_DONE_IGNORED']);
  h.run({ transferDone: false, nowSec: 3 });
  h.run({ downstreamReady: true, nowSec: 4 });
  assert.deepEqual(h.run({ transferDone: true, nowSec: 5 }).events, ['TRANSFER_DONE_ACCEPTED']);
});

test('step：单执行器仲裁，半满时争用由下游胜出，满料/空缓存不虚构争用', () => {
  // 空缓存 + 双就绪 + 来料：只有上游真的有动作，下游无料可出 → 不产生争用事件（A7）。
  const empty = harness(0);
  const intake = empty.run({ upstreamReady: true, downstreamReady: true, incomingItemId: 'p1', nowSec: 0 });
  assert.deepEqual(intake.events, ['ITEM_ACCEPTED']);
  assert.equal(intake.state.contention, null);
  assert.equal(intake.state.actuator, 'intake');
  assert.equal(intake.state.upstreamPermit, true);
  assert.equal(intake.state.downstreamPermit, false);
  assert.equal(intake.state.upstreamPermit && intake.state.downstreamPermit, false);

  // 半满：两侧都真有动作请求 → 争用由下游胜出。
  const half = harness(1);
  const contended = half.run({ upstreamReady: true, downstreamReady: true, incomingItemId: 'p2', nowSec: 0 });
  assert.equal(contended.state.upstreamPermit && contended.state.downstreamPermit, false);
  assert.equal(contended.state.contention, 'downstream');
  assert.ok(contended.events.includes('CONTENTION_DOWNSTREAM'));
  assert.equal(contended.state.transferActive, true);
  assert.equal(contended.state.actuator, 'discharge');
  assert.equal(contended.state.downstreamPermit, true);
  assert.ok(contended.events.includes('ITEM_REJECTED_BUSY'), '执行器被出料占用时来料被拒');

  // 满料：上游已被背压禁止，不构成争用；执行器被出料占用时来料按“忙”拒绝。
  const full = harness(2);
  const fullResult = full.run({ upstreamReady: true, downstreamReady: true, incomingItemId: 'p3', nowSec: 0 });
  assert.equal(fullResult.state.upstreamPermit, false);
  assert.equal(fullResult.state.downstreamPermit, true);
  assert.equal(fullResult.state.contention, null);
  assert.ok(!fullResult.events.includes('CONTENTION_UPSTREAM'), '上游许可为假时不得记“上游获得执行权”');
  assert.ok(fullResult.events.includes('TRANSFER_STARTED'));
  assert.ok(fullResult.events.includes('ITEM_REJECTED_BUSY'));
  assert.equal(fullResult.state.full, true);
});

test('step：转移占用执行器期间来料被拒，不会并行进料与出料', () => {
  const h = harness(1);
  const busy = h.run({ downstreamReady: true, upstreamReady: true, incomingItemId: 'p2', nowSec: 0 });
  assert.deepEqual(busy.events, ['TRANSFER_STARTED', 'CONTENTION_DOWNSTREAM', 'ITEM_REJECTED_BUSY']);
  assert.equal(bufferQueueIo(busy.queue).occupied, 1, '转移期间不得同时入料');
  assert.equal(busy.state.actuator, 'discharge');

  const full = harness(2);
  const rejected = full.run({ upstreamReady: true, incomingItemId: 'p3', nowSec: 0 });
  assert.deepEqual(rejected.events, ['ITEM_REJECTED_FULL']);
  assert.equal(rejected.state.mode, 'BACKPRESSURE');
});

test('step：非法输入显式失败（时间回退、零超时、非法计数、非布尔）', () => {
  const h = harness(0);
  h.run({ nowSec: 5 });
  assert.throws(() => stepBufferControl(h.memory, stepInput(h.queue, { nowSec: 4 })), /nowSec 必须单调不减/);
  for (const transferTimeoutSec of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => stepBufferControl(createBufferControlMemory(), stepInput(h.queue, { transferTimeoutSec })), RangeError);
  }
  for (const transferSeq of [-1, 1.5, Number.NaN]) {
    assert.throws(() => stepBufferControl(createBufferControlMemory(), stepInput(h.queue, { transferDone: true, transferSeq })), /transferSeq/);
  }
  assert.throws(() => stepBufferControl(createBufferControlMemory(), stepInput(h.queue, { upstreamReady: 'yes' })), /upstreamReady/);
  assert.throws(() => stepBufferControl(createBufferControlMemory(), stepInput(h.queue, { incomingItemId: '  ' })), /incomingItemId/);
  assert.throws(() => stepBufferControl(createBufferControlMemory(), stepInput(null)), /缓存队列状态/);
});

test('step：纯函数不修改入参记忆与队列', () => {
  const h = harness(1);
  const memoryRef = h.memory;
  const memorySnapshot = { ...memoryRef };
  const queueRef = h.queue;
  const queueSnapshot = {
    queue: [...queueRef.queue],
    slots: queueRef.slots.map((slot) => ({ ...slot })),
    nextTower: queueRef.nextTower
  };
  const result = stepBufferControl(memoryRef, stepInput(queueRef, {
    upstreamReady: true, incomingItemId: 'p2', nowSec: 0
  }));
  assert.deepEqual(result.events, ['ITEM_ACCEPTED']);
  assert.deepEqual(memoryRef, memorySnapshot, '记忆入参不得被就地修改');
  assert.notEqual(result.memory, memoryRef, '必须返回新的记忆对象');
  assert.deepEqual(queueRef, queueSnapshot, '队列入参不得被就地修改');
  assert.notEqual(result.queue, queueRef, '入队后必须返回新队列对象');
  assert.equal(bufferQueueIo(queueRef).occupied, 1);
  assert.equal(bufferQueueIo(result.queue).occupied, 2);
});

test('step：进料→转移→完成→出料的事件序列与时间戳可追溯', () => {
  const h = harness(0);
  const intake = h.run({ upstreamReady: true, incomingItemId: 'p1', nowSec: 0 });
  assert.deepEqual(intake.events, ['ITEM_ACCEPTED']);
  assert.equal(intake.state.actuator, 'intake');
  assert.equal(intake.state.stepSec, 0);

  const started = h.run({ downstreamReady: true, nowSec: 0.2 });
  assert.deepEqual(started.events, ['TRANSFER_STARTED']);
  assert.equal(started.state.transferElapsedSec, 0);

  const dwelling = h.run({ downstreamReady: true, nowSec: 1 });
  assert.deepEqual(dwelling.events, []);
  assert.equal(dwelling.state.transferElapsedSec, 0.8);
  assert.equal(dwelling.state.transferItemId, 'p1');

  const done = h.run({ transferDone: true, transferSeq: 1, nowSec: 1.2 });
  assert.deepEqual(done.events, ['TRANSFER_DONE_ACCEPTED']);
  assert.equal(done.state.mode, 'READY');
  assert.equal(done.state.actuator, 'idle');
  assert.equal(done.state.transferElapsedSec, null);
  assert.equal(bufferQueueIo(done.queue).occupied, 0);
  assert.deepEqual(h.steps.flatMap((step) => step.events), [
    'ITEM_ACCEPTED', 'TRANSFER_STARTED', 'TRANSFER_DONE_ACCEPTED'
  ]);
});

// ---------------------------------------------------------------------------
// 审查反例回归（T2 整改）
// ---------------------------------------------------------------------------

test('回归 A8：转移中锁故障后，同一件不会自动重发，必须先对账', () => {
  const h = harness(1);
  const started = h.run({ downstreamReady: true, nowSec: 0 });
  assert.deepEqual(started.events, ['TRANSFER_STARTED']);
  assert.equal(started.state.transferItemId, 'p1');

  const faulted = h.run({ fault: true, nowSec: 1 });
  assert.deepEqual(faulted.events, ['FAULT_LATCHED', 'ITEM_STATE_UNKNOWN']);
  assert.equal(faulted.state.unreconciledItemId, 'p1');
  assert.equal(faulted.state.transferActive, false);
  assert.equal(bufferQueueIo(faulted.queue).occupied, 1, '未知件仍占槽，不能靠丢弃会话把账做平');

  // 故障消失不算恢复：没有对账，复位被拒，也不会重新发起转移。
  const resetBlocked = h.run({ fault: false, reset: true, downstreamReady: true, nowSec: 2 });
  assert.deepEqual(resetBlocked.events, ['RECONCILE_REQUIRED']);
  assert.equal(resetBlocked.state.transferActive, false);
  assert.equal(resetBlocked.state.mode, 'FAULT_OVER');

  // 对账 confirmed：件已离开 → 恰好出队一件。
  const confirmed = h.run({ fault: false, reconcile: 'confirmed', downstreamReady: true, nowSec: 3 });
  assert.deepEqual(confirmed.events, ['ITEM_RECONCILED_CONFIRMED']);
  assert.equal(bufferQueueIo(confirmed.queue).occupied, 0);
  assert.equal(confirmed.state.unreconciledItemId, null);
  assert.equal(confirmed.state.transferActive, false, '对账本身不得顺手发起新转移');

  const cleared = h.run({ fault: false, reset: true, nowSec: 4 });
  assert.deepEqual(cleared.events, ['FAULT_CLEARED']);
  assert.equal(cleared.state.mode, 'READY');
});

test('回归 P1-2：对账 confirmed 只移除未知件，不把别的在库件一起清掉', () => {
  const h = harness(3, 4);
  h.run({ downstreamReady: true, nowSec: 0 });
  const faulted = h.run({ fault: true, nowSec: 1 });
  assert.equal(faulted.state.unreconciledItemId, 'p1');
  const confirmed = h.run({ fault: false, reconcile: 'confirmed', nowSec: 2 });
  assert.deepEqual(confirmed.events, ['ITEM_RECONCILED_CONFIRMED']);
  assert.deepEqual(confirmed.queue.queue, ['p2', 'p3']);
  assert.equal(bufferQueueIo(confirmed.queue).occupied, 2);
  assert.equal(confirmed.queue.slots.filter((slot) => slot.occupied && slot.itemId === 'p1').length, 0);
});

test('回归：没有未知件时 reconcile 只记事件，非法对账值直接 RangeError', () => {
  const h = harness(1);
  const idle = h.run({ reconcile: 'confirmed', nowSec: 0 });
  assert.deepEqual(idle.events, ['RECONCILE_IGNORED']);
  assert.equal(bufferQueueIo(idle.queue).occupied, 1);
  assert.throws(
    () => stepBufferControl(h.memory, stepInput(h.queue, { reconcile: 'maybe', nowSec: 1 })),
    /reconcile 必须为 confirmed 或 aborted/
  );
});

test('回归 P1-3：seq 重基必须显式，且不在故障/在途/Done 高时偷偷生效', () => {
  const h = harness(4, 4);
  // 先跑出 seen=3
  for (let seq = 1; seq <= 3; seq += 1) {
    h.run({ downstreamReady: true, nowSec: seq * 2 - 2 });
    const done = h.run({ transferDone: true, transferSeq: seq, nowSec: seq * 2 - 1 });
    assert.deepEqual(done.events, ['TRANSFER_DONE_ACCEPTED']);
  }
  assert.equal(h.memory.transferSeqSeen, 3);

  // 在途转移时重基被拒。
  const started = h.run({ downstreamReady: true, nowSec: 10 });
  assert.deepEqual(started.events, ['TRANSFER_STARTED']);
  const blockedActive = h.run({ transferSeqRebase: 0, nowSec: 11 });
  assert.deepEqual(blockedActive.events, ['TRANSFER_SEQ_REBASE_BLOCKED']);
  assert.equal(blockedActive.state.transferSeqSeen, 3);

  // 故障期间重基被拒。
  const faulted = h.run({ fault: true, nowSec: 12 });
  assert.equal(faulted.state.faultLatched, true);
  const blockedFault = h.run({ fault: false, transferSeqRebase: 0, nowSec: 13 });
  assert.deepEqual(blockedFault.events, ['TRANSFER_SEQ_REBASE_BLOCKED']);
  h.run({ fault: false, reconcile: 'aborted', nowSec: 14 });
  h.run({ fault: false, reset: true, nowSec: 15 });

  // Done 仍为高时重基被拒（当前高电平可能是旧完成，先让它落下）。
  const blockedDone = h.run({ transferDone: true, transferSeqRebase: 0, nowSec: 16 });
  assert.ok(blockedDone.events.includes('TRANSFER_SEQ_REBASE_BLOCKED'));
  assert.equal(blockedDone.state.transferSeqSeen, 3);

  // 无故障、无在途、Done 低：显式重基到 0，之后 PLC 重启回放的 seq=1 可以被正常接受。
  const rebased = h.run({ transferDone: false, transferSeqRebase: 0, nowSec: 17 });
  assert.deepEqual(rebased.events, ['TRANSFER_SEQ_REBASED']);
  assert.equal(rebased.state.transferSeqSeen, 0);

  const restart = h.run({ downstreamReady: true, transferSeq: 1, nowSec: 18 });
  assert.deepEqual(restart.events, ['TRANSFER_STARTED']);
  const replay = h.run({ transferDone: true, transferSeq: 1, nowSec: 19 });
  assert.deepEqual(replay.events, ['TRANSFER_DONE_ACCEPTED'], '重基后 PLC 回放 seq=1 必须能被接受');
  assert.equal(bufferQueueIo(replay.queue).occupied, 0);
});

test('回归 P1-3：不重基时回退序号仍判重，不自动吞掉重放', () => {
  // 计数只能用“严格 +1 的连续完成”推到 5（跳号已被拒绝，见上一条用例）。
  const h = harness(6, 8);
  for (let seq = 1; seq <= 5; seq += 1) {
    h.run({ downstreamReady: true, nowSec: seq * 2 - 2 });
    const done = h.run({ transferDone: true, transferSeq: seq, nowSec: seq * 2 - 1 });
    assert.deepEqual(done.events, ['TRANSFER_DONE_ACCEPTED']);
  }
  assert.equal(h.memory.transferSeqSeen, 5);
  h.run({ downstreamReady: true, nowSec: 11 });
  const replay = h.run({ transferDone: true, transferSeq: 1, nowSec: 12 });
  assert.deepEqual(replay.events, ['TRANSFER_DONE_IGNORED']);
  assert.equal(replay.state.transferSeqSeen, 5, '回退序号不推进计数');
  assert.equal(replay.state.transferActive, true, '也不允许用回退序号结束在途转移');
});

test('回归 P2-1：Done 电平常高时只有显式 level 语义能完成新转移', () => {
  const edge = harness(2, 4);
  edge.run({ downstreamReady: true, nowSec: 0 });
  // 边沿语义：第一次高电平就是这次转移的完成；此后 Done 一直为高，
  // 下一次转移再也拿不到“新的上升沿”，只能超时——不能被当成自动完成（既有安全行为，不放宽）。
  assert.deepEqual(edge.run({ transferDone: true, nowSec: 1 }).events, ['TRANSFER_DONE_ACCEPTED']);
  assert.deepEqual(edge.run({ downstreamReady: true, transferDone: true, nowSec: 2 }).events, ['TRANSFER_DONE_IGNORED', 'TRANSFER_STARTED']);
  for (const nowSec of [3, 4]) {
    assert.deepEqual(edge.run({ transferDone: true, nowSec }).events, ['TRANSFER_DONE_IGNORED']);
  }
  const timedOut = edge.run({ transferDone: true, nowSec: 10 });
  assert.ok(timedOut.events.includes('TRANSFER_TIMEOUT'));

  const level = harness(2, 4);
  level.run({ downstreamReady: true, nowSec: 0 });
  const completed = level.run({ transferDone: true, transferDoneMode: 'level', nowSec: 1 });
  assert.deepEqual(completed.events, ['TRANSFER_DONE_ACCEPTED']);
  assert.equal(bufferQueueIo(completed.queue).occupied, 1);

  // 下一个转移 + 仍为高的 Done：没在途转移时的高电平是“无主完成”，只记事件；
  // 电平语义下每个在途转移只接受一次。
  const nextStart = level.run({ downstreamReady: true, transferDone: true, transferDoneMode: 'level', nowSec: 2 });
  assert.deepEqual(nextStart.events, ['TRANSFER_DONE_UNSOLICITED', 'TRANSFER_STARTED']);
  const nextDone = level.run({ transferDone: true, transferDoneMode: 'level', nowSec: 3 });
  assert.deepEqual(nextDone.events, ['TRANSFER_DONE_ACCEPTED']);
  assert.equal(bufferQueueIo(nextDone.queue).occupied, 0);
  assert.throws(
    () => stepBufferControl(level.memory, stepInput(level.queue, { transferDoneMode: 'both', nowSec: 4 })),
    /transferDoneMode 必须为 edge 或 level/
  );
});

test('回归 P2-2：来料件号与在库件重复时给拒绝事件，不让 RangeError 穿透扫描周期', () => {
  const h = harness(1);
  const duplicate = h.run({ upstreamReady: true, incomingItemId: 'p1', nowSec: 0 });
  assert.deepEqual(duplicate.events, ['ITEM_REJECTED_DUPLICATE']);
  assert.equal(bufferQueueIo(duplicate.queue).occupied, 1);
  assert.equal(duplicate.state.actuator, 'idle');
});

test('回归 P2-3：上游未就绪时来料报 ITEM_REJECTED_UPSTREAM_NOT_READY，不再误标满料', () => {
  const h = harness(0);
  const result = h.run({ upstreamReady: false, incomingItemId: 'p1', nowSec: 0 });
  assert.deepEqual(result.events, ['ITEM_REJECTED_UPSTREAM_NOT_READY']);
  assert.equal(result.state.full, false);
  assert.equal(result.state.mode, 'READY');
  assert.equal(bufferQueueIo(result.queue).occupied, 0);
});

test('回归 P2-4：记忆自相矛盾时 RangeError，不会进入永不超时的状态', () => {
  const queue = queued(1);
  const activeWithoutStart = { ...createBufferControlMemory(), transferActive: true, transferStartedAtSec: null, transferItemId: 'p1' };
  assert.throws(
    () => stepBufferControl(activeWithoutStart, stepInput(queue, { downstreamReady: true, nowSec: 1000 })),
    /transferActive 必须与 transferStartedAtSec/
  );
  const latchedWithoutCode = { ...createBufferControlMemory(), faultLatched: true, faultCode: 'NONE' };
  assert.throws(() => stepBufferControl(latchedWithoutCode, stepInput(queue, { nowSec: 0 })), /faultLatched 与 faultCode/);
  const badCode = { ...createBufferControlMemory(), faultLatched: true, faultCode: 'OVERHEAT' };
  assert.throws(() => stepBufferControl(badCode, stepInput(queue, { nowSec: 0 })), /faultCode 无效/);
  const halfReconciled = { ...createBufferControlMemory(), unreconciledItemId: 'p1', unreconciledReason: null };
  assert.throws(() => stepBufferControl(halfReconciled, stepInput(queue, { nowSec: 0 })), /unreconciledItemId 与 unreconciledReason/);
});

test('回归 P2-5：畸形队列显式报错，不再表现为永久背压', () => {
  const bad = { queue: [], slots: [], nextTower: 'A' };
  assert.throws(
    () => stepBufferControl(createBufferControlMemory(), stepInput(bad)),
    /slots 不能为空/
  );
  const mismatched = { ...queued(1), queue: [] };
  assert.throws(
    () => stepBufferControl(createBufferControlMemory(), stepInput(mismatched)),
    /队列件数 0 与占用槽位 1 不一致|槽位件号/
  );
  const strayItem = { ...queued(0), queue: ['ghost'] };
  assert.throws(
    () => stepBufferControl(createBufferControlMemory(), stepInput(strayItem)),
    /槽位件号|队列件数/
  );
  assert.throws(
    () => stepBufferControl(createBufferControlMemory(), stepInput({ ...queued(0), nextTower: 'C' })),
    /nextTower 必须为 A 或 B/
  );
});

test('回归 P2-6：满料出料中 mode 为 TRANSFER，full 仍为真且背压不丢', () => {
  const h = harness(2);
  const result = h.run({ downstreamReady: true, upstreamReady: true, nowSec: 0 });
  assert.equal(result.state.mode, 'TRANSFER');
  assert.equal(result.state.full, true);
  assert.equal(result.state.upstreamPermit, false);
  assert.equal(result.state.downstreamPermit, true);
  assert.equal(result.state.actuator, 'discharge');
  assert.match(result.state.reason, /背压/);
});

// ---------------------------------------------------------------------------
// 复审 N1–N6 回归（本轮整改）
// ---------------------------------------------------------------------------

test('回归 N1：对账与复位同帧时不得在同一扫描周期重新发起转移（隔一拍）', () => {
  const h = harness(2, 4);
  h.run({ downstreamReady: true, nowSec: 0 });            // p1 在途
  const faulted = h.run({ fault: true, nowSec: 1 });      // 打断，p1 状态未知
  assert.deepEqual(faulted.events, ['FAULT_LATCHED', 'ITEM_STATE_UNKNOWN']);
  assert.equal(faulted.state.unreconciledItemId, 'p1');

  // 操作员一个报文里同时给“对账 + 复位 + 下游就绪”：旧实现会在这里同拍发 TRANSFER_STARTED。
  const same = h.run({ fault: false, reconcile: 'aborted', reset: true, downstreamReady: true, nowSec: 2 });
  assert.deepEqual(same.events, ['ITEM_RECONCILED_ABORTED', 'FAULT_CLEARED'], '对账/复位当拍不得启动转移');
  assert.equal(same.state.arbitrationHeld, true);
  assert.equal(same.state.transferActive, false);
  assert.equal(same.state.downstreamPermit, false, '冻结拍内不得给出下游许可');
  assert.equal(same.state.mode, 'REQUEST');
  assert.match(same.state.reason, /延后一个扫描周期/);
  assert.equal(bufferQueueIo(same.queue).occupied, 2, '复位只清故障，不丢料');

  // 隔一拍才允许重新发起：监督拍的缓冲是“至少一拍”，不是“永久延后”。
  const started = h.run({ downstreamReady: true, nowSec: 3 });
  assert.deepEqual(started.events, ['TRANSFER_STARTED']);
  assert.equal(started.state.transferItemId, 'p1');
  assert.equal(started.state.arbitrationHeld, false);
});

test('回归 N1：复位/对账/重基当拍冻结出料，但进料仍按正常规则处理（不吞来料）', () => {
  // 只复位：同一拍给出下游就绪 + 上游来料。
  const h = harness(1);
  h.run({ downstreamReady: true, nowSec: 0 });
  h.run({ fault: true, nowSec: 1 });
  h.run({ fault: false, reconcile: 'aborted', nowSec: 2 });
  const reset = h.run({ fault: false, reset: true, downstreamReady: true, upstreamReady: true, incomingItemId: 'p2', nowSec: 3 });
  assert.deepEqual(reset.events, ['FAULT_CLEARED', 'ITEM_ACCEPTED'], '出料冻结一拍，但来料照收');
  assert.equal(reset.state.transferActive, false);
  assert.equal(reset.state.actuator, 'intake');
  assert.equal(bufferQueueIo(reset.queue).occupied, 2);
  assert.equal(reset.state.contention, null, '冻结拍不得虚构“上游争用胜出”');
  assert.equal(reset.state.upstreamPermit && reset.state.downstreamPermit, false);

  // 重基当拍同样冻结出料。
  const rebase = harness(2);
  rebase.run({ downstreamReady: true, nowSec: 0 });
  rebase.run({ transferDone: true, transferSeq: 1, nowSec: 1 });
  const rebased = rebase.run({ downstreamReady: true, transferSeqRebase: 0, nowSec: 2 });
  assert.deepEqual(rebased.events, ['TRANSFER_SEQ_REBASED']);
  assert.equal(rebased.state.arbitrationHeld, true);
  assert.equal(rebased.state.transferActive, false);
  const afterRebase = rebase.run({ downstreamReady: true, nowSec: 3 });
  assert.deepEqual(afterRebase.events, ['TRANSFER_STARTED']);
});

test('回归 N2：重基后被重新打开的旧序号不得销账（陈旧完成走跳号拒绝）', () => {
  const h = harness(4, 4);
  for (let seq = 1; seq <= 2; seq += 1) {
    h.run({ downstreamReady: true, nowSec: seq * 2 - 2 });
    assert.deepEqual(h.run({ transferDone: true, transferSeq: seq, nowSec: seq * 2 - 1 }).events,
      ['TRANSFER_DONE_ACCEPTED']);
  }
  assert.equal(h.memory.transferSeqSeen, 2);
  assert.equal(bufferQueueIo(h.queue).occupied, 2);

  const rebased = h.run({ transferSeqRebase: 0, nowSec: 10 });
  assert.deepEqual(rebased.events, ['TRANSFER_SEQ_REBASED']);
  assert.equal(rebased.state.transferSeqSeen, 0);
  assert.equal(bufferQueueIo(rebased.queue).occupied, 2, '重基只动计数，不动队列');

  const started = h.run({ downstreamReady: true, nowSec: 11 });
  assert.equal(started.state.transferItemId, 'p3');

  // PLC 侧把上一轮真实完成过的 seq=2 又送了一次：旧实现会 ACCEPTED 并把 p3 销掉（少算一件）。
  const stale = h.run({ transferDone: true, transferSeq: 2, nowSec: 12 });
  assert.deepEqual(stale.events, ['TRANSFER_SEQ_GAP', 'TRANSFER_DONE_IGNORED']);
  assert.equal(stale.state.transferSeqSeen, 0, '陈旧序号不得推进计数');
  assert.equal(bufferQueueIo(stale.queue).occupied, 2, '陈旧序号不得销账');
  assert.equal(stale.state.transferActive, true, '在途转移不得被陈旧序号结束');

  // 重基后的真实第一次完成是 seq=1，走严格 +1 正常路径。
  const real = h.run({ transferDone: true, transferSeq: 1, nowSec: 13 });
  assert.deepEqual(real.events, ['TRANSFER_DONE_ACCEPTED']);
  assert.equal(bufferQueueIo(real.queue).occupied, 1);
});

test('回归 N3：重基只允许下抬，上抬一律拒绝；被写坏的超大计数可用下抬恢复', () => {
  const h = harness(3, 4);
  h.run({ downstreamReady: true, nowSec: 0 });
  h.run({ transferDone: true, transferSeq: 1, nowSec: 1 });
  assert.equal(h.memory.transferSeqSeen, 1);

  // 笔误/误输入把计数器上抬到 100：旧实现接受后，真实 seq=2 永久被判重，只能反复超时。
  const up = h.run({ transferSeqRebase: 100, nowSec: 2 });
  assert.deepEqual(up.events, ['TRANSFER_SEQ_REBASE_BLOCKED']);
  assert.equal(up.state.transferSeqSeen, 1, '上抬被拒后计数不变');
  assert.equal(up.state.arbitrationHeld, false, '被拒的重基不冻结仲裁');

  // 重基到自身值是幂等的：不产生事件，也不冻结。
  const same = stepBufferControl(h.memory, stepInput(h.queue, { transferSeqRebase: 1, nowSec: 3 }));
  assert.deepEqual(same.events, []);
  assert.equal(same.state.transferSeqSeen, 1);

  // 持久化记忆里被写成 MAX_SAFE_INTEGER：允许下抬重基（<= seen），这是唯一的恢复入口。
  const corrupted = { ...h.memory, transferSeqSeen: Number.MAX_SAFE_INTEGER };
  const recovered = stepBufferControl(corrupted, stepInput(h.queue, { transferSeqRebase: 0, nowSec: 4 }));
  assert.deepEqual(recovered.events, ['TRANSFER_SEQ_REBASED']);
  assert.equal(recovered.memory.transferSeqSeen, 0);
});

test('回归 N6：对账消费序号与正常完成同一口径（严格 +1，跳号同样拒绝并记 GAP）', () => {
  // A. 对账时看到跳号 seq=4（seen=1）：记 GAP、不推进、不销账。
  const gap = harness(3, 4);
  gap.run({ downstreamReady: true, nowSec: 0 });
  assert.deepEqual(gap.run({ transferDone: true, transferSeq: 1, nowSec: 1 }).events, ['TRANSFER_DONE_ACCEPTED']);
  gap.run({ downstreamReady: true, nowSec: 2 });
  const faulted = gap.run({ fault: true, nowSec: 3 });
  assert.equal(faulted.state.unreconciledItemId, 'p2');
  const gapReconcile = gap.run({ fault: false, reconcile: 'aborted', transferDone: true, transferSeq: 4, nowSec: 4 });
  assert.deepEqual(gapReconcile.events, ['ITEM_RECONCILED_ABORTED', 'TRANSFER_SEQ_GAP', 'TRANSFER_DONE_IGNORED']);
  assert.equal(gapReconcile.state.transferSeqSeen, 1, '对账跳号也不得推进计数');
  assert.equal(bufferQueueIo(gapReconcile.queue).occupied, 2, 'aborted + 跳号：一件都不销');

  // B. 对账时看到严格 +1 的 seq=2：按归属消费一次，主完成判定不再重复消费。
  const ok = harness(2, 4);
  ok.run({ downstreamReady: true, nowSec: 0 });
  ok.run({ transferDone: true, transferSeq: 1, nowSec: 1 });
  ok.run({ downstreamReady: true, nowSec: 2 });
  assert.equal(ok.run({ fault: true, nowSec: 3 }).state.unreconciledItemId, 'p2');
  const consumed = ok.run({ fault: false, reconcile: 'aborted', transferDone: true, transferSeq: 2, nowSec: 4 });
  assert.deepEqual(consumed.events, ['ITEM_RECONCILED_ABORTED', 'TRANSFER_DONE_IGNORED'], '同一脉冲只消费一次');
  assert.equal(consumed.state.transferSeqSeen, 2);
  assert.equal(bufferQueueIo(consumed.queue).occupied, 1, '对账 aborted 不销账');

  // C. 对账 confirmed + 严格 +1 的迟到完成：件按对账出队一次，计数同时推进到 2。
  const confirmed = harness(2, 4);
  confirmed.run({ downstreamReady: true, nowSec: 0 });
  confirmed.run({ transferDone: true, transferSeq: 1, nowSec: 1 });
  confirmed.run({ downstreamReady: true, nowSec: 2 });
  confirmed.run({ fault: true, nowSec: 3 });
  const done = confirmed.run({ fault: false, reconcile: 'confirmed', transferDone: true, transferSeq: 2, nowSec: 4 });
  assert.deepEqual(done.events, ['ITEM_RECONCILED_CONFIRMED', 'TRANSFER_DONE_IGNORED']);
  assert.equal(done.state.transferSeqSeen, 2);
  assert.equal(bufferQueueIo(done.queue).occupied, 0, 'confirmed 只出队被打断的那一件');
  assert.equal(done.state.transferActive, false);
});
