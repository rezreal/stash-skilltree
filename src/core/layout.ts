// Organic tree layout: a deterministic force-directed layout over the FULL
// graph. A virtual START node sits fixed at the origin, entry nodes hang off
// it, requirement edges are springs, every node repels every other, topics
// cluster around their own centroid and a gentle radial bias by requirement
// depth lets the tree grow away from START without putting levels on rings.
//
// Positions never depend on progress or fog, so revealing nodes never moves
// the ones already on screen. The initial positions come from a PRNG seeded
// by the node keys, so the same graph always gets the same picture.

import type { Graph, Layout, LayoutBounds, LayoutNode, NodeKey } from "./types.ts";
import { nodeKey } from "./requirements.ts";
import { compareNodeKeys } from "./graph.ts";

export interface LayoutParams {
  /** minimum distance between node centres (and START) after the run */
  minSeparation: number;
  /** spring rest lengths: START → entry, previous level, explicit requirement */
  entryLength: number;
  implicitLength: number;
  explicitLength: number;
  /** spring strengths (force per unit of stretch) */
  entryStrength: number;
  implicitStrength: number;
  explicitStrength: number;
  /** repulsion: force = repulsion · minSeparation² / d², none beyond repulsionRange */
  repulsion: number;
  repulsionRange: number;
  /** pull of a node towards its topic's centroid (per unit of distance) */
  topicPull: number;
  /** radial bias: target radius = entryLength + depth · depthStep */
  depthStep: number;
  radialPull: number;
  iterations: number;
  /** largest step per iteration at the start and at the end (cooling) */
  startTemperature: number;
  endTemperature: number;
}

/** Tuned for node circles of radius 19: minSeparation = 2 diameters. */
export const LAYOUT_PARAMS: LayoutParams = {
  minSeparation: 76,
  entryLength: 120,
  implicitLength: 92,
  explicitLength: 170,
  entryStrength: 0.35,
  implicitStrength: 0.5,
  explicitStrength: 0.12,
  repulsion: 3,
  repulsionRange: 380,
  topicPull: 0.025,
  depthStep: 88,
  radialPull: 0.03,
  iterations: 200,
  startTemperature: 90,
  endTemperature: 0.5,
};

/**
 * depth(n) = 0 without requirements, else max(0, 1 + max over groups of
 * (min over alternatives of depth(target))), a cost alternative counting -1.
 * Back edges of cycles count 0; references to missing nodes are ignored (a
 * group with nothing left counts -1).
 */
export function computeDepths(graph: Graph): Map<NodeKey, number> {
  const depths = new Map<NodeKey, number>();
  const visiting = new Set<NodeKey>();

  const depth = (key: NodeKey): number => {
    const known = depths.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) return 0;
    const node = graph.nodes.get(key)!;
    if (node.requires.length === 0) {
      depths.set(key, 0);
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
    depths.set(key, r);
    return r;
  };

  for (const key of [...graph.nodes.keys()].sort(compareNodeKeys)) depth(key);
  return depths;
}

// --- seeded randomness ---------------------------------------------------------

/** FNV-1a over a string, 32 bit. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, deterministic PRNG returning [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- springs -----------------------------------------------------------------------

/** index of the virtual START node in layout edges */
export const START_INDEX = -1;

export interface LayoutEdge {
  /** prerequisite index into `keys`, or START_INDEX */
  from: number;
  to: number;
  length: number;
  strength: number;
}

interface Prepared {
  keys: NodeKey[];
  depth: Float64Array;
  topicOf: Int32Array;
  topicCount: number;
  edges: LayoutEdge[];
  entries: NodeKey[];
}

