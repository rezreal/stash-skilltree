// The /plugin/skilltree page: loads the library once, derives graph,
// progress, fog, layout and lint, and lays out tree, panels and table.
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

type LoadState =
  | { status: "loading"; message: string }
  | { status: "error"; error: string }
  | { status: "ready"; library: LibraryInput };

function useLibrary(): { state: LoadState; reload: () => void } {
  const [attempt, setAttempt] = React.useState(0);
  const [state, setState] = React.useState<LoadState>({ status: "loading", message: "Loading library…" });

  React.useEffect(() => {
    let cancelled = false;
    setState({ status: "loading", message: "Loading library…" });
    loadLibrary(createClient(), {
      onProgress: (message) => {
        if (!cancelled) setState({ status: "loading", message });
      },
    }).then(
      (library) => {
        if (!cancelled) setState({ status: "ready", library });
      },
      (err: unknown) => {
        if (!cancelled) setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return { state, reload: () => setAttempt((n) => n + 1) };
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
  return <SkilltreeView library={state.library} defaultNeed={defaultNeed} />;
}

function SkilltreeView(props: { library: LibraryInput; defaultNeed?: number }) {
  const { library, defaultNeed } = props;
  const [authorView, setAuthorView] = React.useState(true);
  const [performerId, setPerformerId] = React.useState<Id | undefined>(undefined);
  const [selected, setSelected] = React.useState<NodeKey | undefined>(undefined);

  const graph = React.useMemo(() => buildGraph(library, { defaultNeed }), [library, defaultNeed]);
  const progress = React.useMemo(() => computeProgress(graph, { performerId }), [graph, performerId]);
  const visibility = React.useMemo(() => computeVisibility(graph, progress), [graph, progress]);
  const layout = React.useMemo(() => computeLayout(graph), [graph]);
  const issues = React.useMemo(() => lintGraph(graph, library), [graph, library]);
  const performers = React.useMemo(() => performerOptions(graph), [graph]);
  const depthOf = React.useCallback((topic: string) => topicDepth(graph, progress, topic), [graph, progress]);

  const counts = countBySeverity(issues);
  let complete = 0;
  for (const p of progress.values()) if (p.state === "complete") complete++;

  const fog = authorView ? undefined : (selected ? visibility.get(selected) : undefined);
  const onPerformer = (e: ChangeEvent<HTMLSelectElement>) => setPerformerId(e.target.value || undefined);

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

      {graph.nodes.size === 0 ? (
        <p className="skilltree-empty text-muted">
          No interest tags yet. Give tags the custom fields <code>st.kind=interest</code>, <code>st.topic</code> and{" "}
          <code>st.level</code> to grow the tree.
        </p>
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
              <NodePanel graph={graph} progress={progress} selected={selected} fog={fog} performerId={performerId} />
              {authorView && <LintPanel issues={issues} onSelect={setSelected} />}
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
