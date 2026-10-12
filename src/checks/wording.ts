// What the prompt banner says. Pure.

import type { GazeTarget, PromptAction, PromptPhase, PromptProgress, PromptSpec } from "../prompts/types.ts";

const TARGET_WORDS: Readonly<Record<GazeTarget, string>> = {
  eyes: "their eyes",
  face: "their face",
  mouth: "their mouth",
  hands: "their hands",
  chest: "their chest",
  torso: "their torso",
  hips: "their hips",
  groin: "their groin",
  legs: "their legs",
  feet_floor: "the floor in front of their feet",
  screen_center: "the center of the screen",
  off_screen: "away from the screen",
};

const ACTION_WORDS: Readonly<Record<PromptAction, string>> = {
  nod: "Nod",
  shake_head: "Shake your head",
  eyes_closed: "Close your eyes",
  eyes_open: "Keep your eyes open",
  hand_raised: "Raise a hand",
  still: "Hold still",
  arms_up: "Arms up",
  hands_on_head: "Hands on your head",
  hands_together: "Hands together",
  kneel: "Kneel",
  stand: "Stand up",
  lie_down: "Lie down",
};

/** "their eyes", "the floor in front of their feet", ... */
export function gazeTargetWords(target: GazeTarget): string {
  return TARGET_WORDS[target] ?? target.replace(/_/g, " ");
}

/** "Hands on your head", ... */
export function actionWords(action: PromptAction): string {
  return ACTION_WORDS[action] ?? action.replace(/_/g, " ");
}

/** "Look at their eyes", "Look away from the screen" */
export function gazeInstruction(target: GazeTarget): string {
  if (target === "off_screen") return "Look away from the screen";
  return `Look at ${gazeTargetWords(target)}`;
}

/** The instruction for a prompt in plain words. */
export function promptInstruction(spec: Pick<PromptSpec, "check" | "title" | "target" | "action">): string {
  switch (spec.check) {
    case "repeat":
      return `Say: “${spec.title.trim()}”`;
    case "gaze":
      return spec.target ? gazeInstruction(spec.target) : "Look at the person";
    case "action":
      return spec.action ? actionWords(spec.action) : "Follow the instruction";
    case "spend":
      return `Spend ${spec.title.trim()} coins`;
    default:
      return spec.title;
  }
}

/** The label of the progress bar: what is measured. */
export function progressLabel(spec: Pick<PromptSpec, "check" | "holdSec">): string {
  switch (spec.check) {
    case "repeat":
      return "match";
    case "gaze":
      return `hold ${formatSec(spec.holdSec)}`;
    default:
      return "hold";
  }
}

function formatSec(s: number): string {
  const r = Math.round(s * 10) / 10;
  return `${r} s`;
}

// --- banner ------------------------------------------------------------------------

export type BannerTone = "active" | "replaying" | "passed" | "missed";

export interface BannerView {
  spec: PromptSpec;
  tone: BannerTone;
  instruction: string;
  /** a short status line: "Replaying: try again", "Missed", "Done" */
  status?: string;
  /** 0..1 */
  progress: number;
  progressLabel: string;
  /** why this prompt can't be checked right now (it is then not counted) */
  note?: string;
  /** seconds left in the window, when known */
  secondsLeft?: number;
}

export interface LastResult {
  spec: PromptSpec;
  passed: boolean;
  /** performance.now() ms */
  atMs: number;
}

/** How long a finished prompt stays on the banner (ms). */
export const RESULT_SHOW_MS = 2000;

const OPEN: readonly PromptPhase[] = ["active", "replaying"];

/**
 * What the banner shows now: the first active prompt; else a prompt waiting
 * for its replay ("Replaying: try again"); else the last result for
 * RESULT_SHOW_MS ("Done" / "Missed"); else nothing.
 */
export function bannerView(input: {
  progress: readonly PromptProgress[];
  videoTime?: number;
  nowMs: number;
  last?: LastResult;
  uncheckable?: (spec: PromptSpec) => string | undefined;
}): BannerView | undefined {
  const pick =
    input.progress.find((p) => p.phase === "active") ?? input.progress.find((p) => OPEN.includes(p.phase));
  if (pick) {
    const spec = pick.spec;
    const view: BannerView = {
      spec,
      tone: pick.phase === "replaying" ? "replaying" : "active",
      instruction: promptInstruction(spec),
      progress: clamp01(pick.progress),
      progressLabel: progressLabel(spec),
    };
    if (pick.phase === "replaying") view.status = "Replaying: try again";
    else if (pick.replays > 0) view.status = "Second try";
    const note = input.uncheckable?.(spec);
    if (note !== undefined) view.note = note;
    if (pick.phase === "active" && input.videoTime !== undefined && Number.isFinite(input.videoTime)) {
      view.secondsLeft = Math.max(0, spec.end - input.videoTime);
    }
    return view;
  }
  const last = input.last;
  if (last && input.nowMs - last.atMs >= 0 && input.nowMs - last.atMs < RESULT_SHOW_MS) {
    return {
      spec: last.spec,
      tone: last.passed ? "passed" : "missed",
      instruction: promptInstruction(last.spec),
      status: last.passed ? "Done" : "Missed",
      progress: last.passed ? 1 : clamp01(input.progress.find((p) => p.spec.markerId === last.spec.markerId)?.progress ?? 0),
      progressLabel: progressLabel(last.spec),
    };
  }
  return undefined;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}
