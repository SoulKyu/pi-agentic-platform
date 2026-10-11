// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { press, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { useSessionsCache } from "./sessions-cache.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("../../features/sessions/SessionListScreen.tsx", async () => {
  const { createElement } = await import("react");
  return { SessionListScreen: () => createElement("p", { "data-stub": "home" }) };
});
// A pap update removed the palette chunk: the dynamic import rejects.
vi.mock("../../features/commands/palette/CommandPalette.tsx", () => {
  throw new Error("chunk gone");
});

let started: Array<{ stop(): void }> = [];
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
  vi.restoreAllMocks();
});
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  const bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  current.runtime = bed.runtime;
  localStorage.clear();
  useSessionsCache.setState({ sessions: [], status: "idle" });
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});

const reloads = () =>
  [...document.querySelectorAll("button")].filter((b) => b.textContent === "Reload").length;

describe("a palette chunk that is gone (M3-RT-15)", () => {
  it("leaves the shell standing, says to reload, and tries again on the next open", async () => {
    const expectedErrors: string[] = [];
    const expectedWarns: string[] = [];
    const realError = console.error;
    const realWarn = console.warn;
    // Only the two known messages are swallowed (and asserted below); anything else still reaches the console.
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.includes("There was an error when mocking a module"))
        expectedErrors.push("mock-factory-threw");
      else realError(...args);
    });
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line === "pap: lazy_chunk_failed") expectedWarns.push(line);
      else realWarn(...args);
    });
    const page = await renderShell("/");
    await press(document.body, { key: "k", code: "KeyK", ctrlKey: true });
    await vi.waitFor(() => expect(reloads()).toBe(1), { timeout: 2_000 });
    await settle();
    expect(page.container.querySelector('[data-pane-kind="home"]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await press(document.body, { key: "k", code: "KeyK", ctrlKey: true });
    await vi.waitFor(() => expect(reloads()).toBe(2), { timeout: 2_000 });
    expect(page.container.querySelector('[data-shell="desktop"]')).not.toBeNull();
    expect([expectedErrors, expectedWarns]).toEqual([
      ["mock-factory-threw", "mock-factory-threw"],
      ["pap: lazy_chunk_failed"], // the client log says each code once
    ]);
    await page.unmount();
  });
});
