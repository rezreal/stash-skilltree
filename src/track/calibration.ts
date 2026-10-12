// Raw sensor distance -> script position 0..100, plus slow drift correction
// learned while the script is idle (the user should be at rest, ~0). Pure;
// the caller keeps the calibration (e.g. in localStorage via serialize/parse).

import type { TrackCalibration } from "./types.ts";

/** Readings closer together than this (raw units) can't be told apart. */
const MIN_SPAN = 1e-6;

/**
 * Calibration from two readings: at rest (position 0) and at the deepest
 * point (100). Either may be the larger. Throws a RangeError when they are
 * equal or not finite.
 */
export function calibrate(rawAtZero: number, rawAtFull: number, nowIso: string): TrackCalibration {
  if (!Number.isFinite(rawAtZero) || !Number.isFinite(rawAtFull) || Math.abs(rawAtFull - rawAtZero) < MIN_SPAN) {
    throw new RangeError("calibration needs two different readings");
  }
  return { rawAtZero, rawAtFull, drift: 0, createdAt: nowIso };
}

/** Linear position without drift and without clamping (may leave 0..100). */
export function linearPosition(raw: number, cal: TrackCalibration): number {
  const span = cal.rawAtFull - cal.rawAtZero;
  if (Math.abs(span) < MIN_SPAN) return 0;
  return ((raw - cal.rawAtZero) / span) * 100;
}

/**
 * Readings past the deepest point by more than this share of the calibrated
 * span are not a deeper push but the sensor losing its target: backed off
 * out of range, many distance sensors report 0 or their maximum.
 */
export const NO_TARGET_MARGIN = 0.5;

/**
 * The sensor sees nothing: a reading far beyond the deepest point, or 0 when
 * 0 lies outside the calibrated range (the usual "no echo" value). Treated
 * as fully out, never as fully in.
 */
export function isNoTarget(raw: number, cal: TrackCalibration): boolean {
  if (!Number.isFinite(raw)) return true;
  const lo = Math.min(cal.rawAtZero, cal.rawAtFull);
  const hi = Math.max(cal.rawAtZero, cal.rawAtFull);
  if (raw === 0 && (lo > 0 || hi < 0)) return true;
  return linearPosition(raw, cal) > 100 * (1 + NO_TARGET_MARGIN);
}

/** Calibrated position: linear minus drift, clamped to 0..100; no target reads as 0 (out). */
export function toPosition(raw: number, cal: TrackCalibration): number {
  if (isNoTarget(raw, cal)) return 0;
  const p = linearPosition(raw, cal) - cal.drift;
  if (!(p > 0)) return 0; // also -0 and NaN
  return p > 100 ? 100 : p;
}

export interface DriftOptions {
  /** the reading must be stable for this long before correcting, ms (default 1000) */
  stableMs: number;
  /** "stable": standard deviation of the linear position at most this (default 2) */
  maxStd: number;
  /** time constant of the correction, ms: drift moves 63 % of the way in this time (default 3000) */
  tauMs: number;
  /** |drift| never exceeds this, position units (default 15) */
  maxDrift: number;
  /** samples further apart than this restart the stability window, ms (default 500) */
  maxGapMs: number;
}

export const DEFAULT_DRIFT_OPTIONS: DriftOptions = {
  stableMs: 1000,
  maxStd: 2,
  tauMs: 3000,
  maxDrift: 15,
  maxGapMs: 500,
};

export interface DriftTracker {
  /**
   * One reading. `expected` is the script position the user should be at
   * (lag-compensated) while the script is idle; undefined outside idle
   * sections, which resets the tracker. Returns the calibration, a new
   * object when the drift changed.
   */
  push(raw: number, tMs: number, cal: TrackCalibration, expected?: number): TrackCalibration;
  reset(): void;
}

/**
 * Idle-time drift correction: while the script is idle and the reading has
 * been stable for stableMs, the drift moves (exponentially, tauMs) towards
 * the offset between the reading and where the user should be, bounded by
 * maxDrift.
 */
export function createDriftTracker(opts?: Partial<DriftOptions>): DriftTracker {
  const o: DriftOptions = { ...DEFAULT_DRIFT_OPTIONS, ...opts };
  let win: { t: number; off: number }[] = [];
  let lastT: number | undefined;

  const reset = () => {
    win = [];
    lastT = undefined;
  };

  return {
    reset,
    push(raw, tMs, cal, expected) {
      if (expected === undefined || !Number.isFinite(raw) || !Number.isFinite(tMs)) {
        reset();
        return cal;
      }
      const prevT = lastT;
      // a gap or a step back in time restarts the stability window
      if (prevT !== undefined && (tMs <= prevT || tMs - prevT > o.maxGapMs)) win = [];
      lastT = tMs;
      if (isNoTarget(raw, cal)) {
        // nothing in front of the sensor says nothing about its drift
        win.length = 0;
        return cal;
      }
      win.push({ t: tMs, off: linearPosition(raw, cal) - expected });
      while (win.length > 1 && tMs - win[1].t >= o.stableMs) win.shift();
      if (tMs - win[0].t < o.stableMs || win.length < 3) return cal;

      let sum = 0;
      for (const w of win) sum += w.off;
      const m = sum / win.length;
      let v = 0;
      for (const w of win) v += (w.off - m) ** 2;
      if (Math.sqrt(v / win.length) > o.maxStd) return cal;

      const dt = prevT !== undefined && tMs > prevT ? tMs - prevT : 0;
      const k = 1 - Math.exp(-dt / o.tauMs);
      const target = Math.max(-o.maxDrift, Math.min(o.maxDrift, m));
      const drift = Math.max(-o.maxDrift, Math.min(o.maxDrift, cal.drift + (target - cal.drift) * k));
      return drift === cal.drift ? cal : { ...cal, drift };
    },
  };
}

// --- persistence ---------------------------------------------------------------

export function serializeTrackCalibration(cal: TrackCalibration): string {
  return JSON.stringify({ rawAtZero: cal.rawAtZero, rawAtFull: cal.rawAtFull, drift: cal.drift, createdAt: cal.createdAt });
}

/** Lenient parse of serializeTrackCalibration output; undefined when unusable. */
export function parseTrackCalibration(text: string | null | undefined): TrackCalibration | undefined {
  if (!text) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  const rawAtZero = num(o.rawAtZero);
  const rawAtFull = num(o.rawAtFull);
  if (rawAtZero === undefined || rawAtFull === undefined || Math.abs(rawAtFull - rawAtZero) < MIN_SPAN) return undefined;
  return {
    rawAtZero,
    rawAtFull,
    drift: num(o.drift) ?? 0,
    createdAt: typeof o.createdAt === "string" ? o.createdAt : "",
  };
}
