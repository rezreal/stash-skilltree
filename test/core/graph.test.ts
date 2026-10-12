import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, DEFAULT_NEED, parseSpendAmount } from "../../src/core/index.ts";
import { interest, library, quick, scene, spendMarker } from "./fixtures.ts";

test("tags with the same topic and level merge into one node", () => {
  const g = buildGraph(
    library({
      interestTags: [
        interest("a", "Fixation", 1, { need: 2, requires: "relax:0", paid: 10 }),
        interest("b", " fixation ", 1, { need: 3, requires: "deep:0|$5", paid: 30 }),
        interest("c", "fixation", 0),
        interest("r", "relax", 0),
        interest("d", "deep", 0),
      ],
      scenes: [scene("s1", ["a"]), scene("s2", ["b"]), scene("s3", ["a", "b"]), scene("s4", ["b"])],
    }),
  );
  const n = g.nodes.get("fixation:1")!;
  assert.deepEqual(n.tagIds, ["a", "b"]);
  assert.deepEqual(n.sceneIds, ["s1", "s2", "s3", "s4"]);
  assert.equal(n.need, 3);
  assert.equal(n.rawNeed, 3);
  assert.equal(n.paid, 30);
  assert.deepEqual(n.explicitRequires, [
    [{ kind: "level", topic: "relax", level: 0 }],
    [
      { kind: "level", topic: "deep", level: 0 },
      { kind: "cost", amount: 5 },
    ],
  ]);
  assert.deepEqual(n.requires[0], [{ kind: "level", topic: "fixation", level: 0 }]);
  assert.equal(n.requires.length, 3);
  assert.equal(g.nodes.size, 4);
});

test("only the deepest level of a topic counts for a scene", () => {
  const g = buildGraph(
    library({
      interestTags: [interest("f0", "fix", 0), interest("f1", "fix", 1), interest("f2", "fix", 2), interest("r0", "relax", 0)],
      scenes: [scene("s1", ["f0", "f2", "r0", "unrelated"]), scene("s2", ["f1"]), scene("s3", ["other"])],
    }),
  );
  assert.deepEqual(g.sceneNodes.get("s1"), ["fix:2", "relax:0"]);
  assert.deepEqual(g.sceneNodes.get("s2"), ["fix:1"]);
  assert.deepEqual(g.sceneNodes.get("s3"), []);
  assert.deepEqual(g.nodes.get("fix:0")!.sceneIds, []);
  assert.deepEqual(g.nodes.get("fix:2")!.sceneIds, ["s1"]);
  assert.deepEqual(g.nodes.get("relax:0")!.sceneIds, ["s1"]);
  assert.equal(g.scenes.size, 3);
});

test("implicit previous-level requirement", () => {
  const g = buildGraph(quick({ "a:0": {}, "a:1": {}, "a:2": { requires: "a:1" } }));
  assert.deepEqual(g.nodes.get("a:0")!.requires, []);
  assert.deepEqual(g.nodes.get("a:1")!.requires, [[{ kind: "level", topic: "a", level: 0 }]]);
  assert.deepEqual(g.nodes.get("a:1")!.explicitRequires, []);
  // explicit duplicate of the implicit group is not repeated
  assert.deepEqual(g.nodes.get("a:2")!.requires, [[{ kind: "level", topic: "a", level: 1 }]]);
  assert.deepEqual(g.nodes.get("a:2")!.explicitRequires, [[{ kind: "level", topic: "a", level: 1 }]]);
});

test("need: default, option, minimum 1, capped at scene count", () => {
  const g = buildGraph(
    quick({
      "a:0": { scenes: 5 },
      "b:0": { scenes: 1 },
      "c:0": { scenes: 5, need: 0 },
      "d:0": { scenes: 3, need: 9 },
      "e:0": { scenes: 0, need: 4 },
      "f:0": { scenes: 0 },
    }),
  );
  assert.equal(g.nodes.get("a:0")!.need, DEFAULT_NEED);
  assert.equal(g.nodes.get("a:0")!.rawNeed, undefined);
  assert.equal(g.nodes.get("b:0")!.need, 1);
  assert.equal(g.nodes.get("c:0")!.need, 1);
  assert.equal(g.nodes.get("d:0")!.need, 3);
  assert.equal(g.nodes.get("d:0")!.rawNeed, 9);
  assert.equal(g.nodes.get("e:0")!.need, 4);
  assert.equal(g.nodes.get("f:0")!.need, DEFAULT_NEED);

  const g2 = buildGraph(quick({ "a:0": { scenes: 5 } }), { defaultNeed: 4 });
  assert.equal(g2.nodes.get("a:0")!.need, 4);
});

