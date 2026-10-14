// @vitest-environment happy-dom
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { settingsModelsEn, settingsModelsFr } from "./catalog/settings-models.ts";
import { registerCatalog, translate } from "./index.ts";

const src = join(import.meta.dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe("lazy catalog (Settings › Models)", () => {
  it("registers with the section's chunk, English and French, with the same keys and slots", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(translate("en", "settingsModels.refresh")).toBe("settingsModels.refresh");
    await act(async () => registerCatalog({ en: settingsModelsEn, fr: settingsModelsFr }));
    expect(translate("en", "settingsModels.refresh")).toBe("Refresh catalog");
    expect(translate("fr", "settingsModels.switch.partial", { on: 1, total: 3 })).toBe("1/3 activés");
    expect(Object.keys(settingsModelsFr)).toEqual(Object.keys(settingsModelsEn));
    const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(settingsModelsEn) as Array<keyof typeof settingsModelsEn>) {
      expect(settingsModelsFr[key], key).not.toBe("");
      expect(slots(settingsModelsFr[key]), key).toEqual(slots(settingsModelsEn[key]));
    }
  });

  it("is named only by the section's own files: nothing eager or in the Settings chunk can render a raw key", () => {
    const inChunk = new Set([
      "features/models/ApiKeyForm.tsx",
      "features/models/DiscardConfirm.tsx",
      "features/models/DiscoverPanel.tsx",
      "features/models/EnabledSwitches.tsx",
      "features/models/ModelTest.tsx",
      "features/models/ModelsJsonEditor.tsx",
      "features/models/ModelsSection.tsx",
      "features/models/PricingLookup.tsx",
      "features/models/PricingSwitch.tsx",
      "features/models/ProviderDetail.tsx",
      "features/models/ProviderList.tsx",
      "features/models/SignInFlow.tsx",
      "features/models/models-json.vm.ts",
      "features/models/models.vm.ts",
      "features/models/register-catalog.ts",
      "features/models/use-login-flow.ts",
      "features/models/use-pricing-setting.ts",
    ]);
    expect([...inChunk].filter((file) => !existsSync(join(src, file)))).toEqual([]);
    const offenders: string[] = [];
    for (const file of files(src)) {
      const name = relative(src, file).split("\\").join("/");
      if (!/\.tsx?$/.test(name) || /\.test\.|^i18n\/|^testing\/|models-bed/.test(name) || inChunk.has(name))
        continue;
      const code = readFileSync(file, "utf8");
      if (/["'`]settingsModels\./.test(code)) offenders.push(`${name}: settingsModels key`);
      if (/catalog\/settings-models\.ts"|register-catalog\.ts"/.test(code)) offenders.push(`${name}: import`);
    }
    expect(offenders).toEqual([]);
  });

  it("stays out of the eager catalogs and apart from the other lazy ones", async () => {
    const { en } = await import("./en.ts");
    const { fr } = await import("./fr.ts");
    const { sessionModelsEn } = await import("./catalog/session-models.ts");
    const { settingsScreenEn } = await import("./catalog/settings-screen.ts");
    expect(Object.keys(en).filter((key) => key.startsWith("settingsModels."))).toEqual([]);
    expect(Object.keys(fr).filter((key) => key.startsWith("settingsModels."))).toEqual([]);
    for (const other of [sessionModelsEn, settingsScreenEn])
      expect(Object.keys(other).filter((key) => key in settingsModelsEn)).toEqual([]);
  });
});
