/**
 * 工程库（项目下拉的数据源）。
 *
 * 一个整机模型 = 一个目录：userData/projects/<id>/
 *   project.json   名称/机型/参数/质量/零件数/创建时间
 *   model.step     合并实体（给外部 CAD 用）
 *   model.stl      合并网格
 *   parts/NN-*.stl 逐件网格（重新打开时按零件装配，零件树/干涉检查才有意义）
 *
 * 只存内核真实产出的文件，不做二次建模。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { validateMachineDesign } from '../src/machine/store.ts';
import { validateMachineConfig } from '../src/commission/machine-config.ts';
import { parseProjectLayoutPlacements } from '../src/design/project-layout.ts';
import { buildProjectLayoutValidationView } from '../src/design/project-layout-validation.ts';
import { isProjectGeometryReview, type ProjectGeometryReview } from '../src/design/geometry-review.ts';
import type { Placement } from '../src/enclosure/layout.ts';
import { parseProjectSnapshot, type ProjectSnapshot } from '../src/project-session/snapshot.ts';

export interface ProjectRecord {
  id: string;
  name: string;
  process: string;
  params: Record<string, number>;
  parts: number;
  massKg: number | null;
  envelope: [number, number, number] | null;
  material: string[];
  createdAt: string;
  /**
   * 单件网格：file 是 parts/ 下的文件名，name 是零件名（零件树显示用）。
   * `color` 是材质标识色（'#rrggbb'）：STL 不带颜色，重新打开工程时靠它把四色装配回去，
   * 否则「刚建完有色、关了再开变灰」。
   */
  partsList: Array<{ file: string; name: string; color?: string }>;
  hasStep: boolean;
  hasStl: boolean;
  design?: unknown;
  geometryReview?: ProjectGeometryReview;
  bytes: number;
}

export interface ProjectSaveInput {
  name: string;
  process: string;
  params?: Record<string, number>;
  parts: number;
  massKg?: number | null;
  envelope?: [number, number, number] | null;
  material?: string[];
  stepPath?: string | null;
  stlPath?: string | null;
  partPaths?: Array<{ name: string; path: string; color?: string }>;
  design?: unknown;
  config?: unknown;
  geometryReview?: ProjectGeometryReview;
  stlData?: Uint8Array;
  partData?: Array<{ name: string; data: Uint8Array; path?: string[] }>;
  placements?: unknown[];
  workspace?: unknown;
}

export interface ProjectOpenResult {
  ok: boolean;
  record?: ProjectRecord;
  workspace?: ProjectSnapshot;
  workspaceMessage?: string;
  /** 只从 design.json 恢复的二维毫米坐标；旧工程或损坏数据返回空数组。 */
  placements?: Placement[];
  /** 仅当 design.json、机器设计与 placements 均有效时才允许修改。 */
  layoutEditable?: boolean;
  /** 原始 design.json 内容的 SHA-256；布局写回时作为并发版本令牌。 */
  layoutFingerprint?: string;
  layoutMessage?: string;
  /** 逐件 STL 的绝对路径，按零件序 */
  partPaths?: Array<{ name: string; path: string }>;
  stepPath?: string | null;
  message?: string;
}

const MAX_PROJECTS = 200;

export function projectsRoot(userDataDir: string): string {
  return join(userDataDir, 'projects');
}

function sanitizeId(value: string): string {
  const safe = value.replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return safe || 'project';
}

function projectDir(userDataDir: string, id: string): string {
  return join(projectsRoot(userDataDir), sanitizeId(id));
}

function readRecord(dir: string): ProjectRecord | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as ProjectRecord;
    if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string' || raw.id !== basename(dir) || sanitizeId(raw.id) !== raw.id) return null;
    if (!Array.isArray(raw.partsList) || raw.partsList.some((item) => !item || typeof item.name !== 'string' ||
      typeof item.file !== 'string' || !item.file || item.file === '.' || item.file === '..' || item.file.includes('/') || item.file.includes('\\'))) return null;
    if (raw.geometryReview !== undefined && !isProjectGeometryReview(raw.geometryReview)) return null;
    return raw;
  } catch {
    return null;
  }
}

