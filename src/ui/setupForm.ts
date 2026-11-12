// Pure logic of the tag setup form (no React, no DOM), so it runs under
// `node --test`: which st.* keys each kind uses, form state from a tag's
// custom fields, validation, and the minimal write that saves a form.
//
// Only config keys (st.kind plus the keys in FIELD_SPECS) are ever written
// or removed. Keys the player writes (st.paid, st.unlocked_at), unknown st.*
// keys and every non-st key are left untouched.

import type { NodeKey, Requirement } from "../core/types.ts";
import { describeRequirement, nodeKey, normalizeTopic, parseRequirement } from "../core/requirements.ts";
import { PROMPT_CHECKS, REPLAY_VALUES, fieldNumber, fieldString, type CustomFields } from "../stash/fields.ts";
import type { FieldChange, FieldValue, SetupTag } from "../stash/tags.ts";

export const SETUP_KINDS = ["none", "interest", "trigger", "policy", "prompt", "auto-marker", "replay"] as const;
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
  "eyes_closed",
] as const;
export const PROMPT_ACTIONS = [
  "nod",
  "shake_head",
  "eyes_closed",
  "eyes_open",
  "hand_raised",
  "still",
  "mouth_open",
  "mouth_closed",
  "hand_to_mouth",
  "stroking",
  "hands_off",
  "arms_up",
  "hands_on_head",
  "hands_together",
  "kneel",
  "kneel_sit",
  "stand",
  "lie_down",
  "cat",
  "cow",
  "puppy",
  "down_dog",
  "plank",
  "plow",
  "straddle",
  "straddle_up",
  "child",
  "forward_fold",
  "happy_baby",
  "savasana",
  "hastasana",
  "warrior",
  "tree",
  "cobra",
  "butterfly",
  "shoulder_stand",
] as const;

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
  /** a sentence per option, shown beside checkboxes or under the chosen value */
  optionHelp?: Readonly<Record<string, string>>;
  /** the field only applies when this holds */
  when?: (values: FormValues) => boolean;
}

export const POLICY_RULE_HELP: Readonly<Record<(typeof POLICY_RULES)[number], string>> = {
  attention:
    "Watch with attention: at least 90% of the clip with the gaze on the video (eye tracker) or the window focused and in use, " +
    "and in front of the camera when the webcam is on. Looking away pauses, staying away aborts.",
  exposure:
    "For loops: total listening time counts (Minimum minutes), added up across sessions, also in a background tab. " +
    "Replaces attention; the loop may be paused.",
  prompts:
    "Follow the clip's prompt markers - repeat a phrase, look at a target, take a pose. At least 75% of the prompts " +
    "that could be checked must pass. A missed prompt up to 10 s long is replayed once; longer ones only count " +
    "(a replay tag on the marker overrides this). Added automatically when a clip has prompt markers.",
  track:
    "Follow the clip's funscript with the distance sensor: strokes, holds and ramps, scored against Minimum track score. " +
    "Not scored without a calibrated sensor.",
};

export const PROMPT_CHECK_HELP: Readonly<Record<string, string>> = {
  repeat: "the viewer says the marker's title out loud (checked by local speech recognition)",
  gaze: "the viewer looks at a target on the person in the video, or away, for the hold time",
  action: "the viewer does something the webcam can see: nod, close the eyes, a pose",
  spend: "the clip asks for the amount in the marker's title in stashcoins; declining fails the clip",
  mail: "a mail draft opens over the clip, prefilled from the marker's title (optional \"To: … | Subject: … |\" first); the clip waits at the marker's end until it is sent",
};

export const GAZE_TARGET_HELP: Readonly<Record<string, string>> = {
  eyes: "the person's eyes",
  face: "the person's face",
  mouth: "the person's mouth",
  hands: "the person's hands",
  chest: "the upper torso, below the shoulders",
  torso: "shoulders to hips",
  hips: "the band around the hips",
  groin: "below the middle of the hips, towards the thighs",
  legs: "hips down to the ankles",
  feet_floor: "the floor in front of the person's feet",
  screen_center: "the middle of the picture",
  off_screen: "anywhere but the video",
  eyes_closed: "the viewer keeps the eyes closed (eye tracker or webcam)",
};

