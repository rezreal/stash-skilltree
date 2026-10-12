// Minimal typed view of the parts of stash's window.PluginApi this plugin
// uses. The real object is much larger; see ui/v2.5/src/pluginApi.tsx in the
// stash repo. Everything here is looked up lazily because some members
// (components, hooks) are only populated once stash has rendered.
import type * as ReactTypes from "react";

type AnyComponent = ReactTypes.ComponentType<any>;

export interface LinkProps {
  to: string;
  className?: string;
  title?: string;
  onClick?: (event: ReactTypes.MouseEvent) => void;
  children?: ReactTypes.ReactNode;
}

export interface RouteMatch {
  url: string;
  path: string;
  isExact: boolean;
}

export interface PluginApiShape {
  React: typeof import("react");
  register: {
    route: (path: string, component: ReactTypes.ComponentType) => void;
  };
  patch: {
    /** returns the new argument list for the patched render function */
    before: (component: string, fn: (...args: any[]) => unknown[]) => void;
    after: (component: string, fn: (...args: any[]) => unknown) => void;
  };
  libraries: {
    ReactRouterDOM: {
      Link: ReactTypes.ComponentType<LinkProps>;
      useRouteMatch: (path?: string) => RouteMatch | null;
      useHistory: () => { replace(path: string): void; push(path: string): void };
      useLocation: () => { pathname: string; search: string };
    };
    Bootstrap: {
      Button: AnyComponent;
      Nav: AnyComponent & { Link: AnyComponent };
    };
    FontAwesomeSolid: Record<string, unknown>;
  };
  components: Record<string, AnyComponent | undefined>;
  utils: {
    StashService: {
      useConfiguration: () => {
        data?: {
          configuration?: {
            plugins?: Record<string, Record<string, unknown> | undefined>;
          };
        };
      };
    };
  };
}

export function pluginApi(): PluginApiShape {
  return (window as unknown as { PluginApi: PluginApiShape }).PluginApi;
}

/** Plugin id = manifest file name without extension. */
export const PLUGIN_ID = "skilltree";

/** Reads this plugin's settings from stash's configuration (may be empty). */
export function usePluginSettings(): Record<string, unknown> {
  // StashService is always present in a running stash, so this hook call is
  // unconditional in practice; the guard only protects against API changes.
  const useConfiguration = pluginApi().utils?.StashService?.useConfiguration;
  const result = useConfiguration ? useConfiguration() : undefined;
  return result?.data?.configuration?.plugins?.[PLUGIN_ID] ?? {};
}
