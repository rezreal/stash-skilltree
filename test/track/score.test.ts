import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTrackScorer, sectionAt } from "../../src/track/score.ts";
import type { TrackSample } from "../../src/track/score.ts";
import { segment } from "../../src/track/sections.ts";
import type { Action, Section, TrackLimits, TrackScore } from "../../src/track/types.ts";
import { ScriptBuilder, compositeScript, follow } from "./fixtures.ts";
import type { FollowOptions } from "./fixtures.ts";

const script = compositeScript();
const sections = segment(script);

function run(
  samples: TrackSample[],
  o: { lagMs?: number; sensorRateHz?: number; limits?: TrackLimits; actions?: Action[]; sections?: Section[] } = {},
): TrackScore {
  const actions = o.actions ?? script;
  const opts: Parameters<typeof createTrackScorer>[0] = { actions, sections: o.sections ?? segment(actions), lagMs: o.lagMs ?? 250 };
  if (o.sensorRateHz !== undefined) opts.sensorRateHz = o.sensorRateHz;
  if (o.limits) opts.limits = o.limits;
  const sc = createTrackScorer(opts);
  for (const s of samples) sc.push(s);
  return sc.result();
}

const byKind = (r: TrackScore, kind: Section["kind"]) => r.sections.filter((s) => s.section.kind === kind);
const followRun = (o: FollowOptions = {}, s: Parameters<typeof run>[1] = {}) => run(follow(script, o), s);

describe("sectionAt", () => {
  it("finds the section containing a time", () => {
    assert.equal(sectionAt(sections, 0)?.kind, "idle");
    assert.equal(sectionAt(sections, 2999)?.kind, "idle");
    assert.equal(sectionAt(sections, 3000)?.kind, "stroke");
    assert.equal(sectionAt(sections, 16000)?.kind, "hold");
    assert.equal(sectionAt(sections, 24000)?.kind, "idle");
    assert.equal(sectionAt(sections, 24001), undefined);
    assert.equal(sectionAt(sections, -1), undefined);
    assert.equal(sectionAt([], 0), undefined);
  });
});

