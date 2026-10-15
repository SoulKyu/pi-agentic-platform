// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useUsageStore } from "../../stores/usage-store.ts";
import { alerts, mount, settle } from "../../testing/dom.ts";
import { menuLabels, openMenu, pickItem, preloadMenu } from "../../testing/menu.ts";
import { limitView, usageRuntime, usageSnapshot } from "../../testing/usage-bed.ts";
import { LimitChip } from "./LimitChip.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let bed: ReturnType<typeof usageRuntime>;
const show = async (...limits: Parameters<typeof limitView>[0][]) => {
  const page = await mount(<LimitChip sessionId="sess-1" />);
  await act(async () => {
    bed.emitUsage(usageSnapshot(limits.map((patch) => limitView(patch))));
  });
  await settle();
  return page.container;
};
const trigger = () => document.querySelector("[data-limit-menu]") as HTMLElement;
const sent = (method: string) => bed.called(method).map((call) => [call.params, call.options]);

beforeAll(preloadMenu);
beforeEach(() => {
  setLocale("en");
  useUsageStore.getState().reset();
  bed = usageRuntime();
  current.runtime = bed.runtime;
});
afterEach(() => setLocale("en"));

describe("LimitChip", () => {
  it("opens the usage stream while it is mounted and draws nothing for a session that is not limited", async () => {
    const container = await show();
    expect(bed.called("subscribe.usage")).toHaveLength(1);
    expect(container.querySelector("[data-limit-chip]")).toBeNull();
    expect(container.textContent).toBe("");
  });

  // The chip drops the weekday only when the reset falls on the day the screen opened: pin that day, either side of midnight.
  it.each([
    ["before midnight", new Date(2026, 9, 14, 23, 59), new Date(2026, 9, 14, 23, 59, 30)],
    ["after midnight", new Date(2026, 9, 15, 0, 1), new Date(2026, 9, 15, 14, 30)],
  ])(
    "draws the limited chip with the reset time, or 'Limit reached' without one (%s)",
    async (_name, now, reset) => {
      vi.useFakeTimers({ toFake: ["Date"], now });
      onTestFinished(() => void vi.useRealTimers());
      const container = await show({ resetAt: reset.getTime() });
      expect(container.querySelector("[data-slot='chip']")?.getAttribute("data-tone")).toBe("mut");
      expect(container.querySelector("[data-slot='chip']")?.textContent).toMatch(/^Resets \d{2}:\d{2}$/);
      await act(async () => {
        bed.emitUsage({ kind: "limit", limit: limitView({ resetAt: null, resume: "none" }) });
      });
      expect(container.querySelector("[data-slot='chip']")?.textContent).toBe("Limit reached");
    },
  );

  it("speaks French", async () => {
    setLocale("fr");
    const container = await show({ resetAt: null });
    expect(container.querySelector("[data-slot='chip']")?.textContent).toBe("Limite atteinte");
  });

  it("ignores another session's limit", async () => {
    const container = await show({ sessionId: "other" });
    expect(container.querySelector("[data-limit-chip]")).toBeNull();
  });

  it("offers Resume now and Cancel auto-resume while a resume is scheduled; Resume now sends a command id", async () => {
    await show({ resume: "scheduled" });
    await openMenu(trigger());
    expect(menuLabels()).toEqual(["Resume now", "Cancel auto-resume"]);
    await act(async () => {
      document.body.querySelector<HTMLElement>("[role='menuitem']")?.click();
    });
    await settle();
    expect(sent("usage.resumeNow")).toEqual([[{ sessionId: "sess-1" }, { commandId: "bed-cmd-00000001" }]]);
    expect(bed.called("usage.cancelResume")).toEqual([]);
  });

  it("cancels the auto-resume with a command id", async () => {
    await show({ resume: "scheduled" });
    await pickItem(trigger(), "Cancel auto-resume");
    expect(sent("usage.cancelResume")).toEqual([
      [{ sessionId: "sess-1" }, { commandId: "bed-cmd-00000001" }],
    ]);
  });

  it("offers only Resume now once the resume was cancelled or none was scheduled", async () => {
    await show({ resume: "cancelled" });
    await openMenu(trigger());
    expect(menuLabels()).toEqual(["Resume now"]);
  });

  it("says what a refused resume means, by its code", async () => {
    bed.handlers["usage.resumeNow"] = () => {
      throw new RpcError("capacity");
    };
    await show({ resume: "none", resetAt: null });
    await pickItem(trigger(), "Resume now");
    expect(alerts(document.body)).toHaveLength(1);
    expect(alerts(document.body)[0]).toContain("capacity");
  });

  it("goes when a later run clears the limit", async () => {
    const container = await show({});
    await act(async () => {
      bed.emitUsage({ kind: "limit_cleared", sessionId: "sess-1" });
    });
    expect(container.querySelector("[data-limit-chip]")).toBeNull();
  });
});
