// @vitest-environment happy-dom
import type { AccountAppearance } from "@pap/contracts";
import { Toaster, TooltipProvider } from "@pap/ui";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsScreenEn, settingsScreenFr } from "../../i18n/catalog/settings-screen.ts";
import { registerCatalog, setLocale } from "../../i18n/index.ts";
import { RpcError } from "../../runtime/index.ts";
import { click, mount, press } from "../../testing/dom.ts";
import { AppearancePanel } from "./AppearancePanel.tsx";
import { useAppearanceStore } from "./appearance-store.ts";
import { startAppearance, syncAccountAppearance } from "./controller.ts";
import { DEFAULT_ACCOUNT, DEFAULT_DEVICE } from "./model.ts";

// The Settings chunk registers these strings when it loads; the panel is rendered here without it.
registerCatalog({ en: settingsScreenEn, fr: settingsScreenFr });

vi.mock("../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));

const roles = {
  bg: "#0e1626",
  surface: "#132033",
  text: "#e6edf7",
  agent: "#38bdf8",
  you: "#fb923c",
  attn: "#ec4899",
  ok: "#34d399",
  err: "#f87171",
} as const;
const ocean = { id: "ocean", name: "Ocean", base: "night", roles } as const;
const dune = { id: "dune", name: "Dune", base: "day", roles } as const;

const state = () => useAppearanceStore.getState();
const seed = (account: AccountAppearance = DEFAULT_ACCOUNT) =>
  useAppearanceStore.setState({
    account,
    device: DEFAULT_DEVICE,
    accountStatus: "local",
    deviceStored: true,
  });

const render = () =>
  mount(
    <TooltipProvider>
      <Toaster closeLabel="Close" />
      <AppearancePanel />
    </TooltipProvider>,
  );

// Lets the scripted server's promises settle without a timer (the timers are faked in the Undo test).
const drain = () =>
  act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });

const group = (label: string) =>
  document.querySelector(`[data-slot="segmented"][aria-label="${label}"]`) as HTMLElement;
const pick = (label: string, item: string) =>
  click(
    [...group(label).querySelectorAll('[role="radio"]')].find(
      (one) => one.textContent === item,
    ) as HTMLElement,
  );
const labelled = (selector: string, label: string) =>
  [...document.querySelectorAll(selector)].find((one) =>
    (one.getAttribute("aria-labelledby") ?? "")
      .split(" ")
      .some((id) => document.getElementById(id)?.textContent === label),
  ) as HTMLElement;
const toggle = (label: string) => click(labelled('[role="switch"]', label));
const status = () => document.querySelector('[data-slot="appearance-status"]')?.textContent;
const buttonNamed = (name: string) =>
  [...document.querySelectorAll("button")].find((one) => one.textContent === name) as HTMLElement;

async function openSelect(label: string): Promise<string[]> {
  const trigger = labelled('[role="combobox"]', label);
  await press(trigger, { key: "Enter" });
  await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull(), {
    timeout: 2_000,
  });
  return [...document.querySelectorAll('[role="option"]')].map((one) => one.textContent ?? "");
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  seed();
});
afterEach(async () => {
  for (const close of document.querySelectorAll('button[aria-label="Close"]')) await click(close);
  vi.useRealTimers();
});

