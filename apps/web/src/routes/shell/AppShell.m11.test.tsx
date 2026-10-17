// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("./HomePane.tsx", async () => {
  const { createElement } = await import("react");
  return { HomePane: () => createElement("p") };
});

beforeEach(() => useAgentsStore.getState().reset());

const agent = {
  id: "atlas-1a2b",
  name: "Atlas",
  initials: "AT",
  state: "needs_input",
  unread: 2,
  paused: false,
  quarantined: false,
  unreadable: false,
  threadSessionId: "s9",
  lastActivityAt: 5,
};

// Its sub id is kept out of the numbered ones, like the usage stream's (see `fakeRuntime`).
const emit = (bed: ReturnType<typeof fakeRuntime>, event: unknown) =>
  bed.fake.deliver({ sub: "agents-sub", epoch: "e1", seq: 1, event });

async function mountShell() {
  const bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  const page = await renderShell("/");
  await settle();
  return { bed, page };
}

describe("the agents feed of the shell (M11R63)", () => {
  it("opens the agents stream once, when the shell mounts, and fills the store from it", async () => {
    const { bed, page } = await mountShell();
    expect(bed.called("subscribe.agents")).toEqual([
      expect.objectContaining({ method: "subscribe.agents", params: {} }),
    ]);
    await act(async () => {
      emit(bed, { kind: "snapshot", agents: [agent], requests: [], truncated: false });
    });
    expect(useAgentsStore.getState().view).toMatchObject({
      loaded: true,
      agents: [{ id: "atlas-1a2b", unread: 2 }],
    });
    await page.unmount();
  });

  it("sign-out resets the agents store and closes the subscription", async () => {
    const { bed, page } = await mountShell();
    await act(async () => {
      emit(bed, { kind: "snapshot", agents: [agent], requests: [], truncated: false });
    });
    expect(useAgentsStore.getState().view.agents).toHaveLength(1);
    await page.unmount();
    expect(useAgentsStore.getState().view).toMatchObject({ loaded: false, agents: [], requests: [] });
    expect(bed.called("unsubscribe").map((call) => call.params)).toContainEqual({ sub: "agents-sub" });
  });
});
