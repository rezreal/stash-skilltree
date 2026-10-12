// Splits a script into sections the track rule scores differently:
//
// - hold:   flat (position change <= flatTolerance) for >= holdMinMs, with depth
// - idle:   the same, but near 0 (mean position <= idleMax): "no depth"
// - stroke: fast movement (>= strokeSpeed units/s) with >= 2 direction changes
// - ramp:   slow movement to a new depth (also a lone fast move between two
//           flat stretches, which has no turning point to time)
//
// Expects normalised actions (scriptActions: inverted / range applied, so 0
// means "no depth"). Short flat bits (< holdMinMs) stay part of the movement
// around them, e.g. a brief pause at the bottom of a stroke. Sections cover
// 0 .. last action without gaps and are deterministic. Pure.

import type { Action } from "../funscript/parse.ts";
import { DEFAULT_SECTION_PARAMS } from "./types.ts";
import type { Section, SectionParams, TrackLimits } from "./types.ts";

/** sorted by time, one action per timestamp (the last wins) */
function clean(actions: Action[]): Action[] {
  const sorted = actions
    .filter((a) => Number.isFinite(a.at) && Number.isFinite(a.pos))
    .map((a, i) => ({ a, i }))
    .sort((x, y) => x.a.at - y.a.at || x.i - y.i)
    .map((x) => x.a);
  const out: Action[] = [];
  for (const a of sorted) {
    const last = out[out.length - 1];
    if (last && last.at === a.at) last.pos = a.pos;
    else out.push({ at: a.at, pos: a.pos });
  }
  return out;
}

type Range = [number, number];

/** maximal flat runs of >= holdMinMs, as action index ranges (greedy, left to right) */
function flatRuns(acts: Action[], p: SectionParams): Range[] {
  const out: Range[] = [];
  let i = 0;
  while (i < acts.length - 1) {
    let lo = acts[i].pos;
    let hi = lo;
    let j = i;
    while (j + 1 < acts.length) {
      const q = acts[j + 1].pos;
      const nlo = Math.min(lo, q);
      const nhi = Math.max(hi, q);
      if (nhi - nlo > p.flatTolerance) break;
      lo = nlo;
      hi = nhi;
      j++;
    }
    if (j > i && acts[j].at - acts[i].at >= p.holdMinMs) {
      out.push([i, j]);
      i = j;
    } else i++;
  }
  return out;
}

function mean(acts: Action[], i0: number, i1: number): number {
  // time-weighted mean of the polyline
  let area = 0;
  for (let k = i0; k < i1; k++) area += ((acts[k].pos + acts[k + 1].pos) / 2) * (acts[k + 1].at - acts[k].at);
  const dur = acts[i1].at - acts[i0].at;
  return dur > 0 ? area / dur : acts[i0].pos;
}

function flatSection(acts: Action[], i0: number, i1: number, p: SectionParams): Section {
  const depth = mean(acts, i0, i1);
  return { kind: depth <= p.idleMax ? "idle" : "hold", start: acts[i0].at, end: acts[i1].at, depth };
}

/**
 * Turning points of the movement in acts[i0..i1] (zigzag with hysteresis:
 * a reversal counts once it retreats more than `tol` from the extreme).
 * Returns pivot indices, first = where the movement starts; empty when the
 * movement never exceeds `tol`.
 */
function pivots(acts: Action[], i0: number, i1: number, tol: number): number[] {
  const piv: number[] = [];
  let dir = 0;
  let ext = i0;
  let lo = i0;
  let hi = i0;
  for (let k = i0 + 1; k <= i1; k++) {
    const q = acts[k].pos;
    if (dir === 0) {
      if (q < acts[lo].pos) lo = k;
      if (q > acts[hi].pos) hi = k;
      if (acts[hi].pos - acts[lo].pos > tol) {
        piv.push(Math.min(lo, hi));
        ext = Math.max(lo, hi);
        dir = hi > lo ? 1 : -1;
      }
    } else if (dir === 1) {
      if (q > acts[ext].pos) ext = k;
      else if (acts[ext].pos - q > tol) {
        piv.push(ext);
        dir = -1;
        ext = k;
      }
    } else {
      if (q < acts[ext].pos) ext = k;
      else if (q - acts[ext].pos > tol) {
        piv.push(ext);
        dir = 1;
        ext = k;
      }
    }
  }
  if (dir !== 0) piv.push(ext);
  return piv;
}

