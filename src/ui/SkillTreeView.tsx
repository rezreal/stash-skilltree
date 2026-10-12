// The skill tree: an organic layout (see core/layout.ts) drawn as SVG.
// Positions come from the full graph, so switching between author view and
// fog never moves a node; the fog only decides what is drawn (fogView.ts).
// The viewBox frames the drawn nodes only, so the fog view zooms onto the
// known part and gives nothing away about the extent of the rest. Wheel
// zooms, dragging pans, the buttons zoom and refit.
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import type { Graph, Layout, NodeKey, Progress, Visibility } from "../core/types.ts";
import {
  DEFAULT_DIMS,
  START_RADIUS,
  fitBox,
  panBox,
  viewBoxString,
  zoomBox,
  type EdgeSegment,
  type Point,
  type ViewBox,
} from "./geometry.ts";
import { treeEdges, treeView, type ViewNode } from "./fogView.ts";

const NODE_R = DEFAULT_DIMS.node;
/** pointer travel (px) before a press becomes a drag */
const DRAG_THRESHOLD = 4;

export interface SkillTreeViewProps {
  graph: Graph;
  layout: Layout;
  progress: Progress;
  visibility: Map<NodeKey, Visibility>;
  authorView: boolean;
  selected?: NodeKey;
  onSelect: (key: NodeKey) => void;
}

export function SkillTreeView(props: SkillTreeViewProps) {
  const { graph, layout, progress, visibility, authorView, selected, onSelect } = props;

  const view = React.useMemo(
    () => treeView(graph, progress, visibility, authorView),
    [graph, progress, visibility, authorView],
  );
  const edges = React.useMemo(() => treeEdges(graph, layout, view.drawn), [graph, layout, view]);
  const fit = React.useMemo(() => {
    const pts: Point[] = [];
    for (const key of view.drawn) {
      const n = layout.nodes.get(key);
      if (n) pts.push(n);
    }
    return fitBox(pts);
  }, [layout, view]);

  const fitKey = viewBoxString(fit);
  const [box, setBox] = useViewBox(fit, fitKey);
  const svgRef = React.useRef<SVGSVGElement>(null);
  useWheelZoom(svgRef, setBox);
  const drag = useDragPan(svgRef, box, setBox);

  const complete = (key: NodeKey) => progress.get(key)?.state === "complete";

  return (
    <div className="skilltree-tree-frame">
      <svg
        ref={svgRef}
        className={"skilltree-tree" + (drag.dragging ? " is-dragging" : "")}
        viewBox={viewBoxString(box)}
        role="group"
        aria-label="Skill tree"
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={drag.onPointerDown}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
        onPointerCancel={drag.onPointerUp}
      >
        <defs>
          <marker id="skilltree-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" className="skilltree-arrow" />
          </marker>
        </defs>

        <g className="skilltree-edges" aria-hidden="true">
          {edges.start.map((s) => (
            <Edge key={s.id} seg={s} met={complete(s.target) || progress.get(s.target)?.state === "open"} />
          ))}
          {edges.segments.map((s) => (
            <Edge key={s.id} seg={s} met={s.sources.some(complete)} />
          ))}
          {edges.junctions.map((j) => (
            <g key={j.id}>
              <circle cx={j.x} cy={j.y} r={3.5} className={"skilltree-junction" + (j.sources.some(complete) ? " is-met" : "")} />
              {j.cost !== undefined && (
                <text x={j.x} y={j.y - 7} className="skilltree-junction-cost">
                  ${j.cost}
                </text>
              )}
            </g>
          ))}
        </g>

        <g className="skilltree-start" aria-hidden="true">
          <circle r={START_RADIUS} className="skilltree-start-disc" />
          <text y={START_RADIUS + 12} textAnchor="middle" className="skilltree-start-label">
            start
          </text>
        </g>

        <g className="skilltree-topics" aria-hidden="true">
          {view.topicLabels.map((t) => {
            const n = layout.nodes.get(t.anchor);
            if (!n) return null;
            return (
              <text key={t.topic} x={n.x} y={n.y - NODE_R - 8} textAnchor="middle" className="skilltree-topic-label">
                {t.text}
              </text>
            );
          })}
        </g>

        <g className="skilltree-nodes">
          {view.nodes.map((v) => {
            const n = layout.nodes.get(v.key);
            if (!n) return null;
            return <TreeNode key={v.key} view={v} x={n.x} y={n.y} selected={selected === v.key} onSelect={onSelect} />;
          })}
        </g>
      </svg>
      <div className="skilltree-zoom btn-group-vertical btn-group-sm" role="group" aria-label="Zoom">
        <button type="button" className="btn btn-secondary" aria-label="Zoom in" title="Zoom in" onClick={() => setBox((b) => zoomBox(b, 1.25))}>
          +
        </button>
        <button type="button" className="btn btn-secondary" aria-label="Zoom out" title="Zoom out" onClick={() => setBox((b) => zoomBox(b, 0.8))}>
          −
        </button>
        <button type="button" className="btn btn-secondary" aria-label="Fit tree to view" title="Fit" onClick={() => setBox(fit)}>
          Fit
        </button>
      </div>
    </div>
  );
}

