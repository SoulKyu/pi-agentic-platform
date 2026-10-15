// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationSettings } from "@pap/contracts";
import { setLocale } from "../../i18n/index.ts";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { EMPTY_TASKS } from "../../stores/tasks-reducer.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { button, click, field, mount, settle, text, typeInto } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import "./register-automation-settings-catalog.ts";
import { AutomationForm } from "./AutomationForm.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const STORED = AutomationSettings.parse({ slots: 3, dailyBudgetUsd: 5, timezone: "Asia/Tokyo" });
let bed = fakeRuntime();
let revision = 7;
let stored: unknown = STORED;

beforeEach(() => {
  bed = fakeRuntime();
  current.runtime = bed.runtime;
  revision = 7;
  stored = STORED;
  bed.handlers["settings.get"] = () => ({ value: stored, revision });
  bed.handlers["settings.set"] = () => ({ revision: ++revision });
  useTasksStore.setState({ view: EMPTY_TASKS });
});
afterEach(() => setLocale("en"));

async function open(zone: string | null = "Europe/Paris") {
  const page = await mount(<AutomationForm serverZone="UTC" browserZone={() => zone} />);
  await settle();
  return page;
}
const sets = () => bed.called("settings.set");
const sent = (index = 0) =>
  (sets()[index]?.params as { value: AutomationSettings; baseRevision: number }).value;

