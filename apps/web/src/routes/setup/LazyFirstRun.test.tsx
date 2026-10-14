// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { button, click, mount, settle, type Mounted } from "../../testing/dom.ts";
import { LazyFirstRun } from "./LazyFirstRun.tsx";

const chunk = vi.hoisted(() => ({ failures: 1 }));
vi.mock("./FirstRun.tsx", () => {
  if (chunk.failures-- > 0) throw new Error("Failed to fetch dynamically imported module");
  return { FirstRun: () => <p data-stub="first-run">first run</p> };
});
vi.mock("../../lib/lazy.tsx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/lazy.tsx")>()),
  notifyLazyFailure: vi.fn(),
}));

let page: Mounted | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
});

describe("LazyFirstRun", () => {
  it("leaves a Retry on the screen when the chunk fails to load, and shows the stepper after it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    page = await mount(<LazyFirstRun onDone={vi.fn()} onAccountCreated={vi.fn()} />);
    await settle();
    await vi.waitFor(() => expect(button(page?.container as HTMLElement, "Retry")).toBeTruthy(), {
      timeout: 5000,
    });
    await click(button(page.container, "Retry"));
    await settle();
    await vi.waitFor(() => expect(page?.container.querySelector("[data-stub=first-run]")).not.toBeNull(), {
      timeout: 5000,
    });
  });
});
