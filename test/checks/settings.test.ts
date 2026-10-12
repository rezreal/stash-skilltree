import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checksSettings, DEFAULT_CHECKS_SETTINGS, parseBool } from "../../src/checks/settings.ts";

describe("checksSettings", () => {
  it("defaults everything on (unset settings are missing)", () => {
    assert.deepEqual(checksSettings({}), DEFAULT_CHECKS_SETTINGS);
    assert.deepEqual(checksSettings(undefined), DEFAULT_CHECKS_SETTINGS);
    assert.deepEqual(checksSettings(null), DEFAULT_CHECKS_SETTINGS);
  });

  it("reads booleans and tolerant strings / numbers", () => {
    assert.deepEqual(checksSettings({ webcamRequired: false, promptsEnabled: "no", speechEnabled: 0, videoAnalysis: "TRUE", gazeRegions: "off" }), {
      webcamRequired: false,
      promptsEnabled: false,
      speechEnabled: false,
      videoAnalysis: true,
      gazeRegions: false,
    });
  });

  it("parseBool falls back on junk", () => {
    assert.equal(parseBool("maybe", true), true);
    assert.equal(parseBool("maybe", false), false);
    assert.equal(parseBool(NaN, true), true);
    assert.equal(parseBool(null, false), false);
    assert.equal(parseBool(" off ", true), false);
    assert.equal(parseBool("1", false), true);
    assert.equal(parseBool(2, false), true);
  });
});
