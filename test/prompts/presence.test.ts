import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPresenceMonitor } from "../../src/prompts/presence.ts";

const f = (t: number, personPresent: boolean) => ({ t, facePresent: personPresent, personPresent });

describe("createPresenceMonitor", () => {
  it("no frames yet / camera stalled", () => {
    const m = createPresenceMonitor();
    assert.deepEqual(m.present(0), { present: false, reason: "no-frames" });
    m.push(f(0, true));
    assert.equal(m.present(1900).present, true);
    assert.deepEqual(m.present(2100), { present: false, reason: "no-frames" });
  });

  it("absent only after graceMs without a person", () => {
    const m = createPresenceMonitor();
    for (let t = 0; t <= 1000; t += 100) m.push(f(t, true));
    for (let t = 1100; t <= 2500; t += 100) m.push(f(t, false));
    assert.deepEqual(m.present(2500), { present: true, reason: "present" }); // 1400 ms
    m.push(f(2700, false));
    assert.deepEqual(m.present(2700), { present: false, reason: "absent" }); // 1600 ms
    m.push(f(2800, true));
    assert.equal(m.present(2800).present, true);
  });

  it("custom grace, out-of-order frames ignored, never present from the start", () => {
    const m = createPresenceMonitor({ graceMs: 500 });
    m.push(f(0, false));
    m.push(f(400, false));
    assert.equal(m.present(400).present, true);
    m.push(f(600, false));
    m.push(f(300, true)); // late frame
    assert.equal(m.present(600).reason, "absent");
    m.reset();
    assert.equal(m.present(600).reason, "no-frames");
  });
});
