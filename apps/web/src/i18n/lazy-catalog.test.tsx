// @vitest-environment happy-dom
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, text } from "../testing/dom.ts";
import { settingsScreenEn, settingsScreenFr } from "./catalog/settings-screen.ts";
import { registerCatalog, setLocale, translate, useT } from "./index.ts";

const src = join(import.meta.dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

afterEach(() => setLocale("en"));

describe("lazy catalog (Settings)", () => {
  it("shows the key and reports it until the chunk registers its strings, then resolves and re-renders mounted consumers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    function Probe() {
      const t = useT();
      return <p>{t("settings.appearance.status.saved")}</p>;
    }
    const page = await mount(<Probe />);
    expect(text(page.container)).toBe("settings.appearance.status.saved");
    expect(warn).toHaveBeenCalledWith("pap: message_missing");
    await act(async () => registerCatalog({ en: settingsScreenEn, fr: settingsScreenFr }));
    expect(text(page.container)).toBe("Saved to your account");
    await act(async () => setLocale("fr"));
    expect(text(page.container)).toBe("Enregistré dans votre compte");
    expect(translate("en", "settings.appearance.px", { value: 13 })).toBe("13 px");
    await page.unmount();
    warn.mockRestore();
  });

  it("is referenced only from the Settings chunk: eager code can never render a raw key", () => {
    const lazy = Object.keys(settingsScreenEn);
    // Explicit: features/appearance also holds the eager boot files (index, controller, store, model).
    const chunk = new Set([
      "routes/settings/AccountSection.tsx",
      "routes/settings/LanguageSection.tsx",
      "routes/settings/SettingsScreen.tsx",
      "routes/settings/sections.tsx",
      "features/appearance/AppearancePanel.tsx",
      "features/appearance/AppearancePreview.tsx",
      "features/appearance/AppearanceSection.tsx",
      "features/appearance/CustomThemes.tsx",
      "features/appearance/DetailsSection.tsx",
      "features/appearance/ReadingSection.tsx",
      "features/appearance/ThemeEditor.tsx",
      "features/appearance/ThemeImport.tsx",
      "features/appearance/ThemeSection.tsx",
    ]);
    // A stale entry would silently exempt nothing: every listed file must exist.
    expect([...chunk].filter((file) => !existsSync(join(src, file)))).toEqual([]);
    const inChunk = (file: string) => chunk.has(file);
    const offenders: string[] = [];
    for (const file of files(src)) {
      const name = relative(src, file).split("\\").join("/");
      if (!/\.tsx?$/.test(name) || /\.test\.|^i18n\/|^testing\//.test(name) || inChunk(name)) continue;
      const code = readFileSync(file, "utf8");
      for (const key of lazy)
        if (code.includes(`"${key}"`) || code.includes(`\`${key}`)) offenders.push(`${name}: ${key}`);
      if (/settings\.(?:appearance|theme|language|account|nav|section|soon)\./.test(code))
        offenders.push(`${name}: settings prefix`);
    }
    expect(offenders).toEqual([]);
  });
});
