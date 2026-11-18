// 光伏组件缓存容量：方案阶段纯模型，不读取设备状态，不猜测生产时长。
export interface BufferCapacityInput {
  /** 每个节拍一件，单位秒。 */
  upstreamCycleSec: number;
  downstreamCycleSec: number;
  downstreamStopSec: number;
  initialOccupancy: number;
  /** 停机开始前已放行、尚未进入缓存的件数；不与停机期间新增到件重复。 */
  inTransit: number;
  /** 预留空槽，不作为待排空物料。 */
  reserveSlots: number;
  capacity?: number;
}

export interface BufferCapacityResult {
  arrivalRatePerSec: number;
  departureRatePerSec: number;
  arrivalRatePerMin: number;
  departureRatePerMin: number;
  /** 有符号净流入速率；负数表示下游有追赶余量。 */
  netAccumulationPerSec: number;
  netAccumulationPerMin: number;
  sustainedAccumulationPerMin: number;
  sustainedBalance: boolean;
  normalFlow: 'accumulating' | 'balanced' | 'draining';
  worstStopArrivals: number;
  occupancyAfterStop: number;
  requiredSlots: number;
  capacity: number | null;
  /** 仅判断本次停机及预留槽位，不代表能无限期运行。 */
  capacitySufficient: boolean | null;
  capacityShortfall: number | null;
  /** 正常连续运行至耗尽预留以外空槽的平均速率估算；无容量或无正积累时为 null。 */
  normalFillTimeSec: number | null;
  canDrainWhileUpstreamRuns: boolean;
  /** 恢复运行后排空全部物料的平均速率估算；非空且无追赶余量时为 null。 */
  downstreamCatchupTimeSec: number | null;
  assumptions: string[];
  warnings: string[];
}

function finiteNonnegative(name: string, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} 必须是有限非负数。`);
  }
}

function count(name: string, value: number): void {
  finiteNonnegative(name, value);
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} 必须是非负安全整数。`);
}

/** 非法输入或超出数值表示范围时抛出 RangeError；所有输入必须由调用方明确提供。 */
export function analyzeBufferCapacity(input: BufferCapacityInput): BufferCapacityResult {
  if (!input || typeof input !== 'object') throw new RangeError('必须明确提供缓存容量分析参数。');
  for (const name of ['upstreamCycleSec', 'downstreamCycleSec'] as const) {
    finiteNonnegative(name, input[name]);
    if (input[name] === 0) throw new RangeError(`${name} 必须大于零。`);
  }
  finiteNonnegative('downstreamStopSec', input.downstreamStopSec);
  for (const name of ['initialOccupancy', 'inTransit', 'reserveSlots'] as const) count(name, input[name]);
  if (input.capacity !== undefined) count('capacity', input.capacity);

  const arrivalRatePerSec = 1 / input.upstreamCycleSec;
  const departureRatePerSec = 1 / input.downstreamCycleSec;
  const arrivalRatePerMin = 60 / input.upstreamCycleSec;
  const departureRatePerMin = 60 / input.downstreamCycleSec;
  // 按节拍差计算，避免两个相近倒数相减掩盖真实不平衡。
  const netAccumulationPerSec = ((input.downstreamCycleSec - input.upstreamCycleSec)
    / input.downstreamCycleSec) / input.upstreamCycleSec;
  const netAccumulationPerMin = netAccumulationPerSec * 60;
  if (![arrivalRatePerSec, departureRatePerSec, arrivalRatePerMin, departureRatePerMin,
    netAccumulationPerSec, netAccumulationPerMin].every(Number.isFinite)) {
    throw new RangeError('节拍过小，计算速率超出有限数值范围。');
  }
  const normalFlow = input.upstreamCycleSec < input.downstreamCycleSec ? 'accumulating'
    : input.upstreamCycleSec > input.downstreamCycleSec ? 'draining' : 'balanced';
  const worstStopArrivals = Math.ceil(input.downstreamStopSec / input.upstreamCycleSec);
  const initialCommitted = input.initialOccupancy + input.inTransit;
  const occupancyAfterStop = initialCommitted + worstStopArrivals;
  const requiredSlots = occupancyAfterStop + input.reserveSlots;
  count('停机所需槽位', requiredSlots);
  const capacity = input.capacity ?? null;
  const capacitySufficient = capacity === null ? null : capacity >= requiredSlots;
  const capacityShortfall = capacity === null ? null : Math.max(0, requiredSlots - capacity);
  const normalFillTimeSec = capacity === null || normalFlow !== 'accumulating' ? null
    : Math.max(0, capacity - initialCommitted - input.reserveSlots) / netAccumulationPerSec;
  const canDrainWhileUpstreamRuns = normalFlow === 'draining';
  const downstreamCatchupTimeSec = occupancyAfterStop === 0 ? 0
    : canDrainWhileUpstreamRuns ? occupancyAfterStop / -netAccumulationPerSec : null;
  for (const value of [normalFillTimeSec, downstreamCatchupTimeSec]) {
    if (value !== null && !Number.isFinite(value)) throw new RangeError('时间估算超出有限数值范围。');
  }
  const warnings: string[] = [];
  if (normalFlow === 'accumulating') {
    warnings.push('上游持续快于下游，正常运行也会持续积料；任何有限缓存都不能实现长期节拍平衡，需降速、联锁或提高下游产能。');
  }
  if (!canDrainWhileUpstreamRuns) {
    warnings.push('下游不快于上游；上游持续运行时无法排空已有积料，不能承诺停机后的追赶恢复。');
  }
  if (capacity === null) warnings.push('未提供实际容量，只能给出所需槽位，无法判断容量是否足够或估算正常填满时间。');
  if (capacitySufficient === false) warnings.push(`实际容量不足本次停机及预留需求，缺少 ${capacityShortfall} 个槽位。`);
  return {
    arrivalRatePerSec, departureRatePerSec, arrivalRatePerMin, departureRatePerMin,
    netAccumulationPerSec, netAccumulationPerMin,
    sustainedAccumulationPerMin: Math.max(0, netAccumulationPerMin),
    sustainedBalance: normalFlow !== 'accumulating', normalFlow,
    worstStopArrivals, occupancyAfterStop, requiredSlots, capacity, capacitySufficient,
    capacityShortfall, normalFillTimeSec, canDrainWhileUpstreamRuns, downstreamCatchupTimeSec,
    assumptions: [
      '单件等间隔到达和离开，每个节拍一件；下游停机期间完全不出料，上游维持给定节拍。',
      '离散到件相位未知，采用半开停机时间窗的保守上界 ceil(停机秒数/上游节拍)；零停机时新增到件为零。',
      '初始占用和已放行在途件单独计入；在途件不得与停机期间新增到件重复统计。',
      '预留槽位必须保持空闲；正常填满时间从初始占用加在途件起算，表示耗尽预留以外空槽的时间，不包含停机新增积料。',
      '填满及追赶时间采用平均净速率，不是离散事件时刻保证；追赶按恢复后全部物料排空计算，预留空槽不参与排空。',
      '未假定正常生产的有限时长；本次停机容量足够不等于长期平衡，也未包含重复停机、节拍波动和搬运机构吞吐限制。'
    ],
    warnings
  };
}
