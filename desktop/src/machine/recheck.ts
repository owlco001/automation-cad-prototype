// 真实布尔复核：把 AABB 初筛出来的「疑似干涉」拿去问 sidecar，分成「确认干涉」和「AABB 误报」。
//
// 为什么需要：AABB 看不见孔、也把圆柱当方块（实测圆柱相贯高估 ×1.273，螺栓穿孔 100% 误报）。
// 所以初筛只能说「疑似」，结论要落到真实布尔上。
//
// 能复核什么：`box`（无旋转）与沿 Z 的 `cylinder`——sidecar 的算子就能表达这两个。
// 能复核：`box`（含 `rotationZDeg`：居中→绕自身转→平移）、沿 Z 的 `cylinder`（绕 Z 自转不影响形状）。
// 不能复核的（沿 X/Y 的圆柱）如实标 `unsupported`，不假装复核过。

import type { GeomPart, Vec3 } from './geometry.ts';

export interface SidecarMember {
  ops: Array<Record<string, unknown>>;
  offset: Vec3;
}

export interface MemberResult {
  ok: boolean;
  member?: SidecarMember;
  reason?: string;
}

/**
 * 把一个整机零件翻译成 sidecar 的成员。
 *
 * 注意坐标系差：sidecar 的 `box` 以**原点角**对齐（align=MIN），整机零件记的是**中心**，
 * 所以 offset 要减半个尺寸；`cylinder` 在 sidecar 里以原点为中心，offset 就是中心。
 */
export function partToMember(part: GeomPart): MemberResult {
  const rotation = ((part.rotationZDeg % 360) + 360) % 360;
  if (part.shape.type === 'box') {
    if (rotation !== 0) {
      // 带转角的方块：先把盒子的几何中心放到原点 → 绕原点转 Z（= 绕自身中心转）→ 平移到实际中心。
      // 之前这里一律标 unsupported，结果六工位那 8 对（整机整体转 60°）永远复核不了。
      const [sx, sy, sz] = part.shape.size;
      return {
        ok: true,
        member: {
          ops: [
            { op: 'box', length: sx, width: sy, height: sz, anchor: 'center' },
            { op: 'rotate', deg: rotation },
            { op: 'move', x: part.center[0], y: part.center[1], z: part.center[2] }
          ],
          offset: [0, 0, 0]
        }
      };
    }
    const [sx, sy, sz] = part.shape.size;
    return {
      ok: true,
      member: {
        ops: [{ op: 'box', length: sx, width: sy, height: sz }],
        offset: [part.center[0] - sx / 2, part.center[1] - sy / 2, part.center[2] - sz / 2]
      }
    };
  }
  const shape = part.shape;
  if (shape.axis !== 'z') {
    return { ok: false, reason: `零件 ${part.id} 是沿 ${shape.axis.toUpperCase()} 的圆柱，sidecar 只支持沿 Z` };
  }
  // 沿 Z 的圆柱绕 Z 自转形状不变，rotationZDeg 可以忽略（不是“不支持”）
  return {
    ok: true,
    member: {
      ops: [{ op: 'cylinder', diameter: shape.radius * 2, height: shape.length }],
      offset: [part.center[0], part.center[1], part.center[2]]
    }
  };
}

export interface RecheckPairResult {
  a: string;
  b: string;
  /** 真实布尔交集体积（mm³），复核不到时为 null */
  overlapMm3: number | null;
  /** confirmed = 真撞；misreported = AABB 误报；unchecked = 复核不了 */
  verdict: 'confirmed' | 'misreported' | 'unchecked';
  reason?: string;
}

export interface RecheckResult {
  checked: number;
  confirmed: number;
  misreported: number;
  unchecked: number;
  pairs: RecheckPairResult[];
  /** false 表示没能连上 sidecar，此时任何「已复核」的说法都不成立 */
  available: boolean;
  message?: string;
}

interface RecheckOptions {
  buildUrl: string;
  /** sidecar 的 Bearer token（app.py 用 Authorization: Bearer 校验）；不给则按无鉴权处理 */
  token?: string;
  /** 只复核前 N 对（初筛可能有几十对，全量跑很慢） */
  limit?: number;
  timeoutMs?: number;
}