function prepare(graph: Graph, p: LayoutParams): Prepared {
  const keys = [...graph.nodes.keys()].sort(compareNodeKeys);
  const index = new Map<NodeKey, number>();
  keys.forEach((k, i) => index.set(k, i));
  const depths = computeDepths(graph);
  const depth = new Float64Array(keys.length);
  keys.forEach((k, i) => (depth[i] = depths.get(k) ?? 0));

  const topicIds = new Map<string, number>();
  for (const t of graph.topics) topicIds.set(t, topicIds.size);
  const topicOf = new Int32Array(keys.length);
  keys.forEach((k, i) => {
    const t = graph.nodes.get(k)!.topic;
    if (!topicIds.has(t)) topicIds.set(t, topicIds.size);
    topicOf[i] = topicIds.get(t)!;
  });

  // strongest spring per (from, to) pair
  const springs = new Map<string, LayoutEdge>();
  const addSpring = (e: LayoutEdge) => {
    const id = `${e.from}>${e.to}`;
    const known = springs.get(id);
    if (!known || known.strength < e.strength) springs.set(id, e);
  };
  const hasParent = new Uint8Array(keys.length);

  keys.forEach((key, to) => {
    const node = graph.nodes.get(key)!;
    const prev = node.level > 0 ? index.get(nodeKey(node.topic, node.level - 1)) : undefined;
    if (prev !== undefined && prev !== to) {
      addSpring({ from: prev, to, length: p.implicitLength, strength: p.implicitStrength });
      hasParent[to] = 1;
    }
    for (const group of node.explicitRequires) {
      const alts: number[] = [];
      for (const alt of group) {
        if (alt.kind !== "level") continue;
        const from = index.get(nodeKey(alt.topic, alt.level));
        if (from === undefined || from === to || alts.includes(from)) continue;
        alts.push(from);
      }
      for (const from of alts) {
        if (from === prev) continue;
        // alternatives of one OR group share one spring's worth of pull
        addSpring({ from, to, length: p.explicitLength, strength: p.explicitStrength / alts.length });
        hasParent[to] = 1;
      }
    }
  });

  // entry nodes (nothing to come from) hang off START
  const entries: number[] = [];
  for (let i = 0; i < keys.length; i++) if (!hasParent[i]) entries.push(i);

  // nodes only reachable through cycles: attach the shallowest node of every
  // such group to START with a weak spring so it doesn't drift off
  const children: number[][] = keys.map(() => []);
  for (const e of springs.values()) children[e.from].push(e.to);
  const reached = new Uint8Array(keys.length);
  const flood = (start: number) => {
    const stack = [start];
    reached[start] = 1;
    while (stack.length > 0) {
      const i = stack.pop()!;
      for (const c of children[i]) {
        if (!reached[c]) {
          reached[c] = 1;
          stack.push(c);
        }
      }
    }
  };
  for (const e of entries) flood(e);
  const anchored: number[] = [];
  for (;;) {
    let pick = -1;
    for (let i = 0; i < keys.length; i++) {
      if (!reached[i] && (pick < 0 || depth[i] < depth[pick])) pick = i;
    }
    if (pick < 0) break;
    anchored.push(pick);
    flood(pick);
  }

  const edges = [...springs.values()];
  for (const i of entries) edges.push({ from: START_INDEX, to: i, length: p.entryLength, strength: p.entryStrength });
  for (const i of anchored) edges.push({ from: START_INDEX, to: i, length: p.entryLength, strength: p.entryStrength / 3 });
  edges.sort((a, b) => a.to - b.to || a.from - b.from);

  return { keys, depth, topicOf, topicCount: topicIds.size, edges, entries: entries.map((i) => keys[i]) };
}

// --- initial positions ---------------------------------------------------------

/**
 * Start positions from a radial tree over topics: every topic hangs off the
 * topic it draws most requirement edges from (one that starts shallower), or
 * off START. Each topic gets an angular sector proportional to the number of
 * nodes in its subtree, its children split that sector, and its nodes start
 * at the sector's centre at their depth's radius. Everything is jittered by
 * the seeded PRNG so the simulation does not start from a symmetric state.
 */
