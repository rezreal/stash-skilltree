// Contract for phase 5 (track): following a funscript with a distance sensor
// (a Web Bluetooth "reach trainer" mounted beside a mouthpiece). Shared by
// src/track (pure: sections, calibration, lag, scoring, guide) and
// src/sensors (Web Bluetooth source) and the player wiring.

import type { Action } from "../funscript/parse.ts";

export type { Action };

// --- sensor ---------------------------------------------------------------------

/** One distance reading. */
export interface DistanceSample {
  /** ms, performance.now() timebase (arrival time) */
  t: number;
  /** raw distance in the sensor's unit (mm for most sensors) */
  raw: number;
}

export type SensorConnection = "disconnected" | "connecting" | "connected" | "error";

export interface SensorStatus {
  connection: SensorConnection;
  device?: string;
  /** samples per second over the last second */
  rate?: number;
  message?: string;
}

/** How to read the value out of a GATT notification. */
export type ValueFormat = "uint8" | "uint16le" | "uint16be" | "int16le" | "uint32le" | "float32le" | "ascii";

export interface BleSensorConfig {
  /** GATT service UUID (full or 16-bit alias like "0x181a") */
  service: string;
  /** characteristic with notify */
  characteristic: string;
  format: ValueFormat;
  /** byte offset of the value inside the notification */
  offset: number;
  /** multiply the raw value (e.g. 0.1 for tenths of a mm) */
  scale: number;
  /** optional name prefix filter for the device chooser */
  namePrefix?: string;
}

export interface DistanceSource {
  connect(): Promise<void>;
  disconnect(): void;
  status(): SensorStatus;
  onSample(cb: (s: DistanceSample) => void): () => void;
  onStatus(cb: (s: SensorStatus) => void): () => void;
}

// --- calibration ------------------------------------------------------------------

/**
 * Maps raw distance to script position 0..100. `rawAtZero` is the reading
 * at rest (position 0, "out"); `rawAtFull` at the deepest point (100, "in").
 * Works whichever of the two is larger.
 */
export interface TrackCalibration {
  rawAtZero: number;
  rawAtFull: number;
  /** offset in position units learned from idle sections (drift) */
  drift: number;
  createdAt: string;
}

// --- sections ---------------------------------------------------------------------

export type SectionKind = "stroke" | "hold" | "ramp" | "idle";

export interface Section {
  kind: SectionKind;
  /** ms in script time */
  start: number;
  end: number;
  /** hold: target depth; ramp: start/end positions; stroke: min/max */
  depth?: number;
  from?: number;
  to?: number;
  min?: number;
  max?: number;
  /** stroke: turning points (ms) inside the section */
  turns?: number[];
  /** beyond the user's limits (depth or hold duration): shown, not scored */
  unscored?: boolean;
}

export interface TrackLimits {
  /** deepest scored position 0..100 */
  maxDepth: number;
  /** longest scored hold, seconds */
  maxHoldSec: number;
}

export interface SectionParams {
  /** flat = position change below this over the stretch */
  flatTolerance: number;
  /** a flat stretch at or below this position is idle, above it a hold */
  idleMax: number;
  /** shortest hold / idle, ms */
  holdMinMs: number;
  /** speed (position units per second) above which movement is a stroke, below a ramp */
  strokeSpeed: number;
}

export const DEFAULT_SECTION_PARAMS: SectionParams = {
  flatTolerance: 4,
  idleMax: 5,
  holdMinMs: 800,
  strokeSpeed: 60,
};

export const DEFAULT_LIMITS: TrackLimits = { maxDepth: 100, maxHoldSec: 8 };

// --- scoring ----------------------------------------------------------------------

export interface SectionScore {
  section: Section;
  /** 0..1, undefined when unscored or no data */
  score?: number;
  detail?: string;
}

export interface TrackScore {
  /** duration-weighted mean over scored sections, 0..1 */
  overall?: number;
  strokes: { followed: number; total: number };
  holds: { followed: number; total: number };
  /** mean ramp score 0..1 */
  ramps?: number;
  /** measured lag of the user behind the script, ms */
  lagMs?: number;
  sections: SectionScore[];
}

/** What the on-video guide shows at one moment. */
export interface GuideFrame {
  /** where the user should be now (lag-compensated), 0..100 */
  target: number;
  /** where the user is, 0..100 (calibrated, drift-corrected), undefined without sensor data */
  current?: number;
  direction: "in" | "out" | "hold" | "idle";
  section?: Section;
  /** next ~3 s of the script as [msFromNow, pos] pairs */
  preview: [number, number][];
  /** hold progress 0..1 when in a hold */
  holdProgress?: number;
}
