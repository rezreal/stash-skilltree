import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateLag } from "../../src/track/lag.ts";
import { ScriptBuilder, compositeScript, follow } from "./fixtures.ts";

const asLag = (s: { scriptMs: number; pos: number }[]) => s.map((x) => ({ t: x.scriptMs, pos: x.pos }));

describe("estimateLag", () => {
  const script = compositeScript();
  const active = { from: 3000, to: 15000 };

  it("finds a perfect follower's lag", () => {
    for (const lag of [0, 120, 250, 300, 480]) {
      const got = estimateLag(script, asLag(follow(script, { lagMs: lag, ...active })));
      assert.ok(got !== undefined && Math.abs(got - lag) <= 10, `lag ${lag} -> ${got}`);
    }
  });

  it("copes with noise, a slow sensor and a rough calibration", () => {
    const s = follow(script, { lagMs: 260, noise: 6, rateHz: 12, shape: (p) => 10 + 0.7 * p, ...active });
    const got = estimateLag(script, asLag(s));
    assert.ok(got !== undefined && Math.abs(got - 260) <= 25, `got ${got}`);
  });

  it("picks the first peak for periodic strokes", () => {
    // period 600 ms: lag 250 also correlates at 850 (outside) and the
    // reversed phase at 550; the true one is the first peak
    const b = new ScriptBuilder(0);
    b.strokes(90, 40, 300);
    const s = follow(b.actions, { lagMs: 250, from: 0, to: 12000 });
    const got = estimateLag(b.actions, asLag(s));
    assert.ok(got !== undefined && Math.abs(got - 250) <= 10, `got ${got}`);
    const b2 = new ScriptBuilder(0).strokes(90, 60, 200); // period 400: peaks at 250 and 650
    const got2 = estimateLag(b2.actions, asLag(follow(b2.actions, { lagMs: 250, from: 0, to: 12000 })));
    assert.ok(got2 !== undefined && Math.abs(got2 - 250) <= 10, `got ${got2}`);
  });

  it("is undefined without enough movement or samples", () => {
    const still = follow(script, { lagMs: 250, from: 0, to: 2500 }); // idle only
    assert.equal(estimateLag(script, asLag(still)), undefined);
    const few = follow(script, { lagMs: 250, from: 3000, to: 3500 });
    assert.equal(estimateLag(script, asLag(few)), undefined);
    const ignoring = follow(script, { lagMs: 250, ...active, shape: () => 30, noise: 10, seed: 9 });
    assert.equal(estimateLag(script, asLag(ignoring)), undefined);
  });
});
