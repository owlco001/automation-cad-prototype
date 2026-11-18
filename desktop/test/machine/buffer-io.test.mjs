import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBufferControlMemory, evaluateBufferControl, stepBufferControl } from '../../src/machine/buffer-control.ts';
import { mapBufferIoSignals } from '../../src/machine/buffer-io.ts';
import { createBufferQueue, enqueueBufferItem } from '../../src/machine/buffer-tower.ts';

const queued = (count) => {
  let queue = createBufferQueue({ towerCount: 1, slotsPerTower: 4 });
  for (let index = 0; index < count; index += 1) queue = enqueueBufferItem(queue, `p${index + 1}`).state;
  return queue;
};

test('Ready/Request/TransferDone 映射为命名握手信号', () => {
  const queue = queued(1);
  const input = { upstreamReady: true, downstreamReady: true, transferDone: false, fault: false };
  const control = evaluateBufferControl({ queue, ...input });
  // 单帧兼容状态没有锁存记忆：fault 只能取原始输入，faultSource 显式标注来源。
  assert.deepEqual(mapBufferIoSignals(control, input), {
    upstreamReady: true, upstreamRequest: true, downstreamReady: true, downstreamRequest: true,
    transferDone: false, bufferFull: false, bufferEmpty: false, fault: false, backpressure: false,
    faultSource: 'input'
  });
});

test('满料与故障分别暴露背压和 fault 信号', () => {
  let queue = createBufferQueue({ towerCount: 1, slotsPerTower: 1 });
  queue = enqueueBufferItem(queue, 'p1').state;
  const fullInput = { upstreamReady: true, downstreamReady: false, transferDone: false, fault: false };
  const fullControl = evaluateBufferControl({ queue, ...fullInput });
  assert.equal(mapBufferIoSignals(fullControl, fullInput).backpressure, true);
  const faultInput = { ...fullInput, fault: true };
  const faultControl = evaluateBufferControl({ queue, ...faultInput });
  const signals = mapBufferIoSignals(faultControl, faultInput);
  assert.equal(signals.fault, true);
  assert.equal(signals.upstreamRequest, false);
  assert.equal(signals.downstreamRequest, false);
});

test('锁存故障的 fault 输出点必须为 1（原始电平回落后也一样）', () => {
  // 复跑审查 A10：第 1 步 fault:true 锁存，第 2 步原始 fault 已回落。
  const queue = queued(1);
  const latch = stepBufferControl(createBufferControlMemory(), {
    queue, upstreamReady: false, downstreamReady: false, transferDone: false, fault: true,
    reset: false, nowSec: 0, transferTimeoutSec: 5
  });
  const after = stepBufferControl(latch.memory, {
    queue: latch.queue, upstreamReady: false, downstreamReady: false, transferDone: false, fault: false,
    reset: false, nowSec: 1, transferTimeoutSec: 5
  });
  const handshake = { upstreamReady: true, downstreamReady: false, transferDone: false, fault: false };
  const signals = mapBufferIoSignals(after.state, handshake);
  assert.equal(after.state.mode, 'FAULT_OVER');
  assert.equal(after.state.faultLatched, true);
  assert.equal(handshake.fault, false, '原始输入确实已经回落');
  assert.equal(signals.fault, true, '安全故障点必须反映锁存结论');
  assert.equal(signals.faultSource, 'latched');
  assert.equal(signals.upstreamRequest, false);
  assert.equal(signals.backpressure, false);
});

test('满料且正在出料：mode 是 TRANSFER 时背压仍必须为真', () => {
  // 复跑审查 A1：full + transferActive 时 mode 不再是 BACKPRESSURE。
  let queue = createBufferQueue({ towerCount: 1, slotsPerTower: 2 });
  queue = enqueueBufferItem(queue, 'p1').state;
  queue = enqueueBufferItem(queue, 'p2').state;
  const result = stepBufferControl(createBufferControlMemory(), {
    queue, upstreamReady: true, downstreamReady: true, transferDone: false, fault: false,
    reset: false, nowSec: 0, transferTimeoutSec: 5
  });
  assert.equal(result.state.mode, 'TRANSFER');
  assert.equal(result.state.full, true);
  assert.equal(result.state.upstreamPermit, false);
  assert.equal(result.state.downstreamPermit, true);
  const signals = mapBufferIoSignals(result.state, { upstreamReady: true, downstreamReady: true, transferDone: false, fault: false });
  assert.equal(signals.backpressure, true);
  assert.equal(signals.bufferFull, true);
  assert.equal(signals.upstreamRequest, false);
});
