import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMouseSource } from "../../src/gaze/mouse.ts";
import { screenToViewport } from "../../src/gaze/mapping.ts";
import type { GazeSample, GazeStatus, WindowGeometry } from "../../src/gaze/types.ts";
import { FakeClock, FakeTarget } from "./fakes.ts";

const GEO: WindowGeometry = {
  screenX: 1930, screenY: 20, outerWidth: 1216, outerHeight: 900, innerWidth: 1200, innerHeight: 800,
  devicePixelRatio: 1.25, fullscreen: false,
};

function setup() {
  const clock = new FakeClock();
  const target = new FakeTarget();
  const src = createMouseSource({
    target,
    now: clock.now,
    timers: clock,
    geometry: () => GEO,
    screenOffset: () => ({ x: 2400, y: 0 }),
    screenSize: () => ({ width: 3200, height: 1800 }),
  });
  const samples: GazeSample[] = [];
  const statuses: GazeStatus[] = [];
  src.onSample((s) => samples.push(s));
  src.onStatus((s) => statuses.push(s));
  return { clock, target, src, samples, statuses };
}

describe("createMouseSource", () => {
  it("maps mouse positions so screenToViewport gives them back", async () => {
    const { target, src, samples } = setup();
    await src.connect();
    assert.equal(src.status().connection, "connected");
    assert.equal(src.status().present, true);
    target.dispatch("mousemove", { clientX: 321, clientY: 123 });
    const s = samples.at(-1)!;
    assert.equal(s.valid, true);
    const back = screenToViewport(s, GEO, src.status().screen);
    assert.ok(Math.abs(back.x - 321) < 1e-9 && Math.abs(back.y - 123) < 1e-9);
  });

  it("repeats the last sample while the mouse is still", async () => {
    const { clock, target, src, samples } = setup();
    await src.connect();
    target.dispatch("mousemove", { clientX: 10, clientY: 10 });
    const n = samples.length;
    clock.advance(1000);
    assert.ok(samples.length - n >= 29, String(samples.length - n));
    assert.ok(samples.slice(n).every((s) => s.valid && s.x === samples[n - 1]!.x));
    assert.ok(src.status().rate! >= 29);
  });

  it("holding Shift or leaving the window looks away", async () => {
    const { clock, target, src, samples, statuses } = setup();
    await src.connect();
    target.dispatch("mousemove", { clientX: 10, clientY: 10 });
    target.dispatch("keydown", { key: "Shift" });
    assert.equal(samples.at(-1)!.valid, false);
    assert.equal(statuses.at(-1)!.tracking, false);
    clock.advance(100);
    assert.equal(samples.at(-1)!.valid, false);
    target.dispatch("keyup", { key: "Shift" });
    assert.equal(samples.at(-1)!.valid, true);
    target.dispatch("mousemove", { clientX: 10, clientY: 10, shiftKey: true });
    assert.equal(samples.at(-1)!.valid, false);
    target.dispatch("mousemove", { clientX: 10, clientY: 10, shiftKey: false });
    target.dispatch("mouseout", { relatedTarget: {} });
    assert.equal(samples.at(-1)!.valid, true);
    target.dispatch("mouseout", { relatedTarget: null });
    assert.equal(samples.at(-1)!.valid, false);
    target.dispatch("mousemove", { clientX: 11, clientY: 10 });
    assert.equal(samples.at(-1)!.valid, true);
    target.dispatch("blur");
    assert.equal(samples.at(-1)!.valid, false);
  });

  it("is invalid before the first mouse move", async () => {
    const { clock, src, samples } = setup();
    await src.connect();
    clock.advance(50);
    assert.equal(samples.at(-1)!.valid, false);
  });

  it("disconnect removes listeners and stops the heartbeat", async () => {
    const { clock, target, src, samples } = setup();
    await src.connect();
    target.dispatch("mousemove", { clientX: 10, clientY: 10 });
    src.disconnect();
    assert.equal(target.count(), 0);
    assert.equal(clock.pending, 0);
    const n = samples.length;
    clock.advance(1000);
    assert.equal(samples.length, n);
    assert.equal(src.status().connection, "disconnected");
  });
});