interface ProjectLayoutSnapshot {
  content: string;
  document: Record<string, unknown>;
  placements: Placement[];
  fingerprint: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fingerprint(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function readProjectLayoutSnapshot(dir: string): { snapshot?: ProjectLayoutSnapshot; message?: string } {
  const path = join(dir, 'design.json');
  if (!existsSync(path)) return { message: '该工程没有保存的二维布局（旧工程）' };
  try {
    const bytes = readFileSync(path);
    const content = bytes.toString('utf8');
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed) || !Object.hasOwn(parsed, 'design')) {
      return { message: 'design.json 结构无效，已禁用布局编辑以保护工程文件' };
    }
    try {
      validateMachineDesign(parsed.design);
    } catch {
      return { message: 'design.json 中的机器设计数据无效，已禁用布局编辑以保护工程文件' };
    }
    if (!Array.isArray(parsed.placements)) {
      return { message: 'design.json 中没有有效的二维布局数据，已禁用布局编辑以保护工程文件' };
    }
    const placements = parseProjectLayoutPlacements(parsed.placements);
    if (!placements) return { message: 'design.json 中的布局数据损坏或坐标超出范围，已禁用编辑以保护工程文件' };
    return { snapshot: { content, document: parsed, placements, fingerprint: fingerprint(bytes) } };
  } catch {
    return { message: 'design.json 无法读取或已损坏，已禁用布局编辑以保护工程文件' };
  }
}

/** 列出全部工程，按创建时间倒序（新的在前）。 */
export function listProjects(userDataDir: string): ProjectRecord[] {
  recoverProjectSwaps(userDataDir);
  const root = projectsRoot(userDataDir);
  if (!existsSync(root)) return [];
  const records: ProjectRecord[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const record = readRecord(join(root, entry.name));
    if (record) records.push(record);
  }
  records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return records.slice(0, MAX_PROJECTS);
}

interface ProjectSwap {
  id: string;
  stage: string;
  backup: string;
}

/** A journal exists only after the entire replacement directory is ready.
 * Missing live directory means interruption before publication: restore the old
 * directory (or discard an unpublished first save). A live directory wins after
 * publication. Never expose stage/backup directories in the project list.
 */
function recoverProjectSwaps(userDataDir: string): void {
  const root = projectsRoot(userDataDir);
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith('.project-swap-') || !entry.endsWith('.json')) continue;
    const journal = join(root, entry);
    const swap = JSON.parse(readFileSync(journal, 'utf8')) as ProjectSwap;
    if (typeof swap.id !== 'string' || sanitizeId(swap.id) !== swap.id ||
        entry !== `.project-swap-${swap.id}.json` ||
        typeof swap.stage !== 'string' || !/^\.project-stage-[a-f0-9-]+$/.test(swap.stage) ||
        typeof swap.backup !== 'string' || !/^\.project-backup-[a-f0-9-]+$/.test(swap.backup)) {
      throw new Error('工程保存恢复日志无效');
    }
    const dir = join(root, swap.id);
    const backup = join(root, swap.backup);
    if (!existsSync(dir) && existsSync(backup)) renameSync(backup, dir);
    rmSync(join(root, swap.stage), { recursive: true, force: true });
    rmSync(backup, { recursive: true, force: true });
    rmSync(journal, { force: true });
  }
}

function savedProjectId(userDataDir: string, name: string): string {
  const root = projectsRoot(userDataDir);
  const base = sanitizeId(name);
  // Retain legacy IDs and same-name overwrite behavior, including names whose
  // sanitized forms collide. Compare case-insensitively for Windows filesystems.
  const entries = existsSync(root) ? readdirSync(root).filter((entry) => !entry.startsWith('.')) : [];
  for (const entry of entries) {
    if (sanitizeId(entry) === entry && readRecord(join(root, entry))?.name === name) return entry;
  }
  const occupied = new Set(entries.map((entry) => entry.toLowerCase()));
  if (!occupied.has(base.toLowerCase())) return base;
  const suffix = createHash('sha256').update(name).digest('hex').slice(0, 12);
  const hashed = `${base.slice(0, 35)}-${suffix}`;
  let id = hashed;
  for (let index = 2; occupied.has(id.toLowerCase()); index++) id = `${hashed.slice(0, 40)}-${index}`;
  return id;
}

