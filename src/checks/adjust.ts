// Glue for the session controller's adjustAttention hook: the attention
// reading (gaze or fallback) AND webcam presence. Pure.
import { graceText, type AttentionReading } from "../player/gazeView.ts";
import { combineAttention, type AttentionVerdict } from "./attention.ts";

/** PresenceInfo or anything shaped like it */
type PresenceLike = { present: boolean; reason: string };

/** The reading as a verdict with a reason in plain words. */
export function readingVerdict(reading: Pick<AttentionReading, "attending" | "source" | "reason" | "trackerDown">): AttentionVerdict {
  return { attending: reading.attending, reason: reading.attending ? "watching" : graceText(reading as AttentionReading).toLowerCase() };
}

/** combineAttention over an AttentionReading. */
export function attentionWithPresence(
  reading: AttentionReading,
  presence: PresenceLike | undefined,
  required: boolean,
): AttentionVerdict {
  return combineAttention(readingVerdict(reading), presence, required);
}

/**
 * An adjustAttention(reading, nowMs) for useSkilltreeSession. The session
 * passes Date.now() as nowMs; presence runs on performance.now(), so the
 * argument is ignored and the viewer's own clock is used.
 */
export function presenceAdjuster(
  getViewer: () => { present(nowMs?: number): PresenceLike } | undefined,
  required: boolean | (() => boolean),
): (reading: AttentionReading, nowMs: number) => boolean {
  return (reading) => {
    const viewer = getViewer();
    const req = typeof required === "function" ? required() : required;
    return attentionWithPresence(reading, viewer?.present(), req).attending;
  };
}
