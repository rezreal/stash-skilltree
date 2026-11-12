// What the prompt banner says. Pure.

import { eyesClosedHoldSec, isSustained, shareText, type GazeMoment } from "../prompts/gazeCheck.ts";
import { sharePercentText } from "../prompts/hold.ts";
import { scoredByShare } from "../prompts/actionCheck.ts";
import { isPoseAction } from "../prompts/posture.ts";
import type { GazeTarget, PromptAction, PromptProgress, PromptSpec } from "../prompts/types.ts";

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
  eyes_closed: "your eyes closed",
};

const ACTION_WORDS: Readonly<Record<PromptAction, string>> = {
  nod: "Nod",
  shake_head: "Shake your head",
  eyes_closed: "Close your eyes",
  eyes_open: "Keep your eyes open",
  hand_raised: "Raise a hand",
  still: "Hold still",
  mouth_open: "Open your mouth",
  mouth_closed: "Keep your mouth closed",
  hand_to_mouth: "Hand to your mouth",
  stroking: "Stroke",
  hands_off: "Hands off",
  arms_up: "Arms up",
  hands_on_head: "Hands on your head",
  hands_together: "Hands together",
  kneel: "Kneel",
  kneel_sit: "Kneel and sit on your heels",
  stand: "Stand up",
  lie_down: "Lie down",
  cat: "Cat pose",
  cow: "Cow pose",
  puppy: "Extended puppy pose",
  down_dog: "Downward-facing dog",
  plank: "Plank",
  plow: "Plow pose",
  straddle: "Straddle stretch",
  straddle_up: "Upward seated straddle",
  child: "Child's pose",
  forward_fold: "Standing forward fold",
  happy_baby: "Happy baby pose",
  savasana: "Savasana (corpse pose)",
  hastasana: "Upward salute (hastasana)",
  warrior: "Warrior II",
  tree: "Tree pose",
  cobra: "Cobra pose",
  butterfly: "Butterfly stretch",
  shoulder_stand: "Shoulder stand",
};

/** "their eyes", "the floor in front of their feet", ... */
export function gazeTargetWords(target: GazeTarget): string {
  return TARGET_WORDS[target] ?? target.replace(/_/g, " ");
}

/** "Hands on your head", ... */
export function actionWords(action: PromptAction): string {
  return ACTION_WORDS[action] ?? action.replace(/_/g, " ");
}

