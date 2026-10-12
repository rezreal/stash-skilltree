import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dateLabel,
  formatCoins,
  formatCountdown,
  formatDuration,
  formatFactor,
  formatMinutes,
  formatPercent,
  formatSignedCoins,
  nodeLabel,
  plural,
  topicLabel,
} from "../../src/player/format.ts";

test("formatDuration pads minutes and seconds, adds hours when needed", () => {
  assert.equal(formatDuration(0), "00:00");
  assert.equal(formatDuration(754), "12:34");
  assert.equal(formatDuration(59.9), "00:59");
  assert.equal(formatDuration(3723), "1:02:03");
  assert.equal(formatDuration(-5), "00:00");
  assert.equal(formatDuration(Number.NaN), "00:00");
});

test("formatCountdown rounds up and has no leading zero", () => {
  assert.equal(formatCountdown(18), "0:18");
  assert.equal(formatCountdown(17.2), "0:18");
  assert.equal(formatCountdown(75), "1:15");
  assert.equal(formatCountdown(-1), "0:00");
});

test("formatMinutes rounds and shows at least 1 min for any time", () => {
  assert.equal(formatMinutes(0), "0 min");
  assert.equal(formatMinutes(10), "1 min");
  assert.equal(formatMinutes(1080), "18 min");
  assert.equal(formatMinutes(1110), "19 min");
});

test("coins are whole numbers with a real minus sign", () => {
  assert.equal(formatCoins(85), "85");
  assert.equal(formatCoins(12.6), "13");
  assert.equal(formatCoins(-50), "−50");
  assert.equal(formatSignedCoins(38), "+38");
  assert.equal(formatSignedCoins(-50), "−50");
  assert.equal(formatSignedCoins(0), "0");
});

test("factors and percents", () => {
  assert.equal(formatFactor(2), "×2");
  assert.equal(formatFactor(0.857), "×0.86");
  assert.equal(formatFactor(1.1), "×1.1");
  assert.equal(formatPercent(0.374), "37%");
  assert.equal(formatPercent(0.9), "90%");
});

test("labels", () => {
  assert.equal(topicLabel("deepening"), "Deepening");
  assert.equal(nodeLabel("deepening:2"), "Deepening L2");
  assert.equal(nodeLabel("weird"), "weird");
  assert.equal(dateLabel(undefined), "undated");
  assert.equal(dateLabel("2018-04-12"), "2018-04-12");
  assert.equal(plural(1, "open scene"), "1 open scene");
  assert.equal(plural(3, "open scene"), "3 open scenes");
});
