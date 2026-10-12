// Coordinates every prompt of one clip. Pure and time-injected: the player
// calls update() on its tick with the video time and wall clock and feeds the
// perception streams; the runner routes them to the active checks and emits
// results and requests.
//
// Lifecycle per spec: upcoming -> active (start <= videoTime < end) ->
// at window end: passed | replaying (failed, replays left: asks the player to
// seek to start - 1 and re-runs the window with a fresh checker) | failed.
//
// Seeks:
// - Seeking back before an active window's start returns it to upcoming
//   (checker reset); this does not use a replay.
// - Seeking forward past the end of an active window evaluates it with what
//   was collected so far (it may already have passed).
// - Jumping over a whole window that was never active fails it without a
//   replay: the viewer skipped the prompt. This also applies to windows that
//   lie before the first update's video time (starting mid-clip).
// - A replaying spec whose seek request is ignored (the video plays on to
//   more than REPLAY_IGNORED_SEC past the window end) fails.
// Spend specs are not run here (the player handles spend prompts).

import { createActionCheck } from "./actionCheck.ts";
import { createGazeTargetCheck } from "./gazeCheck.ts";
import { targetRegion } from "./regions.ts";
import { createRepeatCheck } from "./speechCheck.ts";
import type { ActionCheck, ActionCheckOptions } from "./actionCheck.ts";
import type { GazeCheckOptions, GazeTargetCheck } from "./gazeCheck.ts";
import type { RegionOptions } from "./regions.ts";
import type { RepeatCheck } from "./speechCheck.ts";
import type { GazeAttentionSample } from "../gaze/types.ts";
import type {
  CheckResult,
  PersonFrame,
  PromptEvents,
  PromptPhase,
  PromptProgress,
  PromptSpec,
  Region,
  SpeechResult,
  VideoBox,
  ViewerFrame,
} from "./types.ts";

export const REPLAY_IGNORED_SEC = 3;
/** person frames older/newer than this (video seconds) don't locate gaze targets */
export const PERSON_MAX_AGE_SEC = 1;

export interface PromptRunnerOptions {
  /** replays allowed per prompt (default 1) */
  replays?: number;
  /** repeat: score needed (default 0.75) */
  repeatThreshold?: number;
  region?: RegionOptions;
  gaze?: GazeCheckOptions;
  action?: ActionCheckOptions;
  /** seconds before the window start a replay seeks to (default 1) */
  replayLeadSec?: number;
}

export interface PromptRunner {
  readonly specs: readonly PromptSpec[];
  update(input: { videoTime: number; nowMs: number }): PromptEvents;
  /** the video ended: evaluates active windows (no replay), fails replaying ones */
  finish(input: { nowMs: number }): PromptEvents;
  /** gaze already mapped to the viewport */
  feedGaze(sample: GazeAttentionSample): void;
  feedSpeech(result: SpeechResult): void;
  feedViewer(frame: ViewerFrame): void;
  /** the analysed video frame; box = where the video is on the page */
  feedPerson(frame: PersonFrame, box?: VideoBox): void;
  setVideoBox(box: VideoBox): void;
  /** the region an active gaze spec currently targets (for overlays/debug) */
  regionFor(spec: PromptSpec): Region | undefined;
  progress(): PromptProgress[];
}

type Check =
  | { kind: "gaze"; c: GazeTargetCheck }
  | { kind: "repeat"; c: RepeatCheck }
  | { kind: "action"; c: ActionCheck };

interface Entry {
  spec: PromptSpec;
  phase: PromptPhase;
  replays: number;
  check?: Check;
  last?: CheckResult;
}

const NO_PERSON = (videoTime: number): PersonFrame => ({ videoTime, poses: [], faces: [], hands: [] });

