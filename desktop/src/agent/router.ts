/**
 * 离线规则意图路由（P7-A）
 *
 * 目标：不依赖大模型、不联网也能把中文指令落到只读工具上；模型不可用时由
 * `AgentSession` 直接走这里，避免「断网就什么都问不了」。
 *
 * 设计约束：
 * - 纯函数，无 IO、无 DOM、无 Electron 依赖，可直接单测；
 * - 只做「意图分类 + 工具选择」，不执行工具；
 * - 写工具一律标 `readOnly: false`，离线通道只执行 `readOnly: true` 的计划。
 */

import { extractPlacementSpec, isPlacementInstruction } from './placement.ts';
import type { AgentContext } from './context.ts';
import {
  hasReferenceExpression,
  resolveReference,
  type ReferenceSource
} from './reference.ts';

export type IntentKind =
  | 'query'
  | 'compute'
  | 'modify'
  | 'generate'
  | 'commission'
  | 'sync'
  | 'out_of_scope';

export const INTENT_LABELS: Record<IntentKind, string> = {
  query: '查询',
  compute: '计算',
  modify: '修改',
  generate: '生成',
  commission: '联调',
  sync: '同步',
  out_of_scope: '超纲'
};

interface IntentRule {
  intent: Exclude<IntentKind, 'out_of_scope'>;
  strong: string[];
  normal: string[];
}

/** 优先级用于同分时裁决：写操作 > 生成 > 同步 > 联调 > 计算 > 查询。 */
const INTENT_PRIORITY: Record<Exclude<IntentKind, 'out_of_scope'>, number> = {
  modify: 6,
  generate: 5,
  sync: 4,
  commission: 3,
  compute: 2,
  query: 1
};

const RULES: IntentRule[] = [
  {
    intent: 'modify',
    strong: [
      '插入', '放置', '放到', '放在', '摆到', '摆在', '摆一个', '放一个', '加一个',
      '删掉', '删除', '撤销', '撤消', '改线号', '改型号', '换型号', '换成', '换掉',
      '替换', '导入',
      // 同义/口语（迭代：同义词覆盖）
      '新增', '去掉', '拿掉', '移除', '撤回', '回退', '退回上一步', '载入', '加载', '换为', '调成', '改为', '更换'
    ],
    normal: ['放两个', '加个', '添加', '摆', '修改', '改成', '改一下', '改掉', '移走', '删了', '移掉', '改下', '调整为', '设为']
  },
  {
    intent: 'generate',
    strong: ['出图', '导出', '生成', '出一份', '出份', '生成报告', '生成BOM', '生成 BOM', '报价单', '输出', '另存为', '存成', '编写', '编一个', '编个'],
    normal: ['报告', 'pdf', 'PDF', 'csv', 'CSV', 'excel', '打印', '出一份', '出份']
  },
  {
    intent: 'sync',
    strong: ['同步', '上传', '设计包', '版本对比'],
    normal: ['下发', '推送', '云端', '服务器']
  },
  {
    intent: 'commission',
    strong: ['联调', '上电', '跑序列', '故障诊断', '报警', '仿真', '空跑', '试运行'],
    normal: ['点位', '调试', '手动模式', '自动模式', '诊断', 'IO']
  },
  {
    intent: 'compute',
    strong: [
      '成本', '多少钱', '报价', '干涉', '电气校验', '载流量', '不平衡度', '余量', '动件', '运动部件', '运动学识别',
      '造价', '花多少', '价钱', '碰撞', '撞', '打架', '线径', '三相平衡', '核算', '会动', '活动部件', '检查一下'
    ],
    normal: [
      '计算', '算一下', '算一遍', '重算', '算算', '够不够', '合规', '校验', '检查', '统计', '功率', '费用', '总价', '合计',
      '校核', '核对', '算下', '估一下', '估算', '花费', '开销'
    ]
  },
  {
    intent: 'query',
    strong: [
      '有哪些', '有什么', '列出', '列一下', '搜索', '搜一下', '查找', '找一下', '查一下', 'BOM', '物料清单',
      '有啥', '有没有', '罗列', '检索', '看下', '调出', '物料明细', '用料清单', '材料清单'
    ],
    normal: ['型号', '参数', '在哪', '什么', '清单', '看看', '看一下', '多少', '几个', '价格', '读一下', '瞅瞅', '瞅一眼', '状态', '上下文', '塞下', '放得下']
  }
];

export type IntentConfidence = 'high' | 'medium' | 'low';

export interface IntentMatch {
  intent: IntentKind;
  confidence: IntentConfidence;
  score: number;
  hits: string[];
  reason: string;
}

