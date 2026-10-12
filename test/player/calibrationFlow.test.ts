import { test } from "node:test";
import assert from "node:assert/strict";
import { IDENTITY_CALIBRATION, type Calibration, type ViewportPoint } from "../../src/gaze/types.ts";
import {
  DISCARD_MS,
  INITIAL_CALIBRATION_STATE,
  POINT_MS,
  calibrationStep,
  currentTarget,
  errorText,
  errorVerdict,
  minPairs,
  progressLabel,
  verifyError,
  verifyTargets,
  type CalibrationEvent,
  type CalibrationState,
  type TimedPoint,
} from "../../src/player/calibrationFlow.ts";

const TARGETS: ViewportPoint[] = [
  { x: 100, y: 100 },
  { x: 900, y: 100 },
  { x: 900, y: 500 },
  { x: 100, y: 500 },
];

/** gaze lands 20 px right of where it should */
const OFFSET = { x: 20, y: 0 };

/** samples around `p` (plus the offset) between from and to, every 20 ms */
function samplesAt(p: ViewportPoint, from: number, to: number): TimedPoint[] {
  const out: TimedPoint[] = [];
  for (let t = from; t <= to; t += 20) out.push({ t, x: p.x + OFFSET.x, y: p.y + OFFSET.y });
  return out;
}

function run(state: CalibrationState, events: CalibrationEvent[]): CalibrationState {
  return events.reduce((s, e) => calibrationStep(s, e), state);
}

const NOW_ISO = "2026-10-12T10:00:00.000Z";

/** ticks through one point that started at `start`, with samples on `p` */
function pointTicks(p: ViewportPoint | undefined, start: number): CalibrationEvent[] {
  const mid = start + POINT_MS / 2;
  const end = start + POINT_MS;
  return [
    // samples during the first DISCARD_MS (eye travelling) are wild and must be dropped
    { type: "tick", nowMs: mid, nowIso: NOW_ISO, samples: p ? [{ t: start + 10, x: 5000, y: 5000 }, ...samplesAt(p, start + DISCARD_MS, mid)] : [] },
    { type: "tick", nowMs: end, nowIso: NOW_ISO, samples: p ? samplesAt(p, mid + 20, end) : [] },
  ];
}

test("calibration: points are recorded one at a time, then fitted", () => {
  let s = calibrationStep(INITIAL_CALIBRATION_STATE, { type: "start", targets: TARGETS, nowMs: 0, device: false });
  assert.equal(s.step, "point");
  assert.deepEqual(currentTarget(s), TARGETS[0]);
  assert.equal(progressLabel(s), "Calibration · point 1 of 4");
  let t = 0;
  for (let i = 0; i < TARGETS.length; i++) {
    s = run(s, pointTicks(TARGETS[i], t));
    t += POINT_MS;
    if (i + 1 < TARGETS.length) {
      assert.equal(s.step, "point");
      if (s.step === "point") assert.equal(s.index, i + 1);
    }
  }
  assert.equal(s.step, "fitted");
  if (s.step !== "fitted") return;
  assert.equal(s.pairs.length, 4);
  assert.equal(s.missed, 0);
  // the discarded wild sample didn't move the fixation
  assert.deepEqual(s.pairs[0], { measured: { x: 120, y: 100 }, target: { x: 100, y: 100 } });
  // a pure offset is fitted away
  assert.ok(Math.abs(s.calibration.c + 20) < 1e-6, `c = ${s.calibration.c}`);
  assert.ok(s.calibration.errorPx < 1e-6);
  assert.equal(s.calibration.createdAt, NOW_ISO);
  assert.equal(currentTarget(s), undefined);
});

test("calibration fails when too few points had a steady gaze", () => {
  let s = calibrationStep(INITIAL_CALIBRATION_STATE, { type: "start", targets: TARGETS, nowMs: 0, device: false });
  s = run(s, [...pointTicks(TARGETS[0], 0), ...pointTicks(undefined, 1200), ...pointTicks(undefined, 2400), ...pointTicks(TARGETS[3], 3600)]);
  assert.equal(s.step, "failed");
  if (s.step === "failed") assert.match(s.message, /Only 2 of 4 points/);
  assert.equal(minPairs(4), 3);
  assert.equal(minPairs(9), 5);
  assert.deepEqual(calibrationStep(s, { type: "retry" }), { step: "intro" });
});

test("calibration: a fit that throws ends in failed, not a crash", () => {
  const deps = {
    collectFixation: (ps: ViewportPoint[]) => ps[0],
    fitCalibration: (): Calibration => {
      throw new Error("singular");
    },
    applyCalibration: (p: ViewportPoint) => p,
  };
  let s = calibrationStep(INITIAL_CALIBRATION_STATE, { type: "start", targets: TARGETS.slice(0, 3), nowMs: 0, device: false }, deps);
  for (let i = 0; i < 3; i++) for (const e of pointTicks(TARGETS[i], i * POINT_MS)) s = calibrationStep(s, e, deps);
  assert.equal(s.step, "failed");
  if (s.step === "failed") assert.match(s.message, /singular/);
});

