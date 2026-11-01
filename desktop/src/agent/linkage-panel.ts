// 联动面板的 HTML 片段（纯字符串，不碰 DOM，便于单测）。
//
// 只负责「把 formatLinkageView 的结论画出来」：
//   - 结论行 + 循环/节拍
//   - 告警（轴没点位、没有步序）——必须有，不能静默
//   - 步序表（步号 / 执行机构 / 点位 / 起止 ms）
// 播放控制不在这里做：时间轴推进由调用方按帧驱动，面板只给稳定 DOM 锚点
// （`data-linkage-play` / `data-linkage-step`），避免前端自己算时间。

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
  disabledReason?: string;
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
