// Setup section of the author view: configures the st.* fields of tags from
// inside the plugin. Needs every tag of the server, so they are loaded when
// the section is first opened (it stays mounted afterwards).
import type { ReactNode } from "react";
import type { Id } from "../core/types.ts";
import { createClient, loadAllTags, type SetupTag } from "../stash/index.ts";
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

type Tab = "tags" | "ladder";

const TAB_LABELS: Record<Tab, string> = { tags: "Tags", ladder: "Topic ladder" };

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
      {body}
    </div>
  );
}
