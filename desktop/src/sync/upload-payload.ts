/** Validate renderer upload data before any synchronization side effects. */
import type { DesignBomRow, SyncPlcUploadPayload, SyncUploadPayload } from './types.ts';

function syncBytes(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error(`${label}必须是字节数组`);
}

function syncText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串`);
  return value;
}

function syncBom(value: unknown): DesignBomRow[] {
  if (!Array.isArray(value)) throw new Error('BOM 必须是数组');
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`第 ${index + 1} 条 BOM 不是对象`);
    const row = entry as Record<string, unknown>;
    const no = typeof row.no === 'number' ? row.no : index + 1;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const spec = typeof row.spec === 'string' ? row.spec.trim() : '';
    const mat = typeof row.mat === 'string' ? row.mat.trim() : '';
    const qty = typeof row.qty === 'number' && Number.isFinite(row.qty) ? row.qty : 1;
    if (!name) throw new Error(`第 ${index + 1} 条 BOM 缺少名称`);
    const result: DesignBomRow = { no, name, spec, qty, mat };
    if (typeof row.remark === 'string' && row.remark.trim()) result.remark = row.remark.trim();
    return result;
  });
}

function parseSyncPlcPayload(value: unknown): SyncPlcUploadPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('PLC 同步数据必须是对象');
  const source = value as Record<string, unknown>;
  if (typeof source.target !== 'string') throw new Error('PLC target 必须是字符串');
  if (typeof source.generatedVersion !== 'string') throw new Error('PLC generatedVersion 必须是字符串');
  if (typeof source.machineId !== 'string') throw new Error('PLC machineId 必须是字符串');
  if (!Array.isArray(source.programFiles)) throw new Error('PLC programFiles 必须是数组');
  const programFiles = source.programFiles.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`PLC programFiles[${index}] 必须是对象`);
    const file = entry as Record<string, unknown>;
    if (typeof file.path !== 'string' || typeof file.content !== 'string') throw new Error(`PLC programFiles[${index}] 缺少 path/content`);
    return { path: file.path, content: file.content };
  });
  if (typeof source.mappingCsv !== 'string') throw new Error('PLC mappingCsv 必须是字符串');
  return {
    target: source.target as SyncPlcUploadPayload['target'],
    generatedVersion: source.generatedVersion,
    machineId: source.machineId,
    programFiles,
    mappingCsv: source.mappingCsv
  };
}

export function parseSyncPayload(value: unknown): SyncUploadPayload {
  if (typeof value !== 'object' || value === null) throw new Error('同步数据必须是对象');
  const source = value as Record<string, unknown>;
  return {
    projectName: syncText(source.projectName, 'projectName'),
    bomCsv: typeof source.bomCsv === 'string' ? source.bomCsv : syncBytes(source.bomCsv, 'bom.csv'),
    reportHtml: syncText(source.reportHtml, '报告 HTML'),
    glb: syncBytes(source.glb, 'model.glb'),
    dxf: typeof source.dxf === 'string' ? source.dxf : syncBytes(source.dxf, 'drawing.dxf'),
    bom: syncBom(source.bom),
    ...(source.plc === undefined ? {} : { plc: parseSyncPlcPayload(source.plc) })
  };
}

