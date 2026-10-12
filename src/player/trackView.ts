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

/**
 * A stable key for a config, to tell when the source must be recreated. The
 * valid range is left out: it is applied to each sample (applyValidRange),
 * so changing it keeps the connection.
 */
export function configKey(c: BleSensorConfig | undefined): string {
  return c ? [c.service, c.characteristic, c.format, c.offset, c.scale, c.namePrefix ?? ""].join("|") : "";
}

/** the sample flagged by the current valid range (raw outside it = no target) */
export function applyValidRange(s: DistanceSample, range: Pick<BleSensorConfig, "validMin" | "validMax"> | undefined): DistanceSample {
  const out = (range?.validMin !== undefined && s.raw < range.validMin) || (range?.validMax !== undefined && s.raw > range.validMax);
  if (out === (s.noTarget === true)) return s;
  return out ? { t: s.t, raw: s.raw, noTarget: true } : { t: s.t, raw: s.raw };
}

// --- the guide ----------------------------------------------------------------------

const clampPos = (p: number) => (p < 0 ? 0 : p > 100 ? 100 : p);

/**
 * CSS top (%) on the vertical gauge: OUT (0) at the top, IN (100) at the
 * bottom, so going deeper moves down. Display only: positions keep 0 = out,
 * 100 = deepest everywhere else.
 */
export function gaugeTop(pos: number): number {
  return clampPos(pos);
}

export const PREVIEW_W = 300;
export const PREVIEW_H = 60;
export const PREVIEW_MS = 3000;

/** y in the preview strip for a position (0 = out at the top, 100 = in at the bottom) */
export function previewY(pos: number, height = PREVIEW_H): number {
  return Math.round((clampPos(pos) / 100) * height * 10) / 10;
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
      arrow = "down";
      break;
    case "out":
      label = "moving out";
      arrow = "up";
      break;
    case "hold": {
      // a pause inside a stroke reads "hold" too, but only a hold section has a duration to show
      const total = section?.kind === "hold" ? section.end - section.start : 0;
      const done = frame.holdProgress !== undefined ? frame.holdProgress * total : 0;
      label = total > 0 ? `hold ${seconds(done)} / ${seconds(total)} s` : "hold";
      band = { top: gaugeTop(target - BAND_HALF), height: Math.min(target + BAND_HALF, 100) - Math.max(target - BAND_HALF, 0) };
      break;
    }
    default:
      label = "rest";
  }
  if (unscored) label += " · not scored";
  // ahead of the target in the direction of travel: deeper is lower on screen
  const arrowOffset = frame.direction === "in" ? 8 : frame.direction === "out" ? -8 : 0;
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

