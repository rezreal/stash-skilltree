// The /skilltree page: loads the library, derives graph, progress,
// fog, layout and lint, and lays out tree, panels and table. In author view
// a Setup section configures the tags the tree is built from.
import type { ChangeEvent } from "react";
import type { Id, LibraryInput, NodeKey } from "../core/types.ts";
import {
  buildGraph,
  computeLayout,
  computeProgress,
  computeVisibility,
  lintGraph,
  topicDepth,
} from "../core/index.ts";
import { createClient, loadLibrary } from "../stash/index.ts";
import { usePluginSettings } from "./pluginApi.ts";
import { countBySeverity, performerOptions, scenesInTree } from "./derive.ts";
import { RadialTree } from "./RadialTree.tsx";
import { NodePanel } from "./NodePanel.tsx";
import { LintPanel } from "./LintPanel.tsx";
import { TopicTable } from "./TopicTable.tsx";
import { SetupView, type SetupFocus } from "./SetupView.tsx";

type LoadState =
  | { status: "loading"; message: string }
  | { status: "error"; error: string }
  /** a reload keeps the previous library on screen until the new one is in */
  | { status: "ready"; library: LibraryInput; refreshing?: string; refreshError?: string };

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function useLibrary(): { state: LoadState; reload: () => void } {
  const [attempt, setAttempt] = React.useState(0);
  const [state, setState] = React.useState<LoadState>({ status: "loading", message: "Loading library…" });

  React.useEffect(() => {
    let cancelled = false;
    const progress = (message: string) =>
      setState((prev) => (prev.status === "ready" ? { status: "ready", library: prev.library, refreshing: message } : { status: "loading", message }));
    progress("Loading library…");
    loadLibrary(createClient(), {
      onProgress: (message) => {
        if (!cancelled) progress(message);
      },
    }).then(
      (library) => {
        if (!cancelled) setState({ status: "ready", library });
      },
      (err: unknown) => {
        if (cancelled) return;
        setState((prev) =>
          prev.status === "ready"
            ? { status: "ready", library: prev.library, refreshError: errorText(err) }
            : { status: "error", error: errorText(err) },
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const reload = React.useCallback(() => setAttempt((n) => n + 1), []);
  return { state, reload };
}

export function SkilltreePage() {
  const { state, reload } = useLibrary();
  const settings = usePluginSettings();
  const defaultNeed = typeof settings.defaultNeed === "number" && settings.defaultNeed > 0 ? settings.defaultNeed : undefined;

  if (state.status === "loading") {
    return (
      <div className="skilltree skilltree-status" role="status">
        <div className="spinner-border spinner-border-sm mr-2" aria-hidden="true" />
        {state.message}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="skilltree skilltree-status" role="alert">
        <p className="text-danger">Could not load the library: {state.error}</p>
        <button type="button" className="btn btn-secondary" onClick={reload}>
          Retry
        </button>
      </div>
    );
  }
  return (
    <SkilltreeView
      library={state.library}
      defaultNeed={defaultNeed}
      refreshing={state.refreshing}
      refreshError={state.refreshError}
      onReload={reload}
    />
  );
}

interface SkilltreeViewProps {
  library: LibraryInput;
  defaultNeed?: number;
  /** progress message while the library reloads */
  refreshing?: string;
  refreshError?: string;
  onReload: () => void;
}

type Section = "tree" | "setup";

function SkilltreeView(props: SkilltreeViewProps) {
  const { library, defaultNeed, refreshing, refreshError, onReload } = props;
  const [authorView, setAuthorView] = React.useState(true);
  const [performerId, setPerformerId] = React.useState<Id | undefined>(undefined);
  const [selected, setSelected] = React.useState<NodeKey | undefined>(undefined);
  const [section, setSection] = React.useState<Section>("tree");
  // Setup stays mounted once opened, so switching sections keeps its state.
  const [setupOpened, setSetupOpened] = React.useState(false);
  const [setupFocus, setSetupFocus] = React.useState<SetupFocus | undefined>(undefined);

  const graph = React.useMemo(() => buildGraph(library, { defaultNeed }), [library, defaultNeed]);
  const progress = React.useMemo(() => computeProgress(graph, { performerId }), [graph, performerId]);
  const visibility = React.useMemo(() => computeVisibility(graph, progress), [graph, progress]);
  const layout = React.useMemo(() => computeLayout(graph), [graph]);
  const issues = React.useMemo(() => lintGraph(graph, library), [graph, library]);
  const performers = React.useMemo(() => performerOptions(graph), [graph]);
  const depthOf = React.useCallback((topic: string) => topicDepth(graph, progress, topic), [graph, progress]);
  const tagNames = React.useMemo(() => libraryTagNames(library), [library]);

  const counts = countBySeverity(issues);
  let complete = 0;
  for (const p of progress.values()) if (p.state === "complete") complete++;

  const fog = authorView ? undefined : (selected ? visibility.get(selected) : undefined);
  const onPerformer = (e: ChangeEvent<HTMLSelectElement>) => setPerformerId(e.target.value || undefined);
  const showSetup = authorView && section === "setup";
  const openSetup = (tagId?: Id) => {
    setSection("setup");
    setSetupOpened(true);
    if (tagId !== undefined) setSetupFocus((prev) => ({ tagId, seq: (prev?.seq ?? 0) + 1 }));
  };

  return (
    <div className="skilltree">
      <header className="skilltree-header">
        <h2 className="skilltree-title">Skilltree</h2>
        <ul className="skilltree-stats" aria-label="Summary">
          <li><b>{graph.topics.length}</b> topics</li>
          <li><b>{complete}/{graph.nodes.size}</b> nodes complete</li>
          <li><b>{scenesInTree(graph)}</b> scenes in tree</li>
          {authorView && (
            <>
              <li className={counts.error ? "is-error" : undefined}><b>{counts.error}</b> errors</li>
              <li className={counts.warning ? "is-warning" : undefined}><b>{counts.warning}</b> warnings</li>
            </>
          )}
        </ul>
        <div className="skilltree-controls">
          {authorView && (
            <div className="btn-group btn-group-sm skilltree-sections" role="group" aria-label="Section">
              {(["tree", "setup"] as Section[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`btn ${section === s ? "btn-primary" : "btn-secondary"}`}
                  aria-pressed={section === s}
                  onClick={() => (s === "setup" ? openSetup() : setSection(s))}
                >
                  {s === "tree" ? "Tree" : "Setup"}
                </button>
              ))}
            </div>
          )}
          <div className="custom-control custom-switch">
            <input
              type="checkbox"
              className="custom-control-input"
              id="skilltree-author-view"
              checked={authorView}
              onChange={(e) => setAuthorView(e.target.checked)}
            />
            <label className="custom-control-label" htmlFor="skilltree-author-view">
              Author view
            </label>
          </div>
          <select
            className="form-control form-control-sm skilltree-performer"
            aria-label="Performer filter"
            value={performerId ?? ""}
            onChange={onPerformer}
          >
            <option value="">All performers</option>
            {performers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      {refreshing !== undefined && (
        <p className="skilltree-refreshing text-muted" role="status">
          <span className="spinner-border spinner-border-sm mr-2" aria-hidden="true" />
          Reloading library: {refreshing}
        </p>
      )}
      {refreshError !== undefined && (
        <div className="skilltree-refreshing" role="alert">
          <span className="text-danger">Could not reload the library: {refreshError}</span>{" "}
          <button type="button" className="btn btn-secondary btn-sm" onClick={onReload}>
            Retry
          </button>
        </div>
      )}

      {setupOpened && <SetupView hidden={!showSetup} focus={setupFocus} onLibraryChanged={onReload} />}

      {showSetup ? null : graph.nodes.size === 0 ? (
        <div className="skilltree-empty text-muted">
          <p>
            No interest tags yet. Give tags the custom fields <code>st.kind=interest</code>, <code>st.topic</code> and{" "}
            <code>st.level</code> to grow the tree.
          </p>
          {authorView && (
            <button type="button" className="btn btn-primary" onClick={() => openSetup()}>
              Set up tags
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="skilltree-main">
            <div className="skilltree-tree-wrap">
              <RadialTree
                graph={graph}
                layout={layout}
                progress={progress}
                visibility={visibility}
                authorView={authorView}
                selected={selected}
                onSelect={setSelected}
              />
              <Legend authorView={authorView} />
            </div>
            <aside className="skilltree-side">
              <NodePanel
                graph={graph}
                progress={progress}
                selected={selected}
                fog={fog}
                performerId={performerId}
                tagNames={tagNames}
                onEditTag={authorView ? openSetup : undefined}
              />
              {authorView && <LintPanel issues={issues} onSelect={setSelected} tagNames={tagNames} onEditTag={openSetup} />}
            </aside>
          </div>
          {authorView && (
            <TopicTable graph={graph} progress={progress} depthOf={depthOf} selected={selected} onSelect={setSelected} />
          )}
        </>
      )}
    </div>
  );
}

/** names of every st.* tag the library knows, for edit buttons */
function libraryTagNames(library: LibraryInput): Map<Id, string> {
  const names = new Map<Id, string>();
  for (const t of library.interestTags) names.set(t.id, t.name);
  for (const t of library.triggerTags) names.set(t.id, t.name);
  for (const m of library.malformed) names.set(m.tagId, m.tagName);
  return names;
}

function Legend(props: { authorView: boolean }) {
  const items: [string, string][] = [
    ["complete", "complete"],
    ["open", "open"],
    ...(props.authorView
      ? ([["locked", "locked"]] as [string, string][])
      : ([["ahead", "ahead"], ["gate", "can be bought"]] as [string, string][])),
  ];
  return (
    <ul className="skilltree-legend" aria-label="Legend">
      {items.map(([cls, label]) => (
        <li key={cls}>
          <span className={`skilltree-swatch is-${cls}`} aria-hidden="true" />
          {label}
        </li>
      ))}
    </ul>
  );
}
