// @vitest-environment happy-dom
import { act } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { button, hasButton } from "../../testing/dom.ts";
import { boxProject } from "../../testing/box-fixtures.ts";
import { menuLabels, openMenu, preloadMenu } from "../../testing/menu.ts";
import { screenBed } from "../../testing/screen-bed.tsx";
import { shellSnapshot } from "../../testing/shell-snapshot.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined, navigate: vi.fn() }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: (props: { to: string; children: unknown }) =>
      createElement("a", { href: props.to }, props.children as never),
    useNavigate: () => current.navigate,
  };
});

beforeAll(preloadMenu);
const screen = screenBed(current);
const rows = [
  { entryId: "u1", message: { role: "user", content: "first question", timestamp: 1 } },
  {
    entryId: "a2",
    message: { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 5 },
  },
];

beforeEach(() => {
  useShellStore.getState().reset();
});

describe("a session in a project's box", () => {
  it("offers neither Fork from here nor Duplicate (the daemon refuses both)", async () => {
    await act(async () =>
      useShellStore.getState().apply(shellSnapshot([], { projects: [boxProject("running")] })),
    );
    const container = await screen.show({ rows, cwd: "/boxes/b1/project/src" });
    expect(hasButton(container, "Fork from here")).toBe(false);
    expect(hasButton(container, "Edit from here")).toBe(true);
    await openMenu(button(container, "Session actions"));
    expect(menuLabels()).not.toContain("Duplicate");
    expect(menuLabels()).toContain("Export");
  });

  it("keeps both for a host session", async () => {
    const container = await screen.show({ rows });
    expect(hasButton(container, "Fork from here")).toBe(true);
    await openMenu(button(container, "Session actions"));
    expect(menuLabels()).toContain("Duplicate");
  });
});
