// 联锁握手信号：把「本机 → 下游 / 下游 → 本机」那四个点位识别出来，供
// FC_AutoSequence 生成真逻辑（启动受 ALLOW 约束、END 到位才置 DONE、READY 就绪置位）。
//
// 为什么单独一个模块：同一套识别结果被两处消费——
//   1. `sequence.ts` 渲染 ST（启动门、STEP_HANDSHAKE、CASE 之后的握手输出）；
//   2. `simulate.ts` 执行同一套判据（否则仿真会「假通过」：ST 里被 ALLOW 拦住，
//      仿真却一路跑到 DONE，验证结果与生成程序不符）。
// 两个消费者读同一个模型，才不会各写一套规则。
//
// 识别口径（写死在这里，别在调用方各猜一套）：
//   - 输出 `DO-<站>-READY` / 角色含「就绪」 → DO-TRANSFER-READY
//   - 输出 `DO-<站>-DONE`  / 角色含「完成」 → DO-TRANSFER-DONE
//   - 输入 `DI-<站>-ALLOW` / 角色含「允许」 → DI-DOWNSTREAM-ALLOW
//   - 输入 `DI-<站>-END`   / 名称含「到位」且点位以 END 结尾 → DI-TRANSFER-END
//
// 识别到点位但变量表里没有它 → 记进 `unresolved`，调用方必须如实报出来，
// 不允许「识别到了但静默跳过」。

import type { Issue, PlcGenConfig } from './types.ts';
import { buildTagBindings } from './symbols.ts';

export type HandshakeRole = 'ready' | 'done' | 'allow' | 'end';

export interface HandshakeSignal {
  role: HandshakeRole;
  /** 原始点位号，如 DO-TRANSFER-DONE。 */
  point: string;
  /** DB_IO 里的变量名；未进入变量表时为空串。 */
  variable: string;
  /** PLC 绝对地址，如 Q0.0；未进入变量表时为空串。 */
  address: string;
  station: string;
  /** 变量表注释里的用途，便于对点。 */
  purpose: string;
}

export interface HandshakeModel {
  /** 是否有任何握手信号参与；false 时生成程序必须与改动前逐字节一致。 */
  present: boolean;
  /** 生成逻辑所用的工位（多工位握手未支持，见 warnings）。 */
  station?: string;
  ready: HandshakeSignal[];
  done: HandshakeSignal[];
  allow: HandshakeSignal[];
  end: HandshakeSignal[];
  /** 点位识别对了、变量表里却找不到的信号（不静默）。 */
  unresolved: HandshakeSignal[];
  warnings: Issue[];
  /** 参与逻辑的四个信号（点号），写进 mapping/README/测试断言。 */
  signals: string[];
}

interface Candidate {
  role: HandshakeRole;
  point: string;
  station: string;
}

const ROLE_OF_POINT: Array<{ role: HandshakeRole; pattern: RegExp }> = [
  { role: 'ready', pattern: /^DO-.*[-_]READY$/i },
  { role: 'done', pattern: /^DO-.*[-_]DONE$/i },
  { role: 'allow', pattern: /^DI-.*[-_]ALLOW$/i },
  { role: 'end', pattern: /^DI-.*[-_]END$/i }
];

/** 点位名之外的兜底：扩展点位的 role / name 里写中文用途也能认出来。 */
function roleFromText(role: string, name: string, area: 'input' | 'output'): HandshakeRole | null {
  const text = `${role} ${name}`;
  if (area === 'output' && /就绪|ready/i.test(text)) return 'ready';
  if (area === 'output' && /完成|done/i.test(text)) return 'done';
  if (area === 'input' && /允许|allow|许可/i.test(text)) return 'allow';
  if (area === 'input' && /(^|[^A-Za-z])END$|移载到位|接收到位/i.test(text)) return 'end';
  return null;
}

function roleOfPoint(point: string): HandshakeRole | null {
  for (const entry of ROLE_OF_POINT) {
    if (entry.pattern.test(point.trim())) return entry.role;
  }
  return null;
}

/**
 * 识别配置里的联锁握手信号。只读 config（ioPoints + sensors），不认识任何具体机型。
 */
