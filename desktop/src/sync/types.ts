import type { PlcTarget } from '../plcgen/types.ts';

export const DESIGN_MANIFEST_SCHEMA_VERSION = 1 as const;
export const PLC_SYNC_EXTENSION_SCHEMA_VERSION = 1 as const;

export interface SyncConfig {
  baseUrl: string;
  apiKey: string;
  deviceId: string;
  projectId: string;
  enabled: boolean;
}

export type DesignFileKind = 'BOM' | 'PDF' | 'STEP' | 'GLTF' | 'DXF';

export interface DesignFileEntry {
  path: string;
  sha256: string;
  size: number;
  kind: DesignFileKind;
}

export interface DesignBomRow {
  no: number;
  name: string;
  spec: string;
  qty: number;
  mat: string;
  remark?: string;
}

/** PLC 子清单记录：所有路径都位于 plc/ 下，且带字节长度与 SHA-256。 */
export interface SyncPlcFileRecord {
  path: string;
  size: number;
  sha256: string;
}

/** 以可选扩展承载 PLC 数据，保持既有 design-sync schemaVersion 1 可读。 */
export interface DesignPlcManifest {
  schemaVersion: 1;
  target: PlcTarget;
  generatedVersion: string;
  machineId: string;
  programFiles: SyncPlcFileRecord[];
  mapping: SyncPlcFileRecord;
}

export interface DesignManifest {
  schemaVersion: 1;
  projectId: string;
  projectName: string;
  appVersion: string;
  createdAt: string;
  bomSha256: string;
  files: DesignFileEntry[];
  bom: DesignBomRow[];
  /** 缺省表示旧版 BOM/PDF/GLB/DXF 包。 */
  plc?: DesignPlcManifest;
}

/** 仅接受生成器产生的文本源文件以及机型 IO map CSV；主进程会再次校验白名单。 */
export interface SyncPlcUploadPayload {
  target: PlcTarget;
  generatedVersion: string;
  machineId: string;
  programFiles: Array<{ path: string; content: string }>;
  mappingCsv: string;
}

/** 渲染层交给主进程的导出物；主进程负责校验、打 zip 并上传。 */
export interface SyncUploadPayload {
  projectName: string;
  bomCsv: string | Uint8Array;
  reportHtml: string;
  glb: Uint8Array;
  dxf: string | Uint8Array;
  bom: DesignBomRow[];
  plc?: SyncPlcUploadPayload;
}

export type SyncStage = '打包' | '连接' | '上传' | '解析' | '列表' | '比对' | '下载';

export interface SyncResult {
  ok: boolean;
  packageId?: string;
  version?: number;
  duplicated?: boolean;
  message?: string;
  stage?: SyncStage;
  /** 阶段错误码，例如 UPLOAD_FAILED；成功时不返回。 */
  code?: string;
}

export interface SyncPackageSummary {
  packageId: string;
  projectId: string;
  version: number;
  bomSha256: string;
  createdAt: string;
  uploadedBy?: string;
}

export interface DesignDiff {
  base: { packageId: string; version: number };
  bomAdded: DesignBomRow[];
  bomRemoved: DesignBomRow[];
  bomChanged: Array<{ no: number | string; field: string; from: unknown; to: unknown }>;
  filesAdded: string[];
  filesChanged: string[];
  filesRemoved: string[];
}

export type SyncListResult =
  | { ok: true; items: SyncPackageSummary[] }
  | { ok: false; message: string; stage?: SyncStage; code?: string };

export type SyncDiffResult =
  | { ok: true; diff: DesignDiff }
  | { ok: false; message: string; stage?: SyncStage; code?: string };

export type SyncDownloadResult =
  | { ok: true; zip: Uint8Array; bytes: number; sha256: string; etag?: string }
  | { ok: false; message: string; stage?: SyncStage; code?: string };

export interface SyncImportCandidate {
  manifest: DesignManifest;
  plc?: {
    target: PlcTarget;
    generatedVersion: string;
    machineId: string;
    programFiles: Array<{ path: string; content: string }>;
    mappingCsv: string;
  };
  machineContextStatus: 'not-applicable' | 'unavailable' | 'matched';
  /** 解析从不落盘；即使匹配机型，也必须由后续显式应用操作处理。 */
  requiresExplicitApply: true;
}

export type SyncDownloadCandidateResult =
  | { ok: true; candidate: SyncImportCandidate; bytes: number; sha256: string; etag?: string }
  | { ok: false; message: string; stage?: SyncStage; code?: string };

/** 给 UI 的配置视图，绝不包含明文 apiKey。 */
export interface SyncPublicConfig {
  baseUrl: string;
  deviceId: string;
  projectId: string;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyMasked: string;
}
