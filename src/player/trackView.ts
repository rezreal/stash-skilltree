// View-model helpers for the track rule (distance sensor + funscript): the
// plugin settings, the on-video guide's geometry and labels, the live score
// line, the sensors-panel row, calibration captures and the settings the
// "Find my sensor" panel saves. Pure, tested under node --test.
import type {
  BleSensorConfig,
  DistanceSample,
  GuideFrame,
  SensorStatus,
  TrackLimits,
  TrackScore,
  ValueFormat,
} from "../track/types.ts";
import { DEFAULT_LIMITS } from "../track/types.ts";
import { DEFAULT_FORMAT, isValueFormat, normalizeUuid } from "../sensors/value.ts";

// --- settings ---------------------------------------------------------------------

export interface TrackSettings {
  /** undefined while service or characteristic is not set */
  config: BleSensorConfig | undefined;
  limits: TrackLimits;
  /** problems with the settings, for the sensor screen */
  problems: string[];
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim().replace(",", "."));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** The sensor and limit settings (see plugin/skilltree.yml), with defaults and range checks. */
export function trackSettings(raw: Record<string, unknown>): TrackSettings {
  const problems: string[] = [];
  const service = str(raw.sensorService);
  const characteristic = str(raw.sensorCharacteristic);
  const formatRaw = str(raw.sensorFormat).toLowerCase();
  let format: ValueFormat = DEFAULT_FORMAT;
  if (formatRaw) {
    if (isValueFormat(formatRaw)) format = formatRaw;
    else problems.push(`Unknown sensor format “${formatRaw}”; using ${DEFAULT_FORMAT}.`);
  }
  let offset = num(raw.sensorOffset) ?? 0;
  if (!Number.isInteger(offset) || offset < 0) {
    problems.push(`Sensor offset must be a whole number ≥ 0; using 0.`);
    offset = 0;
  }
  let scale = num(raw.sensorScale) ?? 1;
  if (scale === 0) {
    problems.push("Sensor scale 0 would flatten every reading; using 1.");
    scale = 1;
  }
  if (service && normalizeUuid(service) === undefined) problems.push(`The service UUID “${service}” is not valid.`);
  if (characteristic && normalizeUuid(characteristic) === undefined) {
    problems.push(`The characteristic UUID “${characteristic}” is not valid.`);
  }
  const namePrefix = str(raw.sensorNamePrefix);
  const validMin = num(raw.sensorValidMin);
  const validMax = num(raw.sensorValidMax);
  if (validMin !== undefined && validMax !== undefined && validMin >= validMax) {
    problems.push("Valid minimum must be below the valid maximum; ignoring both.");
  }
  const validRange = validMin !== undefined && validMax !== undefined && validMin >= validMax ? {} : {
    ...(validMin !== undefined ? { validMin } : {}),
    ...(validMax !== undefined ? { validMax } : {}),
  };
  const config: BleSensorConfig | undefined =
    service && characteristic
      ? { service, characteristic, format, offset, scale, ...(namePrefix ? { namePrefix } : {}), ...validRange }
      : undefined;

  const depthRaw = num(raw.trackMaxDepth);
  const holdRaw = num(raw.trackMaxHoldSec);
  const maxDepth = depthRaw === undefined ? DEFAULT_LIMITS.maxDepth : Math.max(0, Math.min(100, depthRaw));
  const maxHoldSec = holdRaw === undefined || holdRaw <= 0 ? DEFAULT_LIMITS.maxHoldSec : holdRaw;
  if (depthRaw !== undefined && (depthRaw < 0 || depthRaw > 100)) problems.push("Max depth is limited to 0–100.");
  return { config, limits: { maxDepth, maxHoldSec }, problems };
}

/** a stable key for a config, to tell when the source must be recreated */
export function configKey(c: BleSensorConfig | undefined): string {
  return c
    ? [c.service, c.characteristic, c.format, c.offset, c.scale, c.namePrefix ?? "", c.validMin ?? "", c.validMax ?? ""].join("|")
    : "";
}

// --- the guide ----------------------------------------------------------------------

const clampPos = (p: number) => (p < 0 ? 0 : p > 100 ? 100 : p);

/** CSS top (%) on the vertical gauge: IN (100) at the top, OUT (0) at the bottom */
export function gaugeTop(pos: number): number {
  return 100 - clampPos(pos);
}

export const PREVIEW_W = 300;
export const PREVIEW_H = 60;
export const PREVIEW_MS = 3000;

/** y in the preview strip for a position (100 at the top) */
export function previewY(pos: number, height = PREVIEW_H): number {
  return Math.round((height - (clampPos(pos) / 100) * height) * 10) / 10;
}

