// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
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

const heading = (container: HTMLElement) => container.querySelector("[data-session-name]");

describe("SessionScreen header name", () => {
  it("shows the session name as text only, and follows a rename", async () => {
    const container = await screen.show({ name: '<b onclick="x()">Release</b> prep' });
    expect(heading(container)?.textContent).toBe('<b onclick="x()">Release</b> prep');
    expect(container.querySelector("header b")).toBeNull();
    await screen.emit({ kind: "name", name: "Renamed" });
    expect(heading(container)?.textContent).toBe("Renamed");
  });

  it("shows no name element when the session has none, and no rename field until Rename is chosen", async () => {
    const container = await screen.show({ name: null });
    expect(heading(container)).toBeNull();
    expect(container.querySelectorAll("header input")).toHaveLength(0);
    expect(container.querySelectorAll("header button[aria-label='Session actions']")).toHaveLength(1);
  });

  it("keeps the session actions in the header row, as one menu button at its end", async () => {
    const container = await screen.show({ name: "Release prep" });
    const header = container.querySelector("header") as HTMLElement;
    expect(header.querySelector("[data-session-actions]")).not.toBeNull();
    expect(container.querySelectorAll("section[data-session-actions]")).toHaveLength(0);
    for (const name of ["Rename", "Name it", "Compact", "Export", "Duplicate"])
      expect([...container.querySelectorAll("button")].some((b) => b.textContent === name)).toBe(false);
  });
});

describe("SessionScreen header navigation", () => {
  it("has no back link to the session list: tabs, the drawer and the palette navigate (decision 25)", async () => {
    const container = await screen.show({ name: "Release prep" });
    expect(container.querySelector("header a")).toBeNull();
    expect(container.querySelector("header")?.textContent).not.toContain("Sessions");
  });
});

describe("SessionScreen run status chip", () => {
  const chip = (container: HTMLElement) => container.querySelector("header [data-slot='chip']");
  const state = (container: HTMLElement) => [
    chip(container)?.getAttribute("data-tone"),
    chip(container)?.textContent,
  ];

  it("shows what the run needs from you before how the process is", async () => {
    const container = await screen.show({ status: "idle" });
    expect(state(container)).toEqual(["ok", "Ready"]);
    await screen.emit({ kind: "status", status: "running" });
    expect(state(container)).toEqual(["run", "Working"]);
    await screen.emit({
      kind: "dialog_open",
      dialog: {
        id: "a1",
        method: "approval",
        title: "Run?",
        message: "1 line\nls",
        category: "exec",
        answers: ["deny", "once"],
      },
    });
    expect(state(container)).toEqual(["att", "Needs you"]);
    await screen.emit({ kind: "status", status: "cold" });
    expect(state(container)).toEqual(["mut", "Stopped"]);
  });
});
