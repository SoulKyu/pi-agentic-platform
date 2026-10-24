// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useCurrentProject } from "../../stores/current-project.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { boxProject } from "../../testing/box-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { shellSnapshot } from "../../testing/shell-snapshot.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../shell/HomePane.tsx", async () => {
  const { createElement } = await import("react");
  return { HomePane: () => createElement("p", { "data-stub": "home" }) };
});

let started: Array<{ stop(): void }> = [];
let bed = fakeRuntime("open");
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
  vi.restoreAllMocks();
});

async function shownInBox(path: string) {
  await act(async () =>
    useShellStore.getState().apply(shellSnapshot([], { projects: [boxProject("running")] })),
  );
  useCurrentProject.setState({ projectId: "b1", storageRefused: false });
  const page = await renderShell(path);
  await vi.waitFor(() => expect(document.querySelector("[data-settings-screen]")).not.toBeNull(), {
    timeout: 2_000,
  });
  return page;
}

describe("Settings with a box project current (the host cannot open its folder)", () => {
  it("MCP asks for the global list only and says the project part is not available", async () => {
    const page = await shownInBox("/settings/mcp");
    await vi.waitFor(() => expect(bed.called("mcp.overview").length).toBeGreaterThan(0), { timeout: 2_000 });
    for (const call of bed.called("mcp.overview")) expect(call.params).not.toHaveProperty("cwd");
    expect(document.body.textContent).toContain("Not available in a box yet.");
    await page.unmount();
  });

  it("Skills asks for the global lists only, with no trust check of the box folder", async () => {
    const page = await shownInBox("/settings/skills");
    await vi.waitFor(() => expect(bed.called("skills.list").length).toBeGreaterThan(0), { timeout: 2_000 });
    for (const call of [...bed.called("skills.list"), ...bed.called("plugins.list")])
      expect(call.params).not.toHaveProperty("cwd");
    expect(bed.called("trust.status")).toEqual([]);
    expect(document.body.textContent).toContain("Not available in a box yet.");
    await page.unmount();
  });
});
