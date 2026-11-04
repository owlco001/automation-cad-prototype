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
 * - 多工具一次跑完的「流程配方」不进 `ToolPlan`：`matchRecipeIntent()` 把
 *   「帮我把这台机器评审一遍 / 这台机能不能出图 / 这台机器有没有问题」指到
 *   `review-design` 配方（`recipes.ts` + 汇总器 `design-review.ts`），由侧栏流程面板执行。
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
    strong: ['出图', '导出', '生成', '出一份', '出份', '生成报告', '生成BOM', '生成 BOM', '报价单', '输出', '另存为', '存成', '编写', '编一个', '编个',
      // 「存为工程」是落库到工程列表，不是导出文件；不写进来会被判成超纲
      '存为工程', '保存为工程', '存成工程', '保存成工程'],
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
/** 生成整机实体模型（内核逐件导出）而非合成方案/落盘工程。 */
export function isMachineModelRequest(text: string): boolean {
  const value = (text ?? '').trim();
  if (!value) return false;
  const modelVerb = /(?:建成|生成|建|做|出).{0,6}(?:实体|三维|3d|模型)|实体模型|三维模型|3d\s*模型/i.test(value);
  const scope = /(?:整机|机型|机器|设备|输送机|工位|当前)/.test(value);
  // 与 apply_machine_design（落盘工程）区分：出现「应用/写入/落地/保存」交给 apply 规则
  const apply = /应用|落地|套用|写入|保存|导入|下发/.test(value);
  return modelVerb && scope && !apply;
}

export function isMachineApplyRequest(text: string): boolean {
  const value = (text ?? '').trim();
  if (!value) return false;
  const applyVerb = /应用|落地|套用|写入|导入|下发/.test(value);
  const target = /工程|项目|当前|机型|方案/.test(value);
  return applyVerb && target && /机型|方案|设计|工位/.test(value);
}

/**
 * 机型方案自查请求（只读）：检查/校验当前方案的结构与绑定。
 * 与 apply 区分：这里只出 issues，不写盘；与 verify_plc_program 区分：不看 PLC 轴/信号。
 */
/**
 * 截图请求：让智能体拿证据（capture_view）。
 * 负向：文档类提问（「截图索引在哪」「截图说明」）走知识库，不触发截图。
 */
export function isCaptureRequest(text: string): boolean {
  const value = (text ?? '').trim();
  if (!value) return false;
  // 文档/求助句式不触发截图：「截图怎么用」「截图索引在哪」「截图保存在哪个目录」
  if (/(索引|文档|说明|帮助|怎么|如何|怎样|在哪|哪里|哪个目录|保存到哪|支持|限制|能不能)/.test(value)) return false;
  return /(?:截(?:个|一|张|一下)|截屏|截图|抓个图|抓一张|屏幕快照|screenshot|capture\s+view)/i.test(value);
}

export function isMachineValidateRequest(text: string): boolean {
  const value = (text ?? '').trim();
  if (!value) return false;
  if (!/(?:机型|方案|设计|配置|config)/i.test(value)) return false;
  const verbFirst = /(?:校验|检查|自查|自检|体检|审一下|看看|看一下)[^。；;\n]{0,12}(?:机型|方案|设计|配置)/.test(value);
  const nounFirst =
    /(?:机型|方案|配置)[^。；;\n]{0,12}(?:是否合法|合不合法|有没有问题|有没有错|对不对|是否合规|是否有效|能不能落盘|能不能通过校验|自检|自查)/.test(value);
  return verbFirst || nounFirst;
}

/** PLC 预检缺口补齐请求（写，默认 dryRun）：缺到位检测 / 缺急停安全回路 / 要补齐预检缺口。 */
export function isMachineRepairRequest(text: string): boolean {
  const value = (text ?? '').trim();
  if (!value) return false;
  const repairVerb = /(?:补齐|补全|补上|补一个|补个|补一批|修复|修一下)/.test(value);
  const gapAnchor = /(?:点位|传感器|到位检测|急停|安全回路|安全门|光栅|预检|plc|缺口|io)/i.test(value);
  if (repairVerb && gapAnchor) return true;
  const missing = /(?:缺|少)[^。；;\n]{0,8}(?:点位|传感器|到位检测|急停|安全回路|安全门|光栅)/.test(value);
  return missing && /(?:plc|预检|回路|方案)/i.test(value);
}

