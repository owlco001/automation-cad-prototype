// 整机方案合成（brief → 方案级 machine-case）。
// 只有这一处实现：脚本 `build-machine-case.mjs`（写案例文件）与 CLI `machine-design-cli.mjs`（供 Qt 调用）都走这里，
// 避免两份逻辑漂移导致「文档里的数字」和「客户端算出来的数字」不一致。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMachineBrief } from './spec.ts';
import { synthMachine } from './synth.ts';
import { mapMachineBom } from './bom-map.ts';
import { buildMachineIoMap } from './io-map.ts';
import { estimatePower } from './power.ts';
import { estimateCost, DEFAULT_MACHINE_PRICING } from './cost-model.ts';
import { validatePricebook } from '../cost/pricebook.ts';

export interface BuildMachineCaseOptions {
  brief: string;
  partsDir: string;
  /** pricebook.json 路径；不存在或未给则不用价格簿 */
  pricebookFile?: string;
  /** 附加给成本/功率的假设说明，会原样进 case.assumptions */
  pricingAssumptions?: string[];
  /** 有截图校验文件时一并带上（案例文件用，CLI 不传） */
  screenshotFile?: string;
}

export interface BuiltMachineCase {
  caseData: any;
  design: any;
  mapping: any;
  ioMap: any;
}

