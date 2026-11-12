// Mail prompts: the clip has the viewer send a mail. Nothing is sent
// anywhere; a draft window opens over the clip at the marker's start,
// prefilled from the marker's title, and stays open while the clip plays.
// The marker's end is the latest time to send it: from there the video
// waits (paused) until the viewer presses Send. Sending passes the prompt.
// Pure, tested under node --test.
import type { Id, MarkerInput } from "../core/types.ts";
import { DEFAULT_PROMPT_WINDOWS } from "../prompts/specs.ts";
import { markerWindow, type MarkerWindow } from "./markers.ts";

/** the hold point stays this far before the clip's end, so the clip can't end around an open draft */
export const MAIL_END_MARGIN_SEC = 0.5;

export interface MailDraft {
  /** empty: no recipient prefilled */
  to: string;
  /** empty: no subject prefilled */
  subject: string;
  body: string;
}

export interface MailPrompt {
  marker: MarkerInput;
  draft: MailDraft;
  window: MarkerWindow;
}

const HEADER = /^\s*(to|subject)\s*:([^|]*)\|/i;

/**
 * The draft a marker title prefills: optional leading "To: …|" and
 * "Subject: …|" segments (any order), then the body. A literal \n in the
 * body is a line break (stash marker titles are one line).
 * "To: boss@example.com | Subject: Monday | Hi,\n\nsorry" ->
 * { to: "boss@example.com", subject: "Monday", body: "Hi,\n\nsorry" }
 */
export function parseMailTitle(title: string): MailDraft {
  const draft: MailDraft = { to: "", subject: "", body: "" };
  let rest = title;
  for (let m = HEADER.exec(rest); m; m = HEADER.exec(rest)) {
    draft[m[1]!.toLowerCase() as "to" | "subject"] = m[2]!.trim();
    rest = rest.slice(m[0].length);
  }
  draft.body = rest.replace(/[ \t]*\\n[ \t]*/g, "\n").trim();
  return draft;
}

/** mail markers, by start time */
export function mailPrompts(markers: MarkerInput[]): MailPrompt[] {
  return markers
    .filter((m) => m.check === "mail")
    .map((m) => ({ marker: m, draft: parseMailTitle(m.title), window: markerWindow(m, DEFAULT_PROMPT_WINDOWS.mail) }))
    .sort((a, b) => a.window.start - b.window.start);
}

/**
 * The draft to open at t: the first one not done whose start lies behind t.
 * There is no way past a mail prompt: one jumped over opens (and holds)
 * right away.
 */
export function nextMail(prompts: MailPrompt[], done: ReadonlySet<Id>, t: number): MailPrompt | undefined {
  return prompts.find((p) => !done.has(p.marker.id) && t >= p.window.start);
}

/** video seconds from which an unsent draft holds the clip: its end, kept inside the clip */
export function mailHoldAt(prompt: MailPrompt, durationSec: number): number {
  if (!(durationSec > 0)) return prompt.window.end;
  return Math.max(prompt.window.start, Math.min(prompt.window.end, durationSec - MAIL_END_MARGIN_SEC));
}

/** longest side of a webcam photo attached to a draft (px) */
export const MAIL_PHOTO_MAX_PX = 1280;
/** photos and videos one draft can hold */
export const MAIL_ATTACHMENT_LIMIT = 8;
/** a webcam video stops recording on its own after this long */
export const MAIL_VIDEO_MAX_SEC = 60;

const RECORDER_TYPES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];

/** the first recording format the browser supports, or undefined (let MediaRecorder pick) */
export function pickRecorderType(isSupported: (type: string) => boolean): string | undefined {
  return RECORDER_TYPES.find((t) => {
    try {
      return isSupported(t);
    } catch {
      return false;
    }
  });
}

/** a frame's size scaled down (never up) so its longest side fits max */
export function fitWithin(width: number, height: number, max = MAIL_PHOTO_MAX_PX): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const k = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * k), height: Math.round(height * k) };
}
