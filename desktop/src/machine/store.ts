// 机型方案落盘与校验：负责 MachineDesign 的结构校验、id 净化、BOM 行转换，
// 以及 userData/machine 下的最小文件读写。命令总线负责编排 3D/BOM/PLC 联动。

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { recordDiagnosticError } from '../shared/diagnostics.ts';
import { dirname, join } from 'node:path';
import type { MachineBomItem } from './synth.ts';
import { validateMachineDesign, type NormalizedMachineDesign, type StoredMachineDesign } from './design-validation.ts';
export { validateMachineDesign, machineConfigPoints } from './design-validation.ts';
export type { NormalizedMachineDesign, StoredMachineDesign } from './design-validation.ts';

export interface MachineBomRow {
  name: string;
  model: string;
  qty: number;
  category: string;
  note?: string;
  source: 'machine-design';
  partId?: string;
  packId?: string;
  pendingSelection?: boolean;
}

export interface ActiveMachinePointer {
  schemaVersion: 1;
  machineId: string;
  name: string;
  file: string;
  appliedAt: string;
}

const BOM_KIND_LABEL: Record<MachineBomItem['kind'], string> = {
  actuator: '执行机构',
  sensor: '传感器',
  electrical: '电气'
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 文件名净化：保留中英文/数字/._-，去掉路径分隔、控制字符与连续点。 */
export function sanitizeMachineId(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  let id = raw
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/[^\p{L}\p{N}._-]/gu, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 64);
  if (!id) id = 'machine';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) id = `machine-${id}`;
  return id;
}

export function machineDirectory(userDataRoot: string): string {
  return join(userDataRoot, 'machine');
}

export function machineDesignPath(userDataRoot: string, machineId: string): string {
  return join(machineDirectory(userDataRoot), `${sanitizeMachineId(machineId)}.json`);
}

export function machineBomDraftPath(userDataRoot: string, machineId: string): string {
  return join(machineDirectory(userDataRoot), sanitizeMachineId(machineId), 'bom-draft.csv');
}

/** 参数化几何产物目录：machine/<id>/（与 bom-draft.csv 同目录）。 */
export function machineGeometryPaths(userDataRoot: string, machineId: string): {
  json: string;
  stl: string;
  gltf: string;
  sidecar: string;
  solidsDir: string;
} {
  const dir = join(machineDirectory(userDataRoot), sanitizeMachineId(machineId));
  return {
    json: join(dir, 'geometry.json'),
    stl: join(dir, 'model.stl'),
    gltf: join(dir, 'model.gltf'),
    sidecar: join(dir, 'sidecar-assembly.json'),
    solidsDir: join(dir, 'solids')
  };
}

/** 读取任意文件为 base64（用于撤销快照，兼容二进制 STL/STEP）；不存在返回 null。 */
export function readBase64IfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path).toString('base64') : null;
  } catch (error) {
    recordDiagnosticError('MACHINE_BINARY_READ_FAILED', error, { site: 'desktop/src/machine/store.ts', file: path.split(/[\\/]/).pop() ?? '' });
    return null;
  }
}

export function writeBytes(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

export function restoreBase64(path: string, previous: string | null): void {
  if (previous === null) {
    rmSync(path, { force: true });
    return;
  }
  writeBytes(path, Buffer.from(previous, 'base64'));
}

export function activeMachinePath(userDataRoot: string): string {
  return join(machineDirectory(userDataRoot), 'active.json');
}

export function readTextIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch (error) {
    recordDiagnosticError('MACHINE_TEXT_READ_FAILED', error, { site: 'desktop/src/machine/store.ts', file: path.split(/[\\/]/).pop() ?? '' });
    return null;
  }
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

export function restoreText(path: string, previous: string | null): void {
  if (previous === null) {
    rmSync(path, { force: true });
    return;
  }
  writeText(path, previous);
}

export function readActivePointer(userDataRoot: string): ActiveMachinePointer | null {
  const text = readTextIfExists(activeMachinePath(userDataRoot));
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) return null;
    const machineId = typeof parsed.machineId === 'string' ? sanitizeMachineId(parsed.machineId) : '';
    if (!machineId) return null;
    const name = typeof parsed.name === 'string' ? parsed.name : machineId;
    const appliedAt = typeof parsed.appliedAt === 'string' ? parsed.appliedAt : '';
    return {
      schemaVersion: 1,
      machineId,
      name,
      file: `machine/${machineId}.json`,
      appliedAt
    };
  } catch (error) {
    recordDiagnosticError('MACHINE_ACTIVE_POINTER_PARSE_FAILED', error, { site: 'desktop/src/machine/store.ts' });
    return null;
  }
}

