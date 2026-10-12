// View-model helpers for the eye tracker on the play screens: settings,
// which attention signal counts, pause reasons, the header chip and the
// sensors panel. Pure, tested under node --test.
import type {
  GazeAttentionReason,
  GazeAttentionResult,
  GazeConnection,
  GazeSettings,
  GazeSourceKind,
  GazeStatus,
} from "../gaze/types.ts";

// --- settings ---------------------------------------------------------------------

const SOURCES: GazeSettings["source"][] = ["off", "tobii", "mouse"];

/** plugin setting gazeSource: off (default) | tobii | mouse; anything else is off */
export function gazeSettings(raw: Record<string, unknown>): GazeSettings {
  const v = typeof raw.gazeSource === "string" ? raw.gazeSource.trim().toLowerCase() : "";
  const source = SOURCES.find((s) => s === v) ?? "off";
  return { source };
}

const KIND_LABEL: Record<GazeSourceKind, string> = {
  tobii: "Tobii",
  webxr: "WebXR",
  mouse: "Mouse",
};

/** "Eye tracker (Tobii)" */
export function sourceTitle(kind: GazeSourceKind): string {
  return kind === "mouse" ? "Mouse as gaze (testing)" : `Eye tracker (${KIND_LABEL[kind]})`;
}

// --- which signal counts --------------------------------------------------------------

export interface AttentionReading {
  attending: boolean;
  /** gaze while a tracker is connected, otherwise focus + activity */
  source: "gaze" | "fallback";
  /** the gaze classifier's reason; only with source gaze */
  reason?: GazeAttentionReason;
  insideShare?: number;
  /** a tracker is chosen in the settings but not connected: the fallback stands in */
  trackerDown: boolean;
}

export const INITIAL_READING: AttentionReading = { attending: true, source: "fallback", trackerDown: false };

export interface AttentionChoiceInput {
  /** gazeSource setting is not off */
  selected: boolean;
  connection?: GazeConnection;
  /** classifier verdict over the target rect; undefined without a target */
  gaze?: GazeAttentionResult;
  /** fallbackAttending() for this tick */
  fallback: boolean;
}

/**
 * Gaze decides while the tracker is connected; otherwise (off, never
 * connected, or lost mid-session) the fallback does, so a session never
 * aborts because the tracker went away.
 */
export function chooseAttention(input: AttentionChoiceInput): AttentionReading {
  if (input.connection === "connected" && input.gaze) {
    return {
      attending: input.gaze.attending,
      source: "gaze",
      reason: input.gaze.reason,
      insideShare: input.gaze.insideShare,
      trackerDown: false,
    };
  }
  return { attending: input.fallback, source: "fallback", trackerDown: input.selected };
}

/** the fields the screens show; a reading only re-renders when one changes */
export function sameReading(a: AttentionReading, b: AttentionReading): boolean {
  return a.attending === b.attending && a.source === b.source && a.reason === b.reason && a.trackerDown === b.trackerDown;
}

// --- pause and grace texts ----------------------------------------------------------

export interface PauseText {
  title: string;
  hint: string;
}

/** The inattention overlay: why playback paused. */
export function pauseReasonText(r: AttentionReading): PauseText {
  if (r.source === "gaze") {
    switch (r.reason) {
      case "no-gaze":
      case "blink":
        return {
          title: "Paused: eyes not tracked",
          hint: "The eye tracker can't see your eyes. Sit in front of the screen and look at the video.",
        };
      case "stale":
        return {
          title: "Paused: tracker stalled",
          hint: "No gaze data is arriving. Check the tracker's cable, or reconnect it in the sensors panel.",
        };
      default:
        return { title: "Paused: you looked away", hint: "Look back at the video to continue." };
    }
  }
  return { title: "Paused: you looked away", hint: "Come back to the video to continue." };
}

/** The banner during the grace period. */
export function graceText(r: AttentionReading): string {
  if (r.source === "gaze" && (r.reason === "no-gaze" || r.reason === "blink")) return "Eyes not tracked";
  if (r.source === "gaze" && r.reason === "stale") return "Eye tracker stalled";
  return "Look back at the video";
}

// --- header chip -------------------------------------------------------------------------

export interface GazeChipView {
  label: string;
  tone: "blue" | "orange" | "muted" | "red";
  /** connected: the chip opens the calibration; otherwise it shows the hint */
  action: "calibrate" | "hint";
  /** offer a connect button (a click is the user gesture WebUSB pairing needs) */
  canConnect: boolean;
  hint?: string;
}

