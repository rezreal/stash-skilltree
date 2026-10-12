// The calibration screen's steps as a pure reducer:
//   intro -> [device pass] -> point i recording -> fitted -> verify -> saved
// The device pass runs only when the tracker calibrates itself (Tobii): the
// screen shows the same points and the component feeds them to the tracker.
// The affine pass then measures what is left and fits the correction on
// top. Side effects (fullscreen, the tracker, storage) stay in the component;
// it reports their outcome as events. Times are performance.now() ms.
import type { Calibration, ViewportPoint } from "../gaze/types.ts";
import { applyCalibration, collectFixation, fitCalibration, type CalibrationPair } from "../gaze/index.ts";
import { distancePx } from "./gazeGeometry.ts";

/** how long each point is shown */
export const POINT_MS = 1200;
/** the start of each point is the eye travelling there: not recorded */
export const DISCARD_MS = 300;
export const VERIFY_POINTS = 4;

export interface TimedPoint {
  t: number;
  x: number;
  y: number;
}

export type { CalibrationPair };

export interface VerifyResult {
  target: ViewportPoint;
  /** calibrated fixation; undefined when the gaze wasn't steady */
  measured?: ViewportPoint;
  errorPx?: number;
}

interface Recording {
  targets: ViewportPoint[];
  index: number;
  startedMs: number;
  /** uncalibrated viewport samples for the current point, after DISCARD_MS */
  samples: TimedPoint[];
}

export type CalibrationState =
  | { step: "intro"; message?: string }
  | {
      step: "device";
      stage: "starting" | "point" | "finishing";
      targets: ViewportPoint[];
      index: number;
      startedMs: number;
      /** the tracker took the current point */
      added: boolean;
    }
  | ({ step: "point"; pairs: CalibrationPair[]; missed: number; device: boolean } & Recording)
  | { step: "fitted"; calibration: Calibration; pairs: CalibrationPair[]; missed: number; device: boolean }
  | ({ step: "verify"; calibration: Calibration; pairs: CalibrationPair[]; device: boolean; results: VerifyResult[] } & Recording)
  | { step: "failed"; message: string }
  | { step: "saved"; calibration: Calibration; device: boolean };

export type CalibrationEvent =
  | { type: "start"; targets: ViewportPoint[]; nowMs: number; device: boolean }
  /** the tracker's calibration started */
  | { type: "deviceReady"; nowMs: number }
  /** the tracker took point `index` */
  | { type: "deviceAdded"; index: number }
  /** the tracker stored its calibration: on to the affine pass */
  | { type: "deviceFinished"; nowMs: number }
  | { type: "deviceFailed"; message: string }
  /** advances the clock; `samples` = uncalibrated viewport points since the last tick */
  | { type: "tick"; nowMs: number; nowIso: string; samples?: TimedPoint[] }
  | { type: "verify"; targets: ViewportPoint[]; nowMs: number }
  | { type: "saved"; calibration: Calibration; device?: boolean }
  | { type: "retry" }
  | { type: "cancel"; message?: string };

export interface CalibrationDeps {
  collectFixation: (samples: ViewportPoint[]) => ViewportPoint | undefined;
  fitCalibration: (pairs: CalibrationPair[], nowIso: string) => Calibration;
  applyCalibration: (p: ViewportPoint, c: Calibration) => ViewportPoint;
}

export const GAZE_DEPS: CalibrationDeps = { collectFixation, fitCalibration, applyCalibration };

export const INITIAL_CALIBRATION_STATE: CalibrationState = { step: "intro" };

/** fewest steady points an affine fit is made from */
export function minPairs(targets: number): number {
  return Math.max(3, Math.ceil(targets / 2));
}

function record(rec: Recording, samples: TimedPoint[] | undefined, nowMs: number): TimedPoint[] {
  if (!samples || samples.length === 0) return rec.samples;
  const from = rec.startedMs + DISCARD_MS;
  const until = rec.startedMs + POINT_MS;
  const kept = samples.filter((s) => s.t >= from && s.t <= until && s.t <= nowMs + 1);
  return kept.length > 0 ? [...rec.samples, ...kept] : rec.samples;
}

function fixation(samples: TimedPoint[], deps: CalibrationDeps): ViewportPoint | undefined {
  if (samples.length === 0) return undefined;
  return deps.collectFixation(samples.map((s) => ({ x: s.x, y: s.y })));
}

export function calibrationStep(
  state: CalibrationState,
  event: CalibrationEvent,
  deps: CalibrationDeps = GAZE_DEPS,
): CalibrationState {
  switch (event.type) {
    case "start":
      if (event.targets.length === 0) return { step: "failed", message: "There are no points to show." };
      if (event.device) {
        return { step: "device", stage: "starting", targets: event.targets, index: 0, startedMs: event.nowMs, added: false };
      }
      return { step: "point", targets: event.targets, index: 0, startedMs: event.nowMs, samples: [], pairs: [], missed: 0, device: false };

    case "deviceReady":
      if (state.step !== "device" || state.stage !== "starting") return state;
      return { ...state, stage: "point", index: 0, startedMs: event.nowMs, added: false };

    case "deviceAdded":
      if (state.step !== "device" || state.stage !== "point" || state.index !== event.index) return state;
      return { ...state, added: true };

    case "deviceFinished":
      if (state.step !== "device") return state;
      return { step: "point", targets: state.targets, index: 0, startedMs: event.nowMs, samples: [], pairs: [], missed: 0, device: true };

    case "deviceFailed":
      if (state.step !== "device") return state;
      return { step: "failed", message: `The tracker's calibration failed: ${event.message}` };

    case "tick":
      return tick(state, event, deps);

    case "verify":
      if (state.step !== "fitted" && !(state.step === "verify" && verifyDone(state))) return state;
      if (event.targets.length === 0) return state;
      return {
        step: "verify",
        calibration: state.calibration,
        pairs: state.pairs,
        device: state.device,
        targets: event.targets,
        index: 0,
        startedMs: event.nowMs,
        samples: [],
        results: [],
      };

    case "saved":
      return { step: "saved", calibration: event.calibration, device: event.device ?? ("device" in state && state.device === true) };

    case "retry":
      return { step: "intro" };

    case "cancel":
      return event.message ? { step: "intro", message: event.message } : { step: "intro" };
  }
}

