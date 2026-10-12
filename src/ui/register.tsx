// Hooks the plugin into stash: the page route and a main navbar entry.
import { pluginApi } from "./pluginApi.ts";
import { SkilltreePage } from "./SkilltreePage.tsx";

export const ROUTE = "/plugin/skilltree";

export function register(): void {
  const api = pluginApi();
  api.register.route(ROUTE, SkilltreePage);

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

/** Mirrors the markup of stash's own menu items (MainNavbar.tsx). */
function SkilltreeNavItem() {
  const { libraries, components } = pluginApi();
  const { Link, useRouteMatch } = libraries.ReactRouterDOM;
  const { Button, Nav } = libraries.Bootstrap;
  const Icon = components.Icon;
  const icon = libraries.FontAwesomeSolid.faSitemap ?? libraries.FontAwesomeSolid.faDiagramProject;
  const active = useRouteMatch(ROUTE) !== null;

  return (
    <Nav.Link eventKey={ROUTE} as="div" className="col-4 col-sm-3 col-md-2 col-lg-auto">
      <Link to={ROUTE}>
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
