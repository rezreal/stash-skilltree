// Pure geometry for the radial tree: ring radii, node placement with
// collision spreading, edge segments (with OR-group junctions) and fog stubs.
// No React here so it runs under `node --test`.
import type { GraphNode, Layout, NodeKey, Requirement } from "../core/types.ts";

export interface Point {
  x: number;
  y: number;
}

export interface Dims {
  /** radius of ring 0 */
  inner: number;
  /** distance between rings */
  gap: number;
  /** node circle radius */
  node: number;
}

export const DEFAULT_DIMS: Dims = { inner: 56, gap: 72, node: 19 };

/**
 * Dims for a layout: ring 0 grows when many entry nodes share it, so they
 * fit side by side without the collision spreading wrapping around.
 */
export function dimsFor(layout: Layout, base: Dims = DEFAULT_DIMS): Dims {
  let entries = 0;
  for (const n of layout.nodes.values()) if (n.ring === 0) entries++;
  const needed = (entries * base.node * 2.5) / (2 * Math.PI);
  return { ...base, inner: Math.max(base.inner, Math.ceil(needed)) };
}

export function ringRadius(ring: number, dims: Dims = DEFAULT_DIMS): number {
  return dims.inner + ring * dims.gap;
}

/** angle in degrees, 0 = right, clockwise (SVG y grows downwards) */
export function polar(radius: number, angleDeg: number): Point {
  const a = (angleDeg * Math.PI) / 180;
  return { x: round(radius * Math.cos(a)), y: round(radius * Math.sin(a)) };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface PlacedNode extends Point {
  key: NodeKey;
  ring: number;
  /** final angle after collision spreading */
  angle: number;
}

/**
 * Places every layout node at (ring, angle). Nodes on the same ring closer
 * than two node diameters along the arc are spread symmetrically around their
 * mean angle, ordered by topic order so the result is stable.
 */
export function placeNodes(
  layout: Layout,
  topicOf: (key: NodeKey) => string,
  topics: string[],
  dims: Dims = DEFAULT_DIMS,
): Map<NodeKey, PlacedNode> {
  const byRing = new Map<number, { key: NodeKey; angle: number }[]>();
  for (const n of layout.nodes.values()) {
    const list = byRing.get(n.ring) ?? [];
    list.push({ key: n.key, angle: n.angle });
    byRing.set(n.ring, list);
  }
  const topicIndex = (key: NodeKey) => {
    const i = topics.indexOf(topicOf(key));
    return i < 0 ? topics.length : i;
  };

  const out = new Map<NodeKey, PlacedNode>();
  for (const [ring, list] of byRing) {
    const radius = ringRadius(ring, dims);
    // minimum angular distance so circles don't touch (plus some air)
    const minDeg = radius > 0 ? ((dims.node * 2.3) / radius) * (180 / Math.PI) : 0;
    list.sort((a, b) => a.angle - b.angle || topicIndex(a.key) - topicIndex(b.key));

    for (const cluster of clusterByAngle(list, minDeg)) {
      cluster.sort((a, b) => topicIndex(a.key) - topicIndex(b.key));
      const mean = cluster.reduce((s, n) => s + n.angle, 0) / cluster.length;
      cluster.forEach((n, i) => {
        const angle = mean + (i - (cluster.length - 1) / 2) * minDeg;
        out.set(n.key, { key: n.key, ring, angle, ...polar(radius, angle) });
      });
    }
  }
  return out;
}

/** groups consecutive (sorted) entries closer than minDeg */
function clusterByAngle<T extends { angle: number }>(sorted: T[], minDeg: number): T[][] {
  const clusters: T[][] = [];
  for (const n of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && n.angle - last[last.length - 1].angle < minDeg) last.push(n);
    else clusters.push([n]);
  }
  return clusters;
}

// --- edges -------------------------------------------------------------------

export type EdgeKind = "implicit" | "explicit";

export interface EdgeSegment {
  id: string;
  kind: EdgeKind;
  from: Point;
  to: Point;
  /** node(s) this segment comes from; it is visible if any of them is */
  sources: NodeKey[];
  target: NodeKey;
  /** segment ends at the target node (draw an arrow head) */
  intoTarget: boolean;
}

export interface Junction extends Point {
  id: string;
  target: NodeKey;
  sources: NodeKey[];
  /** buyout price inside the OR group, if any */
  cost?: number;
}

export type EdgeNode = Pick<GraphNode, "key" | "topic" | "level" | "requires" | "explicitRequires">;

/**
 * Edge segments for drawing. Implicit previous-level edges are solid,
 * explicit requirement edges dashed. Alternatives of one OR group run into a
 * junction dot placed just before the target; the junction connects to the
 * target with one segment.
 */
