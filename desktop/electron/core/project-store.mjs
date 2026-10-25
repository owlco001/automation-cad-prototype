import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { CAD_PREVIEW_EXTENSIONS, CAD_PREVIEW_MAX_BYTES, parseCadPreview } from './cad-preview-format.mjs';

const PROJECT_FORMAT = 'automationcad-core-project';
const SCHEMA_VERSION = 1;
const MAX_NAME_LENGTH = 100;
const MAX_NOTES_LENGTH = 20000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ATTACHMENT_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 2000;
const MAX_ATTACHMENT_NAME_LENGTH = 255;
const ATTACHMENT_INDEX_FORMAT = 'automationcad-core-project-attachments';
const ATTACHMENT_INDEX_SCHEMA_VERSION = 1;
const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const EXPECTED_PROJECT_KEYS = ['createdAt', 'format', 'id', 'name', 'notes', 'schemaVersion', 'updatedAt'];
const EXPECTED_SAVE_KEYS = ['id', 'name', 'notes'];
const EXPECTED_ATTACHMENT_INDEX_KEYS = ['attachments', 'format', 'projectId', 'schemaVersion'];
const EXPECTED_ATTACHMENT_KEYS = ['addedAt', 'byteLength', 'extension', 'name', 'sha256'];

function storeError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, expected) {
  return isPlainObject(value) && Object.keys(value).sort().join('\n') === expected.join('\n');
}

function validateName(name) {
  if (typeof name !== 'string') throw storeError('CORE_PROJECT_INVALID', '项目名称必须是文本。');
  const normalized = name.trim();
  if (!normalized || normalized.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw storeError('CORE_PROJECT_INVALID', `项目名称须为 1–${MAX_NAME_LENGTH} 个可见字符。`);
  }
  return normalized;
}

function validateNotes(notes) {
  if (typeof notes !== 'string' || notes.length > MAX_NOTES_LENGTH || notes.includes('\u0000')) {
    throw storeError('CORE_PROJECT_INVALID', `项目备注须为文本且不超过 ${MAX_NOTES_LENGTH} 个字符。`);
  }
  return notes;
}

function validateId(id) {
  if (typeof id !== 'string' || !PROJECT_ID_PATTERN.test(id)) {
    throw storeError('CORE_PROJECT_INVALID', '项目标识无效。');
  }
  return id.toLowerCase();
}

function validateTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validateProject(value) {
  if (!hasExactKeys(value, EXPECTED_PROJECT_KEYS)
    || value.format !== PROJECT_FORMAT
    || value.schemaVersion !== SCHEMA_VERSION
    || typeof value.id !== 'string'
    || !PROJECT_ID_PATTERN.test(value.id)
    || typeof value.name !== 'string'
    || value.name !== validateName(value.name)
    || typeof value.notes !== 'string'
    || value.notes !== validateNotes(value.notes)
    || !validateTimestamp(value.createdAt)
    || !validateTimestamp(value.updatedAt)) {
    throw storeError('CORE_PROJECT_CORRUPT', '工程文件格式无效、已损坏或版本不受支持；原数据未修改。');
  }
  return {
    format: PROJECT_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    id: value.id.toLowerCase(),
    name: value.name,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    notes: value.notes
  };
}

function validateAttachmentExtension(extension) {
  if (typeof extension !== 'string' || !CAD_PREVIEW_EXTENSIONS.includes(extension.toLowerCase())) {
    throw storeError('CORE_ATTACHMENT_INVALID', '项目附件仅支持 STL 与 GLB 格式。');
  }
  return extension.toLowerCase();
}

function validateAttachmentName(name, extension) {
  if (typeof name !== 'string' || !name || name.length > MAX_ATTACHMENT_NAME_LENGTH
    || name === '.' || name === '..' || /[\\/\u0000-\u001f\u007f]/u.test(name)
    || extname(name).toLowerCase() !== extension) {
    throw storeError('CORE_ATTACHMENT_INVALID', '附件文件名或扩展名无效。');
  }
  return name;
}

