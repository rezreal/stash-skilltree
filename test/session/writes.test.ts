import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scene } from "../core/fixtures.ts";
import type { StashClient } from "../../src/stash/client.ts";
import { buildCommit } from "../../src/play/commit.ts";
import { SCENE_UPDATE_FIELDS } from "../../src/play/queries.ts";
import { createSession, step } from "../../src/play/session.ts";
import { DEFAULT_POLICY } from "../../src/play/types.ts";
import type { Ledger, SessionState, Streak } from "../../src/play/types.ts";
import { finishComplete, sessionWriter, storeExposure } from "../../src/session/writes.ts";

function spyClient(): { client: StashClient; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async gql<T>(query: string): Promise<T> {
        calls.push(query);
        return {} as T;
      },
    },
  };
}

const ledger: Ledger = { earned: 50, spent: 0, paid: 0, balance: 50, entries: [] };
const streak: Streak = { days: 0, bonus: 1, activeToday: false };
const sc = scene("7", [], { durationSec: 4 });

function complete(): SessionState {
  let s = createSession({ scene: sc, policy: DEFAULT_POLICY, nowMs: 0 });
  s = step(s, { type: "play" });
  for (let i = 0; i <= 16; i++) s = step(s, { type: "tick", nowMs: i * 250, videoTime: i / 4, attending: true, playing: true });
  s = step(s, { type: "spend", event: { markerId: "m", amount: 5, at: 1, accepted: true } });
  return step(s, { type: "ended", nowMs: 4000 });
}

describe("persist = false: nothing is written", () => {
  it("there is no writer", () => {
    const { client } = spyClient();
    assert.equal(sessionWriter(client, false), undefined);
    assert.notEqual(sessionWriter(client, true), undefined);
  });

  it("a complete session ends in a preview of the same commit, without a request or reload", async () => {
    const { client, calls } = spyClient();
    let reloads = 0;
    const state = complete();
    assert.equal(state.phase, "complete");
    const result = await finishComplete({
      writer: sessionWriter(client, false),
      build: () => buildCommit(state, sc, DEFAULT_POLICY, streak, ledger, "2024-06-01T12:00:00.000Z"),
      reload: async () => void reloads++,
    });
    assert.equal(calls.length, 0);
    assert.equal(reloads, 0);
    assert.equal(result.status, "preview");
    if (result.status !== "preview") return;
    // the would-be result: quality, coins and spend are all there
    assert.ok(result.commit && result.commit.earnedNow > 0);
    assert.equal(result.commit?.spentNow, 5);
    assert.equal(result.commit?.breakdown.quality, 1);
  });

  it("a loop's minutes are skipped, not stored", async () => {
    const { client, calls } = spyClient();
    assert.equal(await storeExposure(sessionWriter(client, false), "7", 600), "skipped");
    assert.equal(calls.length, 0);
  });

  it("persist = true writes once and reloads (normal mode unchanged)", async () => {
    const { client, calls } = spyClient();
    let reloads = 0;
    const state = complete();
    const result = await finishComplete({
      writer: sessionWriter(client, true),
      build: () => buildCommit(state, sc, DEFAULT_POLICY, streak, ledger, "2024-06-01T12:00:00.000Z"),
      reload: async () => void reloads++,
    });
    assert.equal(result.status, "saved");
    assert.deepEqual(calls, [SCENE_UPDATE_FIELDS]);
    assert.equal(reloads, 1);
    assert.equal(await storeExposure(sessionWriter(client, true), "7", 600), "stored");
    assert.equal(calls.length, 2);
  });

  it("a failing build or write is an error state with the commit kept for a retry", async () => {
    const failing: StashClient = {
      async gql<T>(): Promise<T> {
        throw new Error("offline");
      },
    };
    const state = complete();
    const commit = buildCommit(state, sc, DEFAULT_POLICY, streak, ledger, "2024-06-01T12:00:00.000Z");
    const r = await finishComplete({ writer: sessionWriter(failing, true), build: () => commit, reload: async () => undefined });
    assert.deepEqual(r, { status: "error", error: "offline", commit });
    const r2 = await finishComplete({
      writer: undefined,
      build: () => {
        throw new Error("bad");
      },
      reload: async () => undefined,
    });
    assert.deepEqual(r2, { status: "error", error: "bad", commit: undefined });
  });

  it("the session code reaches the write functions only through sessionWriter", () => {
    // structural: the session hook and overlay import no write function, so
    // without a writer (persist: false) nothing can be committed or stored
    for (const file of [
      "src/session/useSkilltreeSession.ts",
      "src/session/StashSession.tsx",
      "src/session/overlays.tsx",
      "src/session/GazeRegionsSummary.tsx",
    ]) {
      const src = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
      for (const fn of ["commitSession", "saveExposure(", "saveGazeRegions(", "payForNode", "SCENE_UPDATE_FIELDS", "TAG_UPDATE_PAID", "PERFORMER_UPDATE_FIELDS", ".gql("]) {
        assert.equal(src.includes(fn), false, `${file} must not use ${fn}`);
      }
    }
  });
});
