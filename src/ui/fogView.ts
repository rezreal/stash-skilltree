// What the tree shows, as pure data: which nodes are drawn and how they are
// labelled, which edges and topic labels appear, the header counts, the
// node panel texts and the player's depth rows. The author view shows
// everything; the fog view (the player's) follows these rules:
//
// - hidden nodes are not drawn, and nothing points towards them: edges and
//   OR junctions are built from drawn nodes only;
// - "ahead" nodes are anonymous "?" discs: no topic, no level; their unlock
//   condition is phrased with nodes the player already sees;
// - "gate" nodes show their price, and their topic and level only once the
//   player has an open or complete node in that topic;
// - a topic is "known" once it has an open or complete node; only known
//   topics get labels or are named anywhere;
// - header counts never reveal totals of the hidden graph.
//
// No React here so it runs under `node --test`.
import type { Graph, GraphNode, Layout, NodeKey, NodeProgress, NodeState, Progress, Visibility } from "../core/types.ts";
import { topicLabel } from "../play/suggest.ts";
import { gateCost, nodeAriaLabel, plural, progressText } from "./derive.ts";
import { buildEdges, positions, startEdges, type EdgeSegment, type Junction } from "./geometry.ts";

export type NodeLook = NodeState | "ahead" | "gate";

export interface ViewNode {
  key: NodeKey;
  look: NodeLook;
  /** text inside the disc: progress, "?" or the price */
  text: string;
  /** small label under the disc ("L2"); empty when the level is secret */
  sublabel: string;
  /** tooltip */
  title: string;
  /** accessible name */
  aria: string;
}

export interface TopicLabel {
  topic: string;
  text: string;
  /** the topic's lowest drawn level, the label sits next to it */
  anchor: NodeKey;
}

export interface TreeView {
  /** drawn nodes, sorted by key */
  nodes: ViewNode[];
  drawn: Set<NodeKey>;
  /** topics that may be named */
  knownTopics: Set<string>;
  topicLabels: TopicLabel[];
}

const stateOf = (progress: Progress, key: NodeKey): NodeState => progress.get(key)?.state ?? "locked";

/** topics with at least one open or complete node */
export function knownTopics(graph: Graph, progress: Progress): Set<string> {
  const out = new Set<string>();
  for (const n of graph.nodes.values()) if (stateOf(progress, n.key) !== "locked") out.add(n.topic);
  return out;
}

/** "Relaxation L1" (fog view) */
export function nodeName(node: Pick<GraphNode, "topic" | "level">): string {
  return `${topicLabel(node.topic)} L${node.level}`;
}

export function treeView(
  graph: Graph,
  progress: Progress,
  visibility: Map<NodeKey, Visibility>,
  authorView: boolean,
): TreeView {
  const known = authorView ? new Set(graph.topics) : knownTopics(graph, progress);
  const nodes: ViewNode[] = [];
  const drawn = new Set<NodeKey>();
  const keys = [...graph.nodes.keys()].sort();
  for (const key of keys) {
    const node = graph.nodes.get(key)!;
    const p = progress.get(key);
    const vis = authorView ? "shown" : (visibility.get(key) ?? "hidden");
    if (vis === "hidden") continue;
    drawn.add(key);
    nodes.push(authorView ? authorNode(node, p) : fogNode(node, p, vis, known.has(node.topic), progress));
  }

  const topicLabels: TopicLabel[] = [];
  for (const topic of graph.topics) {
    if (!known.has(topic)) continue;
    let anchor: GraphNode | undefined;
    for (const key of drawn) {
      const n = graph.nodes.get(key)!;
      if (n.topic !== topic) continue;
      // fog: only open/complete nodes anchor a label (a gate in a known topic
      // is fine to name, but the label belongs to where the player has been)
      if (!authorView && stateOf(progress, key) === "locked") continue;
      if (!anchor || n.level < anchor.level) anchor = n;
    }
    if (anchor) topicLabels.push({ topic, text: authorView ? topic : topicLabel(topic), anchor: anchor.key });
  }
  return { nodes, drawn, knownTopics: known, topicLabels };
}