/** SVG polyline points of the next PREVIEW_MS ([msFromNow, pos] pairs) in a width × height box */
export function previewPoints(preview: [number, number][], width = PREVIEW_W, height = PREVIEW_H, horizonMs = PREVIEW_MS): string {
  const out: string[] = [];
  for (const [ms, pos] of preview) {
    if (!Number.isFinite(ms) || !Number.isFinite(pos)) continue;
    const x = Math.round((Math.max(0, Math.min(horizonMs, ms)) / horizonMs) * width * 10) / 10;
    out.push(`${x},${previewY(pos, height)}`);
  }
  return out.join(" ");
}

export interface GuideView {
  targetTop: number;
  /** undefined without sensor data */
  currentTop?: number;
  arrow: "up" | "down" | undefined;
  /** top of the arrow: ahead of the target in the direction of travel */
  arrowTop: number;
  /** hold band (top, height in %) around the target */
  band?: { top: number; height: number };
  /** short label under the gauge: "moving in", "hold 2.4 / 5.0 s", "rest" */
  label: string;
  /** section label in the preview strip */
  section: string;
  /** a section beyond the user's limits: shown, not scored */
  unscored: boolean;
  /** the max-depth line */
  limitTop: number;
  previewPoints: string;
  currentY?: number;
  aria: string;
}

/** half-height of the hold band in position units */
const BAND_HALF = 8;

function seconds(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(1);
}

export function guideView(frame: GuideFrame, limits: TrackLimits): GuideView {
  const target = clampPos(frame.target);
  const section = frame.section;
  const unscored = section?.unscored === true;
  let label: string;
  let arrow: GuideView["arrow"];
  let band: GuideView["band"];
  switch (frame.direction) {
    case "in":
      label = "moving in";
      arrow = "up";
      break;
    case "out":
      label = "moving out";
      arrow = "down";
      break;
    case "hold": {
      // a pause inside a stroke reads "hold" too, but only a hold section has a duration to show
      const total = section?.kind === "hold" ? section.end - section.start : 0;
      const done = frame.holdProgress !== undefined ? frame.holdProgress * total : 0;
      label = total > 0 ? `hold ${seconds(done)} / ${seconds(total)} s` : "hold";
      band = { top: gaugeTop(target + BAND_HALF), height: Math.min(target + BAND_HALF, 100) - Math.max(target - BAND_HALF, 0) };
      break;
    }
    default:
      label = "rest";
  }
  if (unscored) label += " · not scored";
  const arrowOffset = arrow === "up" ? 8 : arrow === "down" ? -8 : 0;
  const view: GuideView = {
    targetTop: gaugeTop(target),
    arrow,
    arrowTop: gaugeTop(target + arrowOffset),
    label,
    section: section ? section.kind : "—",
    unscored,
    limitTop: gaugeTop(limits.maxDepth),
    previewPoints: previewPoints(frame.preview),
    aria: "",
  };
  if (band) view.band = band;
  if (frame.current !== undefined && Number.isFinite(frame.current)) {
    view.currentTop = gaugeTop(frame.current);
    view.currentY = previewY(frame.current);
  }
  view.aria =
    `Track depth: target ${Math.round(target)}` +
    (frame.current !== undefined ? `, you ${Math.round(clampPos(frame.current))}` : ", no sensor reading") +
    `, ${label}`;
  return view;
}

// --- score --------------------------------------------------------------------------

/** "Strokes 34/48 · Holds 5/6 · Ramps 82% · lag 240 ms"; parts without sections are left out */
export function scoreLine(score: TrackScore | undefined): string {
  if (!score) return "";
  const parts: string[] = [];
  if (score.strokes.total > 0) parts.push(`Strokes ${score.strokes.followed}/${score.strokes.total}`);
  if (score.holds.total > 0) parts.push(`Holds ${score.holds.followed}/${score.holds.total}`);
  if (score.ramps !== undefined) parts.push(`Ramps ${Math.round(score.ramps * 100)}%`);
  if (score.lagMs !== undefined && Number.isFinite(score.lagMs)) parts.push(`lag ${Math.round(score.lagMs)} ms`);
  return parts.length > 0 ? parts.join(" · ") : "No scored sections yet";
}

export function limitsLine(limits: TrackLimits): string {
  const depth = limits.maxDepth < 100 ? `max depth ${Math.round(limits.maxDepth)}` : "no depth limit beyond your calibration";
  return `Your limits: ${depth} · max hold ${formatSec(limits.maxHoldSec)} s. Beyond them, sections are shown but not scored.`;
}

function formatSec(s: number): string {
  return Number.isInteger(s) ? String(s) : s.toFixed(1);
}

// --- sensors panel row --------------------------------------------------------------

export type Tone = "blue" | "orange" | "muted" | "red";

