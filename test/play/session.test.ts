import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scene } from "../core/fixtures.ts";
import {
  addInterval,
  attentionScore,
  createSession,
  exposureTotal,
  qualityScores,
  sessionQuality,
  step,
} from "../../src/play/session.ts";
import { DEFAULT_POLICY } from "../../src/play/types.ts";
import type { SessionEvent, SessionState, WatchPolicy } from "../../src/play/types.ts";

const TICK_MS = 250;

/** Drives a session: plays `seconds` of video from `from`, ticking 4x/s. */
function play(
  s: SessionState,
  opts: { from: number; seconds: number; attending?: boolean | ((t: number) => boolean); playing?: boolean; audible?: boolean; rate?: number },
): SessionState {
  const startMs = s.lastNowMs;
  const ticks = Math.round((opts.seconds * 1000) / TICK_MS);
  const rate = opts.rate ?? 1;
  for (let i = 1; i <= ticks; i++) {
    const nowMs = startMs + i * TICK_MS;
    const videoTime = opts.playing === false ? opts.from : opts.from + (i * TICK_MS * rate) / 1000;
    const attending = typeof opts.attending === "function" ? opts.attending(videoTime) : (opts.attending ?? true);
    const ev: SessionEvent = { type: "tick", nowMs, videoTime, attending, playing: opts.playing ?? true };
    if (opts.audible !== undefined) ev.audible = opts.audible;
    s = step(s, ev);
  }
  return s;
}

function start(durationSec = 100, policy: WatchPolicy = DEFAULT_POLICY, prior?: number): SessionState {
  let s = createSession({ scene: scene("1", [], { durationSec }), policy, nowMs: 0, ...(prior !== undefined ? { priorExposureSec: prior } : {}) });
  s = step(s, { type: "play", nowMs: 0 });
  // first tick sets the video position
  return step(s, { type: "tick", nowMs: 0, videoTime: 0, attending: true, playing: true });
}

describe("intervals", () => {
  it("merges overlapping and touching intervals", () => {
    let l = addInterval([], { start: 0, end: 1 });
    l = addInterval(l, { start: 5, end: 6 });
    l = addInterval(l, { start: 1, end: 2 });
    l = addInterval(l, { start: 3, end: 4 });
    assert.deepEqual(l, [
      { start: 0, end: 2 },
      { start: 3, end: 4 },
      { start: 5, end: 6 },
    ]);
    l = addInterval(l, { start: 1.5, end: 5.5 });
    assert.deepEqual(l, [{ start: 0, end: 6 }]);
    assert.deepEqual(addInterval(l, { start: 2, end: 2 }), l);
  });
});

