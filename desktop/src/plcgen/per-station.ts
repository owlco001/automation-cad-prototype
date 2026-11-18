// 逐工位转换：把「多工位并行时间线」切成「每工位一条串行时间线」，各自生成 PLC 工程后再聚合对账。
//
// 背景（CI「Qt client build」plc-audit 长期红）：`buildLinkage` 让各工位按索引错开并行
// （`desktop/src/machine/linkage.ts` 的 offset 公式），而 `buildSequenceFromLinkage` 在
// a85dc92 之后对**任何**时间重叠都硬拒绝（`linkage-program.ts:101`）——这是正当的 bug 修复：
// 把 4 条并行时间线当串行程序生成，程序节拍会是真实的 4 倍。
//
// 真正的分工：并行只发生在工位**之间**，工位**内部**本来就由 `buildLinkage` 排成串行。
// 所以按 stationId 切片后，每片都能合法转换；聚合时如实标注 `conversionScope: 'per-station'`，
// 绝不宣称「整机时序等价」，也不生成跨站联锁程序（那是计划中的并行调度，属于另一个工程）。
//
// 这个模块是纯函数：输入 linkage + 已补齐的 config，输出可直接塞进 `plcAudit` 的块。
// CLI（`scripts/machine-design-cli.mjs --plc-audit`）只是调用方，Qt 客户端只看聚合结果。

import type { PlcGenConfig, PlcSequenceStep } from './types.ts';
import { auditLinkageVsProgram, buildSequenceFromLinkage, type LinkageAuditPoint, type LinkageProgramAudit, type LinkageProgramGap, type LinkageStepLike } from './linkage-program.ts';
import { generateProject } from './generate.ts';

export interface PerStationLinkage {
  cycleMs: number;
  steps: readonly LinkageStepLike[];
}

export interface PerStationError {
  code: string;
  message: string;
}

export interface PerStationSummary {
  stationId: string;
  steps: number;
  files: number;
  linkagePoints: number;
  pointsDriven: number;
  pointsWithWait: number;
  gaps: number;
  ok: boolean;
  error?: PerStationError;
}

export interface PerStationAudit extends LinkageProgramAudit {
  /** 聚合对账里的缺口带上工位，界面/日志才定位得到是哪一站 */
  gaps: Array<LinkageProgramGap & { stationId: string }>;
}

export interface PerStationConversion {
  /** 关键口径：N 个分工位工程，不是 1 个整机工程 */
  conversionScope: 'per-station';
  stations: number;
  parallelStations: boolean;
  projects: number;
  generated: boolean;
  sequenceSteps: number;
  files: number;
  plcPoints: number;
  generateErrors: PerStationError[];
  /** 任一站失败时不给 audit：失败就是失败，不要半截对账结果 */
  audit?: PerStationAudit;
  stationAudits: PerStationSummary[];
  /** 各站 mapping 点位的并集（点位表相同，用于 --linkage-timing-csv 的地址回填） */
  points: Array<{ point: string; address?: string; variable?: string }>;
}

