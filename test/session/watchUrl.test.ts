import { test } from "node:test";
import assert from "node:assert/strict";
import { scene } from "../core/fixtures.ts";
import { watchUrl } from "../../src/session/watchUrl.ts";
import type { PolicyTagInput } from "../../src/play/types.ts";

const tags: PolicyTagInput[] = [{ id: "loop", name: "Loop", rules: ["exposure"], minMinutes: 20 }];

test("watched clips go to the scene page in Skilltree mode, autoplaying", () => {
  assert.equal(watchUrl("5", scene("5", []), tags), "/scenes/5?skilltree=1&autoplay=true");
  assert.equal(watchUrl("5", undefined, tags), "/scenes/5?skilltree=1&autoplay=true");
});

test("exposure loops carry the loop flag", () => {
  assert.equal(watchUrl("6", scene("6", ["loop"]), tags), "/scenes/6?skilltree=loop&autoplay=true");
});
