// Stroking seen by the webcam: a wrist moving up and down at the lap. Pure.
//
// Positions are body-relative: the origin is the hip midpoint and the unit
// the shoulder width (x scaled by the frame aspect), so sitting a little
// nearer or farther doesn't change them. That needs the shoulders and the
// hips in view; without them a frame is "unknown" with a framing hint
// (strokeFraming).
//
// A swing is the wrist reversing after travelling at least `swingAmp` in y
// (hysteresis, like the nod detector, so jitter never counts). Stroking holds
// while swings keep coming (the last one at most `gapMs` ago) with the wrist
// in the stroke zone around the calibrated centre; hands_off is the opposite.
//
// The calibration (the stroke-camera page) picks the stroking hand, the zone
// centre, the stroke size and the rate from 5 s of stroking and 3 s of rest.
// Without one, both wrists are watched around the hips with default sizes.

import { POSE } from "./types.ts";
import type { NormPoint } from "./types.ts";

export interface StrokeCalibration {
  v: 1;
  /** the stroking wrist (POSE side, as seen by the camera model) */
  hand: "left" | "right";
  /** the wrist's centre while stroking, body-relative (hip midpoint, shoulder widths) */
  cx: number;
  cy: number;
  /** stroke size: peak-to-peak of the wrist's y while stroking, shoulder widths */
  amplitude: number;
  /** strokes (up and down) per second while calibrating */
  rateHz: number;
  savedAt: string;
}

export const STROKE = {
  /** visibility shoulders and hips need */
  bodyVisibility: 0.5,
  /** visibility the wrist needs (a hand at the lap is often half hidden) */
  wristVisibility: 0.3,
  /** without a calibration: zone centre below the hip midpoint and stroke size */
  defaultCy: 0.1,
  defaultAmplitude: 0.2,
  /** the zone: this far from the centre (shoulder widths) still counts */
  zoneX: 0.6,
  zoneY: 0.6,
  /** a swing needs this share of the calibrated stroke size, at least minSwing */
  swingShare: 0.45,
  minSwing: 0.05,
  /** stroking holds while the last swing is at most this old (ms); slower calibrated rates stretch it */
  gapMs: 1200,
  maxGapMs: 2500,
  /** calibration: the stroke must be at least this big and this fast, the hand seen this often */
  minAmplitude: 0.08,
  minRateHz: 0.5,
  minCoverage: 0.6,
  /** calibration: resting must move less than this share of the stroke size */
  maxRestShare: 0.5,
} as const;

export type StrokeState = "in" | "out" | "unknown";

const visible = (p: NormPoint | undefined, min: number): p is NormPoint =>
  !!p && (p.visibility === undefined || p.visibility >= min);

/** hip midpoint and shoulder width (aspect-scaled), or what's missing */
function bodyFrame(pose: readonly NormPoint[] | undefined, aspect: number): { hx: number; hy: number; sw: number } | "shoulders" | "hips" {
  const v = STROKE.bodyVisibility;
  const ls = pose?.[POSE.leftShoulder];
  const rs = pose?.[POSE.rightShoulder];
  if (!visible(ls, v) || !visible(rs, v)) return "shoulders";
  const lh = pose?.[POSE.leftHip];
  const rh = pose?.[POSE.rightHip];
  if (!visible(lh, v) || !visible(rh, v)) return "hips";
  const sw = Math.hypot((ls.x - rs.x) * aspect, ls.y - rs.y);
  if (!(sw > 0)) return "shoulders";
  return { hx: ((lh.x + rh.x) / 2) * aspect, hy: (lh.y + rh.y) / 2, sw };
}

/** a wrist body-relative (hip midpoint, shoulder widths; y down), undefined when it can't be placed */
export function wristRel(
  pose: readonly NormPoint[] | undefined,
  hand: "left" | "right",
  aspect = 4 / 3,
): { x: number; y: number } | undefined {
  const b = bodyFrame(pose, aspect);
  if (typeof b === "string") return undefined;
  const w = pose?.[hand === "left" ? POSE.leftWrist : POSE.rightWrist];
  if (!visible(w, STROKE.wristVisibility)) return undefined;
  return { x: (w.x * aspect - b.hx) / b.sw, y: (w.y - b.hy) / b.sw };
}

export const FRAMING_HINTS = {
  notInView: "Sit in front of the camera",
  shoulders: "Move back a little so the camera sees your shoulders",
  hips: "Tilt the camera down so it sees your lap",
  hands: "Keep your hands where the camera can see them",
} as const;

