import { createRootRoute, createRoute, createRouter, Navigate } from "@tanstack/react-router";
import { SessionListScreen } from "../features/sessions/SessionListScreen.tsx";
import { SessionScreen } from "../features/sessions/SessionScreen.tsx";
import { RootLayout } from "./RootLayout.tsx";

const rootRoute = createRootRoute({ component: RootLayout, notFoundComponent: () => <Navigate to="/" /> });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: SessionListScreen });
const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$sessionId",
  component: function SessionRoute() {
    const { sessionId } = sessionRoute.useParams();
    return <SessionScreen key={sessionId} sessionId={sessionId} />;
  },
});

export const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute, sessionRoute]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
