// Pure logic of the series setup panel (no React, no DOM), so it runs under
// `node --test`: form state from a group's custom fields, the minimal write
// that saves it, warnings, list summary and filtering.
//
// Only st.series and st.reset are ever written or removed; every other key
// of the group is left untouched.

import type { SeriesReset } from "../core/types.ts";
import { SERIES_RESETS, fieldString, type CustomFields } from "../stash/fields.ts";
import type { SetupGroup } from "../stash/groups.ts";
import type { FieldChange } from "../stash/tags.ts";

/** The only keys this panel writes. */
export const SERIES_KEYS = ["st.series", "st.reset"] as const;

export interface SeriesForm {
  daily: boolean;
  reset: SeriesReset;
}

export const RESET_LABELS: Record<SeriesReset, string> = {
  start: "start over at part 1",
  step_back: "step back one part per missed day",
};

function has(fields: CustomFields, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(fields, key) && fields[key] !== null && fields[key] !== undefined;
}

function keyword(v: unknown): string | undefined {
  return fieldString(v)?.toLowerCase();
}

/** Form from stored fields: daily when st.series is "daily", reset step_back only when stored so. */
export function seriesFormFromFields(customFields: CustomFields | null | undefined): SeriesForm {
  const f = customFields ?? {};
  return {
    daily: keyword(f["st.series"]) === "daily",
    reset: keyword(f["st.reset"]) === "step_back" ? "step_back" : "start",
  };
}

export function sameSeriesForm(a: SeriesForm, b: SeriesForm): boolean {
  return a.daily === b.daily && a.reset === b.reset;
}

/**
 * The minimal write that turns `original` into what the form says.
 * - daily: st.series = "daily" unless already; st.reset = "step_back" when
 *   chosen, and for "start" (the default) a stored value other than "start"
 *   is removed.
 * - not daily: st.series and st.reset are removed if the stored st.series is
 *   "daily"; an unknown st.series value is left alone (it is not a daily
 *   series either way, and lint reports it).
 */
export function diffSeriesForm(original: CustomFields | null | undefined, form: SeriesForm): FieldChange {
  const f = original ?? {};
  const change: FieldChange = { set: {}, remove: [] };
  const series = keyword(f["st.series"]);
  const reset = keyword(f["st.reset"]);
  if (form.daily) {
    if (series !== "daily") change.set["st.series"] = "daily";
    if (form.reset === "step_back") {
      if (reset !== "step_back") change.set["st.reset"] = "step_back";
    } else if (reset !== undefined && reset !== "start") {
      change.remove.push("st.reset");
    }
  } else if (series === "daily") {
    change.remove.push("st.series");
    if (has(f, "st.reset")) change.remove.push("st.reset");
  }
  return change;
}

/** Notes for a group's row: unknown stored values, a daily series without scenes. */
export function seriesWarnings(group: SetupGroup, form: SeriesForm): string[] {
  const f = group.customFields;
  const out: string[] = [];
  const series = keyword(f["st.series"]);
  if (series !== undefined && series !== "daily") {
    out.push(`st.series "${fieldString(f["st.series"])}" is unknown; turn on Daily series to replace it`);
  }
  const reset = keyword(f["st.reset"]);
  if (reset !== undefined && !(SERIES_RESETS as readonly string[]).includes(reset)) {
    out.push(`st.reset "${fieldString(f["st.reset"])}" is unknown and counts as "start"`);
  }
  if (form.daily && group.sceneCount === 0) out.push("This group has no scenes yet");
  return out;
}

/** List badge: "daily", "daily · step back", "unknown", or undefined for no series. */
export function seriesSummary(customFields: CustomFields | null | undefined): string | undefined {
  const f = customFields ?? {};
  const series = keyword(f["st.series"]);
  if (series === undefined) return undefined;
  if (series !== "daily") return "unknown";
  return keyword(f["st.reset"]) === "step_back" ? "daily · step back" : "daily";
}

export type GroupFilter = "series" | "all";

export function isSeriesGroup(group: SetupGroup): boolean {
  return fieldString(group.customFields["st.series"]) !== undefined;
}

/** Name contains the query (case-insensitive) and the group passes the filter. */
export function filterGroups(groups: readonly SetupGroup[], query: string, filter: GroupFilter): SetupGroup[] {
  const q = query.trim().toLowerCase();
  return groups.filter((g) => (filter === "all" || isSeriesGroup(g)) && (q === "" || g.name.toLowerCase().includes(q)));
}
