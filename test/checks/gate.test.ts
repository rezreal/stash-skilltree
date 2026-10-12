import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cameraErrorHelp, cameraRow, createSteadyPresence, gatePhase, isNoCamera, micErrorHelp, micRow, visionRow } from "../../src/checks/gate.ts";

describe("cameraErrorHelp", () => {
  it("explains every code", () => {
    assert.match(cameraErrorHelp("insecure-context").hint, /https/);
    assert.match(cameraErrorHelp("permission-denied").title, /denied/);
    assert.match(cameraErrorHelp("no-device").title, /No camera/);
    assert.match(cameraErrorHelp("device-busy").hint, /Another app/);
    assert.match(cameraErrorHelp("assets-missing").hint, /tools\/fetch_models\.sh and copy plugin\/assets to the plugin folder/);
    assert.equal(cameraErrorHelp("assets-missing").retry, false);
    assert.match(cameraErrorHelp("unknown", "boom").hint, /boom/);
    assert.match(cameraErrorHelp(undefined).title, /could not be started/);
  });

  it("no-camera codes", () => {
    assert.equal(isNoCamera("no-device"), true);
    assert.equal(isNoCamera("permission-denied"), true);
    assert.equal(isNoCamera("device-busy"), false);
    assert.equal(isNoCamera("assets-missing"), false);
  });
});

describe("micErrorHelp", () => {
  it("explains every code, and how to watch without a mic where retrying can't help", () => {
    assert.match(micErrorHelp("insecure-context").hint, /https/);
    assert.match(micErrorHelp("insecure-context").hint, /turn off speech recognition/);
    assert.equal(micErrorHelp("insecure-context").retry, false);
    assert.match(micErrorHelp("permission-denied").title, /denied/);
    assert.equal(micErrorHelp("permission-denied").retry, true);
    assert.match(micErrorHelp("no-device").hint, /turn off speech recognition/);
    assert.match(micErrorHelp("device-busy").hint, /Another app/);
    assert.match(micErrorHelp("unknown", "boom").hint, /boom/);
  });
});

describe("gatePhase", () => {
  const base = { required: true, requested: false, state: "off" as const, personSeen: false };
  it("walks ask -> starting -> looking -> ready", () => {
    assert.equal(gatePhase(base), "ask");
    assert.equal(gatePhase({ ...base, requested: true, state: "starting" }), "starting");
    assert.equal(gatePhase({ ...base, requested: true, state: "on" }), "looking");
    assert.equal(gatePhase({ ...base, requested: true, state: "on", personSeen: true }), "ready");
  });

  it("errors: shown when required, skipped when not and there is no camera", () => {
    assert.equal(gatePhase({ ...base, requested: true, state: "error", errorCode: "no-device" }), "error");
    assert.equal(gatePhase({ ...base, required: false, requested: true, state: "error", errorCode: "no-device" }), "skip");
    assert.equal(gatePhase({ ...base, required: false, requested: true, state: "error", errorCode: "assets-missing" }), "error");
  });

  it("someone else's running camera still needs this gate's click", () => {
    assert.equal(gatePhase({ ...base, state: "on" }), "ask");
  });
});

describe("createSteadyPresence", () => {
  it("needs a person in view for the whole steady time", () => {
    const steady = createSteadyPresence(600);
    assert.equal(steady(true, 0), false);
    assert.equal(steady(true, 400), false);
    assert.equal(steady(false, 500), false);
    assert.equal(steady(true, 700), false);
    assert.equal(steady(true, 1300), true);
  });
});

describe("sensor rows", () => {
  it("camera", () => {
    assert.deepEqual(cameraRow("off", undefined), { key: "camera", label: "Camera", value: "off", tone: "muted" });
    assert.equal(cameraRow("on", { present: true, reason: "present" }).tone, "blue");
    assert.equal(cameraRow("on", { present: false, reason: "absent" }).value, "nobody in view");
    assert.equal(cameraRow("on", { present: false, reason: "no-frames" }).value, "stalled");
    const err = cameraRow("error", undefined, { code: "permission-denied", message: "x" });
    assert.equal(err.tone, "red");
    assert.match(err.hint!, /denied/);
  });

  it("microphone and video analysis", () => {
    assert.equal(micRow("listening").tone, "blue");
    assert.equal(micRow("idle").value, "idle");
    assert.equal(micRow("error", "mic denied").hint, "mic denied");
    assert.equal(visionRow("running").tone, "blue");
    assert.equal(visionRow("loading").value, "loading…");
    assert.equal(visionRow("error", "no wasm").hint, "no wasm");
  });
});
