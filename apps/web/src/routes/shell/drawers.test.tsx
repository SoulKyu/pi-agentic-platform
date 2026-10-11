// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAppearance } from "../../features/appearance/index.ts";
import { registerCommand, startKeybindings } from "../../features/commands/index.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { click, press, settle, typeInto } from "../../testing/dom.ts";
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
  return { SessionScreen: () => createElement("p", { "data-stub": "session" }) };
});

const session = (id: string, cwd: string, updatedAt: number, status = "idle") =>
  ({ id, cwd, status, createdAt: 1, updatedAt }) as const;

let bed: ReturnType<typeof fakeRuntime>;
let started: Array<{ stop(): void }> = [];
afterEach(() => {
  started.forEach((one) => one.stop());
  started = [];
});
beforeEach(() => {
  started = [startAppearance(window), startKeybindings()];
  bed = fakeRuntime("open");
  bed.handlers["settings.get"] = () => ({ value: null, revision: 0 });
  bed.handlers["sessions.list"] = () => ({
    sessions: [session("one", "/w/api", 1), session("two", "/w/api", 2, "running")],
  });
  current.runtime = bed.runtime;
  localStorage.clear();
  useSessionsCache.setState({ sessions: [], status: "idle" });
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
});

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const ctrlB = () => press(document.body, { key: "b", code: "KeyB", ctrlKey: true });
const opened = (title: string) =>
  vi.waitFor(() => expect(dialog()?.querySelector("h2")?.textContent).toBe(title), { timeout: 2_000 });

describe("tree drawer", () => {
  it("is not in the document until opened, then Ctrl+B lists the sessions grouped by folder", async () => {
    const page = await renderShell("/");
    await settle();
    expect(dialog()).toBeNull();
    await ctrlB();
    await opened("Sessions");
    const groups = [...(dialog()?.querySelectorAll("[data-group]") ?? [])];
    expect(groups.map((group) => group.getAttribute("data-group"))).toEqual(["/w/api"]);
    expect(groups[0]?.querySelector("h3")?.textContent).toBe("api");
    expect([...(groups[0]?.querySelectorAll("a") ?? [])].map((row) => row.getAttribute("href"))).toEqual([
      "/s/two",
      "/s/one",
    ]);
    await page.unmount();
  });

  it("opening a row navigates to the session and closes the drawer", async () => {
    const page = await renderShell("/");
    await settle();
    await ctrlB();
    await opened("Sessions");
    await click(dialog()?.querySelector('a[href="/s/one"]') as HTMLElement);
    await settle();
    expect(page.router.state.location.pathname).toBe("/s/one");
    await vi.waitFor(() => expect(dialog()).toBeNull(), { timeout: 2_000 });
    await page.unmount();
  });

  it("filters by folder and says so when nothing matches", async () => {
    const page = await renderShell("/");
    await settle();
    await ctrlB();
    await opened("Sessions");
    const filter = dialog()?.querySelector("input") as HTMLInputElement;
    await typeInto(filter, "zzz");
    expect(dialog()?.textContent).toContain("No session matches.");
    expect(dialog()?.querySelectorAll("a")).toHaveLength(0);
    await page.unmount();
  });

  it("shows 200 rows and says how many more, pointing to the palette chord", async () => {
    bed.handlers["sessions.list"] = () => ({
      sessions: Array.from({ length: 250 }, (_, i) => session(`s${i}`, `/w/p${i % 3}`, i)),
    });
    const page = await renderShell("/");
    await settle();
    await ctrlB();
    await opened("Sessions");
    expect(dialog()?.querySelectorAll("a")).toHaveLength(200);
    expect(dialog()?.textContent).toContain("50 more. Use Ctrl+K to find older sessions.");
    await page.unmount();
  });

  it("a failed list shows a banner with Retry, which asks again", async () => {
    let answers = 0;
    bed.handlers["sessions.list"] = () => {
      if (++answers <= 2) throw new Error("boom");
      return { sessions: [session("one", "/w/api", 1)] };
    };
    const page = await renderShell("/");
    await settle();
    await ctrlB();
    await opened("Sessions");
    await vi.waitFor(() => expect(dialog()?.querySelector('[data-slot="banner"]')).not.toBeNull(), {
      timeout: 2_000,
    });
    expect(dialog()?.textContent).toContain("The session list did not load.");
    const retry = [...(dialog()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Retry");
    await click(retry as HTMLElement);
    await settle();
    expect(dialog()?.querySelectorAll("a")).toHaveLength(1);
    await page.unmount();
  });

  it("Escape closes the drawer and does not stop the run", async () => {
    const stop = vi.fn();
    const off = registerCommand("session.stop", stop);
    const page = await renderShell("/s/one");
    await settle();
    await ctrlB();
    await opened("Sessions");
    await press(dialog() as HTMLElement, { key: "Escape", code: "Escape" });
    await vi.waitFor(() => expect(dialog()).toBeNull(), { timeout: 2_000 });
    expect(stop).not.toHaveBeenCalled();
    off();
    await page.unmount();
  });
});

describe("tree drawer, first load", () => {
  it("shows nothing at first, then a labelled spinner while the list is slow", async () => {
    let release: (value: unknown) => void = () => {};
    bed.handlers["sessions.list"] = () => new Promise((resolve) => (release = resolve));
    const page = await renderShell("/");
    await settle();
    await ctrlB();
    await opened("Sessions");
    expect(dialog()?.querySelector('[data-slot="spinner"]')).toBeNull();
    await vi.waitFor(
      () =>
        expect(dialog()?.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe(
          "Loading sessions",
        ),
      {
        timeout: 2_000,
      },
    );
    await act(async () => release({ sessions: [session("one", "/w/api", 1)] }));
    await settle();
    expect(dialog()?.querySelector('[data-slot="spinner"]')).toBeNull();
    expect(dialog()?.querySelectorAll("a")).toHaveLength(1);
    await page.unmount();
  });
});

describe("inbox drawer", () => {
  it("opens from its button with the empty state", async () => {
    const page = await renderShell("/");
    await settle();
    expect(dialog()).toBeNull();
    await click(page.container.querySelector('[aria-label="Inbox"]') as HTMLElement);
    await opened("Inbox");
    expect(dialog()?.getAttribute("data-variant")).toBe("drawer-right");
    expect(dialog()?.querySelector('[data-slot="empty-state"] h2')?.textContent).toBe(
      "Nothing waits for you",
    );
    expect(dialog()?.textContent).toContain(
      "Approvals, replies and finished tasks of your agents appear here, those that need you first.",
    );
    await page.unmount();
  });
});
