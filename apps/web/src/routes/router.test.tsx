// @vitest-environment happy-dom
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasButton, mount } from "../testing/dom.ts";
import { buildRouteTree, createAppRouter } from "./router.tsx";

let silenced: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  silenced = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => silenced.mockRestore());

const Thrower = (): never => {
  throw new Error("boom");
};
const Fine = () => <p data-ok="yes">fine</p>;

async function show(Root: () => React.ReactNode) {
  const router = createAppRouter(buildRouteTree(Root), createMemoryHistory({ initialEntries: ["/"] }));
  return mount(<RouterProvider router={router} />);
}

describe("router", () => {
  it("a root component that throws shows the translated error screen with Reload, not TanStack's default", async () => {
    const page = await show(Thrower);
    expect(page.container.querySelector("h2")?.textContent).toBe("This screen stopped working");
    expect(hasButton(page.container, "Reload")).toBe(true);
    expect(page.container.textContent).not.toContain("boom");
    await page.unmount();
  });

  it("a root that renders fine shows no error heading", async () => {
    const page = await show(Fine);
    expect(page.container.querySelector('[data-ok="yes"]')).not.toBeNull();
    expect(page.container.querySelector("h2")).toBeNull();
    await page.unmount();
  });

  it("declares the five routes", () => {
    const router = createAppRouter(buildRouteTree(Fine), createMemoryHistory({ initialEntries: ["/"] }));
    expect(Object.keys(router.routesByPath).sort()).toEqual([
      "/",
      "/dev/ui",
      "/s/$sessionId",
      "/settings",
      "/settings/$section",
    ]);
  });
});
