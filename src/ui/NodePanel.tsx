// Details of the selected node: requirements, toll/paid info and its scenes.
import type { Graph, Id, NodeKey, Progress, Visibility } from "../core/types.ts";
import { describeRequirement } from "../core/index.ts";
import { stashUrl } from "../stash/index.ts";
import { gateCost, nodeScenes, performerNames, sceneDone } from "./derive.ts";

export interface NodePanelProps {
  graph: Graph;
  progress: Progress;
  selected?: NodeKey;
  /** visibility in fog mode, undefined in author view */
  fog?: Visibility;
  performerId?: Id;
  /** tag id -> name, for the edit buttons */
  tagNames?: ReadonlyMap<Id, string>;
  /** author view: open a tag in Setup */
  onEditTag?: (tagId: Id) => void;
}

export function NodePanel(props: NodePanelProps) {
  const { graph, progress, selected, fog, performerId, tagNames, onEditTag } = props;
  const node = selected ? graph.nodes.get(selected) : undefined;

  if (!node || fog === "hidden") {
    return (
      <section className="skilltree-panel skilltree-node-panel">
        <p className="text-muted mb-0">Select a node to see its requirements and scenes.</p>
      </section>
    );
  }

  const p = progress.get(node.key);
  const explicit = node.explicitRequires.some((g) => g.length > 0) ? describeRequirement(node.explicitRequires) : "";
  const secret = fog === "ahead" || fog === "gate";
  const scenes = nodeScenes(graph, node, performerId);

  return (
    <section className="skilltree-panel skilltree-node-panel" aria-live="polite">
      <h3 className="skilltree-panel-title">
        {node.topic} <span className="text-muted">level {node.level}</span>
      </h3>
      <dl className="skilltree-facts">
        <dt>State</dt>
        <dd>
          <span className={`skilltree-state is-${secret ? fog : (p?.state ?? "locked")}`}>
            {fog === "ahead" ? "ahead" : fog === "gate" ? "gate" : (p?.state ?? "locked")}
          </span>
        </dd>
        <dt>Progress</dt>
        <dd>{p ? `${p.completed} of ${p.need} scenes` : `need ${node.need}`}</dd>
        <dt>Requires</dt>
        <dd>
          {node.level > 0 && <div>{`${node.topic} L${node.level - 1} (previous level)`}</div>}
          {explicit ? <div>{explicit}</div> : node.level === 0 && <div className="text-muted">nothing (entry)</div>}
        </dd>
        {fog === "gate" && (
          <>
            <dt>Price</dt>
            <dd className="skilltree-gold">${gateCost(node, progress)} opens it now</dd>
          </>
        )}
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

      <h4 className="skilltree-panel-subtitle">
        Scenes{" "}
        <span className="text-muted">
          {performerId ? `${scenes.length} of ${node.sceneIds.length} with performer` : node.sceneIds.length}
        </span>
      </h4>
      {secret ? (
        <p className="text-muted">Scenes stay in the fog until this node opens.</p>
      ) : scenes.length === 0 ? (
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
    </section>
  );
}
