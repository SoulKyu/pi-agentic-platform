// @vitest-environment happy-dom
import { lazy } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasButton, mount, settle } from "../../testing/dom.ts";
import { isStaleChunk, PaneBoundary } from "./PaneBoundary.tsx";

const report = vi.hoisted(() => ({ reportClientIssue: vi.fn() }));
vi.mock("../../lib/report.ts", () => report);

let silenced: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  report.reportClientIssue.mockReset();
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
    expect(report.reportClientIssue.mock.calls).toEqual([["lazy_chunk_failed"]]);
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
    expect(report.reportClientIssue.mock.calls).toEqual([["render_failed"]]);
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

describe("isStaleChunk", () => {
  it("knows the Chromium, Safari and bundler wordings, and nothing else", () => {
    expect(isStaleChunk(new TypeError("Failed to fetch dynamically imported module: /a.js"))).toBe(true);
    expect(isStaleChunk(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isStaleChunk(Object.assign(new Error("x"), { name: "ChunkLoadError" }))).toBe(true);
    expect(isStaleChunk(new Error("boom"))).toBe(false);
    expect(isStaleChunk("Importing a module script failed")).toBe(false);
  });
});
