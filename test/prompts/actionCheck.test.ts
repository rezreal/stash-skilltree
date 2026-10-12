import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createActionCheck } from "../../src/prompts/actionCheck.ts";
import type { ActionCheck } from "../../src/prompts/actionCheck.ts";
import type { PromptAction, ViewerFrame } from "../../src/prompts/types.ts";
import { pose, spec } from "./fixtures.ts";

const STEP = 33; // ~30 fps

function check(action: PromptAction, holdSec = 2): ActionCheck {
  return createActionCheck(spec({ check: "action", action, holdSec }));
}
/** frames every STEP ms in [from, to) */
function feed(c: ActionCheck, from: number, to: number, f: (t: number) => Partial<ViewerFrame>): void {
  for (let t = from; t < to; t += STEP) c.push({ t, facePresent: true, personPresent: true, ...f(t) });
}
const sine = (amp: number, periodMs: number, t0 = 0) => (t: number): number => amp * Math.sin((2 * Math.PI * (t - t0)) / periodMs);

describe("nod / shake_head", () => {
  it("detects a nod: one pitch cycle of >= 8 degrees", () => {
    const c = check("nod");
    const wave = sine(6, 1000); // +-6 = 12 degrees peak to peak
    feed(c, 0, 400, (t) => ({ pitch: wave(t) }));
    assert.equal(c.result().passed, false);
    feed(c, 400, 1300, (t) => ({ pitch: wave(t) }));
    assert.equal(c.result().passed, true);
  });

  it("ignores small nods and jitter", () => {
    const c = check("nod");
    const wave = sine(3, 800); // 6 degrees peak to peak
    feed(c, 0, 4000, (t) => ({ pitch: wave(t) + (t % 66 === 0 ? 0.8 : -0.8) }));
    assert.equal(c.result().passed, false);
    assert.ok(c.result().progress < 0.5);
  });

  it("a slow drift down and back is not a nod", () => {
    const c = check("nod");
    feed(c, 0, 5000, (t) => ({ pitch: t < 2500 ? -t / 200 : -(5000 - t) / 200 })); // 12.5 degrees over 5 s
    assert.equal(c.result().passed, false);
  });

  it("detects a head shake from yaw, not pitch", () => {
    const shake = check("shake_head");
    const wave = sine(7, 900);
    feed(shake, 0, 1200, (t) => ({ yaw: wave(t), pitch: 0 }));
    assert.equal(shake.result().passed, true);
    const nod = check("nod");
    feed(nod, 0, 1200, (t) => ({ yaw: wave(t), pitch: 0 }));
    assert.equal(nod.result().passed, false);
    const small = check("shake_head");
    feed(small, 0, 3000, (t) => ({ yaw: sine(4.5, 900)(t) }));
    assert.equal(small.result().passed, false); // 9 degrees < 10
  });

  it("frames without a face are skipped, not reset", () => {
    const c = check("nod");
    feed(c, 0, 300, () => ({ pitch: 0 }));
    feed(c, 300, 600, () => ({ pitch: -10 }));
    feed(c, 600, 900, () => ({ facePresent: false, pitch: 50 }));
    feed(c, 900, 1200, () => ({ pitch: 0 }));
    assert.equal(c.result().passed, true);
  });
});

describe("eyes_closed / eyes_open", () => {
  it("eyes_closed needs both eyes >= 0.5 for min(holdSec, 1.5 s)", () => {
    const c = check("eyes_closed", 3);
    feed(c, 0, 1000, () => ({ eyeBlinkLeft: 0.9, eyeBlinkRight: 0.8 }));
    feed(c, 1000, 1100, () => ({ eyeBlinkLeft: 0.9, eyeBlinkRight: 0.2 })); // one eye opens: reset
    feed(c, 1100, 2500, () => ({ eyeBlinkLeft: 0.9, eyeBlinkRight: 0.8 }));
    assert.equal(c.result().passed, false);
    feed(c, 2500, 2700, () => ({ eyeBlinkLeft: 0.9, eyeBlinkRight: 0.8 }));
    assert.equal(c.result().passed, true);
  });

  it("eyes_closed: lost face neither counts nor resets", () => {
    const c = check("eyes_closed", 1.5);
    feed(c, 0, 900, () => ({ eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9 }));
    feed(c, 900, 3000, () => ({ facePresent: false }));
    assert.equal(c.result().passed, false);
    feed(c, 3000, 3700, () => ({ eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9 }));
    assert.equal(c.result().passed, true);
  });

  it("eyes_open survives blinks but not long closures", () => {
    const c = check("eyes_open", 2);
    feed(c, 0, 1000, () => ({ eyeBlinkLeft: 0.1, eyeBlinkRight: 0.1 }));
    feed(c, 1000, 1200, () => ({ eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9 })); // blink
    feed(c, 1200, 2300, () => ({ eyeBlinkLeft: 0.1, eyeBlinkRight: 0.1 }));
    assert.equal(c.result().passed, true);
    const c2 = check("eyes_open", 2);
    feed(c2, 0, 1000, () => ({ eyeBlinkLeft: 0.1, eyeBlinkRight: 0.1 }));
    feed(c2, 1000, 1700, () => ({ eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9 }));
    feed(c2, 1700, 2900, () => ({ eyeBlinkLeft: 0.1, eyeBlinkRight: 0.1 }));
    assert.equal(c2.result().passed, false);
  });
});