interface InterferePayload {
  ok?: boolean;
  message?: string;
  pairs?: Array<{ overlapMm3: number }>;
}

/** 错误信息里带多少字符的响应原文（够看清是 HTML 错误页还是空 body）。 */
const SNIPPET_LIMIT = 200;

/**
 * 错误信息/日志里不准出现凭证：token 原文、它的 base64 变体、Authorization / Bearer 头，
 * 最后再兜一层「长随机串」。
 *
 * 为什么要抹：sidecar 或中间反代有时会把请求头回显进错误页，"打印响应摘要" 这种便利
 * 很容易顺手把 Bearer 打出来，日志一传就等于凭证泄露。
 *
 * 取舍：①②③④ 是「确定含凭证」的规则，宁可多抹（漏抹不可逆）；⑤ 是「猜」的兜底，
 * 只在**给了 token**（确实有凭证要护）时启用，且只抹长得像凭据的串——过度抹会把
 * 「哪个零件 / 哪个 case」这类唯一有用的定位信息一起抹掉，把可排查的失败变成不可排查。
 */
function redact(value: string, token: string | undefined): string {
  let text = value;
  if (token) {
    // ① token 原文
    text = text.split(token).join('***');
    // ② token 的 base64 / base64url 变体（含无 padding 形式）：
    //    反代把 `Authorization: Basic <b64>` 回显出来时，整词替换完全挡不住（实测原文照出）。
    for (const variant of tokenVariants(token)) {
      if (variant.length >= 8) text = text.split(variant).join('***');
    }
    // ③ token 片段：只剩前半截（截断日志、`token prefix xxx` 之类）时整词替换一样漏。
    //    这里把 token 的每个 ≥6 字符前缀都当敏感串——错抹的代价只是少看几个字符，漏抹就是交出凭证。
    for (let length = token.length - 1; length >= 6; length -= 1) {
      text = text.split(token.slice(0, length)).join('***');
    }
  }
  // ④ 头名 + 值一起抹（`authorization: bearer xxx` 这类整体吃掉）
  text = text.replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?\S+/gi, '$1***');
  text = text.replace(/bearer\s+\S+/gi, 'Bearer ***');
  // ⑤ 兜底：只抹「长得像凭据」的长串，而且只在给了 token 时启用。
  //    上一版是 `/[A-Za-z0-9_\-+/]{20,}/` 一律抹，实测把 UUID、长零件 id、长路径段都抹成 `***`：
  //    `unknown part id: station-1-rotary-table-assembly` → `unknown part id: ***`，
  //    而「是哪个零件」正是复核失败时唯一有用的信息。判据见 looksLikeCredential()。
  if (token) {
    text = text.replace(/[A-Za-z0-9_\-+/]{20,}/g, (run) => (looksLikeCredential(run) ? '***' : run));
  }
  return text;
}

/**
 * 一个 ≥20 字符的连续串是否「长得像凭据」。三条判据，满足其一即抹：
 *
 * ① 同时含大写 + 小写 + 数字 —— API key / base64 / 签名 的通用形态。
 * ② 纯十六进制且 ≥24 字符 —— 哈希、签名（如 a1b2c3d4e5f60718…）。
 * ③ 含 `-_+/` 分隔、≥28 字符，且存在 ≥13 字符的连续段 —— 被分隔符切断的 base64/签名。
 *
 * 故意**不**命中：UUID（8-4-4-4-12，最长段 12）、kebab 零件 id（每段都是英文单词）、
 * 普通路径段（`automationcad-prototype` 这类同样是单词段）。这些是排查线索，不是凭证。
 */
function looksLikeCredential(run: string): boolean {
  const hasUpper = /[A-Z]/.test(run);
  const hasLower = /[a-z]/.test(run);
  const hasDigit = /[0-9]/.test(run);
  if (hasUpper && hasLower && hasDigit) return true;
  if (run.length >= 24 && /^[0-9a-fA-F]+$/.test(run)) return true;
  if (run.length >= 28 && /[-_+/]/.test(run)) {
    const longest = run.split(/[-_+/]/).reduce((max, segment) => Math.max(max, segment.length), 0);
    if (longest >= 13) return true;
  }
  return false;
}

