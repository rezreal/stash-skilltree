import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSkilltreeMode, skilltreeSceneUrl } from "../../src/stashplayer/handoff.ts";

function loc(url: string) {
  const u = new URL(url, "http://stash.local");
  return { pathname: u.pathname, search: u.search };
}

test("skilltreeSceneUrl marks the mode and starts at 0 by default (no t)", () => {
  assert.equal(skilltreeSceneUrl("42"), "/scenes/42?skilltree=1");
  assert.equal(skilltreeSceneUrl("42", { startAt: 0 }), "/scenes/42?skilltree=1");
  assert.equal(skilltreeSceneUrl("42", { startAt: -3 }), "/scenes/42?skilltree=1");
  assert.equal(skilltreeSceneUrl("42", { startAt: Number.NaN }), "/scenes/42?skilltree=1");
});

test("skilltreeSceneUrl uses stash's own t and autoplay parameters", () => {
  assert.equal(skilltreeSceneUrl("7", { startAt: 12.34567, autoplay: true }), "/scenes/7?skilltree=1&t=12.346&autoplay=true");
  assert.equal(skilltreeSceneUrl("7", { loop: true }), "/scenes/7?skilltree=loop");
  assert.equal(skilltreeSceneUrl("a/b"), "/scenes/a%2Fb?skilltree=1");
});

test("parseSkilltreeMode round-trips", () => {
  assert.deepEqual(parseSkilltreeMode(loc(skilltreeSceneUrl("42"))), { sceneId: "42", startAt: 0, loop: false, test: false });
  assert.deepEqual(parseSkilltreeMode(loc(skilltreeSceneUrl("42", { startAt: 30, loop: true, autoplay: true }))), {
    sceneId: "42",
    startAt: 30,
    loop: true,
    test: false,
  });
});

test("test mode: skilltree=test, test-loop for exposure loops", () => {
  assert.equal(skilltreeSceneUrl("42", { test: true, autoplay: true }), "/scenes/42?skilltree=test&autoplay=true");
  assert.equal(skilltreeSceneUrl("42", { test: true, loop: true }), "/scenes/42?skilltree=test-loop");
  assert.equal(skilltreeSceneUrl("42", { test: false, loop: true }), "/scenes/42?skilltree=loop");
  assert.deepEqual(parseSkilltreeMode(loc(skilltreeSceneUrl("42", { test: true, startAt: 5 }))), {
    sceneId: "42",
    startAt: 5,
    loop: false,
    test: true,
  });
  assert.deepEqual(parseSkilltreeMode(loc("/scenes/7?skilltree=test-loop")), { sceneId: "7", startAt: 0, loop: true, test: true });
  // the normal markers are never test mode
  assert.equal(parseSkilltreeMode(loc("/scenes/7?skilltree=1"))?.test, false);
  assert.equal(parseSkilltreeMode(loc("/scenes/7?skilltree=loop"))?.test, false);
  assert.equal(parseSkilltreeMode(loc("/scenes/7?skilltree=loop"))?.loop, true);
});

test("parseSkilltreeMode accepts a base path prefix and a trailing slash", () => {
  assert.equal(parseSkilltreeMode(loc("/stash/scenes/9?skilltree=1"))?.sceneId, "9");
  assert.equal(parseSkilltreeMode(loc("/scenes/9/?skilltree=1"))?.sceneId, "9");
});

test("parseSkilltreeMode needs the marker", () => {
  assert.equal(parseSkilltreeMode(loc("/scenes/9")), undefined);
  assert.equal(parseSkilltreeMode(loc("/scenes/9?t=10")), undefined);
  assert.equal(parseSkilltreeMode(loc("/scenes/9?skilltree=0")), undefined);
  assert.equal(parseSkilltreeMode(loc("/scenes/9?skilltree=false")), undefined);
});

test("parseSkilltreeMode ignores other pages and reserved scene routes", () => {
  assert.equal(parseSkilltreeMode(loc("/scenes?skilltree=1")), undefined);
  assert.equal(parseSkilltreeMode(loc("/scenes/new?skilltree=1")), undefined);
  assert.equal(parseSkilltreeMode(loc("/scenes/markers?skilltree=1")), undefined);
  assert.equal(parseSkilltreeMode(loc("/skilltree/play/9?skilltree=1")), undefined);
  assert.equal(parseSkilltreeMode(loc("/scenes/9/extra?skilltree=1")), undefined);
});

test("invalid t reads as 0, like stash", () => {
  assert.equal(parseSkilltreeMode(loc("/scenes/9?skilltree=1&t=abc"))?.startAt, 0);
  assert.equal(parseSkilltreeMode(loc("/scenes/9?skilltree=1&t=-5"))?.startAt, 0);
  assert.equal(parseSkilltreeMode(loc("/scenes/9?skilltree=1&t=Infinity"))?.startAt, 0);
});

test("a percent-encoded id is decoded; a broken one does not throw", () => {
  assert.equal(parseSkilltreeMode(loc("/scenes/a%2Fb?skilltree=1"))?.sceneId, "a/b");
  assert.equal(parseSkilltreeMode({ pathname: "/scenes/%E0%A4%A", search: "?skilltree=1" }), undefined);
});
