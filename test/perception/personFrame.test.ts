import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FACE, boundsOf, largestFirst, mapPersonFrame, summarizeFace, toNormPoints } from "../../src/perception/personFrame.ts";
import type { LandmarkLike } from "../../src/perception/personFrame.ts";

/** A pose of 33 points spread over a box, all visible. */
function pose(x: number, y: number, w: number, h: number, vis = 0.9): LandmarkLike[] {
  return Array.from({ length: 33 }, (_, i) => ({ x: x + (w * (i % 4)) / 3, y: y + (h * Math.floor(i / 4)) / 8, z: 0, visibility: vis }));
}

/** A face mesh of n points around (cx, cy). */
function mesh(cx: number, cy: number, size: number, n = 478): LandmarkLike[] {
  const pts: LandmarkLike[] = Array.from({ length: n }, (_, i) => ({
    x: cx + size * Math.cos(i) * 0.5,
    y: cy + size * Math.sin(i) * 0.5,
    z: 0,
    visibility: 0,
  }));
  return pts;
}

describe("toNormPoints / boundsOf", () => {
  it("copies visibility only when asked", () => {
    const lms = [{ x: 0.1, y: 0.2, z: 0, visibility: 0.7 }];
    assert.deepEqual(toNormPoints(lms, true), [{ x: 0.1, y: 0.2, visibility: 0.7 }]);
    assert.deepEqual(toNormPoints(lms, false), [{ x: 0.1, y: 0.2 }]);
  });
  it("bounds visible points, falling back to all", () => {
    const pts = [
      { x: 0.1, y: 0.1, visibility: 0.9 },
      { x: 0.5, y: 0.6, visibility: 0.9 },
      { x: 0.9, y: 0.9, visibility: 0.1 },
    ];
    const b = boundsOf(pts, 0.5)!;
    assert.ok(Math.abs(b.w - 0.4) < 1e-9 && Math.abs(b.h - 0.5) < 1e-9 && b.x === 0.1);
    assert.deepEqual(boundsOf(pts.map((p) => ({ ...p, visibility: 0 })), 0.5), { x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
    assert.equal(boundsOf([]), undefined);
  });
  it("largestFirst is stable", () => {
    const items = [{ a: 1 }, { a: 3 }, { a: 1 }];
    const out = largestFirst(items, (i) => ({ x: 0, y: 0, w: i.a, h: 1 }));
    assert.deepEqual(out, [items[1], items[0], items[2]]);
  });
});

describe("summarizeFace", () => {
  it("uses iris centres when the mesh has them", () => {
    const m = mesh(0.5, 0.4, 0.2);
    m[FACE.leftIris] = { x: 0.55, y: 0.38, z: 0 };
    m[FACE.rightIris] = { x: 0.45, y: 0.38, z: 0 };
    const f = summarizeFace(m)!;
    assert.deepEqual(f.leftEye, { x: 0.55, y: 0.38 });
    assert.deepEqual(f.rightEye, { x: 0.45, y: 0.38 });
    assert.ok(f.mouth);
    assert.ok(f.box.w > 0.19 && f.box.w <= 0.2);
  });
  it("falls back to eye corners without irises", () => {
    const m = mesh(0.5, 0.4, 0.2, 468);
    m[FACE.leftEyeOuter] = { x: 0.6, y: 0.4 };
    m[FACE.leftEyeInner] = { x: 0.54, y: 0.4 };
    const f = summarizeFace(m)!;
    assert.ok(Math.abs(f.leftEye!.x - 0.57) < 1e-9);
  });
  it("is undefined for an empty mesh", () => {
    assert.equal(summarizeFace([]), undefined);
  });
});

describe("mapPersonFrame", () => {
  it("sorts poses, faces and hands largest first", () => {
    const small = pose(0.1, 0.1, 0.1, 0.2);
    const big = pose(0.4, 0.1, 0.4, 0.8);
    const f = mapPersonFrame(12.5, {
      poses: [small, big],
      faces: [mesh(0.2, 0.2, 0.05), mesh(0.6, 0.2, 0.15)],
      hands: [Array.from({ length: 21 }, (_, i) => ({ x: 0.1 + i * 0.001, y: 0.5, z: 0, visibility: 0 }))],
    });
    assert.equal(f.videoTime, 12.5);
    assert.equal(f.poses.length, 2);
    assert.equal(f.poses[0][0].x, 0.4);
    assert.equal(f.poses[0][0].visibility, 0.9);
    assert.ok(f.faces[0].box.w > f.faces[1].box.w);
    assert.equal(f.hands.length, 1);
    assert.equal(f.hands[0].length, 21);
    assert.equal(f.hands[0][0].visibility, undefined);
  });
  it("yields empty lists for skipped models", () => {
    assert.deepEqual(mapPersonFrame(0, {}), { videoTime: 0, poses: [], faces: [], hands: [] });
  });
});
