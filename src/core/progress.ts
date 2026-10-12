// Node states (locked / open / complete) from completed scenes.

import type { Alternative, Graph, Id, NodeKey, NodeProgress, NodeState, Progress, Requirement } from "./types.ts";
import { nodeKey, normalizeTopic } from "./requirements.ts";
import { compareNodeKeys } from "./graph.ts";

/** Answers "is this node complete?"; unknown keys must return false. */
export type CompletePredicate = (key: NodeKey) => boolean;

/**
 * A level alternative is satisfied when its node is complete; a cost
 * alternative when the node being evaluated has paid at least the amount.
 */
export function alternativeSatisfied(alt: Alternative, paid: number, isComplete: CompletePredicate): boolean {
  if (alt.kind === "cost") return paid >= alt.amount;
  return isComplete(nodeKey(alt.topic, alt.level));
}

export function groupSatisfied(group: Alternative[], paid: number, isComplete: CompletePredicate): boolean {
  return group.some((alt) => alternativeSatisfied(alt, paid, isComplete));
}

export function requirementMet(req: Requirement, paid: number, isComplete: CompletePredicate): boolean {
  return req.every((g) => groupSatisfied(g, paid, isComplete));
}

function completedCount(graph: Graph, sceneIds: Id[], performerId?: Id): number {
  let n = 0;
  for (const id of sceneIds) {
    const s = graph.scenes.get(id);
    if (!s || !s.completedAt) continue;
    if (performerId !== undefined && !s.performerIds.includes(performerId)) continue;
    n++;
  }
  return n;
}

/**
 * States are global (all scenes). With a performerId only `completed` is
 * restricted to that performer's scenes. Requirement cycles that cannot be
 * entered from outside stay locked.
 */
export function computeProgress(graph: Graph, opts?: { performerId?: Id }): Progress {
  const keys = [...graph.nodes.keys()].sort(compareNodeKeys);
  const globalCompleted = new Map<NodeKey, number>();
  const state = new Map<NodeKey, NodeState>();
  for (const k of keys) {
    const node = graph.nodes.get(k)!;
    globalCompleted.set(k, completedCount(graph, node.sceneIds));
    state.set(k, "locked");
  }
  const isComplete: CompletePredicate = (k) => state.get(k) === "complete";

  // Monotone fixpoint: nodes only move out of "locked", and a node's
  // open/complete decision is final because completion counts are fixed.
  let changed = true;
  while (changed) {
    changed = false;
    for (const k of keys) {
      if (state.get(k) !== "locked") continue;
      const node = graph.nodes.get(k)!;
      if (!requirementMet(node.requires, node.paid, isComplete)) continue;
      state.set(k, globalCompleted.get(k)! >= node.need ? "complete" : "open");
      changed = true;
    }
  }

  const progress: Progress = new Map();
  for (const k of keys) {
    const node = graph.nodes.get(k)!;
    const completed =
      opts?.performerId !== undefined ? completedCount(graph, node.sceneIds, opts.performerId) : globalCompleted.get(k)!;
    const p: NodeProgress = { state: state.get(k)!, completed, need: node.need };
    progress.set(k, p);
  }
  return progress;
}

export function performerHasScenes(graph: Graph, key: NodeKey, performerId: Id): boolean {
  const node = graph.nodes.get(key);
  if (!node) return false;
  return node.sceneIds.some((id) => graph.scenes.get(id)?.performerIds.includes(performerId) ?? false);
}

/** Number of consecutive complete levels of a topic, starting at level 0. */
export function topicDepth(graph: Graph, progress: Progress, topic: string): number {
  const t = normalizeTopic(topic);
  let depth = 0;
  while (graph.nodes.has(nodeKey(t, depth)) && progress.get(nodeKey(t, depth))?.state === "complete") depth++;
  return depth;
}
