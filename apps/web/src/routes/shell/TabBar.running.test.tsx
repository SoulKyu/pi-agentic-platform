// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { useShellStore } from "../../stores/shell-store.ts";
import { shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../../features/sessions/SessionScreen.tsx", async () => {
  const { createElement } = await import("react");
  return { SessionScreen: () => createElement("p", { "data-stub": "session" }) };
});

let started: Array<{ stop(): void }> = [];
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  const bed = fakeRuntime("idle");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  useShellStore
    .getState()
    .apply(shellSnapshot([shellSession({ id: "a", cwd: "/home/ana/a", status: "running", updatedAt: 2 })]));
  useWorkspaceStore.setState({
    ws: {
      tabs: [{ key: "session:a", item: { kind: "session", id: "a" }, split: null }],
      active: "session:a",
    },
  });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
});

describe("TabBar running state", () => {
  it("a running session's tab says Working to screen readers", async () => {
    const page = await renderShell("/s/a");
    const tab = page.container.querySelector('[role="tab"]') as HTMLElement;
    expect(tab.querySelector(".sr-only")?.textContent).toBe("Working");
    await page.unmount();
  });
});
