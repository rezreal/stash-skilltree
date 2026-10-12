import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, computeLayout, computeProgress, computeVisibility, topicDepth } from "../../src/core/index.ts";
import {
  fogDepthRows,
  fogPanel,
  fogStats,
  knownTopics,
  shownRequirementLines,
  treeEdges,
  treeView,
  unlockText,
} from "../../src/ui/fogView.ts";
import { quick } from "../core/fixtures.ts";

// relax: L0 complete, L1 open, L2 ahead, L3 hidden
// fix:   L0 complete, L1 gate ($20, known topic), L2 hidden
// deep:  L0 ahead (after relax:1), L1 hidden        -> unknown topic
// toll:  L0 gate ($50)                              -> unknown topic
// trance: L0 hidden (deep:1 | fix:2)                -> unknown topic
// mix:   L0 open via relax:0 (OR deep:1), L1 hidden (needs deep:1)
function setup() {
  const graph = buildGraph(
    quick({
      "relax:0": { done: 2 },
      "relax:1": { done: 1, need: 2 },
      "relax:2": {},
      "relax:3": {},
      "fix:0": { done: 2 },
      "fix:1": { requires: "$20" },
      "fix:2": {},
      "deep:0": { requires: "relax:1" },
      "deep:1": {},
      "toll:0": { requires: "$50" },
      "trance:0": { requires: "deep:1|fix:2" },
      "mix:0": { requires: "relax:0|deep:1" },
      "mix:1": { requires: "deep:1" },
    }),
  );
  const progress = computeProgress(graph);
  const visibility = computeVisibility(graph, progress);
  const layout = computeLayout(graph);
  return { graph, progress, visibility, layout };
}

const SECRET_TOPICS = /deep|toll|trance/i;

test("fixture visibility is what the tests assume", () => {
  const { visibility } = setup();
  assert.deepEqual(Object.fromEntries([...visibility].sort()), {
    "deep:0": "ahead",
    "deep:1": "hidden",
    "fix:0": "shown",
    "fix:1": "gate",
    "fix:2": "hidden",
    "mix:0": "shown",
    "mix:1": "hidden",
    "relax:0": "shown",
    "relax:1": "shown",
    "relax:2": "ahead",
    "relax:3": "hidden",
    "toll:0": "gate",
    "trance:0": "hidden",
  });
});

test("fog: hidden nodes are not drawn at all", () => {
  const { graph, progress, visibility } = setup();
  const view = treeView(graph, progress, visibility, false);
  assert.deepEqual(
    [...view.drawn].sort(),
    ["deep:0", "fix:0", "fix:1", "mix:0", "relax:0", "relax:1", "relax:2", "toll:0"],
  );
  assert.deepEqual(view.nodes.map((n) => n.key), [...view.drawn].sort());
});

test("fog: ahead nodes are anonymous", () => {
  const { graph, progress, visibility } = setup();
  const view = treeView(graph, progress, visibility, false);
  for (const key of ["deep:0", "relax:2"]) {
    const n = view.nodes.find((v) => v.key === key)!;
    assert.deepEqual(
      { look: n.look, text: n.text, sublabel: n.sublabel, title: n.title, aria: n.aria },
      { look: "ahead", text: "?", sublabel: "", title: "Unknown level", aria: "Unknown level, not yet open" },
    );
  }
});

test("fog: gates show the price, and topic and level only in a known topic", () => {
  const { graph, progress, visibility } = setup();
  const view = treeView(graph, progress, visibility, false);
  const toll = view.nodes.find((v) => v.key === "toll:0")!;
  assert.deepEqual([toll.look, toll.text, toll.sublabel, toll.title], ["gate", "$50", "", "Unknown level"]);
  assert.equal(toll.aria, "Unknown level, can be opened for 50 coins");
  const fix = view.nodes.find((v) => v.key === "fix:1")!;
  assert.deepEqual([fix.look, fix.text, fix.sublabel, fix.title], ["gate", "$20", "L1", "Fix L1"]);
});

test("fog: shown nodes carry progress and their level", () => {
  const { graph, progress, visibility } = setup();
  const view = treeView(graph, progress, visibility, false);
  const relax1 = view.nodes.find((v) => v.key === "relax:1")!;
  assert.deepEqual([relax1.look, relax1.text, relax1.sublabel, relax1.title], ["open", "1/2", "L1", "Relax L1"]);
});

test("fog: topic labels only for topics with an open or complete node", () => {
  const { graph, progress, visibility } = setup();
  assert.deepEqual([...knownTopics(graph, progress)].sort(), ["fix", "mix", "relax"]);
  const view = treeView(graph, progress, visibility, false);
  assert.deepEqual(
    view.topicLabels.map((t) => [t.topic, t.text, t.anchor]).sort(),
    [
      ["fix", "Fix", "fix:0"],
      ["mix", "Mix", "mix:0"],
      ["relax", "Relax", "relax:0"],
    ],
  );
});