export function createPromptRunner(specs: PromptSpec[], opts?: PromptRunnerOptions): PromptRunner {
  const maxReplays = Math.max(0, opts?.replays ?? 1);
  const lead = opts?.replayLeadSec ?? 1;
  const entries: Entry[] = specs
    .filter((s) => s.check !== "spend")
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((spec) => ({ spec, phase: "upcoming" as PromptPhase, replays: 0 }));
  let videoTime = NaN;
  let person: PersonFrame | undefined;
  let box: VideoBox | undefined;

  function makeCheck(spec: PromptSpec, nowMs: number): Check | undefined {
    switch (spec.check) {
      case "gaze":
        return { kind: "gaze", c: createGazeTargetCheck(spec, opts?.gaze) };
      case "repeat": {
        const ro = opts?.repeatThreshold !== undefined ? { threshold: opts.repeatThreshold } : undefined;
        const c = createRepeatCheck(spec, ro);
        c.begin(nowMs);
        return { kind: "repeat", c };
      }
      case "action":
        return { kind: "action", c: createActionCheck(spec, opts?.action) };
      default:
        return undefined;
    }
  }

  function activate(e: Entry, nowMs: number): void {
    e.phase = "active";
    const check = makeCheck(e.spec, nowMs);
    if (check !== undefined) e.check = check;
    else delete e.check;
    delete e.last;
  }

  function evaluate(e: Entry, nowMs: number, out: PromptEvents, allowReplay: boolean): void {
    const check = e.check;
    if (check?.kind === "repeat") check.c.end(nowMs);
    const r: CheckResult = check?.c.result() ?? { passed: false, progress: 0, detail: "cannot check" };
    e.last = r;
    delete e.check;
    if (r.passed) {
      e.phase = "passed";
      out.results.push({ markerId: e.spec.markerId, passed: true });
    } else if (allowReplay && e.replays < maxReplays) {
      e.phase = "replaying";
      e.replays++;
      out.requests.push({ type: "seek", to: Math.max(0, e.spec.start - lead) });
    } else {
      e.phase = "failed";
      out.results.push({ markerId: e.spec.markerId, passed: false });
    }
  }

  function fail(e: Entry, out: PromptEvents, detail: string): void {
    e.phase = "failed";
    e.last = { passed: false, progress: e.last?.progress ?? 0, detail };
    delete e.check;
    out.results.push({ markerId: e.spec.markerId, passed: false });
  }

  /** several replays at once: one seek, to the earliest point */
  function merged(out: PromptEvents): PromptEvents {
    if (out.requests.length <= 1) return out;
    const to = Math.min(...out.requests.map((r) => r.to));
    return { results: out.results, requests: [{ type: "seek", to }] };
  }

  function regionFor(spec: PromptSpec): Region | undefined {
    if (spec.target === undefined || box === undefined) return undefined;
    const fresh = person !== undefined && Number.isFinite(videoTime) && Math.abs(person.videoTime - videoTime) <= PERSON_MAX_AGE_SEC;
    const frame = fresh ? person! : NO_PERSON(videoTime);
    return targetRegion(spec.target, frame, box, opts?.region);
  }

  return {
    specs: entries.map((e) => e.spec),

    update({ videoTime: vt, nowMs }) {
      const out: PromptEvents = { results: [], requests: [] };
      if (!Number.isFinite(vt)) return out;
      videoTime = vt;
      for (const e of entries) {
        const { start, end } = e.spec;
        switch (e.phase) {
          case "upcoming":
            if (vt >= end) fail(e, out, "skipped");
            else if (vt >= start) activate(e, nowMs);
            break;
          case "active":
            if (vt < start) {
              e.phase = "upcoming";
              delete e.check;
              delete e.last;
            } else if (vt >= end) evaluate(e, nowMs, out, true);
            break;
          case "replaying":
            if (vt < start) e.phase = "upcoming";
            else if (vt < end) activate(e, nowMs);
            else if (vt > end + REPLAY_IGNORED_SEC) fail(e, out, "replay not watched");
            break;
          default:
            break;
        }
      }
      return merged(out);
    },

    finish({ nowMs }) {
      const out: PromptEvents = { results: [], requests: [] };
      for (const e of entries) {
        if (e.phase === "active") evaluate(e, nowMs, out, false);
        else if (e.phase === "replaying") fail(e, out, "video ended");
      }
      return out;
    },

    feedGaze(sample) {
      for (const e of entries) {
        if (e.phase !== "active" || e.check?.kind !== "gaze") continue;
        const input: Parameters<GazeTargetCheck["push"]>[0] = { t: sample.t, videoTime, gazeValid: sample.valid };
        if (sample.point !== undefined) input.gaze = sample.point;
        const region = regionFor(e.spec);
        if (region !== undefined) input.region = region;
        e.check.c.push(input);
      }
    },

    feedSpeech(result) {
      for (const e of entries) if (e.phase === "active" && e.check?.kind === "repeat") e.check.c.push(result);
    },

    feedViewer(frame) {
      for (const e of entries) if (e.phase === "active" && e.check?.kind === "action") e.check.c.push(frame);
    },

    feedPerson(frame, b) {
      person = frame;
      if (b !== undefined) box = b;
    },

    setVideoBox(b) {
      box = b;
    },

    regionFor,

    progress() {
      return entries.map((e) => {
        const r = e.phase === "active" ? e.check?.c.result() : e.last;
        const p: PromptProgress = {
          spec: e.spec,
          phase: e.phase,
          progress: e.phase === "passed" ? 1 : (r?.progress ?? 0),
          replays: e.replays,
        };
        if (r?.detail !== undefined) p.detail = r.detail;
        return p;
      });
    },
  };
}
