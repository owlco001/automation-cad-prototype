import type {
  GeneratedFile,
  Issue,
  PlcBomInput,
  PlcGenConfig,
  PlcTarget,
  PrecheckResult,
  StGenerateOptions,
  StStats,
  TagTable
} from './types.ts';
import { precheck } from './precheck.ts';
import { buildTags } from './tags.ts';
import { generateSt } from './st.ts';
import {
  buildSequencePlan,
  generateSequence,
  type SequenceStepModel
} from './sequence.ts';
import { generateAlarms } from './alarms.ts';
import { generateSafety } from './safety.ts';
import { createRenderContext } from './st.ts';
import { buildTagBindings, tagRef, type TagBinding } from './symbols.ts';
import { normalizePointKey } from './io.ts';
import { sha256Hex } from './hash.ts';
import { detectHandshake, type HandshakeModel, type HandshakeRole } from './handshake.ts';
import type { SequenceSource } from './sequence.ts';

export interface GenerateProjectInput extends StGenerateOptions {
  config: PlcGenConfig;
  /** 仅参与预检；不进入程序正文。 */
  bom?: PlcBomInput;
  /** 生成目标；仅影响 README，不进入 ST 内容与 inputHash。 */
  target?: PlcTarget;
  /** 命名前缀；仅影响 README 与导出命名，不进入 ST 内容与 inputHash。 */
  namePrefix?: string;
}

export interface ProjectStats extends StStats {
  steps: number;
  precheckWarnings: number;
  sequenceWarnings: number;
  sequenceEmpty: boolean;
  /** 步序来源：显式 sequence / 联动推导 / 空。 */
  sequenceSource: SequenceSource;
  /** 参与握手逻辑的信号点位（READY/DONE/ALLOW/END），空数组表示本机型没有握手。 */
  handshakeSignals: string[];
  hashes: Record<string, string>;
}

export interface GenerateProjectSuccess {
  ok: true;
  files: GeneratedFile[];
  stats: ProjectStats;
  precheck: PrecheckResult;
  warnings: Issue[];
}

export interface GenerateProjectFailure {
  ok: false;
  errors: Issue[];
  precheck: PrecheckResult;
}

export type GenerateProjectResult = GenerateProjectSuccess | GenerateProjectFailure;

/** 汇总生成固定文件顺序；不得依赖调用方的 Map/对象遍历顺序。 */
export const PROJECT_FILE_ORDER = [
  'src/OB1_Main.st',
  'src/DB_IO.st',
  'src/FB_Cylinder.st',
  'src/FB_Gripper.st',
  'src/FB_RotaryAxis.st',
  'src/FC_AutoSequence.st',
  'src/FC_Alarms.st',
  'src/FC_Safety.st',
  'io-tags.csv',
  'mapping.json',
  'README.md'
] as const;

export const PLC_TARGET_LABELS: Record<PlcTarget, string> = {
  generic: '通用 ST',
  's7-1200': '西门子 S7-1200',
  's7-1500': '西门子 S7-1500',
  codesys: 'CODESYS'
};

interface StepUsage {
  stepNo: number;
  usage: 'set' | 'reset' | 'condition';
}

function sha256(content: string): string {
  return sha256Hex(content);
}

function countLines(content: string): number {
  const normalized = content.endsWith('\n') ? content.slice(0, -1) : content;
  return normalized.split('\n').length;
}

function addUsage(
  map: Map<string, StepUsage[]>,
  point: string,
  stepNo: number,
  usage: StepUsage['usage']
): void {
  const key = normalizePointKey(point);
  const entries = map.get(key) ?? [];
  if (!entries.some((entry) => entry.stepNo === stepNo && entry.usage === usage)) {
    entries.push({ stepNo, usage });
    map.set(key, entries);
  }
}

function usageForPoints(
  map: Map<string, StepUsage[]>,
  points: readonly string[],
  stepNo: number,
  usage: StepUsage['usage']
): void {
  for (const point of points) addUsage(map, point, stepNo, usage);
}

function pointUsages(
  map: Map<string, StepUsage[]>,
  binding: TagBinding
): StepUsage[] {
  const keys = [
    binding.ref.point,
    binding.ref.sourceAddress,
    binding.row.address,
    binding.row.name
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => normalizePointKey(value));
  const entries: StepUsage[] = [];
  for (const key of keys) {
    for (const entry of map.get(key) ?? []) {
      if (!entries.some((candidate) => candidate.stepNo === entry.stepNo && candidate.usage === entry.usage)) {
        entries.push(entry);
      }
    }
  }
  return entries.sort((left, right) => left.stepNo - right.stepNo || left.usage.localeCompare(right.usage, 'en'));
}