test("fog: edges only between drawn nodes, START only to drawn entries", () => {
  const { graph, progress, visibility, layout } = setup();
  const view = treeView(graph, progress, visibility, false);
  const edges = treeEdges(graph, layout, view.drawn);
  for (const s of [...edges.segments, ...edges.start]) {
    assert.ok(view.drawn.has(s.target), s.id);
    for (const src of s.sources) assert.ok(view.drawn.has(src), s.id);
  }
  for (const j of edges.junctions) for (const src of j.sources) assert.ok(view.drawn.has(src), j.id);
  assert.deepEqual(edges.start.map((s) => s.target).sort(), ["fix:0", "relax:0", "toll:0"]);
  // mix:0 = relax:0 | deep:1 with deep:1 hidden: one plain edge, no junction
  assert.equal(edges.junctions.length, 0);
  const intoMix = edges.segments.filter((s) => s.target === "mix:0");
  assert.deepEqual(intoMix.map((s) => [s.kind, s.sources]), [["explicit", ["relax:0"]]]);
});

test("author view draws everything and labels every topic", () => {
  const { graph, progress, visibility, layout } = setup();
  const view = treeView(graph, progress, visibility, true);
  assert.equal(view.drawn.size, graph.nodes.size);
  assert.deepEqual(view.topicLabels.map((t) => t.topic), graph.topics);
  const deep = view.nodes.find((v) => v.key === "deep:0")!;
  assert.deepEqual([deep.look, deep.title, deep.sublabel], ["locked", "deep L0", "L0"]);
  const edges = treeEdges(graph, layout, view.drawn);
  assert.deepEqual(edges.junctions.map((j) => j.target).sort(), ["mix:0", "trance:0"], "OR groups");
  assert.deepEqual(edges.start.map((s) => s.target).sort(), [...layout.entries].sort());
});

test("fog header counts reveal no totals", () => {
  const { graph, progress } = setup();
  assert.deepEqual(fogStats(graph, progress), { reached: 2, open: 2, topics: 3 });
});

test("unlock texts name only nodes the player sees", () => {
  const { graph, progress } = setup();
  assert.equal(unlockText(graph, progress, graph.nodes.get("deep:0")!), "Opens after 1 more scene in Relax L1");
  assert.equal(unlockText(graph, progress, graph.nodes.get("relax:2")!), "Opens after 1 more scene in Relax L1");
  assert.equal(unlockText(graph, progress, graph.nodes.get("fix:1")!), "Opens after paying $20");
  assert.equal(unlockText(graph, progress, graph.nodes.get("toll:0")!), "Opens after paying $50");
  // a hidden alternative is left out; nothing visible left -> generic text
  assert.equal(unlockText(graph, progress, graph.nodes.get("trance:0")!), "Opens after something still in the fog");
});

test("requirement lines of shown nodes skip hidden alternatives", () => {
  const { graph, progress } = setup();
  assert.deepEqual(shownRequirementLines(graph, progress, graph.nodes.get("mix:0")!), ["Relax L0 ✓"]);
  assert.deepEqual(shownRequirementLines(graph, progress, graph.nodes.get("relax:1")!), ["Relax L0 ✓"]);
  assert.deepEqual(shownRequirementLines(graph, progress, graph.nodes.get("relax:0")!), []);
});

test("fog panel contents per visibility", () => {
  const { graph, progress, visibility } = setup();
  const panel = (k: string) => fogPanel(graph, progress, visibility, k);
  assert.deepEqual(panel("deep:0"), {
    title: "Unknown level",
    subtitle: "",
    look: "ahead",
    stateText: "ahead",
    requires: [],
    unlock: "Opens after 1 more scene in Relax L1",
    secret: true,
  });
  const toll = panel("toll:0")!;
  assert.deepEqual([toll.title, toll.subtitle, toll.price, toll.secret], ["Unknown level", "", 50, true]);
  const fix = panel("fix:1")!;
  assert.deepEqual([fix.title, fix.subtitle, fix.price], ["Fix", "level 1", 20]);
  const mix = panel("mix:0")!;
  assert.deepEqual([mix.title, mix.subtitle, mix.look, mix.progress, mix.requires, mix.secret], [
    "Mix",
    "level 0",
    "open",
    "0 of 2 scenes",
    ["Relax L0 ✓"],
    false,
  ]);
  assert.deepEqual(panel("relax:0")!.requires, ["nothing (entry)"]);
  assert.equal(panel("trance:0"), undefined);
  assert.equal(panel("relax:3"), undefined);
});

test("nothing in the fog view names a topic the player has not entered", () => {
  const { graph, progress, visibility } = setup();
  const view = treeView(graph, progress, visibility, false);
  const texts: unknown[] = [view.nodes, view.topicLabels, [...view.knownTopics], fogStats(graph, progress)];
  for (const key of view.drawn) texts.push(fogPanel(graph, progress, visibility, key));
  const json = JSON.stringify(texts);
  // node keys are internal ids (the DOM never shows them); everything else is text
  assert.doesNotMatch(json.replace(/"key":"[^"]*"|"anchor":"[^"]*"/g, ""), SECRET_TOPICS);
});

test("depth rows: entered topics only, up to the reached level + 1", () => {
  const { graph, progress, visibility } = setup();
  const rows = fogDepthRows(graph, progress, visibility, (t) => topicDepth(graph, progress, t));
  assert.deepEqual(
    rows.map((r) => [r.topic, r.depth, r.segments.map((s) => `${s.key}=${s.state}`)]).sort(),
    [
      ["fix", 1, ["fix:0=complete", "fix:1=locked"]],
      ["mix", 0, ["mix:0=open"]],
      ["relax", 1, ["relax:0=complete", "relax:1=open", "relax:2=locked"]],
    ],
  );
});
