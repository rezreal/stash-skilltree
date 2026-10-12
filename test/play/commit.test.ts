import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scene } from "../core/fixtures.ts";
import type { StashClient } from "../../src/stash/client.ts";
import { buildCommit, commitSession, earnedOnDay, payForNode, saveExposure } from "../../src/play/commit.ts";
import { createSession, step } from "../../src/play/session.ts";
import { DEFAULT_POLICY } from "../../src/play/types.ts";
import type { Ledger, SessionCommit, SessionState, Streak } from "../../src/play/types.ts";

interface Call {
  query: string;
  variables: Record<string, unknown> | undefined;
}

function fakeClient(respond: (call: Call) => unknown = () => ({})): { client: StashClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: StashClient = {
    async gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
      const call = { query, variables };
      calls.push(call);
      return respond(call) as T;
    },
  };
  return { client, calls };
}

const emptyLedger: Ledger = { earned: 0, spent: 0, paid: 0, balance: 0, entries: [] };
const noStreak: Streak = { days: 0, bonus: 1, activeToday: false };

function completeSession(durationSec: number, spends: { amount: number; accepted: boolean }[] = []): SessionState {
  let s = createSession({ scene: scene("7", [], { durationSec }), policy: DEFAULT_POLICY, nowMs: 0 });
  s = step(s, { type: "play" });
  for (let i = 0; i <= durationSec * 4; i++) {
    s = step(s, { type: "tick", nowMs: i * 250, videoTime: i / 4, attending: true, playing: true });
  }
  spends.forEach((sp, i) => {
    s = step(s, { type: "spend", event: { markerId: `m${i}`, amount: sp.amount, at: 1, accepted: sp.accepted } });
  });
  return step(s, { type: "ended", nowMs: durationSec * 1000 });
}

describe("buildCommit", () => {
  it("adds this session to the scene's cumulative values", () => {
    const sc = scene("7", [], { durationSec: 600, completions: 1, earned: 10, spent: 5, completedAt: "2024-01-01T00:00:00Z" });
    const state = completeSession(600, [{ amount: 15, accepted: true }]);
    assert.equal(state.phase, "complete");
    const c = buildCommit(state, sc, DEFAULT_POLICY, noStreak, emptyLedger, "2024-05-01T12:00:00Z");
    assert.deepEqual(c, {
      sceneId: "7",
      completedAt: "2024-05-01T12:00:00Z",
      completions: 2,
      earned: 15,
      spent: 20,
      earnedNow: 5,
      spentNow: 15,
      breakdown: { base: 10, quality: 1, rewardMult: 1, repeatFactor: 0.5, streakBonus: 1, total: 5 },
    });
  });

  it("applies the daily cap using today's ledger entries", () => {
    const sc = scene("7", [], { durationSec: 600 });
    const ledger: Ledger = {
      ...emptyLedger,
      entries: [
        { at: "2024-05-01T08:00:00", amount: 6, kind: "earned", sceneId: "1" },
        { at: "2024-04-30T08:00:00", amount: 50, kind: "earned", sceneId: "2" },
        { at: "2024-05-01T09:00:00", amount: 3, kind: "spent", sceneId: "1" },
      ],
    };
    assert.equal(earnedOnDay(ledger, "2024-05-01T12:00:00"), 6);
    const c = buildCommit(completeSession(600), sc, DEFAULT_POLICY, noStreak, ledger, "2024-05-01T12:00:00", { dailyCap: 12 });
    assert.equal(c.earnedNow, 6);
    assert.equal(c.breakdown.uncapped, 10);
    const c2 = buildCommit(completeSession(600), sc, DEFAULT_POLICY, noStreak, ledger, "2024-05-01T12:00:00", {
      dailyCap: 12,
      earnedToday: 0,
    });
    assert.equal(c2.earnedNow, 10);
  });

  it("refuses sessions that are not complete", () => {
    const s = step(createSession({ scene: scene("7", []), policy: DEFAULT_POLICY, nowMs: 0 }), { type: "abort", reason: "user" });
    assert.throws(() => buildCommit(s, scene("7", []), DEFAULT_POLICY, noStreak, emptyLedger, "2024-05-01T12:00:00Z"));
  });
});

const commit: SessionCommit = {
  sceneId: "7",
  completedAt: "2024-05-01T12:00:00Z",
  completions: 2,
  earned: 15,
  spent: 20,
  earnedNow: 5,
  spentNow: 15,
  breakdown: { base: 10, quality: 1, rewardMult: 1, repeatFactor: 0.5, streakBonus: 1, total: 5 },
};

describe("commitSession", () => {
  it("writes the scene fields, then adds a play", async () => {
    const { client, calls } = fakeClient();
    await commitSession(client, commit);
    assert.equal(calls.length, 2);
    assert.match(calls[0].query, /sceneUpdate\(input: \$input\)/);
    assert.deepEqual(calls[0].variables, {
      input: {
        id: "7",
        custom_fields: {
          partial: {
            "st.completed_at": "2024-05-01T12:00:00Z",
            "st.completions": 2,
            "st.earned": 15,
            "st.spent": 20,
          },
        },
      },
    });
    assert.match(calls[1].query, /sceneAddPlay\(id: \$id, times: \$times\)/);
    assert.deepEqual(calls[1].variables, { id: "7", times: ["2024-05-01T12:00:00Z"] });
  });

  it("a failing play history is not fatal, a failing update is", async () => {
    const ok = fakeClient((c) => {
      if (/sceneAddPlay/.test(c.query)) throw new Error("nope");
      return {};
    });
    await commitSession(ok.client, commit);
    assert.equal(ok.calls.length, 2);

    const bad = fakeClient(() => {
      throw new Error("down");
    });
    await assert.rejects(commitSession(bad.client, commit), /down/);
    assert.equal(bad.calls.length, 1);
  });
});

describe("saveExposure", () => {
  it("writes whole seconds", async () => {
    const { client, calls } = fakeClient();
    await saveExposure(client, "9", 754.6);
    assert.deepEqual(calls[0].variables, {
      input: { id: "9", custom_fields: { partial: { "st.exposure_seconds": 755 } } },
    });
  });
});

describe("payForNode", () => {
  it("adds to the node's largest st.paid and writes it onto the first tag", async () => {
    const { client, calls } = fakeClient((c) =>
      /findTags/.test(c.query)
        ? {
            findTags: {
              tags: [
                { id: "a", custom_fields: { "st.paid": "20" } },
                { id: "b", custom_fields: { "st.paid": 35 } },
              ],
            },
          }
        : {},
    );
    const paid = await payForNode(client, ["a", "b"], 60, "2024-05-01T12:00:00Z");
    assert.equal(paid, 95);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].variables, { ids: ["a", "b"], filter: { per_page: -1 } });
    assert.match(calls[1].query, /tagUpdate\(input: \$input\)/);
    assert.deepEqual(calls[1].variables, {
      input: { id: "a", custom_fields: { partial: { "st.paid": 95, "st.unlocked_at": "2024-05-01T12:00:00Z" } } },
    });
  });

  it("starts from 0 and rejects bad input", async () => {
    const { client, calls } = fakeClient((c) => (/findTags/.test(c.query) ? { findTags: { tags: [{ id: "a", custom_fields: null }] } } : {}));
    assert.equal(await payForNode(client, ["a"], 10, "t"), 10);
    await assert.rejects(payForNode(client, [], 10, "t"));
    await assert.rejects(payForNode(client, ["a"], 0, "t"));
    assert.equal(calls.length, 2);
  });
});
