// Contract for phase 2 (playing): suggestions, economy, viewing sessions.
// Shared by src/play (pure logic + write-back) and src/player (UI).

import type { Id, NodeKey } from "../core/types.ts";

// --- watch policy -------------------------------------------------------------

export type RuleName = "attention" | "exposure" | "prompts" | "track";

export interface WatchPolicy {
  rules: RuleName[];
  /** attention: share of the clip that must be attended (default 0.9) */
  attentionMin: number;
  /** attention: seconds of inattention before pausing (default 2) */
  graceSec: number;
  /** attention: seconds paused before the session aborts (default 30) */
  abortSec: number;
  /** exposure: minutes needed (loops) */
  minMinutes?: number;
  /** prompts: share of prompts that must be followed (default 0.75) */
  promptsMin: number;
  rewardMult: number;
  /**
   * Whether the viewer may pause. Off for watched clips: only the plugin
   * pauses (inattention, spend prompts, replays) and Stop ends the clip.
   * On for loops, which are meant to be paused and resumed.
   */
  allowUserPause?: boolean;
}

/** st.kind=policy tags as loaded for playing */
export interface PolicyTagInput {
  id: Id;
  name: string;
  rules: RuleName[];
  minMinutes?: number;
  trackMin?: number;
  rewardMult?: number;
}

// --- sessions -----------------------------------------------------------------

/** half-open interval in video seconds */
export interface Interval {
  start: number;
  end: number;
}

export type SessionPhase = "ready" | "playing" | "grace" | "paused" | "aborted" | "complete";

export interface SpendEvent {
  markerId: Id;
  amount: number;
  at: number;
  accepted: boolean;
}

export interface PromptResult {
  markerId: Id;
  passed: boolean;
}

export type AbortReason =
  /** Esc / stop / leaving the player */
  | "user"
  /** paused for inattention longer than abortSec */
  | "inattention-timeout"
  /** a spend prompt was declined */
  | "spend-declined"
  /** ended with attendedFraction < attentionMin */
  | "attention-below-threshold"
  /** ended with passed prompt share < promptsMin */
  | "prompts-below-threshold"
  /** ended (or stopped) with less exposure than needed */
  | "exposure-below-minimum"
  /** player/video error, tab closed, anything else the UI detects */
  | "error";

/**
 * Viewing-session state, a plain object advanced by `step` (src/play/session.ts).
 * Treat as read-only; every step returns a new object.
 */
export interface SessionState {
  sceneId: Id;
  policy: WatchPolicy;
  phase: SessionPhase;
  abortReason?: AbortReason;
  /** scene duration in seconds; 0 if unknown (then maxVideoTime is used) */
  durationSec: number;
  startedAtMs: number;
  /** nowMs of the last event that carried a time */
  lastNowMs: number;
  /** videoTime of the last tick; undefined before the first tick */
  lastVideoTime?: number;
  maxVideoTime: number;
  /** attended video intervals, sorted and merged */
  attended: Interval[];
  /** attended length / duration (or maxVideoTime), 0..1 */
  attendedFraction: number;
  /** audible playing seconds in this session */
  exposureSec: number;
  /** exposure stored on the scene before this session (st.exposure_seconds) */
  priorExposureSec: number;
  /** latest result per prompt marker */
  prompts: PromptResult[];
  spends: SpendEvent[];
  /** who paused: the user (no abort timer) or the attention rule */
  pausedBy?: "user" | "inattention";
  /** nowMs when inattention started while playing (grace running) */
  inattentiveSinceMs?: number;
  /** nowMs when the attention rule paused the video */
  pausedSinceMs?: number;
  /** one-shot: the UI should pause the video (cleared on the next step) */
  pauseRequested: boolean;
  /** one-shot: the UI should resume the video (cleared on the next step) */
  resumeRequested: boolean;
  /** pauses the viewer tried while pausing is not allowed */
  pauseAttempts: number;
  endedAtMs?: number;
}

