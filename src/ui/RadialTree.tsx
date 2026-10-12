// Radial skill tree: topics as spokes, rings = graph depth. Positions come
// from the full layout, so switching between author view and fog never moves
// a node; fog only hides things.
import type { KeyboardEvent } from "react";
import type { Graph, Layout, NodeKey, Progress, Visibility } from "../core/types.ts";
import {
  DEFAULT_DIMS,
  buildEdges,
  dimsFor,
  fogStubs,
  labelAnchor,
  placeNodes,
  polar,
  ringRadius,
  successorPairs,
  viewBoxFor,
  type EdgeSegment,
  type PlacedNode,
} from "./geometry.ts";
import { gateCost, nodeAriaLabel, progressText } from "./derive.ts";

const NODE_R = DEFAULT_DIMS.node;

export interface RadialTreeProps {
  graph: Graph;
  layout: Layout;
  progress: Progress;
  visibility: Map<NodeKey, Visibility>;
  authorView: boolean;
  selected?: NodeKey;
  onSelect: (key: NodeKey) => void;
}

export function RadialTree(props: RadialTreeProps) {
  const { graph, layout, progress, visibility, authorView, selected, onSelect } = props;

  const dims = React.useMemo(() => dimsFor(layout), [layout]);
  const placed = React.useMemo(
    () => placeNodes(layout, (k) => graph.nodes.get(k)?.topic ?? "", graph.topics, dims),
    [graph, layout, dims],
  );
  const edges = React.useMemo(() => buildEdges(graph.nodes.values(), placed, dims), [graph, placed, dims]);
  const pairs = React.useMemo(() => successorPairs(graph.nodes.values()), [graph]);

  const isVisible = (key: NodeKey) => authorView || (visibility.get(key) ?? "hidden") !== "hidden";
  const segVisible = (s: { target: NodeKey; sources: NodeKey[] }) =>
    isVisible(s.target) && s.sources.some(isVisible);
  const stubs = authorView ? [] : fogStubs(pairs, isVisible, placed, 22, dims);
  const complete = (key: NodeKey) => progress.get(key)?.state === "complete";

  const rings: number[] = [];
  for (let r = 0; r <= layout.maxRing; r++) rings.push(r);
  const labelRadius = ringRadius(layout.maxRing, dims) + dims.node + 22;

  return (
    <svg
      className="skilltree-tree"
      viewBox={viewBoxFor(layout.maxRing, dims)}
      role="group"
      aria-label="Skill tree"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <marker id="skilltree-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L8,4 L0,8 z" className="skilltree-arrow" />
        </marker>
      </defs>

      <g className="skilltree-rings" aria-hidden="true">
        {rings.map((r) => (
          <g key={r}>
            <circle r={ringRadius(r, dims)} className="skilltree-ring" />
            <text x={4} y={-ringRadius(r, dims) - 4} className="skilltree-ring-label">
              L{r}
            </text>
          </g>
        ))}
      </g>

      <g className="skilltree-edges" aria-hidden="true">
        {edges.segments.filter(segVisible).map((s) => (
          <Edge key={s.id} seg={s} met={s.sources.some(complete)} />
        ))}
        {edges.junctions.filter(segVisible).map((j) => (
          <g key={j.id}>
            <circle cx={j.x} cy={j.y} r={3.5} className={"skilltree-junction" + (j.sources.some(complete) ? " is-met" : "")} />
            {j.cost !== undefined && (
              <text x={j.x} y={j.y - 7} className="skilltree-junction-cost">
                ${j.cost}
              </text>
            )}
          </g>
        ))}
        {stubs.map((s) => (
          <line key={s.id} x1={s.from.x} y1={s.from.y} x2={s.to.x} y2={s.to.y} className="skilltree-stub" />
        ))}
      </g>

      <g className="skilltree-topics" aria-hidden="true">
        {graph.topics.map((topic) => {
          const angle = layout.topicAngles.get(topic);
          if (angle === undefined) return null;
          const p = polar(labelRadius, angle);
          return (
            <text key={topic} x={p.x} y={p.y} textAnchor={labelAnchor(angle)} dominantBaseline="middle" className="skilltree-topic-label">
              {topic}
            </text>
          );
        })}
      </g>

      <g className="skilltree-nodes">
        {[...placed.values()].filter((n) => isVisible(n.key)).map((n) => (
          <TreeNode
            key={n.key}
            placed={n}
            graph={graph}
            progress={progress}
            fog={authorView ? undefined : visibility.get(n.key)}
            selected={selected === n.key}
            onSelect={onSelect}
          />
        ))}
      </g>
    </svg>
  );
}

function Edge(props: { seg: EdgeSegment; met: boolean }) {
  const { seg, met } = props;
  const cls = `skilltree-edge is-${seg.kind}` + (met ? " is-met" : "");
  return (
    <line
      x1={seg.from.x}
      y1={seg.from.y}
      x2={seg.to.x}
      y2={seg.to.y}
      className={cls}
      markerEnd={seg.intoTarget ? "url(#skilltree-arrow)" : undefined}
    />
  );
}

interface TreeNodeProps {
  graph: Graph;
  progress: Progress;
  placed: PlacedNode;
  /** visibility in fog mode, undefined in author view */
  fog?: Visibility;
  selected: boolean;
  onSelect: (key: NodeKey) => void;
}

function TreeNode(props: TreeNodeProps) {
  const { graph, progress, placed, fog, selected, onSelect } = props;
  const node = graph.nodes.get(placed.key);
  if (!node) return null;
  const p = progress.get(node.key);
  const cost = fog === "gate" ? gateCost(node, progress) : 0;

  let look: string = p?.state ?? "locked";
  let label = progressText(p);
  if (fog === "ahead") {
    look = "ahead";
    label = "?";
  } else if (fog === "gate") {
    look = "gate";
    label = `$${cost}`;
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(node.key);
    }
  };

  return (
    <g
      className={`skilltree-node is-${look}` + (selected ? " is-selected" : "")}
      transform={`translate(${placed.x} ${placed.y})`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={nodeAriaLabel(node, p, fog, cost)}
      onClick={() => onSelect(node.key)}
      onKeyDown={onKeyDown}
    >
      <title>{`${node.topic} L${node.level}`}</title>
      {selected && <circle r={NODE_R + 5} className="skilltree-node-halo" />}
      <circle r={NODE_R} className="skilltree-node-disc" />
      <text className="skilltree-node-text" dominantBaseline="central" textAnchor="middle">
        {label}
      </text>
      <text className="skilltree-node-level" y={NODE_R + 11} textAnchor="middle">
        {fog === "ahead" ? "" : `${node.topic} ${node.level}`}
      </text>
    </g>
  );
}
