import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, computeProgress, computeVisibility, isVisible } from "../../src/core/index.ts";
import type { LibraryInput } from "../../src/core/index.ts";
import { quick } from "./fixtures.ts";

function vis(lib: LibraryInput) {
  const g = buildGraph(lib);
  return Object.fromEntries(computeVisibility(g, computeProgress(g)));
}

test("open and complete nodes are shown", () => {
  const v = vis(quick({ "a:0": { done: 2 }, "b:0": {} }));
  assert.deepEqual(v, { "a:0": "shown", "b:0": "shown" });
});

test("ahead: would open if every open node completed; further nodes hidden", () => {
  const v = vis(
    quick({
      "a:0": { done: 2 },
      "a:1": {},
      "a:2": {},
      "a:3": {},
      "b:0": {},
      "x:0": { requires: "a:1,b:0" },
      "y:0": { requires: "a:2|b:0" },
      "z:0": { requires: "a:2,b:0" },
    }),
  );
  assert.equal(v["a:1"], "shown");
  assert.equal(v["a:2"], "ahead");
  assert.equal(v["a:3"], "hidden");
  assert.equal(v["x:0"], "ahead");
  assert.equal(v["y:0"], "ahead");
  assert.equal(v["z:0"], "hidden");
});

test("gate: every unmet group can be paid", () => {
  const v = vis(
    quick({
      "a:0": { done: 2 },
      "b:0": {},
      "price:0": { requires: "a:0,$50" },
      "buyout:0": { requires: "b:0|$80" },
      "both:0": { requires: "b:0,$50" },
      "far:0": { requires: "zzz:1|$20" },
    }),
  );
  assert.equal(v["price:0"], "gate");
  assert.equal(v["buyout:0"], "gate");
  // unmet level group without a cost: not a gate; not ahead either, the price is unpaid
  assert.equal(v["both:0"], "hidden");
  assert.equal(v["far:0"], "gate");
});

test("pure price on an entry level is a gate", () => {
  const v = vis(quick({ "a:0": { requires: "$10" } }));
  assert.equal(v["a:0"], "gate");
});

test("ahead treats costs as unmet unless already paid", () => {
  const v = vis(
    quick({
      "a:0": {},
      "unpaid:0": { requires: "a:0,$30|b:0" },
      "paid:0": { requires: "a:0,$30", paid: 30 },
      "b:0": { requires: "zzz:0" },
    }),
  );
  assert.equal(v["unpaid:0"], "hidden");
  assert.equal(v["paid:0"], "ahead");
});

test("locked cycle is hidden and does not hang", () => {
  const v = vis(quick({ "p:0": { requires: "q:0" }, "q:0": { requires: "p:0" } }));
  assert.deepEqual(v, { "p:0": "hidden", "q:0": "hidden" });
});

test("isVisible", () => {
  assert.equal(isVisible("shown"), true);
  assert.equal(isVisible("ahead"), true);
  assert.equal(isVisible("gate"), true);
  assert.equal(isVisible("hidden"), false);
  assert.equal(isVisible(undefined), false);
});
