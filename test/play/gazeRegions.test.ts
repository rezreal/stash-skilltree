import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addSession,
  parseStoredRegions,
  PERFORMER_REGIONS_FIELD,
  saveGazeRegions,
  serializeStoredRegions,
  worthSaving,
} from "../../src/play/gazeRegions.ts";
import { FIND_PERFORMER_FIELDS, PERFORMER_UPDATE_FIELDS } from "../../src/play/queries.ts";
import type { StashClient } from "../../src/stash/client.ts";

interface Call {
  query: string;
  variables: Record<string, unknown> | undefined;
}

function fakeClient(respond: (call: Call) => unknown): { client: StashClient; calls: Call[] } {
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

describe("parseStoredRegions", () => {
  it("reads the JSON string stash stores", () => {
    const v = JSON.stringify({ v: 1, sessions: 3, sec: { eyes: 12.5, chest: "4", nose: 2, face: -1 } });
    assert.deepEqual(parseStoredRegions({ [PERFORMER_REGIONS_FIELD]: v }), { sessions: 3, sec: { eyes: 12.5, chest: 4 } });
  });
  it("reads an object too", () => {
    assert.deepEqual(parseStoredRegions({ [PERFORMER_REGIONS_FIELD]: { sessions: 1, sec: { off: 1 } } }), { sessions: 1, sec: { off: 1 } });
  });
  it("is empty for missing or broken values", () => {
    const empty = { sessions: 0, sec: {} };
    assert.deepEqual(parseStoredRegions(null), empty);
    assert.deepEqual(parseStoredRegions({}), empty);
    assert.deepEqual(parseStoredRegions({ [PERFORMER_REGIONS_FIELD]: "{nope" }), empty);
    assert.deepEqual(parseStoredRegions({ [PERFORMER_REGIONS_FIELD]: 7 }), empty);
    assert.deepEqual(parseStoredRegions({ [PERFORMER_REGIONS_FIELD]: '{"sessions":"x","sec":[]}' }), empty);
  });
});

describe("addSession / serializeStoredRegions / worthSaving", () => {
  it("sums per region, counts the session and rounds to tenths", () => {
    const next = addSession({ sessions: 2, sec: { eyes: 10, hands: 1 } }, { eyes: 1.234, chest: 0.04, legs: 2.06 });
    assert.deepEqual(next, { sessions: 3, sec: { eyes: 11.2, hands: 1, legs: 2.1 } });
    assert.equal(serializeStoredRegions(next), '{"v":1,"sessions":3,"sec":{"eyes":11.2,"hands":1,"legs":2.1}}');
    assert.deepEqual(parseStoredRegions({ [PERFORMER_REGIONS_FIELD]: serializeStoredRegions(next) }), next);
  });
  it("needs a few seconds of gaze", () => {
    assert.equal(worthSaving({ eyes: 2, face: 2.9 }), false);
    assert.equal(worthSaving({ eyes: 2, face: 3 }), true);
  });
});

describe("saveGazeRegions", () => {
  it("reads, adds and writes each performer once", async () => {
    const stored: Record<string, unknown> = { "1": JSON.stringify({ v: 1, sessions: 1, sec: { eyes: 5 } }) };
    const { client, calls } = fakeClient((c) => {
      if (c.query === FIND_PERFORMER_FIELDS) {
        const id = c.variables!.id as string;
        return { findPerformer: { id, custom_fields: id in stored ? { [PERFORMER_REGIONS_FIELD]: stored[id] } : {} } };
      }
      return { performerUpdate: { id: "x" } };
    });
    const r = await saveGazeRegions(client, ["1", "2", "1"], { eyes: 2, chest: 3 });
    assert.deepEqual(r.failed, []);
    assert.deepEqual(r.totals.get("1"), { sessions: 2, sec: { eyes: 7, chest: 3 } });
    assert.deepEqual(r.totals.get("2"), { sessions: 1, sec: { eyes: 2, chest: 3 } });
    const writes = calls.filter((c) => c.query === PERFORMER_UPDATE_FIELDS);
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0]!.variables, {
      input: { id: "1", custom_fields: { partial: { [PERFORMER_REGIONS_FIELD]: '{"v":1,"sessions":2,"sec":{"eyes":7,"chest":3}}' } } },
    });
  });

  it("goes on when one performer fails", async () => {
    const { client } = fakeClient((c) => {
      if (c.query === FIND_PERFORMER_FIELDS) {
        const id = c.variables!.id as string;
        if (id === "1") throw new Error("boom");
        if (id === "3") return { findPerformer: null };
        return { findPerformer: { id, custom_fields: null } };
      }
      return {};
    });
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const r = await saveGazeRegions(client, ["1", "2", "3"], { eyes: 6 });
      assert.deepEqual(r.failed, ["1", "3"]);
      assert.deepEqual([...r.totals.keys()], ["2"]);
    } finally {
      console.warn = warn;
    }
  });
});
