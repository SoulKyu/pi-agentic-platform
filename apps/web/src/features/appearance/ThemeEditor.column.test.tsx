// @vitest-environment happy-dom
import { Toaster, TooltipProvider } from "@pap/ui";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsScreenEn, settingsScreenFr } from "../../i18n/catalog/settings-screen.ts";
import { settingsAppearanceEn, settingsAppearanceFr } from "../../i18n/catalog/settings-appearance.ts";
import { registerCatalog, setLocale } from "../../i18n/index.ts";
import { click, field, mount, press } from "../../testing/dom.ts";
import { AppearancePanel } from "./AppearancePanel.tsx";
import "./ThemeEditor.tsx";
import { DEFAULT_ACCOUNT } from "./model.ts";
import { ocean, labelled, named, seed } from "./theme-test-kit.ts";

registerCatalog({ en: settingsScreenEn, fr: settingsScreenFr });
registerCatalog({ en: settingsAppearanceEn, fr: settingsAppearanceFr });
vi.mock("../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));
// The panel lists the installed fonts through the runtime: a stub, so no socket is opened.
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => ({ rpc: { call: async () => ({ families: [] }) } }),
}));

const room = (wide: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: wide && query.includes("min-width: 1024px"),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

const render = () =>
  mount(
    <TooltipProvider>
      <Toaster closeLabel="Close" regionLabel="Notifications" />
      <AppearancePanel />
    </TooltipProvider>,
  );
const slot = () => document.querySelector('[data-slot="theme-editor-slot"]') as HTMLElement;
const editOcean = async () => {
  await click(labelled("Edit Ocean"));
  await act(async () => {
    await vi.waitFor(() => expect(field(document, "Name")).toBeTruthy(), { timeout: 2_000 });
  });
};

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  seed({ ...DEFAULT_ACCOUNT, customThemes: [ocean] });
});
afterEach(async () => {
  for (const close of document.querySelectorAll('button[aria-label="Close"]')) await click(close);
  vi.unstubAllGlobals();
});

describe("theme editor column (board 08)", () => {
  it("sits in the 330 px right column, not in a dialog, when the page is wide", async () => {
    room(true);
    await render();
    expect(slot().textContent).toContain("Choose Edit");
    await editOcean();
    expect(slot().querySelector('[data-slot="theme-editor-column"]')).not.toBeNull();
    expect(slot().className).toContain("w-status-panel");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(slot().contains(field(document, "Name"))).toBe(true);
  });

  it("moves the focus into the column, Escape closes it and the focus returns to the Edit button", async () => {
    room(true);
    await render();
    await editOcean();
    expect(document.activeElement?.textContent).toBe("Custom theme");
    expect(slot().contains(document.activeElement)).toBe(true);
    await press(field(document, "Name"), { key: "Escape" });
    expect(slot().querySelector('[data-slot="theme-editor-column"]')).toBeNull();
    expect(slot().textContent).toContain("Choose Edit");
    expect(document.activeElement).toBe(labelled("Edit Ocean"));
  });

  it("the column's Close button and Save both end the edit", async () => {
    room(true);
    await render();
    await editOcean();
    await click(slot().querySelector('button[aria-label="Close"]') as HTMLElement);
    expect(slot().querySelector('[data-slot="theme-editor-column"]')).toBeNull();
    await editOcean();
    await click(named("Save", slot()));
    expect(slot().querySelector('[data-slot="theme-editor-column"]')).toBeNull();
  });

  it("falls back to a sheet where there is no room for the column", async () => {
    room(false);
    await render();
    await editOcean();
    expect(slot().querySelector('[data-slot="theme-editor-column"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
