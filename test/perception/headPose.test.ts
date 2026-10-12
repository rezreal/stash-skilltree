import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { headPoseFromMatrix, matrixFromHeadPose } from "../../src/perception/headPose.ts";

function near(a: number | undefined, b: number, eps = 1e-6): void {
  assert.ok(a !== undefined && Math.abs(a - b) < eps, `${a} != ${b}`);
}

describe("headPoseFromMatrix", () => {
  it("is zero for the identity", () => {
    const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    assert.deepEqual(headPoseFromMatrix(id), { yaw: 0, pitch: 0, roll: 0 });
  });

  it("round-trips angles, ignoring scale and translation", () => {
    for (const p of [
      { yaw: 30, pitch: 0, roll: 0 },
      { yaw: 0, pitch: -20, roll: 0 },
      { yaw: 0, pitch: 0, roll: 15 },
      { yaw: -25, pitch: 12, roll: -8 },
      { yaw: 60, pitch: -40, roll: 30 },
    ]) {
      const m = matrixFromHeadPose(p, 1.7, [3, -2, -40]);
      const hp = headPoseFromMatrix(m)!;
      near(hp.yaw, p.yaw);
      near(hp.pitch, p.pitch);
      near(hp.roll, p.roll);
    }
  });

  it("yaw > 0 turns the nose (forward +z) towards +x", () => {
    const m = matrixFromHeadPose({ yaw: 30, pitch: 0, roll: 0 });
    // column-major: third column = image of +z
    assert.ok(m[8] > 0, "forward vector has +x component");
  });

  it("pitch > 0 turns the nose up (+y)", () => {
    const m = matrixFromHeadPose({ yaw: 0, pitch: 20, roll: 0 });
    assert.ok(m[9] > 0, "forward vector has +y component");
  });

  it("reads row-major and 3x3 input", () => {
    const p = { yaw: 10, pitch: 5, roll: -3 };
    const cm = matrixFromHeadPose(p);
    const rm: number[] = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) rm.push(cm[c * 4 + r]);
    near(headPoseFromMatrix(rm, "row-major")!.yaw, 10);
    const m3 = [cm[0], cm[1], cm[2], cm[4], cm[5], cm[6], cm[8], cm[9], cm[10]];
    near(headPoseFromMatrix(m3)!.pitch, 5);
  });

  it("handles gimbal lock and bad input", () => {
    const hp = headPoseFromMatrix(matrixFromHeadPose({ yaw: 20, pitch: 90, roll: 0 }))!;
    near(hp.pitch, 90, 1e-3);
    near(hp.roll, 0);
    assert.equal(headPoseFromMatrix([1, 2, 3]), undefined);
    assert.equal(headPoseFromMatrix(new Array(16).fill(NaN)), undefined);
  });
});