function authorNode(node: GraphNode, p: NodeProgress | undefined): ViewNode {
  return {
    key: node.key,
    look: p?.state ?? "locked",
    text: progressText(p),
    sublabel: `L${node.level}`,
    title: `${node.topic} L${node.level}`,
    aria: nodeAriaLabel(node, p, undefined, 0),
  };
}

function fogNode(
  node: GraphNode,
  p: NodeProgress | undefined,
  vis: Visibility,
  topicKnown: boolean,
  progress: Progress,
): ViewNode {
  if (vis === "ahead") {
    return { key: node.key, look: "ahead", text: "?", sublabel: "", title: "Unknown level", aria: "Unknown level, not yet open" };
  }
  if (vis === "gate") {
    const cost = gateCost(node, progress);
    const name = topicKnown ? nodeName(node) : "Unknown level";
    return {
      key: node.key,
      look: "gate",
      text: `$${cost}`,
      sublabel: topicKnown ? `L${node.level}` : "",
      title: name,
      aria: `${name}, can be opened for ${cost} coins`,
    };
  }
  const name = nodeName(node);
  return {
    key: node.key,
    look: p?.state ?? "locked",
    text: progressText(p),
    sublabel: `L${node.level}`,
    title: name,
    aria: p ? `${name}, ${p.state}, ${p.completed} of ${p.need} scenes completed` : name,
  };
}

// --- edges -------------------------------------------------------------------------

export interface TreeEdges {
  segments: EdgeSegment[];
  junctions: Junction[];
  /** START → drawn entry nodes */
  start: EdgeSegment[];
}

/** Edges between drawn nodes only (hidden alternatives leave no trace). */
export function treeEdges(graph: Graph, layout: Layout, drawn: Set<NodeKey>): TreeEdges {
  const pos = positions(layout, (k) => drawn.has(k));
  const nodes = [...graph.nodes.values()].filter((n) => drawn.has(n.key));
  const { segments, junctions } = buildEdges(nodes, pos);
  return { segments, junctions, start: startEdges(layout.entries, pos) };
}

// --- header ------------------------------------------------------------------------

export interface FogStats {
  /** complete nodes */
  reached: number;
  /** open nodes */
  open: number;
  /** topics with an open or complete node */
  topics: number;
}

export function fogStats(graph: Graph, progress: Progress): FogStats {
  let reached = 0;
  let open = 0;
  for (const key of graph.nodes.keys()) {
    const s = stateOf(progress, key);
    if (s === "complete") reached++;
    else if (s === "open") open++;
  }
  return { reached, open, topics: knownTopics(graph, progress).size };
}

// --- texts -------------------------------------------------------------------------

const levelKey = (topic: string, level: number): NodeKey => `${topic}:${level}`;

/**
 * What still has to happen before a locked node opens, phrased only with
 * nodes the player can see (open ones) and prices:
 * "Opens after 3 more scenes in Relaxation L1 and paying $50".
 * Alternatives the player cannot see are left out.
 */
export function unlockText(graph: Graph, progress: Progress, node: GraphNode): string {
  const parts: string[] = [];
  for (const group of node.requires) {
    const satisfied = group.some((alt) =>
      alt.kind === "level" ? stateOf(progress, levelKey(alt.topic, alt.level)) === "complete" : node.paid >= alt.amount,
    );
    if (satisfied) continue;
    const alts: string[] = [];
    for (const alt of group) {
      if (alt.kind === "cost") {
        alts.push(`paying $${alt.amount - node.paid}`);
        continue;
      }
      const key = levelKey(alt.topic, alt.level);
      const p = progress.get(key);
      const target = graph.nodes.get(key);
      if (!target || p?.state !== "open") continue;
      const left = Math.max(1, p.need - p.completed);
      alts.push(`${plural(left, "more scene")} in ${nodeName(target)}`);
    }
    parts.push(alts.length > 0 ? dedupe(alts).join(" or ") : "something still in the fog");
  }
  return parts.length > 0 ? `Opens after ${dedupe(parts).join(" and ")}` : "Opens soon";
}

/**
 * Requirement lines for an open or complete node in the fog view: every
 * group with the alternatives the player can see (open or complete nodes,
 * prices); done ones get a check mark.
 */
