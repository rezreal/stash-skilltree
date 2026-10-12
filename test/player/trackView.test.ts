import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  captureFrom,
  captureProblem,
  applyValidRange,
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
  mergeSettings,
  parseRangeForm,
  parseSensorTab,
  rangeFormFrom,
  rawVerdict,
  readinessView,
  sensorMenuView,
  tracePolylines,
  validRangeText,
  sensorChipView,
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
  it("puts OUT at the top and IN at the bottom", () => {
    assert.equal(gaugeTop(100), 100);
    assert.equal(gaugeTop(0), 0);
    assert.equal(gaugeTop(130), 100);
    assert.equal(previewY(100), 60);
    assert.equal(previewY(0), 0);
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
      "0,0 150,60 300,30 300,30",
    );
    assert.equal(previewPoints([]), "");
  });

  const limits = { maxDepth: 85, maxHoldSec: 8 };
  const frame = (f: Partial<GuideFrame>): GuideFrame => ({ target: 50, direction: "in", preview: [], ...f });

  it("shows direction arrows ahead of the target", () => {
    const v = guideView(frame({ target: 62, current: 54, direction: "in" }), limits);
    assert.equal(v.targetTop, 62);
    assert.equal(v.arrow, "down");
    assert.equal(v.arrowTop, 70);
    assert.equal(v.currentTop, 54);
    assert.equal(v.currentY, previewY(54));
    assert.equal(v.label, "moving in");
    assert.equal(v.limitTop, 85);
    assert.match(v.aria, /target 62, you 54, moving in/);
    const out = guideView(frame({ target: 30, direction: "out" }), limits);
    assert.equal(out.arrow, "up");
    assert.equal(out.arrowTop, 22);
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
    assert.deepEqual(v.band, { top: 62, height: 16 });
    assert.equal(v.label, "hold 2.4 / 5.0 s");
    assert.equal(v.section, "hold");
    const edge = guideView(frame({ target: 96, direction: "hold" }), limits);
    assert.deepEqual(edge.band, { top: 88, height: 12 });
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

it("valid range: parsed from settings, contradictions ignored", () => {
  const base = { sensorService: "0xffe0", sensorCharacteristic: "0xffe1" };
  const t = trackSettings({ ...base, sensorValidMin: 31 });
  assert.equal(t.config?.validMin, 31);
  assert.equal(t.config?.validMax, undefined);
  const bad = trackSettings({ ...base, sensorValidMin: 50, sensorValidMax: 10 });
  assert.equal(bad.config?.validMin, undefined);
  assert.ok(bad.problems.some((p) => /Valid minimum/.test(p)));
  // the range is applied per sample, so changing it keeps the connection
  assert.equal(configKey(t.config), configKey(trackSettings(base).config));
});

it("applyValidRange flags readings by the current range", () => {
  assert.deepEqual(applyValidRange({ t: 1, raw: 20 }, { validMin: 31 }), { t: 1, raw: 20, noTarget: true });
  assert.deepEqual(applyValidRange({ t: 1, raw: 20, noTarget: true }, {}), { t: 1, raw: 20 });
  const same = { t: 1, raw: 200 };
  assert.equal(applyValidRange(same, { validMin: 31 }), same);
});

it("captures skip no-target readings", () => {
  const samples = [
    { t: 0, raw: 100 }, { t: 10, raw: 5, noTarget: true }, { t: 20, raw: 102 },
    { t: 30, raw: 101 }, { t: 40, raw: 0, noTarget: true }, { t: 50, raw: 99 },
  ];
  const c = captureFrom(samples, 0, 60, 3);
  assert.equal(c?.value, 100.5);
  assert.equal(c?.samples, 4);
});

describe("sensor menu", () => {
  const base = {
    configured: true,
    status: { connection: "connected" as const, device: "Reach-Trainer" },
    calibration: { rawAtZero: 300, rawAtFull: 60 },
    config: { service: "s", characteristic: "c", format: "uint16le" as const, offset: 0, scale: 1, validMin: 31 },
    limits: { maxDepth: 100, maxHoldSec: 8 },
  };

  it("reads the tab from ?tab= and falls back to status", () => {
    assert.equal(parseSensorTab("?tab=calibrate"), "calibrate");
    assert.equal(parseSensorTab("?x=1&tab=range"), "range");
    assert.equal(parseSensorTab("?tab=bogus"), "status");
    assert.equal(parseSensorTab(""), "status");
  });

  it("badges each item with its state", () => {
    const items = sensorMenuView(base);
    assert.deepEqual(
      items.map((i) => [i.id, i.badge, i.tone]),
      [
        ["status", "connected", "blue"],
        ["calibrate", "saved", "blue"],
        ["range", "no depth limit", "muted"],
        ["device", "Reach-Trainer", "muted"],
      ],
    );
    const fresh = sensorMenuView({ ...base, configured: false, status: undefined, calibration: undefined, config: undefined });
    assert.deepEqual(
      fresh.map((i) => i.badge),
      ["not set up", "—", "no depth limit", "set up"],
    );
    const err = sensorMenuView({ ...base, status: { connection: "error", message: "x" }, calibration: undefined, limits: { maxDepth: 60, maxHoldSec: 8 } });
    assert.equal(err[0]!.tone, "red");
    assert.equal(err[1]!.badge, "needed");
    assert.equal(err[2]!.badge, "depth 60");
  });

  it("lists what is missing before track clips are scored", () => {
    const ready = readinessView({ configured: true, connected: true, calibrated: true });
    assert.ok(ready.ready);
    assert.match(ready.summary, /^Ready/);
    const notCal = readinessView({ configured: true, connected: true, calibrated: false });
    assert.equal(notCal.ready, false);
    assert.match(notCal.summary, /isn't scored until: rest and deepest positions calibrated/);
    assert.equal(notCal.steps.find((s) => !s.done)!.tab, "calibrate");
  });

  it("explains raw readings and the valid range", () => {
    assert.equal(rawVerdict(20, { validMin: 31 }), "no target (below 31)");
    assert.equal(rawVerdict(5000, { validMax: 4000 }), "no target (above 4000)");
    assert.equal(rawVerdict(200, { validMin: 31 }), "in range");
    assert.equal(rawVerdict(undefined, undefined), "no reading");
    assert.equal(validRangeText({ validMin: 31 }), "≥ 31");
    assert.equal(validRangeText({ validMin: 31, validMax: 4000 }), "31 – 4000");
    assert.equal(validRangeText(undefined), "all readings");
  });
});

describe("range & limits form", () => {
  it("round-trips the settings and removes empty fields", () => {
    const form = rangeFormFrom({ sensorValidMin: 31, trackMaxDepth: "80", other: 1 });
    assert.deepEqual(form, { validMin: "31", validMax: "", maxDepth: "80", maxHoldSec: "" });
    const { patch, problems } = parseRangeForm({ ...form, maxHoldSec: "6,5" });
    assert.deepEqual(problems, []);
    assert.deepEqual(patch, { sensorValidMin: 31, sensorValidMax: undefined, trackMaxDepth: 80, trackMaxHoldSec: 6.5 });
    const merged = mergeSettings({ sensorValidMax: 900, gaze: "tobii" }, patch!);
    assert.deepEqual(merged, { gaze: "tobii", sensorValidMin: 31, trackMaxDepth: 80, trackMaxHoldSec: 6.5 });
  });

  it("refuses contradictory or out-of-range values", () => {
    const r = parseRangeForm({ validMin: "50", validMax: "40", maxDepth: "120", maxHoldSec: "0" });
    assert.equal(r.patch, undefined);
    assert.equal(r.problems.length, 3);
    assert.match(parseRangeForm({ validMin: "abc", validMax: "", maxDepth: "", maxHoldSec: "" }).problems[0]!, /not a number/);
  });
});

describe("live trace", () => {
  it("draws the last window left to right and breaks at lost readings", () => {
    const pts = [
      { t: 0, pos: 50 }, // too old
      { t: 5000, pos: 0 },
      { t: 7500, pos: 100 },
      { t: 8000, pos: undefined },
      { t: 9000, pos: 50 },
      { t: 15000, pos: 50 },
    ];
    const lines = tracePolylines(pts, 15000, 10000, 100, 100);
    assert.deepEqual(lines, ["0,0 25,100", "40,50 100,50"]);
  });
});

describe("sensorChipView", () => {
  it("offers the next useful action", () => {
    const on = { configured: true, calibrated: true };
    assert.equal(sensorChipView(undefined, { configured: false, calibrated: false }).action, "setup");
    assert.equal(sensorChipView({ connection: "disconnected" }, on).action, "connect");
    assert.deepEqual(
      [sensorChipView({ connection: "connected" }, on).tone, sensorChipView({ connection: "connected" }, on).action],
      ["blue", "open"],
    );
    assert.equal(sensorChipView({ connection: "connected" }, { configured: true, calibrated: false }).label, "Sensor · calibrate");
    assert.equal(sensorChipView({ connection: "connecting", message: "Reconnecting…" }, on).title, "Reconnecting…");
    assert.equal(sensorChipView({ connection: "error", message: "x" }, on).tone, "red");
  });
});
