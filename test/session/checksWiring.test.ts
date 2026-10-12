import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  attentionTexts,
  needsCameraGate,
  presenceWanted,
  sessionAdjuster,
  sessionAttending,
  trackScoreToReport,
  type ScoredTrack,
} from "../../src/session/checksWiring.ts";
import type { AttentionReading } from "../../src/player/gazeView.ts";

const watching: AttentionReading = { attending: true, source: "gaze", reason: "inside", trackerDown: false };
const away: AttentionReading = { attending: false, source: "gaze", reason: "outside", trackerDown: false };
const present = { present: true, reason: "present" };
const absent = { present: false, reason: "absent" };
const off = { present: false, reason: "off" };
const stalled = { present: false, reason: "no-frames" };

describe("camera gate and presence", () => {
  it("the gate stands before the session only when the webcam is required", () => {
    assert.equal(needsCameraGate(true, false), true);
    assert.equal(needsCameraGate(true, true), false);
    assert.equal(needsCameraGate(false, false), false);
  });

  it("presence runs for the whole session when required, silently with permission otherwise", () => {
    for (const permission of ["granted", "denied", "prompt", "unknown"] as const) {
      assert.equal(presenceWanted({ required: true, permission, finished: false }), true);
      assert.equal(presenceWanted({ required: true, permission, finished: true }), false);
      assert.equal(presenceWanted({ required: false, permission, finished: false }), permission === "granted");
      assert.equal(presenceWanted({ required: false, permission, finished: true }), false);
    }
  });
});

describe("sessionAttending", () => {
  it("is the reading AND presence outside gaze prompts", () => {
    const opts = { required: true, gazePromptActive: false };
    assert.equal(sessionAttending(watching, present, opts), true);
    assert.equal(sessionAttending(away, present, opts), false);
    assert.equal(sessionAttending(watching, absent, opts), false);
    assert.equal(sessionAttending(watching, off, opts), false);
  });

  it("an active gaze prompt suspends the gaze part: looking elsewhere doesn't pause", () => {
    assert.equal(sessionAttending(away, present, { required: true, gazePromptActive: true }), true);
    assert.equal(sessionAttending(away, undefined, { required: false, gazePromptActive: true }), true);
    assert.equal(sessionAttending(away, off, { required: false, gazePromptActive: true }), true);
  });

  it("presence still counts during a gaze prompt", () => {
    for (const required of [true, false]) {
      assert.equal(sessionAttending(away, absent, { required, gazePromptActive: true }), false);
      assert.equal(sessionAttending(watching, absent, { required, gazePromptActive: true }), false);
    }
    assert.equal(sessionAttending(away, stalled, { required: true, gazePromptActive: true }), false);
    assert.equal(sessionAttending(away, stalled, { required: false, gazePromptActive: true }), true);
  });

  it("a camera that isn't required only matters when it sees nobody", () => {
    const opts = { required: false, gazePromptActive: false };
    assert.equal(sessionAttending(watching, off, opts), true);
    assert.equal(sessionAttending(watching, stalled, opts), true);
    assert.equal(sessionAttending(watching, absent, opts), false);
    assert.equal(sessionAttending(away, off, opts), false);
  });

  it("the adjuster reads its inputs on every call", () => {
    let input = { presence: present as { present: boolean; reason: string } | undefined, required: true, gazePromptActive: false };
    const adjust = sessionAdjuster(() => input);
    assert.equal(adjust(away, 0), false);
    input = { ...input, gazePromptActive: true };
    assert.equal(adjust(away, 0), true);
    input = { ...input, presence: absent };
    assert.equal(adjust(away, 0), false);
  });
});

describe("attentionTexts", () => {
  it("names presence when it is the reason", () => {
    const t = attentionTexts(watching, absent, false);
    assert.equal(t.byPresence, true);
    assert.equal(t.pause.title, "Paused: not in front of the camera");
    assert.equal(t.grace, "Not in front of the camera");
    // absent also explains a failing gaze
    assert.equal(attentionTexts(away, absent, true).pause.title, "Paused: not in front of the camera");
  });

  it("a stalled or off camera is the reason only when required", () => {
    assert.equal(attentionTexts(watching, stalled, true).pause.title, "Paused: camera stalled");
    assert.equal(attentionTexts(watching, stalled, true).grace, "Camera stalled");
    assert.equal(attentionTexts(watching, off, true).pause.title, "Paused: camera off");
    assert.equal(attentionTexts(away, stalled, false).byPresence, false);
    assert.equal(attentionTexts(away, off, false).byPresence, false);
  });

  it("falls back to the gaze reasons", () => {
    const t = attentionTexts(away, present, true);
    assert.equal(t.byPresence, false);
    assert.equal(t.pause.title, "Paused: you looked away");
    assert.equal(t.grace, "Look back at the video");
    const lost: AttentionReading = { attending: false, source: "gaze", reason: "no-gaze", trackerDown: false };
    assert.equal(attentionTexts(lost, present, true).grace, "Eyes not tracked");
  });
});

describe("trackScoreToReport", () => {
  const track = (scored: boolean, overall?: number): ScoredTrack => ({
    scored: () => scored,
    score: () => (overall === undefined ? {} : { overall }),
  });

  it("reports nothing without a scored track (no sensor: the rule stays unscored)", () => {
    assert.equal(trackScoreToReport(undefined, undefined), undefined);
    assert.equal(trackScoreToReport(track(false, 0.8), undefined), undefined);
    assert.equal(trackScoreToReport(track(false), undefined), undefined);
  });

  it("reports nothing before a section was scored", () => {
    assert.equal(trackScoreToReport(track(true), undefined), undefined);
    assert.equal(trackScoreToReport(track(true, Number.NaN), undefined), undefined);
  });

  it("reports the overall score when it changed", () => {
    assert.equal(trackScoreToReport(track(true, 0.8), undefined), 0.8);
    assert.equal(trackScoreToReport(track(true, 0), undefined), 0);
    assert.equal(trackScoreToReport(track(true, 0.8), 0.8), undefined);
    assert.equal(trackScoreToReport(track(true, 0.75), 0.8), 0.75);
  });
});
