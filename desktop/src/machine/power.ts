// 功率估算：方案阶段纯函数。优先采用元件库额定功率；缺额定值时使用可解释的
// 类别默认值并写入 assumptions。这里只做容量粗估，不做短路电流、电缆选型、
// 启动压降或保护配合计算。

import type { ComponentPart } from '../shared/types.ts';
import { selectCableProtection } from '../elec/selection.ts';
import type { MachineActuatorKind, MachineSensorKind, MachineVoltage } from './spec.ts';

export type MachinePowerRole =
  | 'servo'
  | 'cylinder'
  | 'gripper'
  | 'rotary'
  | 'sensor'
  | 'safety'
  | 'plc'
  | 'psu'
  | 'valve'
  | 'other';

export type PowerVoltage = MachineVoltage;

export interface PowerInputItem {
  role: MachinePowerRole;
  partId?: string;
  packId?: string;
  model?: string;
  /** 展示名，缺省用角色中文名。 */
  name?: string;
  qty: number;
  /** 单件额定有功功率（W）。缺省时按角色默认值并告警。 */
  ratedW?: number;
}

export interface PowerInput {
  items: PowerInputItem[];
  /** 同时系数，默认 0.7。 */
  simultaneity?: number;
  /** 负载率，默认 0.6。 */
  loadFactor?: number;
  /** 效率，默认 0.9。 */
  efficiency?: number;
  /** 功率因数，默认 0.9；24VDC 主回路按 1.0 计。 */
  cosPhi?: number;
  voltage: PowerVoltage;
  /** 已在 BOM 中选定的总进线断路器额定电流；用于交叉校验。 */
  selectedBreakerA?: number;
}

export interface PowerGroup {
  name: string;
  count: number;
  ratedW: number;
  va: number;
}

export interface Dc24Estimate {
  loadW: number;
  supplyW: number;
  marginPct: number;
}

export interface PowerResult {
  /** 视在功率 VA；与 totalVa 相同，保留兼容旧方案卡/存档。 */
  va: number;
  totalVa: number;
  totalKw: number;
  byGroup: PowerGroup[];
  currentA: number;
  breakerSuggestion: { rating: number; poles: 1 | 2 | 3; margin: number };
  /** 总进线断路器—导线配合：先定断路器，再按断路器额定选截面（ampacityA ≥ breakerA）。 */
  mainProtection: { breakerA: number; sectionMm2: number | null; ampacityA: number | null };
  assumptions: string[];
  warnings: string[];
  voltage: PowerVoltage;
  cosPhi: number;
  simultaneity: number;
  loadFactor: number;
  efficiency: number;
  /** 24 VDC 回路；没有 24V 负载与电源时返回 null。 */
  dc24: Dc24Estimate | null;
}

export const POWER_DEFAULTS = {
  simultaneity: 0.7,
  loadFactor: 0.6,
  efficiency: 0.9,
  cosPhi: 0.9
} as const;

export const BREAKER_STANDARD_A = [6, 10, 16, 20, 25, 32, 40, 50, 63] as const;

/** 仅作为「元件库没有额定功率」时的类别默认值，单位 W。 */
export const ROLE_DEFAULT_W: Record<MachinePowerRole, number> = {
  servo: 750,
  cylinder: 5,
  gripper: 15,
  rotary: 200,
  sensor: 3,
  safety: 20,
  plc: 25,
  psu: 350,
  valve: 4,
  other: 10
};

export const POWER_ROLE_LABEL: Record<MachinePowerRole, string> = {
  servo: '伺服',
  cylinder: '气缸',
  gripper: '夹爪',
  rotary: '旋转轴',
  sensor: '传感器',
  safety: '安全光栅',
  plc: 'PLC',
  psu: '24V 电源',
  valve: '电磁阀',
  other: '其他'
};

const DC24_ROLES = new Set<MachinePowerRole>(['sensor', 'safety', 'plc', 'valve']);

