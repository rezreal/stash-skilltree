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
import { promptAttentionFrom } from "../../src/checks/attention.ts";
import type { GazeMoment } from "../../src/prompts/gazeCheck.ts";
import { createPromptRunner } from "../../src/prompts/runner.ts";
import type { PromptSpec } from "../../src/prompts/types.ts";
import { createSession, step } from "../../src/play/session.ts";
import { DEFAULT_POLICY } from "../../src/play/types.ts";
import type { SessionState } from "../../src/play/types.ts";
import { scene } from "../core/fixtures.ts";

const watching: AttentionReading = { attending: true, source: "gaze", reason: "inside", trackerDown: false };
const away: AttentionReading = { attending: false, source: "gaze", reason: "outside", trackerDown: false };
const present = { present: true, reason: "present" };
const absent = { present: false, reason: "absent" };
const off = { present: false, reason: "off" };
const stalled = { present: false, reason: "no-frames" };

const EC_SPEC: PromptSpec = { markerId: "ec", check: "gaze", target: "eyes_closed", start: 10, end: 1721, title: "", holdSec: 1.5 };
const EYES_SPEC: PromptSpec = { markerId: "ey", check: "gaze", target: "eyes", start: 2, end: 552, title: "", holdSec: 2 };
const promptAt = (spec: PromptSpec, state: GazeMoment) => promptAttentionFrom({ spec, state })!;

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
    const opts = { required: true };
    assert.equal(sessionAttending(watching, present, opts), true);
    assert.equal(sessionAttending(away, present, opts), false);
    assert.equal(sessionAttending(watching, absent, opts), false);
    assert.equal(sessionAttending(watching, off, opts), false);
  });

  it("an active gaze prompt replaces the gaze reading", () => {
    const opts = (state: GazeMoment, spec = EC_SPEC) => ({ required: true, prompt: promptAt(spec, state) });
    // eyes_closed: looking at the video (eyes open) is not attending; closed eyes (no gaze) are
    assert.equal(sessionAttending(watching, present, opts("off")), false);
    assert.equal(sessionAttending(away, present, opts("on")), true);
    // other targets: in the region or not, whatever the video-attention reading says
    assert.equal(sessionAttending(watching, present, opts("off", EYES_SPEC)), false);
    assert.equal(sessionAttending(away, present, opts("on", EYES_SPEC)), true);
  });

  it("no evidence for the prompt never pauses", () => {
    for (const spec of [EC_SPEC, EYES_SPEC]) {
      assert.equal(sessionAttending(away, present, { required: true, prompt: promptAt(spec, "unknown") }), true);
      assert.equal(sessionAttending(away, undefined, { required: false, prompt: promptAt(spec, "unknown") }), true);
    }
  });

  it("presence still counts during a gaze prompt", () => {
    for (const required of [true, false]) {
      assert.equal(sessionAttending(away, absent, { required, prompt: promptAt(EC_SPEC, "on") }), false);
      assert.equal(sessionAttending(watching, absent, { required, prompt: promptAt(EYES_SPEC, "on") }), false);
    }
    assert.equal(sessionAttending(away, stalled, { required: true, prompt: promptAt(EC_SPEC, "on") }), false);
    assert.equal(sessionAttending(away, stalled, { required: false, prompt: promptAt(EC_SPEC, "on") }), true);
  });

  it("a camera that isn't required only matters when it sees nobody", () => {
    const opts = { required: false };
    assert.equal(sessionAttending(watching, off, opts), true);
    assert.equal(sessionAttending(watching, stalled, opts), true);
    assert.equal(sessionAttending(watching, absent, opts), false);
    assert.equal(sessionAttending(away, off, opts), false);
  });

  it("the adjuster reads its inputs on every call", () => {
    let input: Parameters<typeof sessionAdjuster>[0] extends () => infer R ? R : never = { presence: present, required: true };
    const adjust = sessionAdjuster(() => input);
    assert.equal(adjust(away, 0), false);
    input = { ...input, prompt: promptAt(EC_SPEC, "on") };
    assert.equal(adjust(away, 0), true);
    input = { ...input, prompt: promptAt(EC_SPEC, "off") };
    assert.equal(adjust(watching, 0), false);
    input = { ...input, prompt: promptAt(EC_SPEC, "on"), presence: absent };
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

describe("attentionTexts during a gaze prompt", () => {
  it("eyes_closed: the eyes are open", () => {
    const t = attentionTexts(watching, present, true, promptAt(EC_SPEC, "off"));
    assert.equal(t.byPresence, false);
    assert.equal(t.pause.title, "Your eyes are open – close them to continue");
    assert.equal(t.grace, "Your eyes are open – close them");
    assert.equal(t.back, "Close your eyes");
  });

  it("other targets: look at the target", () => {
    const t = attentionTexts(away, present, true, promptAt(EYES_SPEC, "off"));
    assert.equal(t.pause.title, "Look at their eyes to continue");
    assert.equal(t.grace, "Look at their eyes");
    assert.equal(t.back, "Look at their eyes");
    const off = attentionTexts(away, present, true, promptAt({ ...EYES_SPEC, target: "off_screen" }, "off"));
    assert.equal(off.pause.title, "Look away from the screen to continue");
  });

  it("presence still wins as the reason", () => {
    assert.equal(attentionTexts(away, absent, true, promptAt(EC_SPEC, "off")).pause.title, "Paused: not in front of the camera");
  });

  it("outside prompts the callout says look back at the video", () => {
    assert.equal(attentionTexts(away, present, true).back, "Look back at the video");
  });
});

describe("eyes_closed prompt drives the session (runner + wiring + session step)", () => {
  const STEP_MS = 50;
  /** eyes per wall ms: the tracker sees the viewer, gaze valid = eyes open */
  type Eyes = (nowMs: number) => "open" | "closed" | "none";

  function simulate(eyes: Eyes, untilMs: number, startVt = 20) {
    const runner = createPromptRunner([EC_SPEC]);
    let session: SessionState = createSession({ scene: scene("s", [], { durationSec: 1800 }), policy: DEFAULT_POLICY, nowMs: 0 });
    session = step(session, { type: "play" });
    let now = 0;
    let vt = startVt;
    // the session's attention reading looks away the whole time (eyes closed / not on the video): it must not matter
    const adjust = sessionAdjuster(() => ({ presence: present, required: true, prompt: promptAttentionFrom(runner.currentGaze(now)) }));
    const log: { nowMs: number; phase: SessionState["phase"]; vt: number }[] = [];
    for (now = 0; now <= untilMs; now += STEP_MS) {
      const e = eyes(now);
      if (e === "open") runner.feedGaze({ t: now, point: { x: 500, y: 500 }, valid: true, present: true });
      else if (e === "closed") runner.feedGaze({ t: now, valid: false, present: true });
      else runner.feedGaze({ t: now, valid: false }); // presence unknown: no evidence
      if (now % 100 === 0) runner.update({ videoTime: vt, nowMs: now });
      if (now % 250 === 0) {
        session = step(session, { type: "tick", nowMs: now, videoTime: vt, attending: adjust(away, now), playing: session.phase !== "paused" });
        log.push({ nowMs: now, phase: session.phase, vt });
      }
      // the player follows the session: video time stands while paused
      if (session.phase !== "paused" && session.phase !== "aborted") vt += STEP_MS / 1000;
    }
    return { session, log, runner };
  }

  it("open eyes during the window pause after the grace period, closing them resumes", () => {
    // closed, open from 5 s to 12 s, closed again
    const { session, log } = simulate((t) => (t >= 5000 && t < 12000 ? "open" : "closed"), 20_000);
    const at = (ms: number) => log.find((l) => l.nowMs === ms)!;
    assert.equal(at(4000).phase, "playing");
    assert.equal(at(6000).phase, "grace");
    const pausedAt = log.find((l) => l.phase === "paused")!;
    assert.ok(pausedAt.nowMs > 7000 && pausedAt.nowMs <= 7500, String(pausedAt.nowMs));
    assert.equal(at(11_000).phase, "paused");
    // video time stood still while paused
    assert.equal(at(11_000).vt, pausedAt.vt);
    // eyes closed at 12 s: resumes on the next tick (no gaze on the video needed)
    assert.equal(at(12_250).phase, "playing");
    assert.equal(session.phase, "playing");
  });

  it("open eyes for longer than abortSec while paused abort the clip", () => {
    const { session } = simulate((t) => (t >= 1000 ? "open" : "closed"), 1000 + 2500 + DEFAULT_POLICY.abortSec * 1000 + 1000);
    assert.equal(session.phase, "aborted");
    assert.equal(session.abortReason, "inattention-timeout");
  });

  it("no evidence never pauses", () => {
    const { session, log } = simulate(() => "none", 15_000);
    assert.ok(log.every((l) => l.phase === "playing"), JSON.stringify(log.find((l) => l.phase !== "playing")));
    assert.equal(session.phase, "playing");
  });

  it("before and after the window the usual attention rule applies", () => {
    // the window starts at 10 s: from vt 0 the 'away' reading pauses before the prompt starts
    const { log } = simulate(() => "closed", 4000, 0);
    assert.ok(log.some((l) => l.phase === "paused"));
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
