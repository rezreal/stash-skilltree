// Gaze target check: did the gaze hold on the target region for holdSec?
// Stateful, time-injected (t in ms, the gaze timebase), no DOM.
//
// The target "eyes_closed" has no region: the viewer is told to close the
// eyes ("close your eyes" in a gaze sequence). It passes when the eyes stay
// closed for min(holdSec, EYES_CLOSED_GAZE.maxHoldSec) - the same hold as
// the webcam action eyes_closed, so both variants of the instruction ask the
// same of the viewer. Evidence comes from two sources, both optional:
// - the eye tracker (push): connected and reporting the person present but
//   no valid gaze = closed (the tracker's signature of closed eyes); valid
//   gaze = open; not present / presence unknown = no evidence.
// - the webcam (pushViewer): face present and both blink blendshapes
//   >= ACTION_THRESHOLDS.eyesClosedMin = closed; a face with either eye
//   <= ACTION_THRESHOLDS.eyesOpenMax = open; no face, missing or in-between
//   scores = no evidence.
// Each moment combines the latest evidence of each source (older than
// staleMs is ignored): an explicit "open" from either source wins, else a
// "closed" from either counts, else the moment is unknown (neither counts
// nor resets the hold).

import { ACTION_THRESHOLDS } from "./actionCheck.ts";
import { createHoldTracker } from "./hold.ts";
import type { HoldState } from "./hold.ts";
import { pointInRegion } from "./regions.ts";
import type { ViewportPoint } from "../gaze/types.ts";
import type { CheckResult, PromptSpec, Region, ViewerFrame } from "./types.ts";

/** exits shorter than this don't break the hold (blinks, saccades, jitter) */
export const GAZE_EXIT_TOLERANCE_MS = 300;

export const EYES_CLOSED_GAZE = {
  /** the hold is min(holdSec, this), like the eyes_closed action */
  maxHoldSec: ACTION_THRESHOLDS.eyesClosedMaxSec,
  /** "open" flicker shorter than this (a stray valid tracker sample) doesn't break the hold */
  flickerMs: 150,
  /** evidence older than this no longer describes the moment, ms */
  staleMs: 400,
} as const;

/** Seconds an eyes_closed gaze prompt must hold. */
export function eyesClosedHoldSec(holdSec: number): number {
  return Math.max(0.1, Math.min(holdSec, EYES_CLOSED_GAZE.maxHoldSec));
}

export interface GazeCheckInput {
  /** ms */
  t: number;
  /** video seconds; samples outside the spec window are ignored */
  videoTime: number;
  gaze?: ViewportPoint;
  gazeValid: boolean;
  /** undefined = the target cannot be located right now (neither in nor out) */
  region?: Region;
  /** eyes_closed: the tracker reports a person in front of it (undefined = unknown) */
  present?: boolean;
}

export interface GazeCheckOptions {
  exitToleranceMs?: number;
  /** longest interval between samples that still counts, ms */
  maxGapMs?: number;
}

export interface GazeTargetCheck {
  readonly spec: PromptSpec;
  push(input: GazeCheckInput): void;
  /** webcam frames; only eyes_closed uses them (ignored for other targets) */
  pushViewer(frame: ViewerFrame): void;
  result(): CheckResult;
  reset(): void;
}

type Eyes = "closed" | "open" | "unknown";

/** Tracker evidence for eyes_closed. */
export function trackerEyes(i: Pick<GazeCheckInput, "gazeValid" | "present">): Eyes {
  if (i.gazeValid) return "open";
  return i.present === true ? "closed" : "unknown";
}

/** Webcam evidence for eyes_closed. */
export function webcamEyes(f: ViewerFrame): Eyes {
  if (!f.facePresent) return "unknown";
  const l = f.eyeBlinkLeft;
  const r = f.eyeBlinkRight;
  if (l === undefined || r === undefined || !Number.isFinite(l) || !Number.isFinite(r)) return "unknown";
  const T = ACTION_THRESHOLDS;
  if (l >= T.eyesClosedMin && r >= T.eyesClosedMin) return "closed";
  if (l <= T.eyesOpenMax || r <= T.eyesOpenMax) return "open";
  return "unknown";
}

