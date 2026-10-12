// Is the viewer in front of the webcam? Pure, time-injected (ms, the
// ViewerFrame timebase). The player ANDs this with gaze / fallback attention.

import type { ViewerFrame } from "./types.ts";

export const DEFAULT_PRESENCE_GRACE_MS = 1500;
export const DEFAULT_PRESENCE_STALE_MS = 2000;

export interface PresenceOptions {
  /** personPresent may be false this long before the viewer counts as absent */
  graceMs?: number;
  /** no frames for this long = camera stalled */
  staleMs?: number;
}

export type PresenceReason = "present" | "absent" | "no-frames";

export interface PresenceState {
  present: boolean;
  reason: PresenceReason;
}

export interface PresenceMonitor {
  push(frame: ViewerFrame): void;
  present(nowMs: number): PresenceState;
  reset(): void;
}

export function createPresenceMonitor(opts?: PresenceOptions): PresenceMonitor {
  const graceMs = opts?.graceMs ?? DEFAULT_PRESENCE_GRACE_MS;
  const staleMs = opts?.staleMs ?? DEFAULT_PRESENCE_STALE_MS;
  let lastT: number | undefined;
  /** first frame of the current absent run, undefined while present */
  let absentSince: number | undefined;

  return {
    push(f) {
      if (!Number.isFinite(f.t)) return;
      if (lastT !== undefined && f.t < lastT) return; // stale, out of order
      lastT = f.t;
      if (f.personPresent) absentSince = undefined;
      else if (absentSince === undefined) absentSince = f.t;
    },
    present(nowMs) {
      if (lastT === undefined || nowMs - lastT > staleMs) return { present: false, reason: "no-frames" };
      if (absentSince !== undefined && nowMs - absentSince > graceMs) return { present: false, reason: "absent" };
      return { present: true, reason: "present" };
    },
    reset() {
      lastT = undefined;
      absentSince = undefined;
    },
  };
}
