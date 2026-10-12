// Pure logic of the tag setup form (no React, no DOM), so it runs under
// `node --test`: which st.* keys each kind uses, form state from a tag's
// custom fields, validation, and the minimal write that saves a form.
//
// Only config keys (st.kind plus the keys in FIELD_SPECS) are ever written
// or removed. Keys the player writes (st.paid, st.unlocked_at), unknown st.*
// keys and every non-st key are left untouched.

import type { NodeKey, Requirement } from "../core/types.ts";
import { describeRequirement, nodeKey, normalizeTopic, parseRequirement } from "../core/requirements.ts";
import { PROMPT_CHECKS, fieldNumber, fieldString, type CustomFields } from "../stash/fields.ts";
import type { FieldChange, FieldValue, SetupTag } from "../stash/tags.ts";

export const SETUP_KINDS = ["none", "interest", "trigger", "policy", "prompt", "auto-marker"] as const;
export type SetupKind = (typeof SETUP_KINDS)[number];
export type ConfiguredKind = Exclude<SetupKind, "none">;

export const TRIGGER_ROLES = ["installed", "used"] as const;
export const POLICY_RULES = ["attention", "exposure", "prompts", "track"] as const;
export const GAZE_TARGETS = [
  "eyes",
  "face",
  "mouth",
  "hands",
  "chest",
  "torso",
  "hips",
  "groin",
  "legs",
  "feet_floor",
  "screen_center",
  "off_screen",
] as const;
export const PROMPT_ACTIONS = ["nod", "shake_head", "eyes_closed", "eyes_open", "hand_raised", "still"] as const;

/** Written by the plugin while playing; shown read-only, never written here. */
export const PLAYER_KEYS = ["st.paid", "st.unlocked_at"] as const;

export type FieldType = "text" | "int" | "number" | "choice" | "list" | "requirement";

/** Input text per config key ("st.topic" etc.); "" means unset. */
export type FormValues = Record<string, string>;

export interface FieldSpec {
  key: string;
  label: string;
  kind: ConfiguredKind;
  type: FieldType;
  required?: boolean;
  /** allowed values of a choice or list field */
  options?: readonly string[];
  min?: number;
  max?: number;
  help?: string;
  /** the field only applies when this holds */
  when?: (values: FormValues) => boolean;
}

export const FIELD_SPECS: readonly FieldSpec[] = [
  { key: "st.topic", label: "Topic", kind: "interest", type: "text", required: true, help: "letters, digits, spaces, _ and -" },
  { key: "st.level", label: "Level", kind: "interest", type: "int", required: true, min: 0, help: "0 = entry level" },
  { key: "st.need", label: "Need", kind: "interest", type: "int", min: 1, help: "completed scenes to complete the level (default 2)" },
  {
    key: "st.requires",
    label: "Requires",
    kind: "interest",
    type: "requirement",
    help: "topic:level, $coins; , = and, | = or. The previous level is always required.",
  },
  { key: "st.trigger", label: "Trigger", kind: "trigger", type: "text", required: true, help: "pairs installed and used tags" },
  { key: "st.trigger_role", label: "Role", kind: "trigger", type: "choice", required: true, options: TRIGGER_ROLES },
  { key: "st.policy", label: "Rules", kind: "policy", type: "list", required: true, options: POLICY_RULES },
  { key: "st.min_minutes", label: "Minimum minutes", kind: "policy", type: "number", min: 0 },
  { key: "st.track_min", label: "Minimum track score", kind: "policy", type: "number", min: 0, max: 1, help: "0 to 1" },
  { key: "st.hold_tol", label: "Hold tolerance", kind: "policy", type: "number", min: 0 },
  { key: "st.hold_min_ms", label: "Minimum hold (ms)", kind: "policy", type: "int", min: 0 },
  { key: "st.idle_max", label: "Idle maximum", kind: "policy", type: "number", min: 0 },
  { key: "st.reward_mult", label: "Reward multiplier", kind: "policy", type: "number", min: 0 },
  { key: "st.check", label: "Check", kind: "prompt", type: "choice", required: true, options: PROMPT_CHECKS },
  {
    key: "st.target",
    label: "Gaze target",
    kind: "prompt",
    type: "choice",
    required: true,
    options: GAZE_TARGETS,
    when: (v) => (v["st.check"] ?? "").trim().toLowerCase() === "gaze",
  },
  {
    key: "st.action",
    label: "Action",
    kind: "prompt",
    type: "choice",
    required: true,
    options: PROMPT_ACTIONS,
    when: (v) => (v["st.check"] ?? "").trim().toLowerCase() === "action",
  },
];

