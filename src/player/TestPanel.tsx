// The choice screen's test panel (Test mode toggle): find ANY scene in stash
// by tags (all must match), funscript, prompt markers and title, and start a
// test session on it (skilltree=test: every check runs, nothing is saved).
// Queries live in src/stash/testSearch.ts.
import type { ChangeEvent } from "react";
import { policyForScene } from "../play/index.ts";
import { stashUrl } from "../stash/client.ts";
import {
  EMPTY_CRITERIA,
  TEST_PER_PAGE,
  loadPromptTagIds,
  loadTagsByIds,
  pageCount,
  searchTags,
  searchTestScenes,
  type TagHit,
  type TestSceneResult,
  type TestSearchCriteria,
  type TestSearchPage,
} from "../stash/testSearch.ts";
import { wantsSensor, watchUrl } from "../session/watchUrl.ts";
import { connectSensorForClip } from "./useTrack.ts";
import { router } from "./api.ts";
import { EMPTY_TEST_LINK, type TestLink } from "./playLink.ts";
import { errorText } from "./common.tsx";
import { dateLabel, formatDuration, plural } from "./format.ts";
import { rangeLabel, testSceneChips } from "./testView.ts";
import type { PlayData } from "./usePlayData.ts";
import { policyLabel } from "./view.ts";

const DEBOUNCE_MS = 300;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

type Load<T> = { status: "idle" } | { status: "loading" } | { status: "ready"; value: T } | { status: "error"; error: string };

