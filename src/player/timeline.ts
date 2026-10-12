// Timeline below the video: attended intervals, gaps, marker dots.
// Pure, tested under node --test.
import type { Id, MarkerInput } from "../core/types.ts";
import type { Interval, PromptResult, SpendEvent } from "../play/types.ts";
import { markerWindow } from "./markers.ts";

export interface TimelineSegment {
  start: number;
  end: number;
  kind: "attended" | "missed";
  /** percent of the duration */
  left: number;
  width: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** sorted, clipped to [0, duration], overlapping or touching intervals merged */
export function mergeIntervals(intervals: Interval[], durationSec: number): Interval[] {
  const clipped = intervals
    .map((i) => ({ start: clamp(i.start, 0, durationSec), end: clamp(i.end, 0, durationSec) }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of clipped) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

/**
 * Attended segments plus "missed" gaps between them, up to `upToSec` (the
 * furthest point watched). Nothing is drawn after it: that part is still
 * ahead. Gaps shorter than `minGapSec` are dropped (tick jitter).
 */
export function timelineSegments(
  attended: Interval[],
  durationSec: number,
  upToSec: number,
  minGapSec = 0.3,
): TimelineSegment[] {
  if (!(durationSec > 0)) return [];
  const upTo = clamp(upToSec, 0, durationSec);
  const merged = mergeIntervals(attended, durationSec);
  const pct = (v: number) => (v / durationSec) * 100;
  const seg = (start: number, end: number, kind: TimelineSegment["kind"]): TimelineSegment => ({
    start,
    end,
    kind,
    left: pct(start),
    width: pct(end - start),
  });
  const out: TimelineSegment[] = [];
  let cursor = 0;
  for (const i of merged) {
    const gapEnd = Math.min(i.start, upTo);
    if (gapEnd - cursor >= minGapSec) out.push(seg(cursor, gapEnd, "missed"));
    out.push(seg(i.start, i.end, "attended"));
    cursor = Math.max(cursor, i.end);
  }
  if (upTo - cursor >= minGapSec) out.push(seg(cursor, upTo, "missed"));
  return out;
}

export type DotState = "passed" | "failed" | "active" | "upcoming" | "accepted" | "declined";

export interface TimelineDot {
  markerId: Id;
  kind: "prompt" | "spend";
  state: DotState;
  /** percent of the duration */
  left: number;
  title: string;
}

/**
 * Dots for prompt and spend markers. A marker is "active" while `t` is
 * inside its window and nothing was recorded for it yet.
 */
export function timelineDots(
  markers: MarkerInput[],
  prompts: PromptResult[],
  spends: SpendEvent[],
  t: number,
  durationSec: number,
): TimelineDot[] {
  if (!(durationSec > 0)) return [];
  const promptBy = new Map(prompts.map((p) => [p.markerId, p]));
  const spendBy = new Map(spends.map((s) => [s.markerId, s]));
  const out: TimelineDot[] = [];
  for (const m of markers) {
    if (!m.check) continue;
    const w = markerWindow(m);
    const left = clamp((m.seconds / durationSec) * 100, 0, 100);
    const inside = t >= w.start && t < w.end;
    if (m.check === "spend") {
      const s = spendBy.get(m.id);
      const state: DotState = s ? (s.accepted ? "accepted" : "declined") : inside ? "active" : "upcoming";
      out.push({ markerId: m.id, kind: "spend", state, left, title: `Spend ${m.title}`.trim() });
    } else {
      const p = promptBy.get(m.id);
      const state: DotState = p ? (p.passed ? "passed" : "failed") : inside ? "active" : "upcoming";
      out.push({ markerId: m.id, kind: "prompt", state, left, title: m.title || m.check });
    }
  }
  return out.sort((a, b) => a.left - b.left);
}
