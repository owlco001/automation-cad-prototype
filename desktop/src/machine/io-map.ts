// 机型 → PLC IO 映射表：复用 plcgen 的点位收集与地址分配，只输出 CSV，
// 不生成 ST / 序列 / 报警程序，避免与完整的 PLC 代码生成逻辑分叉。

import type { MachineConfig } from '../commission/machine-config.ts';
import { collectIoRefs } from '../plcgen/io.ts';
import { buildTags } from '../plcgen/tags.ts';
import type { PlcGenConfig } from '../plcgen/types.ts';

export interface MachineIoMapRow {
  point: string;
  address: string;
  direction: '输入' | '输出';
  ownerType: '执行机构' | '传感器' | '安全' | '扩展';
  owner: string;
  type: string;
  station: string;
  comment: string;
}

const ACTUATOR_TYPE: Record<string, string> = {
  cylinder: '气缸',
  gripper: '夹爪',
  rotary: '旋转轴'
};

const ACTUATOR_FIELD_TYPE: Record<string, string> = {
  extendPoint: '伸出',
  retractPoint: '缩回',
  gripPoint: '夹紧',
  point: '旋转'
};

/**
 * `point` 字段在不同 kind 下语义不同：旋转轴是「分度」，气缸/夹爪借它表达**直线动作点**
 *（顶升、移载这类没有 extend/retract 之分的单点轴）。按 kind 覆盖，否则 io-map 里
 * 「移载台」会被标成「气缸·旋转」——看着像台会转的机构。
 */
const LINEAR_POINT_TYPE = '直线动作';

function sensorType(point: string): string {
  if (/SAFE|SAFETY|光栅|door|estop/i.test(point)) return '安全光栅';
  if (/PHT|PHOTO|光电/i.test(point)) return '光电传感器';
  if (/PRS|PRESS|压力/i.test(point)) return '压力传感器';
  if (/PRX|PROX|接近/i.test(point)) return '接近开关';
  return '传感器';
}

function ownerFromPath(config: PlcGenConfig, path: string): {
  ownerType: MachineIoMapRow['ownerType'];
  owner: string;
  type: string;
} {
  const sensorMatch = /^sensors\[(\d+)\]\.point$/.exec(path);
  if (sensorMatch) {
    const sensor = config.sensors?.[Number(sensorMatch[1])];
    if (sensor) {
      return { ownerType: '传感器', owner: sensor.part, type: sensorType(sensor.point) };
    }
  }
  const actuatorMatch = /^actuators\[(\d+)\]\.(\w+)$/.exec(path);
  if (actuatorMatch) {
    const actuator = config.actuators?.[Number(actuatorMatch[1])];
    if (actuator) {
      const base = ACTUATOR_TYPE[actuator.kind] ?? actuator.kind;
      const field = actuatorMatch[2] ?? '';
      const action = field === 'point' && actuator.kind !== 'rotary'
        ? LINEAR_POINT_TYPE
        : ACTUATOR_FIELD_TYPE[field] ?? '';
      return {
        ownerType: '执行机构',
        owner: actuator.name,
        type: action ? `${base}·${action}` : base
      };
    }
  }
  if (path.startsWith('safety.')) {
    return { ownerType: '安全', owner: '安全回路', type: path.includes('estop') ? '急停' : '安全门/光栅' };
  }
  // 注意前缀是 `ioPoints[0].point`（带方括号），历史上写的是 `ioPoints.` 所以从来没命中过，
  // 扩展点位一律落到最后的兜底「通用/点位」上。
  if (path.startsWith('ioPoints[') || path.startsWith('safetyPoints[')
    || path.startsWith('ioPoints.') || path.startsWith('safetyPoints.')) {
    // 扩展点位带上自己的语义（「移载就绪」「移载完成」），别都落成「扩展点位」
    const index = Number(/^ioPoints\[(\d+)\]/.exec(path)?.[1] ?? -1);
    const entry = index >= 0 ? config.ioPoints?.[index] : undefined;
    return {
      ownerType: '扩展',
      owner: entry?.station ?? '扩展点位',
      type: entry?.role ?? entry?.name ?? '扩展'
    };
  }
  return { ownerType: '扩展', owner: '通用', type: '点位' };
}

/** 生成与完整 PLC 包一致的点位顺序与地址；覆盖配置中的全部唯一 IO 点。 */
export function buildMachineIoMap(config: MachineConfig): { rows: MachineIoMapRow[]; csv: string } {
  const plcConfig = config as PlcGenConfig;
  const refs = collectIoRefs(plcConfig);
  const tags = buildTags(plcConfig);
  const rows = refs.map((ref, index): MachineIoMapRow => {
    const owner = ownerFromPath(plcConfig, ref.path);
    return {
      point: ref.point,
      address: tags.rows[index]?.address ?? '',
      direction: ref.area === 'input' ? '输入' : '输出',
      ownerType: owner.ownerType,
      owner: ref.actuatorName ?? owner.owner,
      type: owner.type,
      station: ref.station,
      comment: ref.comment
    };
  });
  return { rows, csv: renderIoMapCsv(rows) };
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function renderIoMapCsv(rows: readonly MachineIoMapRow[]): string {
  const lines = [
    ['点位', '地址', '方向', '归属类型', '归属', '类型', '工位', '说明'].map(csvCell).join(','),
    ...rows.map((row) => [
      row.point,
      row.address,
      row.direction,
      row.ownerType,
      row.owner,
      row.type,
      row.station,
      row.comment
    ].map(csvCell).join(','))
  ];
  return `\uFEFF${lines.join('\r\n')}`;
}
