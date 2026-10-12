// Contract for phase 3 (eye tracking): gaze sources, screen-to-page mapping,
// calibration and attention from gaze. Shared by src/gaze (logic + sources)
// and the UI that uses it (src/player, calibration screen).

/**
 * tobii: Tobii 4C / ET5 / IS5 over WebUSB via the vendored tobiifree SDK.
 * webxr: a WebXR session's gaze, when the browser and headset provide it.
 * mouse: development stand-in.
 */
export type GazeSourceKind = "tobii" | "webxr" | "mouse";

/** One gaze sample in SCREEN coordinates as the tracker reports them. */
export interface GazeSample {
  /** ms, performance.now() timebase */
  t: number;
  x: number;
  y: number;
  /** false when the tracker has no gaze (eyes closed, looking away, lost) */
  valid: boolean;
}

export type GazeConnection = "disconnected" | "connecting" | "connected" | "error";

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GazeStatus {
  kind: GazeSourceKind;
  connection: GazeConnection;
  /** a person is in front of the tracker (undefined = unknown) */
  present?: boolean;
  /** the tracker currently produces gaze */
  tracking?: boolean;
  /** the screen the tracker is mounted on, in the tracker's pixels */
  screen?: ScreenRect;
  /** samples per second over the last second */
  rate?: number;
  message?: string;
  /** raw device status from the tracker (e.g. Tobii "Tracking", "DeviceNotConnected") */
  device?: string;
  /** physical size of the tracked display in mm, when the tracker reports it */
  displayMm?: { width: number; height: number };
}

export interface GazeSource {
  readonly kind: GazeSourceKind;
  connect(): Promise<void>;
  disconnect(): void;
  status(): GazeStatus;
  /** returns an unsubscribe function */
  onSample(cb: (s: GazeSample) => void): () => void;
  onStatus(cb: (s: GazeStatus) => void): () => void;
  /** present when the tracker can calibrate itself (tobii) */
  readonly deviceCalibration?: DeviceCalibration;
}

/**
 * Calibration done by the tracker itself. Points are in [0,1]² of the
 * screen the tracker is mounted on. The finished blob can be stored and
 * re-applied on the next connect.
 */
export interface DeviceCalibration {
  start(): Promise<void>;
  addPoint(xNorm: number, yNorm: number): Promise<void>;
  finish(): Promise<Uint8Array>;
  apply(blob: Uint8Array): Promise<void>;
}

/** The browser window's placement, read from window/screen at sample time. */
export interface WindowGeometry {
  /** window.screenX / screenY (CSS px) */
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  /** document.fullscreenElement !== null */
  fullscreen: boolean;
}

/** A point in viewport CSS pixels (same space as getBoundingClientRect). */
export interface ViewportPoint {
  x: number;
  y: number;
}

/**
 * Affine correction applied after the geometric screen->viewport mapping:
 * x' = a*x + b*y + c, y' = d*x + e*y + f. Identity = no calibration.
 */
export interface Calibration {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  /** ISO time it was measured */
  createdAt: string;
  /** mean residual error after fitting, CSS px */
  errorPx: number;
  points: number;
}

export interface GazeAttentionParams {
  /** extra margin around the target rect counted as inside, CSS px */
  marginPx: number;
  /** sliding window the decision is made over, ms */
  windowMs: number;
  /** share of samples in the window that must be valid and inside */
  minInsideShare: number;
  /** invalid stretches shorter than this are blinks and ignored, ms */
  blinkMs: number;
  /** no samples at all for this long = tracker stalled, ms */
  staleMs: number;
}

export const DEFAULT_GAZE_ATTENTION: GazeAttentionParams = {
  marginPx: 80,
  windowMs: 600,
  minInsideShare: 0.6,
  blinkMs: 350,
  staleMs: 1500,
};

export const IDENTITY_CALIBRATION: Calibration = {
  a: 1,
  b: 0,
  c: 0,
  d: 0,
  e: 1,
  f: 0,
  createdAt: "",
  errorPx: 0,
  points: 0,
};

export interface GazeSettings {
  source: GazeSourceKind | "off";
}

// --- attention from gaze (src/gaze/attention.ts) -------------------------------

/** The subset of DOMRect the attention classifier needs (viewport CSS px). */
export interface DOMRectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A gaze sample already mapped to the viewport (point absent = no gaze). */
export interface GazeAttentionSample {
  /** ms, same timebase as GazeSample.t */
  t: number;
  point?: ViewportPoint;
  valid: boolean;
}

export type GazeAttentionReason = "inside" | "outside" | "blink" | "no-gaze" | "stale";

export interface GazeAttentionResult {
  attending: boolean;
  /**
   * inside/outside: decided by insideShare; blink: a short gap is in progress
   * and counted as the state before it; no-gaze: invalid for longer than
   * blinkMs; stale: no samples for staleMs (tracker stalled).
   */
  reason: GazeAttentionReason;
  /** time-weighted share of the window that was valid and inside, 0..1 */
  insideShare: number;
}
