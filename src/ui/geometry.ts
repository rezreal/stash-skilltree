// Pure geometry for the skill tree view: node positions from the layout,
// edge segments (with OR-group junctions), edges from START, the fitted
// viewBox and pan/zoom arithmetic. No React here so it runs under
// `node --test`.
import type { GraphNode, Layout, NodeKey, Requirement } from "../core/types.ts";

export interface Point {
  x: number;
  y: number;
}

export interface Dims {
  /** node circle radius */
  node: number;
  /** how far an OR junction may sit in front of its target, beyond the node */
  junction: number;
}

export const DEFAULT_DIMS: Dims = { node: 19, junction: 29 };

/** radius of the START marker at the origin */
export const START_RADIUS = 9;

export const ORIGIN: Point = { x: 0, y: 0 };

function round(n: number): number {
  return Math.round(n * 100) / 100 || 0;
}

/** layout positions of the given nodes (all of them without a filter) */
export function positions(layout: Layout, include?: (key: NodeKey) => boolean): Map<NodeKey, Point> {
  const out = new Map<NodeKey, Point>();
  for (const n of layout.nodes.values()) {
    if (!include || include(n.key)) out.set(n.key, { x: n.x, y: n.y });
  }
  return out;
}

// --- edges -------------------------------------------------------------------

export type EdgeKind = "implicit" | "explicit" | "start";

export interface EdgeSegment {
  id: string;
  kind: EdgeKind;
  from: Point;
  to: Point;
  /** node(s) this segment comes from (empty for START) */
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
 * Edge segments between the nodes that have a position. Implicit
 * previous-level edges are solid, explicit requirement edges dashed.
 * Alternatives of one OR group run into a junction dot placed just before
 * the target; the junction connects to the target with one segment. Pass
 * only the positions of drawn nodes: alternatives without a position are
 * left out entirely, so neither a segment nor the junction's placement
 * hints at them.
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
      segments.push(segment(`${prevKey}>${node.key}`, "implicit", prev, to, [prevKey], node.key, dims));
    }

    node.explicitRequires.forEach((group, gi) => {
      const alts = levelAlternatives(group).filter((k) => pos.has(k) && k !== node.key);
      const cost = costOf(group);
      if (alts.length === 0) return;
      if (alts.length === 1 && cost === undefined) {
        if (alts[0] === prevKey) return; // already drawn as implicit
        segments.push(segment(`${alts[0]}>${node.key}#${gi}`, "explicit", pos.get(alts[0])!, to, alts, node.key, dims));
        return;
      }
      const j = junctionPoint(to, alts.map((k) => pos.get(k)!), dims);
      const id = `${node.key}#${gi}`;
      junctions.push({ id, target: node.key, sources: alts, ...j, ...(cost === undefined ? {} : { cost }) });
      for (const alt of alts) {
        const from = trim(pos.get(alt)!, j, dims.node, 0)[0];
        segments.push({ id: `${alt}>${id}`, kind: "explicit", from, to: j, sources: [alt], target: node.key, intoTarget: false });
      }
      segments.push(segment(`${id}>${node.key}`, "explicit", j, to, alts, node.key, dims, 0));
    });
  }
  return { segments, junctions };
}

/** edges from the START marker to the entry nodes that have a position */
export function startEdges(entries: NodeKey[], pos: Map<NodeKey, Point>, dims: Dims = DEFAULT_DIMS): EdgeSegment[] {
  const out: EdgeSegment[] = [];
  for (const key of entries) {
    const p = pos.get(key);
    if (!p) continue;
    const [from, to] = trim(ORIGIN, p, START_RADIUS, dims.node + 3);
    out.push({ id: `start>${key}`, kind: "start", from, to, sources: [], target: key, intoTarget: true });
  }
  return out;
}

function segment(
  id: string,
  kind: EdgeKind,
  a: Point,
  b: Point,
  sources: NodeKey[],
  target: NodeKey,
  dims: Dims,
  startTrim = dims.node,
): EdgeSegment {
  const [from, to] = trim(a, b, startTrim, dims.node + 3);
  return { id, kind, from, to, sources, target, intoTarget: true };
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
    // sources sit on the target: point towards START instead
    dx = -target.x;
    dy = -target.y;
    len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      dx = 0;
      dy = -1;
      len = 1;
    }
  }
  const d = Math.min(dims.node + dims.junction, Math.max(len * 0.5, dims.node + 6));
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

// --- viewBox, pan and zoom -----------------------------------------------------

export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function viewBoxString(b: ViewBox): string {
  return `${round(b.x)} ${round(b.y)} ${round(b.w)} ${round(b.h)}`;
}

/**
 * The box around the given points (START is always included) plus a margin
 * for node circles and labels, at least `minSize` wide and high so a handful
 * of nodes isn't blown up to fill the screen. Only the points passed in
 * count, so a fog view frames the known part and says nothing about the
 * extent of the rest.
 */
export function fitBox(points: Iterable<Point>, margin = 70, minSize = 480): ViewBox {
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  let w = maxX - minX + 2 * margin;
  let h = maxY - minY + 2 * margin;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  w = Math.max(w, minSize);
  h = Math.max(h, minSize);
  return { x: round(cx - w / 2), y: round(cy - h / 2), w: round(w), h: round(h) };
}

export const MIN_VIEW = 160;
export const MAX_VIEW = 40000;

/**
 * Zooms by `factor` (> 1 zooms in) keeping `center` (in box coordinates)
 * at the same spot; the box width stays within [MIN_VIEW, MAX_VIEW].
 */
export function zoomBox(box: ViewBox, factor: number, center?: Point): ViewBox {
  const c = center ?? { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  let f = factor > 0 && Number.isFinite(factor) ? factor : 1;
  const w = box.w / f;
  if (w < MIN_VIEW) f = box.w / MIN_VIEW;
  else if (w > MAX_VIEW) f = box.w / MAX_VIEW;
  const nw = box.w / f;
  const nh = box.h / f;
  return {
    x: round(c.x - (c.x - box.x) / f),
    y: round(c.y - (c.y - box.y) / f),
    w: round(nw),
    h: round(nh),
  };
}

/** moves the box by (dx, dy) box units */
export function panBox(box: ViewBox, dx: number, dy: number): ViewBox {
  return { x: round(box.x + dx), y: round(box.y + dy), w: box.w, h: box.h };
}
