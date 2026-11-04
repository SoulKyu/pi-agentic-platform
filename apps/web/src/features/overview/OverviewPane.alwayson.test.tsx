// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, text } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { NOW, box, ownerSnapshot } from "./overview-fixtures.ts";
import { cards, callbacks, showIn } from "./overview-bed.tsx";

vi.mock("../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));
const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  bed = fakeRuntime();
  current.runtime = bed.runtime;
});
afterEach(() => {
  setLocale("en");
  vi.useRealTimers();
});

const pins = (root: ParentNode) => [...root.querySelectorAll('[data-slot="icon"]')];

describe("OverviewPane: always on", () => {
  it("shows a muted Always on chip with a pin in the card's facts row", async () => {
    const root = await showIn(bed, ownerSnapshot({ boxes: [box({ alwaysOn: true })] }), callbacks());
    const footer = (cards(root)[0] as HTMLElement).querySelector("footer") as HTMLElement;
    const chip = footer.querySelector('[data-slot="chip"]') as HTMLElement;
    expect(chip.textContent).toBe("Always on");
    expect(chip.getAttribute("data-tone")).toBe("mut");
    expect(chip.querySelector('[data-slot="chip-dot"]')).toBeNull();
    expect(pins(footer)).toHaveLength(1);
  });

  it("has no chip when the box is not always on", async () => {
    const root = await showIn(bed, ownerSnapshot({ boxes: [box()] }), callbacks());
    const footer = (cards(root)[0] as HTMLElement).querySelector("footer") as HTMLElement;
    expect(text(footer)).not.toContain("Always on");
  });

  it("follows a stopped always-on box's name with a pin named Always on", async () => {
    const root = await showIn(
      bed,
      ownerSnapshot({
        boxes: [
          box(),
          box({
            ref: { kind: "agent", id: "s-a" },
            name: "Sleepy",
            state: "stopped",
            phase: "stopped",
            alwaysOn: true,
          }),
          box({ ref: { kind: "agent", id: "s-b" }, name: "Dozer", state: "stopped", phase: "stopped" }),
        ],
      }),
      callbacks(),
    );
    await click(button(root, "Expand"));
    const rows = [...root.querySelectorAll("[data-stopped-row]")];
    const pin = (row: Element) => row.querySelector('[role="img"][aria-label="Always on"]');
    expect(pin(rows[0] as Element)).not.toBeNull();
    expect(pin(rows[1] as Element)).toBeNull();
  });

  it("names the pin in French", async () => {
    setLocale("fr");
    const root = await showIn(
      bed,
      ownerSnapshot({
        boxes: [box({ state: "stopped", phase: "stopped", alwaysOn: true })],
      }),
      callbacks(),
    );
    expect(root.querySelector('[role="img"][aria-label="Toujours allumée"]')).not.toBeNull();
  });
});
