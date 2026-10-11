// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { press, settle, typeInto } from "../../testing/dom.ts";
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
vi.mock("../../features/sessions/SessionScreen.tsx", async () => {
  const { createElement } = await import("react");
  return {
    SessionScreen: ({ sessionId }: { sessionId: string }) =>
      createElement("p", { "data-stub": "session" }, sessionId),
  };
});

let started: Array<{ stop(): void }> = [];
let bed: ReturnType<typeof fakeRuntime>;
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
});
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  bed.handlers["sessions.list"] = () => ({
    sessions: [{ id: "abc", cwd: "/home/ana/pi-agentic", status: "idle", createdAt: 1, updatedAt: 2 }],
  });
  current.runtime = bed.runtime;
  localStorage.clear();
  useSessionsCache.setState({ sessions: [], status: "idle" });
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});

const ctrlK = () => press(document.body, { key: "k", code: "KeyK", ctrlKey: true });
const listbox = () => document.querySelector('[role="listbox"]');
const waitOpen = () => vi.waitFor(() => expect(listbox()).not.toBeNull(), { timeout: 2_000 });

describe("the palette in the shell", () => {
  it("has no listbox until Ctrl+K, toggles with the chord, and refreshes the sessions on open", async () => {
    const page = await renderShell("/");
    await settle();
    expect(listbox()).toBeNull();
    const before = bed.called("sessions.list").length;
    await ctrlK();
    await waitOpen();
    await settle();
    expect(bed.called("sessions.list")).toHaveLength(before + 1);
    expect(document.querySelector("[data-pap-modal] [data-command-palette]")).not.toBeNull();
    await ctrlK();
    await settle();
    expect(listbox()).toBeNull();
    await page.unmount();
  });

  it("opens a session picked from the list, and Escape closes the palette", async () => {
    const page = await renderShell("/");
    await settle();
    await ctrlK();
    await waitOpen();
    await settle();
    await typeInto(document.querySelector("input") as HTMLInputElement, "agentic");
    expect([...document.querySelectorAll('[role="option"]')].map((el) => el.textContent)).toEqual([
      "pi-agentic/home/ana/pi-agentic",
    ]);
    await press(document.querySelector("input") as HTMLInputElement, { key: "Enter" });
    await settle();
    await settle();
    expect(page.router.state.location.pathname).toBe("/s/abc");
    expect(listbox()).toBeNull();
    await ctrlK();
    await waitOpen();
    await press(document.querySelector("input") as HTMLInputElement, { key: "Escape" });
    await settle();
    expect(listbox()).toBeNull();
    await page.unmount();
  });
});
