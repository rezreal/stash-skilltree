// Pure helpers for the Vosk recognizer: grammar (runtime word list) and
// mapping recognizer messages to SpeechResults.

import type { SpeechResult } from "../prompts/types.ts";

/** Vosk's out-of-grammar token. */
export const UNK = "[unk]";

/**
 * Lowercases, turns punctuation (except apostrophes inside words) into spaces
 * and collapses whitespace: "Yes, Sir!" -> "yes sir". Vosk's English models
 * use lowercase words; "don't" stays one word.
 */
export function normalizePhrase(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[’‘`´]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .replace(/(^|\s)'+|'+(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The JSON grammar Vosk takes for a recognizer limited to these phrases, plus
 * "[unk]" so other speech maps to [unk] instead of being forced onto a phrase.
 * Empty / null -> undefined (free-form recognition with the full model).
 */
export function grammarJson(phrases: readonly string[] | null | undefined): string | undefined {
  if (!phrases) return undefined;
  const seen = new Set<string>();
  for (const p of phrases) {
    const n = normalizePhrase(p);
    if (n) seen.add(n);
  }
  if (!seen.size) return undefined;
  return JSON.stringify([...seen, UNK]);
}

/** Removes [unk] tokens and extra whitespace from recognizer text. */
export function cleanRecognizedText(text: string): string {
  return text
    .split(/\s+/)
    .filter((w) => w && w !== UNK)
    .join(" ");
}

/** Structural subset of vosk-browser's recognizer messages. */
export type VoskMessageLike =
  | { event: "result"; result: { text?: string } }
  | { event: "partialresult"; result: { partial?: string } }
  | { event: "error"; error: string }
  | { event: string; [k: string]: unknown };

/**
 * A recognizer message as a SpeechResult; null for errors, unknown events and
 * results that are empty once [unk] is removed.
 */
export function mapVoskMessage(msg: VoskMessageLike | null | undefined, t: number): SpeechResult | null {
  if (!msg) return null;
  let raw: unknown;
  let final: boolean;
  if (msg.event === "result") {
    raw = (msg.result as { text?: unknown } | undefined)?.text;
    final = true;
  } else if (msg.event === "partialresult") {
    raw = (msg.result as { partial?: unknown } | undefined)?.partial;
    final = false;
  } else {
    return null;
  }
  if (typeof raw !== "string") return null;
  const text = cleanRecognizedText(raw);
  if (!text) return null;
  return { t, text, final };
}

/**
 * Drops partials that repeat the previous partial (Vosk emits the same partial
 * for every audio chunk until it changes). Returns true when `r` is news.
 */
export function createPartialDeduper(): (r: SpeechResult) => boolean {
  let last = "";
  return (r) => {
    if (r.final) {
      last = "";
      return true;
    }
    if (r.text === last) return false;
    last = r.text;
    return true;
  };
}
