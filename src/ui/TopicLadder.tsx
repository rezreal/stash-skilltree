// Topic ladder of the Setup section: one topic's levels with the tags on
// each. Edits (add, remove, move a level) only collect pending changes; they
// are written in one batch after an explicit confirmation.
import type { Id } from "../core/types.ts";
import { normalizeTopic } from "../core/index.ts";
import { updateTagsFields, type SetupTag, type StashClient } from "../stash/index.ts";
import {
  addToLadder,
  ladderCandidates,
  ladderChanges,
  ladderOf,
  ladderRows,
  ladderTopics,
  removeFromLadder,
  staleRequires,
  swapLevels,
  type Ladder,
} from "./ladder.ts";
import { describeChange, interestNode, topicError } from "./setupForm.ts";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Status = { ok: string } | { error: string };

export interface TopicLadderProps {
  tags: SetupTag[];
  client: StashClient;
  /** called after a batch write (also a partial one); resolves once the tag list is fresh */
  onApplied: () => Promise<void>;
  /** the topic the URL names: a topic opens it, null closes it, undefined leaves it */
  want?: string | null;
  /** the viewer opened another topic (it goes into the URL); not called for `want` itself */
  onTopic?: (topic: string | undefined) => void;
}

export function TopicLadder(props: TopicLadderProps) {
  const { tags, client, onApplied } = props;
  const topics = React.useMemo(() => ladderTopics(tags), [tags]);
  const [topicInput, setTopicInput] = React.useState("");
  const [topicInputError, setTopicInputError] = React.useState<string | undefined>(undefined);
  const [topic, setTopic] = React.useState<string | undefined>(undefined);
  const reported = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    if (topic === reported.current) return;
    reported.current = topic;
    props.onTopic?.(topic);
  }, [topic]);
  // Pending edits belong to one topic and one tag list; a refreshed list
  // (after writing) starts over from the saved fields.
  const [draft, setDraft] = React.useState<{ topic: string; tags: SetupTag[]; ladder: Ladder } | undefined>(undefined);
  const [adding, setAdding] = React.useState<number | undefined>(undefined);
  const [confirming, setConfirming] = React.useState(false);
  const [progress, setProgress] = React.useState<{ done: number; total: number } | undefined>(undefined);
  const [status, setStatus] = React.useState<Status | undefined>(undefined);

  const base = React.useMemo(() => (topic !== undefined ? ladderOf(tags, topic) : new Map<Id, number>()), [tags, topic]);
  const ladder: Ladder = draft && draft.topic === topic && draft.tags === tags ? draft.ladder : base;
  const changes = React.useMemo(() => (topic !== undefined ? ladderChanges(tags, topic, ladder) : []), [tags, topic, ladder]);
  const byId = React.useMemo(() => new Map(tags.map((t) => [t.id, t] as const)), [tags]);
  const writing = progress !== undefined;

  const update = (next: Ladder) => {
    if (topic === undefined) return;
    setDraft({ topic, tags, ladder: next });
    setConfirming(false);
    setStatus(undefined);
  };

  const openTopic = (name: string) => {
    const err = topicError(name);
    setTopicInputError(err);
    if (err) return;
    const next = normalizeTopic(name);
    if (next === topic) return;
    if (changes.length > 0 && !window.confirm(`Discard ${changes.length} pending change(s) to ${topic}?`)) return;
    setTopic(next);
    setTopicInput(next);
    setDraft(undefined);
    setAdding(undefined);
    setConfirming(false);
    setStatus(undefined);
  };

  const closeTopic = () => {
    if (topic === undefined) return;
    if (changes.length > 0 && !window.confirm(`Discard ${changes.length} pending change(s) to ${topic}?`)) return;
    setTopic(undefined);
    setTopicInput("");
    setDraft(undefined);
    setAdding(undefined);
    setConfirming(false);
    setStatus(undefined);
  };

  // follow the URL (a link, back / forward); the handlers change every render
  React.useEffect(() => {
    const want = props.want;
    if (want === undefined) return;
    if (want === null) closeTopic();
    else if (topicError(want) === undefined && normalizeTopic(want) !== topic) openTopic(want);
  }, [props.want]);

  const apply = async () => {
    const total = changes.length;
    setConfirming(false);
    setStatus(undefined);
    setProgress({ done: 0, total });
    let error: string | undefined;
    try {
      await updateTagsFields(client, changes, (done, t) => setProgress({ done, total: t }));
    } catch (err) {
      error = errorText(err);
    }
    await onApplied();
    setProgress(undefined);
    setDraft(undefined);
    setStatus(error !== undefined ? { error } : { ok: `Wrote ${total} tag${total === 1 ? "" : "s"}.` });
  };

  const rows = ladderRows(ladder, tags);
  const warnings: string[] = [];
  if (topic !== undefined) {
    for (const r of rows.slice(0, -1)) {
      if (r.tags.length === 0) warnings.push(`Level ${r.level} has no tags; the levels after it stay locked`);
    }
    warnings.push(...staleRequires(tags, topic, ladder));
  }

  return (
    <section className="skilltree-panel skilltree-ladder-panel" aria-labelledby="skilltree-ladder-title">
      <h3 className="skilltree-panel-title" id="skilltree-ladder-title">
        Topic ladder
      </h3>
      <form
        className="skilltree-ladder-topic"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          openTopic(topicInput);
        }}
      >
        <label htmlFor="skilltree-ladder-topic-input">Topic</label>
        <div className="skilltree-inline">
          <input
            id="skilltree-ladder-topic-input"
            type="text"
            className={"form-control form-control-sm" + (topicInputError ? " is-invalid" : "")}
            list="skilltree-ladder-topics"
            placeholder="Pick a topic or type a new one"
            autoComplete="off"
            spellCheck={false}
            value={topicInput}
            aria-invalid={topicInputError ? true : undefined}
            aria-describedby={topicInputError ? "skilltree-ladder-topic-error" : undefined}
            onChange={(e) => setTopicInput(e.target.value)}
            disabled={writing}
          />
          <button type="submit" className="btn btn-secondary btn-sm" disabled={writing}>
            Open
          </button>
        </div>
        <datalist id="skilltree-ladder-topics">
          {topics.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        {topicInputError && (
          <div id="skilltree-ladder-topic-error" className="invalid-feedback d-block">
            {topicInputError}
          </div>
        )}
      </form>
      {topics.length > 0 && (
        <ul className="skilltree-chips" aria-label="Existing topics">
          {topics.map((t) => (
            <li key={t}>
              <button
                type="button"
                className={"btn btn-sm " + (t === topic ? "btn-primary" : "btn-outline-secondary")}
                aria-pressed={t === topic}
                disabled={writing}
                onClick={() => openTopic(t)}
              >
                {t}
              </button>
            </li>
          ))}
        </ul>
      )}

      {topic === undefined ? (
        <p className="text-muted mb-0">Open a topic to see its levels and the tags on each.</p>
      ) : (
        <>
          <h4 className="skilltree-panel-subtitle">
            {topic} {!topics.includes(topic) && <span className="text-muted">(new topic)</span>}
          </h4>
          <ul className="skilltree-ladder">
            {rows.map((row, i) => {
              const neighbourEmpty = (j: number) => rows[j] === undefined || rows[j].tags.length === 0;
              const canUp = i > 0 && !(row.tags.length === 0 && neighbourEmpty(i - 1));
              const canDown = i < rows.length - 1 && !(row.tags.length === 0 && neighbourEmpty(i + 1));
              return (
                <li key={row.level} className="skilltree-ladder-level">
                  <div className="skilltree-ladder-head">
                    <h5>
                      Level {row.level}
                      {row.level === 0 && <span className="text-muted"> entry</span>}
                    </h5>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={!canUp || writing}
                      aria-label={`Move level ${row.level} up (swap with level ${row.level - 1})`}
                      onClick={() => update(swapLevels(ladder, row.level, row.level - 1))}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={!canDown || writing}
                      aria-label={`Move level ${row.level} down (swap with level ${row.level + 1})`}
                      onClick={() => update(swapLevels(ladder, row.level, row.level + 1))}
                    >
                      ↓
                    </button>
                  </div>
                  {row.tags.length === 0 ? (
                    <p className="text-muted small mb-1">No tags.</p>
                  ) : (
                    <ul className="skilltree-ladder-tags">
                      {row.tags.map((t) => (
                        <li key={t.id}>
                          <span className="skilltree-tag-name">{t.name}</span>
                          <span className="skilltree-tag-scenes">{t.sceneCount} sc.</span>
                          <button
                            type="button"
                            className="btn btn-link btn-sm skilltree-ladder-remove"
                            disabled={writing}
                            aria-label={`Remove ${t.name} from ${topic}`}
                            onClick={() => update(removeFromLadder(ladder, t.id))}
                          >
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {adding === row.level ? (
                    <AddTagSearch
                      level={row.level}
                      tags={tags}
                      ladder={ladder}
                      onAdd={(id) => {
                        update(addToLadder(ladder, id, row.level));
                        setAdding(undefined);
                      }}
                      onCancel={() => setAdding(undefined)}
                    />
                  ) : (
                    <button
                      type="button"
                      className="btn btn-link btn-sm p-0"
                      disabled={writing}
                      onClick={() => setAdding(row.level)}
                    >
                      Add tag to level {row.level}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>

          {warnings.length > 0 && (
            <ul className="skilltree-setup-warnings" aria-label="Warnings">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          <h4 className="skilltree-panel-subtitle">
            Pending changes <span className="skilltree-count">{changes.length}</span>
          </h4>
          {changes.length === 0 ? (
            <p className="text-muted">None.</p>
          ) : (
            <ul className="skilltree-pending">
              {changes.map((c) => {
                const t = byId.get(c.tagId);
                return (
                  <li key={c.tagId}>
                    <b>{t?.name ?? `Tag ${c.tagId}`}</b>
                    <ul className="skilltree-pending-lines">
                      {describeChange(t?.customFields, c.change).map((line) => (
                        <li key={line}>
                          <code>{line}</code>
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          )}

          {progress !== undefined ? (
            <div role="status" className="skilltree-progress-wrap">
              Writing {progress.done} of {progress.total}…
              <div className="progress skilltree-progress">
                <div
                  className="progress-bar"
                  role="progressbar"
                  aria-label="Writing tags"
                  aria-valuemin={0}
                  aria-valuemax={progress.total}
                  aria-valuenow={progress.done}
                  style={{ width: `${progress.total ? (100 * progress.done) / progress.total : 0}%` }}
                />
              </div>
            </div>
          ) : confirming ? (
            <div className="skilltree-confirm" role="group" aria-labelledby="skilltree-ladder-confirm">
              <span id="skilltree-ladder-confirm">
                Write {changes.length} tag{changes.length === 1 ? "" : "s"}?
              </span>
              <button type="button" className="btn btn-danger btn-sm" onClick={apply} autoFocus>
                Write
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="skilltree-editor-actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={changes.length === 0}
                onClick={() => setConfirming(true)}
              >
                Apply {changes.length} change{changes.length === 1 ? "" : "s"}…
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={changes.length === 0}
                onClick={() => {
                  setDraft(undefined);
                  setAdding(undefined);
                }}
              >
                Discard
              </button>
            </div>
          )}
        </>
      )}
      {status && "ok" in status && (
        <p className="skilltree-setup-ok mb-0" role="status">
          {status.ok}
        </p>
      )}
      {status && "error" in status && (
        <p className="text-danger mb-0" role="alert">
          {status.error}
        </p>
      )}
    </section>
  );
}

interface AddTagSearchProps {
  level: number;
  tags: SetupTag[];
  ladder: Ladder;
  onAdd: (tagId: Id) => void;
  onCancel: () => void;
}

function AddTagSearch(props: AddTagSearchProps) {
  const { level, tags, ladder, onAdd, onCancel } = props;
  const [query, setQuery] = React.useState("");
  const candidates = ladderCandidates(tags, ladder, query, 8);
  const id = `skilltree-ladder-add-${level}`;
  return (
    <div className="skilltree-ladder-add">
      <label htmlFor={id} className="small">
        Find a tag for level {level}
      </label>
      <div className="skilltree-inline">
        <input
          id={id}
          type="search"
          className="form-control form-control-sm"
          autoFocus
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
          }}
        />
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {candidates.length === 0 ? (
        <p className="text-muted small mb-0">No tag without another kind matches.</p>
      ) : (
        <ul className="skilltree-ladder-candidates" aria-label={`Tags to add to level ${level}`}>
          {candidates.map((t) => {
            const node = interestNode(t.customFields);
            return (
              <li key={t.id}>
                <button type="button" className="skilltree-tag-item" onClick={() => onAdd(t.id)}>
                  <span className="skilltree-tag-name">{t.name}</span>
                  {node && <span className="skilltree-tag-detail">moves from {node.topic}:{node.level}</span>}
                  <span className="skilltree-tag-scenes">{t.sceneCount} sc.</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
