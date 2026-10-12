import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { interest, library, performer, scene, spendMarker } from "../core/fixtures.ts";
import { buildGraph, computeProgress, computeVisibility, triggerEdges } from "../../src/core/index.ts";
import type { Id, LibraryInput, SceneInput, SeriesInput, SeriesReset } from "../../src/core/types.ts";
import { computeLedger, computeStreak } from "../../src/play/economy.ts";
import {
  blockedSeriesScenes,
  dayLabel,
  dayStartDate,
  localDayOf,
  normalizeDayStartHour,
  orderedParts,
  seriesByScene,
  seriesForScene,
  seriesStatus,
} from "../../src/play/series.ts";
import { dailySeriesCards, suggest } from "../../src/play/suggest.ts";

/** ISO string of a local date/time in May 2024. */
const may = (d: number, h = 12, min = 0) => new Date(2024, 4, d, h, min).toISOString();
/** "now": 10 May 2024, 20:00 local */
const NOW = new Date(2024, 4, 10, 20);

/** Series g of `n` parts p1..pn (scene_index 1..n); `days` = completion day in May per part (undefined = never). */
function setup(days: (number | string | undefined)[], reset: SeriesReset = "start", n = days.length) {
  const scenes = new Map<Id, SceneInput>();
  const parts = [];
  for (let i = 0; i < n; i++) {
    const d = days[i];
    const completedAt = typeof d === "number" ? may(d) : d;
    scenes.set(`p${i + 1}`, scene(`p${i + 1}`, [], completedAt ? { completedAt } : {}));
    parts.push({ sceneId: `p${i + 1}`, index: i + 1 });
  }
  const series: SeriesInput = { groupId: "g", name: "Daily", mode: "daily", reset, parts };
  return { series, scenes };
}

const status = (days: (number | string | undefined)[], reset: SeriesReset = "start", n?: number, now = NOW, h = 4) => {
  const { series, scenes } = setup(days, reset, n);
  return seriesStatus(series, scenes, now, h);
};

describe("days", () => {
  it("a day starts at dayStartHour: 02:30 belongs to the previous day", () => {
    const d10 = localDayOf(new Date(2024, 4, 10, 12), 0)!;
    assert.equal(localDayOf(new Date(2024, 4, 10, 2, 30), 4), d10 - 1);
    assert.equal(localDayOf(new Date(2024, 4, 10, 2, 30), 0), d10);
    assert.equal(localDayOf(new Date(2024, 4, 10, 4, 0), 4), d10);
    assert.equal(localDayOf(new Date(2024, 4, 10, 3, 59), 4), d10 - 1);
    assert.equal(localDayOf(new Date("nope")), undefined);
    assert.equal(dayLabel(d10), "2024-05-10");
  });

  it("dayStartDate is the local boundary; the hour is clamped to 0–23 with default 4", () => {
    const d10 = localDayOf(new Date(2024, 4, 10, 12))!;
    assert.equal(dayStartDate(d10 + 1, 4).getTime(), new Date(2024, 4, 11, 4).getTime());
    assert.equal(dayStartDate(d10, 0).getTime(), new Date(2024, 4, 10, 0).getTime());
    assert.deepEqual([undefined, "3", -1, 24, 7.9, 0, 23].map(normalizeDayStartHour), [4, 4, 4, 4, 7, 0, 23]);
  });

  it("computeStreak uses the same day boundary", () => {
    const lib = library({
      scenes: [
        scene("a", [], { completedAt: may(10, 2, 30) }), // counts for 9 May
        scene("b", [], { completedAt: may(8, 23) }),
      ],
    });
    assert.deepEqual(computeStreak(lib, NOW), { days: 2, bonus: 1, activeToday: false });
    assert.deepEqual(computeStreak(lib, NOW, { dayStartHour: 0 }), { days: 1, bonus: 1, activeToday: true });
  });
});

describe("orderedParts", () => {
  it("orders by scene_index, missing indices last, ties by date then id", () => {
    const scenes = new Map<Id, SceneInput>([
      ["a", scene("a", [], { date: "2024-03-01" })],
      ["b", scene("b", [], { date: "2024-01-01" })],
      ["c", scene("c", [], { date: undefined })],
      ["10", scene("10", [], { date: undefined })],
      ["9", scene("9", [], { date: undefined })],
      ["x", scene("x", [], { date: "2020-01-01" })],
    ]);
    const series: SeriesInput = {
      groupId: "g",
      name: "S",
      mode: "daily",
      reset: "start",
      parts: [
        { sceneId: "10" },
        { sceneId: "a", index: 5 },
        { sceneId: "c", index: 2 },
        { sceneId: "b", index: 2 },
        { sceneId: "9" },
        { sceneId: "x" },
      ],
    };
    assert.deepEqual(
      orderedParts(series, scenes).map((p) => p.sceneId),
      ["b", "c", "a", "x", "9", "10"],
    );
  });

  it("status follows the order, not the stored part order", () => {
    const { series, scenes } = setup([9, 10, undefined]);
    // stored backwards with indices 3, 2, 1: p3 is part 1
    series.parts = [
      { sceneId: "p1", index: 3 },
      { sceneId: "p2", index: 2 },
      { sceneId: "p3", index: 1 },
    ];
    const s = seriesStatus(series, scenes, NOW, 4);
    assert.deepEqual(s, { state: "not-started", run: 0, nextPart: { sceneId: "p3", index: 1, number: 1 } });
  });
});

