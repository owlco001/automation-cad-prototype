import type { MachineIoMapRow } from '../machine/io-map.ts';
import { normalizePointKey } from '../plcgen/io.ts';
import type { PlcPoint } from '../plc/types.ts';
import type { Step } from './sequence.ts';

export interface CommissionCompatibilityIssue {
  code:
    | 'MACHINE_POINT_MISSING'
    | 'MACHINE_POINT_DUPLICATE'
    | 'MACHINE_ADDRESS_DUPLICATE'
    | 'PLC_POINT_MISSING'
    | 'PLC_POINT_DUPLICATE'
    | 'PLC_ADDRESS_DUPLICATE'
    | 'POINT_TYPE_MISMATCH'
    | 'POINT_DIRECTION_MISMATCH'
    | 'POINT_SEMANTIC_MISMATCH';
  point?: string;
  message: string;
  action: string;
}

export interface CommissionCompatibility {
  compatible: boolean;
  issues: CommissionCompatibilityIssue[];
}

const STANDARD_ROLE_TERMS: Readonly<Record<string, readonly string[]>> = {
  X0: ['主回路'],
  Y0: ['主回路'],
  X1: ['24V'],
  Y1: ['24V'],
  X2: ['PLC', 'RUN'],
  Y2: ['PLC', 'RUN'],
  X3: ['气源'],
  Y3: ['气源'],
  X4: ['原点'],
  Y4: ['原点'],
  X5: ['就绪'],
  Y5: ['就绪'],
  X6: ['滑台', '前进'],
  Y6: ['滑台', '前进'],
  X7: ['滑台', '后退'],
  Y7: ['滑台', '后退'],
  X8: ['安全门'],
  Y8: ['急停'],
  X9: ['急停'],
  X10: ['急停', '复位'],
  X11: ['气源', '低压'],
  X12: ['伺服', '就绪'],
  X13: ['伺服', '报警'],
  X14: ['报警', '锁存']
};

function pointKey(value: string): string {
  return value.trim().toUpperCase();
}

function semanticText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function issue(
  code: CommissionCompatibilityIssue['code'],
  point: string | undefined,
  message: string,
  action: string
): CommissionCompatibilityIssue {
  return { code, ...(point ? { point } : {}), message, action };
}

/**
 * 固定标准用例仅在点位 ID、PLC 元数据和机型 IO 的方向、数字量类型及功能语义
 * 全部一致时才可运行。机型映射中的 `type` 是执行机构/信号用途，不是 PLC 数据类型；
 * 机型 IO 映射当前只描述 BOOL 数字量，因此对应 PLC 点必须为 BOOL。
 */
