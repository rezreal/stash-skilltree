import { test } from "node:test";
import assert from "node:assert/strict";
import type { Graph, GraphNode, NodeProgress, Progress, Requirement, SceneInput } from "../../src/core/types.ts";
import {
  countBySeverity,
  gateCost,
  nodeAriaLabel,
  nodeScenes,
  performerOptions,
  progressText,
  scenesInTree,
  topicRows,
} from "../../src/ui/derive.ts";

function scene(id: string, extra: Partial<SceneInput> = {}): SceneInput {
  return {
    id,
    title: `Scene ${id}`,
    durationSec: 600,
    performerIds: [],
    tagIds: [],
    interactive: false,
    completions: 0,
    earned: 0,
    spent: 0,
    markers: [],
    ...extra,
  };
}

function gnode(key: string, extra: Partial<GraphNode> = {}): GraphNode {
  const [topic, l] = key.split(":");
  return {
    key,
    topic,
    level: Number(l),
    tagIds: [],
    requires: [],
    explicitRequires: [],
    need: 2,
    sceneIds: [],
    paid: 0,
    ...extra,
  };
}

function graphOf(nodes: GraphNode[], scenes: SceneInput[], topics: string[]): Graph {
  const sceneNodes = new Map<string, string[]>();
  for (const s of scenes) sceneNodes.set(s.id, []);
  for (const n of nodes) for (const id of n.sceneIds) sceneNodes.get(id)?.push(n.key);
  return {
    nodes: new Map(nodes.map((n) => [n.key, n])),
    topics,
    scenes: new Map(scenes.map((s) => [s.id, s])),
    performers: new Map([
      ["p1", { id: "p1", name: "Zoe" }],
      ["p2", { id: "p2", name: "Ann" }],
      ["p3", { id: "p3", name: "Unused" }],
    ]),
    sceneNodes,
    buildIssues: [],
  };
}

const prog = (state: NodeProgress["state"], completed = 0, need = 2): NodeProgress => ({ state, completed, need });

const sampleGraph = () =>
  graphOf(
    [
      gnode("a:0", { sceneIds: ["s1", "s2"] }),
      gnode("a:1", { sceneIds: ["s3"] }),
      gnode("b:0", { sceneIds: [] }),
    ],
    [
      scene("s1", { date: "2021-05-01", performerIds: ["p1"], completedAt: "2024-01-01" }),
      scene("s2", { date: "2020-01-01", performerIds: ["p2", "p1"] }),
      scene("s3", { performerIds: ["p2"] }),
      scene("orphan", { performerIds: ["p3"] }),
    ],
    ["a", "b"],
  );

test("scenesInTree ignores scenes without nodes", () => {
  assert.equal(scenesInTree(sampleGraph()), 3);
});

test("performerOptions: only performers of tree scenes, sorted by name", () => {
  assert.deepEqual(
    performerOptions(sampleGraph()).map((p) => p.name),
    ["Ann", "Zoe"],
  );
});

test("nodeScenes sorts by date (undated last) and filters by performer", () => {
  const g = sampleGraph();
  assert.deepEqual(nodeScenes(g, g.nodes.get("a:0")!).map((s) => s.id), ["s2", "s1"]);
  assert.deepEqual(nodeScenes(g, g.nodes.get("a:0")!, "p2").map((s) => s.id), ["s2"]);
});

test("countBySeverity", () => {
  const c = countBySeverity([
    { severity: "error", code: "x", message: "" },
    { severity: "warning", code: "y", message: "" },
    { severity: "error", code: "z", message: "" },
  ]);
  assert.deepEqual(c, { error: 2, warning: 1, info: 0 });
});

test("gateCost: cheapest price of each unmet group, largest of those, minus paid", () => {
  const requires: Requirement = [
    [{ kind: "level", topic: "a", level: 0 }],
    [{ kind: "level", topic: "b", level: 0 }, { kind: "cost", amount: 80 }, { kind: "cost", amount: 60 }],
    [{ kind: "cost", amount: 30 }],
  ];
  const progress: Progress = new Map([
    ["a:0", prog("complete", 2)],
    ["b:0", prog("open")],
  ]);
  assert.equal(gateCost(gnode("c:0", { requires }), progress), 60);
  assert.equal(gateCost(gnode("c:0", { requires, paid: 40 }), progress), 20);
  progress.set("b:0", prog("complete", 2));
  assert.equal(gateCost(gnode("c:0", { requires }), progress), 30);
});

test("progressText and aria labels", () => {
  assert.equal(progressText(prog("open", 1, 3)), "1/3");
  assert.equal(progressText(undefined), "–");
  const n = gnode("a:2");
  assert.equal(nodeAriaLabel(n, prog("open", 1, 3), "shown", 0), "a level 2, open, 1 of 3 scenes completed");
  assert.equal(nodeAriaLabel(n, prog("locked"), "ahead", 0), "Unknown level, not yet open");
  assert.equal(nodeAriaLabel(n, prog("locked"), "gate", 50), "a level 2, can be opened for 50 coins");
  assert.equal(nodeAriaLabel(n, prog("locked"), "gate", 50, false), "Unknown level, can be opened for 50 coins");
});

test("topicRows: one cell per level, empty where a topic has no such level", () => {
  const g = sampleGraph();
  const progress: Progress = new Map([
    ["a:0", prog("open", 1)],
    ["a:1", prog("locked")],
    ["b:0", prog("open")],
  ]);
  const { maxLevel, rows } = topicRows(g, progress, (t) => (t === "a" ? 0 : 0));
  assert.equal(maxLevel, 1);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows[0].cells.map((c) => c && `${c.scenes}:${progressText(c.progress)}`),
    ["2:1/2", "1:0/2"],
  );
  assert.equal(rows[1].cells[1], undefined);
});
