import type { OverviewSnapshot } from "@pap/contracts";
import { act } from "react";
import { vi } from "vitest";
import { mount } from "../../testing/dom.ts";
import type { fakeRuntime } from "../../testing/runtime-bed.ts";
import type { OverviewCallbacks } from "./callbacks.ts";
import { OverviewPane } from "./OverviewPane.tsx";

type Spied = OverviewCallbacks & { [K in keyof OverviewCallbacks]: ReturnType<typeof vi.fn> };

export const callbacks = (): Spied =>
  ({
    openAgent: vi.fn(),
    openProject: vi.fn(),
    openSession: vi.fn(),
    openTask: vi.fn(),
    revealInbox: vi.fn(),
    openHealth: vi.fn(),
    newAgent: vi.fn(),
    newProject: vi.fn(),
  }) as never;

/** Mounts the pane over a runtime whose `overview.get` answers `snapshot`, and lets the first read land. */
export async function showIn(
  bed: ReturnType<typeof fakeRuntime>,
  snapshot: OverviewSnapshot,
  on: OverviewCallbacks,
): Promise<HTMLElement> {
  bed.handlers["overview.get"] = () => snapshot;
  const view = await mount(<OverviewPane {...on} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return view.container;
}

export const cards = (root: ParentNode): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>("[data-box-card]"),
];
