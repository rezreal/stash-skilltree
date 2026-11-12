// The mail draft over the clip (mail prompts, src/player/mail.ts): a
// compose window docked bottom right, prefilled from the marker. It can be
// minimized to its title bar and maximized over the clip; once the clip
// holds for it, a minimized draft comes back up. Nothing is sent anywhere:
// Send (or Ctrl/Cmd+Enter) passes the prompt. Fields are editable; the
// overlay host keeps the player's hotkeys out of them (OverlayHost.tsx).
//
// Photos: the camera button opens a viewfinder (mirrored, like the camera
// PiP) on the session's running camera, or, when that is off, on a camera
// of its own that the viewer's click starts and closing stops. Photos are
// taken as previewed and held as object URLs in this component only; they
// are dropped with the draft, never stored or uploaded.
import { classifyMediaError } from "../perception/errors.ts";
import { formatCountdown } from "../player/format.ts";
import { fitWithin, MAIL_PHOTO_LIMIT, type MailPrompt } from "../player/mail.ts";

type Mode = "normal" | "min" | "max";

interface Photo {
  id: number;
  url: string;
}

const ICON = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, "aria-hidden": true } as const;

const stopTracks = (s: MediaStream) => s.getTracks().forEach((t) => t.stop());

/** a camera stream while `open`: the shared one if running, else one of our own */
function useViewfinderStream(open: boolean, shared: MediaStream | null): { stream: MediaStream | null; error?: string } {
  const [own, setOwn] = React.useState<MediaStream | null>(null);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const useOwn = open && !shared;
  React.useEffect(() => {
    if (!useOwn) return;
    setError(undefined);
    let cancelled = false;
    let got: MediaStream | null = null;
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!md?.getUserMedia) {
      setError(classifyMediaError(new Error("no getUserMedia"), "camera", window.isSecureContext).message);
      return;
    }
    md.getUserMedia({ video: true, audio: false }).then(
      (s) => {
        if (cancelled) return stopTracks(s);
        got = s;
        setOwn(s);
      },
      (err: unknown) => {
        if (!cancelled) setError(classifyMediaError(err, "camera", window.isSecureContext).message);
      },
    );
    return () => {
      cancelled = true;
      if (got) stopTracks(got);
      setOwn(null);
    };
  }, [useOwn]);
  if (!open) return { stream: null };
  if (shared) return { stream: shared };
  return error !== undefined ? { stream: own, error } : { stream: own };
}

export function MailDraft(props: {
  prompt: MailPrompt;
  /** the clip is waiting for Send */
  held: boolean;
  /** seconds of video until the clip waits (while not held) */
  holdInSec: number;
  /** the session's camera stream while it runs (presence), else null */
  camera: MediaStream | null;
  onSend: () => void;
}) {
  const { prompt, held } = props;
  const [to, setTo] = React.useState(prompt.draft.to);
  const [subject, setSubject] = React.useState(prompt.draft.subject);
  const [body, setBody] = React.useState(prompt.draft.body);
  const [mode, setMode] = React.useState<Mode>("normal");
  const [finder, setFinder] = React.useState(false);
  const [photos, setPhotos] = React.useState<Photo[]>([]);
  const photosRef = React.useRef(photos);
  photosRef.current = photos;
  const nextId = React.useRef(1);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const { stream, error } = useViewfinderStream(finder && mode !== "min", props.camera);

  // the clip waits for this draft: it can't stay tucked away
  React.useEffect(() => {
    if (held) setMode((m) => (m === "min" ? "normal" : m));
  }, [held]);

  React.useEffect(() => {
    const el = videoRef.current;
    if (!el || !stream) return;
    el.srcObject = stream;
    void el.play().catch(() => undefined);
    return () => {
      el.srcObject = null;
    };
  }, [stream]);

  // the photos go with the draft
  React.useEffect(() => () => photosRef.current.forEach((p) => URL.revokeObjectURL(p.url)), []);

  const full = photos.length >= MAIL_PHOTO_LIMIT;
  const takePhoto = () => {
    const v = videoRef.current;
    if (!v || full) return;
    const { width, height } = fitWithin(v.videoWidth, v.videoHeight);
    if (width === 0) return;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext("2d");
    if (!g) return;
    // as previewed: mirrored
    g.translate(width, 0);
    g.scale(-1, 1);
    g.drawImage(v, 0, 0, width, height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const photo = { id: nextId.current++, url: URL.createObjectURL(blob) };
        setPhotos((list) => [...list, photo]);
      },
      "image/jpeg",
      0.85,
    );
  };
  const removePhoto = (id: number) =>
    setPhotos((list) => {
      const gone = list.find((p) => p.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      return list.filter((p) => p.id !== id);
    });

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
          {finder && (
            <div className="stp-sp-mail-finder">
              {error ? (
                <p className="stp-small stp-orange stp-sp-mail-finder-error">{error}</p>
              ) : (
                <video ref={videoRef} muted playsInline autoPlay aria-label="Camera preview" />
              )}
              <div className="stp-sp-mail-finder-actions">
                <button
                  type="button"
                  className="stp-btn stp-btn-outline stp-btn-sm"
                  onClick={takePhoto}
                  disabled={!stream || full}
                  title={full ? `At most ${MAIL_PHOTO_LIMIT} photos` : "Take a photo"}
                >
                  Take photo
                </button>
                <button type="button" className="stp-btn stp-btn-outline stp-btn-sm" onClick={() => setFinder(false)}>
                  Done
                </button>
              </div>
            </div>
          )}
          {photos.length > 0 && (
            <div className="stp-sp-mail-photos" aria-label="Attached photos">
              {photos.map((p, i) => (
                <span key={p.id} className="stp-sp-mail-photo">
                  <img src={p.url} alt={`Photo ${i + 1}`} />
                  <button type="button" onClick={() => removePhoto(p.id)} aria-label={`Remove photo ${i + 1}`} title="Remove">
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="stp-sp-mail-foot">
            <button type="button" className="stp-btn stp-btn-orange stp-btn-sm stp-sp-mail-send" onClick={props.onSend} title="Send (Ctrl+Enter)">
              Send
              <svg {...ICON}>
                <path d="M10 14L21 3M21 3l-6.5 18a.55.55 0 0 1-1 0L10 14l-7-3.5a.55.55 0 0 1 0-1L21 3" />
              </svg>
            </button>
            <button
              type="button"
              className={`stp-sp-mail-icon${finder ? " is-on" : ""}`}
              onClick={() => setFinder((f) => !f)}
              aria-label="Attach a photo from your camera"
              aria-pressed={finder}
              title="Attach a photo from your camera"
            >
              <svg {...ICON}>
                <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
                <circle cx="12" cy="13.5" r="3.5" />
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
