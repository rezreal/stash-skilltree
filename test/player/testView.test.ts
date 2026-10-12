import { test } from "node:test";
import assert from "node:assert/strict";
import { scene } from "../core/fixtures.ts";
import { rangeLabel, testSceneChips } from "../../src/player/testView.ts";

test("testSceneChips: funscript, prompt markers, tree membership", () => {
  const s = scene("1", [], {
    interactive: true,
    markers: [
      { id: "a", title: "x", seconds: 1, check: "repeat" },
      { id: "b", title: "y", seconds: 2, check: "spend" },
      { id: "c", title: "z", seconds: 3 },
    ],
  });
  assert.deepEqual(testSceneChips(s, ["fixation:1"], true), [
    { text: "funscript", tone: "blue" },
    { text: "2 prompt markers", tone: "blue" },
    { text: "in tree · Fixation L1", tone: "orange" },
  ]);
  assert.deepEqual(testSceneChips(scene("2", []), [], true), [{ text: "series part", tone: "orange" }]);
  assert.deepEqual(testSceneChips(scene("3", []), [], false), [{ text: "not in tree", tone: "muted" }]);
});

test("rangeLabel", () => {
  assert.equal(rangeLabel(1, 25, 0), "0 scenes");
  assert.equal(rangeLabel(1, 25, 10), "1–10 of 10");
  assert.equal(rangeLabel(2, 25, 60), "26–50 of 60");
  assert.equal(rangeLabel(3, 25, 60), "51–60 of 60");
});
