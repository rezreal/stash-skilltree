// Daily series: a stash group (st.series=daily) whose scenes are watched in
// order, at most one part per day. The position is derived from each part's
// latest st.completed_at and never stored. Pure.
//
// Days: a "day" starts at dayStartHour local time (plugin setting, default
// 4), so a completion at 02:30 counts for the previous calendar day.
//
// reset=start (default): the run is the longest prefix of parts 1..k whose
// completion days are strictly consecutive (day(i+1) = day(i) + 1).
// - last day = today      -> done-today (part k+1 unlocks tomorrow)
// - last day = yesterday  -> due (part k+1 today; deadline = next boundary)
// - earlier               -> broken: run 0, next part 1
// - k = 0                 -> not-started (part 1 any day, no deadline)
// - k = all parts         -> finished
// Rewatching part 1 after a break overwrites its date, so the old chain no
// longer starts at part 1 and only the new prefix counts.
//
// reset=step_back: every missed day steps the position back by one part
// (never below 0) instead of resetting it; the next part is the one after
// the position. A missed day is a day without a series part, counted from
// the day after the last watch up to yesterday (today is still open).
// After a step back, the parts from the new position on are watched again,
// which overwrites their dates, so the stored dates are no longer a simple
// consecutive chain. The position is therefore derived from the most recent
// completion: part e watched on day D means the position was e at the end of
// D, provided some history of daily watches and misses explains it
// (`explainable`); the position today is max(0, e − missed days since D).
// If the most recent completion cannot be explained (a part watched out of
// order), the next most recent one is tried, and so on.

import type { Id, SceneInput, SeriesInput, SeriesPartInput } from "../core/types.ts";
import { DEFAULT_DAY_START_HOUR, type SeriesStatus } from "./types.ts";

const DAY_MS = 86_400_000;

/** A whole hour 0–23; anything else falls back to the default (4). */
export function normalizeDayStartHour(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_DAY_START_HOUR;
  const h = Math.floor(v);
  return h >= 0 && h <= 23 ? h : DEFAULT_DAY_START_HOUR;
}

/**
 * Day number (days since epoch, local calendar) of `date` when days start at
 * `dayStartHour`: before that hour the date belongs to the previous day.
 * Undefined for invalid dates.
 */
export function localDayOf(date: Date, dayStartHour: number = DEFAULT_DAY_START_HOUR): number | undefined {
  const t = date.getTime();
  if (!Number.isFinite(t)) return undefined;
  const h = normalizeDayStartHour(dayStartHour);
  // Date.UTC of the local Y/M/D gives a DST-free day count.
  const day = Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
  return date.getHours() < h ? day - 1 : day;
}

/** localDayOf for an ISO timestamp; undefined when missing or invalid. */
export function dayOfIso(iso: string | undefined, dayStartHour: number = DEFAULT_DAY_START_HOUR): number | undefined {
  if (!iso) return undefined;
  return localDayOf(new Date(iso), dayStartHour);
}

/** The moment day `day` begins (local time, dayStartHour). */
export function dayStartDate(day: number, dayStartHour: number = DEFAULT_DAY_START_HOUR): Date {
  const d = new Date(day * DAY_MS);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), normalizeDayStartHour(dayStartHour), 0, 0, 0);
}