interface MappingLike {
  points?: LinkageAuditPoint[];
  sequence?: PlcSequenceStep[];
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** 按 stationId 分组，保持时间线里首次出现的顺序（同一份 linkage 输出稳定） */
export function groupByStation(linkage: PerStationLinkage): Map<string, LinkageStepLike[]> {
  const groups = new Map<string, LinkageStepLike[]>();
  for (const step of linkage.steps) {
    const key = String(step.stationId ?? '未指定');
    const list = groups.get(key);
    if (list) list.push(step);
    else groups.set(key, [step]);
  }
  // 没有可转换的动作也要给出一条明确结论（保持「生成成功但没有点位」的既有语义）
  if (groups.size === 0) groups.set('未指定', []);
  return groups;
}

const VERIFICATION_RANK: Record<LinkageProgramAudit['safetyVerification'], number> = {
  structured: 2,
  'generated-assignments': 1,
  unverified: 0
};

/**
 * 逐工位转换 + 聚合。
 *
 * 失败语义：任一站转换抛错或生成失败 → `generated: false`，`generateErrors` 汇总原因；
 * 已成功的站仍列在 `stationAudits` 里（看得出「坏在哪一站、其余站是什么状态」）。
 * 重叠守卫本身不在本模块重复实现：切片后自交给 `buildSequenceFromLinkage`，
 * 站内真重叠照样抛 `Overlapping linkage timeline...`。
 */
export function convertLinkagePerStation(
  linkage: PerStationLinkage,
  config: PlcGenConfig,
  options: { namePrefix?: string } = {}
): PerStationConversion {
  const prefix = options.namePrefix?.trim() || 'audit';
  const groups = groupByStation(linkage);
  const stationAudits: PerStationSummary[] = [];
  const generateErrors: PerStationError[] = [];
  const audits: Array<{ stationId: string; audit: LinkageProgramAudit }> = [];
  const points = new Map<string, { point: string; address?: string; variable?: string }>();
  const errorKeys = new Set<string>();
  let files = 0;
  let sequenceSteps = 0;

  for (const [stationId, stationSteps] of groups) {
    let sequence: PlcSequenceStep[];
    try {
      // 切片保留 cycleMs：站内串行，时长/顺序与 3D 时间线一致
      sequence = buildSequenceFromLinkage({ cycleMs: linkage.cycleMs, steps: stationSteps }, config);
    } catch (error) {
      const failure: PerStationError = { code: 'UNSUPPORTED_LINKAGE_CONVERSION', message: `${stationId}: ${messageOf(error)}` };
      generateErrors.push(failure);
      stationAudits.push({ stationId, steps: 0, files: 0, linkagePoints: 0, pointsDriven: 0, pointsWithWait: 0, gaps: 0, ok: false, error: failure });
      continue;
    }
    const generated = generateProject({ config: { ...config, sequence }, namePrefix: `${prefix}-${stationId}` });
    if (!generated.ok) {
      for (const error of generated.errors) {
        const key = `${error.code}\u0000${error.message}`;
        if (errorKeys.has(key)) continue;
        errorKeys.add(key);
        generateErrors.push({ code: error.code, message: error.message });
      }
      stationAudits.push({ stationId, steps: sequence.length, files: 0, linkagePoints: 0, pointsDriven: 0, pointsWithWait: 0, gaps: 0, ok: false, error: { code: generated.errors[0]?.code ?? 'GENERATE_FAILED', message: generated.errors[0]?.message ?? '生成失败' } });
      continue;
    }
    const mappingFile = generated.files.find((file) => file.path === 'mapping.json');
    const mapping: MappingLike = mappingFile ? JSON.parse(mappingFile.content) as MappingLike : {};
    for (const entry of mapping.points ?? []) {
      const point = String(entry.point ?? '');
      if (!point || points.has(point)) continue;
      const compact: { point: string; address?: string; variable?: string } = { point };
      if (entry.address) compact.address = entry.address;
      if (entry.variable) compact.variable = entry.variable;
      points.set(point, compact);
    }
    const programText = generated.files
      .filter((file) => file.path === 'src/FC_AutoSequence.st' || file.path === 'src/FC_Safety.st')
      .map((file) => file.content)
      .join('\n');
    const audit = auditLinkageVsProgram(
      { cycleMs: linkage.cycleMs, steps: stationSteps },
      mapping.points ?? [],
      programText,
      sequence.length,
      mapping.sequence ?? sequence
    );
    files += generated.files.length;
    sequenceSteps += sequence.length;
    audits.push({ stationId, audit });
    stationAudits.push({
      stationId,
      steps: sequence.length,
      files: generated.files.length,
      linkagePoints: audit.linkagePoints,
      pointsDriven: audit.pointsDriven,
      pointsWithWait: audit.pointsWithWait,
      gaps: audit.gaps.length,
      ok: audit.ok
    });
  }

  const failed = stationAudits.filter((station) => !station.ok);
  const generated = failed.length === 0 && generateErrors.length === 0;
  const conversion: PerStationConversion = {
    conversionScope: 'per-station',
    stations: groups.size,
    parallelStations: groups.size > 1,
    projects: audits.length,
    generated,
    sequenceSteps,
    files,
    plcPoints: points.size,
    generateErrors,
    stationAudits,
    points: [...points.values()]
  };
  if (!generated || audits.length === 0) return conversion;

  const gaps = audits.flatMap(({ stationId, audit }) => audit.gaps.map((gap) => ({ ...gap, stationId })));
  const sum = (pick: (audit: LinkageProgramAudit) => number) => audits.reduce((total, entry) => total + pick(entry.audit), 0);
  const limitations = new Set<string>();
  for (const { audit } of audits) for (const line of audit.limitations) limitations.add(line);
  limitations.add('Per-station conversion: cross-station parallel interlocks are not generated; the whole-machine timeline is not an equivalent PLC program.');
  const verification = audits
    .map((entry) => entry.audit.safetyVerification)
    .reduce((worst, current) => (VERIFICATION_RANK[current] < VERIFICATION_RANK[worst] ? current : worst), 'structured' as LinkageProgramAudit['safetyVerification']);

  conversion.audit = {
    ok: gaps.length === 0,
    linkageSteps: sum((audit) => audit.linkageSteps),
    programSteps: sum((audit) => audit.programSteps),
    linkagePoints: sum((audit) => audit.linkagePoints),
    pointsInPlcTable: sum((audit) => audit.pointsInPlcTable),
    pointsDriven: sum((audit) => audit.pointsDriven),
    pointsWithWait: sum((audit) => audit.pointsWithWait),
    safetyGate: audits.every(({ audit }) => audit.safetyGate),
    safetyVerification: verification,
    limitations: [...limitations],
    gaps
  };
  return conversion;
}
