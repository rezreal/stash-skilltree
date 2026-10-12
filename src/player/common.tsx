// Small pieces shared by the choice and player screens.
import type { ReactNode } from "react";
import type { PlayDataState } from "./usePlayData.ts";
import { formatCoins } from "./format.ts";
import { PLAY_ROUTE, ROUTE } from "../ui/register.tsx";

// Not under /plugin/: stash's server answers /plugin/<id>/<page> with a 404
// on reload or direct links. Other paths get the app's index.html.
export const AUTHOR_ROUTE = ROUTE;
export { PLAY_ROUTE };

export const playerRoute = (sceneId: string) => `${PLAY_ROUTE}/${encodeURIComponent(sceneId)}`;

export function CoinIcon(props: { size?: number; strokeWidth?: number }) {
  const size = props.size ?? 18;
  return (
    <svg
      className="stp-coin-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={props.strokeWidth ?? 2}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
    </svg>
  );
}

export function LockIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="3" y="10" width="18" height="11" rx="1" />
      <path d="M7 10V7a5 5 0 0 1 10 0v3" />
    </svg>
  );
}

export function TreeIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="19" r="2.5" />
      <circle cx="5" cy="6" r="2.5" />
      <circle cx="19" cy="6" r="2.5" />
      <path d="M12 16.5V12M12 12L6.5 8M12 12l5.5-4" />
    </svg>
  );
}

/** balance pill: "85 stashcoins", optionally "85 → 35" */
export function Balance(props: { balance: number; after?: number }) {
  const label =
    props.after === undefined
      ? `${formatCoins(props.balance)} stashcoins`
      : `${formatCoins(props.balance)} stashcoins, ${formatCoins(props.after)} after this clip`;
  return (
    <div className="stp-balance" aria-label={label} role="status">
      <CoinIcon />
      <span className="stp-mono stp-balance-value">
        {formatCoins(props.balance)}
        {props.after !== undefined && props.after !== props.balance ? ` → ${formatCoins(props.after)}` : null}
      </span>
      <span className="stp-balance-unit">stashcoins</span>
    </div>
  );
}

/** loading / error placeholder; renders children once the data is ready */
export function DataGate(props: {
  state: PlayDataState;
  onRetry: () => void;
  children: () => ReactNode;
}) {
  const { state } = props;
  if (state.status === "loading") {
    return (
      <div className="skilltree-play stp-status" role="status">
        <div className="spinner-border spinner-border-sm mr-2" aria-hidden="true" />
        {state.message}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="skilltree-play stp-status" role="alert">
        <p className="stp-error">Could not load the library: {state.error}</p>
        <button type="button" className="stp-btn stp-btn-outline" onClick={props.onRetry}>
          Retry
        </button>
      </div>
    );
  }
  return <>{props.children()}</>;
}

/** reload progress / error line under the header */
export function RefreshLine(props: { refreshing?: string; refreshError?: string; onRetry: () => void }) {
  if (props.refreshing !== undefined) {
    return (
      <p className="stp-refresh" role="status">
        <span className="spinner-border spinner-border-sm mr-2" aria-hidden="true" />
        Updating: {props.refreshing}
      </p>
    );
  }
  if (props.refreshError !== undefined) {
    return (
      <p className="stp-refresh" role="alert">
        <span className="stp-error">Could not reload the library: {props.refreshError}</span>{" "}
        <button type="button" className="stp-btn stp-btn-outline stp-btn-sm" onClick={props.onRetry}>
          Retry
        </button>
      </p>
    );
  }
  return null;
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
