// Errors from opening the camera / microphone and loading the models, mapped
// to codes the UI can explain. Pure: classifyMediaError takes the thrown value
// and whether the page is a secure context.

export type PerceptionErrorCode =
  | "insecure-context"
  | "unsupported"
  | "permission-denied"
  | "no-device"
  | "device-busy"
  | "assets-missing"
  | "model-failed"
  | "unknown";

export class PerceptionError extends Error {
  readonly code: PerceptionErrorCode;
  readonly cause?: unknown;
  constructor(code: PerceptionErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "PerceptionError";
    this.code = code;
    this.cause = cause;
  }
}

export type MediaKind = "camera" | "microphone";

function errName(err: unknown): string {
  if (err && typeof err === "object" && "name" in err && typeof (err as { name: unknown }).name === "string") {
    return (err as { name: string }).name;
  }
  return "";
}

/**
 * Error for when getUserMedia can't even be called: it only exists in secure
 * contexts (https, or http://localhost).
 */
export function unavailableMediaError(kind: MediaKind, secure: boolean): PerceptionError {
  if (!secure) {
    return new PerceptionError(
      "insecure-context",
      `The ${kind} needs a secure page: open stash over https (or http://localhost).`,
    );
  }
  return new PerceptionError("unsupported", `This browser can't access the ${kind} (no navigator.mediaDevices).`);
}

/** Maps a getUserMedia rejection to a PerceptionError with a readable message. */
export function classifyMediaError(err: unknown, kind: MediaKind, secure: boolean): PerceptionError {
  if (err instanceof PerceptionError) return err;
  const name = errName(err);
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return new PerceptionError(
        "permission-denied",
        `Access to the ${kind} was denied. Allow it for this site in the browser's address bar and try again.`,
        err,
      );
    case "SecurityError":
      if (!secure) return unavailableMediaError(kind, secure);
      return new PerceptionError(
        "permission-denied",
        `The ${kind} is blocked for this page (browser or permissions policy).`,
        err,
      );
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return new PerceptionError("no-device", `No ${kind} was found.`, err);
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return new PerceptionError(
        "device-busy",
        `The ${kind} could not be started. Another app may be using it.`,
        err,
      );
    case "TypeError":
      if (!secure) return unavailableMediaError(kind, secure);
      break;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new PerceptionError("unknown", `Could not open the ${kind}: ${msg}`, err);
}
