// Plugin entry. Registers the routes, the navigation entry and the
// Skilltree session on stash's scene player.
import { registerPlay } from "./player/register.tsx";
import { registerSkilltreeSession } from "./session/register.tsx";
import { register } from "./ui/register.tsx";

register();
registerPlay();
registerSkilltreeSession();
