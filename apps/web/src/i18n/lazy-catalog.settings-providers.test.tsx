// @vitest-environment happy-dom
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { settingsModelsEn } from "./catalog/settings-models.ts";
import { settingsProvidersEn, settingsProvidersFr } from "./catalog/settings-providers.ts";
import { registerCatalog, translate } from "./index.ts";

const src = join(import.meta.dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );

describe("lazy catalog (provider form)", () => {
  it("registers English and French with the same keys and slots, and translates", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(translate("en", "settingsProviders.add")).toBe("settingsProviders.add");
    await act(async () => registerCatalog({ en: settingsProvidersEn, fr: settingsProvidersFr }));
    expect(translate("en", "settingsProviders.add")).toBe("Add a provider");
    expect(translate("fr", "settingsProviders.add")).toBe("Ajouter un fournisseur");
    expect(Object.keys(settingsProvidersFr)).toEqual(Object.keys(settingsProvidersEn));
    const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(settingsProvidersEn) as Array<keyof typeof settingsProvidersEn>) {
      expect(settingsProvidersFr[key], key).not.toBe("");
      expect(slots(settingsProvidersFr[key]), key).toEqual(slots(settingsProvidersEn[key]));
    }
  });

  it("French carries its accents and uses vous", () => {
    const fr = Object.values(settingsProvidersFr).join("\n");
    for (const word of ["modèle", "réglages", "fournisseur", "clé", "enregistré", "proposé"])
      expect(fr, word).toContain(word);
    for (const bare of [/\bmodele/i, /\breglages/i, /\bcle(?![\wé])/i, /\benregistre(?![\wé])/i])
      expect(fr).not.toMatch(bare);
    expect(fr).not.toMatch(/(^|[\s'])(tu|ton|ta|tes)(?=[\s,.;:!?]|$)/im);
    expect(fr).toMatch(/\bvous\b/i);
  });

  it("has no literal bidi, zero-width or line-separator character", () => {
    const all = [...Object.values(settingsProvidersEn), ...Object.values(settingsProvidersFr)].join("");
    expect(all).not.toMatch(/[\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/u);
  });

  it("is named only by the provider form's own files", () => {
    const inChunk = new Set(["features/models/ProviderFormPanel.tsx", "features/models/ProviderList.tsx"]);
    const offenders: string[] = [];
    for (const file of files(src)) {
      const name = relative(src, file).split("\\").join("/");
      if (!/\.tsx?$/.test(name) || /\.test\.|^testing\/|models-bed/.test(name)) continue;
      if (name.startsWith("i18n/") || name.startsWith("features/models/provider/") || inChunk.has(name))
        continue;
      const code = readFileSync(file, "utf8");
      if (/["'`]settingsProviders\./.test(code)) offenders.push(`${name}: settingsProviders key`);
      if (/settings-providers\.ts"|register-settings-providers\.ts"/.test(code))
        offenders.push(`${name}: import`);
    }
    expect(offenders).toEqual([]);
    expect([...inChunk].filter((file) => !existsSync(join(src, file)))).toEqual([]);
  });

  it("stays out of the eager catalogs and apart from the settingsModels one", async () => {
    const { en } = await import("./en.ts");
    const { fr } = await import("./fr.ts");
    expect(Object.keys(en).filter((key) => key.startsWith("settingsProviders."))).toEqual([]);
    expect(Object.keys(fr).filter((key) => key.startsWith("settingsProviders."))).toEqual([]);
    expect(Object.keys(settingsModelsEn).filter((key) => key in settingsProvidersEn)).toEqual([]);
  });
});
