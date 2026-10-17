import { createMemoryHistory, Outlet, RouterProvider, type AnyRouter } from "@tanstack/react-router";
import { buildRouteTree, createAppRouter } from "../routes/router.tsx";
import { ROUTES } from "../routes/shell/landing-route.ts";
import Landing from "../features/notifications/Landing.tsx";
import type { Timers } from "../runtime/connection.ts";
import { mount } from "./dom.ts";

export { itemOf, loadInbox } from "../features/inbox/inbox-bed.tsx";
export { EMPTY_WORKSPACE, useWorkspaceStore } from "../features/workspace/index.ts";

/** The landing at `/n/<segment>` on a memory router, with the shell's own route mapping. */
export async function mountLanding(segment: string, timers: Timers) {
  const Root = () => (
    <>
      <Landing id={segment} routes={ROUTES} timers={timers} />
      <Outlet />
    </>
  );
  const router: AnyRouter = createAppRouter(
    buildRouteTree(Root),
    createMemoryHistory({ initialEntries: [`/n/${segment}`] }),
  );
  const mounted = await mount(<RouterProvider router={router} />);
  return { mounted, router };
}
