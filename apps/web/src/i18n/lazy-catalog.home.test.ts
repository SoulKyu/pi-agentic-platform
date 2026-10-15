import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { homeEn, homeFr } from "./catalog/home.ts";

const src = join(import.meta.dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );

/** The files of the home's lazy chunks that name its keys (Tasks 8, 10 and 11 add theirs). */
const IN_CHUNK = new Set([
  "features/home/StatusLine.tsx",
  "features/home/RecentWork.tsx",
  "features/home/ProjectPicker.tsx",
  "features/home/ProjectFacts.tsx",
  "features/home/project-facts.ts",
  "features/home/run-launch.ts",
  "features/home/ActionRow.tsx",
  "features/home/HomeBody.tsx",
  "features/home/use-root-access.ts",
]);

describe("lazy catalog (project home)", () => {
  it("has the same keys and slots in English and French", () => {
    expect(Object.keys(homeFr)).toEqual(Object.keys(homeEn));
    const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(homeEn) as Array<keyof typeof homeEn>) {
      expect(homeFr[key], key).not.toBe("");
      expect(slots(homeFr[key]), key).toEqual(slots(homeEn[key]));
    }
  });

  it("is named only by the home's lazy files: the eager composer can never render a raw key", () => {
    expect([...IN_CHUNK].filter((file) => !existsSync(join(src, file)))).toEqual([]);
    const offenders: string[] = [];
    for (const file of files(src)) {
      const name = relative(src, file).split("\\").join("/");
      if (!/\.tsx?$/.test(name) || /\.test\.|^i18n\/|^testing\//.test(name) || IN_CHUNK.has(name)) continue;
      const code = readFileSync(file, "utf8");
      if (/["'`]home\./.test(code)) offenders.push(`${name}: home key`);
      if (/catalog\/home\.ts"|register-home\.ts"/.test(code)) offenders.push(`${name}: import`);
    }
    expect(offenders).toEqual([]);
  });

  it("stays out of the eager catalogs", async () => {
    const { en } = await import("./en.ts");
    const { fr } = await import("./fr.ts");
    expect(Object.keys(en).filter((key) => key.startsWith("home."))).toEqual([]);
    expect(Object.keys(fr).filter((key) => key.startsWith("home."))).toEqual([]);
  });

  it("is reached from the eager composer only through import(): its code cannot slide back into the first paint", () => {
    const lazyOnly =
      /from "\.\/(ProjectFacts|project-facts|run-launch|ProjectPicker|HomeBody|ActionRow)\.tsx?"/;
    const eager = ["ProjectHome.tsx", "ModeChips.tsx", "use-launch.ts", "home-mode.ts"];
    for (const name of eager) {
      const code = readFileSync(join(src, "features/home", name), "utf8");
      // A type-only import is erased; any other static import would pull the chunk into the initial bundle.
      const statics = [...code.matchAll(new RegExp(`^import (?!type )[^;]*${lazyOnly.source};`, "gm"))];
      expect(
        statics.map((match) => match[0]),
        name,
      ).toEqual([]);
    }
  });
});
