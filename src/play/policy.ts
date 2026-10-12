// Watch policies: which rules a scene is watched under, from its policy tags.

import type { SceneInput } from "../core/types.ts";
import type { StashClient } from "../stash/client.ts";
import { fieldNumber, fieldString, tagKind } from "../stash/fields.ts";
import type { StashTag } from "../stash/fields.ts";
import { FIND_POLICY_TAGS, policyTagsVariables } from "./queries.ts";
import type { FindPolicyTagsResult } from "./queries.ts";
import { DEFAULT_POLICY } from "./types.ts";
import type { PolicyTagInput, RuleName, WatchPolicy } from "./types.ts";

export const RULE_NAMES: readonly RuleName[] = ["attention", "exposure", "prompts", "track"];

/** Positive finite number, else undefined. */
function positive(v: unknown): number | undefined {
  const n = fieldNumber(v);
  return n !== undefined && n > 0 ? n : undefined;
}

/**
 * Parses st.policy and the thresholds of a policy tag leniently: rule names
 * are case-insensitive and may be separated by commas, semicolons, `|` or
 * spaces; unknown names and non-positive or non-numeric thresholds are
 * ignored.
 */
export function parsePolicyTag(tag: StashTag): PolicyTagInput {
  const f = tag.custom_fields ?? {};
  const rules: RuleName[] = [];
  for (const part of (fieldString(f["st.policy"]) ?? "").toLowerCase().split(/[,;|\s]+/)) {
    const r = part as RuleName;
    if (RULE_NAMES.includes(r) && !rules.includes(r)) rules.push(r);
  }
  const out: PolicyTagInput = { id: tag.id, name: tag.name, rules };
  const minMinutes = positive(f["st.min_minutes"]);
  const trackMin = positive(f["st.track_min"]);
  const rewardMult = positive(f["st.reward_mult"]);
  if (minMinutes !== undefined) out.minMinutes = minMinutes;
  if (trackMin !== undefined) out.trackMin = trackMin;
  if (rewardMult !== undefined) out.rewardMult = rewardMult;
  return out;
}

/** Tags with st.kind=policy (server filter: st.kind is set; kind checked here). */
export async function loadPolicyTags(client: StashClient): Promise<PolicyTagInput[]> {
  const res = await client.gql<FindPolicyTagsResult>(FIND_POLICY_TAGS, policyTagsVariables());
  return res.findTags.tags.filter((t) => tagKind(t) === "policy").map(parsePolicyTag);
}

/** Whether a scene has prompt markers (any marker whose primary tag sets st.check). */
export function hasPromptMarkers(scene: SceneInput): boolean {
  return scene.markers.some((m) => m.check !== undefined);
}

/**
 * The policy a scene is watched under:
 * - rules = union over the scene's policy tags; no policy tag (or none with a
 *   valid rule) -> ["attention"];
 * - prompt markers add "prompts";
 * - "exposure" (loops) drops "attention": a loop may play in a background tab;
 * - minMinutes = max over tags; rewardMult = max over tags (default 1);
 * - other thresholds from DEFAULT_POLICY.
 */
export function policyForScene(scene: SceneInput, policyTags: PolicyTagInput[]): WatchPolicy {
  const tagIds = new Set(scene.tagIds);
  const rules = new Set<RuleName>();
  let minMinutes: number | undefined;
  let rewardMult: number | undefined;
  for (const tag of policyTags) {
    if (!tagIds.has(tag.id)) continue;
    for (const r of tag.rules) rules.add(r);
    if (tag.minMinutes !== undefined) minMinutes = Math.max(minMinutes ?? 0, tag.minMinutes);
    if (tag.rewardMult !== undefined) rewardMult = Math.max(rewardMult ?? 0, tag.rewardMult);
  }
  if (rules.size === 0) rules.add("attention");
  if (hasPromptMarkers(scene)) rules.add("prompts");
  if (rules.has("exposure")) rules.delete("attention");

  const policy: WatchPolicy = {
    ...DEFAULT_POLICY,
    rules: RULE_NAMES.filter((r) => rules.has(r)),
    rewardMult: rewardMult ?? DEFAULT_POLICY.rewardMult,
  };
  if (minMinutes !== undefined) policy.minMinutes = minMinutes;
  return policy;
}
