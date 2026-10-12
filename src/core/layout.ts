// Radial layout: topics are spokes, ring = requirement depth. Computed from
// the full graph so clearing the fog never moves nodes.

import type { Graph, Layout, LayoutNode, NodeKey } from "./types.ts";
import { nodeKey } from "./requirements.ts";
import { compareNodeKeys } from "./graph.ts";

const COLLISION_DEG = 8;
const NUDGE_DEG = 12;

/** Normalizes an angle to [-180, 180). */
export function normalizeAngle(deg: number): number {
  const a = (((deg + 180) % 360) + 360) % 360 - 180;
  return Object.is(a, -0) ? 0 : a;
}

function angleDistance(a: number, b: number): number {
  const d = Math.abs(normalizeAngle(a - b));
  return Math.min(d, 360 - d);
}

/** Circular mean in degrees; undefined if the vectors cancel out. */
export function circularMean(angles: number[]): number | undefined {
  if (angles.length === 0) return undefined;
  let x = 0;
  let y = 0;
  for (const a of angles) {
    const r = (a * Math.PI) / 180;
    x += Math.cos(r);
    y += Math.sin(r);
  }
  if (Math.hypot(x, y) < 1e-9 * angles.length) return undefined;
  return normalizeAngle(Math.round(((Math.atan2(y, x) * 180) / Math.PI) * 1e6) / 1e6);
}

/**
 * depth(n) = 0 without requirements, else max(0, 1 + max over groups of
 * (min over alternatives of depth(target))), a cost alternative counting -1.
 * Back edges of cycles count 0; references to missing nodes are ignored (a
 * group with nothing left counts -1).
 */
export function computeRings(graph: Graph): Map<NodeKey, number> {
  const ring = new Map<NodeKey, number>();
  const visiting = new Set<NodeKey>();

  const depth = (key: NodeKey): number => {
    const known = ring.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) return 0;
    const node = graph.nodes.get(key)!;
    if (node.requires.length === 0) {
      ring.set(key, 0);
      return 0;
    }
    visiting.add(key);
    let worst = -1;
    for (const g of node.requires) {
      let best: number | undefined;
      for (const alt of g) {
        let d: number;
        if (alt.kind === "cost") d = -1;
        else {
          const target = nodeKey(alt.topic, alt.level);
          if (!graph.nodes.has(target)) continue;
          d = depth(target);
        }
        if (best === undefined || d < best) best = d;
      }
      worst = Math.max(worst, best ?? -1);
    }
    visiting.delete(key);
    const r = Math.max(0, 1 + worst);
    ring.set(key, r);
    return r;
  };

  for (const key of [...graph.nodes.keys()].sort(compareNodeKeys)) depth(key);
  return ring;
}

/** Topics referenced by explicit level requirements of a topic's nodes. */
export function topicDependencies(graph: Graph): Map<string, string[]> {
  const deps = new Map<string, Set<string>>();
  const topics = new Set(graph.topics);
  for (const t of graph.topics) deps.set(t, new Set());
  for (const node of graph.nodes.values()) {
    for (const g of node.explicitRequires) {
      for (const alt of g) {
        if (alt.kind === "level" && alt.topic !== node.topic && topics.has(alt.topic)) {
          deps.get(node.topic)?.add(alt.topic);
        }
      }
    }
  }
  const out = new Map<string, string[]>();
  for (const t of graph.topics) {
    const order = graph.topics.filter((x) => deps.get(t)!.has(x));
    out.set(t, order);
  }
  return out;
}

export function computeTopicAngles(graph: Graph): Map<string, number> {
  const angles = new Map<string, number>();
  const topics = graph.topics;
  if (topics.length === 0) return angles;
  const deps = topicDependencies(graph);
  const base = topics.filter((t) => deps.get(t)!.length === 0);

  if (base.length === 0) {
    topics.forEach((t, i) => angles.set(t, normalizeAngle(-90 + (360 * i) / topics.length)));
    return angles;
  }
  base.forEach((t, i) => angles.set(t, normalizeAngle(-90 + (360 * i) / base.length)));

  const place = (desired: number): number => {
    let a = normalizeAngle(desired);
    for (let i = 0; i < Math.ceil(360 / NUDGE_DEG); i++) {
      if (![...angles.values()].some((b) => angleDistance(a, b) < COLLISION_DEG)) return a;
      a = normalizeAngle(a + NUDGE_DEG);
    }
    return normalizeAngle(desired);
  };

  const resolving = new Set<string>();
  const resolve = (t: string): number | undefined => {
    const known = angles.get(t);
    if (known !== undefined) return known;
    if (resolving.has(t)) return undefined;
    resolving.add(t);
    const parentAngles: number[] = [];
    for (const d of deps.get(t)!) {
      const a = resolve(d);
      if (a !== undefined) parentAngles.push(a);
    }
    resolving.delete(t);
    let desired = circularMean(parentAngles);
    if (desired === undefined) desired = parentAngles.length > 0 ? parentAngles[0] + 90 : -90;
    const a = place(desired);
    angles.set(t, a);
    return a;
  };
  for (const t of topics) resolve(t);
  return angles;
}

export function computeLayout(graph: Graph): Layout {
  const rings = computeRings(graph);
  const topicAngles = computeTopicAngles(graph);
  const nodes = new Map<NodeKey, LayoutNode>();
  let maxRing = 0;
  for (const key of [...graph.nodes.keys()].sort(compareNodeKeys)) {
    const node = graph.nodes.get(key)!;
    const ring = rings.get(key) ?? 0;
    maxRing = Math.max(maxRing, ring);
    nodes.set(key, { key, ring, angle: topicAngles.get(node.topic) ?? -90 });
  }
  return { nodes, topicAngles, maxRing };
}
