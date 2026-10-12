import { test } from "node:test";
import assert from "node:assert/strict";
import type { GraphNode, Layout, LayoutNode, NodeKey, Requirement } from "../../src/core/types.ts";
import {
  DEFAULT_DIMS,
  buildEdges,
  dimsFor,
  fogStubs,
  junctionPoint,
  labelAnchor,
  placeNodes,
  polar,
  ringRadius,
  successorPairs,
  trim,
  viewBoxFor,
  type Point,
} from "../../src/ui/geometry.ts";

const dims = DEFAULT_DIMS;

function layoutOf(nodes: LayoutNode[]): Layout {
  return {
    nodes: new Map(nodes.map((n) => [n.key, n])),
    topicAngles: new Map(),
    maxRing: Math.max(0, ...nodes.map((n) => n.ring)),
  };
}

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

test("polar: 0° is right, 90° is down (SVG coordinates)", () => {
  assert.deepEqual(polar(10, 0), { x: 10, y: 0 });
  assert.deepEqual(polar(10, 90), { x: 0, y: 10 });
  assert.deepEqual(polar(10, -90), { x: 0, y: -10 });
});

test("ringRadius grows by gap per ring", () => {
  assert.equal(ringRadius(0), dims.inner);
  assert.equal(ringRadius(2) - ringRadius(1), dims.gap);
});

test("dimsFor widens ring 0 only when many entry nodes share it", () => {
  const few = layoutOf([{ key: "a:0", ring: 0, angle: 0 }, { key: "b:0", ring: 0, angle: 180 }]);
  assert.equal(dimsFor(few).inner, dims.inner);
  const many = layoutOf(
    Array.from({ length: 24 }, (_, i) => ({ key: `t${i}:0`, ring: 0, angle: i * 15 })),
  );
  const wide = dimsFor(many);
  assert.ok(wide.inner > dims.inner);
  // neighbours 15° apart no longer collide
  assert.ok((2 * Math.PI * wide.inner) / 24 >= 2.3 * dims.node);
});

test("placeNodes keeps separate angles untouched", () => {
  const placed = placeNodes(
    layoutOf([
      { key: "a:0", ring: 0, angle: -90 },
      { key: "b:0", ring: 0, angle: 90 },
    ]),
    (k) => k.split(":")[0],
    ["a", "b"],
  );
  assert.equal(placed.get("a:0")!.angle, -90);
  assert.deepEqual({ x: placed.get("b:0")!.x, y: placed.get("b:0")!.y }, polar(ringRadius(0), 90));
});

test("placeNodes spreads colliding nodes of one ring symmetrically, in topic order", () => {
  const placed = placeNodes(
    layoutOf([
      { key: "b:1", ring: 2, angle: 0 },
      { key: "a:1", ring: 2, angle: 0 },
      { key: "c:0", ring: 1, angle: 0 },
    ]),
    (k) => k.split(":")[0],
    ["a", "b", "c"],
  );
  const a = placed.get("a:1")!;
  const b = placed.get("b:1")!;
  assert.ok(a.angle < 0 && b.angle > 0, "topic order decides the side");
  assert.equal(a.angle, -b.angle, "symmetric around the mean");
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 2 * dims.node, "circles do not overlap");
  assert.equal(placed.get("c:0")!.angle, 0, "other rings are unaffected");
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

test("buildEdges skips references to nodes without a position", () => {
  const pos = new Map<NodeKey, Point>([["c:0", { x: 0, y: 0 }]]);
  const { segments, junctions } = buildEdges([node("c:0", [[lvl("ghost", 3)]])], pos);
  assert.equal(segments.length + junctions.length, 0);
});

test("junctionPoint falls back towards the centre when sources sit on the target", () => {
  const j = junctionPoint({ x: 0, y: 100 }, [{ x: 0, y: 100 }]);
  assert.equal(j.x, 0);
  assert.ok(j.y < 100);
});

test("successorPairs lists every prerequisite once, including implicit levels", () => {
  const pairs = successorPairs([node("a:1", [[lvl("b", 0), lvl("a", 0)]]), node("b:1")]);
  assert.deepEqual(
    pairs.map((p) => p.join(">")).sort(),
    ["a:0>a:1", "b:0>a:1", "b:0>b:1"],
  );
});

test("fogStubs: only visible → hidden, short and pointing at the hidden node", () => {
  const pos = new Map<NodeKey, Point>([
    ["a:0", { x: 0, y: 0 }],
    ["a:1", { x: 200, y: 0 }],
    ["b:0", { x: 0, y: 200 }],
  ]);
  const visible = new Set(["a:0", "b:0"]);
  const stubs = fogStubs(
    [
      ["a:0", "a:1"],
      ["a:0", "b:0"],
      ["a:1", "b:0"],
    ],
    (k) => visible.has(k),
    pos,
    22,
  );
  assert.equal(stubs.length, 1);
  const s = stubs[0];
  assert.equal(s.id, "a:0~a:1");
  assert.equal(s.from.x, dims.node + 2);
  assert.ok(Math.abs(s.to.x - s.from.x - 22) < 0.01);
  assert.equal(s.to.y, 0);
});

test("labelAnchor follows the side of the circle", () => {
  assert.equal(labelAnchor(0), "start");
  assert.equal(labelAnchor(180), "end");
  assert.equal(labelAnchor(-90), "middle");
});

test("viewBoxFor is square and centred", () => {
  const [x, y, w, h] = viewBoxFor(2, dims, 100).split(" ").map(Number);
  assert.equal(x, -(ringRadius(2) + 100));
  assert.equal(y, x);
  assert.equal(w, -2 * x);
  assert.equal(h, w);
});