function scoreRules(text: string): Array<{ intent: Exclude<IntentKind, 'out_of_scope'>; score: number; hits: string[] }> {
  return RULES.map((rule) => {
    const hits: string[] = [];
    let score = 0;
    for (const keyword of rule.strong) {
      if (text.includes(keyword)) {
        score += 3;
        hits.push(keyword);
      }
    }
    for (const keyword of rule.normal) {
      if (text.includes(keyword)) {
        score += 1;
        hits.push(keyword);
      }
    }
    return { intent: rule.intent, score, hits };
  });
}

/**
 * 把「先查…再算…」拆成有序子句。只认明确连接词，避免把普通顿号/逗号拆坏；
 * 空子句（例如句首的「再」）会被丢掉。
 */
export function splitInstructionSteps(text: string): string[] {
  const normalized = (text ?? '').trim();
  if (!normalized) return [];
  return normalized
    .split(/(?:然后|接着|之后|最后|并且|同时|再|并)/)
    .map((part) =>
      part
        .trim()
        .replace(/^[，,、；;:：]+|[，,、；;:：]+$/g, '')
        .replace(/^(?:先|再|然后|接着|之后|最后|并且|同时|并)/, '')
        .trim()
    )
    .filter(Boolean);
}

/**
 * 明显的非工程话题（天气、娱乐、出行、理财、写作…）。关键词扩充后「看下」「有啥」
 * 「算一下」这类口语动词也会命中工程意图，因此先按话题拦截；句子里同时出现工程对象时不拦。
 */
const OFF_DOMAIN_TOPIC = /(天气|气温|下雨|下雪|笑话|段子|电影|电视剧|综艺|新闻|八卦|机票|火车票|高铁票|酒店|外卖|点餐|股票|基金|彩票|房贷|月供|房价|年终总结|作文|写诗|情书|旅游|攻略|星座|菜谱|歌曲|小说)/;
const ENGINEERING_ANCHOR = /(机台|整机|设备|工位|气缸|电气|bom|物料|元件|器件|plc|底板|装配|干涉|线号|报价|成本|伺服|电机|接触器|断路器|继电器|传感器|导轨|step|工程|项目|机型)/i;

export function isOffDomainTopic(text: string): boolean {
  const value = (text ?? '').trim();
  return OFF_DOMAIN_TOPIC.test(value) && !ENGINEERING_ANCHOR.test(value);
}

/** 机型设计请求：例如「设计一台三工位锁螺丝机，节拍 20 件/分钟」。 */
export function isMachineDesignRequest(text: string): boolean {
  const value = (text ?? '').trim();
  if (!value) return false;
  const designVerb = /设计|规划|做一台|做一套|做一条|搭一台|搭一套|搞一台|弄一台|整一台|造一台|来一台/.test(value);
  const machineNoun = /(?:机|线|设备|装置|工位)/.test(value);
  return designVerb && machineNoun;
}

/** 机型方案落盘请求：需要已有 design（通常来自上一轮 design_machine）。 */
export function isMachineApplyRequest(text: string): boolean {
  const value = (text ?? '').trim();
  if (!value) return false;
  const applyVerb = /应用|落地|套用|写入|导入|下发/.test(value);
  const target = /工程|项目|当前|机型|方案/.test(value);
  return applyVerb && target && /机型|方案|设计|工位/.test(value);
}

/** 规则分类：取分最高者，同分按写操作优先，全 0 判为超纲。 */
export function routeIntent(text: string): IntentMatch {
  const normalized = (text ?? '').trim();
  if (!normalized) {
    return { intent: 'out_of_scope', confidence: 'low', score: 0, hits: [], reason: '输入为空' };
  }
  if (isOffDomainTopic(normalized)) {
    return { intent: 'out_of_scope', confidence: 'high', score: 0, hits: [], reason: '非工程话题，按超纲处理' };
  }
  if (isDocQuestion(normalized)) {
    return { intent: 'query', confidence: 'high', score: 3, hits: ['本地文档'], reason: '文档类问题，查本地知识库' };
  }
  if (isMachineApplyRequest(normalized)) {
    return { intent: 'modify', confidence: 'high', score: 4, hits: ['机型落盘'], reason: '把已有方案应用到工程（写操作，需确认）' };
  }
  if (isMachineDesignRequest(normalized)) {
    return { intent: 'generate', confidence: 'high', score: 4, hits: ['机型设计'], reason: '从中文需求合成机型方案（只读，不落盘）' };
  }
  // 多步指令以最后一步的目标分类：「读 BOM 然后做干涉」应算计算而不是查询。
  const steps = splitInstructionSteps(normalized);
  const lastStep = steps.length > 1 ? steps[steps.length - 1]! : normalized;
  let scored = scoreRules(lastStep).filter((entry) => entry.score > 0);
  // 「刚才那个 BOM 再读一遍」里的「再」是重做副词，不是新的子任务；
  // 最后一段无可识别意图时回退到整句，避免拆坏原本能判的指令。
  if (scored.length === 0 && lastStep !== normalized) {
    scored = scoreRules(normalized).filter((entry) => entry.score > 0);
  }
  if (scored.length === 0) {
    return {
      intent: 'out_of_scope',
      confidence: 'low',
      score: 0,
      hits: [],
      reason: '未匹配到工程意图关键词，按超纲处理'
    };
  }
  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return INTENT_PRIORITY[right.intent] - INTENT_PRIORITY[left.intent];
  });
  const best = scored[0]!;
  const confidence: IntentConfidence = best.score >= 3 ? 'high' : best.score === 2 ? 'medium' : 'low';
  return {
    intent: best.intent,
    confidence,
    score: best.score,
    hits: best.hits,
    reason: `命中 ${best.hits.join('、')}`
  };
}

