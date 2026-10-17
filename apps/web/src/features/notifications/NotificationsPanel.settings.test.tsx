// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { button, click, settle, text } from "../../testing/dom.ts";
import {
  DEFAULT_DOC,
  NOW,
  notificationsBed,
  openPanel as open,
  toggle,
} from "../../testing/notifications-bed.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

let s: ReturnType<typeof notificationsBed>;
let bed: ReturnType<typeof notificationsBed>["bed"];
beforeEach(() => {
  s = notificationsBed();
  bed = s.bed;
  current.runtime = bed.runtime;
});
afterEach(() => {
  vi.unstubAllGlobals();
  setLocale("en");
});

const sets = () =>
  bed.called("settings.set").map((entry) => entry.params as { value: Record<string, unknown> });

describe("NotificationsPanel: classes, mute, names", () => {
  it("shows the defaults: approval, failed, budget, notify on; done, reply, review off", async () => {
    const { page } = await open();
    const on = (label: string) => toggle(page.container, label).getAttribute("aria-checked");
    expect(on("Approvals and questions")).toBe("true");
    expect(on("Failures")).toBe("true");
    expect(on("Budgets")).toBe("true");
    expect(on("Agent notices")).toBe("true");
    expect(on("Finished tasks")).toBe("false");
    expect(on("Replies")).toBe("false");
    expect(on("Memory to review")).toBe("false");
    expect(on("Show the trigger or agent name")).toBe("false");
    expect(text(page.container)).toContain("Sent after 60 seconds if you have not answered.");
  });

  it("toggling a class writes the whole document with the revision read", async () => {
    const { page } = await open();
    await click(toggle(page.container, "Finished tasks"));
    await settle();
    expect(bed.called("settings.set").map((entry) => entry.params)).toEqual([
      {
        key: "notifications",
        value: { ...DEFAULT_DOC, classes: { ...DEFAULT_DOC.classes, done: true } },
        baseRevision: 4,
      },
    ]);
    expect(toggle(page.container, "Finished tasks").getAttribute("aria-checked")).toBe("true");
  });

  it("merges on conflict: a field another device changed is kept", async () => {
    let first = true;
    const set = bed.handlers["settings.set"] as (params: unknown) => unknown;
    bed.handlers["settings.set"] = (params) => {
      if (first) {
        first = false;
        s.doc = { value: { ...DEFAULT_DOC, muteUntil: NOW + 5 }, revision: 9 };
      }
      return set(params);
    };
    const { page } = await open();
    await click(toggle(page.container, "Failures"));
    await settle();
    expect(sets()).toHaveLength(2);
    const stored = s.doc.value as { classes: { failed: boolean }; muteUntil: number };
    expect(stored.classes.failed).toBe(false);
    expect(stored.muteUntil).toBe(NOW + 5);
  });

  it("the names option writes titles: names", async () => {
    const { page } = await open();
    await click(toggle(page.container, "Show the trigger or agent name"));
    await settle();
    expect(sets()[0]?.value.titles).toBe("names");
  });

  it("mute presets compute muteUntil from the clock; Off writes null", async () => {
    const { page } = await open();
    await click(button(page.container, "1 h"));
    await settle();
    expect(sets().at(-1)?.value.muteUntil).toBe(NOW + 3_600_000);
    await click(button(page.container, "8 h"));
    await settle();
    expect(sets().at(-1)?.value.muteUntil).toBe(NOW + 8 * 3_600_000);
    await click(button(page.container, "Until I turn it on"));
    await settle();
    expect(sets().at(-1)?.value.muteUntil).toBe(Number.MAX_SAFE_INTEGER);
    expect(text(page.container)).toContain("Muted until you turn it on again.");
    await click(button(page.container, "Off"));
    await settle();
    expect(sets().at(-1)?.value.muteUntil).toBeNull();
  });

  it("shows when a timed mute ends", async () => {
    s.doc = { value: { ...DEFAULT_DOC, muteUntil: NOW + 600_000 }, revision: 2 };
    const { page } = await open();
    expect(text(page.container)).toContain("Muted until");
    expect(button(page.container, "1 h").getAttribute("data-state")).toBe("on");
  });

  it("a stored mute beyond every preset selects none and still says when it ends", async () => {
    s.doc = { value: { ...DEFAULT_DOC, muteUntil: NOW + 20 * 3_600_000 }, revision: 2 };
    const { page } = await open();
    for (const name of ["Off", "1 h", "8 h", "Until I turn it on"])
      expect(button(page.container, name).getAttribute("data-state")).toBe("off");
    expect(text(page.container)).toContain("Muted until");
  });

  it("the mute control is a disabled group while a save is in flight", async () => {
    let finish: (value: unknown) => void = () => {};
    bed.handlers["settings.set"] = () => new Promise((resolve) => (finish = resolve));
    const { page } = await open();
    await click(button(page.container, "1 h"));
    const group = page.container.querySelector(
      "[data-slot=notifications-mute] fieldset",
    ) as HTMLFieldSetElement;
    expect(group.disabled).toBe(true);
    expect(page.container.querySelector("[data-slot=notifications-mute][aria-disabled]")).toBeNull();
    await act(async () => finish({ revision: 9 }));
    await settle();
    expect(group.disabled).toBe(false);
  });

  it("a failed save says so and the switch goes back", async () => {
    bed.handlers["settings.set"] = () => {
      throw new RpcError("internal");
    };
    const { page } = await open();
    await click(toggle(page.container, "Finished tasks"));
    await settle();
    expect(text(page.container)).toContain("The setting could not be saved.");
    expect(toggle(page.container, "Finished tasks").getAttribute("aria-checked")).toBe("false");
  });

  it("quiet hours are read-only here, with a link to Automation", async () => {
    const { page } = await open();
    expect(text(page.container)).toContain("Quiet hours: 22:00 to 07:00.");
    expect(text(page.container)).toContain("arrive as one summary");
    expect(page.container.querySelector('a[href="/settings/automation"]')).not.toBeNull();
  });

  it("says there are no quiet hours when none are set", async () => {
    s.automation = { quietHours: null };
    const { page } = await open();
    expect(text(page.container)).toContain("Quiet hours: none.");
  });
});
