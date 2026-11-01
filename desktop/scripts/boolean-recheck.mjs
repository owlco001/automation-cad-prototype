// 拿真实布尔复核整机的「疑似干涉」：AABB 说撞，到底撞没撞？
//
// 用法：node scripts/boolean-recheck.mjs --case <case.json> [--url http://127.0.0.1:PORT] [--limit 40]
// sidecar 不在时如实打印「未复核」，不冒充结论。
//
// 结构：分支判定与打印文本都收在下面的纯函数里（describePair / buildRecheckReport / buildSkipReport），
// `main()` 只负责读文件、跑复核、把行打出去。抽出来的原因：UNAVAILABLE / PARTIAL 两个分支
// 以前只能靠手动起 sidecar 才走得到，没有任何自动化覆盖（test/machine/recheck-errors.test.mjs 现在直接断言它们）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { screenInterference } from '../src/machine/interference.ts';
import { recheckPairs } from '../src/machine/recheck.ts';

const SKIP_LINE = 'BOOLEAN_RECHECK_SKIP 没给 --url/FT_BUILD_URL：结论仍只是 AABB 初筛，未做真实布尔复核';

/** 单对的打印文本：结论标签 + 零件对 + （有结论时）体积 + （有原因时）原因。 */
export function describePair(pair) {
  const tag = pair.verdict === 'confirmed' ? '真撞' : pair.verdict === 'misreported' ? 'AABB 误报' : '复核不了';
  const volume = pair.overlapMm3 === null ? '' : ` ${pair.overlapMm3} mm³`;
  const reason = pair.reason ? `（${pair.reason}）` : '';
  return `  ${tag} ${pair.a} × ${pair.b}${volume}${reason}`;
}

export function pairLines(pairs) {
  return pairs.map(describePair);
}

/**
 * recheckPairs 的结果 → 要打印的行 + 退出码。
 *
 * - `available:false` 且一对都没跑完：只打 UNAVAILABLE，退出码 1；
 * - `available:false` 但已有完成的对：先打 UNAVAILABLE，再打 `BOOLEAN_RECHECK_PARTIAL` 与那些结论
 *   （中途失败不能把前面跑完的证据一起丢掉），退出码仍是 1；
 * - 正常：`BOOLEAN_RECHECK_OK` + 明细，退出码 0。
 */
export function buildRecheckReport(result) {
  if (!result.available) {
    const lines = [`BOOLEAN_RECHECK_UNAVAILABLE ${result.message ?? ''}`];
    if (result.pairs.length > 0) {
      lines.push(
        `BOOLEAN_RECHECK_PARTIAL checked=${result.checked} confirmed=${result.confirmed} misreported=${result.misreported} unchecked=${result.unchecked}`
      );
      lines.push(...pairLines(result.pairs));
      lines.push('  注：以上是中断前已完成的复核，未列出的对仍是 AABB 初筛');
    }
    return { status: 'unavailable', lines, exitCode: 1 };
  }
  const lines = [
    `BOOLEAN_RECHECK_OK checked=${result.checked} confirmed=${result.confirmed} misreported=${result.misreported} unchecked=${result.unchecked}`
  ];
  lines.push(...pairLines(result.pairs));
  if (result.message) lines.push(`  注：${result.message}`);
  return { status: 'ok', lines, exitCode: 0 };
}

/** 没给 --url/FT_BUILD_URL：不做复核（退出码 0，与「不可用」的 1 区分开）。 */
export function buildSkipReport() {
  return { status: 'skip', lines: [SKIP_LINE], exitCode: 0 };
}

/** `--flag value` 取值；没给就用 fallback。 */
function valueOf(args, flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
}

async function main() {
  const args = process.argv.slice(2);
  const casePath = valueOf(args, '--case', '');
  if (!casePath) {
    process.stderr.write('需要 --case <machine-case.json>\n');
    process.exit(2);
  }
  const document = JSON.parse(readFileSync(casePath, 'utf8'));
  const geometry = document.geometry ?? document;
  const parts = geometry.parts ?? [];
  const buildUrl = valueOf(args, '--url', process.env.FT_BUILD_URL ?? '');
  // sidecar 启动时会打印 token；不带就会 401（实测：能连上但每对都「sidecar 返回失败」）
  const buildToken = valueOf(args, '--token', process.env.FT_BUILD_TOKEN ?? '');
  const limit = Number(valueOf(args, '--limit', '40'));

  const screen = screenInterference(geometry, []);
  const suspects = screen.pairs.filter((pair) => pair.kind === 'suspect').map((pair) => ({ a: pair.a, b: pair.b }));

  console.log(`AABB 初筛：${parts.length} 个零件，疑似干涉 ${suspects.length} 对（其中已声明 ${screen.declared} 对）`);

  const report = buildUrl
    ? buildRecheckReport(
        await recheckPairs(parts, suspects, { buildUrl, limit, ...(buildToken ? { token: buildToken } : {}) })
      )
    : buildSkipReport();

  for (const line of report.lines) console.log(line);
  // 用 exitCode 而不是 process.exit()：进程正常返回，管道里的 stdout 不会被截断。
  process.exitCode = report.exitCode;
}

// 只有直接 `node scripts/boolean-recheck.mjs` 才跑：测试里 import 这些纯函数时不能触发读文件/发请求。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