function initialPositions(prep: Prepared, p: LayoutParams, rand: () => number): Float64Array {
  const n = prep.keys.length;
  const T = prep.topicCount;
  const size = new Float64Array(T);
  const minDepth = new Float64Array(T).fill(Infinity);
  for (let i = 0; i < n; i++) {
    const t = prep.topicOf[i];
    size[t]++;
    minDepth[t] = Math.min(minDepth[t], prep.depth[i]);
  }
  // edges between topics, counted
  const links = new Map<number, number>();
  for (const e of prep.edges) {
    if (e.from === START_INDEX) continue;
    const a = prep.topicOf[e.from];
    const b = prep.topicOf[e.to];
    if (a !== b) links.set(a * T + b, (links.get(a * T + b) ?? 0) + 1);
  }
  const parent = new Int32Array(T).fill(-1);
  for (let b = 0; b < T; b++) {
    let best = -1;
    let bestCount = 0;
    for (let a = 0; a < T; a++) {
      const count = links.get(a * T + b) ?? 0;
      // only shallower topics (or equal depth with a lower index) can be
      // parents, which keeps the topic tree acyclic
      const earlier = minDepth[a] < minDepth[b] || (minDepth[a] === minDepth[b] && a < b);
      if (count > bestCount && earlier) {
        best = a;
        bestCount = count;
      }
    }
    parent[b] = best;
  }
  const children: number[][] = [];
  for (let t = 0; t <= T; t++) children.push([]);
  for (let t = 0; t < T; t++) children[parent[t] < 0 ? T : parent[t]].push(t);
  const weight = new Float64Array(T + 1);
  const weigh = (t: number): number => {
    let w = t < T ? size[t] : 0;
    for (const c of children[t]) w += weigh(c);
    weight[t] = w;
    return w;
  };
  weigh(T);

  const angle = new Float64Array(T);
  const assign = (t: number, from: number, width: number) => {
    let at = from;
    for (const c of children[t]) {
      const w = weight[t] > 0 ? (width * weight[c]) / (weight[t] - (t < T ? size[t] : 0) || 1) : 0;
      angle[c] = at + w / 2 + (rand() - 0.5) * w * 0.3;
      assign(c, at, w);
      at += w;
    }
  };
  assign(T, -Math.PI / 2 - Math.PI, 2 * Math.PI);

  const pos = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const a = angle[prep.topicOf[i]] + (rand() - 0.5) * 0.3;
    const r = p.entryLength + prep.depth[i] * p.depthStep + (rand() - 0.5) * p.depthStep * 0.5;
    pos[2 * i] = r * Math.cos(a);
    pos[2 * i + 1] = r * Math.sin(a);
  }
  return pos;
}

// --- simulation ------------------------------------------------------------------