export function writeActivePointer(userDataRoot: string, pointer: ActiveMachinePointer): void {
  writeText(activeMachinePath(userDataRoot), `${JSON.stringify(pointer, null, 2)}\n`);
}

export function readStoredMachineDesign(userDataRoot: string, machineId: string): StoredMachineDesign | null {
  const text = readTextIfExists(machineDesignPath(userDataRoot, machineId));
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) return null;
    const design = validateMachineDesign(parsed);
    return {
      ...design,
      schemaVersion: 1,
      kind: 'machine-design',
      id: sanitizeMachineId(typeof parsed.id === 'string' ? parsed.id : machineId),
      name: design.config.name,
      appliedAt: typeof parsed.appliedAt === 'string' ? parsed.appliedAt : ''
    };
  } catch (error) {
    recordDiagnosticError('MACHINE_DESIGN_PARSE_FAILED', error, { site: 'desktop/src/machine/store.ts', machineId });
    return null;
  }
}

/**
 * 把已校验的机型方案写成 `machine/<id>.json` 并把 active 指针指过去，返回落盘文档。
 * 与 apply_machine_design 的落盘口径一致（同一份 JSON 缩进、同一个 active 指针形状），
 * 供机型库加载等「方案已经校验完、只剩写盘」的场景复用。
 */
export function writeStoredMachineDesign(
  userDataRoot: string,
  design: NormalizedMachineDesign,
  appliedAt: string = new Date().toISOString()
): StoredMachineDesign {
  const machineId = sanitizeMachineId(design.config.id);
  const stored: StoredMachineDesign = {
    ...design,
    config: { ...design.config, id: machineId },
    schemaVersion: 1,
    kind: 'machine-design',
    id: machineId,
    name: design.config.name,
    appliedAt
  };
  writeText(machineDesignPath(userDataRoot, machineId), `${JSON.stringify(stored, null, 2)}\n`);
  writeActivePointer(userDataRoot, {
    schemaVersion: 1,
    machineId,
    name: stored.name,
    file: `machine/${machineId}.json`,
    appliedAt
  });
  return stored;
}

export function readActiveMachineDesign(userDataRoot: string): StoredMachineDesign | null {
  const pointer = readActivePointer(userDataRoot);
  if (!pointer) return null;
  return readStoredMachineDesign(userDataRoot, pointer.machineId);
}


/** 用于幂等判断的稳定内容（不含 appliedAt，避免重复执行被误判为变更）。 */
export function machineDesignContent(design: NormalizedMachineDesign): string {
  return JSON.stringify({
    config: design.config,
    points: design.points,
    cycle: design.cycle ?? null,
    power: design.power ?? null,
    cost: design.cost ?? null,
    bomDraft: design.bomDraft ?? null,
    warnings: design.warnings,
    assumptions: design.assumptions,
    form: design.form ?? null,
    stationGeometryLayout: design.stationGeometryLayout ?? null
  });
}

