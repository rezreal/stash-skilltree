// Coins: ledger, streak and rewards, all derived from what is stored on scenes
// (st.earned, st.spent, st.completed_at, st.completions) and interest tags
// (st.paid). Nothing here is stored twice.

import type { LibraryInput, SceneInput } from "../core/types.ts";
import { nodeKey, normalizeTopic, parseSpendAmount } from "../core/index.ts";
import { dayOfIso, localDayOf } from "./series.ts";
import type { Ledger, LedgerEntry, RewardBreakdown, Streak, WatchPolicy } from "./types.ts";

// --- ledger -----------------------------------------------------------------------

/**
 * Totals and entries.
 * - earned / spent: Σ over scenes (cumulative per scene).
 * - paid: Σ over nodes of the largest st.paid among the node's tags. That is
 *   what the graph counts as paid for the node, and payForNode keeps it in
 *   that form (it writes the new cumulative value onto one tag), so a node
 *   tagged by several tags is never counted twice.
 * - entries: one "earned" and one "spent" entry per scene with completedAt,
 *   dated at its latest completion (scenes keep only cumulative values, so
 *   earlier completions fold into the latest one), and one "paid" entry per
 *   paid node with `at: ""` because tags carry no reliable payment time
 *   (st.unlocked_at is not loaded into the library input). Entries are sorted
 *   by `at` ascending, so undated entries come first.
 */
export function computeLedger(library: LibraryInput): Ledger {
  let earned = 0;
  let spent = 0;
  const entries: LedgerEntry[] = [];
  for (const s of library.scenes) {
    earned += s.earned;
    spent += s.spent;
    if (!s.completedAt) continue;
    if (s.earned > 0) entries.push({ at: s.completedAt, amount: s.earned, kind: "earned", sceneId: s.id });
    if (s.spent > 0) entries.push({ at: s.completedAt, amount: s.spent, kind: "spent", sceneId: s.id });
  }
  const paidByNode = new Map<string, number>();
  const seenTags = new Set<string>();
  for (const t of library.interestTags) {
    if (seenTags.has(t.id)) continue;
    seenTags.add(t.id);
    if (!(typeof t.paid === "number" && Number.isFinite(t.paid) && t.paid > 0)) continue;
    const topic = normalizeTopic(t.topic);
    if (topic === "" || !Number.isInteger(t.level) || t.level < 0) continue;
    const key = nodeKey(topic, t.level);
    paidByNode.set(key, Math.max(paidByNode.get(key) ?? 0, t.paid));
  }
  let paid = 0;
  for (const [node, amount] of paidByNode) {
    paid += amount;
    entries.push({ at: "", amount, kind: "paid", node });
  }
  entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return { earned, spent, paid, balance: earned - spent - paid, entries };
}

// --- dates ------------------------------------------------------------------------

/** Local calendar day number (days since epoch in local time); undefined if invalid. */
export function localDay(d: Date): number | undefined {
  const t = d.getTime();
  if (!Number.isFinite(t)) return undefined;
  // Date.UTC of the local Y/M/D gives a DST-free day count.
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

// --- streak ------------------------------------------------------------------------

/** 1 below 3 days, then +0.1 every two days: 3–4 -> 1.1, 5–6 -> 1.2, 7+ -> 1.3. */
export function streakBonus(days: number): number {
  if (days < 3) return 1;
  return 1 + Math.min(3, Math.floor((days - 1) / 2)) / 10;
}

/**
 * Consecutive days with at least one completion, ending today or yesterday.
 * Days start at `dayStartHour` local time (default 4, see localDayOf), so a
 * late session counts for the evening it began in. `restDays` (default 0) is
 * how many empty days may sit between two active days (and between the last
 * active day and yesterday) without breaking the streak; rest days are not
 * counted.
 *
 * Only each scene's latest completion is stored, so a repeat moves that
 * scene's day forward; the streak is a best-effort lower bound.
 */
export function computeStreak(
  library: LibraryInput,
  now: Date,
  opts?: { restDays?: number; dayStartHour?: number },
): Streak {
  const rest = Math.max(0, Math.floor(opts?.restDays ?? 0));
  const h = opts?.dayStartHour;
  const today = localDayOf(now, h);
  if (today === undefined) return { days: 0, bonus: 1, activeToday: false };
  const days = new Set<number>();
  for (const s of library.scenes) {
    const d = dayOfIso(s.completedAt, h);
    if (d !== undefined && d <= today) days.add(d);
  }
  const sorted = [...days].sort((a, b) => b - a);
  const activeToday = days.has(today);
  let count = 0;
  if (sorted.length > 0 && today - sorted[0] <= 1 + rest) {
    count = 1;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i - 1] - sorted[i] - 1 > rest) break;
      count++;
    }
  }
  return { days: count, bonus: streakBonus(count), activeToday };
}

// --- rewards -----------------------------------------------------------------------

/** Base coins: one per minute of the clip, at least 1. */
export function baseReward(scene: SceneInput): number {
  return Math.max(1, Math.round(scene.durationSec / 60));
}

/** ×0.5 per earlier completion, never below 0.1. */
export function repeatFactor(completions: number): number {
  return Math.max(0.1, Math.pow(0.5, Math.max(0, completions)));
}

/**
 * total = round(base × quality × rewardMult × repeatFactor × streakBonus),
 * then cut to what is left of the daily cap (dailyCap − earnedToday, ≥ 0).
 */
export function rewardFor(input: {
  scene: SceneInput;
  quality: number;
  policy: WatchPolicy;
  streak: Streak;
  earnedToday?: number;
  dailyCap?: number;
}): RewardBreakdown {
  const base = baseReward(input.scene);
  const quality = Math.max(0, Math.min(1, input.quality));
  const rewardMult = input.policy.rewardMult > 0 ? input.policy.rewardMult : 1;
  const rf = repeatFactor(input.scene.completions);
  const bonus = input.streak.bonus > 0 ? input.streak.bonus : 1;
  const raw = Math.round(base * quality * rewardMult * rf * bonus);
  const out: RewardBreakdown = { base, quality, rewardMult, repeatFactor: rf, streakBonus: bonus, total: raw };
  if (input.dailyCap !== undefined && input.dailyCap >= 0) {
    const left = Math.max(0, input.dailyCap - Math.max(0, input.earnedToday ?? 0));
    if (raw > left) {
      out.total = Math.floor(left);
      out.uncapped = raw;
    }
  }
  return out;
}

export function estimateEarn(scene: SceneInput, policy: WatchPolicy, streak: Streak, assumedQuality = 0.8): number {
  return rewardFor({ scene, quality: assumedQuality, policy, streak }).total;
}

/** Coins the clip's spend prompts ask for (Σ of their amounts). */
export function spendCost(scene: SceneInput): number {
  let n = 0;
  for (const m of scene.markers) {
    if (m.check !== "spend") continue;
    n += parseSpendAmount(m.title) ?? 0;
  }
  return n;
}

/** Prompt markers the user has to follow (spend prompts excluded). */
export function promptCount(scene: SceneInput): number {
  return scene.markers.filter((m) => m.check !== undefined && m.check !== "spend").length;
}

/**
 * How much the clip asks of the user: 1 + 1 per prompt + 3 if interactive
 * (funscript / track rule) + 1 per 10 minutes. Ranks "earn" suggestions.
 */
export function effortScore(scene: SceneInput, policy: WatchPolicy): number {
  const track = scene.interactive || policy.rules.includes("track") ? 3 : 0;
  return 1 + promptCount(scene) + track + Math.max(0, scene.durationSec) / 600;
}