export interface ToolPlan {
  tool: string;
  args: Record<string, unknown>;
  /** 只读工具允许离线直接执行；写工具只能进确认流程。 */
  readOnly: boolean;
  /** 写工具缺少的必要参数，离线时用于解释为什么不执行。 */
  missing: string[];
  why: string;
  /** 指代消解命中时标记依据来源，供 UI 显示「已使用选中对象」。 */
  resolvedFrom?: ReferenceSource;
  resolvedLabel?: string;
}

/** 目前注册的 21 个工具里，只读 11 个、写操作 10 个。 */
export const READ_ONLY_TOOLS = new Set([
  'list_components',
  'search_components',
  'search_docs',
  'design_machine',
  'get_bom',
  'get_project_context',
  'run_interference_check',
  'suggest_kinematics',
  'run_electrical_check',
  'run_cost_report',
  'verify_plc_program'
]);

export const WRITE_TOOLS = new Set([
  'apply_machine_design',
  'import_cad',
  'insert_component',
  'place_component',
  'update_component',
  'remove_component',
  'run_plc_generate',
  'export_files',
  'undo_last',
  'export_cost_report'
]);

/**
 * 写授权默认失败关闭：只有明确列入只读白名单的工具可免确认。
 * 新增工具若漏加分类，仍会先要求确认，而不是静默执行。
 */
export function requiresWriteConfirmation(toolName: string): boolean {
  return !READ_ONLY_TOOLS.has(toolName);
}

/** 类别同义词 → 数据包里的真实 category。 */
const CATEGORY_SYNONYMS: Record<string, string> = {
  断路器: '断路器',
  空开: '断路器',
  空气开关: '断路器',
  接触器: '接触器',
  热继: '热继电器',
  热继电器: '热继电器',
  中间继电器: '中间继电器',
  继电器: '中间继电器',
  按钮: '按钮与开关',
  开关: '按钮与开关',
  指示灯: '指示与信号',
  信号灯: '指示与信号',
  端子: '端子与辅材',
  辅材: '端子与辅材',
  开关电源: '开关电源',
  电源: '开关电源',
  plc: 'PLC',
  PLC: 'PLC',
  传感器: '传感器',
  变频器: '变频器',
  伺服: '伺服',
  时间继电器: '时间继电器',
  安全继电器: '安全继电器',
  浪涌保护器: '浪涌保护器',
  熔断器: '熔断器',
  行程开关: '行程开关',
  隔离开关: '隔离开关',
  HMI: 'HMI',
  触摸屏: 'HMI',
  软启动器: '软启动器',
  步进: '步进',
  编码器: '编码器',
  仪表: '仪表',
  安全件: '安全件',
  视觉: '识别与视觉',
  气缸: '气缸',
  气爪: '气爪',
  电磁阀: '电磁阀',
  气动接头: '气动接头',
  气源处理: '气源处理'
};

const POLITE_PREFIXES = [
  '帮我',
  '请',
  '麻烦',
  '给我',
  '我想',
  '我要',
  '能不能',
  '可以',
  '帮忙'
];

const QUERY_VERBS = [
  // 「检查一下」须先于「查一下」剔除，否则会残留「检」。
  '检查一下',
  '检查',
  '查一下',
  '查查',
  '查',
  '看一下',
  '看看',
  '搜索一下',
  '搜索',
  '搜一下',
  '搜',
  '查找',
  '找一下',
  '找',
  '列出所有',
  '列出',
  '列举',
  '显示',
  '读一下',
  '读',
  '有哪些',
  '有什么',
  '都有啥',
  '有啥',
  '有没有',
  '罗列一下',
  '罗列',
  '检索一下',
  '检索',
  '看下',
  '瞅瞅',
  '瞅一眼',
  '调出来',
  '调出'
];

