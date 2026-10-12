// Ties calibration, drift correction, lag estimation and scoring together
// for the player: feed raw sensor readings with the video time they arrived
// at, ask for the guide frame when drawing and the score when reporting.
// Pure apart from its own state; time is injected.

import type { Action, Funscript } from "../funscript/parse.ts";
import { createDriftTracker, toPosition } from "./calibration.ts";
import type { DriftOptions } from "./calibration.ts";
import { guideFrame } from "./guide.ts";
import { DEFAULT_LAG_MS, estimateLag } from "./lag.ts";
import type { LagOptions } from "./lag.ts";
import { positionAt, scriptActions } from "./normalize.ts";
import { createTrackScorer, sectionAt } from "./score.ts";
import type { ScoreParams } from "./score.ts";
import { segment } from "./sections.ts";
import { DEFAULT_LIMITS } from "./types.ts";
import type { GuideFrame, Section, SectionParams, TrackCalibration, TrackLimits, TrackScore } from "./types.ts";

/** Active (stroke / ramp) script time collected before each lag estimate, ms. */
export const LAG_WINDOW_MS = 15_000;
/** At most this much active script time is kept for the estimate, ms. */
const LAG_BUFFER_MS = 60_000;
/** Without a reading for this long the guide shows no current position, ms. */
const STALE_MS = 1000;
/** Video steps larger than this between two samples are seeks, ms. */
const SEEK_MS = 1000;

export interface TrackSessionOptions {
  /** the funscript (inverted / range applied here) or already normalised actions */
  script: Funscript | Action[];
  calibration: TrackCalibration;
  /** user limits (default DEFAULT_LIMITS) */
  limits?: TrackLimits;
  sectionParams?: Partial<SectionParams>;
  scoreParams?: Partial<ScoreParams>;
  driftOptions?: Partial<DriftOptions>;
  lagOptions?: Partial<LagOptions>;
  /** a known lag: skips the estimate */
  lagMs?: number;
  /** sensor rate when known; otherwise measured from arrival times */
  sensorRateHz?: number;
  /** guide preview length, ms (default 3000) */
  previewMs?: number;
}

export interface TrackSession {
  readonly actions: Action[];
  readonly sections: Section[];
  /**
   * One raw reading: `tMs` its arrival time (performance.now() timebase),
   * `videoTimeSec` the video position at that moment. Returns the
   * calibrated position 0..100.
   */
  pushSample(raw: number, tMs: number, videoTimeSec: number): number;
  /** guide frame at the video position; `nowMs` hides a stale current position */
  guide(videoTimeSec: number, nowMs?: number): GuideFrame;
  score(): TrackScore;
  /** calibration with the drift learned so far (persist it after the session) */
  calibration(): TrackCalibration;
  lagMs(): number;
  /** true once the lag was measured (or given) */
  lagMeasured(): boolean;
  /** sensor rate in use, Hz */
  sensorRate(): number | undefined;
}

function medianOf(v: number[]): number | undefined {
  if (v.length === 0) return undefined;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function createTrackSession(opts: TrackSessionOptions): TrackSession {
  const actions = Array.isArray(opts.script) ? opts.script : scriptActions(opts.script);
  const sections = segment(actions, opts.sectionParams, opts.limits ?? DEFAULT_LIMITS);
  const fixedLag = opts.lagMs !== undefined && Number.isFinite(opts.lagMs);
  const scorerOpts: Parameters<typeof createTrackScorer>[0] = { actions, sections, lagMs: fixedLag ? (opts.lagMs as number) : DEFAULT_LAG_MS };
  if (opts.sensorRateHz !== undefined) scorerOpts.sensorRateHz = opts.sensorRateHz;
  if (opts.scoreParams) scorerOpts.params = opts.scoreParams;
  const scorer = createTrackScorer(scorerOpts);
  const drift = createDriftTracker(opts.driftOptions);

  let cal = opts.calibration;
  let measured = fixedLag;
  let lastPos: number | undefined;
  let lastArrival: number | undefined;
  let lastScriptMs: number | undefined;
  const arrivals: number[] = [];
  let rate = opts.sensorRateHz;

  let lagSamples: { t: number; pos: number; dt: number }[] = [];
  let activeMs = 0;
  let nextTry = LAG_WINDOW_MS;

  const updateRate = (tMs: number) => {
    if (opts.sensorRateHz !== undefined) return;
    arrivals.push(tMs);
    if (arrivals.length > 21) arrivals.shift();
    const dts: number[] = [];
    for (let k = 1; k < arrivals.length; k++) {
      const dt = arrivals[k] - arrivals[k - 1];
      if (dt > 0 && dt < 1000) dts.push(dt);
    }
    const m = medianOf(dts);
    if (m === undefined || dts.length < 4) return;
    const hz = 1000 / m;
    if (rate === undefined || Math.abs(hz - rate) / rate > 0.05) {
      rate = hz;
      scorer.setSensorRate(hz);
    }
  };

  const collectLag = (scriptMs: number, pos: number, dt: number) => {
    if (measured) return;
    const sec = sectionAt(sections, scriptMs - scorer.lag());
    if (!sec || sec.unscored || (sec.kind !== "stroke" && sec.kind !== "ramp")) return;
    lagSamples.push({ t: scriptMs, pos, dt });
    activeMs += dt;
    let kept = 0;
    for (const s of lagSamples) kept += s.dt;
    while (kept > LAG_BUFFER_MS && lagSamples.length > 0) kept -= (lagSamples.shift() as { dt: number }).dt;
    if (activeMs < nextTry) return;
    nextTry += LAG_WINDOW_MS;
    const lag = estimateLag(actions, lagSamples, opts.lagOptions);
    if (lag !== undefined) {
      scorer.setLag(lag);
      measured = true;
      lagSamples = [];
    }
  };

  return {
    actions,
    sections,
    pushSample(raw, tMs, videoTimeSec) {
      const scriptMs = videoTimeSec * 1000;
      if (!Number.isFinite(raw) || !Number.isFinite(scriptMs)) return lastPos ?? 0;
      updateRate(tMs);
      const prev = lastScriptMs;
      const advancing = prev !== undefined && scriptMs > prev && scriptMs - prev <= SEEK_MS;
      lastScriptMs = scriptMs;

      const te = scriptMs - scorer.lag();
      const sec = sectionAt(sections, te);
      cal = drift.push(raw, tMs, cal, advancing && sec?.kind === "idle" ? positionAt(actions, te) : undefined);

      const pos = toPosition(raw, cal);
      lastPos = pos;
      lastArrival = tMs;
      scorer.push({ scriptMs, pos });
      if (advancing) collectLag(scriptMs, pos, scriptMs - (prev as number));
      return pos;
    },
    guide(videoTimeSec, nowMs) {
      const fresh = lastPos !== undefined && (nowMs === undefined || lastArrival === undefined || nowMs - lastArrival <= STALE_MS);
      const input: Parameters<typeof guideFrame>[0] = { actions, sections, scriptMs: videoTimeSec * 1000, lagMs: scorer.lag() };
      if (fresh) input.current = lastPos;
      if (opts.previewMs !== undefined) input.previewMs = opts.previewMs;
      return guideFrame(input);
    },
    score: () => scorer.result(),
    calibration: () => cal,
    lagMs: () => scorer.lag(),
    lagMeasured: () => measured,
    sensorRate: () => scorer.sensorRate(),
  };
}