function tick(
  state: CalibrationState,
  event: { nowMs: number; nowIso: string; samples?: TimedPoint[] },
  deps: CalibrationDeps,
): CalibrationState {
  const { nowMs } = event;
  if (state.step === "device") {
    if (state.stage !== "point" || !state.added || nowMs - state.startedMs < POINT_MS) return state;
    if (state.index + 1 < state.targets.length) {
      return { ...state, index: state.index + 1, startedMs: nowMs, added: false };
    }
    return { ...state, stage: "finishing" };
  }

  if (state.step === "point") {
    const samples = record(state, event.samples, nowMs);
    if (nowMs - state.startedMs < POINT_MS) return samples === state.samples ? state : { ...state, samples };
    const measured = fixation(samples, deps);
    const pairs = measured ? [...state.pairs, { measured, target: state.targets[state.index] }] : state.pairs;
    const missed = measured ? state.missed : state.missed + 1;
    if (state.index + 1 < state.targets.length) {
      return { ...state, index: state.index + 1, startedMs: nowMs, samples: [], pairs, missed };
    }
    const need = minPairs(state.targets.length);
    if (pairs.length < need) {
      return {
        step: "failed",
        message:
          `Only ${pairs.length} of ${state.targets.length} points had a steady gaze (${need} needed). ` +
          "Sit still, keep your eyes on each dot until it is gone, and try again.",
      };
    }
    try {
      return { step: "fitted", calibration: deps.fitCalibration(pairs, event.nowIso), pairs, missed, device: state.device };
    } catch (err) {
      return { step: "failed", message: `The correction could not be fitted: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  if (state.step === "verify") {
    if (verifyDone(state)) return state;
    const samples = record(state, event.samples, nowMs);
    if (nowMs - state.startedMs < POINT_MS) return samples === state.samples ? state : { ...state, samples };
    const target = state.targets[state.index];
    const fix = fixation(samples, deps);
    const measured = fix ? deps.applyCalibration(fix, state.calibration) : undefined;
    const result: VerifyResult = measured ? { target, measured, errorPx: distancePx(measured, target) } : { target };
    return { ...state, index: state.index + 1, startedMs: nowMs, samples: [], results: [...state.results, result] };
  }

  return state;
}

/** all verification points are recorded */
export function verifyDone(state: { step: "verify"; index: number; targets: ViewportPoint[] }): boolean {
  return state.index >= state.targets.length;
}

/** mean error of the verified points, undefined when none had a steady gaze */
export function verifyError(results: VerifyResult[]): number | undefined {
  const errors = results.map((r) => r.errorPx).filter((e): e is number => e !== undefined);
  return errors.length > 0 ? errors.reduce((a, b) => a + b, 0) / errors.length : undefined;
}

/** the dot currently shown, if any */
export function currentTarget(state: CalibrationState): ViewportPoint | undefined {
  if (state.step === "device") return state.stage === "point" ? state.targets[state.index] : undefined;
  if (state.step === "point") return state.targets[state.index];
  if (state.step === "verify" && !verifyDone(state)) return state.targets[state.index];
  return undefined;
}

/** "Tracker calibration · point 3 of 9" */
export function progressLabel(state: CalibrationState): string | undefined {
  switch (state.step) {
    case "device":
      if (state.stage === "starting") return "Tracker calibration · starting…";
      if (state.stage === "finishing") return "Tracker calibration · storing…";
      return `Tracker calibration · point ${state.index + 1} of ${state.targets.length}`;
    case "point":
      return `${state.device ? "Correction" : "Calibration"} · point ${state.index + 1} of ${state.targets.length}`;
    case "verify":
      return verifyDone(state) ? undefined : `Check · point ${state.index + 1} of ${state.targets.length}`;
    default:
      return undefined;
  }
}

/**
 * `n` random check points inside the middle 70% of the screen, at least a
 * fifth of the shorter side apart where possible.
 */
export function verifyTargets(width: number, height: number, n = VERIFY_POINTS, random: () => number = Math.random): ViewportPoint[] {
  const out: ViewportPoint[] = [];
  const minGap = Math.min(width, height) / 5;
  for (let i = 0; i < n; i++) {
    let p: ViewportPoint = { x: width / 2, y: height / 2 };
    for (let tries = 0; tries < 20; tries++) {
      p = { x: width * (0.15 + 0.7 * random()), y: height * (0.15 + 0.7 * random()) };
      if (out.every((q) => distancePx(p, q) >= minGap)) break;
    }
    out.push(p);
  }
  return out;
}

/** "23 px" */
export function errorText(px: number | undefined): string {
  return px !== undefined && Number.isFinite(px) ? `${Math.round(px)} px` : "—";
}

/** a verdict on the mean error, for the result screen */
export function errorVerdict(px: number | undefined): { text: string; tone: "blue" | "orange" | "red" } {
  if (px === undefined) return { text: "No steady gaze was measured.", tone: "red" };
  if (px <= 40) return { text: "Good: about a finger's width at arm's length.", tone: "blue" };
  if (px <= 90) return { text: "Usable for attention, a bit coarse for small targets.", tone: "orange" };
  return { text: "Too coarse. Check the tracker's position and try again.", tone: "red" };
}
