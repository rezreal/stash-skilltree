// Pure helpers for reading a distance out of GATT notifications: decoding a
// DataView in one of the ValueFormats, UUID normalization for the settings,
// and the candidate decodings the "Find my sensor" panel shows. DOM-free.
import type { ValueFormat } from "../track/types.ts";
import type { BluetoothServiceUUID } from "./bluetooth.d.ts";

export const VALUE_FORMATS: readonly ValueFormat[] = [
  "uint8",
  "uint16le",
  "uint16be",
  "int16le",
  "uint32le",
  "float32le",
  "ascii",
];

export const DEFAULT_FORMAT: ValueFormat = "uint16le";

/** bytes one value takes; ascii reads to the end of the notification */
export function formatSize(format: ValueFormat): number | undefined {
  switch (format) {
    case "uint8":
      return 1;
    case "uint16le":
    case "uint16be":
    case "int16le":
      return 2;
    case "uint32le":
    case "float32le":
      return 4;
    case "ascii":
      return undefined;
  }
}

export function isValueFormat(v: unknown): v is ValueFormat {
  return typeof v === "string" && (VALUE_FORMATS as readonly string[]).includes(v);
}

const NUMBER_RE = /[-+]?(?:\d+(?:[.,]\d+)?|[.,]\d+)/;

/** first number in a text like "123\n", "d=123.5mm" or "R0123" */
export function parseAsciiNumber(text: string): number | undefined {
  const m = NUMBER_RE.exec(text);
  if (!m) return undefined;
  const v = Number(m[0].replace(",", "."));
  return Number.isFinite(v) ? v : undefined;
}

function asciiText(dv: DataView, offset: number): string {
  let s = "";
  for (let i = offset; i < dv.byteLength; i++) {
    const b = dv.getUint8(i);
    if (b === 0) break; // C strings
    s += String.fromCharCode(b);
  }
  return s;
}

/**
 * The value at `offset` in `format`, times `scale`. Undefined when the
 * notification is too short, the offset is invalid, or the value is not a
 * finite number (NaN floats, ascii without digits).
 */
export function parseValue(dv: DataView, format: ValueFormat, offset = 0, scale = 1): number | undefined {
  if (!Number.isInteger(offset) || offset < 0) return undefined;
  const size = formatSize(format);
  if (size !== undefined && offset + size > dv.byteLength) return undefined;
  let v: number | undefined;
  switch (format) {
    case "uint8":
      v = dv.getUint8(offset);
      break;
    case "uint16le":
      v = dv.getUint16(offset, true);
      break;
    case "uint16be":
      v = dv.getUint16(offset, false);
      break;
    case "int16le":
      v = dv.getInt16(offset, true);
      break;
    case "uint32le":
      v = dv.getUint32(offset, true);
      break;
    case "float32le":
      v = dv.getFloat32(offset, true);
      break;
    case "ascii":
      if (offset >= dv.byteLength) return undefined;
      v = parseAsciiNumber(asciiText(dv, offset));
      break;
  }
  if (v === undefined || !Number.isFinite(v)) return undefined;
  const out = v * (Number.isFinite(scale) ? scale : 1);
  return Number.isFinite(out) ? out : undefined;
}

// --- UUIDs ------------------------------------------------------------------------

const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHORT_UUID = /^(?:0x)?([0-9a-f]{4}|[0-9a-f]{8})$/;
// GATT assigned names Web Bluetooth accepts, e.g. "heart_rate", "environmental_sensing"
const GATT_NAME = /^[a-z][a-z0-9_.]*$/;

/**
 * A service/characteristic UUID as Web Bluetooth takes it: 16/32-bit
 * aliases ("0x181a", "181A", "0000ffe1") become numbers, full UUIDs are
 * lowercased, GATT names pass through. Undefined when it is none of these.
 */
export function normalizeUuid(input: string | number | undefined): BluetoothServiceUUID | undefined {
  if (typeof input === "number") return Number.isInteger(input) && input > 0 && input <= 0xffffffff ? input : undefined;
  if (typeof input !== "string") return undefined;
  const s = input.trim().toLowerCase();
  if (!s) return undefined;
  if (FULL_UUID.test(s)) return s;
  const short = SHORT_UUID.exec(s);
  if (short) return parseInt(short[1]!, 16);
  if (GATT_NAME.test(s)) return s;
  return undefined;
}

