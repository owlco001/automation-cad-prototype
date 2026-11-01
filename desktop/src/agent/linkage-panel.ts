// 联动面板的 HTML 片段（纯字符串，不碰 DOM，便于单测）。
//
// 只负责「把 formatLinkageView 的结论画出来」：
//   - 结论行 + 循环/节拍
//   - 告警（轴没点位、没有步序）——必须有，不能静默
//   - 步序表（步号 / 执行机构 / 点位 / 起止 ms）
// 播放控制不在这里做：时间轴推进由调用方按帧驱动，面板只给稳定 DOM 锚点
// （`data-linkage-play` / `data-linkage-step`），避免前端自己算时间。
//
// 本文件下半部分是**纯逻辑**的播放控制器（不碰 DOM、时钟/raf 可注入）：
// 相邻两帧之间做 ~300ms 线性插值，末帧精确等于目标帧；模块级单例保证同一时刻
// 只有一个联动循环在写场景（切换机型卡片/重建面板时 abort 旧循环）。

import type { LinkageView } from '../machine/linkage-view.ts';

const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export interface LinkagePanelOptions {
  /** 播放按钮是否可用：没有步序或没有循环时间时禁用，而不是点了没反应 */
  canPlay: boolean;
  disabledReason?: string | undefined;
}

