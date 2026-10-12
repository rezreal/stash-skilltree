// When the expensive checks run, which prompts can be checked at all, and
// which runner results reach the session. Pure.
//
// - The microphone is open only from `leadSec` before a repeat window until
//   it ends; video analysis runs only from `leadSec` before a gaze window
//   (whose target needs the person) until it ends; the webcam runs at the
//   action rate around action windows. Windows already passed or failed
//   don't count.
// - A prompt whose sensor is unavailable (mic denied, analysis failed, no
//   camera, no eye tracker) can't be checked: its result is not reported,
//   so it neither passes nor fails the clip.

import type { Id } from "../core/types.ts";
import type { PersonParts } from "../perception/vision.ts";
import type { GazeTarget, PromptEvents, PromptPhase, PromptSpec } from "../prompts/types.ts";

export const DEFAULT_LEAD_SEC = 1;

/** Gaze targets located without analysing the video. */
const NO_PERSON_TARGETS: readonly GazeTarget[] = ["screen_center", "off_screen", "feet_floor"];
/** feet_floor has a person-free fallback but is better with the pose */
const PERSON_HELPS: readonly GazeTarget[] = ["feet_floor"];

/** The target can only be located on the analysed video frame. */
export function needsPerson(target: GazeTarget | undefined): boolean {
  return target !== undefined && !NO_PERSON_TARGETS.includes(target);
}

/** The target benefits from analysis (needs it, or is better with it). */
export function wantsAnalysis(target: GazeTarget | undefined): boolean {
  return target !== undefined && (needsPerson(target) || PERSON_HELPS.includes(target));
}

/** The MediaPipe models a set of targets needs (pose always: it finds the person). */
export function personPartsFor(targets: Iterable<GazeTarget | undefined>): PersonParts {
  const parts: PersonParts = { pose: false, face: false, hands: false };
  for (const t of targets) {
    if (!wantsAnalysis(t)) continue;
    parts.pose = true;
    if (t === "eyes" || t === "face" || t === "mouth") parts.face = true;
    if (t === "hands") parts.hands = true;
  }
  return parts;
}

// --- which specs run --------------------------------------------------------------

export interface SkippedSpec {
  spec: PromptSpec;
  why: string;
}

export interface SpecSelection {
  specs: PromptSpec[];
  skipped: SkippedSpec[];
}

/**
 * Specs the settings allow: repeat needs speechEnabled, gaze targets that
 * need the person need videoAnalysis. Spend is never run here. Skipped specs
 * are never checked nor reported.
 */
export function selectSpecs(
  specs: readonly PromptSpec[],
  settings: { speechEnabled: boolean; videoAnalysis: boolean },
): SpecSelection {
  const out: SpecSelection = { specs: [], skipped: [] };
  for (const spec of specs) {
    if (spec.check === "spend") continue;
    if (spec.check === "repeat" && !settings.speechEnabled) {
      out.skipped.push({ spec, why: "speech recognition is off" });
    } else if (spec.check === "gaze" && needsPerson(spec.target) && !settings.videoAnalysis) {
      out.skipped.push({ spec, why: "video analysis is off" });
    } else out.specs.push(spec);
  }
  return out;
}

// --- availability -----------------------------------------------------------------

export interface SensorAvailability {
  /** speech can be recognized (model loaded, mic not failed) */
  speech: boolean;
  /** video analysis works (models loaded, not failed) */
  vision: boolean;
  /** the webcam runs */
  camera: boolean;
  /** an eye tracker (or the mouse stand-in) is connected */
  tracker: boolean;
}

/** Why `spec` can't be checked now, or undefined when it can. */
export function uncheckableReason(spec: PromptSpec, a: SensorAvailability): string | undefined {
  switch (spec.check) {
    case "repeat":
      return a.speech ? undefined : "no microphone / speech recognition";
    case "gaze":
      if (!a.tracker) return "no eye tracker connected";
      if (needsPerson(spec.target) && !a.vision) return "video analysis unavailable";
      return undefined;
    case "action":
      return a.camera ? undefined : "camera off";
    default:
      return "not checked here";
  }
}

/**
 * Drops results of prompts that can't be checked, and seek requests that
 * only serve such prompts' replays. `newlyReplaying` = specs that went to
 * "replaying" in this runner call (their seek is to start - leadSec).
 */
export function filterPromptEvents(
  events: PromptEvents,
  specs: ReadonlyMap<Id, PromptSpec>,
  newlyReplaying: readonly PromptSpec[],
  blocked: (spec: PromptSpec) => boolean,
  leadSec: number = DEFAULT_LEAD_SEC,
): PromptEvents {
  const results = events.results.filter((r) => {
    const spec = specs.get(r.markerId);
    return spec === undefined || !blocked(spec);
  });
  if (events.requests.length === 0 || newlyReplaying.length === 0) return { results, requests: events.requests };
  const wanted = newlyReplaying.filter((s) => !blocked(s));
  if (wanted.length === 0) return { results, requests: [] };
  if (wanted.length === newlyReplaying.length) return { results, requests: events.requests };
  const to = Math.min(...wanted.map((s) => Math.max(0, s.start - leadSec)));
  return { results, requests: [{ type: "seek", to }] };
}

/** Specs whose phase changed to "replaying" between two snapshots. */
export function newlyReplaying(
  before: ReadonlyMap<Id, PromptPhase>,
  after: readonly { spec: PromptSpec; phase: PromptPhase }[],
): PromptSpec[] {
  return after.filter((p) => p.phase === "replaying" && before.get(p.spec.markerId) !== "replaying").map((p) => p.spec);
}

// --- scheduling ---------------------------------------------------------------------

export interface ScheduleEntry {
  spec: PromptSpec;
  phase: PromptPhase;
}

export interface CheckSchedule {
  /** the microphone should be open */
  mic: boolean;
  /** the video should be analysed this tick */
  analysis: boolean;
  /** models to run when analysing */
  parts: PersonParts;
  /** the webcam should run at the action rate */
  actionRate: boolean;
  /** a gaze window is active (the attention rule is suspended meanwhile) */
  gazeActive: boolean;
  /** specs in phase "active" */
  active: PromptSpec[];
}

const PENDING: readonly PromptPhase[] = ["upcoming", "active", "replaying"];

/** Inside [start - lead, end) of a window that is not decided yet. */
export function isNear(e: ScheduleEntry, videoTime: number, leadSec: number): boolean {
  return PENDING.includes(e.phase) && videoTime >= e.spec.start - leadSec && videoTime < e.spec.end;
}

export function scheduleChecks(
  entries: readonly ScheduleEntry[],
  videoTime: number,
  opts?: { leadSec?: number },
): CheckSchedule {
  const lead = opts?.leadSec ?? DEFAULT_LEAD_SEC;
  const out: CheckSchedule = {
    mic: false,
    analysis: false,
    parts: { pose: false, face: false, hands: false },
    actionRate: false,
    gazeActive: false,
    active: [],
  };
  if (!Number.isFinite(videoTime)) return out;
  const targets: GazeTarget[] = [];
  for (const e of entries) {
    if (e.phase === "active") out.active.push(e.spec);
    if (!isNear(e, videoTime, lead)) continue;
    switch (e.spec.check) {
      case "repeat":
        out.mic = true;
        break;
      case "gaze":
        if (e.phase === "active") out.gazeActive = true;
        if (wantsAnalysis(e.spec.target)) targets.push(e.spec.target!);
        break;
      case "action":
        out.actionRate = true;
        break;
      default:
        break;
    }
  }
  if (targets.length > 0) {
    out.analysis = true;
    out.parts = personPartsFor(targets);
  }
  return out;
}