/** can the camera judge stroking? The first thing missing, in plain words. */
export function strokeFraming(pose: readonly NormPoint[] | undefined, aspect = 4 / 3): { ok: boolean; hint?: string } {
  if (!pose || pose.length === 0) return { ok: false, hint: FRAMING_HINTS.notInView };
  const b = bodyFrame(pose, aspect);
  if (b === "shoulders") return { ok: false, hint: FRAMING_HINTS.shoulders };
  if (b === "hips") return { ok: false, hint: FRAMING_HINTS.hips };
  if (!wristRel(pose, "left", aspect) && !wristRel(pose, "right", aspect)) return { ok: false, hint: FRAMING_HINTS.hands };
  return { ok: true };
}

// --- swings ----------------------------------------------------------------------

interface Swings {
  push(t: number, y: number): void;
  /** times of the swings so far (ms), oldest first, at most the last 16 */
  readonly times: readonly number[];
  reset(): void;
}

function createSwings(amp: number): Swings {
  let dir: 0 | 1 | -1 = 0;
  let hi = -Infinity;
  let lo = Infinity;
  let ext = 0;
  let times: number[] = [];
  const swing = (t: number) => {
    times.push(t);
    if (times.length > 16) times = times.slice(-16);
  };
  return {
    push(t, y) {
      if (!Number.isFinite(y)) return;
      if (dir === 0) {
        hi = Math.max(hi, y);
        lo = Math.min(lo, y);
        if (hi - lo >= amp) {
          // moving towards the latest value's side
          dir = y >= hi ? 1 : -1;
          ext = y;
          swing(t);
        }
        return;
      }
      if (dir === 1 ? y > ext : y < ext) ext = y;
      else if (Math.abs(ext - y) >= amp) {
        dir = dir === 1 ? -1 : 1;
        ext = y;
        swing(t);
      }
    },
    get times() {
      return times;
    },
    reset() {
      dir = 0;
      hi = -Infinity;
      lo = Infinity;
      ext = 0;
      times = [];
    },
  };
}

// --- the per-frame tracker -------------------------------------------------------------

export interface StrokeTracker {
  /** one webcam frame; returns whether the viewer is stroking right now */
  push(t: number, pose: readonly NormPoint[] | undefined, aspect?: number): StrokeState;
  /** strokes per minute over the last few seconds, undefined before two swings */
  ratePerMin(t: number): number | undefined;
  /** what keeps the camera from judging (framing), when the last frame was unknown */
  readonly hint: string | undefined;
  reset(): void;
}

export function createStrokeTracker(cal?: StrokeCalibration): StrokeTracker {
  const S = STROKE;
  const hands: ("left" | "right")[] = cal ? [cal.hand] : ["left", "right"];
  const cx = cal?.cx ?? 0;
  const cy = cal?.cy ?? S.defaultCy;
  const amplitude = cal?.amplitude ?? S.defaultAmplitude;
  const amp = Math.max(S.minSwing, S.swingShare * amplitude);
  // a calibrated slow stroke may leave more time between swings
  const gap = cal ? Math.min(S.maxGapMs, Math.max(S.gapMs, 1000 / cal.rateHz)) : S.gapMs;
  const swings = new Map(hands.map((h) => [h, createSwings(amp)] as const));
  let hint: string | undefined;

  const inZone = (p: { x: number; y: number }) => Math.abs(p.x - cx) <= S.zoneX && Math.abs(p.y - cy) <= S.zoneY;

  return {
    push(t, pose, aspect = 4 / 3) {
      let seen = false;
      let stroking = false;
      for (const h of hands) {
        const p = wristRel(pose, h, aspect);
        if (!p) continue;
        seen = true;
        const sw = swings.get(h)!;
        if (!inZone(p)) continue;
        sw.push(t, p.y);
        // the last two swings close together, the last one recent
        const last = sw.times[sw.times.length - 1];
        const prev = sw.times[sw.times.length - 2];
        if (last !== undefined && prev !== undefined && t - last <= gap && last - prev <= 2 * gap) stroking = true;
      }
      if (!seen) {
        hint = strokeFraming(pose, aspect).hint ?? FRAMING_HINTS.hands;
        return "unknown";
      }
      hint = undefined;
      return stroking ? "in" : "out";
    },
    ratePerMin(t) {
      let best: number | undefined;
      for (const sw of swings.values()) {
        const recent = sw.times.filter((x) => t - x <= 4000);
        if (recent.length < 2) continue;
        const span = Math.max(recent[recent.length - 1]! - recent[0]!, 1);
        // two swings per stroke
        const perMin = ((recent.length - 1) / 2 / span) * 60_000;
        best = best === undefined ? perMin : Math.max(best, perMin);
      }
      return best;
    },
    get hint() {
      return hint;
    },
    reset() {
      for (const sw of swings.values()) sw.reset();
      hint = undefined;
    },
  };
}

