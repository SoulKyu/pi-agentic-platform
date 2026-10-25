// @vitest-environment happy-dom
import type { AgentSummary } from "@pap/contracts";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { useLaunchStore } from "../../stores/launch-store.ts";
import { launchAt } from "../../testing/launch-bed.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("./HomePane.tsx", async () => {
  const { createElement } = await import("react");
  return { HomePane: () => createElement("p", { "data-stub": "home" }) };
});
const renders = vi.hoisted(() => ({ avatar: 0 }));
vi.mock("../../features/agents/AgentAvatar.tsx", async (original) => {
  const real = await original<typeof import("../../features/agents/AgentAvatar.tsx")>();
  const { createElement } = await import("react");
  return {
    ...real,
    AgentAvatar: (props: Parameters<typeof real.AgentAvatar>[0]) => {
      renders.avatar += 1;
      return createElement(real.AgentAvatar, props);
    },
  };
});

const AGENT = "atlas-1a2b";
const agent: AgentSummary = {
  id: AGENT,
  name: "Atlas",
  initials: "AT",
  state: "idle",
  unread: 0,
  paused: false,
  quarantined: false,
  unreadable: false,
  threadSessionId: null,
  lastActivityAt: 1,
};
const launch = (at: number) => ({
  kind: "launch" as const,
  launch: { ...launchAt("vm", at), box: { kind: "agent" as const, id: AGENT } },
});

beforeEach(() => {
  startAppearance(window);
  const bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  bed.handlers["models.overview"] = () => ({ providers: [], truncated: false });
  current.runtime = bed.runtime;
  localStorage.clear();
  useLaunchStore.getState().reset();
  useAgentsStore.getState().reset();
  renders.avatar = 0;
});

describe("the agent rail while an agent wakes", () => {
  it("shows a compact strip under the avatar, and only the strip follows the launch record", async () => {
    const page = await renderShell("/");
    await act(async () => {
      useAgentsStore.getState().apply({ kind: "snapshot", agents: [agent], requests: [], truncated: false });
    });
    const rail = document.querySelector('[data-slot="rail"]') as HTMLElement;
    expect(rail.querySelector("[data-launch-strip]")).toBeNull();
    await act(async () => {
      useLaunchStore.getState().apply(launch(Date.now() - 1000));
    });
    expect(rail.querySelector("[data-launch-segments]")).not.toBeNull();
    expect(rail.querySelectorAll("[data-segment]")).toHaveLength(5);
    const before = renders.avatar;
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        useLaunchStore.getState().apply(launch(Date.now() - 1000 * (i + 2)));
      });
    }
    expect(renders.avatar).toBe(before);
    await page.unmount();
  });
});
