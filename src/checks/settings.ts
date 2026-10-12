// Plugin settings of the live checks (prompts + webcam presence). Pure.
// Stash stores BOOLEAN settings as booleans and leaves unset ones out, so
// every flag has a default; strings like "false" / "0" are accepted too.

export interface ChecksSettings {
  /** sessions need a camera (presence); default true */
  webcamRequired: boolean;
  /** prompt markers are checked; default true */
  promptsEnabled: boolean;
  /** microphone + local speech recognition for repeat-after-me; default true */
  speechEnabled: boolean;
  /** MediaPipe on the clip (gaze targets on the person in the video); default true */
  videoAnalysis: boolean;
  /** with an eye tracker: time per body region looked at, per session and performer (needs videoAnalysis); default true */
  gazeRegions: boolean;
}

export const DEFAULT_CHECKS_SETTINGS: Readonly<ChecksSettings> = {
  webcamRequired: true,
  promptsEnabled: true,
  speechEnabled: true,
  videoAnalysis: true,
  gazeRegions: true,
};

const TRUE = ["true", "1", "yes", "on"];
const FALSE = ["false", "0", "no", "off"];

/** A boolean setting: booleans as is, numbers != 0, common words; else the default. */
export function parseBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v !== 0 : fallback;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (TRUE.includes(s)) return true;
    if (FALSE.includes(s)) return false;
  }
  return fallback;
}

/** The checks' settings from the plugin settings object (usePluginSettings()). */
export function checksSettings(raw: Record<string, unknown> | null | undefined): ChecksSettings {
  const r = raw ?? {};
  return {
    webcamRequired: parseBool(r.webcamRequired, DEFAULT_CHECKS_SETTINGS.webcamRequired),
    promptsEnabled: parseBool(r.promptsEnabled, DEFAULT_CHECKS_SETTINGS.promptsEnabled),
    speechEnabled: parseBool(r.speechEnabled, DEFAULT_CHECKS_SETTINGS.speechEnabled),
    videoAnalysis: parseBool(r.videoAnalysis, DEFAULT_CHECKS_SETTINGS.videoAnalysis),
    gazeRegions: parseBool(r.gazeRegions, DEFAULT_CHECKS_SETTINGS.gazeRegions),
  };
}
