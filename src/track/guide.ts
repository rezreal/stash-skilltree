// What the on-video guide shows at one moment. Pure.
//
// Choice of target: the scorer compares the user's position at script time
// t with the script at t - lag. The guide's `target` is exactly that
// reference, positionAt(scriptMs - lagMs), so "current on target" means
// "scoring well right now", by construction. The preview runs from the
// target forward (what the target will do next) so the user can anticipate
// the movement instead of reacting to the marker: following the marker with
// the preview's help lines up with the scoring, and a user who follows the
// video instead lines up through the measured lag. The session measures the
// lag once and then keeps it, so following the guide can't feed back into
// a growing lag.

import type { Action } from "../funscript/parse.ts";
import { actionIndexAt, positionAt } from "./normalize.ts";
import { sectionAt } from "./score.ts";
import type { GuideFrame, Section } from "./types.ts";

/** Slope magnitude (units/s) below which a stroke or ramp counts as a pause. */
const STILL_SPEED = 5;
/** Half-width of the window the slope is measured over, ms. */
const SLOPE_MS = 50;

export interface GuideInput {
  actions: Action[];
  sections: Section[];
  /** current video time in script ms */
  scriptMs: number;
  lagMs: number;
  /** calibrated sensor position, if any */
  current?: number;
  /** preview length, ms (default 3000) */
  previewMs?: number;
}

export function guideFrame(input: GuideInput): GuideFrame {
  const { actions, sections, lagMs } = input;
  const previewMs = input.previewMs ?? 3000;
  const te = input.scriptMs - (Number.isFinite(lagMs) ? lagMs : 0);
  const target = positionAt(actions, te);
  const section = sectionAt(sections, te);

  let direction: GuideFrame["direction"];
  if (section?.kind === "idle") direction = "idle";
  else if (section?.kind === "hold") direction = "hold";
  else {
    const slope = ((positionAt(actions, te + SLOPE_MS) - positionAt(actions, te - SLOPE_MS)) * 1000) / (2 * SLOPE_MS);
    if (slope > STILL_SPEED) direction = "in";
    else if (slope < -STILL_SPEED) direction = "out";
    else direction = section ? "hold" : target <= 5 ? "idle" : "hold";
  }

  // preview: the target now, every action ahead, the target at the end
  const preview: [number, number][] = [[0, target]];
  const end = te + previewMs;
  for (let i = actionIndexAt(actions, te) + 1; i < actions.length && actions[i].at < end; i++) {
    if (actions[i].at > te) preview.push([actions[i].at - te, actions[i].pos]);
  }
  if (previewMs > 0) preview.push([previewMs, positionAt(actions, end)]);

  const frame: GuideFrame = { target, direction, preview };
  if (input.current !== undefined && Number.isFinite(input.current)) frame.current = input.current;
  if (section) frame.section = section;
  if (section?.kind === "hold" && section.end > section.start) {
    frame.holdProgress = Math.max(0, Math.min(1, (te - section.start) / (section.end - section.start)));
  }
  return frame;
}
