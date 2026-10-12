// Pure view-model helpers for the author view (no React, no core runtime),
// so they can be tested under `node --test`.
import type {
  Graph,
  GraphNode,
  Id,
  LintIssue,
  NodeKey,
  NodeProgress,
  PerformerInput,
  Progress,
  SceneInput,
  Severity,
  Visibility,
} from "../core/types.ts";

export const SEVERITIES: Severity[] = ["error", "warning", "info"];

/** scenes that count for at least one node */
export function scenesInTree(graph: Graph): number {
  let n = 0;
  for (const keys of graph.sceneNodes.values()) if (keys.length > 0) n++;
  return n;
}

/** performers appearing in at least one scene of the tree, by name */
export function performerOptions(graph: Graph): PerformerInput[] {
  const ids = new Set<Id>();
  for (const [sceneId, keys] of graph.sceneNodes) {
    if (keys.length === 0) continue;
    for (const p of graph.scenes.get(sceneId)?.performerIds ?? []) ids.add(p);
  }
  return [...ids]
    .map((id) => graph.performers.get(id) ?? { id, name: id })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function countBySeverity(issues: LintIssue[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.severity]++;
  return counts;
}

/**
 * Coins still to pay to open a gate node. Core checks every price against
 * the node's total st.paid (paid >= amount), so the amount needed is the
 * largest of the cheapest prices of the unmet groups, minus what was paid.
 */
export function gateCost(node: GraphNode, progress: Progress): number {
  let needed = 0;
  for (const group of node.requires) {
    const met = group.some((alt) =>
      alt.kind === "level"
        ? progress.get(`${alt.topic}:${alt.level}`)?.state === "complete"
        : node.paid >= alt.amount,
    );
    if (met) continue;
    let min = Infinity;
    for (const alt of group) if (alt.kind === "cost") min = Math.min(min, alt.amount);
    if (min !== Infinity) needed = Math.max(needed, min);
  }
  return Math.max(0, needed - node.paid);
}

/** same rule as core's progress: a scene counts once it has st.completed_at */
export function sceneDone(scene: SceneInput): boolean {
  return Boolean(scene.completedAt);
}

/** a node's scenes, optionally only those with a performer, oldest first */
export function nodeScenes(graph: Graph, node: GraphNode, performerId?: Id): SceneInput[] {
  const scenes: SceneInput[] = [];
  for (const id of node.sceneIds) {
    const s = graph.scenes.get(id);
    if (s && (!performerId || s.performerIds.includes(performerId))) scenes.push(s);
  }
  return scenes.sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.title.localeCompare(b.title));
}

export function performerNames(graph: Graph, ids: Id[]): string {
  return ids.map((id) => graph.performers.get(id)?.name ?? id).join(", ");
}

export function progressText(p: NodeProgress | undefined): string {
  return p ? `${p.completed}/${p.need}` : "–";
}

/** "1 more scene", "3 more scenes" */
export function plural(n: number, singular: string, pluralForm = singular + "s"): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/**
 * Accessible name of a tree node. Ahead nodes are always anonymous; gate
 * nodes are named only when `named` (their topic is known to the player).
 */
export function nodeAriaLabel(
  node: GraphNode,
  p: NodeProgress | undefined,
  vis: Visibility | undefined,
  cost: number,
  named = true,
): string {
  const where = `${node.topic} level ${node.level}`;
  if (vis === "ahead") return "Unknown level, not yet open";
  if (vis === "gate") return `${named ? where : "Unknown level"}, can be opened for ${cost} coins`;
  if (!p) return where;
  return `${where}, ${p.state}, ${p.completed} of ${p.need} scenes completed`;
}

export interface TopicCell {
  key: NodeKey;
  scenes: number;
  progress?: NodeProgress;
}

export interface TopicRow {
  topic: string;
  depth: number;
  cells: (TopicCell | undefined)[];
}

/** one row per topic, one column per level 0..maxLevel */
export function topicRows(
  graph: Graph,
  progress: Progress,
  depthOf: (topic: string) => number,
): { maxLevel: number; rows: TopicRow[] } {
  let maxLevel = 0;
  for (const n of graph.nodes.values()) maxLevel = Math.max(maxLevel, n.level);
  const rows = graph.topics.map((topic) => {
    const cells: (TopicCell | undefined)[] = [];
    for (let level = 0; level <= maxLevel; level++) {
      const key = `${topic}:${level}`;
      const node = graph.nodes.get(key);
      cells.push(node ? { key, scenes: node.sceneIds.length, progress: progress.get(key) } : undefined);
    }
    return { topic, depth: depthOf(topic), cells };
  });
  return { maxLevel, rows };
}
