import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { addProjectEn, addProjectFr } from "./catalog/add-project.ts";

const src = join(import.meta.dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );

describe("lazy catalog (Add project)", () => {
  it("has the same keys and slots in English and French", () => {
    expect(Object.keys(addProjectFr)).toEqual(Object.keys(addProjectEn));
    const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of Object.keys(addProjectEn) as Array<keyof typeof addProjectEn>) {
      expect(addProjectFr[key], key).not.toBe("");
      expect(slots(addProjectFr[key]), key).toEqual(slots(addProjectEn[key]));
    }
  });

  it("is named only by the dialog's own files: nothing eager can render a raw key", () => {
    const inChunk = new Set([
      "features/projects/AddProjectDialog.tsx",
      "features/projects/add-project.vm.ts",
      "features/projects/register-add-project-catalog.ts",
    ]);
    expect([...inChunk].filter((file) => !existsSync(join(src, file)))).toEqual([]);
    const offenders: string[] = [];
    for (const file of files(src)) {
      const name = relative(src, file).split("\\").join("/");
      if (!/\.tsx?$/.test(name) || /\.test\.|^i18n\/|^testing\//.test(name) || inChunk.has(name)) continue;
      const code = readFileSync(file, "utf8");
      if (/["'`]addProject\./.test(code)) offenders.push(`${name}: addProject key`);
      if (/catalog\/add-project\.ts"|register-add-project-catalog\.ts"/.test(code))
        offenders.push(`${name}: import`);
    }
    expect(offenders).toEqual([]);
  });
});
