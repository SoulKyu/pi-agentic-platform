// @vitest-environment happy-dom
import type { CustomTheme } from "@pap/contracts";
import { Toaster, TooltipProvider } from "@pap/ui";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsScreenEn, settingsScreenFr } from "../../i18n/catalog/settings-screen.ts";
import { registerCatalog, setLocale } from "../../i18n/index.ts";
import { click, field, mount, press, settle, typeInto } from "../../testing/dom.ts";
import { CustomThemes } from "./CustomThemes.tsx";
import { useAppearanceStore } from "./appearance-store.ts";
import { roleChecks } from "./derive.ts";
import { DEFAULT_ACCOUNT, DEFAULT_DEVICE } from "./model.ts";
import ThemeEditor from "./ThemeEditor.tsx";
import { exportThemeFile, MAX_THEME_FILE_BYTES, presetRoles } from "./theme-io.ts";

registerCatalog({ en: settingsScreenEn, fr: settingsScreenFr });
vi.mock("../../lib/report.ts", () => ({ reportClientIssue: vi.fn() }));

const roles = {
  bg: "#0E1626",
  surface: "#132033",
  text: "#E6EDF7",
  agent: "#38BDF8",
  you: "#FB923C",
  attn: "#EC4899",
  ok: "#34D399",
  err: "#F87171",
} as const;
const initial = { name: "My theme", base: "night", roles } as const;
const exampleText = JSON.stringify(initial);
const hostileText = JSON.stringify({
  ...initial,
  roles: { ...roles, bg: "url(https://x.test/a.png)", agent: undefined },
});
const state = () => useAppearanceStore.getState();
const seed = (account = DEFAULT_ACCOUNT) =>
  useAppearanceStore.setState({
    account,
    device: DEFAULT_DEVICE,
    accountStatus: "local",
    deviceStored: true,
  });
const themes = (count: number): CustomTheme[] =>
  Array.from({ length: count }, (_, i) => ({ id: `t${i}`, name: `Theme ${i}`, base: "night", roles }));
const ocean: CustomTheme = { id: "ocean", name: "Ocean", base: "night", roles };

const named = (name: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll("button")].find(
    (one) => (one.textContent ?? "").trim() === name,
  ) as HTMLButtonElement;
const labelled = (label: string) =>
  document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
const row = (role: string) => document.querySelector(`[data-role="${role}"]`) as HTMLElement;
const fileInput = () => document.querySelector('input[type="file"]') as HTMLInputElement;
const preview = () => document.querySelector('[data-slot="theme-preview"]') as HTMLElement;
const dialogTitles = () => [...document.querySelectorAll('[role="dialog"] h2')].map((h) => h.textContent);
const ratioOf = (value: number) => `${(Math.floor(value * 10) / 10).toFixed(1)}:1`;