const HANDSHAKE_DRIVER: Record<HandshakeRole, string> = {
  ready: 'StepNo = STEP_IDLE AND NOT SafeStop AND NOT SeqTimeout AND AlarmWord = 16#0000（CASE 之后每扫描重算）',
  done: 'STEP_HANDSHAKE 里到位信号为 1 才置位并锁存；SafeStop/Abort/下次启动沿清除（CASE 之后输出）',
  allow: '串进 STEP_IDLE 的启动条件：ALLOW = 0 时不接受启动沿，序列停在待机位',
  end: '最后一步的转移条件 + STEP_HANDSHAKE 的置位判据：END 不到位不置 DONE'
};

/** 握手信号在 mapping.json 里的追溯块：谁驱动它、它在哪个扫描位置写。 */
function buildHandshakeMapping(model: HandshakeModel): Record<string, unknown> | null {
  if (!model.present) return null;
  const role = (list: HandshakeModel['ready']): Array<Record<string, string>> => list.map((signal) => ({
    point: signal.point,
    address: signal.address,
    variable: signal.variable,
    ref: tagRef(signal.variable),
    station: signal.station,
    driver: HANDSHAKE_DRIVER[signal.role]
  }));
  return {
    station: model.station ?? '',
    signals: [
      ...role(model.allow),
      ...role(model.ready),
      ...role(model.done),
      ...role(model.end)
    ]
  };
}