export function buildEdges(
  nodes: Iterable<EdgeNode>,
  pos: Map<NodeKey, Point>,
  dims: Dims = DEFAULT_DIMS,
): { segments: EdgeSegment[]; junctions: Junction[] } {
  const segments: EdgeSegment[] = [];
  const junctions: Junction[] = [];

  for (const node of nodes) {
    const to = pos.get(node.key);
    if (!to) continue;
    const prevKey = node.level > 0 ? `${node.topic}:${node.level - 1}` : undefined;
    const prev = prevKey ? pos.get(prevKey) : undefined;
    if (prevKey && prev) {
      segments.push(segment(`${prevKey}>${node.key}`, "implicit", prev, to, [prevKey], node.key, true, dims));
    }

    node.explicitRequires.forEach((group, gi) => {
      const alts = levelAlternatives(group).filter((k) => pos.has(k));
      const cost = costOf(group);
      if (alts.length === 0) return;
      if (alts.length === 1 && cost === undefined) {
        if (alts[0] === prevKey) return; // already drawn as implicit
        segments.push(segment(`${alts[0]}>${node.key}#${gi}`, "explicit", pos.get(alts[0])!, to, alts, node.key, true, dims));
        return;
      }
      const j = junctionPoint(to, alts.map((k) => pos.get(k)!), dims);
      const id = `${node.key}#${gi}`;
      junctions.push({ id, target: node.key, sources: alts, ...j, ...(cost === undefined ? {} : { cost }) });
      for (const alt of alts) {
        const from = trimStart(pos.get(alt)!, j, dims.node);
        segments.push({ id: `${alt}>${id}`, kind: "explicit", from, to: j, sources: [alt], target: node.key, intoTarget: false });
      }
      segments.push(segment(`${id}>${node.key}`, "explicit", j, to, alts, node.key, true, dims, 0));
    });
  }
  return { segments, junctions };
}

function segment(
  id: string,
  kind: EdgeKind,
  a: Point,
  b: Point,
  sources: NodeKey[],
  target: NodeKey,
  intoTarget: boolean,
  dims: Dims,
  startTrim = dims.node,
): EdgeSegment {
  const [from, to] = trim(a, b, startTrim, dims.node + 3);
  return { id, kind, from, to, sources, target, intoTarget };
}

export function levelAlternatives(group: Requirement[number]): NodeKey[] {
  const keys: NodeKey[] = [];
  for (const alt of group) if (alt.kind === "level") keys.push(`${alt.topic}:${alt.level}`);
  return keys;
}

function costOf(group: Requirement[number]): number | undefined {
  let min: number | undefined;
  for (const alt of group) if (alt.kind === "cost") min = min === undefined ? alt.amount : Math.min(min, alt.amount);
  return min;
}

/** a point just outside the target, towards the centroid of the sources */
export function junctionPoint(target: Point, sources: Point[], dims: Dims = DEFAULT_DIMS): Point {
  const c = sources.reduce((s, p) => ({ x: s.x + p.x / sources.length, y: s.y + p.y / sources.length }), { x: 0, y: 0 });
  let dx = c.x - target.x;
  let dy = c.y - target.y;
  let len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    // sources sit on the target: point towards the centre instead
    dx = -target.x;
    dy = -target.y;
    len = Math.hypot(dx, dy) || 1;
  }
  const d = Math.min(dims.node + dims.gap * 0.4, Math.max(len * 0.5, dims.node + 6));
  return { x: round(target.x + (dx / len) * d), y: round(target.y + (dy / len) * d) };
}

/** shortens segment a→b by `start` at a and `end` at b (never inverts it) */
export function trim(a: Point, b: Point, start: number, end: number): [Point, Point] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len <= start + end || len === 0) {
    const mid = { x: round((a.x + b.x) / 2), y: round((a.y + b.y) / 2) };
    return [mid, mid];
  }
  const ux = dx / len;
  const uy = dy / len;
  return [
    { x: round(a.x + ux * start), y: round(a.y + uy * start) },
    { x: round(b.x - ux * end), y: round(b.y - uy * end) },
  ];
}

function trimStart(a: Point, b: Point, start: number): Point {
  return trim(a, b, start, 0)[0];
}

// --- fog ---------------------------------------------------------------------

/** every (prerequisite → node) pair from the full requirements, deduplicated */
export function successorPairs(nodes: Iterable<Pick<GraphNode, "key" | "requires">>): [NodeKey, NodeKey][] {
  const seen = new Set<string>();
  const pairs: [NodeKey, NodeKey][] = [];
  for (const node of nodes) {
    for (const group of node.requires) {
      for (const src of levelAlternatives(group)) {
        const id = `${src}>${node.key}`;
        if (src === node.key || seen.has(id)) continue;
        seen.add(id);
        pairs.push([src, node.key]);
      }
    }
  }
  return pairs;
}

export interface Stub {
  id: string;
  from: Point;
  to: Point;
}

/**
 * Short dotted stubs from visible nodes towards hidden successors, so the
 * player sees that something lies beyond without learning what or where.
 */
export function fogStubs(
  pairs: [NodeKey, NodeKey][],
  isVisible: (key: NodeKey) => boolean,
  pos: Map<NodeKey, Point>,
  length = 22,
  dims: Dims = DEFAULT_DIMS,
): Stub[] {
  const stubs: Stub[] = [];
  for (const [src, dst] of pairs) {
    if (!isVisible(src) || isVisible(dst)) continue;
    const a = pos.get(src);
    const b = pos.get(dst);
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    const [from, to] = trim(a, b, dims.node + 2, Math.max(0, len - dims.node - 2 - length));
    stubs.push({ id: `${src}~${dst}`, from, to });
  }
  return stubs;
}

// --- labels / frame ----------------------------------------------------------

export function labelAnchor(angleDeg: number): "start" | "middle" | "end" {
  const c = Math.cos((angleDeg * Math.PI) / 180);
  if (c > 0.3) return "start";
  if (c < -0.3) return "end";
  return "middle";
}

/** square viewBox around the outer ring, with room for topic labels */
export function viewBoxFor(maxRing: number, dims: Dims = DEFAULT_DIMS, margin = 120): string {
  const r = ringRadius(Math.max(0, maxRing), dims) + margin;
  return `${-r} ${-r} ${2 * r} ${2 * r}`;
}
