import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFunscript } from "../../src/funscript/parse.ts";
import { calibrate } from "../../src/track/calibration.ts";
import { positionAt } from "../../src/track/normalize.ts";
import { createTrackSession } from "../../src/track/session.ts";
import type { TrackSession } from "../../src/track/session.ts";
import type { Action } from "../../src/track/types.ts";
import { ScriptBuilder, rng } from "./fixtures.ts";

const NOW = "2026-10-12T10:00:00.000Z";
// sensor: 120 mm at rest, 40 mm at full depth
const cal = calibrate(120, 40, NOW);
const toRaw = (pos: number) => 120 - (pos / 100) * 80;

/** long script: idle, 30 s of strokes, hold, ramp, long idle */
function longScript(): Action[] {
  return new ScriptBuilder(0).flat(3000).strokes(80, 75, 400).to(50, 2000).flat(3000).to(0, 1500).flat(15000).actions;
}

/** plays the whole script at 1x, the user following with `lagMs`, sensor at `rateHz` */
function drive(
  session: TrackSession,
  script: Action[],
  o: { lagMs?: number; rateHz?: number; offset?: number; noise?: number; t0?: number } = {},
) {
  const lag = o.lagMs ?? 250;
  const dt = 1000 / (o.rateHz ?? 25);
  const r = rng(5);
  const end = script[script.length - 1].at + 1000;
  for (let ms = 0; ms <= end; ms += dt) {
    let p = positionAt(script, ms - lag) + (o.offset ?? 0);
    if (o.noise) p += (r() * 2 - 1) * o.noise;
    session.pushSample(toRaw(p), (o.t0 ?? 50_000) + ms, ms / 1000);
  }
}

describe("track session", () => {
  it("measures the lag and scores a good follower", () => {
    const script = longScript();
    const s = createTrackSession({ script, calibration: cal, limits: { maxDepth: 100, maxHoldSec: 10 } });
    assert.equal(s.lagMeasured(), false);
    assert.equal(s.lagMs(), 250);
    drive(s, script, { lagMs: 320, noise: 2 });
    assert.equal(s.lagMeasured(), true);
    // the follower's 320 ms plus about one sample (40 ms) from the position filter's median
    assert.ok(Math.abs(s.lagMs() - 360) <= 15, `lag ${s.lagMs()}`);
    const r = s.score();
    assert.ok((r.overall ?? 0) > 0.9, `overall ${r.overall}`);
    assert.equal(r.lagMs, s.lagMs());
    assert.ok(Math.abs((s.sensorRate() ?? 0) - 25) < 1);
  });

  it("reads a funscript as depth = 100 - pos, an inverted one as is", () => {
    const f = parseFunscript({ actions: longScript().map((a) => ({ at: a.at, pos: 100 - a.pos })) });
    const s = createTrackSession({ script: f, calibration: cal });
    assert.equal(s.sections[0].kind, "idle");
    assert.equal(s.actions[0].pos, 0);
    const inv = createTrackSession({ script: parseFunscript({ inverted: true, actions: longScript() }), calibration: cal });
    assert.equal(inv.sections[0].kind, "idle");
  });

  it("applies the default limits", () => {
    // DEFAULT_LIMITS: no depth limit (100), max hold 8 s
    const deep = new ScriptBuilder(0).flat(1000).strokes(95, 10, 400).flat(1000).to(50, 1000).flat(9000).actions;
    const d = createTrackSession({ script: deep, calibration: cal });
    assert.equal(d.sections.find((x) => x.kind === "stroke")?.unscored, undefined); // 95 deep is scored
    assert.equal(d.sections.find((x) => x.kind === "hold")?.unscored, true); // 9 s hold > 8 s
    // a limit the user sets still applies
    const limited = createTrackSession({ script: deep, calibration: cal, limits: { maxDepth: 85, maxHoldSec: 8 } });
    assert.equal(limited.sections.find((x) => x.kind === "stroke")?.unscored, true);
  });

  it("uses a given lag without estimating", () => {
    const script = longScript();
    const s = createTrackSession({ script, calibration: cal, lagMs: 400, limits: { maxDepth: 100, maxHoldSec: 10 } });
    assert.equal(s.lagMeasured(), true);
    drive(s, script, { lagMs: 400 });
    assert.equal(s.lagMs(), 400);
    assert.ok((s.score().overall ?? 0) > 0.95);
  });

  it("corrects drift during idle sections", () => {
    const script = longScript();
    const s = createTrackSession({ script, calibration: cal });
    // the sensor reads 6 units deep at rest (it shifted since calibrating)
    drive(s, script, { offset: 6 });
    const c = s.calibration();
    assert.ok(c.drift > 4 && c.drift <= 6.5, `drift ${c.drift}`);
    assert.ok(s.pushSample(toRaw(6), 200_000, 40) < 2);
  });

  it("guides with the measured lag and the current position", () => {
    const script = longScript();
    const s = createTrackSession({ script, calibration: cal, lagMs: 300 });
    s.pushSample(toRaw(25), 1000, 3.2);
    const g = s.guide(3.5, 1100);
    assert.equal(g.target, positionAt(script, 3200));
    assert.ok(g.current !== undefined && Math.abs(g.current - 25) < 1e-9);
    assert.equal(g.direction, "in");
    assert.equal(s.guide(3.5, 5000).current, undefined); // stale
    assert.ok(s.guide(3.5).current !== undefined);
  });
});
