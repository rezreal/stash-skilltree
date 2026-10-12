// /skilltree/play: pick a performer, then choose the next clip from
// one or two suggestions (continue / explore / earn). Daily series sit above
// them as their own cards.
import type { ChangeEvent } from "react";
import type { Id } from "../core/types.ts";
import { parseNodeKey, topicDepth } from "../core/index.ts";
import { stashUrl } from "../stash/client.ts";
import { dailySeriesCards, localDayOf, payForNode, policyForScene, startPerformers, suggest } from "../play/index.ts";
import type { DailySeriesCard } from "../play/index.ts";
import type { Streak, Suggestion, SuggestionResult } from "../play/types.ts";
import { router } from "./api.ts";
import {
  AUTHOR_ROUTE,
  Balance,
  CoinIcon,
  DataGate,
  LockIcon,
  RefreshLine,
  TreeIcon,
  errorText,
} from "./common.tsx";
import { watchUrl } from "../session/watchUrl.ts";
import { dateLabel, formatDuration, formatFactor, formatSignedCoins, nodeLabel, plural, topicLabel } from "./format.ts";
import { GazeStatusChip } from "./GazeStatusChip.tsx";
import { PerformerAvatar } from "./PerformerAvatar.tsx";
import { loadCurrentPerformer, saveCurrentPerformer } from "./storage.ts";
import { usePlayData, type PlayData } from "./usePlayData.ts";
import { fogDepthRows } from "../ui/fogView.ts";
import {
  KIND_LABEL,
  blockedText,
  chronologyText,
  checkChips,
  costBadge,
  earnText,
  ledgerAmount,
  ledgerLabel,
  reasonsText,
  recentEntries,
  runLabel,
  seriesPartLabel,
  seriesStateView,
  watchButtonLabel,
} from "./view.ts";

export function ChoiceScreen() {
  const { state, reload } = usePlayData();
  return (
    <DataGate state={state} onRetry={() => void reload()}>
      {() =>
        state.status === "ready" ? (
          <ChoiceView
            data={state.data}
            refreshing={state.refreshing}
            refreshError={state.refreshError}
            reload={reload}
          />
        ) : null
      }
    </DataGate>
  );
}

interface ChoiceViewProps {
  data: PlayData;
  refreshing?: string;
  refreshError?: string;
  reload: () => Promise<void>;
}

function ChoiceView(props: ChoiceViewProps) {
  const { data, reload } = props;
  const [stored, setStored] = React.useState<Id | undefined>(() => loadCurrentPerformer());
  const performerId = stored !== undefined && data.graph.performers.has(stored) ? stored : undefined;
  const choosePerformer = React.useCallback((id: Id | undefined) => {
    saveCurrentPerformer(id);
    setStored(id);
    window.scrollTo?.(0, 0);
  }, []);

  // daily series change at the day boundary: suggestions follow the day,
  // cards the clock
  const now = useNow(30_000);
  const today = localDayOf(new Date(now), data.dayStartHour);
  const baseInput = React.useMemo(
    () => ({
      graph: data.graph,
      progress: data.progress,
      visibility: data.visibility,
      library: data.library,
      policyTags: data.policyTags,
      ledger: data.ledger,
      streak: data.streak,
      edges: data.edges,
      now: new Date(),
      dayStartHour: data.dayStartHour,
    }),
    [data, today],
  );
  const result = React.useMemo(
    () => (performerId !== undefined ? suggest({ ...baseInput, performerId, max: 2 }) : undefined),
    [baseInput, performerId],
  );
  const seriesCards = React.useMemo(
    () =>
      dailySeriesCards({
        library: data.library,
        ledger: data.ledger,
        now: new Date(now),
        dayStartHour: data.dayStartHour,
        reach: { graph: baseInput.graph, progress: baseInput.progress, edges: baseInput.edges },
      }),
    [data, now, baseInput],
  );

  return (
    <div className="skilltree-play">
      <PlayHeader balance={data.ledger.balance} streak={data.streak} />
      <RefreshLine refreshing={props.refreshing} refreshError={props.refreshError} onRetry={() => void reload()} />
      <main className="stp-main">
        <section className="stp-primary" aria-label={performerId ? "Suggestions" : "Start"}>
          {performerId === undefined || result === undefined ? (
            <StartView data={data} baseInput={baseInput} seriesCards={seriesCards} onPick={choosePerformer} />
          ) : (
            <NextView
              data={data}
              performerId={performerId}
              result={result}
              seriesCards={seriesCards}
              reload={reload}
              onPick={choosePerformer}
            />
          )}
        </section>
        <Sidebar data={data} options={result?.options ?? []} />
      </main>
    </div>
  );
}

