export interface CoreProject {
  format: 'automationcad-core-project';
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  notes: string;
}

export interface CoreProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
}

export interface CoreProjectSaveInput {
  id: string;
  name: string;
  notes: string;
}

export interface CoreProjectCadPreviewAttachment {
  sha256: string;
  extension: '.stl' | '.glb';
  name: string;
  byteLength: number;
  addedAt: string;
}

export interface CoreProjectCadPreviewAttachmentFile extends CoreProjectCadPreviewAttachment {
  bytes: Uint8Array;
}

export interface CoreProjectStoreOptions {
  /** Internal test seam; never exposed to the renderer. */
  replaceFile?: (temporaryPath: string, projectPath: string) => Promise<void>;
  /** Internal test seam; never exposed to the renderer. */
  createHardLink?: (temporaryPath: string, projectPath: string) => Promise<void>;
  /** Internal test seam; never exposed to the renderer. */
  linkAttachment?: (temporaryPath: string, objectPath: string) => Promise<void>;
  /** Internal test seam; never exposed to the renderer. */
  replaceAttachmentIndex?: (temporaryPath: string, indexPath: string) => Promise<void>;
  /** Internal test seam; never exposed to the renderer. */
  createAttachmentIndex?: (temporaryPath: string, indexPath: string) => Promise<void>;
}

export class CoreProjectStore {
  constructor(root: string, options?: CoreProjectStoreOptions);
  list(): Promise<CoreProjectSummary[]>;
  create(name: string): Promise<CoreProject>;
  open(id: string): Promise<CoreProject>;
  save(input: CoreProjectSaveInput): Promise<CoreProject>;
  addCadPreviewAttachment(projectId: string, name: string, extension: string, bytes: Uint8Array | ArrayBuffer): Promise<CoreProjectCadPreviewAttachment>;
  listCadPreviewAttachments(projectId: string): Promise<CoreProjectCadPreviewAttachment[]>;
  openCadPreviewAttachment(projectId: string, sha256: string): Promise<CoreProjectCadPreviewAttachmentFile>;
}

export const CORE_PROJECT_SCHEMA_VERSION: 1;
export const CORE_PROJECT_ATTACHMENT_SCHEMA_VERSION: 1;