/** 同名工程覆盖；先生成完整目录，再通过可恢复的目录交换发布。 */
export function saveProject(userDataDir: string, input: ProjectSaveInput): { ok: boolean; record?: ProjectRecord; message?: string } {
  let stage: string | undefined;
  let journal: string | undefined;
  let published = false;
  try {
    if (!input || typeof input.name !== 'string' || !input.name.trim()) throw new Error('工程名不能为空');
    const name = input.name.trim();
    const validatedDesign = input.design === undefined ? undefined : validateMachineDesign(input.design);
    const workspace = input.workspace === undefined ? undefined : parseProjectSnapshot(input.workspace);
    /**
     * `config` 以前只校验、不落盘：只给 config 的调用方（例如缓存塔按
     * `design.config.bufferTower` 建模、手上只有一份 config）以为参数进库了，
     * 重开却什么都没有。现在 config 会被包成 `{ config }` 存进 design.json /
     * project.json；`design` 在场时仍以 design 为准（它带工位身份与点位）。
     */
    const validatedConfig = input.config === undefined ? undefined : validateMachineConfig(input.config);
    const designDocument = validatedDesign ?? (validatedConfig ? { config: validatedConfig } : undefined);
    if (input.geometryReview !== undefined && !isProjectGeometryReview(input.geometryReview)) throw new Error('3D/干涉校核状态无效，工程未保存');
    if (input.placements !== undefined && !parseProjectLayoutPlacements(input.placements)) throw new Error('二维布局数据无效');
    if (input.parts !== undefined && (!Number.isInteger(input.parts) || input.parts < 0)) throw new Error('零件数量无效');
    if (input.massKg != null && (typeof input.massKg !== 'number' || !Number.isFinite(input.massKg) || input.massKg < 0)) throw new Error('工程质量无效');
    if (input.envelope != null && (!Array.isArray(input.envelope) || input.envelope.length !== 3 || input.envelope.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n <= 0))) throw new Error('工程包络尺寸无效');
    if (input.material !== undefined && (!Array.isArray(input.material) || input.material.some((item) => typeof item !== 'string'))) throw new Error('工程材料无效');
    if (input.partPaths !== undefined && !Array.isArray(input.partPaths)) throw new Error('零件路径无效');
    if (input.partData !== undefined && !Array.isArray(input.partData)) throw new Error('零件数据无效');
    const validateData = (data: Uint8Array): void => {
      if (!(data instanceof Uint8Array) || !data.byteLength) throw new Error('STL 数据无效');
    };
    // Restore interrupted overwrites before resolving sources which may point
    // into the project's own previous directory.
    recoverProjectSwaps(userDataDir);
    const validateSource = (path: string): void => {
      if (typeof path !== 'string' || !path || !statSync(path).isFile() || statSync(path).size === 0) throw new Error(`模型文件无效：${path}`);
    };
    if (input.stepPath != null) validateSource(input.stepPath);
    if (input.stlPath != null) validateSource(input.stlPath);
    if (input.stlData !== undefined) validateData(input.stlData);
    for (const item of input.partPaths ?? []) {
      if (!item || typeof item.name !== 'string') throw new Error('零件名称无效');
      validateSource(item.path);
    }
    for (const item of input.partData ?? []) {
      if (!item || typeof item.name !== 'string') throw new Error('零件名称无效');
      validateData(item.data);
    }

    recoverProjectSwaps(userDataDir);
    const root = projectsRoot(userDataDir);
    mkdirSync(root, { recursive: true });
    const id = savedProjectId(userDataDir, name);
    const dir = join(root, id);
    const token = randomUUID();
    const swap: ProjectSwap = { id, stage: `.project-stage-${token}`, backup: `.project-backup-${token}` };
    stage = join(root, swap.stage);
    mkdirSync(join(stage, 'parts'), { recursive: true });
    const partsList: Array<{ file: string; name: string; path?: string[]; color?: string }> = [];
    // Prefixes ensure uniqueness even for identical, truncated, case-folded or
    // sanitized names, across both source collections.
    const partFile = (name: string): string => `${String(partsList.length + 1).padStart(4, '0')}-${sanitizeId(name.replace(/\.stl$/i, ''))}.stl`;
    for (const item of input.partPaths ?? []) {
      const file = partFile(item.name || basename(item.path));
      copyFileSync(item.path, join(stage, 'parts', file));
      const color = typeof item.color === 'string' && /^#[0-9a-f]{6}$/i.test(item.color) ? item.color.toLowerCase() : undefined;
      partsList.push({ file, name: item.name, ...(color ? { color } : {}) });
    }
    for (const item of input.partData ?? []) {
      const file = partFile(item.name);
      writeFileSync(join(stage, 'parts', file), item.data);
      // Preserve existing tolerant hierarchy/color normalization.
      const path = Array.isArray(item.path) ? item.path.filter((segment): segment is string => typeof segment === 'string')
        .map((segment) => segment.trim().slice(0, 60)).filter(Boolean).slice(0, 8) : [];
      partsList.push({ file, name: item.name, ...(path.length ? { path } : {}) });
    }
    if (input.stepPath) copyFileSync(input.stepPath, join(stage, 'model.step'));
    if (input.stlPath) copyFileSync(input.stlPath, join(stage, 'model.stl'));
    if (input.stlData !== undefined) writeFileSync(join(stage, 'model.stl'), input.stlData);
    if (designDocument) writeFileSync(join(stage, 'design.json'), `${JSON.stringify({ design: designDocument, placements: input.placements ?? [] }, null, 2)}\n`, 'utf8');
    if (workspace) writeFileSync(join(stage, 'workspace.json'), `${JSON.stringify(workspace, null, 2)}\n`, 'utf8');
    const record: ProjectRecord = {
      id, name, process: String(input.process ?? 'unknown'),
      params: Object.fromEntries(Object.entries(input.params ?? {}).filter(([, value]) => typeof value === 'number' && Number.isFinite(value))),
      parts: input.parts ?? partsList.length,
      massKg: input.massKg ?? null, envelope: input.envelope ?? null, material: input.material ?? [],
      createdAt: new Date().toISOString(), partsList,
      hasStep: Boolean(input.stepPath), hasStl: Boolean(input.stlPath || input.stlData),
      ...(designDocument ? { design: designDocument } : {}),
      ...(input.geometryReview ? { geometryReview: input.geometryReview } : {}),
      bytes: directoryBytes(stage)
    };
    writeFileSync(join(stage, 'project.json'), JSON.stringify(record, null, 2), 'utf8');
    // Publish a fully written journal atomically: interruption while writing
    // must not leave a truncated recovery document next to a live project.
    const journalPath = join(root, `.project-swap-${id}.json`);
    const preparedJournal = join(stage, '.swap.json');
    writeFileSync(preparedJournal, JSON.stringify(swap), { encoding: 'utf8', flag: 'wx' });
    renameSync(preparedJournal, journalPath);
    journal = journalPath;
    if (existsSync(dir)) renameSync(dir, join(root, swap.backup));
    renameSync(stage, dir);
    published = true;
    stage = undefined;
    // Once published, cleanup errors must not report a failed save. The journal
    // retains enough information for the next access to finish cleanup.
    try { recoverProjectSwaps(userDataDir); } catch { /* retry on next access */ }
    return { ok: true, record };
  } catch (error) {
    if (journal && !published) {
      try { recoverProjectSwaps(userDataDir); } catch { /* keep journal/backup for later recovery */ }
    }
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    if (stage && !journal) {
      try { rmSync(stage, { recursive: true, force: true }); } catch { /* unpublished hidden staging directory */ }
    }
  }
}

