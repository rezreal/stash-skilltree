// The camera gate before a session and the sensor rows: view models. Pure.

import type { PerceptionErrorCode } from "../perception/errors.ts";
import type { PresenceInfo } from "./attention.ts";
import type { CameraState } from "./camera.ts";

export interface ErrorHelp {
  title: string;
  hint: string;
  /** trying again can help (the button is shown) */
  retry: boolean;
}

/** What went wrong with the camera, by PerceptionError code. */
export function cameraErrorHelp(code: PerceptionErrorCode | undefined, message?: string): ErrorHelp {
  switch (code) {
    case "insecure-context":
      return {
        title: "The camera needs a secure page",
        hint: "Browsers only allow the camera over https (or http://localhost). Open stash through https and try again.",
        retry: false,
      };
    case "unsupported":
      return { title: "This browser can't use the camera", hint: "Try a current Chrome, Edge or Firefox.", retry: false };
    case "permission-denied":
      return {
        title: "Camera access was denied",
        hint: "Allow the camera for this site (the camera icon in the address bar, or the site settings), then try again.",
        retry: true,
      };
    case "no-device":
      return { title: "No camera found", hint: "Connect a webcam and try again.", retry: true };
    case "device-busy":
      return {
        title: "The camera is busy",
        hint: "Another app or tab may be using it. Close it and try again.",
        retry: true,
      };
    case "assets-missing":
      return {
        title: "The vision models are missing",
        hint: "Run tools/fetch_models.sh and copy plugin/assets to the plugin folder, then reload the page.",
        retry: false,
      };
    case "model-failed":
      return {
        title: "The camera analysis could not start",
        hint: message ? `${message} Reload the page to try again.` : "Reload the page to try again.",
        retry: true,
      };
    default:
      return { title: "The camera could not be started", hint: message ?? "Try again.", retry: true };
  }
}

const SPEECH_OFF = "To watch without a microphone, turn off speech recognition in the Skilltree plugin settings.";

/** What went wrong with the microphone (the mic gate), by PerceptionError code. */
export function micErrorHelp(code: PerceptionErrorCode | undefined, message?: string): ErrorHelp {
  switch (code) {
    case "insecure-context":
      return {
        title: "The microphone needs a secure page",
        hint: `Browsers only allow the microphone over https (or http://localhost). Open stash through https. ${SPEECH_OFF}`,
        retry: false,
      };
    case "unsupported":
      return {
        title: "This browser can't use the microphone",
        hint: `Try a current Chrome, Edge or Firefox. ${SPEECH_OFF}`,
        retry: false,
      };
    case "permission-denied":
      return {
        title: "Microphone access was denied",
        hint: "Allow the microphone for this site (the icon in the address bar, or the site settings), then try again.",
        retry: true,
      };
    case "no-device":
      return { title: "No microphone found", hint: `Connect a microphone or headset and try again. ${SPEECH_OFF}`, retry: true };
    case "device-busy":
      return {
        title: "The microphone is busy",
        hint: "Another app or tab may be using it. Close it and try again.",
        retry: true,
      };
    default:
      return { title: "The microphone could not be started", hint: message ?? "Try again.", retry: true };
  }
}

/** Codes meaning "there is no camera to use" (the gate may go on without one when not required). */
export function isNoCamera(code: PerceptionErrorCode | undefined): boolean {
  return code === "insecure-context" || code === "unsupported" || code === "permission-denied" || code === "no-device";
}

export type GatePhase =
  /** waiting for the click on "Turn on camera" */
  | "ask"
  | "starting"
  /** the camera runs, nobody in view yet */
  | "looking"
  /** a person is in view: onReady */
  | "ready"
  | "error"
  /** not required and no camera: go on without one */
  | "skip";

export function gatePhase(input: {
  required: boolean;
  requested: boolean;
  state: CameraState;
  errorCode?: PerceptionErrorCode;
  /** a person has been seen steadily */
  personSeen: boolean;
}): GatePhase {
  if (input.state === "error") return !input.required && isNoCamera(input.errorCode) ? "skip" : "error";
  if (!input.requested || input.state === "off") return "ask";
  if (input.state === "starting") return "starting";
  return input.personSeen ? "ready" : "looking";
}

/** A person must be in view this long before the gate opens (ms). */
export const GATE_STEADY_MS = 600;

/**
 * Tracks "a person in view for GATE_STEADY_MS": feed it on every poll with
 * the latest frame's personPresent; returns whether the gate may open.
 */
export function createSteadyPresence(steadyMs: number = GATE_STEADY_MS): (personPresent: boolean, nowMs: number) => boolean {
  let since: number | undefined;
  return (personPresent, nowMs) => {
    if (!personPresent) {
      since = undefined;
      return false;
    }
    since ??= nowMs;
    return nowMs - since >= steadyMs;
  };
}

// --- sensor rows ----------------------------------------------------------------------

export type RowTone = "blue" | "orange" | "muted" | "red";

export interface SensorRow {
  key: "camera" | "microphone" | "vision";
  label: string;
  value: string;
  tone: RowTone;
  hint?: string;
}

export type MicState = "off" | "loading" | "idle" | "listening" | "error";
export type VisionState = "off" | "loading" | "ready" | "running" | "error";

export function cameraRow(state: CameraState, presence: PresenceInfo | undefined, error?: { code?: PerceptionErrorCode; message?: string }): SensorRow {
  const row: SensorRow = { key: "camera", label: "Camera", value: "off", tone: "muted" };
  switch (state) {
    case "starting":
      row.value = "starting…";
      break;
    case "on":
      if (presence?.present) {
        row.value = "you're in view";
        row.tone = "blue";
      } else if (presence?.reason === "no-frames") {
        row.value = "stalled";
        row.tone = "orange";
      } else {
        row.value = "nobody in view";
        row.tone = "orange";
      }
      break;
    case "error":
      row.value = "error";
      row.tone = "red";
      row.hint = cameraErrorHelp(error?.code, error?.message).title;
      break;
    default:
      break;
  }
  return row;
}

const MIC_TEXT: Record<MicState, [string, RowTone]> = {
  off: ["off", "muted"],
  loading: ["loading model…", "muted"],
  idle: ["idle", "muted"],
  listening: ["listening", "blue"],
  error: ["error", "red"],
};

export function micRow(state: MicState, message?: string): SensorRow {
  const [value, tone] = MIC_TEXT[state];
  const row: SensorRow = { key: "microphone", label: "Microphone", value, tone };
  if (state === "error" && message) row.hint = message;
  return row;
}

const VISION_TEXT: Record<VisionState, [string, RowTone]> = {
  off: ["off", "muted"],
  loading: ["loading…", "muted"],
  ready: ["ready", "muted"],
  running: ["running", "blue"],
  error: ["error", "red"],
};

export function visionRow(state: VisionState, message?: string): SensorRow {
  const [value, tone] = VISION_TEXT[state];
  const row: SensorRow = { key: "vision", label: "Video analysis", value, tone };
  if (state === "error" && message) row.hint = message;
  return row;
}