/** token 的编码变体：base64 与 base64url，各自再带一份去 padding 的形式。 */
function tokenVariants(token: string): string[] {
  const base64 = toBase64(token);
  const url = base64.replace(/\+/g, '-').replace(/\//g, '_');
  return [base64, base64.replace(/=+$/, ''), url, url.replace(/=+$/, '')];
}

/** 自带 base64 编码：不用 Buffer，是因为这个模块将来进了渲染进程就取不到它。 */
function toBase64(text: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = new TextEncoder().encode(text);
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index] ?? 0;
    const b1 = bytes[index + 1];
    const b2 = bytes[index + 2];
    out += alphabet.charAt(b0 >> 2);
    out += alphabet.charAt(((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4));
    out += b1 === undefined ? '=' : alphabet.charAt(((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6));
    out += b2 === undefined ? '=' : alphabet.charAt(b2 & 0x3f);
  }
  return out;
}

/** 响应摘要：脱敏 → 压平空白 → 截到 SNIPPET_LIMIT 字符；空 body 如实说「空」。 */
function bodySnippet(raw: string, token: string | undefined): string {
  const flat = redact(raw, token).replace(/\s+/g, ' ').trim();
  if (!flat) return '（空响应体）';
  return flat.length > SNIPPET_LIMIT ? `${flat.slice(0, SNIPPET_LIMIT)}…` : flat;
}

export async function recheckPairs(
  parts: GeomPart[],
  suspects: Array<{ a: string; b: string }>,
  options: RecheckOptions
): Promise<RecheckResult> {
  const byId = new Map(parts.map((part) => [part.id, part]));
  const limit = options.limit ?? 40;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const picked = suspects.slice(0, limit);
  if (picked.length === 0) {
    // 没有疑似对：既不是「复核过没问题」，也不是「复核不了」——如实说「不需要」
    return { checked: 0, confirmed: 0, misreported: 0, unchecked: 0, pairs: [], available: true, message: '没有疑似干涉，无需复核' };
  }
  const results: RecheckPairResult[] = [];
  // 不可用分支也要把「已经复核完的那几对」交出去：以前这里直接给 checked:0 并把 pairs 之外的一切丢掉，
  // 结果一次中途失败就让前面跑完的结论凭空消失（case.json 里只剩一句话，没有任何证据）。
  const pairCounts = () => ({
    checked: results.length,
    confirmed: results.filter((item) => item.verdict === 'confirmed').length,
    misreported: results.filter((item) => item.verdict === 'misreported').length,
    unchecked: results.filter((item) => item.verdict === 'unchecked').length
  });
  /** 「已完成 N/M 对」的附注：不可用时也要让读者知道这次到底拿到了多少结论。
   *  这句会原样进 case.json、Qt 弹窗和 CI 日志，所以不写「pairs」这类 JSON 字段名——弹窗里没有指代。 */
  const partialNote = () =>
    results.length > 0 ? `（本次已完成 ${results.length}/${picked.length} 对，其余未复核）` : '';

  for (const suspect of picked) {
    const left = byId.get(suspect.a);
    const right = byId.get(suspect.b);
    if (!left || !right) {
      results.push({ a: suspect.a, b: suspect.b, overlapMm3: null, verdict: 'unchecked', reason: '零件不在几何里' });
      continue;
    }
    const memberA = partToMember(left);
    const memberB = partToMember(right);
    if (!memberA.ok || !memberB.ok) {
      results.push({
        a: suspect.a,
        b: suspect.b,
        overlapMm3: null,
        verdict: 'unchecked',
        reason: memberA.reason ?? memberB.reason ?? '零件无法翻译成 sidecar 成员'
      });
      continue;
    }

    let response: Response;
    try {
      response = await fetch(`${options.buildUrl.replace(/\/$/, '')}/interfere`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
        },
        body: JSON.stringify({ members: [memberA.member, memberB.member] }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      // 连不上就整体停：后面每一对都会是同一个错误，不能刷成「全部误报」
      return {
        ...pairCounts(),
        pairs: results,
        available: false,
        message: `复核不可用：${redact((error as Error).message, options.token)}（结论仍是 AABB 初筛，不能当真实布尔）${partialNote()}`
      };
    }
    // 鉴权失败必须单独说清楚：以前会被当成普通失败，最终表现为「复核不了」，
    // 排查时看不出是 token 配错（doc v6 §19.3 指出的盲区）。
    // 文案要点名 FT_BUILD_TOKEN 和 --token：只写「拒绝访问」时，研发会去查网络/代码，
    // 而不是去看自己 shell 里的环境变量和 sidecar 的启动参数。
    if (response.status === 401 || response.status === 403) {
      const hint = options.token
        ? '这次请求带了 token，但 sidecar 不认——大概率是 FT_BUILD_TOKEN 与 sidecar 的 --token 不是同一个值（或 sidecar 重启后 token 换过）'
        : '这次请求没带 token，而 sidecar 要求 Authorization: Bearer';
      return {
        ...pairCounts(),
        pairs: results,
        available: false,
        message:
          `复核不可用：sidecar 拒绝访问（HTTP ${response.status}）。${hint}。` +
          '请核对 sidecar 启动参数 --token 与本地环境变量 FT_BUILD_TOKEN 是否一致' +
          '——结论仍是 AABB 初筛，不能当真实布尔' +
          partialNote()
      };
    }
    // 响应体先拿到文本再自己 parse：原来直接 `response.json()`，sidecar 返回 500 HTML 或空 body 时
    // 抛的是原生 SyntaxError（"Unexpected token '<'"），既没有状态码也没有 body 摘要，等于没信息。
    let rawBody: string;
    try {
      rawBody = await response.text();
    } catch (error) {
      return {
        ...pairCounts(),
        pairs: results,
        available: false,
        message:
          `复核不可用：读取 sidecar 响应失败（HTTP ${response.status}）：${redact((error as Error).message, options.token)}` +
          '——结论仍是 AABB 初筛，不能当真实布尔' +
          partialNote()
      };
    }
    let payload: InterferePayload | null = null;
    // 「不是 JSON」和「是 JSON 但不是对象」是两回事：前者指向版本/反代出错，后者指向 sidecar 契约变了。
    // 以前两种都报「不是可解析的 JSON」，排查时被引到错误的方向（实测 body=null 时报「响应前 200 字符：null」，
    // 读者会以为 body 坏了，其实是 JSON 合法但形状不对）。
    let shapeProblem: 'not-json' | 'not-object' | null = null;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        shapeProblem = 'not-object';
      } else {
        payload = parsed as InterferePayload;
      }
    } catch {
      shapeProblem = 'not-json';
    }
    if (shapeProblem || !payload) {
      // 非 JSON / 空 body / 形状不对：全都无法判定干涉，如实报不可用，
      // 不能把这一对记成「不撞」（那是伪造结论）。状态码 + body 摘要足够定位是哪个 sidecar 版本/反代出了错。
      const what =
        shapeProblem === 'not-object' ? 'sidecar 响应不是预期的 JSON 对象' : 'sidecar 响应不是可解析的 JSON';
      return {
        ...pairCounts(),
        pairs: results,
        available: false,
        message:
          `复核不可用：${what}（HTTP ${response.status}），无法判定干涉。` +
          `响应前 ${SNIPPET_LIMIT} 字符：${bodySnippet(rawBody, options.token)}` +
          '——结论仍是 AABB 初筛，不能当真实布尔' +
          partialNote()
      };
    }
    if (!payload.ok) {
      results.push({
        a: suspect.a,
        b: suspect.b,
        overlapMm3: null,
        verdict: 'unchecked',
        // sidecar 的失败文案常常直接回显请求头（实测 `bad token: Authorization: Bearer xxx`），
        // 而这个 reason 会被 CI 日志、case.json 和 Qt 弹窗原样渲染——必须和 message 同一个脱敏口径。
        reason: redact(payload.message ?? 'sidecar 返回失败', options.token)
      });
      continue;
    }
    const overlap = payload.pairs?.[0]?.overlapMm3 ?? 0;
    results.push({
      a: suspect.a,
      b: suspect.b,
      overlapMm3: overlap,
      verdict: overlap > 1e-6 ? 'confirmed' : 'misreported'
    });
  }

  return {
    ...pairCounts(),
    pairs: results,
    available: true,
    ...(suspects.length > picked.length
      ? { message: `只复核了前 ${picked.length}/${suspects.length} 对（其余仍是 AABB 初筛）` }
      : {})
  };
}
