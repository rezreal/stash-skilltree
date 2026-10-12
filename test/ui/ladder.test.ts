import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SetupTag } from "../../src/stash/tags.ts";
import {
  addToLadder,
  changedLevels,
  ladderCandidates,
  ladderChanges,
  ladderOf,
  ladderRows,
  ladderTopics,
  removeFromLadder,
  staleRequires,
  swapLevels,
} from "../../src/ui/ladder.ts";

const tag = (id: string, name: string, customFields: Record<string, unknown> = {}, aliases: string[] = []): SetupTag => ({
  id,
  name,
  aliases,
  sceneCount: 1,
  customFields,
});

const interest = (id: string, topic: string, level: number | string, extra: Record<string, unknown> = {}) =>
  tag(id, `${topic} ${level} #${id}`, { "st.kind": "interest", "st.topic": topic, "st.level": level, ...extra });

const tags: SetupTag[] = [
  interest("1", "Fixation", 0),
  interest("2", "fixation ", "1", { "st.need": 3, "st.paid": 40 }),
  interest("3", "fixation", 1),
  interest("4", "relax", 0, { "st.requires": "fixation:1" }),
  interest("5", "relax", 1, { "st.requires": "fixation:0|$10" }),
  tag("6", "Plain", { rating: 3 }, ["unset alias"]),
  tag("7", "Trigger", { "st.kind": "trigger", "st.trigger": "x", "st.trigger_role": "used" }),
  tag("8", "Plain two"),
];

describe("ladder reading", () => {
  it("lists topics of interest tags", () => {
    assert.deepEqual(ladderTopics(tags), ["fixation", "relax"]);
  });

  it("reads one topic, normalising the topic id", () => {
    assert.deepEqual([...ladderOf(tags, " FIXATION")], [["1", 0], ["2", 1], ["3", 1]]);
    assert.deepEqual([...ladderOf(tags, "new")], []);
  });

  it("rows cover 0..max plus an empty level, tags by name", () => {
    const rows = ladderRows(ladderOf(tags, "fixation"), tags);
    assert.deepEqual(
      rows.map((r) => [r.level, r.tags.map((t) => t.id)]),
      [[0, ["1"]], [1, ["2", "3"]], [2, []]],
    );
    assert.deepEqual(
      ladderRows(new Map(), tags).map((r) => r.level),
      [0],
    );
  });
});

describe("ladder edits", () => {
  const ladder = ladderOf(tags, "fixation");

  it("add, remove and swap return new maps", () => {
    assert.deepEqual([...addToLadder(ladder, "6", 2)].sort(), [["1", 0], ["2", 1], ["3", 1], ["6", 2]]);
    assert.deepEqual([...removeFromLadder(ladder, "2")], [["1", 0], ["3", 1]]);
    assert.deepEqual([...swapLevels(ladder, 0, 1)], [["1", 1], ["2", 0], ["3", 0]]);
    assert.deepEqual([...ladder], [["1", 0], ["2", 1], ["3", 1]], "input unchanged");
  });

  it("candidates: not on the topic, unconfigured or interest only", () => {
    assert.deepEqual(
      ladderCandidates(tags, ladder, "").map((t) => t.id),
      ["4", "5", "6", "8"],
    );
    assert.deepEqual(
      ladderCandidates(tags, ladder, "alias").map((t) => t.id),
      ["6"],
    );
    assert.deepEqual(
      ladderCandidates(tags, ladder, "", 2).map((t) => t.id),
      ["4", "5"],
    );
  });

  it("changedLevels compares level membership", () => {
    assert.deepEqual(changedLevels(ladder, ladder), []);
    assert.deepEqual(changedLevels(ladder, swapLevels(ladder, 0, 1)), [0, 1]);
    assert.deepEqual(changedLevels(ladder, addToLadder(ladder, "6", 3)), [3]);
  });
});

describe("ladderChanges", () => {
  it("no changes for the current assignment", () => {
    assert.deepEqual(ladderChanges(tags, "fixation", ladderOf(tags, "fixation")), []);
  });

  it("swapping levels renumbers only st.level", () => {
    const desired = swapLevels(ladderOf(tags, "fixation"), 0, 1);
    assert.deepEqual(ladderChanges(tags, "fixation", desired), [
      { tagId: "1", change: { set: { "st.level": 1 }, remove: [] } },
      { tagId: "2", change: { set: { "st.level": 0 }, remove: [] } },
      { tagId: "3", change: { set: { "st.level": 0 }, remove: [] } },
    ]);
  });

  it("adding an unconfigured tag makes it an interest tag of the topic", () => {
    const desired = addToLadder(ladderOf(tags, "fixation"), "6", 2);
    assert.deepEqual(ladderChanges(tags, " Fixation", desired), [
      { tagId: "6", change: { set: { "st.kind": "interest", "st.topic": "fixation", "st.level": 2 }, remove: [] } },
    ]);
  });

  it("adding an interest tag of another topic moves it, keeping its other fields", () => {
    const desired = addToLadder(ladderOf(tags, "fixation"), "4", 2);
    assert.deepEqual(ladderChanges(tags, "fixation", desired), [
      { tagId: "4", change: { set: { "st.topic": "fixation", "st.level": 2 }, remove: [] } },
    ]);
  });

  it("removing a tag removes its config keys but keeps player keys", () => {
    const desired = removeFromLadder(ladderOf(tags, "fixation"), "2");
    assert.deepEqual(ladderChanges(tags, "fixation", desired), [
      { tagId: "2", change: { set: {}, remove: ["st.kind", "st.topic", "st.level", "st.need"] } },
    ]);
  });

  it("builds a new topic", () => {
    const desired = addToLadder(addToLadder(new Map(), "6", 0), "8", 1);
    assert.deepEqual(ladderChanges(tags, "Deep Relax", desired), [
      { tagId: "6", change: { set: { "st.kind": "interest", "st.topic": "deep relax", "st.level": 0 }, remove: [] } },
      { tagId: "8", change: { set: { "st.kind": "interest", "st.topic": "deep relax", "st.level": 1 }, remove: [] } },
    ]);
  });
});

describe("staleRequires", () => {
  it("names tags whose st.requires point at levels that change", () => {
    const ladder = ladderOf(tags, "fixation");
    assert.deepEqual(staleRequires(tags, "fixation", ladder), []);
    assert.deepEqual(staleRequires(tags, "fixation", swapLevels(ladder, 0, 1)), [
      '"relax 0 #4" requires fixation:1, whose tags change',
      '"relax 1 #5" requires fixation:0, whose tags change',
    ]);
    assert.deepEqual(staleRequires(tags, "fixation", addToLadder(ladder, "6", 2)), []);
  });
});
