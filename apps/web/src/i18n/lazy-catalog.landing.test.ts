import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { landingEn, landingFr } from "./catalog/landing.ts";
import { en } from "./en.ts";
import { fr } from "./fr.ts";

const src = join(import.meta.dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );

describe("lazy catalog (landing)", () => {
  it("has the same keys in English and French, none empty", () => {
    expect(Object.keys(landingFr)).toEqual(Object.keys(landingEn));
    for (const key of Object.keys(landingFr) as Array<keyof typeof landingFr>)
      expect(landingFr[key], key).not.toBe("");
  });

  it("says the three states in French with vous", () => {
    expect(landingFr["landing.handled.title"]).toBe("Déjà traité");
    expect(landingFr["landing.notFound.title"]).toBe("Cette notification n'existe plus");
    expect(landingFr["landing.failed.retry"]).toBe("Réessayer");
  });

  it("puts a space before every colon in French (W6-R9)", () => {
    const tight = Object.entries(landingFr)
      .filter(([, text]) => /[\p{L}\d)]:(?!\/\/)/u.test(text.replaceAll("{", " ")))
      .map(([key]) => key);
    expect(tight).toEqual([]);
  });

  it("stays out of the eager catalogs and is named only by the landing", () => {
    expect(Object.keys(en).filter((key) => key.startsWith("landing."))).toEqual([]);
    expect(Object.keys(fr).filter((key) => key.startsWith("landing."))).toEqual([]);
    const offenders = files(src)
      .map((file) => relative(src, file).split("\\").join("/"))
      .filter((name) => /\.tsx?$/.test(name) && !/\.test\.|^i18n\/|^testing\//.test(name))
      .filter((name) => name !== "features/notifications/Landing.tsx")
      .filter((name) => /["'`]landing\.[a-z]/.test(readFileSync(join(src, name), "utf8")));
    expect(offenders).toEqual([]);
  });
});
