// The mail draft over the clip (mail prompts, src/player/mail.ts): a
// compose window docked bottom right, prefilled from the marker. It can be
// minimized to its title bar and maximized over the clip; once the clip
// holds for it, a minimized draft comes back up. Nothing is sent anywhere:
// Send (or Ctrl/Cmd+Enter) passes the prompt. Fields are editable; the
// overlay host keeps the player's hotkeys out of them (OverlayHost.tsx).
//
// Attachments: the camera button opens a viewfinder (mirrored, like the
// camera PiP) on the session's running camera, or, when that is off, on a
// camera of its own that the viewer's click starts and closing stops. Photos
// are taken as previewed; videos record the camera with the microphone
// (asked for on Record; without it they record silently) for at most
// MAIL_VIDEO_MAX_SEC, and play back mirrored like the preview. Closing the
// viewfinder or minimizing stops a recording and keeps it. Everything is
// held as object URLs in this component only and dropped with the draft,
// never stored or uploaded.
import { classifyMediaError } from "../perception/errors.ts";
import { formatCountdown } from "../player/format.ts";
import { fitWithin, MAIL_ATTACHMENT_LIMIT, MAIL_VIDEO_MAX_SEC, pickRecorderType, type MailPrompt } from "../player/mail.ts";

type Mode = "normal" | "min" | "max";

interface Attachment {
  id: number;
  kind: "photo" | "video";
  url: string;
  /** video length in seconds */
  sec?: number;
}

interface Recording {
  recorder: MediaRecorder;
  mic: MediaStream | null;
  startedMs: number;
  /** stop without keeping the clip (the draft went away) */
  discard: boolean;
}

const ICON = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, "aria-hidden": true } as const;

