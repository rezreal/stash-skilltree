import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fieldNumber,
  fieldString,
  markerPromptFields,
  markerReplay,
  parseInterestTag,
  parsePromptTag,
  parseReplayTag,
  parseSeriesFields,
  parseTriggerTag,
  sceneProgressFields,
  tagKind,
} from "../../src/stash/fields.ts";

const tag = (custom_fields: Record<string, unknown> | null) => ({ id: "7", name: "Fixation 2", custom_fields });

describe("scalar helpers", () => {
  it("fieldString trims and stringifies scalars", () => {
    assert.equal(fieldString("  a "), "a");
    assert.equal(fieldString("   "), undefined);
    assert.equal(fieldString(3), "3");
    assert.equal(fieldString(false), "false");
    assert.equal(fieldString(null), undefined);
    assert.equal(fieldString(undefined), undefined);
    assert.equal(fieldString({}), undefined);
  });

  it("fieldNumber accepts numbers and numeric strings only", () => {
    assert.equal(fieldNumber(2), 2);
    assert.equal(fieldNumber(" 2.5 "), 2.5);
    assert.equal(fieldNumber("-1"), -1);
    assert.equal(fieldNumber(""), undefined);
    assert.equal(fieldNumber("0x10"), undefined);
    assert.equal(fieldNumber("2 coins"), undefined);
    assert.equal(fieldNumber(true), undefined);
    assert.equal(fieldNumber(Number.NaN), undefined);
    assert.equal(fieldNumber(Number.POSITIVE_INFINITY), undefined);
  });

  it("tagKind normalises case and whitespace", () => {
    assert.equal(tagKind(tag({ "st.kind": " Interest " })), "interest");
    assert.equal(tagKind(tag({})), undefined);
    assert.equal(tagKind(tag(null)), undefined);
  });
});

describe("parseInterestTag", () => {
  it("parses a minimal tag; level as number or string", () => {
    for (const level of [2, "2", " 2 ", "2.0"]) {
      assert.deepEqual(parseInterestTag(tag({ "st.kind": "interest", "st.topic": " fixation ", "st.level": level })), {
        ok: { id: "7", name: "Fixation 2", topic: "fixation", level: 2 },
      });
    }
  });

  it("accepts level 0", () => {
    const r = parseInterestTag(tag({ "st.topic": "a", "st.level": 0 }));
    assert.ok("ok" in r && r.ok.level === 0);
  });

  it("parses optional need, requires and paid", () => {
    const r = parseInterestTag(
      tag({
        "st.topic": "fixation",
        "st.level": "3",
        "st.need": "4",
        "st.requires": " relaxation:1,deepening:2|fixation:2|$80 ",
        "st.paid": "12.5",
      }),
    );
    assert.deepEqual(r, {
      ok: {
        id: "7",
        name: "Fixation 2",
        topic: "fixation",
        level: 3,
        need: 4,
        requires: "relaxation:1,deepening:2|fixation:2|$80",
        paid: 12.5,
      },
    });
  });

  it("treats blank optional fields as unset", () => {
    const r = parseInterestTag(tag({ "st.topic": "a", "st.level": 1, "st.need": "", "st.requires": " ", "st.paid": null }));
    assert.deepEqual(r, { ok: { id: "7", name: "Fixation 2", topic: "a", level: 1 } });
  });

  it("accepts paid 0", () => {
    const r = parseInterestTag(tag({ "st.topic": "a", "st.level": 1, "st.paid": 0 }));
    assert.ok("ok" in r && r.ok.paid === 0);
  });

  const problems: [string, Record<string, unknown> | null, string][] = [
    ["missing topic", { "st.level": 1 }, "st.topic is missing"],
    ["blank topic", { "st.topic": "  ", "st.level": 1 }, "st.topic is missing"],
    ["missing level", { "st.topic": "a" }, "st.level is missing"],
    ["blank level", { "st.topic": "a", "st.level": "" }, "st.level is missing"],
    ["non-numeric level", { "st.topic": "a", "st.level": "two" }, 'st.level must be an integer >= 0, got "two"'],
    ["fractional level", { "st.topic": "a", "st.level": 1.5 }, "st.level must be an integer >= 0, got 1.5"],
    ["negative level", { "st.topic": "a", "st.level": "-1" }, 'st.level must be an integer >= 0, got "-1"'],
    ["boolean level", { "st.topic": "a", "st.level": true }, "st.level must be an integer >= 0, got true"],
    ["need 0", { "st.topic": "a", "st.level": 1, "st.need": 0 }, "st.need must be an integer >= 1, got 0"],
    ["need fraction", { "st.topic": "a", "st.level": 1, "st.need": "1.5" }, 'st.need must be an integer >= 1, got "1.5"'],
    ["need text", { "st.topic": "a", "st.level": 1, "st.need": "x" }, 'st.need must be an integer >= 1, got "x"'],
    ["negative paid", { "st.topic": "a", "st.level": 1, "st.paid": -5 }, "st.paid must be a number >= 0, got -5"],
    ["text paid", { "st.topic": "a", "st.level": 1, "st.paid": "$5" }, 'st.paid must be a number >= 0, got "$5"'],
    ["no fields", null, "st.topic is missing; st.level is missing"],
    [
      "several problems",
      { "st.level": "x", "st.need": 0, "st.paid": "y" },
      'st.topic is missing; st.level must be an integer >= 0, got "x"; st.need must be an integer >= 1, got 0; st.paid must be a number >= 0, got "y"',
    ],
  ];
  for (const [name, fields, problem] of problems) {
    it(`reports ${name}`, () => {
      assert.deepEqual(parseInterestTag(tag(fields)), { problem });
    });
  }
});

