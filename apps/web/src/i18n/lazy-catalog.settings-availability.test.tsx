// @vitest-environment happy-dom
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { settingsAvailabilityEn, settingsAvailabilityFr } from "./catalog/settings-availability.ts";
import { translate } from "./index.ts";

const src = join(import.meta.dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe("lazy catalog (settings availability)", () => {
  it("registers with its register file, English and French, with the same keys and slots", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(translate("en", "settingsAvailability.title")).toBe("settingsAvailability.title");
    await import("./register-settings-availability.ts");
    expect(translate("en", "settingsAvailability.title")).toBe("Available models");
    expect(translate("fr", "settingsAvailability.title")).toBe("Modèles proposés");
    expect(Object.keys(settingsAvailabilityFr)).toEqual(Object.keys(settingsAvailabilityEn));
    const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(settingsAvailabilityEn) as Array<keyof typeof settingsAvailabilityEn>) {
      expect(settingsAvailabilityFr[key], key).not.toBe("");
      expect(slots(settingsAvailabilityFr[key]), key).toEqual(slots(settingsAvailabilityEn[key]));
    }
  });

  it("writes French with its accents and the owner's wording (vous, a space before the colon)", () => {
    const text = Object.values(settingsAvailabilityFr).join("\n");
    for (const word of ["modèle", "réglages", "fournisseur", "clé", "enregistré", "proposé"])
      expect(text, word).toContain(word);
    expect(settingsAvailabilityFr["settingsAvailability.mode.all"]).toBe(
      "Tous les modèles des fournisseurs connectés",
    );
    expect(settingsAvailabilityFr["settingsAvailability.mode.selection"]).toBe("Ma sélection");
    expect(text).not.toMatch(/(?<!\p{L})(tu|ton|ta|tes)(?!\p{L})/iu);
    expect(text).not.toMatch(/\S:(\s|$)/);
  });

  it("never claims the extension load is offline", () => {
    for (const text of [settingsAvailabilityEn, settingsAvailabilityFr])
      expect(Object.values(text).join("\n")).not.toMatch(/offline|hors ligne|sans réseau|no network/i);
  });

  it("has no Restrictions tab or placeholder (owner q11)", () => {
    expect(Object.keys(settingsAvailabilityEn).filter((key) => /restrict/i.test(key))).toEqual([]);
  });

  it("is named only by the availability folder: nothing eager can render a raw key", () => {
    const offenders: string[] = [];
    for (const file of files(src)) {
      const name = relative(src, file).split("\\").join("/");
      if (!/\.tsx?$/.test(name) || /\.test\.|^i18n\/|^testing\/|^features\/models\/availability\//.test(name))
        continue;
      const code = readFileSync(file, "utf8");
      if (/["'`]settingsAvailability\./.test(code)) offenders.push(`${name}: key`);
      if (/register-settings-availability\.ts"|catalog\/settings-availability\.ts"/.test(code))
        offenders.push(`${name}: import`);
    }
    expect(offenders).toEqual([]);
  });

  it("stays out of the eager catalogs", async () => {
    const { en } = await import("./en.ts");
    const { fr } = await import("./fr.ts");
    expect(Object.keys(en).filter((key) => key.startsWith("settingsAvailability."))).toEqual([]);
    expect(Object.keys(fr).filter((key) => key.startsWith("settingsAvailability."))).toEqual([]);
  });
});
