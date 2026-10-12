import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, lintGraph, reachableNodes, requirementCycles } from "../../src/core/index.ts";
import type { LibraryInput, LintIssue } from "../../src/core/index.ts";
import { interest, library, quick, scene, trigger } from "./fixtures.ts";

function lint(lib: LibraryInput): LintIssue[] {
  return lintGraph(buildGraph(lib), lib);
}

function codes(issues: LintIssue[], code: string): (string | undefined)[] {
  return issues.filter((i) => i.code === code).map((i) => i.node ?? i.tagId);
}

test("clean graph has no issues", () => {
  assert.deepEqual(lint(quick({ "a:0": {}, "a:1": {}, "b:0": { requires: "a:1|$40" } })), []);
});

test("build issues and malformed tags are included", () => {
  const lib = quick({ "a:0": { requires: "a:0:0,zzz:1" } });
  lib.malformed.push({ tagId: "m1", tagName: "Bad", problem: "st.level is not a number" });
  const issues = lint(lib);
  assert.deepEqual(codes(issues, "requires-syntax"), ["a:0"]);
  assert.deepEqual(codes(issues, "unknown-ref"), ["a:0"]);
  assert.deepEqual(codes(issues, "malformed-tag"), ["m1"]);
  assert.ok(issues.filter((i) => i.code === "malformed-tag").every((i) => i.severity === "error"));
});

test("malformed series groups are errors carrying the group id", () => {
  const lib = quick({ "a:0": {} });
  lib.malformed.push({ groupId: "g1", groupName: "Daily", problem: 'st.series must be "daily", got "weekly"' });
  const issues = lint(lib).filter((i) => i.code === "malformed-series");
  assert.deepEqual(issues, [
    { severity: "error", code: "malformed-series", message: 'Group "Daily": st.series must be "daily", got "weekly"', groupId: "g1" },
  ]);
});

test("unreachable: costs payable, OR escapes, closed cycles and gaps", () => {
  const g = buildGraph(
    quick({
      "a:0": {},
      "price:0": { requires: "$500" },
      "deep:0": { requires: "price:0,a:0" },
      "p:0": { requires: "q:0" },
      "q:0": { requires: "p:0" },
      "m:0": { requires: "n:0|a:0" },
      "n:0": { requires: "m:0" },
      "gap:2": {},
      "ref:0": { requires: "zzz:0" },
    }),
  );
  assert.deepEqual([...reachableNodes(g)].sort(), ["a:0", "deep:0", "m:0", "n:0", "price:0"]);
  const issues = lintGraph(g);
  assert.deepEqual(codes(issues, "unreachable"), ["gap:2", "p:0", "q:0", "ref:0"]);
  assert.ok(issues.filter((i) => i.code === "unreachable").every((i) => i.severity === "error"));
});

test("or-cycle: reachable members of a cycle warn, closed cycles do not", () => {
  const g = buildGraph(
    quick({
      "e:0": {},
      "m:0": { requires: "n:0|e:0" },
      "n:0": { requires: "m:0" },
      "p:0": { requires: "q:0" },
      "q:0": { requires: "p:0" },
      "s:0": { requires: "s:0|$5" },
    }),
  );
  assert.deepEqual(requirementCycles(g), [["m:0", "n:0"], ["p:0", "q:0"], ["s:0"]]);
  const issues = lintGraph(g);
  assert.deepEqual(codes(issues, "or-cycle"), ["m:0", "n:0", "s:0"]);
  assert.ok(issues.filter((i) => i.code === "or-cycle").every((i) => i.severity === "warning"));
});

test("cycle detection handles long chains without recursion limits", () => {
  const spec: Record<string, { requires?: string }> = { "c:0": {} };
  for (let i = 1; i < 5000; i++) spec[`c:${i}`] = {};
  spec["c:0"] = { requires: "c:4999|$1" };
  const g = buildGraph(quick(spec as never));
  const cycles = requirementCycles(g);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].length, 5000);
});

test("level-gap", () => {
  const issues = lint(quick({ "a:0": {}, "a:2": {}, "a:3": {}, "b:1": {} }));
  assert.deepEqual(codes(issues, "level-gap"), ["a:2", "b:1"]);
});

test("empty-node and need-exceeds-scenes", () => {
  const issues = lint(
    quick({
      "a:0": { scenes: 0 },
      "b:0": { scenes: 2, need: 5 },
      "c:0": { scenes: 1 }, // default need capped silently
      "d:0": { scenes: 0, need: 5 }, // only reported as empty
    }),
  );
  assert.deepEqual(codes(issues, "empty-node"), ["a:0", "d:0"]);
  assert.deepEqual(codes(issues, "need-exceeds-scenes"), ["b:0"]);
  assert.match(issues.find((i) => i.code === "need-exceeds-scenes")!.message, /needs 5.*only 2.*capped at 2/);
});

