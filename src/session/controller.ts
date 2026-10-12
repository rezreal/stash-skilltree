// Pure decisions of the Skilltree session on stash's scene player
// (useSkilltreeSession.ts): which pauses are the viewer's, when the pause
// lock applies, how long a spend prompt stays open, what the compact banner
// and the score chip say. Tested under node --test.
import type { Id, SceneInput } from "../core/types.ts";
import { exposureTarget, exposureTotal, isTerminal } from "../play/session.ts";
import type { SessionPhase, SessionState, WatchPolicy } from "../play/types.ts";
import type { SpendPrompt } from "../player/markers.ts";
import type { PauseCause as ViewPauseCause } from "../player/view.ts";
import { formatPercent } from "../player/format.ts";
import type { PauseCause } from "../stashplayer/videoHandle.ts";

/**
 * A pause the session must hear about as pauseByUser. Only cause "other"
 * (control bar, click, keys, media keys, the browser): our own pauses
 * ("plugin"), seeks and the end of the clip are not the viewer's. Nothing
 * counts once the session is over or while a spend prompt holds the video.
 */
export function isViewerPause(cause: PauseCause, state: Pick<SessionState, "phase">, spendOpen: boolean): boolean {
  if (cause !== "other") return false;
  if (state.phase === "aborted" || state.phase === "complete") return false;
  return !spendOpen;
}

/** seconds a spend prompt waits for an answer: its window, 5..60 s */
export function spendWindowSec(prompt: Pick<SpendPrompt, "window">): number {
  return Math.min(60, Math.max(5, prompt.window.end - prompt.window.start));
}

export function spendDeadlineMs(prompt: Pick<SpendPrompt, "window">, nowMs: number): number {
  return nowMs + spendWindowSec(prompt) * 1000;
}

/**
 * The viewer's pause affordances are locked while a clip that doesn't allow
 * pausing (WatchPolicy.allowUserPause, off for watched clips, on for loops)
 * is in a running session. Before the policy is known and after the session
 * ended, the player behaves as stash's.
 */
export function wantsPauseLock(policy: Pick<WatchPolicy, "allowUserPause"> | undefined, phase: SessionPhase | undefined): boolean {
  if (!policy || phase === undefined) return false;
  if (phase === "aborted" || phase === "complete") return false;
  return !policy.allowUserPause;
}

/** why the video is paused, for phaseView */
export function viewPauseCause(spendOpen: boolean, pausedBy: SessionState["pausedBy"]): ViewPauseCause {
  if (spendOpen) return "spend";
  if (pausedBy === "user") return "user";
  if (pausedBy === "inattention") return "attention";
  return undefined;
}

/** the tree's SceneInput for a stash scene id (graph first, then the raw library) */
export function findTreeScene(
  data: { graph: { scenes: Map<Id, SceneInput> }; library: { scenes: SceneInput[] } },
  sceneId: Id,
): SceneInput | undefined {
  return data.graph.scenes.get(sceneId) ?? data.library.scenes.find((s) => s.id === sceneId);
}

/** the player should be paused / playing because of the session's one-shot flags */
export function playerRequest(
  state: Pick<SessionState, "phase" | "pauseRequested" | "resumeRequested">,
  videoPaused: boolean,
  spendOpen: boolean,
): "pause" | "play" | undefined {
  if (isTerminal(state as SessionState)) return undefined;
  if (state.pauseRequested && !videoPaused) return "pause";
  if (state.resumeRequested && videoPaused && !spendOpen) return "play";
  return undefined;
}

export type NoticeTone = "info" | "warning";

export interface BannerNotice {
  text: string;
  tone: NoticeTone;
}

/**
 * The one notice the top banner shows, most urgent first: a pause attempt
 * that was undone, the grace warning, the "press play" hint. Spend prompts
 * and overlays speak for themselves, so nothing shows while one is open.
 */
