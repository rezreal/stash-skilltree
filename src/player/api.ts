// The extra parts of window.PluginApi the player screens use, on top of
// src/ui/pluginApi.ts: react-router's Switch/Route and hooks.
import type * as ReactTypes from "react";
import { pluginApi } from "../ui/pluginApi.ts";

export interface RouteProps {
  path?: string;
  exact?: boolean;
  component?: ReactTypes.ComponentType<any>;
  children?: ReactTypes.ReactNode;
}

export interface History {
  push(path: string): void;
  replace(path: string): void;
}

export interface PlayRouter {
  Switch: ReactTypes.ComponentType<{ children?: ReactTypes.ReactNode }>;
  Route: ReactTypes.ComponentType<RouteProps>;
  Link: ReturnType<typeof pluginApi>["libraries"]["ReactRouterDOM"]["Link"];
  useParams: <T extends Record<string, string>>() => T;
  useHistory: () => History;
  useLocation: () => { pathname: string; search: string };
}

export function router(): PlayRouter {
  return pluginApi().libraries.ReactRouterDOM as unknown as PlayRouter;
}