/** the current viewBox; snaps back to `fit` whenever the fitted box changes */
function useViewBox(fit: ViewBox, fitKey: string): [ViewBox, (f: ViewBox | ((b: ViewBox) => ViewBox)) => void] {
  const [box, setBox] = React.useState<ViewBox>(fit);
  React.useEffect(() => {
    setBox(fit);
  }, [fitKey]); // fitKey is the value identity of fit
  return [box, setBox];
}

/** client coordinates → viewBox coordinates (handles preserveAspectRatio) */
function toBox(svg: SVGSVGElement, clientX: number, clientY: number): Point | undefined {
  const ctm = svg.getScreenCTM();
  if (!ctm) return undefined;
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const p = pt.matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

/**
 * Wheel zoom around the pointer. React 17 registers wheel listeners as
 * passive, so this is a native listener that may call preventDefault.
 */
function useWheelZoom(
  ref: { current: SVGSVGElement | null },
  setBox: (f: (b: ViewBox) => ViewBox) => void,
): void {
  React.useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const at = toBox(svg, e.clientX, e.clientY);
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      setBox((b) => zoomBox(b, factor, at));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [ref, setBox]);
}

interface DragState {
  id: number;
  x: number;
  y: number;
  box: ViewBox;
  /** viewBox units per screen pixel */
  scale: number;
  moved: boolean;
}

/**
 * Drag to pan. A press only becomes a drag after a few pixels; then the
 * pointer is captured, so releasing it does not click the node it started
 * on.
 */
function useDragPan(
  ref: { current: SVGSVGElement | null },
  box: ViewBox,
  setBox: (b: ViewBox) => void,
) {
  const state = React.useRef<DragState | null>(null);
  const [dragging, setDragging] = React.useState(false);

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    const svg = ref.current;
    if (!svg || e.button !== 0) return;
    const ctm = svg.getScreenCTM();
    state.current = { id: e.pointerId, x: e.clientX, y: e.clientY, box, scale: ctm && ctm.a > 0 ? 1 / ctm.a : 1, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const s = state.current;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!s.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      s.moved = true;
      setDragging(true);
      ref.current?.setPointerCapture?.(e.pointerId);
    }
    setBox(panBox(s.box, -dx * s.scale, -dy * s.scale));
  };
  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const s = state.current;
    if (!s || s.id !== e.pointerId) return;
    state.current = null;
    if (s.moved) {
      setDragging(false);
      ref.current?.releasePointerCapture?.(e.pointerId);
    }
  };
  return { dragging, onPointerDown, onPointerMove, onPointerUp };
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
  view: ViewNode;
  x: number;
  y: number;
  selected: boolean;
  onSelect: (key: NodeKey) => void;
}

function TreeNode(props: TreeNodeProps) {
  const { view, x, y, selected, onSelect } = props;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(view.key);
    }
  };

  return (
    <g
      className={`skilltree-node is-${view.look}` + (selected ? " is-selected" : "")}
      transform={`translate(${x} ${y})`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={view.aria}
      onClick={() => onSelect(view.key)}
      onKeyDown={onKeyDown}
    >
      <title>{view.title}</title>
      {selected && <circle r={NODE_R + 5} className="skilltree-node-halo" />}
      <circle r={NODE_R} className="skilltree-node-disc" />
      <text className="skilltree-node-text" dominantBaseline="central" textAnchor="middle">
        {view.text}
      </text>
      {view.sublabel && (
        <text className="skilltree-node-level" y={NODE_R + 11} textAnchor="middle">
          {view.sublabel}
        </text>
      )}
    </g>
  );
}
