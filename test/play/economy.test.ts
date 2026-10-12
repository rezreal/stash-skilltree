import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { interest, library, scene, spendMarker } from "../core/fixtures.ts";
import {
  computeLedger,
  computeStreak,
  effortScore,
  estimateEarn,
  repeatFactor,
  rewardFor,
  spendCost,
  streakBonus,
} from "../../src/play/economy.ts";
import { DEFAULT_POLICY } from "../../src/play/types.ts";
import type { Streak } from "../../src/play/types.ts";

/** ISO string of a local date/time. */
const local = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString();
const noStreak: Streak = { days: 0, bonus: 1, activeToday: false };

describe("computeLedger", () => {
  it("sums scenes and paid nodes (max per node, each tag once)", () => {
    const lib = library({
      interestTags: [
        interest("t1", "fixation", 1, { paid: 60 }),
        interest("t2", "Fixation", 1, { paid: 40 }),
        interest("t3", "deepening", 2, { paid: 25 }),
        interest("t4", "relax", 0),
      ],
      scenes: [
        scene("a", [], { earned: 30, spent: 10, completedAt: "2024-03-02T10:00:00Z" }),
        scene("b", [], { earned: 50, spent: 0, completedAt: "2024-03-01T10:00:00Z" }),
        scene("c", [], { earned: 0 }),
      ],
    });
    const l = computeLedger(lib);
    assert.equal(l.earned, 80);
    assert.equal(l.spent, 10);
    assert.equal(l.paid, 85);
    assert.equal(l.balance, -15);
    assert.deepEqual(
      l.entries.map((e) => [e.kind, e.amount, e.at, e.sceneId ?? e.node]),
      [
        ["paid", 60, "", "fixation:1"],
        ["paid", 25, "", "deepening:2"],
        ["earned", 50, "2024-03-01T10:00:00Z", "b"],
        ["earned", 30, "2024-03-02T10:00:00Z", "a"],
        ["spent", 10, "2024-03-02T10:00:00Z", "a"],
      ],
    );
  });
});

describe("computeStreak", () => {
  const now = new Date(2024, 4, 10, 20);
  const done = (...days: number[]) =>
    library({ scenes: days.map((d, i) => scene(`s${i}`, [], { completedAt: local(2024, 5, d) })) });

  it("counts consecutive days ending today", () => {
    const s = computeStreak(done(10, 9, 8, 6), now);
    assert.deepEqual(s, { days: 3, bonus: 1.1, activeToday: true });
  });

  it("may end yesterday", () => {
    assert.deepEqual(computeStreak(done(9, 8), now), { days: 2, bonus: 1, activeToday: false });
  });

  it("is broken by a gap before yesterday", () => {
    assert.deepEqual(computeStreak(done(8, 7, 6), now), { days: 0, bonus: 1, activeToday: false });
  });

  it("rest days bridge gaps", () => {
    assert.equal(computeStreak(done(10, 8, 6, 3), now, { restDays: 1 }).days, 3);
    assert.equal(computeStreak(done(8, 7), now, { restDays: 1 }).days, 2);
  });

  it("ignores several completions on one day and future dates", () => {
    assert.equal(computeStreak(done(10, 10, 9, 11), now).days, 2);
  });

  it("bonus steps", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 30].map(streakBonus), [1, 1, 1.1, 1.1, 1.2, 1.2, 1.3, 1.3]);
  });
});

describe("rewards", () => {
  it("repeat factor halves with a floor", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 10].map(repeatFactor), [1, 0.5, 0.25, 0.125, 0.1, 0.1]);
  });

  it("multiplies base, quality, multiplier, repeat and streak", () => {
    const r = rewardFor({
      scene: scene("1", [], { durationSec: 1200, completions: 1 }),
      quality: 0.9,
      policy: { ...DEFAULT_POLICY, rewardMult: 2 },
      streak: { days: 7, bonus: 1.3, activeToday: true },
    });
    assert.deepEqual(r, { base: 20, quality: 0.9, rewardMult: 2, repeatFactor: 0.5, streakBonus: 1.3, total: 23 });
  });

  it("base is at least 1", () => {
    assert.equal(rewardFor({ scene: scene("1", [], { durationSec: 10 }), quality: 1, policy: DEFAULT_POLICY, streak: noStreak }).total, 1);
  });

  it("daily cap cuts the total", () => {
    const r = rewardFor({ scene: scene("1", [], { durationSec: 1800 }), quality: 1, policy: DEFAULT_POLICY, streak: noStreak, dailyCap: 100, earnedToday: 90 });
    assert.equal(r.total, 10);
    assert.equal(r.uncapped, 30);
    const none = rewardFor({ scene: scene("1", [], { durationSec: 1800 }), quality: 1, policy: DEFAULT_POLICY, streak: noStreak, dailyCap: 100, earnedToday: 120 });
    assert.equal(none.total, 0);
    const under = rewardFor({ scene: scene("1", [], { durationSec: 1800 }), quality: 1, policy: DEFAULT_POLICY, streak: noStreak, dailyCap: 100, earnedToday: 10 });
    assert.equal(under.total, 30);
    assert.equal(under.uncapped, undefined);
  });

  it("estimateEarn assumes quality 0.8", () => {
    assert.equal(estimateEarn(scene("1", [], { durationSec: 600 }), DEFAULT_POLICY, noStreak), 8);
  });

  it("spend cost sums spend markers", () => {
    const s = scene("1", [], { markers: [spendMarker("a", "pay 30"), spendMarker("b", "$20"), { id: "c", title: "99", seconds: 1 }] });
    assert.equal(spendCost(s), 50);
  });

  it("effort grows with prompts, interactivity and length", () => {
    const plain = scene("1", [], { durationSec: 600 });
    const prompts = scene("2", [], {
      durationSec: 600,
      markers: [
        { id: "a", title: "x", seconds: 1, check: "repeat" },
        { id: "b", title: "x", seconds: 2, check: "gaze" },
        spendMarker("c", "10"),
      ],
    });
    const interactive = scene("3", [], { durationSec: 600, interactive: true });
    assert.equal(effortScore(plain, DEFAULT_POLICY), 2);
    assert.equal(effortScore(prompts, DEFAULT_POLICY), 4);
    assert.equal(effortScore(interactive, DEFAULT_POLICY), 5);
    assert.equal(effortScore(plain, { ...DEFAULT_POLICY, rules: ["track"] }), 5);
  });
});
