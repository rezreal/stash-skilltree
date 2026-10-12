// Gaze target check: did the gaze stay on the target region? Stateful,
// time-injected (t in ms, the gaze timebase), no DOM.
//
// Scoring depends on the window length:
// - windows up to LONG_WINDOW_SEC (10 s): the hold rule - the target must be
//   held continuously for holdSec once anywhere in the window.
// - longer windows (sustained): passed iff the share of evidence time spent
//   on the target is >= SUSTAINED_MIN_SHARE (0.75) and at least holdSec of
//   it was on target (a few samples of evidence can't pass a long window).
//   Time without evidence (no region, no eyes_closed evidence) neither counts
//   nor is required. Progress = share / SUSTAINED_MIN_SHARE, capped at 1.
//   Time while the video is paused counts like playing time (the checks run
//   on the wall clock); pauses are short next to such windows.
//
// current(t) is the per-moment state ("on" | "off" | "unknown"): during an
// active gaze prompt it replaces the session's attention target (see
// src/session/checksWiring.ts), so the viewer is paused when not following
// the prompt. "unknown" (no fresh sample, target not located, no evidence)
// never pauses.
//
// The target "eyes_closed" has no region: the viewer is told to close the
// eyes ("close your eyes" in a gaze sequence). In short windows it passes
// when the eyes stay closed for min(holdSec, EYES_CLOSED_GAZE.maxHoldSec) -
// the same hold as the webcam action eyes_closed, so both variants of the
// instruction ask the same of the viewer. Evidence comes from two sources,
// both optional:
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
//
// idle(t): a later, overlapping gaze prompt supersedes this one (the runner
// feeds only the latest-started active gaze prompt); from t on the time
// counts as no evidence.

import { ACTION_THRESHOLDS } from "./actionCheck.ts";
import { createHoldTracker, createShareTracker } from "./hold.ts";
import type { HoldState, HoldTracker, ShareTracker } from "./hold.ts";
import { pointInRegion } from "./regions.ts";
import type { ViewportPoint } from "../gaze/types.ts";
import type { CheckResult, PromptSpec, Region, ViewerFrame } from "./types.ts";

/** exits shorter than this don't break the hold (blinks, saccades, jitter) */
export const GAZE_EXIT_TOLERANCE_MS = 300;

/** windows longer than this (seconds) are scored by share, not by a continuous hold */
export const LONG_WINDOW_SEC = 10;
/** long windows pass when at least this share of the evidence time was on target */
export const SUSTAINED_MIN_SHARE = 0.75;
/** a region target's last sample describes the moment for this long, ms */
export const GAZE_STALE_MS = 400;

/** The per-moment state of a gaze prompt: following it, not, or no evidence. */
export type GazeMoment = "on" | "off" | "unknown";

const MOMENT: Readonly<Record<HoldState, GazeMoment>> = { in: "on", out: "off", unknown: "unknown" };

/** The window is long: scored by share (sustained), not by the hold rule. */
export function isSustained(spec: Pick<PromptSpec, "start" | "end">): boolean {
  return spec.end - spec.start > LONG_WINDOW_SEC;
}

/** "eyes closed 82% · need 75%" / "on target 40% · need 75%" (share floored, so a shown 75% passes) */
export function shareText(target: PromptSpec["target"], share: number | undefined): string {
  const label = target === "eyes_closed" ? "eyes closed" : "on target";
  const pct = share === undefined || !Number.isFinite(share) ? "–" : `${Math.floor(Math.min(1, Math.max(0, share)) * 100)}%`;
  return `${label} ${pct} · need ${Math.round(SUSTAINED_MIN_SHARE * 100)}%`;
}

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
  /** superseded by a later gaze prompt: from t on, time counts as no evidence */
  idle(t: number): void;
  /** the moment at t (ms, gaze timebase): on target, off, or no evidence */
  current(t: number): GazeMoment;
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

/** hold rule for short windows, share for long ones */
function score(
  spec: PromptSpec,
  hold: HoldTracker,
  share: ShareTracker,
  holdDetail: (bestSec: number) => string,
): CheckResult {
  if (isSustained(spec)) {
    const sh = share.share;
    const passed = sh !== undefined && sh >= SUSTAINED_MIN_SHARE && share.onMs >= hold.needMs;
    const progress = passed ? 1 : Math.min(1, (sh ?? 0) / SUSTAINED_MIN_SHARE, share.onMs / hold.needMs);
    const r: CheckResult = { passed, progress, detail: shareText(spec.target, sh) };
    if (sh !== undefined) r.share = sh;
    return r;
  }
  const passed = hold.passed;
  return {
    passed,
    progress: passed ? 1 : Math.min(1, hold.bestMs / hold.needMs),
    detail: holdDetail(hold.bestMs / 1000),
  };
}

