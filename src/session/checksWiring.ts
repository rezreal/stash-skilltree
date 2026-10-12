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
// - Attention per tick = present AND (gaze or the focus/activity stand-in).
//   While a gaze prompt's window is active the gaze part is suspended (PLAN:
//   gaze prompts suspend the attention rule; the prompt itself is scored by
//   the prompts rule): the tick counts as attending unless presence says
//   otherwise, so the viewer can follow "look at ..." prompts without
//   grace/pause, but leaving the camera's view still counts.
// - Track: the latest overall score is reported to the session while the
//   track is scored (calibrated sensor, readings arrived); without a sensor
//   nothing is reported and the track rule stays unscored.
import { attentionWithPresence } from "../checks/adjust.ts";
import { presencePauseText, presenceReasonText } from "../checks/attention.ts";
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
 * Presence (the shared webcam) runs while the session does: always when the
 * webcam is required (the gate turned it on), otherwise only when camera
 * permission is already granted, so the browser never prompts mid-clip.
 */
export function presenceWanted(input: { required: boolean; permission: CameraPermission; finished: boolean }): boolean {
  if (input.finished) return false;
  return input.required || input.permission === "granted";
}

/**
 * The tick's attention verdict: the reading (gaze or stand-in) AND presence.
 * During an active gaze prompt the reading counts as attending.
 */
export function sessionAttending(
  reading: AttentionReading,
  presence: PresenceLike | undefined,
  opts: { required: boolean; gazePromptActive: boolean },
): boolean {
  const base: AttentionReading = opts.gazePromptActive ? { ...reading, attending: true } : reading;
  return attentionWithPresence(base, presence, opts.required).attending;
}

/** sessionAttending as useSkilltreeSession's adjustAttention, reading its inputs on every tick */
export function sessionAdjuster(
  get: () => { presence: PresenceLike | undefined; required: boolean; gazePromptActive: boolean },
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
  /** presence (not gaze) is why attention fails */
  byPresence: boolean;
}

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/**
 * Why attention fails, in words: presence when it is the reason (absent
 * viewer; a stalled / off camera only when the webcam is required), the
 * gaze reasons otherwise.
 */
export function attentionTexts(reading: AttentionReading, presence: PresenceLike | undefined, required: boolean): AttentionTexts {
  const p = presencePauseText(presence, required);
  if (p) {
    const grace = presence ? capitalize(presenceReasonText(presence.reason)) : "Camera off";
    return { pause: p, grace, byPresence: true };
  }
  return { pause: pauseReasonText(reading), grace: graceText(reading), byPresence: false };
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