describe("track scorer", () => {
  it("a perfect follower with 250 ms lag scores 1", () => {
    const r = followRun({ lagMs: 250 });
    assert.equal(r.overall, 1);
    assert.deepEqual(r.strokes, { followed: 20, total: 20 });
    assert.deepEqual(r.holds, { followed: 1, total: 1 });
    assert.equal(r.ramps, 1);
    assert.equal(r.lagMs, 250);
    for (const s of byKind(r, "idle")) assert.equal(s.score, undefined);
  });

  it("without lag compensation the same follower loses the strokes", () => {
    const r = followRun({ lagMs: 600 });
    assert.ok(r.strokes.followed <= 4, JSON.stringify(r.strokes));
    assert.ok((r.overall ?? 1) < 0.7);
    const fixed = followRun({ lagMs: 600 }, { lagMs: 600 });
    assert.equal(fixed.overall, 1);
  });

  it("timing within +-250 ms of the lag still counts", () => {
    const r = followRun({ lagMs: 450 }); // 200 ms later than assumed
    assert.ok(r.strokes.followed >= 16, JSON.stringify(r.strokes));
  });

  it("a sloppy follower (shallow strokes, wrong depth) fails", () => {
    const r = followRun({ shape: (p) => 30 + 0.4 * (p - 30) });
    assert.equal(r.strokes.followed, 0);
    assert.equal(r.holds.followed, 0);
    assert.ok((r.overall ?? 1) < 0.4, `overall ${r.overall}`);
  });

  it("strokes covering 60 % of the range count, 50 % don't", () => {
    assert.equal(followRun({ shape: (p) => 0.65 * p }).strokes.followed, 20);
    assert.equal(followRun({ shape: (p) => 0.5 * p }).strokes.followed, 0);
  });

  it("a follower who skips the hold fails it", () => {
    const r = followRun({ shape: (p, t) => (t > 15250 && t < 19250 ? 0 : p) });
    const hold = byKind(r, "hold")[0];
    assert.equal(hold.score, 0);
    assert.match(hold.detail ?? "", /left it/);
    assert.deepEqual(r.holds, { followed: 0, total: 1 });
    assert.deepEqual(r.strokes, { followed: 20, total: 20 });
    assert.ok((r.overall ?? 1) < 0.8);
  });

  it("a hold left for more than 1 s fails even when mostly inside", () => {
    // 4 s hold, entry 0.5 s, out for 1.2 s in the middle: 66 % inside, broken
    const r = followRun({ shape: (p, t) => (t > 16600 && t < 17800 ? 30 : p) });
    const hold = byKind(r, "hold")[0];
    assert.ok(hold.score !== undefined && hold.score < 0.4, `score ${hold.score}`);
    assert.equal(r.holds.followed, 0);
    // a brief dip is fine
    const brief = followRun({ shape: (p, t) => (t > 16600 && t < 17000 ? 30 : p) });
    assert.equal(brief.holds.followed, 1);
  });

  it("noise doesn't hurt much", () => {
    const r = followRun({ noise: 4, seed: 7 });
    assert.ok((r.overall ?? 0) > 0.9, `overall ${r.overall}`);
    assert.ok(r.strokes.followed >= 19);
    assert.equal(r.holds.followed, 1);
  });

  it("ramps score by mean absolute error", () => {
    const r = followRun({ shape: (p, t) => ((t > 11250 && t < 15250) || (t > 19250 && t < 21250) ? p + 17.5 : p) });
    for (const s of byKind(r, "ramp")) assert.ok(s.score !== undefined && Math.abs(s.score - 0.5) < 0.05, `score ${s.score}`);
    assert.ok(r.ramps !== undefined && Math.abs(r.ramps - 0.5) < 0.05);
  });

  it("strokes too fast for the sensor are unscored, not failed", () => {
    const b = new ScriptBuilder(0).flat(1000).strokes(80, 30, 150).to(0, 1).flat(1000);
    const fast = { actions: b.actions };
    const slow = run(follow(b.actions, { rateHz: 10 }), { ...fast, sensorRateHz: 10 });
    const stroke = slow.sections.find((s) => s.section.kind === "stroke");
    assert.ok(stroke);
    assert.equal(stroke.score, undefined);
    assert.match(stroke.detail ?? "", /too fast/);
    assert.equal(slow.overall, undefined);
    // the rate is measured when not given
    const measured = run(follow(b.actions, { rateHz: 10 }), fast);
    assert.equal(measured.sections.find((s) => s.section.kind === "stroke")?.score, undefined);
    // a fast sensor resolves them
    const quick = run(follow(b.actions, { rateHz: 40 }), { ...fast, sensorRateHz: 40 });
    assert.equal(quick.sections.find((s) => s.section.kind === "stroke")?.score, 1);
  });

  it("sections beyond the limits are shown but not scored", () => {
    const r = followRun({ shape: () => 0 }, { limits: { maxDepth: 70, maxHoldSec: 3 } });
    const stroke = byKind(r, "stroke")[0];
    const hold = byKind(r, "hold")[0];
    assert.equal(stroke.score, undefined);
    assert.equal(stroke.section.unscored, true);
    assert.equal(stroke.detail, "beyond your limits");
    assert.equal(hold.score, undefined);
    assert.deepEqual(r.strokes, { followed: 0, total: 0 });
    assert.deepEqual(r.holds, { followed: 0, total: 0 });
    // only the ramps are left, and an idle user fails them
    assert.ok(r.overall !== undefined && r.overall < 0.3);
  });

  it("scores live: in-progress parts aren't scored yet", () => {
    const sc = createTrackScorer({ actions: script, sections, lagMs: 250 });
    const samples = follow(script);
    let i = 0;
    for (; samples[i].scriptMs < 2000; i++) sc.push(samples[i]);
    assert.equal(sc.result().overall, undefined);
    for (; samples[i].scriptMs < 6000; i++) sc.push(samples[i]);
    const mid = sc.result();
    const stroke = byKind(mid, "stroke")[0];
    assert.equal(stroke.score, undefined); // under half watched
    for (; samples[i].scriptMs < 8500; i++) sc.push(samples[i]);
    const later = sc.result();
    assert.ok(later.strokes.total > 0 && later.strokes.total < 20, JSON.stringify(later.strokes));
    assert.equal(later.strokes.followed, later.strokes.total);
    for (; i < samples.length; i++) sc.push(samples[i]);
    assert.equal(sc.result().overall, 1);
    assert.equal(sc.result(), sc.result()); // cached
  });

  it("seeking back doesn't count twice, and a better replay doesn't help", () => {
    const good = follow(script, { from: 0, to: 9000 });
    const bad = follow(script, { from: 9000 + 50, shape: () => 0 });
    const baseline = run([...good, ...bad]);
    // replay 4000..12000 perfectly after a seek back: 4000..9000 is ignored
    const replay = follow(script, { from: 4000, to: 12000 });
    const rest = follow(script, { from: 12000 + 50, shape: () => 0 });
    const seeked = run([...good, ...bad.filter((s) => s.scriptMs < 12000), ...replay, ...rest]);
    const strokeBase = byKind(baseline, "stroke")[0].score;
    const strokeSeek = byKind(seeked, "stroke")[0].score;
    assert.equal(strokeSeek, strokeBase);
    assert.deepEqual(seeked.strokes, baseline.strokes);
  });

  it("skipped parts have no data instead of failing", () => {
    const before = follow(script, { from: 0, to: 14000 });
    const after = follow(script, { from: 20000 });
    const r = run([...before, ...after]);
    const hold = byKind(r, "hold")[0];
    assert.equal(hold.score, undefined);
    assert.equal(hold.detail, "no data");
    assert.equal(r.holds.total, 0);
    assert.equal(r.overall, 1);
  });

  it("paused video (same script time) adds nothing", () => {
    const s = follow(script, { from: 0, to: 16000 });
    const paused = Array.from({ length: 200 }, () => ({ scriptMs: 16000, pos: 0 }));
    const a = run([...s, ...paused, ...follow(script, { from: 16050 })]);
    assert.equal(a.overall, 1);
  });

  it("weights the overall by watched duration", () => {
    // strokes perfect (8 s), everything else 0: ramps 6 s and hold 4 s fail
    const r = followRun({ shape: (p, t) => (t >= 3000 && t < 11400 ? p : 100 - p) });
    const parts = r.sections.filter((s) => s.score !== undefined);
    let w = 0;
    let sum = 0;
    for (const s of parts) {
      const d = s.section.end - s.section.start;
      w += d;
      sum += (s.score ?? 0) * d;
    }
    assert.ok(r.overall !== undefined && Math.abs(r.overall - sum / w) < 0.02, `${r.overall} vs ${sum / w}`);
  });

  it("changing the lag rescored everything", () => {
    const sc = createTrackScorer({ actions: script, sections, lagMs: 0 });
    for (const s of follow(script, { lagMs: 500 })) sc.push(s);
    assert.ok((sc.result().overall ?? 1) < 0.7);
    sc.setLag(500);
    assert.equal(sc.lag(), 500);
    assert.equal(sc.result().overall, 1);
    assert.equal(sc.result().lagMs, 500);
  });
});
