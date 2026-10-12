// Parsing of the flat `st.*` custom fields stash stores on tags and scenes.
//
// Custom field values are scalars and may arrive as string, number or
// boolean depending on how they were entered, so parsing is lenient:
// strings are trimmed, "2" and 2 are the same value.

import type { InterestTagInput, MarkerInput, SeriesReset, TriggerTagInput } from "../core/types.ts";

export type CustomFields = Record<string, unknown>;

/** The subset of a stash Tag the parsers need. */
export interface StashTag {
  id: string;
  name: string;
  custom_fields?: CustomFields | null;
}

export type ParseResult<T> = { ok: T } | { problem: string };

export const KNOWN_KINDS = ["interest", "trigger", "policy", "prompt", "auto-marker"] as const;

export const PROMPT_CHECKS = ["repeat", "gaze", "action", "spend"] as const;
export type PromptCheck = (typeof PROMPT_CHECKS)[number];

export interface PromptTagInfo {
  check: PromptCheck;
  target?: string;
  action?: string;
}

// --- scalar helpers --------------------------------------------------------

/** Trimmed string form of a scalar; undefined for missing or blank values. */
export function fieldString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") {
    const s = v.trim();
    return s === "" ? undefined : s;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Finite number from a number or numeric string; undefined otherwise. */
export function fieldNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const s = v.trim();
    if (!NUMERIC.test(s)) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function fieldInteger(v: unknown): number | undefined {
  const n = fieldNumber(v);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
}

/** Lower-cased keyword form (kinds, roles, checks). */
function fieldKeyword(v: unknown): string | undefined {
  return fieldString(v)?.toLowerCase();
}

function show(v: unknown): string {
  return JSON.stringify(typeof v === "string" ? v.trim() : v);
}

function fields(tag: StashTag): CustomFields {
  return tag.custom_fields ?? {};
}

// --- tags --------------------------------------------------------------------

/** Normalised st.kind of a tag (trimmed, lower case), undefined if unset. */
export function tagKind(tag: StashTag): string | undefined {
  return fieldKeyword(fields(tag)["st.kind"]);
}

/** Parses a tag with st.kind=interest. Collects every problem. */
export function parseInterestTag(tag: StashTag): ParseResult<InterestTagInput> {
  const f = fields(tag);
  const problems: string[] = [];

  const topic = fieldString(f["st.topic"]);
  if (topic === undefined) problems.push("st.topic is missing");

  const rawLevel = f["st.level"];
  const level = fieldInteger(rawLevel);
  if (fieldString(rawLevel) === undefined) problems.push("st.level is missing");
  else if (level === undefined || level < 0) problems.push(`st.level must be an integer >= 0, got ${show(rawLevel)}`);

  let need: number | undefined;
  if (fieldString(f["st.need"]) !== undefined) {
    need = fieldInteger(f["st.need"]);
    if (need === undefined || need < 1) problems.push(`st.need must be an integer >= 1, got ${show(f["st.need"])}`);
  }

  const requires = fieldString(f["st.requires"]);

  let paid: number | undefined;
  if (fieldString(f["st.paid"]) !== undefined) {
    paid = fieldNumber(f["st.paid"]);
    if (paid === undefined || paid < 0) problems.push(`st.paid must be a number >= 0, got ${show(f["st.paid"])}`);
  }

  if (problems.length > 0) return { problem: problems.join("; ") };

  const ok: InterestTagInput = { id: tag.id, name: tag.name, topic: topic as string, level: level as number };
  if (need !== undefined) ok.need = need;
  if (requires !== undefined) ok.requires = requires;
  if (paid !== undefined) ok.paid = paid;
  return { ok };
}

