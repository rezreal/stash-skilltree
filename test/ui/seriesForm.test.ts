import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SetupGroup } from "../../src/stash/groups.ts";
import { describeChange } from "../../src/ui/setupForm.ts";
import {
  SERIES_KEYS,
  diffSeriesForm,
  filterGroups,
  sameSeriesForm,
  seriesFormFromFields,
  seriesSummary,
  seriesWarnings,
} from "../../src/ui/seriesForm.ts";

const group = (id: string, name: string, customFields: Record<string, unknown> = {}, sceneCount = 3): SetupGroup => ({
  id,
  name,
  sceneCount,
  customFields,
});

describe("seriesFormFromFields", () => {
  it("reads daily and the reset mode leniently", () => {
    assert.deepEqual(seriesFormFromFields({}), { daily: false, reset: "start" });
    assert.deepEqual(seriesFormFromFields(null), { daily: false, reset: "start" });
    assert.deepEqual(seriesFormFromFields({ "st.series": " Daily ", "st.reset": "STEP_BACK" }), { daily: true, reset: "step_back" });
    assert.deepEqual(seriesFormFromFields({ "st.series": "weekly", "st.reset": "never" }), { daily: false, reset: "start" });
    assert.ok(sameSeriesForm({ daily: true, reset: "start" }, { daily: true, reset: "start" }));
    assert.ok(!sameSeriesForm({ daily: true, reset: "start" }, { daily: true, reset: "step_back" }));
  });
});

describe("diffSeriesForm", () => {
  const empty = { set: {}, remove: [] };

  it("an unchanged form writes nothing", () => {
    for (const f of [{}, { "st.series": "daily" }, { "st.series": "daily", "st.reset": "step_back" }, { "st.series": "daily", "st.reset": "start" }]) {
      assert.deepEqual(diffSeriesForm(f, seriesFormFromFields(f)), empty);
    }
  });

  it("turning daily on writes st.series, and st.reset only for step_back", () => {
    assert.deepEqual(diffSeriesForm({ other: 1 }, { daily: true, reset: "start" }), { set: { "st.series": "daily" }, remove: [] });
    assert.deepEqual(diffSeriesForm({}, { daily: true, reset: "step_back" }), {
      set: { "st.series": "daily", "st.reset": "step_back" },
      remove: [],
    });
  });

  it("switching the reset mode", () => {
    const stepBack = { "st.series": "daily", "st.reset": "step_back" };
    assert.deepEqual(diffSeriesForm(stepBack, { daily: true, reset: "start" }), { set: {}, remove: ["st.reset"] });
    assert.deepEqual(diffSeriesForm({ "st.series": "daily" }, { daily: true, reset: "step_back" }), {
      set: { "st.reset": "step_back" },
      remove: [],
    });
    // an unknown stored reset is cleaned up when start is kept
    assert.deepEqual(diffSeriesForm({ "st.series": "daily", "st.reset": "never" }, { daily: true, reset: "start" }), {
      set: {},
      remove: ["st.reset"],
    });
  });

  it("turning daily off removes both keys; unknown st.series values are left alone", () => {
    assert.deepEqual(diffSeriesForm({ "st.series": "daily", "st.reset": "step_back", "st.x": 1 }, { daily: false, reset: "step_back" }), {
      set: {},
      remove: ["st.series", "st.reset"],
    });
    assert.deepEqual(diffSeriesForm({ "st.series": "daily" }, { daily: false, reset: "start" }), { set: {}, remove: ["st.series"] });
    assert.deepEqual(diffSeriesForm({ "st.series": "weekly", "st.reset": "start" }, { daily: false, reset: "start" }), empty);
    // turning an unknown value into daily replaces it
    assert.deepEqual(diffSeriesForm({ "st.series": "weekly" }, { daily: true, reset: "start" }), { set: { "st.series": "daily" }, remove: [] });
  });

  it("only ever touches st.series and st.reset", () => {
    const fields = { "st.series": "daily", "st.reset": "step_back", "st.kind": "interest", note: "x" };
    for (const daily of [true, false]) {
      for (const reset of ["start", "step_back"] as const) {
        const c = diffSeriesForm(fields, { daily, reset });
        for (const k of [...Object.keys(c.set), ...c.remove]) assert.ok((SERIES_KEYS as readonly string[]).includes(k), k);
      }
    }
  });

  it("describes the write like the tag editor", () => {
    const f = { "st.series": "daily", "st.reset": "step_back" };
    assert.deepEqual(describeChange(f, diffSeriesForm(f, { daily: false, reset: "start" })), [
      "remove st.series (daily)",
      "remove st.reset (step_back)",
    ]);
  });
});

describe("series list helpers", () => {
  it("summaries and warnings", () => {
    assert.equal(seriesSummary({}), undefined);
    assert.equal(seriesSummary({ "st.series": "daily" }), "daily");
    assert.equal(seriesSummary({ "st.series": "daily", "st.reset": "step_back" }), "daily · step back");
    assert.equal(seriesSummary({ "st.series": "weekly" }), "unknown");

    assert.deepEqual(seriesWarnings(group("1", "A", { "st.series": "daily" }), { daily: true, reset: "start" }), []);
    assert.deepEqual(seriesWarnings(group("1", "A", {}, 0), { daily: true, reset: "start" }), ["This group has no scenes yet"]);
    assert.deepEqual(seriesWarnings(group("1", "A", { "st.series": "Weekly", "st.reset": "never" }), { daily: false, reset: "start" }), [
      'st.series "Weekly" is unknown; turn on Daily series to replace it',
      'st.reset "never" is unknown and counts as "start"',
    ]);
  });

  it("filters by name and series", () => {
    const groups = [group("1", "Morning Routine", { "st.series": "daily" }), group("2", "Evening"), group("3", "morning extra")];
    assert.deepEqual(filterGroups(groups, "", "series").map((g) => g.id), ["1"]);
    assert.deepEqual(filterGroups(groups, " MORNING ", "all").map((g) => g.id), ["1", "3"]);
    assert.deepEqual(filterGroups(groups, "eve", "series"), []);
  });
});
