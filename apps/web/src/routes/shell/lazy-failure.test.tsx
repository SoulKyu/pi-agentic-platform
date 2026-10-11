// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { runCommand, startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { settle } from "../../testing/dom.ts";
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
// A pap update removed the chunk: the dynamic import rejects.
vi.mock("../../features/commands/ShortcutsHelp.tsx", () => {
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

describe("a shell lazy chunk that is gone (M3-RT-15)", () => {
  it("leaves the shell standing and says to reload", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const page = await renderShell("/");
    runCommand("shortcuts.help");
    await vi.waitFor(
      () =>
        expect(document.body.textContent).toContain(
          "This part of pap did not load. pap may have been updated: reload the page.",
        ),
      { timeout: 2_000 },
    );
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(page.container.querySelector('[data-shell="desktop"]')).not.toBeNull();
    expect([...document.querySelectorAll("button")].some((b) => b.textContent === "Reload")).toBe(true);
    await page.unmount();
  });
});