export const TOBII_HINT =
  "Plug in the tracker and use Chrome or Edge. On Windows, stop the Tobii services " +
  "(Tobii Service and Tobii Experience) first, so the browser can claim the device. " +
  "Then press Connect and pick the tracker; later visits reconnect by themselves.";

export const OFF_HINT =
  "No eye tracker is set up. Choose one under Settings → Plugins → Skilltree (Eye tracker). " +
  "Without one, attention is judged from window focus and activity.";

function notConnectedHint(kind: GazeSourceKind, message: string | undefined): string {
  const base =
    kind === "tobii"
      ? TOBII_HINT
      : kind === "mouse"
        ? "The mouse stands in for gaze, for testing. Press Connect."
        : "This source isn't available yet. Choose another one in the plugin settings.";
  return message ? `${message} ${base}` : base;
}

/** The sensor status chip in the choice screen header. */
export function gazeChipView(settings: GazeSettings, status: GazeStatus | undefined, calibrated: boolean): GazeChipView {
  if (settings.source === "off" || status === undefined) {
    return { label: "Eye tracker off", tone: "muted", action: "hint", canConnect: false, hint: OFF_HINT };
  }
  const name = status.kind === "mouse" ? "Mouse gaze" : "Eye tracker";
  switch (status.connection) {
    case "connected":
      return {
        label: calibrated ? `${name} connected` : `${name} connected · calibrate`,
        tone: calibrated ? "blue" : "orange",
        action: "calibrate",
        canConnect: false,
      };
    case "connecting":
      return { label: `${name} connecting…`, tone: "muted", action: "hint", canConnect: false, hint: notConnectedHint(status.kind, undefined) };
    case "error":
      return {
        label: `${name} error`,
        tone: "red",
        action: "hint",
        canConnect: status.kind !== "webxr",
        hint: notConnectedHint(status.kind, status.message),
      };
    case "disconnected":
      return {
        label: `${name} disconnected`,
        tone: "orange",
        action: "hint",
        canConnect: status.kind !== "webxr",
        hint: notConnectedHint(status.kind, status.message),
      };
  }
}

// --- sensors panel --------------------------------------------------------------------

const CONNECTION_TEXT: Record<GazeConnection, string> = {
  connected: "connected",
  connecting: "connecting…",
  disconnected: "disconnected",
  error: "error",
};

const REASON_TEXT: Record<GazeAttentionReason, string> = {
  inside: "on the video",
  outside: "looking away",
  blink: "blink",
  "no-gaze": "eyes not tracked",
  stale: "stalled",
};

export interface GazeSensorView {
  title: string;
  connection: string;
  connectionTone: "blue" | "orange" | "muted" | "red";
  rate: string;
  presence: string;
  reason: string;
}

/** "62 Hz", "—" when unknown */
export function rateText(rate: number | undefined): string {
  return rate !== undefined && Number.isFinite(rate) ? `${Math.round(rate)} Hz` : "—";
}

export function presenceText(status: Pick<GazeStatus, "present" | "tracking">): string {
  if (status.present === false) return "no one in front";
  if (status.tracking === false) return "eyes not found";
  if (status.present === true) return "present";
  return "—";
}

/** The eye tracker block of the sensors panel. `rate` overrides status.rate (measured locally). */
export function gazeSensorView(status: GazeStatus, reading: AttentionReading, rate?: number): GazeSensorView {
  const connected = status.connection === "connected";
  return {
    title: sourceTitle(status.kind),
    connection: status.message && !connected ? `${CONNECTION_TEXT[status.connection]} · ${status.message}` : CONNECTION_TEXT[status.connection],
    connectionTone: connected ? "blue" : status.connection === "error" ? "red" : status.connection === "connecting" ? "muted" : "orange",
    rate: connected ? rateText(rate ?? status.rate) : "—",
    presence: connected ? presenceText(status) : "—",
    reason: reading.source === "gaze" && reading.reason ? REASON_TEXT[reading.reason] : "—",
  };
}

/** "Attention: eye tracker" / "Attention: fallback (focus + activity)" */
export function attentionSourceLabel(r: AttentionReading): string {
  if (r.source === "gaze") return "Attention: eye tracker";
  return r.trackerDown ? "Attention: fallback · tracker not connected" : "Attention: fallback (focus + activity)";
}
