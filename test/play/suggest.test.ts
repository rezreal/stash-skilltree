import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { interest, library, performer, scene, spendMarker, trigger } from "../core/fixtures.ts";
import { buildGraph, computeProgress, computeVisibility, triggerEdges } from "../../src/core/index.ts";
import type { LibraryInput, SceneInput } from "../../src/core/types.ts";
import { computeLedger } from "../../src/play/economy.ts";
import { describeNode, gatePrice, startPerformers, suggest, topicLabel } from "../../src/play/suggest.ts";
import type { SuggestInput } from "../../src/play/suggest.ts";

const done = { completedAt: "2024-02-01T00:00:00Z", completions: 1 };

// Dates follow performer chronology: P's next clips in line are r5 and f1
// (2024-01-03, r4 comes after them), every new clip of Q is dated 2024-01-01.
function base(extraScenes: SceneInput[] = [], balanceScenes = 100): LibraryInput {
  return library({
    performers: [performer("P"), performer("Q")],
    interestTags: [
      interest("tr0", "relax", 0),
      interest("tr1", "relax", 1),
      interest("tf0", "fixation", 0),
      interest("td0", "deepening", 0, { requires: "$60" }),
      interest("tb0", "breath", 0),
    ],
    scenes: [
      scene("r1", ["tr0"], { performerIds: ["P"], ...done, earned: balanceScenes / 2 }),
      scene("r2", ["tr0"], { performerIds: ["P"], ...done, earned: balanceScenes / 2 }),
      scene("r3", ["tr0"], { performerIds: ["Q"] }),
      scene("r4", ["tr1"], { performerIds: ["P"], date: "2024-01-05" }),
      scene("r5", ["tr1"], { performerIds: ["P"], date: "2024-01-03" }),
      scene("r6", ["tr1"], { performerIds: ["Q"] }),
      scene("f1", ["tf0"], { performerIds: ["P"], date: "2024-01-03" }),
      scene("f2", ["tf0"], { performerIds: ["Q"] }),
      scene("d1", ["td0"], { performerIds: ["Q"] }),
      scene("b1", ["tb0"], { performerIds: ["Q"] }),
      scene("b2", ["tb0"], { performerIds: ["Q"] }),
      ...extraScenes,
    ],
  });
}

function input(lib: LibraryInput, extra: Partial<SuggestInput> = {}): SuggestInput {
  const graph = buildGraph(lib);
  const progress = computeProgress(graph);
  return {
    graph,
    progress,
    visibility: computeVisibility(graph, progress),
    library: lib,
    policyTags: [],
    ledger: computeLedger(lib),
    streak: { days: 0, bonus: 1, activeToday: false },
    edges: triggerEdges(lib),
    ...extra,
  };
}

const replace = (lib: LibraryInput, id: string, patch: Partial<SceneInput>): LibraryInput => ({
  ...lib,
  scenes: lib.scenes.map((s) => (s.id === id ? { ...s, ...patch } : s)),
});

describe("describe helpers", () => {
  it("labels topics and nodes", () => {
    assert.equal(topicLabel("body scan"), "Body Scan");
    assert.equal(describeNode("deepening:3"), "Deepening L3");
  });
});