test("toll when every scene has a spend marker", () => {
  const lib = library({
    interestTags: [interest("t", "toll", 0), interest("u", "half", 0), interest("v", "noamount", 0)],
    scenes: [
      scene("s1", ["t"], { markers: [spendMarker("m1", "$80"), spendMarker("m2", "120")] }),
      scene("s2", ["t"], { markers: [spendMarker("m3", "pay 60 coins"), { id: "m4", title: "5", seconds: 1, check: "repeat" }] }),
      scene("s3", ["u"], { markers: [spendMarker("m5", "10")] }),
      scene("s4", ["u"]),
      scene("s5", ["v"], { markers: [spendMarker("m6", "lots")] }),
    ],
  });
  const g = buildGraph(lib);
  assert.deepEqual(g.nodes.get("toll:0")!.toll, { amount: 60 });
  assert.equal(g.nodes.get("half:0")!.toll, undefined);
  assert.equal(g.nodes.get("noamount:0")!.toll, undefined);
  assert.equal(parseSpendAmount("between 30 and 20"), 20);
  assert.equal(parseSpendAmount("none"), undefined);
});

test("build issues: syntax errors and unknown refs", () => {
  const g = buildGraph(quick({ "a:0": {}, "b:0": { requires: "a:0,a:5,zzz:1,oops" } }));
  const codes = g.buildIssues.map((i) => [i.code, i.severity, i.node, i.tagId]);
  assert.deepEqual(codes, [
    ["requires-syntax", "error", "b:0", "t:b:0"],
    ["unknown-ref", "error", "b:0", "t:b:0"],
    ["unknown-ref", "error", "b:0", "t:b:0"],
  ]);
  assert.match(g.buildIssues[1].message, /no level 5/);
  assert.match(g.buildIssues[2].message, /no topic "zzz"/);
});

test("invalid interest tags are skipped and reported", () => {
  const g = buildGraph(library({ interestTags: [interest("x", "  ", 0), interest("y", "a", -1), interest("z", "a", 0)] }));
  assert.deepEqual([...g.nodes.keys()], ["a:0"]);
  assert.deepEqual(
    g.buildIssues.map((i) => i.tagId),
    ["x", "y"],
  );
});

test("topics: deterministic, linked topics adjacent", () => {
  const g = buildGraph(
    quick({
      "alpha:0": {},
      "zeta:0": {},
      "beta:0": {},
      "mid:0": { requires: "zeta:0" },
      "omega:0": { requires: "alpha:0" },
    }),
  );
  // alpha first (alphabetical), then its partner omega; mid and zeta adjacent
  assert.deepEqual(g.topics, ["alpha", "omega", "beta", "mid", "zeta"]);
  const again = buildGraph(
    quick({
      "omega:0": { requires: "alpha:0" },
      "mid:0": { requires: "zeta:0" },
      "beta:0": {},
      "zeta:0": {},
      "alpha:0": {},
    }),
  );
  assert.deepEqual(again.topics, g.topics);
});

test("co-required topics end up adjacent", () => {
  const g = buildGraph(quick({ "a:0": {}, "b:0": {}, "m:0": {}, "z:0": {}, "c:0": { requires: "a:0,z:0" } }));
  const i = g.topics.indexOf("a");
  assert.deepEqual(g.topics.slice(i, i + 3), ["a", "c", "z"]);
});

test("performers are indexed", () => {
  const g = buildGraph(library({ performers: [{ id: "p1", name: "Ann" }] }));
  assert.equal(g.performers.get("p1")!.name, "Ann");
  assert.deepEqual(g.topics, []);
});