/** Every key the setup form may write or remove. */
export const CONFIG_KEYS: readonly string[] = ["st.kind", ...FIELD_SPECS.map((s) => s.key)];

export interface SetupForm {
  kind: SetupKind;
  values: FormValues;
  /** st.kind as found on the tag when it is none of SETUP_KINDS */
  unknownKind?: string;
}

export interface SetupContext {
  /** levels that exist per (normalised) topic, ascending */
  levels: ReadonlyMap<string, readonly number[]>;
}

export interface Validation {
  /** per config key, one message */
  errors: Record<string, string>;
  warnings: string[];
}

// --- helpers -------------------------------------------------------------------

/** Same character set core's requirement parser accepts for topic ids. */
const TOPIC_RE = /^[\p{L}\p{N}_\- ]+$/u;

function has(fields: CustomFields, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(fields, key) && fields[key] !== null && fields[key] !== undefined;
}

function keyword(v: unknown): string | undefined {
  return fieldString(v)?.toLowerCase();
}

/** Number typed into the form; accepts a decimal comma ("0,5"). */
export function parseFormNumber(text: string): number | undefined {
  const t = text.trim().replace(/^([+-]?\d*),(\d+)$/, "$1.$2");
  return fieldNumber(t);
}

/** Lower-cased, de-duplicated tokens of a comma list, in order. */
export function listTokens(v: unknown): string[] {
  const s = fieldString(v);
  if (s === undefined) return [];
  const out: string[] = [];
  for (const raw of s.split(",")) {
    const t = raw.trim().toLowerCase();
    if (t !== "" && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Canonical list: known options in their order, unknown tokens after. */
function canonicalList(spec: FieldSpec, tokens: string[]): string {
  const opts = spec.options ?? [];
  const known = opts.filter((o) => tokens.includes(o));
  const unknown = tokens.filter((t) => !opts.includes(t));
  return [...known, ...unknown].join(",");
}

/** Toggles one token of a list field's text, e.g. a policy rule checkbox. */
export function toggleListToken(text: string, token: string, on: boolean): string {
  const tokens = listTokens(text).filter((t) => t !== token);
  if (on) tokens.push(token);
  const spec = FIELD_SPECS.find((s) => s.type === "list");
  return spec ? canonicalList(spec, tokens) : tokens.join(",");
}

export function fieldSpec(key: string): FieldSpec | undefined {
  return FIELD_SPECS.find((s) => s.key === key);
}

export function applies(spec: FieldSpec, form: SetupForm): boolean {
  return spec.kind === form.kind && (!spec.when || spec.when(form.values));
}

/** The fields shown and written for the form's current kind. */
export function activeFields(form: SetupForm): FieldSpec[] {
  return FIELD_SPECS.filter((s) => applies(s, form));
}

/** Value as stored, normalised for comparison. Unparseable numbers stay strings. */
function storedValue(spec: FieldSpec, raw: unknown): FieldValue | undefined {
  switch (spec.type) {
    case "int":
    case "number":
      return fieldNumber(raw) ?? fieldString(raw);
    case "choice":
      return keyword(raw);
    case "list": {
      const tokens = listTokens(raw);
      return tokens.length > 0 ? canonicalList(spec, tokens) : undefined;
    }
    default:
      return fieldString(raw);
  }
}

/** Value to write for the form text; "invalid" for numbers that do not parse. */
function formValue(spec: FieldSpec, text: string): FieldValue | undefined | "invalid" {
  const t = text.trim();
  if (t === "") return undefined;
  switch (spec.type) {
    case "int":
    case "number":
      return parseFormNumber(t) ?? "invalid";
    case "choice":
      return t.toLowerCase();
    case "list": {
      const tokens = listTokens(t);
      return tokens.length > 0 ? canonicalList(spec, tokens) : undefined;
    }
    default:
      return t;
  }
}

function formText(spec: FieldSpec, raw: unknown): string {
  const v = storedValue(spec, raw);
  return v === undefined ? "" : String(v);
}

function show(v: unknown): string {
  return fieldString(v) ?? JSON.stringify(v);
}

// --- form ------------------------------------------------------------------------

export function formFromFields(customFields: CustomFields | null | undefined): SetupForm {
  const f = customFields ?? {};
  const values: FormValues = {};
  for (const spec of FIELD_SPECS) values[spec.key] = formText(spec, f[spec.key]);
  const raw = keyword(f["st.kind"]);
  const known = raw !== undefined && raw !== "none" && (SETUP_KINDS as readonly string[]).includes(raw);
  const form: SetupForm = { kind: known ? (raw as SetupKind) : "none", values };
  if (raw !== undefined && !known) form.unknownKind = fieldString(f["st.kind"]);
  return form;
}

export function withKind(form: SetupForm, kind: SetupKind): SetupForm {
  return { ...form, kind };
}

export function withValue(form: SetupForm, key: string, text: string): SetupForm {
  return { ...form, values: { ...form.values, [key]: text } };
}

/**
 * The minimal write that turns `original` into what the form says: changed
 * config keys are set (numbers as numbers, strings trimmed), config keys the
 * form leaves empty or that do not apply to its kind are removed. A key is
 * never both set and removed. Numbers that do not parse are left alone
 * (validateForm reports them).
 */
export function diffForm(original: CustomFields | null | undefined, form: SetupForm): FieldChange {
  const f = original ?? {};
  const change: FieldChange = { set: {}, remove: [] };

  if (form.kind === "none") {
    if (has(f, "st.kind")) change.remove.push("st.kind");
  } else if (keyword(f["st.kind"]) !== form.kind) {
    change.set["st.kind"] = form.kind;
  }

  for (const spec of FIELD_SPECS) {
    const present = has(f, spec.key);
    if (!applies(spec, form)) {
      if (present) change.remove.push(spec.key);
      continue;
    }
    const value = formValue(spec, form.values[spec.key] ?? "");
    if (value === "invalid") continue;
    if (value === undefined) {
      if (present) change.remove.push(spec.key);
      continue;
    }
    if (storedValue(spec, f[spec.key]) !== value) change.set[spec.key] = value;
  }
  return change;
}

// --- validation --------------------------------------------------------------------

/** Topics and their levels from every interest tag (optionally without one tag). */
export function setupContext(tags: readonly SetupTag[], excludeTagId?: string): SetupContext {
  const sets = new Map<string, Set<number>>();
  for (const tag of tags) {
    if (tag.id === excludeTagId) continue;
    const node = interestNode(tag.customFields);
    if (!node) continue;
    let s = sets.get(node.topic);
    if (!s) sets.set(node.topic, (s = new Set()));
    s.add(node.level);
  }
  const levels = new Map<string, number[]>();
  for (const [topic, s] of [...sets].sort((a, b) => a[0].localeCompare(b[0]))) {
    levels.set(topic, [...s].sort((a, b) => a - b));
  }
  return { levels };
}

/** (topic, level) of an interest tag with a usable topic and level. */
export function interestNode(customFields: CustomFields | null | undefined): { topic: string; level: number } | undefined {
  const f = customFields ?? {};
  if (keyword(f["st.kind"]) !== "interest") return undefined;
  const topic = fieldString(f["st.topic"]);
  const level = fieldNumber(f["st.level"]);
  if (topic === undefined || level === undefined || !Number.isInteger(level) || level < 0) return undefined;
  return { topic: normalizeTopic(topic), level };
}

/** Why a topic id cannot be used, or undefined when it can. */
export function topicError(text: string): string | undefined {
  const t = normalizeTopic(text);
  if (t === "") return "Required";
  return TOPIC_RE.test(t) ? undefined : "Only letters, digits, spaces, _ and -";
}

function rangeText(spec: FieldSpec, what: string): string {
  if (spec.min !== undefined && spec.max !== undefined) return `Must be ${what} from ${spec.min} to ${spec.max}`;
  if (spec.min !== undefined) return `Must be ${what} ≥ ${spec.min}`;
  return `Must be ${what}`;
}

function checkNumber(spec: FieldSpec, text: string): string | undefined {
  const n = parseFormNumber(text);
  const what = spec.type === "int" ? "a whole number" : "a number";
  if (n === undefined || (spec.type === "int" && !Number.isInteger(n))) return rangeText(spec, what);
  if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) return rangeText(spec, what);
  return undefined;
}

/** Warnings for st.requires references that point nowhere. */
export function requirementWarnings(text: string, ctx: SetupContext, self?: NodeKey): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const group of parseRequirement(text).req) {
    for (const alt of group) {
      if (alt.kind !== "level") continue;
      const key = nodeKey(alt.topic, alt.level);
      if (seen.has(key)) continue;
      seen.add(key);
      const levels = ctx.levels.get(alt.topic);
      if (key === self) warnings.push(`st.requires names this tag's own level ${key}`);
      else if (!levels) warnings.push(`st.requires: no tag has topic "${alt.topic}"`);
      else if (!levels.includes(alt.level)) {
        warnings.push(`st.requires: ${key} does not exist (${alt.topic} has level${levels.length === 1 ? "" : "s"} ${levels.join(", ")})`);
      }
    }
  }
  return warnings;
}

