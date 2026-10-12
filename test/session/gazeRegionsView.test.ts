import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { countedText, performerRegionsLine, regionBars } from "../../src/session/gazeRegionsView.ts";

describe("regionBars", () => {
  it("labels the regions largest first", () => {
    assert.deepEqual(regionBars({ chest: 1, eyes: 3 }), [
      { label: "Eyes", share: 0.75, text: "75%" },
      { label: "Chest", share: 0.25, text: "25%" },
    ]);
    assert.deepEqual(regionBars({}), []);
  });
  it("sums the smallest into Other beyond max", () => {
    const bars = regionBars({ eyes: 4, face: 3, chest: 2, hands: 1 }, 3);
    assert.deepEqual(
      bars.map((b) => [b.label, b.text]),
      [
        ["Eyes", "40%"],
        ["Face", "30%"],
        ["Other", "30%"],
      ],
    );
  });
});

describe("performerRegionsLine / countedText", () => {
  it("names the performer, the clips and the top regions", () => {
    assert.equal(
      performerRegionsLine("Ada", { sessions: 5, sec: { eyes: 3, face: 2, person: 4, off: 1 } }),
      "Ada · 5 clips · rest of the body 40%, eyes 30%, face 20%",
    );
    assert.equal(performerRegionsLine("Bo", { sessions: 1, sec: {} }), "Bo · 1 clip");
  });
  it("says how much gaze was counted", () => {
    assert.equal(countedText({ eyes: 12.4 }), "12 s of gaze counted");
    assert.equal(countedText({ eyes: 100, face: 30 }), "2 min 10 s of gaze counted");
  });
});
