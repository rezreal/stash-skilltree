import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { POSE } from "../../src/prompts/types.ts";
import type { NormPoint } from "../../src/prompts/types.ts";
import { matrixFromHeadPose } from "../../src/perception/headPose.ts";
import {
  blendshapeScore,
  createViewerFrameMapper,
  handRaised,
  meanDisplacement,
  personPresent,
} from "../../src/perception/viewerFrame.ts";

function body(over: Partial<Record<keyof typeof POSE, NormPoint>> = {}, vis = 0.9): NormPoint[] {
  const pts: NormPoint[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.7, visibility: vis }));
  pts[POSE.leftShoulder] = { x: 0.6, y: 0.6, visibility: vis };
  pts[POSE.rightShoulder] = { x: 0.4, y: 0.6, visibility: vis };
  pts[POSE.leftWrist] = { x: 0.65, y: 0.9, visibility: vis };
  pts[POSE.rightWrist] = { x: 0.35, y: 0.9, visibility: vis };
  for (const [k, v] of Object.entries(over)) pts[POSE[k as keyof typeof POSE]] = v!;
  return pts;
}

describe("handRaised", () => {
  it("needs a wrist more than 0.1 above its own shoulder", () => {
    assert.equal(handRaised(body()), false);
    assert.equal(handRaised(body({ leftWrist: { x: 0.65, y: 0.45, visibility: 0.9 } })), true);
    assert.equal(handRaised(body({ rightWrist: { x: 0.35, y: 0.45, visibility: 0.9 } })), true);
    assert.equal(handRaised(body({ leftWrist: { x: 0.65, y: 0.55, visibility: 0.9 } })), false, "only 0.05 above");
  });
  it("ignores invisible joints", () => {
    assert.equal(handRaised(body({ leftWrist: { x: 0.65, y: 0.3, visibility: 0.1 } })), false);
    assert.equal(
      handRaised(body({ leftWrist: { x: 0.65, y: 0.3, visibility: 0.9 }, leftShoulder: { x: 0.6, y: 0.6, visibility: 0.2 } })),
      false,
    );
    assert.equal(handRaised(undefined), false);
  });
  it("accepts a low-visibility wrist at the frame edge", () => {
    assert.equal(handRaised(body({ leftWrist: { x: 0.65, y: 0.02, visibility: 0.35 } })), true);
  });
});

describe("meanDisplacement", () => {
  it("averages over points visible in both frames", () => {
    const a = [{ x: 0, y: 0, visibility: 1 }, { x: 0, y: 0, visibility: 1 }, { x: 0, y: 0, visibility: 0.1 }];
    const b = [{ x: 0.3, y: 0.4, visibility: 1 }, { x: 0, y: 0.1, visibility: 1 }, { x: 1, y: 1, visibility: 1 }];
    assert.ok(Math.abs(meanDisplacement(a, b)! - 0.3) < 1e-9);
    assert.equal(meanDisplacement(undefined, b), undefined);
    assert.equal(meanDisplacement([{ x: 0, y: 0, visibility: 0 }], [{ x: 0, y: 0, visibility: 0 }]), undefined);
    assert.equal(meanDisplacement([{ x: 0, y: 0 }], [{ x: 0, y: 0.5 }]), 0.5, "no visibility = visible");
  });
});

describe("personPresent", () => {
  it("is a face, or >= 8 visible pose landmarks", () => {
    assert.equal(personPresent(true, undefined), true);
    assert.equal(personPresent(false, undefined), false);
    assert.equal(personPresent(false, body()), true);
    const few = body({}, 0.2);
    for (let i = 0; i < 7; i++) few[i] = { ...few[i], visibility: 0.9 };
    assert.equal(personPresent(false, few), false);
    few[7] = { ...few[7], visibility: 0.9 };
    assert.equal(personPresent(false, few), true);
  });
});

describe("createViewerFrameMapper", () => {
  const face = Array.from({ length: 478 }, (_, i) => ({ x: 0.5 + 0.001 * i, y: 0.4, z: 0, visibility: 0 }));
  const shapes = [{ categories: [{ categoryName: "eyeBlinkLeft", score: 0.8 }, { categoryName: "eyeBlinkRight", score: 0.7 }] }];

  it("maps face, blendshapes, head pose, pose and aspect", () => {
    const m = createViewerFrameMapper();
    const f = m.map(1000, {
      faces: [face],
      blendshapes: shapes,
      matrices: [{ data: matrixFromHeadPose({ yaw: 20, pitch: -10, roll: 5 }) }],
      poses: [body({ leftWrist: { x: 0.65, y: 0.3, visibility: 0.9 } }).map((p) => ({ ...p, z: 0, visibility: p.visibility ?? 0 }))],
      aspect: 4 / 3,
    });
    assert.equal(f.t, 1000);
    assert.equal(f.facePresent, true);
    assert.equal(f.personPresent, true);
    assert.equal(f.eyeBlinkLeft, 0.8);
    assert.equal(f.eyeBlinkRight, 0.7);
    assert.ok(Math.abs(f.yaw! - 20) < 1e-6 && Math.abs(f.pitch! + 10) < 1e-6 && Math.abs(f.roll! - 5) < 1e-6);
    assert.equal(f.handRaised, true);
    assert.equal(f.pose!.length, 33);
    assert.equal(f.aspect, 4 / 3);
    assert.equal(f.motion, undefined, "no previous frame");
  });

  it("measures motion against the previous frame of the same kind", () => {
    const m = createViewerFrameMapper();
    const p0 = body();
    const p1 = p0.map((p) => ({ ...p, x: p.x + 0.02 }));
    m.map(0, { poses: [p0] });
    const f = m.map(100, { poses: [p1] });
    assert.ok(Math.abs(f.motion! - 0.02) < 1e-9);
    // switch to face only: no motion this frame, then face motion
    assert.equal(m.map(200, { faces: [face] }).motion, undefined);
    const moved = face.map((p) => ({ ...p, y: p.y + 0.01 }));
    assert.ok(Math.abs(m.map(300, { faces: [moved] }).motion! - 0.01) < 1e-9);
    m.reset();
    assert.equal(m.map(400, { faces: [moved] }).motion, undefined);
  });

  it("reports nobody when nothing was found", () => {
    const f = createViewerFrameMapper().map(5, { faces: [], poses: [] });
    assert.deepEqual(f, { t: 5, facePresent: false, personPresent: false, handRaised: false });
  });

  it("blendshapeScore finds by name", () => {
    assert.equal(blendshapeScore(shapes[0], "eyeBlinkRight"), 0.7);
    assert.equal(blendshapeScore(shapes[0], "jawOpen"), undefined);
    assert.equal(blendshapeScore(undefined, "jawOpen"), undefined);
  });
});
