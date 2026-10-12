import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { combineAttention, presenceFromMonitor, presencePauseText, presenceReasonText } from "../../src/checks/attention.ts";
import { attentionWithPresence, presenceAdjuster, readingVerdict } from "../../src/checks/adjust.ts";
import type { AttentionReading } from "../../src/player/gazeView.ts";

const ok = { attending: true, reason: "watching" };
const away = { attending: false, reason: "look back at the video" };
const P = (reason: string, present = false) => ({ present, reason });

describe("combineAttention", () => {
  it("present: the base decides", () => {
    assert.deepEqual(combineAttention(ok, P("present", true), true), ok);
    assert.deepEqual(combineAttention(away, P("present", true), true), away);
  });

  it("absent person never attends, required or not, and explains a failing base", () => {
    for (const req of [true, false]) {
      assert.deepEqual(combineAttention(ok, P("absent"), req), { attending: false, reason: "not in front of the camera" });
      assert.deepEqual(combineAttention(away, P("absent"), req), { attending: false, reason: "not in front of the camera" });
    }
  });

  it("camera stalled blocks only when required", () => {
    assert.deepEqual(combineAttention(ok, P("no-frames"), true), { attending: false, reason: "camera stalled" });
    assert.deepEqual(combineAttention(ok, P("no-frames"), false), ok);
    // a failing base keeps its own reason
    assert.deepEqual(combineAttention(away, P("no-frames"), true), away);
  });

  it("camera off / error / starting", () => {
    assert.deepEqual(combineAttention(ok, P("off"), true), { attending: false, reason: "camera off" });
    assert.deepEqual(combineAttention(ok, P("error"), true), { attending: false, reason: "camera error" });
    assert.deepEqual(combineAttention(ok, P("starting"), true), { attending: false, reason: "camera starting" });
    assert.deepEqual(combineAttention(ok, P("error"), false), ok);
  });

  it("no presence at all (camera not in use)", () => {
    assert.deepEqual(combineAttention(ok, undefined, false), ok);
    assert.deepEqual(combineAttention(away, undefined, false), away);
    assert.deepEqual(combineAttention(ok, undefined, true), { attending: false, reason: "camera off" });
    assert.deepEqual(combineAttention(away, undefined, true), away);
  });
});

describe("presence reasons", () => {
  it("maps reasons to words, unknown passes through", () => {
    assert.equal(presenceReasonText("absent"), "not in front of the camera");
    assert.equal(presenceReasonText("no-frames"), "camera stalled");
    assert.equal(presenceReasonText("weird"), "weird");
  });

  it("presenceFromMonitor keeps the monitor's verdict", () => {
    assert.deepEqual(presenceFromMonitor({ present: false, reason: "absent" }), { present: false, reason: "absent" });
  });

  it("pause texts: absent always, camera problems only when required", () => {
    assert.match(presencePauseText(P("absent"), false)!.title, /not in front of the camera/);
    assert.match(presencePauseText(P("no-frames"), true)!.title, /stalled/);
    assert.equal(presencePauseText(P("no-frames"), false), undefined);
    assert.equal(presencePauseText(P("present", true), true), undefined);
    assert.match(presencePauseText(undefined, true)!.title, /camera off/);
    assert.equal(presencePauseText(undefined, false), undefined);
  });
});

describe("adjust (session glue)", () => {
  const reading = (attending: boolean): AttentionReading => ({ attending, source: "fallback", trackerDown: false });

  it("readingVerdict", () => {
    assert.deepEqual(readingVerdict(reading(true)), { attending: true, reason: "watching" });
    assert.equal(readingVerdict(reading(false)).attending, false);
  });

  it("attentionWithPresence / presenceAdjuster", () => {
    assert.equal(attentionWithPresence(reading(true), P("absent"), false).attending, false);
    let presence = P("present", true);
    let required = true;
    const adjust = presenceAdjuster(() => ({ present: () => presence }), () => required);
    assert.equal(adjust(reading(true), Date.now()), true);
    presence = P("no-frames");
    assert.equal(adjust(reading(true), Date.now()), false);
    required = false;
    assert.equal(adjust(reading(true), Date.now()), true);
    assert.equal(presenceAdjuster(() => undefined, true)(reading(true), 0), false);
    assert.equal(presenceAdjuster(() => undefined, false)(reading(true), 0), true);
  });
});
