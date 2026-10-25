import type { MachineConfig } from '../commission/machine-config.ts';

/** 同步与生成面板共同使用的支持目标白名单。 */
export const PLC_TARGETS = ['generic', 's7-1200', 's7-1500', 'codesys'] as const;

/** 生成目标；当前只影响 README 注释与命名前缀，不改变 ST 内容。 */
export type PlcTarget = typeof PLC_TARGETS[number];

export interface Issue {
  code: string;
  message: string;
  path?: string;
}

export interface PrecheckResult {
  errors: Issue[];
  warnings: Issue[];
}

export interface PlcSafetyConfig {
  /** 急停链路输入点；可给一个或多个通道。 */
  emergencyStop?: string | readonly string[];
  estop?: string | readonly string[];
  emergencyStopPoint?: string | readonly string[];
  emergencyStopPoints?: readonly string[];
  /** 安全门／光栅输入点；可给一个或多个通道。 */
  safetyDoor?: string | readonly string[];
  safetyDoors?: readonly string[];
  door?: string | readonly string[];
  safetyDoorPoint?: string | readonly string[];
  safetyDoorPoints?: readonly string[];
  /** 安全复位输入点；不参与急停/安全门“已定义”的判定。 */
  reset?: string;
}

export interface PlcIoPoint {
  /** 点位标识，如 X10、I1.2、Y0、Q0.0。 */
  point: string;
  name?: string;
  station?: string;
  area?: 'input' | 'output';
  /** 可选源地址；用于预检地址重复/越界。 */
  address?: string;
  /** 可选语义：estop / safetyDoor / 急停 / 安全门 等。 */
  role?: string;
}

export interface PlcSequenceStep {
  id?: string;
  name?: string;
  action?: string;
  /** 兼容 commission 的 type 字段。 */
  type?: string;
  point?: string;
  value?: boolean | number;
  points?: readonly string[];
  setPoints?: readonly string[];
  resetPoints?: readonly string[];
  waitPoints?: readonly string[];
  sets?: readonly string[];
  resets?: readonly string[];
  waits?: readonly string[];
  condition?: string;
  expect?: boolean | number;
  /** 单步超时，单位 ms；缺省使用 5000。 */
  timeoutMs?: number;
  /** `timeoutMs` 的兼容别名。 */
  timeout?: number;
}

/** MachineConfig 的 PLC 生成扩展；原有调用方无需修改。 */
export interface PlcGenConfig extends MachineConfig {
  version?: string | number;
  safety?: PlcSafetyConfig;
  /** 联调步序；也接受 `steps` 别名。 */
  sequence?: readonly PlcSequenceStep[];
  steps?: readonly PlcSequenceStep[];
  /** 不在执行机构/传感器表里的额外 IO（如安全继电器反馈）。 */
  ioPoints?: readonly PlcIoPoint[];
  /** 旧的直读字段兼容。 */
  estopPoint?: string;
  safetyDoorPoint?: string;
  emergencyStop?: string | readonly string[];
  safetyDoor?: string | readonly string[];
}

/**
 * BOM 行既兼容 export/bom.ts 的 BomRow，也支持显式点数。
 * inputPoints/outputPoints 优先；points/ioPoints 视为未分方向的模块总点数。
 */
export interface PlcBomRow {
  index?: number | string;
  name?: string;
  model?: string;
  spec?: string;
  partId?: string;
  quantity?: number;
  qty?: number;
  material?: string;
  note?: string;
  kind?: string;
  category?: string;
  inputPoints?: number;
  outputPoints?: number;
  diPoints?: number;
  doPoints?: number;
  inputCount?: number;
  outputCount?: number;
  di?: number;
  do?: number;
  points?: number;
  ioPoints?: number;
  ioCount?: number;
}

export type PlcBomInput =
  | readonly PlcBomRow[]
  | {
      rows?: readonly PlcBomRow[];
      bom?: readonly PlcBomRow[];
      modules?: readonly PlcBomRow[];
      plcModules?: readonly PlcBomRow[];
      items?: readonly PlcBomRow[];
      plc?: {
        modules?: readonly PlcBomRow[];
        inputPoints?: number;
        outputPoints?: number;
        ioPoints?: number;
        points?: number;
      };
    };

export interface TagRow {
  address: string;
  name: string;
  type: 'BOOL';
  comment: string;
  station: string;
}

export interface TagTable {
  rows: TagRow[];
  csv: string;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface StGenerateOptions {
  /** 机型版本；默认读取 config.version，再回落 1。 */
  version?: string | number;
  /** 气缸/夹爪/轴 FB 的默认超时，单位 ms，默认 3000。 */
  timeoutTimeMs?: number;
  /** 旋转轴角度容差，单位度，默认 0.5。 */
  toleranceDeg?: number;
  /** 自动序列单步默认超时，单位 ms，默认 5000。 */
  sequenceTimeoutMs?: number;
  generatorVersion?: string;
}

export interface StGenerateInput extends StGenerateOptions {
  config: PlcGenConfig;
  bom?: PlcBomInput;
}

export interface StStats {
  files: number;
  lines: number;
  tags: number;
  inputs: number;
  outputs: number;
  actuators: number;
  stations: number;
  inputHash: string;
  timeoutTimeMs: number;
  toleranceDeg: number;
}

export interface StGenerateResult {
  files: GeneratedFile[];
  stats: StStats;
}