export function bannerNotice(input: {
  phase: SessionPhase;
  spendOpen: boolean;
  pauseAttemptRecent: boolean;
  graceText: string;
  exposureOnly: boolean;
  /** test mode: the hint says nothing is saved at all */
  test?: boolean;
}): BannerNotice | undefined {
  const { phase } = input;
  if (input.spendOpen || phase === "aborted" || phase === "complete") return undefined;
  if (input.pauseAttemptRecent) {
    return { text: "Pausing isn’t part of the session. Stop (Esc) ends it – the clip won’t count.", tone: "warning" };
  }
  if (phase === "grace") return { text: input.graceText, tone: "warning" };
  if (phase === "ready" && input.test) {
    return { text: "Test mode – press play. Every check runs; nothing is saved.", tone: "info" };
  }
  if (phase === "ready") {
    return {
      text: input.exposureOnly
        ? "Press play to start the loop. Stopping saves its minutes."
        : "Press play to start. Nothing is saved until the clip is complete.",
      tone: "info",
    };
  }
  return undefined;
}

export interface ScoreChipView {
  /** short value, e.g. "93%" or "12 min" */
  value: string;
  /** what the value is, for the label */
  label: string;
  tone: "blue" | "orange" | "muted";
}

/**
 * The small chip that opens the sensors panel: the score that decides the
 * clip (attended share, or exposure minutes for loops) and whether
 * attention is with the video right now.
 */
export function scoreChipView(
  state: Pick<SessionState, "attendedFraction" | "exposureSec" | "priorExposureSec" | "phase">,
  policy: Pick<WatchPolicy, "rules" | "attentionMin" | "minMinutes">,
  attending: boolean,
): ScoreChipView {
  if (policy.rules.includes("attention")) {
    const below = state.phase !== "ready" && !attending;
    return {
      value: formatPercent(state.attendedFraction),
      label: `attended, needs ${formatPercent(policy.attentionMin)}`,
      tone: below ? "orange" : "blue",
    };
  }
  if (policy.rules.includes("exposure")) {
    const min = Math.floor((state.priorExposureSec + state.exposureSec) / 60);
    return {
      value: policy.minMinutes ? `${min}/${policy.minMinutes} min` : `${min} min`,
      label: "exposure",
      tone: "blue",
    };
  }
  return { value: attending ? "with you" : "away", label: "attention", tone: attending ? "blue" : "muted" };
}

/** the loop's minutes are worth saving on the way out (stop, leaving the page) */
export function loopWorthSaving(state: Pick<SessionState, "phase" | "exposureSec">, saveIdle: boolean): boolean {
  return saveIdle && state.exposureSec >= 1 && state.phase !== "aborted" && state.phase !== "complete";
}

export interface RuleResult {
  rule: "attention" | "prompts" | "track" | "exposure";
  label: string;
  /** e.g. "93% / 90%" */
  value: string;
  /** undefined: not scored (no prompt results, no track readings) */
  passed: boolean | undefined;
}

/**
 * Each rule of the policy with its result, the same thresholds as the
 * session's evaluateRules; for test mode's summary (what decided the clip).
 */
export function ruleResults(state: SessionState, promptCount: number): RuleResult[] {
  const p = state.policy;
  const out: RuleResult[] = [];
  if (p.rules.includes("attention")) {
    out.push({
      rule: "attention",
      label: "Attention",
      value: `${formatPercent(state.attendedFraction)} / ${formatPercent(p.attentionMin)}`,
      passed: state.attendedFraction >= p.attentionMin,
    });
  }
  if (p.rules.includes("prompts")) {
    const passed = state.prompts.filter((r) => r.passed).length;
    const answered = state.prompts.length;
    out.push({
      rule: "prompts",
      label: "Prompts",
      value: answered > 0 ? `${passed} of ${answered} passed${promptCount > answered ? ` (${promptCount} markers)` : ""} / ${formatPercent(p.promptsMin)}` : "no results",
      passed: answered > 0 ? passed / answered >= p.promptsMin : undefined,
    });
  }
  if (p.rules.includes("track")) {
    out.push({
      rule: "track",
      label: "Track",
      value: state.track !== undefined ? `${formatPercent(state.track)} / ${formatPercent(p.trackMin)}` : "not scored",
      passed: state.track !== undefined ? state.track >= p.trackMin : undefined,
    });
  }
  if (p.rules.includes("exposure")) {
    const total = exposureTotal(state);
    const target = exposureTarget(state);
    out.push({
      rule: "exposure",
      label: "Exposure",
      value: `${Math.floor(total / 60)} / ${Math.ceil(target / 60)} min`,
      passed: total >= target,
    });
  }
  return out;
}
