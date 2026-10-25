// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { usePaletteRequest } from "../../stores/palette-request.ts";
import { registerCommand } from "../../lib/command-registry.ts";
import { button, click, hasButton, settle, text } from "../../testing/dom.ts";
import { screenBed } from "../../testing/screen-bed.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined, navigate: vi.fn() }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; children: ReactNode }) =>
      createElement("a", { href: props.to }, props.children),
    useNavigate: () => current.navigate,
  };
});

const screen = screenBed(current);

describe("SessionScreen, a session that does not exist", () => {
  it("a not_found feed shows the EmptyState with its two actions, and no composer or status chip", async () => {
    current.navigate.mockResolvedValue(undefined);
    screen.bed.handlers["subscribe.session"] = () => {
      throw new RpcError("not_found");
    };
    const container = await screen.remount();
    await settle();
    const empty = container.querySelector("[data-slot='empty-state']");
    expect(empty?.querySelector("h2")?.textContent).toBe("This session no longer exists");
    expect(text(empty as HTMLElement)).toContain("Your other sessions are intact.");
    expect(container.querySelector("[data-composer]")).toBeNull();
    expect(container.querySelector("[data-slot='chip']")).toBeNull();
    expect(container.querySelector("[role='alert']")).toBeNull();
    await click(button(container, "Back to the project"));
    expect(current.navigate).toHaveBeenCalledWith({ to: "/" });
    expect(hasButton(container, "Search sessions")).toBe(true);
    const toggle = vi.fn();
    const off = registerCommand("palette.toggle", toggle);
    await click(button(container, "Search sessions"));
    off();
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(usePaletteRequest.getState().search).toEqual({ projectId: null });
  });
});