const stopTracks = (s: MediaStream) => s.getTracks().forEach((t) => t.stop());
const canRecord = () => typeof MediaRecorder !== "undefined";

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
  const [attachments, setAttachments] = React.useState<Attachment[]>([]);
  const attachmentsRef = React.useRef(attachments);
  attachmentsRef.current = attachments;
  const nextId = React.useRef(1);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const viewing = finder && mode !== "min";
  const { stream, error } = useViewfinderStream(viewing, props.camera);
  const [recording, setRecording] = React.useState<Recording | undefined>(undefined);
  const recordingRef = React.useRef(recording);
  recordingRef.current = recording;
  const [recNote, setRecNote] = React.useState<string | undefined>(undefined);
  const [, tick] = React.useState(0);

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

  const add = (a: Omit<Attachment, "id">) => setAttachments((list) => [...list, { id: nextId.current++, ...a }]);

  const stopRecording = React.useCallback(() => {
    const rec = recordingRef.current;
    if (rec && rec.recorder.state !== "inactive") rec.recorder.stop();
  }, []);

  // the viewfinder closed or the draft was minimized: the recording ends (and is kept)
  React.useEffect(() => {
    if (!viewing) stopRecording();
  }, [viewing, stopRecording]);

  // the elapsed time while recording; the limit stops it
  React.useEffect(() => {
    if (!recording) return;
    const id = window.setInterval(() => {
      tick((n) => (n + 1) % 1_000_000);
      if (Date.now() - recording.startedMs >= MAIL_VIDEO_MAX_SEC * 1000) stopRecording();
    }, 250);
    return () => window.clearInterval(id);
  }, [recording, stopRecording]);

  // the attachments go with the draft; a running recording is thrown away
  React.useEffect(
    () => () => {
      const rec = recordingRef.current;
      if (rec) {
        rec.discard = true;
        if (rec.recorder.state !== "inactive") rec.recorder.stop();
        if (rec.mic) stopTracks(rec.mic);
      }
      attachmentsRef.current.forEach((a) => URL.revokeObjectURL(a.url));
    },
    [],
  );

  const full = attachments.length >= MAIL_ATTACHMENT_LIMIT;

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
        if (blob) add({ kind: "photo", url: URL.createObjectURL(blob) });
      },
      "image/jpeg",
      0.85,
    );
  };

  const startRecording = async () => {
    if (!stream || full || recordingRef.current || !canRecord()) return;
    setRecNote(undefined);
    let mic: MediaStream | null = null;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      setRecNote(`Recording without sound. ${classifyMediaError(err, "microphone", window.isSecureContext).message}`);
    }
    // the viewfinder may have closed while the browser asked
    if (!videoRef.current?.srcObject) {
      if (mic) stopTracks(mic);
      return;
    }
    const tracks = [...stream.getVideoTracks(), ...(mic?.getAudioTracks() ?? [])];
    const type = pickRecorderType((t) => MediaRecorder.isTypeSupported(t));
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(new MediaStream(tracks), type ? { mimeType: type } : undefined);
    } catch {
      if (mic) stopTracks(mic);
      setRecNote("This browser can't record video.");
      return;
    }
    const chunks: Blob[] = [];
    const rec: Recording = { recorder, mic, startedMs: Date.now(), discard: false };
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      if (rec.mic) stopTracks(rec.mic);
      if (recordingRef.current === rec) {
        recordingRef.current = undefined;
        setRecording(undefined);
      }
      if (rec.discard || chunks.length === 0) return;
      const blob = new Blob(chunks, { type: recorder.mimeType || type || "video/webm" });
      add({ kind: "video", url: URL.createObjectURL(blob), sec: (Date.now() - rec.startedMs) / 1000 });
    };
    recorder.start(1000);
    recordingRef.current = rec;
    setRecording(rec);
  };

  const remove = (id: number) =>
    setAttachments((list) => {
      const gone = list.find((a) => a.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      return list.filter((a) => a.id !== id);
    });

  const title = subject.trim() || "New message";
  const toggle = (m: Mode) => setMode((cur) => (cur === m ? "normal" : m));
  const onKeyDown = (e: { key: string; ctrlKey: boolean; metaKey: boolean; preventDefault(): void }) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      props.onSend();
    }
  };
  const recSec = recording ? (Date.now() - recording.startedMs) / 1000 : 0;
  const limitTitle = `At most ${MAIL_ATTACHMENT_LIMIT} attachments`;

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
                <div className={`stp-sp-mail-view${recording ? " is-rec" : ""}`}>
                  <video ref={videoRef} muted playsInline autoPlay aria-label="Camera preview" />
                  {recording && (
                    <span className="stp-sp-mail-rec stp-mono" role="status">
                      REC {formatCountdown(recSec)} / {formatCountdown(MAIL_VIDEO_MAX_SEC)}
                    </span>
                  )}
                </div>
              )}
              <div className="stp-sp-mail-finder-actions">
                <button
                  type="button"
                  className="stp-btn stp-btn-outline stp-btn-sm"
                  onClick={takePhoto}
                  disabled={!stream || full || !!recording}
                  title={full ? limitTitle : "Take a photo"}
                >
                  Take photo
                </button>
                {canRecord() &&
                  (recording ? (
                    <button type="button" className="stp-btn stp-btn-orange stp-btn-sm" onClick={stopRecording}>
                      Stop
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="stp-btn stp-btn-outline stp-btn-sm"
                      onClick={() => void startRecording()}
                      disabled={!stream || full}
                      title={full ? limitTitle : `Record a video (up to ${MAIL_VIDEO_MAX_SEC} s)`}
                    >
                      Record video
                    </button>
                  ))}
                <button type="button" className="stp-btn stp-btn-outline stp-btn-sm" onClick={() => setFinder(false)}>
                  Done
                </button>
              </div>
              {recNote && <p className="stp-small stp-muted stp-sp-mail-finder-note">{recNote}</p>}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="stp-sp-mail-photos" aria-label="Attachments">
              {attachments.map((a, i) => (
                <span key={a.id} className={`stp-sp-mail-photo is-${a.kind}`}>
                  {a.kind === "photo" ? (
                    <img src={a.url} alt={`Photo ${i + 1}`} />
                  ) : (
                    <>
                      <video
                        src={a.url}
                        playsInline
                        preload="metadata"
                        aria-label={`Video ${i + 1}, click to play`}
                        onClick={(e) => {
                          const v = e.currentTarget;
                          if (v.paused) void v.play().catch(() => undefined);
                          else v.pause();
                        }}
                      />
                      <span className="stp-sp-mail-photo-len stp-mono">{formatCountdown(a.sec ?? 0)}</span>
                    </>
                  )}
                  <button type="button" onClick={() => remove(a.id)} aria-label={`Remove attachment ${i + 1}`} title="Remove">
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
              aria-label="Attach a photo or video from your camera"
              aria-pressed={finder}
              title="Attach a photo or video from your camera"
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
