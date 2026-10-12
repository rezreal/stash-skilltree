// Session overlays over stash's scene player: inattention pause, spend
// prompt, aborted, complete summary, loop saved.
//
// SpendDialog, CompleteSummary and LoopSaved are copied from
// src/player/PlayerScreen.tsx (private there), adapted to the stash
// overlay: Hold-to-send uses Enter rather than Space (Space inside stash's
// .VideoPlayer is taken by its play/pause handler before React sees it).
// PlayerScreen.tsx is going away; these are the copies to keep.
// Test mode (`test`): the summary is a preview of the would-be commit with
// the rule results and a clear "not saved" note; nothing was written.
import type { ReactNode } from "react";
import { seriesForScene, seriesStatus } from "../play/index.ts";
import type { AbortReason, SessionState } from "../play/types.ts";
import { router } from "../player/api.ts";
import { CoinIcon, PLAY_ROUTE } from "../player/common.tsx";
import {
  formatCoins,
  formatCountdown,
  formatDuration,
  formatFactor,
  formatMinutes,
  formatPercent,
  formatSignedCoins,
  nodeLabel,
} from "../player/format.ts";
import type { PauseText } from "../player/gazeView.ts";
import { HoldButton } from "../player/HoldButton.tsx";
import type { PlayData } from "../player/usePlayData.ts";
import { abortReasonText, baseLabel, fogLabel, newlyCompleted, newlyVisible, seriesSummaryLine } from "../player/view.ts";
import type { RuleResult } from "./controller.ts";
import type { OpenSpend, SaveState, StartSnapshot } from "./useSkilltreeSession.ts";

export const TEST_NOT_SAVED = "Test mode – not saved";

