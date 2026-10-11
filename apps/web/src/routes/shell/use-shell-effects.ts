import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { itemFromPath, useWorkspaceStore } from "../../features/workspace/index.ts";

export function useShellEffects(): void {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const open = useWorkspaceStore((state) => state.open);

  // The URL names the active item; the tab follows it. An unknown path opens nothing.
  useEffect(() => {
    const item = itemFromPath(pathname, import.meta.env.DEV);
    if (item) open(item);
  }, [pathname, open]);
}