describe("suggest", () => {
  it("continue in the deepest topic, explore a new topic", () => {
    const r = suggest(input(base(), { performerId: "P" }));
    assert.equal(r.performerId, "P");
    assert.equal(r.blocked, undefined);
    assert.deepEqual(
      r.options.map((o) => [o.kind, o.sceneId, o.node]),
      [
        ["continue", "r5", "relax:1"],
        ["explore", "f1", "fixation:0"],
      ],
    );
    assert.deepEqual(r.options[0].reasons, ["counts toward Relax L1 (0 of 2 done)", "next Relax scene for this performer"]);
    assert.deepEqual(r.options[1].reasons, ["first Fixation scene for this performer", "counts toward Fixation L0 (0 of 2 done)"]);
    assert.equal(r.options[0].estimatedEarn, 8);
    assert.equal(r.options[0].price, 0);
  });

  it("switches rank other performers by shared topics, then open scenes", () => {
    const r = suggest(input(base(), { performerId: "P" }));
    assert.equal(r.switches.length, 1);
    assert.equal(r.switches[0].performerId, "Q");
    assert.deepEqual([...r.switches[0].sharedTopics].sort(), ["fixation", "relax"]);
    // r6, f2, b1, b2 (d1 is behind a gate, r3 is in a complete node)
    assert.equal(r.switches[0].openScenes, 4);
  });

  it("never suggests unaffordable clips; blocked continue becomes earn", () => {
    let lib = base();
    lib = replace(lib, "r4", { markers: [spendMarker("m4", "150")] });
    lib = replace(lib, "r5", { markers: [spendMarker("m5", "pay 200")] });
    lib = replace(lib, "f2", { interactive: true, durationSec: 1200 });
    const r = suggest(input(lib, { performerId: "P" }));
    // r4 (150) is behind r5 in P's chronology, so only r5 (200) counts
    assert.deepEqual(r.blocked, { node: "relax:1", cost: 200, balance: 100 });
    assert.deepEqual(
      r.options.map((o) => [o.kind, o.sceneId]),
      [
        ["earn", "f2"],
        ["explore", "f1"],
      ],
    );
    assert.ok(r.options[0].reasons.includes("high effort: interactive"));
    assert.ok(r.options[0].reasons.includes("toward Relax L1 (needs 200, you have 100)"));
    for (const o of r.options) assert.ok(o.spendCost + o.price <= 100);
  });

  it("an affordable scene in the same node is taken before blocking", () => {
    // r7 shares r5's date, so both are next in line for P; r4 (later) is not
    const lib = replace(base([scene("r7", ["tr1"], { performerIds: ["P"], date: "2024-01-03" })]), "r5", {
      markers: [spendMarker("m5", "150")],
    });
    const r = suggest(input(lib, { performerId: "P" }));
    assert.equal(r.blocked, undefined);
    assert.equal(r.options[0].sceneId, "r7");
  });

  it("gate nodes are candidates with a price when affordable", () => {
    const lib = base([scene("d2", ["td0"], { performerIds: ["P"], date: "2024-01-03" })]);
    // P has no fixation scene in this variant
    const noF = { ...lib, scenes: lib.scenes.filter((s) => s.id !== "f1") };
    const inp = input(noF, { performerId: "P" });
    assert.equal(gatePrice(inp.graph, inp.progress, "deepening:0"), 60);
    const r = suggest(inp);
    const explore = r.options.find((o) => o.kind === "explore");
    assert.ok(explore);
    assert.equal(explore.sceneId, "d2");
    assert.equal(explore.price, 60);
    assert.ok(explore.reasons.includes("opens Deepening L0 for 60"));
  });

  it("an unaffordable gate blocks and is replaced by earn", () => {
    const lib = base([scene("d2", ["td0"], { performerIds: ["P"], date: "2024-01-03" })], 50);
    const noF = { ...lib, scenes: lib.scenes.filter((s) => s.id !== "f1") };
    const r = suggest(input(noF, { performerId: "P" }));
    assert.deepEqual(r.blocked, { node: "deepening:0", cost: 60, balance: 50 });
    assert.ok(!r.options.some((o) => o.sceneId === "d2"));
    assert.deepEqual(r.options.map((o) => o.kind), ["continue", "earn"]);
  });

  it("low balance offers earn as the second option", () => {
    const r = suggest(input(base([], 10), { performerId: "P" }));
    assert.deepEqual(r.options.map((o) => o.kind), ["continue", "earn"]);
    assert.notEqual(r.options[0].sceneId, r.options[1].sceneId);
    assert.ok(r.options[1].reasons.includes("your balance is low (10)"));
    // three options when asked for them
    const r3 = suggest(input(base([], 10), { performerId: "P", max: 3 }));
    assert.deepEqual(r3.options.map((o) => o.kind), ["continue", "earn", "explore"]);
    assert.equal(new Set(r3.options.map((o) => o.sceneId)).size, 3);
  });

  it("earn may repeat a completed scene with decay", () => {
    let lib = base([], 10);
    lib = replace(lib, "r1", { interactive: true, durationSec: 3600 });
    const r = suggest(input(lib, { performerId: "P" }));
    const earn = r.options.find((o) => o.kind === "earn");
    assert.ok(earn);
    assert.equal(earn.sceneId, "r1");
    assert.equal(earn.node, "relax:0");
    assert.ok(earn.reasons.includes("repeat, reward ×0.5"));
  });

  it("trigger: a used scene waits for its installed scene", () => {
    const lib = base();
    lib.triggerTags.push(trigger("ti", "x", "installed"), trigger("tu", "x", "used"));
    lib.interestTags.push(interest("tl2", "relax", 2));
    // installer sits in a locked node, the user scene would be P's next relax scene;
    // the installer is undated (outside the chronology, the trigger edge stays
    // hard) and the user scene shares r5's date (both next in line), sorting first
    lib.scenes.push(scene("inst", ["tl2", "ti"], { performerIds: ["P"], date: undefined }));
    lib.scenes.push(scene("a-use", ["tr1", "tu"], { performerIds: ["P"], date: "2024-01-03" }));
    let r = suggest(input(lib, { performerId: "P" }));
    assert.equal(r.options[0].sceneId, "r5");
    // once the installer is completed, the user scene comes first
    const lib2 = replace(lib, "inst", done);
    r = suggest(input(lib2, { performerId: "P" }));
    assert.equal(r.options[0].sceneId, "a-use");
    assert.ok(r.options[0].reasons.includes('uses the "x" trigger installed earlier'));
  });

  it("trigger: a scene using two triggers needs an installer completed for each", () => {
    const lib = base();
    lib.triggerTags.push(
      trigger("txi", "x", "installed"),
      trigger("txu", "x", "used"),
      trigger("tyi", "y", "installed"),
      trigger("tyu", "y", "used"),
    );
    lib.interestTags.push(interest("tl2", "relax", 2));
    lib.scenes.push(scene("instX", ["tl2", "txi"], { performerIds: ["P"], date: "2023-01-01", ...done }));
    // instY undated, the user scene next in line with r5 (see above)
    lib.scenes.push(scene("instY", ["tl2", "tyi"], { performerIds: ["P"], date: undefined }));
    lib.scenes.push(scene("a-use", ["tr1", "txu", "tyu"], { performerIds: ["P"], date: "2024-01-03" }));
    // only x is installed: the scene stays out everywhere
    let r = suggest(input(lib, { performerId: "P", max: 5 }));
    assert.ok(!r.options.some((o) => o.sceneId === "a-use"));
    assert.equal(r.options[0].sceneId, "r5");
    // both installed: it comes first
    r = suggest(input(replace(lib, "instY", done), { performerId: "P" }));
    assert.equal(r.options[0].sceneId, "a-use");
  });

  it("without a performer picks the one with most open scenes", () => {
    const r = suggest(input(base()));
    assert.equal(r.performerId, "Q");
    assert.equal(r.options[0].kind, "continue");
    assert.equal(r.options[0].sceneId, "r6");
    assert.ok(r.switches.every((s) => s.performerId !== "Q"));
    assert.deepEqual(r.switches.map((s) => s.performerId), ["P"]);
  });

  it("nothing to suggest returns no options", () => {
    const lib = library({ interestTags: [interest("t", "a", 0)], scenes: [scene("s", ["t"], { ...done, earned: 100 })] });
    const r = suggest(input(lib));
    assert.deepEqual(r.options, []);
    assert.deepEqual(r.switches, []);
    // with a low balance a repeat is still offered to earn
    const poor = library({ interestTags: [interest("t", "a", 0)], scenes: [scene("s", ["t"], done)] });
    assert.deepEqual(suggest(input(poor)).options.map((o) => [o.kind, o.sceneId]), [["earn", "s"]]);
  });
});