/**
 * Plain-English preview of what opens an interest level: the previous level
 * (implicit) and st.requires, e.g. "a L0 and (b L1 or pay 20)".
 */
export function opensAfter(form: SetupForm): string {
  const { req } = parseRequirement(form.values["st.requires"] ?? "");
  const topic = normalizeTopic(form.values["st.topic"] ?? "");
  const level = parseFormNumber(form.values["st.level"] ?? "");
  const groups: Requirement = [];
  if (topicError(topic) === undefined && level !== undefined && Number.isInteger(level) && level > 0) {
    groups.push([{ kind: "level", topic, level: level - 1 }]);
  }
  groups.push(...req);
  return groups.length > 0 ? describeRequirement(groups) : "nothing (entry level)";
}

export function validateForm(form: SetupForm, ctx: SetupContext): Validation {
  const errors: Record<string, string> = {};
  const warnings: string[] = [];

  if (form.unknownKind !== undefined && form.kind === "none") {
    warnings.push(`st.kind "${form.unknownKind}" is not a known kind; pick one, or save to remove it`);
  }

  for (const spec of activeFields(form)) {
    const text = (form.values[spec.key] ?? "").trim();
    if (text === "") {
      if (spec.required) errors[spec.key] = "Required";
      continue;
    }
    switch (spec.type) {
      case "int":
      case "number": {
        const e = checkNumber(spec, text);
        if (e) errors[spec.key] = e;
        break;
      }
      case "choice":
        if (!(spec.options ?? []).includes(text.toLowerCase())) {
          errors[spec.key] = `Must be one of ${(spec.options ?? []).join(", ")}`;
        }
        break;
      case "list": {
        const tokens = listTokens(text);
        const unknown = tokens.filter((t) => !(spec.options ?? []).includes(t));
        if (unknown.length > 0) errors[spec.key] = `Unknown: ${unknown.join(", ")}; use ${(spec.options ?? []).join(", ")}`;
        else if (tokens.length === 0 && spec.required) errors[spec.key] = "Required";
        break;
      }
      case "requirement": {
        const { errors: parseErrors } = parseRequirement(text);
        if (parseErrors.length > 0) errors[spec.key] = parseErrors.join("; ");
        break;
      }
      default:
        if (spec.key === "st.topic") {
          const e = topicError(text);
          if (e) errors[spec.key] = e;
        }
    }
  }

  if (form.kind === "interest") {
    const topic = normalizeTopic(form.values["st.topic"] ?? "");
    const level = parseFormNumber(form.values["st.level"] ?? "");
    const nodeOk = !errors["st.topic"] && !errors["st.level"] && topic !== "" && level !== undefined;
    const self = nodeOk ? nodeKey(topic, level) : undefined;
    if (nodeOk && level > 0 && !(ctx.levels.get(topic) ?? []).includes(level - 1)) {
      warnings.push(`No other tag has ${topic}:${level - 1}; level ${level} stays locked until it exists`);
    }
    const requires = form.values["st.requires"] ?? "";
    if (!errors["st.requires"]) warnings.push(...requirementWarnings(requires, ctx, self));
  }

  return { errors, warnings };
}