test("trigger-unpaired and trigger-order", () => {
  const lib = library({
    interestTags: [interest("a", "a", 0)],
    triggerTags: [
      trigger("xi", "X", "installed"),
      trigger("xu", "x", "used"),
      trigger("yu", "y", "used"),
      trigger("zi", "z", "installed"),
      trigger("zu", "z", "used"),
    ],
    performers: [{ id: "p1", name: "Ann" }, { id: "p2", name: "Bea" }],
    scenes: [
      scene("s1", ["a", "yu"], { performerIds: ["p1"] }),
      // x for p1: used before installed -> trigger-order
      scene("x-u", ["a", "xu"], { performerIds: ["p1"], date: "2023-01-01" }),
      scene("x-i", ["a", "xi"], { performerIds: ["p1"], date: "2023-06-01" }),
      // x for p2: fine
      scene("x-i2", ["a", "xi"], { performerIds: ["p2"], date: "2023-01-01" }),
      scene("x-u2", ["a", "xu"], { performerIds: ["p2"], date: "2023-06-01" }),
      // z for p1: one used scene undated -> not flagged
      scene("z-u", ["a", "zu"], { performerIds: ["p1"], date: undefined }),
      scene("z-u2", ["a", "zu"], { performerIds: ["p1"], date: "2020-01-01" }),
      scene("z-i", ["a", "zi"], { performerIds: ["p1"], date: "2023-01-01" }),
    ],
  });
  const issues = lint(lib);
  const unpaired = issues.filter((i) => i.code === "trigger-unpaired");
  assert.equal(unpaired.length, 1);
  assert.equal(unpaired[0].tagId, "yu");
  assert.equal(unpaired[0].severity, "warning");
  const order = issues.filter((i) => i.code === "trigger-order");
  assert.equal(order.length, 1);
  assert.equal(order[0].severity, "info");
  assert.equal(order[0].sceneId, "x-u");
  assert.match(order[0].message, /Ann/);
});

test("scene-no-date is one aggregated info", () => {
  const lib = quick({ "a:0": { scenes: 3 } });
  lib.scenes[0].date = undefined;
  lib.scenes[2].date = undefined;
  const issues = lint(lib);
  const nd = issues.filter((i) => i.code === "scene-no-date");
  assert.equal(nd.length, 1);
  assert.equal(nd[0].severity, "info");
  assert.match(nd[0].message, /^2 scene/);
});

test("chronology-stall: a performer whose clip in line can never open", () => {
  const lib = library({
    interestTags: [interest("a", "a", 0), interest("b", "b", 0, { requires: "zzz:0" })],
    performers: [{ id: "p1", name: "Ann" }, { id: "p2", name: "Bea" }, { id: "p3", name: "Cat" }],
    scenes: [
      // Ann: next in line sits in unreachable b:0, a later clip waits forever
      scene("ann-b", ["b"], { performerIds: ["p1"], date: "2023-01-01" }),
      scene("ann-a", ["a"], { performerIds: ["p1"], date: "2023-06-01" }),
      // Bea: one of two same-date clips is stuck; the later clip still waits
      scene("bea-a", ["a"], { performerIds: ["p2"], date: "2023-01-01" }),
      scene("bea-b", ["b"], { performerIds: ["p2"], date: "2023-01-01" }),
      scene("bea-later", ["a"], { performerIds: ["p2"], date: "2023-02-01" }),
      // Cat: the stuck clip is the last one, or already watched, or undated
      scene("cat-a", ["a"], { performerIds: ["p3"], date: "2023-01-01" }),
      scene("cat-b", ["b"], { performerIds: ["p3"], date: "2023-06-01" }),
      scene("cat-done", ["b"], { performerIds: ["p3"], date: "2022-01-01", completedAt: "2024-01-01T00:00:00Z" }),
      scene("cat-undated", ["b"], { performerIds: ["p3"], date: undefined }),
    ],
  });
  const stalls = lint(lib).filter((i) => i.code === "chronology-stall");
  assert.deepEqual(
    stalls.map((i) => [i.severity, i.sceneId, i.node]),
    [
      ["warning", "ann-b", "b:0"],
      ["warning", "bea-b", "b:0"],
    ],
  );
  assert.match(stalls[0].message, /^Ann can never get past 2023-01-01: "ann-b".*1 later clip/);
  // a reachable tree has no stalls
  assert.deepEqual(lint(quick({ "a:0": { performer: "p" }, "a:1": { performer: "p" } })), []);
});

test("sorted errors first, then warnings, then info", () => {
  const lib = quick({ "a:0": { scenes: 0 }, "b:1": { scenes: 1 } });
  lib.scenes[0].date = undefined;
  lib.malformed.push({ tagId: "m", tagName: "M", problem: "bad" });
  const issues = lint(lib);
  const sev = issues.map((i) => i.severity);
  assert.deepEqual(sev, [...sev].sort((x, y) => ["error", "warning", "info"].indexOf(x) - ["error", "warning", "info"].indexOf(y)));
  assert.equal(sev[0], "error");
  assert.equal(sev[sev.length - 1], "info");
});

test("without input: no malformed/trigger checks", () => {
  const lib = quick({ "a:0": {} });
  lib.malformed.push({ tagId: "m", tagName: "M", problem: "bad" });
  assert.deepEqual(lintGraph(buildGraph(lib)), []);
});
