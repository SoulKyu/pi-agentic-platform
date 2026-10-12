// @vitest-environment happy-dom
import type { CustomTheme } from "@pap/contracts";
import { Toaster, TooltipProvider } from "@pap/ui";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsScreenEn, settingsScreenFr } from "../../i18n/catalog/settings-screen.ts";
import { settingsAppearanceEn, settingsAppearanceFr } from "../../i18n/catalog/settings-appearance.ts";
import { registerCatalog, setLocale } from "../../i18n/index.ts";
import { click, field, mount, press, typeInto } from "../../testing/dom.ts";
// Loaded up front so the lazy import inside CustomThemes resolves from the module cache, not a cold transform.
import "./ThemeEditor.tsx";
import { useAppearanceStore } from "./appearance-store.ts";
import { CustomThemes } from "./CustomThemes.tsx";
import { DEFAULT_ACCOUNT } from "./model.ts";
import { exportThemeFile, presetRoles } from "./theme-io.ts";
import {
  initial,
  exampleText,
  hostileText,
  seed,
  themes,
  ocean,
  named,
  labelled,
  preview,
  chooseFile,
} from "./theme-test-kit.ts";

const state = () => useAppearanceStore.getState();

registerCatalog({ en: settingsScreenEn, fr: settingsScreenFr });
registerCatalog({ en: settingsAppearanceEn, fr: settingsAppearanceFr });
vi.mock("../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  seed();
});
afterEach(async () => {
  for (const close of document.querySelectorAll('button[aria-label="Close"]')) await click(close);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CustomThemes", () => {
  const render = () =>
    mount(
      <TooltipProvider>
        <Toaster closeLabel="Close" regionLabel="Notifications" />
        <CustomThemes />
      </TooltipProvider>,
    );
  const editorOpen = () =>
    act(async () => {
      await vi.waitFor(() => expect(field(document, "Name")).toBeTruthy(), { timeout: 2_000 });
    });
  async function duplicateFrom(preset: string): Promise<void> {
    await press(named("Duplicate & edit"), { key: "Enter" });
    await act(async () => {
      await vi.waitFor(() => expect(document.querySelector('[role="menuitem"]')).not.toBeNull(), {
        timeout: 2_000,
      });
    });
    await click(
      [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent === preset) as Element,
    );
    await editorOpen();
  }

  it("Duplicate & edit from Night Control opens the editor with the preset's roles and saves a fresh id", async () => {
    await render();
    await duplicateFrom("Night Control");
    expect(field(document, "Name").value).toBe("Night Control copy");
    const night = presetRoles("night");
    expect(field(document, "Agent").value).toBe(night.agent);
    expect(field(document, "You").value).toBe(night.you);
    await click(named("Save"));
    expect(state().account.customThemes).toEqual([
      { id: "night-control-copy", name: "Night Control copy", base: "night", roles: night },
    ]);
  });

  it("Duplicate & edit from Day · Papier keeps the you fill for the primary button, not the darkened text tone (M3-RT-32)", async () => {
    await render();
    await duplicateFrom("Day · Papier");
    expect(field(document, "You").value).toBe("#fb923c");
    expect(preview().getAttribute("data-theme")).toBe("day");
    expect(preview().style.getPropertyValue("--you-fill")).toBe("#fb923c");
  });

  it("High contrast duplicates on a night base", async () => {
    await render();
    await duplicateFrom("High contrast");
    expect(preview().getAttribute("data-theme")).toBe("night");
    expect(field(document, "Name").value).toBe("High contrast copy");
  });

  it("deleting the theme in use switches that side back to its preset, and Undo restores theme and selection", async () => {
    seed({ ...DEFAULT_ACCOUNT, customThemes: [ocean, ...themes(1)], darkTheme: "ocean", lightTheme: "day" });
    await render();
    await click(labelled("Delete Ocean"));
    expect(state().account.customThemes.map((t) => t.id)).toEqual(["t0"]);
    expect(state().account.darkTheme).toBe("night");
    await click(named("Undo"));
    expect(state().account.customThemes.map((t) => t.id)).toEqual(["ocean", "t0"]);
    expect(state().account.darkTheme).toBe("ocean");
  });

  it("deleting a theme that is not in use leaves the selection alone", async () => {
    seed({ ...DEFAULT_ACCOUNT, customThemes: [ocean, ...themes(1)], darkTheme: "ocean" });
    await render();
    await click(labelled("Delete Theme 0"));
    expect(state().account.darkTheme).toBe("ocean");
    expect(state().account.customThemes.map((t) => t.id)).toEqual(["ocean"]);
  });

  it("Edit saves over the same id", async () => {
    seed({ ...DEFAULT_ACCOUNT, customThemes: [ocean] });
    await render();
    await click(labelled("Edit Ocean"));
    await editorOpen();
    await typeInto(field(document, "Name") as HTMLInputElement, "Ocean 2");
    await click(named("Save"));
    expect(state().account.customThemes).toEqual([{ ...ocean, name: "Ocean 2" }]);
  });

  it("a selected theme whose base changes can no longer serve that side: the side goes back to its preset", async () => {
    seed({ ...DEFAULT_ACCOUNT, customThemes: [ocean], darkTheme: "ocean" });
    await render();
    await click(labelled("Edit Ocean"));
    await editorOpen();
    await click(
      [...document.querySelectorAll('[role="radio"]')].find((one) => one.textContent === "Day") as Element,
    );
    await click(named("Save"));
    await click(named("Save anyway")); // night roles on a day base fall below AA
    expect(state().account.customThemes).toEqual([{ ...ocean, base: "day" }]);
    expect(state().account.darkTheme).toBe("night");
  });

  it("the light side goes back to Day · Papier when its theme becomes a night theme", async () => {
    const dune: CustomTheme = { ...ocean, id: "dune", name: "Dune", base: "day" };
    seed({ ...DEFAULT_ACCOUNT, customThemes: [dune], lightTheme: "dune" });
    await render();
    await click(labelled("Edit Dune"));
    await editorOpen();
    await click(
      [...document.querySelectorAll('[role="radio"]')].find((one) => one.textContent === "Night") as Element,
    );
    await click(named("Save"));
    expect(state().account.customThemes).toEqual([{ ...dune, base: "night" }]);
    expect(state().account.lightTheme).toBe("day");
  });

  it("Undo keeps an edit made in between and restores the selection", async () => {
    seed({ ...DEFAULT_ACCOUNT, customThemes: [ocean, ...themes(1)], darkTheme: "ocean" });
    await render();
    await click(labelled("Delete Ocean"));
    await click(labelled("Edit Theme 0"));
    await editorOpen();
    await typeInto(field(document, "Name") as HTMLInputElement, "Renamed");
    await click(named("Save"));
    await click(named("Undo"));
    expect(state().account.customThemes.map((t) => [t.id, t.name])).toEqual([
      ["ocean", "Ocean"],
      ["t0", "Renamed"],
    ]);
    expect(state().account.darkTheme).toBe("ocean");
  });

  it("Undo does not take back a side that was chosen again in between", async () => {
    seed({ ...DEFAULT_ACCOUNT, customThemes: [ocean], darkTheme: "ocean" });
    await render();
    await click(labelled("Delete Ocean"));
    state().setAccount({ ...state().account, darkTheme: "hc" });
    await click(named("Undo"));
    expect(state().account.customThemes.map((t) => t.id)).toEqual(["ocean"]);
    expect(state().account.darkTheme).toBe("hc");
  });

  it("Undo at 16 themes says the theme could not be restored", async () => {
    seed({ ...DEFAULT_ACCOUNT, customThemes: [ocean] });
    await render();
    await click(labelled("Delete Ocean"));
    state().setAccount({ ...state().account, customThemes: themes(16) });
    await click(named("Undo"));
    expect(state().account.customThemes).toHaveLength(16);
    expect(document.body.textContent).toContain("16 custom themes at most. Delete one to add another.");
  });

  it("Undo restores under a fresh id when a new theme took the id, keeping the selection", async () => {
    seed({ ...DEFAULT_ACCOUNT, customThemes: [ocean], darkTheme: "ocean" });
    await render();
    await click(labelled("Delete Ocean"));
    state().setAccount({ ...state().account, customThemes: [{ ...ocean, name: "Other" }] });
    await click(named("Undo"));
    expect(state().account.customThemes.map((t) => [t.id, t.name])).toEqual([
      ["ocean-2", "Ocean"],
      ["ocean", "Other"],
    ]);
    expect(state().account.darkTheme).toBe("ocean-2");
  });

  it("saving an edit of a theme deleted meanwhile adds it as a new theme", async () => {
    seed({ ...DEFAULT_ACCOUNT, customThemes: [ocean] });
    await render();
    await click(labelled("Edit Ocean"));
    await editorOpen();
    state().setAccount({ ...state().account, customThemes: [] });
    await click(named("Save"));
    expect(state().account.customThemes).toEqual([ocean]);
  });

  it("saving an edit of a deleted theme at 16 themes keeps the editor open and says why", async () => {
    seed({ ...DEFAULT_ACCOUNT, customThemes: [ocean] });
    await render();
    await click(labelled("Edit Ocean"));
    await editorOpen();
    state().setAccount({ ...state().account, customThemes: themes(16) });
    await click(named("Save"));
    expect(state().account.customThemes).toHaveLength(16);
    expect(field(document, "Name")).toBeTruthy();
    expect(document.body.textContent).toContain("16 custom themes at most. Delete one to add another.");
  });

  it("at 16 themes, Duplicate & edit, Import and each Duplicate are disabled and the hint says why", async () => {
    seed({ ...DEFAULT_ACCOUNT, customThemes: themes(16) });
    const page = await render();
    expect(named("Duplicate & edit").disabled).toBe(true);
    expect(named("Import").disabled).toBe(true);
    expect(labelled("Duplicate Theme 0").disabled).toBe(true);
    expect(page.container.textContent).toContain("16 custom themes at most. Delete one to add another.");
    expect(labelled("Edit Theme 0").disabled).toBe(false);
  });

  it("shows no hint below the limit", async () => {
    seed({ ...DEFAULT_ACCOUNT, customThemes: themes(15) });
    const page = await render();
    expect(named("Duplicate & edit").disabled).toBe(false);
    expect(page.container.textContent).not.toContain("16 custom themes at most");
  });

  it("imports a file into the editor, which still has to be saved; a hostile file only lists errors", async () => {
    await render();
    await chooseFile(hostileText);
    expect(document.querySelector('[data-slot="theme-import-errors"]')?.textContent).toContain("roles.bg");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await chooseFile(exampleText);
    await editorOpen();
    expect(field(document, "Name").value).toBe("My theme");
    expect(state().account.customThemes).toEqual([]);
    await click(named("Save"));
    expect(state().account.customThemes).toEqual([{ id: "my-theme", ...initial }]);
  });

  it("Export downloads the stored theme", async () => {
    seed({ ...DEFAULT_ACCOUNT, customThemes: [ocean] });
    const create = vi.fn(() => "blob:pap/3");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await render();
    await click(labelled("Export Ocean"));
    expect(await (create.mock.calls[0] as unknown as [Blob])[0].text()).toBe(exportThemeFile(ocean));
    expect(clicked).toHaveBeenCalledOnce();
  });
});