/** test mode: each rule of the policy and how it went */
export function RuleResults(props: { results: RuleResult[] }) {
  if (props.results.length === 0) return null;
  return (
    <div className="stp-breakdown stp-test-rules" aria-label="Rule results">
      {props.results.map((r) => (
        <div key={r.rule} className="stp-row">
          <span className="stp-soft">{r.label}</span>
          <span className="stp-mono">
            {r.value}{" "}
            <span className={r.passed === undefined ? "stp-muted" : r.passed ? "stp-blue" : "stp-orange"}>
              {r.passed === undefined ? "· not scored" : r.passed ? "· passed" : "· failed"}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

function PauseIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="stp-orange" aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}

/**
 * Paused for inattention. `compact`: the gaze callout carries the message
 * where the viewer is looking, so the video only shows that it is paused.
 * Lets clicks through, so stash's controls stay usable.
 */
export function InattentionOverlay(props: { text: PauseText; abortInSec: number; compact?: boolean }) {
  return (
    <div className={`stp-overlay stp-sp-passive${props.compact ? " is-compact" : ""}`} role="alertdialog" aria-label="Paused">
      <PauseIcon />
      {!props.compact && (
        <>
          <div className="stp-overlay-title">{props.text.title}</div>
          <div className="stp-soft">{props.text.hint}</div>
        </>
      )}
      <div className="stp-small stp-mono stp-orange">aborts in {formatCountdown(props.abortInSec)} · this attempt won’t count</div>
    </div>
  );
}

export function SpendDialog(props: { open: OpenSpend; balance: number; onAccept: () => void; onDecline: () => void }) {
  const { prompt, deadlineMs } = props.open;
  const left = (deadlineMs - Date.now()) / 1000;
  const affordable = props.balance >= prompt.amount;
  return (
    <div className="stp-overlay is-light stp-sp-active">
      <div className="stp-dialog" role="dialog" aria-modal="true" aria-labelledby="stp-sp-spend-title">
        <div className="stp-dialog-head">
          <span className="stp-gold">
            <CoinIcon size={34} />
          </span>
          <div className="stp-col">
            <span id="stp-sp-spend-title" className="stp-dialog-title">
              Send {formatCoins(prompt.amount)} stashcoins
            </span>
            <span className="stp-small stp-mono stp-muted">
              marker {formatDuration(prompt.window.start)} · confirm within {formatCountdown(left)}
            </span>
          </div>
        </div>
        <div className="stp-balance-row stp-mono">
          <span>balance</span>
          <span>
            {formatCoins(props.balance)} → {formatCoins(props.balance - prompt.amount)}
          </span>
        </div>
        {affordable ? (
          <HoldButton
            label="Hold to send"
            hint="Press and hold for a second (mouse, touch, or hold Enter)"
            autoFocus
            onConfirm={props.onAccept}
          />
        ) : (
          <p className="stp-error stp-small">You have {formatCoins(props.balance)} stashcoins, not enough for this prompt.</p>
        )}
        <button type="button" className="stp-btn stp-btn-outline" onClick={props.onDecline}>
          Decline · this clip fails
        </button>
      </div>
    </div>
  );
}

export function AbortedOverlay(props: { reason: AbortReason | undefined; onRetry: () => void; testResults?: RuleResult[] }) {
  const { Link } = router();
  return (
    <div className="stp-overlay stp-sp-active" role="alertdialog" aria-label="Aborted">
      {props.testResults && <span className="stp-test-badge">{TEST_NOT_SAVED}</span>}
      <div className="stp-overlay-title">This attempt doesn’t count</div>
      <div className="stp-soft">{abortReasonText(props.reason)}</div>
      {props.testResults && <RuleResults results={props.testResults} />}
      <div className="stp-small stp-muted">Nothing was saved.</div>
      <div className="stp-overlay-actions">
        <Link to={PLAY_ROUTE} className="stp-btn stp-btn-orange">
          Back to choices
        </Link>
        <button type="button" className="stp-btn stp-btn-outline" onClick={props.onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}

function Saving(props: { children: ReactNode }) {
  return (
    <p className="stp-soft" role="status">
      <span className="spinner-border spinner-border-sm mr-2" aria-hidden="true" />
      {props.children}
    </p>
  );
}

export function CompleteSummary(props: {
  start: StartSnapshot;
  data: PlayData;
  session: SessionState;
  save: SaveState;
  promptCount: number;
  onRetrySave: () => void;
  /** test mode: rule results; the summary is a preview, nothing was saved */
  testResults?: RuleResult[];
  /** extra summary blocks (the gaze regions) */
  children?: ReactNode;
}) {
  const { start, data, session, save } = props;
  const { Link } = router();
  const test = props.testResults !== undefined;
  const commit = save.status === "saved" || save.status === "error" || save.status === "preview" ? save.commit : undefined;
  const saved = save.status === "saved";

  const completed = saved ? newlyCompleted(start.progress, data.progress) : [];
  const revealed = saved ? newlyVisible(start.visibility, data.visibility) : [];
  const nodes = data.graph.sceneNodes.get(start.scene.id) ?? [];
  const title = test
    ? nodes.length > 0
      ? `Would count toward ${nodes.map(nodeLabel).join(", ")}`
      : "All rules met"
    : completed.length > 0
      ? `${completed.map(nodeLabel).join(", ")} complete`
      : nodes.length > 0
        ? `Counts toward ${nodes.map(nodeLabel).join(", ")}`
        : "Clip complete";

  const b = commit?.breakdown;
  const passed = session.prompts.filter((p) => p.passed).length;
  const quality = [
    start.policy.rules.includes("attention") ? `attention ${formatPercent(session.attendedFraction)}` : undefined,
    props.promptCount > 0 ? `prompts ${passed}/${props.promptCount}` : undefined,
  ]
    .filter((s) => s !== undefined)
    .join(", ");
  const before = start.ledger.balance;
  const after = commit ? before + commit.earnedNow - commit.spentNow : before;
  // daily series this scene is a part of, judged on the reloaded library
  const seriesLines = saved
    ? seriesForScene(data.library.series, start.scene.id).map((s) =>
        seriesSummaryLine(s, seriesStatus(s, data.graph.scenes, new Date(), data.dayStartHour)),
      )
    : [];

  return (
    <div className="stp-overlay is-dark stp-sp-active">
      <div className="stp-summary" role="dialog" aria-labelledby="stp-sp-summary-title">
        <div className="stp-col">
          {test ? <span className="stp-test-badge">{TEST_NOT_SAVED}</span> : <span className="stp-eyebrow">Clip counted</span>}
          <span id="stp-sp-summary-title" className="stp-summary-title">
            {title}
          </span>
          {test && (
            <span className="stp-small stp-soft">
              This is what the clip would have earned. No coins, completions or exposure were written.
            </span>
          )}
        </div>
        {props.testResults && <RuleResults results={props.testResults} />}
        {save.status === "saving" && <Saving>Saving…</Saving>}
        {save.status === "error" && (
          <div role="alert" className="stp-col">
            <p className="stp-error">Could not save: {save.error}</p>
            <button type="button" className="stp-btn stp-btn-outline" onClick={props.onRetrySave}>
              Try saving again
            </button>
          </div>
        )}
        {b && commit && (
          <div className="stp-breakdown">
            <div className="stp-row">
              <span className="stp-soft">{baseLabel(start.scene.durationSec)}</span>
              <span className="stp-mono">{Number(b.base.toFixed(1))}</span>
            </div>
            <div className="stp-row">
              <span className="stp-soft">Quality{quality ? ` · ${quality}` : ""}</span>
              <span className="stp-mono">{formatFactor(b.quality)}</span>
            </div>
            {b.rewardMult !== 1 && (
              <div className="stp-row">
                <span className="stp-soft">Clip multiplier</span>
                <span className="stp-mono">{formatFactor(b.rewardMult)}</span>
              </div>
            )}
            {b.repeatFactor !== 1 && (
              <div className="stp-row">
                <span className="stp-soft">Repeat · watched {start.scene.completions} times before</span>
                <span className="stp-mono">{formatFactor(b.repeatFactor)}</span>
              </div>
            )}
            {b.streakBonus !== 1 && (
              <div className="stp-row">
                <span className="stp-soft">Streak · day {start.streak.days}</span>
                <span className="stp-mono">{formatFactor(b.streakBonus)}</span>
              </div>
            )}
            <div className="stp-row stp-row-sep">
              <span className="stp-soft">{test ? "Would earn" : "Earned"}</span>
              <span className="stp-mono stp-blue">{formatSignedCoins(commit.earnedNow)}</span>
            </div>
            {commit.spentNow > 0 && (
              <div className="stp-row">
                <span className="stp-soft">{test ? "Would spend in this clip" : "Spent in this clip"}</span>
                <span className="stp-mono stp-orange">{formatSignedCoins(-commit.spentNow)}</span>
              </div>
            )}
            <div className="stp-row stp-strong">
              <span>{test ? "Balance (unchanged)" : "Balance"}</span>
              <span className="stp-mono stp-gold-text">
                {test ? `${formatCoins(before)} · would be ${formatCoins(after)}` : `${formatCoins(before)} → ${formatCoins(after)}`}
              </span>
            </div>
          </div>
        )}
        {seriesLines.map((line) => (
          <div key={line} className="stp-fog-line stp-series-line">
            <span className="stp-fog-dot" aria-hidden="true" />
            {line}
          </div>
        ))}
        {saved && revealed.length > 0 && (
          <div className="stp-fog-line">
            <span className="stp-fog-dot" aria-hidden="true" />
            Out of the fog: {revealed.map((k) => fogLabel(k, data.visibility.get(k))).join(" · ")}
          </div>
        )}
        {props.children}
        <Link to={PLAY_ROUTE} className="stp-btn stp-btn-orange stp-btn-lg">
          Choose next
        </Link>
      </div>
    </div>
  );
}

export function LoopSaved(props: {
  save: SaveState;
  previousSec: number;
  minMinutes?: number;
  onRetry: () => void;
  onAgain: () => void;
  /** extra summary blocks (the gaze regions) */
  children?: ReactNode;
}) {
  const { save } = props;
  const { Link } = router();
  return (
    <div className="stp-overlay is-dark stp-sp-active">
      <div className="stp-summary" role="dialog" aria-labelledby="stp-sp-loop-title">
        {save.status === "saving" && <Saving>Saving the minutes…</Saving>}
        {save.status === "error" && (
          <div role="alert" className="stp-col">
            <p className="stp-error">Could not save the minutes: {save.error}</p>
            <button type="button" className="stp-btn stp-btn-outline" onClick={props.onRetry}>
              Try again
            </button>
          </div>
        )}
        {(save.status === "saved" || save.status === "preview") && (
          <>
            <div className="stp-col">
              {save.status === "preview" ? (
                <span className="stp-test-badge">{TEST_NOT_SAVED}</span>
              ) : (
                <span className="stp-eyebrow">Loop saved</span>
              )}
              <span id="stp-sp-loop-title" className="stp-summary-title">
                {formatMinutes(save.exposureSec ?? 0)} {save.status === "preview" ? "would be added" : "added"}
              </span>
            </div>
            <div className="stp-breakdown">
              <div className="stp-row">
                <span className="stp-soft">{save.status === "preview" ? "Total exposure (not stored)" : "Total exposure"}</span>
                <span className="stp-mono">
                  {formatMinutes(props.previousSec + (save.exposureSec ?? 0))}
                  {props.minMinutes ? ` / ${props.minMinutes} min` : ""}
                </span>
              </div>
            </div>
            {props.children}
          </>
        )}
        <div className="stp-overlay-actions">
          <Link to={PLAY_ROUTE} className="stp-btn stp-btn-orange">
            Choose next
          </Link>
          {(save.status === "saved" || save.status === "preview") && (
            <button type="button" className="stp-btn stp-btn-outline" onClick={props.onAgain}>
              Play again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
