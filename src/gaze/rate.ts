// Small helpers shared by the gaze sources: a rolling samples-per-second
// counter and a listener set. Time is injected; no DOM.

export interface RateCounter {
  /** records one event at time t (ms) */
  add(t: number): void;
  /** events per second over the last windowMs before nowMs */
  rate(nowMs: number): number;
  reset(): void;
}

export function createRateCounter(windowMs = 1000): RateCounter {
  // timestamps in arrival order; old ones are dropped from the front
  let times: number[] = [];
  let head = 0;

  function prune(nowMs: number): void {
    const cutoff = nowMs - windowMs;
    while (head < times.length && times[head]! <= cutoff) head++;
    // compact once the dead prefix dominates
    if (head > 256 && head * 2 > times.length) {
      times = times.slice(head);
      head = 0;
    }
  }

  return {
    add(t) {
      times.push(t);
      prune(t);
    },
    rate(nowMs) {
      prune(nowMs);
      return ((times.length - head) * 1000) / windowMs;
    },
    reset() {
      times = [];
      head = 0;
    },
  };
}

export interface Listeners<T> {
  add(cb: (v: T) => void): () => void;
  emit(v: T): void;
  clear(): void;
}

/** A set of callbacks; a throwing listener doesn't stop the others. */
export function createListeners<T>(): Listeners<T> {
  const set = new Set<(v: T) => void>();
  return {
    add(cb) {
      set.add(cb);
      return () => {
        set.delete(cb);
      };
    },
    emit(v) {
      for (const cb of [...set]) {
        try {
          cb(v);
        } catch (err) {
          console.error("[skilltree] gaze listener failed", err);
        }
      }
    },
    clear() {
      set.clear();
    },
  };
}

/** Injectable timer functions (globalThis by default, fakes in tests). */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const GLOBAL_TIMERS: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export function defaultNow(): number {
  return globalThis.performance.now();
}
