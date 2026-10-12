// Gaze target check: did the gaze hold on the target region for holdSec?
// Stateful, time-injected (t in ms, the gaze timebase), no DOM.

import { createHoldTracker } from "./hold.ts";
import { pointInRegion } from "./regions.ts";
import type { ViewportPoint } from "../gaze/types.ts";
import type { CheckResult, PromptSpec, Region } from "./types.ts";

/** exits shorter than this don't break the hold (blinks, saccades, jitter) */
export const GAZE_EXIT_TOLERANCE_MS = 300;

export interface GazeCheckInput {
  /** ms */
  t: number;
  /** video seconds; samples outside the spec window are ignored */
  videoTime: number;
  gaze?: ViewportPoint;
  gazeValid: boolean;
  /** undefined = the target cannot be located right now (neither in nor out) */
  region?: Region;
}

export interface GazeCheckOptions {
  exitToleranceMs?: number;
  /** longest interval between samples that still counts, ms */
  maxGapMs?: number;
}

export interface GazeTargetCheck {
  readonly spec: PromptSpec;
  push(input: GazeCheckInput): void;
  result(): CheckResult;
  reset(): void;
}

export function createGazeTargetCheck(spec: PromptSpec, opts?: GazeCheckOptions): GazeTargetCheck {
  const hold = createHoldTracker({
    needMs: spec.holdSec * 1000,
    toleranceMs: opts?.exitToleranceMs ?? GAZE_EXIT_TOLERANCE_MS,
    maxDtMs: opts?.maxGapMs ?? 250,
  });
  const EPS = 0.05;
  return {
    spec,
    push(i) {
      if (!Number.isFinite(i.videoTime) || i.videoTime < spec.start - EPS || i.videoTime > spec.end + EPS) {
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