function simulate(prep: Prepared, pos: Float64Array, p: LayoutParams): void {
  const n = prep.keys.length;
  if (n === 0) return;
  const T = prep.topicCount;
  const force = new Float64Array(2 * n);
  const cx = new Float64Array(T);
  const cy = new Float64Array(T);
  const cn = new Float64Array(T);
  for (let i = 0; i < n; i++) cn[prep.topicOf[i]]++;
  const target = new Float64Array(n);
  for (let i = 0; i < n; i++) target[i] = p.entryLength + prep.depth[i] * p.depthStep;
  const krep = p.repulsion * p.minSeparation * p.minSeparation;
  const minSep = p.minSeparation;
  const range2 = p.repulsionRange * p.repulsionRange;
  const cellOf = new Int32Array(n);
  const next = new Int32Array(n);
  const cool = Math.pow(p.endTemperature / p.startTemperature, 1 / Math.max(1, p.iterations - 1));
  let temperature = p.startTemperature;

  /** repulsion between node i and every node of the list starting at j */
  const repelFrom = (i: number, j: number) => {
    const xi = pos[2 * i];
    const yi = pos[2 * i + 1];
    let fxi = 0;
    let fyi = 0;
    for (; j >= 0; j = next[j]) {
      let dx = xi - pos[2 * j];
      let dy = yi - pos[2 * j + 1];
      let d2 = dx * dx + dy * dy;
      if (d2 > range2) continue;
      if (d2 < 1e-4) {
        // coincident: separate along a fixed, index-derived direction
        dx = Math.cos(i * 2.399 + j) * 0.01;
        dy = Math.sin(i * 2.399 + j) * 0.01;
        d2 = 1e-4;
      }
      const d = Math.sqrt(d2);
      let f = krep / d2;
      if (d < minSep) f += (minSep - d) * 0.5;
      f /= d;
      fxi += dx * f;
      fyi += dy * f;
      force[2 * j] -= dx * f;
      force[2 * j + 1] -= dy * f;
    }
    force[2 * i] += fxi;
    force[2 * i + 1] += fyi;
  };

  for (let it = 0; it < p.iterations; it++) {
    force.fill(0);

    // repulsion between nearby pairs (bucketed in a grid of repulsionRange
    // cells, so only neighbouring cells are compared), and from START;
    // closer than minSeparation adds a linear push on top
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, pos[2 * i]);
      minY = Math.min(minY, pos[2 * i + 1]);
      maxX = Math.max(maxX, pos[2 * i]);
      maxY = Math.max(maxY, pos[2 * i + 1]);
    }
    // cells at least repulsionRange wide, at most 64 per axis
    const cell = Math.max(p.repulsionRange, (maxX - minX) / 63, (maxY - minY) / 63);
    const cols = Math.floor((maxX - minX) / cell) + 1;
    const rows = Math.floor((maxY - minY) / cell) + 1;
    const head = new Int32Array(cols * rows).fill(-1);
    for (let i = n - 1; i >= 0; i--) {
      const cxi = Math.min(cols - 1, Math.floor((pos[2 * i] - minX) / cell));
      const cyi = Math.min(rows - 1, Math.floor((pos[2 * i + 1] - minY) / cell));
      cellOf[i] = cyi * cols + cxi;
      next[i] = head[cellOf[i]];
      head[cellOf[i]] = i;
    }
    // each cell against itself and its four "forward" neighbours, so every
    // pair is visited once
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        for (let i = head[r * cols + c]; i >= 0; i = next[i]) {
          repelFrom(i, next[i]);
          if (c + 1 < cols) repelFrom(i, head[r * cols + c + 1]);
          if (r + 1 < rows) {
            if (c > 0) repelFrom(i, head[(r + 1) * cols + c - 1]);
            repelFrom(i, head[(r + 1) * cols + c]);
            if (c + 1 < cols) repelFrom(i, head[(r + 1) * cols + c + 1]);
          }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const xi = pos[2 * i];
      const yi = pos[2 * i + 1];
      const d2s = xi * xi + yi * yi;
      if (d2s > 1e-4 && d2s <= range2) {
        const ds = Math.sqrt(d2s);
        let f = krep / d2s;
        if (ds < minSep) f += (minSep - ds) * 0.5;
        force[2 * i] += (xi / ds) * f;
        force[2 * i + 1] += (yi / ds) * f;
      }
    }

    // springs
    for (const e of prep.edges) {
      const fromStart = e.from === START_INDEX;
      const ax = fromStart ? 0 : pos[2 * e.from];
      const ay = fromStart ? 0 : pos[2 * e.from + 1];
      const dx = pos[2 * e.to] - ax;
      const dy = pos[2 * e.to + 1] - ay;
      const d = Math.sqrt(dx * dx + dy * dy) || 1e-3;
      const f = (e.strength * (d - e.length)) / d;
      force[2 * e.to] -= dx * f;
      force[2 * e.to + 1] -= dy * f;
      if (!fromStart) {
        force[2 * e.from] += dx * f;
        force[2 * e.from + 1] += dy * f;
      }
    }

    // topic clusters and the radial depth bias
    cx.fill(0);
    cy.fill(0);
    for (let i = 0; i < n; i++) {
      cx[prep.topicOf[i]] += pos[2 * i];
      cy[prep.topicOf[i]] += pos[2 * i + 1];
    }
    for (let i = 0; i < n; i++) {
      const t = prep.topicOf[i];
      const x = pos[2 * i];
      const y = pos[2 * i + 1];
      force[2 * i] += (cx[t] / cn[t] - x) * p.topicPull;
      force[2 * i + 1] += (cy[t] / cn[t] - y) * p.topicPull;
      const r = Math.sqrt(x * x + y * y);
      if (r > 1e-3) {
        const f = ((target[i] - r) * p.radialPull) / r;
        force[2 * i] += x * f;
        force[2 * i + 1] += y * f;
      }
    }

    // move, each step limited by the temperature
    for (let i = 0; i < n; i++) {
      const fx = force[2 * i];
      const fy = force[2 * i + 1];
      const len = Math.sqrt(fx * fx + fy * fy);
      if (len < 1e-9) continue;
      const step = Math.min(len, temperature) / len;
      pos[2 * i] += fx * step;
      pos[2 * i + 1] += fy * step;
    }
    temperature *= cool;
  }
}

