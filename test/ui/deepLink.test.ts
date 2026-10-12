import { test } from "node:test";
import assert from "node:assert/strict";
import { authorLinkSearch, parseAuthorLink } from "../../src/ui/deepLink.ts";

test("plain tree without a query", () => {
  assert.deepEqual(parseAuthorLink(""), { section: "tree" });
  assert.equal(authorLinkSearch({ section: "tree" }), "");
});

test("tree: selected node, performer, fog view", () => {
  const link = parseAuthorLink("?node=Relaxation%3A2&performer=12&fog=1");
  assert.deepEqual(link, { section: "tree", node: "Relaxation:2", performer: "12", fog: true });
  assert.equal(authorLinkSearch(link), "?fog=1&node=Relaxation%3A2&performer=12");
});

test("setup: a tag implies the tags tab, a topic the ladder tab", () => {
  assert.deepEqual(parseAuthorLink("?tag=345"), { section: "setup", tab: "tags", tag: "345" });
  assert.deepEqual(parseAuthorLink("?topic=Relaxation"), { section: "setup", tab: "ladder", topic: "Relaxation" });
  assert.deepEqual(parseAuthorLink("?view=setup&tab=series"), { section: "setup", tab: "series" });
  assert.deepEqual(parseAuthorLink("?view=setup"), { section: "setup", tab: "tags" });
  assert.deepEqual(parseAuthorLink("?view=setup&tab=bogus"), { section: "setup", tab: "tags" });
});

test("fog view wins over setup; tree-only and setup-only keys are dropped", () => {
  assert.deepEqual(parseAuthorLink("?view=setup&tag=3&fog=1"), { section: "tree", fog: true });
  assert.deepEqual(parseAuthorLink("?view=setup&node=A%3A1"), { section: "setup", tab: "tags" });
  assert.equal(authorLinkSearch({ section: "setup", tab: "series", tag: "3", node: "A:1" }), "?view=setup&tab=series");
});

test("round trips", () => {
  for (const s of ["?view=setup&tag=345", "?view=setup&tab=ladder&topic=Deep+Trance", "?view=setup&tab=series&performer=4", "?node=A%3A1"]) {
    assert.equal(authorLinkSearch(parseAuthorLink(s)), s);
  }
});
