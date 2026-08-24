/**
 * The engine's capacity. Permits are engine-internal on purpose: they sit above the
 * replaceable spawn adapter, so no substituted adapter can run a child without one.
 */

export const MAX_CONCURRENT_CHILDREN = 4;

const QUEUE_ABORTED = "Subagent execution was aborted while waiting for capacity.";
export const QUEUE_CANCELLED = "Subagent execution was cancelled because the session ended.";

export interface Permit {
  release(): void;
}

interface Waiter {
  resolve(permit: Permit): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  abort(): void;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/** A permit pool, not a run registry: it knows how many children may run, never which. */
export class PermitPool {
  private active = 0;
  private readonly waiting: Waiter[] = [];

  constructor(private readonly limit = MAX_CONCURRENT_CHILDREN) {}

  tryAcquire(): Permit | undefined {
    if (this.active >= this.limit) return undefined;
    this.active += 1;
    return this.createPermit();
  }

  acquire(signal?: AbortSignal): Promise<Permit> {
    if (signal?.aborted) return Promise.reject(abortError(QUEUE_ABORTED));
    const permit = this.tryAcquire();
    if (permit) return Promise.resolve(permit);
    return new Promise<Permit>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.waiting.indexOf(waiter);
          if (index === -1) return;
          this.waiting.splice(index, 1);
          signal?.removeEventListener("abort", waiter.abort);
          reject(abortError(QUEUE_ABORTED));
        },
      };
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.waiting.push(waiter);
    });
  }

  /** Settle only current waiters; the pool stays usable for later sessions. */
  cancelWaiting(reason: string): void {
    for (const waiter of this.waiting.splice(0)) {
      waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.reject(abortError(reason));
    }
  }

  private createPermit(): Permit {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.release();
      },
    };
  }

  private release(): void {
    this.active -= 1;
    const waiter = this.waiting.shift();
    if (!waiter) return;
    waiter.signal?.removeEventListener("abort", waiter.abort);
    this.active += 1;
    waiter.resolve(this.createPermit());
  }
}
