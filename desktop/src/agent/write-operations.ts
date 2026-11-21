import { createHash } from 'node:crypto';

const OPERATION_ID = /^[A-Za-z0-9_-]{16,128}$/;
const RESULT_LIMIT = 64 * 1024;

export function isWriteOperationId(value: unknown): value is string {
  return typeof value === 'string' && OPERATION_ID.test(value);
}

type State = 'awaiting_confirmation' | 'executing' | 'finished' | 'cancelled' | 'unknown';
interface Entry {
  fingerprint: string;
  state: State;
  result?: unknown;
  expires: number;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Prevents duplicate writes within this process and retention window, not across restarts. */
export class WriteOperations {
  private readonly entries = new Map<string, Entry>();

  private readonly limit: number;
  private readonly retentionMs: number;

  constructor(limit = 256, retentionMs = 15 * 60 * 1000) {
    this.limit = limit;
    this.retentionMs = retentionMs;
  }

  private lookup(scope: string, id: string): Entry | undefined {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expires <= now) this.entries.delete(key);
    }
    return this.entries.get(`${scope}:${id}`);
  }

  status(scope: string, id: string): unknown {
    const entry = this.lookup(scope, id);
    return entry
      ? { ok: true, operationId: id, state: entry.state, ...('result' in entry ? { result: entry.result } : {}) }
      : { ok: false, operationId: id, code: 'WRITE_OPERATION_NOT_FOUND', message: '未找到操作记录，不能据此判定未执行。' };
  }

  async run(scope: string, id: string, name: string, args: Record<string, unknown>,
    execute: (markExecuting: () => void) => Promise<{ result: unknown; state: 'finished' | 'cancelled' | 'unknown' }>): Promise<unknown> {
    const fingerprint = createHash('sha256').update(canonicalJson([name, args])).digest('hex');
    const existing = this.lookup(scope, id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { ok: false, operationId: id, code: 'WRITE_OPERATION_CONFLICT', message: '操作 ID 已绑定其他写入。' };
      if ('result' in existing) return existing.result;
      return { ok: false, operationId: id, code: 'WRITE_OPERATION_RECORDED', state: existing.state, message: '该操作已登记，不会再次执行；请查询原操作。' };
    }
    if (this.entries.size >= this.limit) return { ok: false, operationId: id, code: 'WRITE_OPERATION_CAPACITY', message: '写操作记录已达上限，未执行。' };
    const entry: Entry = { fingerprint, state: 'awaiting_confirmation', expires: Infinity };
    this.entries.set(`${scope}:${id}`, entry);
    try {
      const { result, state } = await execute(() => { entry.state = 'executing'; });
      entry.state = state;
      const serialized = JSON.stringify(result) ?? '';
      if (Buffer.byteLength(serialized) <= RESULT_LIMIT) entry.result = result;
      else {
        const record = result !== null && typeof result === 'object' ? result as Record<string, unknown> : {};
        entry.result = {
          ok: typeof record.ok === 'boolean' ? record.ok : null,
          operationId: id,
          resultOmitted: true,
          resultBytes: Buffer.byteLength(serialized),
          ...(typeof record.code === 'string' ? { code: record.code.slice(0, 256) } : {}),
          ...(typeof record.message === 'string' ? { message: record.message.slice(0, 1024) } : {})
        };
      }
      return result;
    } catch {
      entry.state = 'unknown';
      return { ok: false, operationId: id, code: 'WRITE_OUTCOME_UNKNOWN', message: '无法确定写操作的结果，请查询原操作并核对工程，不要自动重试。' };
    } finally {
      entry.expires = Date.now() + this.retentionMs;
    }
  }
}
