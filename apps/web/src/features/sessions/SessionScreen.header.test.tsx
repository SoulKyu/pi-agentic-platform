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

  it("shows no name element when the session has none, and no rename control", async () => {
    const container = await screen.show({ name: null });
    expect(heading(container)).toBeNull();
    expect(container.querySelectorAll("header button, header input")).toHaveLength(0);
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
