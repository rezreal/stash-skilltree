// How the live checks (src/checks: webcam presence, prompt checks) and the
// track rule (src/player/useTrack.ts) plug into the session on stash's scene
// player. Pure decisions, tested under node --test; StashSession.tsx does
// the React side.
//
// - Camera: with the webcamRequired setting the CameraGate runs before the
//   session (playback held) and presence runs for the whole session. Without
//   it there is no gate: presence starts silently when the site already has
//   camera permission (never a browser prompt mid-clip), otherwise the
//   session runs without presence and webcam action prompts aren't checked.
// - Microphone: a clip with repeat prompts gets the mic gate (after the
//   camera gate) whenever speech recognition is on; there is no way past it
//   without the mic other than switching speech recognition off.
// - Attention per tick = present AND (gaze or the focus/activity stand-in).
//   While a gaze prompt's window is active the prompt REPLACES the gaze
//   part (PLAN: prompts): attending = following the prompt (gaze inside the
//   target region; eyes_closed: eyes closed per the tracker / webcam
//   evidence), with no evidence counting as attending. The session's usual
//   grace -> pause -> resume -> abort machinery runs on that value, so
//   "close your eyes" pauses the clip while the eyes are open and resumes
//   it when they close again (no gaze on the video needed). Presence still
//   ANDs in. The prompt itself is scored by the prompts rule.
// - Track: the latest overall score is reported to the session while the
//   track is scored (calibrated sensor, readings arrived); without a sensor
//   nothing is reported and the track rule stays unscored.
import { attentionWithPresence } from "../checks/adjust.ts";
import { combineAttention, presencePauseText, presenceReasonText } from "../checks/attention.ts";
import { promptAttentionText } from "../checks/wording.ts";
import type { MarkerInput } from "../core/types.ts";
import { promptSpecs } from "../prompts/specs.ts";
import type { PromptSpec } from "../prompts/types.ts";
import { graceText, pauseReasonText, type AttentionReading, type PauseText } from "../player/gazeView.ts";

/** PresenceInfo or anything shaped like it */
export type PresenceLike = { present: boolean; reason: string };

/** The camera's permission as CameraGate's useCameraPermission sees it. */
export type CameraPermission = "granted" | "denied" | "prompt" | "unknown";

/** The camera gate stands before the session: required and not passed yet. */
export function needsCameraGate(required: boolean, gatePassed: boolean): boolean {
  return required && !gatePassed;
}

/**
 * The clip has repeat prompts that will be checked (prompts and speech
 * recognition on): the mic gate asks for the microphone before it starts,
 * so the browser never prompts mid-clip and a missing mic can't quietly
 * drop the prompts.
 */
export function clipNeedsMic(
  markers: readonly MarkerInput[],
  settings: { promptsEnabled: boolean; speechEnabled: boolean },
): boolean {
  if (!settings.promptsEnabled || !settings.speechEnabled) return false;
  return promptSpecs([...markers]).some((s) => s.check === "repeat");
}

/**
 * Presence (the shared webcam) runs while the session does: always when the
 * webcam is required (the gate turned it on), otherwise only when camera
 * permission is already granted, so the browser never prompts mid-clip.
 */
export function presenceWanted(input: { required: boolean; permission: CameraPermission; finished: boolean }): boolean {
  if (input.finished) return false;
  return input.required || input.permission === "granted";
}

/** PromptAttention (usePromptChecks.promptAttention) or anything shaped like it */
export type PromptAttentionLike = { attending: boolean; reason: string; spec: Pick<PromptSpec, "target"> };

/**
 * The tick's attention verdict: the reading (gaze or stand-in) AND presence.
 * During an active gaze prompt (prompt defined) the prompt's verdict
 * replaces the reading.
 */
export function sessionAttending(
  reading: AttentionReading,
  presence: PresenceLike | undefined,
  opts: { required: boolean; prompt?: PromptAttentionLike | undefined },
): boolean {
  // a hidden or covered window never counts - except with the eyes closed
  if (reading.background && opts.prompt?.spec.target !== "eyes_closed") return false;
  if (opts.prompt) {
    return combineAttention({ attending: opts.prompt.attending, reason: opts.prompt.reason }, presence, opts.required).attending;
  }
  return attentionWithPresence(reading, presence, opts.required).attending;
}

/**
 * sessionAttending as useSkilltreeSession's adjustAttention, reading its
 * inputs on every tick (the session's nowMs is Date.now(); prompt and
 * presence run on performance.now(), so get() reads them itself).
 */
export function sessionAdjuster(
  get: () => { presence: PresenceLike | undefined; required: boolean; prompt?: PromptAttentionLike | undefined },
): (reading: AttentionReading, nowMs: number) => boolean {
  return (reading) => {
    const { presence, ...opts } = get();
    return sessionAttending(reading, presence, opts);
  };
}

export interface AttentionTexts {
  /** the inattention overlay / callout title */
  pause: PauseText;
  /** the banner and callout during the grace period */
  grace: string;
  /** what to do, short: the callout detail while paused ("Look back at the video") */
  back: string;
  /** presence (not gaze) is why attention fails */
  byPresence: boolean;
}

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

const BACK = "Look back at the video";

/**
 * Why attention fails, in words: presence when it is the reason (absent
 * viewer; a stalled / off camera only when the webcam is required), else
 * the active gaze prompt ("Your eyes are open – close them to continue",
 * "Look at their eyes to continue"), else the gaze reasons.
 */
export function attentionTexts(
  reading: AttentionReading,
  presence: PresenceLike | undefined,
  required: boolean,
  prompt?: PromptAttentionLike,
): AttentionTexts {
  const p = presencePauseText(presence, required);
  if (p) {
    const grace = presence ? capitalize(presenceReasonText(presence.reason)) : "Camera off";
    return { pause: p, grace, back: BACK, byPresence: true };
  }
  if (reading.background && prompt?.spec.target !== "eyes_closed") {
    return { pause: pauseReasonText(reading), grace: graceText(reading), back: "Bring the window to the front", byPresence: false };
  }
  if (prompt) {
    const t = promptAttentionText(prompt.spec);
    return { pause: t.pause, grace: t.grace, back: t.back, byPresence: false };
  }
  return { pause: pauseReasonText(reading), grace: graceText(reading), back: BACK, byPresence: false };
}

/** What the score feed needs of useTrackSession's TrackHandle. */
export interface ScoredTrack {
  scored(): boolean;
  score(): { overall?: number };
}

/** how often the live track score is reported to the session (ms) */
export const TRACK_REPORT_MS = 1000;

/**
 * The track score to report now, or undefined: nothing while the track
 * isn't scored (no calibration, no sensor readings) or has no scored
 * section yet, and nothing when it equals the last reported score.
 */
export function trackScoreToReport(track: ScoredTrack | undefined, last: number | undefined): number | undefined {
  if (!track || !track.scored()) return undefined;
  const overall = track.score().overall;
  if (overall === undefined || !Number.isFinite(overall)) return undefined;
  if (last !== undefined && Math.abs(overall - last) < 1e-9) return undefined;
  return overall;
}
