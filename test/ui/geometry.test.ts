import { test } from "node:test";
import assert from "node:assert/strict";
import type { GraphNode, Layout, NodeKey, Requirement } from "../../src/core/types.ts";
import {
  DEFAULT_DIMS,
  MAX_VIEW,
  MIN_VIEW,
  START_RADIUS,
  buildEdges,
  fitBox,
  junctionPoint,
  panBox,
  positions,
  startEdges,
  trim,
  viewBoxString,
  zoomBox,
  type Point,
} from "../../src/ui/geometry.ts";

const dims = DEFAULT_DIMS;

function node(key: NodeKey, explicit: Requirement = []): GraphNode {
  const [topic, l] = key.split(":");
  const level = Number(l);
  const implicit: Requirement = level > 0 ? [[{ kind: "level", topic, level: level - 1 }]] : [];
  return {
    key,
    topic,
    level,
    tagIds: [],
    requires: [...implicit, ...explicit],
    explicitRequires: explicit,
    need: 2,
    sceneIds: [],
    paid: 0,
  };
}

const lvl = (topic: string, level: number) => ({ kind: "level" as const, topic, level });

function layoutOf(points: Record<NodeKey, Point>, entries: NodeKey[] = []): Layout {
  return {
    nodes: new Map(Object.entries(points).map(([key, p]) => [key, { key, ...p, depth: 0 }])),
    entries,
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    maxDepth: 0,
  };
}

test("positions: all layout nodes, or only those passing the filter", () => {
  const l = layoutOf({ "a:0": { x: 1, y: 2 }, "b:0": { x: 3, y: 4 } });
  assert.deepEqual([...positions(l)], [["a:0", { x: 1, y: 2 }], ["b:0", { x: 3, y: 4 }]]);
  assert.deepEqual([...positions(l, (k) => k === "b:0").keys()], ["b:0"]);
});

test("trim shortens both ends and collapses short segments", () => {
  const [from, to] = trim({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 20);
  assert.deepEqual(from, { x: 10, y: 0 });
  assert.deepEqual(to, { x: 80, y: 0 });
  const [m1, m2] = trim({ x: 0, y: 0 }, { x: 10, y: 0 }, 10, 10);
  assert.deepEqual(m1, m2);
});

test("buildEdges: implicit previous-level edge is solid, explicit single edge dashed", () => {
  const pos = new Map<NodeKey, Point>([
    ["a:0", { x: 0, y: -60 }],
    ["a:1", { x: 0, y: -130 }],
    ["b:0", { x: 60, y: 0 }],
  ]);
  const { segments, junctions } = buildEdges([node("a:0"), node("a:1", [[lvl("b", 0)]]), node("b:0")], pos);
  assert.equal(junctions.length, 0);
  const kinds = segments.map((s) => `${s.sources.join("+")}>${s.target}:${s.kind}`).sort();
  assert.deepEqual(kinds, ["a:0>a:1:implicit", "b:0>a:1:explicit"]);
  assert.ok(segments.every((s) => s.intoTarget));
});

test("buildEdges: explicit group equal to the previous level is not drawn twice", () => {
  const pos = new Map<NodeKey, Point>([
    ["a:0", { x: 0, y: -60 }],
    ["a:1", { x: 0, y: -130 }],
  ]);
  const { segments } = buildEdges([node("a:1", [[lvl("a", 0)]])], pos);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, "implicit");
});

test("buildEdges: OR alternatives meet in a junction before the target", () => {
  const pos = new Map<NodeKey, Point>([
    ["a:0", { x: -100, y: 0 }],
    ["b:0", { x: 100, y: 0 }],
    ["c:0", { x: 0, y: 200 }],
  ]);
  const target = node("c:0", [[lvl("a", 0), lvl("b", 0), { kind: "cost", amount: 80 }, { kind: "cost", amount: 50 }]]);
  const { segments, junctions } = buildEdges([target], pos);
  assert.equal(junctions.length, 1);
  const j = junctions[0];
  assert.equal(j.cost, 50, "cheapest buyout");
  assert.deepEqual(j.sources, ["a:0", "b:0"]);
  assert.ok(j.y < 200 && j.y > 0, "junction lies between sources and target");
  const intoJ = segments.filter((s) => !s.intoTarget);
  assert.equal(intoJ.length, 2);
  for (const s of intoJ) assert.deepEqual(s.to, { x: j.x, y: j.y });
  const last = segments.filter((s) => s.intoTarget);
  assert.equal(last.length, 1);
  assert.deepEqual(last[0].sources, ["a:0", "b:0"]);
});

