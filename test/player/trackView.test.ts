import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  captureFrom,
  captureProblem,
  configKey,
  gaugeTop,
  guideView,
  limitsLine,
  median,
  mergePluginSettings,
  previewPoints,
  previewY,
  scoreLine,
  sensorRowView,
  settingsLines,
  trackSettings,
} from "../../src/player/trackView.ts";
import type { GuideFrame, TrackScore } from "../../src/track/types.ts";

describe("trackSettings", () => {
  it("uses defaults and needs service + characteristic for a config", () => {
    const s = trackSettings({});
    assert.equal(s.config, undefined);
    assert.deepEqual(s.limits, { maxDepth: 100, maxHoldSec: 8 });
    assert.deepEqual(s.problems, []);
  });

  it("reads every key, numbers as numbers or strings", () => {
    const s = trackSettings({
      sensorService: " 0xffe0 ",
      sensorCharacteristic: "0xffe1",
      sensorFormat: "ASCII",
      sensorOffset: "1",
      sensorScale: 0.1,
      sensorNamePrefix: "Reach",
      trackMaxDepth: "70",
      trackMaxHoldSec: 5,
    });
    assert.deepEqual(s.config, {
      service: "0xffe0",
      characteristic: "0xffe1",
      format: "ascii",
      offset: 1,
      scale: 0.1,
      namePrefix: "Reach",
    });
    assert.deepEqual(s.limits, { maxDepth: 70, maxHoldSec: 5 });
  });

  it("reports bad values and falls back", () => {
    const s = trackSettings({
      sensorService: "ffe0!",
      sensorCharacteristic: "0xffe1",
      sensorFormat: "int8",
      sensorOffset: -2,
      sensorScale: 0,
      trackMaxDepth: 140,
      trackMaxHoldSec: -1,
    });
    assert.equal(s.config!.format, "uint16le");
    assert.equal(s.config!.offset, 0);
    assert.equal(s.config!.scale, 1);
    assert.deepEqual(s.limits, { maxDepth: 100, maxHoldSec: 8 });
    assert.equal(s.problems.length, 5);
  });

  it("keys configs", () => {
    const a = trackSettings({ sensorService: "0xffe0", sensorCharacteristic: "0xffe1" }).config;
    const b = trackSettings({ sensorService: "0xffe0", sensorCharacteristic: "0xffe1", sensorScale: 2 }).config;
    assert.notEqual(configKey(a), configKey(b));
    assert.equal(configKey(undefined), "");
  });
});

describe("guide geometry", () => {
  it("puts IN at the top", () => {
    assert.equal(gaugeTop(100), 0);
    assert.equal(gaugeTop(0), 100);
    assert.equal(gaugeTop(130), 0);
    assert.equal(previewY(100), 0);
    assert.equal(previewY(0), 60);
    assert.equal(previewY(50), 30);
  });

  it("maps the 3 s preview into the strip", () => {
    assert.equal(
      previewPoints([
        [0, 0],
        [1500, 100],
        [3000, 50],
        [4000, 50],
      ]),
      "0,60 150,0 300,30 300,30",
    );
    assert.equal(previewPoints([]), "");
  });

  const limits = { maxDepth: 85, maxHoldSec: 8 };
  const frame = (f: Partial<GuideFrame>): GuideFrame => ({ target: 50, direction: "in", preview: [], ...f });

  it("shows direction arrows ahead of the target", () => {
    const v = guideView(frame({ target: 62, current: 54, direction: "in" }), limits);
    assert.equal(v.targetTop, 38);
    assert.equal(v.arrow, "up");
    assert.equal(v.arrowTop, 30);
    assert.equal(v.currentTop, 46);
    assert.equal(v.currentY, previewY(54));
    assert.equal(v.label, "moving in");
    assert.equal(v.limitTop, 15);
    assert.match(v.aria, /target 62, you 54, moving in/);
    const out = guideView(frame({ target: 30, direction: "out" }), limits);
    assert.equal(out.arrow, "down");
    assert.equal(out.arrowTop, 78);
    assert.equal(out.currentTop, undefined);
    assert.match(out.aria, /no sensor reading/);
  });

  it("shows a hold band with progress", () => {
    const v = guideView(
      frame({
        target: 70,
        direction: "hold",
        holdProgress: 0.48,
        section: { kind: "hold", start: 10_000, end: 15_000, depth: 70 },
      }),
      limits,
    );
    assert.equal(v.arrow, undefined);
    assert.deepEqual(v.band, { top: 22, height: 16 });
    assert.equal(v.label, "hold 2.4 / 5.0 s");
    assert.equal(v.section, "hold");
    const edge = guideView(frame({ target: 96, direction: "hold" }), limits);
    assert.deepEqual(edge.band, { top: 0, height: 12 });
  });

  it("marks unscored sections and rest", () => {
    const v = guideView(frame({ direction: "idle", target: 0, section: { kind: "stroke", start: 0, end: 1, unscored: true } }), limits);
    assert.equal(v.label, "rest · not scored");
    assert.ok(v.unscored);
  });
});