export function buildMachineCase(options: BuildMachineCaseOptions): BuiltMachineCase {
  const { partsDir, pricebookFile, screenshotFile } = options;
  const briefText = options.brief;
  const pricingAssumptions = options.pricingAssumptions ?? [];
  const pricedPricing = DEFAULT_MACHINE_PRICING;
  const builtinDir = partsDir;

function loadBuiltinParts(builtinDir: string) {
  const parts = [];
  for (const entry of readdirSync(builtinDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const partsFile = join(builtinDir, entry.name, 'parts.json');
    if (!existsSync(partsFile)) continue;
    const manifestFile = join(builtinDir, entry.name, 'manifest.json');
    const manifest = existsSync(manifestFile)
      ? JSON.parse(readFileSync(manifestFile, 'utf8'))
      : { id: entry.name, name: entry.name };
    const raw = JSON.parse(readFileSync(partsFile, 'utf8'));
    const rows = Array.isArray(raw) ? raw : Array.isArray(raw.parts) ? raw.parts : [];
    for (const row of rows) {
      parts.push({
        id: String(row.id),
        model: String(row.model),
        category: String(row.category),
        specs: row.specs && typeof row.specs === 'object' ? row.specs : {},
        ...(typeof row.price === 'number' ? { price: row.price } : {}),
        packId: entry.name,
        packName: String(manifest.name ?? entry.name)
      });
    }
  }
  return parts;
}

function stationTable(design: any) {
  return design.config.stations.map((station: any) => {
    const actuators = design.config.actuators
      .filter((actuator: any) => actuator.station === station)
      .map((actuator: any) => ({
        id: actuator.id,
        kind: actuator.kind,
        name: actuator.name,
        points: [actuator.extendPoint, actuator.retractPoint, actuator.gripPoint, actuator.point].filter(Boolean)
      }));
    const sensors = design.config.sensors
      .filter((sensor: any) => sensor.station === station)
      .map((sensor: any) => ({ point: sensor.point, part: sensor.part }));
    return { station, actuators, sensors };
  });
}

const parts = loadBuiltinParts(partsDir);
const pricebook = pricebookFile && existsSync(pricebookFile)
  ? validatePricebook(JSON.parse(readFileSync(pricebookFile, 'utf8')))
  : undefined;
const brief = parseMachineBrief(briefText);
const design = synthMachine(brief, {
  parts,
  pricing: pricedPricing,
  pricingAssumptions,
  ...(pricebook ? { builtinPricebook: pricebook } : {})
});
const mapping = mapMachineBom(design, parts);
design.bomDraft = { items: mapping.items };
design.warnings.push(...mapping.pending.map((entry) => `${entry.name}：${entry.reason}`));
design.warnings.push(...mapping.notices);
const mainBreaker = mapping.items.find((item) => item.name === '总进线断路器');
const mainBreakerPart = mainBreaker?.partId
  ? parts.find((part) => part.id === mainBreaker.partId && part.packId === mainBreaker.packId)
  : undefined;
const selectedBreakerA = (() => {
  const raw = mainBreakerPart?.specs?.['额定电流'];
  if (typeof raw === 'number') return raw;
  const match = typeof raw === 'string' ? raw.match(/(\d+(?:\.\d+)?)\s*A/i) : null;
  return match?.[1] ? Number(match[1]) : undefined;
})();
design.power = estimatePower(design, {
  parts,
  voltage: design.power.voltage,
  simultaneity: pricedPricing.power.simultaneity,
  loadFactor: pricedPricing.power.loadFactor,
  efficiency: pricedPricing.power.efficiency,
  cosPhi: pricedPricing.power.cosPhi,
  ...(selectedBreakerA !== undefined ? { selectedBreakerA } : {}),
  assumptions: pricingAssumptions
});
design.cost = estimateCost(design, {
  parts,
  pricing: pricedPricing,
  pricingAssumptions,
  ...(pricebook ? { builtinPricebook: pricebook } : {})
});
const ioMap = buildMachineIoMap(design.config);

const caseData = {
  schemaVersion: 1,
  kind: 'machine-case',
  brief: briefText,
  parsed: brief,
  design: {
    config: design.config,
    points: design.points,
    cycle: design.cycle,
    power: design.power,
    cost: design.cost,
    form: design.form,
    warnings: design.warnings,
    assumptions: design.assumptions,
    bomDraft: design.bomDraft
  },
  cycleAnalysis: {
    mode: design.cycle.mode,
    targetPerMin: design.cycle.perMin,
    targetSecondsPerPiece: design.cycle.secondsPerPiece,
    stationSeconds: design.cycle.stationSeconds,
    throughputPerMin: design.cycle.throughputPerMin,
    estimatedSecondsPerPiece: design.cycle.estimatedSecondsPerPiece,
    baseSeconds: design.cycle.baseSeconds,
    slowestStation: design.cycle.slowestStation,
    slowestActionSeconds: design.cycle.slowestActionSeconds,
    meetsTarget: design.cycle.meetsTarget,
    requiredParallelStations: design.cycle.requiredParallelStations,
    requiredTotalStations: design.cycle.requiredTotalStations,
    verdict: design.cycle.meetsTarget
      ? design.cycle.mode === 'parallel'
        ? `当前方案按同工序并行满足目标节拍：单工位 ${design.cycle.stationSeconds} 秒/件 × ${brief.stations} 工位 ≈ ${design.cycle.throughputPerMin} 件/分钟`
        : `当前 ${design.cycle.mode} 布局满足目标节拍：最慢工位 ${design.cycle.stationSeconds} 秒/件 → ${design.cycle.throughputPerMin} 件/分钟`
      : design.cycle.mode === 'parallel'
        ? `当前并行方案未满足目标节拍，按现估算总工位至少 ${design.cycle.requiredTotalStations} 个`
        : `当前 ${design.cycle.mode} 布局未满足目标节拍，按现估算需每道工序 ${design.cycle.requiredParallelStations} 个并行工位，总工位至少 ${design.cycle.requiredTotalStations} 个`,
    bottleneck: design.cycle.bottleneck
  },
  stations: stationTable(design),
  bom: {
    items: mapping.items,
    pending: mapping.pending,
    notices: mapping.notices,
    sourcePacks: mapping.sourcePacks,
    realPartCount: mapping.items.filter((item) => item.partId).length,
    pendingCount: mapping.items.filter((item) => item.pendingSelection).length
  },
  electrical: mapping.electrical,
  cost: design.cost,
  ioMap: {
    rowCount: ioMap.rows.length,
    rows: ioMap.rows,
    csv: ioMap.csv
  },
  screenshotValidation: screenshotFile && existsSync(screenshotFile)
    ? JSON.parse(readFileSync(screenshotFile, 'utf8'))
    : null
};


  return { caseData, design, mapping, ioMap };
}
