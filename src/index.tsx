// Plugin entry. Registers the routes and the navigation entry.
import { registerPlay } from "./player/register.tsx";
import { register } from "./ui/register.tsx";

register();
registerPlay();
