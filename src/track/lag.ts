// How far the user follows behind the script, from a cross-correlation of
// the script with the sensor signal. People follow ~200-300 ms late (plus
// sensor and Bluetooth latency); the session measures it once over the first
// active sections and then compensates everywhere. Pure.

import type { Action } from "../funscript/parse.ts";
import { positionAt } from "./normalize.ts";

/** Assumed lag until one is measured, ms. */
export const DEFAULT_LAG_MS = 250;

export interface LagOptions {
  /** largest lag tried, ms (default 800); the search runs 0..maxLagMs */
  maxLagMs: number;
  /** step between tried lags, ms (default 10); the peak is refined below that */
  stepMs: number;
  /** fewest samples to try at all (default 20) */
  minSamples: number;
  /** both signals must move at least this much (std. deviation, position units; default 5) */
  minStd: number;
  /** best Pearson correlation needed (default 0.5) */
  minCorrelation: number;
  /**
   * Periodic strokes correlate again one period later. The earliest local
   * peak within this margin of the best correlation wins (default 0.03).
   */
  tieMargin: number;
}

export const DEFAULT_LAG_OPTIONS: LagOptions = {
  maxLagMs: 800,
  stepMs: 10,
  minSamples: 20,
  minStd: 5,
  minCorrelation: 0.5,
  tieMargin: 0.03,
};

function std(v: number[]): number {
  if (v.length === 0) return 0;
  let m = 0;
  for (const x of v) m += x;
  m /= v.length;
  let s = 0;
  for (const x of v) s += (x - m) ** 2;
  return Math.sqrt(s / v.length);
}

/** Pearson correlation; NaN when either side is constant. */
function pearson(x: number[], y: number[]): number {
  const n = x.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}

/**
 * Lag in ms (0..maxLagMs) that best lines the samples up with the script:
 * the user's position at script time t matches the script at t - lag.
 * `samples[].t` is script time (ms), `pos` the calibrated position.
 * Pearson correlation ignores offset and scale, so a rough calibration is
 * fine. Undefined with too few samples, too little movement or no clear match.
 */
export function estimateLag(
  script: Action[],
  samples: { t: number; pos: number }[],
  opts?: Partial<LagOptions>,
): number | undefined {
  const o: LagOptions = { ...DEFAULT_LAG_OPTIONS, ...opts };
  const pts = samples.filter((s) => Number.isFinite(s.t) && Number.isFinite(s.pos));
  if (script.length < 2 || pts.length < o.minSamples) return undefined;
  const y = pts.map((s) => s.pos);
  if (std(y) < o.minStd) return undefined;

  const step = Math.max(1, o.stepMs);
  const lags: number[] = [];
  for (let l = 0; l <= o.maxLagMs + 1e-9; l += step) lags.push(l);
  const r = lags.map((l) => {
    const x = pts.map((s) => positionAt(script, s.t - l));
    if (std(x) < o.minStd) return NaN;
    return pearson(x, y);
  });

  let best = -Infinity;
  for (const v of r) if (v > best) best = v;
  if (!(best >= o.minCorrelation)) return undefined;

  const at = (k: number) => (Number.isFinite(r[k]) ? r[k] : -Infinity);
  let pick = -1;
  for (let k = 0; k < r.length; k++) {
    const v = at(k);
    if (v < best - o.tieMargin) continue;
    if ((k === 0 || v >= at(k - 1)) && (k === r.length - 1 || v >= at(k + 1))) {
      pick = k;
      break;
    }
  }
  if (pick < 0) pick = r.indexOf(best);

  // parabolic refinement between the neighbours
  let lag = lags[pick];
  if (pick > 0 && pick < r.length - 1) {
    const a = at(pick - 1);
    const b = at(pick);
    const c = at(pick + 1);
    const den = a - 2 * b + c;
    if (Number.isFinite(den) && den < 0) lag += (0.5 * (a - c) * step) / den;
  }
  return Math.round(Math.max(0, Math.min(o.maxLagMs, lag)));
}
