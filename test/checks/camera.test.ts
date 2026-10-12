import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCameraManager, type CameraSessionLike } from "../../src/checks/camera.ts";
import { PerceptionError } from "../../src/perception/errors.ts";
import type { ViewerFrame } from "../../src/prompts/types.ts";

interface Fake extends CameraSessionLike {
  stopped: boolean;
  rates: number[];
  frame(f: ViewerFrame): void;
  fail(e: PerceptionError): void;
}

function fakeSession(): Fake {
  const frames = new Set<(f: ViewerFrame) => void>();
  const errors = new Set<(e: PerceptionError) => void>();
  let latest: ViewerFrame | null = null;
  const s: Fake = {
    stream: {} as MediaStream,
    stopped: false,
    rates: [],
    latest: () => latest,
    onFrame: (cb) => (frames.add(cb), () => frames.delete(cb)),
    onError: (cb) => (errors.add(cb), () => errors.delete(cb)),
    setRate: (hz) => s.rates.push(hz),
    stop: () => {
      s.stopped = true;
    },
    frame: (f) => {
      latest = f;
      for (const cb of frames) cb(f);
    },
    fail: (e) => {
      for (const cb of errors) cb(e);
    },
  };
  return s;
}

/** a manager with manual timers and a controllable start */
function setup(opts?: { fail?: unknown }) {
  const started: { resolve: (s: Fake) => void; reject: (e: unknown) => void; rateHz: number }[] = [];
  const timers = new Map<number, () => void>();
  let nextId = 1;
  let clock = 0;
  const m = createCameraManager({
    start: ({ rateHz }) =>
      new Promise<CameraSessionLike>((resolve, reject) => {
        if (opts?.fail) reject(opts.fail);
        else started.push({ resolve, reject, rateHz });
      }),
    lingerMs: 1000,
    now: () => clock,
    setTimer: (fn) => {
      const id = nextId++;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id as number);
    },
  });
  const runTimers = () => {
    for (const [id, fn] of [...timers]) {
      timers.delete(id);
      fn();
    }
  };
  return { m, started, timers, runTimers, setClock: (t: number) => (clock = t) };
}

const tick = () => new Promise((r) => setImmediate(r));
const frame = (t: number, personPresent: boolean): ViewerFrame => ({ t, facePresent: personPresent, personPresent });

describe("createCameraManager", () => {
  it("starts on acquire, stops a moment after the last release", async () => {
    const { m, started, timers, runTimers } = setup();
    assert.equal(m.snapshot().state, "off");
    const release = m.acquire();
    assert.equal(m.snapshot().state, "starting");
    const s = fakeSession();
    started[0]!.resolve(s);
    await tick();
    assert.equal(m.snapshot().state, "on");
    assert.equal(m.stream(), s.stream);
    release();
    release(); // idempotent
    assert.equal(m.users, 0);
    assert.equal(s.stopped, false);
    assert.equal(timers.size, 1);
    runTimers();
    assert.equal(s.stopped, true);
    assert.equal(m.snapshot().state, "off");
    assert.equal(m.stream(), null);
  });

  it("a remount within the linger keeps the same session (StrictMode, gate -> session)", async () => {
    const { m, started, runTimers } = setup();
    const r1 = m.acquire();
    const s = fakeSession();
    started[0]!.resolve(s);
    await tick();
    r1();
    const r2 = m.acquire();
    runTimers();
    assert.equal(s.stopped, false);
    assert.equal(started.length, 1);
    assert.equal(m.snapshot().state, "on");
    r2();
    runTimers();
    assert.equal(s.stopped, true);
  });

  it("a start that resolves after everyone left is stopped right away", async () => {
    const { m, started, runTimers } = setup();
    const r = m.acquire();
    r();
    runTimers();
    assert.equal(m.snapshot().state, "off");
    const s = fakeSession();
    started[0]!.resolve(s);
    await tick();
    assert.equal(s.stopped, true);
    assert.equal(m.snapshot().state, "off");
  });

  it("start errors become PerceptionErrors; the next first user retries", async () => {
    const { m } = setup({ fail: new PerceptionError("permission-denied", "denied") });
    const r = m.acquire();
    await tick();
    assert.equal(m.snapshot().state, "error");
    assert.equal(m.snapshot().error?.code, "permission-denied");
    assert.deepEqual(m.present(), { present: false, reason: "error" });
    r();
    const r2 = m.acquire(); // first user again (linger pending): retries
    assert.equal(m.snapshot().state, "starting");
    await tick();
    assert.equal(m.snapshot().state, "error");
    r2();

    const plain = setup({ fail: new Error("weird") });
    plain.m.acquire();
    await tick();
    assert.equal(plain.m.snapshot().error?.code, "unknown");
  });

  it("a session error stops the camera; retry starts it again", async () => {
    const { m, started } = setup();
    m.acquire();
    const s = fakeSession();
    started[0]!.resolve(s);
    await tick();
    s.fail(new PerceptionError("device-busy", "unplugged"));
    assert.equal(s.stopped, true);
    assert.equal(m.snapshot().state, "error");
    assert.equal(m.snapshot().error?.code, "device-busy");
    m.retry();
    assert.equal(m.snapshot().state, "starting");
    assert.equal(started.length, 2);
  });

  it("presence from frames, frame subscribers, rate", async () => {
    const { m, started, setClock } = setup();
    assert.deepEqual(m.present(), { present: false, reason: "off" });
    m.acquire();
    assert.deepEqual(m.present(), { present: false, reason: "starting" });
    m.setRate(15);
    const s = fakeSession();
    started[0]!.resolve(s);
    await tick();
    assert.deepEqual(s.rates, [15]);
    const seen: number[] = [];
    const off = m.subscribe((f) => seen.push(f.t));
    s.frame(frame(100, true));
    setClock(150);
    assert.deepEqual(m.present(), { present: true, reason: "present" });
    s.frame(frame(200, false));
    s.frame(frame(2000, false));
    assert.deepEqual(m.present(2000), { present: false, reason: "absent" });
    assert.deepEqual(m.present(5000), { present: false, reason: "no-frames" });
    off();
    s.frame(frame(2100, true));
    assert.deepEqual(seen, [100, 200, 2000]);
    assert.equal(m.latest()?.t, 2100);
    m.setRate(5);
    assert.deepEqual(s.rates, [15, 5]);
  });

  it("stopNow and change listeners", async () => {
    const { m, started } = setup();
    const states: string[] = [];
    m.onChange(() => states.push(m.snapshot().state));
    m.acquire();
    const s = fakeSession();
    started[0]!.resolve(s);
    await tick();
    m.stopNow();
    assert.equal(s.stopped, true);
    assert.deepEqual(states, ["starting", "on", "off"]);
  });
});
