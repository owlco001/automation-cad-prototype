import type { BufferControlState } from './buffer-control.ts';

export interface BufferIoSignals {
  upstreamReady: boolean;
  upstreamRequest: boolean;
  downstreamReady: boolean;
  downstreamRequest: boolean;
  transferDone: boolean;
  bufferFull: boolean;
  bufferEmpty: boolean;
  fault: boolean;
  backpressure: boolean;
  /** `fault` 的取值来源：`latched` = 锁存故障结论（step 层状态），`input` = 原始输入电平。 */
  faultSource: 'latched' | 'input';
}

/**
 * Maps the pure control decision to named handshake signals; no PLC addresses are assumed.
 *
 * 安全点位 `buffer-fault` 必须反映**锁存**故障：`stepBufferControl` 的状态带 `faultLatched`，
 * 故障信号已经回落后它仍为 true。若只看原始 `input.fault`，锁存中的故障会导出 DO=0。
 * 兼容单帧 `evaluateBufferControl`（无锁存记忆）时回退到 `input.fault`。
 * `backpressure` 由“满料”事实导出，不再依赖 `mode` 文案：满料且正在出料时 mode 是 TRANSFER，
 * 但上游仍必须背压；FAULT_OVER 下由 `fault` 表达，不叠加背压。
 */
export function mapBufferIoSignals(control: BufferControlState, input: {
  upstreamReady: boolean;
  downstreamReady: boolean;
  transferDone: boolean;
  fault: boolean;
}): BufferIoSignals {
  const latched = (control as BufferControlState & { faultLatched?: boolean }).faultLatched;
  const latchedFault = typeof latched === 'boolean' ? latched : null;
  return {
    upstreamReady: input.upstreamReady,
    upstreamRequest: control.upstreamPermit,
    downstreamReady: input.downstreamReady,
    downstreamRequest: control.downstreamPermit,
    transferDone: input.transferDone,
    bufferFull: control.full,
    bufferEmpty: control.empty,
    fault: latchedFault === true ? true : input.fault,
    backpressure: control.full && control.mode !== 'FAULT_OVER',
    faultSource: latchedFault === true ? 'latched' : 'input'
  };
}
