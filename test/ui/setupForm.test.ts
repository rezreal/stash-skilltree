import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SetupTag } from "../../src/stash/tags.ts";
import {
  CONFIG_KEYS,
  GAZE_TARGETS,
  GAZE_TARGET_HELP,
  activeFields,
  describeChange,
  diffForm,
  filterTags,
  formFromFields,
  parseFormNumber,
  readOnlyFields,
  opensAfter,
  setupContext,
  tagSummary,
  toggleListToken,
  validateForm,
  withKind,
  withValue,
  type SetupContext,
  type SetupForm,
} from "../../src/ui/setupForm.ts";

const ctx = (levels: Record<string, number[]> = {}): SetupContext => ({ levels: new Map(Object.entries(levels)) });

const tag = (id: string, name: string, customFields: Record<string, unknown> = {}, extra: Partial<SetupTag> = {}): SetupTag => ({
  id,
  name,
  aliases: [],
  sceneCount: 0,
  customFields,
  ...extra,
});

function edit(form: SetupForm, values: Record<string, string>): SetupForm {
  let f = form;
  for (const [k, v] of Object.entries(values)) f = withValue(f, k, v);
  return f;
}

const empty = () => formFromFields({});

describe("formFromFields", () => {
  it("starts unconfigured tags as kind none with empty values", () => {
    const f = formFromFields(null);
    assert.equal(f.kind, "none");
    assert.equal(f.unknownKind, undefined);
    for (const key of CONFIG_KEYS.filter((k) => k !== "st.kind")) assert.equal(f.values[key], "", key);
  });

  it("reads interest fields as input text", () => {
    const f = formFromFields({ "st.kind": " Interest ", "st.topic": " fixation ", "st.level": 2, "st.need": "3", "st.requires": "a:1|$5" });
    assert.equal(f.kind, "interest");
    assert.equal(f.values["st.topic"], "fixation");
    assert.equal(f.values["st.level"], "2");
    assert.equal(f.values["st.need"], "3");
    assert.equal(f.values["st.requires"], "a:1|$5");
  });

  it("lower-cases choices and normalises lists", () => {
    const f = formFromFields({ "st.kind": "policy", "st.policy": " Prompts, attention ,prompts", "st.trigger_role": "USED" });
    assert.equal(f.values["st.policy"], "attention,prompts");
    assert.equal(f.values["st.trigger_role"], "used");
  });

  it("keeps an unknown kind aside", () => {
    const f = formFromFields({ "st.kind": "Intrest" });
    assert.equal(f.kind, "none");
    assert.equal(f.unknownKind, "Intrest");
    assert.match(validateForm(f, ctx()).warnings[0], /"Intrest" is not a known kind/);
  });

  it("knows auto-marker", () => {
    assert.equal(formFromFields({ "st.kind": "auto-marker" }).kind, "auto-marker");
    assert.deepEqual(activeFields(formFromFields({ "st.kind": "auto-marker" })), []);
  });
});

describe("parseFormNumber", () => {
  it("accepts numbers with a decimal point or comma", () => {
    assert.equal(parseFormNumber(" 2 "), 2);
    assert.equal(parseFormNumber("0.5"), 0.5);
    assert.equal(parseFormNumber("0,5"), 0.5);
    assert.equal(parseFormNumber(",5"), 0.5);
    assert.equal(parseFormNumber("1e3"), 1000);
    assert.equal(parseFormNumber("1,000,5"), undefined);
    assert.equal(parseFormNumber("two"), undefined);
    assert.equal(parseFormNumber(""), undefined);
  });
});

describe("activeFields", () => {
  it("shows target only for gaze and action only for action", () => {
    const keys = (check: string) => activeFields(edit(withKind(empty(), "prompt"), { "st.check": check })).map((s) => s.key);
    assert.deepEqual(keys("gaze"), ["st.check", "st.target"]);
    assert.deepEqual(keys("action"), ["st.check", "st.action"]);
    assert.deepEqual(keys("repeat"), ["st.check"]);
    assert.deepEqual(keys(""), ["st.check"]);
  });
});

