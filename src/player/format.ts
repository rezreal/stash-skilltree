// Formatting for the player screens: durations, coins, node labels.
// Pure, tested under node --test.

/** 754 -> "12:34", 3723 -> "1:02:03"; negative and NaN count as 0 */
export function formatDuration(sec: number): string {
  const total = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${String(m).padStart(2, "0")}:${ss}`;
}

/** countdown style without leading zero minutes: 18 -> "0:18" */
export function formatCountdown(sec: number): string {
  const total = Number.isFinite(sec) && sec > 0 ? Math.ceil(sec) : 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** whole minutes, at least 1 for anything above 0: 754 -> "13 min" */
export function formatMinutes(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "0 min";
  return `${Math.max(1, Math.round(sec / 60))} min`;
}

/** coins are whole numbers; the minus is a real minus sign */
export function formatCoins(n: number): string {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  return v < 0 ? `−${Math.abs(v)}` : String(v);
}

/** signed amount for ledger lines: +12 / −50 */
export function formatSignedCoins(n: number): string {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  if (v > 0) return `+${v}`;
  return formatCoins(v);
}

/** multiplier: 2 -> "×2", 0.857 -> "×0.86", 1.1 -> "×1.1" */
export function formatFactor(f: number): string {
  const v = Number.isFinite(f) ? f : 0;
  return `×${Number(v.toFixed(2))}`;
}

/** 0.374 -> "37%" */
export function formatPercent(fraction: number): string {
  const v = Number.isFinite(fraction) ? fraction : 0;
  return `${Math.round(v * 100)}%`;
}

/** same labels as the suggestion reasons: "body scan" -> "Body Scan", "deepening:2" -> "Deepening L2" */
export { topicLabel, describeNode as nodeLabel } from "../play/suggest.ts";

/** "2018-04-12" -> "2018-04-12"; undefined -> "undated" */
export function dateLabel(date: string | undefined): string {
  return date && date.length > 0 ? date : "undated";
}

/** "1 open scene" / "3 open scenes" */
export function plural(n: number, singular: string, pluralForm = singular + "s"): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}
