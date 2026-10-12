// Presence on the webcam combined with the session's attention verdict
// (gaze, or the focus/activity stand-in). Pure.
//
// PLAN (Presence): attention = present AND (gaze on the video, or the
// fallback). An absent viewer never counts as attending while the camera is
// in use. A stalled / lost / off camera only blocks attention when the
// webcam is required; otherwise the session carries on without presence.

import type { PresenceState } from "../prompts/presence.ts";

/**
 * present / absent / no-frames: from the presence monitor while the camera
 * runs; off / starting / error: the camera session itself.
 */
export type PresenceReason = "present" | "absent" | "no-frames" | "off" | "starting" | "error";

export interface PresenceInfo {
  present: boolean;
  reason: PresenceReason;
}

export interface AttentionVerdict {
  attending: boolean;
  reason: string;
}

export const PRESENCE_TEXT: Readonly<Record<PresenceReason, string>> = {
  present: "in front of the camera",
  absent: "not in front of the camera",
  "no-frames": "camera stalled",
  off: "camera off",
  starting: "camera starting",
  error: "camera error",
};

/** Plain words for a presence reason (unknown reasons pass through). */
export function presenceReasonText(reason: string): string {
  return (PRESENCE_TEXT as Record<string, string>)[reason] ?? reason;
}

/** The presence monitor's state as PresenceInfo. */
export function presenceFromMonitor(s: PresenceState): PresenceInfo {
  return { present: s.present, reason: s.reason };
}

/**
 * attending = base.attending AND present (while the webcam is in use).
 * - presence undefined (no camera in use): required -> "camera off", else base
 * - absent person -> "not in front of the camera" (also over a failing base:
 *   it explains the looking away)
 * - camera stalled / starting / off / error -> blocks only when required
 */
export function combineAttention(
  base: AttentionVerdict,
  presence: { present: boolean; reason: string } | undefined,
  required: boolean,
): AttentionVerdict {
  if (presence === undefined) {
    if (required && base.attending) return { attending: false, reason: PRESENCE_TEXT.off };
    return base;
  }
  if (presence.present) return base;
  if (presence.reason === "absent") return { attending: false, reason: PRESENCE_TEXT.absent };
  if (!base.attending) return base;
  if (!required) return base;
  return { attending: false, reason: presenceReasonText(presence.reason) };
}

/** Pause overlay text when presence (not gaze) is why attention failed; undefined otherwise. */
export function presencePauseText(
  presence: { present: boolean; reason: string } | undefined,
  required: boolean,
): { title: string; hint: string } | undefined {
  if (presence === undefined) {
    return required
      ? { title: "Paused: camera off", hint: "This session needs the camera. Turn it on to continue." }
      : undefined;
  }
  if (presence.present) return undefined;
  switch (presence.reason) {
    case "absent":
      return { title: "Paused: not in front of the camera", hint: "Sit where the camera can see you to continue." };
    case "no-frames":
      return required
        ? { title: "Paused: camera stalled", hint: "No pictures are arriving from the camera. Check it, or reload the page." }
        : undefined;
    case "starting":
      return required ? { title: "Waiting for the camera", hint: "The camera is starting." } : undefined;
    default:
      return required
        ? { title: "Paused: camera off", hint: "This session needs the camera. Turn it on to continue." }
        : undefined;
  }
}