describe("validateForm", () => {
  it("interest: topic and level are required", () => {
    const v = validateForm(withKind(empty(), "interest"), ctx());
    assert.deepEqual(v.errors, { "st.topic": "Required", "st.level": "Required" });
  });

  it("interest: level must be a whole number >= 0, need >= 1", () => {
    const base = edit(withKind(empty(), "interest"), { "st.topic": "a" });
    assert.equal(validateForm(withValue(base, "st.level", "-1"), ctx()).errors["st.level"], "Must be a whole number ≥ 0");
    assert.equal(validateForm(withValue(base, "st.level", "1.5"), ctx()).errors["st.level"], "Must be a whole number ≥ 0");
    assert.equal(validateForm(withValue(base, "st.level", "x"), ctx()).errors["st.level"], "Must be a whole number ≥ 0");
    const ok = withValue(base, "st.level", "0");
    assert.deepEqual(validateForm(ok, ctx()).errors, {});
    assert.equal(validateForm(withValue(ok, "st.need", "0"), ctx()).errors["st.need"], "Must be a whole number ≥ 1");
    assert.deepEqual(validateForm(withValue(ok, "st.need", "3"), ctx()).errors, {});
  });

  it("interest: topic must be usable in st.requires", () => {
    const f = edit(withKind(empty(), "interest"), { "st.topic": "a:b", "st.level": "0" });
    assert.equal(validateForm(f, ctx()).errors["st.topic"], "Only letters, digits, spaces, _ and -");
    assert.deepEqual(validateForm(withValue(f, "st.topic", "Deep Relax_2-x"), ctx()).errors, {});
  });

  it("interest: reports st.requires parse errors", () => {
    const f = edit(withKind(empty(), "interest"), { "st.topic": "a", "st.level": "0", "st.requires": "b:x,$0" });
    const v = validateForm(f, ctx({ b: [0] }));
    assert.match(v.errors["st.requires"], /level must be a whole number/);
    assert.match(v.errors["st.requires"], /amount must be a positive whole number/);
  });

  it("interest: warns about references to missing topics and levels", () => {
    const f = edit(withKind(empty(), "interest"), { "st.topic": "a", "st.level": "1", "st.requires": "b:0|c:3,a:1,$20" });
    const v = validateForm(f, ctx({ a: [0], c: [0, 1] }));
    assert.deepEqual(v.errors, {});
    assert.deepEqual(v.warnings, [
      'st.requires: no tag has topic "b"',
      "st.requires: c:3 does not exist (c has levels 0, 1)",
      "st.requires names this tag's own level a:1",
    ]);
  });

  it("interest: warns about a missing previous level", () => {
    const f = edit(withKind(empty(), "interest"), { "st.topic": "A", "st.level": "2" });
    assert.deepEqual(validateForm(f, ctx({ a: [0] })).warnings, ["No other tag has a:1; level 2 stays locked until it exists"]);
    assert.deepEqual(validateForm(f, ctx({ a: [0, 1] })).warnings, []);
  });

  it("trigger: name and role are required, role is installed or used", () => {
    const f = withKind(empty(), "trigger");
    assert.deepEqual(validateForm(f, ctx()).errors, { "st.trigger": "Required", "st.trigger_role": "Required" });
    const bad = edit(f, { "st.trigger": "x", "st.trigger_role": "maybe" });
    assert.equal(validateForm(bad, ctx()).errors["st.trigger_role"], "Must be one of installed, used");
    assert.deepEqual(validateForm(withValue(bad, "st.trigger_role", "Installed"), ctx()).errors, {});
  });

  it("policy: rules from the list, thresholds in range", () => {
    const f = withKind(empty(), "policy");
    assert.deepEqual(validateForm(f, ctx()).errors, { "st.policy": "Required" });
    const v = validateForm(
      edit(f, { "st.policy": "attention,blink", "st.track_min": "1.5", "st.min_minutes": "-2", "st.hold_min_ms": "2.5", "st.reward_mult": "x" }),
      ctx(),
    );
    assert.deepEqual(v.errors, {
      "st.policy": "Unknown: blink; use attention, exposure, prompts, track",
      "st.track_min": "Must be a number from 0 to 1",
      "st.min_minutes": "Must be a number ≥ 0",
      "st.hold_min_ms": "Must be a whole number ≥ 0",
      "st.reward_mult": "Must be a number ≥ 0",
    });
    const ok = edit(f, { "st.policy": "track", "st.track_min": "0,8", "st.hold_tol": "0.1", "st.idle_max": "5" });
    assert.deepEqual(validateForm(ok, ctx()).errors, {});
  });

  it("prompt: check required, target/action required for gaze/action", () => {
    const f = withKind(empty(), "prompt");
    assert.deepEqual(validateForm(f, ctx()).errors, { "st.check": "Required" });
    assert.deepEqual(validateForm(withValue(f, "st.check", "gaze"), ctx()).errors, { "st.target": "Required" });
    assert.deepEqual(validateForm(withValue(f, "st.check", "action"), ctx()).errors, { "st.action": "Required" });
    assert.deepEqual(validateForm(withValue(f, "st.check", "repeat"), ctx()).errors, {});
    assert.match(validateForm(edit(f, { "st.check": "gaze", "st.target": "nose" }), ctx()).errors["st.target"], /^Must be one of eyes, face/);
    assert.deepEqual(validateForm(edit(f, { "st.check": "gaze", "st.target": "eyes_closed" }), ctx()).errors, {});
    assert.match(validateForm(withValue(f, "st.check", "blink"), ctx()).errors["st.check"], /repeat, gaze, action, spend/);
  });

  it("none: nothing to validate", () => {
    assert.deepEqual(validateForm(withValue(empty(), "st.level", "x"), ctx()), { errors: {}, warnings: [] });
  });
});

