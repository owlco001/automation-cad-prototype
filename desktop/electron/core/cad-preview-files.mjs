import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { CAD_PREVIEW_EXTENSIONS, CAD_PREVIEW_MAX_BYTES } from './cad-preview-format.mjs';

const READ_CHUNK_BYTES = 256 * 1024;

function sameFile(left, right) {
  if (left.dev !== right.dev) return false;
  if (left.ino !== 0 && right.ino !== 0) return left.ino === right.ino;
  return left.size === right.size && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs && left.birthtimeMs === right.birthtimeMs;
}

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

export function validateCadPreviewExtension(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) fail('CAD_PREVIEW_INVALID_PATH', 'CAD 文件路径无效。');
  const extension = extname(filePath).toLowerCase();
  if (!CAD_PREVIEW_EXTENSIONS.includes(extension)) fail('CAD_PREVIEW_UNSUPPORTED_EXTENSION', '仅支持 STL 与 GLB 格式。');
  return extension;
}

export async function readCadPreviewFile(filePath) {
  const extension = validateCadPreviewExtension(filePath);
  let handle;
  try {
    const pathInfo = await lstat(filePath);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) fail('CAD_PREVIEW_NOT_REGULAR_FILE', '所选路径不是普通文件。');
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile()) fail('CAD_PREVIEW_NOT_REGULAR_FILE', '所选路径不是普通文件。');
    if (!sameFile(pathInfo, before)) fail('CAD_PREVIEW_FILE_CHANGED', '选择路径在打开期间发生变化，请重新选择后再试。');
    if (before.size <= 0) fail('CAD_PREVIEW_EMPTY_FILE', '所选文件为空。');
    if (before.size > CAD_PREVIEW_MAX_BYTES) fail('CAD_PREVIEW_TOO_LARGE', '文件超过 32 MiB 的只读预览上限。');

    const chunks = [];
    let total = 0;
    while (total <= CAD_PREVIEW_MAX_BYTES) {
      const capacity = Math.min(READ_CHUNK_BYTES, CAD_PREVIEW_MAX_BYTES - total + 1);
      const chunk = Buffer.allocUnsafe(capacity);
      const { bytesRead } = await handle.read(chunk, 0, capacity, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > CAD_PREVIEW_MAX_BYTES) fail('CAD_PREVIEW_TOO_LARGE', '文件超过 32 MiB 的只读预览上限。');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (total !== before.size || !sameFile(before, after) || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      fail('CAD_PREVIEW_FILE_CHANGED', '读取期间文件发生变化，请重新选择后再试。');
    }
    const bytes = Uint8Array.from(Buffer.concat(chunks, total));
    return {
      cancelled: false,
      name: basename(filePath),
      extension,
      byteLength: bytes.byteLength,
      bytes
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && String(error.code).startsWith('CAD_PREVIEW_')) throw error;
    fail('CAD_PREVIEW_READ_FAILED', '无法安全读取所选 CAD 文件。');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
