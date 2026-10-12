// Series section of the Setup view: every stash group with a "Daily series"
// switch and the reset mode. Edits are drafts until saved; saving writes
// only st.series / st.reset of the changed groups (see seriesForm.ts).
import type { Id, SeriesReset } from "../core/types.ts";
import {
  SERIES_RESETS,
  isEmptyChange,
  stashUrl,
  updateGroupsFields,
  type FieldChange,
  type SetupGroup,
  type StashClient,
} from "../stash/index.ts";
import { describeChange } from "./setupForm.ts";
import {
  RESET_LABELS,
  diffSeriesForm,
  filterGroups,
  isSeriesGroup,
  seriesFormFromFields,
  seriesSummary,
  seriesWarnings,
  type GroupFilter,
  type SeriesForm,
} from "./seriesForm.ts";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Status = { ok: string } | { error: string };

export interface SeriesSetupPanelProps {
  groups: SetupGroup[];
  client: StashClient;
  /** called after a successful write; resolves once the group list is fresh */
  onSaved: () => Promise<void>;
}

interface PendingChange {
  group: SetupGroup;
  change: FieldChange;
}

export function SeriesSetupPanel(props: SeriesSetupPanelProps) {
  const { groups, client, onSaved } = props;
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<GroupFilter>(() => (groups.some(isSeriesGroup) ? "series" : "all"));
  // A draft belongs to one group object: a refreshed list (after a save)
  // brings new objects and so fresh forms from the saved fields.
  const [drafts, setDrafts] = React.useState<Map<Id, { group: SetupGroup; form: SeriesForm }>>(() => new Map());
  const [saving, setSaving] = React.useState<{ done: number; total: number } | undefined>(undefined);
  const [status, setStatus] = React.useState<Status | undefined>(undefined);

  const draftOf = (g: SetupGroup): SeriesForm | undefined => {
    const d = drafts.get(g.id);
    return d && d.group === g ? d.form : undefined;
  };
  const formOf = (g: SetupGroup): SeriesForm => draftOf(g) ?? seriesFormFromFields(g.customFields);
  const edit = (g: SetupGroup, form: SeriesForm) => {
    setDrafts((prev) => new Map(prev).set(g.id, { group: g, form }));
    setStatus(undefined);
  };

  const pending: PendingChange[] = [];
  for (const g of groups) {
    const form = draftOf(g);
    if (!form) continue;
    const change = diffSeriesForm(g.customFields, form);
    if (!isEmptyChange(change)) pending.push({ group: g, change });
  }

  const visible = React.useMemo(() => filterGroups(groups, query, filter), [groups, query, filter]);

  const save = async () => {
    if (pending.length === 0 || saving) return;
    setStatus(undefined);
    setSaving({ done: 0, total: pending.length });
    try {
      await updateGroupsFields(
        client,
        pending.map((p) => ({ groupId: p.group.id, change: p.change })),
        (done, total) => setSaving({ done, total }),
      );
      await onSaved();
      setDrafts(new Map());
      setStatus({ ok: "Saved." });
    } catch (err) {
      setStatus({ error: `Could not save: ${errorText(err)}` });
    } finally {
      setSaving(undefined);
    }
  };

  return (
    <section className="skilltree-panel skilltree-series-setup" aria-labelledby="skilltree-series-title">
      <h3 className="skilltree-panel-title" id="skilltree-series-title">
        Series
      </h3>
      <p className="text-muted small">
        A daily series is a stash group whose scenes are watched in their group order, one part per day. Missing a
        day either starts the series over or steps back one part per missed day. Writes{" "}
        <code>st.series</code> and <code>st.reset</code> on the group, nothing else.
      </p>
      <div className="skilltree-series-filters">
        <label htmlFor="skilltree-group-search" className="sr-only">
          Search groups
        </label>
        <input
          id="skilltree-group-search"
          type="search"
          className="form-control form-control-sm"
          placeholder="Search groups"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <fieldset>
          <legend className="sr-only">Show</legend>
          {(["series", "all"] as GroupFilter[]).map((f) => (
            <div key={f} className="custom-control custom-radio custom-control-inline">
              <input
                type="radio"
                id={`skilltree-group-filter-${f}`}
                name="skilltree-group-filter"
                className="custom-control-input"
                checked={filter === f}
                onChange={() => setFilter(f)}
              />
              <label className="custom-control-label" htmlFor={`skilltree-group-filter-${f}`}>
                {f === "series" ? "Series" : "All groups"}
              </label>
            </div>
          ))}
        </fieldset>
      </div>
      <p className="skilltree-scene-meta mb-1" aria-live="polite">
        {visible.length} of {groups.length} groups
      </p>
      {visible.length === 0 ? (
        <p className="text-muted mb-0">
          {groups.length === 0
            ? "There are no groups in stash yet."
            : filter === "series" && query === ""
              ? "No group is a series yet. Show all groups to start."
              : "No groups match."}
        </p>
      ) : (
        <ul className="skilltree-series-list">
          {visible.map((g) => (
            <li key={g.id}>
              <SeriesRow group={g} form={formOf(g)} edited={draftOf(g) !== undefined} disabled={saving !== undefined} onChange={(f) => edit(g, f)} />
            </li>
          ))}
        </ul>
      )}

      {pending.length > 0 && (
        <>
          <h4 className="skilltree-panel-subtitle">Will write</h4>
          <ul className="skilltree-pending">
            {pending.map((p) => (
              <li key={p.group.id}>
                <strong>{p.group.name}</strong>
                <ul className="skilltree-pending-lines">
                  {describeChange(p.group.customFields, p.change).map((line) => (
                    <li key={line}>
                      <code>{line}</code>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="skilltree-editor-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={pending.length === 0 || saving !== undefined}
          onClick={() => void save()}
        >
          {saving
            ? `Saving ${saving.done}/${saving.total}…`
            : pending.length > 0
              ? `Save ${pending.length} ${pending.length === 1 ? "group" : "groups"}`
              : "Save"}
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={drafts.size === 0 || saving !== undefined}
          onClick={() => {
            setDrafts(new Map());
            setStatus(undefined);
          }}
        >
          Revert
        </button>
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
    </section>
  );
}

function SeriesRow(props: {
  group: SetupGroup;
  form: SeriesForm;
  edited: boolean;
  disabled: boolean;
  onChange: (form: SeriesForm) => void;
}) {
  const { group, form, edited, disabled, onChange } = props;
  const id = `skilltree-series-${group.id.replace(/\W/g, "-")}`;
  const summary = seriesSummary(group.customFields);
  const warnings = seriesWarnings(group, form);
  return (
    <div className={"skilltree-series-row" + (edited ? " is-edited" : "")}>
      <div className="skilltree-series-name">
        <a href={stashUrl(`groups/${group.id}`)} className="skilltree-tag-name">
          {group.name}
        </a>
        {summary && <span className="skilltree-kind is-series">{summary}</span>}
        <span className="skilltree-tag-scenes">{group.sceneCount} sc.</span>
      </div>
      <div className="skilltree-series-controls">
        <div className="custom-control custom-switch">
          <input
            type="checkbox"
            className="custom-control-input"
            id={`${id}-daily`}
            checked={form.daily}
            disabled={disabled}
            onChange={(e) => onChange({ ...form, daily: e.target.checked })}
          />
          <label className="custom-control-label" htmlFor={`${id}-daily`}>
            Daily series
          </label>
        </div>
        <label className="sr-only" htmlFor={`${id}-reset`}>
          {`When a day is missed in ${group.name}`}
        </label>
        <select
          id={`${id}-reset`}
          className="custom-select custom-select-sm"
          value={form.reset}
          disabled={disabled || !form.daily}
          title="When a day is missed"
          onChange={(e) => onChange({ ...form, reset: e.target.value as SeriesReset })}
        >
          {SERIES_RESETS.map((r) => (
            <option key={r} value={r}>
              missed day: {RESET_LABELS[r]}
            </option>
          ))}
        </select>
      </div>
      {warnings.length > 0 && (
        <ul className="skilltree-setup-warnings">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
