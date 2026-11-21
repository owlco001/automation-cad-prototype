/** Bounded FIFO for one approval surface. The deadline starts at admission, including queue time. */
export class ConfirmationQueue {
  private readonly pending: Array<() => void> = [];
  private active = false;

  private readonly limit: number;

  constructor(limit = 8) { this.limit = limit; }

  async submit<T>(signal: AbortSignal, unavailable: T, show: () => Promise<T>): Promise<T> {
    if (signal.aborted || this.pending.length + Number(this.active) >= this.limit) return unavailable;
    return await new Promise<T>((resolve) => {
      const onAbort = (): void => {
        const index = this.pending.indexOf(start);
        if (index !== -1) {
          this.pending.splice(index, 1);
          resolve(unavailable);
        }
      };
      const start = (): void => {
        signal.removeEventListener('abort', onAbort);
        this.active = true;
        void (async () => {
          try {
            resolve(signal.aborted ? unavailable : await show());
          } catch {
            resolve(unavailable);
          } finally {
            this.active = false;
            this.pending.shift()?.();
          }
        })();
      };
      if (!this.active) start();
      else {
        this.pending.push(start);
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}
