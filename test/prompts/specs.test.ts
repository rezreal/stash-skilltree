import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { activeAt, promptSpecs } from "../../src/prompts/specs.ts";
import type { MarkerInput } from "../../src/prompts/types.ts";

const m = (over: Partial<MarkerInput>): MarkerInput => ({ id: "x", title: "", seconds: 10, ...over });

describe("promptSpecs", () => {
  it("uses default windows per check and keeps explicit ends", () => {
    const specs = promptSpecs([
      m({ id: "r", check: "repeat", title: "I obey", seconds: 1 }),
      m({ id: "g", check: "gaze", target: "eyes", seconds: 2 }),
      m({ id: "a", check: "action", action: "nod", seconds: 3 }),
      m({ id: "e", check: "gaze", target: "face", seconds: 4, endSeconds: 20 }),
    ]);
    assert.deepEqual(
      specs.map((s) => [s.markerId, s.start, s.end]),
      [["r", 1, 7], ["g", 2, 7], ["a", 3, 8], ["e", 4, 20]],
    );
    assert.equal(specs[1]!.target, "eyes");
    assert.equal(specs[2]!.action, "nod");
  });

  it("skips spend unless asked, unknown targets/actions, empty phrases and plain markers", () => {
    const markers = [
      m({ id: "s", check: "spend", title: "50" }),
      m({ id: "g", check: "gaze", target: "elbow" }),
      m({ id: "g2", check: "gaze" }),
      m({ id: "a", check: "action", action: "dance" }),
      m({ id: "r", check: "repeat", title: "  " }),
      m({ id: "plain" }),
      m({ id: "ok", check: "action", action: "kneel" }),
    ];
    assert.deepEqual(promptSpecs(markers).map((s) => s.markerId), ["ok"]);
    const withSpend = promptSpecs(markers, { includeSpend: true });
    assert.deepEqual(withSpend.map((s) => s.markerId), ["ok", "s"]); // same start: shorter window first
    assert.equal(withSpend[1]!.end, 20);
  });

  it("caps holdSec at 70% of the window and falls back on bad ends", () => {
    const [short, normal, bad] = promptSpecs([
      m({ id: "a", check: "gaze", target: "eyes", seconds: 0, endSeconds: 2 }),
      m({ id: "b", check: "gaze", target: "eyes", seconds: 5 }),
      m({ id: "c", check: "gaze", target: "eyes", seconds: 9, endSeconds: 8 }),
    ]);
    assert.ok(Math.abs(short!.holdSec - 1.4) < 1e-9);
    assert.equal(normal!.holdSec, 2);
    assert.equal(bad!.end, 14);
  });

  it("activeAt is start-inclusive, end-exclusive", () => {
    const specs = promptSpecs([m({ id: "a", check: "action", action: "still", seconds: 10, endSeconds: 12 })]);
    assert.equal(activeAt(specs, 9.99).length, 0);
    assert.equal(activeAt(specs, 10).length, 1);
    assert.equal(activeAt(specs, 12).length, 0);
  });
});

describe("promptSpecs: gaze eyes_closed", () => {
  it("accepts eyes_closed as a gaze target (and still as an action)", () => {
    const specs = promptSpecs([
      m({ id: "g", check: "gaze", target: "eyes_closed", seconds: 1 }),
      m({ id: "a", check: "action", action: "eyes_closed", seconds: 2 }),
    ]);
    assert.deepEqual(
      specs.map((s) => [s.markerId, s.check, s.target ?? s.action]),
      [
        ["g", "gaze", "eyes_closed"],
        ["a", "action", "eyes_closed"],
      ],
    );
  });
});
