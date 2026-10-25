// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { useCurrentProject } from "../../stores/current-project.ts";
import { useLaunchStore } from "../../stores/launch-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { shellProject, shellSnapshot } from "../../testing/shell-snapshot.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";

const current = vi.hoisted(() => ({
  runtime: undefined as Runtime | undefined,
  bed: undefined as { handlers: Record<string, (params: unknown) => unknown> } | undefined,
}));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../shell/HomePane.tsx", async () => {
  const { createElement } = await import("react");
  return { HomePane: () => createElement("p", { "data-stub": "home" }) };
});

let started: Array<{ stop(): void }> = [];
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  const bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  bed.handlers["mcp.overview"] = () => new Promise(() => undefined);
  current.runtime = bed.runtime;
  current.bed = bed;
  localStorage.clear();
  useShellStore.getState().reset();
  useLaunchStore.getState().reset();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(() => {
  vi.useRealTimers();
  started.forEach((one) => one.stop());
  started = [];
  vi.restoreAllMocks();
});

const bed = () => {
  if (current.bed === undefined) throw new Error("no bed");
  return current.bed;
};
const lines = () => document.querySelectorAll('[data-slot="loading-line"]');
const advance = (ms: number) =>
  act(async () => {
    vi.advanceTimersByTime(ms);
  });

async function mcpWhileReading() {
  const page = await renderShell("/settings/mcp");
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  return page;
}

describe("Settings › MCP loading", () => {
  it("shows one loading line, not two", async () => {
    const page = await mcpWhileReading();
    await advance(500);
    expect(lines()).toHaveLength(1);
    expect(document.body.textContent?.match(/Loading/g) ?? []).toHaveLength(1);
    await page.unmount();
  });

  it("a Pi read past 10 s says Pi is reading N things at once", async () => {
    const page = await mcpWhileReading();
    await act(async () => {
      useLaunchStore.getState().apply({ kind: "helpers", helpers: { active: 3, max: 4, waiting: 0 } });
    });
    await advance(9_000);
    expect(document.body.textContent).not.toContain("Pi is reading 3 things at once");
    await advance(1_500);
    expect(lines()).toHaveLength(1);
    expect(document.body.textContent).toContain("Pi is reading 3 things at once");
    await page.unmount();
  });
});

describe("a later wait starts its own loading line", () => {
  it("a retry after the first load starts its loading line from zero", async () => {
    let calls = 0;
    bed().handlers["users.list"] = () =>
      ++calls === 1 ? Promise.reject(new Error("down")) : new Promise(() => undefined);
    bed().handlers["users.providers"] = () => new Promise(() => undefined);
    const page = await renderShell("/settings/users");
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    await advance(130_000);
    const retry = [...document.querySelectorAll("button")].find((b) =>
      /try again|retry/i.test(b.textContent ?? ""),
    );
    expect(retry).toBeDefined();
    await act(async () => retry?.click());
    expect(lines()).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/\d+ min|\d+ s\b/);
    await page.unmount();
  });

  it("a folder change starts a fresh loading line", async () => {
    let calls = 0;
    bed().handlers["mcp.overview"] = () =>
      ++calls === 1 ? Promise.reject(new Error("down")) : new Promise(() => undefined);
    await act(async () =>
      useShellStore
        .getState()
        .apply(shellSnapshot([], { projects: [shellProject({ id: "p1" }), shellProject({ id: "p2" })] })),
    );
    useCurrentProject.setState({ projectId: "p1", storageRefused: false });
    const page = await renderShell("/settings/mcp");
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    await advance(130_000);
    await act(async () => useCurrentProject.setState({ projectId: "p2", storageRefused: false }));
    expect(calls).toBe(2);
    expect(lines()).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/\d+ min|\d+ s\b/);
    await page.unmount();
  });
});
