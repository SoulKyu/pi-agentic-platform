import { Toaster, TooltipProvider } from "@pap/ui";
import { createMemoryHistory, RouterProvider, type AnyRouter } from "@tanstack/react-router";
import { vi } from "vitest";
import { AppShell } from "../routes/shell/AppShell.tsx";
import { buildRouteTree, createAppRouter } from "../routes/router.tsx";
import { loadShellChunks, type ChunkName } from "./chunks.ts";
import { mount, type Mounted } from "./dom.ts";

const PHONE_QUERY = "(max-width: 767.98px)";

export interface ShellOptions {
  readonly username?: string | null;
  onSignedOut?(): void;
  readonly phone?: boolean;
  readonly passkeysAvailable?: boolean;
  /** Chunks a gesture of the test opens (a split pane) on top of those the path and the drawers need. */
  readonly chunks?: readonly ChunkName[];
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
  // The lazy chunks are loaded here, outside any test wait, so a loaded host cannot outlast a waitFor budget.
  await loadShellChunks(path, options.chunks);
  const Shell = () => (
    <AppShell
      username={options.username === undefined ? "ana" : options.username}
      passkeysAvailable={options.passkeysAvailable ?? false}
      onSignedOut={options.onSignedOut ?? (() => {})}
    />
  );
  const router = createAppRouter(buildRouteTree(Shell), createMemoryHistory({ initialEntries: [path] }));
  const mounted = await mount(
    <TooltipProvider>
      <RouterProvider router={router} />
      <Toaster closeLabel="Dismiss" regionLabel="Notifications" />
    </TooltipProvider>,
  );
  return { ...mounted, router };
}