// --- calibration -------------------------------------------------------------------------

export interface PoseSample {
  t: number;
  pose?: readonly NormPoint[];
  aspect?: number;
}

const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]!;
};

/** robust peak-to-peak: 90th minus 10th percentile */
const spread = (xs: number[]): number => (xs.length < 2 ? 0 : quantile(xs, 0.9) - quantile(xs, 0.1));

/**
 * A calibration from samples while stroking and while resting, or why not.
 * The stroking hand is the wrist whose y moved most; it must be seen in at
 * least minCoverage of the stroking frames, move at least minAmplitude at
 * minRateHz or faster, and move clearly less while resting.
 */
export function calibrateStroke(
  stroking: readonly PoseSample[],
  resting: readonly PoseSample[],
  savedAt: string,
): { ok: true; calibration: StrokeCalibration } | { ok: false; problem: string } {
  const S = STROKE;
  if (stroking.length < 10) return { ok: false, problem: "Too few camera frames. Keep the camera on and try again." };
  let best: { hand: "left" | "right"; pts: { t: number; x: number; y: number }[]; amp: number } | undefined;
  for (const hand of ["left", "right"] as const) {
    const pts = stroking.flatMap((s) => {
      const p = wristRel(s.pose, hand, s.aspect);
      return p ? [{ t: s.t, ...p }] : [];
    });
    const amp = spread(pts.map((p) => p.y));
    if (!best || amp > best.amp) best = { hand, pts, amp };
  }
  if (!best || best.pts.length < S.minCoverage * stroking.length) {
    const framing = strokeFraming(stroking[stroking.length - 1]?.pose, stroking[stroking.length - 1]?.aspect);
    return { ok: false, problem: `The camera didn't see your hand at your lap often enough. ${framing.hint ?? FRAMING_HINTS.hands}.` };
  }
  if (best.amp < S.minAmplitude) return { ok: false, problem: "No clear up-and-down movement. Stroke with longer movements, then try again." };
  const sw = createSwings(Math.max(S.minSwing, S.swingShare * best.amp));
  for (const p of best.pts) sw.push(p.t, p.y);
  const span = (stroking[stroking.length - 1]!.t - stroking[0]!.t) / 1000;
  const rateHz = span > 0 ? sw.times.length / 2 / span : 0;
  if (rateHz < S.minRateHz) return { ok: false, problem: "That was too slow to tell from resting. Stroke at your usual pace, then try again." };
  const rest = resting.flatMap((s) => {
    const p = wristRel(s.pose, best.hand, s.aspect);
    return p ? [p.y] : [];
  });
  if (rest.length >= 5 && spread(rest) > S.maxRestShare * best.amp) {
    return { ok: false, problem: "Your hand moved almost as much while resting. Keep it still during the rest, then try again." };
  }
  return {
    ok: true,
    calibration: {
      v: 1,
      hand: best.hand,
      cx: quantile(best.pts.map((p) => p.x), 0.5),
      cy: quantile(best.pts.map((p) => p.y), 0.5),
      amplitude: best.amp,
      rateHz,
      savedAt,
    },
  };
}

/** parses a stored calibration; undefined when missing or malformed */
export function parseStrokeCalibration(text: string | undefined): StrokeCalibration | undefined {
  if (!text) return undefined;
  try {
    const c = JSON.parse(text) as Partial<StrokeCalibration>;
    const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
    if (c.v !== 1 || (c.hand !== "left" && c.hand !== "right")) return undefined;
    if (!num(c.cx) || !num(c.cy) || !num(c.amplitude) || !num(c.rateHz) || !(c.amplitude! > 0) || !(c.rateHz! > 0)) return undefined;
    return { v: 1, hand: c.hand, cx: c.cx!, cy: c.cy!, amplitude: c.amplitude!, rateHz: c.rateHz!, savedAt: String(c.savedAt ?? "") };
  } catch {
    return undefined;
  }
}