/** Parses a tag with st.kind=trigger. Collects every problem. */
export function parseTriggerTag(tag: StashTag): ParseResult<TriggerTagInput> {
  const f = fields(tag);
  const problems: string[] = [];

  const trigger = fieldString(f["st.trigger"]);
  if (trigger === undefined) problems.push("st.trigger is missing");

  const role = fieldKeyword(f["st.trigger_role"]);
  if (role === undefined) problems.push("st.trigger_role is missing");
  else if (role !== "installed" && role !== "used")
    problems.push(`st.trigger_role must be "installed" or "used", got ${show(f["st.trigger_role"])}`);

  if (problems.length > 0) return { problem: problems.join("; ") };
  return { ok: { id: tag.id, name: tag.name, trigger: trigger as string, role: role as "installed" | "used" } };
}

/**
 * Parses a marker primary tag. Returns undefined when the tag is not a
 * prompt tag (st.kind != prompt), so ordinary markers are left alone.
 */
export function parsePromptTag(tag: StashTag): ParseResult<PromptTagInfo> | undefined {
  if (tagKind(tag) !== "prompt") return undefined;
  const f = fields(tag);

  const check = fieldKeyword(f["st.check"]);
  if (check === undefined) return { problem: "st.check is missing" };
  if (!(PROMPT_CHECKS as readonly string[]).includes(check))
    return { problem: `st.check must be one of ${PROMPT_CHECKS.join(", ")}, got ${show(f["st.check"])}` };

  const ok: PromptTagInfo = { check: check as PromptCheck };
  const target = fieldString(f["st.target"]);
  const action = fieldString(f["st.action"]);
  if (target !== undefined) ok.target = target;
  if (action !== undefined) ok.action = action;
  return { ok };
}

/** Prompt fields for a MarkerInput; empty when the tag is no (valid) prompt tag. */
export function markerPromptFields(tag: StashTag | null | undefined): Pick<MarkerInput, "check" | "target" | "action"> {
  if (!tag) return {};
  const r = parsePromptTag(tag);
  return r && "ok" in r ? { ...r.ok } : {};
}

// --- groups (series) ------------------------------------------------------------

export const SERIES_MODES = ["daily"] as const;
export const SERIES_RESETS = ["start", "step_back"] as const;

export interface SeriesConfig {
  mode: "daily";
  reset: SeriesReset;
}

/**
 * st.series / st.reset of a group. Undefined when st.series is unset (the
 * group is no series); st.reset defaults to "start". Collects every problem.
 */
export function parseSeriesFields(customFields: CustomFields | null | undefined): ParseResult<SeriesConfig> | undefined {
  const f = customFields ?? {};
  const mode = fieldKeyword(f["st.series"]);
  if (mode === undefined) return undefined;
  const problems: string[] = [];
  if (!(SERIES_MODES as readonly string[]).includes(mode))
    problems.push(`st.series must be ${SERIES_MODES.map((m) => JSON.stringify(m)).join(" or ")}, got ${show(f["st.series"])}`);
  const reset = fieldKeyword(f["st.reset"]) ?? "start";
  if (!(SERIES_RESETS as readonly string[]).includes(reset))
    problems.push(`st.reset must be "start" or "step_back", got ${show(f["st.reset"])}`);
  if (problems.length > 0) return { problem: problems.join("; ") };
  return { ok: { mode: mode as "daily", reset: reset as SeriesReset } };
}

// --- scenes --------------------------------------------------------------------

export interface SceneProgressFields {
  completedAt?: string;
  completions: number;
  earned: number;
  spent: number;
  exposureSec?: number;
}

/** Progress the plugin wrote to a scene. Unparseable numbers count as 0. */
export function sceneProgressFields(customFields: CustomFields | null | undefined): SceneProgressFields {
  const f = customFields ?? {};
  const out: SceneProgressFields = {
    completions: fieldInteger(f["st.completions"]) ?? 0,
    earned: fieldNumber(f["st.earned"]) ?? 0,
    spent: fieldNumber(f["st.spent"]) ?? 0,
  };
  const completedAt = fieldString(f["st.completed_at"]);
  if (completedAt !== undefined) out.completedAt = completedAt;
  const exposure = fieldNumber(f["st.exposure_seconds"]);
  if (exposure !== undefined && exposure > 0) out.exposureSec = exposure;
  return out;
}
