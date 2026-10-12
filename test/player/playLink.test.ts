import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlayLink, playLinkSearch } from "../../src/player/playLink.ts";

test("the start view has no query", () => {
  assert.deepEqual(parsePlayLink(""), { link: {}, has: { performer: false, test: false } });
  assert.equal(playLinkSearch({}), "");
});

test("a performer's suggestions", () => {
  const p = parsePlayLink("?performer=12");
  assert.deepEqual(p.link, { performer: "12" });
  assert.equal(p.has.performer, true);
  assert.equal(playLinkSearch(p.link), "?performer=12");
});

test("test mode with its search", () => {
  const p = parsePlayLink("?test=1&funscript=1&tags=4,x,9&q=%20intro%20&page=2");
  assert.deepEqual(p.link.test, { tags: ["4", "9"], funscript: true, prompts: false, title: "intro", page: 2 });
  assert.equal(playLinkSearch(p.link), "?test=1&funscript=1&tags=4,9&q=intro&page=2");
  assert.equal(parsePlayLink("?test=1&page=0").link.test?.page, 1);
});

test("test=0 is named but off, so it overrides a stored test mode", () => {
  const p = parsePlayLink("?test=0");
  assert.equal(p.link.test, undefined);
  assert.equal(p.has.test, true);
});

test("test mode leaves the performer out of the link", () => {
  assert.equal(playLinkSearch({ performer: "3", test: { tags: [], funscript: false, prompts: true, title: "", page: 1 } }), "?test=1&prompts=1");
});
