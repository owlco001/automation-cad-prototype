// 联动视图的**纯数据**格式化：不碰 DOM、不碰 three.js，便于单测与复用。
//
// 为什么单独一层：Qt 的 LinkageDialog 与 Electron 的联动面板要显示同一套结论，
// 两边各自拼字符串迟早会漂移（一边写“12 轴”一边写“12 个执行机构”）。
// 这里只接受 desktop `buildLinkage()` 的输出，输出给人读的几行 + 逐步时序表。

export interface LinkageSummaryLine {
  label: string;
  value: string;
}

export interface LinkageStepRow {
  stepNo: number;
  actuator: string;
  point: string;
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface LinkageView {
  /** 一句话结论，可直接放标题下 */
  headline: string;
  lines: LinkageSummaryLine[];
  steps: LinkageStepRow[];
  /** 需要用户注意的问题（点位缺 IO、步序与联动对不上等） */
  warnings: string[];
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export function formatLinkageView(linkage: any): LinkageView {
  const cycleMs = num(linkage?.cycleMs);
  const axes: any[] = Array.isArray(linkage?.axes) ? linkage.axes : [];
  // CLI 实际输出用 axisCount（不是 axes 数组）；两者都认，避免面板显示成 0 轴
  const axisCount = num(linkage?.axisCount) ?? axes.length;
  const steps: any[] = Array.isArray(linkage?.steps) ? linkage.steps : [];

  const rows: LinkageStepRow[] = steps.map((step, index) => {
    const startMs = num(step?.startMs) ?? 0;
    const rawEnd = num(step?.endMs);
    const durationMs = num(step?.durationMs) ?? (rawEnd === null ? 0 : rawEnd - startMs);
    const endMs = rawEnd ?? startMs + durationMs;
    const ioList: unknown[] = Array.isArray(step?.io) ? step.io : [];
    return {
      stepNo: num(step?.stepNo) ?? index + 1,
      actuator: String(step?.actuatorId ?? step?.actuator ?? step?.partId ?? ''),
      point: String(step?.point ?? ioList.join(' / ')),
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      durationMs: Math.round(durationMs)
    };
  });

  const warnings: string[] = [];
  const missingIo = axes.filter((axis) => !axis?.point || axis?.point === '');
  if (missingIo.length > 0) {
    warnings.push(`${missingIo.length} 个运动轴没有点位（${missingIo.map((axis) => String(axis?.id ?? axis?.partId ?? '?')).slice(0, 3).join('、')}${missingIo.length > 3 ? ' 等' : ''}），联动播放不会驱动它们`);
  }
  if (steps.length === 0) {
    warnings.push('没有步序：该方案的执行机构未给出动作顺序，播放只能停在原位');
  }

  const headline = cycleMs === null
    ? `联动时间线：${axisCount} 轴 / ${steps.length} 步（缺循环时间，无法播放）`
    : `${axisCount} 轴 / ${steps.length} 步 / 循环 ${(cycleMs / 1000).toFixed(2)} s`;

  return {
    headline,
    lines: [
      { label: '运动轴', value: `${axisCount} 个` },
      { label: '步序', value: `${steps.length} 步` },
      { label: '循环时间', value: cycleMs === null ? '未给出' : `${cycleMs} ms` },
      { label: '节拍', value: cycleMs === null || cycleMs <= 0 ? '—' : `${(60000 / cycleMs).toFixed(1)} 件/分钟` }
    ],
    steps: rows,
    warnings
  };
}