export type SessionEvent =
  | { type: "play"; nowMs?: number }
  | { type: "pauseByUser"; nowMs?: number }
  | {
      type: "tick";
      nowMs: number;
      videoTime: number;
      attending: boolean;
      playing: boolean;
      /** false when muted / volume 0 (exposure only counts audible play); default true */
      audible?: boolean;
    }
  | { type: "prompt"; result: PromptResult }
  | { type: "spend"; event: SpendEvent }
  | { type: "ended"; nowMs: number }
  | { type: "abort"; reason: AbortReason; nowMs?: number };

/** per-rule scores 0..1; a rule without data is left out (not scored) */
export interface QualityScores {
  attention?: number;
  prompts?: number;
  exposure?: number;
}

/** what a finished session writes back; nothing is written for aborted ones */
export interface SessionCommit {
  sceneId: Id;
  completedAt: string;
  /** cumulative values to store on the scene */
  completions: number;
  earned: number;
  spent: number;
  /** this session alone, for the summary */
  earnedNow: number;
  spentNow: number;
  breakdown: RewardBreakdown;
}

// --- economy ------------------------------------------------------------------

export interface RewardBreakdown {
  base: number;
  quality: number;
  rewardMult: number;
  repeatFactor: number;
  streakBonus: number;
  total: number;
  /** total before the daily cap cut it down (only set when the cap applied) */
  uncapped?: number;
}

export interface Ledger {
  earned: number;
  spent: number;
  paid: number;
  balance: number;
  entries: LedgerEntry[];
}

export interface LedgerEntry {
  at: string;
  amount: number;
  kind: "earned" | "spent" | "paid";
  sceneId?: Id;
  node?: NodeKey;
}

export interface Streak {
  days: number;
  /** multiplier applied to rewards, 1 = none */
  bonus: number;
  activeToday: boolean;
}

// --- suggestions --------------------------------------------------------------

export type SuggestionKind = "continue" | "explore" | "earn";

export interface Suggestion {
  kind: SuggestionKind;
  sceneId: Id;
  node: NodeKey;
  /** coins this clip will ask for (spend prompts) */
  spendCost: number;
  /** price to open the node first (gate), 0 if none */
  price: number;
  estimatedEarn: number;
  /** short human reasons, e.g. "counts toward deepening L3 (2 of 3)" */
  reasons: string[];
}

export interface PerformerSwitch {
  performerId: Id;
  sharedTopics: string[];
  openScenes: number;
}

export interface SuggestionResult {
  options: Suggestion[];
  switches: PerformerSwitch[];
  /** performer the options were picked for (the given one, or the busiest when none was given) */
  performerId?: Id;
  /** set when the best next step is not affordable */
  blocked?: { node: NodeKey; cost: number; balance: number };
}

// --- daily series ---------------------------------------------------------------

export type SeriesState = "not-started" | "due" | "done-today" | "broken" | "finished";

/** Where a daily series stands today, derived from its parts' st.completed_at. */
export interface SeriesStatus {
  state: SeriesState;
  /** parts held in the current run (consecutive days for reset=start) */
  run: number;
  /** the part to watch next (unlocks tomorrow when done-today); none when finished */
  nextPart?: {
    sceneId: Id;
    /** scene_index in the group, if stash has one */
    index?: number;
    /** 1-based position in watch order */
    number: number;
  };
  /** due: ISO timestamp of the next day boundary, the run's deadline */
  deadline?: string;
  /** YYYY-MM-DD of the day the run was last extended */
  lastDay?: string;
}

// --- player settings (plugin settings / defaults) -----------------------------

/** Hour (local time) when a new day starts: completions before it count for the previous day. */
export const DEFAULT_DAY_START_HOUR = 4;

export interface PlaySettings {
  defaultNeed: number;
  /** seconds without mouse/keyboard before fallback attention counts as away */
  idleSec: number;
  dailyEarnCap?: number;
  /** day boundary hour 0–23 for streaks, the daily cap and daily series (default 4) */
  dayStartHour?: number;
}

export const DEFAULT_POLICY: WatchPolicy = {
  rules: ["attention"],
  attentionMin: 0.9,
  graceSec: 2,
  abortSec: 30,
  promptsMin: 0.75,
  rewardMult: 1,
};
