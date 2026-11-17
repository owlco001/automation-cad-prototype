/** Validate PLC export input before creating directories or archives. */
import { normalizeZipPath, type ZipEntry } from '../shared/zip.ts';

export function plcExportFiles(value: unknown): ZipEntry[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('PLC 导出缺少文件');
  if (value.length > 200) throw new Error('PLC 导出文件过多');
  let total = 0;
  const entries = value.map((item, index): ZipEntry => {
    if (typeof item !== 'object' || item === null) throw new Error(`PLC 导出文件 ${index + 1} 格式不合法`);
    const source = item as Record<string, unknown>;
    const path = normalizeZipPath(source.path);
    if (typeof source.content !== 'string') throw new Error(`PLC 导出文件 ${path} 缺少正文`);
    total += Buffer.byteLength(source.content, 'utf8');
    return { path, content: source.content };
  });
  if (total > 20 * 1024 * 1024) throw new Error('PLC 导出正文超过 20MB');
  return entries;
}

