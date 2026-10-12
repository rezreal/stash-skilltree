import { test } from "node:test";
import assert from "node:assert/strict";
import type { MarkerInput } from "../../src/core/types.ts";
import { mergeIntervals, timelineDots, timelineSegments } from "../../src/player/timeline.ts";

test("mergeIntervals sorts, clips and merges touching intervals", () => {
  assert.deepEqual(
    mergeIntervals(
      [
        { start: 50, end: 60 },
        { start: -5, end: 10 },
        { start: 10, end: 20 },
        { start: 15, end: 18 },
        { start: 90, end: 120 },
        { start: 30, end: 30 },
      ],
      100,
    ),
    [
      { start: 0, end: 20 },
      { start: 50, end: 60 },
      { start: 90, end: 100 },
    ],
  );
});

test("timelineSegments: attended plus missed gaps up to the furthest point", () => {
  const segs = timelineSegments(
    [
      { start: 0, end: 20 },
      { start: 25, end: 40 },
    ],
    100,
    50,
  );
  assert.deepEqual(
    segs.map((s) => [s.kind, s.start, s.end]),
    [
      ["attended", 0, 20],
      ["missed", 20, 25],
      ["attended", 25, 40],
      ["missed", 40, 50],
    ],
  );
  assert.equal(segs[1].left, 20);
  assert.equal(segs[1].width, 5);
});

test("timelineSegments: leading gap, tiny gaps dropped, nothing after upTo", () => {
  const segs = timelineSegments(
    [
      { start: 10, end: 20 },
      { start: 20.1, end: 30 },
    ],
    200,
    30,
  );
  assert.deepEqual(
    segs.map((s) => [s.kind, s.start, s.end]),
    [
      ["missed", 0, 10],
      ["attended", 10, 20],
      ["attended", 20.1, 30],
    ],
  );
  assert.deepEqual(timelineSegments([], 0, 10), []);
  assert.deepEqual(
    timelineSegments([], 100, 10).map((s) => [s.kind, s.start, s.end]),
    [["missed", 0, 10]],
  );
});

test("timelineDots: state per prompt and spend marker", () => {
  const markers: MarkerInput[] = [
    { id: "p1", title: "Say it", seconds: 10, endSeconds: 15, check: "repeat" },
    { id: "p2", title: "", seconds: 20, endSeconds: 25, check: "gaze" },
    { id: "p3", title: "Look", seconds: 40, endSeconds: 45, check: "gaze" },
    { id: "s1", title: "50", seconds: 30, endSeconds: 35, check: "spend" },
    { id: "s2", title: "20", seconds: 60, endSeconds: 65, check: "spend" },
    { id: "x", title: "chapter", seconds: 5 },
  ];
  const dots = timelineDots(
    markers,
    [
      { markerId: "p1", passed: true },
      { markerId: "p2", passed: false },
    ],
    [{ markerId: "s1", amount: 50, at: 31, accepted: true }],
    42,
    100,
  );
  assert.deepEqual(
    dots.map((d) => [d.markerId, d.kind, d.state, d.left]),
    [
      ["p1", "prompt", "passed", 10],
      ["p2", "prompt", "failed", 20],
      ["s1", "spend", "accepted", 30],
      ["p3", "prompt", "active", 40],
      ["s2", "spend", "upcoming", 60],
    ],
  );
  assert.equal(dots[1].title, "gaze", "empty titles fall back to the check");
});
