// Routes of the player side: the choice screen, the player and the gaze
// calibration.
//
// stash mounts every PluginApi.register.route() as a plain, non-exact
// <Route> next to the others (no <Switch>), so one registration for the
// whole /skilltree/play subtree is made here and the screens are told
// apart by our own <Switch> with exact paths. The calibration lives at
// /skilltree/calibrate, outside that subtree, so the same routes are
// registered for it too; only one of the two outer routes ever matches.
import { pluginApi } from "../ui/pluginApi.ts";
import { router } from "./api.ts";
import { CalibrationScreen } from "./CalibrationScreen.tsx";
import { CALIBRATE_ROUTE, PLAY_ROUTE } from "./common.tsx";
import { ChoiceScreen } from "./ChoiceScreen.tsx";
import { PlayerScreen } from "./PlayerScreen.tsx";

export { PLAY_ROUTE };

function PlayRoutes() {
  const { Switch, Route } = router();
  return (
    <Switch>
      <Route exact path={PLAY_ROUTE} component={ChoiceScreen} />
      <Route exact path={`${PLAY_ROUTE}/:sceneId`} component={PlayerScreen} />
      <Route exact path={CALIBRATE_ROUTE} component={CalibrationScreen} />
    </Switch>
  );
}

export function registerPlay(): void {
  const api = pluginApi();
  api.register.route(PLAY_ROUTE, PlayRoutes);
  api.register.route(CALIBRATE_ROUTE, PlayRoutes);
}
