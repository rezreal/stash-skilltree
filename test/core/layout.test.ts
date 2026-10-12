import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LAYOUT_PARAMS,
  START_INDEX,
  buildGraph,
  computeDepths,
  computeLayout,
  computeProgress,
  hashString,
  layoutEdges,
  seededRandom,
} from "../../src/core/index.ts";
import type { Graph, Layout } from "../../src/core/types.ts";
import { quick, type QuickNode } from "./fixtures.ts";

function minDistance(l: Layout): number {
  const pts = [{ x: 0, y: 0 }, ...l.nodes.values()];
  let min = Infinity;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) min = Math.min(min, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
  }
  return min;
}

function finite(l: Layout): boolean {
  for (const n of l.nodes.values()) if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return false;
  return Object.values(l.bounds).every(Number.isFinite);
}

/** a tree of `topics` topics with up to `levels` levels and cross-topic requirements */
function bigSpec(topics: number, levels: number, seed = 7): Record<string, QuickNode> {
  const rand = seededRandom(seed);
  const spec: Record<string, QuickNode> = {};
  for (let t = 0; t < topics; t++) {
    const count = 3 + Math.floor(rand() * (levels - 2));
    for (let l = 0; l < count; l++) {
      let requires: string | undefined;
      if (t >= 5 && l === 0) {
        requires = `t${Math.floor(rand() * t)}:${1 + Math.floor(rand() * 2)}`;
        if (rand() < 0.3) requires += `|t${Math.floor(rand() * t)}:1`;
      } else if (l > 1 && rand() < 0.12) {
        requires = `t${Math.floor(rand() * topics)}:${Math.floor(rand() * 3)},$${10 * (1 + Math.floor(rand() * 5))}`;
      }
      spec[`t${t}:${l}`] = requires ? { requires } : {};
    }
  }
  return spec;
}

const sample: Record<string, QuickNode> = {
  "relax:0": { done: 2 },
  "relax:1": { done: 1 },
  "relax:2": {},
  "fix:0": {},
  "fix:1": {},
  "deep:0": { requires: "relax:1" },
  "deep:1": {},
  "trance:0": { requires: "deep:1|fix:1" },
  "toll:0": { requires: "$50" },
};

test("depths follow requirements", () => {
  const g = buildGraph(
    quick({
      "a:0": {},
      "a:1": {},
      "a:2": {},
      "b:0": { requires: "a:2" },
      "c:0": { requires: "a:2|b:0" },
      "d:0": { requires: "a:1|$50" },
      "e:0": { requires: "$50" },
      "f:0": { requires: "a:0,$5" },
      "g:0": { requires: "zzz:3" },
      "g:1": {},
    }),
  );
  const d = computeDepths(g);
  assert.deepEqual(
    Object.fromEntries([...d].sort()),
    { "a:0": 0, "a:1": 1, "a:2": 2, "b:0": 3, "c:0": 3, "d:0": 0, "e:0": 0, "f:0": 1, "g:0": 0, "g:1": 1 },
  );
  const l = computeLayout(g);
  assert.equal(l.nodes.get("b:0")!.depth, 3);
  assert.equal(l.maxDepth, 3);
});

test("cycles terminate with deterministic depths", () => {
  const g = buildGraph(quick({ "p:0": { requires: "q:0" }, "q:0": { requires: "p:0" }, "s:0": { requires: "s:0" } }));
  const d = computeDepths(g);
  assert.equal(d.get("p:0"), 2);
  assert.equal(d.get("q:0"), 1);
  assert.equal(d.get("s:0"), 1);
  const l = computeLayout(g);
  assert.ok(finite(l));
  assert.ok(minDistance(l) >= LAYOUT_PARAMS.minSeparation);
});

test("entry nodes hang off START; cycle-only groups are anchored to it", () => {
  const g = buildGraph(quick({ ...sample, "p:0": { requires: "q:0" }, "q:0": { requires: "p:0" } }));
  const l = computeLayout(g);
  assert.deepEqual(l.entries, ["fix:0", "relax:0", "toll:0"]);
  const { keys, edges } = layoutEdges(g);
  const fromStart = edges.filter((e) => e.from === START_INDEX).map((e) => keys[e.to]).sort();
  // q:0 is the shallower node of the p/q cycle
  assert.deepEqual(fromStart, ["fix:0", "q:0", "relax:0", "toll:0"]);
  // implicit edges are shorter and stronger than explicit ones
  const edge = (a: string, b: string) => edges.find((e) => keys[e.from] === a && keys[e.to] === b)!;
  assert.ok(edge("relax:0", "relax:1").length < edge("relax:1", "deep:0").length);
  assert.ok(edge("relax:0", "relax:1").strength > edge("relax:1", "deep:0").strength);
  // OR alternatives share one spring's pull
  assert.ok(Math.abs(edge("deep:1", "trance:0").strength - LAYOUT_PARAMS.explicitStrength / 2) < 1e-9);
});