export function createGazeTargetCheck(spec: PromptSpec, opts?: GazeCheckOptions): GazeTargetCheck {
  if (spec.target === "eyes_closed") return createEyesClosedCheck(spec, opts);
  const maxDtMs = opts?.maxGapMs ?? 250;
  const hold = createHoldTracker({
    needMs: spec.holdSec * 1000,
    toleranceMs: opts?.exitToleranceMs ?? GAZE_EXIT_TOLERANCE_MS,
    maxDtMs,
  });
  const share = createShareTracker({ maxDtMs });
  let last: { t: number; state: HoldState } | undefined;
  const video = createVideoClock();
  const add = (t: number, state: HoldState): void => {
    hold.push(t, state);
    share.push(t, state);
  };
  return {
    spec,
    push(i) {
      if (!inWindow(spec, i.videoTime)) {
        hold.cut();
        share.cut();
        last = undefined;
        return;
      }
      const state =
        i.region === undefined
          ? "unknown"
          : i.gazeValid && i.gaze !== undefined && pointInRegion(i.gaze, i.region)
            ? "in"
            : "out";
      if (Number.isFinite(i.t)) last = { t: i.t, state };
      // a paused clip asks nothing: only time the video moves on counts
      if (video.advanced(i.videoTime)) add(i.t, state);
      else {
        hold.cut();
        share.cut();
      }
    },
    pushViewer() {
      // region targets don't use the webcam
    },
    idle(t) {
      add(t, "unknown");
      last = undefined;
    },
    current(t) {
      return last !== undefined && Math.abs(t - last.t) <= GAZE_STALE_MS ? MOMENT[last.state] : "unknown";
    },
    result() {
      return score(spec, hold, share, (s) => `held ${s.toFixed(1)} of ${spec.holdSec.toFixed(1)} s`);
    },
    reset() {
      hold.reset();
      share.reset();
      last = undefined;
    },
  };
}

/**
 * Tells whether the video moved on since the previous sample. Paused or
 * buffering video keeps its time; a seek moves it either way and counts as
 * moving (the window check handles leaving the window).
 */
function createVideoClock(): { advanced(videoTime: number): boolean } {
  let prev: number | undefined;
  return {
    advanced(videoTime) {
      const moved = prev === undefined || Math.abs(videoTime - prev) > 1e-4;
      prev = videoTime;
      return moved;
    },
  };
}

function inWindow(spec: PromptSpec, videoTime: number): boolean {
  return Number.isFinite(videoTime) && videoTime >= spec.start - EPS && videoTime <= spec.end + EPS;
}

function createEyesClosedCheck(spec: PromptSpec, opts?: GazeCheckOptions): GazeTargetCheck {
  const needSec = eyesClosedHoldSec(spec.holdSec);
  const maxDtMs = opts?.maxGapMs ?? 250;
  const hold = createHoldTracker({
    needMs: needSec * 1000,
    toleranceMs: EYES_CLOSED_GAZE.flickerMs,
    maxDtMs,
  });
  const share = createShareTracker({ maxDtMs });
  let tracker: { t: number; eyes: Eyes } | undefined;
  let webcam: { t: number; eyes: Eyes } | undefined;
  /** last time pushed into the hold (the two streams interleave) */
  let lastT = -Infinity;
  const video = createVideoClock();
  let playing = true;

  const fresh = (e: { t: number; eyes: Eyes } | undefined, t: number): Eyes =>
    e !== undefined && t - e.t <= EYES_CLOSED_GAZE.staleMs ? e.eyes : "unknown";
  const moment = (t: number): HoldState => combineEyes(fresh(tracker, t), fresh(webcam, t));

  function step(t: number): void {
    // streams may be slightly out of order: never step the hold backwards
    const at = Math.max(t, lastT);
    lastT = at;
    if (!playing) return;
    const state = moment(at);
    hold.push(at, state);
    share.push(at, state);
  }

  function forget(): void {
    tracker = undefined;
    webcam = undefined;
    lastT = -Infinity;
  }

  return {
    spec,
    push(i) {
      if (!Number.isFinite(i.t)) return;
      if (!inWindow(spec, i.videoTime)) {
        hold.cut();
        share.cut();
        forget();
        return;
      }
      tracker = { t: i.t, eyes: trackerEyes(i) };
      // a paused clip asks nothing: only time the video moves on counts,
      // but the current state keeps following the eyes so the clip resumes
      playing = video.advanced(i.videoTime);
      if (!playing) {
        hold.cut();
        share.cut();
        lastT = -Infinity;
      }
      step(i.t);
    },
    pushViewer(f) {
      if (!Number.isFinite(f.t)) return;
      webcam = { t: f.t, eyes: webcamEyes(f) };
      step(f.t);
    },
    idle(t) {
      if (!Number.isFinite(t)) return;
      tracker = undefined;
      webcam = undefined;
      step(t);
    },
    current(t) {
      return MOMENT[moment(t)];
    },
    result() {
      return score(spec, hold, share, (s) => `eyes closed ${s.toFixed(1)} of ${needSec.toFixed(1)} s`);
    },
    reset() {
      hold.reset();
      share.reset();
      forget();
    },
  };
}
