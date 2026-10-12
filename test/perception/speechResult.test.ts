import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cleanRecognizedText,
  createPartialDeduper,
  grammarJson,
  mapVoskMessage,
  normalizePhrase,
} from "../../src/perception/speechResult.ts";

describe("normalizePhrase", () => {
  it("lowercases and strips punctuation, keeps inner apostrophes", () => {
    assert.equal(normalizePhrase("  Yes, Sir!  "), "yes sir");
    assert.equal(normalizePhrase("I don’t know..."), "i don't know");
    assert.equal(normalizePhrase("'quoted' words"), "quoted words");
    assert.equal(normalizePhrase("--"), "");
  });
});

describe("grammarJson", () => {
  it("dedupes, adds [unk], undefined for nothing", () => {
    assert.equal(grammarJson(["Thank you", "thank you!", "Good girl"]), '["thank you","good girl","[unk]"]');
    assert.equal(grammarJson([]), undefined);
    assert.equal(grammarJson(["!!"]), undefined);
    assert.equal(grammarJson(null), undefined);
    assert.equal(grammarJson(undefined), undefined);
  });
});

describe("mapVoskMessage", () => {
  it("maps final and partial results, dropping [unk] and empties", () => {
    assert.deepEqual(mapVoskMessage({ event: "result", result: { text: "thank you" } }, 10), { t: 10, text: "thank you", final: true });
    assert.deepEqual(mapVoskMessage({ event: "partialresult", result: { partial: "thank [unk]" } }, 11), {
      t: 11,
      text: "thank",
      final: false,
    });
    assert.equal(mapVoskMessage({ event: "result", result: { text: "[unk]" } }, 1), null);
    assert.equal(mapVoskMessage({ event: "partialresult", result: { partial: "" } }, 1), null);
    assert.equal(mapVoskMessage({ event: "error", error: "x" }, 1), null);
    assert.equal(mapVoskMessage({ event: "load", result: true }, 1), null);
    assert.equal(mapVoskMessage(null, 1), null);
  });
  it("cleanRecognizedText", () => {
    assert.equal(cleanRecognizedText(" [unk] yes  [unk] please "), "yes please");
  });
});

describe("createPartialDeduper", () => {
  it("drops repeated partials, always passes finals", () => {
    const news = createPartialDeduper();
    assert.equal(news({ t: 0, text: "thank", final: false }), true);
    assert.equal(news({ t: 1, text: "thank", final: false }), false);
    assert.equal(news({ t: 2, text: "thank you", final: false }), true);
    assert.equal(news({ t: 3, text: "thank you", final: true }), true);
    assert.equal(news({ t: 4, text: "thank you", final: false }), true, "reset after a final");
  });
});
