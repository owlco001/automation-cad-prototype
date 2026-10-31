// 3D 联动调试：把「几何里已经算好的运动轴」变成一条可播放的时间线。
//
// 数据来源全是现成的，不另造一套：
//   - `geometry.moving`：生成器为每个执行机构算出的轴（kind / strokeMm / rangeDeg /
//     durationMs / partIds / pivot / axis / IO 点号）
//   - `document.throughput`：节拍（件/分钟）→ 一个循环的时长
//   - 轴上的 `points`：与 PLC IO 表同名的点位，联动时用来点亮「此刻哪些输出为 ON」
//
// 这个模块是纯函数：给定几何 + 时刻，算出每个零件该位移/转多少、哪些 IO 该亮。
// Qt 只负责把这些数字画出来，不自己算运动（和几何同一条纪律）。

export type Vec3 = [number, number, number];

export interface MovingAxis {
  actuatorId: string;
  stationId: string;
  kind: 'cylinder' | 'gripper' | 'rotary' | string;
  partIds: string[];
  strokeMm: number;
  rangeDeg: number;
  home: string;
  durationMs: number;
  points?: Record<string, string>;
  axis?: Vec3;
  pivot?: Vec3;
  jaws?: Array<{ partId: string; sign: number }>;
}

export interface LinkageStep {
  /** 程序步号：与 PLC 步序一一对应（S1、S2…），顺序与 startMs 一致 */
  stepNo: number;
  actuatorId: string;
  stationId: string;
  kind: string;
  /** 该步在循环中的起止时刻（ms） */
  startMs: number;
  endMs: number;
  /** 这一步会让哪些 IO 点变为 ON（来自几何里的 points） */
  io: string[];
  /** 动作幅度：气缸/气爪为 mm，旋转为 deg */
  amount: number;
}

export interface Linkage {
  cycleMs: number;
  steps: LinkageStep[];
  axes: MovingAxis[];
  /** 零件初始中心（旋转轴要绕 pivot 转，零件中心会跟着走） */
  centers: Record<string, Vec3>;
  /** 轴没给 durationMs 时的兜底值，写出来便于核对 */
  defaultDurationMs: number;
}

export interface Pose {
  /** 每个零件相对初始位置的位移（mm），只列有位移的 */
  offsets: Record<string, Vec3>;
  /** 每个零件绕自身 Z 的转角（deg），只列有转角的 */
  rotZDeg: Record<string, number>;
  /** 此刻处于 ON 的 IO 点 */
  activeIO: string[];
  /** 当前处在哪些步里（actuatorId#stepIndex） */
  activeSteps: string[];
  phase: number;
}

const DEFAULT_DURATION_MS = 400;

const ioOf = (axis: MovingAxis): string[] => Object.values(axis.points ?? {}).filter((value) => typeof value === 'string');

/**
 * 把轴排成一条循环时间线。
 *
 * 排法：同一工位内的轴**顺序执行**（气爪→气缸→旋转这类），
 * 不同工位按索引错开相同间隔（流水线节拍），于是整机看起来是连续流动的。
 * 这是「示意级联动」：不是伺服曲线，也不做加减速，只保证
 * 时长、行程、IO 三件事和几何/PLC 对得上。
 */