export function buildMachineBomRows(design: NormalizedMachineDesign): MachineBomRow[] {
  const items = design.bomDraft?.items ?? [];
  return items.map((item): MachineBomRow => {
    const row: MachineBomRow = {
      name: item.name,
      model: item.model?.trim() || '模型待定',
      qty: item.qty,
      category: BOM_KIND_LABEL[item.kind],
      source: 'machine-design'
    };
    if (item.note) row.note = item.note;
    if (item.partId) row.partId = item.partId;
    if (item.packId) row.packId = item.packId;
    if (item.pendingSelection === true) row.pendingSelection = true;
    return row;
  });
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const MACHINE_BOM_CSV_HEADER = ['序号', '名称', '型号', '数量', '分类', '来源包', '来源', '待选型', '备注'] as const;

export function renderMachineBomCsv(rows: readonly MachineBomRow[]): string {
  const lines = [
    [...MACHINE_BOM_CSV_HEADER].map(csvCell).join(','),
    ...rows.map((row, index) => [
      index + 1,
      row.name,
      row.model,
      row.qty,
      row.category,
      row.packId ?? '',
      row.source,
      row.pendingSelection ? '是' : '否',
      row.note ?? ''
    ].map(csvCell).join(','))
  ];
  return `\uFEFF${lines.join('\r\n')}`;
}

const BOM_KIND_BY_LABEL: Record<string, MachineBomItem['kind']> = {
  [BOM_KIND_LABEL.actuator]: 'actuator',
  [BOM_KIND_LABEL.sensor]: 'sensor',
  [BOM_KIND_LABEL.electrical]: 'electrical'
};

/** CSV 单元格解析：只处理 renderMachineBomCsv 会产出的引号转义（"" → "）。 */
function parseCsvCells(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      cells.push(cell);
      cell = '';
      continue;
    }
    cell += char;
  }
  cells.push(cell);
  return cells;
}

/**
 * `bom.csv` → `bomDraft.items` 的反向解析（机型库加载用，B4）。
 *
 * 列头以 `MACHINE_BOM_CSV_HEADER` 为准，按列名取数而不是按位置，列顺序将来变了也不会错位。
 * 已知损失：该 CSV 没有物料号/role/额定功率列，往返后 `partId` 无法复原（`run_cost_report`
 * 会按缺物料号处理，不会伪造型号）；`型号` 列是 `模型待定` 时按缺省处理。
 * 行结构不合法一律抛错，让调用方（`loadFromLibrary`）转成 `LIBRARY_INVALID_CONFIG`，
 * 不静默跳过行——少一行 BOM 比报错更难查。
 */
export function parseMachineBomCsv(text: string): MachineBomItem[] {
  const rows = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const headerLine = rows[0] ?? '';
  const header = parseCsvCells(headerLine).map((cell) => cell.trim());
  const columnIndex = (name: string): number => header.indexOf(name);
  for (const required of ['名称', '型号', '数量', '分类']) {
    if (columnIndex(required) < 0) throw new Error(`bom.csv 缺少必需列「${required}」`);
  }
  const cellOf = (cells: string[], name: string): string => {
    const index = columnIndex(name);
    return index >= 0 && index < cells.length ? (cells[index] ?? '').trim() : '';
  };
  const items: MachineBomItem[] = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const line = rows[rowIndex];
    if (!line || !line.trim()) continue;
    const where = `bom.csv 第 ${rowIndex + 1} 行`;
    const cells = parseCsvCells(line);
    if (cells.length !== header.length) {
      throw new Error(`${where}列数不符（${cells.length} ≠ 表头 ${header.length}）`);
    }
    const name = cellOf(cells, '名称');
    if (!name) throw new Error(`${where}缺少名称`);
    const qty = Number(cellOf(cells, '数量'));
    if (!Number.isInteger(qty) || qty < 1) throw new Error(`${where}数量必须是正整数`);
    const label = cellOf(cells, '分类');
    const kind = BOM_KIND_BY_LABEL[label];
    if (!kind) throw new Error(`${where}分类「${label}」不在执行机构/传感器/电气之内`);
    const item: MachineBomItem = { kind, name, qty };
    const model = cellOf(cells, '型号');
    if (model && model !== '模型待定') item.model = model;
    const packId = cellOf(cells, '来源包');
    if (packId) item.packId = packId;
    if (cellOf(cells, '待选型') === '是') item.pendingSelection = true;
    const note = cellOf(cells, '备注');
    if (note) item.note = note;
    items.push(item);
  }
  return items;
}