/** open from either source wins, else closed from either, else unknown */
export function combineEyes(a: Eyes, b: Eyes): HoldState {
  if (a === "open" || b === "open") return "out";
  if (a === "closed" || b === "closed") return "in";
  return "unknown";
}

const EPS = 0.05;

export function createGazeTargetCheck(spec: PromptSpec, opts?: GazeCheckOptions): GazeTargetCheck {
  if (spec.target === "eyes_closed") return createEyesClosedCheck(spec, opts);
  const hold = createHoldTracker({
    needMs: spec.holdSec * 1000,
    toleranceMs: opts?.exitToleranceMs ?? GAZE_EXIT_TOLERANCE_MS,
    maxDtMs: opts?.maxGapMs ?? 250,
  });
  return {
    spec,
    push(i) {
      if (!inWindow(spec, i.videoTime)) {
        hold.cut();
        return;
      }
      const state =
        i.region === undefined
          ? "unknown"
          : i.gazeValid && i.gaze !== undefined && pointInRegion(i.gaze, i.region)
            ? "in"
            : "out";
      hold.push(i.t, state);
    },
    pushViewer() {
      // region targets don't use the webcam
    },
    result() {
      const passed = hold.passed;
      return {
        passed,
        progress: passed ? 1 : Math.min(1, hold.bestMs / hold.needMs),
        detail: `held ${(hold.bestMs / 1000).toFixed(1)} of ${spec.holdSec.toFixed(1)} s`,
      };
    },
    reset() {
      hold.reset();
    },
  };
}

function inWindow(spec: PromptSpec, videoTime: number): boolean {
  return Number.isFinite(videoTime) && videoTime >= spec.start - EPS && videoTime <= spec.end + EPS;
}

function createEyesClosedCheck(spec: PromptSpec, opts?: GazeCheckOptions): GazeTargetCheck {
  const needSec = eyesClosedHoldSec(spec.holdSec);
  const hold = createHoldTracker({
    needMs: needSec * 1000,
    toleranceMs: EYES_CLOSED_GAZE.flickerMs,
    maxDtMs: opts?.maxGapMs ?? 250,
  });
  let tracker: { t: number; eyes: Eyes } | undefined;
  let webcam: { t: number; eyes: Eyes } | undefined;
  /** last time pushed into the hold (the two streams interleave) */
  let lastT = -Infinity;

  const fresh = (e: { t: number; eyes: Eyes } | undefined, t: number): Eyes =>
    e !== undefined && t - e.t <= EYES_CLOSED_GAZE.staleMs ? e.eyes : "unknown";

  function step(t: number): void {
    // streams may be slightly out of order: never step the hold backwards
    const at = Math.max(t, lastT);
    lastT = at;
    hold.push(at, combineEyes(fresh(tracker, at), fresh(webcam, at)));
  }

  return {
    spec,
    push(i) {
      if (!Number.isFinite(i.t)) return;
      if (!inWindow(spec, i.videoTime)) {
        hold.cut();
        tracker = undefined;
        webcam = undefined;
        lastT = -Infinity;
        return;
      }
      tracker = { t: i.t, eyes: trackerEyes(i) };
      step(i.t);
    },
    pushViewer(f) {
      if (!Number.isFinite(f.t)) return;
      webcam = { t: f.t, eyes: webcamEyes(f) };
      step(f.t);
    },
    result() {
      const passed = hold.passed;
      return {
        passed,
        progress: passed ? 1 : Math.min(1, hold.bestMs / hold.needMs),
        detail: `eyes closed ${(hold.bestMs / 1000).toFixed(1)} of ${needSec.toFixed(1)} s`,
      };
    },
    reset() {
      hold.reset();
      tracker = undefined;
      webcam = undefined;
      lastT = -Infinity;
    },
  };
}