function buildMapping(
  config: PlcGenConfig,
  tags: TagTable,
  steps: readonly SequenceStepModel[],
  inputHash: string,
  handshake: HandshakeModel
): string {
  const usageMap = new Map<string, StepUsage[]>();
  for (const step of steps) {
    usageForPoints(usageMap, step.sets, step.stepNo, 'set');
    usageForPoints(usageMap, step.resets, step.stepNo, 'reset');
    for (const point of step.referencedPoints) addUsage(usageMap, point, step.stepNo, 'condition');
  }

  const points = buildTagBindings(config).map((binding) => {
    const usages = pointUsages(usageMap, binding);
    const ref = binding.ref.actuatorName
      ?? (binding.ref.station === '安全' ? '安全回路' : binding.ref.point);
    return {
      ref,
      point: binding.ref.point,
      address: binding.row.address,
      variable: binding.row.name,
      type: binding.row.type,
      comment: binding.row.comment,
      station: binding.row.station,
      area: binding.ref.area,
      steps: [...new Set(usages.map((entry) => entry.stepNo))],
      stepUsage: usages
    };
  });

  const handshakeMapping = buildHandshakeMapping(handshake);
  const payload = {
    schemaVersion: 1,
    generatorVersion: '1.0.0',
    inputHash,
    machine: {
      id: config.id,
      name: config.name,
      version: String(config.version ?? 1)
    },
    ioCount: {
      total: tags.rows.length,
      inputs: tags.rows.filter((row) => row.address.startsWith('I')).length,
      outputs: tags.rows.filter((row) => row.address.startsWith('Q')).length
    },
    points,
    sequence: steps.map((step) => ({
      stepNo: step.stepNo,
      name: step.name,
      sets: step.sets,
      resets: step.resets,
      waits: step.waits,
      condition: step.condition,
      timeoutMs: step.timeoutMs
    })),
    ...(handshakeMapping ? { handshake: handshakeMapping } : {})
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function buildReadme(
  config: PlcGenConfig,
  precheckResult: PrecheckResult,
  steps: readonly SequenceStepModel[],
  sequenceWarnings: readonly Issue[],
  tags: TagTable,
  inputHash: string,
  version: string,
  target: PlcTarget,
  namePrefix: string,
  sequenceSource: SequenceSource,
  handshake: HandshakeModel
): string {
  const warnings = [...precheckResult.warnings, ...sequenceWarnings];
  const lines = [
    '# PLC 程序生成说明',
    '',
    `- 机型：${config.name || '未命名机型'} (${config.id || '未指定'})`,
    `- 机型版本：${version}`,
    `- 生成器：AutomationCAD v1.0.0`,
    `- 输入哈希：${inputHash}`,
    `- 目标平台：${PLC_TARGET_LABELS[target]}`,
    `- 命名前缀：${namePrefix}`,
    `- 文件数：${PROJECT_FILE_ORDER.length}`,
    `- IO 变量：${tags.rows.length}（输入 ${tags.rows.filter((row) => row.address.startsWith('I')).length} / 输出 ${tags.rows.filter((row) => row.address.startsWith('Q')).length}）`,
    `- 自动序列步数：${steps.length}`,
    `- 预检结果：${precheckResult.errors.length} error / ${precheckResult.warnings.length} warning`,
    `- 序列警告：${sequenceWarnings.length}`,
    ''
  ];
  // 只有「联动推导」和「握手」这两种新情况才加行：显式 sequence 的老机型说明文件逐字节不变。
  if (sequenceSource === 'linkage') {
    lines.splice(lines.length - 1, 0,
      `- 序列来源：联动推导（config 无显式 sequence，用执行机构驱动点位 + 到位传感器生成 ${steps.length} 步）`);
  }
  if (handshake.present) {
    lines.splice(lines.length - 1, 0,
      `- 联锁握手：${handshake.signals.join(' / ')}（ALLOW 约束启动、END 到位才置 DONE、READY = 待机且无报警、SafeStop 同周期复位）`);
  }
  lines.push(...[
    '## 文件',
    '',
    ...PROJECT_FILE_ORDER.map((path) => `- \`${path}\``),
    '',
    '## 导入说明',
    '',
    '1. 先导入 `io-tags.csv` 建立变量表，或将 `DB_IO.st` 中带绝对地址的变量声明导入 DB。',
    '2. `OB1_Main.st` 按扫描顺序调用 `FC_AutoSequence`、`FC_Alarms`、`FC_Safety`；安全块最后执行，确保 `SafeStop` 同周期复位输出。',
    '3. `mapping.json` 提供位号、点位、变量与步序的追溯关系，可用于 HMI 或 MES 对点。',
    '4. 生成结果不含时间戳，同一输入可逐字节复现。',
    ''
  ]);
  if (warnings.length > 0) {
    lines.push('## 警告', '');
    for (const warning of warnings) {
      lines.push(`- ${warning.code}: ${warning.message}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function fileByPath(files: readonly GeneratedFile[], path: string): GeneratedFile {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) throw new Error(`PLC 生成文件不存在：${path}`);
  return file;
}

/**
 * 汇总生成 PLC 工程：预检有 error 时不生成任何文件；成功时固定输出 11 个文件。
 * 同一输入（JSON 键序一致）重复生成，每个文件 sha256 一致。
 */
export function generateProject(input: GenerateProjectInput): GenerateProjectResult {
  const { target = 'generic', namePrefix, ...programInput } = input;
  const ctx = createRenderContext(programInput);
  const check = precheck(ctx.config, input.bom);
  if (check.errors.length > 0) {
    return { ok: false, errors: check.errors, precheck: check };
  }

  const base = generateSt(programInput);
  const sequence = generateSequence(programInput);
  const plan = buildSequencePlan(programInput);
  const handshake = detectHandshake(ctx.config);
  const tags = buildTags(ctx.config);
  const mapping = buildMapping(ctx.config, tags, plan.steps, ctx.inputHash, handshake);
  const sequenceWarnings = [...plan.warnings, ...handshake.warnings];
  const readme = buildReadme(
    ctx.config,
    check,
    plan.steps,
    sequenceWarnings,
    tags,
    ctx.inputHash,
    ctx.version,
    target,
    namePrefix?.trim() || ctx.config.id || 'PLC',
    plan.source,
    handshake
  );

  const allFiles: GeneratedFile[] = [
    fileByPath(base.files, 'src/OB1_Main.st'),
    fileByPath(base.files, 'src/DB_IO.st'),
    fileByPath(base.files, 'src/FB_Cylinder.st'),
    fileByPath(base.files, 'src/FB_Gripper.st'),
    fileByPath(base.files, 'src/FB_RotaryAxis.st'),
    { path: 'src/FC_AutoSequence.st', content: sequence.content },
    { path: 'src/FC_Alarms.st', content: generateAlarms(programInput) },
    { path: 'src/FC_Safety.st', content: generateSafety(programInput) },
    { path: 'io-tags.csv', content: tags.csv },
    { path: 'mapping.json', content: mapping },
    { path: 'README.md', content: readme }
  ];
  if (allFiles.map((file) => file.path).join('\n') !== PROJECT_FILE_ORDER.join('\n')) {
    throw new Error('PLC 生成文件顺序与固定清单不一致');
  }

  const hashes: Record<string, string> = {};
  for (const file of allFiles) hashes[file.path] = sha256(file.content);

  const warnings = [...check.warnings, ...sequenceWarnings];
  const stats: ProjectStats = {
    files: allFiles.length,
    lines: allFiles.reduce((total, file) => total + countLines(file.content), 0),
    tags: tags.rows.length,
    inputs: tags.rows.filter((row) => row.address.startsWith('I')).length,
    outputs: tags.rows.filter((row) => row.address.startsWith('Q')).length,
    actuators: (ctx.config.actuators ?? []).length,
    stations: (ctx.config.stations ?? []).length,
    inputHash: ctx.inputHash,
    timeoutTimeMs: ctx.timeoutTimeMs,
    toleranceDeg: ctx.toleranceDeg,
    steps: plan.steps.length,
    precheckWarnings: check.warnings.length,
    sequenceWarnings: sequenceWarnings.length,
    sequenceEmpty: plan.steps.length === 0,
    sequenceSource: plan.source,
    handshakeSignals: handshake.signals,
    hashes
  };

  return {
    ok: true,
    files: allFiles,
    stats,
    precheck: check,
    warnings
  };
}

/** 兼容别名：保留对外导出，当前仓库内无调用；新代码请使用 `generateProject`。 */
export const generatePlcProject = generateProject;
