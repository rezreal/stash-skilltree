// The viewing session: a transaction over one clip. Plain state + pure
// reducer; time and inputs (attention, video time) are injected by the UI,
// which calls `step` with a tick about 4 times a second.
//
// Phases: ready -> playing <-> grace -> paused (by inattention) -> aborted,
// paused (by user) has no abort timer; ended -> complete | aborted.
// Nothing here writes anywhere; see commit.ts for complete sessions.

import type { SceneInput } from "../core/types.ts";
import type {
  AbortReason,
  Interval,
  PromptResult,
  QualityScores,
  SessionEvent,
  SessionState,
  WatchPolicy,
} from "./types.ts";

/** Video jumps larger than this between two ticks are seeks (no credit across). */
export const SEEK_THRESHOLD_SEC = 2;

export function createSession(input: {
  scene: SceneInput;
  policy: WatchPolicy;
  nowMs: number;
  /** st.exposure_seconds already stored on the scene (loops add up) */
  priorExposureSec?: number;
}): SessionState {
  return {
    sceneId: input.scene.id,
    policy: input.policy,
    phase: "ready",
    durationSec: input.scene.durationSec > 0 ? input.scene.durationSec : 0,
    startedAtMs: input.nowMs,
    lastNowMs: input.nowMs,
    maxVideoTime: 0,
    attended: [],
    attendedFraction: 0,
    exposureSec: 0,
    priorExposureSec: Math.max(0, input.priorExposureSec ?? 0),
    prompts: [],
    spends: [],
    pauseRequested: false,
    resumeRequested: false,
    pauseAttempts: 0,
  };
}

export function isTerminal(state: SessionState): boolean {
  return state.phase === "aborted" || state.phase === "complete";
}

// --- intervals ----------------------------------------------------------------

/** Adds [start, end) to a sorted, merged list; touching intervals merge. */
export function addInterval(list: Interval[], add: Interval): Interval[] {
  if (!(add.end > add.start)) return list;
  const out: Interval[] = [];
  let cur: Interval = { start: add.start, end: add.end };
  let placed = false;
  for (const iv of list) {
    if (iv.end < cur.start) out.push(iv);
    else if (iv.start > cur.end) {
      if (!placed) {
        out.push(cur);
        placed = true;
      }
      out.push(iv);
    } else cur = { start: Math.min(cur.start, iv.start), end: Math.max(cur.end, iv.end) };
  }
  if (!placed) out.push(cur);
  return out;
}

export function intervalsLength(list: Interval[]): number {
  let n = 0;
  for (const iv of list) n += iv.end - iv.start;
  return n;
}

/** Duration used for fractions: the scene's, else the furthest video time seen. */
export function effectiveDuration(state: SessionState): number {
  return state.durationSec > 0 ? state.durationSec : state.maxVideoTime;
}

function fraction(attended: Interval[], duration: number): number {
  if (!(duration > 0)) return 0;
  return Math.min(1, intervalsLength(attended) / duration);
}

// --- exposure -------------------------------------------------------------------

/** Exposure needed: st.min_minutes, else one full play of the clip. */
export function exposureTarget(state: SessionState): number {
  const m = state.policy.minMinutes;
  return m !== undefined && m > 0 ? m * 60 : effectiveDuration(state);
}

/** Stored plus this session's exposure, what saveExposure writes. */
export function exposureTotal(state: SessionState): number {
  return state.priorExposureSec + state.exposureSec;
}

// --- reducer --------------------------------------------------------------------

function abort(s: SessionState, reason: AbortReason, nowMs?: number): SessionState {
  const out: SessionState = { ...s, phase: "aborted", abortReason: reason };
  if (nowMs !== undefined) out.endedAtMs = nowMs;
  delete out.inattentiveSinceMs;
  delete out.pausedSinceMs;
  return out;
}

function clearPause(s: SessionState): void {
  delete s.pausedBy;
  delete s.pausedSinceMs;
  delete s.inattentiveSinceMs;
}

function tick(prev: SessionState, e: Extract<SessionEvent, { type: "tick" }>): SessionState {
  const s: SessionState = { ...prev, lastNowMs: e.nowMs };
  const hasAttention = s.policy.rules.includes("attention");
  const wallSec = Math.max(0, (e.nowMs - prev.lastNowMs) / 1000);

  // Autoplay: a playing tick before the play event starts the session.
  if (s.phase === "ready" && e.playing) s.phase = "playing";

  const last = prev.lastVideoTime;
  const t = Number.isFinite(e.videoTime) && e.videoTime >= 0 ? e.videoTime : (last ?? 0);
  s.maxVideoTime = Math.max(s.maxVideoTime, s.durationSec > 0 ? Math.min(t, s.durationSec) : t);
  s.lastVideoTime = t;
  const duration = effectiveDuration(s);

  const active = s.phase === "playing" || s.phase === "grace";

  // Attended intervals: forward span since the last tick, unless it was a seek.
  if (active && e.playing && e.attending && last !== undefined) {
    const delta = t - last;
    if (delta > 0 && delta <= SEEK_THRESHOLD_SEC) {
      const cap = s.durationSec > 0 ? s.durationSec : Infinity;
      s.attended = addInterval(s.attended, { start: Math.min(last, cap), end: Math.min(t, cap) });
    }
  }
  s.attendedFraction = fraction(s.attended, effectiveDuration(s));

  // Exposure: audible playing time. Bounded by both wall time and video
  // progress, so throttled background ticks still count and neither a
  // suspended device nor a faster playback rate inflates it. A loop that
  // wrapped around counts the wrap.
  if (active && e.playing && e.audible !== false && last !== undefined) {
    let advance = t - last;
    if (advance < 0) advance = duration > 0 ? Math.max(0, duration - last) + t : t;
    s.exposureSec = prev.exposureSec + Math.min(wallSec, advance);
  }

  if (!hasAttention) {
    if (s.phase === "grace") s.phase = "playing";
    return s;
  }

  // Attention rule: grace -> pause -> abort.
  if (active) {
    if (e.playing && !e.attending) {
      const since = prev.inattentiveSinceMs ?? e.nowMs;
      s.inattentiveSinceMs = since;
      if (e.nowMs - since > s.policy.graceSec * 1000) {
        s.phase = "paused";
        s.pausedBy = "inattention";
        s.pausedSinceMs = e.nowMs;
        s.pauseRequested = true;
        delete s.inattentiveSinceMs;
      } else s.phase = "grace";
    } else {
      // attending, or the video is not playing (buffering): no inattention
      delete s.inattentiveSinceMs;
      s.phase = "playing";
    }
  } else if (s.phase === "paused" && s.pausedBy === "inattention") {
    if (e.attending) {
      clearPause(s);
      s.phase = "playing";
      s.resumeRequested = true;
    } else if (e.nowMs - (s.pausedSinceMs ?? e.nowMs) > s.policy.abortSec * 1000) {
      return abort(s, "inattention-timeout", e.nowMs);
    }
  }
  return s;
}