/** 24 V 回路功率：角色默认；显式 24VDC 的 other 也计入。 */
function isDc24Item(item: PowerInputItem): boolean {
  return DC24_ROLES.has(item.role);
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function polesFor(voltage: PowerVoltage): 1 | 2 | 3 {
  return voltage === '380VAC' ? 3 : 1;
}

/** 按电压计算总电流：380V 三相，220V 单相，24VDC 按直流。 */
export function currentForPower(powerKw: number, voltage: PowerVoltage, cosPhi: number): number {
  if (!Number.isFinite(powerKw) || powerKw < 0) throw new Error('功率必须是非负数字');
  const watts = powerKw * 1000;
  if (voltage === '380VAC') return watts / (Math.sqrt(3) * 380 * cosPhi);
  if (voltage === '220VAC') return watts / (220 * cosPhi);
  return watts / 24;
}

export interface DesignPowerPartRef {
  model?: string;
  partId?: string;
  packId?: string;
  ratedW?: number;
}

export interface DesignPowerBomItem extends DesignPowerPartRef {
  kind?: 'actuator' | 'sensor' | 'electrical';
  role?: string;
  name?: string;
  qty?: number;
}

export interface DesignPowerSource {
  config: {
    name?: string;
    actuators?: readonly (DesignPowerPartRef & { kind: MachineActuatorKind })[];
    sensors?: readonly (DesignPowerPartRef & { point: string })[];
  };
  bomDraft?: { items?: readonly DesignPowerBomItem[] };
  power?: { byGroup?: readonly { name: string }[]; voltage?: PowerVoltage };
}

export interface DesignPowerOptions {
  parts?: readonly ComponentPart[];
  /** 显式声明 rotary 是否为伺服轴；缺省从 BOM/旧功率结果推断。 */
  servo?: boolean;
  voltage?: PowerVoltage;
  simultaneity?: number;
  loadFactor?: number;
  efficiency?: number;
  cosPhi?: number;
  selectedBreakerA?: number;
  /** 额外假设（例如参数文件缺失回退）。 */
  assumptions?: readonly string[];
}

function partSpecNumber(part: ComponentPart | undefined, keys: readonly string[]): number | null {
  if (!part) return null;
  for (const key of keys) {
    const raw = part.specs[key];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
    if (typeof raw === 'string') {
      const match = raw.match(/(\d+(?:\.\d+)?)\s*(k?W)\b/i);
      if (match?.[1]) {
        const value = Number(match[1]);
        if (Number.isFinite(value) && value > 0) return /^k/i.test(match[2] ?? '') ? value * 1000 : value;
      }
    }
  }
  return null;
}

/** 从元件库读额定功率；安全光栅按 24V × 消耗电流（多组电流求和）估算。 */
export function ratedPowerFromPart(part: ComponentPart | undefined): number | null {
  if (!part) return null;
  const direct = partSpecNumber(part, ['额定功率', '功率', '输出功率', '额定输出功率']);
  if (direct !== null) return round(direct, 3);
  const currents = part.specs['消耗电流'];
  if (typeof currents === 'string' && /mA/i.test(currents)) {
    const values = [...currents.matchAll(/(\d+(?:\.\d+)?)\s*mA/gi)].map((match) => Number(match[1]));
    const totalMa = values.reduce((sum, value) => sum + value, 0);
    if (totalMa > 0) return round((totalMa / 1000) * 24, 3);
  }
  return null;
}

function findPart(
  parts: readonly ComponentPart[] | undefined,
  id: string,
  packId?: string
): ComponentPart | undefined {
  if (!parts) return undefined;
  return parts.find((part) => part.id === id && (packId === undefined || part.packId === packId));
}

function hasPartReference(ref: DesignPowerPartRef | undefined): boolean {
  return Boolean(ref?.partId?.trim() || ref?.model?.trim());
}

function validRatedW(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? round(value, 3) : null;
}

/** 绑定料号优先按 partId + packId 定位；缺少 partId 时才按型号定位。 */
function findBoundPart(
  parts: readonly ComponentPart[] | undefined,
  ref: DesignPowerPartRef
): ComponentPart | undefined {
  if (!parts) return undefined;
  if (ref.partId) {
    const byId = parts.filter((part) =>
      part.id === ref.partId && (ref.packId === undefined || part.packId === ref.packId)
    );
    if (byId.length === 1) return byId[0];
    if (ref.model) {
      const byIdAndModel = byId.filter((part) => part.model === ref.model);
      if (byIdAndModel.length === 1) return byIdAndModel[0];
    }
    return undefined;
  }
  if (!ref.model) return undefined;
  const byModel = parts.filter((part) =>
    part.model === ref.model && (ref.packId === undefined || part.packId === ref.packId)
  );
  return byModel.length === 1 ? byModel[0] : undefined;
}

function bomRowsForRole(
  design: DesignPowerSource,
  kind: 'actuator' | 'sensor' | 'electrical',
  roles: readonly string[]
): DesignPowerBomItem[] {
  return (design.bomDraft?.items ?? []).filter((item) =>
    (!item.kind || item.kind === kind) && roles.includes(item.role ?? '') &&
    (hasPartReference(item) || validRatedW(item.ratedW) !== null)
  );
}

function samePartReference(left: DesignPowerPartRef, right: DesignPowerPartRef): boolean {
  const samePack = left.packId === undefined || right.packId === undefined || left.packId === right.packId;
  if (left.partId && right.partId) return left.partId === right.partId && samePack;
  return Boolean(left.model && right.model && left.model === right.model && samePack);
}

function bomSourceAtIndex(
  rows: readonly (DesignPowerPartRef & { qty?: number })[],
  index: number
): DesignPowerPartRef | undefined {
  let offset = 0;
  for (const row of rows) {
    const qty = typeof row.qty === 'number' && Number.isInteger(row.qty) && row.qty > 0 ? row.qty : 1;
    if (index < offset + qty) return row;
    offset += qty;
  }
  return undefined;
}

function sourceForConfiguredDevice(
  configured: DesignPowerPartRef,
  rows: readonly (DesignPowerPartRef & { qty?: number })[],
  index: number
): DesignPowerPartRef {
  if (hasPartReference(configured)) {
    const matchingBom = rows.find((row) => samePartReference(configured, row));
    const ratedW = validRatedW(matchingBom?.ratedW) ?? validRatedW(configured.ratedW);
    return { ...configured, ...(ratedW !== null ? { ratedW } : {}) };
  }
  return bomSourceAtIndex(rows, index) ?? configured;
}

function rotaryBomRows(design: DesignPowerSource): ReturnType<typeof bomRowsForRole> {
  const rows = bomRowsForRole(design, 'actuator', ['rotary', 'servo']);
  const notDriveRows = rows.filter((row) => !/伺服驱动器/.test(row.name ?? ''));
  const motorRows = notDriveRows.filter((row) => /伺服电机/.test(row.name ?? ''));
  return motorRows.length > 0 ? motorRows : notDriveRows.length > 0 ? notDriveRows : rows;
}

function sensorKind(point: string): MachineSensorKind {
  if (point.includes('-SAFE-')) return 'safety';
  if (point.includes('-PRS-')) return 'pressure';
  if (point.includes('-PHT-')) return 'photoelectric';
  return 'proximity';
}

function detectServo(design: DesignPowerSource, explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit;
  if (design.power?.byGroup?.some((group) => group.name === '伺服')) return true;
  return (design.bomDraft?.items ?? []).some((item) =>
    /伺服驱动器|伺服电机/.test(item.name ?? '')
  );
}

/** 从方案 config/BOM 组装 PowerInput；优先用元件库额定值。 */
export function powerInputFromDesign(
  design: DesignPowerSource,
  options: DesignPowerOptions = {}
): PowerInput {
  const parts = options.parts;
  const items: PowerInputItem[] = [];
  const servo = detectServo(design, options.servo);
  const push = (
    role: MachinePowerRole,
    qty: number,
    name: string,
    ref: DesignPowerPartRef = {},
    fallbackPart?: ComponentPart
  ): void => {
    if (qty <= 0) return;
    const hasBinding = hasPartReference(ref);
    const selectedPart = hasBinding ? findBoundPart(parts, ref) : undefined;
    const part = hasBinding ? selectedPart : fallbackPart;
    const rated = ratedPowerFromPart(selectedPart) ?? validRatedW(ref.ratedW) ??
      (hasBinding ? null : ratedPowerFromPart(fallbackPart));
    const partId = ref.partId ?? part?.id;
    const packId = ref.packId ?? part?.packId;
    items.push({
      role,
      qty,
      name,
      ...(partId ? { partId } : {}),
      ...(packId ? { packId } : {}),
      ...(ref.model ? { model: ref.model } : {}),
      ...(rated !== null ? { ratedW: rated } : {})
    });
  };

  const servoDrive = findPart(parts, 'SV660PS5R5I', 'iec-cn');
  const servoMotor = findPart(parts, 'MS1H1-75B30CB', 'iec-cn');
  const gripper = findPart(parts, 'MHZ2-20D', 'smc-cn');
  const valve = findPart(parts, 'SY5120-5LZD', 'smc-cn');
  const proximity = findPart(parts, 'D-M9B', 'smc-cn');
  const plc = findPart(parts, 'CP1E-N40DR-A', 'iec-cn');
  const safety = findPart(parts, 'F3SG-4SRA0640-14', 'iec-cn');
  const psu = findPart(parts, 'LRS-350-24', 'iec-cn');

  const cylinderActuators = design.config.actuators?.filter((actuator) => actuator.kind === 'cylinder') ?? [];
  const gripperActuators = design.config.actuators?.filter((actuator) => actuator.kind === 'gripper') ?? [];
  const rotaryActuators = design.config.actuators?.filter((actuator) => actuator.kind === 'rotary') ?? [];
  const cylinderCount = cylinderActuators.length;
  const gripperCount = gripperActuators.length;
  const rotaryCount = rotaryActuators.length;
  const sensors = design.config.sensors ?? [];
  const ordinarySensorConfigs = sensors.filter((sensor) => sensorKind(sensor.point) !== 'safety');
  const safetySensorConfigs = sensors.filter((sensor) => sensorKind(sensor.point) === 'safety');
  const addConfiguredDevices = (
    role: MachinePowerRole,
    name: string,
    configured: readonly DesignPowerPartRef[],
    count: number,
    rows: readonly (DesignPowerPartRef & { qty?: number })[],
    fallbackPart?: ComponentPart
  ): void => {
    if (configured.length === 0) {
      push(role, count, name, {}, fallbackPart);
      return;
    }
    configured.forEach((device, index) => {
      push(role, 1, name, sourceForConfiguredDevice(device, rows, index), fallbackPart);
    });
  };

  addConfiguredDevices(
    'cylinder', '气缸', cylinderActuators, cylinderCount,
    bomRowsForRole(design, 'actuator', ['cylinder'])
  );
  addConfiguredDevices(
    'gripper', '夹爪', gripperActuators, gripperCount,
    bomRowsForRole(design, 'actuator', ['gripper']), gripper
  );
  addConfiguredDevices(
    servo ? 'servo' : 'rotary', servo ? '伺服轴' : '旋转轴', rotaryActuators, rotaryCount,
    rotaryBomRows(design), servo ? (servoDrive ?? servoMotor) : undefined
  );
  addConfiguredDevices(
    'sensor', '传感器', ordinarySensorConfigs, ordinarySensorConfigs.length,
    bomRowsForRole(design, 'sensor', ['sensor']), proximity
  );
  addConfiguredDevices(
    'safety', '安全光栅', safetySensorConfigs, safetySensorConfigs.length,
    bomRowsForRole(design, 'sensor', ['safety']), safety
  );
  const valveRows = bomRowsForRole(design, 'actuator', ['valve']);
  const plcRows = bomRowsForRole(design, 'electrical', ['plc']);
  const psuRows = bomRowsForRole(design, 'electrical', ['psu']);
  push('valve', gripperCount, '电磁阀', bomSourceAtIndex(valveRows, 0) ?? {}, valve);
  push('plc', 1, 'PLC', bomSourceAtIndex(plcRows, 0) ?? {}, plc);
  push('psu', 1, '24V 电源', bomSourceAtIndex(psuRows, 0) ?? {}, psu);

  return {
    items,
    ...(options.simultaneity !== undefined ? { simultaneity: options.simultaneity } : {}),
    ...(options.loadFactor !== undefined ? { loadFactor: options.loadFactor } : {}),
    ...(options.efficiency !== undefined ? { efficiency: options.efficiency } : {}),
    ...(options.cosPhi !== undefined ? { cosPhi: options.cosPhi } : {}),
    voltage: options.voltage ?? design.power?.voltage ?? '380VAC',
    ...(options.selectedBreakerA !== undefined ? { selectedBreakerA: options.selectedBreakerA } : {})
  };
}

/** 核心纯函数：PowerInput → 容量、电流、断路器建议与 24V 余量。 */
function estimatePowerInput(input: PowerInput): PowerResult {
  if (!input || !Array.isArray(input.items)) throw new Error('功率输入必须包含 items 数组');
  if (input.voltage !== '220VAC' && input.voltage !== '380VAC' && input.voltage !== '24VDC') {
    throw new Error('电压必须是 220VAC、380VAC 或 24VDC');
  }
  const simultaneity = positiveOr(input.simultaneity, POWER_DEFAULTS.simultaneity);
  const loadFactor = positiveOr(input.loadFactor, POWER_DEFAULTS.loadFactor);
  const efficiency = positiveOr(input.efficiency, POWER_DEFAULTS.efficiency);
  const cosPhi = positiveOr(input.cosPhi, input.voltage === '24VDC' ? 1 : POWER_DEFAULTS.cosPhi);
  if (simultaneity > 1) throw new Error('同时系数必须在 (0,1] 内');
  if (loadFactor > 1) throw new Error('负载率必须在 (0,1] 内');
  if (efficiency > 1) throw new Error('效率必须在 (0,1] 内');
  if (cosPhi > 1) throw new Error('功率因数必须在 (0,1] 内');

  const warnings: string[] = [];
  const assumptions: string[] = [
    `同时系数 Ks=${simultaneity}：多负载不会同时达到额定功率，按此系数折减。`,
    `负载率 Kf=${loadFactor}：设备实际轴功率按额定功率的此比例估算。`,
    `效率 η=${efficiency}：由机械输出折算到电输入，P_in = ΣP_rated × Ks × Kf ÷ η。`,
    `功率因数 cosφ=${cosPhi}：视在功率 S = P_in ÷ cosφ，电流按此计算。`,
    `断路器按计算电流 × 1.25 向上取标准壳架电流（6–630 A），极数按 ${input.voltage} 取 ${polesFor(input.voltage)}P。`,
    '导线截面按断路器额定反选：取载流量 ≥ 断路器额定电流的最小常用截面；超过单根 6mm² 时提示分回路或并联，不静默选超粗线。'
  ];
  const defaultsUsed = new Map<MachinePowerRole, { count: number; missing: number }>();
  const groups = new Map<MachinePowerRole, { count: number; ratedW: number; effectiveW: number }>();
  let connectedW = 0;
  let effectiveW = 0;
  let dc24LoadW = 0;
  let psuSupplyW: number | null = null;

  for (const item of input.items) {
    if (!item || typeof item.qty !== 'number' || !Number.isFinite(item.qty) || item.qty <= 0) {
      throw new Error('功率条目数量必须是正数');
    }
    if (item.role === 'psu') {
      const rated = typeof item.ratedW === 'number' && item.ratedW > 0 ? item.ratedW : ROLE_DEFAULT_W.psu;
      psuSupplyW = (psuSupplyW ?? 0) + rated * item.qty;
      continue;
    }
    const hasRated = typeof item.ratedW === 'number' && Number.isFinite(item.ratedW) && item.ratedW > 0;
    const rated = hasRated ? item.ratedW as number : ROLE_DEFAULT_W[item.role] ?? ROLE_DEFAULT_W.other;
    if (!hasRated) {
      const record = defaultsUsed.get(item.role) ?? { count: 0, missing: 0 };
      record.count += item.qty;
      record.missing += item.qty;
      defaultsUsed.set(item.role, record);
      const reference = item.partId
        ? `${item.packId ? `${item.packId}:` : ''}${item.partId}`
        : item.model ?? '无 partId/型号';
      warnings.push(
        `${item.name ?? POWER_ROLE_LABEL[item.role]}缺少额定功率（${reference} × ${item.qty}），` +
        `按类别默认 ${rated} W/件估算。`
      );
    }
    const connected = rated * item.qty;
    const effective = connected * simultaneity * loadFactor;
    connectedW += connected;
    effectiveW += effective;
    if (isDc24Item(item)) dc24LoadW += connected;
    const group = groups.get(item.role) ?? { count: 0, ratedW: 0, effectiveW: 0 };
    group.count += item.qty;
    group.ratedW += connected;
    group.effectiveW += effective;
    groups.set(item.role, group);
  }

  const inputW = effectiveW / efficiency;
  const totalVa = inputW / cosPhi;
  const totalKw = inputW / 1000;
  const currentA = currentForPower(totalKw, input.voltage, cosPhi);
  const mainProtection = selectCableProtection(currentA, { label: '总进线' });
  const rating = mainProtection.breakerA;
  const margin = currentA > 0 ? rating / currentA : 0;
  warnings.push(...mainProtection.warnings);
  const byGroup: PowerGroup[] = [...groups.entries()].map(([role, group]) => ({
    name: POWER_ROLE_LABEL[role],
    count: group.count,
    ratedW: round(group.ratedW, 3),
    va: round((group.effectiveW / efficiency) / cosPhi, 3)
  }));

  if (defaultsUsed.size > 0) {
    const detail = [...defaultsUsed.entries()].map(([role, record]) => {
      const label = POWER_ROLE_LABEL[role];
      return `${label} ${record.missing} 件按 ${ROLE_DEFAULT_W[role]} W`;
    }).join('、');
    assumptions.push(`额定功率缺失时使用类别默认值：${detail}。默认值仅用于方案阶段粗估。`);
  } else {
    assumptions.push(
      `类别默认值仅在元件库无额定功率时使用：伺服 ${ROLE_DEFAULT_W.servo} W、` +
      `气缸 ${ROLE_DEFAULT_W.cylinder} W、夹爪 ${ROLE_DEFAULT_W.gripper} W、旋转轴 ${ROLE_DEFAULT_W.rotary} W、` +
      `传感器 ${ROLE_DEFAULT_W.sensor} W、安全光栅 ${ROLE_DEFAULT_W.safety} W、PLC ${ROLE_DEFAULT_W.plc} W、` +
      `电磁阀 ${ROLE_DEFAULT_W.valve} W。`
    );
  }

  let dc24: Dc24Estimate | null = null;
  if (dc24LoadW > 0 || psuSupplyW !== null) {
    const supplyW = psuSupplyW ?? ROLE_DEFAULT_W.psu;
    const marginPct = supplyW > 0 ? ((supplyW - dc24LoadW) / supplyW) * 100 : 0;
    dc24 = {
      loadW: round(dc24LoadW, 3),
      supplyW: round(supplyW, 3),
      marginPct: round(marginPct, 1)
    };
    assumptions.push(
      `24 VDC 回路按连接负载 ${round(dc24LoadW)} W 统计，电源容量 ${round(supplyW)} W；` +
      `余量 ${dc24.marginPct}%，负载超过额定 70% 时告警。`
    );
    if (dc24LoadW > supplyW) {
      warnings.push(`24 VDC 负载 ${round(dc24LoadW)} W 超过电源容量 ${round(supplyW)} W。`);
    } else if (dc24LoadW / supplyW > 0.7) {
      warnings.push(`24 VDC 电源余量不足：负载 ${round(dc24LoadW)} W / 容量 ${round(supplyW)} W = ` +
        `${round((dc24LoadW / supplyW) * 100, 1)}%，已超过 70%。`);
    }
  }

  const selected = input.selectedBreakerA;
  if (typeof selected === 'number' && Number.isFinite(selected) && selected > 0) {
    if (currentA > selected) {
      warnings.push(
        `计算电流 ${round(currentA)} A 超过已选总进线断路器 ${selected} A，必须放大断路器或分回路。`
      );
    } else if (selected / currentA > 1.6) {
      warnings.push(
        `已选总进线断路器 ${selected} A 对计算电流 ${round(currentA)} A 余量 ` +
        `${round((selected / currentA - 1) * 100, 1)}% 超过 60%，可评估降一档。`
      );
    }
  }

  assumptions.push(`整机连接负载 ${round(connectedW)} W；经系数折算为输入有功 ${round(totalKw * 1000)} W。`);

  return {
    va: round(totalVa, 3),
    totalVa: round(totalVa, 3),
    totalKw: round(totalKw, 3),
    byGroup,
    currentA: round(currentA, 3),
    breakerSuggestion: { rating, poles: polesFor(input.voltage), margin: round(margin, 3) },
    mainProtection: {
      breakerA: mainProtection.breakerA,
      sectionMm2: mainProtection.sectionMm2,
      ampacityA: mainProtection.ampacityA
    },
    assumptions,
    warnings,
    voltage: input.voltage,
    cosPhi,
    simultaneity,
    loadFactor,
    efficiency,
    dc24
  };
}

function isPowerInput(value: PowerInput | DesignPowerSource): value is PowerInput {
  return Array.isArray((value as PowerInput).items);
}

/** 允许 `estimatePower(design, options)` 直接接入方案对象。 */
export function estimatePowerForDesign(
  design: DesignPowerSource,
  options: DesignPowerOptions = {}
): PowerResult {
  const input = powerInputFromDesign(design, options);
  const result = estimatePowerInput(input);
  if (options.assumptions?.length) result.assumptions.unshift(...options.assumptions);
  return result;
}

/**
 * 与任务约定一致：传 PowerInput 做纯计算，传方案对象则先组装 PowerInput。
 */
export function estimatePower(
  value: PowerInput | DesignPowerSource,
  options: DesignPowerOptions = {}
): PowerResult {
  return isPowerInput(value) ? estimatePowerInput(value) : estimatePowerForDesign(value, options);
}
