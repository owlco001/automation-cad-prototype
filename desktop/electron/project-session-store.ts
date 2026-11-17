import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { MAX_PROJECT_SNAPSHOT_BYTES, parseProjectSnapshot, type ProjectSnapshot } from '../src/project-session/snapshot.ts';

export interface ProjectSessionResult {
  ok: boolean;
  snapshot?: ProjectSnapshot;
  revision: string | null;
  savedAt?: string;
  message?: string;
  conflict?: boolean;
}
interface Envelope {
  schemaVersion: 1;
  revision: string;
  savedAt: string;
  projectFingerprint: string;
  snapshot: ProjectSnapshot;
}
interface Context { dir: string; fingerprint: string }
const MAX_ENVELOPE_BYTES = MAX_PROJECT_SNAPSHOT_BYTES + 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POINTER_FILE = 'last-project-session.json';

function safeId(id: unknown): asserts id is string {
  // Exact validation: never sanitize an untrusted id into a different project.
  if (typeof id !== 'string' || id.length < 1 || id.length > 48 || !/^[\w\u4e00-\u9fa5-]+$/.test(id)) throw new Error('Invalid project id');
}
function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(value).length !== fields.length || fields.some((key) => !Object.hasOwn(value, key))) throw new Error('Invalid session envelope fields');
}
function regular(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Session files must be regular local files');
}
function directory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Project directory must be a local directory');
}
function readBounded(path: string, max = MAX_ENVELOPE_BYTES): string {
  regular(path);
  if (lstatSync(path).size > max) throw new Error('Session file exceeds size limit');
  const bytes = readFileSync(path);
  if (bytes.length > max) throw new Error('Session file exceeds size limit');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return text;
}
function context(userData: string, id: string): Context {
  safeId(id);
  const root = resolve(userData);
  directory(root);
  const projects = join(root, 'projects');
  directory(projects);
  const dir = join(projects, id);
  directory(dir);
  const content = readBounded(join(dir, 'project.json'));
  const project: unknown = JSON.parse(content);
  if (!plain(project) || project.id !== id || typeof project.name !== 'string') throw new Error('Project is missing or invalid');
  return { dir, fingerprint: createHash('sha256').update(content).digest('hex') };
}
function envelope(path: string, ctx: Context): Envelope {
  const raw: unknown = JSON.parse(readBounded(path));
  if (!plain(raw)) throw new Error('Invalid session envelope');
  exact(raw, ['schemaVersion', 'revision', 'savedAt', 'projectFingerprint', 'snapshot']);
  if (raw.schemaVersion !== 1 || typeof raw.revision !== 'string' || !UUID.test(raw.revision)
    || typeof raw.savedAt !== 'string' || !Number.isFinite(Date.parse(raw.savedAt))
    || typeof raw.projectFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(raw.projectFingerprint)) throw new Error('Invalid session envelope');
  if (raw.projectFingerprint !== ctx.fingerprint) throw new Error('Project was replaced; session fingerprint does not match');
  return { schemaVersion: 1, revision: raw.revision, savedAt: raw.savedAt, projectFingerprint: raw.projectFingerprint, snapshot: parseProjectSnapshot(raw.snapshot) };
}
function workspace(ctx: Context): ProjectSnapshot | null {
  const path = join(ctx.dir, 'workspace.json');
  return existsSync(path) ? parseProjectSnapshot(JSON.parse(readBounded(path, MAX_PROJECT_SNAPSHOT_BYTES))) : null;
}
function result(saved: Envelope, message?: string): ProjectSessionResult {
  return { ok: true, snapshot: saved.snapshot, revision: saved.revision, savedAt: saved.savedAt, ...(message ? { message } : {}) };
}
function errorResult(error: unknown): ProjectSessionResult {
  return { ok: false, revision: null, message: error instanceof Error ? error.message : String(error) };
}

/** Read-only recovery exposes the previous valid save and never rewrites corrupt data. */
export function readProjectSession(userData: string, id: string): ProjectSessionResult {
  try {
    const ctx = context(userData, id);
    const current = join(ctx.dir, 'session.json');
    const backup = join(ctx.dir, 'session.json.bak');
    if (existsSync(current) || existsSync(backup)) {
      try {
        return result(envelope(current, ctx));
      } catch (currentError) {
        if (existsSync(backup)) {
          try { return result(envelope(backup, ctx), `Recovered previous session backup; current session is unavailable or invalid: ${currentError instanceof Error ? currentError.message : String(currentError)}`); }
          catch { /* Preserve the current error, including project replacement. */ }
        }
        throw currentError;
      }
    }
    const initial = workspace(ctx);
    return initial ? { ok: true, snapshot: initial, revision: null } : { ok: true, revision: null, message: 'No saved project session' };
  } catch (error) { return errorResult(error); }
}

