import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { guideFrame } from "../../src/track/guide.ts";
import { positionAt } from "../../src/track/normalize.ts";
import { segment } from "../../src/track/sections.ts";
import { compositeScript } from "./fixtures.ts";

const actions = compositeScript();
const sections = segment(actions);
const frame = (scriptMs: number, lagMs = 250, extra: { current?: number; previewMs?: number } = {}) =>
  guideFrame({ actions, sections, scriptMs, lagMs, ...extra });

describe("guideFrame", () => {
  it("targets the script at now - lag, the reference the scorer uses", () => {
    assert.equal(frame(3450).target, positionAt(actions, 3200));
    assert.equal(frame(3450).target, 40);
    assert.equal(frame(3450, 0).target, positionAt(actions, 3450));
  });

  it("gives the direction from the slope and the section kind", () => {
    assert.equal(frame(1000).direction, "idle");
    assert.equal(frame(3450).direction, "in"); // 3200: rising 0 -> 80
    assert.equal(frame(3850).direction, "out"); // 3600: falling
    assert.equal(frame(16000).direction, "hold");
    assert.equal(frame(20000).direction, "out"); // ramp down
    assert.equal(frame(12000).direction, "in");
    assert.equal(frame(16000).section?.kind, "hold");
  });

  it("shows hold progress", () => {
    assert.equal(frame(15250).holdProgress, 0);
    assert.equal(frame(17250).holdProgress, 0.5);
    assert.equal(frame(3450).holdProgress, undefined);
  });

  it("previews the next seconds from the target on", () => {
    const f = frame(3250, 250, { previewMs: 1000 }); // te = 3000
    assert.deepEqual(f.preview, [
      [0, 0],
      [400, 80],
      [800, 0],
      [1000, 40],
    ]);
    const end = frame(30000);
    assert.deepEqual(end.preview, [
      [0, 0],
      [3000, 0],
    ]);
  });

  it("passes the current position through", () => {
    assert.equal(frame(1000).current, undefined);
    assert.equal(frame(1000, 250, { current: 12 }).current, 12);
  });
});