/**
 * Pushes overlapping pairs apart until every node centre is at least
 * `minSep` from every other one and from START (which stays put).
 */
function separate(pos: Float64Array, n: number, minSep: number, maxPasses = 200): void {
  const want = minSep + 0.5; // a little slack against rounding
  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const xi = pos[2 * i];
      const yi = pos[2 * i + 1];
      const ds = Math.sqrt(xi * xi + yi * yi);
      if (ds < want) {
        const ux = ds > 1e-6 ? xi / ds : Math.cos(i * 2.399);
        const uy = ds > 1e-6 ? yi / ds : Math.sin(i * 2.399);
        pos[2 * i] = ux * (want + 0.5);
        pos[2 * i + 1] = uy * (want + 0.5);
        moved = true;
      }
      for (let j = i + 1; j < n; j++) {
        let dx = pos[2 * j] - pos[2 * i];
        let dy = pos[2 * j + 1] - pos[2 * i + 1];
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d >= want) continue;
        if (d < 1e-6) {
          dx = Math.cos(i * 2.399 + j);
          dy = Math.sin(i * 2.399 + j);
        } else {
          dx /= d;
          dy /= d;
        }
        const push = (want + 0.5 - d) / 2;
        pos[2 * i] -= dx * push;
        pos[2 * i + 1] -= dy * push;
        pos[2 * j] += dx * push;
        pos[2 * j + 1] += dy * push;
        moved = true;
      }
    }
    if (!moved) return;
  }
}

const round1 = (v: number) => Math.round(v * 10) / 10 || 0;

/**
 * Positions for every node of the graph. Deterministic: the same graph
 * (same node keys and requirements) always gives the same layout, whatever
 * the progress.
 */
export function computeLayout(graph: Graph, params: Partial<LayoutParams> = {}): Layout {
  const p: LayoutParams = { ...LAYOUT_PARAMS, ...params };
  const prep = prepare(graph, p);
  const n = prep.keys.length;
  const rand = seededRandom(hashString(prep.keys.join("|")));
  const pos = initialPositions(prep, p, rand);
  simulate(prep, pos, p);
  separate(pos, n, p.minSeparation);

  const nodes = new Map<NodeKey, LayoutNode>();
  const bounds: LayoutBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let maxDepth = 0;
  prep.keys.forEach((key, i) => {
    const x = round1(pos[2 * i]);
    const y = round1(pos[2 * i + 1]);
    const depth = prep.depth[i];
    maxDepth = Math.max(maxDepth, depth);
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
    nodes.set(key, { key, x, y, depth });
  });
  return { nodes, entries: prep.entries, bounds, maxDepth };
}

/** The springs the layout uses (START = START_INDEX), for tests and debugging. */
export function layoutEdges(graph: Graph, params: Partial<LayoutParams> = {}): { keys: NodeKey[]; edges: LayoutEdge[] } {
  const prep = prepare(graph, { ...LAYOUT_PARAMS, ...params });
  return { keys: prep.keys, edges: prep.edges };
}
