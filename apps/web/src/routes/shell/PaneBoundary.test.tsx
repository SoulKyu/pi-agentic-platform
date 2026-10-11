// @vitest-environment happy-dom
import { lazy } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasButton, mount, settle } from "../../testing/dom.ts";
import { PaneBoundary } from "./PaneBoundary.tsx";

let silenced: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  silenced = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => silenced.mockRestore());

const rejecting = (failure: Error) => lazy(() => Promise.reject(failure) as Promise<never>);

describe("PaneBoundary", () => {
  it("a stale chunk (failing lazy import) shows the translated 'updated' screen with Reload", async () => {
    const Stale = rejecting(new TypeError("Failed to fetch dynamically imported module: /assets/x.js"));
    const page = await mount(
      <PaneBoundary>
        <Stale />
      </PaneBoundary>,
    );
    await settle();
    expect(page.container.querySelector("h2")?.textContent).toBe("pap was updated");
    expect(hasButton(page.container, "Reload")).toBe(true);
    await page.unmount();
  });

  it("any other failure shows the generic error screen", async () => {
    const Broken = rejecting(new Error("boom"));
    const page = await mount(
      <PaneBoundary>
        <Broken />
      </PaneBoundary>,
    );
    await settle();
    expect(page.container.querySelector("h2")?.textContent).toBe("This screen stopped working");
    await page.unmount();
  });

  it("shows the loading line while a lazy screen loads, then the screen", async () => {
    const Slow = lazy(async () => ({ default: () => <p data-ok="yes">ready</p> }));
    const page = await mount(
      <PaneBoundary>
        <Slow />
      </PaneBoundary>,
    );
    await settle();
    expect(page.container.querySelector('[data-ok="yes"]')).not.toBeNull();
    await page.unmount();
  });
});
