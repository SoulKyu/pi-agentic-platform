// @vitest-environment happy-dom
import { TooltipProvider } from "@pap/ui";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsScreenEn, settingsScreenFr } from "../../i18n/catalog/settings-screen.ts";
import { settingsAppearanceEn, settingsAppearanceFr } from "../../i18n/catalog/settings-appearance.ts";
import { registerCatalog, setLocale } from "../../i18n/index.ts";
import { click, field, mount, settle, typeInto } from "../../testing/dom.ts";
import { roleChecks } from "./derive.ts";
import ThemeEditor from "./ThemeEditor.tsx";
import { exportThemeFile, MAX_THEME_FILE_BYTES } from "./theme-io.ts";
import {
  roles,
  initial,
  exampleText,
  hostileText,
  seed,
  named,
  row,
  fileInput,
  preview,
  dialogTitles,
  ratioOf,
  chooseFile,
} from "./theme-test-kit.ts";

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

  it("exports the draft through a Blob URL, revoked on a later task", async () => {
    const create = vi.fn(() => "blob:pap/2");
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.useFakeTimers();
    await renderEditor();
    await click(named("Export"));
    const blob = (create.mock.calls[0] as unknown as [Blob])[0];
    expect(await blob.text()).toBe(exportThemeFile({ id: "my-theme", ...initial }));
    expect(clicked).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40_000);
    expect(revoke).toHaveBeenCalledWith("blob:pap/2");
  });
});
