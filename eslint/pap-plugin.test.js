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

  it("rejects a disable of the comment guards themselves (R64)", async () => {
    const bypass = (guard) =>
      `// eslint-disable-next-line @eslint-community/eslint-comments/${guard} -- hide the next line\n/* eslint-disable max-lines -- legacy parser */\nexport const a = 1;\n`;
    for (const guard of ["no-restricted-disable", "no-use"]) {
      const [result] = await eslint.lintText(bypass(guard), {
        filePath: "packages/contracts/src/self-off.ts",
      });
      const reported = result?.messages.filter(
        (m) => m.ruleId === "@eslint-community/eslint-comments/no-restricted-disable" && m.line === 1,
      );
      expect(reported?.length, guard).toBeGreaterThan(0);
    }
  });

  // A block directive and a -line directive cover the report about themselves, so only -next-line may stay (R64b).
  describe("block and -line directives cannot switch a guard off (R64b)", () => {
    const messagesOf = async (code, filePath) => {
      const [result] = await eslint.lintText(code, { filePath });
      return result?.messages.map((m) => m.ruleId) ?? [];
    };

    it("reports the block form that disables the restricted-disable rule and max-lines in one comment", async () => {
      const code = `/* eslint-disable @eslint-community/eslint-comments/no-restricted-disable, max-lines -- r */\n${linesOf(401)}\n/* eslint-enable -- r */\n`;
      expect(await messagesOf(code, "packages/contracts/src/block-off.ts")).toContain(
        "@eslint-community/eslint-comments/no-use",
      );
    });

    it("reports the -line form that does the same on the line max-lines points at", async () => {
      const long = `${linesOf(400)}\nexport const last = 1; // eslint-disable-line @eslint-community/eslint-comments/no-restricted-disable, max-lines -- r\n`;
      expect(await messagesOf(long, "packages/contracts/src/line-off.ts")).toContain(
        "@eslint-community/eslint-comments/no-use",
      );
    });

    it("reports a directive that lists the guards themselves as well", async () => {
      const guards =
        "@eslint-community/eslint-comments/no-use, @eslint-community/eslint-comments/no-restricted-disable";
      const block = `/* eslint-disable ${guards}, max-lines -- r */\n${linesOf(401)}\n/* eslint-enable -- r */\n`;
      const line = `${linesOf(400)}\nexport const last = 1; // eslint-disable-line ${guards}, max-lines -- r\n`;
      for (const code of [block, line]) {
        expect(await messagesOf(code, "packages/contracts/src/guards-off.ts")).toContain(
          "@eslint-community/eslint-comments/no-use",
        );
      }
    });

    it("reports a block disable of an ordinary rule too", async () => {
      const code =
        "/* eslint-disable @typescript-eslint/no-explicit-any -- r */\nexport const a: any = 1;\n/* eslint-enable -- r */\n";
      expect(await messagesOf(code, "packages/contracts/src/block-ordinary.ts")).toContain(
        "@eslint-community/eslint-comments/no-use",
      );
    });
  });

  it("lets a reasoned disable of an ordinary rule through", async () => {
    const code =
      "// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a test double\nexport const a: any = 1;\n";
    const [result] = await eslint.lintText(code, { filePath: "packages/contracts/src/ordinary.ts" });
    expect(result?.messages).toEqual([]);
  });

  it("flags raw colours in UI source but not in its tests", async () => {
    const code = 'export const c = "#A78BFA";\n';
    const [source] = await eslint.lintText(code, { filePath: "packages/ui/src/Button.tsx" });
    const [test] = await eslint.lintText(code, { filePath: "packages/ui/src/Button.test.tsx" });
    expect(source?.messages.map((m) => m.ruleId)).toContain("pap/no-raw-colors");
    expect(test?.messages.map((m) => m.ruleId)).not.toContain("pap/no-raw-colors");
  });
});

