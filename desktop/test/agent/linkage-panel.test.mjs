import assert from 'node:assert/strict';
import test from 'node:test';
import { formatLinkageView } from '../../src/machine/linkage-view.ts';
import { renderLinkagePanelHtml } from '../../src/agent/linkage-panel.ts';

const base = () => formatLinkageView({
  cycleMs: 1890,
  axes: [{ id: 'st1-gripper-1', point: 'ST1-GRIP-A1' }],
  steps: [{ stepNo: 1, actuator: 'st1-gripper-1', point: 'ST1-GRIP-A1', startMs: 0, durationMs: 280 }]
});

test('面板渲染：结论、步序行、播放按钮都在', () => {
  const html = renderLinkagePanelHtml(base(), { canPlay: true });
  assert.match(html, /1 轴 \/ 1 步 \/ 循环 1\.89 s/);
  assert.match(html, /data-linkage-play/);
  assert.match(html, /data-linkage-step="1"/);
  assert.match(html, /ST1-GRIP-A1/);
  assert.doesNotMatch(html, /disabled/);
});

test('不可播放时按钮禁用并给出原因（不能点了没反应）', () => {
  const html = renderLinkagePanelHtml(base(), { canPlay: false, disabledReason: '没有步序' });
  assert.match(html, /disabled/);
  assert.match(html, /没有步序/);
});

test('没有步序时表格位置给空态说明，而不是空表', () => {
  const view = formatLinkageView({ cycleMs: 1000, axes: [], steps: [] });
  const html = renderLinkagePanelHtml(view, { canPlay: false });
  assert.match(html, /没有步序/);
  assert.match(html, /acp-linkage-empty/);
  assert.doesNotMatch(html, /<tbody><\/tbody>/);
});

test('告警照原样显示且经过转义', () => {
  const view = formatLinkageView({ cycleMs: 1000, axes: [{ id: '<b>x</b>' }], steps: [] });
  const html = renderLinkagePanelHtml(view, { canPlay: false });
  assert.match(html, /acp-linkage-warn/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
});
