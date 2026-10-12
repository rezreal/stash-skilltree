import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assessPosture, classifyPosture, POSTURE_HINTS as H } from "../../src/prompts/posture.ts";
import { pose } from "./fixtures.ts";

// webcam frames, aspect 4/3; y grows downwards
const DESK = { nose: [0.5, 0.3], leftEye: [0.48, 0.28], rightEye: [0.52, 0.28], leftShoulder: [0.4, 0.5], rightShoulder: [0.6, 0.5] } as const;
const STANDING = {
  nose: [0.5, 0.15],
  leftShoulder: [0.45, 0.25],
  rightShoulder: [0.55, 0.25],
  leftHip: [0.47, 0.5],
  rightHip: [0.53, 0.5],
  leftKnee: [0.47, 0.7],
  rightKnee: [0.53, 0.7],
  leftAnkle: [0.47, 0.9],
  rightAnkle: [0.53, 0.9],
} as const;

describe("classifyPosture", () => {
  it("arms_up: wrists clearly above the head", () => {
    assert.equal(classifyPosture("arms_up", pose({ ...DESK, leftWrist: [0.4, 0.05], rightWrist: [0.6, 0.08] })), "in");
    assert.equal(classifyPosture("arms_up", pose({ ...DESK, leftWrist: [0.4, 0.05], rightWrist: [0.6, 0.27] })), "out"); // one at eye height
    assert.equal(classifyPosture("arms_up", pose({ ...DESK, leftWrist: [0.4, 0.05] })), "unknown");
    // no nose: relative to the shoulders
    const noNose = { ...DESK, nose: undefined };
    assert.equal(classifyPosture("arms_up", pose({ ...noNose, leftWrist: [0.4, 0.1], rightWrist: [0.6, 0.1] })), "in");
    assert.equal(classifyPosture("arms_up", pose({ ...noNose, leftWrist: [0.4, 0.4], rightWrist: [0.6, 0.4] })), "out");
  });

  it("hands_on_head: wrists at eye height near the head, elbows out", () => {
    const base = { ...DESK, leftWrist: [0.47, 0.2], rightWrist: [0.53, 0.2] } as const;
    assert.equal(classifyPosture("hands_on_head", pose({ ...base, leftElbow: [0.3, 0.3], rightElbow: [0.7, 0.3] })), "in");
    assert.equal(classifyPosture("hands_on_head", pose({ ...base, leftElbow: [0.45, 0.45], rightElbow: [0.55, 0.45] })), "out");
    assert.equal(
      classifyPosture("hands_on_head", pose({ ...base, leftWrist: [0.2, 0.2], leftElbow: [0.3, 0.3], rightElbow: [0.7, 0.3] })),
      "out",
    ); // hand far from the head
    assert.equal(classifyPosture("hands_on_head", pose({ ...base, leftWrist: [0.47, 0.02], leftElbow: [0.3, 0.3], rightElbow: [0.7, 0.3] })), "out"); // too high
    assert.equal(classifyPosture("hands_on_head", pose(base)), "unknown"); // elbows not visible
  });

  it("hands_together: wrists close, between shoulders and hips", () => {
    assert.equal(classifyPosture("hands_together", pose({ ...DESK, leftWrist: [0.49, 0.65], rightWrist: [0.51, 0.66] })), "in");
    assert.equal(classifyPosture("hands_together", pose({ ...DESK, leftWrist: [0.4, 0.65], rightWrist: [0.6, 0.65] })), "out");
    assert.equal(classifyPosture("hands_together", pose({ ...DESK, leftWrist: [0.49, 0.2], rightWrist: [0.51, 0.2] })), "out"); // above the head
    assert.equal(classifyPosture("hands_together", pose({ ...STANDING, leftWrist: [0.49, 0.6], rightWrist: [0.51, 0.6] })), "out"); // below the hips
  });

  it("stand: straight knees and hips, upright torso", () => {
    assert.equal(classifyPosture("stand", pose(STANDING)), "in");
    const bent = { ...STANDING, leftKnee: [0.55, 0.62], rightKnee: [0.6, 0.62] } as const;
    assert.equal(classifyPosture("stand", pose(bent)), "out");
    assert.equal(classifyPosture("stand", pose({ ...STANDING, leftAnkle: undefined, rightAnkle: undefined })), "unknown");
    assert.equal(classifyPosture("kneel", pose(STANDING)), "out");
    assert.equal(classifyPosture("lie_down", pose(STANDING)), "out");
  });

  it("kneel: tall kneel from the side and sitting on the heels from the front; not sitting on a chair", () => {
    const tall = {
      leftShoulder: [0.5, 0.3],
      rightShoulder: [0.51, 0.3],
      leftHip: [0.5, 0.55],
      rightHip: [0.51, 0.55],
      leftKnee: [0.5, 0.8],
      rightKnee: [0.51, 0.8],
      leftAnkle: [0.32, 0.82],
      rightAnkle: [0.33, 0.82],
    } as const;
    assert.equal(classifyPosture("kneel", pose(tall)), "in");
    const heels = {
      leftShoulder: [0.42, 0.4],
      rightShoulder: [0.58, 0.4],
      leftHip: [0.45, 0.68],
      rightHip: [0.55, 0.68],
      leftKnee: [0.42, 0.8],
      rightKnee: [0.58, 0.8],
      leftAnkle: [0.44, 0.77],
      rightAnkle: [0.56, 0.77],
    } as const;
    assert.equal(classifyPosture("kneel", pose(heels)), "in");
    const chair = {
      ...heels,
      leftKnee: [0.42, 0.72],
      rightKnee: [0.58, 0.72],
      leftAnkle: [0.42, 0.95],
      rightAnkle: [0.58, 0.95],
    } as const;
    assert.equal(classifyPosture("kneel", pose(chair)), "out");
    assert.equal(classifyPosture("kneel", pose({ ...heels, leftAnkle: undefined, rightAnkle: undefined })), "unknown");
  });

  it("kneel_sit: on the heels with an upright back; not a tall kneel, cross-legged or bowing forward", () => {
    const front = {
      leftShoulder: [0.42, 0.4],
      rightShoulder: [0.58, 0.4],
      leftHip: [0.45, 0.68],
      rightHip: [0.55, 0.68],
      leftKnee: [0.42, 0.8],
      rightKnee: [0.58, 0.8],
      leftAnkle: [0.44, 0.77],
      rightAnkle: [0.56, 0.77],
    } as const;
    assert.equal(classifyPosture("kneel_sit", pose(front)), "in");
    assert.equal(classifyPosture("kneel", pose(front)), "in"); // sitting on the heels is a kneel too
    // from the side, facing right: thighs forward, shins folded back under the hips
    const side = {
      leftShoulder: [0.5, 0.35],
      leftHip: [0.5, 0.6],
      leftKnee: [0.65, 0.68],
      leftAnkle: [0.48, 0.7],
    } as const;
    assert.equal(classifyPosture("kneel_sit", pose(side)), "in");
    const tall = {
      leftShoulder: [0.5, 0.3],
      rightShoulder: [0.51, 0.3],
      leftHip: [0.5, 0.55],
      rightHip: [0.51, 0.55],
      leftKnee: [0.5, 0.8],
      rightKnee: [0.51, 0.8],
      leftAnkle: [0.32, 0.82],
      rightAnkle: [0.33, 0.82],
    } as const;
    assert.equal(classifyPosture("kneel_sit", pose(tall)), "out");
    const crossLegged = {
      ...front,
      leftHip: [0.45, 0.7],
      rightHip: [0.55, 0.7],
      leftKnee: [0.3, 0.68],
      rightKnee: [0.7, 0.68],
      leftAnkle: [0.47, 0.72],
      rightAnkle: [0.53, 0.72],
    } as const;
    assert.equal(classifyPosture("kneel_sit", pose(crossLegged)), "out");
    const bowing = { ...side, leftShoulder: [0.7, 0.55] } as const;
    assert.equal(classifyPosture("kneel_sit", pose(bowing)), "out");
    assert.equal(classifyPosture("kneel_sit", pose(STANDING)), "out");
    assert.equal(classifyPosture("kneel_sit", pose({ ...front, leftAnkle: undefined, rightAnkle: undefined })), "unknown");
  });

  it("says what is missing for kneel_sit, most basic first", () => {
    const side = { leftShoulder: [0.5, 0.35], leftHip: [0.5, 0.6], leftKnee: [0.65, 0.68], leftAnkle: [0.48, 0.7] } as const;
    assert.deepEqual(assessPosture("kneel_sit", pose(side)), { state: "in" });
    // tall kneel: hips up over the knees
    const tall = { leftShoulder: [0.5, 0.3], leftHip: [0.5, 0.55], leftKnee: [0.5, 0.8], leftAnkle: [0.32, 0.82] } as const;
    assert.deepEqual(assessPosture("kneel_sit", pose(tall)), { state: "out", hint: H.ontoHeels });
    assert.deepEqual(assessPosture("kneel_sit", pose({ ...side, leftShoulder: [0.7, 0.55] })), { state: "out", hint: H.backStraight });
    assert.deepEqual(assessPosture("kneel_sit", pose(STANDING)), { state: "out", hint: H.kneesDown });
    const crossLegged = { leftShoulder: [0.45, 0.4], leftHip: [0.45, 0.7], leftKnee: [0.3, 0.68], leftAnkle: [0.47, 0.72] } as const;
    assert.deepEqual(assessPosture("kneel_sit", pose(crossLegged)), { state: "out", hint: H.heelsNotFloor });
    assert.deepEqual(assessPosture("kneel_sit", pose({ ...side, leftAnkle: undefined })), { state: "unknown", hint: H.showLegs });
  });

  it("says what is missing for the other poses", () => {
    assert.equal(assessPosture("arms_up", pose({ ...DESK, leftWrist: [0.4, 0.05], rightWrist: [0.6, 0.27] })).hint, H.armsUp);
    assert.equal(assessPosture("arms_up", pose(DESK)).hint, H.showHands);
    const head = { ...DESK, leftWrist: [0.47, 0.2], rightWrist: [0.53, 0.2] } as const;
    assert.equal(assessPosture("hands_on_head", pose({ ...head, leftElbow: [0.45, 0.45], rightElbow: [0.55, 0.45] })).hint, H.elbowsOut);
    assert.equal(assessPosture("hands_together", pose({ ...DESK, leftWrist: [0.4, 0.65], rightWrist: [0.6, 0.65] })).hint, H.handsTogether);
    assert.equal(assessPosture("stand", pose({ ...STANDING, leftKnee: [0.55, 0.62], rightKnee: [0.6, 0.62] })).hint, H.legsStraight);
    assert.equal(assessPosture("kneel", pose(STANDING)).hint, H.kneesDown);
    assert.equal(assessPosture("lie_down", pose(STANDING)).hint, H.lieFlat);
    assert.equal(assessPosture("stand", pose(STANDING)).hint, undefined);
  });

  it("lie_down: shoulder-hip line near horizontal", () => {
    const lying = { leftShoulder: [0.2, 0.6], rightShoulder: [0.21, 0.63], leftHip: [0.5, 0.62], rightHip: [0.5, 0.66] } as const;
    assert.equal(classifyPosture("lie_down", pose(lying)), "in");
    const tilted = { ...lying, leftHip: [0.35, 0.95], rightHip: [0.36, 0.97] } as const; // ~45 degrees
    assert.equal(classifyPosture("lie_down", pose(tilted)), "out");
    assert.equal(classifyPosture("lie_down", pose({ leftShoulder: [0.2, 0.6] })), "unknown");
    assert.equal(classifyPosture("stand", pose({ ...lying, leftKnee: [0.7, 0.62], leftAnkle: [0.9, 0.62] })), "out");
  });

  it("aspect changes angles", () => {
    // the same normalized points are flatter in a wide frame than in a tall one
    const p = pose({ leftShoulder: [0.2, 0.5], rightShoulder: [0.2, 0.5], leftHip: [0.5, 0.75], rightHip: [0.5, 0.75] });
    assert.equal(classifyPosture("lie_down", p, 16 / 9), "in"); // atan(0.25 / 0.533) = 25 deg
    assert.equal(classifyPosture("lie_down", p, 0.75), "out"); // atan(0.25 / 0.225) = 48 deg
  });

  it("ignores low-visibility landmarks", () => {
    assert.equal(classifyPosture("arms_up", pose({ ...DESK, leftWrist: [0.4, 0.05, 0.4], rightWrist: [0.6, 0.05] })), "unknown");
    assert.equal(classifyPosture("arms_up", undefined), "unknown");
  });
});
