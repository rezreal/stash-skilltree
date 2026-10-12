// Every write a viewing session can make goes through a SessionWriter, and
// the only way to get one is sessionWriter(client, persist). Test mode passes
// persist = false and gets none: the session's end then builds the would-be
// commit (pure) and shows it as a preview, and a loop's minutes are only
// counted, because there is nothing to call. useSkilltreeSession imports no
// write function itself (test/session/writes.test.ts checks that).
// Pure apart from the writer; tested under node --test.
import type { Id } from "../core/types.ts";
import { commitSession, saveExposure } from "../play/commit.ts";
import type { SessionCommit } from "../play/types.ts";
import type { StashClient } from "../stash/client.ts";

export interface SessionWriter {
  /** a complete session's scene fields (st.completed_at, completions, earned, spent) */
  commit(c: SessionCommit): Promise<void>;
  /** a loop's total exposure (st.exposure_seconds) */
  saveExposure(sceneId: Id, totalSec: number): Promise<void>;
}

/** The session's writer; undefined when it must not persist (test mode). */
export function sessionWriter(client: StashClient, persist: boolean): SessionWriter | undefined {
  if (!persist) return undefined;
  return {
    commit: (c) => commitSession(client, c),
    saveExposure: (sceneId, totalSec) => saveExposure(client, sceneId, totalSec),
  };
}

export type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; commit?: SessionCommit; exposureSec?: number }
  | { status: "error"; error: string; commit?: SessionCommit }
  /** test mode: what would have been saved; nothing was */
  | { status: "preview"; commit?: SessionCommit; exposureSec?: number };

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The end of a complete session: builds the commit (or takes the prepared
 * one of a retry), writes it and reloads the play data. Without a writer
 * the result is a preview of the same commit and nothing else happens (no
 * write, no reload).
 */
export async function finishComplete(input: {
  writer: SessionWriter | undefined;
  build: () => SessionCommit;
  prepared?: SessionCommit;
  reload: () => Promise<void>;
}): Promise<SaveState> {
  let c = input.prepared;
  try {
    c = c ?? input.build();
    if (!input.writer) return { status: "preview", commit: c };
    await input.writer.commit(c);
  } catch (err) {
    return { status: "error", error: errorText(err), commit: c };
  }
  await input.reload();
  return { status: "saved", commit: c };
}

/**
 * Stores a loop's total exposure. "skipped" without a writer: the minutes
 * count for this session (and may complete it) but are not stored.
 */
export async function storeExposure(
  writer: SessionWriter | undefined,
  sceneId: Id,
  totalSec: number,
): Promise<"stored" | "skipped"> {
  if (!writer) return "skipped";
  await writer.saveExposure(sceneId, totalSec);
  return "stored";
}
