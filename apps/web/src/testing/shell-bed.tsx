import { Toaster, TooltipProvider } from "@pap/ui";
import { createMemoryHistory, RouterProvider, type AnyRouter } from "@tanstack/react-router";
import { vi } from "vitest";
import { AppShell } from "../routes/shell/AppShell.tsx";
import { buildRouteTree, createAppRouter } from "../routes/router.tsx";
import { mount, type Mounted } from "./dom.ts";

const PHONE_QUERY = "(max-width: 767.98px)";

export interface ShellOptions {
  readonly username?: string;
  onSignedOut?(): void;
  readonly phone?: boolean;
}

/** The shell on a memory-history router, with no auth gate, inside the providers main.tsx supplies. */
export async function renderShell(
  path: string,
  options: ShellOptions = {},
): Promise<Mounted & { router: AnyRouter }> {
  if (options.phone !== undefined) {
    const phone = options.phone;
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === PHONE_QUERY ? phone : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  }
  const Shell = () => (
    <AppShell
      username={options.username ?? "ana"}
      passkeysAvailable={false}
      onSignedOut={options.onSignedOut ?? (() => {})}
    />
  );
  const router = createAppRouter(buildRouteTree(Shell), createMemoryHistory({ initialEntries: [path] }));
  const mounted = await mount(
    <TooltipProvider>
      <RouterProvider router={router} />
      <Toaster closeLabel="Dismiss" />
    </TooltipProvider>,
  );
  return { ...mounted, router };
}