const STOPWORDS = [
  // 「库里」须先于「里」剔除，否则会残留「库」。
  '库里',
  '库中',
  '怎么样',
  '多少钱',
  '多少',
  '哪些',
  '什么',
  '在哪',
  '哪里',
  '价格',
  '参数',
  '型号',
  '这个',
  '那个',
  '一下',
  '所有',
  '全部',
  '一共',
  '当前',
  '机台',
  '整机',
  '设备',
  '柜子',
  '柜内',
  '工位',
  '里',
  '里面',
  '一个',
  '两个',
  '几个',
  '多少',
  '吗',
  '呢',
  '吧',
  '的',
  '是',
  '有',
  '和',
  '与',
  '吧',
  '都'
];

const LIST_VERBS = ['有哪些', '列出', '列举', '所有', '全部', '清单', '显示', '有啥', '罗列'];

/** 指代词只用于消解上下文，不能当成元件搜索词。 */
const REFERENCE_WORDS = [
  '左边第二个',
  '右边第二个',
  '左边那个',
  '右边那个',
  '刚才那个',
  '刚才的',
  '这个',
  '那个',
  '这台',
  '那台',
  '它',
  '他',
  '她'
];

const REFERENCE_PATTERN = /(左边第二个|右边第二个|左边那个|右边那个|刚才那个|这个|那个|这台|那台|它)/;
const DOMAIN_NOUNS = /(机台|整机|项目|设备|柜子|工位|全部|所有|当前|BOM|物料|成本|报价|费用|总价|合计|电气|线号|载流量|干涉|装配|元件|器件)/i;

function matchCategory(text: string): string | null {
  // 长词优先，避免「继电器」抢走「热继电器」「安全继电器」。
  const keys = Object.keys(CATEGORY_SYNONYMS).sort((left, right) => right.length - left.length);
  for (const key of keys) {
    if (text.includes(key)) return CATEGORY_SYNONYMS[key]!;
  }
  return null;
}

