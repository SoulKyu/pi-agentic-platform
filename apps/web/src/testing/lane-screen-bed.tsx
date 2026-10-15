import type { ReactNode } from "react";
import { type Mock, vi } from "vitest";
import { useLaneStore } from "../stores/lane-store.ts";
import { useShellStore } from "../stores/shell-store.ts";
import { useSessionStore } from "../stores/session-store.ts";
import { mount, settle } from "./dom.ts";
import { laneSnapshot, laneView } from "./lane-fixtures.ts";
import { inShell, newBed } from "../features/lanes/lanes-bed.tsx";
import { useDismissedLaneNotices } from "../features/lanes/LaneNotices.tsx";
import { LaneScreen } from "../features/lanes/LaneScreen.tsx";

export const pr = {
  number: 7,
  url: "https://github.com/o/r/pull/7",
  state: "open",
  draft: false,
  conflicts: true,
  checks: { total: 3, passed: 2, failed: 1, pending: 0 },
  checkedAt: 1,
  error: null,
};
export const load = (patch: object = {}) =>
  useLaneStore
    .getState()
    .apply(laneSnapshot([laneView({ id: "a-1a2b", primarySessionId: "sess-1", ...patch })]));

export const opened: Mock<() => void> = vi.fn();
export const slots = {
  chat: (sessionId: string, before: ReactNode) => (
    <div data-chat={sessionId}>
      {before}
      chat {sessionId}
    </div>
  ),
  changes: (root: string) => <div>changes {root}</div>,
  terminal: (root: string) => <div>terminal {root}</div>,
  split: ({ first, second }: { first: ReactNode; second: ReactNode }) => (
    <div>
      {first}
      {second}
    </div>
  ),
};
export const show = async (extra: object = {}) => {
  const page = await mount(
    inShell(<LaneScreen laneId="a-1a2b" onOpenArchived={opened} {...slots} {...extra} />),
  );
  await settle();
  return page;
};
export const phone = (yes: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: yes && query.includes("max-width"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

/** The `beforeEach` of every lane screen test file. */
export function resetLaneScreenBed(): void {
  localStorage.clear();
  useDismissedLaneNotices.setState({ ids: new Set() });
  newBed();
  useLaneStore.getState().reset();
  useShellStore.getState().reset();
  useSessionStore.setState({ views: {} });
  opened.mockClear();
  phone(false);
}
