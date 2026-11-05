// 机型 BOM → 真实元件包映射。纯函数：输入方案与已加载元件，输出带 pack/id 的
// BOM 行及电气估算。型号必须能在传入的元件列表里按 id 找到，避免「看起来专业
// 但库里不存在」的选型。

import type { ComponentPart } from '../shared/types.ts';
import type { MachineDesign } from './synth.ts';
import { ratedPowerFromPart } from './power.ts';

export interface MachineElectricalCalculation {
  id: string;
  name: string;
  formula: string;
  inputs: Record<string, number | string>;
  loadA?: number;
  requiredA?: number;
  ratedA?: number;
  margin?: number;
}

export interface MachineBomMapping {
  items: MachineDesign['bomDraft']['items'];
  pending: { name: string; reason: string }[];
  /** 已选到真实型号、但仍需工程师现场核对的提示（如安全距离），不是待选型。 */
  notices: string[];
  electrical: {
    assumptions: string[];
    auxLoadBreakdown: { name: string; qty: number; watts: number }[];
    totalServoW: number;
    totalAuxW: number;
    totalDesignW: number;
    calculations: MachineElectricalCalculation[];
  };
  sourcePacks: string[];
}

export interface MachineBomMapOptions {
  /** 选型余量，默认 1.25（额定电流/计算电流）。 */
  marginFactor?: number;
  cosPhi?: number;
  efficiency?: number;
  mainVoltage?: number;
  branchVoltage?: number;
  auxLoadW?: {
    valve: number;
    proximitySensor: number;
    safetyCurtain: number;
    plc: number;
    safetyRelay: number;
    servoControl: number;
    reserve: number;
  };
}

const DEFAULT_OPTIONS = {
  marginFactor: 1.25,
  cosPhi: 0.85,
  efficiency: 0.9,
  mainVoltage: 380,
  branchVoltage: 220,
  auxLoadW: {
    valve: 4,
    proximitySensor: 2,
    safetyCurtain: 15,
    plc: 25,
    safetyRelay: 5,
    servoControl: 10,
    reserve: 9
  }
} as const;

const MODEL_REFS = {
  servoDrive: { id: 'SV660PS5R5I', packId: 'iec-cn' },
  servoMotor: { id: 'MS1H1-75B30CB', packId: 'iec-cn' },
  gripper: { id: 'MHZ2-20D', packId: 'smc-cn' },
  valve: { id: 'SY5120-5LZD', packId: 'smc-cn' },
  proximity: { id: 'D-M9B', packId: 'smc-cn' },
  plc: { id: 'CP1E-N40DR-A', packId: 'iec-cn' },
  safetyRelay: { id: 'PNOZ-s3-750103', packId: 'iec-cn' },
  // 安全光栅初选：14 mm 手指保护（ISO 13855 中 C = 8 × (d − 14) = 0，所需安全距离最小，
  // 适合锁螺丝等手部靠近危险点的上料口）；保护高度 640 mm 覆盖整机几何中 600 mm 的光栅立柱；
  // Type 4 / PL e，OSSD 接 PNOZ s3 的光栅监控输入。安装距离与保护高度仍需按现场开口核算。
  safetyCurtain: { id: 'F3SG-4SRA0640-14', packId: 'iec-cn' },
  psu24v: { id: 'LRS-350-24', packId: 'iec-cn' },
  servoBreaker: { id: 'iC65N-C6-1P', packId: 'iec-cn' },
  mainBreaker: { id: '5SY63-C16', packId: 'iec-cn' },
  psuBreaker: { id: 'iC65N-C6-1P', packId: 'iec-cn' }
} as const;

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function countKind(design: MachineDesign, kind: string): number {
  return design.config.actuators.filter((actuator) => actuator.kind === kind).length;
}

function countSensor(design: MachineDesign, kind: 'proximity' | 'photoelectric' | 'safety' | 'pressure'): number {
  const code = { proximity: '-PRX-', photoelectric: '-PHT-', safety: '-SAFE-', pressure: '-PRS-' }[kind];
  return design.config.sensors.filter((sensor) => sensor.point.toUpperCase().includes(code)).length;
}

