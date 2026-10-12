import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calibrate } from "../../src/track/calibration.ts";
import { createPositionFilter } from "../../src/track/filter.ts";

// rest 60 mm (out), deepest 20 mm (in): readings shrink going in
const cal = calibrate(60, 20, "2026-01-01T00:00:00Z");
const mm = (pos: number) => 60 - (pos / 100) * 40;

describe("position filter", () => {
  it("does not flicker to fully in while backed off", () => {
    const f = createPositionFilter();
    // backed off: no echo, with stray readings near the deep end in between
    const raws = [0, 0, 18, 0, 21, 0, 0, 19, 0];
    const out = raws.map((r) => f.push(r, cal));
    assert.deepEqual(out, raws.map(() => 0));
    assert.equal(f.lost(), true);
  });

  it("comes back after a few consistent readings", () => {
    const f = createPositionFilter();
    f.push(0, cal);
    assert.equal(f.push(mm(50), cal), 0);
    assert.equal(f.push(mm(52), cal), 0);
    const p = f.push(mm(48), cal);
    assert.ok(Math.abs(p - 50) < 3, `back to ~50, got ${p}`);
    assert.equal(f.lost(), false);
  });

  it("drops a lone spike while tracking", () => {
    const f = createPositionFilter();
    f.push(mm(30), cal);
    f.push(mm(31), cal);
    const spike = f.push(mm(100), cal);
    assert.ok(spike < 40, `a single spike must not jump: ${spike}`);
    assert.ok(f.push(mm(32), cal) < 40);
  });

  it("follows real movement with a short delay", () => {
    const f = createPositionFilter();
    let p = 0;
    for (let pos = 0; pos <= 100; pos += 10) p = f.push(mm(pos), cal);
    assert.ok(p >= 90, `reaches the deep end: ${p}`);
  });
});
