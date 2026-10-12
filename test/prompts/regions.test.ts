import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { convexHull, pointInRegion, targetRegion, toViewport, videoContentRect } from "../../src/prompts/regions.ts";
import type { Region } from "../../src/prompts/types.ts";
import { BOX, BOX_FULL, STANDING, frame, pose } from "./fixtures.ts";

// BOX content rect: x 0..1000, y 218.75..781.25; normalized (x, y) -> (1000x, 218.75 + 562.5y)
const Y = (n: number): number => 218.75 + 562.5 * n;
const X = (n: number): number => 1000 * n;
const inR = (r: Region | undefined, x: number, y: number): boolean => {
  assert.ok(r, "region expected");
  return pointInRegion({ x, y }, r);
};

describe("videoContentRect / toViewport", () => {
  it("letterboxes a wide video in a square element", () => {
    assert.deepEqual(videoContentRect(BOX), { left: 0, top: 218.75, width: 1000, height: 562.5, right: 1000, bottom: 781.25 });
  });
  it("pillarboxes a tall video", () => {
    const r = videoContentRect({ left: 10, top: 20, width: 1000, height: 500, videoWidth: 500, videoHeight: 500 });
    assert.deepEqual(r, { left: 260, top: 20, width: 500, height: 500, right: 760, bottom: 520 });
  });
  it("uses the element rect when the video size is unknown", () => {
    const r = videoContentRect({ left: 5, top: 6, width: 100, height: 50, videoWidth: 0, videoHeight: 0 });
    assert.deepEqual(r, { left: 5, top: 6, width: 100, height: 50, right: 105, bottom: 56 });
  });
  it("maps normalized points through the content rect", () => {
    assert.deepEqual(toViewport({ x: 0.5, y: 0.5 }, BOX), { x: 500, y: 500 });
    assert.deepEqual(toViewport({ x: 0, y: 1 }, BOX), { x: 0, y: 781.25 });
    assert.deepEqual(toViewport({ x: 0.25, y: 0.5 }, BOX_FULL), { x: 500, y: 500 });
  });
});

describe("pointInRegion", () => {
  it("handles ellipses, polygons and outside", () => {
    const e: Region = { kind: "ellipse", cx: 0, cy: 0, rx: 10, ry: 5 };
    assert.equal(pointInRegion({ x: 9, y: 0 }, e), true);
    assert.equal(pointInRegion({ x: 0, y: 6 }, e), false);
    const p: Region = { kind: "polygon", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }] };
    assert.equal(pointInRegion({ x: 2, y: 2 }, p), true);
    assert.equal(pointInRegion({ x: 8, y: 8 }, p), false);
    const o: Region = { kind: "outside", of: { left: 0, top: 0, right: 10, bottom: 10 } };
    assert.equal(pointInRegion({ x: 5, y: 5 }, o), false);
    assert.equal(pointInRegion({ x: 15, y: 5 }, o), true);
    assert.equal(pointInRegion({ x: NaN, y: 5 }, o), false);
  });
  it("convexHull drops interior points", () => {
    const h = convexHull([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 0, y: 2 }]);
    assert.equal(h.length, 4);
  });
});