export function shownRequirementLines(graph: Graph, progress: Progress, node: GraphNode): string[] {
  const lines: string[] = [];
  for (const group of node.requires) {
    const alts: string[] = [];
    for (const alt of group) {
      if (alt.kind === "cost") {
        alts.push(node.paid >= alt.amount ? `$${alt.amount} ✓` : `$${alt.amount}`);
        continue;
      }
      const key = levelKey(alt.topic, alt.level);
      const target = graph.nodes.get(key);
      const s = stateOf(progress, key);
      if (!target || s === "locked") continue;
      alts.push(s === "complete" ? `${nodeName(target)} ✓` : nodeName(target));
    }
    if (alts.length > 0) lines.push(dedupe(alts).join(" or "));
  }
  return dedupe(lines);
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

export interface FogPanel {
  title: string;
  subtitle: string;
  look: NodeLook;
  stateText: string;
  /** "1 of 3 scenes", only for open and complete nodes */
  progress?: string;
  /** requirement lines (open and complete nodes) */
  requires: string[];
  /** unlock condition (ahead and gate nodes) */
  unlock?: string;
  /** price that opens a gate now */
  price?: number;
  /** scenes stay hidden */
  secret: boolean;
}

/** Node panel contents in the fog view; undefined for hidden nodes. */
export function fogPanel(
  graph: Graph,
  progress: Progress,
  visibility: Map<NodeKey, Visibility>,
  key: NodeKey,
): FogPanel | undefined {
  const node = graph.nodes.get(key);
  const vis = visibility.get(key) ?? "hidden";
  if (!node || vis === "hidden") return undefined;
  if (vis === "ahead") {
    return {
      title: "Unknown level",
      subtitle: "",
      look: "ahead",
      stateText: "ahead",
      requires: [],
      unlock: unlockText(graph, progress, node),
      secret: true,
    };
  }
  if (vis === "gate") {
    const known = knownTopics(graph, progress).has(node.topic);
    return {
      title: known ? topicLabel(node.topic) : "Unknown level",
      subtitle: known ? `level ${node.level}` : "",
      look: "gate",
      stateText: "can be bought",
      requires: [],
      unlock: unlockText(graph, progress, node),
      price: gateCost(node, progress),
      secret: true,
    };
  }
  const p = progress.get(key);
  const state = p?.state ?? "locked";
  const requires = shownRequirementLines(graph, progress, node);
  return {
    title: topicLabel(node.topic),
    subtitle: `level ${node.level}`,
    look: state,
    stateText: state,
    progress: p ? `${p.completed} of ${p.need} scenes` : undefined,
    requires: requires.length > 0 ? requires : ["nothing (entry)"],
    secret: false,
  };
}

// --- the player's depth sidebar ------------------------------------------------------

export interface DepthSegment {
  key: NodeKey;
  state: NodeState;
}

export interface FogDepthRow {
  topic: string;
  depth: number;
  segments: DepthSegment[];
}

/**
 * One row per known topic (an open or complete node), in topic order.
 * Segments run up to the deepest open/complete level plus the next level if
 * the fog shows it (ahead or gate), never further, so the sidebar does not
 * reveal how deep a topic goes.
 */
export function fogDepthRows(
  graph: Graph,
  progress: Progress,
  visibility: Map<NodeKey, Visibility>,
  depthOf: (topic: string) => number,
): FogDepthRow[] {
  const byTopic = new Map<string, GraphNode[]>();
  for (const n of graph.nodes.values()) {
    const list = byTopic.get(n.topic) ?? [];
    list.push(n);
    byTopic.set(n.topic, list);
  }
  const rows: FogDepthRow[] = [];
  for (const topic of graph.topics) {
    const nodes = (byTopic.get(topic) ?? []).sort((a, b) => a.level - b.level);
    let reached = -1;
    for (const n of nodes) if (stateOf(progress, n.key) !== "locked") reached = Math.max(reached, n.level);
    if (reached < 0) continue;
    const segments: DepthSegment[] = [];
    for (const n of nodes) {
      if (n.level > reached + 1) break;
      const vis = visibility.get(n.key) ?? "hidden";
      if (vis === "hidden") continue;
      segments.push({ key: n.key, state: stateOf(progress, n.key) });
    }
    rows.push({ topic, depth: depthOf(topic), segments });
  }
  return rows;
}
