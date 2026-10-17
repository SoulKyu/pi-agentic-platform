// @vitest-environment happy-dom
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { modelPickerEn, modelPickerFr } from "./catalog/model-picker.ts";
import { translate } from "./index.ts";

const src = join(import.meta.dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe("lazy catalog (model picker)", () => {
  it("registers with its register file, English and French, with the same keys and slots", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(translate("en", "modelPicker.search")).toBe("modelPicker.search");
    await import("./register-model-picker.ts");
    expect(translate("en", "modelPicker.search")).toBe("Search models");
    expect(translate("fr", "modelPicker.search")).toBe("Rechercher un modèle");
    expect(Object.keys(modelPickerFr)).toEqual(Object.keys(modelPickerEn));
    const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(modelPickerEn) as Array<keyof typeof modelPickerEn>) {
      expect(modelPickerFr[key], key).not.toBe("");
      expect(slots(modelPickerFr[key]), key).toEqual(slots(modelPickerEn[key]));
    }
  });

  it("writes French with its accents and the owner's wording (vous)", () => {
    const text = Object.values(modelPickerFr).join("\n");
    for (const word of ["modèle", "réglages", "fournisseur", "clé", "enregistré", "proposé"])
      expect(text, word).toContain(word);
    expect(modelPickerFr["modelPicker.notOffered"]).toBe("Modèle enregistré, plus proposé");
    expect(modelPickerFr["modelPicker.empty"]).toBe(
      "Aucun modèle disponible. Connectez un fournisseur dans les réglages.",
    );
    expect(text).not.toMatch(/\btu\b|\bton\b|\bta\b|\btes\b/i);
  });

  it("is named only by the picker's folder: nothing eager can render a raw key", () => {
    const offenders: string[] = [];
    for (const file of files(src)) {
      const name = relative(src, file).split("\\").join("/");
      if (!/\.tsx?$/.test(name) || /\.test\.|^i18n\/|^testing\/|^features\/models\/picker\//.test(name))
        continue;
      const code = readFileSync(file, "utf8");
      if (/["'`]modelPicker\./.test(code)) offenders.push(`${name}: modelPicker key`);
      if (/register-model-picker\.ts"|catalog\/model-picker\.ts"/.test(code))
        offenders.push(`${name}: import`);
    }
    expect(offenders).toEqual([]);
  });

  it("stays out of the eager catalogs", async () => {
    const { en } = await import("./en.ts");
    const { fr } = await import("./fr.ts");
    expect(Object.keys(en).filter((key) => key.startsWith("modelPicker."))).toEqual([]);
    expect(Object.keys(fr).filter((key) => key.startsWith("modelPicker."))).toEqual([]);
  });
});
