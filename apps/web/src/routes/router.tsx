import { createRootRoute, createRoute, createRouter, type RouterHistory } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { RootLayout } from "./RootLayout.tsx";
import { RouteError } from "./RouteError.tsx";

// The routes name the URLs (typed links, M2's Link to="/s/$sessionId"); AppShell renders the panes from the path.
const Empty = () => null;

/** The route tree under a root component: RootLayout in the app, AppShell alone in the shell test bed. */
export function buildRouteTree(Root: () => ReactNode) {
  const rootRoute = createRootRoute({ component: Root, notFoundComponent: Empty });
  const route = <P extends string>(path: P) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: Empty });
  return rootRoute.addChildren([
    route("/"),
    route("/s/$sessionId"),
    route("/settings"),
    route("/settings/$section"),
    route("/explore/$root"),
    route("/changes/$root"),
    route("/term/$id"),
    route("/lane/$laneId"),
    route("/compare/$fanoutId"),
    route("/tasks"),
    route("/trigger/$id"),
    route("/agents/$id"),
    route("/dev/ui"),
  ]);
}

/** The app's router options in one place, so the test bed gets the same translated error screen (M3-RT-15). */
export function createAppRouter(tree: ReturnType<typeof buildRouteTree>, history?: RouterHistory) {
  return createRouter({ routeTree: tree, history, defaultErrorComponent: RouteError });
}

export const routeTree = buildRouteTree(RootLayout);
export const router = createAppRouter(routeTree);

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