describe("seriesStatus, reset=start", () => {
  it("not started: part 1 any day, no deadline", () => {
    assert.deepEqual(status([undefined, undefined]), {
      state: "not-started",
      run: 0,
      nextPart: { sceneId: "p1", index: 1, number: 1 },
    });
    // later parts watched elsewhere don't start the run
    assert.equal(status([undefined, 10, 9]).state, "not-started");
  });

  it("chain ending today: done for today, next part unlocks tomorrow", () => {
    assert.deepEqual(status([8, 9, 10, undefined, undefined]), {
      state: "done-today",
      run: 3,
      lastDay: "2024-05-10",
      nextPart: { sceneId: "p4", index: 4, number: 4 },
    });
  });

  it("chain ending yesterday: due today with the next day boundary as deadline", () => {
    assert.deepEqual(status([7, 8, 9, undefined]), {
      state: "due",
      run: 3,
      lastDay: "2024-05-09",
      deadline: new Date(2024, 4, 11, 4).toISOString(),
      nextPart: { sceneId: "p4", index: 4, number: 4 },
    });
  });

  it("chain ending before yesterday: broken, starts again at part 1", () => {
    assert.deepEqual(status([6, 7, 8, undefined]), {
      state: "broken",
      run: 0,
      lastDay: "2024-05-08",
      nextPart: { sceneId: "p1", index: 1, number: 1 },
    });
  });

  it("a gap or a same-day repeat ends the chain", () => {
    assert.deepEqual(status([8, 9, 6, 7, 8]), {
      state: "due",
      run: 2,
      lastDay: "2024-05-09",
      deadline: new Date(2024, 4, 11, 4).toISOString(),
      nextPart: { sceneId: "p3", index: 3, number: 3 },
    });
    const sameDay = status([9, 9, 10]);
    assert.equal(sameDay.state, "due");
    assert.equal(sameDay.run, 1);
  });

  it("rewatching part 1 after a break restarts the run; old dates later in the series don't count", () => {
    // old run 1..4 on 1–4 May, part 1 again today
    assert.deepEqual(status([10, 2, 3, 4, undefined]), {
      state: "done-today",
      run: 1,
      lastDay: "2024-05-10",
      nextPart: { sceneId: "p2", index: 2, number: 2 },
    });
    // part 1 yesterday, part 2 today, part 3 still from the old run
    const s = status([9, 10, 3, 4, undefined]);
    assert.equal(s.state, "done-today");
    assert.equal(s.run, 2);
    assert.equal(s.nextPart?.number, 3);
    // part 3 from the old run is older than part 2: the chain stops at 2
    const t = status([8, 9, 1, undefined]);
    assert.equal(t.state, "due");
    assert.equal(t.run, 2);
  });

  it("mixed dates: a newer part 1 than part 2 ends the chain at part 1", () => {
    const s = status([10, 9]);
    assert.equal(s.state, "done-today");
    assert.equal(s.run, 1);
  });

  it("day boundary: 02:30 counts for the previous day", () => {
    // part 1 at 02:30 today counts as yesterday -> part 2 due
    const due = status([may(10, 2, 30), undefined]);
    assert.equal(due.state, "due");
    assert.equal(due.lastDay, "2024-05-09");
    // part 1 at 02:30 and part 2 at 23:30 on the same calendar day are consecutive days
    const two = status([may(10, 2, 30), may(10, 23, 30), undefined], "start", 3, new Date(2024, 4, 10, 23, 45));
    assert.equal(two.state, "done-today");
    assert.equal(two.run, 2);
    // with midnight as boundary they are the same day
    const midnight = status([may(10, 2, 30), may(10, 23, 30), undefined], "start", 3, new Date(2024, 4, 10, 23, 45), 0);
    assert.equal(midnight.state, "done-today");
    assert.equal(midnight.run, 1);
    // at 02:00 on 11 May it is still the 10th: done for today, not due
    const late = status([9, 10, undefined], "start", 3, new Date(2024, 4, 11, 2));
    assert.equal(late.state, "done-today");
    // deadline of a due series at 02:00 is 04:00 the same calendar day
    const lateDue = status([9, undefined], "start", 2, new Date(2024, 4, 11, 2));
    assert.equal(lateDue.state, "due");
    assert.equal(lateDue.deadline, new Date(2024, 4, 11, 4).toISOString());
  });

  it("finished: every part in one unbroken run, also long ago", () => {
    assert.deepEqual(status([8, 9, 10]), { state: "finished", run: 3, lastDay: "2024-05-10" });
    assert.deepEqual(status([1, 2, 3]), { state: "finished", run: 3, lastDay: "2024-05-03" });
  });

  it("ignores completions after now", () => {
    assert.equal(status([11, undefined]).state, "not-started");
    const s = status([9, 11, undefined]);
    assert.equal(s.state, "due");
    assert.equal(s.run, 1);
  });

  it("parts whose scene is not loaded count as not completed", () => {
    const { series, scenes } = setup([9, 10, undefined]);
    scenes.delete("p2");
    const s = seriesStatus(series, scenes, NOW, 4);
    assert.equal(s.state, "due");
    assert.equal(s.nextPart?.sceneId, "p2");
  });
});