function movementSections(acts: Action[], i0: number, i1: number, p: SectionParams): Section[] {
  const piv = pivots(acts, i0, i1, p.flatTolerance);
  if (piv.length < 2) return [];
  interface Leg {
    a: number;
    b: number;
    start: number;
    end: number;
    fast: boolean;
  }
  const legs: Leg[] = [];
  for (let l = 0; l + 1 < piv.length; l++) {
    const a = piv[l];
    const b = piv[l + 1];
    const dt = acts[b].at - acts[a].at;
    const speed = dt > 0 ? (Math.abs(acts[b].pos - acts[a].pos) * 1000) / dt : Infinity;
    legs.push({
      a,
      b,
      start: l === 0 ? acts[i0].at : acts[a].at,
      end: l + 2 === piv.length ? acts[i1].at : acts[b].at,
      fast: speed >= p.strokeSpeed,
    });
  }
  const out: Section[] = [];
  let k = 0;
  while (k < legs.length) {
    if (legs[k].fast) {
      let m = k;
      while (m + 1 < legs.length && legs[m + 1].fast) m++;
      if (m > k) {
        let min = Infinity;
        let max = -Infinity;
        const turns: number[] = [];
        for (let l = k; l <= m; l++) {
          min = Math.min(min, acts[legs[l].a].pos, acts[legs[l].b].pos);
          max = Math.max(max, acts[legs[l].a].pos, acts[legs[l].b].pos);
          if (l > k) turns.push(acts[legs[l].a].at);
        }
        out.push({ kind: "stroke", start: legs[k].start, end: legs[m].end, min, max, turns });
        k = m + 1;
        continue;
      }
    }
    const leg = legs[k];
    out.push({ kind: "ramp", start: leg.start, end: leg.end, from: acts[leg.a].pos, to: acts[leg.b].pos });
    k++;
  }
  return out;
}

/** deepest position a section reaches */
export function sectionDepth(s: Section): number {
  switch (s.kind) {
    case "stroke":
      return s.max ?? 0;
    case "ramp":
      return Math.max(s.from ?? 0, s.to ?? 0);
    default:
      return s.depth ?? 0;
  }
}

/** Marks sections beyond the limits (max depth, max hold) unscored. Idle sections are never scored anyway. */
export function applyLimits(sections: Section[], limits: TrackLimits): Section[] {
  return sections.map((s) => {
    if (s.kind === "idle") return s;
    const tooDeep = sectionDepth(s) > limits.maxDepth;
    const tooLong = s.kind === "hold" && s.end - s.start > limits.maxHoldSec * 1000;
    return tooDeep || tooLong ? { ...s, unscored: true } : s;
  });
}

/**
 * Sections of a (normalised) script, covering 0 .. last action. Limits are
 * only applied when given. Empty without at least two distinct timestamps
 * (counting the implicit start at 0).
 */
export function segment(actions: Action[], params?: Partial<SectionParams>, limits?: TrackLimits): Section[] {
  const p: SectionParams = { ...DEFAULT_SECTION_PARAMS, ...params };
  const acts = clean(actions);
  if (acts.length === 0) return [];
  // before the first action its position holds (as in positionAt)
  if (acts[0].at > 0) acts.unshift({ at: 0, pos: acts[0].pos });
  if (acts.length < 2) return [];

  // Flat runs; runs that touch (share an action) are a slow drift, i.e. a ramp.
  const runs = flatRuns(acts, p);
  const blocks: { range: Range; drift: boolean }[] = [];
  for (const r of runs) {
    const last = blocks[blocks.length - 1];
    if (last && last.range[1] === r[0]) {
      last.range = [last.range[0], r[1]];
      last.drift = true;
    } else blocks.push({ range: [r[0], r[1]], drift: false });
  }

  const out: Section[] = [];
  let cursor = 0;
  for (const b of blocks) {
    const [i0, i1] = b.range;
    if (i0 > cursor) out.push(...movementSections(acts, cursor, i0, p));
    const from = acts[i0].pos;
    const to = acts[i1].pos;
    if (b.drift && Math.abs(to - from) > p.flatTolerance) {
      out.push({ kind: "ramp", start: acts[i0].at, end: acts[i1].at, from, to });
    } else out.push(flatSection(acts, i0, i1, p));
    cursor = i1;
  }
  if (cursor < acts.length - 1) out.push(...movementSections(acts, cursor, acts.length - 1, p));

  const first = acts[0].at;
  const lastAt = acts[acts.length - 1].at;
  if (out.length === 0) return limit([flatSection(acts, 0, acts.length - 1, p)], limits);

  // Close gaps left by movement too small to form a leg: the previous section
  // extends over it (the first one reaches back to the start).
  out[0].start = first;
  for (let k = 1; k < out.length; k++) out[k - 1].end = out[k].start;
  out[out.length - 1].end = lastAt;
  return limit(out, limits);
}

function limit(sections: Section[], limits: TrackLimits | undefined): Section[] {
  return limits ? applyLimits(sections, limits) : sections;
}
