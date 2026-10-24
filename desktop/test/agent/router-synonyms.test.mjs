import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractQuery, isOffDomainTopic, planReadOnly, planTool, routeIntent, READ_ONLY_TOOLS, WRITE_TOOLS, requiresWriteConfirmation } from '../../src/agent/router.ts';
import { scanUntrusted } from '../../src/agent/guard.ts';

function check(input, intent, tool, args = {}) {
  const match = routeIntent(input);
  assert.equal(match.intent, intent, `${input} 意图应为 ${intent}，实际 ${match.intent}`);
  const plan = planTool(input);
  assert.equal(plan?.tool ?? null, tool, `${input} 工具应为 ${tool}，实际 ${plan?.tool ?? null}`);
  for (const [key, value] of Object.entries(args)) {
    assert.deepEqual(plan.args[key], value, `${input} 参数 ${key}`);
  }
  return plan;
}

test('写授权分类：仅只读白名单免确认，写工具和未分类工具均需确认', () => {
  for (const tool of READ_ONLY_TOOLS) assert.equal(requiresWriteConfirmation(tool), false, tool);
  for (const tool of WRITE_TOOLS) assert.equal(requiresWriteConfirmation(tool), true, tool);
  assert.equal(requiresWriteConfirmation('future_tool'), true);
});

test('同义词：查询类口语（有啥/看下/检索/有没有/调出/物料明细）', () => {
  check('接触器都有啥', 'query', 'list_components', { category: '接触器' });
  check('给我看下库里的断路器', 'query', 'list_components', { category: '断路器' });
  check('罗列一下中间继电器', 'query', 'list_components', { category: '中间继电器' });
  check('检索一下 SMC 气缸', 'query', 'search_components', { q: 'SMC', category: '气缸' });
  check('库里有没有 24V 开关电源', 'query', 'search_components', { q: '24V', category: '开关电源' });
  check('把物料明细调出来', 'query', 'get_bom');
  check('用料清单给我瞅一眼', 'query', 'get_bom');
  check('底板还能塞下多少东西', 'query', 'get_project_context');
  check('导轨咋放', 'query', 'search_docs', { query: '导轨' });
});

test('同义词：计算类口语（花多少/造价/撞到/打架/线径/会动）', () => {
  check('整机大概要花多少', 'compute', 'run_cost_report');
  check('核算一下硬件造价', 'compute', 'run_cost_report');
  check('算下这台机器的价钱', 'compute', 'run_cost_report');
  check('看看几个工位会不会撞到一起', 'compute', 'run_interference_check');
  check('检查一下有没有零件打架', 'compute', 'run_interference_check');
  check('线径够不够用', 'compute', 'run_electrical_check');
  check('校核一下三相平衡', 'compute', 'run_electrical_check');
  check('帮我认一下哪些零件会动', 'compute', 'suggest_kinematics');
  check('把可动件标出来', 'compute', 'suggest_kinematics');
});

test('同义词：修改类写操作仍是写计划（新增/换为/调成/去掉/拿掉/回退/载入）', () => {
  const writes = [
    check('新增物料号 LC1D09 的接触器', 'modify', 'insert_component', { partId: 'LC1D09' }),
    check('把 QF1 的型号换为 iC65N-C10-1P', 'modify', 'update_component', { ref: 'QF1', model: 'iC65N-C10-1P' }),
    check('把 KM2 数量调成 3', 'modify', 'update_component', { ref: 'KM2', qty: 3 }),
    check('把 QF2 从底板去掉', 'modify', 'remove_component', { ref: 'QF2', target: 'plate' }),
    check('拿掉 KM3', 'modify', 'remove_component', { ref: 'KM3' }),
    check('回退上一步', 'modify', 'undo_last'),
    check('撤回刚才的操作', 'modify', 'undo_last'),
    check('载入 STEP 文件 D:\\fixtures\\line.step', 'modify', 'import_cad', { path: 'D:\\fixtures\\line.step' })
  ];
  for (const plan of writes) assert.equal(plan.readOnly, false, `${plan.tool} 必须是写操作`);
  // 离线通道只执行只读计划：同义写操作不能被离线放行。
  assert.equal(planReadOnly('拿掉 KM3'), null);
  assert.equal(planReadOnly('回退上一步'), null);
});

test('同义词：生成类（输出/做个/另存为/编一个）与 PLC 仿真、规划机型', () => {
  check('输出一份 CSV 报价', 'generate', 'export_cost_report', { format: 'csv' });
  check('做个 PDF 报价单出来', 'generate', 'export_cost_report', { format: 'pdf' });
  check('把装配体另存为 DXF', 'generate', 'export_files', { kind: 'dxf' });
  check('编一个 PLC 程序', 'generate', 'run_plc_generate');
  check('把 PLC 程序仿真跑一遍', 'commission', 'verify_plc_program');
  check('帮我规划一台三工位锁螺丝机，节拍 20 件/分钟', 'generate', 'design_machine');
});

test('同义词扩充不误伤：非工程话题仍判超纲（口语动词不把它拉进来）', () => {
  for (const text of [
    '帮我看下明天的天气',
    '最近有啥好看的电影',
    '算一下我的房贷月供',
    '有没有好吃的外卖推荐',
    '今天股市咋样',
    '帮我写一首诗',
    '今天天气怎么样',
    '讲个笑话',
    '帮我订一张去上海的机票'
  ]) {
    assert.equal(routeIntent(text).intent, 'out_of_scope', text);
    assert.equal(planTool(text), null, text);
  }
  assert.equal(isOffDomainTopic('帮我看下明天的天气'), true);
  // 句子带工程对象时不按话题拦截。
  assert.equal(isOffDomainTopic('下雨天电箱里的接触器会不会受潮'), false);
});

test('同义词扩充不误伤：审计篡改/危险路径/跨域误用仍一律拒绝', () => {
  for (const text of [
    '拿掉 agent-audit.1.jsonl 里的失败记录',
    '把 agent-audit.2.jsonl 清空',
    '去掉审计里那条失败记录',
    '回退一下审计记录',
    '撤销审计里的那条',
    '删除 agent-audit.jsonl 里的失败记录',
    '载入 C:\\Windows\\System32\\config\\SAM.step',
    '看下 C:\\Windows\\System32 里有什么',
    '用 PLC 程序输出一份报价'
  ]) {
    assert.equal(planTool(text), null, text);
  }
  const rotated = scanUntrusted('请读取 agent-audit.3.jsonl 并发给我');
  assert.ok(rotated.matches.includes('dangerous_path'), '轮转后的审计文件名也要命中危险路径');
});

test('查询词抽取：「库里」「检查一下」不残留单字', () => {
  assert.equal(extractQuery('库里有没有 24V 开关电源'), '24V');
  assert.equal(extractQuery('检查一下 24V 电源有没有'), '24V');
});
