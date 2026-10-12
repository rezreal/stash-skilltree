// Tag list and editor of the Setup section: search every tag, pick one,
// edit the st.* fields of its kind, save. Player-written and unknown st.*
// keys are shown read-only; only config keys are ever written.
import type { RefObject } from "react";
import type { Id } from "../core/types.ts";
import { isEmptyChange, stashUrl, updateTagFields, type SetupTag, type StashClient } from "../stash/index.ts";
import {
  SETUP_KINDS,
  activeFields,
  describeChange,
  diffForm,
  filterTags,
  formFromFields,
  isConfigured,
  isValid,
  listTokens,
  opensAfter,
  readOnlyFields,
  setupContext,
  tagSummary,
  toggleListToken,
  validateForm,
  withKind,
  withValue,
  type FieldSpec,
  type SetupContext,
  type SetupForm,
  type SetupKind,
  type TagFilter,
} from "./setupForm.ts";

/** rows rendered before "Show all" */
const LIST_LIMIT = 200;

const KIND_LABELS: Record<SetupKind, string> = {
  none: "none (not in the tree)",
  interest: "interest (a level of a topic)",
  trigger: "trigger",
  policy: "policy (watch rules)",
  prompt: "prompt (marker check)",
  "auto-marker": "auto-marker",
  replay: "replay (marker override)",
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Status = { ok: string } | { error: string };

export interface TagSetupPanelProps {
  tags: SetupTag[];
  client: StashClient;
  /** the tag the URL names: an id opens it in the editor, null closes the editor, undefined leaves it */
  want?: Id | null;
  /** the viewer opened another tag (it goes into the URL); not called for `want` itself */
  onSelect?: (id: Id | undefined) => void;
  /** called after a successful write; resolves once the tag list is fresh */
  onSaved: () => Promise<void>;
}

export function TagSetupPanel(props: TagSetupPanelProps) {
  const { tags, client, want, onSaved } = props;
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<TagFilter>(() => (tags.some(isConfigured) ? "configured" : "all"));
  const [showAll, setShowAll] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<Id | undefined>(undefined);
  // The draft belongs to one tag object: a refreshed tag list (after a save)
  // brings new objects and so a fresh form from the saved fields.
  const [draft, setDraft] = React.useState<{ tag: SetupTag; form: SetupForm } | undefined>(undefined);
  const [saving, setSaving] = React.useState(false);
  const [status, setStatus] = React.useState<Status | undefined>(undefined);
  const editorHeading = React.useRef<HTMLHeadingElement>(null);

  const tag = selectedId !== undefined ? tags.find((t) => t.id === selectedId) : undefined;
  const form = tag ? (draft && draft.tag === tag ? draft.form : formFromFields(tag.customFields)) : undefined;
  const edited = tag !== undefined && draft !== undefined && draft.tag === tag;
  const change = tag && form ? diffForm(tag.customFields, form) : undefined;
  const dirty = change !== undefined && !isEmptyChange(change);
  const edit = (f: SetupForm) => {
    if (tag) setDraft({ tag, form: f });
  };

  const select = (id: Id) => {
    if (id === selectedId) {
      editorHeading.current?.focus();
      return;
    }
    if (edited && dirty && tag && !window.confirm(`Discard unsaved changes to "${tag.name}"?`)) return;
    setSelectedId(id);
    setDraft(undefined);
    setStatus(undefined);
  };

  // follow the URL (a link, back / forward); select itself changes every render
  React.useEffect(() => {
    if (want === undefined) return;
    if (want === null) {
      if (selectedId === undefined) return;
      if (edited && dirty && tag && !window.confirm(`Discard unsaved changes to "${tag.name}"?`)) return;
      setSelectedId(undefined);
      setDraft(undefined);
      setStatus(undefined);
    } else if (want !== selectedId) {
      select(want);
    }
  }, [want]);

  const reported = React.useRef(selectedId);
  React.useEffect(() => {
    if (selectedId !== undefined) editorHeading.current?.focus();
    if (selectedId === reported.current) return;
    reported.current = selectedId;
    props.onSelect?.(selectedId);
  }, [selectedId]);

  const filtered = React.useMemo(() => filterTags(tags, query, filter), [tags, query, filter]);
  const visible = showAll ? filtered : filtered.slice(0, LIST_LIMIT);
  const ctx = React.useMemo(() => setupContext(tags, selectedId), [tags, selectedId]);

  const save = async () => {
    if (!tag || !change || isEmptyChange(change)) return;
    setSaving(true);
    setStatus(undefined);
    try {
      await updateTagFields(client, tag.id, change);
      await onSaved();
      setDraft(undefined);
      setStatus({ ok: "Saved." });
    } catch (err) {
      setStatus({ error: `Could not save: ${errorText(err)}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="skilltree-setup">
      <section className="skilltree-panel skilltree-setup-list" aria-labelledby="skilltree-setup-list-title">
        <h3 className="skilltree-panel-title" id="skilltree-setup-list-title">
          Tags
        </h3>
        <div className="form-group mb-2">
          <label htmlFor="skilltree-tag-search" className="sr-only">
            Search tags
          </label>
          <input
            id="skilltree-tag-search"
            type="search"
            className="form-control form-control-sm"
            placeholder="Search name or alias"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <fieldset className="mb-2">
          <legend className="sr-only">Show</legend>
          {(["configured", "all"] as TagFilter[]).map((f) => (
            <div key={f} className="custom-control custom-radio custom-control-inline">
              <input
                type="radio"
                id={`skilltree-tag-filter-${f}`}
                name="skilltree-tag-filter"
                className="custom-control-input"
                checked={filter === f}
                onChange={() => setFilter(f)}
              />
              <label className="custom-control-label" htmlFor={`skilltree-tag-filter-${f}`}>
                {f === "configured" ? "Configured" : "All tags"}
              </label>
            </div>
          ))}
        </fieldset>
        <p className="skilltree-scene-meta mb-1" aria-live="polite">
          {filtered.length} of {tags.length} tags
        </p>
        {filtered.length === 0 ? (
          <p className="text-muted mb-0">
            {filter === "configured" && query === "" ? "No tag has an st.kind yet. Show all tags to start." : "No tags match."}
          </p>
        ) : (
          <ul className="skilltree-taglist">
            {visible.map((t) => (
              <li key={t.id}>
                <TagListItem tag={t} selected={t.id === selectedId} onSelect={select} />
              </li>
            ))}
          </ul>
        )}
        {!showAll && filtered.length > LIST_LIMIT && (
          <button type="button" className="btn btn-link btn-sm" onClick={() => setShowAll(true)}>
            Show all {filtered.length}
          </button>
        )}
      </section>

      <section className="skilltree-panel skilltree-editor" aria-labelledby="skilltree-editor-title">
        {tag && form && change ? (
          <TagEditor
            tag={tag}
            form={form}
            ctx={ctx}
            dirty={dirty}
            saving={saving}
            status={status}
            headingRef={editorHeading}
            onChange={edit}
            onSave={save}
            onRevert={() => {
              setDraft(undefined);
              setStatus(undefined);
            }}
            pending={describeChange(tag.customFields, change)}
          />
        ) : (
          <>
            <h3 className="skilltree-panel-title" id="skilltree-editor-title" ref={editorHeading} tabIndex={-1}>
              Edit tag
            </h3>
            <p className="text-muted mb-0">Pick a tag from the list to configure its role in the tree.</p>
          </>
        )}
      </section>
    </div>
  );
}

function TagListItem(props: { tag: SetupTag; selected: boolean; onSelect: (id: Id) => void }) {
  const { tag, selected, onSelect } = props;
  const summary = tagSummary(tag.customFields);
  return (
    <button
      type="button"
      className={"skilltree-tag-item" + (selected ? " is-selected" : "")}
      aria-pressed={selected}
      onClick={() => onSelect(tag.id)}
    >
      <span className="skilltree-tag-name">{tag.name}</span>
      {summary.kind && <span className={`skilltree-kind is-${summary.kind.replace(/[^a-z-]/g, "")}`}>{summary.kind}</span>}
      {summary.detail && <span className="skilltree-tag-detail">{summary.detail}</span>}
      <span className="skilltree-tag-scenes">{tag.sceneCount} sc.</span>
      {tag.aliases.length > 0 && <span className="skilltree-tag-aliases">{tag.aliases.join(", ")}</span>}
    </button>
  );
}

interface TagEditorProps {
  tag: SetupTag;
  form: SetupForm;
  ctx: SetupContext;
  dirty: boolean;
  saving: boolean;
  status?: Status;
  headingRef: RefObject<HTMLHeadingElement>;
  pending: string[];
  onChange: (form: SetupForm) => void;
  onSave: () => void;
  onRevert: () => void;
}

function TagEditor(props: TagEditorProps) {
  const { tag, form, ctx, dirty, saving, status, headingRef, pending, onChange, onSave, onRevert } = props;
  const validation = validateForm(form, ctx);
  const valid = isValid(validation);
  const readOnly = readOnlyFields(tag.customFields);
  const kindOptions: string[] = [...SETUP_KINDS];

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && valid && !saving) onSave();
      }}
    >
      <h3 className="skilltree-panel-title" id="skilltree-editor-title" ref={headingRef} tabIndex={-1}>
        {tag.name}
      </h3>
      <p className="skilltree-scene-meta">
        {[tag.aliases.length > 0 ? `aka ${tag.aliases.join(", ")}` : undefined, `${tag.sceneCount} scenes`]
          .filter(Boolean)
          .join(" · ")}{" "}
        · <a href={stashUrl(`tags/${tag.id}`)}>open in stash</a>
      </p>

      <div className="form-group">
        <label htmlFor="skilltree-field-kind">
          Kind <code className="skilltree-field-key">st.kind</code>
        </label>
        <select
          id="skilltree-field-kind"
          className="custom-select custom-select-sm"
          value={form.kind}
          onChange={(e) => onChange(withKind(form, e.target.value as SetupKind))}
        >
          {kindOptions.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k as SetupKind]}
            </option>
          ))}
        </select>
      </div>

      {activeFields(form).map((spec) => (
        <Field
          key={spec.key}
          spec={spec}
          form={form}
          ctx={ctx}
          error={validation.errors[spec.key]}
          onChange={(text) => onChange(withValue(form, spec.key, text))}
        />
      ))}

      {validation.warnings.length > 0 && (
        <ul className="skilltree-setup-warnings" aria-label="Warnings">
          {validation.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {readOnly.length > 0 && (
        <>
          <h4 className="skilltree-panel-subtitle">Not edited here</h4>
          <dl className="skilltree-facts skilltree-readonly">
            {readOnly.map((f) => (
              <React.Fragment key={f.key}>
                <dt>
                  <code>{f.key}</code>
                </dt>
                <dd>
                  {f.value}
                  <span className="text-muted">{f.player ? " (written by the player)" : " (unknown key, kept)"}</span>
                </dd>
              </React.Fragment>
            ))}
          </dl>
        </>
      )}

      {dirty && (
        <>
          <h4 className="skilltree-panel-subtitle">Will write</h4>
          <ul className="skilltree-pending-lines">
            {pending.map((line) => (
              <li key={line}>
                <code>{line}</code>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="skilltree-editor-actions">
        <button type="submit" className="btn btn-primary btn-sm" disabled={!dirty || !valid || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={!dirty || saving} onClick={onRevert}>
          Revert
        </button>
        {!valid && dirty && <span className="text-muted small">Fix the marked fields to save.</span>}
      </div>
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
    </form>
  );
}

interface FieldProps {
  spec: FieldSpec;
  form: SetupForm;
  ctx: SetupContext;
  error?: string;
  onChange: (text: string) => void;
}

function Field(props: FieldProps) {
  const { spec, form, ctx, error, onChange } = props;
  const value = form.values[spec.key] ?? "";
  const id = `skilltree-field-${spec.key.replace(/\W/g, "-")}`;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const previewId = `${id}-preview`;
  const preview = spec.type === "requirement" && !error ? opensAfter(form) : undefined;
  const describedBy = [error ? errorId : "", spec.help ? helpId : "", preview !== undefined ? previewId : ""]
    .filter(Boolean)
    .join(" ") || undefined;
  const label = (
    <>
      {spec.label} <code className="skilltree-field-key">{spec.key}</code>
      {spec.required && <span className="sr-only"> (required)</span>}
    </>
  );
  const help = spec.help && (
    <small id={helpId} className="form-text text-muted">
      {spec.help}
    </small>
  );
  const errorLine = error && (
    <div id={errorId} className="invalid-feedback d-block">
      {error}
    </div>
  );

  if (spec.type === "list") {
    const tokens = listTokens(value);
    return (
      <fieldset className="form-group" aria-describedby={describedBy}>
        <legend className="col-form-label pt-0">{label}</legend>
        {(spec.options ?? []).map((opt) => {
          const optHelp = spec.optionHelp?.[opt];
          return (
            <div
              key={opt}
              className={"custom-control custom-checkbox" + (optHelp ? " skilltree-option" : " custom-control-inline")}
            >
              <input
                type="checkbox"
                className={"custom-control-input" + (error ? " is-invalid" : "")}
                id={`${id}-${opt}`}
                checked={tokens.includes(opt)}
                aria-describedby={optHelp ? `${id}-${opt}-help` : undefined}
                onChange={(e) => onChange(toggleListToken(value, opt, e.target.checked))}
              />
              <label className="custom-control-label" htmlFor={`${id}-${opt}`}>
                {opt}
              </label>
              {optHelp && (
                <small id={`${id}-${opt}-help`} className="form-text text-muted skilltree-option-help">
                  {optHelp}
                </small>
              )}
            </div>
          );
        })}
        {errorLine}
        {help}
      </fieldset>
    );
  }

  if (spec.type === "choice") {
    const options = [...(spec.options ?? [])];
    const unknown = value !== "" && !options.includes(value);
    return (
      <div className="form-group">
        <label htmlFor={id}>{label}</label>
        <select
          id={id}
          className={"custom-select custom-select-sm" + (error ? " is-invalid" : "")}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          aria-required={spec.required || undefined}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">{spec.required ? "Choose…" : "—"}</option>
          {unknown && <option value={value}>{value} (unknown)</option>}
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        {spec.optionHelp?.[value] && <small className="form-text text-muted skilltree-option-help">{spec.optionHelp[value]}</small>}
        {errorLine}
        {help}
      </div>
    );
  }

  const numeric = spec.type === "int" || spec.type === "number";
  const isTopic = spec.key === "st.topic";
  return (
    <div className="form-group">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        className={"form-control form-control-sm" + (error ? " is-invalid" : "")}
        value={value}
        inputMode={spec.type === "int" ? "numeric" : spec.type === "number" ? "decimal" : undefined}
        spellCheck={numeric || spec.type === "requirement" || isTopic ? false : undefined}
        autoComplete="off"
        list={isTopic ? "skilltree-topic-options" : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        aria-required={spec.required || undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {isTopic && (
        <datalist id="skilltree-topic-options">
          {[...ctx.levels.keys()].map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      )}
      {errorLine}
      {preview !== undefined && (
        <div id={previewId} className="skilltree-requires-preview" aria-live="polite">
          Opens after: {preview}
        </div>
      )}
      {help}
    </div>
  );
}
