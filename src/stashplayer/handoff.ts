// How "Watch" hands a scene over to stash's own scene page in Skilltree mode.
//
// The scene page (/scenes/:id, SceneLoader in stash's Scene.tsx) already reads
// a few query parameters, and the URL keeps working with them:
//   t=<seconds>     initialTimestamp: ScenePlayer seeks there AND autoplays
//   autoplay=true   start playing once the source (and a Handy script) is ready
//   continue=...    queue auto-advance; only matters with a queue (qs/qfp)
// Without `t`, ScenePlayer starts at scene.resume_time ("continue from") unless
// the user enabled "always start from beginning". `t=0` does not help: it is
// read as "no timestamp". So the clip starting at 0 is the patch's job (it
// hands ScenePlayer a scene whose resume_time is 0); the URL only marks the
// mode. A non-zero start uses stash's own `t`, so even without the patch the
// page starts in the right place.
//
// Our marker is `skilltree=1` (or `skilltree=loop` for exposure loops, which
// must keep looping). No queue parameters are added, so stash has no "next"
// scene to advance to.

export const SKILLTREE_PARAM = "skilltree";

export interface SkilltreeUrlOptions {
  /** seconds; values <= 0 (the default) start at the beginning */
  startAt?: number;
  /** stash's autoplay=true: play as soon as the source is ready */
  autoplay?: boolean;
  /** an exposure loop: let stash's player loop the clip */
  loop?: boolean;
}

export interface SkilltreeMode {
  sceneId: string;
  /** seconds, >= 0 */
  startAt: number;
  loop: boolean;
}

/** in-app path (for history.push / <Link>); react-router adds stash's base path */
export function skilltreeSceneUrl(sceneId: string, opts: SkilltreeUrlOptions = {}): string {
  const params = [`${SKILLTREE_PARAM}=${opts.loop ? "loop" : "1"}`];
  const startAt = normalizeStart(opts.startAt);
  if (startAt > 0) params.push(`t=${roundTime(startAt)}`);
  if (opts.autoplay) params.push("autoplay=true");
  return `/scenes/${encodeURIComponent(sceneId)}?${params.join("&")}`;
}

/** /scenes/<id> at the end of the path; any base path prefix in front is fine */
const SCENE_PATH = /\/scenes\/([^/?#]+)\/?$/;

/**
 * Reads the mode from a router location or window.location. undefined unless
 * the path is a scene page and the marker is present. Reserved scene routes
 * (/scenes/new, /scenes/markers) never match.
 */
export function parseSkilltreeMode(location: { pathname: string; search: string }): SkilltreeMode | undefined {
  const m = SCENE_PATH.exec(location.pathname);
  if (!m) return undefined;
  let sceneId: string;
  try {
    sceneId = decodeURIComponent(m[1]);
  } catch {
    return undefined;
  }
  if (sceneId === "new" || sceneId === "markers" || sceneId === "") return undefined;

  const params = new URLSearchParams(location.search);
  const flag = params.get(SKILLTREE_PARAM);
  if (flag === null || flag === "0" || flag === "false") return undefined;

  // same reading as stash's SceneLoader: Number(t), invalid -> 0
  const startAt = normalizeStart(Number(params.get("t") ?? ""));
  return { sceneId, startAt, loop: flag === "loop" };
}

function normalizeStart(t: number | undefined): number {
  return t !== undefined && Number.isFinite(t) && t > 0 ? t : 0;
}

function roundTime(t: number): string {
  return String(Math.round(t * 1000) / 1000);
}