function specNumber(part: ComponentPart, key: string): number | null {
  const raw = part.specs[key];
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const match = raw.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function partByRef(
  parts: readonly ComponentPart[],
  ref: { id: string; packId: string }
): ComponentPart {
  const part = parts.find((candidate) => candidate.id === ref.id && candidate.packId === ref.packId);
  if (!part) throw new Error(`BOM 选型失败：元件包 ${ref.packId} 中不存在 id=${ref.id}`);
  return part;
}

function noteFor(part: ComponentPart, extra?: string): string {
  const base = `来源包：${part.packId} · id=${part.id}`;
  return extra ? `${base} · ${extra}` : base;
}

function item(
  kind: 'actuator' | 'sensor' | 'electrical',
  name: string,
  part: ComponentPart,
  qty: number,
  role: NonNullable<MachineDesign['bomDraft']['items'][number]['role']>,
  extra?: string
): MachineDesign['bomDraft']['items'][number] {
  const ratedW = ratedPowerFromPart(part);
  return {
    kind,
    name,
    qty,
    model: part.model,
    note: noteFor(part, extra),
    partId: part.id,
    role,
    ...(ratedW !== null ? { ratedW } : {}),
    ...(part.packId ? { packId: part.packId } : {})
  };
}

/**
 * 把方案 BOM 映射到真实型号。缺少任一必需型号会抛错；安全光栅只在方案含光栅时
 * 才需要，元件包里找不到该型号时退回「待选型」并写明原因，不伪造型号。
 */
export function mapMachineBom(
  design: MachineDesign,
  parts: readonly ComponentPart[],
  options: MachineBomMapOptions = {}
): MachineBomMapping {
  const settings = {
    ...DEFAULT_OPTIONS,
    ...options,
    auxLoadW: { ...DEFAULT_OPTIONS.auxLoadW, ...(options.auxLoadW ?? {}) }
  };
  const servoCount = countKind(design, 'rotary');
  const gripperCount = countKind(design, 'gripper');
  const proximityCount = countSensor(design, 'proximity');
  const safetyCount = countSensor(design, 'safety');
  const servoDetected = design.power.byGroup.some((group) => group.name === '伺服');
  const items: MachineDesign['bomDraft']['items'] = [];

  const servoDrive = partByRef(parts, MODEL_REFS.servoDrive);
  const servoMotor = partByRef(parts, MODEL_REFS.servoMotor);
  const gripper = partByRef(parts, MODEL_REFS.gripper);
  const valve = partByRef(parts, MODEL_REFS.valve);
  const proximity = partByRef(parts, MODEL_REFS.proximity);
  const plc = partByRef(parts, MODEL_REFS.plc);
  const safetyRelay = partByRef(parts, MODEL_REFS.safetyRelay);
  const psu = partByRef(parts, MODEL_REFS.psu24v);
  const servoBreaker = partByRef(parts, MODEL_REFS.servoBreaker);
  const mainBreaker = partByRef(parts, MODEL_REFS.mainBreaker);
  const psuBreaker = partByRef(parts, MODEL_REFS.psuBreaker);

  if (servoDetected && servoCount > 0) {
    items.push(item('actuator', '伺服驱动器', servoDrive, servoCount, 'servo', '按 1 驱 1 电机配置'));
    items.push(item('actuator', '伺服电机', servoMotor, servoCount, 'servo', '与 SV660P 750 W 配套'));
  }
  if (gripperCount > 0) {
    items.push(item('actuator', '气爪', gripper, gripperCount, 'gripper'));
    items.push(item('actuator', '电磁阀', valve, gripperCount, 'valve', '按 1 气爪 1 阀配置'));
  }
  if (proximityCount > 0) items.push(item('sensor', '到位检测（磁性开关）', proximity, proximityCount, 'sensor'));
  const pending: MachineBomMapping['pending'] = [];
  const notices: string[] = [];
  const safetyCurtain = safetyCount > 0
    ? parts.find((candidate) =>
      candidate.id === MODEL_REFS.safetyCurtain.id && candidate.packId === MODEL_REFS.safetyCurtain.packId)
    : undefined;
  if (safetyCount > 0 && safetyCurtain) {
    const resolution = String(safetyCurtain.specs['分辨率'] ?? '').split('（')[0];
    const height = String(safetyCurtain.specs['保护高度'] ?? '');
    const level = String(safetyCurtain.specs['安全等级'] ?? '');
    items.push(item(
      'sensor',
      '安全光栅',
      safetyCurtain,
      safetyCount,
      'safety',
      `${resolution} / ${height} / ${level}，OSSD 接安全继电器`
    ));
    notices.push(
      `安全光栅：已初选 ${safetyCurtain.model}（${resolution}、保护高度 ${height}），` +
      '安装距离需按 ISO 13855 用实测停机时间核算，保护高度需覆盖实际上料开口。'
    );
  } else if (safetyCount > 0) {
    const reason = `元件包 ${MODEL_REFS.safetyCurtain.packId} 中未找到安全光栅 ${MODEL_REFS.safetyCurtain.id}，需补录或手工选型`;
    items.push({
      kind: 'sensor',
      name: '安全光栅',
      qty: safetyCount,
      model: '待选型',
      note: reason,
      role: 'safety',
      pendingSelection: true
    });
    pending.push({ name: '安全光栅', reason });
  }

  const aux = settings.auxLoadW;
  const auxLoadBreakdown = [
    { name: '电磁阀', qty: gripperCount, watts: gripperCount * aux.valve },
    { name: '到位检测', qty: proximityCount, watts: proximityCount * aux.proximitySensor },
    { name: '安全光栅', qty: safetyCount, watts: safetyCount * aux.safetyCurtain },
    { name: 'PLC', qty: 1, watts: aux.plc },
    { name: '安全继电器', qty: 1, watts: aux.safetyRelay },
    { name: '伺服驱动控制', qty: servoCount, watts: servoCount * aux.servoControl },
    { name: '预留', qty: 1, watts: aux.reserve }
  ].filter((entry) => entry.watts > 0);
  const totalAuxW = auxLoadBreakdown.reduce((sum, entry) => sum + entry.watts, 0);
  const totalServoW = servoCount * 750;
  const totalDesignW = totalServoW + totalAuxW;
  const phaseFactor = Math.sqrt(3);
  const mainLoadA = totalDesignW / (phaseFactor * settings.mainVoltage * settings.cosPhi * settings.efficiency);
  const servoLoadA = 750 / (settings.branchVoltage * settings.cosPhi * settings.efficiency);
  const psuAcLoadA = (specNumber(psu, '输出功率') ?? 350) /
    (settings.branchVoltage * settings.cosPhi * settings.efficiency);
  const psuDcLoadA = totalAuxW / 24;
  const mainRatedA = specNumber(mainBreaker, '额定电流') ?? 0;
  const servoRatedA = specNumber(servoBreaker, '额定电流') ?? 0;
  const psuBreakerRatedA = specNumber(psuBreaker, '额定电流') ?? 0;
  const psuRatedW = specNumber(psu, '输出功率') ?? 0;
  const psuRatedA = specNumber(psu, '输出电流') ?? 0;

  const calculations: MachineElectricalCalculation[] = [
    {
      id: 'main-current',
      name: '总进线计算电流',
      formula: 'I = P / (√3 × U × cosφ × η)',
      inputs: {
        totalDesignW,
        voltage: settings.mainVoltage,
        phases: 3,
        cosPhi: settings.cosPhi,
        efficiency: settings.efficiency
      },
      loadA: round(mainLoadA),
      requiredA: round(mainLoadA * settings.marginFactor),
      ratedA: mainRatedA,
      margin: round(mainRatedA / mainLoadA)
    },
    {
      id: 'servo-branch-current',
      name: '单轴伺服支路计算电流',
      formula: 'I = 750 W / (U × cosφ × η)',
      inputs: {
        powerW: 750,
        voltage: settings.branchVoltage,
        cosPhi: settings.cosPhi,
        efficiency: settings.efficiency
      },
      loadA: round(servoLoadA),
      requiredA: round(servoLoadA * settings.marginFactor),
      ratedA: servoRatedA,
      margin: round(servoRatedA / servoLoadA)
    },
    {
      id: 'psu-ac-current',
      name: '开关电源进线计算电流',
      formula: 'I = 350 W / (U × cosφ × η)',
      inputs: {
        powerW: psuRatedW,
        voltage: settings.branchVoltage,
        cosPhi: settings.cosPhi,
        efficiency: settings.efficiency
      },
      loadA: round(psuAcLoadA),
      requiredA: round(psuAcLoadA * settings.marginFactor),
      ratedA: psuBreakerRatedA,
      margin: round(psuBreakerRatedA / psuAcLoadA)
    },
    {
      id: 'psu-dc-output',
      name: '24 V 电源输出余量',
      formula: 'Iout = Paux / 24 V',
      inputs: { auxLoadW: totalAuxW, voltage: 24 },
      loadA: round(psuDcLoadA),
      requiredA: round(psuDcLoadA * settings.marginFactor),
      ratedA: psuRatedA,
      margin: round(psuRatedA / psuDcLoadA)
    }
  ];

  items.push(item('electrical', 'PLC', plc, 1, 'plc', '24 DI / 16 DO，覆盖 19 点位'));
  items.push(item(
    'electrical',
    '安全继电器',
    safetyRelay,
    1,
    'other',
    safetyCurtain ? `光栅/安全门监控，接 ${safetyCurtain.model} 的 OSSD` : '光栅/安全门监控'
  ));
  items.push(item('electrical', '24 V 开关电源', psu, 1, 'psu', `${psuRatedW} W / ${psuRatedA} A`));
  // 伺服支路只在真有伺服轴时存在：qty=0 的 BOM 行不是「没配」，而是一份非法 BOM
  //（validateMachineDesign 要求 qty 是正整数，整份方案会被拒签 —— 移载/纯气动方案实测就卡在这）。
  if (servoCount > 0) {
    items.push(item('electrical', '伺服支路断路器', servoBreaker, servoCount, 'other', `计算 ${round(servoLoadA)} A，额定 ${servoRatedA} A`));
  }
  items.push(item('electrical', '总进线断路器', mainBreaker, 1, 'other', `计算 ${round(mainLoadA)} A，额定 ${mainRatedA} A`));
  items.push(item('electrical', '开关电源支路断路器', psuBreaker, 1, 'other', `计算 ${round(psuAcLoadA)} A，额定 ${psuBreakerRatedA} A`));

  const sourcePacks = [...new Set(items.map((entry) => entry.packId).filter((id): id is string => Boolean(id)))]
    .sort((left, right) => left.localeCompare(right));

  return {
    items,
    pending,
    notices,
    electrical: {
      assumptions: [
        `总进线按 ${settings.mainVoltage} V 三相四线估算，伺服支路取相电压 ${settings.branchVoltage} V。`,
        `cosφ=${settings.cosPhi}、效率 η=${settings.efficiency}，功率因数为工程估算，需按实际电机/驱动数据复核。`,
        `所有断路器与开关电源按计算电流/功率的 ${settings.marginFactor} 倍以上选取；额定值来自元件包 specs。`,
        safetyCurtain
          ? `安全光栅按 ${safetyCurtain.model} 计（样本消耗电流 ${String(safetyCurtain.specs['消耗电流'] ?? '见样本')}），` +
            `24 V 负载仍按每套 ${aux.safetyCurtain} W 预留（含 OSSD 负载与余量）。`
          : `安全光栅未选到型号，未参与具体电气参数校核，仅按每套 ${aux.safetyCurtain} W 预留。`
      ],
      auxLoadBreakdown,
      totalServoW,
      totalAuxW,
      totalDesignW,
      calculations
    },
    sourcePacks
  };
}
