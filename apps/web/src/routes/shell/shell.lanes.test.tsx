// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/rpc.ts";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { useWorkspaceStore } from "../../features/workspace/index.ts";
import { registerCommand } from "../../lib/command-registry.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useLaneStore } from "../../stores/lane-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { click, press, settle } from "../../testing/dom.ts";
import { fanoutView, laneSnapshot, laneView } from "../../testing/lane-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("./HomePane.tsx", async () => {
  const { createElement } = await import("react");
  return { HomePane: () => createElement("p") };
});

const FAN = "0123456789abcdef";
let started: Array<{ stop(): void }> = [];
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  const bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  useLaneStore.getState().reset();
  useWorkspaceStore.setState({ ws: { tabs: [], active: null } });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
});

const loadLane = (id: string, patch = {}) => {
  useLaneStore
    .getState()
    .apply(laneSnapshot([laneView({ id, branch: "pi/fix-a", ...patch })], [fanoutView({ id: FAN })], 2));
};

describe("lanes in the shell", () => {
  it("a lane tab reads its branch and a status dot with the status word for screen readers", async () => {
    useShellStore
      .getState()
      .apply(
        shellSnapshot([shellSession({ id: "s", cwd: "/p/worktrees/fix-a-1a2b/src", status: "running" })]),
      );
    loadLane("fix-a-1a2b");
    useWorkspaceStore.setState({
      ws: {
        tabs: [{ key: "lane:fix-a-1a2b", item: { kind: "lane", id: "fix-a-1a2b" }, split: null }],
        active: "lane:fix-a-1a2b",
      },
    });
    const page = await renderShell("/lane/fix-a-1a2b");
    await settle();
    const tab = page.container.querySelector<HTMLElement>('[role="tab"]');
    expect(tab?.textContent).toBe("pi/fix-a Working");
    expect(tab?.querySelector("[aria-hidden]")?.className).toContain("bg-agent-fill");
    expect(tab?.querySelector(".sr-only")?.textContent).toBe("Working");
    await page.unmount();
  });

  it("a compare tab reads its lane count", async () => {
    loadLane("fix-a-1a2b");
    useLaneStore
      .getState()
      .apply({ kind: "fanout", fanout: fanoutView({ id: FAN, laneIds: ["a-1a2b", "b-1a2b", "c-1a2b"] }) });
    useWorkspaceStore.setState({
      ws: {
        tabs: [{ key: `compare:${FAN}`, item: { kind: "compare", id: FAN }, split: null }],
        active: `compare:${FAN}`,
      },
    });
    const page = await renderShell(`/compare/${FAN}`);
    await settle();
    expect(page.container.querySelector('[role="tab"]')?.textContent).toBe("Compare · 3 lanes");
    await page.unmount();
  });

  it("a lane the store no longer holds says it was archived and points to the archived list", async () => {
    loadLane("other-1a2b");
    const page = await renderShell("/lane/gone-1a2b");
    await vi.waitFor(() => expect(page.container.textContent).toContain("This lane was archived"), {
      timeout: 2_000,
    });
    expect(page.container.textContent).toContain("Archived lanes");
    await page.unmount();
  });

  it("Ctrl+Shift+L runs lanes.new", async () => {
    const handler = vi.fn();
    const off = registerCommand("lanes.new", handler);
    const page = await renderShell("/");
    const event = await press(document.body, { key: "L", code: "KeyL", ctrlKey: true, shiftKey: true });
    expect(handler).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    off();
    await page.unmount();
  });

  it("sign-out (unmount) empties the lane store", async () => {
    loadLane("fix-a-1a2b");
    const page = await renderShell("/");
    await settle();
    expect(useLaneStore.getState().view.lanes.size).toBe(1);
    await page.unmount();
    expect(useLaneStore.getState().view).toMatchObject({ loaded: false, archived: 0 });
    expect(useLaneStore.getState().view.lanes.size).toBe(0);
  });
});

describe("a lane tab with a refused stream", () => {
  it("shows the error and a Retry that resubscribes, never Loading forever", async () => {
    const bed = fakeRuntime("open");
    bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
    bed.handlers["subscribe.lane"] = () => {
      throw new RpcError("capacity");
    };
    current.runtime = bed.runtime;
    const page = await renderShell("/lane/fix-a-1a2b");
    await vi.waitFor(() => expect(page.container.textContent).toContain("Lanes did not load"), {
      timeout: 2_000,
    });
    expect(page.container.textContent).not.toContain("Loading lanes");
    const before = bed.called("subscribe.lane").length;
    const retry = [...page.container.querySelectorAll("button")].find(
      (b) => b.textContent === "Retry",
    ) as HTMLElement;
    await click(retry);
    await settle();
    expect(bed.called("subscribe.lane").length).toBeGreaterThan(before);
    await page.unmount();
  });
});
