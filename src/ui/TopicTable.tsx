// Per-topic overview: one row per topic, one column per level.
import type { Graph, NodeKey, Progress } from "../core/types.ts";
import { progressText, topicRows } from "./derive.ts";

export interface TopicTableProps {
  graph: Graph;
  progress: Progress;
  depthOf: (topic: string) => number;
  selected?: NodeKey;
  onSelect: (key: NodeKey) => void;
}

export function TopicTable(props: TopicTableProps) {
  const { graph, progress, depthOf, selected, onSelect } = props;
  const { maxLevel, rows } = React.useMemo(() => topicRows(graph, progress, depthOf), [graph, progress, depthOf]);
  const levels: number[] = [];
  for (let l = 0; l <= maxLevel; l++) levels.push(l);

  return (
    <section className="skilltree-panel skilltree-topics-panel">
      <h3 className="skilltree-panel-title">Topics</h3>
      <div className="skilltree-table-wrap">
        <table className="table table-sm skilltree-table">
          <thead>
            <tr>
              <th scope="col">Topic</th>
              <th scope="col" title="consecutive complete levels from L0">
                Depth
              </th>
              {levels.map((l) => (
                <th key={l} scope="col">
                  L{l}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.topic}>
                <th scope="row">{row.topic}</th>
                <td>{row.depth}</td>
                {row.cells.map((cell, l) =>
                  cell ? (
                    <td key={l} className={`is-${cell.progress?.state ?? "locked"}` + (selected === cell.key ? " is-selected" : "")}>
                      <button
                        type="button"
                        className="skilltree-linkish"
                        onClick={() => onSelect(cell.key)}
                        aria-label={`${row.topic} level ${l}: ${cell.scenes} scenes, ${progressText(cell.progress)} completed`}
                      >
                        <span className="skilltree-cell-progress">{progressText(cell.progress)}</span>
                        <span className="skilltree-cell-scenes">{cell.scenes} sc.</span>
                      </button>
                    </td>
                  ) : (
                    <td key={l} className="is-empty">
                      –
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