describe("hand_raised / still", () => {
  it("hand_raised needs 0.5 s", () => {
    const c = check("hand_raised");
    feed(c, 0, 400, () => ({ handRaised: true }));
    feed(c, 400, 1000, () => ({ handRaised: false }));
    assert.equal(c.result().passed, false);
    feed(c, 1000, 1600, () => ({ handRaised: true }));
    assert.equal(c.result().passed, true);
  });

  it("still: low motion for holdSec; moving or leaving resets", () => {
    const c = check("still", 2);
    feed(c, 0, 1500, () => ({ motion: 0.001 }));
    feed(c, 1500, 1600, () => ({ facePresent: false })); // leaving the frame resets
    feed(c, 1600, 3000, () => ({ motion: 0.001 }));
    assert.equal(c.result().passed, false);
    feed(c, 3000, 3200, () => ({ motion: 0.02 })); // fidgeting resets
    feed(c, 3200, 5000, () => ({ motion: 0.002 }));
    assert.equal(c.result().passed, false);
    feed(c, 5000, 5300, () => ({ motion: 0.002 }));
    assert.equal(c.result().passed, true);
  });
});

describe("body-pose actions", () => {
  const UP = pose({ nose: [0.5, 0.3], leftShoulder: [0.4, 0.5], rightShoulder: [0.6, 0.5], leftWrist: [0.4, 0.05], rightWrist: [0.6, 0.05] });
  const DOWN = pose({ nose: [0.5, 0.3], leftShoulder: [0.4, 0.5], rightShoulder: [0.6, 0.5], leftWrist: [0.42, 0.8], rightWrist: [0.58, 0.8] });

  it("arms_up holds for min(holdSec, 1.5 s), gated on the pose not the face", () => {
    const c = check("arms_up", 4);
    feed(c, 0, 1000, () => ({ facePresent: false, pose: UP }));
    feed(c, 1000, 1500, () => ({ pose: DOWN }));
    feed(c, 1500, 2900, () => ({ facePresent: false, pose: UP }));
    assert.equal(c.result().passed, false);
    feed(c, 2900, 3100, () => ({ facePresent: false, pose: UP }));
    assert.equal(c.result().passed, true);
  });

  const STANDING_POSE = pose({
    leftShoulder: [0.45, 0.25],
    leftHip: [0.47, 0.5],
    leftKnee: [0.47, 0.7],
    leftAnkle: [0.47, 0.9],
  });
  const SEIZA = pose({ leftShoulder: [0.5, 0.35], leftHip: [0.5, 0.6], leftKnee: [0.65, 0.68], leftAnkle: [0.48, 0.7] });

  it("long pose windows are scored by share: the pose must be kept, not just reached", () => {
    const long = (): ActionCheck => createActionCheck(spec({ check: "action", action: "kneel_sit", start: 10, end: 40 }));
    const kept = long();
    feed(kept, 0, 20000, () => ({ facePresent: false, pose: SEIZA }));
    feed(kept, 20000, 24000, () => ({ pose: STANDING_POSE }));
    assert.equal(kept.result().passed, true);
    assert.ok(kept.result().share! > 0.8);
    assert.match(kept.result().detail!, /^kneel sit 8\d% · need 75%$/);

    const left = long();
    feed(left, 0, 5000, () => ({ pose: SEIZA }));
    feed(left, 5000, 20000, () => ({ pose: STANDING_POSE }));
    assert.equal(left.result().passed, false); // held 5 s, but only a quarter of the time
    assert.ok(left.result().progress < 0.5);

    // time without the legs in view neither counts nor is required
    const hidden = long();
    feed(hidden, 0, 3000, () => ({ pose: SEIZA }));
    feed(hidden, 3000, 20000, () => ({ pose: pose({ nose: [0.5, 0.3] }) }));
    assert.equal(hidden.result().passed, true);

    // a short window keeps the hold rule
    const short = check("kneel_sit");
    feed(short, 0, 1600, () => ({ pose: SEIZA }));
    feed(short, 1600, 5000, () => ({ pose: STANDING_POSE }));
    assert.equal(short.result().passed, true);
  });

  it("reports a steady hint of what is missing, cleared once the pose is held", () => {
    const c = createActionCheck(spec({ check: "action", action: "kneel_sit", start: 10, end: 40 }));
    feed(c, 0, 400, () => ({ pose: STANDING_POSE }));
    assert.equal(c.result().hint, undefined); // not yet steady
    feed(c, 400, 1000, () => ({ pose: STANDING_POSE }));
    assert.equal(c.result().hint, "Put your knees on the floor");
    feed(c, 1000, 1200, () => ({ pose: SEIZA }));
    assert.equal(c.result().hint, "Put your knees on the floor"); // a moment in the pose keeps it
    feed(c, 1200, 1600, () => ({ pose: SEIZA }));
    assert.equal(c.result().hint, undefined);
    feed(c, 1600, 2600, () => ({ personPresent: false, facePresent: false }));
    assert.equal(c.result().hint, "Get in front of the camera");
    // a passed short window has no hint
    const short = check("kneel_sit");
    feed(short, 0, 1600, () => ({ pose: SEIZA }));
    feed(short, 1600, 3000, () => ({ pose: STANDING_POSE }));
    assert.equal(short.result().passed, true);
    assert.equal(short.result().hint, undefined);
  });

  it("missing landmarks or no person are neither pass nor fail", () => {
    const c = check("arms_up", 1);
    feed(c, 0, 600, () => ({ pose: UP }));
    feed(c, 600, 2000, () => ({ pose: pose({ nose: [0.5, 0.3] }) }));
    feed(c, 2000, 3000, () => ({ personPresent: false, facePresent: false }));
    assert.equal(c.result().passed, false);
    feed(c, 3000, 3500, () => ({ pose: UP }));
    assert.equal(c.result().passed, true);
  });
});
