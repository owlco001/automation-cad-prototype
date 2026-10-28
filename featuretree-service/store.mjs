// FeatureTree 文档存储：包络（revision / origin / history）+ 操作 + 乐观锁 + 原子事务。
// 流程固定：校验 → 编译 → 重建钩子 → 发布新版本 → 通知订阅者；任一步失败则版本不变。
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateDoc, checkPanelEdit, compileOps } from './validate.mjs';

export function clone(v) { return JSON.parse(JSON.stringify(v)); }

/**
 * 材料表：密度是**输入**，不是猜的。质量 = 体积 × 密度，换了材料要重新算，
 * 但几何（体积/包围盒）不变——这也是为什么材料是文档属性而不是特征的参数。
 */
export const MATERIALS = {
  steel: { label: '钢', densityGPerCm3: 7.85 },
  aluminum: { label: '铝', densityGPerCm3: 2.70 },
  stainless: { label: '不锈钢', densityGPerCm3: 7.93 },
  brass: { label: '黄铜', densityGPerCm3: 8.50 }
};

export function materialOf(doc) {
  const key = doc && typeof doc.material === 'string' ? doc.material : 'steel';
  const entry = MATERIALS[key] || MATERIALS.steel;
  return { key: MATERIALS[key] ? key : 'steel', ...entry };
}

/**
 * 带真实时区偏移的 ISO 时间串。
 * 以前写的是 `toISOString().replace('Z','+08:00')`——那只是把 UTC 时刻改标成 +08:00，
 * 实际差 8 小时（实测留痕时间比真实时刻早 480 分钟）。这里按本机偏移重排各字段。
 */
export function nowIso(date = new Date()) {
  const pad = (value, width = 2) => String(Math.abs(value)).padStart(width, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// 重建钩子（v1 占位实现，非 OCCT 真重建）：编译算子 + 指纹。
// 真实 OCCT/build123d 重建由后续 cadgen 侧车桥接替换本函数；
// 在此之前，服务诚实地只保证“编译通过 + 指纹变化”，不宣称已生成 BRep。
/**
 * 重建（契约 §8 / §14.1）：
 * - 配了 FT_BUILD_URL（build123d sidecar）时，把算子送去真建实体，拿体积/包围盒/质量；
 *   质量按调用方给的密度算（默认钢 7.85 g/cm³），密度是输入不是猜的。
 * - 没配 sidecar 时只做「编译 + 指纹」，并明确 geometry=null，绝不假装算过体积。
 * - 算子为空（全部压缩）一律失败——契约 §14.5 要求版本停在原处。
 */
export async function rebuild(doc) {
  const ops = compileOps(doc);
  if (ops.length === 0) {
    return { ok: false, message: '重建失败：没有任何可构建的特征（全部被压缩或缺少实体特征）' };
  }
  const sidecar = process.env.FT_BUILD_URL;
  if (!sidecar) {
    const fingerprint = createHash('sha256').update(JSON.stringify(ops)).digest('hex').slice(0, 16);
    return { ok: true, ops, fingerprint, geometry: null };
  }
  try {
    const response = await fetch(`${sidecar.replace(/\/+$/, '')}/rebuild`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ops, densityGPerCm3: Number(process.env.FT_DENSITY) || materialOf(doc).densityGPerCm3 }),
      signal: AbortSignal.timeout(20_000)
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      return { ok: false, message: payload?.message || `重建 sidecar 返回 HTTP ${response.status}` };
    }
    return {
      ok: true,
      ops,
      fingerprint: payload.fingerprint,
      geometry: {
        volumeMm3: payload.volumeMm3,
        bboxMm: payload.bboxMm,
        massKg: payload.massKg,
        densityGPerCm3: payload.densityGPerCm3,
        material: materialOf(doc).key,
        materialLabel: materialOf(doc).label,
        kernel: 'build123d'
      }
    };
  } catch (error) {
    return { ok: false, message: `重建 sidecar 不可用：${error instanceof Error ? error.message : String(error)}` };
  }
}