test("same graph, same layout", () => {
  const a = computeLayout(buildGraph(quick(sample)));
  const b = computeLayout(buildGraph(quick(sample)));
  assert.deepEqual([...a.nodes], [...b.nodes]);
  assert.deepEqual(a.bounds, b.bounds);
  // insertion order of the tags does not matter either
  const reversed = Object.fromEntries(Object.entries(sample).reverse());
  const c = computeLayout(buildGraph(quick(reversed)));
  for (const [k, n] of a.nodes) assert.deepEqual(c.nodes.get(k), n);
});

test("progress never moves a node", () => {
  const before = buildGraph(quick(sample));
  const after = buildGraph(
    quick({
      ...sample,
      "relax:1": { done: 2 },
      "relax:2": { done: 2 },
      "deep:0": { ...sample["deep:0"], done: 2 },
      "toll:0": { ...sample["toll:0"], paid: 50 },
    }),
  );
  // progress differs ...
  const pa = computeProgress(before);
  const pb = computeProgress(after);
  assert.notEqual(pa.get("deep:0")!.state, pb.get("deep:0")!.state);
  // ... positions do not
  const la = computeLayout(before);
  const lb = computeLayout(after);
  for (const [k, n] of la.nodes) assert.deepEqual(lb.nodes.get(k), n, k);
});

test("nodes keep two diameters apart, START stays at the origin, no NaN", () => {
  for (const spec of [sample, bigSpec(12, 8), bigSpec(25, 10, 3)]) {
    const l = computeLayout(buildGraph(quick(spec)));
    assert.ok(finite(l), "finite coordinates");
    assert.ok(minDistance(l) >= LAYOUT_PARAMS.minSeparation, `min distance ${minDistance(l)}`);
    for (const n of l.nodes.values()) {
      assert.ok(n.x >= l.bounds.minX && n.x <= l.bounds.maxX && n.y >= l.bounds.minY && n.y <= l.bounds.maxY);
    }
    assert.ok(l.bounds.minX <= 0 && l.bounds.maxX >= 0 && l.bounds.minY <= 0 && l.bounds.maxY >= 0, "START inside");
  }
});

test("the tree grows away from START: deeper nodes sit further out on average", () => {
  const l = computeLayout(buildGraph(quick(bigSpec(20, 9))));
  const sum = new Map<number, { r: number; n: number }>();
  for (const n of l.nodes.values()) {
    const s = sum.get(n.depth) ?? { r: 0, n: 0 };
    s.r += Math.hypot(n.x, n.y);
    s.n++;
    sum.set(n.depth, s);
  }
  const mean = (d: number) => sum.get(d)!.r / sum.get(d)!.n;
  assert.ok(mean(0) < mean(2) && mean(2) < mean(4) && mean(4) < mean(6));
  // but levels are not on rings: one depth spans a wide band of radii
  const radii = [...l.nodes.values()].filter((n) => n.depth === 3).map((n) => Math.hypot(n.x, n.y));
  assert.ok(Math.max(...radii) - Math.min(...radii) > 40);
});

test("a topic's nodes stay closer to each other than to other topics", () => {
  const l = computeLayout(buildGraph(quick(bigSpec(12, 8))));
  let inside = 0;
  let insideN = 0;
  let across = 0;
  let acrossN = 0;
  const nodes = [...l.nodes.values()];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
      if (nodes[i].key.split(":")[0] === nodes[j].key.split(":")[0]) {
        inside += d;
        insideN++;
      } else {
        across += d;
        acrossN++;
      }
    }
  }
  assert.ok(inside / insideN < (across / acrossN) * 0.7);
});

test("~300 nodes lay out fast", () => {
  const g: Graph = buildGraph(quick(bigSpec(38, 14)));
  assert.ok(g.nodes.size >= 280, `${g.nodes.size} nodes`);
  computeLayout(g); // warm up the JIT
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    computeLayout(g);
    times.push(performance.now() - t0);
  }
  const median = times.sort((a, b) => a - b)[1];
  // typically 25-40 ms; generous bound for slow machines
  assert.ok(median < 250, `median ${median.toFixed(1)} ms for ${g.nodes.size} nodes`);
});

test("empty graph", () => {
  const l = computeLayout(buildGraph(quick({})));
  assert.equal(l.nodes.size, 0);
  assert.deepEqual(l.entries, []);
  assert.deepEqual(l.bounds, { minX: 0, minY: 0, maxX: 0, maxY: 0 });
  assert.equal(l.maxDepth, 0);
});

test("seeded PRNG and hash are deterministic", () => {
  assert.equal(hashString("a:0|b:1"), hashString("a:0|b:1"));
  assert.notEqual(hashString("a:0"), hashString("a:1"));
  const r1 = seededRandom(42);
  const r2 = seededRandom(42);
  const xs = [r1(), r1(), r1()];
  assert.deepEqual(xs, [r2(), r2(), r2()]);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});
