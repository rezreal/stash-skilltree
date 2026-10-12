// Marker windows: when a prompt or spend marker is being checked.
// Pure, tested under node --test.
import type { Id, MarkerInput } from "../core/types.ts";
import { parseSpendAmount } from "../core/graph.ts";
import type { SpendEvent } from "../play/types.ts";

/** window length for markers without end_seconds */
export const DEFAULT_WINDOW_SEC = 10;

export interface MarkerWindow {
  start: number;
  end: number;
}

/** [seconds, end_seconds), or a default-length window when there is no end */
export function markerWindow(m: MarkerInput, defaultSec = DEFAULT_WINDOW_SEC): MarkerWindow {
  const start = Math.max(0, m.seconds);
  const end = m.endSeconds !== undefined && m.endSeconds > start ? m.endSeconds : start + defaultSec;
  return { start, end };
}

/** the first marker (by start) whose window contains t, optionally filtered by check */
export function activeMarker(
  markers: MarkerInput[],
  t: number,
  check?: MarkerInput["check"],
): MarkerInput | undefined {
  let best: MarkerInput | undefined;
  for (const m of markers) {
    if (check !== undefined && m.check !== check) continue;
    if (check === undefined && m.check === undefined) continue;
    const w = markerWindow(m);
    if (t >= w.start && t < w.end && (!best || m.seconds < best.seconds)) best = m;
  }
  return best;
}

export interface SpendPrompt {
  marker: MarkerInput;
  amount: number;
  window: MarkerWindow;
}

/** spend markers with a readable amount, by start time */
export function spendPrompts(markers: MarkerInput[]): SpendPrompt[] {
  const out: SpendPrompt[] = [];
  for (const m of markers) {
    if (m.check !== "spend") continue;
    const amount = parseSpendAmount(m.title);
    if (amount === undefined || amount <= 0) continue;
    out.push({ marker: m, amount, window: markerWindow(m) });
  }
  return out.sort((a, b) => a.window.start - b.window.start);
}

/** the spend prompt to ask now: t inside its window and not decided yet */
export function pendingSpend(prompts: SpendPrompt[], decided: SpendEvent[], t: number): SpendPrompt | undefined {
  const done = new Set<Id>(decided.map((d) => d.markerId));
  return prompts.find((p) => !done.has(p.marker.id) && t >= p.window.start && t < p.window.end);
}

/**
 * Spend prompts whose window lies behind t without a decision, e.g. because
 * the viewer seeked over them. They count as declined: a spend prompt
 * can't be skipped.
 */
export function missedSpends(prompts: SpendPrompt[], decided: SpendEvent[], t: number): SpendPrompt[] {
  const done = new Set<Id>(decided.map((d) => d.markerId));
  return prompts.filter((p) => !done.has(p.marker.id) && t >= p.window.end);
}

/** coins spent in this session so far */
export function spentInSession(spends: SpendEvent[]): number {
  let n = 0;
  for (const s of spends) if (s.accepted) n += s.amount;
  return n;
}