export function isValid(v: Validation): boolean {
  return Object.keys(v.errors).length === 0;
}

// --- display ----------------------------------------------------------------------------

export interface ReadOnlyField {
  key: string;
  value: string;
  /** written by the plugin while playing */
  player: boolean;
}

/** st.* keys the form never writes: player keys first, then unknown ones. */
export function readOnlyFields(customFields: CustomFields | null | undefined): ReadOnlyField[] {
  const f = customFields ?? {};
  const out: ReadOnlyField[] = [];
  for (const key of Object.keys(f)) {
    if (!key.startsWith("st.") || CONFIG_KEYS.includes(key)) continue;
    out.push({ key, value: show(f[key]), player: (PLAYER_KEYS as readonly string[]).includes(key) });
  }
  return out.sort((a, b) => Number(b.player) - Number(a.player) || a.key.localeCompare(b.key));
}

/** One line per key of a change, e.g. "st.level: 1 → 2", "remove st.need (3)". */
export function describeChange(original: CustomFields | null | undefined, change: FieldChange): string[] {
  const f = original ?? {};
  const lines: string[] = [];
  for (const [key, value] of Object.entries(change.set)) {
    lines.push(has(f, key) ? `${key}: ${show(f[key])} → ${value}` : `${key} = ${value}`);
  }
  for (const key of change.remove) lines.push(has(f, key) ? `remove ${key} (${show(f[key])})` : `remove ${key}`);
  return lines;
}

