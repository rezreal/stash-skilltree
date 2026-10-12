import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRepeatCheck, grammarFor, normalizeWords, numberToWords, phraseMatch, spokenPhrase } from "../../src/prompts/speechCheck.ts";
import { spec } from "./fixtures.ts";

describe("normalizeWords", () => {
  it("lowercases, strips punctuation and apostrophes", () => {
    assert.deepEqual(normalizeWords("I'm  listening, Sir!"), ["im", "listening", "sir"]);
    assert.deepEqual(normalizeWords("Café crème"), ["cafe", "creme"]);
  });
  it("turns number words into digits", () => {
    assert.deepEqual(normalizeWords("fifty coins"), ["50", "coins"]);
    assert.deepEqual(normalizeWords("twenty five"), ["25"]);
    assert.deepEqual(normalizeWords("one hundred and five"), ["105"]);
    assert.deepEqual(normalizeWords("two thousand three hundred"), ["2300"]);
    assert.deepEqual(normalizeWords("one two three"), ["1", "2", "3"]);
    assert.deepEqual(normalizeWords("1,000 times"), ["1000", "times"]);
    assert.deepEqual(normalizeWords("bread and butter"), ["bread", "and", "butter"]);
  });
});

describe("phraseMatch", () => {
  it("is 1 for an exact phrase inside longer speech", () => {
    assert.equal(phraseMatch("I listen and I follow", "okay I listen and I follow you"), 1);
  });
  it("treats number words and digits alike", () => {
    assert.equal(phraseMatch("I will pay 50 coins", "i will pay fifty coins"), 1);
    assert.equal(phraseMatch("twenty five times", "25 times"), 1);
    assert.ok(phraseMatch("I will pay 50 coins", "i will pay fifteen coins") < 0.85);
  });
  it("tolerates small recognition errors", () => {
    const s = phraseMatch("I listen and I follow", "i lissen and i fallow");
    assert.ok(s >= 0.85, String(s));
    const dropped = phraseMatch("I listen and I follow", "i listen i follow");
    assert.ok(dropped >= 0.75, String(dropped));
    const inserted = phraseMatch("I listen and I follow", "i listen and then i follow");
    assert.ok(inserted >= 0.75, String(inserted));
  });
  it("is order-aware and low for unrelated speech", () => {
    assert.ok(phraseMatch("I listen and I follow", "follow i and listen i") < 0.75);
    assert.ok(phraseMatch("I listen and I follow", "what time is it") < 0.3);
    assert.equal(phraseMatch("", "anything"), 0);
    assert.equal(phraseMatch("hello", ""), 0);
  });
});

describe("createRepeatCheck", () => {
  const s = spec({ check: "repeat", title: "I listen and I follow" });

  it("passes on a matching final result inside the window", () => {
    const c = createRepeatCheck(s);
    c.begin(1000);
    c.push({ t: 1500, text: "i listen and", final: false });
    assert.equal(c.result().passed, false);
    assert.ok(c.result().progress > 0.5);
    c.push({ t: 2500, text: "i lissen and i follow", final: true });
    assert.equal(c.result().passed, true);
    assert.equal(c.result().progress, 1);
  });

  it("partials need 0.9", () => {
    const c = createRepeatCheck(s);
    c.begin(0);
    c.push({ t: 10, text: "i listen and i fallow", final: false }); // ~0.93
    assert.equal(c.result().passed, true);
    const c2 = createRepeatCheck(s);
    c2.begin(0);
    c2.push({ t: 10, text: "i listen i follow", final: false }); // ~0.89
    assert.equal(c2.result().passed, false);
    c2.push({ t: 20, text: "i listen i follow", final: true });
    assert.equal(c2.result().passed, true);
  });

  it("ignores results before begin, outside the window and after end", () => {
    const c = createRepeatCheck(s);
    c.push({ t: 5, text: "i listen and i follow", final: true });
    c.begin(1000);
    c.push({ t: 999, text: "i listen and i follow", final: true });
    c.end(2000);
    c.push({ t: 2001, text: "i listen and i follow", final: true });
    assert.equal(c.result().passed, false);
    assert.equal(c.result().detail, "nothing heard");
  });

  it("respects a custom threshold", () => {
    const c = createRepeatCheck(s, { threshold: 0.99 });
    c.begin(0);
    c.push({ t: 1, text: "i lissen and i follow", final: true });
    assert.equal(c.result().passed, false);
  });
});

describe("grammar", () => {
  it("spells numbers out and keeps apostrophes", () => {
    assert.equal(numberToWords(0), "zero");
    assert.equal(numberToWords(45), "forty five");
    assert.equal(numberToWords(105), "one hundred five");
    assert.equal(numberToWords(2300), "two thousand three hundred");
    assert.equal(spokenPhrase("I'll pay 50 coins!"), "i'll pay fifty coins");
  });
  it("lists repeat phrases once plus [unk]", () => {
    const g = grammarFor([
      spec({ check: "repeat", title: "Yes, Sir." }),
      spec({ check: "repeat", title: "yes sir" }),
      spec({ check: "gaze", title: "look", target: "eyes" }),
      spec({ check: "repeat", title: "Count to 3" }),
    ]);
    assert.deepEqual(g, ["yes sir", "count to three", "[unk]"]);
  });
});
