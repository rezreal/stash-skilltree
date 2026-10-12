import { test } from "node:test";
import assert from "node:assert/strict";
import type { Graph, GraphNode, MarkerInput, NodeKey, NodeProgress, Progress, SceneInput, Visibility } from "../../src/core/types.ts";
import { DEFAULT_POLICY, type WatchPolicy } from "../../src/play/types.ts";
import {
  abortReasonText,
  blockedText,
  checkChips,
  costBadge,
  depthRows,
  earnText,
  isExposureOnly,
  ledgerAmount,
  ledgerLabel,
  newlyCompleted,
  newlyVisible,
  phaseView,
  previousExposure,
  promptMarkers,
  promptsNeeded,
  reasonsText,
  recentEntries,
  watchButtonLabel,
} from "../../src/player/view.ts";

const policy = (extra: Partial<WatchPolicy> = {}): WatchPolicy => ({ ...DEFAULT_POLICY, ...extra });
const marker = (id: string, check?: MarkerInput["check"]): MarkerInput => ({ id, title: "", seconds: 0, check });

test("checkChips: policy rules first, then prompt kinds in a fixed order", () => {
  assert.deepEqual(checkChips(policy(), []), ["attention"]);
  assert.deepEqual(
    checkChips(policy({ rules: ["attention", "prompts"] }), [
      marker("1", "spend"),
      marker("2", "gaze"),
      marker("3", "repeat"),
      marker("4", "gaze"),
      marker("5"),
    ]),
    ["attention", "repeat-after-me", "look-at prompts", "spend prompt"],
  );
  assert.deepEqual(checkChips(policy({ rules: ["exposure"], minMinutes: 60 }), []), ["loop · 60 min"]);
  assert.deepEqual(checkChips(policy({ rules: ["attention", "track"] }), []), ["attention", "track"]);
  // without the prompts rule only spend prompts apply
  assert.deepEqual(checkChips(policy(), [marker("1", "gaze"), marker("2", "spend")]), ["attention", "spend prompt"]);
});

test("reasonsText makes sentences", () => {
  assert.equal(
    reasonsText(["counts toward Deepening L3 (2 of 3)", " next Fixation scene for this performer ", "", "done!"]),
    "Counts toward Deepening L3 (2 of 3). Next Fixation scene for this performer. Done!",
  );
  assert.equal(reasonsText([]), "");
});

test("cost badge, earn line and button label", () => {
  assert.equal(costBadge({ price: 0, spendCost: 0 }), undefined);
  assert.equal(costBadge({ price: 60, spendCost: 0 }), "opens for 60");
  assert.equal(costBadge({ price: 0, spendCost: 30 }), "spend 30");
  assert.equal(costBadge({ price: 60, spendCost: 30 }), "opens for 60 · spend 30");
  assert.equal(earnText({ estimatedEarn: 11.6, spendCost: 0 }), "earns ~12");
  assert.equal(earnText({ estimatedEarn: 12, spendCost: 30 }), "earns ~12 · asks you to spend 30");
  assert.equal(watchButtonLabel({ price: 0 }), "Watch");
  assert.equal(watchButtonLabel({ price: 60 }), "Pay 60 & watch");
  assert.match(blockedText({ node: "triggers:2", cost: 120, balance: 85 }), /^Triggers L2 costs 120 and you have 85\./);
});

function node(topic: string, level: number): GraphNode {
  return {
    key: `${topic}:${level}`,
    topic,
    level,
    tagIds: [],
    requires: [],
    explicitRequires: [],
    need: 2,
    sceneIds: [],
    paid: 0,
  };
}

function graphOf(nodes: GraphNode[], scenes: SceneInput[] = []): Graph {
  return {
    nodes: new Map(nodes.map((n) => [n.key, n])),
    topics: [...new Set(nodes.map((n) => n.topic))],
    scenes: new Map(scenes.map((s) => [s.id, s])),
    performers: new Map(),
    sceneNodes: new Map(),
    buildIssues: [],
  };
}

const prog = (state: NodeProgress["state"]): NodeProgress => ({ state, completed: 0, need: 2 });

