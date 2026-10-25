// @vitest-environment happy-dom
import { Toaster } from "@pap/ui";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionScreen } from "./SessionScreen.tsx";
import type { Runtime } from "../../runtime/index.ts";
import { click } from "../../testing/dom.ts";
import { sessionSnapshot } from "../../testing/session-snapshot.ts";
import { screenBed } from "../../testing/screen-bed.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; children: ReactNode }) =>
      createElement("a", { href: props.to }, props.children),
    useNavigate: () => () => Promise.resolve(),
  };
});

const screen = screenBed(current);
beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

const toasts = () =>
  [...document.querySelectorAll('[data-slot="toast"]')].map((node) => node.textContent ?? "");
const lines = (container: ParentNode) =>
  [...container.querySelectorAll("[data-notice]")].map((node) => node.textContent);

const snapshot = async (patch: Record<string, unknown>) => screen.emit(sessionSnapshot(patch));

/** The Toaster keeps module state across tests: the fake clock lets what an earlier test left expire before the real events. */
async function open(patch: Record<string, unknown> = {}) {
  const container = await screen.remount(
    <>
      <SessionScreen sessionId="sess-1" />
      <Toaster closeLabel="Close toast" regionLabel="Notifications" />
    </>,
  );
  await act(async () => {
    vi.advanceTimersByTime(6000);
  });
  await snapshot(patch);
  return container;
}

describe("notices in the session screen", () => {
  it("shows a live info notice as a toast and not as a line", async () => {
    const container = await open();
    await screen.emit({ kind: "notice", level: "info", text: "Saved." });
    expect(toasts()).toEqual(["Saved."]);
    expect(lines(container)).toEqual([]);
  });

  it("closes a toast after 5 s", async () => {
    await open();
    await screen.emit({ kind: "notice", level: "info", text: "Saved." });
    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(toasts()).toEqual(["Saved."]);
    await act(async () => {
      vi.advanceTimersByTime(1400);
    });
    expect(toasts()).toEqual([]);
  });

  it("keeps the extension label inside the toast", async () => {
    await open();
    await screen.emit({ kind: "notice", level: "info", text: "Ponytail loaded: full", source: "extension" });
    expect(toasts()).toEqual(["from an extension: Ponytail loaded: full"]);
  });

  it("does not toast, nor draw, an info notice a snapshot carries", async () => {
    const container = await open({ notices: [{ level: "info", text: "Old news", source: "extension" }] });
    expect(toasts()).toEqual([]);
    expect(lines(container)).toEqual([]);
  });

  it("shows only the latest 3 toasts of a flood", async () => {
    await open();
    for (const n of [1, 2, 3, 4, 5]) await screen.emit({ kind: "notice", level: "info", text: `n${n}` });
    expect(toasts()).toEqual(["n3", "n4", "n5"]);
  });

  it("keeps a warning and an error as lines with a dismiss, and keeps them dismissed after a snapshot replay", async () => {
    const notices = [
      { level: "warning", text: "Disk is nearly full" },
      { level: "error", text: "Boom" },
    ];
    const container = await open({ notices });
    expect(lines(container)).toEqual(["Disk is nearly full", "Boom"]);
    // a server-pushed notice is a background event: a polite status with the warning icon, never an alert
    const boom = container.querySelector('[data-notice][role="status"]');
    expect(boom?.textContent).toBe("Boom");
    expect(boom?.querySelector("svg")).not.toBeNull();
    expect(container.querySelector('[data-notice][role="alert"]')).toBeNull();
    expect(toasts()).toEqual([]);
    const dismiss = container.querySelectorAll<HTMLElement>('[data-notice] [aria-label="Dismiss"]');
    await click(dismiss[1] as HTMLElement);
    expect(lines(container)).toEqual(["Disk is nearly full"]);
    await snapshot({ notices });
    expect(lines(container)).toEqual(["Disk is nearly full"]);
  });
});
