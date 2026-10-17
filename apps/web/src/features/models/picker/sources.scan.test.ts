import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const features = join(import.meta.dirname, "..", "..");

/** The only files outside `features/models/` that may read `models.overview` (MPR4). */
const OVERVIEW_ALLOW_LIST = ["sessions/ModelMenu.tsx", "auth/PiStep.tsx"];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

/** Non-test sources outside `features/models/`, as paths relative to `features/`. */
function outsideModels(): Array<{ readonly name: string; readonly code: string }> {
  return sources(features)
    .map((file) => relative(features, file).split("\\").join("/"))
    .filter(
      (name) => /\.tsx?$/.test(name) && !/\.test\.|-bed\.tsx?$/.test(name) && !name.startsWith("models/"),
    )
    .map((name) => ({ name, code: readFileSync(join(features, name), "utf8") }));
}

function overviewReaders(files: ReadonlyArray<{ name: string; code: string }>): string[] {
  return files
    .filter(
      ({ code }) => /["']models\.overview["']/.test(code) || /\buse-overview\b|\buseOverview\b/.test(code),
    )
    .map(({ name }) => name)
    .filter((name) => !OVERVIEW_ALLOW_LIST.includes(name));
}

function selectModelChoices(files: ReadonlyArray<{ name: string; code: string }>): string[] {
  return files
    .filter(
      ({ code }) =>
        /import\s*\{[^}]*\bSelect\b[^}]*\}\s*from\s*["']@pap\/ui/.test(code) &&
        /\b(?:ModelChoice|modelChoices)\b/.test(code),
    )
    .map(({ name }) => name);
}

describe("model pickers read only models.available or sessions.models (MPR4)", () => {
  it("the scan finds what it is meant to find", () => {
    const sample = [
      { name: "x/A.tsx", code: 'rpc.call("models.overview", {})' },
      { name: "x/B.tsx", code: 'import { useOverview } from "../models/use-overview.ts";' },
      { name: "sessions/ModelMenu.tsx", code: 'rpc.call("models.overview", {})' },
      { name: "x/C.tsx", code: 'import { Select } from "@pap/ui";\nconst modelChoices = [];' },
      { name: "x/D.tsx", code: 'import { Select } from "@pap/ui";\nconst choices = [];' },
    ];
    expect(overviewReaders(sample)).toEqual(["x/A.tsx", "x/B.tsx"]);
    expect(selectModelChoices(sample)).toEqual(["x/C.tsx"]);
  });

  it("the allow-list files exist and still read the overview (so the list cannot rot)", () => {
    for (const name of OVERVIEW_ALLOW_LIST) {
      const code = readFileSync(join(features, name), "utf8");
      expect(code, name).toMatch(/models\.overview|useOverview|use-overview/);
    }
  });

  it("no file outside features/models/ calls models.overview or imports use-overview", () => {
    expect(overviewReaders(outsideModels())).toEqual([]);
  });

  it("no file outside features/models/ builds model options for a Select", () => {
    expect(selectModelChoices(outsideModels())).toEqual([]);
  });
});