describe("Settings > Appearance", () => {
  it("mode Night/Day/System writes the account scope", async () => {
    await render();
    await pick("Mode", "Day");
    expect(state().account.mode).toBe("day");
    await pick("Mode", "Night");
    expect(state().account.mode).toBe("night");
  });

  it("the dark theme lists Night Control, High contrast and dark custom themes; the light one Day · Papier and light custom themes", async () => {
    seed({ ...DEFAULT_ACCOUNT, customThemes: [ocean, dune] });
    await render();
    expect(labelled('[role="combobox"]', "Dark theme").textContent).toContain("Night Control");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(await openSelect("Dark theme")).toEqual(["Night Control", "High contrast", "Ocean"]);
    await press(document.querySelector('[role="listbox"]') as HTMLElement, { key: "Escape" });
    await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull(), {
      timeout: 2_000,
    });
    expect(await openSelect("Light theme")).toEqual(["Day · Papier", "Dune"]);
  });

  it("density and sizes write the device scope; Follow density clears a size", async () => {
    await render();
    await pick("Density", "Comfortable");
    expect(state().device.density).toBe("comfortable");
    await pick("Density", "Compact");
    const thumb = labelled('[role="slider"]', "UI size");
    expect(thumb.getAttribute("aria-valuetext")).toBe("13 px");
    await press(thumb, { key: "ArrowRight" });
    await press(thumb, { key: "ArrowRight" });
    expect(state().device.uiSize).toBe(15);
    expect(labelled('[role="slider"]', "UI size").getAttribute("aria-valuetext")).toBe("15 px");
    await click(buttonNamed("Follow density"));
    expect(state().device.uiSize).toBeNull();
    expect(document.body.textContent).not.toContain("Follow density");
  });

  it("switches write the account scope", async () => {
    await render();
    await toggle("Uppercase labels");
    expect(state().account.uppercaseLabels).toBe(false);
    await toggle("Background grid");
    expect(state().account.grid).toBe(false);
    await pick("Rail position", "Right");
    await pick("Agent avatars", "Glyph");
    await pick("Tool card detail", "Full");
    expect(state().account).toMatchObject({
      railPosition: "right",
      avatarStyle: "glyph",
      toolDetail: "full",
    });
  });

  it("fonts offer the bundled families or the system stacks only", async () => {
    await render();
    expect(await openSelect("UI font")).toEqual(["Manrope", "System font"]);
    await press(document.querySelector('[role="listbox"]') as HTMLElement, { key: "Escape" });
    await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull(), {
      timeout: 2_000,
    });
    expect(await openSelect("Code font")).toEqual(["JetBrains Mono", "System font"]);
  });

  it("motion and chat width write the device scope", async () => {
    await render();
    await pick("Motion", "None");
    expect(state().device.motion).toBe("none");
    await pick("Chat width", "Narrow");
    expect(state().device.chatWidth).toBe("narrow");
  });

  it("reset covers both scopes, keeps the custom themes, and Undo restores them", async () => {
    seed({ ...DEFAULT_ACCOUNT, customThemes: [ocean] });
    await render();
    await pick("Mode", "Day");
    await toggle("Background grid");
    await pick("Density", "Comfortable");
    await pick("Motion", "None");
    const changed = { account: state().account, device: state().device };
    await click(buttonNamed("Reset to defaults"));
    expect(state().account).toEqual({ ...DEFAULT_ACCOUNT, customThemes: [ocean] });
    expect(state().device).toEqual(DEFAULT_DEVICE);
    expect(document.querySelector('[data-slot="toast"]')?.textContent).toContain("Appearance reset");
    await click(buttonNamed("Undo"));
    expect(state().account).toEqual(changed.account);
    expect(state().device).toEqual(changed.device);
  });

  it("says where the account copy stands", async () => {
    await render();
    expect(status()).toBe("");
    const lines = {
      saving: "Saving…",
      saved: "Saved to your account",
      error: "Not saved to your account. Your next change tries again.",
      "load-error":
        "Showing this device's copy: your saved appearance could not be loaded. Changes stay on this device until it loads.",
    } as const;
    for (const [accountStatus, line] of Object.entries(lines)) {
      await act(async () => useAppearanceStore.setState({ accountStatus: accountStatus as never }));
      expect(status(), accountStatus).toBe(line);
    }
    await act(async () => useAppearanceStore.setState({ accountStatus: "local" }));
    expect(status()).toBe("");
    expect(document.body.textContent).not.toContain("does not keep device settings");
    await act(async () => useAppearanceStore.setState({ deviceStored: false }));
    expect(document.body.textContent).toContain(
      "This browser does not keep device settings: they apply to this page only.",
    );
  });

  it("speaks French", async () => {
    setLocale("fr");
    await render();
    await act(async () => useAppearanceStore.setState({ accountStatus: "saved" }));
    expect(status()).toBe("Enregistré dans votre compte");
    expect(document.querySelector("h2")?.textContent).toBe("Apparence");
    expect(buttonNamed("Rétablir les valeurs par défaut")).toBeDefined();
  });

  it("the preview shows a you message, an agent message, a tool card and a primary button", async () => {
    await render();
    const preview = document.querySelector('section[aria-label="Preview"]') as HTMLElement;
    expect(preview.querySelector('[data-slot="message"][data-author="you"]')).not.toBeNull();
    expect(preview.querySelector('[data-slot="message"][data-author="agent"]')).not.toBeNull();
    expect(preview.querySelector('[data-slot="tool-card"]')).not.toBeNull();
    expect(preview.querySelector('[data-variant="primary"]')).not.toBeNull();
    await pick("Tool card detail", "Full");
    expect(preview.querySelector('[data-slot="tool-card"]')).not.toBeNull();
  });
});