export function openProject(userDataDir: string, id: string): ProjectOpenResult {
  try { recoverProjectSwaps(userDataDir); } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const dir = projectDir(userDataDir, id);
  const record = readRecord(dir);
  if (!record) return { ok: false, message: `工程「${id}」不存在或已损坏` };
  const partsDir = join(dir, 'parts');
  const partPaths: Array<{ name: string; path: string; color?: string }> = [];
  // partsList 的顺序就是零件序，名字来自保存时记录（零件树要显示中文名）
  for (const entry of record.partsList ?? []) {
    const path = join(partsDir, entry.file);
    if (!existsSync(path)) return { ok: false, message: `工程零件文件缺失：${entry.file}` };
    partPaths.push({ name: entry.name, path, ...(entry.color ? { color: entry.color } : {}) });
  }
  const stepPath = join(dir, 'model.step');
  const layout = readProjectLayoutSnapshot(dir);
  let workspace: ProjectSnapshot | undefined;
  let workspaceMessage: string | undefined;
  if (existsSync(join(dir, 'workspace.json'))) {
    try { workspace = parseProjectSnapshot(JSON.parse(readFileSync(join(dir, 'workspace.json'), 'utf8'))); }
    catch { workspaceMessage = '工程工作区快照损坏，无法恢复编辑状态'; }
  }
  return {
    ok: true,
    record,
    ...(workspace ? { workspace } : {}),
    ...(workspaceMessage ? { workspaceMessage } : {}),
    placements: layout.snapshot?.placements ?? [],
    layoutEditable: Boolean(layout.snapshot),
    ...(layout.snapshot ? { layoutFingerprint: layout.snapshot.fingerprint } : {}),
    ...(layout.message ? { layoutMessage: layout.message } : {}),
    partPaths,
    stepPath: existsSync(stepPath) ? stepPath : null
  };
}

export interface ProjectLayoutSaveResult {
  ok: boolean;
  /** fingerprint 冲突时为 true；调用方应提示用户重新载入，不可自动覆盖。 */
  conflict?: boolean;
  fingerprint?: string;
  message?: string;
}

