// "Watch" goes to stash's own scene page in Skilltree mode (handoff.ts).
// Exposure loops carry the loop flag so stash's player keeps looping them.
// The test panel's "Test" uses the same with test: true (skilltree=test /
// test-loop): loop is derived from the clip's policy the same way.
// Pure, tested under node --test.
import type { Id, SceneInput } from "../core/types.ts";
import { policyForScene } from "../play/policy.ts";
import type { PolicyTagInput } from "../play/types.ts";
import { isExposureOnly } from "../player/view.ts";
import { skilltreeSceneUrl } from "../stashplayer/handoff.ts";

/** The clip runs the track rule, so its Watch click should bring the distance sensor up. */
export function wantsSensor(scene: SceneInput | undefined, policyTags: PolicyTagInput[]): boolean {
  return scene ? policyForScene(scene, policyTags).rules.includes("track") : false;
}

/**
 * In-app path of the scene page for a Skilltree session. Autoplay: the
 * click on "Watch" is the viewer's go, and stash's autoplay waits for the
 * source (and a Handy script) to be ready.
 */
export function watchUrl(
  sceneId: Id,
  scene: SceneInput | undefined,
  policyTags: PolicyTagInput[],
  opts: { test?: boolean } = {},
): string {
  const loop = scene ? isExposureOnly(policyForScene(scene, policyTags)) : false;
  return skilltreeSceneUrl(sceneId, { loop, autoplay: true, test: opts.test === true });
}