const changedAccount: AccountAppearance = {
  ...DEFAULT_ACCOUNT,
  mode: "day",
  grid: false,
  customThemes: [ocean],
};

/** settings.get answers from `gets`; each settings.set waits for the test to settle it. */
function scriptedServer(gets: Array<{ value: unknown; revision: number }>) {
  const settles: Array<{ ok(revision: number): void; fail(code: "conflict" | "internal"): void }> = [];
  const sets: unknown[] = [];
  const rpc = {
    call: vi.fn((method: string, params: unknown) => {
      if (method === "settings.get") return Promise.resolve(gets.shift());
      sets.push(params);
      return new Promise((resolve, reject) =>
        settles.push({
          ok: (revision) => resolve({ revision }),
          fail: (code) => reject(new RpcError(code)),
        }),
      );
    }),
  };
  return { rpc, sets, settles };
}

let controller: { stop(): void } | null = null;

async function resetThenSave(server: ReturnType<typeof scriptedServer>) {
  seed(changedAccount); // the person's copy is in place before the controller starts watching the store
  controller = startAppearance(window);
  await syncAccountAppearance(server.rpc as never);
  await render();
  await click(buttonNamed("Reset to defaults"));
  await act(async () => vi.advanceTimersByTime(400));
}

describe("Undo and the account copy", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => controller?.stop());

  it("while the reset is being saved: sends the previous values from the revision that save returned", async () => {
    const server = scriptedServer([{ value: null, revision: 1 }]);
    await resetThenSave(server);
    expect(server.sets).toEqual([
      { key: "appearance", value: { ...DEFAULT_ACCOUNT, customThemes: [ocean] }, baseRevision: 1 },
    ]);
    await click(buttonNamed("Undo"));
    expect(state().account).toEqual(changedAccount);
    await act(async () => vi.advanceTimersByTime(400));
    expect(server.sets).toHaveLength(1); // one save at a time: Undo waits for the reset's save
    await act(async () => server.settles[0]?.ok(2));
    await drain();
    expect(server.sets[1]).toEqual({ key: "appearance", value: changedAccount, baseRevision: 2 });
    await act(async () => server.settles[1]?.ok(3));
    await drain();
    expect(server.sets).toHaveLength(2);
    expect(state().accountStatus).toBe("saved");
  });

  it("when the reset's save conflicts: re-reads, merges the Undo fields over the server copy and retries at the new revision", async () => {
    const server = scriptedServer([
      { value: null, revision: 1 },
      { value: { ...DEFAULT_ACCOUNT, uiFont: "system", customThemes: [ocean] }, revision: 5 },
    ]);
    await resetThenSave(server);
    await click(buttonNamed("Undo"));
    await act(async () => server.settles[0]?.fail("conflict"));
    await drain();
    expect(server.sets).toHaveLength(2);
    const merged = { ...changedAccount, uiFont: "system" }; // the server's other field survives, ours win
    expect(server.sets[1]).toEqual({ key: "appearance", value: merged, baseRevision: 5 });
    expect(state().account).toEqual(merged);
    await act(async () => server.settles[1]?.ok(6));
    await drain();
    expect(status()).toBe("Saved to your account");
  });

  it("when the reset's save fails: says so, and Undo saves the previous values again at the same revision", async () => {
    const server = scriptedServer([{ value: null, revision: 1 }]);
    await resetThenSave(server);
    await act(async () => server.settles[0]?.fail("internal"));
    await drain();
    expect(status()).toBe("Not saved to your account. Your next change tries again.");
    await click(buttonNamed("Undo"));
    await act(async () => vi.advanceTimersByTime(400));
    expect(server.sets).toHaveLength(2);
    expect(server.sets[1]).toEqual({ key: "appearance", value: changedAccount, baseRevision: 1 });
    await act(async () => server.settles[1]?.ok(2));
    await drain();
    expect(status()).toBe("Saved to your account");
  });
});

describe("Undo and the custom themes", () => {
  it("restores what Reset changed and never rewrites customThemes edited since", async () => {
    seed(changedAccount);
    await render();
    await click(buttonNamed("Reset to defaults"));
    const edited = { ...state().account, customThemes: [ocean, dune] };
    await act(async () => state().setAccount(edited));
    await click(buttonNamed("Undo"));
    expect(state().account).toEqual({ ...changedAccount, customThemes: [ocean, dune] });
  });
});
