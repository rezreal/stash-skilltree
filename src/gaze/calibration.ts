// Page-level gaze calibration: an affine correction fitted from fixations on
// known targets, applied after the geometric screen->viewport mapping
// (mapping.ts). It absorbs what the geometry model gets wrong (chrome
// heights, mixed DPI, tracker offset). Pure; storage is the caller's.

import { applyCalibration } from "./mapping.ts";
import { IDENTITY_CALIBRATION } from "./types.ts";
import type { Calibration, ViewportPoint } from "./types.ts";

export interface CalibrationPair {
  /** where the mapped gaze was while the user looked at the target */
  measured: ViewportPoint;
  /** where the target was drawn */
  target: ViewportPoint;
}

function finitePoint(p: ViewportPoint | undefined): p is ViewportPoint {
  return p !== undefined && Number.isFinite(p.x) && Number.isFinite(p.y);
}

function meanResidual(pairs: CalibrationPair[], c: Calibration): number {
  if (pairs.length === 0) return 0;
  let sum = 0;
  for (const p of pairs) {
    const q = applyCalibration(p.measured, c);
    sum += Math.hypot(q.x - p.target.x, q.y - p.target.y);
  }
  return sum / pairs.length;
}

/**
 * Least-squares affine fit (6 parameters) mapping measured -> target, solved
 * via the normal equations in centred coordinates. With fewer than 3 points,
 * or points (nearly) on one line, falls back to translation only.
 */
export function fitCalibration(pairs: CalibrationPair[], nowIso: string): Calibration {
  const ps = pairs.filter((p) => finitePoint(p.measured) && finitePoint(p.target));
  const n = ps.length;
  if (n === 0) return { ...IDENTITY_CALIBRATION, createdAt: nowIso };

  let mx = 0, my = 0, tx = 0, ty = 0;
  for (const p of ps) {
    mx += p.measured.x;
    my += p.measured.y;
    tx += p.target.x;
    ty += p.target.y;
  }
  mx /= n;
  my /= n;
  tx /= n;
  ty /= n;

  let c: Calibration = { ...IDENTITY_CALIBRATION, c: tx - mx, f: ty - my, createdAt: nowIso, points: n };

  if (n >= 3) {
    // centred sums: S = sum u u^T (u = measured - mean), and cross terms with the targets
    let sxx = 0, sxy = 0, syy = 0, sxu = 0, syu = 0, sxv = 0, syv = 0;
    for (const p of ps) {
      const x = p.measured.x - mx;
      const y = p.measured.y - my;
      const u = p.target.x - tx;
      const v = p.target.y - ty;
      sxx += x * x;
      sxy += x * y;
      syy += y * y;
      sxu += x * u;
      syu += y * u;
      sxv += x * v;
      syv += y * v;
    }
    const det = sxx * syy - sxy * sxy;
    const scale = (sxx + syy) * (sxx + syy);
    // det/scale is 0 for collinear points, 1/4 for an isotropic spread
    if (scale > 0 && det / scale > 1e-6) {
      const a = (syy * sxu - sxy * syu) / det;
      const b = (sxx * syu - sxy * sxu) / det;
      const d = (syy * sxv - sxy * syv) / det;
      const e = (sxx * syv - sxy * sxv) / det;
      c = { a, b, c: tx - a * mx - b * my, d, e, f: ty - d * mx - e * my, createdAt: nowIso, errorPx: 0, points: n };
    }
  }
  c.errorPx = meanResidual(ps, c);
  return c;
}

/**
 * Calibration targets in viewport px: centre first, then the corners at 10%
 * insets, and for 9 points the edge midpoints.
 */
export function calibrationPoints(width: number, height: number, count: 5 | 9 = 9): ViewportPoint[] {
  const x0 = width * 0.1, x1 = width * 0.5, x2 = width * 0.9;
  const y0 = height * 0.1, y1 = height * 0.5, y2 = height * 0.9;
  const pts: ViewportPoint[] = [
    { x: x1, y: y1 },
    { x: x0, y: y0 },
    { x: x2, y: y0 },
    { x: x2, y: y2 },
    { x: x0, y: y2 },
  ];
  if (count === 9) pts.push({ x: x1, y: y0 }, { x: x2, y: y1 }, { x: x1, y: y2 }, { x: x0, y: y1 });
  return pts;
}

export interface FixationOptions {
  /** fewer usable samples than this -> undefined */
  minSamples: number;
  /** median distance of the samples from their median point above this -> undefined (CSS px) */
  maxSpreadPx: number;
}

export const DEFAULT_FIXATION: FixationOptions = { minSamples: 8, maxSpreadPx: 50 };

function median(xs: number[]): number {
  const s = [...xs].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Robust centre of the gaze while the user fixated one target: the
 * per-axis median. Rejected (undefined) when there are too few samples or
 * the median distance from that centre exceeds maxSpreadPx (the user wasn't
 * fixating). The caller drops the first ~300ms after the target appears.
 */
export function collectFixation(
  samples: ViewportPoint[],
  opts?: Partial<FixationOptions>,
): ViewportPoint | undefined {
  const o = { ...DEFAULT_FIXATION, ...opts };
  const ps = samples.filter(finitePoint);
  if (ps.length === 0 || ps.length < o.minSamples) return undefined;
  const centre = { x: median(ps.map((p) => p.x)), y: median(ps.map((p) => p.y)) };
  const spread = median(ps.map((p) => Math.hypot(p.x - centre.x, p.y - centre.y)));
  return spread > o.maxSpreadPx ? undefined : centre;
}

export function serializeCalibration(c: Calibration): string {
  const { a, b, c: cc, d, e, f, createdAt, errorPx, points } = c;
  return JSON.stringify({ v: 1, a, b, c: cc, d, e, f, createdAt, errorPx, points });
}

/** Parses what serializeCalibration wrote; undefined on anything else. */
export function parseCalibration(raw: string | null | undefined): Calibration | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof o !== "object" || o === null) return undefined;
  const r = o as Record<string, unknown>;
  const nums = ["a", "b", "c", "d", "e", "f", "errorPx", "points"] as const;
  for (const k of nums) {
    const v = r[k];
    if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  }
  if (typeof r.createdAt !== "string") return undefined;
  const points = r.points as number;
  const errorPx = r.errorPx as number;
  if (points < 0 || !Number.isInteger(points) || errorPx < 0) return undefined;
  return {
    a: r.a as number,
    b: r.b as number,
    c: r.c as number,
    d: r.d as number,
    e: r.e as number,
    f: r.f as number,
    createdAt: r.createdAt,
    errorPx,
    points,
  };
}
