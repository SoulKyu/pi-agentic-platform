import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "./en.ts";
import { fr } from "./fr.ts";
import { pushEn, pushFr } from "./catalog/push.ts";

const src = join(import.meta.dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );

describe("lazy catalog (push)", () => {
  it("has the same keys in English and French, none empty", () => {
    expect(Object.keys(pushFr)).toEqual(Object.keys(pushEn));
    for (const key of Object.keys(pushFr) as Array<keyof typeof pushFr>)
      expect(pushFr[key], key).not.toBe("");
  });

  it("carries the M12R16 and M12R29 sentences", () => {
    expect(pushFr["push.support.insecure"]).toBe("Les notifications et l'installation demandent HTTPS.");
    expect(pushFr["push.support.needs_install_ios"]).toBe(
      "Ajoutez pap à l'écran d'accueil (Partager, puis Sur l'écran d'accueil), puis activez les notifications ici.",
    );
  });

  it("stays out of the eager catalogs and is named only by lazy code", () => {
    expect(Object.keys(en).filter((key) => key.startsWith("push."))).toEqual([]);
    expect(Object.keys(fr).filter((key) => key.startsWith("push."))).toEqual([]);
    const offenders = files(src)
      .map((file) => relative(src, file).split("\\").join("/"))
      .filter((name) => /\.tsx?$/.test(name) && !/\.test\.|^i18n\/|^testing\//.test(name))
      .filter((name) => !/^features\/notifications\/|^routes\/shell\/UpdateBanner\.tsx$/.test(name))
      .filter((name) =>
        /["'`]push\.(?:support|enable|reenable)\./.test(readFileSync(join(src, name), "utf8")),
      );
    expect(offenders).toEqual([]);
  });
});
