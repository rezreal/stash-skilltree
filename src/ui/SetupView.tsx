// Setup section of the author view: configures the st.* fields of tags (and
// the series fields of groups) from inside the plugin. Needs every tag of the
// server, so they are loaded when the section is first opened (it stays
// mounted afterwards); groups load when the Series tab is first opened.
import type { ReactNode } from "react";
import type { Id } from "../core/types.ts";
import { createClient, loadAllGroups, loadAllTags, type SetupGroup, type SetupTag } from "../stash/index.ts";
import { SeriesSetupPanel } from "./SeriesSetupPanel.tsx";
import { TagSetupPanel } from "./TagSetupPanel.tsx";
import { TopicLadder } from "./TopicLadder.tsx";

/** Request to open a tag in the editor; seq makes repeated requests distinct. */
export interface SetupFocus {
  tagId: Id;
  seq: number;
}

type TagsState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; tags: SetupTag[]; refreshError?: string };

type GroupsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; groups: SetupGroup[]; refreshError?: string };

type Tab = "tags" | "ladder" | "series";

const TAB_LABELS: Record<Tab, string> = { tags: "Tags", ladder: "Topic ladder", series: "Series" };

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface SetupViewProps {
  hidden: boolean;
  focus?: SetupFocus;
  /** reloads the library so the tree reflects written tags */
  onLibraryChanged: () => void;
}

export function SetupView(props: SetupViewProps) {
  const { hidden, focus, onLibraryChanged } = props;
  const client = React.useMemo(() => createClient(), []);
  const [state, setState] = React.useState<TagsState>({ status: "loading" });
  const [tab, setTab] = React.useState<Tab>("tags");
  const mounted = React.useRef(true);

  const loadTags = React.useCallback(async () => {
    try {
      const tags = await loadAllTags(client);
      if (mounted.current) setState({ status: "ready", tags });
    } catch (err) {
      if (!mounted.current) return;
      setState((prev) =>
        prev.status === "ready" ? { ...prev, refreshError: errorText(err) } : { status: "error", error: errorText(err) },
      );
    }
  }, [client]);

  React.useEffect(() => {
    mounted.current = true;
    loadTags();
    return () => {
      mounted.current = false;
    };
  }, [loadTags]);

  React.useEffect(() => {
    if (focus) setTab("tags");
  }, [focus]);

  const [groupsState, setGroupsState] = React.useState<GroupsState>({ status: "idle" });
  const loadGroups = React.useCallback(async () => {
    try {
      const groups = await loadAllGroups(client);
      if (mounted.current) setGroupsState({ status: "ready", groups });
    } catch (err) {
      if (!mounted.current) return;
      setGroupsState((prev) =>
        prev.status === "ready" ? { ...prev, refreshError: errorText(err) } : { status: "error", error: errorText(err) },
      );
    }
  }, [client]);
  React.useEffect(() => {
    if (tab !== "series" || groupsState.status !== "idle") return;
    setGroupsState({ status: "loading" });
    void loadGroups();
  }, [tab, groupsState.status, loadGroups]);
  const afterGroupsWrite = React.useCallback(async () => {
    onLibraryChanged();
    await loadGroups();
  }, [onLibraryChanged, loadGroups]);

  /** after a write: fresh tags for the editors, fresh library for the tree */
  const afterWrite = React.useCallback(async () => {
    onLibraryChanged();
    await loadTags();
  }, [onLibraryChanged, loadTags]);

  let body: ReactNode;
  if (state.status === "loading") {
    body = (
      <p className="skilltree-status" role="status">
        <span className="spinner-border spinner-border-sm mr-2" aria-hidden="true" />
        Loading tags…
      </p>
    );
  } else if (state.status === "error") {
    body = (
      <div className="skilltree-status" role="alert">
        <p className="text-danger">Could not load the tags: {state.error}</p>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            setState({ status: "loading" });
            loadTags();
          }}
        >
          Retry
        </button>
      </div>
    );
  } else {
    body = (
      <>
        {state.refreshError !== undefined && (
          <p className="text-danger" role="alert">
            Could not refresh the tags: {state.refreshError}
          </p>
        )}
        {/* both stay mounted so unsaved edits survive switching */}
        <div hidden={tab !== "tags"}>
          <TagSetupPanel tags={state.tags} client={client} focus={focus} onSaved={afterWrite} />
        </div>
        <div hidden={tab !== "ladder"}>
          <TopicLadder tags={state.tags} client={client} onApplied={afterWrite} />
        </div>
      </>
    );
  }

  let seriesBody: ReactNode = null;
  if (groupsState.status === "loading") {
    seriesBody = (
      <p className="skilltree-status" role="status">
        <span className="spinner-border spinner-border-sm mr-2" aria-hidden="true" />
        Loading groups…
      </p>
    );
  } else if (groupsState.status === "error") {
    seriesBody = (
      <div className="skilltree-status" role="alert">
        <p className="text-danger">Could not load the groups: {groupsState.error}</p>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            setGroupsState({ status: "loading" });
            void loadGroups();
          }}
        >
          Retry
        </button>
      </div>
    );
  } else if (groupsState.status === "ready") {
    seriesBody = (
      <>
        {groupsState.refreshError !== undefined && (
          <p className="text-danger" role="alert">
            Could not refresh the groups: {groupsState.refreshError}
          </p>
        )}
        <SeriesSetupPanel groups={groupsState.groups} client={client} onSaved={afterGroupsWrite} />
      </>
    );
  }

  return (
    <div className="skilltree-setup-view" hidden={hidden}>
      <div className="btn-group btn-group-sm skilltree-sections mb-3" role="group" aria-label="Setup view">
        {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`btn ${tab === t ? "btn-primary" : "btn-secondary"}`}
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>
      <div hidden={tab === "series"}>{body}</div>
      <div hidden={tab !== "series"}>{seriesBody}</div>
    </div>
  );
}