export function buildLinkage(geometry: any, options: { cycleMs?: number } = {}): Linkage {
  const axes: MovingAxis[] = Array.isArray(geometry?.moving) ? geometry.moving : [];
  const stations: string[] = Array.isArray(geometry?.stations)
    ? geometry.stations.map((station: any) => String(station?.id ?? station?.name ?? '')).filter(Boolean)
    : [];
  const stationOrder = new Map<string, number>();
  stations.forEach((id, index) => stationOrder.set(id, index));
  for (const axis of axes) {
    if (!stationOrder.has(axis.stationId)) stationOrder.set(axis.stationId, stationOrder.size);
  }

  // 每站内部顺序执行；站与站之间按「每站时长」错开
  const perStation = new Map<string, MovingAxis[]>();
  for (const axis of axes) {
    const list = perStation.get(axis.stationId) ?? [];
    list.push(axis);
    perStation.set(axis.stationId, list);
  }
  const stationSpan = new Map<string, number>();
  for (const [stationId, list] of perStation) {
    const span = list.reduce((sum, axis) => sum + (Number(axis.durationMs) || DEFAULT_DURATION_MS), 0);
    stationSpan.set(stationId, span);
  }
  const stationCount = Math.max(1, stationOrder.size);
  const naturalCycle = Math.max(...[...stationSpan.values()], 0) + Math.max(0, stationCount - 1) * Math.max(...[...stationSpan.values()], 0) / stationCount;

  const cycleMs = Number.isFinite(options.cycleMs) && Number(options.cycleMs) > 0
    ? Number(options.cycleMs)
    : Math.round(naturalCycle);

  // 每站在循环里占据的窗口：[offset, offset + span]
  const spanSlots = [...stationSpan.entries()].sort((a, b) => (stationOrder.get(a[0]) ?? 0) - (stationOrder.get(b[0]) ?? 0));
  const maxSpan = Math.max(1, ...spanSlots.map(([, span]) => span));
  const steps: LinkageStep[] = [];
  spanSlots.forEach(([stationId, span], slotIndex) => {
    // 站错开：让最后一站的结束正好落在循环末尾
    const offset = cycleMs > maxSpan ? ((cycleMs - span) * slotIndex) / Math.max(1, spanSlots.length - 1) : 0;
    let cursor = offset;
    for (const axis of perStation.get(stationId) ?? []) {
      const duration = Number(axis.durationMs) || DEFAULT_DURATION_MS;
      const amount = axis.kind === 'rotary' ? Number(axis.rangeDeg) || 0 : Number(axis.strokeMm) || 0;
      steps.push({
        stepNo: 0,   // 排序后再编号，避免站间错开导致编号乱序
        actuatorId: axis.actuatorId,
        stationId,
        kind: axis.kind,
        startMs: Math.round(cursor),
        endMs: Math.round(cursor + duration),
        io: ioOf(axis),
        amount
      });
      cursor += duration;
    }
  });
  steps.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  steps.forEach((step, index) => { step.stepNo = index + 1; });

  const centers: Record<string, Vec3> = {};
  for (const part of (Array.isArray(geometry?.parts) ? geometry.parts : [])) {
    const center = Array.isArray(part?.center) ? part.center : null;
    if (part?.id && center) centers[String(part.id)] = [Number(center[0]) || 0, Number(center[1]) || 0, Number(center[2]) || 0];
  }

  return { cycleMs, steps, axes, centers, defaultDurationMs: DEFAULT_DURATION_MS };
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** 单个动作的归一化进度 0..1（在步窗口内线性推进，窗口外为 0 或 1） */
const progressOf = (step: LinkageStep, tMs: number): number => {
  if (step.endMs <= step.startMs) return tMs >= step.endMs ? 1 : 0;
  return clamp01((tMs - step.startMs) / (step.endMs - step.startMs));
};

/**
 * 三角波：先到位再返回（气缸伸出/缩回、气爪闭合/张开）。
 * 旋转轴不回位——分度台是「转过去停在那儿」，下一个循环再转。
 */
const travelProfile = (step: LinkageStep, tMs: number): number => {
  const progress = progressOf(step, tMs);
  if (step.kind === 'rotary') return progress;
  return progress <= 0.5 ? progress * 2 : (1 - progress) * 2;
};

export function poseAt(linkage: Linkage, tMs: number): Pose {
  const time = ((tMs % linkage.cycleMs) + linkage.cycleMs) % linkage.cycleMs;
  const offsets: Record<string, Vec3> = {};
  const rotZDeg: Record<string, number> = {};
  const activeIO = new Set<string>();
  const activeSteps: string[] = [];

  linkage.steps.forEach((step, index) => {
    const inWindow = time >= step.startMs && time < step.endMs;
    if (inWindow) {
      for (const point of step.io) activeIO.add(point);
      activeSteps.push(`${step.actuatorId}#${index}`);
    }
    const amount = travelProfile(step, time);
    if (amount <= 0) return;
    const axis = linkage.axes.find((item) => item.actuatorId === step.actuatorId);
    if (!axis) return;
    if (step.kind === 'rotary') {
      // 分度台绕自身轴转：零件中心跟着绕 pivot 走（不是原地自转，否则扫掠检测会低估）
      const pivot = Array.isArray(axis.pivot) ? axis.pivot : [0, 0, 0];
      const deg = (Number(axis.rangeDeg) || 0) * amount;
      const radians = (deg * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      for (const partId of axis.partIds) {
        const center = linkage.centers[partId];
        rotZDeg[partId] = round1(deg);
        if (!center) continue;
        const dx = center[0] - (pivot[0] ?? 0);
        const dy = center[1] - (pivot[1] ?? 0);
        offsets[partId] = [
          round1(dx * cos - dy * sin - dx),
          round1(dx * sin + dy * cos - dy),
          0
        ];
      }
      return;
    }
    if (step.kind === 'gripper') {
      // 气爪：两片夹爪相向移动，各走 strokeMm/2
      const jaws = Array.isArray(axis.jaws) ? axis.jaws : axis.partIds.map((partId, i) => ({ partId, sign: i === 0 ? 1 : -1 }));
      const half = (Number(axis.strokeMm) || 0) / 2;
      for (const jaw of jaws) {
        const shift = -Math.sign(jaw.sign || 1) * half * amount;
        offsets[jaw.partId] = [round1(shift), 0, 0];
      }
      return;
    }
    // 气缸：沿自身轴向伸出
    const dir = Array.isArray(axis.axis) ? axis.axis : [0, 0, 1];
    const stroke = (Number(axis.strokeMm) || 0) * amount;
    for (const partId of axis.partIds) {
      offsets[partId] = [round1((dir[0] ?? 0) * stroke), round1((dir[1] ?? 0) * stroke), round1((dir[2] ?? 0) * stroke)];
    }
  });

  return {
    offsets,
    rotZDeg,
    activeIO: [...activeIO].sort(),
    activeSteps,
    phase: linkage.cycleMs > 0 ? round3(time / linkage.cycleMs) : 0
  };
}

const round1 = (value: number): number => Math.round(value * 10) / 10;
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** 从节拍（件/分钟）反推循环时长；没有节拍就返回 null，由调用方决定用什么 */
export function cycleMsFromThroughput(throughputPerMinute: number): number | null {
  if (!Number.isFinite(throughputPerMinute) || throughputPerMinute <= 0) return null;
  return Math.round(60000 / throughputPerMinute);
}