describe("score and limits lines", () => {
  const score: TrackScore = {
    strokes: { followed: 34, total: 48 },
    holds: { followed: 5, total: 6 },
    ramps: 0.82,
    lagMs: 240.4,
    sections: [],
  };
  it("formats the live score", () => {
    assert.equal(scoreLine(score), "Strokes 34/48 · Holds 5/6 · Ramps 82% · lag 240 ms");
    assert.equal(scoreLine({ ...score, holds: { followed: 0, total: 0 }, ramps: undefined, lagMs: undefined }), "Strokes 34/48");
    assert.equal(scoreLine({ strokes: { followed: 0, total: 0 }, holds: { followed: 0, total: 0 }, sections: [] }), "No scored sections yet");
    assert.equal(scoreLine(undefined), "");
  });
  it("states the limits", () => {
    assert.match(limitsLine({ maxDepth: 85, maxHoldSec: 8 }), /max depth 85 · max hold 8 s/);
    assert.match(limitsLine({ maxDepth: 85.4, maxHoldSec: 7.5 }), /max depth 85 · max hold 7.5 s/);
    assert.match(limitsLine({ maxDepth: 100, maxHoldSec: 8 }), /no depth limit beyond your calibration · max hold 8 s/);
  });
});

describe("sensorRowView", () => {
  it("covers the states", () => {
    assert.equal(sensorRowView(undefined, { configured: false, calibrated: false }).connection, "not set up – track not scored");
    const off = sensorRowView({ connection: "disconnected" }, { configured: true, calibrated: true });
    assert.equal(off.connection, "not connected – track not scored");
    assert.ok(off.canConnect);
    const c = sensorRowView({ connection: "connected", device: "Reach", rate: 31.6 }, { configured: true, calibrated: false });
    assert.equal(c.connection, "connected · Reach");
    assert.equal(c.rate, "32 Hz");
    assert.equal(c.tone, "blue");
    assert.equal(c.calibrated, "no – track not scored");
    assert.match(c.hint!, /Calibrate/);
    assert.equal(c.canConnect, false);
    const e = sensorRowView({ connection: "error", message: "No sensor chosen." }, { configured: true, calibrated: true });
    assert.equal(e.tone, "red");
    assert.equal(e.hint, "No sensor chosen.");
    assert.ok(e.canConnect);
  });
});

describe("calibration captures", () => {
  it("takes the median of a window", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
    assert.equal(median([]), undefined);
    const samples = [0, 100, 200, 300, 400, 500, 600, 2000].map((t, i) => ({ t, raw: i === 3 ? 999 : 100 + i }));
    const c = captureFrom(samples, 0, 1500)!;
    assert.equal(c.samples, 7);
    assert.equal(c.value, 104);
    assert.equal(c.spread, 999 - 100);
    assert.equal(captureFrom(samples, 1000, 2500), undefined);
  });

  it("warns about captures that are too close or shaky", () => {
    const cap = (value: number, spread = 1) => ({ value, samples: 20, spread });
    assert.match(captureProblem(cap(120), cap(121))!, /almost the same/);
    assert.match(captureProblem(cap(120, 30), cap(40))!, /moved a lot/);
    assert.equal(captureProblem(cap(120), cap(40)), undefined);
    assert.equal(captureProblem(undefined, cap(40)), undefined);
  });
});

describe("saving the discovered sensor", () => {
  it("merges into the whole plugin config", () => {
    const merged = mergePluginSettings(
      { gazeSource: "tobii", sensorNamePrefix: "Old" },
      { sensorService: "0xffe0", sensorCharacteristic: "0xffe1", sensorFormat: "ascii", sensorOffset: 0, sensorScale: 1 },
    );
    assert.deepEqual(merged, {
      gazeSource: "tobii",
      sensorService: "0xffe0",
      sensorCharacteristic: "0xffe1",
      sensorFormat: "ascii",
      sensorOffset: 0,
      sensorScale: 1,
    });
    assert.equal(
      settingsLines({ sensorService: "a", sensorCharacteristic: "b", sensorFormat: "uint8", sensorOffset: 1, sensorScale: 2, sensorNamePrefix: "R" }).length,
      6,
    );
  });
});
