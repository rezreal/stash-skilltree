// Write-back. A viewing session is a transaction: only complete sessions are
// committed (plus loop exposure, which is saved on stop). Mutation arguments
// checked against stash v0.31.0 (see queries.ts).

import type { Id, SceneInput } from "../core/types.ts";
import type { StashClient } from "../stash/client.ts";
import { fieldNumber } from "../stash/fields.ts";
import { rewardFor } from "./economy.ts";
import { FIND_TAG_FIELDS, SCENE_UPDATE_FIELDS, TAG_UPDATE_PAID } from "./queries.ts";
import type { FindTagFieldsResult } from "./queries.ts";
import { dayOfIso, localDayOf } from "./series.ts";
import { sessionQuality } from "./session.ts";
import type { Ledger, SessionCommit, SessionState, Streak, WatchPolicy } from "./types.ts";

/**
 * Coins earned on the day of `nowIso` (days start at `dayStartHour`, default
 * 4) according to the ledger. Best effort: scenes store cumulative values at
 * their latest completion, so a scene repeated today counts with everything
 * it ever earned.
 */
export function earnedOnDay(ledger: Ledger, nowIso: string, dayStartHour?: number): number {
  const today = localDayOf(new Date(nowIso), dayStartHour);
  if (today === undefined) return 0;
  let n = 0;
  for (const e of ledger.entries) {
    if (e.kind !== "earned" || !e.at) continue;
    if (dayOfIso(e.at, dayStartHour) === today) n += e.amount;
  }
  return n;
}

/**
 * What a complete session writes: cumulative completions / earned / spent
 * (scene values plus this session; spent = accepted spend prompts) and the
 * reward breakdown for the summary. Throws for sessions that are not complete.
 */
export function buildCommit(
  state: SessionState,
  scene: SceneInput,
  policy: WatchPolicy,
  streak: Streak,
  ledger: Ledger,
  nowIso: string,
  opts?: { dailyCap?: number; earnedToday?: number; dayStartHour?: number },
): SessionCommit {
  if (state.phase !== "complete") throw new Error(`cannot commit a session in phase "${state.phase}"`);
  if (state.sceneId !== scene.id) throw new Error(`session is for scene ${state.sceneId}, not ${scene.id}`);
  const quality = sessionQuality(state, policy);
  const reward: Parameters<typeof rewardFor>[0] = { scene, quality, policy, streak };
  if (opts?.dailyCap !== undefined) {
    reward.dailyCap = opts.dailyCap;
    reward.earnedToday = opts.earnedToday ?? earnedOnDay(ledger, nowIso, opts.dayStartHour);
  }
  const breakdown = rewardFor(reward);
  let spentNow = 0;
  for (const s of state.spends) if (s.accepted) spentNow += s.amount;
  return {
    sceneId: scene.id,
    completedAt: nowIso,
    completions: scene.completions + 1,
    earned: scene.earned + breakdown.total,
    spent: scene.spent + spentNow,
    earnedNow: breakdown.total,
    spentNow,
    breakdown,
  };
}

/**
 * One sceneUpdate with custom_fields.partial (st.completed_at = this, the
 * latest, completion; cumulative st.completions / st.earned / st.spent).
 * No play is added: playback runs on stash's own scene player, whose
 * activity tracking already counts the play (sceneIncrementPlayCount, per
 * the user's minimumPlayPercent); a sceneAddPlay here would count it twice.
 */
export async function commitSession(client: StashClient, commit: SessionCommit): Promise<void> {
  await client.gql(SCENE_UPDATE_FIELDS, {
    input: {
      id: commit.sceneId,
      custom_fields: {
        partial: {
          "st.completed_at": commit.completedAt,
          "st.completions": commit.completions,
          "st.earned": commit.earned,
          "st.spent": commit.spent,
        },
      },
    },
  });
}

/** Stores a loop's total exposure (stored + this session), whole seconds. */
export async function saveExposure(client: StashClient, sceneId: Id, totalExposureSec: number): Promise<void> {
  const seconds = Math.max(0, Math.round(totalExposureSec));
  await client.gql(SCENE_UPDATE_FIELDS, {
    input: { id: sceneId, custom_fields: { partial: { "st.exposure_seconds": seconds } } },
  });
}

/**
 * Pays `amount` coins into a node (all its interest tags in `tagIds`).
 *
 * The node's paid value is the largest st.paid among its tags (that is how
 * the graph reads it), so this reads the tags' current st.paid, and writes
 * max + amount, cumulative, onto the first tag together with st.unlocked_at.
 * Other tags keep their (smaller or equal) values, so the node's max is the
 * new total and the ledger, which also takes the max per node, counts the
 * payment once. Returns the new st.paid.
 */
export async function payForNode(client: StashClient, tagIds: Id[], amount: number, nowIso: string): Promise<number> {
  if (tagIds.length === 0) throw new Error("payForNode: node has no tags");
  if (!(amount > 0) || !Number.isFinite(amount)) throw new Error(`payForNode: invalid amount ${amount}`);
  const res = await client.gql<FindTagFieldsResult>(FIND_TAG_FIELDS, {
    ids: tagIds,
    filter: { per_page: -1 },
  });
  let current = 0;
  for (const t of res.findTags.tags) {
    const v = fieldNumber(t.custom_fields?.["st.paid"]);
    if (v !== undefined && v > current) current = v;
  }
  const paid = current + amount;
  await client.gql(TAG_UPDATE_PAID, {
    input: { id: tagIds[0], custom_fields: { partial: { "st.paid": paid, "st.unlocked_at": nowIso } } },
  });
  return paid;
}
