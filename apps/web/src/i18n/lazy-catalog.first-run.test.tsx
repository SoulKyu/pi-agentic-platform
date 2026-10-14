// @vitest-environment happy-dom
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { firstRunEn, firstRunFr } from "./catalog/first-run.ts";

const src = join(import.meta.dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );

describe("lazy catalog (first run)", () => {
  it("has the same keys and placeholders in English and French", () => {
    expect(Object.keys(firstRunFr)).toEqual(Object.keys(firstRunEn));
    const slots = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(firstRunEn) as Array<keyof typeof firstRunEn>)
      expect(slots(firstRunFr[key]), key).toEqual(slots(firstRunEn[key]));
  });

  it("stays out of the eager catalogs and is named only by the stepper chunk", async () => {
    const { en } = await import("./en.ts");
    const { fr } = await import("./fr.ts");
    expect(Object.keys(en).filter((key) => key.startsWith("firstRun."))).toEqual([]);
    expect(Object.keys(fr).filter((key) => key.startsWith("firstRun."))).toEqual([]);
    const inChunk = new Set([
      "features/auth/PasskeyStep.tsx",
      "features/auth/PiStep.tsx",
      "features/auth/SetupStepper.tsx",
      "features/auth/register-first-run.ts",
      "routes/setup/SetupModels.tsx",
    ]);
    const offenders: string[] = [];
    for (const file of files(src)) {
      const name = relative(src, file).split("\\").join("/");
      if (!/\.tsx?$/.test(name) || /\.test\.|^i18n\/|^testing\//.test(name) || inChunk.has(name)) continue;
      const code = readFileSync(file, "utf8");
      if (/["'`]firstRun\./.test(code)) offenders.push(`${name}: firstRun key`);
      if (/catalog\/first-run\.ts"|register-first-run\.ts"/.test(code)) offenders.push(`${name}: import`);
    }
    expect(offenders).toEqual([]);
  });
});