export interface SensorRowView {
  title: string;
  connection: string;
  tone: Tone;
  rate?: string;
  calibrated: string;
  hint?: string;
  canConnect: boolean;
}

/** The sensor is optional: without it (or without a calibration) track clips play, the track rule just isn't scored. */
export const NOT_SCORED = "track not scored";

export function sensorRowView(
  status: SensorStatus | undefined,
  opts: { configured: boolean; calibrated: boolean; rate?: number },
): SensorRowView {
  const title = "Distance sensor (BLE)";
  const calibrated = opts.calibrated ? "yes" : `no – ${NOT_SCORED}`;
  if (!opts.configured) {
    return { title, connection: `not set up – ${NOT_SCORED}`, tone: "muted", calibrated, hint: "Set it up on the sensor page.", canConnect: false };
  }
  const s = status ?? { connection: "disconnected" as const };
  const connectionText =
    s.connection === "connected"
      ? s.device
        ? `connected · ${s.device}`
        : "connected"
      : s.connection === "connecting"
        ? "connecting…"
        : `not connected – ${NOT_SCORED}`;
  const view: SensorRowView = {
    title,
    connection: connectionText,
    tone: s.connection === "connected" ? "blue" : s.connection === "error" ? "red" : s.connection === "connecting" ? "orange" : "muted",
    calibrated,
    canConnect: s.connection === "disconnected" || s.connection === "error",
  };
  if (s.connection === "connected") view.rate = `${Math.round(opts.rate ?? s.rate ?? 0)} Hz`;
  if (s.message) view.hint = s.message;
  else if (s.connection === "connected" && !opts.calibrated) view.hint = "Calibrate the rest and deepest positions so track clips are scored.";
  return view;
}

// --- calibration captures ---------------------------------------------------------------

export function median(values: number[]): number | undefined {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return undefined;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1]! + v[mid]!) / 2;
}

export const CAPTURE_MS = 1500;
/** fewer samples than this in a capture window means the sensor is too slow or silent */
export const CAPTURE_MIN_SAMPLES = 5;

export interface Capture {
  value: number;
  samples: number;
  /** spread (max - min) in raw units, to warn about a shaky capture */
  spread: number;
}

/** median of the samples in [fromT, toT]; undefined when there are too few */
export function captureFrom(samples: DistanceSample[], fromT: number, toT: number, minSamples = CAPTURE_MIN_SAMPLES): Capture | undefined {
  const vals = samples.filter((s) => s.t >= fromT && s.t <= toT && !s.noTarget).map((s) => s.raw);
  if (vals.length < minSamples) return undefined;
  const value = median(vals)!;
  return { value, samples: vals.length, spread: Math.max(...vals) - Math.min(...vals) };
}

/** "too close" when rest and deepest differ by less than this share of their mean (or 3 raw units) */
export function captureProblem(rest: Capture | undefined, deep: Capture | undefined): string | undefined {
  if (!rest || !deep) return undefined;
  const span = Math.abs(deep.value - rest.value);
  if (span < Math.max(3, 0.05 * Math.abs((deep.value + rest.value) / 2))) {
    return "Rest and deepest readings are almost the same. Check that the sensor sees the movement, then capture again.";
  }
  if (rest.spread > span / 4 || deep.spread > span / 4) {
    return "The readings moved a lot while capturing. Hold still for the 1.5 s and capture again for a steadier mapping.";
  }
  return undefined;
}

// --- saving the discovered sensor ---------------------------------------------------------

export interface SensorSettingsPatch {
  sensorService: string;
  sensorCharacteristic: string;
  sensorFormat: ValueFormat;
  sensorOffset: number;
  sensorScale: number;
  sensorNamePrefix?: string;
}

/** The whole plugin config with the sensor keys replaced (configurePlugin replaces the map). */
export function mergePluginSettings(current: Record<string, unknown>, patch: SensorSettingsPatch): Record<string, unknown> {
  const out: Record<string, unknown> = { ...current, ...patch };
  if (patch.sensorNamePrefix === undefined) delete out.sensorNamePrefix;
  return out;
}

/** the patch as lines to type into Settings › Plugins › Skilltree */
export function settingsLines(patch: SensorSettingsPatch): [string, string][] {
  const rows: [string, string][] = [
    ["Distance sensor service UUID", patch.sensorService],
    ["Distance sensor characteristic UUID", patch.sensorCharacteristic],
    ["Distance sensor value format", patch.sensorFormat],
    ["Distance sensor value offset (bytes)", String(patch.sensorOffset)],
    ["Distance sensor scale", String(patch.sensorScale)],
  ];
  if (patch.sensorNamePrefix) rows.push(["Distance sensor name filter", patch.sensorNamePrefix]);
  return rows;
}
