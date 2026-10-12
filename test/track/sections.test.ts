import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFunscript } from "../../src/funscript/parse.ts";
import { positionAt, scriptActions } from "../../src/track/normalize.ts";
import { applyLimits, segment } from "../../src/track/sections.ts";
import type { Action, Section } from "../../src/track/types.ts";
import { ScriptBuilder, compositeScript, rng } from "./fixtures.ts";

const kinds = (s: Section[]) => s.map((x) => `${x.kind}@${x.start}-${x.end}`);

function assertCovers(sections: Section[], actions: Action[]) {
  assert.ok(sections.length > 0);
  assert.equal(sections[0].start, 0);
  assert.equal(sections[sections.length - 1].end, actions[actions.length - 1].at);
  for (let i = 0; i < sections.length; i++) {
    assert.ok(sections[i].end > sections[i].start, `section ${i} has length`);
    if (i > 0) assert.equal(sections[i].start, sections[i - 1].end, `no gap before ${i}`);
  }
}

describe("normalize", () => {
  it("reads pos as depth = 100 - pos, takes inverted files as is, applies range, collapses equal timestamps", () => {
    const f = parseFunscript({ inverted: true, range: 50, actions: [{ at: 0, pos: 50 }, { at: 100, pos: 0 }, { at: 100, pos: 25 }, { at: 200, pos: 80 }] });
    assert.deepEqual(scriptActions(f), [
      { at: 0, pos: 100 },
      { at: 100, pos: 50 },
      { at: 200, pos: 100 },
    ]);
    const plain = parseFunscript({ actions: [{ at: 0, pos: 10 }] });
    assert.deepEqual(scriptActions(plain), [{ at: 0, pos: 90 }]);
  });

  it("interpolates linearly and holds the edge values", () => {
    const a = [
      { at: 1000, pos: 20 },
      { at: 2000, pos: 60 },
    ];
    assert.equal(positionAt(a, 0), 20);
    assert.equal(positionAt(a, 1000), 20);
    assert.equal(positionAt(a, 1500), 40);
    assert.equal(positionAt(a, 1750), 50);
    assert.equal(positionAt(a, 9999), 60);
    assert.equal(positionAt([], 5), 0);
  });
});

describe("segment", () => {
  it("splits the composite script into idle, stroke, ramp, hold, ramp, idle", () => {
    const s = segment(compositeScript());
    assert.deepEqual(kinds(s), [
      "idle@0-3000",
      "stroke@3000-11000",
      "ramp@11000-15000",
      "hold@15000-19000",
      "ramp@19000-21000",
      "idle@21000-24000",
    ]);
    const stroke = s[1];
    assert.equal(stroke.min, 0);
    assert.equal(stroke.max, 80);
    assert.equal(stroke.turns?.length, 19);
    assert.equal(stroke.turns?.[0], 3400);
    assert.deepEqual([s[2].from, s[2].to], [0, 60]);
    assert.equal(s[3].depth, 60);
    assert.ok(s.every((x) => !x.unscored));
  });

  it("idle is flat near 0, hold is flat with depth", () => {
    const s = segment(new ScriptBuilder(3).flat(2000).to(40, 2000).flat(2000).actions);
    assert.deepEqual(s.map((x) => x.kind), ["idle", "ramp", "hold"]);
    assert.equal(s[2].depth, 40);
  });

  it("keeps short flat bits at the bottom of a stroke inside the stroke", () => {
    const b = new ScriptBuilder(0).flat(1000);
    for (let i = 0; i < 6; i++) b.to(70, 300).to(0, 300).flat(300);
    b.flat(1000);
    const s = segment(b.actions);
    assert.deepEqual(s.map((x) => x.kind), ["idle", "stroke", "idle"]);
    assert.equal(s[1].turns?.length, 11);
  });

  it("a slow drift is a ramp, not a chain of holds", () => {
    const b = new ScriptBuilder(10);
    for (let i = 0; i < 100; i++) b.to(10 + (i + 1) * 0.4, 100); // 10 -> 50 over 10 s, 4 units/s
    const s = segment(b.actions);
    assert.deepEqual(s.map((x) => x.kind), ["ramp"]);
    assert.equal(s[0].from, 10);
    assert.equal(Math.round(s[0].to ?? 0), 50);
  });

  it("a lone fast move between flat stretches is a ramp", () => {
    const s = segment(new ScriptBuilder(0).flat(1000).to(70, 200).flat(1500).actions);
    assert.deepEqual(s.map((x) => x.kind), ["idle", "ramp", "hold"]);
  });

  it("starts at 0 even when the script starts later", () => {
    const s = segment([
      { at: 2000, pos: 50 },
      { at: 4000, pos: 50 },
      { at: 4300, pos: 0 },
    ]);
    assert.deepEqual(kinds(s), ["hold@0-4000", "ramp@4000-4300"]);
  });

  it("handles tiny scripts", () => {
    assert.deepEqual(segment([]), []);
    assert.deepEqual(segment([{ at: 0, pos: 30 }]), []);
    assert.deepEqual(kinds(segment([{ at: 0, pos: 0 }, { at: 300, pos: 2 }])), ["idle@0-300"]);
  });

  it("covers random scripts without gaps, deterministically", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed);
      const b = new ScriptBuilder(Math.round(r() * 100));
      for (let i = 0; i < 80; i++) {
        const k = r();
        if (k < 0.2) b.flat(100 + Math.round(r() * 3000));
        else b.to(Math.round(r() * 100), 50 + Math.round(r() * 1500));
      }
      const s1 = segment(b.actions);
      assertCovers(s1, b.actions);
      assert.deepEqual(segment(b.actions), s1);
      for (const s of s1) {
        if (s.kind === "stroke") assert.ok((s.turns ?? []).every((t) => t > s.start && t < s.end));
      }
    }
  });

  it("respects section params", () => {
    const a = new ScriptBuilder(0).flat(600).to(50, 1000).flat(600).actions;
    assert.deepEqual(segment(a).map((x) => x.kind), ["ramp"]);
    assert.deepEqual(segment(a, { holdMinMs: 500 }).map((x) => x.kind), ["idle", "ramp", "hold"]);
  });
});

describe("limits", () => {
  it("marks deep sections and long holds unscored, never idle", () => {
    const s = segment(compositeScript(), {}, { maxDepth: 70, maxHoldSec: 3 });
    assert.deepEqual(
      s.map((x) => [x.kind, x.unscored === true]),
      [
        ["idle", false],
        ["stroke", true], // reaches 80
        ["ramp", false],
        ["hold", true], // 4 s > 3 s
        ["ramp", false],
        ["idle", false],
      ],
    );
    const ok = applyLimits(segment(compositeScript()), { maxDepth: 85, maxHoldSec: 8 });
    assert.ok(ok.every((x) => !x.unscored));
  });
});