export function renderLinkagePanelHtml(view: LinkageView, options: LinkagePanelOptions = { canPlay: true }): string {
  const lines = view.lines
    .map((line) => `<div class="acp-linkage-kv"><span>${escapeHtml(line.label)}</span><b>${escapeHtml(line.value)}</b></div>`)
    .join('');

  const warnings = view.warnings.length > 0
    ? `<div class="acp-linkage-warn">${view.warnings.map((w) => `<div>⚠ ${escapeHtml(w)}</div>`).join('')}</div>`
    : '';

  const rows = view.steps
    .map((step) => `<tr data-linkage-step="${step.stepNo}">`
      + `<td>${step.stepNo}</td>`
      + `<td>${escapeHtml(step.actuator)}</td>`
      + `<td>${escapeHtml(step.point)}</td>`
      + `<td>${step.startMs}</td>`
      + `<td>${step.endMs}</td>`
      + `<td>${step.durationMs}</td>`
      + '</tr>')
    .join('');

  const table = view.steps.length > 0
    ? `<table class="acp-linkage-table"><thead><tr><th>步</th><th>执行机构</th><th>点位</th><th>开始 ms</th><th>结束 ms</th><th>时长 ms</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="acp-linkage-empty">没有步序：该方案未给出动作顺序，播放只能停在原位。</div>';

  const playDisabled = options.canPlay ? '' : ' disabled';
  const playTitle = options.canPlay ? '按 desktop 生成的帧播放' : escapeHtml(options.disabledReason ?? '当前没有可播放的步序');
  const play = `<div class="acp-linkage-controls">`
    + `<button type="button" data-linkage-play${playDisabled} title="${playTitle}">▶ 播放联动</button>`
    + `<span class="acp-linkage-clock" data-linkage-clock>0 / ${view.lines.find((line) => line.label === '循环时间')?.value ?? '—'}</span>`
    + '</div>';

  return `<div class="acp-linkage-panel" data-linkage-panel>`
    + `<div class="acp-linkage-head">${escapeHtml(view.headline)}</div>`
    + lines
    + warnings
    + play
    + table
    + '</div>';
}

// ---------------------------------------------------------------------------
// 联动播放控制器
//
// 设计要点：
//   - 纯逻辑，不碰 DOM：位姿/时间由调用方通过 onSample 消费，时钟与 raf 可注入，
//     因此单测能用假时钟跑完，不必真等 300ms。
//   - 模块级单例：同一时刻只允许一条循环写场景（`window.__cadApplyLinkagePose`
//     是全局写入点，两条 tick 会争抢同一场景）。
//   - 帧间插值：从源帧起 ~300ms 线性混合到目标帧（offsets 与 rotZDeg 同时插值），
//     超过 300ms 的间隔就先到位再保持；末帧/段末返回目标帧本体数值，不停在中间值。
// ---------------------------------------------------------------------------

/** 相邻两帧之间的插值时长（ms）。短步长会被压到步长本身，不会追上下一帧。 */
export const LINKAGE_FRAME_BLEND_MS = 300;

export interface LinkagePose {
  offsets?: Record<string, number[]> | undefined;
  rotZDeg?: Record<string, number> | undefined;
}

/** CLI 的帧把 offsets/rotZDeg 放在顶层，也有 pose:{...} 的形状；两种都认。 */
export interface LinkagePlaybackFrame {
  tMs?: number | undefined;
  stepNo?: number | undefined;
  offsets?: Record<string, number[]> | undefined;
  rotZDeg?: Record<string, number> | undefined;
  pose?: LinkagePose | undefined;
}

export interface LinkageFrameSample {
  /** 时间轴位置（已按循环时长截断） */
  tMs: number;
  /** 当前高亮的步号：取已开始的最后一帧，和时钟口径一致 */
  stepNo: number | undefined;
  /** 插值后的位姿；末帧精确等于目标帧 */
  pose: LinkagePose;
}

export type LinkagePlaybackEndReason = 'end' | 'abort';

export interface LinkagePlaybackOptions {
  frames: readonly LinkagePlaybackFrame[];
  cycleMs?: number | undefined;
  /** 帧间插值时长，默认 LINKAGE_FRAME_BLEND_MS */
  blendMs?: number | undefined;
  /** 注入点：默认 performance.now / requestAnimationFrame / cancelAnimationFrame */
  now?: (() => number) | undefined;
  raf?: ((callback: (time: number) => void) => number) | undefined;
  cancelRaf?: ((handle: number) => void) | undefined;
  onSample?: ((sample: LinkageFrameSample) => void) | undefined;
  /**
   * onSample 抛错时的上报口（不吞错误）。播放一定先结束（onDone('abort')）再上报；
   * 没给这个口就把错误抛回 tick 的调用方。
   */
  onError?: ((error: unknown) => void) | undefined;
  onDone?: ((reason: LinkagePlaybackEndReason) => void) | undefined;
}

export interface LinkagePlayback {
  /** 立刻停掉：之后即便还有排队的回调也不再 onSample（不再写场景） */
  abort(): void;
  readonly finished: boolean;
}

const isNumberArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'number' && Number.isFinite(item));

/** 统一两种帧形状；没有位姿时给空对象，别让调用方判 undefined */
export function resolveLinkagePose(frame: LinkagePlaybackFrame | undefined): LinkagePose {
  const nested = frame?.pose;
  if (nested && typeof nested === 'object') return nested;
  const pose: LinkagePose = {};
  if (frame?.offsets) pose.offsets = frame.offsets;
  if (frame?.rotZDeg) pose.rotZDeg = frame.rotZDeg;
  return pose;
}

const copyPose = (pose: LinkagePose): LinkagePose => {
  const out: LinkagePose = {};
  if (pose.offsets) out.offsets = { ...pose.offsets };
  if (pose.rotZDeg) out.rotZDeg = { ...pose.rotZDeg };
  return out;
};

const lerp = (a: number, b: number, alpha: number): number => {
  if (alpha <= 0) return a;
  if (alpha >= 1) return b;
  return a + (b - a) * alpha;
};

// 开发态守卫：只告警、不改数值。
// **不要**在这里读 `process.env.NODE_ENV`：本文件会进渲染进程的扩展包，而
// electron 的 webPreferences 是 nodeIntegration:false + contextIsolation:true，
// 页面世界根本没有 `process`；本项目又按 Vite **库模式**（iife）构建，这个表达式
// 不会被常量折叠，跑到就抛 `ReferenceError: process is not defined`。
// 于是去重靠集合本身：同一零件只提示一次，不引入任何 `process` 引用，
// 生产包里告警最多一条、只进控制台，不进 UI。
const warnedWrappedParts = new Set<string>();

function warnWrappedAngle(part: string, from: number, to: number): void {
  const delta = to - from;
  if (Math.abs(delta) <= 180) return;
  if (warnedWrappedParts.has(part)) return; // 每帧都插值，同一零件只提示一次
  warnedWrappedParts.add(part);
  console.warn(
    `[linkage] 转角插值输入疑似回绕：${part} ${from}° → ${to}°（Δ=${delta.toFixed(1)}°）。`
    + 'blendLinkagePose 要求输入是未回绕的连续角度；按线性插值会反向转 '
    + `${(360 - Math.abs(delta)).toFixed(1)}°，请先在产生帧的一侧归一化。`
  );
}

/**
 * 线性混合两帧位姿：offsets 逐分量、rotZDeg 逐零件。
 * alpha<=0 返回源帧、alpha>=1 返回目标帧**本体数值**（不是 a+(b-a)*1 的浮点近似）。
 *
 * 转角约定（重要）：**输入必须是未回绕的连续角度**（例如 0°→90°→180°，而不是
 * 350°→10°）。本函数只做线性插值，不做最短弧归一化：对「连续旋转轴」来说，
 * 350°→10° 的 340° 反向转反而是错的语义，只有调用方知道该走哪条弧，所以归一化
 * 留给产生帧的那一侧（`poseAt` 的三角波每步都从 0 起算，天然连续）。
 * 误用时开发态会打一条告警（见 `warnWrappedAngle`，同一零件只报一次、只写控制台）。
 * 告警不读 `process.env`（渲染进程里没有 `process`，库模式构建也不折叠），
 * 因此不改变任何生产语义，也不会让播放循环抛错。
 */
export function blendLinkagePose(from: LinkagePose, to: LinkagePose, alpha: number): LinkagePose {
  if (alpha <= 0) return copyPose(from);
  if (alpha >= 1) return copyPose(to);
  const out: LinkagePose = {};

  const offsetKeys = new Set([...Object.keys(from.offsets ?? {}), ...Object.keys(to.offsets ?? {})]);
  if (offsetKeys.size > 0) {
    const offsets: Record<string, number[]> = {};
    for (const key of offsetKeys) {
      const a = from.offsets?.[key];
      const b = to.offsets?.[key];
      if (isNumberArray(a) && isNumberArray(b) && a.length === b.length) {
        offsets[key] = b.map((value, index) => lerp(a[index] ?? 0, value, alpha));
      } else {
        // 只有一侧有时不去“淡出”，直接跟着出现/保留，避免零件被拉到 0
        const single = isNumberArray(a) ? a : isNumberArray(b) ? b : undefined;
        if (single) offsets[key] = [...single];
      }
    }
    if (Object.keys(offsets).length > 0) out.offsets = offsets;
  }

  const rotKeys = new Set([...Object.keys(from.rotZDeg ?? {}), ...Object.keys(to.rotZDeg ?? {})]);
  if (rotKeys.size > 0) {
    const rotZDeg: Record<string, number> = {};
    for (const key of rotKeys) {
      const a = from.rotZDeg?.[key];
      const b = to.rotZDeg?.[key];
      if (typeof a === 'number' && typeof b === 'number') {
        // 不做最短弧归一化：输入约定是未回绕的连续角度，误用只在开发态告警
        warnWrappedAngle(key, a, b);
        rotZDeg[key] = lerp(a, b, alpha);
      } else {
        const single = typeof a === 'number' ? a : typeof b === 'number' ? b : undefined;
        if (typeof single === 'number') rotZDeg[key] = single;
      }
    }
    if (Object.keys(rotZDeg).length > 0) out.rotZDeg = rotZDeg;
  }

  return out;
}

export interface LinkageTimelineEntry {
  frame: LinkagePlaybackFrame;
  index: number;
  tMs: number;
}

/** 在时间轴上取样本：段内插值，段末/时间轴末端精确等于目标帧 */
export function sampleLinkageFrame(
  timeline: readonly LinkageTimelineEntry[],
  tMs: number,
  blendMs: number = LINKAGE_FRAME_BLEND_MS
): LinkageFrameSample {
  const first = timeline[0];
  if (!first) return { tMs, stepNo: undefined, pose: {} };
  if (timeline.length === 1) return { tMs, stepNo: first.frame.stepNo, pose: resolveLinkagePose(first.frame) };

  let index = 0;
  while (index + 1 < timeline.length && (timeline[index + 1] as LinkageTimelineEntry).tMs <= tMs) index += 1;
  const from = timeline[index] as LinkageTimelineEntry;
  const to = timeline[index + 1];
  if (!to) return { tMs, stepNo: from.frame.stepNo, pose: resolveLinkagePose(from.frame) };

  const gap = to.tMs - from.tMs;
  const span = Math.min(blendMs, gap);
  const alpha = span > 0 ? Math.min(1, Math.max(0, (tMs - from.tMs) / span)) : 1;
  return {
    tMs,
    stepNo: from.frame.stepNo,
    pose: blendLinkagePose(resolveLinkagePose(from.frame), resolveLinkagePose(to.frame), alpha)
  };
}

/**
 * 建一条播放循环并立刻启动（第一次 raf 里给 t=0 的帧）。
 * 单测请自己注入 now/raf/cancelRaf；生产用默认实现。
 */
export function createLinkagePlayback(options: LinkagePlaybackOptions): LinkagePlayback {
  const now = options.now ?? (() => performance.now());
  const raf = options.raf ?? ((callback: (time: number) => void) => requestAnimationFrame(callback));
  const cancelRaf = options.cancelRaf ?? ((handle: number) => {
    // 不在渲染进程里（单测/主进程）时没有 cancelAnimationFrame：abort 绝不能因此抛错
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  });
  const blendInput = options.blendMs;
  const blendMs = typeof blendInput === 'number' && Number.isFinite(blendInput) && blendInput >= 0
    ? blendInput
    : LINKAGE_FRAME_BLEND_MS;

  const timeline: LinkageTimelineEntry[] = options.frames
    .map((frame, index) => ({ frame, index, tMs: Math.max(0, Number(frame?.tMs ?? 0) || 0) }))
    .filter((entry) => Number.isFinite(entry.tMs))
    .sort((a, b) => (a.tMs - b.tMs) || (a.index - b.index));

  const declared = Number(options.cycleMs ?? 0);
  const lastT = timeline.length > 0 ? (timeline[timeline.length - 1] as LinkageTimelineEntry).tMs : 0;
  const total = Number.isFinite(declared) && declared > 0 ? declared : lastT;

  const started = now();
  let finished = false;
  let aborted = false;
  let handle: number | null = null;

  const stop = (reason: LinkagePlaybackEndReason): void => {
    if (finished) return;
    finished = true;
    if (handle !== null) {
      const pending = handle;
      handle = null;
      cancelRaf(pending);
    }
    options.onDone?.(reason);
  };

  const tick = (time: number): void => {
    handle = null;
    // abort 之后旧循环绝不再碰场景：排队的回调到这里直接咽掉
    if (aborted || finished) return;
    const stamped = typeof time === 'number' && Number.isFinite(time) ? time : now();
    const tMs = total > 0 ? Math.min(total, Math.max(0, stamped - started)) : 0;
    try {
      // 采样也在 try 里：`sampleLinkageFrame` → `resolveLinkagePose` / `blendLinkagePose`
      // 同样可能抛（坏帧、getter 抛错、将来插值逻辑改动）。若留在 try 外，
      // 异常会直接从 rAF 回调冒出去，finished 保持 false、单例永远 active，
      // 播放按钮永久 disabled —— 与 onSample 抛错是同一个故障模式，必须同一条收尾。
      const sample = sampleLinkageFrame(timeline, tMs, blendMs);
      options.onSample?.(sample);
    } catch (error) {
      // 采样或消费方（写场景 / 套位姿）抛错时也必须收尾：否则 finished 保持 false、
      // 单例仍指向这条循环，hasActiveLinkagePlayback() 永远 true，播放按钮再也点不动。
      aborted = true;
      stop('abort');
      if (options.onError) {
        options.onError(error);
        return;
      }
      // 没有上报口就照样抛回调用方——错误不吞，只是播放已经结束
      throw error;
    }
    if (aborted) return;
    if (tMs >= total) {
      stop('end');
      return;
    }
    handle = raf(tick);
  };

  const playback: LinkagePlayback = {
    get finished() {
      return finished;
    },
    abort() {
      if (finished) return;
      aborted = true;
      stop('abort');
    }
  };

  if (timeline.length === 0) {
    // 没有帧就别假装在播：立刻结束，调用方据此还原按钮
    finished = true;
    options.onDone?.('end');
    return playback;
  }

  handle = raf(tick);
  return playback;
}

// 模块级单例：同一时刻只允许一条联动循环写场景
let activeLinkagePlayback: LinkagePlayback | null = null;

/** 开播前先掐掉上一条（切换机型卡片 / 重开面板都走这里） */
export function startLinkagePlayback(options: LinkagePlaybackOptions): LinkagePlayback {
  const previous = activeLinkagePlayback;
  activeLinkagePlayback = null;
  previous?.abort();

  let started: LinkagePlayback | null = null;
  started = createLinkagePlayback({
    ...options,
    onDone: (reason) => {
      if (started && activeLinkagePlayback === started) activeLinkagePlayback = null;
      options.onDone?.(reason);
    }
  });
  activeLinkagePlayback = started.finished ? null : started;
  return started;
}

/** 切卡片 / 关闭重建面板 / 清空对话时调用：旧循环之后不再写 __cadApplyLinkagePose */
export function abortLinkagePlayback(): void {
  const current = activeLinkagePlayback;
  activeLinkagePlayback = null;
  current?.abort();
}

/** 自检用：当前是否还有活跃联动循环 */
export function hasActiveLinkagePlayback(): boolean {
  return activeLinkagePlayback !== null;
}
