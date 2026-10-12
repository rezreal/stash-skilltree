import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, circularMean, computeLayout, normalizeAngle } from "../../src/core/index.ts";
import { quick } from "./fixtures.ts";

test("rings follow requirement depth", () => {
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
  const l = computeLayout(g);
  const ring = (k: string) => l.nodes.get(k)!.ring;
  assert.equal(ring("a:0"), 0);
  assert.equal(ring("a:1"), 1);
  assert.equal(ring("a:2"), 2);
  assert.equal(ring("b:0"), 3);
  assert.equal(ring("c:0"), 3);
  assert.equal(ring("d:0"), 0);
  assert.equal(ring("e:0"), 0);
  assert.equal(ring("f:0"), 1);
  assert.equal(ring("g:0"), 0);
  assert.equal(ring("g:1"), 1);
  assert.equal(l.maxRing, 3);
});

test("cycles terminate with deterministic rings", () => {
  const g = buildGraph(quick({ "p:0": { requires: "q:0" }, "q:0": { requires: "p:0" }, "s:0": { requires: "s:0" } }));
  const l = computeLayout(g);
  assert.equal(l.nodes.get("p:0")!.ring, 2);
  assert.equal(l.nodes.get("q:0")!.ring, 1);
  assert.equal(l.nodes.get("s:0")!.ring, 1);
});

test("base topics spaced evenly from the top, dependents at the mean of their parents", () => {
  const g = buildGraph(
    quick({
      "x:0": {},
      "y:0": {},
      "z:0": {},
      "w:0": {},
      "w:1": { requires: "x:0,y:0" },
    }),
  );
  assert.deepEqual(g.topics, ["w", "x", "y", "z"]);
  const l = computeLayout(g);
  assert.equal(l.topicAngles.get("x"), -90);
  assert.equal(l.topicAngles.get("y"), 30);
  assert.equal(l.topicAngles.get("z"), 150);
  assert.equal(l.topicAngles.get("w"), -30);
  assert.equal(l.nodes.get("w:0")!.angle, -30);
  assert.equal(l.nodes.get("w:1")!.angle, -30);
});

test("dependent on a dependent resolves recursively", () => {
  const g = buildGraph(quick({ "a:0": {}, "b:0": {}, "m:0": { requires: "a:0,b:0" }, "n:0": { requires: "m:0,a:0" } }));
  const l = computeLayout(g);
  const a = l.topicAngles.get("a")!;
  const b = l.topicAngles.get("b")!;
  const m = l.topicAngles.get("m")!;
  const n = l.topicAngles.get("n")!;
  assert.deepEqual([a, b].sort((p, q) => p - q), [-90, 90]);
  // a and b are opposite: the mean is undefined, falls back to first parent + 90
  assert.ok([0, -180].includes(m));
  assert.equal(n, circularMean([m, a]));
});

test("collisions are nudged in 12 degree steps", () => {
  const g = buildGraph(
    quick({
      "a:0": {},
      "b:0": {},
      "c:0": {},
      "d:0": {},
      "e:0": { requires: "a:0" },
      "f:0": { requires: "a:0" },
    }),
  );
  assert.deepEqual(g.topics, ["a", "e", "f", "b", "c", "d"]);
  const l = computeLayout(g);
  assert.equal(l.topicAngles.get("a"), -90);
  assert.equal(l.topicAngles.get("b"), 0);
  assert.equal(l.topicAngles.get("c"), 90);
  assert.equal(l.topicAngles.get("d"), -180);
  assert.equal(l.topicAngles.get("e"), -78);
  assert.equal(l.topicAngles.get("f"), -66);
});

test("no base topics: all spaced evenly", () => {
  const g = buildGraph(quick({ "p:0": { requires: "q:0" }, "q:0": { requires: "p:0" } }));
  const l = computeLayout(g);
  assert.equal(l.topicAngles.get(g.topics[0]), -90);
  assert.equal(l.topicAngles.get(g.topics[1]), 90);
});

test("empty graph", () => {
  const l = computeLayout(buildGraph(quick({})));
  assert.equal(l.nodes.size, 0);
  assert.equal(l.topicAngles.size, 0);
  assert.equal(l.maxRing, 0);
});

test("angle helpers", () => {
  assert.equal(normalizeAngle(270), -90);
  assert.equal(normalizeAngle(180), -180);
  assert.equal(normalizeAngle(-190), 170);
  assert.equal(circularMean([170, -170]), -180);
  assert.equal(circularMean([0, 90]), 45);
  assert.equal(circularMean([0, 180]), undefined);
  assert.equal(circularMean([]), undefined);
});
