// Repeat-after-me: fuzzy phrase matching over local speech recognition.
// A port of tools/extract_markers.py phrase_in (best sliding window, order
// aware) with soft token similarity, so small recognition errors
// ("lissen" for "listen") still count, and numbers written as digits or
// words compare equal.

import type { CheckResult, PromptSpec, SpeechResult } from "./types.ts";

export const DEFAULT_REPEAT_THRESHOLD = 0.75;
/** a partial (not final) result passes only at this score */
export const PARTIAL_REPEAT_THRESHOLD = 0.9;

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000 };

type NumKind = "small" | "tens" | "scale";
function numKind(w: string): NumKind | undefined {
  if (w in SMALL) return "small";
  if (w in TENS) return "tens";
  if (w in SCALES) return "scale";
  return undefined;
}

function rawWords(text: string, keepApostrophes: boolean): string[] {
  const s = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, "$1");
  const cleaned = keepApostrophes ? s.replace(/[^a-z0-9' ]+/g, " ") : s.replace(/'/g, "").replace(/[^a-z0-9 ]+/g, " ");
  return cleaned
    .split(/\s+/)
    .map((w) => (keepApostrophes ? w.replace(/^'+|'+$/g, "") : w))
    .filter((w) => w !== "");
}

/** Number word runs -> digit strings ("twenty five" -> "25", "one hundred and five" -> "105"). */
function numbersToDigits(words: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    const first = numKind(words[i]!);
    if (first === undefined) {
      out.push(words[i]!);
      i++;
      continue;
    }
    let total = 0;
    let current = 0;
    let last: NumKind | undefined;
    let lastSmall = 0;
    let j = i;
    while (j < words.length) {
      let w = words[j]!;
      // "hundred and five"
      if (w === "and" && last === "scale" && j + 1 < words.length && numKind(words[j + 1]!) !== undefined && numKind(words[j + 1]!) !== "scale") {
        j++;
        w = words[j]!;
      }
      const k = numKind(w);
      if (k === undefined) break;
      if (k === "small") {
        if (last === "small") break;
        if (last === "tens" && (SMALL[w]! >= 10 || lastSmall !== 0)) break;
        current += SMALL[w]!;
        lastSmall = SMALL[w]!;
      } else if (k === "tens") {
        if (last === "small" || last === "tens") break;
        current += TENS[w]!;
        lastSmall = 0;
      } else {
        const v = SCALES[w]!;
        if (v === 100) current = (current || 1) * 100;
        else {
          total += (current || 1) * v;
          current = 0;
        }
        lastSmall = 0;
      }
      last = k;
      j++;
    }
    out.push(String(total + current));
    i = j;
  }
  return out;
}

/** Lowercase words without punctuation, number words as digits. */
export function normalizeWords(text: string): string[] {
  return numbersToDigits(rawWords(text, false));
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

const isNum = (w: string): boolean => /^\d+$/.test(w);

/** 0..1; below 0.5 counts as no match. Numbers must match exactly. */
function tokenSim(a: string, b: string): number {
  if (a === b) return 1;
  if (isNum(a) || isNum(b)) return 0;
  const s = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  return s >= 0.5 ? s : 0;
}

/** Order-aware similarity: weighted LCS, ratio 2M / (|a| + |b|) like difflib. */
function alignRatio(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = [0];
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.max(prev[j]!, cur[j - 1]!, prev[j - 1]! + tokenSim(a[i - 1]!, b[j - 1]!)));
    }
    prev = cur;
  }
  return (2 * prev[b.length]!) / (a.length + b.length);
}

/**
 * How well `heard` contains `expected`, 0..1: the best window of heard (as
 * long as the phrase, +-1 word for an inserted or dropped word) compared
 * with the phrase.
 */
export function phraseMatch(expected: string, heard: string): number {
  const e = normalizeWords(expected);
  const h = normalizeWords(heard);
  if (e.length === 0 || h.length === 0) return 0;
  const n = e.length;
  let best = 0;
  for (let len = Math.max(1, n - 1); len <= n + 1; len++) {
    const l = Math.min(len, h.length);
    for (let i = 0; i + l <= h.length; i++) {
      best = Math.max(best, alignRatio(e, h.slice(i, i + l)));
      if (best >= 1) return 1;
    }
    if (l === h.length) break;
  }
  return best;
}

export interface RepeatCheckOptions {
  /** score a final result needs (default 0.75) */
  threshold?: number;
  /** score a partial result needs (default 0.9, never below threshold) */
  partialThreshold?: number;
}

export interface RepeatCheck {
  readonly spec: PromptSpec;
  /** the window opens (wall ms, same timebase as SpeechResult.t) */
  begin(nowMs: number): void;
  /** the window closes; later results are ignored */
  end(nowMs: number): void;
  push(result: SpeechResult): void;
  result(): CheckResult;
  reset(): void;
}

export function createRepeatCheck(spec: PromptSpec, opts?: RepeatCheckOptions): RepeatCheck {
  const threshold = opts?.threshold ?? DEFAULT_REPEAT_THRESHOLD;
  const partial = Math.max(threshold, opts?.partialThreshold ?? PARTIAL_REPEAT_THRESHOLD);
  let startMs: number | undefined;
  let endMs: number | undefined;
  let best = 0;
  let bestText = "";
  let passed = false;
  return {
    spec,
    begin(nowMs) {
      startMs = nowMs;
      endMs = undefined;
    },
    end(nowMs) {
      endMs = nowMs;
    },
    push(r) {
      if (startMs === undefined || !Number.isFinite(r.t) || r.t < startMs) return;
      if (endMs !== undefined && r.t > endMs) return;
      const score = phraseMatch(spec.title, r.text);
      if (score > best) {
        best = score;
        bestText = r.text;
      }
      if (score >= (r.final ? threshold : partial)) passed = true;
    },
    result() {
      return {
        passed,
        progress: passed ? 1 : threshold > 0 ? Math.min(1, best / threshold) : 0,
        detail: bestText === "" ? "nothing heard" : `heard "${bestText}" (${Math.round(best * 100)}%)`,
      };
    },
    reset() {
      startMs = undefined;
      endMs = undefined;
      best = 0;
      bestText = "";
      passed = false;
    },
  };
}

// --- recognizer grammar --------------------------------------------------------

const ONES = Object.keys(SMALL);
const TENS_WORDS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** 0 <= n < 1e6 as English words; larger numbers stay digits. */
export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 1e6) return String(n);
  if (n < 20) return ONES[n]!;
  if (n < 100) return TENS_WORDS[Math.floor(n / 10)]! + (n % 10 ? " " + ONES[n % 10]! : "");
  if (n < 1000) return ONES[Math.floor(n / 100)]! + " hundred" + (n % 100 ? " " + numberToWords(n % 100) : "");
  return numberToWords(Math.floor(n / 1000)) + " thousand" + (n % 1000 ? " " + numberToWords(n % 1000) : "");
}

/** A phrase as the recognizer would output it: lowercase words, digits spelled out. */
export function spokenPhrase(text: string): string {
  return rawWords(text, true)
    .map((w) => (isNum(w) ? numberToWords(Number(w)) : w))
    .join(" ");
}

/** Phrase list for a restricted recognizer grammar (Vosk): the repeat phrases + "[unk]". */
export function grammarFor(specs: PromptSpec[]): string[] {
  const out: string[] = [];
  for (const s of specs) {
    if (s.check !== "repeat") continue;
    const p = spokenPhrase(s.title);
    if (p !== "" && !out.includes(p)) out.push(p);
  }
  out.push("[unk]");
  return out;
}
