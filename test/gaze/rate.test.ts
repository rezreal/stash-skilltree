import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createListeners, createRateCounter } from "../../src/gaze/rate.ts";

describe("createRateCounter", () => {
  it("counts events in the last second", () => {
    const r = createRateCounter();
    assert.equal(r.rate(0), 0);
    for (let t = 0; t < 2000; t += 10) r.add(t);
    assert.equal(r.rate(1990), 100);
    assert.equal(r.rate(2500), 49);
    assert.equal(r.rate(5000), 0);
    r.add(5000);
    r.reset();
    assert.equal(r.rate(5000), 0);
  });

  it("supports other windows", () => {
    const r = createRateCounter(500);
    for (let t = 0; t < 1000; t += 50) r.add(t);
    assert.equal(r.rate(950), 20);
  });
});

describe("createListeners", () => {
  it("unsubscribes and isolates throwing listeners", () => {
    const l = createListeners<number>();
    const got: number[] = [];
    const orig = console.error;
    console.error = () => {};
    try {
      l.add(() => {
        throw new Error("boom");
      });
      const off = l.add((v) => got.push(v));
      l.emit(1);
      off();
      l.emit(2);
    } finally {
      console.error = orig;
    }
    assert.deepEqual(got, [1]);
  });
});
