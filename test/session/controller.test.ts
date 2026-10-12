import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scene } from "../core/fixtures.ts";
import {
  bannerNotice,
  findTreeScene,
  isViewerPause,
  loopWorthSaving,
  playerRequest,
  scoreChipView,
  spendDeadlineMs,
  spendWindowSec,
  viewPauseCause,
  wantsPauseLock,
} from "../../src/session/controller.ts";
import { DEFAULT_POLICY } from "../../src/play/types.ts";

describe("isViewerPause", () => {
  it("only cause other, while the session runs and no spend prompt holds the video", () => {
    assert.equal(isViewerPause("other", { phase: "playing" }, false), true);
    assert.equal(isViewerPause("other", { phase: "grace" }, false), true);
    for (const cause of ["plugin", "seek", "end"] as const) assert.equal(isViewerPause(cause, { phase: "playing" }, false), false);
    assert.equal(isViewerPause("other", { phase: "playing" }, true), false);
    assert.equal(isViewerPause("other", { phase: "complete" }, false), false);
    assert.equal(isViewerPause("other", { phase: "aborted" }, false), false);
  });
});

describe("spend prompt window", () => {
  it("is the marker window clamped to 5..60 s", () => {
    assert.equal(spendWindowSec({ window: { start: 10, end: 12 } }), 5);
    assert.equal(spendWindowSec({ window: { start: 10, end: 30 } }), 20);
    assert.equal(spendWindowSec({ window: { start: 0, end: 600 } }), 60);
    assert.equal(spendDeadlineMs({ window: { start: 10, end: 30 } }, 1000), 21_000);
  });
});

describe("wantsPauseLock", () => {
  it("follows allowUserPause while the session runs", () => {
    assert.equal(wantsPauseLock(DEFAULT_POLICY, "playing"), true);
    assert.equal(wantsPauseLock(DEFAULT_POLICY, "ready"), true);
    assert.equal(wantsPauseLock({ allowUserPause: true }, "playing"), false);
    assert.equal(wantsPauseLock(DEFAULT_POLICY, "complete"), false);
    assert.equal(wantsPauseLock(DEFAULT_POLICY, "aborted"), false);
    assert.equal(wantsPauseLock(undefined, "playing"), false);
    assert.equal(wantsPauseLock(DEFAULT_POLICY, undefined), false);
  });
});

describe("viewPauseCause", () => {
  it("spend first, then who paused", () => {
    assert.equal(viewPauseCause(true, "inattention"), "spend");
    assert.equal(viewPauseCause(false, "user"), "user");
    assert.equal(viewPauseCause(false, "inattention"), "attention");
    assert.equal(viewPauseCause(false, undefined), undefined);
  });
});

describe("findTreeScene", () => {
  it("looks in the graph, then the library", () => {
    const a = scene("1", []);
    const b = scene("2", []);
    const data = { graph: { scenes: new Map([["1", a]]) }, library: { scenes: [a, b] } };
    assert.equal(findTreeScene(data, "1"), a);
    assert.equal(findTreeScene(data, "2"), b);
    assert.equal(findTreeScene(data, "3"), undefined);
  });
});

describe("playerRequest", () => {
  const base = { phase: "playing" as const, pauseRequested: false, resumeRequested: false };
  it("maps the one-shot flags onto the player", () => {
    assert.equal(playerRequest({ ...base, phase: "paused", pauseRequested: true }, false, false), "pause");
    assert.equal(playerRequest({ ...base, pauseRequested: true }, true, false), undefined);
    assert.equal(playerRequest({ ...base, resumeRequested: true }, true, false), "play");
    assert.equal(playerRequest({ ...base, resumeRequested: true }, true, true), undefined);
    assert.equal(playerRequest({ ...base, resumeRequested: true }, false, false), undefined);
    assert.equal(playerRequest({ ...base, phase: "aborted", resumeRequested: true }, true, false), undefined);
  });
});

describe("bannerNotice", () => {
  const input = { phase: "playing" as const, spendOpen: false, pauseAttemptRecent: false, graceText: "Look back", exposureOnly: false };
  it("picks the most urgent notice", () => {
    assert.equal(bannerNotice(input), undefined);
    assert.deepEqual(bannerNotice({ ...input, phase: "grace" }), { text: "Look back", tone: "warning" });
    assert.equal(bannerNotice({ ...input, phase: "grace", pauseAttemptRecent: true })?.text.startsWith("Pausing"), true);
    assert.equal(bannerNotice({ ...input, phase: "ready" })?.tone, "info");
    assert.match(bannerNotice({ ...input, phase: "ready", exposureOnly: true })?.text ?? "", /loop/);
  });
  it("stays quiet during spend prompts and after the end", () => {
    assert.equal(bannerNotice({ ...input, phase: "grace", spendOpen: true }), undefined);
    assert.equal(bannerNotice({ ...input, phase: "complete", pauseAttemptRecent: true }), undefined);
  });
});

describe("scoreChipView", () => {
  const state = { attendedFraction: 0.934, exposureSec: 90, priorExposureSec: 600, phase: "playing" as const };
  it("shows the attended share for attention clips", () => {
    assert.deepEqual(scoreChipView(state, DEFAULT_POLICY, true), { value: "93%", label: "attended, needs 90%", tone: "blue" });
    assert.equal(scoreChipView(state, DEFAULT_POLICY, false).tone, "orange");
    assert.equal(scoreChipView({ ...state, phase: "ready" }, DEFAULT_POLICY, false).tone, "blue");
  });
  it("shows exposure minutes for loops", () => {
    const loop = { ...DEFAULT_POLICY, rules: ["exposure" as const], minMinutes: 30 };
    assert.equal(scoreChipView(state, loop, true).value, "11/30 min");
    assert.equal(scoreChipView(state, { ...loop, minMinutes: undefined }, true).value, "11 min");
  });
});

describe("loopWorthSaving", () => {
  it("needs unsaved minutes of a running session", () => {
    assert.equal(loopWorthSaving({ phase: "playing", exposureSec: 30 }, true), true);
    assert.equal(loopWorthSaving({ phase: "paused", exposureSec: 30 }, true), true);
    assert.equal(loopWorthSaving({ phase: "playing", exposureSec: 0.5 }, true), false);
    assert.equal(loopWorthSaving({ phase: "playing", exposureSec: 30 }, false), false);
    assert.equal(loopWorthSaving({ phase: "complete", exposureSec: 30 }, true), false);
  });
});