describe("seriesStatus, reset=step_back", () => {
  it("behaves like start while the run is unbroken", () => {
    assert.equal(status([8, 9, 10, undefined], "step_back").state, "done-today");
    const due = status([8, 9, undefined], "step_back");
    assert.equal(due.state, "due");
    assert.equal(due.run, 2);
    assert.deepEqual(status([undefined, undefined], "step_back").state, "not-started");
    assert.deepEqual(status([8, 9, 10], "step_back"), { state: "finished", run: 3, lastDay: "2024-05-10" });
  });

  it("each missed day steps back one part", () => {
    // run of 5 ending 7 May; 8 and 9 May missed -> 3, part 4 next
    assert.deepEqual(status([3, 4, 5, 6, 7, undefined], "step_back"), {
      state: "broken",
      run: 3,
      lastDay: "2024-05-07",
      nextPart: { sceneId: "p4", index: 4, number: 4 },
    });
    // one missed day (9 May) -> 4
    assert.equal(status([4, 5, 6, 7, 8, undefined], "step_back").run, 4);
    // never below 0
    assert.deepEqual(status([1, 2, undefined], "step_back"), {
      state: "broken",
      run: 0,
      lastDay: "2024-05-02",
      nextPart: { sceneId: "p1", index: 1, number: 1 },
    });
  });

  it("continuing after a step back overwrites dates and still derives the run", () => {
    // 1..5 on 1–5 May, 6 and 7 missed (-> 3), part 4 again on 8 May
    const day8 = status([1, 2, 3, 8, 5, undefined], "step_back", 6, new Date(2024, 4, 8, 20));
    assert.equal(day8.state, "done-today");
    assert.equal(day8.run, 4);
    assert.equal(day8.nextPart?.number, 5);
    // next day it is due
    const day9 = status([1, 2, 3, 8, 5, undefined], "step_back", 6, new Date(2024, 4, 9, 20));
    assert.equal(day9.state, "due");
    assert.equal(day9.run, 4);
    // part 5 on 9 May, part 6 on 10 May: finished
    assert.equal(status([1, 2, 3, 8, 9, 10], "step_back").state, "finished");
    // part 5 on 9 May, then 10 and 11 May missed: back to 3 on the 12th
    const day12 = status([1, 2, 3, 8, 9, undefined], "step_back", 6, new Date(2024, 4, 12, 20));
    assert.equal(day12.state, "broken");
    assert.equal(day12.run, 3);
    assert.equal(day12.nextPart?.sceneId, "p4");
  });

  it("decayed to 0 and started again from part 1", () => {
    const s = status([10, 2, undefined], "step_back");
    assert.equal(s.state, "done-today");
    assert.equal(s.run, 1);
    assert.equal(s.nextPart?.number, 2);
  });

  it("a part watched out of order is ignored and its day counts as missed", () => {
    // part 1 on 8 May, part 3 (never part 2) on 9 May: 9 May was a missed day
    const s = status([8, undefined, 9, undefined], "step_back");
    assert.equal(s.state, "broken");
    assert.equal(s.run, 0);
    assert.equal(s.nextPart?.number, 1);
    // without part 1 nothing has started
    assert.equal(status([undefined, 9, 10], "step_back").state, "not-started");
  });
});