/** 设计评审配方 id（`recipes.ts` 第 6 个模板）。 */
export const DESIGN_REVIEW_RECIPE_ID = 'review-design';

/** 「评审」动作词：一次看完整机，而不是查单个工具。 */
const REVIEW_VERB = /(?:评审|评估|体检|审一遍|过一遍|把把关|全面检查|整机检查|整体检查)/;
/** 评审对象词：机器/整机/方案/这台… */
const REVIEW_TARGET = /(?:机器|机台|整机|设备|图纸|设计|方案|这台|这机)/;
/** 机器类锚点：单独出现「有没有问题 / 能不能出图」时必须有它，否则不抢别的意图。 */
const MACHINE_ANCHOR = /(?:机器|机台|整机|设备|这台|这机)/;
/** 出图/交付可行性质问：「这台机能不能出图」。 */
const DELIVERY_QUESTION =
  /(?:(?:能不能|能否|可不可以|是否可以|是否).{0,8}(?:出图|出图纸|交付|下单|发图|投产))|(?:(?:出图|交付).{0,4}(?:吗|没|没有))/;
/** 有没有毛病：「这台机器有没有问题」。 */
const PROBLEM_QUESTION = /(?:有没有(?:问题|毛病|风险|坑)|有什么(?:问题|风险|毛病))/;

/**
 * 设计评审请求：用户要的是「帮我把这台机器评审一遍」，不是逐个工具问答。
 *
 * 边界（刻意与相邻意图区分，避免抢单工具计划）：
 * - 「机型方案有没有问题 / 校验机型方案」→ 仍归 `isMachineValidateRequest`（只查结构与绑定，单工具）；
 *   这里只在出现「机器/整机/这台」这类整机锚点、或明确的评审动作词时才命中。
 * - 「成本评估 / 电气评估」这类单域说法不命中（没有整机对象词）。
 */
export function isDesignReviewRequest(text: string): boolean {
  const value = (text ?? '').trim();
  if (!value) return false;
  if (isOffDomainTopic(value)) return false;
  if (REVIEW_VERB.test(value) && REVIEW_TARGET.test(value)) return true;
  if (DELIVERY_QUESTION.test(value) && MACHINE_ANCHOR.test(value)) return true;
  if (PROBLEM_QUESTION.test(value) && MACHINE_ANCHOR.test(value)) return true;
  return false;
}

/**
 * 意图 → 流程配方。目前只有「设计评审」一条：它要串 5 个只读工具 + 1 个纯函数汇总，
 * 落在 `ToolPlan`（单工具）之外，所以由调用方（侧栏输入）按本函数切到流程面板并启动。
 * 未命中返回 null，调用方继续走 `planTool` 的单工具通道。
 */
