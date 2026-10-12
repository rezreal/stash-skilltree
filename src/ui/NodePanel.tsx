// Details of the selected node: requirements, toll/paid info and its scenes.
// In the fog view the texts come from fogView.ts, which never names a topic
// the player has not entered.
import type { Graph, GraphNode, Id, NodeKey, Progress, Visibility } from "../core/types.ts";
import { describeRequirement } from "../core/index.ts";
import { stashUrl } from "../stash/index.ts";
import { nodeScenes, performerNames, sceneDone } from "./derive.ts";
import { fogPanel } from "./fogView.ts";

export interface NodePanelProps {
  graph: Graph;
  progress: Progress;
  visibility: Map<NodeKey, Visibility>;
  selected?: NodeKey;
  /** visibility of the selected node in fog mode, undefined in author view */
  fog?: Visibility;
  performerId?: Id;
  /** tag id -> name, for the edit buttons */
  tagNames?: ReadonlyMap<Id, string>;
  /** author view: open a tag in Setup */
  onEditTag?: (tagId: Id) => void;
}

function Placeholder() {
  return (
    <section className="skilltree-panel skilltree-node-panel">
      <p className="text-muted mb-0">Select a node to see its requirements and scenes.</p>
    </section>
  );
}

export function NodePanel(props: NodePanelProps) {
  const { graph, selected, fog } = props;
  const node = selected ? graph.nodes.get(selected) : undefined;
  if (!node || fog === "hidden") return <Placeholder />;
  return fog === undefined ? <AuthorNodePanel {...props} node={node} /> : <FogNodePanel {...props} node={node} />;
}

function FogNodePanel(props: NodePanelProps & { node: GraphNode }) {
  const { graph, progress, visibility, node, performerId } = props;
  const view = fogPanel(graph, progress, visibility, node.key);
  if (!view) return <Placeholder />;

  return (
    <section className="skilltree-panel skilltree-node-panel" aria-live="polite">
      <h3 className="skilltree-panel-title">
        {view.title} {view.subtitle && <span className="text-muted">{view.subtitle}</span>}
      </h3>
      <dl className="skilltree-facts">
        <dt>State</dt>
        <dd>
          <span className={`skilltree-state is-${view.look}`}>{view.stateText}</span>
        </dd>
        {view.progress && (
          <>
            <dt>Progress</dt>
            <dd>{view.progress}</dd>
          </>
        )}
        {view.requires.length > 0 && (
          <>
            <dt>Requires</dt>
            <dd>
              {view.requires.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </dd>
          </>
        )}
        {view.price !== undefined && (
          <>
            <dt>Price</dt>
            <dd className="skilltree-gold">${view.price} opens it now</dd>
          </>
        )}
        {view.unlock && (
          <>
            <dt>{view.price !== undefined ? "Or" : "Opens"}</dt>
            <dd>{view.unlock}</dd>
          </>
        )}
        {!view.secret && node.toll && (
          <>
            <dt>Toll</dt>
            <dd className="skilltree-gold">every clip asks for ${node.toll.amount}, paid once</dd>
          </>
        )}
        {!view.secret && node.paid > 0 && (
          <>
            <dt>Paid</dt>
            <dd className="skilltree-gold">${node.paid}</dd>
          </>
        )}
      </dl>

      {view.secret ? (
        <p className="text-muted">What lies here stays in the fog until it opens.</p>
      ) : (
        <SceneList graph={graph} node={node} performerId={performerId} />
      )}
    </section>
  );
}

function AuthorNodePanel(props: NodePanelProps & { node: GraphNode }) {
  const { graph, progress, node, performerId, tagNames, onEditTag } = props;
  const p = progress.get(node.key);
  const explicit = node.explicitRequires.some((g) => g.length > 0) ? describeRequirement(node.explicitRequires) : "";

  return (
    <section className="skilltree-panel skilltree-node-panel" aria-live="polite">
      <h3 className="skilltree-panel-title">
        {node.topic} <span className="text-muted">level {node.level}</span>
      </h3>
      <dl className="skilltree-facts">
        <dt>State</dt>
        <dd>
          <span className={`skilltree-state is-${p?.state ?? "locked"}`}>{p?.state ?? "locked"}</span>
        </dd>
        <dt>Progress</dt>
        <dd>{p ? `${p.completed} of ${p.need} scenes` : `need ${node.need}`}</dd>
        <dt>Requires</dt>
        <dd>
          {node.level > 0 && <div>{`${node.topic} L${node.level - 1} (previous level)`}</div>}
          {explicit ? <div>{explicit}</div> : node.level === 0 && <div className="text-muted">nothing (entry)</div>}
        </dd>
        {node.toll && (
          <>
            <dt>Toll</dt>
            <dd className="skilltree-gold">every clip asks for ${node.toll.amount}, paid once</dd>
          </>
        )}
        {node.paid > 0 && (
          <>
            <dt>Paid</dt>
            <dd className="skilltree-gold">${node.paid}</dd>
          </>
        )}
      </dl>

      {onEditTag && node.tagIds.length > 0 && (
        <>
          <h4 className="skilltree-panel-subtitle">Edit tags</h4>
          <ul className="skilltree-node-tags">
            {node.tagIds.map((id) => {
              const name = tagNames?.get(id) ?? `Tag ${id}`;
              return (
                <li key={id}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => onEditTag(id)}
                    aria-label={`Edit tag ${name}`}
                  >
                    {name}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <SceneList graph={graph} node={node} performerId={performerId} />
    </section>
  );
}

function SceneList(props: { graph: Graph; node: GraphNode; performerId?: Id }) {
  const { graph, node, performerId } = props;
  const scenes = nodeScenes(graph, node, performerId);
  return (
    <>
      <h4 className="skilltree-panel-subtitle">
        Scenes{" "}
        <span className="text-muted">
          {performerId ? `${scenes.length} of ${node.sceneIds.length} with performer` : node.sceneIds.length}
        </span>
      </h4>
      {scenes.length === 0 ? (
        <p className="text-muted">No scenes.</p>
      ) : (
        <ul className="skilltree-scenes">
          {scenes.map((s) => (
            <li key={s.id} className={sceneDone(s) ? "is-done" : undefined}>
              <a href={stashUrl(`scenes/${s.id}`)} className="skilltree-scene-title">
                {s.title || `Scene ${s.id}`}
              </a>
              {sceneDone(s) && (
                <span className="skilltree-done" aria-label="completed" title="completed">
                  {" "}
                  ✓
                </span>
              )}
              <div className="skilltree-scene-meta">
                {[s.date, performerNames(graph, s.performerIds)].filter(Boolean).join(" · ")}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
