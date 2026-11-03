/**
 * 最小 ZIP 写入封装：统一走项目已有的 `adm-zip`，并在这里集中做路径校验。
 * 生成器只提供「相对路径 + 文本/字节」，不接受绝对路径或 `..`。
 */
import AdmZip from 'adm-zip';

export interface ZipEntry {
  path: string;
  content: string | Uint8Array;
}

const MAX_ENTRIES = 500;

/** 归一化并校验 ZIP 内路径；返回 `a/b.st` 形式。 */
export function normalizeZipPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('缺少必填参数：ZIP 条目路径');
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`ZIP 条目路径必须是相对路径：${value}`);
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`ZIP 条目路径含控制字符：${value}`);
  }
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`ZIP 条目路径不合法：${value}`);
  }
  return normalized;
}

/** 构造 ZIP（store 条目由 adm-zip 写入 CRC 与中央目录）。 */
export function createZip(entries: readonly ZipEntry[]): Buffer {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('ZIP 不能为空');
  if (entries.length > MAX_ENTRIES) throw new Error(`ZIP 条目过多：${entries.length} > ${MAX_ENTRIES}`);

  const used = new Set<string>();
  const zip = new AdmZip();
  for (const entry of entries) {
    const path = normalizeZipPath(entry.path);
    if (used.has(path)) throw new Error(`ZIP 条目路径重复：${path}`);
    used.add(path);
    const data = typeof entry.content === 'string'
      ? Buffer.from(entry.content, 'utf8')
      : Buffer.from(entry.content);
    zip.addFile(path, data);
  }
  // 固定条目时间戳：ZIP 头里的 DOS 时间是「打包那一刻」，同一份内容隔几秒再打包 sha256 就变了，
  // 机型库/导出物要靠包哈希做去重与完整性核对，不能有这种抖动。
  // 2020-01-01 是任意固定值（DOS 时间域 1980..2107），只要恒定即可。
  const fixed = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));
  for (const entry of zip.getEntries()) entry.header.time = fixed;
  return zip.toBuffer();
}

/** 读取 ZIP 条目名与 CRC，供自检/测试使用。 */
export function listZipEntries(value: Buffer | Uint8Array): Array<{ path: string; size: number; crc: number }> {
  const zip = new AdmZip(Buffer.from(value));
  return zip.getEntries().map((entry) => ({
    path: entry.entryName,
    size: entry.header.size,
    crc: entry.header.crc
  }));
}
