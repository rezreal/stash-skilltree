import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scene } from "../core/fixtures.ts";
import { loadPolicyTags, parsePolicyTag, policyForScene } from "../../src/play/policy.ts";
import { fallbackAttending } from "../../src/play/attention.ts";
import type { StashClient } from "../../src/stash/client.ts";
import type { PolicyTagInput } from "../../src/play/types.ts";

describe("parsePolicyTag", () => {
  it("parses rules and thresholds leniently", () => {
    const t = parsePolicyTag({
      id: "1",
      name: "p",
      custom_fields: {
        "st.kind": "policy",
        "st.policy": " Attention , PROMPTS;track bogus attention",
        "st.min_minutes": "15",
        "st.track_min": 0.6,
        "st.reward_mult": "abc",
      },
    });
    assert.deepEqual(t, { id: "1", name: "p", rules: ["attention", "prompts", "track"], minMinutes: 15, trackMin: 0.6 });
  });

  it("ignores non-positive numbers and missing fields", () => {
    assert.deepEqual(parsePolicyTag({ id: "1", name: "p", custom_fields: { "st.reward_mult": -1 } }), {
      id: "1",
      name: "p",
      rules: [],
    });
    assert.deepEqual(parsePolicyTag({ id: "2", name: "q", custom_fields: null }), { id: "2", name: "q", rules: [] });
  });
});

describe("loadPolicyTags", () => {
  it("filters st.kind=policy from tags with any st.kind", async () => {
    const calls: { query: string; variables?: Record<string, unknown> }[] = [];
    const client: StashClient = {
      async gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
        calls.push({ query, ...(variables ? { variables } : {}) });
        return {
          findTags: {
            tags: [
              { id: "1", name: "a", custom_fields: { "st.kind": "Policy", "st.policy": "exposure", "st.min_minutes": 20 } },
              { id: "2", name: "b", custom_fields: { "st.kind": "interest" } },
            ],
          },
        } as T;
      },
    };
    const tags = await loadPolicyTags(client);
    assert.deepEqual(tags, [{ id: "1", name: "a", rules: ["exposure"], minMinutes: 20 }]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].query, /findTags/);
    assert.deepEqual((calls[0].variables?.tag_filter as Record<string, unknown>).custom_fields, [
      { field: "st.kind", modifier: "NOT_NULL" },
    ]);
  });
});

describe("policyForScene", () => {
  const tags: PolicyTagInput[] = [
    { id: "pa", name: "a", rules: ["attention"], rewardMult: 1.5 },
    { id: "pp", name: "p", rules: ["prompts", "track"], rewardMult: 2, minMinutes: 3 },
    { id: "pe", name: "e", rules: ["exposure"], minMinutes: 10 },
    { id: "pe2", name: "e2", rules: ["exposure"], minMinutes: 20 },
  ];

  it("defaults to attention without policy tags", () => {
    const p = policyForScene(scene("1", ["x"]), tags);
    assert.deepEqual(p.rules, ["attention"]);
    assert.equal(p.rewardMult, 1);
    assert.equal(p.attentionMin, 0.9);
    assert.equal(p.minMinutes, undefined);
  });

  it("unions rules and takes the max reward multiplier", () => {
    const p = policyForScene(scene("1", ["pa", "pp"]), tags);
    assert.deepEqual(p.rules, ["attention", "prompts", "track"]);
    assert.equal(p.rewardMult, 2);
  });

  it("does not add attention when policy tags name other rules", () => {
    assert.deepEqual(policyForScene(scene("1", ["pp"]), tags).rules, ["prompts", "track"]);
  });

  it("prompt markers add prompts", () => {
    const s = scene("1", [], { markers: [{ id: "m", title: "say", seconds: 1, check: "repeat" }] });
    assert.deepEqual(policyForScene(s, tags).rules, ["attention", "prompts"]);
    const plain = scene("2", [], { markers: [{ id: "m", title: "chapter", seconds: 1 }] });
    assert.deepEqual(policyForScene(plain, tags).rules, ["attention"]);
  });

  it("a funscript alone doesn't add track: only a tag with the track rule does", () => {
    assert.deepEqual(policyForScene(scene("1", [], { interactive: true }), tags).rules, ["attention"]);
  });

  it("trackMin: strictest over tags, percent values read as shares, default 0.7", () => {
    const tt: PolicyTagInput[] = [
      { id: "t1", name: "t1", rules: ["track"], trackMin: 0.6 },
      { id: "t2", name: "t2", rules: ["track"], trackMin: 80 },
      { id: "t3", name: "t3", rules: ["track"], trackMin: 500 },
    ];
    assert.equal(policyForScene(scene("1", ["t1"]), tt).trackMin, 0.6);
    assert.equal(policyForScene(scene("1", ["t1", "t2"]), tt).trackMin, 0.8);
    assert.equal(policyForScene(scene("1", ["t3"]), tt).trackMin, 1);
    assert.equal(policyForScene(scene("1", ["pp"]), tags).trackMin, 0.7);
  });

  it("exposure drops attention, minMinutes is the max", () => {
    const p = policyForScene(scene("1", ["pa", "pe", "pe2"]), tags);
    assert.deepEqual(p.rules, ["exposure"]);
    assert.equal(p.minMinutes, 20);
    assert.equal(p.rewardMult, 1.5);
  });
});

describe("fallbackAttending", () => {
  const base = { visible: true, focused: true, fullscreen: false, lastActivityMs: 0, nowMs: 10_000, idleSec: 30 };
  it("needs a visible, focused tab", () => {
    assert.equal(fallbackAttending(base), true);
    assert.equal(fallbackAttending({ ...base, visible: false }), false);
    assert.equal(fallbackAttending({ ...base, focused: false, fullscreen: true }), false);
  });
  it("needs fullscreen or recent activity", () => {
    assert.equal(fallbackAttending({ ...base, nowMs: 31_000 }), false);
    assert.equal(fallbackAttending({ ...base, nowMs: 31_000, fullscreen: true }), true);
    assert.equal(fallbackAttending({ ...base, nowMs: 30_000 }), true);
  });
});