function PlayHeader(props: { balance: number; streak: Streak }) {
  const { Link } = router();
  const { streak } = props;
  return (
    <header className="stp-header">
      <div className="stp-brand">
        <span className="stp-brand-icon">
          <TreeIcon />
        </span>
        Skilltree
      </div>
      <nav className="stp-nav" aria-label="Skilltree">
        <span className="stp-nav-item is-active" aria-current="page">
          Play
        </span>
        <Link to={AUTHOR_ROUTE} className="stp-nav-item">
          Tree
        </Link>
      </nav>
      <div className="stp-spacer" />
      <GazeStatusChip />
      <div className={`stp-streak${streak.activeToday ? " is-active" : ""}`} title={streak.activeToday ? "You watched today" : "Watch a clip today to keep the streak"}>
        <span className="stp-dot" aria-hidden="true" />
        {streak.days > 0 ? `Streak · ${plural(streak.days, "day")}` : "No streak yet"}
        {streak.bonus > 1 ? <span className="stp-mono"> {formatFactor(streak.bonus)}</span> : null}
      </div>
      <Balance balance={props.balance} />
    </header>
  );
}

// --- start: pick a performer ------------------------------------------------------

type BaseInput = Omit<Parameters<typeof suggest>[0], "performerId" | "max">;

