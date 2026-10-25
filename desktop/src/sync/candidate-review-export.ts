import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { MAX_PLC_FILE_BYTES, MAX_PLC_PROGRAM_FILES, MAX_PLC_TOTAL_BYTES, sha256Hex, validatePlcText } from './package.ts';
import { PLCGEN_VERSION } from '../plcgen/st.ts';
import { PLC_TARGETS } from '../plcgen/types.ts';
import type { SyncImportCandidate } from './types.ts';

export const PLC_REVIEW_ALLOWED_PATHS = [
  'src/OB1_Main.st',
  'src/DB_IO.st',
  'src/FB_Cylinder.st',
  'src/FB_Gripper.st',
  'src/FB_RotaryAxis.st',
  'src/FC_AutoSequence.st',
  'src/FC_Alarms.st',
  'src/FC_Safety.st',
  'io-tags.csv',
  'mapping.json'
] as const;

const ALLOWED_PATHS = new Set<string>(PLC_REVIEW_ALLOWED_PATHS);
const ALLOWED_LOWERCASE_PATHS = new Set(PLC_REVIEW_ALLOWED_PATHS.map((path) => path.toLowerCase()));

export interface CandidateReviewFile {
  path: string;
  bytes: Uint8Array;
}

export interface CandidateReviewFileSystem {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  realpath(path: string): string;
  makeTempDirectory(prefix: string): string;
  makeDirectory(path: string): void;
  openExclusive(path: string, mode: number): number;
  writeDescriptor(descriptor: number, bytes: Uint8Array): void;
  closeDescriptor(descriptor: number): void;
  rename(source: string, destination: string): void;
  remove(path: string): void;
}

export interface CandidateReviewExportOptions {
  /** Injectable for deterministic collision tests; production uses a cryptographic random suffix. */
  randomSuffix?: () => string;
  /** Injectable filesystem operations allow failure-path tests without weakening the IPC contract. */
  fileSystem?: Partial<CandidateReviewFileSystem>;
}