/** Rule check at the end of the clip; undefined = passed. */
export function evaluateRules(state: SessionState): AbortReason | undefined {
  const p = state.policy;
  if (p.rules.includes("attention") && state.attendedFraction < p.attentionMin) return "attention-below-threshold";
  if (p.rules.includes("prompts") && state.prompts.length > 0) {
    const passed = state.prompts.filter((r) => r.passed).length;
    if (passed / state.prompts.length < p.promptsMin) return "prompts-below-threshold";
  }
  if (p.rules.includes("exposure") && exposureTotal(state) < exposureTarget(state)) return "exposure-below-minimum";
  return undefined;
}

function upsertPrompt(list: PromptResult[], r: PromptResult): PromptResult[] {
  const out = list.filter((x) => x.markerId !== r.markerId);
  out.push(r);
  return out;
}

/**
 * Advances the session. Terminal phases (aborted, complete) ignore every
 * event. pauseRequested / resumeRequested are one-shot flags, cleared at the
 * start of each step.
 */
export function step(state: SessionState, event: SessionEvent): SessionState {
  const s: SessionState = { ...state, pauseRequested: false, resumeRequested: false };
  if (isTerminal(s)) return s;
  switch (event.type) {
    case "play":
      if (event.nowMs !== undefined) s.lastNowMs = event.nowMs;
      clearPause(s);
      s.phase = "playing";
      return s;
    case "pauseByUser":
      if (event.nowMs !== undefined) s.lastNowMs = event.nowMs;
      if (!s.policy.allowUserPause) {
        // not allowed: undo it; only Stop ends a clip early
        s.pauseAttempts += 1;
        s.resumeRequested = true;
        return s;
      }
      clearPause(s);
      s.phase = "paused";
      s.pausedBy = "user";
      return s;
    case "tick":
      return tick(s, event);
    case "prompt":
      s.prompts = upsertPrompt(s.prompts, event.result);
      return s;
    case "spend":
      s.spends = [...s.spends, event.event];
      return event.event.accepted ? s : abort(s, "spend-declined");
    case "abort":
      return abort(s, event.reason, event.nowMs);
    case "ended": {
      s.lastNowMs = event.nowMs;
      const failed = evaluateRules(s);
      if (failed) return abort(s, failed, event.nowMs);
      clearPause(s);
      s.phase = "complete";
      s.endedAtMs = event.nowMs;
      return s;
    }
  }
}

// --- quality ----------------------------------------------------------------------

/**
 * Attention score from the attended fraction f and the threshold m:
 * f = m -> 0.5, f = 1 -> 1.0, linear in between (below m: 0.5 * f / m, which
 * only shows up in live previews since such sessions abort). The threshold
 * itself is a pass, the second half of the range rewards watching the rest.
 */
export function attentionScore(f: number, m: number): number {
  const x = Math.max(0, Math.min(1, f));
  if (m >= 1) return x >= 1 ? 1 : 0.5 * x;
  if (m <= 0) return 0.5 + 0.5 * x;
  if (x >= m) return 0.5 + (0.5 * (x - m)) / (1 - m);
  return (0.5 * x) / m;
}

/**
 * Per-rule scores, usable live. attention: attentionScore; prompts: share of
 * reported prompt results that passed (prompts the UI cannot check yet are
 * not reported and so not scored); exposure: min(1, total / target). track is
 * not scored yet (phase 5).
 */
export function qualityScores(state: SessionState, policy: WatchPolicy = state.policy): QualityScores {
  const out: QualityScores = {};
  if (policy.rules.includes("attention")) out.attention = attentionScore(state.attendedFraction, policy.attentionMin);
  if (policy.rules.includes("prompts") && state.prompts.length > 0) {
    out.prompts = state.prompts.filter((r) => r.passed).length / state.prompts.length;
  }
  if (policy.rules.includes("exposure")) {
    const m = policy.minMinutes;
    const target = m !== undefined && m > 0 ? m * 60 : effectiveDuration(state);
    out.exposure = target > 0 ? Math.min(1, exposureTotal(state) / target) : 1;
  }
  return out;
}

/** Mean of the scored rules (1 if none is scored); 0 unless the session is complete. */
export function sessionQuality(state: SessionState, policy: WatchPolicy = state.policy): number {
  if (state.phase !== "complete") return 0;
  const scores = Object.values(qualityScores(state, policy)).filter((v): v is number => typeof v === "number");
  if (scores.length === 0) return 1;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}
