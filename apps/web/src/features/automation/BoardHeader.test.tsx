// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { RpcError } from "../../runtime/rpc.ts";
import { click, settle, text } from "../../testing/dom.ts";
import { BoardHeader } from "./BoardHeader.tsx";
import { countsOf, current, newBed, showWithStepUp } from "./board-bed.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const STORED = {
  paused: false,
  slots: 2,
  timezone: null,
  quietHours: null,
  dailyBudgetUsd: 5,
  autoResume: true,
};
const pauseSwitch = (container: HTMLElement) =>
  container.querySelector('[role="switch"]') as HTMLButtonElement;

describe("BoardHeader", () => {
  it("shows the counts, today's spend with the budget and the quiet-hours chip", async () => {
    newBed();
    const page = await showWithStepUp(<BoardHeader counts={countsOf({ quietHours: true })} />);
    const words = text(page.container);
    expect(words).toContain("Tasks");
    expect(words).toContain("1 / 2 running");
    expect(words).toContain("3 queued");
    expect(words).toContain("Today $1.84 / $5.00");
    expect(words).toContain("Quiet hours");
  });

  it("has no quiet-hours chip outside the window", async () => {
    newBed();
    const page = await showWithStepUp(<BoardHeader counts={countsOf()} />);
    expect(text(page.container)).not.toContain("Quiet hours");
  });

  it("writes the pause with the revision it read", async () => {
    const bed = newBed();
    bed.handlers["settings.get"] = () => ({ value: STORED, revision: 3 });
    bed.handlers["settings.set"] = () => ({ revision: 4 });
    const page = await showWithStepUp(<BoardHeader counts={countsOf()} />);
    await click(pauseSwitch(page.container));
    await settle();
    const [write] = bed.called("settings.set");
    expect(write?.params).toEqual({
      key: "automation",
      value: { ...STORED, paused: true },
      baseRevision: 3,
    });
    expect(write?.options?.commandId).toBeTruthy();
    expect(pauseSwitch(page.container).getAttribute("aria-checked")).toBe("true");
  });

  it("shows the stored pause again when the stream reconnects and when the page becomes visible", async () => {
    const bed = newBed();
    let stored = false;
    bed.handlers["settings.get"] = () => ({ value: { ...STORED, paused: stored }, revision: 3 });
    const page = await showWithStepUp(<BoardHeader counts={countsOf()} />);
    expect(pauseSwitch(page.container).getAttribute("aria-checked")).toBe("false");
    stored = true;
    bed.fake.setState("waiting");
    await settle();
    expect(pauseSwitch(page.container).getAttribute("aria-checked")).toBe("false");
    bed.fake.setState("open");
    await settle();
    expect(pauseSwitch(page.container).getAttribute("aria-checked")).toBe("true");
    stored = false;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(pauseSwitch(page.container).getAttribute("aria-checked")).toBe("false");
  });

  it("reads again and retries once on a conflict, with the new revision", async () => {
    const bed = newBed();
    let reads = 0;
    bed.handlers["settings.get"] = () => {
      reads += 1;
      return { value: reads === 1 ? STORED : { ...STORED, slots: 4 }, revision: reads === 1 ? 3 : 5 };
    };
    let writes = 0;
    bed.handlers["settings.set"] = () => {
      writes += 1;
      if (writes === 1) throw new RpcError("conflict");
      return { revision: 6 };
    };
    const page = await showWithStepUp(<BoardHeader counts={countsOf()} />);
    await click(pauseSwitch(page.container));
    await settle();
    const writesSent = bed.called("settings.set").map((call) => call.params);
    expect(writesSent).toEqual([
      { key: "automation", value: { ...STORED, paused: true }, baseRevision: 3 },
      { key: "automation", value: { ...STORED, slots: 4, paused: true }, baseRevision: 5 },
    ]);
    expect(page.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("gives up after a second conflict and says so", async () => {
    const bed = newBed();
    bed.handlers["settings.get"] = () => ({ value: STORED, revision: 3 });
    bed.handlers["settings.set"] = () => {
      throw new RpcError("conflict");
    };
    const page = await showWithStepUp(<BoardHeader counts={countsOf()} />);
    await click(pauseSwitch(page.container));
    await settle();
    expect(bed.called("settings.set")).toHaveLength(2);
    expect(page.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not change the pause",
    );
    expect(pauseSwitch(page.container).getAttribute("aria-checked")).toBe("false");
  });

  it("never overwrites a stored value this build cannot read", async () => {
    const bed = newBed();
    bed.handlers["settings.get"] = () => ({ value: { slots: "many" }, revision: 3 });
    const page = await showWithStepUp(<BoardHeader counts={countsOf()} />);
    await click(pauseSwitch(page.container));
    await settle();
    expect(bed.called("settings.set")).toHaveLength(0);
    expect(page.container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
