import { test } from "node:test";
import assert from "node:assert/strict";
import { triggerEdges, triggerScenes } from "../../src/core/index.ts";
import { library, scene, trigger } from "./fixtures.ts";

test("edges from installed to later used scenes of the same performer", () => {
  const lib = library({
    triggerTags: [trigger("ti", "Snap", "installed"), trigger("tu", " snap ", "used"), trigger("ou", "other", "used")],
    scenes: [
      scene("i1", ["ti"], { performerIds: ["p1"], date: "2024-01-01" }),
      scene("u1", ["tu"], { performerIds: ["p1"], date: "2024-02-01" }),
      scene("u0", ["tu"], { performerIds: ["p1"], date: "2023-12-01" }),
      scene("same", ["tu"], { performerIds: ["p1"], date: "2024-01-01" }),
      scene("u2", ["tu"], { performerIds: ["p1"], date: undefined }),
      scene("u3", ["tu", "ou"], { performerIds: ["p2"], date: "2025-01-01" }),
      scene("i2", ["ti"], { performerIds: ["p2", "p1"], date: undefined }),
      scene("both", ["ti", "tu"], { performerIds: ["p3"] }),
    ],
  });
  const edges = triggerEdges(lib).map((e) => `${e.performerId} ${e.from}->${e.to} ${e.trigger}`);
  assert.deepEqual(edges, [
    "p1 i1->u1 snap",
    "p1 i1->u2 snap",
    "p1 i2->u1 snap",
    "p1 i2->u0 snap",
    "p1 i2->same snap",
    "p1 i2->u2 snap",
    "p2 i2->u3 snap",
  ]);
});

test("triggerScenes groups by normalized name, sorted", () => {
  const lib = library({
    triggerTags: [trigger("b", "B", "used"), trigger("a", "a", "installed"), trigger("blank", "  ", "used")],
    scenes: [scene("s1", ["b", "b"]), scene("s2", ["a", "blank"])],
  });
  const t = triggerScenes(lib);
  assert.deepEqual([...t.keys()], ["a", "b"]);
  assert.deepEqual(t.get("b")!.used.map((s) => s.id), ["s1"]);
  assert.deepEqual(t.get("a")!.installed.map((s) => s.id), ["s2"]);
  assert.deepEqual(t.get("b")!.usedTagIds, ["b"]);
});
