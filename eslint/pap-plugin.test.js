import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ESLint, RuleTester } from "eslint";
import { describe, expect, it } from "vitest";
import tseslint from "typescript-eslint";
import pap from "./pap-plugin.js";

const repoRoot = resolve(import.meta.dirname, "..");

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
});

tester.run("no-raw-colors", pap.rules["no-raw-colors"], {
  valid: [{ code: 'const c = "text-agent bg-panel";' }, { code: 'const href = "#setup";' }],
  invalid: [
    { code: 'const c = "#A78BFA";', errors: [{ messageId: "raw" }] },
    { code: "const s = { color: `rgb(1, 2, 3)` };", errors: [{ messageId: "raw" }] },
  ],
});

tester.run("no-arbitrary-values", pap.rules["no-arbitrary-values"], {
  valid: [{ code: 'const c = "w-11 h-6.5 rounded-sm";' }],
  invalid: [
    { code: 'const c = "w-[13px]";', errors: [{ messageId: "arbitrary" }] },
    { code: 'const c = "hover:bg-[#fff] p-2";', errors: [{ messageId: "arbitrary" }] },
  ],
});

tester.run("no-restyle", pap.rules["no-restyle"], {
  valid: [{ code: 'import { Button } from "@pap/ui"; const x = <Button variant="primary">ok</Button>;' }],
  invalid: [
    {
      code: 'import { Button } from "@pap/ui"; const x = <Button className="mt-2">ok</Button>;',
      errors: [{ messageId: "restyle" }],
    },
  ],
});

tester.run("zustand-selector", pap.rules["zustand-selector"], {
  valid: [{ code: "const v = useSessionStore((s) => s.views);" }],
  invalid: [{ code: "const all = useSessionStore();", errors: [{ messageId: "selector" }] }],
});

const linesOf = (count) => Array.from({ length: count }, (_, i) => `export const v${i} = ${i};`).join("\n");

describe("repository gates", () => {
  const eslint = new ESLint({ cwd: repoRoot });

  it("rejects a file over 400 lines", async () => {
    const [result] = await eslint.lintText(linesOf(401), { filePath: "packages/contracts/src/too-long.ts" });
    expect(result?.messages.map((m) => m.ruleId)).toContain("max-lines");
  });

  it("accepts a file of exactly 400 lines", async () => {
    const [result] = await eslint.lintText(linesOf(400), { filePath: "packages/contracts/src/at-limit.ts" });
    expect(result?.messages.map((m) => m.ruleId)).not.toContain("max-lines");
  });

  it("rejects an eslint-disable without a reason", async () => {
    const code = "// eslint-disable-next-line no-console\nconsole.log(1);\n";
    const [result] = await eslint.lintText(code, { filePath: "packages/contracts/src/disable.ts" });
    expect(result?.messages.map((m) => m.ruleId)).toContain(
      "@eslint-community/eslint-comments/require-description",
    );
  });

  it("rejects a reasoned eslint-disable of max-lines", async () => {
    const code = "/* eslint-disable max-lines -- legacy parser */\nexport const a = 1;\n";
    const [result] = await eslint.lintText(code, { filePath: "packages/contracts/src/limit-off.ts" });
    expect(result?.messages.map((m) => m.ruleId)).toContain(
      "@eslint-community/eslint-comments/no-restricted-disable",
    );
  });

  it("rejects a reasoned eslint-disable of a boundaries rule", async () => {
    const code = "/* eslint-disable boundaries/element-types -- x */\nexport const a = 1;\n";
    const [result] = await eslint.lintText(code, { filePath: "apps/daemon/src/modules/a/service.ts" });
    expect(result?.messages.map((m) => m.ruleId)).toContain(
      "@eslint-community/eslint-comments/no-restricted-disable",
    );
  });

  it("rejects an inline config comment that turns max-lines off", async () => {
    const code = `/* eslint max-lines: "off" -- legacy parser */\n${linesOf(400)}`;
    const [result] = await eslint.lintText(code, { filePath: "packages/contracts/src/inline-off.ts" });
    expect(result?.messages.map((m) => m.ruleId)).toContain("@eslint-community/eslint-comments/no-use");
  });

  it("flags raw colours in UI source but not in its tests", async () => {
    const code = 'export const c = "#A78BFA";\n';
    const [source] = await eslint.lintText(code, { filePath: "packages/ui/src/Button.tsx" });
    const [test] = await eslint.lintText(code, { filePath: "packages/ui/src/Button.test.tsx" });
    expect(source?.messages.map((m) => m.ruleId)).toContain("pap/no-raw-colors");
    expect(test?.messages.map((m) => m.ruleId)).not.toContain("pap/no-raw-colors");
  });
});

