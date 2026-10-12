// Prompt markers -> PromptSpecs: the windows the runner checks. Pure.

import { GAZE_TARGETS, PROMPT_ACTIONS } from "./types.ts";
import type { GazeTarget, MarkerInput, PromptAction, PromptCheck, PromptSpec } from "./types.ts";

/** Default check window per kind when a marker has no end (seconds). */
export const DEFAULT_PROMPT_WINDOWS: Readonly<Record<PromptCheck, number>> = {
  repeat: 6,
  gaze: 5,
  action: 5,
  spend: 10,
};

/**
 * Seconds a repeat window stays open past an explicit marker end. The marker
 * covers the clip saying the phrase; the viewer repeats it afterwards, and
 * the recognizer's final result only arrives once they stop speaking.
 */
export const REPEAT_TAIL_SEC = 3;

export const DEFAULT_HOLD_SEC = 2;
/** holdSec is never more than this share of the window */
export const MAX_HOLD_SHARE = 0.7;

export interface PromptSpecOptions {
  /** include spend prompts (the session/player handles them by default) */
  includeSpend?: boolean;
  /** override default windows */
  windows?: Partial<Record<PromptCheck, number>>;
  /** default hold time (seconds) */
  holdSec?: number;
  /** override REPEAT_TAIL_SEC */
  repeatTailSec?: number;
}

export function isGazeTarget(s: string | undefined): s is GazeTarget {
  return s !== undefined && (GAZE_TARGETS as readonly string[]).includes(s);
}

export function isPromptAction(s: string | undefined): s is PromptAction {
  return s !== undefined && (PROMPT_ACTIONS as readonly string[]).includes(s);
}

/**
 * Specs for every marker with a valid `check`, sorted by start. Skipped:
 * markers without check, spend (unless includeSpend), gaze with a missing or
 * unknown target, action with a missing or unknown action, repeat with an
 * empty phrase, non-finite times. A missing or non-positive end falls back to
 * start + default window; an explicit repeat end gets REPEAT_TAIL_SEC added.
 */
export function promptSpecs(markers: MarkerInput[], opts?: PromptSpecOptions): PromptSpec[] {
  const windows = { ...DEFAULT_PROMPT_WINDOWS, ...opts?.windows };
  const defaultHold = opts?.holdSec ?? DEFAULT_HOLD_SEC;
  const repeatTail = Math.max(0, opts?.repeatTailSec ?? REPEAT_TAIL_SEC);
  const out: PromptSpec[] = [];
  for (const m of markers) {
    const check = m.check;
    if (check === undefined) continue;
    if (check === "spend" && !opts?.includeSpend) continue;
    if (!Number.isFinite(m.seconds)) continue;
    const start = Math.max(0, m.seconds);
    const explicitEnd = m.endSeconds !== undefined && Number.isFinite(m.endSeconds) && m.endSeconds > start;
    const end = explicitEnd ? m.endSeconds! + (check === "repeat" ? repeatTail : 0) : start + windows[check];
    const spec: PromptSpec = {
      markerId: m.id,
      check,
      start,
      end,
      title: m.title,
      holdSec: Math.max(0, Math.min(defaultHold, MAX_HOLD_SHARE * (end - start))),
    };
    if (m.replay !== undefined) spec.replay = m.replay;
    if (check === "gaze") {
      if (!isGazeTarget(m.target)) continue;
      spec.target = m.target;
    } else if (check === "action") {
      if (!isPromptAction(m.action)) continue;
      spec.action = m.action;
    } else if (check === "repeat") {
      if (m.title.trim() === "") continue;
    }
    out.push(spec);
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end || (a.markerId < b.markerId ? -1 : 1));
}

/** Specs whose window contains videoTime (start inclusive, end exclusive). */
export function activeAt(specs: PromptSpec[], videoTime: number): PromptSpec[] {
  return specs.filter((s) => videoTime >= s.start && videoTime < s.end);
}
