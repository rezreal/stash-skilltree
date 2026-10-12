// Fog of war: which nodes the player gets to see.

import type { Graph, NodeKey, Progress, Visibility } from "./types.ts";
import { groupSatisfied, requirementMet } from "./progress.ts";
import type { CompletePredicate } from "./progress.ts";

/**
 * complete/open -> "shown".
 * Locked:
 * - "gate": every unmet group contains a cost alternative, i.e. paying now
 *   would open it (groups without a cost are all met already).
 * - "ahead": would open if every currently open node completed. No new
 *   payment is assumed; amounts already paid (st.paid) still count.
 * - otherwise "hidden".
 */
export function computeVisibility(graph: Graph, progress: Progress): Map<NodeKey, Visibility> {
  const isComplete: CompletePredicate = (k) => progress.get(k)?.state === "complete";
  const wouldBeComplete: CompletePredicate = (k) => {
    const s = progress.get(k)?.state;
    return s === "complete" || s === "open";
  };
  const out = new Map<NodeKey, Visibility>();
  for (const node of graph.nodes.values()) {
    const state = progress.get(node.key)?.state ?? "locked";
    if (state !== "locked") {
      out.set(node.key, "shown");
      continue;
    }
    const unmet = node.requires.filter((g) => !groupSatisfied(g, node.paid, isComplete));
    const gate = unmet.length > 0 && unmet.every((g) => g.some((alt) => alt.kind === "cost"));
    if (gate) out.set(node.key, "gate");
    else if (requirementMet(node.requires, node.paid, wouldBeComplete)) out.set(node.key, "ahead");
    else out.set(node.key, "hidden");
  }
  return out;
}

/** Whether a visibility value means the node is drawn in the fog view. */
export function isVisible(v: Visibility | undefined): boolean {
  return v === "shown" || v === "ahead" || v === "gate";
}
