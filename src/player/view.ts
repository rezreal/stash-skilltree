// View-model helpers for the choice and player screens.
// Pure, tested under node --test.
import type { Id, MarkerInput, NodeKey, Progress, SceneInput, SeriesInput, Visibility } from "../core/types.ts";
import type {
  AbortReason,
  LedgerEntry,
  SeriesStatus,
  SessionPhase,
  Suggestion,
  SuggestionKind,
  WatchPolicy,
} from "../play/types.ts";
import { formatDuration, formatMinutes, nodeLabel } from "./format.ts";

// --- suggestion cards ------------------------------------------------------------

export const KIND_LABEL: Record<SuggestionKind, string> = {
  continue: "Continue",
  explore: "Explore",
  earn: "Earn",
};

const MARKER_CHIP: Record<NonNullable<MarkerInput["check"]>, string> = {
  repeat: "repeat-after-me",
  gaze: "look-at prompts",
  action: "webcam actions",
  spend: "spend prompt",
  mail: "mail drafts",
};

/**
 * What a clip will check, in display order: the policy rules, then one chip
 * per kind of prompt marker it has. Prompt chips only appear when the policy
 * includes `prompts`, except spend and mail prompts, which always apply
 * (both hold the clip until answered).
 */
export function checkChips(policy: WatchPolicy, markers: MarkerInput[]): string[] {
  const chips: string[] = [];
  const add = (c: string) => {
    if (!chips.includes(c)) chips.push(c);
  };
  if (policy.rules.includes("attention")) add("attention");
  if (policy.rules.includes("exposure")) {
    add(policy.minMinutes ? `loop · ${policy.minMinutes} min` : "loop");
  }
  if (policy.rules.includes("track")) add("track");
  const order: NonNullable<MarkerInput["check"]>[] = ["repeat", "gaze", "action", "spend", "mail"];
  const present = new Set(markers.map((m) => m.check).filter((c) => c !== undefined));
  for (const check of order) {
    if (!present.has(check)) continue;
    if (check !== "spend" && check !== "mail" && !policy.rules.includes("prompts")) continue;
    add(MARKER_CHIP[check]);
  }
  return chips;
}

/** reasons as sentences: capitalized, ending with a period, joined by spaces */
export function reasonsText(reasons: string[]): string {
  return reasons
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .map((r) => {
      const s = r[0].toUpperCase() + r.slice(1);
      return /[.!?]$/.test(s) ? s : s + ".";
    })
    .join(" ");
}

