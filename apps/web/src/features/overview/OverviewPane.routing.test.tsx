// @vitest-environment happy-dom
import type { OverviewSnapshot } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { button, click, text } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import type { OverviewCallbacks } from "./callbacks.ts";
import { NOW, box, ownerSnapshot } from "./overview-fixtures.ts";
import { callbacks, cards, showIn } from "./overview-bed.tsx";

vi.mock("../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof fakeRuntime>;
const show = (snapshot: OverviewSnapshot, on: OverviewCallbacks = callbacks()) => showIn(bed, snapshot, on);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  bed = fakeRuntime();
  current.runtime = bed.runtime;
});
afterEach(() => {
  setLocale("en");
  vi.useRealTimers();
});

const sleeping = [
  box({ ref: { kind: "agent", id: "s-a" }, name: "Sleepy", state: "stopped", phase: "stopped" }),
  box({ ref: { kind: "project", id: "s-p" }, name: "Dozer", state: "stopped", phase: "stopped" }),
];

describe("OverviewPane: where a card sends you, and its next run", () => {
  it("an agent's thread line and its session ask open the agent tab, its tasks still open the task", async () => {
    const on = callbacks();
    const root = await show(
      ownerSnapshot({
        boxes: [
          box({
            state: "waiting",
            ask: { source: "session", sessionId: "th1", title: "Which one?" },
            activities: [
              { kind: "thread", id: "th1", title: "Chat", since: null, stoppable: false },
              { kind: "task", id: "t1", title: "Tidy", since: null, stoppable: true },
            ],
          }),
        ],
      }),
      on,
    );
    await click(button(root, "Thread · Chat"));
    expect(on.openAgent).toHaveBeenLastCalledWith("atlas-1a2b");
    await click(button(root, "Answer"));
    expect(on.openAgent).toHaveBeenCalledTimes(2);
    await click(button(root, "Task · Tidy"));
    expect(on.openTask).toHaveBeenCalledWith("t1");
    expect(on.openSession).not.toHaveBeenCalled();
  });

  it("a project's session ask still opens that session", async () => {
    const on = callbacks();
    const root = await show(
      ownerSnapshot({
        boxes: [
          box({
            ref: { kind: "project", id: "p1" },
            name: "Alpha",
            state: "waiting",
            ask: { source: "session", sessionId: "s9", title: "Fix" },
          }),
        ],
      }),
      on,
    );
    await click(button(root, "Answer"));
    expect(on.openSession).toHaveBeenCalledWith("s9");
    expect(on.openAgent).not.toHaveBeenCalled();
  });

  it("the card's next run reads Next, 24 h time and the trigger's name", async () => {
    const midnight = new Date(NOW).setHours(0, 0, 0, 0);
    const root = await show(
      ownerSnapshot({
        boxes: [box({ nextRun: { at: midnight + 18 * 3_600_000, name: "Evening pulse" } })],
      }),
    );
    expect(text(cards(root)[0] as Element)).toContain("Next 18:00 · Evening pulse");
    setLocale("fr");
    const fr = await show(
      ownerSnapshot({
        boxes: [box({ nextRun: { at: midnight + 18 * 3_600_000, name: "Pulse du soir" } })],
      }),
    );
    expect(text(cards(fr)[0] as Element)).toContain("Prochaine 18:00 · Pulse du soir");
  });

  it("an expanded row shows its next run", async () => {
    const midnight = new Date(NOW).setHours(0, 0, 0, 0);
    const root = await show(
      ownerSnapshot({
        boxes: [
          box(),
          box({
            ref: { kind: "agent", id: "s-a" },
            name: "Sleepy",
            state: "stopped",
            phase: "stopped",
            nextRun: { at: midnight + 26 * 3_600_000, name: "Early pulse" },
          }),
        ],
      }),
    );
    await click(button(root, "Expand"));
    const row = root.querySelector("[data-stopped-row]") as HTMLElement;
    expect(text(row)).toContain("Next tomorrow 02:00 · Early pulse");
  });

  it("counts one stopped box in the singular, in both languages", async () => {
    const one = [
      box({ ref: { kind: "agent", id: "s-a" }, name: "Sleepy", state: "stopped", phase: "stopped" }),
    ];
    expect(text(await show(ownerSnapshot({ boxes: [box(), ...one] })))).toContain("1 stopped");
    setLocale("fr");
    expect(text(await show(ownerSnapshot({ boxes: [box(), ...one] })))).toMatch(/1 arrêtée(?!s)/);
    expect(text(await show(ownerSnapshot({ boxes: [box(), ...sleeping] })))).toContain("2 arrêtées");
  });
});
