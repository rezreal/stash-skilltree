// The mail draft over the clip (mail prompts, src/player/mail.ts): a
// compose window docked bottom right, prefilled from the marker. It can be
// minimized to its title bar and maximized over the clip; once the clip
// holds for it, a minimized draft comes back up. Nothing is sent anywhere:
// Send (or Ctrl/Cmd+Enter) passes the prompt. Fields are editable; the
// overlay host keeps the player's hotkeys out of them (OverlayHost.tsx).
import { formatCountdown } from "../player/format.ts";
import type { MailPrompt } from "../player/mail.ts";

type Mode = "normal" | "min" | "max";

const ICON = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, "aria-hidden": true } as const;

export function MailDraft(props: {
  prompt: MailPrompt;
  /** the clip is waiting for Send */
  held: boolean;
  /** seconds of video until the clip waits (while not held) */
  holdInSec: number;
  onSend: () => void;
}) {
  const { prompt, held } = props;
  const [to, setTo] = React.useState(prompt.draft.to);
  const [subject, setSubject] = React.useState(prompt.draft.subject);
  const [body, setBody] = React.useState(prompt.draft.body);
  const [mode, setMode] = React.useState<Mode>("normal");

  // the clip waits for this draft: it can't stay tucked away
  React.useEffect(() => {
    if (held) setMode((m) => (m === "min" ? "normal" : m));
  }, [held]);

  const title = subject.trim() || "New message";
  const toggle = (m: Mode) => setMode((cur) => (cur === m ? "normal" : m));
  const onKeyDown = (e: { key: string; ctrlKey: boolean; metaKey: boolean; preventDefault(): void }) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      props.onSend();
    }
  };

  return (
    <div
      className={`stp-sp-mail is-${mode}${held ? " is-held" : ""}`}
      role="dialog"
      aria-label={`Mail draft: ${title}`}
      onKeyDown={onKeyDown}
    >
      <div className="stp-sp-mail-head" onClick={() => mode === "min" && setMode("normal")}>
        <span className="stp-sp-mail-title">{title}</span>
        <button
          type="button"
          className="stp-sp-mail-icon"
          onClick={(e) => {
            e.stopPropagation();
            toggle("min");
          }}
          aria-label={mode === "min" ? "Restore" : "Minimize"}
          title={mode === "min" ? "Restore" : "Minimize"}
        >
          <svg {...ICON}>{mode === "min" ? <path d="M6 15l6-6 6 6" /> : <path d="M5 12h14" />}</svg>
        </button>
        <button
          type="button"
          className="stp-sp-mail-icon"
          onClick={(e) => {
            e.stopPropagation();
            toggle("max");
          }}
          aria-label={mode === "max" ? "Restore" : "Maximize"}
          title={mode === "max" ? "Restore" : "Maximize"}
        >
          <svg {...ICON}>
            {mode === "max" ? <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /> : <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />}
          </svg>
        </button>
      </div>
      {mode !== "min" && (
        <div className="stp-sp-mail-body">
          <label className="stp-sp-mail-row">
            <span>To</span>
            <input type="email" value={to} onChange={(e) => setTo(e.currentTarget.value)} placeholder="name@example.com" />
          </label>
          <label className="stp-sp-mail-row">
            <span>Subject</span>
            <input type="text" value={subject} onChange={(e) => setSubject(e.currentTarget.value)} />
          </label>
          <textarea
            className="stp-sp-mail-text"
            value={body}
            onChange={(e) => setBody(e.currentTarget.value)}
            aria-label="Message"
          />
          <div className="stp-sp-mail-foot">
            <button type="button" className="stp-btn stp-btn-orange stp-btn-sm stp-sp-mail-send" onClick={props.onSend} title="Send (Ctrl+Enter)">
              Send
              <svg {...ICON}>
                <path d="M10 14L21 3M21 3l-6.5 18a.55.55 0 0 1-1 0L10 14l-7-3.5a.55.55 0 0 1 0-1L21 3" />
              </svg>
            </button>
            <span className={`stp-small ${held ? "stp-orange" : "stp-muted"}`} role="status">
              {held ? "The clip waits until you send this." : `Send within ${formatCountdown(props.holdInSec)} or the clip waits`}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
