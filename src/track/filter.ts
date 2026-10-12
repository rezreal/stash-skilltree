// Cleans up a distance sensor at the edge of its range. Backed off, it
// alternates between "no target" and stray echoes that can land near the
// deep end, so a single reading must never jump the position from out to
// in. Once the target is lost the position stays out until a few readings
// in a row agree again; while tracking, a short median drops lone spikes.
import { isNoTarget, toPosition } from "./calibration.ts";
import type { TrackCalibration } from "./types.ts";

export interface PositionFilterOptions {
  /** consistent readings needed to trust the sensor again after losing the target */
  confirmCount: number;
  /** "consistent": all within this many position units of each other */
  confirmSpread: number;
  /** readings in the median while tracking (odd) */
  medianOf: number;
}

export const DEFAULT_FILTER_OPTIONS: PositionFilterOptions = { confirmCount: 3, confirmSpread: 15, medianOf: 3 };

export interface PositionFilter {
  /** the filtered position 0..100 for this reading */
  push(raw: number, cal: TrackCalibration): number;
  /** the last filtered position, if any */
  current(): number | undefined;
  /** true while the target is lost (reading as fully out) */
  lost(): boolean;
  reset(): void;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function createPositionFilter(opts?: Partial<PositionFilterOptions>): PositionFilter {
  const o = { ...DEFAULT_FILTER_OPTIONS, ...opts };
  let isLost = false;
  let confirm: number[] = [];
  let window: number[] = [];
  let last: number | undefined;

  return {
    push(raw, cal) {
      if (isNoTarget(raw, cal)) {
        isLost = true;
        confirm = [];
        window = [];
        last = 0;
        return 0;
      }
      const pos = toPosition(raw, cal);
      if (isLost) {
        confirm.push(pos);
        if (confirm.length > o.confirmCount) confirm.shift();
        const spread = Math.max(...confirm) - Math.min(...confirm);
        if (confirm.length < o.confirmCount || spread > o.confirmSpread) {
          last = 0;
          return 0;
        }
        isLost = false;
        window = confirm.slice(-o.medianOf);
        confirm = [];
      } else {
        window.push(pos);
        if (window.length > o.medianOf) window.shift();
      }
      last = median(window);
      return last;
    },
    current: () => last,
    lost: () => isLost,
    reset() {
      isLost = false;
      confirm = [];
      window = [];
      last = undefined;
    },
  };
}