function syncDirectory(path: string): void {
  // Windows may reject opening/fsyncing a directory; file fsync still precedes rename.
  let fd: number | undefined;
  try { fd = openSync(path, 'r'); fsyncSync(fd); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EINVAL')) throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
function atomicWrite(path: string, content: string, dir: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, content, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    syncDirectory(dir);
  } finally {
    if (fd !== undefined) closeSync(fd);
    // This exact temporary path was created by this call in a validated directory.
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Synchronous main-process API: calls are serialized by the JS event loop.
 * This is optimistic concurrency within one app process, not a cross-process lock.
 */
export function saveProjectSession(userData: string, id: string, payload: { snapshot: unknown; expectedRevision: string | null }): ProjectSessionResult {
  try {
    const ctx = context(userData, id);
    if (!plain(payload)) throw new Error('Invalid session save payload');
    exact(payload, ['snapshot', 'expectedRevision']);
    if (payload.expectedRevision !== null && (typeof payload.expectedRevision !== 'string' || !UUID.test(payload.expectedRevision))) throw new Error('Invalid expectedRevision');
    const snapshot = parseProjectSnapshot(payload.snapshot);
    const currentPath = join(ctx.dir, 'session.json');
    const backupPath = join(ctx.dir, 'session.json.bak');
    // Fail closed: recovery is read-only until corrupt/missing current is repaired.
    const previous = existsSync(currentPath) ? envelope(currentPath, ctx) : null;
    if (!previous && existsSync(backupPath)) throw new Error('Current session is missing; recover backup before saving');
    if ((previous?.revision ?? null) !== payload.expectedRevision) {
      return { ok: false, revision: previous?.revision ?? null, conflict: true, message: 'Session revision conflict; reload before saving' };
    }
    const initial = workspace(ctx);
    const binding = previous?.snapshot ?? initial;
    if (binding && (binding.projectId !== snapshot.projectId || binding.meshSignature !== snapshot.meshSignature)) throw new Error('Snapshot project binding or mesh signature does not match saved project');
    const next: Envelope = { schemaVersion: 1, revision: randomUUID(), savedAt: new Date().toISOString(), projectFingerprint: ctx.fingerprint, snapshot };
    const content = JSON.stringify(next);
    if (new TextEncoder().encode(content).byteLength > MAX_ENVELOPE_BYTES) throw new Error('Session envelope exceeds size limit');
    if (previous) atomicWrite(backupPath, JSON.stringify(previous), ctx.dir);
    atomicWrite(currentPath, content, ctx.dir);
    return result(next);
  } catch (error) { return errorResult(error); }
}

/** Explicit user-triggered repair only. Never called by reads or autosave. */
export function repairProjectSession(userData: string, id: string, expectedRevision: string): ProjectSessionResult {
  try {
    const ctx = context(userData, id);
    if (typeof expectedRevision !== 'string' || !UUID.test(expectedRevision)) throw new Error('Invalid expectedRevision');
    const currentPath = join(ctx.dir, 'session.json');
    const backupPath = join(ctx.dir, 'session.json.bak');
    const backup = envelope(backupPath, ctx);
    if (backup.revision !== expectedRevision) {
      return { ok: false, revision: backup.revision, conflict: true, message: 'Session backup revision conflict; reload before repair' };
    }
    const initial = workspace(ctx);
    if (initial && (initial.projectId !== backup.snapshot.projectId || initial.meshSignature !== backup.snapshot.meshSignature)) throw new Error('Backup project binding or mesh signature does not match saved project');
    if (existsSync(currentPath)) {
      // A now-valid current file means another action resolved the failure. Do not
      // replace a newer valid save with an older backup after a stale UI click.
      let current: Envelope | null = null;
      try { current = envelope(currentPath, ctx); } catch { /* Corrupt current is preserved below. */ }
      if (current) return { ok: false, revision: current.revision, conflict: true, message: 'Current session is valid; reload before repair' };
      regular(currentPath);
      const preservedPath = join(ctx.dir, `session.corrupt-${randomUUID()}.json`);
      if (existsSync(preservedPath)) throw new Error('Corrupt session preservation path already exists');
      // Both absolute paths are exact children of the validated project directory.
      // Preserve raw bytes (including malformed UTF-8 or oversized corrupt data).
      renameSync(currentPath, preservedPath);
      syncDirectory(ctx.dir);
    }
    atomicWrite(currentPath, JSON.stringify(backup), ctx.dir);
    return result(backup);
  } catch (error) { return errorResult(error); }
}

export function rememberLastProjectSession(userData: string, id: string): { ok: boolean; message?: string } {
  try {
    context(userData, id);
    const root = resolve(userData);
    const path = join(root, POINTER_FILE);
    if (existsSync(path)) regular(path);
    atomicWrite(path, JSON.stringify({ id }), root);
    return { ok: true };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
}

export function readLastProjectSession(userData: string): ProjectSessionResult & { id?: string } {
  try {
    const root = resolve(userData);
    directory(root);
    const path = join(root, POINTER_FILE);
    if (!existsSync(path)) return { ok: true, revision: null };
    const raw: unknown = JSON.parse(readBounded(path, 1024));
    if (!plain(raw)) throw new Error('Invalid last project pointer');
    exact(raw, ['id']);
    safeId(raw.id);
    return { ...readProjectSession(root, raw.id), id: raw.id };
  } catch (error) { return errorResult(error); }
}