export function matchRecipeIntent(text: string): string | null {
  return isDesignReviewRequest(text) ? DESIGN_REVIEW_RECIPE_ID : null;
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
  // 跨会话项目记忆：先于通用打分，否则「忘掉这个项目的记忆」落 out_of_scope。
  if (isProjectMemoryClearRequest(normalized)) {
    return { intent: 'modify', confidence: 'high', score: 4, hits: ['项目记忆'], reason: '清空当前工程的跨会话记忆（写操作，需确认）' };
  }
  if (isProjectMemoryRecallRequest(normalized)) {
    return { intent: 'query', confidence: 'high', score: 3, hits: ['项目记忆'], reason: '读取当前工程的跨会话事实记录（只读）' };
  }
  // 大结果回取：句子里没有领域名词，通用规则会判成超纲，先在这里归到 query。
  if (isToolResultRecallRequest(normalized)) {
    return { intent: 'query', confidence: 'high', score: 4, hits: ['工具结果回取'], reason: '按 resultId 分批读回被截断的完整结果（只读）' };
  }
  // 失败自查：先于 isDocQuestion，否则「上次为什么失败」会被「为什么」拉去查文档。
  if (isRecentAuditRequest(normalized)) {
    return { intent: 'query', confidence: 'high', score: 4, hits: ['失败自查'], reason: '读审计历史看上次为什么失败（只读）' };
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
  // PLC 预检缺口补齐 / 机型方案自查：先于通用打分，否则「补齐」会被判超纲或抢成生成。
  if (isMachineRepairRequest(normalized)) {
    return { intent: 'modify', confidence: 'high', score: 4, hits: ['PLC 缺口补齐'], reason: '补齐 PLC 预检缺口（写操作，需确认）' };
  }
  if (isMachineValidateRequest(normalized)) {
    return { intent: 'query', confidence: 'high', score: 3, hits: ['机型自查'], reason: '只读校验机型方案的结构与绑定' };
  }
  // 机型库的存取/列举/导出：以「机型库」为锚点直接给意图，别让「保存/列出」这类
  // 词被通用规则判成超纲（planTool 侧另有 planMachineLibraryRequest 负责选工具）。
  if (MACHINE_LIBRARY_NOUN.test(normalized) && !/(成本|报价|价格|干涉|电气校验|载流量)/.test(normalized)) {
    // 远程下载先于列举/导出：句子常同时带「有哪些」（问目录里有什么），但落点是下载。
    if (/(?:下载|拉取|拉下来|装下来|同步下来)/.test(normalized) && /(?:远程|来源|目录|机型)/.test(normalized)) {
      return { intent: 'modify', confidence: 'high', score: 4, hits: ['机型库远程下载'], reason: '从远程目录下载机型入库（写操作，需确认）' };
    }
    if (/(?:有哪些|有什么|列出|列举|列一下|清单|列表|看看|查看|查一下|几台)/.test(normalized)) {
      return { intent: 'query', confidence: 'high', score: 3, hits: ['机型库'], reason: '列举机型库（只读）' };
    }
    if (/(?:导出|打包|分享|发给|拷贝|复制出)/.test(normalized)) {
      return { intent: 'generate', confidence: 'high', score: 3, hits: ['机型库导出'], reason: '导出机型包（写 userData/exports，需确认）' };
    }
    if (/(?:存进|存入|保存|入库|收录|收进|放进|写入|打包进|加载|载入|读取|恢复|切换|切到|调出)/.test(normalized)) {
      return { intent: 'modify', confidence: 'high', score: 4, hits: ['机型库'], reason: '机型库存取（写操作，需确认）' };
    }
  }
  // 截图请求：先于通用打分，否则「截图」既不匹配意图词也会被拆句拆坏。
  if (isCaptureRequest(normalized)) {
    return { intent: 'query', confidence: 'high', score: 3, hits: ['截图'], reason: '截取当前视图作为证据（只读，落盘返回 path 与 sha256）' };
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

/** 目前注册的 38 个工具里，只读 19 个、写操作 19 个。 */
export const READ_ONLY_TOOLS = new Set([
  'list_components',
  'search_components',
  'search_docs',
  'design_machine',
  'get_bom',
  'get_render_stats',
  'get_project_context',
  'run_interference_check',
  'suggest_kinematics',
  'run_electrical_check',
  'run_cost_report',
  'verify_plc_program',
  // 只读列机型库：不写库、不改 active
  'list_machine_library',
  // 只读列远程来源与目录里可下载的机型（只写 sources-cache 缓存，不动库与 active）
  'list_machine_sources',
  // 只读自查方案：只返回 issues，不落盘、不改 active
  'validate_machine_design',
  // 只读截图：写 userData/agent-shots（证据文件），不改工程与机型
  'capture_view',
  // 只读跨会话项目记忆：只读 agent-memory.json，不写不删
  'get_agent_memory',
  // 只读回取已落盘的大工具结果：只读 agent-results/<sha16>.json，不重跑工具、不改工程
  'get_tool_result',
  // 只读自查失败历史：只读 agent-audit(.N).jsonl，不写审计、不改工程；只回工具名/错误码/耗时/白名单参数
  'get_recent_audit'
]);

export const WRITE_TOOLS = new Set([
  'apply_machine_design',
  // 会替换当前视口里的模型（虽然不写工程文件），仍需确认
  'build_machine_model',
  // 写工程文件（画布方案 → 示意装配工程），需要确认
  'build_canvas_assembly',
  // 把当前视口模型逐件存成工程（导入模型落库），需要确认
  'save_scene_as_project',
  'import_cad',
  'insert_component',
  'place_component',
  'update_component',
  'remove_component',
  'run_plc_generate',
  'export_files',
  'undo_last',
  'export_cost_report',
  // 机型库：入库写 userData/machine-library，等同于文件写
  'save_machine_to_library',
  // 加载会把 active.json 指过去并刷 3D
  'load_machine_from_library',
  // 导出写 userData/exports
  'export_machine_package',
  // 远程下载：写 userData/machine-library（联网 + 落盘），且没有 overwrite 参数
  'download_machine_from_source',
  // 补齐会写回 machine/<id>.json 并刷新联调配置（默认 dryRun 只读预览，但工具本身是写）
  'repair_plc_config',
  // 清空 agent-memory.json 里当前工程的桶（删记录，等同文件写）
  'clear_agent_memory'
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

const MACHINE_LIBRARY_NOUN = /(?:机型库|机器库|模板库)/;

/**
 * 机型库的四个动作（离线规则通道）。
 *
 * 必须放在 planToolBase 的最前面：`isMachineApplyRequest` 会把「把当前机型写入机型库」
 * 抢成 apply_machine_design（那是把方案落到工程，不是入库），而 routeIntent 对
 * 「保存到机型库」这类句子容易判成超纲。这里以「机型库」为锚点先分流。
 */
function planMachineLibraryRequest(value: string): ToolPlan | null {
  if (!MACHINE_LIBRARY_NOUN.test(value)) return null;
  // 显式「id: xxx」优先；否则取句子里唯一的连字符 token（design-screw-3st 这类机型 id）
  const id = value.match(/(?:机型|机器|模板)?\s*(?:id|ID|编号)\s*[:：=]?\s*([A-Za-z0-9][A-Za-z0-9._-]*)/)?.[1]
    ?? value.match(/([A-Za-z][A-Za-z0-9._]*(?:-[A-Za-z0-9._]+)+)/)?.[1];

  // 远程来源：先判下载，再判「列出」。
  // 顺序上的坑：「看看远程目录里能下载什么」既有下载动词又有机型字样，但它要的是**列目录**
  // （没有具体机型 id）；只有句子里点出了机型 id，才算「下载这一台」。
  const remote = /(?:远程|在线|来源|目录)/.test(value);
  if (remote && /(?:下载|拉取|拉下来|装下来|同步下来)/.test(value)) {
    const listWords = /(?:有哪些|有什么|什么可|看看|查看|列出|列举|清单|列表|目录里)/.test(value);
    if (id || (!listWords && /(?:机型|机器|模板)/.test(value))) {
      const sourceId = value.match(/(?:来源|source)\s*[:：=]?\s*([A-Za-z0-9][A-Za-z0-9._-]*)/i)?.[1];
      const machineId = id;
      return {
        tool: 'download_machine_from_source',
        args: {
          ...(sourceId ? { sourceId } : {}),
          ...(machineId ? { machineId } : {})
        },
        readOnly: false,
        missing: [
          ...(sourceId ? [] : ['sourceId']),
          ...(machineId ? [] : ['machineId'])
        ],
        why: '从远程目录下载机型：限 https/50 MiB、比对 SHA-256 后走同一套严格导入（需确认，同名不覆盖）'
      };
    }
  }
  if (remote && /(?:来源|目录|在线|可下载|远端|catalog)/i.test(value)) {
    return {
      tool: 'list_machine_sources',
      args: {},
      readOnly: true,
      missing: [],
      why: '只读列出远程来源、连通性与目录里可下载的机型'
    };
  }

  if (/(?:导出|打包|分享|发给|拷贝|复制出)/.test(value)) {
    return {
      tool: 'export_machine_package',
      args: { ...(id ? { id } : {}) },
      readOnly: false,
      missing: id ? [] : ['id'],
      why: '把机型库里的机型导出成 .machine.zip（写 userData/exports，需确认）'
    };
  }
  if (/(?:存进|存入|保存|入库|收录|收进|放进|写入|打包进)/.test(value)) {
    return {
      tool: 'save_machine_to_library',
      args: { ...(id ? { id } : {}) },
      readOnly: false,
      missing: [],
      why: '把当前机型存进机型库（同名已存在必须显式传 overwrite，需确认）'
    };
  }
  if (/(?:加载|载入|读取|恢复|切换|切到|调出)/.test(value)) {
    return {
      tool: 'load_machine_from_library',
      args: { ...(id ? { id } : {}) },
      readOnly: false,
      missing: id ? [] : ['id'],
      why: '从机型库加载机型并刷新 3D（需确认）'
    };
  }
  if (/(?:有哪些|有什么|列出|列举|列一下|清单|列表|看看|查看|查一下|几台)/.test(value)) {
    return {
      tool: 'list_machine_library',
      args: {},
      readOnly: true,
      missing: [],
      why: '只读列出机型库里已有的机型'
    };
  }
  return null;
}

/**
 * 跨会话项目记忆：清空（写）/ 回忆（只读）。
 *
 * 清空必须点明「记忆」二字，避免把「删除审计里的失败记录」这类（越权/审计篡改）
 * 抢成清记忆。回忆只认「你记得…做了什么 / 上次改了什么 / 项目记忆」这类问句。
 */
export function isProjectMemoryClearRequest(text: string): boolean {
  const value = (text ?? '').trim();
  if (!value) return false;
  return /(?:忘掉|清除|清空|删除|删掉|重置)[^。；;\n]{0,12}记忆|记忆[^。；;\n]{0,8}(?:清空|清除|忘掉|删掉|重置)/.test(value);
}

export function isProjectMemoryRecallRequest(text: string): boolean {
  const value = (text ?? '').trim();
  if (!value) return false;
  return /(?:项目记忆|跨会话记忆|操作记忆)/.test(value)
    || /你(?:还)?记得[^。；;\n]{0,12}(?:上次|之前|做过|改过|哪台|什么|哪些)/.test(value)
    || /(?:上次|之前)[^。；;\n]{0,8}(?:做了什么|改了什么|干了什么|动过什么|用过哪台|哪台机型)/.test(value);
}

/**
 * 「把刚才那个完整结果给我看看」——超限工具结果被外置后要求回取。
 *
 * 只认「完整/全部/全文 + 结果（回执）」且带取回语气，或明确说「结果被截断了，继续读」。
 * 导出/成本报告类句子一律排除：那是生成任务，抢过来会变成「回取一份不存在的旧结果」。
 * 离线规则拿不到 resultId（它只出现在回执里），所以计划里 missing 记为 resultId，
 * 由会话层如实说明「需要回执里的 resultId」而不是瞎猜一个。
 */
export function isToolResultRecallRequest(text: string): boolean {
  const value = (text ?? '').trim();
  if (!value) return false;
  if (/get_tool_result/.test(value)) return true;
  if (/(?:成本|报价|费用|报告|导出|生成|打印)/.test(value)) return false;
  if (/(?:完整|全部|全文|整份)[^。；;\n]{0,6}(?:结果|回执)/.test(value)
    && /(?:给|看|读|取|拿|发|来|继续|接着|续|要)/.test(value)) {
    return true;
  }
  return /(?:结果|回执)[^。；;\n]{0,8}(?:被)?(?:截断|截了|只看了一半|看不全|不全)/.test(value)
    && /(?:继续|接着|续读|看完|读全|完整|全部|取回|拿全)/.test(value);
}

/**
 * 失败自查请求（只读）：问「上次为什么不行」时要查审计，而不是盲目重跑同一组参数。
 * 负向：纯文档提问（「为什么 PLC 预检会失败」）没有「上次/刚才」这类历史锚点，仍走知识库。
 */
export function isRecentAuditRequest(text: string): boolean {
  const value = (text ?? '').trim();
  if (!value) return false;
  // 审计篡改：带删/清/改/回退动词的句子不接，交给 guard 一律拒绝（不能借「自查」包装成写操作）。
  if (/审计/.test(value) && /(?:删除|删掉|清空|清除|抹掉|擦除|篡改|改掉|隐藏|回退|撤回|撤销|覆盖|拿掉|去掉|移除)/.test(value)) {
    return false;
  }
  if (/get_recent_audit/.test(value)) return true;
  if (/(?:审计记录|调用记录|工具调用历史|失败历史|上次的?报错)/.test(value)) return true;
  const past = /(?:上次|上一次|刚才|刚刚|之前|前面|最近|历史)/.test(value);
  const failure = /(?:为什么|为啥|怎么回事|什么原因|报错|错误|失败|不成功|不行|没通过|卡住)/.test(value);
  return past && failure;
}

/** 从「上次生成 PLC 为什么不行」里抽过滤参数：只猜工具名、只看失败与时间窗，不猜别的。 */
function recentAuditArgs(text: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (/(?:生成|跑|编)[^。；\n]{0,6}plc|plc[^。；\n]{0,6}(?:生成|程序)/i.test(text)) {
    args.tool = 'run_plc_generate';
  } else if (/(?:补齐|补全|修复)[^。；\n]{0,8}(?:plc|预检|缺口|急停|安全回路)/.test(text)) {
    args.tool = 'repair_plc_config';
  } else if (/(?:应用|落盘|写入)[^。；\n]{0,8}(?:机型|方案|工程)/.test(text)) {
    args.tool = 'apply_machine_design';
  }
  if (/(?:失败|报错|错误|不成功|不行|没通过|为什么|原因)/.test(text)) args.onlyFailed = true;
  if (/最近\s*(?:一|1)\s*天|24\s*小时/.test(text)) args.sinceMinutes = 1440;
  else if (/最近\s*(?:两|二|2)\s*天/.test(text)) args.sinceMinutes = 2880;
  else if (/最近\s*(?:三|3)\s*天/.test(text)) args.sinceMinutes = 4320;
  else if (/最近\s*(?:七|7)\s*天|一周/.test(text)) args.sinceMinutes = 10080;
  return args;
}

/**
 * 把中文指令映射成一个工具计划。
 * 返回 null 表示「没有任何工具能接住」，调用方应如实说做不了。
 */
function planToolBase(text: string): ToolPlan | null {
  const value = (text ?? '').trim();
  if (!value) return null;
  // 跨会话项目记忆：读/清都在意图分类之前判，避免「忘掉这个项目的记忆」被当成 out_of_scope。
  if (isProjectMemoryClearRequest(value)) {
    return {
      tool: 'clear_agent_memory',
      args: {},
      readOnly: false,
      missing: [],
      why: '清空本工程的跨会话记忆（只清当前工程，需确认；不动其他工程与工程文件）'
    };
  }
  if (isProjectMemoryRecallRequest(value)) {
    return {
      tool: 'get_agent_memory',
      args: {},
      readOnly: true,
      missing: [],
      why: '读取本工程最近的成功操作事实（跨会话，只读；最多 20 条）'
    };
  }
  // 大结果回取：必须在本轮意图分类之前判，否则「完整结果」会被判成超纲。
  if (isToolResultRecallRequest(value)) {
    return {
      tool: 'get_tool_result',
      args: {},
      readOnly: true,
      missing: ['resultId'],
      why: '按 resultId 分批读回被截断的完整工具结果（只读，不重跑原工具）'
    };
  }
  if (isRecentAuditRequest(value)) {
    return {
      tool: 'get_recent_audit',
      args: recentAuditArgs(value),
      readOnly: true,
      missing: [],
      why: '读审计历史自查上次为什么失败（只读；按工具名 + onlyFailed 过滤，不盲目重试）'
    };
  }
  const libraryPlan = planMachineLibraryRequest(value);
  if (libraryPlan) return libraryPlan;
  // PLC 预检缺口补齐 / 机型方案自查：必须在 apply/design/verify 之前判断。
  // 「补齐方案再写入工程」这类句子会被 isMachineApplyRequest 抢成 apply_machine_design，
  // 而这里要的是先补齐（apply 需要先有一份合法 config）。
  if (isMachineRepairRequest(value)) {
    const write = /(?:确认|直接|落盘|写入|保存|存盘|按这个|就这么)/.test(value);
    return {
      tool: 'repair_plc_config',
      args: { dryRun: !write },
      readOnly: false,
      missing: [],
      why: write
        ? '按最小改动补齐 PLC 预检缺口并写回机型方案（需确认；只加到位检测与安全回路）'
        : '先只读预览要补哪些点位与安全回路（dryRun，不写盘）'
    };
  }
  if (isMachineValidateRequest(value)) {
    return {
      tool: 'validate_machine_design',
      args: {},
      readOnly: true,
      missing: [],
      why: '只读自查当前机型方案的结构与绑定（与落盘/预检同一判定源，不写盘、不改工程）'
    };
  }
  // 这两条必须写在最前面：意图分类会把「存为工程」判成 out_of_scope 提前 return null，
  // 也会把「画布方案生成整机 3D」抢成 build_machine_model（那是参数化整机，不是画布占位装配）。
  // 画布方案 → 整机 3D 装配工程（离线规则此前没有入口，评估集因此报「未覆盖工具」）
  if (/(?:画布|工作台|方案)[^。；;\n]{0,14}(?:生成|变成|转成|做成|导出|建)[^。；;\n]{0,10}(?:整机|三维|3d|装配)|(?:生成|变成|转成|做成|建)[^。；;\n]{0,6}整机[^。；;\n]{0,6}(?:三维|3d|装配)/i.test(value)) {
    return {
      tool: 'build_canvas_assembly',
      args: {},
      readOnly: false,
      missing: [],
      why: '把当前画布方案按工位尺寸生成示意装配工程（不含真实几何，质量为未称重，需确认）'
    };
  }
  if (/(?:当前|这个|该|视口|已导入|导入的)[^。；;\n]{0,10}(?:模型|装配|场景|零件)[^。；;\n]{0,8}(?:存|保存|另存|建|落)[^。；;\n]{0,4}工程|(?:存|保存|另存)(?:为|成)?工程/.test(value)) {
    return {
      tool: 'save_scene_as_project',
      args: {},
      readOnly: false,
      missing: [],
      why: '把当前视口逐件导出 STL 并存成工程（需确认）'
    };
  }
  if (/(?:验证|模拟|自检|仿真|空跑|试跑|试运行).*(?:plc|程序)|(?:plc|程序).*(?:验证|模拟|自检|仿真|空跑|试跑|试运行)/i.test(value)) {
    return {
      tool: 'verify_plc_program',
      args: {},
      readOnly: true,
      missing: [],
      why: '先预检再生成，并用内置模拟器跑联调序列（不落盘、不写 PLC）'
    };
  }
  // 「把当前机型建成实体模型」= 走参数化内核出真实实体并装配进视口（写视口、不写工程）
  if (isMachineModelRequest(value)) {
    return {
      tool: 'build_machine_model',
      args: {},
      readOnly: false,
      missing: [],
      why: '按当前机型参数生成整机实体模型并装配进视口（需确认；只改视口，不写工程文件）'
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
  if (isCaptureRequest(value)) {
    const view = /机型库/.test(value) ? 'library' : /联动|动作|播放/.test(value) ? 'linkage' : /导出|文件|产物/.test(value) ? 'exports' : '3d';
    return {
      tool: 'capture_view',
      args: { view },
      readOnly: true,
      missing: [],
      why: `截取 ${view} 视图并落盘，返回文件路径、字节数与 sha256（默认 1600×1000）`
    };
  }
  if (/(?:渲染统计|渲染指标|渲染状态|帧率|帧时间|每帧|fps|不跟手|拖动.{0,8}(?:卡|慢)|软件渲染|swiftshader|llvmpipe)/i.test(value)) {
    return {
      tool: 'get_render_stats',
      args: {},
      readOnly: true,
      missing: [],
      why: '读取当前视口渲染器、软件渲染标记、零件/三角形数与最近拖动帧时间'
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