// The old /skilltree/play/:sceneId route: clips play on stash's own scene
// page now (src/session/), so this only forwards links and bookmarks there.
import { skilltreeSceneUrl } from "../stashplayer/handoff.ts";
import { router } from "./api.ts";

export function PlayerScreen() {
  const { useParams, useHistory } = router();
  const { sceneId } = useParams<{ sceneId: string }>();
  const history = useHistory();
  React.useEffect(() => history.replace(skilltreeSceneUrl(sceneId, { autoplay: true })), [history, sceneId]);
  return null;
}
