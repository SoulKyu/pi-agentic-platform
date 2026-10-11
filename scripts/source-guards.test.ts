import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkRepository, checkSource, lineCount, MAX_LINES, trackedSourceFiles } from "./source-guards.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const linesOf = (count: number) => "export const a = 1;\n".repeat(count);
const rulesOf = (code: string, file = "packages/contracts/src/fixture.ts") =>
  checkSource(file, code).map((violation) => violation.rule);

describe("source guards over the tracked files (R64c)", () => {
  it("finds no file over 400 lines and no ESLint inline-config comment", () => {
    expect(checkRepository(repoRoot)).toEqual([]);
  });

  it("looks at the real sources and skips node_modules, dist, spikes and fixtures", () => {
    const files = trackedSourceFiles(repoRoot);
    expect(files).toContain("scripts/copy-sql.ts");
    expect(files).toContain("eslint.config.js");
    expect(files.filter((file) => /(^|\/)(node_modules|dist|spikes|fixtures)\//.test(file))).toEqual([]);
    expect(files.filter((file) => !/\.(ts|tsx|js|mjs|cjs)$/.test(file))).toEqual([]);
  });
});

describe("line limit", () => {
  it("counts lines the way a reader does, with or without a final newline", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("a")).toBe(1);
    expect(lineCount("a\n")).toBe(1);
    expect(lineCount("a\r\nb\r\n")).toBe(2);
    expect(lineCount("a\n\n")).toBe(2);
  });

  it("catches a file of 401 lines", () => {
    const [violation] = checkSource("packages/contracts/src/too-long.ts", linesOf(MAX_LINES + 1));
    expect(violation).toMatchObject({ rule: "max-lines", file: "packages/contracts/src/too-long.ts" });
    expect(violation?.detail).toContain("401 lines");
  });

  it("accepts a file of exactly 400 lines", () => {
    expect(rulesOf(linesOf(MAX_LINES))).toEqual([]);
  });

  it("catches the 401-line file that tries to switch the rule off from inside", () => {
    const code = `/* eslint max-lines: "off" -- legacy parser */\n${linesOf(MAX_LINES)}`;
    expect(rulesOf(code).sort()).toEqual(["inline-config", "max-lines"]);
  });
});

describe("ESLint inline config comments", () => {
  it.each([
    { label: "rule options with a reason", comment: '/* eslint max-lines: "off" -- legacy parser */' },
    { label: "no spaces", comment: "/*eslint max-lines:0*/" },
    { label: "the directive on the next line", comment: "/*\n  eslint max-lines: off\n*/" },
    { label: "options on the next line", comment: "/* eslint\n  max-lines: off */" },
    { label: "eslint-env", comment: "/* eslint-env node */" },
    { label: "global", comment: "/* global window */" },
    { label: "globals", comment: "/* globals window, document */" },
    { label: "exported", comment: "/* exported helper */" },
  ])("catches $label", ({ comment }) => {
    expect(rulesOf(`${comment}\nexport const a = 1;\n`)).toEqual(["inline-config"]);
  });

  it("catches one after code, inside a call, in JSX and at the end of the file", () => {
    const comment = '/* eslint max-lines: "off" */';
    for (const code of [
      `export const a = 1; ${comment}\n`,
      `export const a = Math.max(${comment});\n`,
      `export const a = <div>{${comment}}</div>;\n`,
      `export const a = 1;\n${comment}`,
    ]) {
      expect(rulesOf(code, "apps/web/src/fixture.tsx"), code).toEqual(["inline-config"]);
    }
  });

  it("reports the line of the comment", () => {
    const [violation] = checkSource("a.ts", `export const a = 1;\n\n/* eslint max-lines: off */\n`);
    expect(violation?.detail).toBe("line 3: /* eslint max-lines: off */");
  });

  it("reads JavaScript files too", () => {
    expect(rulesOf('/* eslint max-lines: "off" */\nexport const a = 1;\n', "eslint/fixture.js")).toEqual([
      "inline-config",
    ]);
  });

  it("does not take text that only looks like a comment for one", () => {
    for (const code of [
      'export const code = "/* eslint max-lines: \\"off\\" */";\n',
      "export const code = `/* eslint max-lines: off */`;\n",
      "export const code = `${1}/* eslint max-lines: off */`;\n",
      "export const pattern = /\\/* eslint max-lines: off */u;\n",
      "export const view = <p>/* eslint max-lines: off */</p>;\n",
      "// /* eslint max-lines: off */\nexport const a = 1;\n",
      "// eslint max-lines: off\nexport const a = 1;\n",
    ]) {
      expect(rulesOf(code, "apps/web/src/fixture.tsx"), code).toEqual([]);
    }
  });

  it("leaves disable directives to the eslint-comments rules", () => {
    const code =
      "// eslint-disable-next-line no-console -- a reason\nconsole.log(1);\n/* eslint-disable-next-line no-console -- r */\n";
    expect(rulesOf(code)).toEqual([]);
  });
});
