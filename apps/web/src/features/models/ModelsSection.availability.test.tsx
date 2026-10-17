// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { settle } from "../../testing/dom.ts";
import { current, newBed, show } from "./models-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

describe("Settings > Models with the availability view", () => {
  it("mounts the view above the provider list and reads the preview once", async () => {
    const bed = newBed();
    const page = await show();
    await vi.waitFor(async () => {
      await settle();
      expect(page.container.querySelector("[data-availability]")).not.toBeNull();
    });
    const view = page.container.querySelector("[data-availability]") as HTMLElement;
    const list = page.container.querySelector('ul[aria-label="Providers"]') as HTMLElement;
    expect(view.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bed.called("models.available")).toHaveLength(1);
    // The owner's q11 answer: no Restrictions tab or placeholder anywhere on the screen.
    expect(page.container.textContent).not.toMatch(/restriction/i);
  });
});
