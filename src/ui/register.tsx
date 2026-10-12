// Hooks the plugin into stash: the page route and a main navbar entry.
import { pluginApi } from "./pluginApi.ts";
import { SkilltreePage } from "./SkilltreePage.tsx";

// Not under /plugin/: stash's server mounts /plugin for plugin files and
// answers anything else below /plugin/<id> with a 404, so such a page breaks
// on reload or when opened from a link. Other paths get the app's index.html.
export const ROUTE = "/skilltree";
export const PLAY_ROUTE = `${ROUTE}/play`;

export function register(): void {
  const api = pluginApi();
  // register.route has no `exact`, and the player lives below this path
  api.register.route(ROUTE, AuthorRoute);

  // MainNavBar.MenuItems renders <Nav>{children}</Nav> around the stock menu
  // entries; appending our entry to its children puts it after "Tags".
  api.patch.before("MainNavBar.MenuItems", (props: { children?: unknown }) => [
    {
      ...props,
      children: (
        <>
          {props.children}
          <SkilltreeNavItem />
        </>
      ),
    },
  ]);
}

function AuthorRoute() {
  const match = pluginApi().libraries.ReactRouterDOM.useRouteMatch(ROUTE);
  return match?.isExact ? <SkilltreePage /> : null;
}

/**
 * The nav entry opens the choice screen - playing is what most visits are
 * for; the author view is one click away from there. Highlighted on both.
 *
 * Mirrors the markup of stash's own menu items (MainNavbar.tsx). */
function SkilltreeNavItem() {
  const { libraries, components } = pluginApi();
  const { Link, useRouteMatch } = libraries.ReactRouterDOM;
  const { Button, Nav } = libraries.Bootstrap;
  const Icon = components.Icon;
  const icon = libraries.FontAwesomeSolid.faSitemap ?? libraries.FontAwesomeSolid.faDiagramProject;
  const active = useRouteMatch(ROUTE) !== null;

  return (
    <Nav.Link eventKey={ROUTE} as="div" className="col-4 col-sm-3 col-md-2 col-lg-auto">
      <Link to={PLAY_ROUTE}>
        <Button
          className={
            "minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center" +
            (active ? " active" : "")
          }
        >
          {Icon && icon ? <Icon icon={icon} className="nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0" /> : null}
          <span>Skilltree</span>
        </Button>
      </Link>
    </Nav.Link>
  );
}
