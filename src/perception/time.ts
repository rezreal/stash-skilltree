// Small pure timing helpers for the analysis loops.

/**
 * MediaPipe VIDEO mode needs strictly increasing timestamps per task. Returns
 * a function that passes `ms` through, bumped just past the previous value
 * when the clock didn't advance (or went back).
 */
export function createMonotonic(): (ms: number) => number {
  let last = -Infinity;
  return (ms) => {
    const t = ms > last ? ms : last + 1;
    last = t;
    return t;
  };
}

export const MIN_RATE_HZ = 0.5;
export const MAX_RATE_HZ = 30;

/** Clamps an analysis rate to [0.5, 30] Hz; non-finite -> fallback. */
export function clampRate(hz: number, fallback: number): number {
  if (!Number.isFinite(hz) || hz <= 0) return fallback;
  return Math.min(MAX_RATE_HZ, Math.max(MIN_RATE_HZ, hz));
}

/**
 * Delay until the next tick of a fixed-rate loop: aims for `start + 1000/hz`
 * where start is when the previous tick began; never negative.
 */
export function nextDelay(hz: number, tickStartedAt: number, now: number): number {
  return Math.max(0, tickStartedAt + 1000 / hz - now);
}
