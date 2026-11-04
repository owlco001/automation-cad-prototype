/**
 * ElecDesign → Circuit（+ 版面用的结构计划 ElecPlan）。
 *
 * 规则全部按“负载/信号类别”展开，不认机型：
 *   主回路：总进线断路器 -QF0 → 母线 → 每路负载一条支路
 *           （开关电源 / 直接起动 QF-KM-FR-M / 变频 QF-U-M / 伺服 QF-U-M 单相 220V）；
 *   控制回路：+24V → -FU1 → 急停（无安全继电器时串联）/ 安全继电器安全输出 → 安全母线 S；
 *            起保停硬接线电机挂在 S 下；PLC 输出组电源 3L+ 也取自 S（急停切断全部输出）；
 *   PLC 输入：三线制 / 两线制 / 触点 / 安全继电器状态；PLC 输出：电磁阀 / 灯 / 蜂鸣器 / 继电器 / 电机运行；
 *   端子排 -X1：凡是“柜内元件与现场元件同在一个网络”，现场元件的每个引脚各占一个端子。
 */

import type { Circuit, CircuitDevice, CircuitNet, DeviceKind } from './circuit.ts';
import { PIN } from './circuit.ts';
import { normalizeElecDesign, type DesignIssue, type ElecDesign, type ElecInput, type ElecMotor, type ElecOutput } from './design.ts';
import { breakerNameFor } from './machine-circuit.ts';
import { selectMotorProtection } from './protection.ts';
import { breakerFor, breakerRatingFromModel, selectCableForBreaker } from './selection.ts';

export interface PowerBranch {
  kind: 'psu' | 'dol' | 'vfd' | 'servo';
  /** 单相支路取电的相 */
  phase?: 'L1' | 'L2' | 'L3';
  breaker: string;
  /** 支路断路器额定电流（由型号读出；读不出按计算电流选标准档） */
  breakerA: number;
  /** 导线截面与载流量：按断路器额定选出，保证 ampacityA ≥ breakerA */
  sectionMm2: number | null;
  ampacityA: number | null;
  currentA: number;
  poles: number;
  contactor?: string;
  thermal?: string;
  drive?: string;
  psu?: string;
  motor?: string;
  purpose: string;
}

export type LadderStep = { kind: 'series'; tag: string } | { kind: 'parallel'; tags: string[] };

/** 挂在安全母线 S 与 0V 之间的一条电流路径 */
export interface Rung {
  steps: LadderStep[];
  /** 末端线圈 */
  coil: string;
}

export interface SafetyBlock {
  relay: string;
  kind: 'estop' | 'curtain';
  /** 急停双通道：每通道串联的常闭触点位号 */
  channels: string[][];
  reset: string;
  curtain?: string;
  status: boolean;
}

export interface InputColumn {
  address: string;
  kind: 'sensor3' | 'sensor2' | 'contact' | 'status';
  /** 现场元件位号；status 为安全继电器位号 */
  tag: string;
  purpose: string;
  point?: string;
}

export interface OutputColumn {
  address: string;
  kind: 'field' | 'coil' | 'drive';
  /** 自上而下串联的元件位号（coil：[热继常闭?, 线圈]；drive：[驱动器控制端子]；field：[负载]） */
  tags: string[];
  purpose: string;
  point?: string;
}

export interface ElecPlan {
  mainBreaker: string;
  /** 总进线断路器—导线配合（先定断路器，再按断路器额定选截面） */
  mainFeed: { breakerA: number; sectionMm2: number | null; ampacityA: number | null; currentA: number };
  branches: PowerBranch[];
  fuse: string;
  /** -FU1 与安全母线 S 之间串联的元件（急停或安全继电器安全输出） */
  chain: string[];
  rungs: Rung[];
  safety: SafetyBlock[];
  inputs: InputColumn[];
  outputs: OutputColumn[];
  plc: string;
  /** 输入公共端 1M 接哪条母线 */
  inputCommon: '+24V' | '0V';
  /** 现场引脚 → 端子位号 */
  terminalOf: Record<string, string>;
}

export interface ElecBuild {
  design: ElecDesign;
  circuit: Circuit;
  plan: ElecPlan;
  issues: DesignIssue[];
}