describe("test helpers stay out of production daemon code", () => {
  const eslint = new ESLint({ cwd: repoRoot });
  const ruleIdsOf = async (code, filePath) => {
    const [result] = await eslint.lintText(code, { filePath });
    return result?.messages.map((m) => m.ruleId);
  };

  it.each([
    ["a module file", "apps/daemon/src/modules/auth/service.ts", "./testing/fixture.ts"],
    [
      "a module file reaching a sibling folder",
      "apps/daemon/src/modules/auth/service.ts",
      "../../testing/free-port.ts",
    ],
    ["a kernel file", "apps/daemon/src/kernel/db/open.ts", "../../testing/free-port.ts"],
    ["a root file", "apps/daemon/src/main.ts", "./testing/free-port.ts"],
    ["a root file importing a nested helper", "apps/daemon/src/main.ts", "./testing/fixtures/approval.ts"],
  ])("rejects %s importing a testing/ file", async (_name, filePath, source) => {
    expect(await ruleIdsOf(`import "${source}";\n`, filePath)).toContain("no-restricted-imports");
  });

  it("rejects a type-only and a dynamic import of a testing/ file too", async () => {
    const code =
      'import type { X } from "./testing/fixture.ts";\nexport const load = () => import("./testing/fixture.ts");\n';
    const ruleIds = await ruleIdsOf(code, "apps/daemon/src/modules/auth/service.ts");
    expect(ruleIds).toContain("no-restricted-imports");
    expect(ruleIds).toContain("no-restricted-syntax");
  });

  it("lets tests and the testing/ folders import helpers", async () => {
    const code = 'import "./testing/fixture.ts";\nimport "./sibling.ts";\n';
    expect(await ruleIdsOf(code, "apps/daemon/src/modules/auth/http.test.ts")).not.toContain(
      "no-restricted-imports",
    );
    expect(await ruleIdsOf(code, "apps/daemon/src/modules/auth/testing/other.ts")).not.toContain(
      "no-restricted-imports",
    );
  });

  it("lets production code import ordinary siblings", async () => {
    const code = 'import "./service.ts";\nimport "../b/index.ts";\nimport "./contesting/x.ts";\n';
    expect(await ruleIdsOf(code, "apps/daemon/src/modules/auth/service.ts")).not.toContain(
      "no-restricted-imports",
    );
  });
});

describe("module boundaries", () => {
  const repoConfig = join(repoRoot, "eslint.config.js");
  const fixture = {
    "apps/daemon/src/modules/a/index.ts": "export const fromA = 1;\n",
    "apps/daemon/src/modules/b/index.ts": "export const fromB = 2;\n",
    "apps/daemon/src/modules/b/internal.ts": "export const secret = 3;\n",
    "apps/daemon/src/modules/b/testing/bed.ts": "export const bed = 5;\n",
    "packages/ui/package.json": '{ "name": "@pap/ui", "type": "module", "exports": "./src/index.ts" }\n',
    "packages/ui/src/index.ts": "export const Button = 4;\n",
  };

  async function boundaryRulesFor(importPath, from = "apps/daemon/src/modules/a/service.ts") {
    const root = await mkdtemp(join(tmpdir(), "pap-boundaries-"));
    try {
      for (const [path, content] of Object.entries(fixture)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), content);
      }
      await mkdir(join(root, "node_modules/@pap"), { recursive: true });
      await symlink(join(root, "packages/ui"), join(root, "node_modules/@pap/ui"), "dir");
      const eslint = new ESLint({ cwd: root, overrideConfigFile: repoConfig });
      const filePath = join(root, from);
      const [result] = await eslint.lintText(`import "${importPath}";\n`, { filePath });
      return result.messages.map((m) => m.ruleId).filter((id) => id?.startsWith("boundaries/"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("rejects a module importing another module's non-index file", async () => {
    expect(await boundaryRulesFor("../b/internal.ts")).toContain("boundaries/entry-point");
  });

  it("allows a module importing another module's index file", async () => {
    expect(await boundaryRulesFor("../b/index.ts")).toEqual([]);
    expect(await boundaryRulesFor("../b")).toEqual([]);
  });

  it("lets a module's test helper build on another module's test helper and public index", async () => {
    const helper = "apps/daemon/src/modules/a/testing/bed.ts";
    expect(await boundaryRulesFor("../../b/testing/bed.ts", helper)).toEqual([]);
    expect(await boundaryRulesFor("../../b/index.ts", helper)).toEqual([]);
    expect(await boundaryRulesFor("../../b/internal.ts", helper)).toContain("boundaries/entry-point");
  });

  it("holds the shared daemon testing folder to the same module entry points", async () => {
    const harness = "apps/daemon/src/testing/harness.ts";
    expect(await boundaryRulesFor("../modules/b/index.ts", harness)).toEqual([]);
    expect(await boundaryRulesFor("../modules/b/testing/bed.ts", harness)).toEqual([]);
    expect(await boundaryRulesFor("../modules/b/internal.ts", harness)).toContain("boundaries/entry-point");
    const nested = "apps/daemon/src/testing/fixtures/seed.ts";
    expect(await boundaryRulesFor("../../modules/b/internal.ts", nested)).toContain("boundaries/entry-point");
  });

  it("rejects a daemon module importing @pap/ui across packages", async () => {
    expect(await boundaryRulesFor("@pap/ui")).toContain("boundaries/element-types");
  });
});
