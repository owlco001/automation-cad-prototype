// 生成六工位锁螺丝机案例：解析 → 合成 → 真实型号 BOM → PLC IO。
// 全部结果写入 docs/desktop/eval/machine-case.json，文档中的数字以此为准。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMachineCase } from '../src/machine/case.ts';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const repoRoot = resolve(desktopRoot, '..');
const builtinDir = join(repoRoot, 'packs', 'builtin');
const outFile = join(repoRoot, 'docs', 'desktop', 'eval', 'machine-case.json');
const screenshotFile = join(repoRoot, 'docs', 'desktop', 'eval', 'machine-screenshots.json');

const BRIEF = '六工位锁螺丝机，节拍 20 件/分钟，每工位 1 套汇川 750W 伺服 + 1 个 SMC 气爪 + 1 个到位检测 + 安全光栅';
const pricebookFile = join(builtinDir, 'pricebook-cn', 'pricebook.json');

const partsDir = builtinDir;
const pricingAssumptions = ['machine-case.json 未读取 userData/machine-pricing.json，使用工程默认系数与工时单价。'];
const { caseData, design, mapping, ioMap } = buildMachineCase({
  brief: BRIEF,
  partsDir,
  ...(existsSync(pricebookFile) ? { pricebookFile } : {}),
  pricingAssumptions,
  ...(existsSync(screenshotFile) ? { screenshotFile } : {})
});

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(caseData, null, 2)}\n`, 'utf8');
console.log(`MACHINE_CASE_OK ${outFile}`);
console.log(`stations=${design.config.stations.length} actuators=${design.config.actuators.length} sensors=${design.config.sensors.length} points=${ioMap.rows.length}`);
console.log(`form=${design.form.id} range=${design.form.stationRange.join('-')} default=${design.form.defaultStations}`);
console.log(`cycle mode=${design.cycle.mode} station=${design.cycle.stationSeconds}s throughput=${design.cycle.throughputPerMin}/min meetsTarget=${design.cycle.meetsTarget} requiredStations=${design.cycle.requiredTotalStations}`);
console.log(`bomRows=${mapping.items.length} realParts=${caseData.bom.realPartCount} pending=${caseData.bom.pendingCount}`);
console.log(`power kw=${design.power.totalKw} a=${design.power.currentA} breaker=${design.power.breakerSuggestion.rating} dc24=${design.power.dc24?.marginPct ?? 'n/a'}`);
console.log(`cost total=${design.cost.total} material=${design.cost.material} electrical=${design.cost.electrical} labor=${design.cost.labor} missing=${design.cost.missingCount}`);
