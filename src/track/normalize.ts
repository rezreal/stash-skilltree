// Script positions as the track rule sees them: depth 0 = out (no depth),
// 100 = the deepest point. A funscript's pos is the other way round (100 =
// top of the stroke = out, 0 = bottom = deepest), so depth = 100 - pos; a
// file marked `inverted` already counts the other way and is taken as is.
// `range` (full-scale value) is applied first. Pure.

import type { Action, Funscript } from "../funscript/parse.ts";

const clamp = (p: number) => (p < 0 ? 0 : p > 100 ? 100 : p);

/**
 * The main axis as depth: `range` (full-scale value) applied, clamped to
 * 0..100, then 100 - pos unless the file is marked `inverted`. Actions sharing a timestamp collapse to the last one,
 * so the result is strictly increasing in `at`.
 */
export function scriptActions(f: Funscript): Action[] {
  const range = f.range !== undefined && f.range > 0 ? f.range : 100;
  const out: Action[] = [];
  for (const a of f.actions) {
    const p = clamp((a.pos / range) * 100);
    const pos = f.inverted ? p : 100 - p;
    const last = out[out.length - 1];
    if (last && last.at === a.at) last.pos = pos;
    else out.push({ at: a.at, pos });
  }
  return out;
}

/** Index of the last action with at <= ms, -1 before the first. */
export function actionIndexAt(actions: Action[], ms: number): number {
  let lo = 0;
  let hi = actions.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (actions[mid].at <= ms) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/**
 * Script position at `ms`, linearly interpolated between actions; before
 * the first / after the last action the edge value holds. 0 without actions.
 */
export function positionAt(actions: Action[], ms: number): number {
  const n = actions.length;
  if (n === 0) return 0;
  if (ms <= actions[0].at) return actions[0].pos;
  if (ms >= actions[n - 1].at) return actions[n - 1].pos;
  const i = actionIndexAt(actions, ms);
  const a = actions[i];
  const b = actions[i + 1];
  if (b.at === a.at) return b.pos;
  return a.pos + ((b.pos - a.pos) * (ms - a.at)) / (b.at - a.at);
}
