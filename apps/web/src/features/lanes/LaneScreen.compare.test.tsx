// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { button, click, hasButton, settle } from "../../testing/dom.ts";
import { load, phone, resetLaneScreenBed, show } from "../../testing/lane-screen-bed.tsx";
import { current } from "./lanes-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const FANOUT = "0123456789abcdef";
beforeEach(resetLaneScreenBed);
afterEach(() => vi.unstubAllGlobals());

describe("lane header: the fan-out's compare (§5)", () => {
  it("links a fan-out's lane to its compare tab", async () => {
    load({ fanoutId: FANOUT, fanoutSlot: 0 });
    const openCompare = vi.fn();
    const page = await show({ openCompare });
    await click(button(page.container, "Compare"));
    expect(openCompare).toHaveBeenCalledExactlyOnceWith(FANOUT);
  });

  it("offers no Compare for a lane outside a fan-out", async () => {
    load();
    const page = await show({ openCompare: vi.fn() });
    expect(hasButton(page.container, "Compare")).toBe(false);
  });

  it("puts Compare in the phone's sheet", async () => {
    phone(true);
    load({ fanoutId: FANOUT, fanoutSlot: 1 });
    const openCompare = vi.fn();
    const page = await show({ openCompare });
    await click(button(page.container, "Lane actions"));
    await settle();
    await click(button(document.body, "Compare"));
    expect(openCompare).toHaveBeenCalledExactlyOnceWith(FANOUT);
  });
});