describe("diffForm", () => {
  const interestFields = { "st.kind": "interest", "st.topic": "a", "st.level": 1, "st.need": 3, "st.requires": "b:0" };

  it("is a no-op for an unchanged form", () => {
    for (const fields of [
      {},
      interestFields,
      { "st.kind": "Interest", "st.topic": " a ", "st.level": "1", "st.need": "3" },
      { "st.kind": "trigger", "st.trigger": "x", "st.trigger_role": "Installed" },
      { "st.kind": "policy", "st.policy": "prompts, attention", "st.track_min": "0.5", "st.hold_min_ms": 200 },
      { "st.kind": "prompt", "st.check": "gaze", "st.target": "eyes" },
      { "st.kind": "auto-marker" },
    ]) {
      assert.deepEqual(diffForm(fields, formFromFields(fields)), { set: {}, remove: [] }, JSON.stringify(fields));
    }
  });

  it("configures a new interest tag, numbers as numbers, strings trimmed", () => {
    const f = edit(withKind(empty(), "interest"), { "st.topic": "  fixation ", "st.level": " 2 ", "st.need": "3", "st.requires": " a:1 " });
    assert.deepEqual(diffForm({ other: "x" }, f), {
      set: { "st.kind": "interest", "st.topic": "fixation", "st.level": 2, "st.need": 3, "st.requires": "a:1" },
      remove: [],
    });
  });

  it("writes only changed keys", () => {
    const f = withValue(formFromFields(interestFields), "st.level", "2");
    assert.deepEqual(diffForm(interestFields, f), { set: { "st.level": 2 }, remove: [] });
  });

  it("removes optional fields left empty", () => {
    const f = edit(formFromFields(interestFields), { "st.need": " ", "st.requires": "" });
    assert.deepEqual(diffForm(interestFields, f), { set: {}, remove: ["st.need", "st.requires"] });
  });

  it("switching interest -> trigger removes the interest keys", () => {
    const f = edit(withKind(formFromFields(interestFields), "trigger"), { "st.trigger": "x", "st.trigger_role": "used" });
    assert.deepEqual(diffForm(interestFields, f), {
      set: { "st.kind": "trigger", "st.trigger": "x", "st.trigger_role": "used" },
      remove: ["st.topic", "st.level", "st.need", "st.requires"],
    });
  });

  it("switching to none removes every config key but keeps player and other keys", () => {
    const fields = { ...interestFields, "st.paid": 80, "st.unlocked_at": "2026-01-01", "st.custom": "keep", rating: 5 };
    const change = diffForm(fields, withKind(formFromFields(fields), "none"));
    assert.deepEqual(change, { set: {}, remove: ["st.kind", "st.topic", "st.level", "st.need", "st.requires"] });
  });

  it("never touches non-config keys", () => {
    const fields = { "st.paid": 1, "st.unlocked_at": "x", "st.future": 1, color: "red" };
    const f = edit(withKind(formFromFields(fields), "interest"), { "st.topic": "a", "st.level": "0" });
    const change = diffForm(fields, f);
    for (const k of Object.keys(fields)) {
      assert.ok(!(k in change.set) && !change.remove.includes(k), k);
    }
  });

  it("prompt: switching check drops the target", () => {
    const fields = { "st.kind": "prompt", "st.check": "gaze", "st.target": "eyes" };
    assert.deepEqual(diffForm(fields, withValue(formFromFields(fields), "st.check", "repeat")), {
      set: { "st.check": "repeat" },
      remove: ["st.target"],
    });
    assert.deepEqual(diffForm(fields, edit(formFromFields(fields), { "st.check": "action", "st.action": "nod" })), {
      set: { "st.check": "action", "st.action": "nod" },
      remove: ["st.target"],
    });
  });

  it("policy: writes the canonical rule list and numbers", () => {
    const f = edit(withKind(empty(), "policy"), { "st.policy": "track, Attention", "st.track_min": "0,75", "st.hold_min_ms": "250" });
    assert.deepEqual(diffForm({}, f), {
      set: { "st.kind": "policy", "st.policy": "attention,track", "st.track_min": 0.75, "st.hold_min_ms": 250 },
      remove: [],
    });
  });

  it("rewrites a numeric string only when the number changes", () => {
    const fields = { "st.kind": "interest", "st.topic": "a", "st.level": "1" };
    assert.deepEqual(diffForm(fields, withValue(formFromFields(fields), "st.level", "1.0")), { set: {}, remove: [] });
    assert.deepEqual(diffForm(fields, withValue(formFromFields(fields), "st.level", "4")), { set: { "st.level": 4 }, remove: [] });
  });

  it("leaves unparseable numbers alone", () => {
    const fields = { "st.kind": "interest", "st.topic": "a", "st.level": 1 };
    assert.deepEqual(diffForm(fields, withValue(formFromFields(fields), "st.level", "two")), { set: {}, remove: [] });
  });

  it("removes stray config keys of another kind and an unknown kind", () => {
    const fields = { "st.kind": "trigger", "st.trigger": "x", "st.trigger_role": "used", "st.topic": "old" };
    assert.deepEqual(diffForm(fields, formFromFields(fields)), { set: {}, remove: ["st.topic"] });
    assert.deepEqual(diffForm({ "st.kind": "intrest" }, formFromFields({ "st.kind": "intrest" })), { set: {}, remove: ["st.kind"] });
  });

  it("never sets and removes the same key", () => {
    const fields = { ...interestFields, "st.trigger": "x" };
    for (const kind of ["none", "interest", "trigger", "policy", "prompt"] as const) {
      const change = diffForm(fields, withKind(formFromFields(fields), kind));
      for (const k of change.remove) assert.ok(!(k in change.set), `${kind}: ${k}`);
    }
  });
});

