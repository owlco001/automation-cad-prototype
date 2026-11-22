// 结构连接的**显式声明**：哪些零件本来就该共位（立柱插横梁、立柱接台面、立柱接底板、横梁接立柱、
// 传感器支架、执行机构安装座）。
//
// 为什么需要它：干涉初筛如果按「都是结构件 → 算共位」来放行，那真正的结构撞车也会被一起放行；
// 如果完全不声明，立柱插横梁这种正常装配又会一直报。所以只放行**列在这里的连接**，
// 不在表里的重叠一律算「需人工确认」。
//
// 这里按生成器的构件命名规则匹配（id 前缀/后缀），不是几何推断。新增构件类型时要把规则加进来，
// 否则它会以「需人工确认」出现在初筛里——这是有意的，宁可多报也不要漏。
//
// 性能口径：规则只依赖单个 id，所以在进入 O(n²) 零件对循环**之前**，每个零件只跑一遍规则，
// 把六条规则的命中情况压成两个位掩码；配对时只做位运算再取最低位（首匹配优先级）。
// 同时只枚举「至少可能成为连接一端」的零件：不参与任何规则、也不是传感器支架/本体的零件
// 不可能与任何零件成对，跳过它们不改变结果顺序或语义。

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

const RULE_REASONS = RULES.map((rule) => rule.reason);

/** 把 `sensor-<key>-bracket` 拆出 `<key>`；不是支架返回 null。 */
function bracketStem(id: string): string | null {
  const match = /^(sensor-.+)-bracket$/.exec(id);
  return match ? (match[1] ?? null) : null;
}

/**
 * 每个零件只算一次：规则命中位掩码 + 传感器归属。
 *
 * `aMask` 的 bit i 表示 `RULES[i].a` 命中该 id，`bMask` 同理。配对时
 * `(aMask & bMask') | (bMask & aMask')` 就是“该规则在任一方向命中”的集合；
 * 取最低位即等价于原来 `RULES.find(...)` 的首匹配。
 */
interface PartProfile {
  id: string;
  aMask: number;
  bMask: number;
  /** `sensor-<key>-bracket` 的 `<key>`；不是支架为 null */
  stem: string | null;
  /** 是 `sensor-*` 本体（不是支架） */
  sensorBody: boolean;
}

function profilePart(raw: any): PartProfile {
  const id = String(raw?.id ?? '');
  let aMask = 0;
  let bMask = 0;
  for (let index = 0; index < RULES.length; index += 1) {
    const rule = RULES[index];
    if (!rule) continue;
    if (rule.a.test(id)) aMask |= 1 << index;
    if (rule.b.test(id)) bMask |= 1 << index;
  }
  const stem = bracketStem(id);
  return {
    id,
    aMask,
    bMask,
    stem,
    sensorBody: stem === null && id.startsWith('sensor-')
  };
}

/** 同源判断：`sensor-X-bracket` 只接 `sensor-X` / `sensor-X-tx` / `sensor-X-rx`。 */
function bodyMatchesStem(bodyId: string, stem: string): boolean {
  return bodyId === stem || bodyId === `${stem}-tx` || bodyId === `${stem}-rx`;
}

function sameSensorProfile(a: PartProfile, b: PartProfile): boolean {
  if (a.stem !== null && b.stem === null && b.sensorBody) {
    if (bodyMatchesStem(b.id, a.stem)) return true;
  }
  if (b.stem !== null && a.stem === null && a.sensorBody) {
    if (bodyMatchesStem(a.id, b.stem)) return true;
  }
  return false;
}

/**
 * 本体只有在其 stem 真的存在于输入里时才可能成对；提前排除孤立本体，
 * 避免它们进入候选对。
 */
function sensorBodyHasStem(id: string, stems: Set<string>): boolean {
  if (stems.has(id)) return true;
  if (id.endsWith('-tx') && stems.has(id.slice(0, -3))) return true;
  if (id.endsWith('-rx') && stems.has(id.slice(0, -3))) return true;
  return false;
}

/** 返回所有「已声明」的连接对（按 id 排序，便于去重与断言）。 */
export function declaredJoints(parts: any[]): DeclaredJoint[] {
  const profiles = new Array<PartProfile>(parts.length);
  const stems = new Set<string>();
  for (let index = 0; index < parts.length; index += 1) {
    const profile = profilePart(parts[index]);
    profiles[index] = profile;
    if (profile.stem !== null) stems.add(profile.stem);
  }

  // 只保留可能成为连接一端的零件。顺序仍是原输入顺序，因此输出顺序不变。
  const candidates: number[] = [];
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];
    if (!profile) continue;
    if ((profile.aMask | profile.bMask) !== 0 || profile.stem !== null
      || (profile.sensorBody && sensorBodyHasStem(profile.id, stems))) {
      candidates.push(index);
    }
  }

  const joints: DeclaredJoint[] = [];
  for (let left = 0; left < candidates.length; left += 1) {
    const i = candidates[left];
    if (i === undefined) continue;
    const a = profiles[i];
    if (!a) continue;
    for (let right = left + 1; right < candidates.length; right += 1) {
      const j = candidates[right];
      if (j === undefined) continue;
      const b = profiles[j];
      if (!b) continue;
      const ruleMask = (a.aMask & b.bMask) | (b.aMask & a.bMask);
      let reason: string | null = null;
      if (ruleMask !== 0) {
        const ruleIndex = 31 - Math.clz32(ruleMask & -ruleMask);
        reason = RULE_REASONS[ruleIndex] ?? null;
      } else if ((a.stem !== null || b.stem !== null) && sameSensorProfile(a, b)) {
        reason = '传感器接支架';
      }
      if (reason === null) continue;
      const idA = a.id;
      const idB = b.id;
      joints.push(idA < idB ? { a: idA, b: idB, reason } : { a: idB, b: idA, reason });
    }
  }
  return joints;
}

/** 连接对是否已声明（用 a|b 的排序键比较）。 */
export function jointKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