test("device pass: start, one point per target once the tracker took it, then the affine pass", () => {
  let s = calibrationStep(INITIAL_CALIBRATION_STATE, { type: "start", targets: TARGETS, nowMs: 0, device: true });
  assert.equal(s.step, "device");
  assert.equal(currentTarget(s), undefined);
  assert.equal(progressLabel(s), "Tracker calibration · starting…");
  s = calibrationStep(s, { type: "deviceReady", nowMs: 100 });
  assert.deepEqual(currentTarget(s), TARGETS[0]);
  // time alone doesn't advance: the tracker has to take the point
  s = calibrationStep(s, { type: "tick", nowMs: 100 + POINT_MS * 3, nowIso: NOW_ISO });
  if (s.step === "device") assert.equal(s.index, 0);
  // a late answer for another point is ignored
  s = calibrationStep(s, { type: "deviceAdded", index: 3 });
  if (s.step === "device") assert.equal(s.added, false);
  let t = 100;
  for (let i = 0; i < TARGETS.length; i++) {
    s = calibrationStep(s, { type: "deviceAdded", index: i });
    t += POINT_MS;
    s = calibrationStep(s, { type: "tick", nowMs: Math.max(t, 100 + POINT_MS * 3), nowIso: NOW_ISO });
    t = Math.max(t, 100 + POINT_MS * 3);
  }
  assert.equal(s.step, "device");
  if (s.step === "device") assert.equal(s.stage, "finishing");
  s = calibrationStep(s, { type: "deviceFinished", nowMs: 10_000 });
  assert.equal(s.step, "point");
  if (s.step === "point") {
    assert.equal(s.device, true);
    assert.equal(s.index, 0);
    assert.equal(s.startedMs, 10_000);
  }
  assert.equal(progressLabel(s), "Correction · point 1 of 4");
});

test("device pass failure", () => {
  let s = calibrationStep(INITIAL_CALIBRATION_STATE, { type: "start", targets: TARGETS, nowMs: 0, device: true });
  s = calibrationStep(s, { type: "deviceFailed", message: "busy" });
  assert.deepEqual(s, { step: "failed", message: "The tracker's calibration failed: busy" });
});

test("verify measures calibrated fixations on new points; save and reset", () => {
  const fitted: CalibrationState = {
    step: "fitted",
    calibration: { ...IDENTITY_CALIBRATION, c: -20, points: 4, errorPx: 0, createdAt: NOW_ISO },
    pairs: [],
    missed: 0,
    device: false,
  };
  const checks = [
    { x: 300, y: 300 },
    { x: 600, y: 200 },
  ];
  let s = calibrationStep(fitted, { type: "verify", targets: checks, nowMs: 0 });
  assert.equal(s.step, "verify");
  assert.equal(progressLabel(s), "Check · point 1 of 2");
  s = run(s, [...pointTicks(checks[0], 0), ...pointTicks(undefined, POINT_MS)]);
  assert.equal(s.step, "verify");
  if (s.step !== "verify") return;
  assert.equal(currentTarget(s), undefined);
  assert.deepEqual(s.results[0], { target: checks[0], measured: { x: 300, y: 300 }, errorPx: 0 });
  assert.deepEqual(s.results[1], { target: checks[1] });
  assert.equal(verifyError(s.results), 0);
  // ticks after the last point change nothing
  assert.equal(calibrationStep(s, { type: "tick", nowMs: 99_999, nowIso: NOW_ISO }), s);
  // verify again from a finished check
  assert.equal(calibrationStep(s, { type: "verify", targets: checks, nowMs: 5000 }).step, "verify");
  const saved = calibrationStep(s, { type: "saved", calibration: s.calibration });
  assert.deepEqual(saved, { step: "saved", calibration: s.calibration, device: false });
  assert.deepEqual(calibrationStep(saved, { type: "saved", calibration: IDENTITY_CALIBRATION, device: false }), {
    step: "saved",
    calibration: IDENTITY_CALIBRATION,
    device: false,
  });
});

test("events that don't fit the step are ignored; cancel returns to the intro", () => {
  const intro = INITIAL_CALIBRATION_STATE;
  assert.equal(calibrationStep(intro, { type: "tick", nowMs: 1, nowIso: NOW_ISO }), intro);
  assert.equal(calibrationStep(intro, { type: "deviceReady", nowMs: 1 }), intro);
  assert.equal(calibrationStep(intro, { type: "verify", targets: TARGETS, nowMs: 1 }), intro);
  const s = calibrationStep(intro, { type: "start", targets: TARGETS, nowMs: 0, device: false });
  assert.deepEqual(calibrationStep(s, { type: "cancel", message: "Stopped." }), { step: "intro", message: "Stopped." });
  assert.equal(calibrationStep(intro, { type: "start", targets: [], nowMs: 0, device: false }).step, "failed");
});

test("verifyTargets: inside the middle of the screen, spread apart, deterministic with a seeded random", () => {
  let seed = 1;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const pts = verifyTargets(1920, 1080, 4, random);
  assert.equal(pts.length, 4);
  for (const p of pts) {
    assert.ok(p.x >= 1920 * 0.15 && p.x <= 1920 * 0.85);
    assert.ok(p.y >= 1080 * 0.15 && p.y <= 1080 * 0.85);
  }
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) assert.ok(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) >= 1080 / 5);
  }
});

test("error texts", () => {
  assert.equal(errorText(23.4), "23 px");
  assert.equal(errorText(undefined), "—");
  assert.equal(errorVerdict(30).tone, "blue");
  assert.equal(errorVerdict(60).tone, "orange");
  assert.equal(errorVerdict(200).tone, "red");
  assert.equal(errorVerdict(undefined).tone, "red");
  assert.equal(verifyError([]), undefined);
  assert.equal(verifyError([{ target: { x: 0, y: 0 }, errorPx: 10 }, { target: { x: 0, y: 0 }, errorPx: 30 }, { target: { x: 0, y: 0 } }]), 20);
});