describe("display helpers", () => {
  it("readOnlyFields lists player keys first, then unknown st.* keys", () => {
    assert.deepEqual(
      readOnlyFields({ "st.zeta": true, "st.unlocked_at": "2026-01-01", "st.kind": "interest", "st.paid": 80, rating: 1 }),
      [
        { key: "st.paid", value: "80", player: true },
        { key: "st.unlocked_at", value: "2026-01-01", player: true },
        { key: "st.zeta", value: "true", player: false },
      ],
    );
  });

  it("describeChange shows old and new values", () => {
    const fields = { "st.level": 1, "st.need": 3 };
    assert.deepEqual(describeChange(fields, { set: { "st.level": 2, "st.kind": "interest" }, remove: ["st.need"] }), [
      "st.level: 1 → 2",
      "st.kind = interest",
      "remove st.need (3)",
    ]);
  });

  it("opensAfter describes the previous level plus st.requires", () => {
    const f = (values: Record<string, string>) => edit(withKind(empty(), "interest"), values);
    assert.equal(opensAfter(f({ "st.topic": "a", "st.level": "0" })), "nothing (entry level)");
    assert.equal(opensAfter(f({ "st.topic": "a", "st.level": "0", "st.requires": "$80" })), "pay 80");
    assert.equal(opensAfter(f({ "st.topic": "A", "st.level": "2" })), "a L1");
    assert.equal(
      opensAfter(f({ "st.topic": "fixation", "st.level": "3", "st.requires": "relaxation:1,deepening:2|fixation:2" })),
      "fixation L2 and relaxation L1 and (deepening L2 or fixation L2)",
    );
    assert.equal(opensAfter(f({ "st.topic": "a", "st.level": "x", "st.requires": "b:1|$5" })), "b L1 or pay 5");
  });

  it("tagSummary per kind", () => {
    assert.deepEqual(tagSummary({}), {});
    assert.deepEqual(tagSummary({ "st.kind": "Interest", "st.topic": "Fixation", "st.level": "2" }), { kind: "interest", detail: "fixation:2" });
    assert.deepEqual(tagSummary({ "st.kind": "interest", "st.topic": "a" }), { kind: "interest", detail: "incomplete" });
    assert.deepEqual(tagSummary({ "st.kind": "trigger", "st.trigger": "x", "st.trigger_role": "Used" }), { kind: "trigger", detail: "x · used" });
    assert.deepEqual(tagSummary({ "st.kind": "policy", "st.policy": "attention, prompts" }), { kind: "policy", detail: "attention,prompts" });
    assert.deepEqual(tagSummary({ "st.kind": "prompt", "st.check": "gaze", "st.target": "eyes" }), { kind: "prompt", detail: "gaze eyes" });
    assert.deepEqual(tagSummary({ "st.kind": "auto-marker" }), { kind: "auto-marker" });
  });

  it("toggleListToken keeps the canonical order", () => {
    assert.equal(toggleListToken("track", "attention", true), "attention,track");
    assert.equal(toggleListToken("attention,track", "attention", false), "track");
    assert.equal(toggleListToken("", "prompts", true), "prompts");
  });
});

