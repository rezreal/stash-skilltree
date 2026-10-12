import { test } from "node:test";
import assert from "node:assert/strict";
import { appendSlot, type ReactLike } from "../../src/stashplayer/appendSlot.ts";

const Fragment = Symbol("Fragment");
const R: ReactLike = {
  Fragment,
  createElement: (type, props, ...children) => ({ type, key: (props as { key?: unknown } | null)?.key ?? null, props: { ...(props as object), children } }),
};
const div = { type: "div", key: null, props: {} };
const lovense = { type: "LovenseSlot", key: "lovense-sync", props: {} };
const ours = { type: "SkilltreeSlot", key: "skilltree:5", props: {} };

test("stash's element stays the first top-level child whether or not another plugin added a slot", () => {
  const plain = appendSlot(div, ours, R) as { type: unknown; props: { children: unknown[] } };
  assert.equal(plain.type, Fragment);
  assert.deepEqual(plain.props.children, [div, ours]);
  const theirs = R.createElement(Fragment, null, div, lovense);
  const merged = appendSlot(theirs, ours, R) as { props: { children: unknown[] } };
  assert.deepEqual(merged.props.children, [div, lovense, ours]);
});

test("a keyed fragment or anything else is kept whole", () => {
  const keyed = { type: Fragment, key: "x", props: { children: [div] } };
  assert.deepEqual((appendSlot(keyed, ours, R) as { props: { children: unknown[] } }).props.children, [keyed, ours]);
});
