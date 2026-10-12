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
