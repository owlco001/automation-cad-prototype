import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import {
  buildPortableProjectArchive,
  parsePortableProjectArchive,
  PORTABLE_PROJECT_LIMITS,
  PORTABLE_PROJECT_EXCLUDED_STATE_CODES,
  type PortableProjectCandidate,
  type PortableProjectIdentity
} from './archive.ts';

export type ProjectArchiveDialogChoice = { canceled: true } | { canceled: false; path: string };

export interface PortableProjectDesktopDependencies {
  isEnabled(): boolean;
  chooseCadFile(): Promise<ProjectArchiveDialogChoice>;
  chooseArchiveDestination(suggestedName: string): Promise<ProjectArchiveDialogChoice>;
  chooseArchiveFile(): Promise<ProjectArchiveDialogChoice>;
  statFile(path: string): { isFile: boolean; size: number };
  readFile(path: string): Uint8Array;
  writeFileExclusive(path: string, bytes: Uint8Array): void;
  appVersion: string;
  now?: () => Date;
}

export interface PortableProjectPreview {
  project: { id: string; name: string; identity?: PortableProjectIdentity };
  appVersion: string;
  createdAt: string;
  schemaVersion: number;
  coreSchemaVersion: number;
  state: { featureTree: boolean; kinematics: boolean; viewState: boolean };
  omittedState: string[];
  dependencies: Array<{ originalName: string; format: string; size: number; sha256: string }>;
  integrity: { algorithm: string; scope: string; authenticity: string };
  restoreMode: 'archive-api-only';
  unsupported: string[];
}

export type PortableProjectDesktopResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'MODULE_DISABLED' | 'CANCELED' | 'FAILED'; stage?: string; message: string };

export interface PortableCadExportResult {
  path: string;
  bytes: number;
  sha256: string;
  projectName: string;
  dependencyName: string;
  projectId: string;
  includedState: { featureTree: boolean; kinematics: boolean; viewState: boolean };
  excludedState: string[];
}

export interface PortableProjectExportSnapshot {
  projectId: string;
  sourceName: string;
  sourceSha256: string;
  sourceSize: number;
  modelObjects: PortableProjectIdentity['modelObjects'];
  featureTreeJson: string | null;
  kinematicsJson: string | null;
  viewStateJson: string | null;
  excludedState: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireEnabled(dependencies: PortableProjectDesktopDependencies): void {
  if (!dependencies.isEnabled()) {
    throw Object.assign(new Error('功能模块「project.portable」当前已关闭，已拒绝工程档案文件操作。'), {
      code: 'MODULE_DISABLED'
    });
  }
}

function requireRegularFile(dependencies: PortableProjectDesktopDependencies, path: string, maximum: number, label: string): number {
  const info = dependencies.statFile(path);
  if (!info.isFile || !Number.isSafeInteger(info.size) || info.size <= 0) throw new Error(`${label}不是有效的普通文件`);
  if (info.size > maximum) throw new Error(`${label}超过 ${maximum} 字节上限`);
  return info.size;
}

function readBoundedFile(
  dependencies: PortableProjectDesktopDependencies,
  path: string,
  maximum: number,
  label: string
): Uint8Array {
  const expectedSize = requireRegularFile(dependencies, path, maximum, label);
  const bytes = dependencies.readFile(path);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new Error(`${label}读取结果为空或无效`);
  if (bytes.byteLength > maximum) throw new Error(`${label}读取后超过 ${maximum} 字节上限`);
  if (bytes.byteLength !== expectedSize) throw new Error(`${label}在读取期间发生变化，已拒绝继续`);
  return bytes;
}

function portableCadFormat(path: string): string {
  const extension = extname(path).slice(1).toLowerCase();
  if (!['step', 'stp', 'iges', 'igs', 'brep', 'stl', 'glb'].includes(extension)) {
    throw new Error(`工程档案当前不支持该 CAD 文件格式：${extension ? `.${extension}` : '(无扩展名)'}`);
  }
  return extension;
}

function projectNameFromPath(path: string): string {
  const raw = basename(path, extname(path)).trim();
  if (!raw) throw new Error('无法从所选 CAD 文件名生成档案名称');
  return raw.slice(0, 200);
}

function suggestedArchiveName(name: string): string {
  const safe = name
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 96);
  return `${safe || 'AutomationCAD'}.acproj`;
}