describe("startPerformers", () => {
  it("lists performers with new scenes in open entry nodes", () => {
    const lib = base();
    const { max: _m, performerId: _p, ...rest } = input(lib);
    const list = startPerformers(rest);
    assert.deepEqual(
      list.map((p) => [p.performerId, p.entryScenes, [...p.topics].sort(), p.firstDate]),
      [
        ["Q", 3, ["breath", "fixation"], "2024-01-01"],
        ["P", 1, ["fixation"], "2024-01-03"],
      ],
    );
  });
});

describe("performer chronology", () => {
  const withLevel2 = (extra: SceneInput[], balanceScenes = 100) => {
    const lib = base(extra, balanceScenes);
    lib.interestTags.push(interest("tl2", "relax", 2));
    return lib;
  };

  it("later clips of a performer are not offered; same-date clips are", () => {
    const r = suggest(input(base(), { performerId: "P", max: 5 }));
    const ids = r.options.map((o) => o.sceneId);
    assert.ok(ids.includes("r5") && ids.includes("f1"));
    assert.ok(!ids.includes("r4"));
    assert.equal(r.chronology, undefined);
  });

  it("the best continue clip held back by an earlier clip in an open node: reason, not locked", () => {
    const lib = replace(base(), "r5", { date: "2024-01-04" });
    const r = suggest(input(lib, { performerId: "P" }));
    assert.equal(r.options[0].kind, "continue");
    assert.equal(r.options[0].sceneId, "f1");
    assert.deepEqual(r.chronology, { sceneId: "r5", performerId: "P", nextSceneIds: ["f1"], locked: false });
  });

  it("a performer whose next clip is in a locked level is stalled: locked reason, no switch, no start", () => {
    const lib = withLevel2([scene("early", ["tl2"], { performerIds: ["P"], date: "2023-01-01" })]);
    const r = suggest(input(lib, { performerId: "P", max: 5 }));
    assert.ok(!r.options.some((o) => o.kind === "continue"));
    assert.ok(!r.options.some((o) => ["r4", "r5", "f1"].includes(o.sceneId)));
    assert.deepEqual(r.chronology, { sceneId: "r5", performerId: "P", nextSceneIds: ["early"], locked: true });
    // P has nothing to watch now: not on the start screen, not offered as a switch
    const { max: _m, performerId: _p, ...rest } = input(lib);
    assert.deepEqual(startPerformers(rest).map((p) => p.performerId), ["Q"]);
    assert.ok(!suggest(input(lib, { performerId: "Q" })).switches.some((s) => s.performerId === "P"));
  });

  it("earn may still repeat a completed clip of a stalled performer", () => {
    let lib = withLevel2([scene("early", ["tl2"], { performerIds: ["P"], date: "2023-01-01" })], 10);
    lib = replace(lib, "r1", { interactive: true, durationSec: 3600 });
    const r = suggest(input(lib, { performerId: "P" }));
    const earn = r.options.find((o) => o.kind === "earn");
    assert.ok(earn);
    assert.equal(earn.sceneId, "r1");
  });

  it("a clip with two performers waits until it is next in line for both", () => {
    // pq is P's earliest new clip, but Q still has clips from 2024-01-01
    const lib = base([scene("pq", ["tr1"], { performerIds: ["P", "Q"], date: "2024-01-02" })]);
    const r = suggest(input(lib, { performerId: "P", max: 5 }));
    assert.ok(!r.options.some((o) => ["pq", "r5", "f1"].includes(o.sceneId)));
    assert.equal(r.chronology?.sceneId, "pq");
    assert.equal(r.chronology?.performerId, "Q");
    assert.deepEqual(r.chronology?.nextSceneIds, ["b1", "b2", "d1", "f2", "r3", "r6"]);
    assert.equal(r.chronology?.locked, false);
    // Q can still switch in with the clips in line; pq is not counted
    assert.equal(r.switches.find((s) => s.performerId === "Q")?.openScenes, 4);
    // once Q has caught up (all earlier clips watched), pq comes up for P
    let caught = lib;
    for (const id of ["b1", "b2", "d1", "f2", "r3", "r6"]) caught = replace(caught, id, done);
    const r2 = suggest(input(caught, { performerId: "P" }));
    assert.equal(r2.options[0].sceneId, "pq");
    assert.equal(r2.chronology, undefined);
  });

  it("switches and start screen only list performers with a clip in line", () => {
    // Q's earliest clip sits in a locked level: Q is stalled
    const lib = withLevel2([scene("qlock", ["tl2"], { performerIds: ["Q"], date: "2023-01-01" })]);
    const r = suggest(input(lib, { performerId: "P" }));
    assert.deepEqual(r.switches, []);
    const { max: _m, performerId: _p, ...rest } = input(lib);
    assert.deepEqual(startPerformers(rest).map((p) => p.performerId), ["P"]);
  });
});