function copyAttachmentBytes(input) {
  let view;
  if (input instanceof ArrayBuffer) view = new Uint8Array(input);
  else if (ArrayBuffer.isView(input)) view = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  else throw storeError('CORE_ATTACHMENT_INVALID', '附件内容格式无效。');
  if (!Number.isSafeInteger(view.byteLength) || view.byteLength <= 0) {
    throw storeError('CORE_ATTACHMENT_INVALID', '附件内容为空或长度无效。');
  }
  if (view.byteLength > CAD_PREVIEW_MAX_BYTES) {
    throw storeError('CORE_ATTACHMENT_TOO_LARGE', 'CAD 附件超过 32 MiB 上限。');
  }
  return Buffer.from(view);
}

function validateAttachmentEntry(value) {
  if (!hasExactKeys(value, EXPECTED_ATTACHMENT_KEYS)
    || !Number.isSafeInteger(value.byteLength)
    || value.byteLength <= 0
    || value.byteLength > CAD_PREVIEW_MAX_BYTES
    || typeof value.sha256 !== 'string'
    || !SHA256_PATTERN.test(value.sha256)
    || value.sha256 !== value.sha256.toLowerCase()
    || !validateTimestamp(value.addedAt)) {
    throw storeError('CORE_ATTACHMENT_INDEX_CORRUPT', '项目附件索引条目无效；现有数据未修改。');
  }
  let extension;
  let name;
  try {
    extension = validateAttachmentExtension(value.extension);
    name = validateAttachmentName(value.name, extension);
  } catch (error) {
    throw storeError('CORE_ATTACHMENT_INDEX_CORRUPT', '项目附件索引含无效的格式或文件名；现有数据未修改。', error);
  }
  return {
    sha256: value.sha256,
    extension,
    name,
    byteLength: value.byteLength,
    addedAt: value.addedAt
  };
}

function validateAttachmentIndex(value, projectId) {
  if (!hasExactKeys(value, EXPECTED_ATTACHMENT_INDEX_KEYS)
    || value.format !== ATTACHMENT_INDEX_FORMAT
    || value.schemaVersion !== ATTACHMENT_INDEX_SCHEMA_VERSION
    || value.projectId !== projectId
    || !Array.isArray(value.attachments)
    || value.attachments.length > MAX_ATTACHMENT_COUNT) {
    throw storeError('CORE_ATTACHMENT_INDEX_CORRUPT', '项目附件索引格式无效、项目标识不匹配或版本不受支持；现有数据未修改。');
  }
  const attachments = value.attachments.map(validateAttachmentEntry);
  const hashes = new Set();
  for (const attachment of attachments) {
    if (hashes.has(attachment.sha256)) {
      throw storeError('CORE_ATTACHMENT_INDEX_CORRUPT', '项目附件索引含重复内容摘要；现有数据未修改。');
    }
    hashes.add(attachment.sha256);
  }
  return {
    format: ATTACHMENT_INDEX_FORMAT,
    schemaVersion: ATTACHMENT_INDEX_SCHEMA_VERSION,
    projectId,
    attachments
  };
}

function bytesHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function compareStats(left, right) {
  if (left.dev !== right.dev) return false;
  if (left.ino !== 0 && right.ino !== 0) return left.ino === right.ino;
  return left.size === right.size && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs && left.birthtimeMs === right.birthtimeMs;
}