async function chooseFile(text: string, size = text.length): Promise<void> {
  const file = { size, text: vi.fn(async () => text) };
  Object.defineProperty(fileInput(), "files", { value: [file], configurable: true });
  await act(async () => {
    fileInput().dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  seed();
});
afterEach(async () => {
  for (const close of document.querySelectorAll('button[aria-label="Close"]')) await click(close);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ThemeEditor", () => {
  const renderEditor = (onSave = vi.fn()) =>
    mount(
      <TooltipProvider>
        <ThemeEditor open onOpenChange={() => {}} initial={initial} onSave={onSave} />
      </TooltipProvider>,
    ).then(() => onSave);

  it("shows the ratio of a role in tabular figures and Below AA once an edit makes it unreadable", async () => {
    await renderEditor();
    expect(row("text").querySelector('[data-slot="chip"]')?.textContent).toBe("AA");
    await typeInto(field(document, "Text") as HTMLInputElement, "#1A2333");
    const chip = row("text").querySelector('[data-slot="chip"]');
    expect(chip?.textContent).toBe("Below AA");
    const expected = roleChecks({ id: "x", ...initial, roles: { ...roles, text: "#1A2333" } }).find(
      (check) => check.role === "text",
    );
    const ratio = row("text").querySelector('[data-slot="theme-ratio"]');
    expect(ratio?.textContent).toBe(ratioOf(expected?.ratio ?? 0));
    expect(ratio?.className).toContain("tabular-nums");
  });

  it("asks before saving below AA: Keep editing saves nothing, Save anyway saves the edited roles", async () => {
    const onSave = await renderEditor();
    await typeInto(field(document, "Text") as HTMLInputElement, "#1A2333");
    await click(named("Save"));
    expect(dialogTitles()).toContain("Save below AA contrast?");
    const confirm = document.querySelector('[data-slot="theme-confirm"]');
    expect(confirm?.textContent).toContain("Text");
    expect(confirm?.textContent).toMatch(/\d\.\d:1/);
    await click(named("Keep editing"));
    expect(onSave).not.toHaveBeenCalled();
    expect(dialogTitles()).not.toContain("Save below AA contrast?");
    await click(named("Save"));
    await click(named("Save anyway"));
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith({ ...initial, roles: { ...roles, text: "#1A2333" } });
  });

  it("saves at once when every role passes", async () => {
    const onSave = await renderEditor();
    await click(named("Save"));
    expect(dialogTitles()).not.toContain("Save below AA contrast?");
    expect(onSave).toHaveBeenCalledWith(initial);
  });

  it("an invalid hex disables Save and marks the field invalid", async () => {
    await renderEditor();
    await typeInto(field(document, "Text") as HTMLInputElement, "#12");
    expect(named("Save").disabled).toBe(true);
    expect(field(document, "Text").getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Use # followed by six hexadecimal digits.",
    );
    await typeInto(field(document, "Text") as HTMLInputElement, "#1A2333");
    expect(named("Save").disabled).toBe(false);
  });

  it("pairs each colour input with a labelled hex field, and the two stay in step", async () => {
    await renderEditor();
    const picker = document.querySelector(
      'input[type="color"][aria-label="Agent, colour picker"]',
    ) as HTMLInputElement;
    expect(picker.value).toBe("#38bdf8");
    await typeInto(picker, "#112233");
    expect(field(document, "Agent").value).toBe("#112233");
  });

  it("previews with data-theme and inline hex values only", async () => {
    await renderEditor();
    expect(preview().getAttribute("data-theme")).toBe("night");
    expect(preview().style.getPropertyValue("--bg")).toBe("#0e1626");
    const declarations = (preview().getAttribute("style") ?? "").split(";").filter(Boolean);
    expect(declarations.length).toBeGreaterThan(10);
    for (const declaration of declarations)
      expect(declaration.trim(), declaration).toMatch(/^--[a-z0-9-]+:\s*#[0-9a-f]{6}(?:[0-9a-f]{2})?$/);
    await typeInto(field(document, "Background") as HTMLInputElement, "#12");
    expect(preview().style.getPropertyValue("--bg")).toBe("#0e1626");
  });

  it("a hostile import lists the paths and leaves the fields as they were", async () => {
    await renderEditor();
    await chooseFile(hostileText);
    const errors = document.querySelector('[data-slot="theme-import-errors"]');
    expect(errors?.textContent).toContain("roles.bg");
    expect(errors?.textContent).toContain("roles.agent");
    expect(field(document, "Background").value).toBe("#0E1626");
    expect(field(document, "Agent").value).toBe("#38BDF8");
  });

  it("refuses a big file without reading it; a good file fills the fields", async () => {
    await renderEditor();
    const big = { size: MAX_THEME_FILE_BYTES + 1, text: vi.fn(async () => exampleText) };
    Object.defineProperty(fileInput(), "files", { value: [big], configurable: true });
    await act(async () => {
      fileInput().dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(big.text).not.toHaveBeenCalled();
    expect(document.querySelector('[data-slot="theme-import-errors"]')?.textContent).toContain("16 KB");
    await chooseFile(exampleText.replace("#38BDF8", "#112233").replace("My theme", "Imported"));
    expect(document.querySelector('[data-slot="theme-import-errors"]')).toBeNull();
    expect(field(document, "Agent").value).toBe("#112233");
    expect(field(document, "Name").value).toBe("Imported");
  });

  it("exports the draft through a Blob URL, revoked after the click", async () => {
    const create = vi.fn(() => "blob:pap/2");
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await renderEditor();
    await click(named("Export"));
    const blob = (create.mock.calls[0] as unknown as [Blob])[0];
    expect(await blob.text()).toBe(exportThemeFile({ id: "my-theme", ...initial }));
    expect(clicked).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("blob:pap/2");
  });
});

describe("CustomThemes", () => {
  const render = () =>
    mount(
      <TooltipProvider>
        <Toaster closeLabel="Close" />
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