/** coin badge on the thumbnail, or undefined when the clip costs nothing */
export function costBadge(s: Pick<Suggestion, "price" | "spendCost">): string | undefined {
  const parts: string[] = [];
  if (s.price > 0) parts.push(`opens for ${s.price}`);
  if (s.spendCost > 0) parts.push(`spend ${s.spendCost}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** "earns ~12 · asks you to spend 30" */
export function earnText(s: Pick<Suggestion, "estimatedEarn" | "spendCost">): string {
  const earn = `earns ~${Math.round(s.estimatedEarn)}`;
  return s.spendCost > 0 ? `${earn} · asks you to spend ${s.spendCost}` : earn;
}

export function watchButtonLabel(s: Pick<Suggestion, "price">): string {
  return s.price > 0 ? `Pay ${s.price} & watch` : "Watch";
}

export function blockedText(b: { node: NodeKey; cost: number; balance: number }): string {
  return (
    `${nodeLabel(b.node)} costs ${b.cost} and you have ${b.balance}. ` +
    "Its clips come back as suggestions once you can afford them. Earn clips pay the most."
  );
}

/**
 * Why the next clip is held back by date order. The waiting clips are named
 * by title only when they are open to play anyway; a clip behind a locked
 * level is not named, so the fog keeps it.
 */
export function chronologyText(
  w: { performerId: Id; nextSceneIds: Id[]; locked: boolean },
  performerName: string,
  titleOf: (id: Id) => string | undefined,
): string {
  if (w.locked) {
    return (
      `${performerName}'s clips are watched in date order, and their next one is behind a level that isn't open yet. ` +
      "Open more of the tree or switch performer."
    );
  }
  const titles = w.nextSceneIds.map(titleOf).filter((t): t is string => !!t);
  const next =
    titles.length === 1 ? `“${titles[0]}” comes` : titles.length > 1 ? `${titles.length} earlier clips come` : "an earlier clip comes";
  return `${performerName}'s clips are watched in date order: ${next} first.`;
}

// --- daily series cards -------------------------------------------------------------

/** "part 3 of 10" */
export function seriesPartLabel(status: SeriesStatus, total: number): string {
  const n = status.nextPart?.number ?? Math.min(total, status.run + 1);
  return `part ${n} of ${total}`;
}

/** "3-day run" / "no run yet" */
export function runLabel(run: number): string {
  return run > 0 ? `${run}-day run` : "no run yet";
}

/** time left until `deadline` as h:mm:ss / mm:ss, "00:00" once passed */
export function timeLeft(deadline: string | undefined, nowMs: number): string | undefined {
  if (deadline === undefined) return undefined;
  const ms = Date.parse(deadline) - nowMs;
  if (!Number.isFinite(ms)) return undefined;
  return formatDuration(Math.max(0, Math.ceil(ms / 1000)));
}

export interface SeriesStateView {
  text: string;
  tone: "orange" | "blue" | "red" | "muted";
  /** due: the live countdown to the deadline */
  countdown?: string;
}

/** The state line of a series card. */
export function seriesStateView(series: Pick<SeriesInput, "reset">, status: SeriesStatus, nowMs: number): SeriesStateView {
  const n = status.nextPart?.number;
  switch (status.state) {
    case "due": {
      const miss = series.reset === "step_back" ? "steps back a part if missed" : "resets if missed";
      const view: SeriesStateView = { text: `due today — ${miss}`, tone: "orange" };
      const left = timeLeft(status.deadline, nowMs);
      if (left !== undefined) view.countdown = `${left} left`;
      return view;
    }
    case "done-today":
      return { text: n ? `done for today — part ${n} unlocks tomorrow` : "done for today", tone: "blue" };
    case "broken":
      return {
        text: n && n > 1 ? `run broken — stepped back to part ${n}` : "run broken — starts again at part 1",
        tone: "red",
      };
    case "not-started":
      return { text: "start any day", tone: "muted" };
    case "finished":
      return { text: "finished", tone: "blue" };
  }
}

/** Summary line after a series part was counted: "Morning: part 4 of 10 · 4-day run". */
export function seriesSummaryLine(series: SeriesInput, status: SeriesStatus): string {
  const total = series.parts.length;
  if (status.state === "finished") return `${series.name}: finished · all ${total} parts in a ${runLabel(total)}`;
  return `${series.name}: part ${status.run} of ${total} · ${runLabel(status.run)}`;
}

/** "Trainer clip" / "Spend prompt in X" / "Opened Deepening L2" */
export function ledgerLabel(e: LedgerEntry, scenes: Map<Id, SceneInput>): string {
  const title = e.sceneId ? scenes.get(e.sceneId)?.title || `Scene ${e.sceneId}` : undefined;
  if (e.kind === "paid") return e.node ? `Opened ${nodeLabel(e.node)}` : "Opened a level";
  if (e.kind === "spent") return title ? `Spent in ${title}` : "Spend prompt";
  return title ?? "Clip counted";
}

/** most recent first */
export function recentEntries(entries: LedgerEntry[], max = 6): LedgerEntry[] {
  return [...entries].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, max);
}

/** signed amount: earned positive, spent and paid negative */
export function ledgerAmount(e: LedgerEntry): number {
  const a = Math.abs(e.amount);
  return e.kind === "earned" ? a : -a;
}

// --- player ------------------------------------------------------------------------

/** a scene whose only rule is exposure: stopping saves, never aborts */
export function isExposureOnly(policy: WatchPolicy): boolean {
  return policy.rules.includes("exposure") && !policy.rules.some((r) => r === "attention" || r === "track");
}

export function policyLabel(policy: WatchPolicy): string {
  return policy.rules.length > 0 ? `policy: ${policy.rules.join(" + ")}` : "policy: none";
}

const ABORT_TEXT: Record<AbortReason, string> = {
  user: "You stopped the clip.",
  "inattention-timeout": "You were away from the video for too long.",
  "spend-declined": "A spend prompt was declined, so this clip fails.",
  "attention-below-threshold": "Not enough of the clip was attended.",
  "prompts-below-threshold": "Not enough prompts were followed.",
  "track-below-threshold": "The script wasn't followed closely enough.",
  "exposure-below-minimum": "The loop didn't play long enough.",
  error: "The video could not be played.",
};