export function validateCommissionSteps(
  steps: readonly Step[],
  machineRows: readonly MachineIoMapRow[],
  plcPoints: readonly PlcPoint[]
): CommissionCompatibility {
  const issues: CommissionCompatibilityIssue[] = [];
  const seenIssueKeys = new Set<string>();
  const addIssue = (entry: CommissionCompatibilityIssue): void => {
    const key = `${entry.code}:${entry.point ?? ''}:${entry.message}`;
    if (seenIssueKeys.has(key)) return;
    seenIssueKeys.add(key);
    issues.push(entry);
  };

  const usedPointIds = [...new Set(steps.flatMap((step) => step.point ? [step.point] : []))];
  const mapById = new Map<string, MachineIoMapRow[]>();
  const mapByPhysicalAddress = new Map<string, MachineIoMapRow[]>();
  for (const row of machineRows) {
    const key = pointKey(row.point);
    const rows = mapById.get(key) ?? [];
    rows.push(row);
    mapById.set(key, rows);
    const physicalKey = normalizePointKey(row.point);
    const physicalRows = mapByPhysicalAddress.get(physicalKey) ?? [];
    physicalRows.push(row);
    mapByPhysicalAddress.set(physicalKey, physicalRows);
  }
  const plcById = new Map<string, PlcPoint[]>();
  const plcByPhysicalAddress = new Map<string, PlcPoint[]>();
  for (const point of plcPoints) {
    const key = pointKey(point.id);
    const entries = plcById.get(key) ?? [];
    entries.push(point);
    plcById.set(key, entries);
    const physicalKey = normalizePointKey(point.id);
    const physicalEntries = plcByPhysicalAddress.get(physicalKey) ?? [];
    physicalEntries.push(point);
    plcByPhysicalAddress.set(physicalKey, physicalEntries);
  }

  const usedRows: Array<{ id: string; row: MachineIoMapRow }> = [];
  const usedPlcPoints: Array<{ id: string; point: PlcPoint }> = [];
  for (const id of usedPointIds) {
    const key = pointKey(id);
    const mapRows = mapById.get(key) ?? [];
    const physicalRows = mapByPhysicalAddress.get(normalizePointKey(id)) ?? [];
    if (physicalRows.length > 1) {
      addIssue(issue(
        'MACHINE_POINT_DUPLICATE', id,
        `机型 IO 映射中的点位「${id}」与地址别名重复 ${physicalRows.length} 次`,
        '为每个物理信号分配唯一点位 ID，不能同时使用 X/Y 点名和 I/Q 字节位别名。'
      ));
    } else if (mapRows.length === 0) {
      addIssue(issue(
        'MACHINE_POINT_MISSING', id,
        `机型 IO 映射缺少用例需要的点位「${id}」`,
        `在当前机型配置中为该功能分配点位「${id}」，或为该机型建立专属联调用例。`
      ));
    } else if (mapRows.length > 1) {
      addIssue(issue(
        'MACHINE_POINT_DUPLICATE', id,
        `机型 IO 映射中的点位「${id}」重名 ${mapRows.length} 次`,
        '为每个物理信号分配唯一点位 ID，并删除重复映射后再运行。'
      ));
    } else {
      const row = mapRows[0];
      if (row) usedRows.push({ id, row });
    }

    const matches = plcById.get(key) ?? [];
    const physicalMatches = plcByPhysicalAddress.get(normalizePointKey(id)) ?? [];
    if (physicalMatches.length > 1) {
      addIssue(issue(
        'PLC_POINT_DUPLICATE', id,
        `PLC 点位「${id}」与同一物理地址的别名重复 ${physicalMatches.length} 次`,
        '删除重复别名；同一物理 IO 只能保留一个点位 ID。'
      ));
    } else if (matches.length === 0) {
      addIssue(issue(
        'PLC_POINT_MISSING', id,
        `PLC 点位表缺少用例需要的点位「${id}」`,
        `在 PLC 点位表中添加「${id}」，并确认它映射到当前机型的同一信号。`
      ));
    } else if (matches.length > 1) {
      addIssue(issue(
        'PLC_POINT_DUPLICATE', id,
        `PLC 点位表中的点位 ID「${id}」重复`,
        '删除重复点位，确保每个 IO 信号只有一个唯一 ID。'
      ));
    } else {
      const point = matches[0];
      if (point) usedPlcPoints.push({ id, point });
    }
  }

  const mapAddresses = new Map<string, string[]>();
  for (const { id, row } of usedRows) {
    const addressKey = `${row.direction}:${row.address.trim().toUpperCase()}`;
    const ids = mapAddresses.get(addressKey) ?? [];
    ids.push(id);
    mapAddresses.set(addressKey, ids);
  }
  for (const ids of mapAddresses.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) {
      addIssue(issue(
        'MACHINE_ADDRESS_DUPLICATE', id,
        `机型 IO 点位 ${ids.join('、')} 指向同一地址`,
        '为每个不同的物理 IO 分配独立地址；若确为同一信号，请只保留一个点位并调整用例引用。'
      ));
    }
  }

  const plcAddresses = new Map<string, string[]>();
  for (const { id, point } of usedPlcPoints) {
    const addressKey = `${point.area}:${point.address}`;
    const ids = plcAddresses.get(addressKey) ?? [];
    ids.push(id);
    plcAddresses.set(addressKey, ids);
  }
  for (const ids of plcAddresses.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) {
      addIssue(issue(
        'PLC_ADDRESS_DUPLICATE', id,
        `PLC 点位 ${ids.join('、')} 共用同一 ${usedPlcPoints.find((entry) => entry.id === id)?.point.area ?? ''} 地址`,
        '检查 Modbus 地址分配；为不同信号配置正确且不冲突的 PLC 地址。'
      ));
    }
  }

  for (const { id, row } of usedRows) {
    const point = (plcById.get(pointKey(id)) ?? [])[0];
    if (!point) continue;
    if (point.dataType !== 'bool') {
      addIssue(issue(
        'POINT_TYPE_MISMATCH', id,
        `机型点位「${id}」是数字量，但 PLC 点位类型为 ${point.dataType}`,
        '将该点位的数据类型改为 BOOL；若它实际是模拟量，请先为该机型定义对应的模拟量联调用例。'
      ));
    }

    const expectedArea = row.direction === '输入' ? 'discrete' : 'coil';
    const expectedWritable = row.direction === '输出';
    if (point.area !== expectedArea || Boolean(point.writable) !== expectedWritable) {
      const expectedDirection = row.direction === '输入' ? '只读离散输入' : '可写线圈输出';
      addIssue(issue(
        'POINT_DIRECTION_MISMATCH', id,
        `机型映射将「${id}」定义为${row.direction}，但 PLC 点位配置为 ${point.area}${point.writable ? '（可写）' : ''}`,
        `将「${id}」配置为${expectedDirection}，并核对它与机型 IO 表中的物理接线一致。`
      ));
    }

    const requiredTerms = STANDARD_ROLE_TERMS[pointKey(id)];
    if (requiredTerms) {
      const actual = semanticText(`${row.comment} ${row.owner} ${row.type}`);
      const missingTerms = requiredTerms.filter((term) => !actual.includes(semanticText(term)));
      if (missingTerms.length > 0) {
        addIssue(issue(
          'POINT_SEMANTIC_MISMATCH', id,
          `点位「${id}」在机型 IO 映射中的用途与标准用例不符（缺少：${missingTerms.join('、')}）`,
          `核对机型映射中「${id}」的归属与说明；需明确标注“${requiredTerms.join('、')}”对应的实际信号，不能只复用相同 ID。`
        ));
      }
    }
  }

  return { compatible: issues.length === 0, issues };
}

export function describeCommissionCompatibility(result: CommissionCompatibility): string {
  if (result.compatible) return '';
  const details = result.issues.map((entry) => entry.message).join('；');
  const action = result.issues[0]?.action;
  return `当前 IO 映射不兼容，已禁用该联调流程：${details}${action ? `。建议：${action}` : ''}`;
}