test("buildEdges: alternatives without a position leave no trace", () => {
  // b:0 is not drawn: the OR group becomes a plain edge from a:0, and the
  // junction (if any) would not lean towards b:0
  const pos = new Map<NodeKey, Point>([
    ["a:0", { x: -100, y: 0 }],
    ["c:0", { x: 0, y: 200 }],
  ]);
  const { segments, junctions } = buildEdges([node("c:0", [[lvl("a", 0), lvl("b", 0)]])], pos);
  assert.equal(junctions.length, 0);
  assert.deepEqual(segments.map((s) => s.sources), [["a:0"]]);
  const ghost = buildEdges([node("c:0", [[lvl("ghost", 3)]])], new Map([["c:0", { x: 0, y: 0 }]]));
  assert.equal(ghost.segments.length + ghost.junctions.length, 0);
});

test("junctionPoint falls back towards START when sources sit on the target", () => {
  const j = junctionPoint({ x: 0, y: 100 }, [{ x: 0, y: 100 }]);
  assert.equal(j.x, 0);
  assert.ok(j.y < 100);
  const atOrigin = junctionPoint({ x: 0, y: 0 }, [{ x: 0, y: 0 }]);
  assert.ok(Number.isFinite(atOrigin.x) && Number.isFinite(atOrigin.y));
});

test("startEdges: from the START marker to entry nodes that have a position", () => {
  const pos = new Map<NodeKey, Point>([["a:0", { x: 100, y: 0 }]]);
  const edges = startEdges(["a:0", "hidden:0"], pos);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].kind, "start");
  assert.deepEqual(edges[0].from, { x: START_RADIUS, y: 0 });
  assert.deepEqual(edges[0].to, { x: 100 - dims.node - 3, y: 0 });
});

test("fitBox frames the points and START with a margin, never smaller than minSize", () => {
  const box = fitBox([{ x: 100, y: 50 }, { x: 900, y: -400 }], 50, 100);
  assert.deepEqual(box, { x: -50, y: -450, w: 1000, h: 550 });
  const small = fitBox([{ x: 40, y: 0 }], 10, 480);
  assert.equal(small.w, 480);
  assert.equal(small.h, 480);
  assert.equal(small.x + small.w / 2, 20, "centred on what is shown");
  assert.deepEqual(fitBox([], 70, 0), { x: -70, y: -70, w: 140, h: 140 });
});

test("zoomBox keeps the zoom centre in place and clamps the scale", () => {
  const box = { x: 0, y: 0, w: 1000, h: 500 };
  const z = zoomBox(box, 2, { x: 100, y: 100 });
  assert.deepEqual(z, { x: 50, y: 50, w: 500, h: 250 });
  // the centre stays at the same relative spot
  assert.equal((100 - z.x) / z.w, (100 - box.x) / box.w);
  assert.equal(zoomBox(box, 1000).w, MIN_VIEW);
  assert.equal(zoomBox(box, 1e-6).w, MAX_VIEW);
  assert.deepEqual(zoomBox(box, NaN), box);
  const centred = zoomBox(box, 2);
  assert.deepEqual(centred, { x: 250, y: 125, w: 500, h: 250 });
});

test("panBox moves without resizing; viewBoxString rounds", () => {
  assert.deepEqual(panBox({ x: 0, y: 0, w: 10, h: 20 }, 5, -3), { x: 5, y: -3, w: 10, h: 20 });
  assert.equal(viewBoxString({ x: -1.23456, y: 2, w: 100, h: 50.005 }), "-1.23 2 100 50.01");
});
