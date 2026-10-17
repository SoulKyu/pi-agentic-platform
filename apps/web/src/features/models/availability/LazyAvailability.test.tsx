// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, settle, text } from "../../../testing/dom.ts";
import { availabilityBed, current, overviewOfWorld } from "./availability-world.ts";
import { LazyAvailability } from "./index.ts";

vi.mock("../../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

// The section's chunk is gone (a tab open across a pap update) until `chunk.gone` is switched off.
const chunk = vi.hoisted(() => ({ gone: true }));
vi.mock("./AvailabilitySection.tsx", async (importOriginal) => {
  if (chunk.gone)
    throw new TypeError("Failed to fetch dynamically imported module: /assets/Availability-old.js");
  return importOriginal();
});

const toasts = vi.hoisted(() => [] as Array<{ message: string }>);
vi.mock("@pap/ui", async (original) => ({
  ...(await original<typeof import("@pap/ui")>()),
  toast: (input: { message: string }) => toasts.push(input),
}));
vi.mock("../../../lib/report.ts", () => ({ reportClientIssue: () => {} }));

beforeEach(() => {
  availabilityBed();
});
afterEach(() => {
  toasts.length = 0;
});

describe("LazyAvailability", () => {
  it("a gone chunk says to reload and leaves the rest of the screen alone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { world } = availabilityBed();
    const page = await mount(
      <LazyAvailability overview={overviewOfWorld(world)} reloadOverview={() => {}} />,
    );
    await vi.waitFor(
      async () => {
        await settle();
        expect(toasts).toHaveLength(1);
      },
      { timeout: 10_000 },
    );
    expect(toasts[0]?.message).toBe(
      "This part of pap did not load. pap may have been updated: reload the page.",
    );
    expect(text(page.container)).toBe("");
    chunk.gone = false;
  });
});