function StartView(props: {
  data: PlayData;
  baseInput: BaseInput;
  seriesCards: DailySeriesCard[];
  onPick: (id: Id) => void;
}) {
  const { data } = props;
  const { Link } = router();
  const [query, setQuery] = React.useState("");
  const starts = React.useMemo(() => startPerformers(props.baseInput), [props.baseInput]);
  const q = query.trim().toLowerCase();
  const name = (id: Id) => data.graph.performers.get(id)?.name ?? `Performer ${id}`;
  const shown = starts.filter((s) => q === "" || name(s.performerId).toLowerCase().includes(q));

  return (
    <>
      <div className="stp-heading-row">
        <h1 className="stp-h1">Who do you start with?</h1>
      </div>
      <p className="stp-lead">
        Pick a performer. Suggestions follow their scenes in date order; levels you reach count for every performer.
      </p>
      <SeriesSection data={data} cards={props.seriesCards} />
      {starts.length === 0 ? (
        <div className="stp-notice">
          <span>
            There are no entry scenes yet. Give tags <code>st.kind=interest</code>, a topic and level 0 in the{" "}
            <Link to={AUTHOR_ROUTE}>tree</Link> to begin.
          </span>
        </div>
      ) : (
        <>
          <input
            type="search"
            className="stp-search"
            placeholder="Search performers"
            aria-label="Search performers"
            value={query}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
          />
          {shown.length === 0 ? (
            <p className="stp-muted">No performer matches “{query}”.</p>
          ) : (
            <div className="stp-performer-grid">
              {shown.map((s) => (
                <button key={s.performerId} type="button" className="stp-performer-card" onClick={() => props.onPick(s.performerId)}>
                  <span className="stp-performer-head">
                    <PerformerAvatar performerId={s.performerId} name={name(s.performerId)} size={52} />
                    <span className="stp-performer-name">{name(s.performerId)}</span>
                  </span>
                  <span className="stp-chips">
                    {s.topics.map((t) => (
                      <span key={t} className="stp-chip">
                        {topicLabel(t)}
                      </span>
                    ))}
                  </span>
                  <span className="stp-small stp-muted">
                    {plural(s.entryScenes, "entry scene")}
                    {s.firstDate ? ` · from ${s.firstDate}` : ""}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

// --- what next ---------------------------------------------------------------------

interface NextViewProps {
  data: PlayData;
  performerId: Id;
  result: SuggestionResult;
  seriesCards: DailySeriesCard[];
  reload: () => Promise<void>;
  onPick: (id: Id | undefined) => void;
}

function NextView(props: NextViewProps) {
  const { data, performerId, result } = props;
  const name = (id: Id) => data.graph.performers.get(id)?.name ?? `Performer ${id}`;

  return (
    <>
      <div className="stp-heading-row">
        <h1 className="stp-h1">What next?</h1>
        <span className="stp-pill">with {name(performerId)}</span>
        <button type="button" className="stp-link-btn" onClick={() => props.onPick(undefined)}>
          All performers
        </button>
      </div>

      {result.blocked && (
        <div className="stp-notice" role="note">
          <span className="stp-notice-icon">
            <LockIcon />
          </span>
          <span>{blockedText(result.blocked)}</span>
        </div>
      )}

      {result.chronology && (
        <div className="stp-notice" role="note">
          <span className="stp-notice-icon">
            <LockIcon />
          </span>
          <span>
            {chronologyText(result.chronology, name(result.chronology.performerId), (id) => data.graph.scenes.get(id)?.title || undefined)}
          </span>
        </div>
      )}

      <SeriesSection data={data} cards={props.seriesCards} />

      {result.options.length === 0 ? (
        <p className="stp-muted">
          Nothing to suggest with {name(performerId)} right now. Switch performer below or open the tree to see what is
          ahead.
        </p>
      ) : (
        <div className="stp-options">
          {result.options.map((o, i) => (
            <SuggestionCard key={`${o.sceneId}-${o.node}`} data={data} option={o} num={i + 1} reload={props.reload} />
          ))}
        </div>
      )}

      {result.switches.length > 0 && (
        <div className="stp-switch">
          <div className="stp-switch-head">
            <h2 className="stp-h2">Or switch performer</h2>
            <span className="stp-small stp-muted">Ranked by overlap with the topics you are in</span>
          </div>
          <div className="stp-switch-grid">
            {result.switches.map((s) => (
              <button key={s.performerId} type="button" className="stp-switch-card" onClick={() => props.onPick(s.performerId)}>
                <span className="stp-performer-head">
                  <PerformerAvatar performerId={s.performerId} name={name(s.performerId)} size={40} />
                  <span className="stp-performer-name">{name(s.performerId)}</span>
                </span>
                {s.sharedTopics.length > 0 && (
                  <span className="stp-small stp-muted">Shares {s.sharedTopics.map(topicLabel).join(", ")}</span>
                )}
                <span className="stp-small stp-orange">{plural(s.openScenes, "open scene")}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function SuggestionCard(props: { data: PlayData; option: Suggestion; num: number; reload: () => Promise<void> }) {
  const { data, option: o } = props;
  const { Link, useHistory } = router();
  const history = useHistory();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [thumbOk, setThumbOk] = React.useState(true);

  const scene = data.graph.scenes.get(o.sceneId);
  const node = data.graph.nodes.get(o.node);
  const policy = React.useMemo(() => (scene ? policyForScene(scene, data.policyTags) : undefined), [scene, data.policyTags]);
  const chips = scene && policy ? checkChips(policy, scene.markers) : [];
  const badge = costBadge(o);
  const reasons = reasonsText(o.reasons);
  const cantPay = o.price > data.ledger.balance;

  const payAndWatch = async () => {
    if (!node || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await payForNode(data.client, node.tagIds, o.price, new Date().toISOString());
      await props.reload();
      history.push(watchUrl(o.sceneId, scene, data.policyTags));
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <article className={`stp-card is-${o.kind}`}>
      <div className="stp-thumb">
        {thumbOk ? (
          <img src={stashUrl(`scene/${o.sceneId}/screenshot`)} alt="" loading="lazy" onError={() => setThumbOk(false)} />
        ) : null}
        <span className={`stp-kind is-${o.kind}`}>
          {props.num} · {KIND_LABEL[o.kind]}
        </span>
        {badge && (
          <span className="stp-cost">
            <CoinIcon size={14} strokeWidth={2.4} />
            {badge}
          </span>
        )}
        {scene && <span className="stp-duration stp-mono">{formatDuration(scene.durationSec)}</span>}
      </div>
      <div className="stp-card-body">
        <div className="stp-card-titles">
          <div className="stp-small stp-mono stp-muted">
            {nodeLabel(o.node)} · {dateLabel(scene?.date)}
          </div>
          <h2 className="stp-card-title">{scene?.title || `Scene ${o.sceneId}`}</h2>
        </div>
        {chips.length > 0 && (
          <div className="stp-chips">
            {chips.map((c) => (
              <span key={c} className="stp-chip">
                {c}
              </span>
            ))}
          </div>
        )}
        {reasons && <p className="stp-reasons">{reasons}</p>}
        <div className="stp-earns">
          <CoinIcon size={14} strokeWidth={2.4} />
          {earnText(o)}
        </div>
        <div className="stp-grow" />
        {error && (
          <p className="stp-error stp-small" role="alert">
            Could not pay: {error}
          </p>
        )}
        {o.price > 0 ? (
          <button
            type="button"
            className={`stp-btn stp-btn-${o.kind === "earn" ? "gold" : "orange"}`}
            disabled={busy || cantPay || !node}
            onClick={() => void payAndWatch()}
          >
            {busy ? "Paying…" : cantPay ? `Needs ${o.price} stashcoins` : watchButtonLabel(o)}
          </button>
        ) : (
          <Link to={watchUrl(o.sceneId, scene, data.policyTags)} className={`stp-btn stp-btn-${o.kind === "earn" ? "gold" : "orange"}`}>
            {watchButtonLabel(o)}
          </Link>
        )}
      </div>
    </article>
  );
}

// --- daily series --------------------------------------------------------------------

/** Current time in ms, refreshed every `intervalMs`. */
function useNow(intervalMs: number): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function SeriesSection(props: { data: PlayData; cards: DailySeriesCard[] }) {
  if (props.cards.length === 0) return null;
  return (
    <section className="stp-series" aria-labelledby="stp-series-title">
      <h2 className="stp-h2" id="stp-series-title">
        Daily series
      </h2>
      <div className="stp-series-list">
        {props.cards.map((c) => (
          <SeriesCard key={c.series.groupId} data={props.data} card={c} />
        ))}
      </div>
    </section>
  );
}

function SeriesCard(props: { data: PlayData; card: DailySeriesCard }) {
  const { data, card } = props;
  const { series, status } = card;
  const { Link } = router();
  const [thumbOk, setThumbOk] = React.useState(true);
  // the countdown ticks every second; other states only need the minute
  const nowMs = useNow(status.state === "due" ? 1000 : 60_000);
  const next = status.nextPart;
  if (!next) return null;
  const scene = data.graph.scenes.get(next.sceneId);
  const view = seriesStateView(series, status, nowMs);

  return (
    <article className={`stp-series-card is-${status.state}`}>
      <div className="stp-series-thumb">
        {thumbOk ? (
          <img src={stashUrl(`scene/${next.sceneId}/screenshot`)} alt="" loading="lazy" onError={() => setThumbOk(false)} />
        ) : null}
        {scene && <span className="stp-duration stp-mono">{formatDuration(scene.durationSec)}</span>}
      </div>
      <div className="stp-series-body">
        <div className="stp-small stp-mono stp-muted">
          {seriesPartLabel(status, series.parts.length)} · {runLabel(status.run)}
        </div>
        <h3 className="stp-card-title">{series.name}</h3>
        {scene?.title ? <div className="stp-small stp-soft stp-series-scene">{scene.title}</div> : null}
        <div className={`stp-series-state stp-tone-${view.tone}`}>
          {view.text}
          {view.countdown !== undefined && (
            <span className="stp-mono stp-series-countdown" title={`Deadline ${status.deadline ?? ""}`}>
              {" "}
              · {view.countdown}
            </span>
          )}
        </div>
        {card.spendCost > 0 && (
          <div className="stp-earns">
            <CoinIcon size={14} strokeWidth={2.4} />
            asks you to spend {card.spendCost}
          </div>
        )}
      </div>
      {status.state !== "done-today" && (
        <div className="stp-series-action">
          {card.affordable ? (
            <Link to={watchUrl(next.sceneId, scene, data.policyTags)} className="stp-btn stp-btn-orange">
              Watch
            </Link>
          ) : (
            <button type="button" className="stp-btn stp-btn-orange" disabled>
              Needs {card.spendCost} stashcoins
            </button>
          )}
        </div>
      )}
    </article>
  );
}

// --- sidebar -------------------------------------------------------------------------

function Sidebar(props: { data: PlayData; options: Suggestion[] }) {
  const { data } = props;
  const { Link } = router();
  const rows = React.useMemo(
    // only topics the player has entered, levels up to the reached one + 1
    () => fogDepthRows(data.graph, data.progress, data.visibility, (t) => topicDepth(data.graph, data.progress, t)),
    [data],
  );
  const recent = recentEntries(data.ledger.entries);
  const hintFor = (topic: string) => {
    const nums = props.options
      .map((o, i) => (parseNodeKey(o.node)?.topic === topic ? String(i + 1) : undefined))
      .filter((n) => n !== undefined);
    return nums.length > 0 ? `← ${nums.join(" · ")}` : "";
  };

  return (
    <aside className="stp-side" aria-label="Your progress">
      <div className="stp-panel">
        <div className="stp-panel-head">
          <h2 className="stp-h3">Your depth</h2>
          <Link to={AUTHOR_ROUTE} className="stp-small stp-orange">
            Open tree
          </Link>
        </div>
        {rows.length === 0 ? (
          <p className="stp-muted stp-small">No topics yet.</p>
        ) : (
          rows.map((r) => (
            <div key={r.topic} className="stp-depth-row">
              <div className="stp-depth-head">
                <span>
                  {topicLabel(r.topic)} <span className="stp-muted">· depth {r.depth}</span>
                </span>
                <span className="stp-orange stp-strong">{hintFor(r.topic)}</span>
              </div>
              <div className="stp-segs" style={{ gridTemplateColumns: `repeat(${Math.max(5, r.segments.length)}, minmax(0, 1fr))` }}>
                {r.segments.map((s) => (
                  <div key={s.key} className={`stp-seg is-${s.state}`} title={s.state === "locked" ? "Next level: locked" : `${nodeLabel(s.key)}: ${s.state}`} />
                ))}
              </div>
            </div>
          ))
        )}
        <div className="stp-legend">
          <span><span className="stp-seg-swatch is-complete" />done</span>
          <span><span className="stp-seg-swatch is-open" />open</span>
          <span><span className="stp-seg-swatch is-locked" />locked</span>
        </div>
      </div>

      <div className="stp-panel">
        <h2 className="stp-h3">Recent coins</h2>
        {recent.length === 0 ? (
          <p className="stp-muted stp-small">Nothing yet. Completed clips earn stashcoins.</p>
        ) : (
          <ul className="stp-ledger">
            {recent.map((e, i) => {
              const amount = ledgerAmount(e);
              return (
                <li key={`${e.at}-${i}`}>
                  <span className="stp-ledger-label">{ledgerLabel(e, data.graph.scenes)}</span>
                  <span className={`stp-mono ${amount >= 0 ? "stp-blue" : "stp-orange"}`}>{formatSignedCoins(amount)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
