// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import { runCommand } from "../../lib/command-registry.ts";
import type { Runtime } from "../../runtime/index.ts";
import { usePaletteRequest } from "../../stores/palette-request.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { press, settle, typeInto } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { renderShell } from "../../testing/shell-bed.tsx";
import { shellProject, shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("./HomePane.tsx", async () => {
  const { createElement } = await import("react");
  return { HomePane: () => createElement("p", { "data-stub": "home" }) };
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
  usePaletteRequest.setState({ search: null });
});

const input = () => document.querySelector("[data-command-palette] input") as HTMLInputElement | null;

describe("the home's Search opens ⌘K for transcripts (§3.2)", () => {
  it("opens in search mode for the project, and the next plain ⌘K is the usual palette", async () => {
    const page = await renderShell("/");
    await settle();
    await act(async () =>
      bed.emitTo(
        "subscribe.shell",
        shellSnapshot([shellSession({ id: "a1", projectId: "p1" })], {
          projects: [shellProject({ id: "p1", name: "api", sessions: 1 })],
        }),
      ),
    );
    await act(async () => {
      usePaletteRequest.getState().askSearch("p1");
      runCommand("palette.toggle");
    });
    await vi.waitFor(() => expect(input()).not.toBeNull(), { timeout: 2_000 });
    expect(input()?.getAttribute("aria-label")).toBe("Search transcripts in api");
    await press(input() as HTMLInputElement, { key: "Escape" });
    await settle();
    await press(document.body, { key: "k", code: "KeyK", ctrlKey: true });
    await vi.waitFor(() => expect(input()).not.toBeNull(), { timeout: 2_000 });
    expect(input()?.getAttribute("aria-label")).toBe("Search commands and sessions");
    await page.unmount();
  });

  it("searches every project, and says so, when the asked project is unknown", async () => {
    const hit = (id: string, projectId: string) => ({
      sessionId: id,
      entryId: `${id}-e`,
      role: "assistant",
      at: 1,
      snippet: "the \u0002kube\u0003 cluster",
      session: shellSession({ id, name: `Notes ${id}`, projectId }),
    });
    bed.handlers["search.query"] = () => ({ hits: [hit("h1", "p1"), hit("h2", "p2")] });
    const page = await renderShell("/");
    await settle();
    await act(async () => {
      usePaletteRequest.getState().askSearch("gone");
      runCommand("palette.toggle");
    });
    await vi.waitFor(() => expect(input()).not.toBeNull(), { timeout: 2_000 });
    expect(input()?.getAttribute("aria-label")).toBe("Search transcripts");
    await typeInto(input() as HTMLInputElement, "kube");
    await vi.waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(2), {
      timeout: 2_000,
    });
    expect(bed.called("subscribe.tasks")).toHaveLength(0);
    await page.unmount();
  });
});
