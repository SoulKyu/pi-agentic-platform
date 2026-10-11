import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkLiterals, literalsIn } from "./literal-coverage.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));

describe("literal UI strings (DESIGN.md §11)", () => {
  it("finds JSX text and labelling attributes, not code or symbols", () => {
    const found = literalsIn(
      "x.tsx",
      [
        "const a = <p>Save changes</p>;",
        'const b = <button aria-label="Close" />;',
        'const c = <input placeholder="Search" />;',
        "const d = <span>{count} · ⌘</span>;",
        'const e = <div data-slot="button" className="flex" />;',
        'const f = <p>{t("key")}</p>;',
      ].join("\n"),
    );
    expect(found.map((l) => l.text)).toEqual(["Save changes", "Close", "Search"]);
  });

  it("packages/ui and apps/web have none outside the allowlist", () => {
    expect(checkLiterals(REPO).map((l) => `${l.file}:${l.line} ${l.text}`)).toEqual([]);
  });
});

const SAMPLE = "export const A = () => <p>Hello there</p>;\n";

/** A throwaway git repo holding `files` (untracked is enough: the gate lists new files too) and an allowlist. */
function inFixture<T>(files: readonly string[], allowlist: unknown[], run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "pap-literals-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts/literal-allowlist.json"), JSON.stringify(allowlist));
    for (const file of files) {
      mkdirSync(join(root, dirname(file)), { recursive: true });
      writeFileSync(join(root, file), SAMPLE);
    }
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const reported = (files: readonly string[], allowlist: unknown[] = []) =>
  inFixture(files, allowlist, (root) => checkLiterals(root).map((l) => l.file));

describe("literal gate scope and allowlist", () => {
  it("reports a literal outside the skipped paths", () => {
    expect(reported(["apps/web/src/routes/x.tsx", "packages/ui/src/y.tsx"])).toEqual([
      "apps/web/src/routes/x.tsx",
      "packages/ui/src/y.tsx",
    ]);
  });

  it("skips M2's sessions folder until P7", () => {
    expect(reported(["apps/web/src/features/sessions/x.tsx"])).toEqual([]);
  });

  it("skips tests, testing helpers and the gallery, and non-tsx or other trees", () => {
    expect(
      reported([
        "apps/web/src/routes/x.test.tsx",
        "apps/web/src/testing/x.tsx",
        "apps/web/src/gallery/x.tsx",
        "apps/web/src/routes/x.ts",
        "apps/daemon/src/x.tsx",
      ]),
    ).toEqual([]);
  });

  it("drops a literal named in the allowlist, for that file and text only", () => {
    const entry = { file: "apps/web/src/routes/x.tsx", text: "Hello there", reason: "fixture" };
    expect(reported(["apps/web/src/routes/x.tsx"], [entry])).toEqual([]);
    expect(reported(["apps/web/src/routes/x.tsx", "apps/web/src/routes/z.tsx"], [entry])).toEqual([
      "apps/web/src/routes/z.tsx",
    ]);
    expect(reported(["apps/web/src/routes/x.tsx"], [{ ...entry, text: "Other" }])).toEqual([
      "apps/web/src/routes/x.tsx",
    ]);
  });
});
