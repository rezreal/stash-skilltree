// Loads what the play screens need (library + policy tags) and derives graph,
// progress, fog, ledger, streak and trigger edges from it. The last load is
// cached for the page's lifetime, so moving between the choice screen and the
// player doesn't reload the library; writes call reload() to refresh it.
import type { Graph, LibraryInput, NodeKey, Progress, Visibility } from "../core/types.ts";
import type { TriggerEdge } from "../core/triggers.ts";
import { buildGraph, computeProgress, computeVisibility, triggerEdges } from "../core/index.ts";
import { createClient, type StashClient } from "../stash/client.ts";
import { loadLibrary } from "../stash/load.ts";
import { computeLedger, computeStreak, loadPolicyTags } from "../play/index.ts";
import type { Ledger, PolicyTagInput, Streak } from "../play/types.ts";
import { usePluginSettings } from "../ui/pluginApi.ts";

interface Raw {
  library: LibraryInput;
  policyTags: PolicyTagInput[];
  loadedAt: number;
}

export interface PlayData {
  client: StashClient;
  library: LibraryInput;
  policyTags: PolicyTagInput[];
  graph: Graph;
  progress: Progress;
  visibility: Map<NodeKey, Visibility>;
  ledger: Ledger;
  streak: Streak;
  edges: TriggerEdge[];
  /** seconds without input before fallback attention counts as away */
  idleSec: number;
  /** plugin setting dailyEarnCap: most coins earned per day, if set */
  dailyEarnCap?: number;
}

export type PlayDataState =
  | { status: "loading"; message: string }
  | { status: "error"; error: string }
  | { status: "ready"; data: PlayData; refreshing?: string; refreshError?: string };

export const DEFAULT_IDLE_SEC = 120;

let cache: Raw | undefined;
let sharedClient: StashClient | undefined;

function client(): StashClient {
  if (!sharedClient) sharedClient = createClient();
  return sharedClient;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

type RawState =
  | { status: "loading"; message: string }
  | { status: "error"; error: string }
  | { status: "ready"; raw: Raw; refreshing?: string; refreshError?: string };

async function loadRaw(onProgress: (msg: string) => void): Promise<Raw> {
  const c = client();
  const [library, policyTags] = await Promise.all([
    loadLibrary(c, { onProgress }),
    loadPolicyTags(c),
  ]);
  return { library, policyTags, loadedAt: Date.now() };
}

export function usePlayData(): { state: PlayDataState; reload: () => Promise<void> } {
  const settings = usePluginSettings();
  const defaultNeed = typeof settings.defaultNeed === "number" && settings.defaultNeed > 0 ? settings.defaultNeed : undefined;
  const idleSec = typeof settings.idleSec === "number" && settings.idleSec > 0 ? settings.idleSec : DEFAULT_IDLE_SEC;
  const dailyEarnCap =
    typeof settings.dailyEarnCap === "number" && settings.dailyEarnCap > 0 ? settings.dailyEarnCap : undefined;

  const [rawState, setRawState] = React.useState<RawState>(() =>
    cache ? { status: "ready", raw: cache } : { status: "loading", message: "Loading library…" },
  );
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = React.useCallback(async () => {
    const progress = (message: string) => {
      if (!mounted.current) return;
      setRawState((prev) =>
        prev.status === "ready" ? { status: "ready", raw: prev.raw, refreshing: message } : { status: "loading", message },
      );
    };
    progress("Loading library…");
    try {
      const raw = await loadRaw(progress);
      cache = raw;
      if (mounted.current) setRawState({ status: "ready", raw });
    } catch (err) {
      if (!mounted.current) return;
      setRawState((prev) =>
        prev.status === "ready"
          ? { status: "ready", raw: prev.raw, refreshError: errorText(err) }
          : { status: "error", error: errorText(err) },
      );
    }
  }, []);

  React.useEffect(() => {
    if (!cache) void reload();
  }, [reload]);

  const raw = rawState.status === "ready" ? rawState.raw : undefined;
  const data = React.useMemo<PlayData | undefined>(() => {
    if (!raw) return undefined;
    const graph = buildGraph(raw.library, { defaultNeed });
    const progress = computeProgress(graph);
    return {
      client: client(),
      library: raw.library,
      policyTags: raw.policyTags,
      graph,
      progress,
      visibility: computeVisibility(graph, progress),
      ledger: computeLedger(raw.library),
      streak: computeStreak(raw.library, new Date(raw.loadedAt)),
      edges: triggerEdges(raw.library),
      idleSec,
      dailyEarnCap,
    };
  }, [raw, defaultNeed, idleSec, dailyEarnCap]);

  let state: PlayDataState;
  if (rawState.status === "ready" && data) {
    state = { status: "ready", data, refreshing: rawState.refreshing, refreshError: rawState.refreshError };
  } else if (rawState.status === "error") {
    state = rawState;
  } else {
    state = { status: "loading", message: rawState.status === "loading" ? rawState.message : "Loading…" };
  }
  return { state, reload };
}
