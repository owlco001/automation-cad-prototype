import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AGENT_CONTINUE_ACTION,
  PENDING_HINT_LIMIT,
  REPEATED_READS_TEXT,
  budgetReasonText,
  renderAgentTurnOutcome,
  toAgentChatOutcome,
  truncatePendingHint,
  turnOutcomeText
} from '../../src/agent/turn-outcome-view.ts';

const LIMIT_BUDGET = { base: 6, effective: 12, reason: 'write' };
const LIMIT_OUTCOME = {
  iterations: 12,
  budget: LIMIT_BUDGET,
  stopped: 'iteration_limit',
  pendingHint: '已应用方案但还没生成 PLC'
};

/** 允许出现的标签形态（属性值里出现裸引号/尖括号即视为逃逸，不匹配）。 */
const ALLOWED_TAG_PATTERNS = [
  /<span data-agent-continue="(?:iteration_limit|repeated_reads)" title="[^"<>]*">/g,
  /<\/span>/g,
  /<div class="acp-plan-actions">/g,
  /<\/div>/g,
  /<button type="button" class="acp-btn acp-btn-ghost" data-agent-continue-send="[^"<>]*">/g,
  /<\/button>/g
];

function stripAllowedTags(html) {
  let rest = html;
  for (const pattern of ALLOWED_TAG_PATTERNS) rest = rest.replace(pattern, '');
  return rest;
}

test('无 stopped：不返回任何提示（null）', () => {
  assert.equal(renderAgentTurnOutcome({ iterations: 3, budget: { base: 6, effective: 6, reason: 'read-only' } }), null);
  assert.equal(renderAgentTurnOutcome(null), null);
  assert.equal(renderAgentTurnOutcome(undefined), null);
  assert.equal(turnOutcomeText({ iterations: 3, budget: LIMIT_BUDGET }), null);
});

test('iteration_limit + pendingHint：文案带步数与待办，并挂【继续】', () => {
  const html = renderAgentTurnOutcome(LIMIT_OUTCOME);
  assert.equal(typeof html, 'string');
  assert.match(html, /已达本轮上限（12 步）/);
  assert.match(html, /已应用方案但还没生成 PLC/);
  assert.match(html, /data-agent-continue-send="继续"/);
  // IPC 侧的同一份文案（不含标签）
  assert.equal(turnOutcomeText(LIMIT_OUTCOME), '已达本轮上限（12 步）· 已应用方案但还没生成 PLC');
});

test('repeated_reads：用固定文案，且绝不说「已达本轮上限」', () => {
  const html = renderAgentTurnOutcome({
    iterations: 5,
    budget: LIMIT_BUDGET,
    stopped: 'repeated_reads',
    pendingHint: '再查一次 search_components'
  });
  assert.equal(typeof html, 'string');
  assert.ok(html.includes(REPEATED_READS_TEXT));
  assert.ok(!html.includes('已达本轮上限'));
  assert.equal(turnOutcomeText({ stopped: 'repeated_reads' }), REPEATED_READS_TEXT);
  // 固定文案：传进来的 pendingHint 不该被当成「待办」再念一遍
  assert.ok(!html.includes('再查一次 search_components'));
});

test('超长 pendingHint 截到 200 字，且不切坏中文', () => {
  const long = '已应用方案但还没生成 PLC，'.repeat(40); // 480 字
  const cut = truncatePendingHint(long);
  assert.equal(Array.from(cut).length, PENDING_HINT_LIMIT);
  assert.ok(cut.endsWith('…'));
  // 不要出现替换字符 / 半个代理对
  assert.ok(!cut.includes('\uFFFD'));
  assert.equal(Buffer.from(cut, 'utf8').toString('utf8'), cut);
  const html = renderAgentTurnOutcome({ ...LIMIT_OUTCOME, pendingHint: long });
  assert.ok(!html.includes(long));
  assert.ok(Array.from(html).length > 0);
  // emoji（代理对）同样按码点截断，不会劈成两半
  const emoji = truncatePendingHint('🚀'.repeat(300));
  assert.equal(Array.from(emoji).length, PENDING_HINT_LIMIT);
  assert.equal((emoji.match(/🚀/gu) ?? []).length, PENDING_HINT_LIMIT - 1);
});

test('渲染结果带 data-agent-continue，且不含未转义的 < >（防注入）', () => {
  const html = renderAgentTurnOutcome({
    ...LIMIT_OUTCOME,
    pendingHint: '<img src=x onerror=alert(1)>下一步：生成 PLC'
  });
  assert.ok(html.includes('data-agent-continue="iteration_limit"'));
  const rest = stripAllowedTags(html);
  assert.ok(!rest.includes('<'), `残留未转义的 <：${rest}`);
  assert.ok(!rest.includes('>'), `残留未转义的 >：${rest}`);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  // 引号也要转义，避免提前闭合属性
  const quoted = renderAgentTurnOutcome({ ...LIMIT_OUTCOME, pendingHint: '" onmouseover="alert(1)' });
  assert.ok(quoted.includes('&quot; onmouseover=&quot;alert(1)'));
  const quotedRest = stripAllowedTags(quoted);
  assert.ok(!quotedRest.includes('<') && !quotedRest.includes('>'), `残留标签字符：${quotedRest}`);
});

test('budget.reason 四档都映射成人能看懂的中文', () => {
  assert.match(budgetReasonText('write', { base: 6, effective: 12 }), /写操作.*12 步/);
  assert.match(budgetReasonText('long-plan', { base: 6, effective: 12 }), /计划.*12 步/);
  assert.match(budgetReasonText('commission', { base: 6, effective: 12 }), /联调.*12 步/);
  assert.match(budgetReasonText('read-only', { base: 6, effective: 6 }), /只读.*6 步/);
  // 未知原因退回基础档，不返回空串/英文码
  assert.match(budgetReasonText(undefined, { base: 6, effective: 6 }), /只读/);
  assert.match(budgetReasonText('weird', { base: 4, effective: 4 }), /基础预算 4 步/);
  const html = renderAgentTurnOutcome(LIMIT_OUTCOME);
  assert.ok(html.includes('title="本轮有写操作，预算上抬到 12 步"'));
});

test('IPC 回执：只有 stopped 存在时才带 continueHint / nextAction', () => {
  const idle = toAgentChatOutcome({ iterations: 3, budget: { base: 6, effective: 6, reason: 'read-only' } });
  assert.equal(idle.stopped, undefined);
  assert.equal(idle.continueHint, undefined);
  assert.equal(idle.nextAction, undefined);
  assert.deepEqual(idle.budget, { base: 6, effective: 6, reason: 'read-only' });

  const limited = toAgentChatOutcome({ ...LIMIT_OUTCOME, pendingHint: '生成 PLC' });
  assert.equal(limited.stopped, 'iteration_limit');
  assert.equal(limited.iterations, 12);
  assert.equal(limited.continueHint, '已达本轮上限（12 步）· 生成 PLC');
  assert.equal(limited.nextAction, AGENT_CONTINUE_ACTION);
  assert.equal(limited.pendingHint, '生成 PLC');

  const tooLong = toAgentChatOutcome({ ...LIMIT_OUTCOME, pendingHint: '长'.repeat(500) });
  assert.equal(Array.from(tooLong.pendingHint).length, PENDING_HINT_LIMIT);

  assert.equal(toAgentChatOutcome(null), null);
});
