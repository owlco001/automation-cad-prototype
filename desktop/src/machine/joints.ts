// 结构连接的**显式声明**：哪些零件本来就该共位（立柱插横梁、立柱接台面、立柱接底板、横梁接立柱、
// 传感器支架、执行机构安装座）。
//
// 为什么需要它：干涉初筛如果按「都是结构件 → 算共位」来放行，那真正的结构撞车也会被一起放行；
// 如果完全不声明，立柱插横梁这种正常装配又会一直报。所以只放行**列在这里的连接**，
// 不在表里的重叠一律算「需人工确认」。
//
// 这里按生成器的构件命名规则匹配（id 前缀/后缀），不是几何推断。新增构件类型时要把规则加进来，
// 否则它会以「需人工确认」出现在初筛里——这是有意的，宁可多报也不要漏。

export interface DeclaredJoint {
  a: string;
  b: string;
  /** 人话原因，直接显示在界面上 */
  reason: string;
}

interface Rule {
  a: RegExp;
  b: RegExp;
  reason: string;
}

const RULES: Rule[] = [
  { a: /^frame-leg-\d+$/, b: /^frame-stringer-/, reason: '立柱插横梁' },
  { a: /^frame-leg-\d+$/, b: /^frame-top$/, reason: '立柱接台面' },
  { a: /-upright-[lr]$/, b: /-plate$/, reason: '工位立柱接底板' },
  { a: /-beam$/, b: /-upright-[lr]$/, reason: '门架横梁接立柱' },
  { a: /-mount$/, b: /-(body|base)$/, reason: '执行机构接安装座' },
  { a: /^conveyor-frame$/, b: /^conveyor-(belt|motor)$/, reason: '输送线组件' }
];

/** 把 `sensor-<key>-bracket` 拆出 `<key>`；不是支架返回 null。 */
function bracketStem(id: string): string | null {
  const match = /^(sensor-.+)-bracket$/.exec(id);
  return match ? (match[1] ?? null) : null;
}

/**
 * 「传感器接支架」必须**同源**：`sensor-X-bracket` 只接 `sensor-X`（或它自己的
 * 安全光栅端 `sensor-X-tx/rx`）。
 *
 * 为什么不用 /^sensor-/ 一条正则了事：那样任何 `sensor-*` 都算，连
 * 「支架 × 支架」这种布置冲突也会被当成已声明连接放行 —— 实测光伏转向机
 * 3 对支架互插 17500 mm³ 就是这么被挡下来的。跨传感器的「A 支架接 B 本体」
 * 也不是装配关系，同样不能放行。
 */
function sameSensorStem(a: string, b: string): boolean {
  const stemA = bracketStem(a);
  const stemB = bracketStem(b);
  if (!stemA && !stemB) return false;
  const stem = stemA ?? stemB;
  const body = stemA ? b : a;
  if (!body.startsWith('sensor-') || bracketStem(body) !== null) return false;
  return body === stem || body === `${stem}-tx` || body === `${stem}-rx`;
}

function matchOne(rule: Rule, a: string, b: string): boolean {
  return (rule.a.test(a) && rule.b.test(b)) || (rule.a.test(b) && rule.b.test(a));
}

function ruleFor(a: string, b: string): string | null {
  const rule = RULES.find((candidate) => matchOne(candidate, a, b));
  if (rule) return rule.reason;
  return sameSensorStem(a, b) ? '传感器接支架' : null;
}

/** 返回所有「已声明」的连接对（按 id 排序，便于去重与断言）。 */
export function declaredJoints(parts: any[]): DeclaredJoint[] {
  const joints: DeclaredJoint[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    for (let j = i + 1; j < parts.length; j += 1) {
      const a = String(parts[i]?.id ?? '');
      const b = String(parts[j]?.id ?? '');
      const reason = ruleFor(a, b);
      if (reason === null) continue;
      joints.push(a < b ? { a, b, reason } : { a: b, b: a, reason });
    }
  }
  return joints;
}

/** 连接对是否已声明（用 a|b 的排序键比较）。 */
export function jointKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
