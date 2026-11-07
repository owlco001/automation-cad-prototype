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
}

export interface ProjectOpenResult {
  ok: boolean;
  record?: ProjectRecord;
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
    if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;
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
  const root = projectsRoot(userDataDir);
  if (!existsSync(root)) return [];
  const records: ProjectRecord[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const record = readRecord(join(root, entry.name));
    if (record) records.push(record);
  }
  records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return records.slice(0, MAX_PROJECTS);
}

/**
 * 保存一个工程。同名工程覆盖（id 由名字派生），保证下拉里不会堆一堆"皮带输送机-2-3"。
 */
export function saveProject(userDataDir: string, input: ProjectSaveInput): { ok: boolean; record?: ProjectRecord; message?: string } {
  const name = String(input.name ?? '').trim();
  if (!name) return { ok: false, message: '工程名不能为空' };
  const id = sanitizeId(name);
  const dir = projectDir(userDataDir, id);
  try {
    const validatedDesign = input.design === undefined ? undefined : validateMachineDesign(input.design);
    if (input.config !== undefined) validateMachineConfig(input.config);
    if (input.geometryReview !== undefined && !isProjectGeometryReview(input.geometryReview)) {
      return { ok: false, message: '3D/干涉校核状态无效，工程未保存' };
    }
    const temporaryParts = join(dir, `.parts-${process.pid}-${Date.now()}`);
    rmSync(temporaryParts, { recursive: true, force: true });
    mkdirSync(temporaryParts, { recursive: true });
    const stagedParts: Array<{ file: string; name: string }> = [];
    const stagePart = (name: string, data: Uint8Array): void => {
      const safe = sanitizeId(name.replace(/\.stl$/i, ''));
      const file = `${safe}.stl`;
      writeFileSync(join(temporaryParts, file), data);
      stagedParts.push({ file, name });
    };
    for (const item of input.partPaths ?? []) {
      if (!item?.path || !existsSync(item.path)) continue;
      stagePart(item.name || basename(item.path), readFileSync(item.path));
    }
    for (const item of input.partData ?? []) {
      if (!(item.data instanceof Uint8Array) || item.data.byteLength === 0) return { ok: false, message: `零件 ${item.name} STL 数据无效` };
      stagePart(item.name, item.data);
    }
    mkdirSync(join(dir, 'parts'), { recursive: true });
    for (const file of readdirSync(join(dir, 'parts'))) rmSync(join(dir, 'parts', file), { force: true });
    for (const item of stagedParts) renameSync(join(temporaryParts, item.file), join(dir, 'parts', item.file));
    rmSync(temporaryParts, { recursive: true, force: true });
    const partsList: Array<{ file: string; name: string; path?: string[]; color?: string }> = [];
    for (const item of input.partPaths ?? []) {
      if (!item?.path || !existsSync(item.path)) continue;
      const safe = sanitizeId(basename(item.path).replace(/\.stl$/i, ''));
      const target = join(dir, 'parts', `${safe}.stl`);
      copyFileSync(item.path, target);
      // 颜色只收 '#rrggbb'：脏数据（旧版工程没有这一项）就不写，读回来按默认色板处理
      const color = typeof item.color === 'string' && /^#[0-9a-f]{6}$/i.test(item.color) ? item.color.toLowerCase() : undefined;
      partsList.push({ file: `${safe}.stl`, name: String(item.name ?? safe), ...(color ? { color } : {}) });
    }
    for (const item of input.partData ?? []) {
      if (!(item.data instanceof Uint8Array) || item.data.byteLength === 0) return { ok: false, message: `零件 ${item.name} STL 数据无效` };
      const safe = sanitizeId(item.name);
      const target = join(dir, 'parts', `${safe}.stl`);
      writeFileSync(target, item.data);
      // 装配层级路径（根 → 父节点）：可选，最多 8 级、单段 ≤60 字符，脏数据直接丢掉不写坏工程
      const path = Array.isArray(item.path)
        ? item.path
            .filter((segment): segment is string => typeof segment === 'string')
            .map((segment) => segment.trim().slice(0, 60))
            .filter(Boolean)
            .slice(0, 8)
        : [];
      partsList.push(path.length > 0
        ? { file: `${safe}.stl`, name: item.name, path }
        : { file: `${safe}.stl`, name: item.name });
    }
    let hasStep = false;
    let hasStl = false;
    if (input.stepPath && existsSync(input.stepPath)) {
      copyFileSync(input.stepPath, join(dir, 'model.step'));
      hasStep = true;
    }
    if (input.stlPath && existsSync(input.stlPath)) {
      copyFileSync(input.stlPath, join(dir, 'model.stl'));
      hasStl = true;
    }
    if (input.stlData !== undefined) {
      if (!(input.stlData instanceof Uint8Array) || input.stlData.byteLength === 0) return { ok: false, message: '整机 STL 数据无效' };
      writeFileSync(join(dir, 'model.stl'), input.stlData);
      hasStl = true;
    }
    const bytes = directoryBytes(dir);
    const record: ProjectRecord = {
      id,
      name,
      process: String(input.process ?? 'unknown'),
      // params 只收有限数字：历史上有过 "11-128" 这种既不是数字也不是字符串的值写进工程，
      // 读回来 JSON.parse 直接炸，工程被当成损坏文件跳过
      params: Object.fromEntries(
        Object.entries(input.params ?? {}).filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
      ),
      parts: Number(input.parts ?? partsList.length),
      massKg: typeof input.massKg === 'number' ? input.massKg : null,
      envelope: input.envelope ?? null,
      material: input.material ?? [],
      createdAt: new Date().toISOString(),
      partsList,
      hasStep,
      hasStl,
      ...(validatedDesign ? { design: validatedDesign } : {}),
      ...(input.geometryReview ? { geometryReview: input.geometryReview } : {}),
      bytes
    };
    writeFileSync(join(dir, 'project.json'), JSON.stringify(record, null, 2), 'utf8');
    if (validatedDesign) writeFileSync(join(dir, 'design.json'), `${JSON.stringify({ design: validatedDesign, placements: input.placements ?? [] }, null, 2)}\n`, 'utf8');
    return { ok: true, record };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function openProject(userDataDir: string, id: string): ProjectOpenResult {
  const dir = projectDir(userDataDir, id);
  const record = readRecord(dir);
  if (!record) return { ok: false, message: `工程「${id}」不存在或已损坏` };
  const partsDir = join(dir, 'parts');
  const partPaths: Array<{ name: string; path: string; color?: string }> = [];
  // partsList 的顺序就是零件序，名字来自保存时记录（零件树要显示中文名）
  for (const entry of record.partsList ?? []) {
    const path = join(partsDir, entry.file);
    if (!existsSync(path)) continue;
    partPaths.push({ name: entry.name, path, ...(entry.color ? { color: entry.color } : {}) });
  }
  const stepPath = join(dir, 'model.step');
  const layout = readProjectLayoutSnapshot(dir);
  return {
    ok: true,
    record,
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
