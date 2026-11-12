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

  // yoga floor poses: side-on fixtures face right and show the left side only
  const STANDING_ARMS = { ...STANDING, leftElbow: [0.44, 0.38], rightElbow: [0.56, 0.38], leftWrist: [0.44, 0.5], rightWrist: [0.56, 0.5] } as const;
  const TABLE = {
    leftShoulder: [0.6, 0.5],
    leftElbow: [0.6, 0.63],
    leftWrist: [0.6, 0.77],
    leftHip: [0.35, 0.5],
    leftKnee: [0.35, 0.75],
    leftAnkle: [0.15, 0.77],
    nose: [0.7, 0.53],
  } as const;

  it("cat and cow: on hands and knees, told apart by the head", () => {
    const cat = { ...TABLE, nose: [0.68, 0.62] } as const;
    const cow = { ...TABLE, nose: [0.7, 0.42] } as const;
    assert.deepEqual(assessPosture("cat", pose(cat)), { state: "in" });
    assert.deepEqual(assessPosture("cow", pose(cow)), { state: "in" });
    assert.deepEqual(assessPosture("cat", pose(cow)), { state: "out", hint: H.roundBack });
    assert.deepEqual(assessPosture("cow", pose(cat)), { state: "out", hint: H.archBack });
    // a neutral tabletop is neither
    assert.equal(classifyPosture("cat", pose(TABLE)), "out");
    assert.equal(classifyPosture("cow", pose(TABLE)), "out");
    // from the front: shoulders wide, torso foreshortened
    const front = {
      leftShoulder: [0.42, 0.4],
      rightShoulder: [0.58, 0.4],
      leftElbow: [0.42, 0.55],
      rightElbow: [0.58, 0.55],
      leftWrist: [0.42, 0.7],
      rightWrist: [0.58, 0.7],
      leftHip: [0.45, 0.35],
      rightHip: [0.55, 0.35],
      leftKnee: [0.45, 0.6],
      rightKnee: [0.55, 0.6],
      leftAnkle: [0.45, 0.58],
      rightAnkle: [0.55, 0.58],
    } as const;
    assert.equal(classifyPosture("cat", pose({ ...front, nose: [0.5, 0.58] })), "in");
    assert.equal(classifyPosture("cow", pose({ ...front, nose: [0.5, 0.3] })), "in");
    // a tall kneel with the arms hanging: hands not on the floor
    const tall = { ...cat, leftHip: [0.5, 0.5], leftShoulder: [0.5, 0.25], leftElbow: [0.5, 0.38], leftWrist: [0.5, 0.5], nose: [0.5, 0.15] } as const;
    assert.equal(assessPosture("cat", pose({ ...tall, leftKnee: [0.5, 0.75] })).hint, H.handsFloor);
    assert.equal(assessPosture("cat", pose(STANDING_ARMS)).hint, H.allFours);
    assert.deepEqual(assessPosture("cat", pose({ ...cat, leftAnkle: undefined })), { state: "unknown", hint: H.showWhole });
    assert.equal(classifyPosture("cat", pose({ ...cat, nose: undefined })), "unknown");
  });

  it("puppy: hips over the knees, chest down, arms forward; side-on only", () => {
    const puppy = { ...TABLE, leftShoulder: [0.6, 0.72], leftElbow: [0.72, 0.75], leftWrist: [0.85, 0.77], nose: [0.68, 0.77] } as const;
    assert.deepEqual(assessPosture("puppy", pose(puppy)), { state: "in" });
    assert.deepEqual(assessPosture("puppy", pose(TABLE)), { state: "out", hint: H.chestDown });
    // child's pose: hips back on the heels
    assert.deepEqual(assessPosture("puppy", pose({ ...puppy, leftHip: [0.25, 0.68] })), { state: "out", hint: H.hipsOverKnees });
    // chest down but the hands by the knees
    assert.equal(assessPosture("puppy", pose({ ...puppy, leftElbow: [0.5, 0.75], leftWrist: [0.45, 0.77] })).hint, H.reachForward);
    assert.equal(assessPosture("puppy", pose({ ...STANDING_ARMS, rightShoulder: undefined })).hint, H.allFours);
    assert.deepEqual(assessPosture("puppy", pose({ ...puppy, rightShoulder: [0.4, 0.72] })), { state: "unknown", hint: H.turnSide });
  });

  const DOG = {
    leftWrist: [0.75, 0.85],
    leftElbow: [0.7, 0.75],
    leftShoulder: [0.65, 0.65],
    leftHip: [0.45, 0.35],
    leftKnee: [0.38, 0.6],
    leftAnkle: [0.3, 0.85],
  } as const;

  it("down_dog: hands and feet down, hips high, an open V; side-on only", () => {
    assert.deepEqual(assessPosture("down_dog", pose(DOG)), { state: "in" });
    // both shoulders seen but overlapping: still side-on
    assert.equal(classifyPosture("down_dog", pose({ ...DOG, rightShoulder: [0.66, 0.65] })), "in");
    // standing forward fold, hands by the feet
    const fold = { leftWrist: [0.53, 0.9], leftElbow: [0.53, 0.8], leftShoulder: [0.53, 0.7], leftHip: [0.5, 0.4], leftKnee: [0.5, 0.65], leftAnkle: [0.5, 0.9] } as const;
    assert.deepEqual(assessPosture("down_dog", pose(fold)), { state: "out", hint: H.handsForward });
    assert.equal(assessPosture("down_dog", pose({ ...DOG, leftKnee: [0.3, 0.45] })).hint, H.legsStraight);
    assert.equal(assessPosture("down_dog", pose({ ...DOG, leftElbow: [0.62, 0.8] })).hint, H.armsStraight);
    assert.equal(assessPosture("down_dog", pose(TABLE)).hint, H.hipsUp);
    assert.deepEqual(assessPosture("down_dog", pose({ ...DOG, rightShoulder: [0.5, 0.65] })), { state: "unknown", hint: H.turnSide });
  });

  const PLANK = {
    leftShoulder: [0.7, 0.6],
    leftElbow: [0.7, 0.72],
    leftWrist: [0.7, 0.84],
    leftHip: [0.45, 0.66],
    leftKnee: [0.3, 0.7],
    leftAnkle: [0.15, 0.74],
  } as const;

  it("plank: level, straight body, held up on the arms; says which way the hips go", () => {
    assert.deepEqual(assessPosture("plank", pose(PLANK)), { state: "in" });
    // forearm plank
    assert.equal(classifyPosture("plank", pose({ ...PLANK, leftShoulder: [0.7, 0.68], leftElbow: [0.7, 0.8], leftWrist: [0.82, 0.8], leftHip: [0.45, 0.71] })), "in");
    assert.deepEqual(assessPosture("plank", pose({ ...PLANK, leftHip: [0.45, 0.75], leftKnee: [0.3, 0.745] })), { state: "out", hint: H.hipsUp });
    assert.deepEqual(assessPosture("plank", pose({ ...PLANK, leftHip: [0.45, 0.5], leftKnee: [0.3, 0.62] })), { state: "out", hint: H.hipsLower });
    const flat = { leftShoulder: [0.7, 0.8], leftElbow: [0.6, 0.82], leftWrist: [0.5, 0.82], leftHip: [0.45, 0.82], leftKnee: [0.3, 0.82], leftAnkle: [0.15, 0.82] } as const;
    assert.deepEqual(assessPosture("plank", pose(flat)), { state: "out", hint: H.onHands });
    assert.equal(assessPosture("plank", pose({ ...PLANK, leftKnee: [0.3, 0.84], leftAnkle: [0.15, 0.7] })).hint, H.legsStraight);
    assert.equal(assessPosture("plank", pose(DOG)).hint, H.bodyLevel);
    // head towards the camera: the body points at it, the line can't be judged
    const front = { leftShoulder: [0.4, 0.5], rightShoulder: [0.6, 0.5], leftElbow: [0.4, 0.62], leftWrist: [0.4, 0.75], leftHip: [0.45, 0.45], rightHip: [0.55, 0.45], leftKnee: [0.46, 0.43], leftAnkle: [0.47, 0.42] } as const;
    assert.deepEqual(assessPosture("plank", pose(front)), { state: "unknown", hint: H.turnSide });
    assert.deepEqual(assessPosture("plank", pose({ ...PLANK, leftWrist: undefined })), { state: "unknown", hint: H.showWhole });
  });

  it("plow: on the shoulders, hips up, straight legs over the head", () => {
    const plow = { leftShoulder: [0.47, 0.82], leftHip: [0.45, 0.5], leftKnee: [0.6, 0.62], leftAnkle: [0.75, 0.8], nose: [0.55, 0.8] } as const;
    assert.deepEqual(assessPosture("plow", pose(plow)), { state: "in" });
    // shoulder stand: legs up, not over
    assert.deepEqual(assessPosture("plow", pose({ ...plow, leftKnee: [0.45, 0.32], leftAnkle: [0.45, 0.15] })), { state: "out", hint: H.legsOverHead });
    // feet still in the air
    assert.equal(assessPosture("plow", pose({ ...plow, leftKnee: [0.58, 0.48], leftAnkle: [0.72, 0.6] })).hint, H.feetDown);
    // knees bent by the ears
    assert.equal(assessPosture("plow", pose({ ...plow, leftKnee: [0.65, 0.45], leftAnkle: [0.6, 0.75] })).hint, H.legsStraight);
    // standing forward fold: hips over the shoulders, but the feet far below them
    const fold = { leftShoulder: [0.53, 0.7], leftHip: [0.5, 0.4], leftKnee: [0.5, 0.65], leftAnkle: [0.5, 0.9] } as const;
    assert.equal(assessPosture("plow", pose(fold)).hint, H.shouldersDown);
    assert.equal(assessPosture("plow", pose(STANDING)).state, "unknown"); // facing the camera
    assert.equal(assessPosture("plow", pose({ ...STANDING, rightShoulder: undefined })).hint, H.hipsOverShoulders);
  });

  const STRADDLE = {
    leftShoulder: [0.42, 0.35],
    rightShoulder: [0.58, 0.35],
    leftHip: [0.45, 0.62],
    rightHip: [0.55, 0.62],
    leftKnee: [0.3, 0.7],
    rightKnee: [0.7, 0.7],
    leftAnkle: [0.12, 0.8],
    rightAnkle: [0.88, 0.8],
  } as const;
  const STRADDLE_UP = {
    leftShoulder: [0.43, 0.3],
    rightShoulder: [0.57, 0.3],
    leftHip: [0.46, 0.6],
    rightHip: [0.54, 0.6],
    leftKnee: [0.33, 0.45],
    rightKnee: [0.67, 0.45],
    leftAnkle: [0.2, 0.3],
    rightAnkle: [0.8, 0.3],
  } as const;

  it("straddle: seated, straight legs wide on the floor; facing the camera only", () => {
    assert.deepEqual(assessPosture("straddle", pose(STRADDLE)), { state: "in" });
    const narrow = { ...STRADDLE, leftKnee: [0.42, 0.73], rightKnee: [0.58, 0.73], leftAnkle: [0.4, 0.85], rightAnkle: [0.6, 0.85] } as const;
    assert.deepEqual(assessPosture("straddle", pose(narrow)), { state: "out", hint: H.legsWide });
    assert.equal(assessPosture("straddle", pose(STANDING)).hint, H.sitDown);
    assert.equal(assessPosture("straddle", pose(STRADDLE_UP)).hint, H.legsDown);
    assert.equal(assessPosture("straddle", pose({ ...STRADDLE, leftKnee: [0.3, 0.6] })).hint, H.legsStraight);
    const side = { leftShoulder: [0.4, 0.4], rightShoulder: [0.41, 0.4], leftHip: [0.4, 0.7], rightHip: [0.41, 0.7], leftKnee: [0.6, 0.7], rightKnee: [0.61, 0.7], leftAnkle: [0.8, 0.7], rightAnkle: [0.81, 0.7] } as const;
    assert.deepEqual(assessPosture("straddle", pose(side)), { state: "unknown", hint: H.faceCamera });
    assert.deepEqual(assessPosture("straddle", pose({ ...STRADDLE, rightAnkle: undefined })), { state: "unknown", hint: H.showLegs });
  });

  it("straddle_up: balancing on the seat, straight legs lifted wide, back up", () => {
    assert.deepEqual(assessPosture("straddle_up", pose(STRADDLE_UP)), { state: "in" });
    assert.deepEqual(assessPosture("straddle_up", pose(STRADDLE)), { state: "out", hint: H.legsUp });
    // legs lifted together: a boat pose
    const boat = { ...STRADDLE_UP, leftKnee: [0.47, 0.45], rightKnee: [0.53, 0.45], leftAnkle: [0.48, 0.3], rightAnkle: [0.52, 0.3] } as const;
    assert.equal(assessPosture("straddle_up", pose(boat)).hint, H.legsWide);
    assert.equal(assessPosture("straddle_up", pose({ ...STRADDLE_UP, leftKnee: [0.4, 0.4] })).hint, H.legsStraight);
    // leaning far to the side
    assert.equal(assessPosture("straddle_up", pose({ ...STRADDLE_UP, leftShoulder: [0.2, 0.42], rightShoulder: [0.34, 0.32] })).hint, H.backStraight);
  });

  it("child: knees down, hips on the heels, folded over the thighs", () => {
    const child = { leftShoulder: [0.55, 0.74], leftHip: [0.32, 0.72], leftKnee: [0.5, 0.8], leftAnkle: [0.3, 0.82], nose: [0.65, 0.8] } as const;
    assert.deepEqual(assessPosture("child", pose(child)), { state: "in" });
    // sitting up on the heels (thunderbolt / kneel_sit)
    const seiza = { leftShoulder: [0.5, 0.35], leftHip: [0.5, 0.6], leftKnee: [0.65, 0.68], leftAnkle: [0.48, 0.7] } as const;
    assert.deepEqual(assessPosture("child", pose(seiza)), { state: "out", hint: H.foldOverThighs });
    assert.equal(assessPosture("child", pose({ leftShoulder: [0.6, 0.72], leftHip: [0.35, 0.5], leftKnee: [0.35, 0.75], leftAnkle: [0.15, 0.77] })).hint, H.ontoHeels); // puppy
    assert.equal(assessPosture("child", pose(STANDING)).hint, H.kneesDown);
    assert.deepEqual(assessPosture("child", pose({ ...child, leftAnkle: undefined })), { state: "unknown", hint: H.showLegs });
  });

  it("forward_fold: standing, folded down from the hips; not down dog or plow", () => {
    const fold = { leftShoulder: [0.53, 0.7], leftHip: [0.5, 0.4], leftKnee: [0.5, 0.65], leftAnkle: [0.5, 0.9] } as const;
    assert.deepEqual(assessPosture("forward_fold", pose(fold)), { state: "in" });
    const front = {
      leftShoulder: [0.42, 0.7],
      rightShoulder: [0.58, 0.7],
      leftHip: [0.45, 0.4],
      rightHip: [0.55, 0.4],
      leftKnee: [0.45, 0.65],
      rightKnee: [0.55, 0.65],
      leftAnkle: [0.45, 0.9],
      rightAnkle: [0.55, 0.9],
    } as const;
    assert.equal(classifyPosture("forward_fold", pose(front)), "in");
    assert.deepEqual(assessPosture("forward_fold", pose(STANDING)), { state: "out", hint: H.foldDeeper });
    assert.equal(assessPosture("forward_fold", pose({ ...fold, leftShoulder: [0.75, 0.42] })).hint, H.foldDeeper); // flat back, half way
    assert.equal(assessPosture("forward_fold", pose(DOG)).hint, H.foldDeeper);
    assert.equal(assessPosture("forward_fold", pose({ ...fold, leftKnee: [0.6, 0.7] })).hint, H.legsStraight);
    const plow = { leftShoulder: [0.47, 0.82], leftHip: [0.45, 0.5], leftKnee: [0.6, 0.62], leftAnkle: [0.75, 0.8] } as const;
    assert.equal(assessPosture("forward_fold", pose(plow)).hint, H.onFeet);
  });

  // lying on the back, head to the left
  const SAVASANA = {
    leftShoulder: [0.3, 0.8],
    leftElbow: [0.4, 0.82],
    leftWrist: [0.5, 0.83],
    leftHip: [0.55, 0.8],
    leftKnee: [0.72, 0.81],
    leftAnkle: [0.88, 0.82],
    nose: [0.22, 0.76],
  } as const;

  it("happy_baby: on the back, knees to the armpits, soles up, holding the feet", () => {
    const baby = { ...SAVASANA, leftKnee: [0.365, 0.628], leftAnkle: [0.365, 0.378], leftElbow: [0.33, 0.6], leftWrist: [0.37, 0.4] } as const;
    assert.deepEqual(assessPosture("happy_baby", pose(baby)), { state: "in" });
    assert.deepEqual(assessPosture("happy_baby", pose({ ...baby, leftWrist: [0.5, 0.82] })), { state: "out", hint: H.holdFeet });
    // straight legs pointing up
    assert.equal(assessPosture("happy_baby", pose({ ...baby, leftKnee: [0.55, 0.55], leftAnkle: [0.55, 0.3], leftWrist: [0.55, 0.32] })).hint, H.bendKnees);
    assert.equal(assessPosture("happy_baby", pose(SAVASANA)).hint, H.kneesToChest);
    assert.equal(assessPosture("happy_baby", pose({ ...STANDING_ARMS, rightShoulder: undefined })).hint, H.lieBack);
    assert.deepEqual(assessPosture("happy_baby", pose({ ...baby, rightShoulder: [0.3, 0.6] })), { state: "unknown", hint: H.turnSide });
  });

  it("savasana: flat on the back, legs long, arms by the sides", () => {
    assert.deepEqual(assessPosture("savasana", pose(SAVASANA)), { state: "in" });
    assert.deepEqual(assessPosture("savasana", pose({ ...SAVASANA, leftElbow: [0.2, 0.8], leftWrist: [0.1, 0.8] })), { state: "out", hint: H.armsDown }); // arms overhead
    assert.equal(assessPosture("savasana", pose({ ...SAVASANA, leftKnee: [0.65, 0.65], leftAnkle: [0.75, 0.82] })).hint, H.legsDown); // knees up
    assert.equal(assessPosture("savasana", pose(PLANK)).hint, H.armsDown);
    assert.equal(assessPosture("savasana", pose({ ...STANDING_ARMS, rightShoulder: undefined })).hint, H.lieFlat);
    assert.deepEqual(assessPosture("savasana", pose({ ...SAVASANA, leftWrist: undefined })), { state: "unknown", hint: H.showWhole });
  });

  it("hastasana: standing, both arms straight overhead", () => {
    const salute = { ...STANDING, leftElbow: [0.43, 0.12], rightElbow: [0.57, 0.12], leftWrist: [0.42, 0.0], rightWrist: [0.58, 0.0] } as const;
    assert.deepEqual(assessPosture("hastasana", pose(salute)), { state: "in" });
    assert.deepEqual(assessPosture("hastasana", pose({ ...salute, leftElbow: [0.36, 0.1] })), { state: "out", hint: H.armsStraight });
    assert.deepEqual(assessPosture("hastasana", pose(STANDING_ARMS)), { state: "out", hint: H.armsUp });
    assert.equal(assessPosture("hastasana", pose({ ...salute, leftKnee: [0.55, 0.62], rightKnee: [0.6, 0.62] })).hint, H.legsStraight);
    assert.deepEqual(assessPosture("hastasana", pose({ ...salute, leftAnkle: undefined, rightAnkle: undefined })), { state: "unknown", hint: H.showLegs });
  });

  it("warrior: wide stance, front knee bent, back leg straight, arms out; facing the camera", () => {
    const warrior = {
      leftShoulder: [0.45, 0.3],
      rightShoulder: [0.55, 0.3],
      leftElbow: [0.37, 0.3],
      rightElbow: [0.63, 0.3],
      leftWrist: [0.29, 0.3],
      rightWrist: [0.71, 0.31],
      leftHip: [0.47, 0.52],
      rightHip: [0.53, 0.52],
      leftKnee: [0.33, 0.58],
      rightKnee: [0.6, 0.66],
      leftAnkle: [0.33, 0.8],
      rightAnkle: [0.67, 0.8],
    } as const;
    assert.deepEqual(assessPosture("warrior", pose(warrior)), { state: "in" });
    assert.deepEqual(assessPosture("warrior", pose(STANDING_ARMS)), { state: "out", hint: H.feetWide });
    // wide, both legs straight
    assert.equal(assessPosture("warrior", pose({ ...warrior, leftKnee: [0.4, 0.66] })).hint, H.bendFrontKnee);
    // wide squat: both knees bent
    assert.equal(assessPosture("warrior", pose({ ...warrior, rightKnee: [0.67, 0.58] })).hint, H.backLegStraight);
    // arms overhead (warrior I arms)
    const armsUp = { ...warrior, leftElbow: [0.44, 0.17], rightElbow: [0.56, 0.17], leftWrist: [0.43, 0.04], rightWrist: [0.57, 0.04] } as const;
    assert.equal(assessPosture("warrior", pose(armsUp)).hint, H.armsOut);
    assert.deepEqual(assessPosture("warrior", pose({ ...warrior, rightShoulder: [0.46, 0.3] })), { state: "unknown", hint: H.faceCamera });
    assert.deepEqual(assessPosture("warrior", pose({ ...warrior, rightWrist: undefined })), { state: "unknown", hint: H.showWhole });
  });

  it("tree: one straight leg, the other foot on it, knee out; facing the camera", () => {
    const tree = {
      leftShoulder: [0.45, 0.25],
      rightShoulder: [0.55, 0.25],
      leftHip: [0.47, 0.5],
      rightHip: [0.53, 0.5],
      leftKnee: [0.38, 0.62],
      rightKnee: [0.53, 0.7],
      leftAnkle: [0.51, 0.6],
      rightAnkle: [0.53, 0.9],
    } as const;
    assert.deepEqual(assessPosture("tree", pose(tree)), { state: "in" });
    // mirrored: standing on the left leg
    const mirrored = { ...tree, leftKnee: [0.47, 0.7], leftAnkle: [0.47, 0.9], rightKnee: [0.62, 0.62], rightAnkle: [0.49, 0.6] } as const;
    assert.equal(classifyPosture("tree", pose(mirrored)), "in");
    assert.deepEqual(assessPosture("tree", pose(STANDING)), { state: "out", hint: H.footOnLeg });
    // knee up, foot hanging free
    assert.equal(assessPosture("tree", pose({ ...tree, leftAnkle: [0.4, 0.75] })).hint, H.footOnLeg);
    // foot on the calf, knee pointing at the camera
    assert.equal(assessPosture("tree", pose({ ...tree, leftKnee: [0.49, 0.62], leftAnkle: [0.52, 0.72] })).hint, H.kneeOut);
    assert.equal(assessPosture("tree", pose({ ...tree, leftShoulder: [0.3, 0.32], rightShoulder: [0.4, 0.28] })).hint, H.torsoUpright);
    assert.equal(assessPosture("tree", pose({ ...tree, rightKnee: [0.6, 0.7] })).hint, H.standOneLeg);
    assert.deepEqual(assessPosture("tree", pose({ ...tree, rightShoulder: [0.46, 0.25] })), { state: "unknown", hint: H.faceCamera });
  });

  it("cobra: on the belly, legs down, chest lifted on the hands; side-on only", () => {
    const cobra = {
      leftShoulder: [0.62, 0.62],
      leftElbow: [0.63, 0.72],
      leftWrist: [0.62, 0.82],
      leftHip: [0.45, 0.8],
      leftKnee: [0.3, 0.81],
      leftAnkle: [0.15, 0.82],
      nose: [0.7, 0.5],
    } as const;
    assert.deepEqual(assessPosture("cobra", pose(cobra)), { state: "in" });
    assert.deepEqual(assessPosture("cobra", pose(SAVASANA)), { state: "out", hint: H.chestUp });
    // sphinx: on the forearms, hands out in front
    const sphinx = { ...cobra, leftShoulder: [0.6, 0.68], leftElbow: [0.6, 0.82], leftWrist: [0.72, 0.82] } as const;
    assert.equal(assessPosture("cobra", pose(sphinx)).hint, H.handsUnder);
    assert.equal(assessPosture("cobra", pose({ ...cobra, leftElbow: [0.7, 0.72] })).hint, H.armsStraight);
    assert.equal(assessPosture("cobra", pose(PLANK)).hint, H.chestUp);
    assert.equal(assessPosture("cobra", pose(DOG)).hint, H.lieFlat);
    assert.deepEqual(assessPosture("cobra", pose({ ...cobra, rightShoulder: [0.42, 0.62] })), { state: "unknown", hint: H.turnSide });
  });

  it("butterfly: seated, soles together, heels in, knees out; facing the camera", () => {
    const butterfly = {
      leftShoulder: [0.44, 0.35],
      rightShoulder: [0.56, 0.35],
      leftHip: [0.47, 0.62],
      rightHip: [0.53, 0.62],
      leftKnee: [0.3, 0.66],
      rightKnee: [0.7, 0.66],
      leftAnkle: [0.48, 0.72],
      rightAnkle: [0.52, 0.72],
    } as const;
    assert.deepEqual(assessPosture("butterfly", pose(butterfly)), { state: "in" });
    // cross-legged: each foot under the other knee
    assert.deepEqual(assessPosture("butterfly", pose({ ...butterfly, leftAnkle: [0.62, 0.7], rightAnkle: [0.38, 0.7] })), { state: "out", hint: H.feetTogether });
    // soles together far out in front
    assert.equal(assessPosture("butterfly", pose({ ...butterfly, leftKnee: [0.3, 0.72], rightKnee: [0.7, 0.72], leftAnkle: [0.48, 0.86], rightAnkle: [0.52, 0.86] })).hint, H.heelsIn);
    // knees up together (feet flat in front)
    assert.equal(assessPosture("butterfly", pose({ ...butterfly, leftKnee: [0.45, 0.5], rightKnee: [0.55, 0.5] })).hint, H.kneesOutSides);
    assert.equal(assessPosture("butterfly", pose({ ...butterfly, leftShoulder: [0.24, 0.45], rightShoulder: [0.36, 0.38] })).hint, H.backStraight);
    assert.equal(assessPosture("butterfly", pose(STANDING)).hint, H.sitDown);
    assert.deepEqual(assessPosture("butterfly", pose({ ...butterfly, rightShoulder: [0.45, 0.35] })), { state: "unknown", hint: H.faceCamera });
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
