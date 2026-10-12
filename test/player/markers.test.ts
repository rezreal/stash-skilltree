import { test } from "node:test";
import assert from "node:assert/strict";
import type { MarkerInput } from "../../src/core/types.ts";
import {
  DEFAULT_WINDOW_SEC,
  activeMarker,
  markerWindow,
  missedSpends,
  pendingSpend,
  spendPrompts,
  spentInSession,
} from "../../src/player/markers.ts";

const m = (id: string, seconds: number, extra: Partial<MarkerInput> = {}): MarkerInput => ({
  id,
  title: "",
  seconds,
  ...extra,
});

test("markerWindow uses end_seconds or a default length", () => {
  assert.deepEqual(markerWindow(m("a", 10, { endSeconds: 18 })), { start: 10, end: 18 });
  assert.deepEqual(markerWindow(m("a", 10)), { start: 10, end: 10 + DEFAULT_WINDOW_SEC });
  // an end before the start is ignored
  assert.deepEqual(markerWindow(m("a", 10, { endSeconds: 5 }), 4), { start: 10, end: 14 });
});

test("activeMarker finds the marker whose window contains t (half-open)", () => {
  const markers = [
    m("gaze", 10, { endSeconds: 20, check: "gaze" }),
    m("spend", 15, { endSeconds: 25, check: "spend", title: "50" }),
    m("plain", 0, { endSeconds: 100 }),
  ];
  assert.equal(activeMarker(markers, 5), undefined, "plain markers are not prompts");
  assert.equal(activeMarker(markers, 10)?.id, "gaze");
  assert.equal(activeMarker(markers, 16)?.id, "gaze", "earliest start wins");
  assert.equal(activeMarker(markers, 16, "spend")?.id, "spend");
  assert.equal(activeMarker(markers, 20)?.id, "spend", "end is exclusive");
  assert.equal(activeMarker(markers, 25), undefined);
  assert.equal(activeMarker(markers, 50, undefined), undefined);
});

test("spendPrompts parses amounts and skips unreadable ones", () => {
  const prompts = spendPrompts([
    m("b", 30, { check: "spend", title: "pay 80 coins" }),
    m("a", 10, { check: "spend", title: "$50", endSeconds: 14 }),
    m("c", 40, { check: "spend", title: "no amount" }),
    m("d", 50, { check: "gaze", title: "20" }),
  ]);
  assert.deepEqual(
    prompts.map((p) => [p.marker.id, p.amount, p.window.start, p.window.end]),
    [
      ["a", 50, 10, 14],
      ["b", 80, 30, 30 + DEFAULT_WINDOW_SEC],
    ],
  );
});

test("pendingSpend and missedSpends respect decisions", () => {
  const prompts = spendPrompts([
    m("a", 10, { check: "spend", title: "50", endSeconds: 14 }),
    m("b", 30, { check: "spend", title: "20", endSeconds: 35 }),
  ]);
  assert.equal(pendingSpend(prompts, [], 9), undefined);
  assert.equal(pendingSpend(prompts, [], 12)?.marker.id, "a");
  const decided = [{ markerId: "a", amount: 50, at: 12, accepted: true }];
  assert.equal(pendingSpend(prompts, decided, 12), undefined);
  assert.deepEqual(missedSpends(prompts, [], 13), []);
  assert.deepEqual(missedSpends(prompts, [], 14).map((p) => p.marker.id), ["a"]);
  // seeking over both: both are missed unless decided
  assert.deepEqual(missedSpends(prompts, decided, 60).map((p) => p.marker.id), ["b"]);
});

test("spentInSession counts accepted spends only", () => {
  assert.equal(
    spentInSession([
      { markerId: "a", amount: 50, at: 1, accepted: true },
      { markerId: "b", amount: 20, at: 2, accepted: false },
      { markerId: "c", amount: 5, at: 3, accepted: true },
    ]),
    55,
  );
});
