// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { registerCommand, startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { press, settle, typeInto } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";
import { useShellStore } from "../../stores/shell-store.ts";

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
  current.runtime = bed.runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});

const feed = () =>
  act(async () =>
    bed.emitTo("subscribe.shell", shellSnapshot([shellSession({ id: "abc", cwd: "/home/ana/pi-agentic" })])),
  );
const ctrlK = () => press(document.body, { key: "k", code: "KeyK", ctrlKey: true });
const listbox = () => document.querySelector('[role="listbox"]');
const waitOpen = () => vi.waitFor(() => expect(listbox()).not.toBeNull(), { timeout: 2_000 });

describe("the palette in the shell", () => {
  it("has no listbox until Ctrl+K, toggles with the chord, and never lists sessions", async () => {
    const page = await renderShell("/");
    await settle();
    expect(listbox()).toBeNull();
    await ctrlK();
    await waitOpen();
    await settle();
    expect(bed.called("sessions.list")).toEqual([]);
    expect(document.querySelector("[data-pap-modal] [data-command-palette]")).not.toBeNull();
    await ctrlK();
    await settle();
    expect(listbox()).toBeNull();
    await page.unmount();
  });

  it("opens a session picked from the list, and Escape closes the palette", async () => {
    const page = await renderShell("/");
    await settle();
    await feed();
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
    await page.unmount();
  });

  it("spends no row on an archived session", async () => {
    const page = await renderShell("/");
    await settle();
    await act(async () =>
      bed.emitTo(
        "subscribe.shell",
        shellSnapshot([
          shellSession({ id: "live", cwd: "/w/live", updatedAt: 1 }),
          shellSession({ id: "gone", cwd: "/w/gone", updatedAt: 9, archivedAt: 5 }),
        ]),
      ),
    );
    await ctrlK();
    await waitOpen();
    await settle();
    const rows = [...document.querySelectorAll('[role="option"]')].map((el) => el.textContent);
    expect(rows).toContain("live/w/live");
    expect(rows).not.toContain("gone/w/gone");
    await page.unmount();
  });

  it("Escape inside the palette closes the palette and never stops the run", async () => {
    const stop = vi.fn();
    const off = registerCommand("session.stop", stop);
    const page = await renderShell("/s/abc");
    await settle();
    // The focus is in the dialog's portal, so mark the page as a focused session to make the rule eligible.
    document.body.setAttribute("data-pane-kind", "session");
    try {
      await press(document.body, { key: "Escape" });
      expect(stop).toHaveBeenCalledOnce(); // premise: with no palette open, this Escape stops the run
      stop.mockClear();
      await ctrlK();
      await waitOpen();
      await settle();
      const field = document.querySelector("input") as HTMLInputElement;
      expect(document.activeElement).toBe(field);
      await press(field, { key: "Escape" });
      await settle();
      expect([listbox(), stop.mock.calls.length]).toEqual([null, 0]);
    } finally {
      document.body.removeAttribute("data-pane-kind");
      off();
      await page.unmount();
    }
  });
});
