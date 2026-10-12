import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ASSETS, assetUrl, assetsRoot } from "../../src/perception/assets.ts";
import { PerceptionError, classifyMediaError, unavailableMediaError } from "../../src/perception/errors.ts";
import { loadScriptGlobal, resetScriptCache } from "../../src/perception/loader.ts";
import type { ScriptHost } from "../../src/perception/loader.ts";
import { clampRate, createMonotonic, nextDelay } from "../../src/perception/time.ts";

describe("assetUrl", () => {
  it("builds URLs under the base href", () => {
    assert.equal(assetsRoot("https://h/stash/"), "https://h/stash/plugin/skilltree/assets/");
    assert.equal(assetUrl("/mediapipe/wasm", "https://h/stash"), "https://h/stash/plugin/skilltree/assets/mediapipe/wasm");
    assert.equal(assetUrl(ASSETS.voskModel, "https://h/"), "https://h/plugin/skilltree/assets/vosk/vosk-model-small-en-us-0.15.tar.gz");
  });
});

function domErr(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

describe("classifyMediaError", () => {
  it("maps DOMException names to codes", () => {
    assert.equal(classifyMediaError(domErr("NotAllowedError"), "camera", true).code, "permission-denied");
    assert.equal(classifyMediaError(domErr("NotFoundError"), "camera", true).code, "no-device");
    assert.equal(classifyMediaError(domErr("OverconstrainedError"), "camera", true).code, "no-device");
    assert.equal(classifyMediaError(domErr("NotReadableError"), "microphone", true).code, "device-busy");
    assert.equal(classifyMediaError(domErr("SecurityError"), "camera", false).code, "insecure-context");
    assert.equal(classifyMediaError(domErr("SecurityError"), "camera", true).code, "permission-denied");
    assert.equal(classifyMediaError(new TypeError("x"), "camera", false).code, "insecure-context");
    assert.equal(classifyMediaError("weird", "camera", true).code, "unknown");
  });
  it("mentions the device and passes PerceptionErrors through", () => {
    assert.match(classifyMediaError(domErr("NotFoundError"), "microphone", true).message, /microphone/);
    const e = new PerceptionError("assets-missing", "x");
    assert.equal(classifyMediaError(e, "camera", true), e);
    assert.match(unavailableMediaError("camera", false).message, /https/);
    assert.equal(unavailableMediaError("camera", true).code, "unsupported");
  });
});

describe("time helpers", () => {
  it("createMonotonic never repeats or goes back", () => {
    const ts = createMonotonic();
    assert.deepEqual([ts(10), ts(10), ts(5), ts(20)], [10, 11, 12, 20]);
  });
  it("clampRate and nextDelay", () => {
    assert.equal(clampRate(100, 5), 30);
    assert.equal(clampRate(0.1, 5), 0.5);
    assert.equal(clampRate(NaN, 5), 5);
    assert.equal(clampRate(-1, 5), 5);
    assert.equal(nextDelay(10, 1000, 1030), 70);
    assert.equal(nextDelay(10, 1000, 1200), 0);
  });
});

function fakeHost(onAppend: (el: { src: string; fire(type: "load" | "error"): void }) => void): ScriptHost & { count: number } {
  const host = {
    count: 0,
    createElement() {
      const listeners: Record<string, (() => void)[]> = {};
      const el = {
        src: "",
        async: false,
        addEventListener(type: string, fn: () => void) {
          (listeners[type] ??= []).push(fn);
        },
        fire(type: "load" | "error") {
          for (const fn of listeners[type] ?? []) fn();
        },
      };
      return el;
    },
    head: {
      appendChild(el: unknown) {
        host.count++;
        onAppend(el as { src: string; fire(type: "load" | "error"): void });
        return el;
      },
    },
  };
  return host;
}

describe("loadScriptGlobal", () => {
  it("injects once and resolves the global", async () => {
    resetScriptCache();
    const scope: Record<string, unknown> = {};
    const host = fakeHost((el) => {
      queueMicrotask(() => {
        scope.Lib = { src: el.src };
        el.fire("load");
      });
    });
    const [a, b] = await Promise.all([
      loadScriptGlobal<{ src: string }>("https://h/a.js", "Lib", host, scope),
      loadScriptGlobal<{ src: string }>("https://h/a.js", "Lib", host, scope),
    ]);
    assert.equal(a, b);
    assert.equal(a.src, "https://h/a.js");
    assert.equal(host.count, 1);
    await loadScriptGlobal("https://h/a.js", "Lib", host, scope);
    assert.equal(host.count, 1);
  });
  it("rejects with assets-missing and allows a retry", async () => {
    resetScriptCache();
    const scope: Record<string, unknown> = {};
    let fail = true;
    const host = fakeHost((el) =>
      queueMicrotask(() => {
        if (fail) el.fire("error");
        else {
          scope.Lib2 = 1;
          el.fire("load");
        }
      }),
    );
    await assert.rejects(loadScriptGlobal("https://h/b.js", "Lib2", host, scope), (e: PerceptionError) => e.code === "assets-missing");
    fail = false;
    assert.equal(await loadScriptGlobal("https://h/b.js", "Lib2", host, scope), 1);
    assert.equal(host.count, 2);
  });
  it("rejects when the script defines no global", async () => {
    resetScriptCache();
    const host = fakeHost((el) => queueMicrotask(() => el.fire("load")));
    await assert.rejects(loadScriptGlobal("https://h/c.js", "Nope", host, {}), /did not define Nope/);
  });
});