/** 网络 id：安全母线（急停/安全继电器之后的 24V） */
export const SAFE_NET = 'S24';
export const TERMINAL_STRIP = '-X1';

const BREAKER_STEPS_1P = [1, 2, 3, 4, 6, 10, 16, 20, 25, 32, 40, 50, 63];
const MAIN_STEPS = [6, 10, 16, 20, 25, 32, 40, 50, 63, 80, 100, 125, 160];

function stepUp(steps: readonly number[], value: number): number {
  return steps.find((step) => step >= value) ?? (steps[steps.length - 1] as number);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 型号里的极数：3P / 2P / 1P+N（2 极）/ 1P */
export function polesOfModel(model: string, fallback: number): number {
  const hit = /([1-4])\s*P(\s*\+\s*N)?/i.exec(model);
  if (!hit) return fallback;
  return Number(hit[1]) + (hit[2] ? 1 : 0);
}

export function buildElec(input: ElecDesign): ElecBuild {
  const { design, issues } = normalizeElecDesign(input);
  const devices: CircuitDevice[] = [];
  const netPins = new Map<string, string[]>();
  const netLabel = new Map<string, string>();
  const counters = new Map<string, number>();
  const nextTag = (prefix: string): string => {
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    return `-${prefix}${n}`;
  };
  const add = (
    tag: string,
    kind: DeviceKind,
    name: string,
    model: string,
    spec: string,
    pins: string[],
    extra: Partial<CircuitDevice> = {}
  ): CircuitDevice => {
    const device: CircuitDevice = { tag, kind, name, model, spec, pins, ...extra };
    devices.push(device);
    return device;
  };
  const join = (net: string, ...pins: string[]): void => {
    const list = netPins.get(net) ?? [];
    list.push(...pins);
    netPins.set(net, list);
  };
  /**
   * 断路器已定（型号 → 额定电流）后，按额定选导线截面。
   * 选不出来 / 截面超过常用单根上限时只告警并提示分回路，不静默换一根超粗线。
   */
  const cableFor = (
    currentA: number,
    model: string,
    label: string
  ): { breakerA: number; sectionMm2: number | null; ampacityA: number | null } => {
    const breakerA = breakerRatingFromModel(model) ?? breakerFor(currentA);
    const cable = selectCableForBreaker(breakerA, { label });
    for (const message of cable.warnings) {
      issues.push({ severity: 'warning', code: 'CABLE_SELECTION', message });
    }
    return { breakerA, sectionMm2: cable.sectionMm2, ampacityA: cable.ampacityA };
  };
  for (const label of ['L1', 'L2', 'L3', 'N', 'PE', '+24V', '0V']) {
    netLabel.set(label, label);
    netPins.set(label, []);
  }

  /* ================= 主回路 ================= */
  const motorById = new Map(design.motors.map((motor) => [motor.id, motor]));
  const branches: PowerBranch[] = [];
  const phaseLoadA: Record<'L1' | 'L2' | 'L3', number> = { L1: 0, L2: 0, L3: 0 };
  let singlePhaseIndex = 0;
  const nextPhase = (): 'L1' | 'L2' | 'L3' => {
    const phase = (['L1', 'L2', 'L3'] as const)[singlePhaseIndex % 3] as 'L1' | 'L2' | 'L3';
    singlePhaseIndex += 1;
    return phase;
  };

  const mainTag = '-QF0';
  counters.set('QF', 0);
  const busNet = (phase: string): string => `BUS-${phase}`;

  /** 单相支路：断路器（1P 或 1P+N）→ 负载 L/N */
  const singlePhaseFeed = (
    branchIndex: number,
    breakerModel: string,
    currentA: number,
    phase: 'L1' | 'L2' | 'L3',
    loadTag: string,
    purpose: string
  ): { breaker: string; poles: number } => {
    const poles = Math.min(2, polesOfModel(breakerModel, 2));
    const breaker = nextTag('QF');
    const pins = poles === 2 ? ['1', '3', '2', '4'] : ['1', '2'];
    add(breaker, 'breaker', breakerNameFor(breakerModel), breakerModel, `计算电流 ${round1(currentA)} A`, pins, { estimated: true });
    join(busNet(phase), PIN(breaker, '1'));
    join(`B${branchIndex}-L`, PIN(breaker, poles === 2 ? '2' : '2'), PIN(loadTag, 'L'));
    if (poles === 2) {
      join('N', PIN(breaker, '3'));
      join(`B${branchIndex}-N`, PIN(breaker, '4'), PIN(loadTag, 'N'));
    } else {
      join('N', PIN(loadTag, 'N'));
    }
    phaseLoadA[phase] += currentA;
    return { breaker, poles };
  };

  // 开关电源支路
  const psuWatts = design.psu.watts ?? 240;
  const psuTag = '-G1';
  {
    const currentA = psuWatts / (220 * 0.9 * 0.9);
    const model = `iC65N 1P+N C${stepUp(BREAKER_STEPS_1P, currentA * 1.25)}`;
    const phase = nextPhase();
    const feed = singlePhaseFeed(branches.length, model, currentA, phase, psuTag, '24V 电源');
    const cable = cableFor(currentA, model, `${psuTag} 24V 电源支路`);
    add(psuTag, 'psu', '24V 开关电源', design.psu.model, `DC 24V · ${psuWatts} W`, ['L', 'N', '+', '-']);
    join('+24V', PIN(psuTag, '+'));
    join('0V', PIN(psuTag, '-'));
    branches.push({
      kind: 'psu', phase, breaker: feed.breaker, poles: feed.poles, psu: psuTag, purpose: '24V 电源',
      currentA, ...cable
    });
  }

  const motorTag = new Map<string, string>();
  const contactorOf = new Map<string, { km: string; fr: string }>();
  const driveOf = new Map<string, string>();
  for (const motor of design.motors) {
    const index = branches.length;
    const mTag = nextTag('M');
    motorTag.set(motor.id, mTag);
    const motorSpec = [`${motor.powerKw} kW`, motor.spec].filter(Boolean).join(' · ');
    const motorModel = motor.motorModel ?? (motor.starter === 'servo' ? '交流伺服电机' : '三相异步电机');
    add(mTag, 'motor', motor.name, motorModel, motorSpec, ['U', 'V', 'W', 'PE'], { field: true, ...(motor.purpose ? { purpose: motor.purpose } : {}) });
    join('PE', PIN(mTag, 'PE'));
    const purpose = motor.purpose ?? motor.name;
    if (motor.starter === 'servo') {
      const uTag = nextTag('U');
      driveOf.set(motor.id, uTag);
      const currentA = (motor.powerKw * 1000) / (220 * 0.85 * 0.9);
      const model = motor.breakerModel ?? `iC65N 1P+N C${stepUp(BREAKER_STEPS_1P, currentA * 1.25)}`;
      const phase = nextPhase();
      const feed = singlePhaseFeed(index, model, currentA, phase, uTag, purpose);
      const cable = cableFor(currentA, model, `${mTag} 伺服支路`);
      add(uTag, 'drive', '伺服驱动器', motor.driveModel ?? `伺服驱动器 ${motor.powerKw} kW`, `单相 AC 220V · ${motor.powerKw} kW`, ['L', 'N', 'U', 'V', 'W']);
      ['U', 'V', 'W'].forEach((pin) => join(`B${index}-${pin}`, PIN(uTag, pin), PIN(mTag, pin)));
      branches.push({
        kind: 'servo', phase, breaker: feed.breaker, poles: feed.poles, drive: uTag, motor: mTag, purpose,
        currentA, ...cable
      });
      continue;
    }
    const protection = selectMotorProtection(motor.powerKw);
    const breakerModel = motor.breakerModel ?? protection.breaker;
    const cable = cableFor(protection.currentA, breakerModel, `${purpose} 主回路`);
    const qf = nextTag('QF');
    add(qf, 'breaker', breakerNameFor(breakerModel), breakerModel, `计算电流 ${protection.currentA} A`, ['1', '3', '5', '2', '4', '6'], { estimated: true });
    (['L1', 'L2', 'L3'] as const).forEach((phase, i) => {
      join(busNet(phase), PIN(qf, ['1', '3', '5'][i] as string));
      phaseLoadA[phase] += protection.currentA;
    });
    if (motor.starter === 'vfd') {
      const uTag = nextTag('U');
      driveOf.set(motor.id, uTag);
      add(uTag, 'drive', '变频器', motor.driveModel ?? `变频器 ${motor.powerKw} kW 380V`, `三相 AC 380V · ${motor.powerKw} kW`, ['L1', 'L2', 'L3', 'U', 'V', 'W']);
      ['L1', 'L2', 'L3'].forEach((pin, i) => join(`B${index}-Q${i}`, PIN(qf, ['2', '4', '6'][i] as string), PIN(uTag, pin)));
      ['U', 'V', 'W'].forEach((pin) => join(`B${index}-${pin}`, PIN(uTag, pin), PIN(mTag, pin)));
      branches.push({ kind: 'vfd', breaker: qf, poles: 3, drive: uTag, motor: mTag, purpose, currentA: protection.currentA, ...cable });
      continue;
    }
    const km = nextTag('KM');
    const fr = `-FR${km.slice(3)}`;
    contactorOf.set(motor.id, { km, fr });
    add(km, 'contactor', '交流接触器', protection.contactor, `计算电流 ${protection.currentA} A`, ['1', '3', '5', '2', '4', '6'], { estimated: true });
    add(fr, 'thermal', '热过载继电器', protection.thermal, `整定 ${protection.thermalSetA} A`, ['1', '3', '5', '2', '4', '6'], { estimated: true });
    ['1', '3', '5'].forEach((pinIn, i) => {
      const pinOut = ['2', '4', '6'][i] as string;
      join(`B${index}-Q${i}`, PIN(qf, pinOut), PIN(km, pinIn));
      join(`B${index}-K${i}`, PIN(km, pinOut), PIN(fr, pinIn));
      join(`B${index}-${['U', 'V', 'W'][i]}`, PIN(fr, pinOut), PIN(mTag, ['U', 'V', 'W'][i] as string));
    });
    add(`${fr}NC`, 'nc', '热继常闭触点', protection.thermal, '95/96', ['95', '96'], { displayTag: fr });
    add(`${km}K`, 'coil', '接触器线圈', protection.contactor, '24V DC · A1/A2', ['A1', 'A2'], { displayTag: km });
    join('0V', PIN(`${km}K`, 'A2'));
    join(`${km}-COIL`, PIN(`${fr}NC`, '96'), PIN(`${km}K`, 'A1'));
    branches.push({ kind: 'dol', breaker: qf, poles: 3, contactor: km, thermal: fr, motor: mTag, purpose, currentA: protection.currentA, ...cable });
  }

  // 总进线断路器
  let mainFeed: ElecPlan['mainFeed'] = { breakerA: 0, sectionMm2: null, ampacityA: null, currentA: 0 };
  {
    const maxA = Math.max(phaseLoadA.L1, phaseLoadA.L2, phaseLoadA.L3);
    const rating = stepUp(MAIN_STEPS, Math.max(1, maxA) * 1.25);
    const model = design.supply.mainBreakerModel ?? (rating <= 63 ? `iC65N 3P C${rating}` : `NSX160F 3P ${rating}A`);
    const cable = cableFor(maxA, model, '总进线');
    mainFeed = { breakerA: cable.breakerA, sectionMm2: cable.sectionMm2, ampacityA: cable.ampacityA, currentA: maxA };
    add(mainTag, 'breaker', breakerNameFor(model), model, `总进线 · 最大相 ${round1(maxA)} A`, ['1', '3', '5', '2', '4', '6'], { estimated: true });
    (['L1', 'L2', 'L3'] as const).forEach((phase, i) => {
      join(phase, PIN(mainTag, ['1', '3', '5'][i] as string));
      join(busNet(phase), PIN(mainTag, ['2', '4', '6'][i] as string));
    });
  }

  /* ================= 控制回路 ================= */
  const fuse = '-FU1';
  add(fuse, 'fuse', '熔断器', 'RT18-32', '6 A', ['1', '2'], { estimated: true });
  join('+24V', PIN(fuse, '1'));
  const chain: string[] = [];
  const safety: SafetyBlock[] = [];
  const estopTags: string[] = [];
  for (let i = 0; i < design.safety.estops; i += 1) estopTags.push(nextTag('SB'));
  const statusFor = (key: string): boolean => design.inputs.some((item) => item.device === 'safety-status' && item.safetyOf === key);
  const relayTags = new Map<string, string>();

  if (design.safety.relay && estopTags.length > 0) {
    const ks = nextTag('KS');
    relayTags.set('estop', ks);
    const reset = nextTag('SB');
    const status = statusFor('estop');
    const model = design.safety.relayModel ?? 'PNOZ s3';
    add(ks, 'safety', '安全继电器（急停）', model, '双通道急停 · 手动复位', ['A1', 'A2', 'S11', 'S12', 'S21', 'S22', 'S33', 'S34', ...(status ? ['Y32'] : [])]);
    add(`${ks}Q`, 'no', '安全输出', model, '13/14', ['13', '14'], { displayTag: ks, stopFunction: true });
    join('+24V', PIN(ks, 'A1'));
    join('0V', PIN(ks, 'A2'));
    const ch1: string[] = [];
    const ch2: string[] = [];
    estopTags.forEach((tag) => {
      add(tag, 'nc', '急停按钮（常闭）', 'XB2-BS542C', '蘑菇头 · 双触点 11-12/21-22', ['11', '12'], { field: true });
      add(`${tag}B`, 'nc', '急停按钮第二触点', 'XB2-BS542C', '21-22', ['21', '22'], { displayTag: tag, field: true });
      ch1.push(tag);
      ch2.push(`${tag}B`);
    });
    const loop = (from: string, to: string, tags: string[], pinA: string, pinB: string, id: string): void => {
      let prev = PIN(ks, from);
      tags.forEach((tag, i) => {
        join(`${id}-${i}`, prev, PIN(tag, pinA));
        prev = PIN(tag, pinB);
      });
      join(`${id}-${tags.length}`, prev, PIN(ks, to));
    };
    loop('S11', 'S12', ch1, '11', '12', `${ks}-C1`);
    loop('S21', 'S22', ch2, '21', '22', `${ks}-C2`);
    add(reset, 'no', '复位按钮（常开）', 'XB2-BA61C', '蓝色', ['13', '14'], { field: true });
    join(`${ks}-R1`, PIN(ks, 'S33'), PIN(reset, '13'));
    join(`${ks}-R2`, PIN(reset, '14'), PIN(ks, 'S34'));
    safety.push({ relay: ks, kind: 'estop', channels: [ch1, ch2], reset, status });
    chain.push(`${ks}Q`);
  } else {
    estopTags.forEach((tag) => {
      add(tag, 'nc', '急停按钮（常闭）', 'XB2-BS542C', '蘑菇头 · 旋转复位', ['11', '12'], { field: true });
      chain.push(tag);
    });
  }
  for (const curtain of design.safety.curtains) {
    const ks = nextTag('KS');
    relayTags.set(curtain.id, ks);
    const reset = nextTag('SB');
    const bl = nextTag('BL');
    const status = statusFor(curtain.id);
    const model = design.safety.curtainRelayModel ?? design.safety.relayModel ?? 'PNOZ s3';
    add(ks, 'safety', '安全继电器（光栅）', model, 'OSSD 双通道 · 手动复位', ['A1', 'A2', 'S12', 'S22', 'S33', 'S34', ...(status ? ['Y32'] : [])]);
    add(`${ks}Q`, 'no', '安全输出', model, '13/14', ['13', '14'], { displayTag: ks, stopFunction: true });
    add(bl, 'curtain', curtain.name, curtain.model ?? '安全光栅 Type 4', 'OSSD1/OSSD2 · PNP', ['+', '-', 'OSSD1', 'OSSD2'], { field: true, ...(curtain.purpose ? { purpose: curtain.purpose } : {}) });
    add(reset, 'no', '复位按钮（常开）', 'XB2-BA61C', '蓝色', ['13', '14'], { field: true });
    join('+24V', PIN(ks, 'A1'), PIN(bl, '+'));
    join('0V', PIN(ks, 'A2'), PIN(bl, '-'));
    join(`${ks}-O1`, PIN(bl, 'OSSD1'), PIN(ks, 'S12'));
    join(`${ks}-O2`, PIN(bl, 'OSSD2'), PIN(ks, 'S22'));
    join(`${ks}-R1`, PIN(ks, 'S33'), PIN(reset, '13'));
    join(`${ks}-R2`, PIN(reset, '14'), PIN(ks, 'S34'));
    safety.push({ relay: ks, kind: 'curtain', channels: [], reset, curtain: bl, status });
    chain.push(`${ks}Q`);
  }
  // FU1 → chain → S
  {
    let prev = PIN(fuse, '2');
    chain.forEach((tag, i) => {
      const device = devices.find((item) => item.tag === tag) as CircuitDevice;
      join(`CH-${i}`, prev, PIN(tag, device.pins[0] as string));
      prev = PIN(tag, device.pins[1] as string);
    });
    join(SAFE_NET, prev);
  }

  // 起保停硬接线
  const rungs: Rung[] = [];
  if (design.startStop === 'hardwired') {
    const dolMotors = design.motors.filter((motor) => motor.starter === 'dol');
    const stop = nextTag('SB');
    const start = nextTag('SB');
    add(stop, 'nc', '停止按钮（常闭）', 'XB2-BA42C', '红色', ['11', '12'], { field: true });
    add(start, 'no', '启动按钮（常开）', 'XB2-BA31C', '绿色', ['13', '14'], { field: true });
    join(SAFE_NET, PIN(stop, '11'));
    if (dolMotors.length === 1) {
      const { km, fr } = contactorOf.get((dolMotors[0] as ElecMotor).id) as { km: string; fr: string };
      add(`${km}A`, 'no', '接触器辅助触点', devices.find((d) => d.tag === km)?.model ?? '', '13/14 NO', ['13', '14'], { displayTag: km });
      join('HW-1', PIN(stop, '12'), PIN(start, '13'), PIN(`${km}A`, '13'));
      join('HW-2', PIN(start, '14'), PIN(`${km}A`, '14'), PIN(`${fr}NC`, '95'));
      rungs.push({ steps: [{ kind: 'series', tag: stop }, { kind: 'parallel', tags: [start, `${km}A`] }, { kind: 'series', tag: `${fr}NC` }], coil: `${km}K` });
    } else {
      const ka = nextTag('KA');
      add(ka, 'coil', '运行中间继电器', 'RXM4AB2BD', '24V DC · 4NO', ['A1', 'A2']);
      add(`${ka}A`, 'no', '中间继电器触点', 'RXM4AB2BD', '13/14 NO', ['13', '14'], { displayTag: ka });
      join('HW-1', PIN(stop, '12'), PIN(start, '13'), PIN(`${ka}A`, '13'));
      join('HW-2', PIN(start, '14'), PIN(`${ka}A`, '14'), PIN(ka, 'A1'));
      join('0V', PIN(ka, 'A2'));
      rungs.push({ steps: [{ kind: 'series', tag: stop }, { kind: 'parallel', tags: [start, `${ka}A`] }], coil: ka });
      dolMotors.forEach((motor, i) => {
        const { km, fr } = contactorOf.get(motor.id) as { km: string; fr: string };
        const contact = `${ka}C${i + 2}`;
        const n = i + 2;
        add(contact, 'no', '中间继电器触点', 'RXM4AB2BD', `${n}3/${n}4 NO`, [`${n}3`, `${n}4`], { displayTag: ka });
        join(SAFE_NET, PIN(contact, `${n}3`));
        join(`HW-M${i}`, PIN(contact, `${n}4`), PIN(`${fr}NC`, '95'));
        rungs.push({ steps: [{ kind: 'series', tag: contact }, { kind: 'series', tag: `${fr}NC` }], coil: `${km}K` });
      });
    }
  }

  /* ================= PLC ================= */
  const plc = '-A1';
  const plcPins: string[] = ['L+', 'M'];
  join('+24V', PIN(plc, 'L+'));
  join('0V', PIN(plc, 'M'));
  const inputs: InputColumn[] = [];
  const outputs: OutputColumn[] = [];
  const npn = design.inputs.some((item) => item.output === 'npn');
  const inputCommon: '+24V' | '0V' = npn ? '+24V' : '0V';
  if (design.inputs.length > 0) {
    plcPins.push('1M');
    join(inputCommon, PIN(plc, '1M'));
  }
  const sensorName: Record<string, string> = {
    photoelectric: '光电传感器',
    proximity: '接近开关',
    pressure: '压力开关',
    'proximity-2w': '磁性开关（两线）'
  };
  for (const item of design.inputs as Array<ElecInput & { address: string }>) {
    plcPins.push(item.address);
    const signal = `IN-${item.address}`;
    const base = { purpose: item.purpose, ...(item.point ? { point: item.point } : {}) };
    if (item.device === 'safety-status') {
      const ks = relayTags.get(item.safetyOf ?? 'estop') as string;
      join(signal, PIN(ks, 'Y32'), PIN(plc, item.address));
      inputs.push({ address: item.address, kind: 'status', tag: ks, ...base });
      continue;
    }
    if (item.device === 'button-no' || item.device === 'button-nc') {
      const tag = nextTag('SB');
      const nc = item.device === 'button-nc';
      const name = item.role === 'start' ? '启动按钮（常开）' : item.role === 'stop' ? '停止按钮（常闭）' : item.role === 'reset' ? '复位按钮（常开）' : nc ? '按钮/开关（常闭）' : '按钮/开关（常开）';
      const model = item.model ?? (item.role === 'start' ? 'XB2-BA31C' : item.role === 'stop' ? 'XB2-BA42C' : nc ? 'XB2-BA42C' : 'XB2-BA61C');
      const [a, b] = nc ? ['11', '12'] : ['13', '14'];
      add(tag, nc ? 'nc' : 'no', name, model, item.role === 'start' ? '绿色' : item.role === 'stop' ? '红色' : '24V DC', [a as string, b as string], { field: true, purpose: item.purpose });
      // 触点下端接 +24V，上端接 PLC 输入（源型输入，公共端 1M 接 0V）
      join(npn ? '0V' : '+24V', PIN(tag, b as string));
      join(signal, PIN(tag, a as string), PIN(plc, item.address));
      inputs.push({ address: item.address, kind: 'contact', tag, ...base });
      continue;
    }
    const tag = nextTag('B');
    if (item.device === 'proximity-2w') {
      add(tag, 'sensor2', sensorName[item.device] as string, item.model ?? 'D-M9B', '两线 · 24V DC', ['+', '-'], { field: true, purpose: item.purpose });
      join(npn ? '0V' : '+24V', PIN(tag, '+'));
      join(signal, PIN(tag, '-'), PIN(plc, item.address));
      inputs.push({ address: item.address, kind: 'sensor2', tag, ...base });
      continue;
    }
    const defaults: Record<string, string> = { photoelectric: 'E3Z-D81', proximity: 'E2E-X5E1', pressure: 'ISE20-P-M' };
    add(tag, 'sensor', sensorName[item.device] as string, item.model ?? (defaults[item.device] as string), `${(item.output ?? 'pnp').toUpperCase()} · 24V DC`, ['+', '-', 'OUT'], { field: true, purpose: item.purpose });
    join('+24V', PIN(tag, '+'));
    join('0V', PIN(tag, '-'));
    join(signal, PIN(tag, 'OUT'), PIN(plc, item.address));
    inputs.push({ address: item.address, kind: 'sensor3', tag, ...base });
  }

  const qPins: string[] = [];
  if (design.outputs.length > 0) {
    plcPins.push('3L+', '3M');
    join(SAFE_NET, PIN(plc, '3L+'));
    join('0V', PIN(plc, '3M'));
  }
  for (const item of design.outputs as Array<ElecOutput & { address: string }>) {
    plcPins.push(item.address);
    qPins.push(item.address);
    const signal = `OUT-${item.address}`;
    const base = { purpose: item.purpose, ...(item.point ? { point: item.point } : {}) };
    if (item.device === 'motor-run') {
      const motor = motorById.get(item.motorId ?? '') as ElecMotor;
      const contactor = contactorOf.get(motor.id);
      if (contactor) {
        join(signal, PIN(plc, item.address), PIN(`${contactor.fr}NC`, '95'));
        outputs.push({ address: item.address, kind: 'coil', tags: [`${contactor.fr}NC`, `${contactor.km}K`], ...base });
        continue;
      }
      const drive = driveOf.get(motor.id) as string;
      const servo = motor.starter === 'servo';
      const [run, com] = servo ? ['SON', 'COM'] : ['DI1', 'COM'];
      add(`${drive}C`, 'module', servo ? '伺服驱动器控制端子' : '变频器控制端子', devices.find((d) => d.tag === drive)?.model ?? '', servo ? 'SON 使能 · COM' : 'DI1 运行 · COM', [run, com], { displayTag: drive });
      join(signal, PIN(plc, item.address), PIN(`${drive}C`, run));
      join('0V', PIN(`${drive}C`, com));
      outputs.push({ address: item.address, kind: 'drive', tags: [`${drive}C`], ...base });
      continue;
    }
    if (item.device === 'relay') {
      const ka = nextTag('KA');
      add(ka, 'coil', '中间继电器', item.model ?? 'RXM2AB2BD', '24V DC', ['A1', 'A2'], { purpose: item.purpose });
      join(signal, PIN(plc, item.address), PIN(ka, 'A1'));
      join('0V', PIN(ka, 'A2'));
      outputs.push({ address: item.address, kind: 'coil', tags: [ka], ...base });
      continue;
    }
    const spec = {
      valve: { prefix: 'YV', kind: 'solenoid' as DeviceKind, name: '电磁阀线圈', model: 'SY5120-5LZD', spec: '24V DC' },
      lamp: { prefix: 'HL', kind: 'lamp' as DeviceKind, name: '指示灯', model: 'XB2-BVB3LC', spec: '24V DC' },
      buzzer: { prefix: 'HA', kind: 'buzzer' as DeviceKind, name: '蜂鸣器', model: 'XB2-BSB3LC', spec: '24V DC' }
    }[item.device];
    const tag = nextTag(spec.prefix);
    add(tag, spec.kind, spec.name, item.model ?? spec.model, spec.spec, ['1', '2'], { field: true, purpose: item.purpose });
    join(signal, PIN(plc, item.address), PIN(tag, '1'));
    join('0V', PIN(tag, '2'));
    outputs.push({ address: item.address, kind: 'field', tags: [tag], ...base });
  }
  add(plc, 'plc', 'PLC', design.plc.model, design.plc.spec ?? `DI ${design.inputs.length} / DO ${design.outputs.length}`, plcPins, {
    ...(qPins.length > 0 ? { links: [{ from: '3L+', to: qPins }] } : {})
  });

  /* ================= 端子排 ================= */
  const fieldTags = new Set(devices.filter((device) => device.field).map((device) => device.tag));
  const pinNet = new Map<string, string>();
  for (const [net, pins] of netPins) for (const pin of pins) pinNet.set(pin, net);
  const terminalOf: Record<string, string> = {};
  let terminalNo = 0;
  const order = devices.filter((device) => device.field);
  for (const device of order) {
    for (const pin of device.pins) {
      const key = PIN(device.tag, pin);
      const net = pinNet.get(key);
      if (!net) continue;
      const others = (netPins.get(net) ?? []).filter((other) => other !== key);
      const hasCabinet = others.some((other) => !fieldTags.has(other.slice(0, other.lastIndexOf(':'))));
      // PE：柜内 PE 汇流排视为柜内侧，现场 PE 线一律经 PE 端子
      if (!hasCabinet && net !== 'PE') continue;
      terminalNo += 1;
      const tag = `${TERMINAL_STRIP}-${terminalNo}`;
      const pe = net === 'PE';
      add(tag, 'terminal', pe ? 'PE 端子' : '端子', pe ? 'UKT2.5-PE' : 'UK2.5B', `${TERMINAL_STRIP}:${terminalNo}`, ['i', 'o'], {
        displayTag: TERMINAL_STRIP,
        terminal: { strip: TERMINAL_STRIP, no: terminalNo, ...(pe ? { pe: true } : {}) }
      });
      join(net, PIN(tag, 'i'), PIN(tag, 'o'));
      terminalOf[key] = tag;
    }
  }

  const nets: CircuitNet[] = [...netPins.entries()]
    .filter(([, pins]) => pins.length > 0)
    .map(([id, pins]) => ({ id, ...(netLabel.has(id) ? { label: netLabel.get(id) as string } : {}), pins }));

  return {
    design,
    circuit: { devices, nets, supply: '3ph-380' },
    plan: {
      mainBreaker: mainTag,
      mainFeed,
      branches,
      fuse,
      chain,
      rungs,
      safety,
      inputs,
      outputs,
      plc,
      inputCommon,
      terminalOf
    },
    issues
  };
}