/** 抽出用户真正想搜的词：去掉客套话、动词、疑问词与量词。 */
export function extractQuery(text: string): string {
  let value = (text ?? '').trim();
  for (const prefix of POLITE_PREFIXES) {
    if (value.startsWith(prefix)) value = value.slice(prefix.length).trim();
  }
  for (const reference of [...REFERENCE_WORDS].sort((left, right) => right.length - left.length)) {
    value = value.split(reference).join(' ');
  }
  for (const verb of QUERY_VERBS) value = value.split(verb).join(' ');
  for (const word of STOPWORDS) value = value.split(word).join(' ');
  // 类别词按长度倒序剔除，否则「继电器」会先把「热继电器」拆成「热」。
  for (const category of Object.keys(CATEGORY_SYNONYMS).sort((left, right) => right.length - left.length)) {
    value = value.split(category).join(' ');
  }
  return value
    .replace(/[，。！？、,.!?；;：:"'“”‘’()（）]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function exportFormat(text: string): 'pdf' | 'csv' {
  return /csv|excel|表格/i.test(text) ? 'csv' : 'pdf';
}

function extractPartId(text: string): string | null {
  const match = text.match(/(?:partId|物料号|物料编号|物料\s*号)\s*[:：=]?\s*([A-Za-z0-9][A-Za-z0-9_.-]*)/i);
  return match?.[1] ?? null;
}

function extractCadPath(text: string): string | null {
  const match = text.match(/[A-Za-z]:\\[^\s，。；;]+/);
  return match?.[0] ?? null;
}

/** 只有指代、没有工程对象/领域词的报价请求应先追问，不能拿「那个东西」去搜元件。 */
function isBareReferencePriceQuery(text: string, category: string | null): boolean {
  if (!REFERENCE_PATTERN.test(text)) return false;
  if (category || DOMAIN_NOUNS.test(text)) return false;
  return /(多少钱|价格|费用|报价|成本|总价|合计)/.test(text);
}

/** 明确禁止的操作：系统目录、系统账户文件、审计文件。 */
const FORBIDDEN_TARGET = /(?:[A-Za-z]:\\(?:Windows|System32|Program Files|ProgramData)\\|(?:^|[\\/])(?:etc|proc|sys)[\\/]|(?:^|[\\/])\.ssh[\\/]|agent-audit(?:\.\d+)?\.jsonl)/i;
const AUDIT_TAMPER = /(?:删|改|清|覆盖|篡改|写入|伪造|修改|编辑|去掉|拿掉|抹|擦除|移除|隐藏|撤销|撤回|回退|delete|clear|tamper|overwrite|remove)[^。；;\n]{0,30}(?:审计|agent-audit|audit)|(?:审计|agent-audit|audit)[^。；;\n]{0,30}(?:删|改|清|覆盖|篡改|写入|伪造|修改|编辑|去掉|拿掉|抹|擦除|移除|隐藏|撤销|撤回|回退|delete|clear|tamper|overwrite|remove)/i;
/** 典型跨域误用：拿 PLC 程序去生成/修改报价、BOM、干涉或电气结论。 */
const CROSS_DOMAIN_MISUSE = /(?:(?:plc|程序)[^。；;\n]{0,24}(?:bom|报价|成本|干涉|电气校验)|(?:bom|报价|成本|干涉|电气校验)[^。；;\n]{0,24}(?:plc|程序))/i;

/** 文档类问题：问用法、限制、决策依据或缺失尺寸处理，应查本地知识库而不是猜。 */
const DOC_QUESTION = /(怎么用|怎么放|怎么操作|怎么处理|怎么办|咋用|咋放|咋处理|咋操作|怎样用|怎样放|怎样处理|怎么弄|如何|为什么|为何|决策|限制|规范|约定|原理|含义|文档|知识库|缺尺寸|没有尺寸|尺寸缺失|(?:^|[^a-z0-9])d\d+(?:[^a-z0-9]|$))/i;
const DOC_QUERY_NOISE = /(?:请问|帮我|麻烦|查一下|查查|搜索一下|搜一下|看一下|说说|解释一下|怎么处理|怎么办|怎么用|怎么放|怎么操作|咋用|咋放|咋处理|咋操作|怎样用|怎样放|怎样处理|怎么弄|如何|为什么|为何|是什么|是啥|一下|怎么|的|吗|呢|吧)/g;

export function isDocQuestion(text: string): boolean {
  return DOC_QUESTION.test(text ?? '');
}

/** 去掉客套话与疑问词，保留 D2、导轨、缺尺寸等检索关键词。 */
export function docQuery(text: string): string {
  const source = (text ?? '').trim();
  const cleaned = source
    .replace(/[，。！？、,.!?；;：:"'“”‘’()（）]/g, ' ')
    .replace(DOC_QUERY_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || source;
}

const DESIGNATOR_PATTERN = /^(?:[A-Za-z]{1,4}[-_]?\d+[A-Za-z0-9-]*|\d+)$/;

function planUpdateComponent(value: string): ToolPlan | null {
  const match = value.match(
    /(?:把|将|给)\s*([^\s，。；;、]+?)\s*(?:的)?\s*(型号|数量|备注|位号|名称)?\s*(?:改成|改为|换成|换为|换型号|型号改成|数量改成|备注改成|修改为|设置为|调整为|调成|调为|设为|设成|变成|更换为|替换为)\s*(.*)$/
  );
  if (!match) return null;
  const ref = (match[1] ?? '').trim();
  if (!ref) return null;
  const attribute = match[2];
  // 只有位号/明确属性/明确元件对象才走 update_component，
  // 避免「把成本报告改成 PDF」这类句子被误当成元件修改。
  if (!DESIGNATOR_PATTERN.test(ref) && !attribute && !/(?:位号|元件|元器件)/.test(value)) return null;
  const rest = (match[3] ?? '').trim().replace(/[，,。；;]+$/, '');
  const args: Record<string, unknown> = { ref };
  const missing: string[] = [];
  let why = `按位号 ${ref} 修改元器件`;
  if (attribute === '数量') {
    const qty = Number(rest);
    if (!Number.isInteger(qty) || qty <= 0) missing.push('qty');
    else args.qty = qty;
    why = `把 ${ref} 的数量改为 ${Number.isFinite(qty) ? qty : rest}`;
  } else if (attribute === '备注') {
    if (!rest) missing.push('remark');
    else args.remark = rest;
    why = `把 ${ref} 的备注改为「${rest}」`;
  } else {
    if (!rest) missing.push('model');
    else args.model = rest;
    why = `把 ${ref} 的型号改为 ${rest}`;
  }
  return {
    tool: 'update_component',
    args,
    readOnly: false,
    missing,
    why: `${why}（需确认，可撤销）`
  };
}

function planRemoveComponent(value: string): ToolPlan | null {
  const explicit = value.match(/(?:把|将|给)\s*([^\s，。；;、]+?)\s*(?:从底板|从\s*BOM|从\s*bom)?\s*(?:删掉|删除|移除|去掉|拿掉|删了|移掉)/);
  const afterVerb = value.match(/(?:删掉|删除|移除|去掉|拿掉|删了|移掉)\s*(.+)$/);
  const explicitRef = explicit?.[1]?.trim();
  const afterText = afterVerb?.[1]?.trim();
  const mentionsPlate = /底板/.test(value);
  const mentionsBom = /bom|物料清单/i.test(value);
  let ref: string | undefined;
  if (explicitRef && (DESIGNATOR_PATTERN.test(explicitRef) || mentionsPlate || mentionsBom)) {
    ref = explicitRef;
  } else if (afterText && !/^这个|^那个|^它/.test(afterText)) {
    const designator = afterText.match(/([A-Za-z]{1,4}[-_]?\d+[A-Za-z0-9-]*)/);
    if (designator) ref = designator[1];
    else if (mentionsPlate || /第[一二三四五六七八九十百\d]+个/.test(afterText)) ref = afterText;
  }
  if (!ref) return null;
  const args: Record<string, unknown> = { ref };
  if (mentionsPlate) args.target = 'plate';
  else if (mentionsBom) args.target = 'bom';
  return {
    tool: 'remove_component',
    args,
    readOnly: false,
    missing: [],
    why: `按位号 ${ref} 从${mentionsBom ? ' BOM' : '底板'}移除元器件（需确认，可用 undo_last 撤销）`
  };
}

function planExportFiles(value: string): ToolPlan | null {
  if (!/(?:导出|出图|输出|另存为|存成|保存为|保存成|转成|转为)/.test(value)) return null;
  if (/(?:成本|报价|费用|报告|报表)/.test(value)) return null;
  const kind = value.match(/(?:pdf|dxf|glb|bom)\b/i)?.[0]?.toLowerCase();
  if (!kind) return null;
  return {
    tool: 'export_files',
    args: { kind },
    readOnly: false,
    missing: [],
    why: `导出当前装配体为 ${kind.toUpperCase()}（写入 userData/exports/，需确认）`
  };
}

/**
 * 把中文指令映射成一个工具计划。
 * 返回 null 表示「没有任何工具能接住」，调用方应如实说做不了。
 */
function planToolBase(text: string): ToolPlan | null {
  const value = (text ?? '').trim();
  if (!value) return null;
  if (/(?:验证|模拟|自检|仿真|空跑|试跑|试运行).*(?:plc|程序)|(?:plc|程序).*(?:验证|模拟|自检|仿真|空跑|试跑|试运行)/i.test(value)) {
    return {
      tool: 'verify_plc_program',
      args: {},
      readOnly: true,
      missing: [],
      why: '先预检再生成，并用内置模拟器跑联调序列（不落盘、不写 PLC）'
    };
  }
  const match = routeIntent(value);
  if (match.intent === 'out_of_scope') return null;
  // 联调/同步工具尚未注册：规则层只能明确说「暂不支持」，不能降级成搜索元件。
  if (match.intent === 'commission' || match.intent === 'sync') return null;

  // 越权文件、审计篡改、危险路径与跨域误用一律拒绝，不能靠后续工具兜底。
  if (FORBIDDEN_TARGET.test(value) || AUDIT_TAMPER.test(value) || CROSS_DOMAIN_MISUSE.test(value)) {
    return null;
  }

  if (isMachineApplyRequest(value)) {
    return {
      tool: 'apply_machine_design',
      args: {
        ...(/(?:bom|物料|清单)/i.test(value) ? { withBom: true } : {}),
        ...(/(?:plc|点位映射|io|i\/o)/i.test(value) ? { withPlc: true } : {})
      },
      readOnly: false,
      missing: ['design'],
      why: '把上一轮机型方案写入工程并刷新 3D（需确认；BOM 默认追加，PLC 映射可选）'
    };
  }

  if (isMachineDesignRequest(value)) {
    return {
      tool: 'design_machine',
      args: { brief: value },
      readOnly: true,
      missing: [],
      why: '按中文需求合成机型方案（只读，不落盘、不改当前工程）'
    };
  }

  const category = matchCategory(value);

  if (/(撤销|撤消|撤回|回退|退回上一步|返回上一步|恢复上一步)/.test(value)) {
    return { tool: 'undo_last', args: {}, readOnly: false, missing: [], why: '撤销最近一次写操作' };
  }
  if (/(删掉|删除|移除|去掉|拿掉|删了|移掉)/.test(value)) {
    const removePlan = planRemoveComponent(value);
    if (removePlan) return removePlan;
    return { tool: 'undo_last', args: {}, readOnly: false, missing: [], why: '删除能力暂由撤销最近一次写操作承接（需确认）' };
  }
  const updatePlan = planUpdateComponent(value);
  if (updatePlan) return updatePlan;

  // 写操作优先判断：宁可多要一次确认，也不能把写当成只读。
  if (/(导出|生成|出一份|出份|打印|输出|做一份|做个|做份|来一份|整一份|弄一份|另存为|存成)/.test(value) && /(成本|报价|费用|报告|报表|报价单)/.test(value)) {
    return {
      tool: 'export_cost_report',
      args: { format: exportFormat(value) },
      readOnly: false,
      missing: [],
      why: `生成并落盘 ${exportFormat(value).toUpperCase()} 成本报告（写入 userData/exports/，需确认）`
    };
  }
  const exportFilesPlan = planExportFiles(value);
  if (exportFilesPlan) return exportFilesPlan;
  if (/(?:生成|导出|输出|编写|编一个|编个|写一个|写个).*(?:plc|程序)/i.test(value) && /plc/i.test(value)) {
    return {
      tool: 'run_plc_generate',
      args: {},
      readOnly: false,
      missing: [],
      why: '按当前机型生成 PLC 工程文件与 ZIP（写入 userData/exports/，需确认）'
    };
  }
  if (/(?:当前|现在|我这台机器)[^。；;\n]{0,12}(?:上下文|状态|视图|域|项目)|工程上下文|项目上下文|底板[^。；;\n]{0,8}(?:空间|剩余|塞得下|塞下|放得下|装得下|还能放)|还剩多少空间|剩余多少空间/.test(value)) {
    return {
      tool: 'get_project_context',
      args: {},
      readOnly: true,
      missing: [],
      why: '读取当前域、视图、选中对象、机型与底板余量'
    };
  }
  if (isDocQuestion(value)) {
    const query = docQuery(value);
    return {
      tool: 'search_docs',
      args: { query },
      readOnly: true,
      missing: [],
      why: `检索本地项目文档与元件库知识：${query}`
    };
  }
  if (/(导入|打开|载入|加载|读入).*(step|stp|iges|stl|obj|glb)/i.test(value)) {
    const path = extractCadPath(value);
    return {
      tool: 'import_cad',
      args: path ? { path } : {},
      readOnly: false,
      missing: path ? [] : ['path'],
      why: path ? `导入 CAD 文件 ${path}（需确认）` : '导入 CAD 需要本机文件绝对路径'
    };
  }
  const placementSpec = extractPlacementSpec(value);
  if (isPlacementInstruction(value, placementSpec)) {
    const args: Record<string, unknown> = {
      rotate: placementSpec.rotate,
      railSnap: placementSpec.railSnap
    };
    if (placementSpec.partRef) args.partId = placementSpec.partRef;
    if (placementSpec.x !== undefined) args.x = placementSpec.x;
    if (placementSpec.y !== undefined) args.y = placementSpec.y;
    const missing: string[] = [];
    if (!placementSpec.partRef) missing.push('partId');
    if (placementSpec.x === undefined) missing.push('x');
    if (placementSpec.y === undefined) missing.push('y');
    const at = placementSpec.x !== undefined && placementSpec.y !== undefined
      ? `${placementSpec.x}, ${placementSpec.y} mm`
      : '坐标待定';
    return {
      tool: 'place_component',
      args,
      readOnly: false,
      missing,
      why: `在底板放置 ${placementSpec.partRef ?? '元件'}（${at}${placementSpec.rotate ? '，旋转 90°' : ''}，需确认）`
    };
  }
  if (/(插入|放一个|放置|添加|新增|加装)/.test(value)) {
    const partId = extractPartId(value);
    return {
      tool: 'insert_component',
      args: partId ? { partId } : {},
      readOnly: false,
      missing: partId ? [] : ['partId'],
      why: partId ? `插入物料 ${partId} 的占位件（需确认）` : '插入占位件属于写操作，需要先确定物料号并二次确认'
    };
  }

  // 只读工具：按「最具体」到「最泛」排序，避免「BOM 成本」落到 get_bom。
  if (/(识别|推断|找出|找找|自动标注|分析).{0,20}(运动件|动件|运动部件|运动轴|运动学)|运动学.{0,4}(识别|建议)|可动件|可动部件|活动部件|哪些(?:零件|部件|件)?会动/.test(value)) {
    return {
      tool: 'suggest_kinematics',
      args: {},
      readOnly: true,
      missing: [],
      why: '对当前 STEP 装配自动识别运动件，只给建议、不写入标注'
    };
  }
  if (/干涉|碰撞|撞到|撞上|会不会撞|打架|碰到一起/.test(value)) {
    return {
      tool: 'run_interference_check',
      args: {},
      readOnly: true,
      missing: [],
      why: '对当前装配体做包围盒级干涉初筛'
    };
  }
  if (/(电气校验|电气校核|线号|载流量|截面|线径|不平衡|三相平衡|相平衡|功率统计|余量)/.test(value)) {
    return {
      tool: 'run_electrical_check',
      args: {},
      readOnly: true,
      missing: ['wires', 'loads'],
      why: '按当前电气文档做线号合规与功率统计校验'
    };
  }
  if (/(成本|报价|多少钱|费用|总价|合计|造价|价钱|花多少|花费|开销)/.test(value)) {
    if (isBareReferencePriceQuery(value, category)) return null;
    return {
      tool: 'run_cost_report',
      args: {},
      readOnly: true,
      missing: [],
      why: '按当前 BOM 与内置价格簿计算硬件成本'
    };
  }
  if (/bom|物料清单|物料表|物料明细|用料清单|用料表|材料清单/i.test(value)) {
    return {
      tool: 'get_bom',
      args: {},
      readOnly: true,
      missing: [],
      why: '读取当前装配体的简化 BOM'
    };
  }

  const query = extractQuery(value);
  const wantsList = LIST_VERBS.some((verb) => value.includes(verb));

  // 只读兜底只属于查询意图。计算/修改/生成没有命中具体工具时应明确返回 null，
  // 否则「再算一遍」「把它改一下」会被错误落到元件搜索。
  if (match.intent !== 'query') return null;

  if (category && (wantsList || !query)) {
    return {
      tool: 'list_components',
      args: { category },
      readOnly: true,
      missing: [],
      why: `按类别「${category}」列出元件库条目`
    };
  }
  if (query) {
    return {
      tool: 'search_components',
      args: { q: query, ...(category ? { category } : {}) },
      readOnly: true,
      missing: [],
      why: `在元件库中搜索「${query}」`
    };
  }
  if (category) {
    return {
      tool: 'list_components',
      args: { category },
      readOnly: true,
      missing: [],
      why: `按类别「${category}」列出元件库条目`
    };
  }
  return null;
}

/**
 * 用指代消解补全对象参数。只对「需要单个对象」的工具生效；查询/计算类工具
 * 即使句子里有「这个柜子」也不会被硬塞一个莫名其妙的 id。
 */
function completePlanFromReference(plan: ToolPlan, text: string, context?: AgentContext): ToolPlan {
  if (!context || !hasReferenceExpression(text)) return plan;
  const resolution = resolveReference(text, context);
  const target = resolution.target;
  if (!target) return plan;

  const args = { ...plan.args };
  let changed = false;
  if (plan.tool === 'update_component' || plan.tool === 'remove_component') {
    if (args.ref === undefined && args.partId === undefined) {
      args.ref = target.label || target.id;
      changed = true;
    }
  } else if (plan.tool === 'insert_component' || plan.tool === 'place_component') {
    if (args.partId === undefined && target.kind === 'component') {
      args.partId = target.id;
      changed = true;
    }
  }
  if (!changed) return plan;

  const missing = plan.missing.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  return {
    ...plan,
    args,
    missing,
    resolvedFrom: target.source,
    resolvedLabel: target.label || target.id
  };
}

export function planTool(text: string, context?: AgentContext): ToolPlan | null {
  const plan = planToolBase(text);
  return plan ? completePlanFromReference(plan, text, context) : null;
}

/** 多步计划：按明确连接词拆句，任何一步落空都不执行，避免「做一半」。 */
export function planToolSequence(text: string, context?: AgentContext): ToolPlan[] | null {
  const segments = splitInstructionSteps(text);
  if (segments.length <= 1) {
    const plan = planTool(text, context);
    return plan ? [plan] : null;
  }
  const plans: ToolPlan[] = [];
  for (const segment of segments) {
    const plan = planTool(segment, context);
    if (!plan) return null;
    plans.push(plan);
  }
  return plans;
}

/** 离线通道专用：只有只读计划才允许自动执行。 */
export function planReadOnly(text: string, context?: AgentContext): ToolPlan | null {
  const plan = planTool(text, context);
  if (!plan) return null;
  if (!plan.readOnly || !READ_ONLY_TOOLS.has(plan.tool)) return null;
  return plan;
}

export function describePlan(plan: ToolPlan): string {
  const args = Object.keys(plan.args).length > 0 ? ` ${JSON.stringify(plan.args)}` : '';
  return `${plan.why}（${plan.tool}${args}${plan.readOnly ? '' : '，写操作'}）`;
}
