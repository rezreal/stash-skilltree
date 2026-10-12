// The gaze region heatmap summed per performer: st.gaze_regions on the
// performer, JSON {"v":1,"sessions":n,"sec":{"eyes":12.3,...}} (seconds per
// region, see src/prompts/regionHeatmap.ts). A saved session (complete, or a
// loop's minutes) adds its time to every performer of the clip: the gaze is
// on the clip's main person, and which performer that is isn't known.

import type { Id } from "../core/types.ts";
import { HEATMAP_REGIONS, totalOf, type HeatmapRegion, type RegionSeconds } from "../prompts/regionHeatmap.ts";
import type { StashClient } from "../stash/client.ts";
import { fieldNumber, type CustomFields } from "../stash/fields.ts";
import { FIND_PERFORMER_FIELDS, PERFORMER_UPDATE_FIELDS, type FindPerformerFieldsResult } from "./queries.ts";

export const PERFORMER_REGIONS_FIELD = "st.gaze_regions";

/** sessions with less counted gaze than this aren't added to the performers, s */
export const MIN_SAVE_SEC = 5;

export interface StoredRegions {
  /** sessions summed */
  sessions: number;
  sec: RegionSeconds;
}

const isRegion = (k: string): k is HeatmapRegion => (HEATMAP_REGIONS as readonly string[]).includes(k);

/** A performer's stored totals; missing or unreadable values are empty, unknown regions are dropped. */
export function parseStoredRegions(fields: CustomFields | null | undefined): StoredRegions {
  const empty: StoredRegions = { sessions: 0, sec: {} };
  let raw: unknown = fields?.[PERFORMER_REGIONS_FIELD];
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return empty;
    }
  }
  if (typeof raw !== "object" || raw === null) return empty;
  const o = raw as { sessions?: unknown; sec?: unknown };
  const sessions = fieldNumber(o.sessions);
  const out: StoredRegions = { sessions: sessions !== undefined && sessions > 0 ? Math.floor(sessions) : 0, sec: {} };
  if (typeof o.sec === "object" && o.sec !== null) {
    for (const [k, v] of Object.entries(o.sec)) {
      const n = fieldNumber(v);
      if (isRegion(k) && n !== undefined && n > 0) out.sec[k] = n;
    }
  }
  return out;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** stored + one session, seconds rounded to tenths */
export function addSession(stored: StoredRegions, session: RegionSeconds): StoredRegions {
  const sec: RegionSeconds = {};
  for (const r of HEATMAP_REGIONS) {
    const n = round1((stored.sec[r] ?? 0) + (session[r] ?? 0));
    if (n > 0) sec[r] = n;
  }
  return { sessions: stored.sessions + 1, sec };
}

export function serializeStoredRegions(s: StoredRegions): string {
  return JSON.stringify({ v: 1, sessions: s.sessions, sec: s.sec });
}

/** The session counted enough gaze to be added to the performers. */
export function worthSaving(session: RegionSeconds): boolean {
  return totalOf(session) >= MIN_SAVE_SEC;
}

export interface SavedRegions {
  /** the new totals of the performers that were saved */
  totals: Map<Id, StoredRegions>;
  /** performers whose totals could not be read or written */
  failed: Id[];
}

/**
 * Adds a session to each performer's st.gaze_regions (read, add, write with
 * custom_fields.partial). Each performer on its own: one failing doesn't
 * stop the others.
 */
export async function saveGazeRegions(client: StashClient, performerIds: readonly Id[], session: RegionSeconds): Promise<SavedRegions> {
  const out: SavedRegions = { totals: new Map(), failed: [] };
  for (const id of new Set(performerIds)) {
    try {
      const res = await client.gql<FindPerformerFieldsResult>(FIND_PERFORMER_FIELDS, { id });
      if (!res.findPerformer) throw new Error(`performer ${id} not found`);
      const next = addSession(parseStoredRegions(res.findPerformer.custom_fields), session);
      await client.gql(PERFORMER_UPDATE_FIELDS, {
        input: { id, custom_fields: { partial: { [PERFORMER_REGIONS_FIELD]: serializeStoredRegions(next) } } },
      });
      out.totals.set(id, next);
    } catch (err) {
      console.warn(`[skilltree] gaze regions of performer ${id} not saved`, err);
      out.failed.push(id);
    }
  }
  return out;
}
