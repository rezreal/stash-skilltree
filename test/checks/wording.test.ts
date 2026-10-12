import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GAZE_TARGETS, PROMPT_ACTIONS } from "../../src/prompts/types.ts";
import type { PromptProgress } from "../../src/prompts/types.ts";
import {
  actionWords,
  bannerView,
  gazeInstruction,
  gazeTargetWords,
  progressLabel,
  promptInstruction,
  RESULT_SHOW_MS,
} from "../../src/checks/wording.ts";
import { spec } from "./fixtures.ts";

describe("prompt wording", () => {
  it("gaze targets in plain words", () => {
    assert.equal(gazeInstruction("feet_floor"), "Look at the floor in front of their feet");
    assert.equal(gazeInstruction("groin"), "Look at their groin");
    assert.equal(gazeInstruction("eyes"), "Look at their eyes");
    assert.equal(gazeInstruction("off_screen"), "Look away from the screen");
    assert.equal(gazeInstruction("screen_center"), "Look at the center of the screen");
    for (const t of GAZE_TARGETS) assert.doesNotMatch(gazeTargetWords(t), /_/);
  });

  it("actions in plain words", () => {
    assert.equal(actionWords("hands_on_head"), "Hands on your head");
    assert.equal(actionWords("shake_head"), "Shake your head");
    for (const a of PROMPT_ACTIONS) assert.doesNotMatch(actionWords(a), /_/);
  });

  it("instructions per check", () => {
    assert.equal(promptInstruction({ check: "repeat", title: " I am listening " }), "Say: “I am listening”");
    assert.equal(promptInstruction({ check: "gaze", title: "", target: "mouth" }), "Look at their mouth");
    assert.equal(promptInstruction({ check: "action", title: "", action: "kneel" }), "Kneel");
    assert.equal(promptInstruction({ check: "spend", title: "50" }), "Spend 50 coins");
  });
});

describe("bannerView", () => {
  const g = spec({ check: "gaze", start: 10, end: 15, target: "eyes" });
  const r = spec({ check: "repeat", start: 20, end: 26, title: "yes" });
  const prog = (phases: [typeof g, PromptProgress["phase"], number, number?][]): PromptProgress[] =>
    phases.map(([s, phase, progress, replays]) => ({ spec: s, phase, progress, replays: replays ?? 0 }));

  it("nothing on screen without an open prompt or a recent result", () => {
    assert.equal(bannerView({ progress: prog([[g, "upcoming", 0], [r, "upcoming", 0]]), nowMs: 0 }), undefined);
  });

  it("the active prompt with progress, time left and a note", () => {
    const v = bannerView({
      progress: prog([[g, "active", 0.4], [r, "upcoming", 0]]),
      videoTime: 12.2,
      nowMs: 0,
      uncheckable: () => "no eye tracker connected",
    })!;
    assert.equal(v.tone, "active");
    assert.equal(v.instruction, "Look at their eyes");
    assert.equal(v.progress, 0.4);
    assert.ok(Math.abs(v.secondsLeft! - 2.8) < 1e-9);
    assert.equal(v.note, "no eye tracker connected");
    assert.equal(v.status, undefined);
  });

  it("second try and replaying states", () => {
    assert.equal(bannerView({ progress: prog([[g, "active", 0, 1]]), nowMs: 0 })!.status, "Second try");
    const v = bannerView({ progress: prog([[g, "replaying", 0.3, 1]]), nowMs: 0 })!;
    assert.equal(v.tone, "replaying");
    assert.match(v.status!, /Replaying/);
  });

  it("active wins over replaying", () => {
    assert.equal(bannerView({ progress: prog([[g, "replaying", 0, 1], [r, "active", 0]]), nowMs: 0 })!.spec, r);
  });

  it("the last result for a moment: missed / done", () => {
    const progress = prog([[g, "failed", 0.5, 1]]);
    const missed = bannerView({ progress, nowMs: 1000, last: { spec: g, passed: false, atMs: 500 } })!;
    assert.equal(missed.tone, "missed");
    assert.equal(missed.status, "Missed");
    assert.equal(missed.progress, 0.5);
    assert.equal(bannerView({ progress, nowMs: 500 + RESULT_SHOW_MS, last: { spec: g, passed: false, atMs: 500 } }), undefined);
    const done = bannerView({ progress: prog([[g, "passed", 1]]), nowMs: 600, last: { spec: g, passed: true, atMs: 500 } })!;
    assert.equal(done.tone, "passed");
    assert.equal(done.progress, 1);
  });
});

describe("gaze eyes_closed wording", () => {
  it("banner says close your eyes, with the capped hold", () => {
    assert.equal(gazeInstruction("eyes_closed"), "Close your eyes");
    assert.equal(promptInstruction({ check: "gaze", title: "", target: "eyes_closed" }), "Close your eyes");
    assert.equal(progressLabel({ check: "gaze", holdSec: 2, target: "eyes_closed" }), "hold 1.5 s");
    assert.equal(progressLabel({ check: "gaze", holdSec: 1, target: "eyes_closed" }), "hold 1 s");
    assert.equal(progressLabel({ check: "gaze", holdSec: 2, target: "eyes" }), "hold 2 s");
    const ec = spec({ check: "gaze", start: 10, end: 15, target: "eyes_closed" });
    const v = bannerView({ progress: [{ spec: ec, phase: "active", progress: 0.5, replays: 0 }], nowMs: 0 })!;
    assert.equal(v.instruction, "Close your eyes");
    assert.equal(v.progressLabel, "hold 1.5 s");
  });
});