describe("tag list", () => {
  const tags = [
    tag("1", "Fixation deep", { "st.kind": "interest" }),
    tag("2", "Spiral", {}, { aliases: ["Hypno swirl"] }),
    tag("3", "Other", { "st.kind": " " }),
  ];

  it("filters by name or alias, case-insensitive", () => {
    assert.deepEqual(filterTags(tags, "SWIRL", "all").map((t) => t.id), ["2"]);
    assert.deepEqual(filterTags(tags, "  fix ", "all").map((t) => t.id), ["1"]);
    assert.deepEqual(filterTags(tags, "", "all").map((t) => t.id), ["1", "2", "3"]);
  });

  it("configured means a non-blank st.kind", () => {
    assert.deepEqual(filterTags(tags, "", "configured").map((t) => t.id), ["1"]);
  });

  it("setupContext collects levels per normalised topic, optionally without one tag", () => {
    const all = [
      tag("1", "a0", { "st.kind": "interest", "st.topic": "A", "st.level": 0 }),
      tag("2", "a2", { "st.kind": "interest", "st.topic": "a ", "st.level": "2" }),
      tag("3", "b0", { "st.kind": "interest", "st.topic": "b", "st.level": "0" }),
      tag("4", "bad", { "st.kind": "interest", "st.topic": "c", "st.level": "x" }),
      tag("5", "trigger", { "st.kind": "trigger", "st.topic": "d", "st.level": 0 }),
    ];
    assert.deepEqual([...setupContext(all).levels], [["a", [0, 2]], ["b", [0]]]);
    assert.deepEqual([...setupContext(all, "3").levels], [["a", [0, 2]]]);
  });
});

describe("gaze targets", () => {
  it("match the plugin's list, each with help (eyes_closed: tracker or webcam)", async () => {
    const prompts = await import("../../src/prompts/types.ts");
    assert.deepEqual([...GAZE_TARGETS], [...prompts.GAZE_TARGETS]);
    for (const t of GAZE_TARGETS) assert.ok(GAZE_TARGET_HELP[t], t);
    assert.equal(GAZE_TARGET_HELP.eyes_closed, "the viewer keeps the eyes closed (eye tracker or webcam)");
  });
});