/** "YYYY-MM-DD" of a day number. */
export function dayLabel(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

// --- parts ---------------------------------------------------------------------

/** Numeric ids compare as numbers, others as strings. */
function compareIds(a: Id, b: Id): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Parts in watch order: scene_index ascending, parts without an index after
 * those with one; ties by scene date (earliest first, undated last), then id.
 */
export function orderedParts(series: SeriesInput, scenes: ReadonlyMap<Id, SceneInput>): SeriesPartInput[] {
  const date = (p: SeriesPartInput) => scenes.get(p.sceneId)?.date;
  return [...series.parts].sort((a, b) => {
    if (a.index !== b.index) {
      if (a.index === undefined) return 1;
      if (b.index === undefined) return -1;
      return a.index - b.index;
    }
    const da = date(a);
    const db = date(b);
    if (da !== db) {
      if (!da) return 1;
      if (!db) return -1;
      return da < db ? -1 : 1;
    }
    return compareIds(a.sceneId, b.sceneId);
  });
}

/** scene id -> the series it is a part of */
export function seriesByScene(series: readonly SeriesInput[]): Map<Id, SeriesInput[]> {
  const out = new Map<Id, SeriesInput[]>();
  for (const s of series) {
    for (const p of s.parts) {
      const list = out.get(p.sceneId);
      if (!list) out.set(p.sceneId, [s]);
      else if (!list.includes(s)) list.push(s);
    }
  }
  return out;
}

/** The series a scene is a part of (usually none or one). */
export function seriesForScene(series: readonly SeriesInput[], sceneId: Id): SeriesInput[] {
  return series.filter((s) => s.parts.some((p) => p.sceneId === sceneId));
}

// --- status ----------------------------------------------------------------------

interface Anchor {
  /** parts held at the end of `day` */
  run: number;
  day: number;
}

/** reset=start: longest prefix with strictly consecutive days. */
function startAnchor(days: (number | undefined)[]): Anchor | undefined {
  let k = 0;
  while (k < days.length) {
    const d = days[k];
    if (d === undefined || (k > 0 && d !== (days[k - 1] as number) + 1)) break;
    k++;
  }
  return k > 0 ? { run: k, day: days[k - 1] as number } : undefined;
}

/**
 * step_back: can some history of one-part-per-day watches and missed days,
 * consistent with the stored latest dates, reach position e − 1 at the end
 * of day D − 1 (so that watching part e on D was the next part)?
 *
 * Walking backwards from (P, X) = "position P at the end of day X":
 * - P = 0: explained (a fresh start or a fully decayed run).
 * - part P's latest day is X: it was watched on X -> (P − 1, X − 1).
 * - otherwise X may have been a missed day, stepping back from P + 1
 *   -> (P + 1, X − 1); a finished series (P + 1 = all parts) never steps back.
 * - if part P's latest day is after X it may also have been watched on X
 *   before, the date overwritten by a later rewatch -> (P − 1, X − 1).
 * Before the earliest stored completion the position was 0.
 */
function explainable(days: (number | undefined)[], e: number, D: number): boolean {
  const n = days.length;
  let minDay = Infinity;
  for (const d of days) if (d !== undefined && d < minDay) minDay = d;
  const span = D - minDay + 2;
  const seen = new Set<number>();
  const stack: [number, number][] = [[e - 1, D - 1]];
  while (stack.length > 0) {
    const [p, x] = stack.pop() as [number, number];
    if (p === 0) return true;
    if (p >= n || x < minDay) continue;
    const key = p * span + (D - x);
    if (seen.has(key)) continue;
    seen.add(key);
    const dp = days[p - 1];
    if (dp === x) {
      stack.push([p - 1, x - 1]);
      continue;
    }
    stack.push([p + 1, x - 1]);
    if (dp !== undefined && dp > x) stack.push([p - 1, x - 1]);
  }
  return false;
}

/** step_back: the most recent completion that a daily history explains. */
function stepBackAnchor(days: (number | undefined)[]): Anchor | undefined {
  const done: { part: number; day: number }[] = [];
  days.forEach((d, i) => {
    if (d !== undefined) done.push({ part: i + 1, day: d });
  });
  done.sort((a, b) => b.day - a.day || b.part - a.part);
  for (const c of done) {
    if (explainable(days, c.part, c.day)) return { run: c.part, day: c.day };
  }
  return undefined;
}

/**
 * Today's state of a daily series (see the file header for the rules).
 * Completions after `now` are ignored; parts whose scene is not in `scenes`
 * count as not completed.
 */
export function seriesStatus(
  series: SeriesInput,
  scenes: ReadonlyMap<Id, SceneInput>,
  now: Date,
  dayStartHour: number = DEFAULT_DAY_START_HOUR,
): SeriesStatus {
  const h = normalizeDayStartHour(dayStartHour);
  const parts = orderedParts(series, scenes);
  const n = parts.length;
  const next = (run: number): SeriesStatus["nextPart"] => {
    const p = parts[run];
    if (!p) return undefined;
    const out: NonNullable<SeriesStatus["nextPart"]> = { sceneId: p.sceneId, number: run + 1 };
    if (p.index !== undefined) out.index = p.index;
    return out;
  };
  const withNext = (status: SeriesStatus): SeriesStatus => {
    const np = next(status.run);
    if (np) status.nextPart = np;
    return status;
  };

  const today = localDayOf(now, h);
  if (today === undefined || n === 0) return withNext({ state: "not-started", run: 0 });

  const days = parts.map((p) => {
    const d = dayOfIso(scenes.get(p.sceneId)?.completedAt, h);
    return d !== undefined && d <= today ? d : undefined;
  });
  const anchor = series.reset === "step_back" ? stepBackAnchor(days) : startAnchor(days);
  if (!anchor) return withNext({ state: "not-started", run: 0 });

  const lastDay = dayLabel(anchor.day);
  if (anchor.run >= n) return { state: "finished", run: n, lastDay };
  if (anchor.day === today) return withNext({ state: "done-today", run: anchor.run, lastDay });
  if (anchor.day === today - 1) {
    return withNext({
      state: "due",
      run: anchor.run,
      lastDay,
      deadline: dayStartDate(today + 1, h).toISOString(),
    });
  }
  const missed = today - anchor.day - 1;
  const run = series.reset === "step_back" ? Math.max(0, anchor.run - missed) : 0;
  return withNext({ state: "broken", run, lastDay });
}

/** Status per series (keyed by group id). */
export function seriesStatuses(
  series: readonly SeriesInput[],
  scenes: ReadonlyMap<Id, SceneInput>,
  now: Date,
  dayStartHour: number = DEFAULT_DAY_START_HOUR,
): Map<Id, SeriesStatus> {
  const out = new Map<Id, SeriesStatus>();
  for (const s of series) out.set(s.groupId, seriesStatus(s, scenes, now, dayStartHour));
  return out;
}

/**
 * Scenes of daily series that normal suggestions must leave out: every part,
 * except the next part of a series that is not done for today (due, broken
 * or not started). A scene in two series stays allowed if either allows it.
 */
export function blockedSeriesScenes(
  series: readonly SeriesInput[],
  scenes: ReadonlyMap<Id, SceneInput>,
  now: Date,
  dayStartHour: number = DEFAULT_DAY_START_HOUR,
): Set<Id> {
  const blocked = new Set<Id>();
  const allowed = new Set<Id>();
  for (const s of series) {
    for (const p of s.parts) blocked.add(p.sceneId);
    const st = seriesStatus(s, scenes, now, dayStartHour);
    if (st.nextPart && st.state !== "done-today" && st.state !== "finished") allowed.add(st.nextPart.sceneId);
  }
  for (const id of allowed) blocked.delete(id);
  return blocked;
}