test("depthRows: only visible levels, topics without any are left out", () => {
  const g = graphOf([node("relax", 0), node("relax", 1), node("relax", 2), node("deep", 0), node("hidden", 0)]);
  const progress: Progress = new Map([
    ["relax:0", prog("complete")],
    ["relax:1", prog("open")],
    ["relax:2", prog("locked")],
    ["deep:0", prog("open")],
    ["hidden:0", prog("locked")],
  ]);
  const vis = new Map<NodeKey, Visibility>([
    ["relax:0", "shown"],
    ["relax:1", "shown"],
    ["relax:2", "hidden"],
    ["deep:0", "shown"],
    ["hidden:0", "hidden"],
  ]);
  const rows = depthRows(g, progress, vis, (t) => (t === "relax" ? 1 : 0));
  assert.deepEqual(
    rows.map((r) => [r.topic, r.depth, r.segments.map((s) => s.state)]),
    [
      ["relax", 1, ["complete", "open"]],
      ["deep", 0, ["open"]],
    ],
  );
});

test("newlyVisible and newlyCompleted compare before and after", () => {
  const before = new Map<NodeKey, Visibility>([
    ["a:0", "shown"],
    ["a:1", "hidden"],
    ["b:0", "hidden"],
  ]);
  const after = new Map<NodeKey, Visibility>([
    ["a:0", "shown"],
    ["a:1", "ahead"],
    ["b:0", "gate"],
    ["c:0", "shown"],
    ["d:0", "hidden"],
  ]);
  assert.deepEqual(newlyVisible(before, after), ["a:1", "b:0", "c:0"]);
  const pb: Progress = new Map([
    ["a:0", prog("open")],
    ["a:1", prog("complete")],
  ]);
  const pa: Progress = new Map([
    ["a:0", prog("complete")],
    ["a:1", prog("complete")],
    ["b:0", prog("open")],
  ]);
  assert.deepEqual(newlyCompleted(pb, pa), ["a:0"]);
});

test("ledger helpers", () => {
  const scenes = new Map<string, SceneInput>([
    [
      "s1",
      {
        id: "s1",
        title: "Trainer clip",
        durationSec: 60,
        performerIds: [],
        tagIds: [],
        interactive: false,
        completions: 1,
        earned: 10,
        spent: 0,
        markers: [],
      },
    ],
  ]);
  assert.equal(ledgerLabel({ at: "x", amount: 38, kind: "earned", sceneId: "s1" }, scenes), "Trainer clip");
  assert.equal(ledgerLabel({ at: "x", amount: 50, kind: "spent", sceneId: "s1" }, scenes), "Spent in Trainer clip");
  assert.equal(ledgerLabel({ at: "x", amount: 60, kind: "paid", node: "triggers:1" }, scenes), "Opened Triggers L1");
  assert.equal(ledgerLabel({ at: "x", amount: 5, kind: "earned", sceneId: "gone" }, scenes), "Scene gone");
  assert.equal(ledgerAmount({ at: "x", amount: 50, kind: "spent" }), -50);
  assert.equal(ledgerAmount({ at: "x", amount: 60, kind: "paid" }), -60);
  assert.equal(ledgerAmount({ at: "x", amount: 12, kind: "earned" }), 12);
  const recent = recentEntries(
    [
      { at: "2026-01-01", amount: 1, kind: "earned" },
      { at: "2026-03-01", amount: 3, kind: "earned" },
      { at: "2026-02-01", amount: 2, kind: "earned" },
    ],
    2,
  );
  assert.deepEqual(recent.map((e) => e.amount), [3, 2]);
});

test("player helpers", () => {
  assert.equal(isExposureOnly(policy({ rules: ["exposure"] })), true);
  assert.equal(isExposureOnly(policy({ rules: ["exposure", "prompts"] })), true);
  assert.equal(isExposureOnly(policy({ rules: ["attention"] })), false);
  assert.equal(isExposureOnly(policy({ rules: ["exposure", "track"] })), false);
  assert.equal(promptsNeeded(policy({ promptsMin: 0.75 }), 6), 5);
  assert.equal(promptsNeeded(policy({ promptsMin: 0.75 }), 4), 3);
  assert.equal(promptsNeeded(policy(), 0), 0);
  assert.deepEqual(promptMarkers([marker("1", "spend"), marker("2", "gaze"), marker("3")]).map((m) => m.id), ["2"]);
  assert.equal(abortReasonText("user"), "You stopped the clip.");
  assert.equal(abortReasonText("inattention-timeout"), "You were away from the video for too long.");
  assert.equal(abortReasonText(undefined), "The session was stopped.");
  assert.equal(phaseView("paused", policy(), "attention").label, "Paused");
  assert.equal(phaseView("paused", policy(), "user").tone, "muted");
  assert.equal(phaseView("playing", policy(), "spend").label, "Spend prompt");
  const s = { id: "x" } as SceneInput;
  assert.equal(previousExposure(s), 0);
  assert.equal(previousExposure({ ...s, exposureSec: 120 } as SceneInput), 120);
});