describe("React Compiler rules for the web app and the UI package (R122)", () => {
  const eslint = new ESLint({ cwd: repoRoot });
  const refDuringRender =
    'import { useRef } from "react";\nexport function C() {\n  const ref = useRef(0);\n  return <p>{ref.current}</p>;\n}\n';
  const setStateInRender =
    'import { useState } from "react";\nexport function C() {\n  const [n, setN] = useState(0);\n  setN(1);\n  return <p>{n}</p>;\n}\n';
  const impureRender = "export function C() {\n  return <p>{Math.random()}</p>;\n}\n";
  const assignedProp =
    "export function C(props: { n: number }) {\n  props.n = 2;\n  return <p>{props.n}</p>;\n}\n";

  it.each([
    ["a ref read during render", refDuringRender, "react-hooks/refs"],
    ["a state setter called during render", setStateInRender, "react-hooks/set-state-in-render"],
    ["an impure call during render", impureRender, "react-hooks/purity"],
    ["an assigned prop", assignedProp, "react-hooks/immutability"],
  ])("rejects %s, in the web app and in the UI package", async (_name, code, rule) => {
    for (const filePath of ["apps/web/src/features/x/C.tsx", "packages/ui/src/primitives/C.tsx"]) {
      const [result] = await eslint.lintText(code, { filePath });
      const hit = result?.messages.find((m) => m.ruleId === rule);
      expect(hit?.severity, `${rule} in ${filePath}`).toBe(2);
    }
  });

  it("accepts the same component written the compiler's way", async () => {
    const code =
      'import { useRef, useState } from "react";\nexport function C() {\n  const ref = useRef(0);\n  const [n, setN] = useState(0);\n  return (\n    <button type="button" onClick={() => setN(n + ref.current)}>\n      {n}\n    </button>\n  );\n}\n';
    const [result] = await eslint.lintText(code, { filePath: "apps/web/src/features/x/Ok.tsx" });
    expect(result?.messages).toEqual([]);
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

  // The fake worker lives in the kernel, so the modules' tests (Task 22) can build on it without the build shipping it.
  describe("the kernel's fake worker", () => {
    const fake = "../../kernel/testing/fake-worker.ts";
    const boundariesAndImports = async (code, filePath) =>
      (await ruleIdsOf(code, filePath)).filter(
        (id) => id?.startsWith("boundaries/") || id === "no-restricted-imports",
      );

    it("can be imported by a module's test, and by a test of the kernel", async () => {
      const code = `import { createFakeWorker } from "${fake}";\nexport const worker = createFakeWorker();\n`;
      expect(await boundariesAndImports(code, "apps/daemon/src/modules/auth/session.test.ts")).toEqual([]);
      const fromKernel = code.replace(fake, "../testing/fake-worker.ts");
      expect(
        await boundariesAndImports(fromKernel, "apps/daemon/src/kernel/supervisor/other.test.ts"),
      ).toEqual([]);
    });

    it("cannot be imported by production code of a module or of the kernel", async () => {
      const code = `import { createFakeWorker } from "${fake}";\nexport const worker = createFakeWorker();\n`;
      expect(await boundariesAndImports(code, "apps/daemon/src/modules/auth/session.ts")).toEqual([
        "no-restricted-imports",
      ]);
      const fromKernel = code.replace(fake, "../testing/fake-worker.ts");
      expect(await boundariesAndImports(fromKernel, "apps/daemon/src/kernel/supervisor/other.ts")).toEqual([
        "no-restricted-imports",
      ]);
    });
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

tester.run("no-native-title", pap.rules["no-native-title"], {
  valid: [
    { code: 'const x = <button aria-label="Close">x</button>;' },
    { code: 'const x = <iframe title="preview" />;' },
    { code: 'const x = <Tooltip title="ok"><b /></Tooltip>;' },
  ],
  invalid: [
    { code: 'const x = <button title="Close">x</button>;', errors: [{ messageId: "title" }] },
    { code: "const x = <span title={label}>x</span>;", errors: [{ messageId: "title" }] },
  ],
});
