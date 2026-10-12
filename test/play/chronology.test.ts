import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { interest, library, performer, scene } from "../core/fixtures.ts";
import { buildGraph } from "../../src/core/index.ts";
import type { SceneInput } from "../../src/core/types.ts";
import { chronology, chronologyAllowed, nextInLine } from "../../src/play/chronology.ts";

const done = { completedAt: "2024-02-01T00:00:00Z", completions: 1 };
const s = (id: string, performerIds: string[], date: string | undefined, extra: Partial<SceneInput> = {}) =>
  scene(id, [], { performerIds, date, ...extra });
const allowedIds = (scenes: SceneInput[]) => {
  const ok = chronologyAllowed(library({ scenes }));
  return scenes.filter((x) => ok(x.id)).map((x) => x.id);
};

describe("chronology", () => {
  it("a performer's clips go in date order across all their clips", () => {
    const scenes = [s("c", ["P"], "2024-03-01"), s("a", ["P"], "2024-01-01"), s("b", ["P"], "2024-02-01")];
    assert.deepEqual(allowedIds(scenes), ["a"]);
    const lib = library({ scenes });
    assert.deepEqual(nextInLine(lib, "P").map((x) => x.id), ["a"]);
    // watching a moves the line on; out-of-order completions don't skip a gap
    scenes[1] = { ...scenes[1], ...done };
    assert.deepEqual(allowedIds(scenes), ["a", "b"]);
    const outOfOrder = [s("a", ["P"], "2024-01-01"), s("b", ["P"], "2024-02-01", done), s("c", ["P"], "2024-03-01")];
    // b stays allowed (a repeat of a completed clip), c waits for a
    assert.deepEqual(allowedIds(outOfOrder), ["a", "b"]);
  });

  it("same-date clips don't order each other", () => {
    const scenes = [s("x2", ["P"], "2024-01-01"), s("x1", ["P"], "2024-01-01"), s("y", ["P"], "2024-01-02")];
    assert.deepEqual(allowedIds(scenes), ["x2", "x1"]);
    const c = chronology(library({ scenes }));
    assert.deepEqual(c.nextInLine("P").map((x) => x.id), ["x1", "x2"]);
    assert.equal(c.frontier("P"), "2024-01-01");
    assert.deepEqual(c.blockers("y"), ["P"]);
    // one of them watched: the other still holds y back
    scenes[1] = { ...scenes[1], ...done };
    assert.deepEqual(allowedIds(scenes), ["x2", "x1"]);
  });

  it("undated clips neither block nor are blocked", () => {
    const scenes = [s("u", ["P"], undefined), s("a", ["P"], "2024-01-01"), s("b", ["P"], "2024-02-01")];
    assert.deepEqual(allowedIds(scenes), ["u", "a"]);
    assert.deepEqual(nextInLine(library({ scenes }), "P").map((x) => x.id), ["a"]);
    // only undated clips left: nothing is in line
    assert.deepEqual(nextInLine(library({ scenes: [s("u", ["P"], undefined)] }), "P"), []);
  });

  it("a clip with several performers waits until it is next for every one of them", () => {
    const scenes = [
      s("pq", ["P", "Q"], "2024-02-01"),
      s("q0", ["Q"], "2024-01-15"),
      s("p0", ["P"], "2024-01-01", done),
      s("p1", ["P"], "2024-03-01"),
    ];
    // pq is next for P but not for Q; p1 waits for pq
    assert.deepEqual(allowedIds(scenes), ["q0", "p0"]);
    const c = chronology(library({ scenes }));
    assert.deepEqual(c.blockers("pq"), ["Q"]);
    assert.deepEqual(c.blockers("p1"), ["P"]);
    assert.deepEqual(c.nextInLine("P").map((x) => x.id), ["pq"]);
    scenes[1] = { ...scenes[1], ...done };
    assert.deepEqual(allowedIds(scenes), ["pq", "q0", "p0"]);
  });

  it("clips without performers and unknown ids are allowed; a graph works as source", () => {
    const lib = library({
      performers: [performer("P")],
      interestTags: [interest("t", "a", 0)],
      scenes: [scene("n", ["t"], { date: "2025-01-01" }), scene("a", ["t"], { performerIds: ["P"], date: "2024-01-01" }), scene("b", ["t"], { performerIds: ["P"], date: "2024-06-01" })],
    });
    const ok = chronologyAllowed(buildGraph(lib));
    assert.deepEqual(["n", "a", "b", "zzz"].map(ok), [true, true, false, true]);
  });
});