describe("series lookups", () => {
  it("finds the series of a scene", () => {
    const a: SeriesInput = { groupId: "a", name: "A", mode: "daily", reset: "start", parts: [{ sceneId: "1" }, { sceneId: "2" }] };
    const b: SeriesInput = { groupId: "b", name: "B", mode: "daily", reset: "start", parts: [{ sceneId: "2" }] };
    assert.deepEqual(seriesForScene([a, b], "2"), [a, b]);
    assert.deepEqual(seriesForScene([a, b], "3"), []);
    const map = seriesByScene([a, b]);
    assert.deepEqual(map.get("1"), [a]);
    assert.deepEqual(map.get("2"), [a, b]);
  });

  it("blocks every part except the next one of a series that is not done today", () => {
    const due = setup([9, undefined, undefined]);
    assert.deepEqual([...blockedSeriesScenes([due.series], due.scenes, NOW, 4)].sort(), ["p1", "p3"]);
    const doneToday = setup([9, 10, undefined]);
    assert.deepEqual([...blockedSeriesScenes([doneToday.series], doneToday.scenes, NOW, 4)].sort(), ["p1", "p2", "p3"]);
    const finished = setup([9, 10]);
    assert.deepEqual([...blockedSeriesScenes([finished.series], finished.scenes, NOW, 4)].sort(), ["p1", "p2"]);
  });
});

// --- suggestions ----------------------------------------------------------------------------

/** A tree with one open node whose scenes s1..s3 are also parts 1..3 of a daily series. */
function seriesLibrary(days: (number | undefined)[], extra: Partial<LibraryInput> = {}): LibraryInput {
  const scenes = days.map((d, i) =>
    scene(`s${i + 1}`, ["t0"], { performerIds: ["P"], date: `2024-01-0${i + 1}`, ...(d ? { completedAt: may(d), completions: 1 } : {}) }),
  );
  return library({
    performers: [performer("P")],
    interestTags: [interest("t0", "relax", 0, { need: 9 })],
    scenes: [...scenes, scene("other", ["t0"], { performerIds: ["P"], date: "2024-02-01" })],
    series: [
      {
        groupId: "g",
        name: "Daily",
        mode: "daily",
        reset: "start",
        parts: days.map((_, i) => ({ sceneId: `s${i + 1}`, index: i + 1 })),
      },
    ],
    ...extra,
  });
}

function suggestFor(lib: LibraryInput) {
  const graph = buildGraph(lib);
  const progress = computeProgress(graph);
  return suggest({
    graph,
    progress,
    visibility: computeVisibility(graph, progress),
    library: lib,
    policyTags: [],
    ledger: computeLedger(lib),
    streak: { days: 0, bonus: 1, activeToday: false },
    edges: triggerEdges(lib),
    performerId: "P",
    max: 5,
    now: NOW,
    dayStartHour: 4,
  });
}

const suggested = (lib: LibraryInput) => suggestFor(lib).options.map((o) => o.sceneId);

describe("suggestions and daily series", () => {
  it("only the next part of a series that is not done today is suggested", () => {
    // not started: part 1 may come up, parts 2 and 3 not
    let ids = suggested(seriesLibrary([undefined, undefined, undefined]));
    assert.ok(ids.includes("s1"));
    assert.ok(!ids.includes("s2") && !ids.includes("s3"));
    // due: part 2 is next
    ids = suggested(seriesLibrary([9, undefined, undefined]));
    assert.ok(ids.includes("s2"));
    assert.ok(!ids.includes("s3"));
    // done today: nothing of the series, even as a repeat earn clip
    ids = suggested(seriesLibrary([9, 10, undefined]));
    assert.ok(!ids.some((id) => id.startsWith("s")));
    assert.ok(ids.includes("other"));
  });

  it("dailySeriesCards: one card per unfinished series, due first, with affordability", () => {
    const lib = seriesLibrary([9, undefined, undefined]);
    lib.scenes.push(scene("q1", [], { markers: [spendMarker("m", "50")] }), scene("q2", []));
    lib.scenes.push(scene("z1", [], { completedAt: may(9) }), scene("z2", [], { completedAt: may(10) }));
    lib.series.push(
      { groupId: "q", name: "Another", mode: "daily", reset: "start", parts: [{ sceneId: "q1" }, { sceneId: "q2" }] },
      { groupId: "z", name: "Done", mode: "daily", reset: "start", parts: [{ sceneId: "z1" }, { sceneId: "z2" }] },
    );
    const cards = dailySeriesCards({ library: lib, ledger: { earned: 30, spent: 0, paid: 0, balance: 30, entries: [] }, now: NOW });
    assert.deepEqual(
      cards.map((c) => [c.series.groupId, c.status.state, c.status.nextPart?.sceneId, c.spendCost, c.affordable]),
      [
        ["g", "due", "s2", 0, true],
        ["q", "not-started", "q1", 50, false],
      ],
    );
    assert.deepEqual(dailySeriesCards({ library: library(), ledger: computeLedger(library()), now: NOW }), []);
  });
});