export interface TagSummary {
  /** lower-cased st.kind, undefined when unset */
  kind?: string;
  /** e.g. "fixation:2", "x · installed", "gaze eyes" */
  detail?: string;
}

export function tagSummary(customFields: CustomFields | null | undefined): TagSummary {
  const f = customFields ?? {};
  const kind = keyword(f["st.kind"]);
  if (kind === undefined) return {};
  const parts = (...xs: (string | undefined)[]) => xs.filter((x) => x !== undefined).join(" ") || undefined;
  switch (kind) {
    case "interest": {
      const node = interestNode(f);
      return { kind, detail: node ? `${node.topic}:${node.level}` : "incomplete" };
    }
    case "trigger":
      return { kind, detail: [fieldString(f["st.trigger"]), keyword(f["st.trigger_role"])].filter(Boolean).join(" · ") || undefined };
    case "policy":
      return { kind, detail: listTokens(f["st.policy"]).join(",") || undefined };
    case "prompt":
      return { kind, detail: parts(keyword(f["st.check"]), fieldString(f["st.target"]) ?? fieldString(f["st.action"])) };
    default:
      return { kind };
  }
}

export type TagFilter = "configured" | "all";

export function isConfigured(tag: SetupTag): boolean {
  return fieldString(tag.customFields["st.kind"]) !== undefined;
}

/** Name or alias contains the query (case-insensitive). */
export function matchesQuery(tag: SetupTag, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return tag.name.toLowerCase().includes(q) || tag.aliases.some((a) => a.toLowerCase().includes(q));
}

export function filterTags(tags: readonly SetupTag[], query: string, filter: TagFilter): SetupTag[] {
  return tags.filter((t) => (filter === "all" || isConfigured(t)) && matchesQuery(t, query));
}
