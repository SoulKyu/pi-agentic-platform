import { LaunchesStreamEvent, type BoxRef, type HelperStatus, type LaunchView } from "@pap/contracts";
import { useMemo } from "react";
import { create } from "zustand";

export interface LaunchesView {
  /** The live launches by id. An ended launch is gone: a failed one leaves its InlineError elsewhere. */
  readonly launches: ReadonlyMap<string, LaunchView>;
  readonly helpers: HelperStatus;
}

export const EMPTY_LAUNCHES: LaunchesView = {
  launches: new Map(),
  helpers: { active: 0, max: 0, waiting: 0 },
};

/** The `launches` stream: a snapshot replaces, a launch event upserts, an end event removes. Garbage is skipped, never fatal. */
export function reduceLaunches(view: LaunchesView, raw: unknown): LaunchesView {
  const parsed = LaunchesStreamEvent.safeParse(raw);
  if (!parsed.success) return view;
  const event = parsed.data;
  switch (event.kind) {
    case "snapshot":
      return {
        launches: new Map(event.launches.map((launch) => [launch.id, launch])),
        helpers: event.helpers,
      };
    case "launch":
      return { ...view, launches: new Map(view.launches).set(event.launch.id, event.launch) };
    case "end": {
      if (!view.launches.has(event.id)) return view;
      const launches = new Map(view.launches);
      launches.delete(event.id);
      return { ...view, launches };
    }
    case "helpers":
      return { ...view, helpers: event.helpers };
  }
}

interface LaunchStoreState {
  readonly view: LaunchesView;
  apply(event: unknown): void;
  /** Sign-out: the next account starts from nothing. */
  reset(): void;
}

export const useLaunchStore = create<LaunchStoreState>()((set) => ({
  view: EMPTY_LAUNCHES,
  apply: (event) => set((state) => ({ view: reduceLaunches(state.view, event) })),
  reset: () => set({ view: EMPTY_LAUNCHES }),
}));

/** The live launch of a box (`project:<id>` or `agent:<id>`), or none. A box has at most one at a time. */
export function launchOf(
  launches: ReadonlyMap<string, LaunchView>,
  box: BoxRef | null | undefined,
): LaunchView | undefined {
  if (!box) return undefined;
  for (const launch of launches.values()) {
    if (launch.box.kind === box.kind && launch.box.id === box.id) return launch;
  }
  return undefined;
}

export function useLaunchOf(box: BoxRef | null | undefined): LaunchView | undefined {
  return useLaunchStore((state) => launchOf(state.view.launches, box));
}

/** Whether a box has a live launch: a boolean, so a screen that only needs the fact does not render with each event. */
export function useIsLaunching(box: BoxRef | null | undefined): boolean {
  return useLaunchStore((state) => launchOf(state.view.launches, box) !== undefined);
}

export function useLaunches(): readonly LaunchView[] {
  const launches = useLaunchStore((state) => state.view.launches);
  return useMemo(() => [...launches.values()], [launches]);
}

export function useHelperStatus(): HelperStatus {
  return useLaunchStore((state) => state.view.helpers);
}

/** A duration for the launch panel: `45 s`, `1 min 5 s`, `30 min`, `1 h 2 min`. Whole seconds, rounded down. */
export function formatLaunchTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  if (minutes > 0) return seconds > 0 ? `${minutes} min ${seconds} s` : `${minutes} min`;
  return `${seconds} s`;
}
