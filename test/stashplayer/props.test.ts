import { test } from "node:test";
import assert from "node:assert/strict";
import { modeForScene, skilltreePlayerProps, type ScenePlayerProps, type StashScene } from "../../src/stashplayer/props.ts";
import { overrideUserAction, userAction } from "../../src/stashplayer/playerOptions.ts";
import type { VideoJsLike } from "../../src/stashplayer/videoHandle.ts";

const loc = (pathname: string, search: string) => ({ pathname, search });

function baseProps(scene: StashScene): ScenePlayerProps {
  return {
    scene,
    hideScrubberOverride: false,
    autoplay: false,
    permitLoop: true,
    initialTimestamp: 0,
    sendSetTimestamp: () => undefined,
    onComplete: () => {
      throw new Error("queue advanced");
    },
    onNext: () => {
      throw new Error("next");
    },
    onPrevious: () => {
      throw new Error("previous");
    },
  };
}

test("modeForScene only matches the scene being played", () => {
  assert.equal(modeForScene({ id: "5" }, loc("/scenes/5", "?skilltree=1"))?.sceneId, "5");
  assert.equal(modeForScene({ id: "6" }, loc("/scenes/5", "?skilltree=1")), undefined);
  assert.equal(modeForScene({ id: "5" }, loc("/scenes/5", "")), undefined);
  assert.equal(modeForScene(undefined, loc("/scenes/5", "?skilltree=1")), undefined);
});

test("skilltreePlayerProps starts at 0 instead of the resume time and disables queue/skip callbacks", () => {
  const scene = { id: "5", resume_time: 321, title: "x" };
  const props = baseProps(scene);
  const out = skilltreePlayerProps(props, { sceneId: "5", startAt: 0, loop: false }, new WeakMap());
  assert.equal(out.scene.resume_time, 0);
  assert.equal(out.scene.title, "x");
  assert.equal(scene.resume_time, 321, "stash's object is untouched");
  assert.equal(out.initialTimestamp, 0);
  assert.equal(out.permitLoop, false);
  out.onComplete();
  out.onNext();
  out.onPrevious();
  assert.equal(out.sendSetTimestamp, props.sendSetTimestamp);
  assert.equal(out.hideScrubberOverride, false);
});

test("the scene copy and the callbacks keep their identity across renders", () => {
  const scene = { id: "5", resume_time: 10 };
  const cache = new WeakMap<object, StashScene>();
  const mode = { sceneId: "5", startAt: 0, loop: false };
  const a = skilltreePlayerProps(baseProps(scene), mode, cache);
  const b = skilltreePlayerProps(baseProps(scene), mode, cache);
  assert.equal(a.scene, b.scene);
  assert.equal(a.onComplete, b.onComplete);
  assert.equal(a.onNext, b.onNext);
});

test("no copy when there is no resume time", () => {
  const scene = { id: "5", resume_time: null };
  const out = skilltreePlayerProps(baseProps(scene), { sceneId: "5", startAt: 0, loop: false }, new WeakMap());
  assert.equal(out.scene, scene);
});

test("startAt and loops pass through", () => {
  const out = skilltreePlayerProps(baseProps({ id: "5" }), { sceneId: "5", startAt: 42, loop: true }, new WeakMap());
  assert.equal(out.initialTimestamp, 42);
  assert.equal(out.permitLoop, true);
});

test("overrideUserAction sets and restores, also when the key was absent", () => {
  const hotkeys = () => undefined;
  const p = { options_: { userActions: { hotkeys } } } as unknown as VideoJsLike;
  const restoreClick = overrideUserAction(p, "click", false);
  const wrapped = () => undefined;
  const restoreHot = overrideUserAction(p, "hotkeys", wrapped);
  assert.equal(userAction(p, "click"), false);
  assert.equal(userAction(p, "hotkeys"), wrapped);
  restoreHot();
  restoreClick();
  assert.equal(userAction(p, "hotkeys"), hotkeys);
  assert.ok(!("click" in p.options_!.userActions!));
});

test("overrideUserAction leaves a value someone else set afterwards", () => {
  const p = {} as unknown as VideoJsLike;
  const restore = overrideUserAction(p, "click", false);
  p.options_!.userActions!.click = "theirs";
  restore();
  assert.equal(userAction(p, "click"), "theirs");
});