export function TestPanel(props: {
  data: PlayData;
  /** the search to start with (a deep link) */
  initial?: TestLink;
  /** the search changed (for the page's deep link) */
  onChange?: (link: TestLink) => void;
}) {
  const { data } = props;
  const client = data.client;
  const start = props.initial ?? EMPTY_TEST_LINK;
  // tags from a link carry only ids: shown by id until their names arrive
  const [tags, setTags] = React.useState<TagHit[]>(() => start.tags.map((id) => ({ id, name: `tag ${id}`, sceneCount: 0 })));
  const [funscript, setFunscript] = React.useState(start.funscript);
  const [promptMarkers, setPromptMarkers] = React.useState(start.prompts);
  const [titleInput, setTitleInput] = React.useState(start.title);
  const title = useDebounced(titleInput, DEBOUNCE_MS);
  React.useEffect(() => {
    if (start.tags.length === 0) return;
    let live = true;
    loadTagsByIds(client, start.tags).then(
      (named) => {
        if (!live) return;
        // keep the user's picks if they changed the tags meanwhile
        setTags((cur) => (cur.map((t) => t.id).join(",") === start.tags.join(",") ? named : cur));
      },
      () => undefined, // names stay "tag <id>"; the filter still works
    );
    return () => {
      live = false;
    };
  }, []);

  // prompt tag ids, once (needed for "has prompt markers")
  const [promptTags, setPromptTags] = React.useState<Load<string[]>>({ status: "idle" });
  React.useEffect(() => {
    if (!promptMarkers || promptTags.status !== "idle") return;
    setPromptTags({ status: "loading" });
    loadPromptTagIds(client).then(
      (value) => setPromptTags({ status: "ready", value }),
      (err: unknown) => setPromptTags({ status: "error", error: errorText(err) }),
    );
  }, [client, promptMarkers, promptTags.status]);

  const tagKey = tags.map((t) => t.id).join(",");
  // the page belongs to one filter: a new filter starts at page 1
  const filterKey = JSON.stringify([tagKey, funscript, promptMarkers, title]);
  const [paging, setPaging] = React.useState({ filterKey, page: start.page });
  const page = paging.filterKey === filterKey ? paging.page : 1;
  const setPage = (p: number) => setPaging({ filterKey, page: p });

  const criteria = React.useMemo<TestSearchCriteria>(
    () => ({ ...EMPTY_CRITERIA, tagIds: tagKey ? tagKey.split(",") : [], funscript, promptMarkers, title, page }),
    [tagKey, funscript, promptMarkers, title, page],
  );
  const onChange = React.useRef(props.onChange);
  onChange.current = props.onChange;
  React.useEffect(() => {
    onChange.current?.({ tags: tagKey ? tagKey.split(",") : [], funscript, prompts: promptMarkers, title, page });
  }, [tagKey, funscript, promptMarkers, title, page]);
  const promptIds = promptTags.status === "ready" ? promptTags.value : undefined;
  const [results, setResults] = React.useState<Load<TestSearchPage>>({ status: "idle" });
  const [searching, setSearching] = React.useState(false);
  React.useEffect(() => {
    if (criteria.promptMarkers && promptIds === undefined) return; // waits for the prompt tags
    let live = true;
    // the previous page stays up (dimmed) while the next one loads
    setResults((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
    setSearching(true);
    searchTestScenes(client, criteria, promptIds ?? []).then(
      (value) => {
        if (!live) return;
        setResults({ status: "ready", value });
        setSearching(false);
      },
      (err: unknown) => {
        if (!live) return;
        setResults({ status: "error", error: errorText(err) });
        setSearching(false);
      },
    );
    return () => {
      live = false;
    };
  }, [client, criteria, promptIds]);

  const count = results.status === "ready" ? results.value.count : 0;
  const pages = pageCount(count);

  return (
    <section className="stp-test" aria-labelledby="stp-test-title">
      <div className="stp-test-banner" role="note">
        <span className="stp-test-tag">TEST</span>
        <span id="stp-test-title" className="stp-strong">
          Test mode – everything is open, nothing is saved
        </span>
        <span className="stp-small stp-soft">
          Any scene in stash runs a full session (camera, prompts, track, flashes, locks). No coins, completions,
          exposure or payments are written.
        </span>
      </div>

      <div className="stp-test-filters">
        <TagPicker client={client} selected={tags} onChange={setTags} />
        <input
          type="search"
          className="stp-search"
          placeholder="Title contains"
          aria-label="Title contains"
          value={titleInput}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setTitleInput(e.target.value)}
        />
        <div className="stp-test-checks">
          <label className="stp-test-check">
            <input type="checkbox" checked={funscript} onChange={(e: ChangeEvent<HTMLInputElement>) => setFunscript(e.target.checked)} />
            has funscript
          </label>
          <label className="stp-test-check">
            <input
              type="checkbox"
              checked={promptMarkers}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setPromptMarkers(e.target.checked)}
            />
            has prompt markers
          </label>
        </div>
      </div>

      {promptMarkers && promptTags.status === "error" && (
        <p className="stp-error stp-small" role="alert">
          Could not load the prompt tags: {promptTags.error}
        </p>
      )}
      {promptMarkers && promptIds !== undefined && promptIds.length === 0 && (
        <p className="stp-muted stp-small">There are no tags with st.kind=prompt, so no scene has prompt markers.</p>
      )}

      {results.status === "error" ? (
        <p className="stp-error stp-small" role="alert">
          Could not search: {results.error}
        </p>
      ) : results.status !== "ready" ? (
        <p className="stp-muted stp-small" role="status">
          <span className="spinner-border spinner-border-sm mr-2" aria-hidden="true" />
          Searching…
        </p>
      ) : (
        <>
          <div className="stp-test-count stp-small stp-muted" role="status">
            {count === 0 ? "No scene matches." : `${rangeLabel(page, TEST_PER_PAGE, count)} · newest first`}
          </div>
          <ul className={`stp-test-results${searching ? " is-stale" : ""}`} aria-busy={searching}>
            {results.value.results.map((r) => (
              <TestResultRow key={r.scene.id} data={data} result={r} />
            ))}
          </ul>
          {pages > 1 && (
            <nav className="stp-test-pager" aria-label="Result pages">
              <button type="button" className="stp-btn stp-btn-outline stp-btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </button>
              <span className="stp-small stp-mono stp-muted">
                page {page} of {pages}
              </span>
              <button type="button" className="stp-btn stp-btn-outline stp-btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                Next
              </button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}

function TestResultRow(props: { data: PlayData; result: TestSceneResult }) {
  const { data } = props;
  const { scene, performers } = props.result;
  const { useHistory } = router();
  const history = useHistory();
  const [thumbOk, setThumbOk] = React.useState(true);
  const policy = React.useMemo(() => policyForScene(scene, data.policyTags), [scene, data.policyTags]);
  const chips = testSceneChips(
    scene,
    data.graph.sceneNodes.get(scene.id) ?? [],
    data.graph.scenes.has(scene.id) || data.library.scenes.some((s) => s.id === scene.id),
  );

  return (
    <li className="stp-test-row">
      <div className="stp-test-thumb">
        {thumbOk ? (
          <img src={stashUrl(`scene/${scene.id}/screenshot`)} alt="" loading="lazy" onError={() => setThumbOk(false)} />
        ) : null}
        {scene.durationSec > 0 && <span className="stp-duration stp-mono">{formatDuration(scene.durationSec)}</span>}
      </div>
      <div className="stp-test-body">
        <div className="stp-small stp-mono stp-muted">
          {dateLabel(scene.date)} · {policyLabel(policy)}
        </div>
        <div className="stp-test-title">{scene.title || `Scene ${scene.id}`}</div>
        {performers.length > 0 && <div className="stp-small stp-soft">{performers.map((p) => p.name).join(", ")}</div>}
        <div className="stp-chips">
          {chips.map((c) => (
            <span key={c.text} className={`stp-chip stp-test-chip is-${c.tone}`}>
              {c.text}
            </span>
          ))}
        </div>
      </div>
      <button
        type="button"
        className="stp-btn stp-btn-sm stp-test-go"
        onClick={() => {
          if (wantsSensor(scene, data.policyTags)) connectSensorForClip();
          history.push(watchUrl(scene.id, scene, data.policyTags, { test: true }));
        }}
      >
        Test
      </button>
    </li>
  );
}

/** Searchable tag picker: findTags by name (debounced), scene counts, several tags (all must match). */
function TagPicker(props: { client: PlayData["client"]; selected: TagHit[]; onChange: (tags: TagHit[]) => void }) {
  const { client, selected, onChange } = props;
  const [input, setInput] = React.useState("");
  const q = useDebounced(input.trim(), DEBOUNCE_MS);
  const [hits, setHits] = React.useState<Load<TagHit[]>>({ status: "idle" });
  React.useEffect(() => {
    if (q === "") {
      setHits({ status: "idle" });
      return;
    }
    let live = true;
    setHits({ status: "loading" });
    searchTags(client, q).then(
      (value) => {
        if (live) setHits({ status: "ready", value });
      },
      (err: unknown) => {
        if (live) setHits({ status: "error", error: errorText(err) });
      },
    );
    return () => {
      live = false;
    };
  }, [client, q]);

  const chosen = new Set(selected.map((t) => t.id));
  const add = (t: TagHit) => {
    if (!chosen.has(t.id)) onChange([...selected, t]);
    setInput("");
  };
  const options = hits.status === "ready" ? hits.value.filter((t) => !chosen.has(t.id)) : [];

  return (
    <div className="stp-test-tags">
      <input
        type="search"
        className="stp-search"
        placeholder="Add a tag (all must match)"
        aria-label="Find tags"
        value={input}
        onChange={(e: ChangeEvent<HTMLInputElement>) => setInput(e.target.value)}
      />
      {selected.length > 0 && (
        <div className="stp-chips" aria-label="Selected tags">
          {selected.map((t) => (
            <span key={t.id} className="stp-chip stp-test-selected">
              {t.name}
              <button
                type="button"
                className="stp-test-remove"
                aria-label={`Remove ${t.name}`}
                onClick={() => onChange(selected.filter((x) => x.id !== t.id))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {input.trim() !== "" && (
        <div className="stp-test-hits" role="listbox" aria-label="Matching tags">
          {hits.status === "loading" || hits.status === "idle" ? (
            <span className="stp-small stp-muted">Searching…</span>
          ) : hits.status === "error" ? (
            <span className="stp-small stp-error">Could not search tags: {hits.error}</span>
          ) : options.length === 0 ? (
            <span className="stp-small stp-muted">No tag matches “{input.trim()}”.</span>
          ) : (
            options.map((t) => (
              <button key={t.id} type="button" role="option" aria-selected={false} className="stp-test-hit" onClick={() => add(t)}>
                <span>{t.name}</span>
                <span className="stp-small stp-mono stp-muted">{plural(t.sceneCount, "scene")}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