const nodeFileSystem: CandidateReviewFileSystem = {
  exists(path) {
    try {
      lstatSync(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  },
  isDirectory(path) {
    return statSync(path).isDirectory();
  },
  realpath(path) {
    return realpathSync(path);
  },
  makeTempDirectory(prefix) {
    return mkdtempSync(prefix);
  },
  makeDirectory(path) {
    mkdirSync(path, { mode: 0o700 });
  },
  openExclusive(path, mode) {
    return openSync(path, 'wx', mode);
  },
  writeDescriptor(descriptor, bytes) {
    writeFileSync(descriptor, bytes);
  },
  closeDescriptor(descriptor) {
    closeSync(descriptor);
  },
  rename(source, destination) {
    renameSync(source, destination);
  },
  remove(path) {
    rmSync(path, { recursive: true, force: true });
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0') || /^[A-Za-z]:/.test(path)) return false;
  const segments = path.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..' && !/[\u0000-\u001f\u007f]/.test(segment));
}

function assertCandidatePath(path: unknown, exactSeen: Set<string>, foldedSeen: Set<string>): asserts path is string {
  if (typeof path !== 'string' || !isSafeRelativePath(path)) throw new Error('PLC 审阅导出包含不安全相对路径');
  const folded = path.toLowerCase();
  if (exactSeen.has(path)) throw new Error(`PLC 审阅导出存在重复路径：${path}`);
  if (foldedSeen.has(folded)) throw new Error(`PLC 审阅导出存在大小写冲突路径：${path}`);
  exactSeen.add(path);
  foldedSeen.add(folded);
  if (!ALLOWED_PATHS.has(path) || !ALLOWED_LOWERCASE_PATHS.has(folded)) {
    throw new Error(`PLC 审阅导出文件类型或路径不在白名单中：${path}`);
  }
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const expectedExtension = path.startsWith('src/') ? 'st' : path === 'io-tags.csv' ? 'csv' : 'json';
  if (extension !== expectedExtension) throw new Error(`PLC 审阅导出文件类型不受支持：${path}`);
}

/**
 * Rechecks the exact parsed-candidate file set before a local review export.
 * The machine-specific plc.mapping CSV is deliberately excluded: its safety persistence schema is unresolved.
 */
export function buildCandidateReviewFiles(candidate: unknown): CandidateReviewFile[] {
  if (!isRecord(candidate) || candidate.requiresExplicitApply !== true || !isRecord(candidate.plc) || !isRecord(candidate.manifest)) {
    throw new Error('PLC 审阅导出需要已校验的只读 PLC 候选');
  }
  const plc = candidate.plc;
  const manifest = candidate.manifest;
  if (typeof plc.target !== 'string' || !PLC_TARGETS.includes(plc.target as (typeof PLC_TARGETS)[number])) {
    throw new Error('PLC 审阅候选 target 不受支持');
  }
  if (plc.generatedVersion !== PLCGEN_VERSION || typeof plc.machineId !== 'string' || !plc.machineId.trim()) {
    throw new Error('PLC 审阅候选身份或生成器版本无效');
  }
  if (!isRecord(manifest.plc) || manifest.plc.target !== plc.target || manifest.plc.generatedVersion !== plc.generatedVersion ||
      manifest.plc.machineId !== plc.machineId || !Array.isArray(manifest.plc.programFiles) ||
      manifest.plc.programFiles.length !== MAX_PLC_PROGRAM_FILES || !isRecord(manifest.plc.mapping) ||
      manifest.plc.mapping.path !== 'plc/machine-io-map.csv') {
    throw new Error('PLC 审阅候选与已校验 manifest 不一致');
  }
  if (!Array.isArray(plc.programFiles) || plc.programFiles.length !== MAX_PLC_PROGRAM_FILES) {
    throw new Error(`PLC 审阅导出必须恰好包含 ${MAX_PLC_PROGRAM_FILES} 个固定文件`);
  }

  const manifestRecords = new Map<string, Record<string, unknown>>();
  for (const record of manifest.plc.programFiles) {
    if (!isRecord(record) || typeof record.path !== 'string' || manifestRecords.has(record.path)) {
      throw new Error('PLC 审阅候选 manifest 文件清单无效');
    }
    manifestRecords.set(record.path, record);
  }

  const exactSeen = new Set<string>();
  const foldedSeen = new Set<string>();
  const files: CandidateReviewFile[] = [];
  let totalBytes = 0;
  for (const entry of plc.programFiles) {
    if (!isRecord(entry) || typeof entry.content !== 'string') throw new Error('PLC 审阅导出文件记录无效');
    assertCandidatePath(entry.path, exactSeen, foldedSeen);
    const bytes = validatePlcText(entry.content, `plc/${entry.path}`);
    if (bytes.byteLength > MAX_PLC_FILE_BYTES) throw new Error(`PLC 审阅文件超过 1 MiB 上限：${entry.path}`);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_PLC_TOTAL_BYTES) throw new Error('PLC 审阅文件总量超过 8 MiB 上限');
    files.push({ path: entry.path, bytes });
  }
  if (PLC_REVIEW_ALLOWED_PATHS.some((path) => !exactSeen.has(path))) throw new Error('PLC 审阅候选缺少固定白名单文件');
  if (manifestRecords.size !== MAX_PLC_PROGRAM_FILES || PLC_REVIEW_ALLOWED_PATHS.some((path) => !manifestRecords.has(`plc/${path}`))) {
    throw new Error('PLC 审阅候选 manifest 缺少固定白名单文件');
  }
  for (const file of files) {
    const record = manifestRecords.get(`plc/${file.path}`);
    if (!record || record.size !== file.bytes.byteLength || record.sha256 !== sha256Hex(file.bytes)) {
      throw new Error(`PLC 审阅文件与已校验 manifest 不一致：${file.path}`);
    }
  }
  return files;
}

function packageIdentityHash(packageId: string): string {
  if (typeof packageId !== 'string' || !packageId.trim() || packageId.length > 256 || /[\u0000-\u001f\u007f]/.test(packageId)) {
    throw new Error('packageId 无效，无法生成安全审阅目录名');
  }
  const label = packageId.trim();
  validatePlcText(label, 'packageId');
  return sha256Hex(label).slice(0, 12);
}

function randomHexSuffix(): string {
  return randomBytes(16).toString('hex');
}

/** Writes validated PLC text to a new sibling directory, then atomically renames the private staging directory. */
export function exportCandidateReviewFolder(
  parentDirectory: string,
  packageId: string,
  candidate: unknown,
  options: CandidateReviewExportOptions = {}
): { folderName: string; fileCount: number } {
  if (typeof parentDirectory !== 'string' || !parentDirectory.trim()) throw new Error('请选择本地审阅导出的父文件夹');
  const files = buildCandidateReviewFiles(candidate);
  const fileSystem: CandidateReviewFileSystem = { ...nodeFileSystem, ...options.fileSystem };
  if (!fileSystem.isDirectory(parentDirectory)) throw new Error('所选父路径不是文件夹');
  const parent = fileSystem.realpath(parentDirectory);
  const suffix = options.randomSuffix?.() ?? randomHexSuffix();
  if (!/^[a-f0-9]{8,32}$/i.test(suffix)) throw new Error('审阅目录唯一标识无效');
  const folderName = `plc-review-${packageIdentityHash(packageId)}-${suffix.toLowerCase()}`;
  const finalDirectory = join(parent, folderName);
  if (fileSystem.exists(finalDirectory)) throw new Error('目标审阅文件夹已存在；未覆盖任何文件');

  const stagingDirectory = fileSystem.makeTempDirectory(join(parent, `.${folderName}.tmp-`));
  const reservationPath = join(parent, `.${folderName}.reserve`);
  let reservationDescriptor: number | null = null;
  let published = false;
  try {
    for (const file of files) {
      const destination = join(stagingDirectory, ...file.path.split('/'));
      if (file.path.startsWith('src/')) {
        const sourceDirectory = join(stagingDirectory, 'src');
        if (!fileSystem.exists(sourceDirectory)) fileSystem.makeDirectory(sourceDirectory);
      }
      const descriptor = fileSystem.openExclusive(destination, 0o600);
      try {
        fileSystem.writeDescriptor(descriptor, file.bytes);
      } finally {
        fileSystem.closeDescriptor(descriptor);
      }
    }

    // A short-lived exclusive sibling reservation prevents two exports in this process family from claiming the same random name.
    reservationDescriptor = fileSystem.openExclusive(reservationPath, 0o600);
    if (fileSystem.exists(finalDirectory)) throw new Error('目标审阅文件夹已存在；未覆盖任何文件');
    fileSystem.rename(stagingDirectory, finalDirectory);
    published = true;
    return { folderName, fileCount: files.length };
  } finally {
    if (reservationDescriptor !== null) fileSystem.closeDescriptor(reservationDescriptor);
    if (fileSystem.exists(reservationPath)) fileSystem.remove(reservationPath);
    if (!published && fileSystem.exists(stagingDirectory)) fileSystem.remove(stagingDirectory);
  }
}
