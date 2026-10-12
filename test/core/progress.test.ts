import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, computeProgress, performerHasScenes, topicDepth } from "../../src/core/index.ts";
import { interest, library, quick, scene } from "./fixtures.ts";

function states(lib: Parameters<typeof buildGraph>[0]) {
  const p = computeProgress(buildGraph(lib));
  return Object.fromEntries([...p].map(([k, v]) => [k, v.state]));
}

test("entry nodes open, complete when enough scenes done", () => {
  const s = states(quick({ "a:0": { done: 2 }, "b:0": { done: 1 }, "c:0": {} }));
  assert.deepEqual(s, { "a:0": "complete", "b:0": "open", "c:0": "open" });
});

test("implicit chain: next level opens only after previous completes", () => {
  const s = states(quick({ "a:0": { done: 2 }, "a:1": { done: 2 }, "a:2": { done: 1 }, "a:3": { done: 2 } }));
  assert.deepEqual(s, { "a:0": "complete", "a:1": "complete", "a:2": "open", "a:3": "locked" });
});

test("completed scenes in a locked node do not make it complete", () => {
  const s = states(quick({ "a:0": {}, "a:1": { done: 2 } }));
  assert.equal(s["a:1"], "locked");
});

test("AND groups need every group", () => {
  const s = states(
    quick({ "a:0": { done: 2 }, "b:0": { done: 1 }, "x:0": { requires: "a:0,b:0" }, "y:0": { requires: "a:0" } }),
  );
  assert.equal(s["x:0"], "locked");
  assert.equal(s["y:0"], "open");
});

test("OR group satisfied by any alternative", () => {
  const s = states(quick({ "a:0": {}, "b:0": { done: 2 }, "x:0": { requires: "a:0|b:0" }, "y:0": { requires: "a:0|zzz:4" } }));
  assert.equal(s["x:0"], "open");
  assert.equal(s["y:0"], "locked");
});

test("cost alternatives check the evaluated node's paid amount", () => {
  const s = states(
    quick({
      "a:0": {},
      "price:0": { requires: "$50", paid: 50 },
      "cheap:0": { requires: "$50", paid: 49 },
      "buyout:0": { requires: "a:0|$80", paid: 100 },
      "both:0": { requires: "a:0,$10", paid: 10 },
      "free:0": { requires: "$10" },
    }),
  );
  assert.equal(s["price:0"], "open");
  assert.equal(s["cheap:0"], "locked");
  assert.equal(s["buyout:0"], "open");
  assert.equal(s["both:0"], "locked");
  assert.equal(s["free:0"], "locked");
});

test("dependency order does not matter (fixpoint)", () => {
  const s = states(
    quick({
      "z:0": { done: 2, requires: "y:0" },
      "y:0": { done: 2, requires: "x:0" },
      "x:0": { done: 2 },
    }),
  );
  assert.deepEqual(s, { "x:0": "complete", "y:0": "complete", "z:0": "complete" });
});

test("cycles: closed cycles stay locked, OR-escaped cycles resolve, no hang", () => {
  const s = states(
    quick({
      "p:0": { done: 2, requires: "q:0" },
      "q:0": { done: 2, requires: "p:0" },
      "e:0": { done: 2 },
      "m:0": { done: 2, requires: "n:0|e:0" },
      "n:0": { done: 2, requires: "m:0" },
      "self:0": { requires: "self:0" },
    }),
  );
  assert.equal(s["p:0"], "locked");
  assert.equal(s["q:0"], "locked");
  assert.equal(s["m:0"], "complete");
  assert.equal(s["n:0"], "complete");
  assert.equal(s["self:0"], "locked");
});

test("performer filter changes counts only", () => {
  const lib = library({
    interestTags: [interest("a", "a", 0), interest("b", "b", 0)],
    scenes: [
      scene("s1", ["a"], { performerIds: ["p1"], completedAt: "x" }),
      scene("s2", ["a"], { performerIds: ["p2"], completedAt: "x" }),
      scene("s3", ["a"], { performerIds: ["p1", "p2"] }),
      scene("s4", ["b"], { performerIds: ["p2"] }),
    ],
  });
  const g = buildGraph(lib);
  const all = computeProgress(g);
  const p1 = computeProgress(g, { performerId: "p1" });
  assert.deepEqual(all.get("a:0"), { state: "complete", completed: 2, need: 2 });
  assert.deepEqual(p1.get("a:0"), { state: "complete", completed: 1, need: 2 });
  assert.deepEqual(p1.get("b:0"), { state: "open", completed: 0, need: 1 });
  assert.equal(performerHasScenes(g, "a:0", "p1"), true);
  assert.equal(performerHasScenes(g, "b:0", "p1"), false);
  assert.equal(performerHasScenes(g, "b:0", "p2"), true);
  assert.equal(performerHasScenes(g, "nope:0", "p2"), false);
});

test("topicDepth counts consecutive complete levels from 0", () => {
  const g = buildGraph(
    quick({
      "a:0": { done: 2 },
      "a:1": { done: 2 },
      "a:2": { done: 0 },
      "b:0": {},
      "c:1": { done: 2 },
    }),
  );
  const p = computeProgress(g);
  assert.equal(topicDepth(g, p, "a"), 2);
  assert.equal(topicDepth(g, p, " A "), 2);
  assert.equal(topicDepth(g, p, "b"), 0);
  assert.equal(topicDepth(g, p, "c"), 0);
  assert.equal(topicDepth(g, p, "missing"), 0);
});