export const PROMPT_ACTION_HELP: Readonly<Record<string, string>> = {
  nod: "nod at least once (down and up)",
  shake_head: "shake the head at least once",
  eyes_closed: "keep both eyes closed",
  eyes_open: "keep the eyes open (blinks are fine)",
  hand_raised: "raise a hand above the shoulder",
  still: "stay still in front of the camera (in windows over 10 s: for most of the window)",
  mouth_open: "open the mouth wide",
  mouth_closed: "keep the mouth closed, e.g. holding something in it (in windows over 10 s: for most of the window)",
  hand_to_mouth: "hold a hand at the mouth (the camera must see the shoulders)",
  stroking: "keep stroking (the camera must see the lap; set up the stroke camera once; in windows over 10 s: for most of the window)",
  hands_off: "no stroking (the camera must see the lap; in windows over 10 s: for most of the window)",
  arms_up: "both arms up above the head",
  hands_on_head: "both hands on the head",
  hands_together: "hands together in front of the chest",
  kneel: "kneel (the camera must see the legs)",
  kneel_sit:
    "kneel sitting back on the heels, back upright, as in meditation; yoga thunderbolt pose (vajrasana) " +
    "(the camera must see the legs; best from the side)",
  stand: "stand upright (the camera must see the legs)",
  lie_down: "lie down",
  cat: "yoga cat: on hands and knees, back rounded up, head dropped",
  cow: "yoga cow: on hands and knees, belly dropped, head lifted",
  puppy: "yoga extended puppy: hips over the knees, chest down, arms stretched forward (side-on to the camera)",
  down_dog: "yoga downward-facing dog: hands and feet on the floor, hips lifted high (side-on to the camera)",
  plank: "plank on hands or forearms, body in a straight line (side-on to the camera)",
  plow: "yoga plow: on the back, legs over the head, feet toward the floor behind it (side-on to the camera)",
  straddle: "straddle stretch: sitting with straight legs spread wide on the floor (facing the camera)",
  straddle_up: "yoga upward seated straddle: balancing on the seat, straight legs lifted wide (facing the camera)",
  child: "yoga child's pose: kneeling, hips back on the heels, folded forward over the thighs",
  forward_fold: "yoga standing forward fold: standing, folded down from the hips, head toward the knees",
  happy_baby: "yoga happy baby: on the back, knees pulled toward the armpits, soles up, holding the feet (side-on to the camera)",
  savasana: "yoga corpse pose (savasana): lying flat on the back, legs long, arms by the sides (side-on to the camera)",
  hastasana: "yoga upward salute (hastasana): standing upright, both arms straight overhead (the camera must see the legs)",
  warrior: "yoga warrior II: feet wide, front knee bent, back leg straight, arms out to the sides at shoulder height (facing the camera)",
  tree: "yoga tree: standing on one straight leg, the other foot on its calf or thigh, knee out to the side (facing the camera)",
  cobra: "yoga cobra: lying on the belly, legs on the floor, chest lifted on the hands (side-on to the camera)",
  butterfly: "butterfly stretch (bound angle): seated, soles together, heels drawn in, knees out to the sides (facing the camera)",
  shoulder_stand:
    "yoga supported shoulder stand (salamba sarvangasana): on the shoulders, hips over them, straight legs up to the ceiling (side-on to the camera)",
};

export const REPLAY_HELP: Readonly<Record<string, string>> = {
  yes: "a missed prompt is replayed once (the clip seeks back to it), however long its window",
  no: "a missed prompt is not replayed; it only counts against the prompts share at the end",
};

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
  {
    key: "st.policy",
    label: "Rules",
    kind: "policy",
    type: "list",
    required: true,
    options: POLICY_RULES,
    optionHelp: POLICY_RULE_HELP,
    help:
      "What a clip with this tag must do to count as completed; every checked rule applies. " +
      "Clips without a policy tag use attention, plus prompts when they have prompt markers.",
  },
  {
    key: "st.min_minutes",
    label: "Minimum minutes",
    kind: "policy",
    type: "number",
    min: 0,
    help: "exposure: listening time needed, added up over sessions (default: one full play)",
  },
  {
    key: "st.track_min",
    label: "Minimum track score",
    kind: "policy",
    type: "number",
    min: 0,
    max: 1,
    help: "track: score from 0 to 1 the following must reach (default 0.7)",
  },
  { key: "st.hold_tol", label: "Hold tolerance", kind: "policy", type: "number", min: 0, help: "track: how far from a hold's depth still counts, in script units (default 8)" },
  { key: "st.hold_min_ms", label: "Minimum hold (ms)", kind: "policy", type: "int", min: 0, help: "track: shortest flat stretch treated as a hold (default 800)" },
  { key: "st.idle_max", label: "Idle maximum", kind: "policy", type: "number", min: 0, help: "track: flat stretches at or below this depth are rest, not holds (default 5)" },
  { key: "st.reward_mult", label: "Reward multiplier", kind: "policy", type: "number", min: 0, help: "coins earned are multiplied by this, e.g. 2 for effortful training clips" },
  { key: "st.check", label: "Check", kind: "prompt", type: "choice", required: true, options: PROMPT_CHECKS, optionHelp: PROMPT_CHECK_HELP },
  {
    key: "st.target",
    label: "Gaze target",
    kind: "prompt",
    type: "choice",
    required: true,
    options: GAZE_TARGETS,
    optionHelp: GAZE_TARGET_HELP,
    when: (v) => (v["st.check"] ?? "").trim().toLowerCase() === "gaze",
  },
  {
    key: "st.action",
    label: "Action",
    kind: "prompt",
    type: "choice",
    required: true,
    options: PROMPT_ACTIONS,
    optionHelp: PROMPT_ACTION_HELP,
    when: (v) => (v["st.check"] ?? "").trim().toLowerCase() === "action",
  },
  {
    key: "st.replay",
    label: "Replay",
    kind: "replay",
    type: "choice",
    required: true,
    options: REPLAY_VALUES,
    optionHelp: REPLAY_HELP,
    help: "add this tag to a prompt marker (as a secondary tag) to override the default: windows up to 10 s replay, longer ones only count",
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
    case "replay":
      return { kind, detail: keyword(f["st.replay"]) };
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
