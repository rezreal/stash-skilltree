// Routes of the player side: the choice screen and the player.
//
// stash mounts every PluginApi.register.route() as a plain, non-exact
// <Route> next to the others (no <Switch>), so one registration for the
// whole /skilltree/play subtree is made here and the two screens are
// told apart by our own <Switch> with exact paths.
import { pluginApi } from "../ui/pluginApi.ts";
import { router } from "./api.ts";
import { PLAY_ROUTE } from "./common.tsx";
import { ChoiceScreen } from "./ChoiceScreen.tsx";
import { PlayerScreen } from "./PlayerScreen.tsx";

export { PLAY_ROUTE };

function PlayRoutes() {
  const { Switch, Route } = router();
  return (
    <Switch>
      <Route exact path={PLAY_ROUTE} component={ChoiceScreen} />
      <Route exact path={`${PLAY_ROUTE}/:sceneId`} component={PlayerScreen} />
    </Switch>
  );
}

export function registerPlay(): void {
  pluginApi().register.route(PLAY_ROUTE, PlayRoutes);
}
