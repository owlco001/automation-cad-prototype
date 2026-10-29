// 拿真实布尔复核整机的「疑似干涉」：AABB 说撞，到底撞没撞？
//
// 用法：node scripts/boolean-recheck.mjs --case <case.json> [--url http://127.0.0.1:PORT] [--limit 40]
// sidecar 不在时如实打印「未复核」，不冒充结论。
import { readFileSync } from 'node:fs';
import { screenInterference } from '../src/machine/interference.ts';
import { recheckPairs } from '../src/machine/recheck.ts';

const args = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};

const casePath = valueOf('--case', '');
if (!casePath) {
  process.stderr.write('需要 --case <machine-case.json>\n');
  process.exit(2);
}
const document = JSON.parse(readFileSync(casePath, 'utf8'));
const geometry = document.geometry ?? document;
const parts = geometry.parts ?? [];
const buildUrl = valueOf('--url', process.env.FT_BUILD_URL ?? '');
const limit = Number(valueOf('--limit', '40'));

const screen = screenInterference(geometry, []);
const suspects = screen.pairs
  .filter((pair) => pair.kind === 'suspect')
  .map((pair) => ({ a: pair.a, b: pair.b }));

console.log(`AABB 初筛：${parts.length} 个零件，疑似干涉 ${suspects.length} 对（其中已声明 ${screen.declared} 对）`);

if (!buildUrl) {
  console.log('BOOLEAN_RECHECK_SKIP 没给 --url/FT_BUILD_URL：结论仍只是 AABB 初筛，未做真实布尔复核');
  process.exit(0);
}

const result = await recheckPairs(parts, suspects, { buildUrl, limit });
if (!result.available) {
  console.log(`BOOLEAN_RECHECK_UNAVAILABLE ${result.message}`);
  process.exit(1);
}
console.log(`BOOLEAN_RECHECK_OK checked=${result.checked} confirmed=${result.confirmed} misreported=${result.misreported} unchecked=${result.unchecked}`);
for (const pair of result.pairs) {
  const tag = pair.verdict === 'confirmed' ? '真撞' : pair.verdict === 'misreported' ? 'AABB 误报' : '复核不了';
  console.log(`  ${tag} ${pair.a} × ${pair.b}${pair.overlapMm3 === null ? '' : ` ${pair.overlapMm3} mm³`}${pair.reason ? `（${pair.reason}）` : ''}`);
}
if (result.message) console.log(`  注：${result.message}`);