describe("targetRegion", () => {
  const person = frame([pose(STANDING)]);

  it("eyes: ellipse around both pose eyes with the minimum size", () => {
    const r = targetRegion("eyes", person, BOX)!;
    assert.equal(r.kind, "ellipse");
    if (r.kind !== "ellipse") return;
    assert.equal(r.cx, 500);
    assert.ok(Math.abs(r.cy - Y(0.19)) < 1e-9);
    assert.equal(r.rx, 45); // eye distance 20 px -> min 90 px diameter
    assert.equal(inR(r, 500, Y(0.19) + 40), true);
    assert.equal(inR(r, 500, Y(0.3)), false); // shoulders
  });

  it("eyes: prefers face-mesh eyes and honours minDiameterPx", () => {
    const f = frame([pose(STANDING)], {
      faces: [{ box: { x: 0.45, y: 0.12, w: 0.1, h: 0.15 }, leftEye: { x: 0.47, y: 0.17 }, rightEye: { x: 0.53, y: 0.17 } }],
    });
    const r = targetRegion("eyes", f, BOX, { minDiameterPx: 20 })!;
    assert.equal(r.kind, "ellipse");
    if (r.kind !== "ellipse") return;
    assert.ok(Math.abs(r.cy - Y(0.17)) < 1e-9);
    assert.ok(Math.abs(r.rx - 54) < 1e-9); // 0.9 * 60 px
  });

  it("skips landmarks below 0.5 visibility and returns undefined when nothing is left", () => {
    const p = pose({ ...STANDING, leftEye: [0.49, 0.19, 0.3], rightEye: [0.51, 0.19, 0.49] });
    assert.equal(targetRegion("eyes", frame([p]), BOX), undefined);
    assert.equal(targetRegion("eyes", frame([]), BOX), undefined);
  });

  it("face: face box when it belongs to the main pose, else the pose head hull", () => {
    const own = frame([pose(STANDING)], { faces: [{ box: { x: 0.45, y: 0.12, w: 0.1, h: 0.16 } }] });
    const r = targetRegion("face", own, BOX)!;
    assert.equal(r.kind, "ellipse");
    if (r.kind === "ellipse") {
      assert.equal(r.cx, 500);
      assert.ok(Math.abs(r.cy - Y(0.2)) < 1e-9);
    }
    // a face elsewhere (another person): ignored, pose head used
    const other = frame([pose(STANDING)], { faces: [{ box: { x: 0.05, y: 0.1, w: 0.2, h: 0.3 } }] });
    const r2 = targetRegion("face", other, BOX)!;
    assert.equal(inR(r2, 500, Y(0.2)), true);
    assert.equal(inR(r2, X(0.15), Y(0.25)), false);
    // no pose: the largest face
    const faceOnly = frame([], { faces: [{ box: { x: 0.1, y: 0.1, w: 0.05, h: 0.05 } }, { box: { x: 0.6, y: 0.1, w: 0.2, h: 0.3 } }] });
    assert.equal(inR(targetRegion("face", faceOnly, BOX), X(0.7), Y(0.25)), true);
  });

  it("mouth: face mouth or pose mouth corners", () => {
    assert.equal(inR(targetRegion("mouth", person, BOX), 500, Y(0.22)), true);
    assert.equal(inR(targetRegion("mouth", person, BOX), 500, Y(0.32)), false);
    const p = pose({ ...STANDING, mouthLeft: undefined, mouthRight: undefined });
    assert.equal(targetRegion("mouth", frame([p]), BOX), undefined);
  });

  it("hands: hull of both hands, ellipse for one", () => {
    const both = targetRegion("hands", person, BOX)!;
    assert.equal(both.kind, "polygon");
    assert.equal(inR(both, X(0.42), Y(0.52)), true);
    assert.equal(inR(both, X(0.5), Y(0.52)), true); // between the hands
    assert.equal(inR(both, X(0.5), Y(0.3)), false);
    const one = targetRegion("hands", frame([pose({ ...STANDING, rightWrist: [0.58, 0.52, 0.2] })]), BOX)!;
    assert.equal(one.kind, "ellipse");
    assert.equal(inR(one, X(0.42), Y(0.52)), true);
    assert.equal(inR(one, X(0.58), Y(0.52)), false);
  });

  it("hands: uses hand landmarks next to the wrist, ignores another person's hands", () => {
    const fingers = [{ x: 0.42, y: 0.52 }, { x: 0.41, y: 0.6 }, { x: 0.43, y: 0.61 }];
    const far = [{ x: 0.9, y: 0.5 }, { x: 0.92, y: 0.55 }];
    const f = frame([pose({ ...STANDING, rightWrist: undefined })], { hands: [far, fingers] });
    const r = targetRegion("hands", f, BOX)!;
    assert.equal(inR(r, X(0.42), Y(0.6)), true);
    assert.equal(inR(r, X(0.91), Y(0.52)), false);
    // no pose: the hands themselves
    const r2 = targetRegion("hands", frame([], { hands: [far] }), BOX)!;
    assert.equal(inR(r2, X(0.91), Y(0.52)), true);
  });

  it("chest: between shoulders and 40% towards the hips", () => {
    const r = targetRegion("chest", person, BOX)!;
    assert.equal(inR(r, 500, Y(0.35)), true);
    assert.equal(inR(r, 500, Y(0.5)), false);
    // hips out of frame: estimated
    const close = frame([pose({ ...STANDING, leftHip: undefined, rightHip: undefined })]);
    assert.equal(inR(targetRegion("chest", close, BOX), 500, Y(0.35)), true);
    assert.equal(targetRegion("chest", frame([pose({ ...STANDING, leftShoulder: undefined })]), BOX), undefined);
  });

  it("torso and hips need their landmarks", () => {
    assert.equal(inR(targetRegion("torso", person, BOX), 500, Y(0.45)), true);
    assert.equal(targetRegion("torso", frame([pose({ ...STANDING, rightHip: undefined })]), BOX), undefined);
    const hips = targetRegion("hips", person, BOX)!;
    assert.equal(inR(hips, X(0.45), Y(0.55)), true);
    assert.equal(inR(hips, 500, Y(0.35)), false);
    assert.equal(targetRegion("hips", frame([pose({ ...STANDING, leftHip: undefined })]), BOX), undefined);
  });

  it("groin: below the hip midpoint, about hip width wide", () => {
    const r = targetRegion("groin", person, BOX)!;
    const hm = Y(0.55);
    assert.equal(inR(r, 500, hm + 15), true);
    assert.equal(inR(r, 500, hm + 80), false);
    assert.equal(inR(r, X(0.4), hm + 15), false);
    // knees out of frame: estimated thighs, still a region
    const noKnees = frame([pose({ ...STANDING, leftKnee: undefined, rightKnee: undefined })]);
    assert.equal(inR(targetRegion("groin", noKnees, BOX), 500, hm + 15), true);
    // hips missing: cannot place it
    assert.equal(targetRegion("groin", frame([pose({ ...STANDING, leftHip: undefined })]), BOX), undefined);
    assert.equal(targetRegion("groin", frame([]), BOX), undefined);
  });

  it("legs: hips to ankles", () => {
    const r = targetRegion("legs", person, BOX)!;
    assert.equal(inR(r, 500, Y(0.72)), true);
    assert.equal(inR(r, 500, Y(0.3)), false);
    const noLegs = pose({ ...STANDING, leftKnee: undefined, rightKnee: undefined, leftAnkle: undefined, rightAnkle: undefined });
    assert.equal(targetRegion("legs", frame([noLegs]), BOX), undefined);
  });

  it("feet_floor: from the feet down to the content bottom", () => {
    const r = targetRegion("feet_floor", person, BOX)!;
    assert.equal(inR(r, X(0.5), Y(0.95)), true);
    assert.equal(inR(r, X(0.5), 779), true);
    assert.equal(inR(r, X(0.5), Y(0.72)), false); // knees
    assert.equal(inR(r, X(0.1), Y(0.95)), false);
  });

  it("feet_floor: bottom 20% of the content rect when feet are not visible", () => {
    const noFeet = pose({ ...STANDING, leftHeel: undefined, rightHeel: undefined, leftFootIndex: undefined, rightFootIndex: undefined, leftAnkle: undefined, rightAnkle: undefined });
    for (const f of [frame([noFeet]), frame([])]) {
      const r = targetRegion("feet_floor", f, BOX)!;
      assert.equal(inR(r, 100, 700), true);
      assert.equal(inR(r, 900, 780), true);
      assert.equal(inR(r, 100, 600), false);
    }
  });

  it("feet_floor: low feet still get a band below them", () => {
    const p = pose({ ...STANDING, leftHeel: [0.465, 0.99], rightHeel: [0.525, 0.99], leftFootIndex: [0.48, 0.995], rightFootIndex: [0.54, 0.995] });
    const r = targetRegion("feet_floor", frame([p]), BOX)!;
    assert.equal(inR(r, 500, Y(1) + 10), true); // 15% of a shoulder width (100 px) below the toes
  });

  it("screen_center and off_screen need no person", () => {
    const c = targetRegion("screen_center", frame([]), BOX)!;
    assert.equal(inR(c, 500, 500), true);
    assert.equal(inR(c, 600, 500), true); // rx = 125
    assert.equal(inR(c, 500, 580), false); // ry = 70.3
    const o = targetRegion("off_screen", frame([]), BOX)!;
    assert.equal(o.kind, "outside");
    assert.equal(inR(o, 500, 150), true); // in the letterbox bar, beyond the 5% margin
    assert.equal(inR(o, 500, 200), false); // inside the margin
    assert.equal(inR(o, 500, 500), false);
  });

  it("picks the largest pose as the main person", () => {
    const small = pose({ leftShoulder: [0.1, 0.5], rightShoulder: [0.13, 0.5], leftHip: [0.105, 0.6], rightHip: [0.125, 0.6] });
    const r = targetRegion("torso", frame([small, pose(STANDING)]), BOX)!;
    assert.equal(inR(r, 500, Y(0.45)), true);
    assert.equal(inR(r, X(0.115), Y(0.55)), false);
  });
});

describe("targetRegion: eyes_closed", () => {
  it("has no region, with or without a person", () => {
    assert.equal(targetRegion("eyes_closed", frame([pose(STANDING)]), BOX), undefined);
    assert.equal(targetRegion("eyes_closed", frame([]), BOX), undefined);
  });
});
