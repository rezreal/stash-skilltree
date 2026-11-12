// Talking to the Toy Sync plugin (a separate stash plugin that drives toys -
// Lovense vibrators, DG-LAB Coyote e-stim - from the scene's funscript).
// Only window events, so it works whichever plugin loads first and does
// nothing when Toy Sync isn't installed:
//
//   "toysync:gain"   { source: "skilltree", gain: 0..1 | null }
//       during track clips: full on target, fading the further off; null
//       withdraws it when the clip ends. Toy Sync multiplies all gains.
//   "toysync:nudge"  { source: "skilltree", reason: "track" | "gaze" }
//       one short sharp cue (e-stim only, at the viewer's calibrated nudge
//       level). Toy Sync rate-limits nudges itself, whatever we send.
//
// Pure helpers plus the dispatches, tested under node --test.

export const GAIN_EVENT = "toysync:gain";
export const NUDGE_EVENT = "toysync:nudge";
export const SOURCE = "skilltree";

export type NudgeReason = "track" | "gaze";

/** gain steps: a new value is only sent when it moves a whole step */
export const GAIN_STEP = 0.05;

/**
 * Gain from the match glow's mismatch (0 on target .. 1 fully off): 1 on
 * target, falling to 0 when fully off. Undefined (nothing to judge: no
 * sensor reading, rest, an unscored section) leaves the toy on the script
 * alone (gain 1).
 */
export function gainFromMismatch(mismatch: number | undefined): number {
  if (mismatch === undefined || !Number.isFinite(mismatch)) return 1;
  const g = 1 - Math.min(1, Math.max(0, mismatch));
  return Math.round(g / GAIN_STEP) * GAIN_STEP;
}

/** the track counts as "far off" for a nudge from this mismatch on (deep in the red) */
export const TRACK_NUDGE_MISMATCH = 0.6;

export interface EventTargetLike {
  dispatchEvent(event: Event): boolean;
}

function dispatch(type: string, detail: unknown, target: EventTargetLike | undefined): void {
  if (!target || typeof target.dispatchEvent !== "function" || typeof CustomEvent !== "function") return;
  target.dispatchEvent(new CustomEvent(type, { detail }));
}

/** sends our gain (null = stop gating) to Toy Sync, if it listens */
export function sendToyGain(gain: number | null, target: EventTargetLike | undefined = globalThis as unknown as EventTargetLike): void {
  dispatch(GAIN_EVENT, { source: SOURCE, gain }, target);
}

/** asks Toy Sync for one nudge */
export function sendToyNudge(reason: NudgeReason, target: EventTargetLike | undefined = globalThis as unknown as EventTargetLike): void {
  dispatch(NUDGE_EVENT, { source: SOURCE, reason }, target);
}

/** a BOOLEAN plugin setting that is on unless explicitly turned off */
export function onUnlessOff(setting: unknown): boolean {
  return !(setting === false || setting === "false" || setting === 0 || setting === "0");
}

/**
 * When to nudge for a condition that lasts: once it has held for `afterMs`,
 * then again every `repeatMs` while it still holds; it starts over once the
 * condition ends.
 */
export interface NudgeTimer {
  /** feed the condition at a time; true = send a nudge now */
  update(off: boolean, nowMs: number): boolean;
  reset(): void;
}

export const NUDGE_AFTER_MS = 1000;
export const NUDGE_REPEAT_MS = 5000;

export function createNudgeTimer(afterMs = NUDGE_AFTER_MS, repeatMs = NUDGE_REPEAT_MS): NudgeTimer {
  let since: number | undefined;
  let last: number | undefined;
  return {
    update(off, nowMs) {
      if (!off) {
        since = undefined;
        last = undefined;
        return false;
      }
      if (since === undefined) since = nowMs;
      if (nowMs - since < afterMs) return false;
      if (last !== undefined && nowMs - last < repeatMs) return false;
      last = nowMs;
      return true;
    },
    reset() {
      since = undefined;
      last = undefined;
    },
  };
}

export interface GazeNudgeInput {
  /** the leading gaze prompt's verdict, when one runs: "off" is evidence of not following */
  prompt?: { state: string } | undefined;
  /** the session's attention reading */
  reading: { attending: boolean; source: "gaze" | "fallback"; trackerDown: boolean; background?: boolean };
}

/**
 * The gaze isn't followed, on real evidence: a gaze prompt reports "off"
 * (eyes open during eyes_closed, not on the target region), or the eye
 * tracker sees the viewer looking away from the video. Never on the
 * focus/activity fallback, never without evidence, and not while the window
 * is in the background (the session pauses for that anyway).
 */
export function gazeNotFollowed(input: GazeNudgeInput): boolean {
  if (input.reading.background) return false;
  if (input.prompt) return input.prompt.state === "off";
  return input.reading.source === "gaze" && !input.reading.trackerDown && !input.reading.attending;
}
