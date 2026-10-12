import { test } from "node:test";
import assert from "node:assert/strict";
import type { MarkerInput } from "../../src/core/types.ts";
import { MAIL_END_MARGIN_SEC, mailHoldAt, mailPrompts, nextMail, parseMailTitle } from "../../src/player/mail.ts";
import { DEFAULT_PROMPT_WINDOWS, promptSpecs } from "../../src/prompts/specs.ts";

const m = (id: string, seconds: number, extra: Partial<MarkerInput> = {}): MarkerInput => ({
  id,
  title: "",
  seconds,
  ...extra,
});

test("parseMailTitle: a plain title is the body", () => {
  assert.deepEqual(parseMailTitle("  Hi, I'm late.  "), { to: "", subject: "", body: "Hi, I'm late." });
});

test("parseMailTitle: leading To and Subject segments, any order and case", () => {
  assert.deepEqual(parseMailTitle("To: boss@example.com | Subject: Re: Monday | Hi,\\n\\nsorry"), {
    to: "boss@example.com",
    subject: "Re: Monday",
    body: "Hi,\n\nsorry",
  });
  assert.deepEqual(parseMailTitle("subject: Hello|TO:a@b.c|body | with a pipe"), {
    to: "a@b.c",
    subject: "Hello",
    body: "body | with a pipe",
  });
  // only leading segments are headers
  assert.deepEqual(parseMailTitle("Dear Sir | To: nobody |"), { to: "", subject: "", body: "Dear Sir | To: nobody |" });
});

test("parseMailTitle: line breaks swallow the spaces around them", () => {
  assert.equal(parseMailTitle("Hi, \\n see you").body, "Hi,\nsee you");
});

test("mailPrompts: only mail markers, by start, with the mail default window", () => {
  const prompts = mailPrompts([
    m("b", 30, { check: "mail", title: "second", endSeconds: 50 }),
    m("x", 5, { check: "spend", title: "50" }),
    m("a", 10, { check: "mail", title: "Subject: S | first" }),
  ]);
  assert.deepEqual(
    prompts.map((p) => [p.marker.id, p.window, p.draft.subject]),
    [
      ["a", { start: 10, end: 10 + DEFAULT_PROMPT_WINDOWS.mail }, "S"],
      ["b", { start: 30, end: 50 }, ""],
    ],
  );
});

test("nextMail: the first unsent mail whose start lies behind t", () => {
  const prompts = mailPrompts([m("a", 10, { check: "mail" }), m("b", 30, { check: "mail" })]);
  assert.equal(nextMail(prompts, new Set(), 9), undefined);
  assert.equal(nextMail(prompts, new Set(), 10)?.marker.id, "a");
  // jumped over: still opens
  assert.equal(nextMail(prompts, new Set(), 100)?.marker.id, "a");
  assert.equal(nextMail(prompts, new Set(["a"]), 20), undefined);
  assert.equal(nextMail(prompts, new Set(["a"]), 31)?.marker.id, "b");
  assert.equal(nextMail(prompts, new Set(["a", "b"]), 100), undefined);
});

test("mailHoldAt: the marker end, kept inside the clip", () => {
  const [p] = mailPrompts([m("a", 10, { check: "mail", endSeconds: 40 })]);
  assert.equal(mailHoldAt(p!, 100), 40);
  assert.equal(mailHoldAt(p!, 0), 40);
  assert.equal(mailHoldAt(p!, 30), 30 - MAIL_END_MARGIN_SEC);
  // never before the start
  assert.equal(mailHoldAt(p!, 10.2), 10);
});

test("promptSpecs leaves mail markers to the session", () => {
  assert.deepEqual(promptSpecs([m("a", 10, { check: "mail", title: "hi" })]), []);
});