export class Store {
  /**
   * @param initialDoc 种子文档（磁盘上没有存档时用它）
   * @param options.dataDir 设置后启用落盘（FT_DATA_DIR）；不设就是纯内存态（默认，契约 §15.1 未拍板）
   */
  constructor(initialDoc, options = {}) {
    this.doc = clone(initialDoc);
    this.revision = 0;
    this.history = [];
    this.snapshots = [clone(this.doc)]; // snapshots[revision] = 该版本文档全文
    this.listeners = new Set();
    this.geometry = null;
    // undo 不是终点：撤回的那一版必须能再“重做”回来。栈上限 50，避免无限长内存。
    this.redoStack = [];
    this.dataDir = options.dataDir || null;
    this.dataFile = this.dataDir ? join(this.dataDir, 'demo-adapter.json') : null;
    const errs = validateDoc(this.doc);
    if (errs.length) throw new Error('初始文档校验失败：' + errs.join('；'));
  }
  /**
   * 启动时把种子树也重建一次，这样首个 GET /v1/tree 就带 geometry。
   * sidecar 配了但连不上时不让服务起不来：只记下错误，等写操作时按 REBUILD_FAILED 报。
   */
  /** 从磁盘恢复（有存档就用存档的文档/版本/历史/快照），然后重建几何 */
  async restore() {
    if (!this.dataFile || !existsSync(this.dataFile)) return false;
    const raw = await readFile(this.dataFile, 'utf8');
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || !saved.doc) return false;
    const errs = validateDoc(saved.doc);
    if (errs.length) {
      // 存档坏了不要静默覆盖：报出来，让调用方决定（这里保留种子树并记下原因）
      this.restoreError = `存档校验失败，已回退种子树：${errs.join('；')}`;
      return false;
    }
    this.doc = clone(saved.doc);
    this.revision = Number.isInteger(saved.revision) ? saved.revision : 0;
    this.history = Array.isArray(saved.history) ? saved.history : [];
    this.snapshots = Array.isArray(saved.snapshots) && saved.snapshots.length
      ? saved.snapshots.map((entry) => clone(entry))
      : [clone(this.doc)];
    if (!this.snapshots[this.revision]) this.snapshots[this.revision] = clone(this.doc);
    return true;
  }

  /** 原子落盘：先写临时文件再 rename，避免写一半断电留下半个 JSON */
  async persist() {
    if (!this.dataFile) return;
    await mkdir(dirname(this.dataFile), { recursive: true });
    const payload = JSON.stringify({
      documentId: 'demo-adapter',
      revision: this.revision,
      doc: this.doc,
      history: this.history,
      snapshots: this.snapshots,
      savedAt: nowIso()
    }, null, 2);
    const temp = `${this.dataFile}.tmp`;
    await writeFile(temp, payload, 'utf8');
    await rename(temp, this.dataFile);
  }

  async init() {
    this.lastInitAttempt = Date.now();
    const rb = await rebuild(this.doc);
    if (rb.ok) {
      this.geometry = rb.geometry;
      this.fingerprint = rb.fingerprint;
    } else {
      this.geometryError = rb.message || '重建失败';
    }
  }

  /**
   * 启动时 sidecar 可能还没加载完（build123d import 要几秒）。init 失败不该让服务永久没有几何，
   * 所以在 GET /v1/tree 里做一次带节流的重试：成功就补上，失败就等下一次。
   */
  async retryInit() {
    const now = Date.now();
    if (this.geometry || now - (this.lastInitAttempt || 0) < 5000) return;
    this.lastInitAttempt = now;
    await this.init();
  }

  envelope() {
    return {
      documentId: 'demo-adapter',
      kind: 'part',
      revision: this.revision,
      // 给 UI 用：能不能撤销/重做不用客户端自己猜
      undoDepth: Math.max(0, this.revision),
      redoDepth: this.redoStack.length,
      doc: clone(this.doc),
      history: clone(this.history),
      ...(this.geometry ? { geometry: clone(this.geometry) } : {})
    };
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(change) { for (const fn of this.listeners) fn(change); }

  // 核心写入口：fn(docDraft) 做修改；随后整树校验 + 重建，失败则丢弃草稿。
  async commit(expectedRevision, actor, operation, featureIds, fn) {
    if (expectedRevision !== this.revision) {
      return { error: 'CONFLICT_STALE_REVISION', message: `版本过期：期望 ${expectedRevision}，当前 ${this.revision}`, current: this.envelope() };
    }
    const draft = clone(this.doc);
    const opErr = fn(draft);
    if (opErr) return { error: 'VALIDATION_FAILED', message: opErr };
    const errs = validateDoc(draft);
    if (errs.length) return { error: 'VALIDATION_FAILED', message: errs.join('；') };
    const rb = await rebuild(draft);
    if (!rb.ok) return { error: 'REBUILD_FAILED', message: rb.message || '重建失败' };
    const before = this.revision;
    this.doc = draft;
    this.doc.updatedAt = nowIso();
    this.revision += 1;
    this.snapshots[this.revision] = clone(this.doc);
    this.geometry = rb.geometry;
    // 一旦发生新的写操作，原来的 redo 分支就作废（否则会重做出一棵不相干的树）
    this.redoStack = [];
    const entry = { revision: this.revision, beforeRevision: before, timestamp: this.doc.updatedAt, actor, operation, featureIds, fingerprint: rb.fingerprint, ...(rb.geometry ? { geometry: rb.geometry } : {}) };
    this.history.push(entry);
    const env = this.envelope();
    this.emit({ documentId: env.documentId, revision: env.revision, changedFeatureIds: featureIds, actor });
    await this.persist();
    return env;
  }

  async applyOperation(body) {
    const { expectedRevision, actor = 'manual', operation } = body;
    const actorLabel = actor === 'agent' ? `agent:${body.agentId || 'unknown'}` : 'manual';
    switch (operation) {
      case 'createFeature': {
        const f = body.feature;
        if (!f || typeof f.id !== 'string' || !f.id.trim()) return { error: 'VALIDATION_FAILED', message: '缺少必填参数：特征.id' };
        if (this.doc.features.some(x => x.id === f.id)) return { error: 'DUPLICATE_ID', message: `id「${f.id}」已存在` };
        return await this.commit(expectedRevision, actorLabel, operation, [f.id], (d) => { d.features.push(clone(f)); return null; });
      }
      case 'updateFeatureParams': {
        const f = this.doc.features.find(x => x.id === body.featureId);
        if (!f) return { error: 'NOT_FOUND', message: `找不到特征：${body.featureId}` };
        for (const [k, v] of Object.entries(body.patch || {})) {
          const e = checkPanelEdit(f, k, v);
          if (e) return { error: e.startsWith('未知字段') ? 'UNKNOWN_FIELD' : 'VALIDATION_FAILED', message: e };
        }
        return await this.commit(expectedRevision, actorLabel, operation, [body.featureId], (d) => {
          const t = d.features.find(x => x.id === body.featureId);
          Object.assign(t.params, clone(body.patch)); return null;
        });
      }
      case 'renameFeature': {
        if (typeof body.name !== 'string' || !body.name.trim()) return { error: 'VALIDATION_FAILED', message: 'name 必须是非空字符串' };
        if (!this.doc.features.some(x => x.id === body.featureId)) return { error: 'NOT_FOUND', message: `找不到特征：${body.featureId}` };
        return await this.commit(expectedRevision, actorLabel, operation, [body.featureId], (d) => { d.features.find(x => x.id === body.featureId).name = body.name; return null; });
      }
      case 'reorderFeature': {
        const from = this.doc.features.findIndex(x => x.id === body.featureId);
        if (from === -1) return { error: 'NOT_FOUND', message: `找不到特征：${body.featureId}` };
        return await this.commit(expectedRevision, actorLabel, operation, [body.featureId], (d) => {
          const [m] = d.features.splice(from, 1);
          const idx = Math.max(0, Math.min(body.targetIndex ?? 0, d.features.length));
          d.features.splice(idx, 0, m); return null;
        });
      }
      case 'setSuppressed': {
        if (typeof body.suppressed !== 'boolean') return { error: 'VALIDATION_FAILED', message: 'suppressed 必须是布尔值' };
        if (!this.doc.features.some(x => x.id === body.featureId)) return { error: 'NOT_FOUND', message: `找不到特征：${body.featureId}` };
        return await this.commit(expectedRevision, actorLabel, operation, [body.featureId], (d) => { d.features.find(x => x.id === body.featureId).suppressed = body.suppressed; return null; });
      }
      case 'deleteFeature': {
        const target = this.doc.features.find(x => x.id === body.featureId);
        if (!target) return { error: 'NOT_FOUND', message: `找不到特征：${body.featureId}` };
        // 契约 §14.6：删除被引用特征必须被拒绝并指明引用方——删掉唯一基体后，
        // 剩下的孔/沉头/圆角就失去了作用对象（旧实现会 200 通过并留下无基体的树）。
        const remaining = this.doc.features.filter(f => f.id !== target.id);
        const cutTypes = ['holes', 'counterbore', 'fillet'];
        const hasBody = remaining.some(f => f.type === 'box' && f.suppressed !== true);
        const orphans = remaining.filter(f => cutTypes.includes(f.type) && f.suppressed !== true);
        if (!hasBody && orphans.length > 0) {
          return {
            error: 'REFERENCE_IN_USE',
            message: `特征「${target.id}」被引用，不能删除：引用方 ${orphans.map(f => `${f.type}「${f.id}」`).join('、')}`
          };
        }
        return await this.commit(expectedRevision, actorLabel, operation, [body.featureId], (d) => {
          d.features = d.features.filter(x => x.id !== body.featureId);
          return null;
        });
      }
      case 'applyTransaction': {
        const ops = body.operations || [];
        // 事务在单次 commit 内顺序执行子操作，任一失败整单回滚（草稿丢弃）。
        return await this.commit(expectedRevision, actorLabel, operation, ops.map(o => o.featureId).filter(Boolean), (d) => {
          for (const op of ops) {
            if (op.operation === 'updateFeatureParams') {
              const t = d.features.find(x => x.id === op.featureId);
              if (!t) return `找不到特征：${op.featureId}`;
              for (const [k, v] of Object.entries(op.patch || {})) {
                const e = checkPanelEdit(t, k, v);
                if (e) return e;
              }
              Object.assign(t.params, clone(op.patch));
            } else if (op.operation === 'setSuppressed') {
              const t = d.features.find(x => x.id === op.featureId);
              if (!t) return `找不到特征：${op.featureId}`;
              t.suppressed = op.suppressed;
            } else return `事务不支持的操作：${op.operation}`;
          }
          return null;
        });
      }
      case 'setMaterial': {
        const key = typeof body.material === 'string' ? body.material.trim() : '';
        if (!MATERIALS[key]) {
          return { error: 'VALIDATION_FAILED', message: `未知材料「${key}」，可选：${Object.keys(MATERIALS).join('/')}` };
        }
        // 材料写在文档上：几何不变、质量重算，历史里能查到是谁改的
        return await this.commit(expectedRevision, actorLabel, operation, [], (d) => { d.material = key; return null; });
      }
      default:
        return { error: 'VALIDATION_FAILED', message: `未知操作：${operation}` };
    }
  }

  async undo(expectedRevision, actor = 'manual', steps = 1) {
    // undo 本身也是一次写操作：带 expectedRevision，经过校验与重建，产生新 revision；
    // 历史不删除，undo 记录进 history，目标是 snapshots[revision - steps] 的全文。
    if (expectedRevision !== this.revision) {
      return { error: 'CONFLICT_STALE_REVISION', message: `版本过期：期望 ${expectedRevision}，当前 ${this.revision}`, current: this.envelope() };
    }
    const target = this.revision - Math.max(1, steps);
    if (target < 0 || !this.snapshots[target]) return { error: 'NOT_FOUND', message: `没有可撤销到的版本：${target}` };
    const restored = clone(this.snapshots[target]);
    const errs = validateDoc(restored);
    if (errs.length) return { error: 'VALIDATION_FAILED', message: errs.join('；') };
    const rb = await rebuild(restored);
    if (!rb.ok) return { error: 'REBUILD_FAILED', message: rb.message || '重建失败' };
    const before = this.revision;
    this.redoStack.push(clone(this.doc));
    if (this.redoStack.length > 50) this.redoStack.shift();
    this.doc = restored;
    this.doc.updatedAt = nowIso();
    this.revision += 1;
    this.snapshots[this.revision] = clone(this.doc);
    this.geometry = rb.geometry;
    this.history.push({ revision: this.revision, beforeRevision: before, timestamp: this.doc.updatedAt, actor, operation: 'undo', featureIds: [], fingerprint: rb.fingerprint, undoTarget: target });
    if (rb.geometry) this.history[this.history.length - 1].geometry = rb.geometry;
    const env = this.envelope();
    this.emit({ documentId: env.documentId, revision: env.revision, changedFeatureIds: [], actor });
    await this.persist();
    return env;
  }

  /**
   * 重做：把最近一次 undo 撤回掉的文档放回来。
   * 和 undo 一样走乐观锁 + 校验 + 重建，失败则版本与文档都不动。
   * 新写操作会清空 redo 栈（分支历史不合并）。
   */
  async redo(expectedRevision, actor = 'manual', steps = 1) {
    if (expectedRevision !== this.revision) {
      return { error: 'CONFLICT_STALE_REVISION', message: `版本过期：期望 ${expectedRevision}，当前 ${this.revision}`, current: this.envelope() };
    }
    const count = Math.max(1, Math.min(steps, this.redoStack.length));
    if (!this.redoStack.length) {
      return { error: 'REDO_EMPTY', message: '没有可重做的操作（redo 栈为空，或之后又发生了新的修改）' };
    }
    // 连续重做多步时，最终落在倒数第 count 个快照上
    const restored = clone(this.redoStack[this.redoStack.length - count]);
    const errs = validateDoc(restored);
    if (errs.length) return { error: 'VALIDATION_FAILED', message: errs.join('；') };
    const rb = await rebuild(restored);
    if (!rb.ok) return { error: 'REBUILD_FAILED', message: rb.message || '重建失败' };
    const before = this.revision;
    this.redoStack.splice(this.redoStack.length - count, count);
    this.doc = restored;
    this.doc.updatedAt = nowIso();
    this.revision += 1;
    this.snapshots[this.revision] = clone(this.doc);
    this.geometry = rb.geometry;
    const entry = { revision: this.revision, beforeRevision: before, timestamp: this.doc.updatedAt, actor, operation: 'redo', featureIds: [], fingerprint: rb.fingerprint, redoSteps: count };
    if (rb.geometry) entry.geometry = rb.geometry;
    this.history.push(entry);
    const env = this.envelope();
    this.emit({ documentId: env.documentId, revision: env.revision, changedFeatureIds: [], actor });
    await this.persist();
    return env;
  }
}