/** The whole plugin config with `patch` applied; an undefined value removes that key. */
export function mergeSettings(current: Record<string, unknown>, patch: Record<string, string | number | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
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

// --- the sensor menu (/skilltree/sensor) --------------------------------------------------

export type SensorTab = "status" | "calibrate" | "range" | "device";

export const SENSOR_TABS: readonly { id: SensorTab; label: string }[] = [
  { id: "status", label: "Status" },
  { id: "calibrate", label: "Calibrate" },
  { id: "range", label: "Range & limits" },
  { id: "device", label: "Device" },
];

/** the tab named by ?tab= in a location search string; status by default */
export function parseSensorTab(search: string): SensorTab {
  const m = /[?&]tab=([^&#]*)/.exec(search);
  const v = m ? decodeURIComponent(m[1]!) : "";
  return SENSOR_TABS.some((t) => t.id === v) ? (v as SensorTab) : "status";
}

export interface SensorMenuInput {
  configured: boolean;
  status: SensorStatus | undefined;
  calibration: { rawAtZero: number; rawAtFull: number } | undefined;
  config: BleSensorConfig | undefined;
  limits: TrackLimits;
}

export interface SensorMenuItem {
  id: SensorTab;
  label: string;
  /** short state next to the label */
  badge: string;
  tone: Tone;
}

const round = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** "31 – 4000", "≥ 31", "≤ 4000" or "all readings" */
export function validRangeText(config: Pick<BleSensorConfig, "validMin" | "validMax"> | undefined): string {
  const lo = config?.validMin;
  const hi = config?.validMax;
  if (lo !== undefined && hi !== undefined) return `${round(lo)} – ${round(hi)}`;
  if (lo !== undefined) return `≥ ${round(lo)}`;
  if (hi !== undefined) return `≤ ${round(hi)}`;
  return "all readings";
}

export function sensorMenuView(input: SensorMenuInput): SensorMenuItem[] {
  const c = input.status?.connection ?? "disconnected";
  const status: SensorMenuItem = !input.configured
    ? { id: "status", label: "Status", badge: "not set up", tone: "muted" }
    : c === "connected"
      ? { id: "status", label: "Status", badge: "connected", tone: "blue" }
      : c === "connecting"
        ? { id: "status", label: "Status", badge: "connecting", tone: "orange" }
        : c === "error"
          ? { id: "status", label: "Status", badge: "problem", tone: "red" }
          : { id: "status", label: "Status", badge: "off", tone: "muted" };
  const calibrate: SensorMenuItem = input.calibration
    ? { id: "calibrate", label: "Calibrate", badge: "saved", tone: "blue" }
    : { id: "calibrate", label: "Calibrate", badge: input.configured ? "needed" : "—", tone: input.configured ? "orange" : "muted" };
  const depth = input.limits.maxDepth < 100 ? `depth ${Math.round(input.limits.maxDepth)}` : "no depth limit";
  const range: SensorMenuItem = { id: "range", label: "Range & limits", badge: depth, tone: "muted" };
  const device: SensorMenuItem = input.configured
    ? { id: "device", label: "Device", badge: input.status?.device ?? input.config?.namePrefix ?? "set", tone: "muted" }
    : { id: "device", label: "Device", badge: "set up", tone: "orange" };
  return [status, calibrate, range, device];
}

export interface ReadinessStep {
  label: string;
  done: boolean;
  /** where to fix it */
  tab: SensorTab;
}

export interface ReadinessView {
  steps: ReadinessStep[];
  /** every step done: track clips are scored */
  ready: boolean;
  summary: string;
}

export function readinessView(input: { configured: boolean; connected: boolean; calibrated: boolean }): ReadinessView {
  const steps: ReadinessStep[] = [
    { label: "Sensor found and saved", done: input.configured, tab: "device" },
    { label: "Connected", done: input.connected, tab: "status" },
    { label: "Rest and deepest positions calibrated", done: input.calibrated, tab: "calibrate" },
  ];
  const ready = steps.every((s) => s.done);
  const missing = steps.find((s) => !s.done);
  const summary = ready
    ? "Ready: track clips follow their funscript with the sensor and score the track."
    : `Track clips still play, but the track isn't scored until: ${missing!.label.toLowerCase()}.`;
  return { steps, ready, summary };
}

/** what a raw reading means under the valid range */
export function rawVerdict(raw: number | undefined, config: Pick<BleSensorConfig, "validMin" | "validMax"> | undefined): string {
  if (raw === undefined || !Number.isFinite(raw)) return "no reading";
  if (config?.validMin !== undefined && raw < config.validMin) return `no target (below ${round(config.validMin)})`;
  if (config?.validMax !== undefined && raw > config.validMax) return `no target (above ${round(config.validMax)})`;
  return "in range";
}

// --- range & limits form ------------------------------------------------------------------

export interface RangeForm {
  validMin: string;
  validMax: string;
  maxDepth: string;
  maxHoldSec: string;
}

function field(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "string" ? v.trim() : "";
}

export function rangeFormFrom(raw: Record<string, unknown>): RangeForm {
  return {
    validMin: field(raw.sensorValidMin),
    validMax: field(raw.sensorValidMax),
    maxDepth: field(raw.trackMaxDepth),
    maxHoldSec: field(raw.trackMaxHoldSec),
  };
}

export type RangePatch = Record<"sensorValidMin" | "sensorValidMax" | "trackMaxDepth" | "trackMaxHoldSec", number | undefined>;

/** The settings patch for the form (empty = default, removed), or the problems that block saving. */
export function parseRangeForm(form: RangeForm): { patch?: RangePatch; problems: string[] } {
  const problems: string[] = [];
  const parse = (v: string, what: string): number | undefined => {
    if (v.trim() === "") return undefined;
    const n = Number(v.trim().replace(",", "."));
    if (!Number.isFinite(n)) {
      problems.push(`${what} is not a number.`);
      return undefined;
    }
    return n;
  };
  const validMin = parse(form.validMin, "No-target below");
  const validMax = parse(form.validMax, "No-target above");
  const maxDepth = parse(form.maxDepth, "Max depth");
  const maxHoldSec = parse(form.maxHoldSec, "Max hold");
  if (validMin !== undefined && validMax !== undefined && validMin >= validMax) {
    problems.push("“No target below” must be lower than “no target above”.");
  }
  if (maxDepth !== undefined && (maxDepth < 0 || maxDepth > 100)) problems.push("Max depth goes from 0 to 100.");
  if (maxHoldSec !== undefined && maxHoldSec <= 0) problems.push("Max hold must be more than 0 seconds.");
  if (problems.length > 0) return { problems };
  return { patch: { sensorValidMin: validMin, sensorValidMax: validMax, trackMaxDepth: maxDepth, trackMaxHoldSec: maxHoldSec }, problems };
}

// --- live trace ------------------------------------------------------------------------------

export const TRACE_MS = 10_000;
export const TRACE_W = 600;
export const TRACE_H = 120;

/**
 * SVG polylines for the last `windowMs` of positions (0..100, 0 = out at the
 * top like the guide), oldest at the left. A missing position (no target, uncalibrated)
 * breaks the line, so a lost target shows as a gap.
 */
export function tracePolylines(
  points: readonly { t: number; pos: number | undefined }[],
  now: number,
  windowMs = TRACE_MS,
  width = TRACE_W,
  height = TRACE_H,
): string[] {
  const lines: string[] = [];
  let cur: string[] = [];
  for (const p of points) {
    const age = now - p.t;
    if (age > windowMs || age < 0) continue;
    if (p.pos === undefined || !Number.isFinite(p.pos)) {
      if (cur.length > 1) lines.push(cur.join(" "));
      cur = [];
      continue;
    }
    const x = Math.round(((windowMs - age) / windowMs) * width * 10) / 10;
    cur.push(`${x},${previewY(p.pos, height)}`);
  }
  if (cur.length > 1) lines.push(cur.join(" "));
  return lines;
}

// --- sensor chip (play header, session bar) --------------------------------------------------

export interface SensorChipView {
  label: string;
  tone: Tone;
  /** what a click does: connect (a user gesture for the picker), open the sensor menu, or nothing new */
  action: "connect" | "setup" | "open";
  title: string;
}

export function sensorChipView(status: SensorStatus | undefined, opts: { configured: boolean; calibrated: boolean }): SensorChipView {
  if (!opts.configured) return { label: "Sensor", tone: "muted", action: "setup", title: "Set up the distance sensor" };
  const c = status?.connection ?? "disconnected";
  if (c === "connected") {
    return opts.calibrated
      ? { label: "Sensor", tone: "blue", action: "open", title: `Distance sensor connected${status?.device ? ` (${status.device})` : ""}` }
      : { label: "Sensor · calibrate", tone: "orange", action: "setup", title: "Calibrate the distance sensor so track clips are scored" };
  }
  if (c === "connecting") return { label: "Sensor · connecting", tone: "orange", action: "open", title: status?.message ?? "Connecting to the distance sensor" };
  if (c === "error") return { label: "Sensor · problem", tone: "red", action: "setup", title: status?.message ?? "The distance sensor has a problem" };
  return { label: "Sensor · connect", tone: "muted", action: "connect", title: "Connect the distance sensor" };
}

// --- match glow ------------------------------------------------------------------------------
// The video's edges light up while a track section runs: strong green while
// the user is on the target, yellow turning red the further off they are.
// The guide's target is the scorer's reference (lag-compensated), so green
// means "scoring right now".

/** position error (units) that is still a match, and the error that is fully red, per section kind */
export const GLOW_TOLERANCE: Record<"stroke" | "hold" | "ramp", { good: number; bad: number }> = {
  // a 250 ms timing slip on a fast stroke is already ~20 units off
  stroke: { good: 15, bad: 45 },
  // the scorer's hold band is +-8
  hold: { good: 8, bad: 25 },
  ramp: { good: 8, bad: 30 },
};

/**
 * How far off the user is, 0 (on target) .. 1 (fully off), for a position
 * error in a section; undefined when there is nothing to judge (no reading,
 * rest, an unscored or unknown section).
 */
export function glowMismatch(frame: Pick<GuideFrame, "direction" | "section">, error: number | undefined): number | undefined {
  if (error === undefined || !Number.isFinite(error)) return undefined;
  const s = frame.section;
  if (!s || s.unscored || s.kind === "idle" || frame.direction === "idle") return undefined;
  const tol = GLOW_TOLERANCE[s.kind];
  const e = Math.abs(error);
  if (e <= tol.good) return 0;
  return Math.min(1, (e - tol.good) / (tol.bad - tol.good));
}

/** CSS color for a mismatch: green on target, yellow just off, red at 1 */
export function glowColor(mismatch: number): string {
  if (mismatch <= 0) return "hsl(130 85% 50%)";
  const hue = Math.round(55 * (1 - Math.min(1, mismatch)));
  return `hsl(${hue} 95% 52%)`;
}

/** time constant of the error smoothing, ms: steady colors instead of a flicker */
export const GLOW_SMOOTH_MS = 250;

/** one exponential smoothing step of the error over dtMs */
export function smoothError(prev: number | undefined, next: number, dtMs: number, tauMs = GLOW_SMOOTH_MS): number {
  if (prev === undefined || !Number.isFinite(prev)) return next;
  const a = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  return prev + (next - prev) * a;
}

export const DEFAULT_TRACK_GLOW = 70;

/** glow strength 0..1 for the trackGlow setting in percent (default 70, 0 = off) */
export function trackGlowIntensity(setting: unknown): number {
  const n = typeof setting === "number" ? setting : typeof setting === "string" && setting.trim() !== "" ? Number(setting) : NaN;
  const pct = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : DEFAULT_TRACK_GLOW;
  return pct / 100;
}
