import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  filterPromptEvents,
  needsPerson,
  newlyReplaying,
  personPartsFor,
  scheduleChecks,
  selectSpecs,
  uncheckableReason,
  wantsAnalysis,
} from "../../src/checks/schedule.ts";
import type { PromptPhase, PromptSpec } from "../../src/prompts/types.ts";
import { entry, spec } from "./fixtures.ts";

describe("targets and parts", () => {
  it("which targets need the analysed person", () => {
    assert.equal(needsPerson("eyes"), true);
    assert.equal(needsPerson("groin"), true);
    assert.equal(needsPerson("screen_center"), false);
    assert.equal(needsPerson("off_screen"), false);
    assert.equal(needsPerson("feet_floor"), false);
    assert.equal(wantsAnalysis("feet_floor"), true);
    assert.equal(wantsAnalysis("off_screen"), false);
    assert.equal(needsPerson(undefined), false);
  });

  it("models per target set", () => {
    assert.deepEqual(personPartsFor(["hips"]), { pose: true, face: false, hands: false });
    assert.deepEqual(personPartsFor(["eyes", "hands"]), { pose: true, face: true, hands: true });
    assert.deepEqual(personPartsFor(["screen_center"]), { pose: false, face: false, hands: false });
  });
});

describe("selectSpecs", () => {
  const rep = spec({ check: "repeat", start: 0, end: 5, title: "hi" });
  const eyes = spec({ check: "gaze", start: 5, end: 10, target: "eyes" });
  const centre = spec({ check: "gaze", start: 10, end: 15, target: "screen_center" });
  const act = spec({ check: "action", start: 15, end: 20, action: "nod" });
  const spend = spec({ check: "spend", start: 20, end: 30, title: "5" });
  const all = [rep, eyes, centre, act, spend];

  it("everything on: all but spend", () => {
    assert.deepEqual(selectSpecs(all, { speechEnabled: true, videoAnalysis: true }), { specs: [rep, eyes, centre, act], skipped: [] });
  });

  it("speech / video analysis off skip what needs them", () => {
    const sel = selectSpecs(all, { speechEnabled: false, videoAnalysis: false });
    assert.deepEqual(sel.specs, [centre, act]);
    assert.deepEqual(
      sel.skipped.map((s) => [s.spec, s.why]),
      [
        [rep, "speech recognition is off"],
        [eyes, "video analysis is off"],
      ],
    );
  });
});

describe("uncheckableReason", () => {
  const all = { speech: true, vision: true, camera: true, tracker: true };
  it("by check kind", () => {
    const rep = spec({ check: "repeat", start: 0, end: 5 });
    const eyes = spec({ check: "gaze", start: 0, end: 5, target: "eyes" });
    const off = spec({ check: "gaze", start: 0, end: 5, target: "off_screen" });
    const act = spec({ check: "action", start: 0, end: 5, action: "nod" });
    for (const s of [rep, eyes, off, act]) assert.equal(uncheckableReason(s, all), undefined);
    assert.match(uncheckableReason(rep, { ...all, speech: false })!, /microphone/);
    assert.match(uncheckableReason(eyes, { ...all, tracker: false })!, /eye tracker/);
    assert.match(uncheckableReason(eyes, { ...all, vision: false })!, /video analysis/);
    assert.equal(uncheckableReason(off, { ...all, vision: false }), undefined);
    assert.match(uncheckableReason(act, { ...all, camera: false })!, /camera/);
  });
});

describe("filterPromptEvents", () => {
  const a = spec({ markerId: "a", check: "repeat", start: 10, end: 15 });
  const b = spec({ markerId: "b", check: "action", start: 12, end: 16 });
  const byId = new Map<string, PromptSpec>([
    ["a", a],
    ["b", b],
  ]);

  it("drops results of blocked prompts", () => {
    const out = filterPromptEvents(
      { results: [{ markerId: "a", passed: false }, { markerId: "b", passed: true }, { markerId: "x", passed: true }], requests: [] },
      byId,
      [],
      (s) => s === a,
    );
    assert.deepEqual(out.results, [{ markerId: "b", passed: true }, { markerId: "x", passed: true }]);
  });

  it("drops a seek that only serves blocked replays, re-aims a mixed one", () => {
    const seek = { results: [], requests: [{ type: "seek" as const, to: 9 }] };
    assert.deepEqual(filterPromptEvents(seek, byId, [a], (s) => s === a).requests, []);
    assert.deepEqual(filterPromptEvents(seek, byId, [a, b], (s) => s === a).requests, [{ type: "seek", to: 11 }]);
    assert.deepEqual(filterPromptEvents(seek, byId, [a, b], () => false).requests, seek.requests);
    // unknown origin: kept
    assert.deepEqual(filterPromptEvents(seek, byId, [], () => true).requests, seek.requests);
  });

  it("newlyReplaying diffs phases", () => {
    const before = new Map<string, PromptPhase>([
      ["a", "active"],
      ["b", "replaying"],
    ]);
    assert.deepEqual(newlyReplaying(before, [entry(a, "replaying"), entry(b, "replaying")]), [a]);
  });
});

describe("scheduleChecks", () => {
  const rep = spec({ check: "repeat", start: 10, end: 16 });
  const eyes = spec({ check: "gaze", start: 20, end: 25, target: "eyes" });
  const centre = spec({ check: "gaze", start: 30, end: 35, target: "screen_center" });
  const act = spec({ check: "action", start: 40, end: 45, action: "hands_on_head" });

  it("mic from 1 s before a repeat window until it ends", () => {
    const at = (t: number, phase: PromptPhase = "upcoming") => scheduleChecks([entry(rep, phase)], t).mic;
    assert.equal(at(8.9), false);
    assert.equal(at(9), true);
    assert.equal(at(12, "active"), true);
    assert.equal(at(15.99, "active"), true);
    assert.equal(at(16), false);
    // already decided: no mic
    assert.equal(at(12, "passed"), false);
    assert.equal(at(12, "failed"), false);
    // replay: the seek lands in the lead
    assert.equal(at(9.2, "replaying"), true);
  });

  it("analysis only around gaze windows that need the person, with their models", () => {
    const s = scheduleChecks([entry(eyes, "active")], 21);
    assert.equal(s.analysis, true);
    assert.deepEqual(s.parts, { pose: true, face: true, hands: false });
    assert.equal(s.gazeActive, true);
    assert.equal(scheduleChecks([entry(eyes)], 18.5).analysis, false);
    assert.equal(scheduleChecks([entry(eyes)], 19.5).analysis, true);
    assert.equal(scheduleChecks([entry(eyes)], 19.5).gazeActive, false);
    const c = scheduleChecks([entry(centre, "active")], 31);
    assert.equal(c.analysis, false);
    assert.equal(c.gazeActive, true);
  });

  it("webcam action rate around action windows; active list", () => {
    const s = scheduleChecks([entry(rep, "passed"), entry(act, "active")], 41);
    assert.equal(s.actionRate, true);
    assert.equal(s.mic, false);
    assert.deepEqual(s.active, [act]);
    assert.equal(scheduleChecks([entry(act)], 38).actionRate, false);
  });

  it("no video time: nothing runs", () => {
    const s = scheduleChecks([entry(rep, "active")], NaN);
    assert.equal(s.mic, false);
    assert.deepEqual(s.active, []);
  });

  it("custom lead", () => {
    assert.equal(scheduleChecks([entry(rep)], 7.5, { leadSec: 3 }).mic, true);
  });
});
