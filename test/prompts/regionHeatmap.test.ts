import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyGaze,
  createRegionHeatmap,
  regionMap,
  regionShares,
  totalOf,
  type RegionMap,
} from "../../src/prompts/regionHeatmap.ts";
import { personRegion, targetRegion } from "../../src/prompts/regions.ts";
import { BOX, STANDING, frame, pose } from "./fixtures.ts";

// BOX content rect: x 0..1000, y 218.75..781.25; normalized (x, y) -> (1000x, 218.75 + 562.5y)
const Y = (n: number): number => 218.75 + 562.5 * n;
const X = (n: number): number => 1000 * n;
const person = frame([pose(STANDING)]);
// small regions so neighbouring ones don't swallow each other
const map = regionMap(person, BOX, { minDiameterPx: 10 });
const at = (x: number, y: number) => classifyGaze({ x, y }, map);

describe("regionMap / classifyGaze", () => {
  it("lists the regions most specific first", () => {
    assert.deepEqual(
      map.regions.map(([r]) => r),
      ["eyes", "mouth", "hands", "hands", "face", "chest", "groin", "hips", "torso", "legs", "feet", "person"],
    );
  });

  it("gives a point the most specific region containing it", () => {
    assert.equal(at(X(0.5), Y(0.19)), "eyes");
    assert.equal(at(X(0.5), Y(0.22)), "mouth");
    assert.equal(at(X(0.5), Y(0.2) - 15), "face"); // forehead: in the face, above the eyes
    assert.equal(at(X(0.5), Y(0.35)), "chest");
    assert.equal(at(X(0.5), Y(0.57)), "groin");
    assert.equal(at(X(0.42), Y(0.52)), "hands");
    assert.equal(at(X(0.58), Y(0.52)), "hands");
    assert.equal(at(X(0.47), Y(0.8)), "legs");
    assert.equal(at(X(0.5), Y(0.91)), "feet");
  });

  it("splits the rest into the person, the video and off the video", () => {
    assert.equal(at(X(0.43), Y(0.42)), "person"); // an elbow
    assert.equal(at(X(0.1), Y(0.3)), "video");
    assert.equal(at(X(0.5), 100), "off");
    // regions reaching past the video edge still count as off it
    assert.equal(at(X(0.5), Y(1) + 5), "off");
  });

  it("without a person everything on the video is 'video'", () => {
    const empty = regionMap(frame([]), BOX);
    assert.deepEqual(empty.regions, []);
    assert.equal(classifyGaze({ x: 500, y: 500 }, empty), "video");
  });

  it("has no feet region without feet (no floor fallback)", () => {
    const noFeet = pose({ ...STANDING, leftAnkle: undefined, rightAnkle: undefined, leftHeel: undefined, rightHeel: undefined, leftFootIndex: undefined, rightFootIndex: undefined });
    const m = regionMap(frame([noFeet]), BOX);
    assert.ok(!m.regions.some(([r]) => r === "feet"));
    // the gaze prompt keeps its fallback
    assert.ok(targetRegion("feet_floor", frame([noFeet]), BOX));
    assert.equal(targetRegion("feet_floor", frame([noFeet]), BOX, { personOnly: true }), undefined);
  });
});

describe("personRegion", () => {
  it("covers the visible landmarks and the face box, padded", () => {
    const f = frame([pose(STANDING)], { faces: [{ box: { x: 0.46, y: 0.1, w: 0.08, h: 0.16 } }] });
    const r = personRegion(f, BOX)!;
    assert.equal(r.kind, "polygon");
    const m: RegionMap = { video: { left: 0, top: 218.75, width: 1000, height: 562.5, right: 1000, bottom: 781.25 }, regions: [["person", r]] };
    assert.equal(classifyGaze({ x: X(0.5), y: Y(0.11) }, m), "person"); // top of the face box
    assert.equal(classifyGaze({ x: X(0.43), y: Y(0.42) }, m), "person");
    assert.equal(classifyGaze({ x: X(0.2), y: Y(0.5) }, m), "video");
  });

  it("is undefined without a person", () => {
    assert.equal(personRegion(frame([]), BOX), undefined);
  });
});

describe("createRegionHeatmap", () => {
  const eyes = { x: X(0.5), y: Y(0.19) };
  const chest = { x: X(0.5), y: Y(0.35) };

  it("adds the time between samples to the region of the sample", () => {
    const h = createRegionHeatmap();
    h.setRegions(0, map);
    for (let t = 0; t <= 1000; t += 10) h.push({ t, valid: true, point: t < 600 ? eyes : chest }, true);
    const s = h.seconds();
    assert.ok(Math.abs(s.eyes! - 0.59) < 1e-9);
    assert.ok(Math.abs(s.chest! - 0.41) < 1e-9);
    assert.ok(Math.abs(h.totalSec() - 1) < 1e-9);
  });

  it("skips invalid samples, gaps, time not counted and stale or dropped regions", () => {
    const h = createRegionHeatmap({ freshMs: 1000, maxGapMs: 250 });
    h.setRegions(0, map);
    h.push({ t: 0, valid: true, point: eyes }, true);
    h.push({ t: 100, valid: false }, true); // blink
    h.push({ t: 200, valid: true, point: eyes }, false); // paused
    h.push({ t: 600, valid: true, point: eyes }, true); // gap of 400 ms
    h.push({ t: 700, valid: true, point: eyes }, true); // counts: 100 ms
    h.push({ t: 1800, valid: true, point: eyes }, true); // gap
    h.push({ t: 1900, valid: true, point: eyes }, true); // regions 1.9 s old: stale
    h.setRegions(1900, undefined);
    h.push({ t: 2000, valid: true, point: eyes }, true); // no regions
    h.setRegions(2000, map);
    h.push({ t: 2100, valid: true }, true); // no point
    h.push({ t: 2200, valid: true, point: { x: NaN, y: 0 } }, true);
    h.push({ t: NaN, valid: true, point: eyes }, true);
    const s = h.seconds();
    assert.ok(Math.abs(s.eyes! - 0.1) < 1e-9, JSON.stringify(s));
    // NaN point: off the video (not inside its rect)
    assert.ok(Math.abs(s.off! - 0.1) < 1e-9, JSON.stringify(s));
  });

  it("ignores samples going back in time", () => {
    const h = createRegionHeatmap();
    h.setRegions(0, map);
    h.push({ t: 100, valid: true, point: eyes }, true);
    h.push({ t: 50, valid: true, point: eyes }, true);
    h.push({ t: 60, valid: true, point: eyes }, true);
    assert.ok(Math.abs(h.totalSec() - 0.01) < 1e-9);
  });
});

describe("regionShares / totalOf", () => {
  it("sorts by time, drops empty regions, ties in region order", () => {
    assert.deepEqual(regionShares({ chest: 1, eyes: 1, off: 2, face: 0 }), [
      { region: "off", sec: 2, share: 0.5 },
      { region: "eyes", sec: 1, share: 0.25 },
      { region: "chest", sec: 1, share: 0.25 },
    ]);
    assert.deepEqual(regionShares({}), []);
    assert.equal(totalOf({ eyes: 1.5, hands: 2 }), 3.5);
  });
});
