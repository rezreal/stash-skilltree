// Photosensitivity limiter for screen flashes: never more than `maxPerSecond`
// flashes in any 1-second sliding window. Three is the WCAG 2.3.1 general
// flash threshold. Flashes over the cap are dropped, not queued. Pure.

export const MAX_FLASHES_PER_SECOND = 3;
const WINDOW_MS = 1000;

export interface FlashLimiter {
  /** true (and the flash is counted) when one more flash at `nowMs` stays within the cap */
  allow(nowMs: number): boolean;
  reset(): void;
}

export function createFlashLimiter(opts: { maxPerSecond?: number } = {}): FlashLimiter {
  const max = Math.max(0, Math.floor(opts.maxPerSecond ?? MAX_FLASHES_PER_SECOND));
  let recent: number[] = [];
  return {
    allow(nowMs) {
      // a clock that went backwards keeps its entries: they still count
      recent = recent.filter((t) => nowMs - t < WINDOW_MS);
      if (recent.length >= max) return false;
      recent.push(nowMs);
      return true;
    },
    reset() {
      recent = [];
    },
  };
}

export const DEFAULT_SNAP_FLASH = 60;

/**
 * Peak opacity (0..1) for the snapFlash plugin setting, a brightness in
 * percent: unset or invalid -> 60 %, clamped to 0..100, 0 = off.
 */
export function snapFlashIntensity(setting: unknown): number {
  const n = typeof setting === "number" ? setting : typeof setting === "string" && setting.trim() !== "" ? Number(setting) : NaN;
  const pct = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : DEFAULT_SNAP_FLASH;
  return pct / 100;
}