/** abort reasons from the session machine in plain words */
export function abortReasonText(reason: AbortReason | undefined): string {
  return reason !== undefined ? (ABORT_TEXT[reason] ?? "The session was stopped.") : "The session was stopped.";
}

export interface PhaseView {
  label: string;
  tone: "blue" | "orange" | "gold" | "muted" | "red";
  hint: string;
}

export type PauseCause = "user" | "attention" | "spend" | "mail" | undefined;

export function phaseView(phase: SessionPhase, policy: WatchPolicy, cause: PauseCause): PhaseView {
  if (cause === "spend") {
    return {
      label: "Spend prompt",
      tone: "gold",
      hint: "The clip asks for stashcoins. Confirm by holding the button. Declining or letting the time run out fails the clip.",
    };
  }
  if (cause === "mail") {
    return { label: "Mail draft", tone: "orange", hint: "The clip waits until you send the mail draft." };
  }
  switch (phase) {
    case "ready":
      return { label: "Ready", tone: "muted", hint: "Press play to start. Nothing is saved until the clip is complete." };
    case "playing":
      if (cause === "user") return { label: "Paused", tone: "muted", hint: "Paused by you. Press play to continue." };
      return {
        label: "Watching",
        tone: "blue",
        hint: isExposureOnly(policy)
          ? "Playback time is being recorded. Stopping saves the minutes."
          : "You are with the video. Attended time is being recorded.",
      };
    case "grace":
      return {
        label: "Look back",
        tone: "orange",
        hint: `Attention left the video. Playback pauses after ${policy.graceSec} s.`,
      };
    case "paused":
      if (cause === "user") return { label: "Paused", tone: "muted", hint: "Paused by you. Press play to continue." };
      return {
        label: "Paused",
        tone: "orange",
        hint: `Attention left the video for more than ${policy.graceSec} s. Playback resumes when you come back.`,
      };
    case "aborted":
      return { label: "Aborted", tone: "red", hint: "This attempt does not count. Nothing was saved." };
    case "complete":
      return { label: "Counted", tone: "blue", hint: "All rules met. Coins are booked and the tree is updated." };
  }
}

/** prompts needed for the policy: ceil(promptsMin × prompt markers) */
export function promptsNeeded(policy: WatchPolicy, promptMarkers: number): number {
  if (promptMarkers <= 0) return 0;
  return Math.max(0, Math.ceil(policy.promptsMin * promptMarkers - 1e-9));
}

/** prompt markers (anything but spend) the policy checks */
export function promptMarkers(markers: MarkerInput[]): MarkerInput[] {
  return markers.filter((m) => m.check !== undefined && m.check !== "spend");
}

// --- completion summary ----------------------------------------------------------------

/** nodes visible now that were hidden before, in graph order */
export function newlyVisible(
  before: Map<NodeKey, Visibility>,
  after: Map<NodeKey, Visibility>,
): NodeKey[] {
  const out: NodeKey[] = [];
  for (const [key, v] of after) {
    if (v === "hidden") continue;
    if ((before.get(key) ?? "hidden") === "hidden") out.push(key);
  }
  return out;
}

/** nodes complete now that weren't before */
export function newlyCompleted(before: Progress, after: Progress): NodeKey[] {
  const out: NodeKey[] = [];
  for (const [key, p] of after) {
    if (p.state === "complete" && before.get(key)?.state !== "complete") out.push(key);
  }
  return out;
}

/** "Out of the fog: Deepening L4 · Triggers L2 (gate)" parts */
export function fogLabel(key: NodeKey, v: Visibility | undefined): string {
  return v === "gate" ? `${nodeLabel(key)} (can be bought)` : nodeLabel(key);
}

export function baseLabel(durationSec: number): string {
  return `Base · ${formatMinutes(durationSec)}`;
}

/**
 * Exposure seconds already stored on the scene (st.exposure_seconds). Read
 * defensively: SceneInput may not carry the field yet.
 */
export function previousExposure(scene: SceneInput): number {
  const v = scene.exposureSec;
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : 0;
}
