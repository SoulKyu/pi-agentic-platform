import { vi } from "vitest";
import type { HomeActions, HomeShortcuts, HomeTarget } from "../features/home/home-actions.ts";

/** A URL per target, close to the app's (`pathOfItem`), for tests that read links. */
export function hrefOf(target: HomeTarget): string {
  switch (target.kind) {
    case "session":
      return `/s/${target.id}`;
    case "lane":
      return `/lane/${target.id}`;
    case "compare":
      return `/compare/${target.id}`;
    case "tasks":
      return "/tasks";
    case "files":
      return `/explore/${target.root}`;
    case "terminal":
      return `/term/${target.id}`;
    case "settings":
      return `/settings/${target.section}`;
  }
}

/** The shell's actions as spies; `newLane` answers true (the dialog opened) unless a test says otherwise. */
export function fakeHomeActions() {
  return {
    href: vi.fn(hrefOf),
    open: vi.fn<(target: HomeTarget) => void>(),
    openTree: vi.fn<() => void>(),
    openInbox: vi.fn<() => void>(),
    openSearch: vi.fn<(projectId: string | null) => void>(),
    openShortcuts: vi.fn<() => void>(),
    newLane: vi.fn<HomeActions["newLane"]>(() => true),
    newTrigger: vi.fn<HomeActions["newTrigger"]>(),
    newAgent: vi.fn<HomeActions["newAgent"]>(),
    addProject: vi.fn<HomeActions["addProject"]>(),
  } satisfies HomeActions;
}

/** The chord hints of the home tests. */
export const SHORTCUTS: HomeShortcuts = {
  lane: { keys: ["Ctrl", "Shift", "L"], joiner: "+" },
  search: { keys: ["Ctrl", "K"], joiner: "+" },
  help: { keys: ["?"], joiner: "+" },
};