function samePlacementIdentityAndMetadata(a: Placement, b: Placement): boolean {
  return a.id === b.id && a.partId === b.partId && a.model === b.model && a.w === b.w && a.h === b.h &&
    a.railId === b.railId && a.tag === b.tag && a.qty === b.qty && a.note === b.note;
}

/** 仅允许改动已有 placement 的 x/y；原始 design/schema 与其它布局字段逐字保留。 */
export function saveProjectLayout(
  userDataDir: string,
  id: string,
  expectedFingerprint: string,
  proposedPlacements: unknown
): ProjectLayoutSaveResult {
  if (!/^[a-f0-9]{64}$/i.test(expectedFingerprint)) return { ok: false, message: '布局版本指纹无效，请重新打开工程布局' };
  try { recoverProjectSwaps(userDataDir); } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const dir = projectDir(userDataDir, id);
  const path = join(dir, 'design.json');
  const current = readProjectLayoutSnapshot(dir);
  if (!current.snapshot) {
    try {
      if (fingerprint(readFileSync(path)) !== expectedFingerprint) {
        return { ok: false, conflict: true, message: '工程设计文件已变化或损坏；为避免覆盖，保存已拒绝，请重新载入最新工程' };
      }
    } catch {
      return { ok: false, conflict: true, message: '工程设计文件已删除或不可读取；保存已拒绝，请重新载入工程' };
    }
    return { ok: false, message: current.message ?? '工程布局不可编辑' };
  }
  if (current.snapshot.fingerprint !== expectedFingerprint) {
    return { ok: false, conflict: true, message: '工程布局已被其他操作修改；为避免覆盖，保存已拒绝，请重新载入最新布局' };
  }
  const proposed = parseProjectLayoutPlacements(proposedPlacements);
  if (!proposed) return { ok: false, message: '布局坐标无效或超出允许范围，未保存任何修改' };
  const saved = current.snapshot.placements;
  if (proposed.length !== saved.length || proposed.some((item, index) => !saved[index] || !samePlacementIdentityAndMetadata(saved[index]!, item))) {
    return { ok: false, message: '布局项目或非坐标字段已变化；仅允许编辑原有项目的 X/Y 坐标' };
  }
  const record = readRecord(dir);
  const validation = buildProjectLayoutValidationView(proposed, record?.envelope);
  if (validation.saveBlockReason === 'unknown-envelope') {
    return { ok: false, message: '项目包络尺寸缺失或无效，无法校验边界；布局未写回' };
  }
  if (validation.saveBlockReason === 'out-of-bounds') {
    return { ok: false, message: `布局有 ${validation.outOfBounds.length} 项超出项目包络，未写回` };
  }

  const originalPlacements = current.snapshot.document.placements;
  if (!Array.isArray(originalPlacements)) return { ok: false, message: '工程布局数据无效，未保存任何修改' };
  const placements = originalPlacements.map((raw, index) => {
    if (!isRecord(raw)) throw new Error('工程布局数据无效');
    return { ...raw, x: proposed[index]!.x, y: proposed[index]!.y };
  });
  const nextContent = `${JSON.stringify({ ...current.snapshot.document, placements }, null, 2)}\n`;
  const temporary = join(dir, `.design-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, nextContent, { encoding: 'utf8', flag: 'wx' });
    // 在原子替换之前再次校验，避免等待写临时文件期间覆盖另一个进程的更新。
    let latestContent: Uint8Array;
    try {
      latestContent = readFileSync(path);
    } catch {
      return { ok: false, conflict: true, message: '工程设计文件已不可读取；保存已拒绝，请重新载入工程' };
    }
    if (fingerprint(latestContent) !== expectedFingerprint) {
      return { ok: false, conflict: true, message: '工程布局已被其他操作修改；为避免覆盖，保存已拒绝，请重新载入最新布局' };
    }
    renameSync(temporary, path);
    return { ok: true, fingerprint: fingerprint(nextContent) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? `布局保存失败：${error.message}` : `布局保存失败：${String(error)}` };
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function deleteProject(userDataDir: string, id: string): { ok: boolean; message?: string } {
  try { recoverProjectSwaps(userDataDir); } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const dir = projectDir(userDataDir, id);
  if (!existsSync(dir)) return { ok: false, message: `工程「${id}」不存在` };
  try {
    rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function directoryBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += directoryBytes(path);
    else total += statSync(path).size;
  }
  return total;
}