describe("session", () => {
  it("starts ready and plays", () => {
    const s0 = createSession({ scene: scene("1", []), policy: DEFAULT_POLICY, nowMs: 0 });
    assert.equal(s0.phase, "ready");
    assert.equal(step(s0, { type: "play" }).phase, "playing");
  });

  it("autoplay: a playing tick starts the session", () => {
    const s0 = createSession({ scene: scene("1", []), policy: DEFAULT_POLICY, nowMs: 0 });
    assert.equal(step(s0, { type: "tick", nowMs: 250, videoTime: 0.25, attending: true, playing: true }).phase, "playing");
  });

  it("watching everything completes with full attention", () => {
    let s = start(100);
    s = play(s, { from: 0, seconds: 100 });
    assert.equal(s.phase, "playing");
    assert.deepEqual(s.attended, [{ start: 0, end: 100 }]);
    assert.equal(s.attendedFraction, 1);
    s = step(s, { type: "ended", nowMs: s.lastNowMs });
    assert.equal(s.phase, "complete");
    assert.equal(sessionQuality(s), 1);
  });

  it("seeks give no credit across the jump, and rewatching does not double count", () => {
    let s = start(100);
    s = play(s, { from: 0, seconds: 10 });
    // seek forward to 50
    s = step(s, { type: "tick", nowMs: s.lastNowMs + TICK_MS, videoTime: 50, attending: true, playing: true });
    s = play(s, { from: 50, seconds: 10 });
    assert.deepEqual(s.attended, [
      { start: 0, end: 10 },
      { start: 50, end: 60 },
    ]);
    // seek back to 5 and rewatch
    s = step(s, { type: "tick", nowMs: s.lastNowMs + TICK_MS, videoTime: 5, attending: true, playing: true });
    s = play(s, { from: 5, seconds: 10 });
    assert.deepEqual(s.attended, [
      { start: 0, end: 15 },
      { start: 50, end: 60 },
    ]);
    assert.equal(s.attendedFraction, 0.25);
    s = step(s, { type: "ended", nowMs: s.lastNowMs });
    assert.equal(s.phase, "aborted");
    assert.equal(s.abortReason, "attention-below-threshold");
  });

  it("grace -> pause -> resume", () => {
    let s = start(100);
    s = play(s, { from: 0, seconds: 10 });
    // look away: grace for 2 s
    s = step(s, { type: "tick", nowMs: s.lastNowMs + TICK_MS, videoTime: 10.25, attending: false, playing: true });
    assert.equal(s.phase, "grace");
    s = play(s, { from: 10.25, seconds: 1.5, attending: false });
    assert.equal(s.phase, "grace");
    assert.equal(s.pauseRequested, false);
    s = play(s, { from: 11.75, seconds: 0.75, attending: false });
    assert.equal(s.phase, "paused");
    assert.equal(s.pausedBy, "inattention");
    assert.equal(s.pauseRequested, true);
    // flag is one-shot
    s = step(s, { type: "tick", nowMs: s.lastNowMs + TICK_MS, videoTime: 12.25, attending: false, playing: false });
    assert.equal(s.pauseRequested, false);
    assert.equal(s.phase, "paused");
    // still away for 10 s: no abort yet
    s = play(s, { from: 12.25, seconds: 10, attending: false, playing: false });
    assert.equal(s.phase, "paused");
    // back
    s = step(s, { type: "tick", nowMs: s.lastNowMs + TICK_MS, videoTime: 12.25, attending: true, playing: false });
    assert.equal(s.phase, "playing");
    assert.equal(s.resumeRequested, true);
    assert.equal(s.pausedBy, undefined);
    s = step(s, { type: "tick", nowMs: s.lastNowMs + TICK_MS, videoTime: 12.25, attending: true, playing: true });
    assert.equal(s.resumeRequested, false);
    // no credit for the unattended span
    assert.deepEqual(s.attended, [{ start: 0, end: 10 }]);
  });

  it("a short look away only enters grace", () => {
    let s = start(100);
    s = play(s, { from: 0, seconds: 10, attending: (t) => !(t > 5 && t <= 6) });
    assert.equal(s.phase, "playing");
    assert.deepEqual(s.attended, [
      { start: 0, end: 5 },
      { start: 6, end: 10 },
    ]);
  });

  it("paused by inattention for longer than abortSec aborts", () => {
    let s = start(100);
    s = play(s, { from: 0, seconds: 5 });
    s = play(s, { from: 5, seconds: 3, attending: false });
    assert.equal(s.phase, "paused");
    s = play(s, { from: 8, seconds: 29.5, attending: false, playing: false });
    assert.equal(s.phase, "paused");
    s = play(s, { from: 8, seconds: 1, attending: false, playing: false });
    assert.equal(s.phase, "aborted");
    assert.equal(s.abortReason, "inattention-timeout");
    // terminal: further events are ignored
    assert.equal(step(s, { type: "play" }).phase, "aborted");
    assert.equal(step(s, { type: "ended", nowMs: s.lastNowMs }).phase, "aborted");
  });

  it("a pause by the viewer is undone when pausing is not allowed", () => {
    let s = start(100);
    s = play(s, { from: 0, seconds: 10 });
    s = step(s, { type: "pauseByUser" });
    assert.equal(s.phase, "playing");
    assert.equal(s.pausedBy, undefined);
    assert.equal(s.resumeRequested, true);
    assert.equal(s.pauseAttempts, 1);
    s = step(s, { type: "tick", nowMs: s.lastNowMs + TICK_MS, videoTime: 10.25, attending: true, playing: true });
    assert.equal(s.resumeRequested, false);
    assert.equal(s.pauseAttempts, 1);
  });

  it("user pause does not count against attention and has no abort timer", () => {
    let s = start(100, { ...DEFAULT_POLICY, allowUserPause: true });
    s = play(s, { from: 0, seconds: 50 });
    s = step(s, { type: "pauseByUser" });
    assert.equal(s.phase, "paused");
    assert.equal(s.pausedBy, "user");
    // away for ten minutes
    s = play(s, { from: 50, seconds: 600, attending: false, playing: false });
    assert.equal(s.phase, "paused");
    assert.equal(s.pauseRequested, false);
    // coming back does not auto-resume a user pause
    s = step(s, { type: "tick", nowMs: s.lastNowMs + TICK_MS, videoTime: 50, attending: true, playing: false });
    assert.equal(s.resumeRequested, false);
    s = step(s, { type: "play" });
    s = play(s, { from: 50, seconds: 50 });
    s = step(s, { type: "ended", nowMs: s.lastNowMs });
    assert.equal(s.phase, "complete");
    assert.equal(s.attendedFraction, 1);
  });

  it("a buffering video does not run the grace timer", () => {
    let s = start(100);
    s = play(s, { from: 0, seconds: 10 });
    s = play(s, { from: 10, seconds: 5, attending: false, playing: false });
    assert.equal(s.phase, "playing");
  });

  it("ended below the threshold aborts; at the threshold completes with quality 0.5", () => {
    let s = start(100);
    s = play(s, { from: 0, seconds: 100, attending: (t) => t <= 89 });
    s = step(s, { type: "ended", nowMs: s.lastNowMs });
    assert.equal(s.abortReason, "attention-below-threshold");

    s = start(100);
    s = play(s, { from: 0, seconds: 100, attending: (t) => t <= 90 });
    assert.ok(Math.abs(s.attendedFraction - 0.9) < 1e-9);
    s = step(s, { type: "ended", nowMs: s.lastNowMs });
    assert.equal(s.phase, "complete");
    assert.ok(Math.abs(sessionQuality(s) - 0.5) < 1e-9);
  });

  it("unknown duration uses the furthest video time", () => {
    let s = start(0);
    s = play(s, { from: 0, seconds: 20, attending: (t) => t <= 10 });
    assert.equal(s.maxVideoTime, 20);
    assert.equal(s.attendedFraction, 0.5);
  });

  it("declined spend aborts, accepted spend is recorded", () => {
    let s = start(100);
    s = step(s, { type: "spend", event: { markerId: "m1", amount: 10, at: 5, accepted: true } });
    assert.equal(s.phase, "playing");
    assert.equal(s.spends.length, 1);
    s = step(s, { type: "spend", event: { markerId: "m2", amount: 20, at: 9, accepted: false } });
    assert.equal(s.phase, "aborted");
    assert.equal(s.abortReason, "spend-declined");
  });

  it("explicit abort", () => {
    const s = step(start(100), { type: "abort", reason: "user", nowMs: 5 });
    assert.equal(s.phase, "aborted");
    assert.equal(s.abortReason, "user");
    assert.equal(s.endedAtMs, 5);
  });

  it("prompts: failing share aborts, passing share scores, latest result per marker wins", () => {
    const policy: WatchPolicy = { ...DEFAULT_POLICY, rules: ["attention", "prompts"] };
    let s = start(100, policy);
    s = play(s, { from: 0, seconds: 100 });
    s = step(s, { type: "prompt", result: { markerId: "a", passed: false } });
    s = step(s, { type: "prompt", result: { markerId: "b", passed: false } });
    assert.equal(step(s, { type: "ended", nowMs: s.lastNowMs }).abortReason, "prompts-below-threshold");
    s = step(s, { type: "prompt", result: { markerId: "a", passed: true } });
    s = step(s, { type: "prompt", result: { markerId: "b", passed: true } });
    s = step(s, { type: "prompt", result: { markerId: "c", passed: true } });
    s = step(s, { type: "prompt", result: { markerId: "d", passed: false } });
    assert.equal(s.prompts.length, 4);
    s = step(s, { type: "ended", nowMs: s.lastNowMs });
    assert.equal(s.phase, "complete");
    assert.deepEqual(qualityScores(s), { attention: 1, prompts: 0.75 });
    assert.equal(sessionQuality(s), 0.875);
  });

  it("prompts nobody reported are not scored", () => {
    const policy: WatchPolicy = { ...DEFAULT_POLICY, rules: ["attention", "prompts"] };
    let s = start(100, policy);
    s = play(s, { from: 0, seconds: 100 });
    s = step(s, { type: "ended", nowMs: s.lastNowMs });
    assert.equal(s.phase, "complete");
    assert.deepEqual(qualityScores(s), { attention: 1 });
  });

  it("track: the latest reported score is scored and checked against trackMin", () => {
    const policy: WatchPolicy = { ...DEFAULT_POLICY, rules: ["attention", "track"] };
    assert.equal(DEFAULT_POLICY.trackMin, 0.7);
    let s = start(100, policy);
    s = play(s, { from: 0, seconds: 100 });
    s = step(s, { type: "track", score: 0.4 });
    assert.equal(s.track, 0.4);
    const failed = step(s, { type: "ended", nowMs: s.lastNowMs });
    assert.equal(failed.phase, "aborted");
    assert.equal(failed.abortReason, "track-below-threshold");
    s = step(s, { type: "track", score: 0.8 });
    s = step(s, { type: "ended", nowMs: s.lastNowMs });
    assert.equal(s.phase, "complete");
    assert.deepEqual(qualityScores(s), { attention: 1, track: 0.8 });
    assert.ok(Math.abs(sessionQuality(s) - 0.9) < 1e-9);
  });

  it("track: scores are clamped, a stricter trackMin applies, and no score means not scored", () => {
    const policy: WatchPolicy = { ...DEFAULT_POLICY, rules: ["track"], trackMin: 0.9 };
    let s = start(100, policy);
    s = play(s, { from: 0, seconds: 100 });
    assert.equal(step(s, { type: "track", score: 7 }).track, 1);
    assert.equal(step(s, { type: "track", score: Number.NaN }).track, undefined);
    assert.equal(step(step(s, { type: "track", score: 0.85 }), { type: "ended", nowMs: s.lastNowMs }).abortReason, "track-below-threshold");
    const none = step(s, { type: "ended", nowMs: s.lastNowMs });
    assert.equal(none.phase, "complete");
    assert.deepEqual(qualityScores(none), {});
    // a track score without the track rule is ignored
    let plain = start(100);
    plain = play(plain, { from: 0, seconds: 100 });
    plain = step(step(plain, { type: "track", score: 0.1 }), { type: "ended", nowMs: plain.lastNowMs });
    assert.equal(plain.phase, "complete");
    assert.deepEqual(qualityScores(plain), { attention: 1 });
  });

  it("exposure-only loop: no attention needed, counts audible play across wraps, adds prior exposure", () => {
    const policy: WatchPolicy = { ...DEFAULT_POLICY, rules: ["exposure"], minMinutes: 2 };
    let s = start(30, policy, 30);
    // not attending, background tab: never paused
    s = play(s, { from: 0, seconds: 29, attending: false });
    assert.equal(s.phase, "playing");
    assert.equal(s.pauseRequested, false);
    assert.ok(Math.abs(s.exposureSec - 29) < 1e-9);
    // wrap: 29 -> 0.5 is 1.5 s of play
    s = step(s, { type: "tick", nowMs: s.lastNowMs + 1500, videoTime: 0.5, attending: false, playing: true });
    assert.ok(Math.abs(s.exposureSec - 30.5) < 1e-9);
    // muted time does not count
    s = play(s, { from: 0.5, seconds: 10, attending: false, audible: false });
    assert.ok(Math.abs(s.exposureSec - 30.5) < 1e-9);
    // stopping early fails, but the total is there to be saved
    const stopped = step(s, { type: "ended", nowMs: s.lastNowMs });
    assert.equal(stopped.abortReason, "exposure-below-minimum");
    assert.ok(Math.abs(exposureTotal(stopped) - 60.5) < 1e-9);
    // keep looping to reach 2 minutes total
    s = play(s, { from: 10.5, seconds: 19.5, attending: false });
    s = step(s, { type: "tick", nowMs: s.lastNowMs + 250, videoTime: 0.25, attending: false, playing: true });
    s = play(s, { from: 0.25, seconds: 29.5, attending: false });
    s = step(s, { type: "tick", nowMs: s.lastNowMs + 250, videoTime: 0.25, attending: false, playing: true });
    s = play(s, { from: 0.25, seconds: 15, attending: false });
    assert.ok(exposureTotal(s) >= 120, `total ${exposureTotal(s)}`);
    s = step(s, { type: "ended", nowMs: s.lastNowMs });
    assert.equal(s.phase, "complete");
    assert.deepEqual(qualityScores(s), { exposure: 1 });
  });

  it("exposure is bounded by wall time (fast playback) and by video progress (suspend)", () => {
    const policy: WatchPolicy = { ...DEFAULT_POLICY, rules: ["exposure"], minMinutes: 10 };
    let s = start(1000, policy);
    s = play(s, { from: 0, seconds: 10, rate: 2 });
    assert.ok(Math.abs(s.exposureSec - 10) < 1e-9);
    // device slept an hour with the video frozen
    s = step(s, { type: "tick", nowMs: s.lastNowMs + 3_600_000, videoTime: 20.25, attending: false, playing: true });
    assert.ok(Math.abs(s.exposureSec - 10.25) < 1e-9);
    // throttled background tab: one tick per minute still counts
    s = step(s, { type: "tick", nowMs: s.lastNowMs + 60_000, videoTime: 80.25, attending: false, playing: true });
    assert.ok(Math.abs(s.exposureSec - 70.25) < 1e-9);
  });

  it("quality is 0 for sessions that are not complete", () => {
    assert.equal(sessionQuality(start(100)), 0);
  });
});

describe("attentionScore", () => {
  it("maps threshold -> 0.5 and full -> 1 linearly", () => {
    assert.equal(attentionScore(0.9, 0.9), 0.5);
    assert.equal(attentionScore(1, 0.9), 1);
    assert.ok(Math.abs(attentionScore(0.95, 0.9) - 0.75) < 1e-9);
    assert.ok(Math.abs(attentionScore(0.45, 0.9) - 0.25) < 1e-9);
    assert.equal(attentionScore(1, 1), 1);
    assert.equal(attentionScore(0.5, 0), 0.75);
  });
});