describe("AutomationForm", () => {
  it("shows what is stored", async () => {
    const page = await open();
    expect(field(page.container, "Slots").value).toBe("3");
    expect(field(page.container, "Daily budget (USD)").value).toBe("5");
    expect(text(page.container)).toContain("Asia/Tokyo");
  });

  it("refuses 0 and 9 slots in the form and sends nothing", async () => {
    const page = await open();
    for (const bad of ["0", "9"]) {
      await typeInto(field(page.container, "Slots"), bad);
      expect(text(page.container)).toContain("A whole number from 1 to 8.");
      expect(button(page.container, "Save").disabled).toBe(true);
    }
    await typeInto(field(page.container, "Slots"), "8");
    expect(text(page.container)).not.toContain("A whole number from 1 to 8.");
    expect(button(page.container, "Save").disabled).toBe(false);
    expect(sets()).toHaveLength(0);
  });

  it("says there is no window when quiet hours start and end together", async () => {
    const page = await open();
    await typeInto(field(page.container, "Quiet hours from"), "22:00");
    await typeInto(field(page.container, "Quiet hours to"), "22:00");
    expect(text(page.container)).toContain("No window: the two times are the same.");
    await typeInto(field(page.container, "Quiet hours to"), "07:00");
    expect(text(page.container)).not.toContain("No window");
    await typeInto(field(page.container, "Quiet hours to"), "7");
    expect(text(page.container)).toContain("Two times as HH:MM, or both empty.");
    expect(button(page.container, "Save").disabled).toBe(true);
  });

  it("saves with the revision it read, and reads again and retries once on a conflict", async () => {
    let attempts = 0;
    bed.handlers["settings.set"] = () => {
      attempts += 1;
      if (attempts === 1) {
        revision = 9; // someone else wrote first
        throw new RpcError("conflict");
      }
      return { revision: ++revision };
    };
    const page = await open();
    await typeInto(field(page.container, "Slots"), "4");
    await click(button(page.container, "Save"));
    await settle();
    expect(sets().map((call) => (call.params as { baseRevision: number }).baseRevision)).toEqual([7, 9]);
    expect(sent(0).slots).toBe(4);
    expect(sent(1).slots).toBe(4);
    expect(text(page.container)).toContain("Saved.");
  });

  it("does not retry a second conflict, and keeps the edits", async () => {
    bed.handlers["settings.set"] = () => {
      throw new RpcError("conflict");
    };
    const page = await open();
    await typeInto(field(page.container, "Slots"), "4");
    await click(button(page.container, "Save"));
    await settle();
    expect(sets()).toHaveLength(2);
    expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("changed elsewhere");
    expect(field(page.container, "Slots").value).toBe("4");
  });

  it("stores the browser's zone at the first save and keeps the stored one after", async () => {
    stored = { ...STORED, timezone: null };
    const first = await open("Europe/Paris");
    expect(text(first.container)).toContain("UTC (the server's)");
    await typeInto(field(first.container, "Slots"), "2");
    await click(button(first.container, "Save"));
    await settle();
    expect(sent(0).timezone).toBe("Europe/Paris");
    await first.unmount();

    stored = { ...STORED, timezone: "Asia/Tokyo" };
    const later = await open("Europe/Paris");
    await typeInto(field(later.container, "Slots"), "2");
    await click(button(later.container, "Save"));
    await settle();
    expect(sent(1).timezone).toBe("Asia/Tokyo");
  });

  it("leaves the zone unset when the browser has none the server accepts", async () => {
    stored = { ...STORED, timezone: null };
    const page = await open(null);
    await typeInto(field(page.container, "Slots"), "2");
    await click(button(page.container, "Save"));
    await settle();
    expect(sent(0).timezone).toBeNull();
  });

  it("saves no budget as null and keeps a pause set elsewhere meanwhile", async () => {
    const page = await open();
    stored = { ...STORED, paused: true }; // the Tasks board paused after this form loaded
    await typeInto(field(page.container, "Daily budget (USD)"), "");
    await click(button(page.container, "Save"));
    await settle();
    expect(sent(0).dailyBudgetUsd).toBeNull();
    expect(sent(0).paused).toBe(true);
  });

  it("says a token cannot change these settings when the server answers forbidden", async () => {
    bed.handlers["settings.set"] = () => {
      throw new RpcError("forbidden");
    };
    const page = await open();
    await typeInto(field(page.container, "Slots"), "4");
    await click(button(page.container, "Save"));
    await settle();
    expect(sets()).toHaveLength(1);
    expect(page.container.querySelector('[role="alert"]')?.textContent).toBe(
      "A token cannot change automation settings. Sign in from the browser to change them.",
    );
  });

  it("writes nothing and says so when the stored document cannot be read", async () => {
    stored = { slots: "many" };
    const page = await open();
    expect(page.container.querySelector('[role="alert"]')?.textContent).toBe(
      "The automation settings could not be read.",
    );
    expect(page.container.querySelector("input")).toBeNull();
    expect(sets()).toHaveLength(0);
  });

  it("pauses through the same setting the Tasks board writes, and follows the stream", async () => {
    const page = await open();
    const toggle = () => page.container.querySelector<HTMLElement>('[role="switch"][aria-checked]');
    const pause = () =>
      [...page.container.querySelectorAll<HTMLElement>('[role="switch"]')].find(
        (one) =>
          one.getAttribute("aria-labelledby") !== null &&
          document.getElementById(one.getAttribute("aria-labelledby") ?? "")?.textContent ===
            "Pause automation",
      ) as HTMLElement;
    expect(toggle()).not.toBeNull();
    expect(pause().getAttribute("aria-checked")).toBe("false");
    await click(pause());
    await settle();
    expect(sets()).toHaveLength(1);
    expect(sent(0)).toEqual({ ...STORED, paused: true });
    expect(pause().getAttribute("aria-checked")).toBe("true");
    // The board's stream says it is running again (another tab resumed): the switch follows without a reload.
    const counts = {
      paused: false,
      slots: 3,
      running: 0,
      queued: 0,
      quietHours: false,
      todayUsd: 0,
      budgetUsd: 5,
    };
    useTasksStore.getState().apply({ kind: "counts", counts });
    await settle();
    expect(pause().getAttribute("aria-checked")).toBe("false");
  });

  it("does not show a pause another tab has lifted after the stream confirmed it", async () => {
    const page = await open();
    const pause = () =>
      [...page.container.querySelectorAll<HTMLElement>('[role="switch"]')].find(
        (one) =>
          document.getElementById(one.getAttribute("aria-labelledby") ?? "")?.textContent ===
          "Pause automation",
      ) as HTMLElement;
    const counts = (paused: boolean) => ({
      paused,
      slots: 3,
      running: 0,
      queued: 0,
      quietHours: false,
      todayUsd: 0,
      budgetUsd: 5,
    });
    useTasksStore.getState().apply({ kind: "counts", counts: counts(false) });
    await settle();
    await click(pause());
    await settle();
    useTasksStore.getState().apply({ kind: "counts", counts: counts(true) });
    await settle();
    useTasksStore.getState().apply({ kind: "counts", counts: counts(false) });
    await settle();
    expect(pause().getAttribute("aria-checked")).toBe("false");
  });

  it("reads the pause again when the stream reconnects and when the page becomes visible", async () => {
    const page = await open();
    const pause = () =>
      [...page.container.querySelectorAll<HTMLElement>('[role="switch"]')].find(
        (one) =>
          document.getElementById(one.getAttribute("aria-labelledby") ?? "")?.textContent ===
          "Pause automation",
      ) as HTMLElement;
    expect(pause().getAttribute("aria-checked")).toBe("false");
    stored = { ...STORED, paused: true };
    bed.fake.setState("waiting");
    await settle();
    bed.fake.setState("open");
    await settle();
    expect(pause().getAttribute("aria-checked")).toBe("true");
    stored = STORED;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(pause().getAttribute("aria-checked")).toBe("false");
  });

  it("explains quiet hours without internal milestone names, in English and French", async () => {
    const page = await open();
    expect(text(page.container)).toContain("Coming soon: notifications that wait for the end of the window.");
    expect(text(page.container)).not.toContain("M12");
    setLocale("fr");
    await settle();
    expect(text(page.container)).toContain("Bientôt : des notifications qui attendent la fin de la plage.");
    expect(text(page.container)).not.toContain("M12");
  });

  it("answers in French", async () => {
    setLocale("fr");
    const page = await open();
    expect(field(page.container, "Emplacements").value).toBe("3");
    expect(button(page.container, "Enregistrer")).toBeTruthy();
  });
});