describe("parseTriggerTag", () => {
  it("parses installed and used, case-insensitively", () => {
    assert.deepEqual(parseTriggerTag(tag({ "st.trigger": " x ", "st.trigger_role": "installed" })), {
      ok: { id: "7", name: "Fixation 2", trigger: "x", role: "installed" },
    });
    assert.deepEqual(parseTriggerTag(tag({ "st.trigger": "x", "st.trigger_role": " Used " })), {
      ok: { id: "7", name: "Fixation 2", trigger: "x", role: "used" },
    });
  });

  it("stringifies numeric trigger ids", () => {
    const r = parseTriggerTag(tag({ "st.trigger": 5, "st.trigger_role": "used" }));
    assert.ok("ok" in r && r.ok.trigger === "5");
  });

  const problems: [string, Record<string, unknown>, string][] = [
    ["missing trigger", { "st.trigger_role": "used" }, "st.trigger is missing"],
    ["missing role", { "st.trigger": "x" }, "st.trigger_role is missing"],
    ["bad role", { "st.trigger": "x", "st.trigger_role": "planted" }, 'st.trigger_role must be "installed" or "used", got "planted"'],
    ["both missing", {}, "st.trigger is missing; st.trigger_role is missing"],
  ];
  for (const [name, fields, problem] of problems) {
    it(`reports ${name}`, () => {
      assert.deepEqual(parseTriggerTag(tag(fields)), { problem });
    });
  }
});

describe("parseReplayTag / markerReplay", () => {
  it("reads st.replay of replay tags only", () => {
    assert.equal(parseReplayTag(tag({ "st.kind": "prompt", "st.replay": "no" })), undefined);
    assert.deepEqual(parseReplayTag(tag({ "st.kind": "replay", "st.replay": " No " })), { ok: false });
    assert.deepEqual(parseReplayTag(tag({ "st.kind": "replay", "st.replay": "yes" })), { ok: true });
    assert.deepEqual(parseReplayTag(tag({ "st.kind": "replay", "st.replay": true })), { ok: true });
    assert.deepEqual(parseReplayTag(tag({ "st.kind": "replay" })), { problem: "st.replay is missing" });
    assert.deepEqual(parseReplayTag(tag({ "st.kind": "replay", "st.replay": "maybe" })), {
      problem: 'st.replay must be yes or no, got "maybe"',
    });
  });

  it("no wins over yes; other and broken tags are ignored", () => {
    const yes = tag({ "st.kind": "replay", "st.replay": "yes" });
    const no = tag({ "st.kind": "replay", "st.replay": "no" });
    const broken = tag({ "st.kind": "replay", "st.replay": "maybe" });
    assert.equal(markerReplay([yes]), true);
    assert.equal(markerReplay([yes, no]), false);
    assert.equal(markerReplay([broken, tag({ "st.kind": "auto-marker" })]), undefined);
    assert.equal(markerReplay(null), undefined);
  });
});

