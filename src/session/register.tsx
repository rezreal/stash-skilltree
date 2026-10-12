// Skilltree sessions on stash's own scene page (/scenes/:id?skilltree=1).
// The pause lock is applied by the session itself (it follows the clip's
// WatchPolicy.allowUserPause, which only the loaded policy knows), so the
// patch's own URL-based default is switched off.
import { registerStashPlayerPatch } from "../stashplayer/patch.tsx";
import { SkilltreeStashOverlay } from "./StashSession.tsx";

export function registerSkilltreeSession(): void {
  registerStashPlayerPatch((ctx) => <SkilltreeStashOverlay ctx={ctx} />, { lockPause: false });
}
