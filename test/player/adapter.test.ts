import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIVITY_EVENTS, createAttentionAdapter, type AttentionEnv } from "../../src/player/attentionAdapter.ts";
import {
  CALIBRATION_KEY,
  loadCalibrationText,
  loadCurrentPerformer,
  loadShowGaze,
  loadTestMode,
  saveCalibrationText,
  saveCurrentPerformer,
  saveShowGaze,
  saveTestMode,
} from "../../src/player/storage.ts";

function fakeEnv() {
  const listeners = new Map<string, Set<() => void>>();
  let now = 1000;
  const doc = { visibilityState: "visible", focused: true, fullscreenElement: null as unknown };
  const env: AttentionEnv = {
    target: {
      addEventListener: (type, fn) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type, fn) => {
        listeners.get(type)?.delete(fn);
      },
    },
    document: {
      get visibilityState() {
        return doc.visibilityState;
      },
      hasFocus: () => doc.focused,
      get fullscreenElement() {
        return doc.fullscreenElement;
      },
    },
    now: () => now,
  };
  return {
    env,
    doc,
    fire: (type: string) => listeners.get(type)?.forEach((fn) => fn()),
    advance: (ms: number) => {
      now += ms;
    },
    count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

test("attention adapter reads the page state and the last activity", () => {
  const f = fakeEnv();
  const a = createAttentionAdapter(f.env);
  assert.equal(f.count(), ACTIVITY_EVENTS.length);
  assert.deepEqual(a.read(), { visible: true, focused: true, fullscreen: false, lastActivityMs: 1000 });
  f.advance(500);
  f.fire("mousemove");
  f.doc.visibilityState = "hidden";
  f.doc.focused = false;
  f.doc.fullscreenElement = {};
  assert.deepEqual(a.read(), { visible: false, focused: false, fullscreen: true, lastActivityMs: 1500 });
  f.advance(500);
  f.fire("keydown");
  assert.equal(a.read().lastActivityMs, 2000);
});

test("attention adapter cleanup removes its listeners", () => {
  const f = fakeEnv();
  const a = createAttentionAdapter(f.env);
  a.cleanup();
  assert.equal(f.count(), 0);
  f.advance(100);
  f.fire("mousemove");
  assert.equal(a.read().lastActivityMs, 1000);
});

test("current performer storage is optional and never throws", () => {
  const data = new Map<string, string>();
  const store = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
  assert.equal(loadCurrentPerformer(store), undefined);
  saveCurrentPerformer("42", store);
  assert.equal(loadCurrentPerformer(store), "42");
  saveCurrentPerformer(undefined, store);
  assert.equal(loadCurrentPerformer(store), undefined);
  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(loadCurrentPerformer(broken), undefined);
  assert.doesNotThrow(() => saveCurrentPerformer("1", broken));
  assert.equal(loadCurrentPerformer(undefined), undefined);
});

test("calibration text and the show-gaze toggle are stored per viewer, blocked storage is harmless", () => {
  const data = new Map<string, string>();
  const store = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
  assert.equal(loadCalibrationText(store), undefined);
  assert.equal(saveCalibrationText('{"v":1}', store), true);
  assert.equal(data.get(CALIBRATION_KEY), '{"v":1}');
  assert.equal(CALIBRATION_KEY, "skilltree.calibration");
  assert.equal(loadCalibrationText(store), '{"v":1}');
  assert.equal(saveCalibrationText(undefined, store), true);
  assert.equal(loadCalibrationText(store), undefined);

  assert.equal(loadShowGaze(store), false);
  saveShowGaze(true, store);
  assert.equal(loadShowGaze(store), true);
  saveShowGaze(false, store);
  assert.equal(loadShowGaze(store), false);

  assert.equal(loadTestMode(store), false);
  saveTestMode(true, store);
  assert.equal(loadTestMode(store), true);
  assert.equal(data.get("skilltree.play.testMode"), "1");
  saveTestMode(false, store);
  assert.equal(loadTestMode(store), false);
  assert.equal(data.has("skilltree.play.testMode"), false);

  const broken = {
    getItem: (): string | null => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(loadCalibrationText(broken), undefined);
  assert.equal(saveCalibrationText("x", broken), false);
  assert.equal(saveCalibrationText("x", undefined), false);
  assert.equal(loadShowGaze(broken), false);
  assert.doesNotThrow(() => saveShowGaze(true, broken));
  assert.equal(loadTestMode(broken), false);
  assert.equal(loadTestMode(undefined), false);
  assert.doesNotThrow(() => saveTestMode(true, broken));
});