describe("parsePromptTag", () => {
  it("ignores tags that are not prompt tags", () => {
    assert.equal(parsePromptTag(tag(null)), undefined);
    assert.equal(parsePromptTag(tag({ "st.kind": "interest", "st.check": "gaze" })), undefined);
  });

  it("parses check, target and action", () => {
    assert.deepEqual(parsePromptTag(tag({ "st.kind": "prompt", "st.check": " Gaze ", "st.target": " eyes " })), {
      ok: { check: "gaze", target: "eyes" },
    });
    assert.deepEqual(parsePromptTag(tag({ "st.kind": "prompt", "st.check": "action", "st.action": "nod" })), {
      ok: { check: "action", action: "nod" },
    });
    for (const check of ["repeat", "spend"]) {
      assert.deepEqual(parsePromptTag(tag({ "st.kind": "prompt", "st.check": check })), { ok: { check } });
    }
  });

  it("reports a missing or unknown check", () => {
    assert.deepEqual(parsePromptTag(tag({ "st.kind": "prompt" })), { problem: "st.check is missing" });
    assert.deepEqual(parsePromptTag(tag({ "st.kind": "prompt", "st.check": "blink" })), {
      problem: 'st.check must be one of repeat, gaze, action, spend, mail, got "blink"',
    });
  });

  it("markerPromptFields returns only valid prompt data", () => {
    assert.deepEqual(markerPromptFields(tag({ "st.kind": "prompt", "st.check": "gaze", "st.target": "eyes" })), {
      check: "gaze",
      target: "eyes",
    });
    assert.deepEqual(markerPromptFields(tag({ "st.kind": "prompt", "st.check": "blink" })), {});
    assert.deepEqual(markerPromptFields(tag({})), {});
    assert.deepEqual(markerPromptFields(null), {});
  });
});

describe("sceneProgressFields", () => {
  it("defaults to zero", () => {
    assert.deepEqual(sceneProgressFields({}), { completions: 0, earned: 0, spent: 0 });
    assert.deepEqual(sceneProgressFields(null), { completions: 0, earned: 0, spent: 0 });
  });

  it("parses numbers and numeric strings", () => {
    assert.deepEqual(
      sceneProgressFields({
        "st.completed_at": " 2026-10-01T12:00:00Z ",
        "st.completions": "3",
        "st.earned": 12.5,
        "st.spent": " 4 ",
        "st.other": "ignored",
      }),
      { completedAt: "2026-10-01T12:00:00Z", completions: 3, earned: 12.5, spent: 4 },
    );
  });

  it("treats unparseable values as zero / unset", () => {
    assert.deepEqual(
      sceneProgressFields({ "st.completed_at": "  ", "st.completions": "1.5", "st.earned": "lots", "st.spent": true }),
      { completions: 0, earned: 0, spent: 0 },
    );
  });
});

it("sceneProgressFields reads stored loop exposure", () => {
  assert.equal(sceneProgressFields({ "st.exposure_seconds": "1830.5" }).exposureSec, 1830.5);
  assert.equal(sceneProgressFields({ "st.exposure_seconds": 0 }).exposureSec, undefined);
  assert.equal(sceneProgressFields({}).exposureSec, undefined);
});

describe("parseSeriesFields", () => {
  it("is undefined without st.series", () => {
    assert.equal(parseSeriesFields({}), undefined);
    assert.equal(parseSeriesFields(null), undefined);
    assert.equal(parseSeriesFields({ "st.series": "  ", "st.reset": "step_back" }), undefined);
  });

  it("parses daily with the default and explicit reset modes", () => {
    assert.deepEqual(parseSeriesFields({ "st.series": "Daily" }), { ok: { mode: "daily", reset: "start" } });
    assert.deepEqual(parseSeriesFields({ "st.series": "daily", "st.reset": " STEP_BACK " }), {
      ok: { mode: "daily", reset: "step_back" },
    });
  });

  it("reports unknown values", () => {
    assert.deepEqual(parseSeriesFields({ "st.series": "weekly", "st.reset": "start" }), {
      problem: 'st.series must be "daily", got "weekly"',
    });
    assert.deepEqual(parseSeriesFields({ "st.series": "daily", "st.reset": 3 }), {
      problem: 'st.reset must be "start" or "step_back", got 3',
    });
  });
});
