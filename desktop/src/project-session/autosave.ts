export type ProjectAutosaveStatus = {
  status: 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';
  message?: string;
};

export type ProjectAutosaveResult = {
  ok: boolean;
  revision?: string | null;
  message?: string;
  conflict?: boolean;
};

export interface ProjectAutosaveOptions<T> {
  capture: () => T;
  save: (id: string, snapshot: T, revision: string | null) => Promise<ProjectAutosaveResult>;
  onStatus?: (state: ProjectAutosaveStatus) => void;
  delayMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** JSON snapshots must be serializable; each save receives an isolated capture. */
export class ProjectAutosave<T> {
  private readonly options: ProjectAutosaveOptions<T>;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private timer: { handle: unknown } | null = null;
  private generation = 0;
  private changes = 0;
  private id: string | null = null;
  private revision: string | null = null;
  private baseline = '';
  private observed: string | null = '';
  private dirty = false;
  private conflicted = false;
  private disposed = false;
  // A suspended session's request still occupies this slot until it settles.
  private flight: { generation: number; promise: Promise<boolean> } | null = null;

  constructor(options: ProjectAutosaveOptions<T>) {
    this.options = options;
    this.setTimer = options.setTimer ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  activate(id: string, revision: string | null, baseline: T): void {
    if (this.disposed) return;
    const json = this.serialize(baseline);
    this.cancelTimer();
    this.generation += 1;
    this.id = id;
    this.revision = revision;
    this.baseline = json;
    this.observed = json;
    this.changes = 0;
    this.dirty = false;
    this.conflicted = false;
    this.status('saved');
  }

  /** Poll without resetting the debounce or retrying failed, unchanged captures. */
  checkForChanges(): void {
    if (this.id === null || this.disposed) return;
    try {
      const json = this.serialize(this.options.capture());
      if (json === this.observed) return;
      this.observed = json;
      if (json === this.baseline && this.flight?.generation !== this.generation) {
        this.cancelTimer();
        if (this.dirty && !this.conflicted) {
          this.dirty = false;
          this.status('saved');
        }
        return;
      }
      this.markDirty();
    } catch (error) {
      this.observed = null;
      this.cancelTimer();
      this.changes += 1;
      this.dirty = true;
      if (!this.conflicted) this.status('error', error instanceof Error ? error.message : String(error));
    }
  }

  markDirty(): void {
    if (this.id === null || this.disposed) return;
    this.changes += 1;
    this.dirty = true;
    if (this.conflicted) return;
    this.status('dirty');
    this.cancelTimer();
    const generation = this.generation;
    this.timer = { handle: this.setTimer(() => {
      this.timer = null;
      if (generation === this.generation) void this.flush();
    }, this.options.delayMs ?? 500) };
  }

  /** Drains changes, including edits made during a save; failures require a new call. */
  async flush(): Promise<boolean> {
    const generation = this.generation;
    this.cancelTimer();
    while (this.id !== null && !this.disposed && generation === this.generation) {
      if (this.conflicted) return false;
      if (this.flight) {
        const flight = this.flight;
        const ok = await flight.promise;
        if (flight.generation === generation && !ok) return false;
        continue;
      }
      if (!this.dirty) return true;
      let json: string;
      let snapshot: T;
      try {
        json = this.serialize(this.options.capture());
        snapshot = JSON.parse(json) as T;
        this.observed = json;
      } catch (error) {
        this.cancelTimer();
        this.status('error', error instanceof Error ? error.message : String(error));
        return false;
      }
      if (json === this.baseline) {
        this.dirty = false;
        this.status('saved');
        return true;
      }
      const id = this.id;
      const revision = this.revision;
      const changes = this.changes;
      const flight = { generation, promise: Promise.resolve(false) };
      this.flight = flight;
      // Defer invocation until the flight slot is installed, including synchronous throws.
      flight.promise = Promise.resolve().then(async () => {
        try {
          if (generation !== this.generation || this.disposed) return false;
          const result = await this.options.save(id, snapshot, revision);
          if (generation !== this.generation || this.disposed) return false;
          if (result.conflict || !result.ok) {
            this.conflicted = result.conflict === true;
            this.cancelTimer();
            this.status(this.conflicted ? 'conflict' : 'error', result.message);
            return false;
          }
          this.baseline = json;
          if (result.revision !== undefined) this.revision = result.revision;
          this.dirty = changes !== this.changes;
          this.status(this.dirty ? 'dirty' : 'saved');
          return true;
        } catch (error) {
          if (generation === this.generation && !this.disposed) {
            this.cancelTimer();
            this.status('error', error instanceof Error ? error.message : String(error));
          }
          return false;
        } finally {
          if (this.flight === flight) this.flight = null;
        }
      });
      this.status('saving');
      const ok = await flight.promise;
      if (!ok) return false;
    }
    return false;
  }

  suspend(): void {
    this.cancelTimer();
    this.generation += 1;
    this.id = null;
    this.dirty = false;
    this.conflicted = false;
    this.status('idle');
  }

  isDirty(): boolean {
    return this.dirty;
  }

  dispose(): void {
    if (this.disposed) return;
    this.suspend();
    this.disposed = true;
  }

  private serialize(snapshot: T): string {
    const json = JSON.stringify(snapshot);
    if (json === undefined) throw new Error('Project snapshot is not JSON serializable');
    return json;
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer.handle);
    this.timer = null;
  }

  private status(status: ProjectAutosaveStatus['status'], message?: string): void {
    this.options.onStatus?.(message === undefined ? { status } : { status, message });
  }
}