/** "Look at their eyes", "Look away from the screen", "Close your eyes" */
export function gazeInstruction(target: GazeTarget): string {
  if (target === "off_screen") return "Look away from the screen";
  if (target === "eyes_closed") return "Close your eyes";
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

type LabelSpec = Pick<PromptSpec, "check" | "holdSec"> & {
  target?: GazeTarget | undefined;
  action?: PromptAction | undefined;
  start?: number;
  end?: number;
};

/**
 * A gaze window, or an action window that scores by share (body poses,
 * mouth_closed, still), longer than LONG_WINDOW_SEC: scored by share, not by
 * the hold.
 */
export function sustainedWindow(spec: LabelSpec): boolean {
  if (spec.check !== "gaze" && !(spec.check === "action" && scoredByShare(spec.action))) return false;
  return spec.start !== undefined && spec.end !== undefined && isSustained({ start: spec.start, end: spec.end });
}

/**
 * The label of the progress bar: what is measured. Long gaze and pose windows
 * show the share ("eyes closed 82% · need 75%", "in pose 90% · need 75%"),
 * short ones the hold ("hold 2 s").
 */
export function progressLabel(spec: LabelSpec, share?: number): string {
  switch (spec.check) {
    case "repeat":
      return "match";
    case "gaze":
      if (sustainedWindow(spec)) return shareText(spec.target, share);
      return `hold ${formatSec(spec.target === "eyes_closed" ? eyesClosedHoldSec(spec.holdSec) : spec.holdSec)}`;
    case "action":
      if (!sustainedWindow(spec)) return "hold";
      return `${isPoseAction(spec.action) ? "in pose" : "held"} ${sharePercentText(share)}`;
    default:
      return "hold";
  }
}

function formatSec(s: number): string {
  const r = Math.round(s * 10) / 10;
  return `${r} s`;
}

// --- gaze prompts as the attention target -------------------------------------------

export interface PromptAttentionText {
  /** the inattention overlay */
  pause: { title: string; hint: string };
  /** the banner notice and callout title during the grace period */
  grace: string;
  /** what to do, short (the callout detail while paused) */
  back: string;
}

/** What the session says when the viewer doesn't follow an active gaze prompt. */
export function promptAttentionText(spec: Pick<PromptSpec, "target">): PromptAttentionText {
  const target = spec.target;
  if (target === "eyes_closed") {
    return {
      pause: {
        title: "Your eyes are open – close them to continue",
        hint: "This part asks you to keep your eyes closed. The clip continues as soon as they are closed again.",
      },
      grace: "Your eyes are open – close them",
      back: "Close your eyes",
    };
  }
  const instruction = target ? gazeInstruction(target) : "Look at the person";
  const where = target === "off_screen" ? "away from the screen" : target ? `at ${gazeTargetWords(target)}` : "at the person";
  return {
    pause: { title: `${instruction} to continue`, hint: `This part asks you to look ${where}. The clip continues when you do.` },
    grace: instruction,
    back: instruction,
  };
}

/** The attention verdict's reason for a gaze prompt's moment, in plain words. */
export function promptAttentionReason(spec: Pick<PromptSpec, "target">, state: GazeMoment): string {
  if (state === "unknown") return "prompt not measurable right now";
  if (state === "on") return spec.target === "eyes_closed" ? "eyes closed" : "following the prompt";
  if (spec.target === "eyes_closed") return "eyes open";
  if (spec.target === "off_screen") return "looking at the screen";
  return spec.target ? `not looking at ${gazeTargetWords(spec.target)}` : "not looking at the person";
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
  /** long gaze and pose windows: the share line, shown instead of the seconds left ("eyes closed 82% · need 75%") */
  shareText?: string;
  /** why this prompt can't be checked right now (it is then not counted) */
  note?: string;
  /** active body poses: what to change right now ("Sit back onto your heels") */
  hint?: string;
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

/** The active prompt that started last. */
function latestActive(progress: readonly PromptProgress[]): PromptProgress | undefined {
  let pick: PromptProgress | undefined;
  for (const p of progress) if (p.phase === "active" && (pick === undefined || p.spec.start > pick.spec.start)) pick = p;
  return pick;
}

type BannerInput = {
  progress: readonly PromptProgress[];
  videoTime?: number;
  nowMs: number;
  last?: LastResult;
  uncheckable?: (spec: PromptSpec) => string | undefined;
};

function openView(pick: PromptProgress, input: BannerInput): BannerView {
  const spec = pick.spec;
  const view: BannerView = {
    spec,
    tone: pick.phase === "replaying" ? "replaying" : "active",
    instruction: promptInstruction(spec),
    progress: clamp01(pick.progress),
    progressLabel: progressLabel(spec, pick.share),
  };
  if (sustainedWindow(spec)) view.shareText = view.progressLabel;
  if (pick.phase === "replaying") view.status = "Replaying: try again";
  else if (pick.replays > 0) view.status = "Second try";
  const note = input.uncheckable?.(spec);
  if (note !== undefined) view.note = note;
  else if (pick.phase === "active" && pick.hint !== undefined) view.hint = pick.hint;
  if (pick.phase === "active" && input.videoTime !== undefined && Number.isFinite(input.videoTime)) {
    view.secondsLeft = Math.max(0, spec.end - input.videoTime);
  }
  return view;
}

function resultView(last: LastResult, progress: readonly PromptProgress[]): BannerView {
  const p = progress.find((q) => q.spec.markerId === last.spec.markerId);
  const view: BannerView = {
    spec: last.spec,
    tone: last.passed ? "passed" : "missed",
    instruction: promptInstruction(last.spec),
    status: last.passed ? "Done" : "Missed",
    progress: last.passed ? 1 : clamp01(p?.progress ?? 0),
    progressLabel: progressLabel(last.spec, p?.share),
  };
  if (sustainedWindow(last.spec)) view.shareText = view.progressLabel;
  return view;
}

/**
 * What the banner shows now, one row per prompt, in start order (rows don't
 * jump when a later prompt begins):
 * - every active prompt - overlapping prompts are checked side by side
 *   (e.g. "Kneel and sit on your heels" for minutes with "Look at their
 *   eyes" inside it). Of overlapping gaze prompts only the one that started
 *   last is shown: it supersedes the others, which count no evidence
 *   meanwhile (see runner.ts).
 * - without an active prompt, a prompt waiting for its replay ("Replaying:
 *   try again").
 * - the last result for RESULT_SHOW_MS ("Done" / "Missed"), after the active
 *   rows, unless a replay is waiting.
 */
export function bannerViews(input: BannerInput): BannerView[] {
  const active = input.progress.filter((p) => p.phase === "active");
  const leadGaze = latestActive(active.filter((p) => p.spec.check === "gaze"));
  const views = active
    .filter((p) => p.spec.check !== "gaze" || p === leadGaze)
    .sort((a, b) => a.spec.start - b.spec.start)
    .map((p) => openView(p, input));
  if (views.length === 0) {
    const waiting = input.progress.find((p) => p.phase === "replaying");
    if (waiting) return [openView(waiting, input)];
  }
  const last = input.last;
  if (
    last &&
    input.nowMs - last.atMs >= 0 &&
    input.nowMs - last.atMs < RESULT_SHOW_MS &&
    !views.some((v) => v.spec.markerId === last.spec.markerId)
  ) {
    views.push(resultView(last, input.progress));
  }
  return views;
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}