const BASE_SUFFIX = "-0000-1000-8000-00805f9b34fb";

/** full lowercase 128-bit form of a normalized UUID (names stay names), for comparisons */
export function canonicalUuid(u: BluetoothServiceUUID): string {
  if (typeof u === "number") return `${u.toString(16).padStart(8, "0")}${BASE_SUFFIX}`;
  return u.toLowerCase();
}

/** "0x181a" for UUIDs on the Bluetooth base, the full UUID otherwise */
export function shortUuid(uuid: string): string {
  const s = uuid.toLowerCase();
  if (s.endsWith(BASE_SUFFIX) && s.startsWith("0000")) return `0x${s.slice(4, 8)}`;
  if (s.endsWith(BASE_SUFFIX)) return `0x${s.slice(0, 8)}`;
  return s;
}

// --- raw bytes and candidate decodings ---------------------------------------------

export function hexBytes(dv: DataView): string {
  const parts: string[] = [];
  for (let i = 0; i < dv.byteLength; i++) parts.push(dv.getUint8(i).toString(16).padStart(2, "0"));
  return parts.join(" ");
}

/** printable ASCII of the bytes, other bytes as "." */
export function asciiPreview(dv: DataView): string {
  let s = "";
  for (let i = 0; i < dv.byteLength; i++) {
    const b = dv.getUint8(i);
    s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : b === 0x0a ? "\\n" : b === 0x0d ? "\\r" : ".";
  }
  return s;
}

export interface Decoding {
  format: ValueFormat;
  offset: number;
  /** the decoded value per sample (undefined where it doesn't decode) */
  values: (number | undefined)[];
}

/** offsets tried per format: up to this many bytes into the notification */
const MAX_OFFSET = 8;

/** every (format, offset) that decodes at least one of the samples */
export function candidateDecodings(samples: DataView[]): Decoding[] {
  const out: Decoding[] = [];
  const maxLen = samples.reduce((m, s) => Math.max(m, s.byteLength), 0);
  for (const format of VALUE_FORMATS) {
    const size = formatSize(format) ?? 1;
    const lastOffset = format === "ascii" ? 0 : Math.min(MAX_OFFSET, maxLen - size);
    for (let offset = 0; offset <= lastOffset; offset++) {
      const values = samples.map((s) => parseValue(s, format, offset, 1));
      if (values.some((v) => v !== undefined)) out.push({ format, offset, values });
    }
  }
  return out;
}

export interface RankedDecoding extends Decoding {
  /** higher = more likely the distance; 0 = implausible */
  score: number;
  reason: string;
}

/** a distance in mm from a hobby sensor: 0..4 m */
const PLAUSIBLE_MAX = 4000;

/**
 * Ranks candidate decodings by how much they look like a distance: every
 * sample decodes, values are small non-negative numbers, they change between
 * samples (move the sensor while sampling), integers before floats, and the
 * whole notification used. A heuristic to guide the user, not a verdict.
 */
export function rankDecodings(samples: DataView[]): RankedDecoding[] {
  const ranked = candidateDecodings(samples).map((d): RankedDecoding => {
    const vals = d.values.filter((v): v is number => v !== undefined);
    if (vals.length < d.values.length) return { ...d, score: 0, reason: "not every sample decodes" };
    if (vals.some((v) => v < 0 || v > PLAUSIBLE_MAX)) return { ...d, score: 0, reason: "outside 0..4000" };
    if (d.format === "float32le" && vals.some((v) => v !== 0 && Math.abs(v) < 1e-3)) {
      return { ...d, score: 0, reason: "tiny floats (likely not a float)" };
    }
    let score = 1;
    const distinct = new Set(vals).size;
    const changes = distinct > 1;
    if (changes) score += 2;
    const spread = Math.max(...vals) - Math.min(...vals);
    if (spread >= 5) score += 1;
    if (d.offset === 0) score += 0.5;
    if (d.format === "ascii") score += 1; // text sensors print exactly the number
    if (d.format === "uint8" && samples.some((s) => s.byteLength > 1)) score -= 0.5;
    if (d.format === "float32le") score -= 0.25;
    if (d.format === "uint16be") score -= 0.75; // GATT values are little-endian by convention
    const reason = changes ? `changes (${distinct} values)` : "constant: move the sensor while sampling";
    return { ...d, score, reason };
  });
  return ranked.sort((a, b) => b.score - a.score || a.offset - b.offset);
}