async function readSafeFileSnapshot(filePath, maximumBytes, errorCode, invalidMessage) {
  let handle;
  try {
    const pathInfo = await lstat(filePath);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.size > maximumBytes) {
      throw storeError(errorCode, invalidMessage);
    }
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || !compareStats(pathInfo, before) || before.size > maximumBytes) {
      throw storeError(errorCode, invalidMessage);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!compareStats(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.byteLength !== before.size) {
      throw storeError(errorCode, invalidMessage);
    }
    return bytes;
  } catch (error) {
    if (error?.code?.startsWith?.('CORE_ATTACHMENT_')) throw error;
    throw storeError(errorCode, invalidMessage, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Stores versioned project metadata and immutable, content-addressed preview attachments.
 * Renderer callers never provide or receive filesystem paths.
 */
export class CoreProjectStore {
  #root;
  #replaceFile;
  #createHardLink;
  #linkAttachment;
  #replaceAttachmentIndex;
  #createAttachmentIndex;
  #locks = new Map();

  constructor(root, {
    replaceFile = rename,
    createHardLink = link,
    linkAttachment = link,
    replaceAttachmentIndex = rename,
    createAttachmentIndex = link
  } = {}) {
    if (typeof root !== 'string' || root.length === 0) throw new TypeError('Core project store root must be provided by the application.');
    this.#root = resolve(root);
    this.#replaceFile = replaceFile;
    this.#createHardLink = createHardLink;
    this.#linkAttachment = linkAttachment;
    this.#replaceAttachmentIndex = replaceAttachmentIndex;
    this.#createAttachmentIndex = createAttachmentIndex;
  }

  async list() {
    await this.#ensureRoot();
    let entries;
    try {
      entries = await readdir(this.#root, { withFileTypes: true });
    } catch (error) {
      throw storeError('CORE_PROJECT_STORAGE_ERROR', '无法读取本地项目列表。', error);
    }
    const ids = entries
      .map((entry) => entry.name.match(/^([0-9a-f-]{36})\.json$/iu)?.[1])
      .filter((id) => typeof id === 'string' && PROJECT_ID_PATTERN.test(id));
    const projects = [];
    for (const id of ids) {
      const project = await this.#readProject(id);
      projects.push({ id: project.id, name: project.name, updatedAt: project.updatedAt });
    }
    return projects.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name));
  }

  async create(name) {
    const normalizedName = validateName(name);
    const now = new Date().toISOString();
    const project = {
      format: PROJECT_FORMAT,
      schemaVersion: SCHEMA_VERSION,
      id: randomUUID(),
      name: normalizedName,
      createdAt: now,
      updatedAt: now,
      notes: ''
    };
    await this.#writeProject(project, true);
    return project;
  }

  async open(id) {
    return this.#readProject(validateId(id));
  }

  async save(input) {
    if (!hasExactKeys(input, EXPECTED_SAVE_KEYS)) {
      throw storeError('CORE_PROJECT_INVALID', '保存请求字段无效。');
    }
    const id = validateId(input.id);
    const name = validateName(input.name);
    const notes = validateNotes(input.notes);
    return this.#withProjectLock(id, async () => {
      const existing = await this.#readProject(id);
      const updated = validateProject({
        ...existing,
        name,
        notes,
        updatedAt: new Date().toISOString()
      });
      await this.#writeProject(updated, false);
      return updated;
    });
  }

  async addCadPreviewAttachment(projectId, name, extension, inputBytes) {
    const id = validateId(projectId);
    const normalizedExtension = validateAttachmentExtension(extension);
    const normalizedName = validateAttachmentName(name, normalizedExtension);
    const bytes = copyAttachmentBytes(inputBytes);
    // Parse the exact byte snapshot in the main-process store before any attachment path is created.
    parseCadPreview(bytes, normalizedExtension);
    const sha256 = bytesHash(bytes);

    return this.#withProjectLock(id, async () => {
      await this.#readProject(id);
      await this.#ensureAttachmentDirectory(id);
      const indexState = await this.#readAttachmentIndex(id);
      const existing = indexState.index.attachments.find((attachment) => attachment.sha256 === sha256);
      if (existing) {
        await this.#readAttachmentObject(id, existing);
        return { ...existing };
      }
      if (indexState.index.attachments.length >= MAX_ATTACHMENT_COUNT) {
        throw storeError('CORE_ATTACHMENT_LIMIT_REACHED', '该项目的 CAD 预览附件已达到数量上限。');
      }

      const attachment = {
        sha256,
        extension: normalizedExtension,
        name: normalizedName,
        byteLength: bytes.byteLength,
        addedAt: new Date().toISOString()
      };
      const objectPath = this.#attachmentObjectPath(id, sha256);
      await this.#createOrVerifyAttachmentObject(objectPath, bytes, sha256);
      const nextIndex = validateAttachmentIndex({
        ...indexState.index,
        attachments: [...indexState.index.attachments, attachment]
      }, id);
      await this.#writeAttachmentIndex(id, nextIndex, !indexState.exists);
      return { ...attachment };
    });
  }

  async listCadPreviewAttachments(projectId) {
    const id = validateId(projectId);
    await this.#readProject(id);
    const { index } = await this.#readAttachmentIndex(id);
    for (const attachment of index.attachments) await this.#assertAttachmentObjectExists(id, attachment);
    return index.attachments.map((attachment) => ({ ...attachment }));
  }

  async openCadPreviewAttachment(projectId, sha256Input) {
    const id = validateId(projectId);
    if (typeof sha256Input !== 'string' || !SHA256_PATTERN.test(sha256Input)) {
      throw storeError('CORE_ATTACHMENT_INVALID', '附件内容标识无效。');
    }
    const sha256 = sha256Input.toLowerCase();
    await this.#readProject(id);
    const { index } = await this.#readAttachmentIndex(id);
    const attachment = index.attachments.find((candidate) => candidate.sha256 === sha256);
    if (!attachment) throw storeError('CORE_ATTACHMENT_NOT_FOUND', '找不到该项目附件。');
    const bytes = await this.#readAttachmentObject(id, attachment);
    parseCadPreview(bytes, attachment.extension);
    return { ...attachment, bytes };
  }

  async #withProjectLock(id, operation) {
    const previous = this.#locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.#locks.set(id, current);
    try {
      return await current;
    } finally {
      if (this.#locks.get(id) === current) this.#locks.delete(id);
    }
  }

  async #ensureRoot() {
    try {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      const info = await lstat(this.#root);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw storeError('CORE_PROJECT_STORAGE_ERROR', '本地项目存储目录不可用。');
      }
    } catch (error) {
      if (error?.code === 'CORE_PROJECT_STORAGE_ERROR') throw error;
      throw storeError('CORE_PROJECT_STORAGE_ERROR', '无法访问本地项目存储目录。', error);
    }
  }

  #projectPath(id) {
    return join(this.#root, `${validateId(id)}.json`);
  }

  #attachmentDirectory(id) {
    return join(this.#root, validateId(id), 'attachments');
  }

  #attachmentIndexPath(id) {
    return join(this.#attachmentDirectory(id), 'index-v1.json');
  }

  #attachmentObjectPath(id, sha256) {
    if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
      throw storeError('CORE_ATTACHMENT_INVALID', '附件内容摘要无效。');
    }
    return join(this.#attachmentDirectory(id), sha256);
  }

  async #ensureDirectory(path, code, message) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw storeError(code, message, error);
    }
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw storeError(code, message);
    } catch (error) {
      if (error?.code === code) throw error;
      throw storeError(code, message, error);
    }
  }

  async #ensureAttachmentDirectory(id) {
    await this.#ensureRoot();
    const projectDirectory = join(this.#root, validateId(id));
    await this.#ensureDirectory(projectDirectory, 'CORE_ATTACHMENT_STORAGE_ERROR', '项目附件目录不可用。');
    await this.#ensureDirectory(join(projectDirectory, 'attachments'), 'CORE_ATTACHMENT_STORAGE_ERROR', '项目附件目录不可用。');
  }

  async #existingAttachmentDirectory(id) {
    await this.#ensureRoot();
    const projectDirectory = join(this.#root, validateId(id));
    let projectInfo;
    try {
      projectInfo = await lstat(projectDirectory);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw storeError('CORE_ATTACHMENT_STORAGE_ERROR', '无法检查项目附件目录。', error);
    }
    if (!projectInfo.isDirectory() || projectInfo.isSymbolicLink()) {
      throw storeError('CORE_ATTACHMENT_STORAGE_ERROR', '项目附件目录不可用。');
    }
    const attachmentDirectory = join(projectDirectory, 'attachments');
    try {
      const info = await lstat(attachmentDirectory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw storeError('CORE_ATTACHMENT_STORAGE_ERROR', '项目附件目录不可用。');
      return attachmentDirectory;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error?.code === 'CORE_ATTACHMENT_STORAGE_ERROR') throw error;
      throw storeError('CORE_ATTACHMENT_STORAGE_ERROR', '无法检查项目附件目录。', error);
    }
  }

  async #readAttachmentIndex(id) {
    const attachmentDirectory = await this.#existingAttachmentDirectory(id);
    if (!attachmentDirectory) {
      return {
        exists: false,
        index: { format: ATTACHMENT_INDEX_FORMAT, schemaVersion: ATTACHMENT_INDEX_SCHEMA_VERSION, projectId: id, attachments: [] }
      };
    }
    const indexPath = this.#attachmentIndexPath(id);
    let info;
    try {
      info = await lstat(indexPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return {
          exists: false,
          index: { format: ATTACHMENT_INDEX_FORMAT, schemaVersion: ATTACHMENT_INDEX_SCHEMA_VERSION, projectId: id, attachments: [] }
        };
      }
      throw storeError('CORE_ATTACHMENT_STORAGE_ERROR', '无法检查项目附件索引。', error);
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ATTACHMENT_INDEX_BYTES) {
      throw storeError('CORE_ATTACHMENT_INDEX_CORRUPT', '项目附件索引类型或大小无效；现有数据未修改。');
    }
    let text;
    try {
      const bytes = await readSafeFileSnapshot(
        indexPath,
        MAX_ATTACHMENT_INDEX_BYTES,
        'CORE_ATTACHMENT_INDEX_CORRUPT',
        '项目附件索引读取时发生变化或类型/大小无效；现有数据未修改。'
      );
      text = bytes.toString('utf8');
    } catch (error) {
      if (error?.code?.startsWith?.('CORE_ATTACHMENT_')) throw error;
      throw storeError('CORE_ATTACHMENT_STORAGE_ERROR', '无法读取项目附件索引。', error);
    }
    try {
      return { exists: true, index: validateAttachmentIndex(JSON.parse(text), id) };
    } catch (error) {
      if (error?.code === 'CORE_ATTACHMENT_INDEX_CORRUPT') throw error;
      throw storeError('CORE_ATTACHMENT_INDEX_CORRUPT', '项目附件索引格式无效或已损坏；现有数据未修改。', error);
    }
  }

  async #assertAttachmentObjectExists(id, attachment) {
    const objectPath = this.#attachmentObjectPath(id, attachment.sha256);
    let info;
    try {
      info = await lstat(objectPath);
    } catch (error) {
      throw storeError('CORE_ATTACHMENT_CORRUPT', '项目附件对象缺失或无法检查；现有数据未修改。', error);
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size !== attachment.byteLength || info.size > CAD_PREVIEW_MAX_BYTES) {
      throw storeError('CORE_ATTACHMENT_CORRUPT', '项目附件对象类型或大小无效；现有数据未修改。');
    }
  }

  async #readAttachmentObject(id, attachment) {
    const objectPath = this.#attachmentObjectPath(id, attachment.sha256);
    const bytes = await readSafeFileSnapshot(
      objectPath,
      CAD_PREVIEW_MAX_BYTES,
      'CORE_ATTACHMENT_CORRUPT',
      '项目附件对象在读取期间发生变化或类型/大小无效；现有数据未修改。'
    );
    if (bytes.byteLength !== attachment.byteLength || bytesHash(bytes) !== attachment.sha256) {
      throw storeError('CORE_ATTACHMENT_CORRUPT', '项目附件对象大小或 SHA-256 校验失败；现有数据未修改。');
    }
    return bytes;
  }

  async #createOrVerifyAttachmentObject(objectPath, bytes, sha256) {
    try {
      const existing = await lstat(objectPath);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== bytes.byteLength || existing.size > CAD_PREVIEW_MAX_BYTES) {
        throw storeError('CORE_ATTACHMENT_CORRUPT', '已存在的内容寻址附件对象类型或大小无效；未覆盖对象。');
      }
      const existingBytes = await readSafeFileSnapshot(
        objectPath,
        CAD_PREVIEW_MAX_BYTES,
        'CORE_ATTACHMENT_CORRUPT',
        '已存在的内容寻址附件对象读取不安全；未覆盖对象。'
      );
      if (bytesHash(existingBytes) !== sha256 || !existingBytes.equals(bytes)) {
        throw storeError('CORE_ATTACHMENT_CORRUPT', '已存在的内容寻址附件对象与摘要不一致；未覆盖对象。');
      }
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error?.code?.startsWith?.('CORE_ATTACHMENT_')) throw error;
        throw storeError('CORE_ATTACHMENT_STORAGE_ERROR', '无法检查既有附件对象；未覆盖对象。', error);
      }
    }

    const directory = dirname(objectPath);
    const temporaryPath = join(directory, `.${sha256}.${randomUUID()}.tmp`);
    let fileHandle;
    try {
      fileHandle = await open(temporaryPath, 'wx', 0o600);
      await fileHandle.writeFile(bytes);
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = undefined;
      try {
        await this.#linkAttachment(temporaryPath, objectPath);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await lstat(objectPath);
        if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== bytes.byteLength) {
          throw storeError('CORE_ATTACHMENT_CORRUPT', '并发创建的附件对象类型或大小无效；未覆盖对象。', error);
        }
        const existingBytes = await readSafeFileSnapshot(
          objectPath,
          CAD_PREVIEW_MAX_BYTES,
          'CORE_ATTACHMENT_CORRUPT',
          '并发创建的附件对象读取不安全；未覆盖对象。'
        );
        if (bytesHash(existingBytes) !== sha256 || !existingBytes.equals(bytes)) {
          throw storeError('CORE_ATTACHMENT_CORRUPT', '并发创建的附件对象与 SHA-256 不一致；未覆盖对象。', error);
        }
      }
    } catch (error) {
      if (error?.code?.startsWith?.('CORE_ATTACHMENT_')) throw error;
      throw storeError('CORE_ATTACHMENT_COPY_FAILED', '无法安全创建不可变附件对象；现有附件未修改。', error);
    } finally {
      if (fileHandle) {
        try { await fileHandle.close(); } catch {}
      }
      try { await unlink(temporaryPath); } catch (error) {
        if (error?.code !== 'ENOENT') {
          // A private temporary file is never indexed; the committed content object remains immutable.
        }
      }
    }
  }

  async #writeAttachmentIndex(id, index, createOnly) {
    await this.#ensureAttachmentDirectory(id);
    const targetPath = this.#attachmentIndexPath(id);
    if (!createOnly) {
      let existing;
      try {
        existing = await lstat(targetPath);
      } catch (error) {
        throw storeError('CORE_ATTACHMENT_INDEX_WRITE_FAILED', '无法确认附件索引状态；原索引保持不变。', error);
      }
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw storeError('CORE_ATTACHMENT_INDEX_CORRUPT', '附件索引类型无效；原数据未修改。');
      }
    } else {
      try {
        await lstat(targetPath);
        throw storeError('CORE_ATTACHMENT_INDEX_WRITE_FAILED', '附件索引已被其他写入创建；未覆盖原索引。');
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'CORE_ATTACHMENT_INDEX_WRITE_FAILED') {
          throw storeError('CORE_ATTACHMENT_INDEX_WRITE_FAILED', '无法确认附件索引状态；原索引保持不变。', error);
        }
        if (error?.code === 'CORE_ATTACHMENT_INDEX_WRITE_FAILED') throw error;
      }
    }

    const temporaryPath = join(this.#attachmentDirectory(id), `.index-v1.${randomUUID()}.tmp`);
    let fileHandle;
    try {
      fileHandle = await open(temporaryPath, 'wx', 0o600);
      await fileHandle.writeFile(`${JSON.stringify(index, null, 2)}\n`, 'utf8');
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = undefined;
      if (createOnly) await this.#createAttachmentIndex(temporaryPath, targetPath);
      else await this.#replaceAttachmentIndex(temporaryPath, targetPath);
    } catch (error) {
      throw storeError('CORE_ATTACHMENT_INDEX_WRITE_FAILED', '附件索引提交失败；先前索引和已登记附件保持不变。', error);
    } finally {
      if (fileHandle) {
        try { await fileHandle.close(); } catch {}
      }
      try { await unlink(temporaryPath); } catch (error) {
        if (error?.code !== 'ENOENT') {
          // The committed index remains valid; an ignored private temp file cannot be opened as an attachment.
        }
      }
    }
  }

  async #readProject(id) {
    await this.#ensureRoot();
    const filePath = this.#projectPath(id);
    let info;
    try {
      info = await lstat(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') throw storeError('CORE_PROJECT_NOT_FOUND', '找不到该项目。', error);
      throw storeError('CORE_PROJECT_STORAGE_ERROR', '无法读取本地项目。', error);
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) {
      throw storeError('CORE_PROJECT_CORRUPT', '工程文件类型或大小无效；原数据未修改。');
    }
    let text;
    try {
      text = await readFile(filePath, 'utf8');
    } catch (error) {
      throw storeError('CORE_PROJECT_STORAGE_ERROR', '无法读取本地项目。', error);
    }
    try {
      const project = validateProject(JSON.parse(text));
      if (project.id !== validateId(id)) throw storeError('CORE_PROJECT_CORRUPT', '工程文件标识与存储位置不匹配；原数据未修改。');
      return project;
    } catch (error) {
      if (error?.code === 'CORE_PROJECT_CORRUPT') throw error;
      throw storeError('CORE_PROJECT_CORRUPT', '工程文件格式无效、已损坏或版本不受支持；原数据未修改。', error);
    }
  }

  async #writeProject(project, createOnly) {
    await this.#ensureRoot();
    const targetPath = this.#projectPath(project.id);
    if (createOnly) {
      try {
        const existing = await lstat(targetPath);
        if (existing) throw storeError('CORE_PROJECT_ALREADY_EXISTS', '该项目标识已存在，未覆盖原数据。');
      } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'CORE_PROJECT_ALREADY_EXISTS') {
          throw storeError('CORE_PROJECT_STORAGE_ERROR', '无法确认项目文件状态。', error);
        }
        if (error?.code === 'CORE_PROJECT_ALREADY_EXISTS') throw error;
      }
    } else {
      let existing;
      try {
        existing = await lstat(targetPath);
      } catch (error) {
        if (error?.code === 'ENOENT') throw storeError('CORE_PROJECT_NOT_FOUND', '找不到该项目。', error);
        throw storeError('CORE_PROJECT_STORAGE_ERROR', '无法确认项目文件状态。', error);
      }
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw storeError('CORE_PROJECT_CORRUPT', '工程文件类型无效；原数据未修改。');
      }
    }

    const temporaryPath = join(this.#root, `.${project.id}.${randomUUID()}.tmp`);
    let fileHandle;
    let committed = false;
    try {
      fileHandle = await open(temporaryPath, 'wx', 0o600);
      await fileHandle.writeFile(`${JSON.stringify(project, null, 2)}\n`, 'utf8');
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = undefined;
      if (createOnly) await this.#createHardLink(temporaryPath, targetPath);
      else await this.#replaceFile(temporaryPath, targetPath);
      committed = true;
    } catch (error) {
      if (error?.code === 'EEXIST' && createOnly) {
        throw storeError('CORE_PROJECT_ALREADY_EXISTS', '该项目标识已存在，未覆盖原数据。', error);
      }
      throw storeError('CORE_PROJECT_WRITE_FAILED', '项目保存失败；已保存版本保持不变。', error);
    } finally {
      if (fileHandle) {
        try { await fileHandle.close(); } catch {}
      }
      try { await unlink(temporaryPath); } catch (error) {
        if (error?.code !== 'ENOENT' && committed) {
          // The committed project remains valid; a leftover private temp file is ignored by the store.
        }
      }
    }
  }
}

export const CORE_PROJECT_SCHEMA_VERSION = SCHEMA_VERSION;
export const CORE_PROJECT_ATTACHMENT_SCHEMA_VERSION = ATTACHMENT_INDEX_SCHEMA_VERSION;