function ensureArchiveExtension(path: string): string {
  return extname(path).toLowerCase() === '.acproj' ? path : `${path}.acproj`;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseExportSnapshot(value: unknown, dependencyName: string, dependencyContent: Uint8Array): PortableProjectExportSnapshot {
  if (!isRecord(value)) throw new Error('无法安全创建工程档案：缺少当前工程状态快照');
  const expectedKeys = [
    'projectId', 'sourceName', 'sourceSha256', 'sourceSize', 'modelObjects',
    'featureTreeJson', 'kinematicsJson', 'viewStateJson', 'excludedState'
  ].sort();
  if (Object.keys(value).sort().join('\0') !== expectedKeys.join('\0')) {
    throw new Error('工程状态快照字段不完整或含未知数据，已拒绝导出');
  }
  if (typeof value.projectId !== 'string' || !/^acproj-[0-9a-f-]{36}$/i.test(value.projectId)) {
    throw new Error('工程状态快照缺少稳定 projectId');
  }
  if (value.sourceName !== dependencyName) throw new Error('所选 CAD 文件名与当前工程来源不匹配，已拒绝打包状态');
  if (value.sourceSha256 !== sha256Hex(dependencyContent) || value.sourceSize !== dependencyContent.byteLength) {
    throw new Error('所选 CAD 原件与当前工程来源 SHA-256/大小不匹配，已拒绝打包状态');
  }
  if (!Array.isArray(value.modelObjects) || value.modelObjects.length > 10_000) {
    throw new Error('工程状态快照的 CAD 对象映射超出限制');
  }
  if (!Array.isArray(value.excludedState) || value.excludedState.length > 16 || !value.excludedState.every((code) =>
    typeof code === 'string' && (PORTABLE_PROJECT_EXCLUDED_STATE_CODES as readonly string[]).includes(code)
  ) || new Set(value.excludedState).size !== value.excludedState.length) {
    throw new Error('工程状态快照的排除能力清单无效');
  }
  for (const state of [value.featureTreeJson, value.kinematicsJson, value.viewStateJson]) {
    if (state !== null && (typeof state !== 'string' || Buffer.byteLength(state, 'utf8') > PORTABLE_PROJECT_LIMITS.maxStateBytes)) {
      throw new Error('工程状态快照为空值类型无效或超过单状态大小上限');
    }
  }
  if (typeof value.kinematicsJson === 'string') {
    let annotation: unknown;
    try { annotation = JSON.parse(value.kinematicsJson) as unknown; }
    catch { throw new Error('运动学候选不是合法 JSON'); }
    if (!isRecord(annotation) || annotation.version !== 2 || annotation.projectId !== value.projectId) {
      throw new Error('运动学候选缺少当前工程 ID 与稳定对象映射，已拒绝导出');
    }
  }
  return {
    projectId: value.projectId,
    sourceName: value.sourceName as string,
    sourceSha256: value.sourceSha256 as string,
    sourceSize: value.sourceSize as number,
    modelObjects: value.modelObjects as PortableProjectIdentity['modelObjects'],
    featureTreeJson: value.featureTreeJson as string | null,
    kinematicsJson: value.kinematicsJson as string | null,
    viewStateJson: value.viewStateJson as string | null,
    excludedState: [...value.excludedState] as string[]
  };
}

function previewFromCandidate(candidate: PortableProjectCandidate): PortableProjectPreview {
  const manifest = candidate.manifest;
  return {
    project: { ...manifest.project },
    appVersion: manifest.appVersion,
    createdAt: manifest.createdAt,
    schemaVersion: manifest.schemaVersion,
    coreSchemaVersion: manifest.coreSchemaVersion,
    state: {
      featureTree: manifest.state.featureTree !== null,
      kinematics: manifest.state.kinematics !== null,
      viewState: manifest.state.viewState !== null
    },
    omittedState: [...(manifest.state.omitted ?? [])],
    dependencies: manifest.dependencies.map((dependency) => ({
      originalName: dependency.originalName,
      format: dependency.format,
      size: dependency.size,
      sha256: dependency.sha256
    })),
    integrity: { ...manifest.integrity },
    restoreMode: manifest.restoreMode,
    unsupported: [...manifest.unsupported]
  };
}

function failure(error: unknown): PortableProjectDesktopResult<never> {
  const code = error && typeof error === 'object' && 'code' in error && error.code === 'MODULE_DISABLED'
    ? 'MODULE_DISABLED'
    : 'FAILED';
  return { ok: false, code, message: errorMessage(error) };
}

/** 必须以当前工程的稳定身份和白名单状态快照绑定用户选中的 CAD 原件。 */
export async function exportSelectedCadAsPortableArchive(
  dependencies: PortableProjectDesktopDependencies,
  snapshotValue: unknown
): Promise<PortableProjectDesktopResult<PortableCadExportResult>> {
  try {
    requireEnabled(dependencies);
    const cadChoice = await dependencies.chooseCadFile();
    if (cadChoice.canceled) return { ok: false, code: 'CANCELED', stage: 'cad-selection', message: '已取消选择 CAD 原件。' };
    requireEnabled(dependencies);

    portableCadFormat(cadChoice.path);
    const dependencyName = basename(cadChoice.path);
    const content = readBoundedFile(dependencies, cadChoice.path, PORTABLE_PROJECT_LIMITS.maxDependencyBytes, 'CAD 原件');
    const snapshot = parseExportSnapshot(snapshotValue, dependencyName, content);
    const projectName = projectNameFromPath(cadChoice.path);
    const createdAt = (dependencies.now?.() ?? new Date()).toISOString();
    const built = buildPortableProjectArchive({
      projectId: snapshot.projectId,
      projectName,
      appVersion: dependencies.appVersion,
      createdAt,
      identity: {
        sourceName: snapshot.sourceName,
        sourceSha256: snapshot.sourceSha256,
        sourceSize: snapshot.sourceSize,
        modelObjects: snapshot.modelObjects
      },
      dependencies: [{ originalName: dependencyName, content }],
      ...(snapshot.featureTreeJson ? { featureTreeJson: snapshot.featureTreeJson } : {}),
      ...(snapshot.kinematicsJson ? { kinematicsJson: snapshot.kinematicsJson } : {}),
      ...(snapshot.viewStateJson ? { viewStateJson: snapshot.viewStateJson } : {}),
      excludedState: snapshot.excludedState
    });

    const destination = await dependencies.chooseArchiveDestination(suggestedArchiveName(projectName));
    if (destination.canceled) return { ok: false, code: 'CANCELED', stage: 'archive-destination', message: '已取消保存工程档案；未写入文件。' };
    requireEnabled(dependencies);
    const path = ensureArchiveExtension(destination.path);
    dependencies.writeFileExclusive(path, built.bytes);
    return {
      ok: true,
      value: {
        path,
        bytes: built.bytes.byteLength,
        sha256: built.sha256,
        projectName,
        dependencyName,
        projectId: snapshot.projectId,
        includedState: {
          featureTree: snapshot.featureTreeJson !== null,
          kinematics: snapshot.kinematicsJson !== null,
          viewState: snapshot.viewStateJson !== null
        },
        excludedState: [...snapshot.excludedState]
      }
    };
  } catch (error) {
    return failure(error);
  }
}

/** 严格解析所选 .acproj，但仅返回清单摘要；不写入、不覆盖或应用任何项目状态。 */
export async function previewSelectedPortableArchive(
  dependencies: PortableProjectDesktopDependencies
): Promise<PortableProjectDesktopResult<PortableProjectPreview>> {
  try {
    requireEnabled(dependencies);
    const choice = await dependencies.chooseArchiveFile();
    if (choice.canceled) return { ok: false, code: 'CANCELED', stage: 'archive-selection', message: '已取消选择工程档案。' };
    requireEnabled(dependencies);
    if (extname(choice.path).toLowerCase() !== '.acproj') throw new Error('所选文件不是 .acproj 工程档案');
    const bytes = readBoundedFile(dependencies, choice.path, PORTABLE_PROJECT_LIMITS.maxArchiveBytes, '工程档案');
    requireEnabled(dependencies);
    const candidate = parsePortableProjectArchive(bytes);
    return { ok: true, value: previewFromCandidate(candidate) };
  } catch (error) {
    return failure(error);
  }
}

/** 独占创建档案文件，不截断已有文件；写入失败时仅尽力清理本调用创建的目标。 */
export function writePortableArchiveExclusively(target: string, bytes: Uint8Array): void {
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = openSync(target, 'wx', 0o600);
    created = true;
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* preserve the original error */ }
    }
    if (created) {
      try { unlinkSync(target); } catch { /* best-effort cleanup of this newly-created file only */ }
    }
    throw error;
  }
}