export function detectHandshake(config: PlcGenConfig): HandshakeModel {
  const warnings: Issue[] = [];
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const push = (role: HandshakeRole | null, point: string, station: string): void => {
    if (!role) return;
    const trimmed = point.trim();
    if (!trimmed) return;
    const key = `${role}:${trimmed.toUpperCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ role, point: trimmed, station: station.trim() || '未指定' });
  };

  for (const [index, raw] of (config.ioPoints ?? []).entries()) {
    const extra = raw as { point?: string; name?: string; role?: string; station?: string; area?: 'input' | 'output' };
    const point = String(extra.point ?? '').trim();
    if (!point) continue;
    const area = extra.area ?? (point.toUpperCase().startsWith('DI') ? 'input' : point.toUpperCase().startsWith('DO') ? 'output' : 'output');
    const role = roleOfPoint(point) ?? roleFromText(String(extra.role ?? ''), String(extra.name ?? ''), area);
    // 输入型握手（ALLOW/END）常写在 sensors 里；ioPoints 里出现也照收。
    push(role, point, String(extra.station ?? `ioPoints[${index}]`));
  }
  for (const [index, raw] of (config.sensors ?? []).entries()) {
    const sensor = raw as { point?: string; part?: string; station?: string; role?: string };
    const point = String(sensor.point ?? '').trim();
    if (!point) continue;
    const role = roleOfPoint(point) ?? roleFromText(String(sensor.role ?? ''), String(sensor.part ?? ''), 'input');
    push(role, point, String(sensor.station ?? `sensors[${index}]`));
  }

  const bindings = buildTagBindings(config);
  const byPoint = new Map<string, { variable: string; address: string; purpose: string; station: string }>();
  for (const binding of bindings) {
    byPoint.set(binding.ref.point.trim().toUpperCase(), {
      variable: binding.row.name,
      address: binding.row.address,
      purpose: binding.row.comment,
      station: binding.row.station
    });
  }

  const unresolved: HandshakeSignal[] = [];
  const signals: HandshakeSignal[] = [];
  for (const candidate of candidates) {
    const hit = byPoint.get(candidate.point.toUpperCase());
    if (!hit) {
      unresolved.push({ ...candidate, variable: '', address: '', purpose: '' });
      warnings.push({
        code: 'HANDSHAKE_POINT_UNRESOLVED',
        message: `联锁信号 ${candidate.point} 没有进入 IO 变量表，握手逻辑不会生成它（补齐点位后重新生成）`
      });
      continue;
    }
    signals.push({ ...candidate, variable: hit.variable, address: hit.address, purpose: hit.purpose });
  }

  const stations = [...new Set(signals.map((signal) => signal.station))];
  const station = stations[0];
  if (stations.length > 1) {
    warnings.push({
      code: 'HANDSHAKE_MULTI_STATION',
      message: `联锁信号分布在多个工位（${stations.join('、')}），当前只为 ${station} 生成握手逻辑，其余信号仅进入变量表`
    });
  }
  const scoped = station ? signals.filter((signal) => signal.station === station) : [];

  const pick = (role: HandshakeRole): HandshakeSignal[] => scoped.filter((signal) => signal.role === role);
  const model: HandshakeModel = {
    present: scoped.length > 0,
    ready: pick('ready'),
    done: pick('done'),
    allow: pick('allow'),
    end: pick('end'),
    unresolved,
    warnings,
    signals: scoped.map((signal) => signal.point)
  };
  if (station) model.station = station;

  if (model.present) {
    const missing: string[] = [];
    if (model.ready.length === 0) missing.push('DO-*-READY（就绪输出）');
    if (model.done.length === 0) missing.push('DO-*-DONE（完成输出）');
    if (model.allow.length === 0) missing.push('DI-*-ALLOW（下游允许，启动互锁）');
    if (model.end.length === 0) missing.push('DI-*-END（到位，置 DONE 的判据）');
    if (missing.length > 0) {
      warnings.push({
        code: 'HANDSHAKE_PARTIAL',
        message: `工位 ${station} 的联锁信号不全，缺：${missing.join('、')}；缺的那一环不会生成逻辑`
      });
    }
  }

  return model;
}
