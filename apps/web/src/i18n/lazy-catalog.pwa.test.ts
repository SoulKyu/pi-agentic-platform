import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "./en.ts";
import { fr } from "./fr.ts";
import { pwaEn, pwaFr } from "./catalog/pwa.ts";

const src = join(import.meta.dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );

describe("lazy catalog (pwa update banner)", () => {
  it("has the same keys in English and French, none empty", () => {
    expect(Object.keys(pwaFr)).toEqual(Object.keys(pwaEn));
    for (const key of Object.keys(pwaFr) as Array<keyof typeof pwaFr>) expect(pwaFr[key], key).not.toBe("");
  });

  it("stays out of the eager catalogs and is named only by the banner", () => {
    expect(Object.keys(en).filter((key) => key.startsWith("pwa."))).toEqual([]);
    expect(Object.keys(fr).filter((key) => key.startsWith("pwa."))).toEqual([]);
    const offenders = files(src)
      .map((file) => relative(src, file).split("\\").join("/"))
      .filter((name) => /\.tsx?$/.test(name) && !/\.test\.|^i18n\/|^testing\//.test(name))
      .filter((name) => name !== "routes/shell/UpdateBanner.tsx")
      .filter((name) => /["'`]pwa\./.test(readFileSync(join(src, name), "utf8")));
    expect(offenders).toEqual([]);
  });
});
