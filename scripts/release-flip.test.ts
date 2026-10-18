import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkRelease } from "./release-check.ts";
import { applyFlip, flipTree, OWNER_ONLY_ITEMS, PROSE_CHECKLIST, type FlipFiles } from "./release-flip.ts";

const REPO = resolve(import.meta.dirname, "..");
const RELEASE_YML = ".github/workflows/release.yml";
const UPDATE_CHECK = "apps/daemon/src/update-check.ts";
const UPDATE_CHECK_TEST = "apps/daemon/src/update-check.test.ts";
const PI_COMPAT = ".github/workflows/pi-compat.yml";
const CHECKED = [
  "package.json",
  "apps/daemon/package.json",
  ".release-please-manifest.json",
  "release-please-config.json",
  RELEASE_YML,
  PI_COMPAT,
  UPDATE_CHECK,
  UPDATE_CHECK_TEST,
  "LICENSE",
  "LICENSES/Apache-2.0.txt",
  "THIRD_PARTY_NOTICES.md",
];

let tree: string;
const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");
const real = (): FlipFiles => ({
  releaseYml: read(REPO, RELEASE_YML),
  piCompatYml: read(REPO, PI_COMPAT),
  updateCheckTs: read(REPO, UPDATE_CHECK),
  updateCheckTestTs: read(REPO, UPDATE_CHECK_TEST),
});

beforeEach(() => {
  tree = mkdtempSync(join(tmpdir(), "pap-release-flip-"));
  for (const file of CHECKED) {
    mkdirSync(dirname(join(tree, file)), { recursive: true });
    cpSync(join(REPO, file), join(tree, file));
  }
});
afterEach(() => rmSync(tree, { recursive: true, force: true }));

describe("applyFlip on the real files", () => {
  it("changes the three files and leaves the rest of each untouched", () => {
    const before = real();
    const after = applyFlip(before);
    expect(after.releaseYml).toContain("on:\n  push:\n    branches: [main]\n  workflow_dispatch:");
    expect(after.releaseYml).toContain(
      "if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || inputs.channel == 'stable')",
    );
    expect(after.releaseYml).toContain("if: github.ref == 'refs/heads/main' && inputs.channel == 'next'");
    expect(before.piCompatYml).not.toContain("schedule:");
    expect(after.piCompatYml).toContain('on:\n  schedule:\n    - cron: "17 3 * * *"\n  workflow_dispatch:');
    expect(after.piCompatYml.replace(/ {2}schedule:\n.*\n/, "")).toBe(before.piCompatYml);
    expect(after.updateCheckTs).toContain("export const UPDATE_CHECK_DEFAULT = true;");
    expect(after.updateCheckTs).not.toContain("UPDATE_CHECK_DEFAULT = false");
    expect(after.updateCheckTestTs).toContain("expect(UPDATE_CHECK_DEFAULT).toBe(true);");
    expect(after.updateCheckTestTs).not.toContain("expect(UPDATE_CHECK_DEFAULT).toBe(false)");
    expect(after.updateCheckTestTs.split("\n").length).toBe(before.updateCheckTestTs.split("\n").length);
  });

  it("yields a tree on which release:check returns no problem", () => {
    expect(checkRelease(tree)).toEqual([]);
    flipTree(tree);
    expect(checkRelease(tree)).toEqual([]);
    expect(read(tree, RELEASE_YML)).toContain("push:");
    expect(read(tree, PI_COMPAT)).toContain("schedule:");
  });

  it("refuses to run twice", () => {
    expect(() => applyFlip(applyFlip(real()))).toThrow(/already flipped/);
    flipTree(tree);
    expect(() => flipTree(tree)).toThrow(/already flipped/);
  });

  it("refuses a file it does not recognise instead of writing a partial flip", () => {
    const files = real();
    expect(() => applyFlip({ ...files, updateCheckTs: "export const X = 1;\n" })).toThrow(
      /UPDATE_CHECK_DEFAULT/,
    );
    expect(() =>
      applyFlip({
        ...files,
        releaseYml: files.releaseYml.replace("on:\n  workflow_dispatch:", "on:\n  dispatch:"),
      }),
    ).toThrow(/release\.yml/);
    expect(() =>
      applyFlip({ ...files, piCompatYml: files.piCompatYml.replace("workflow_dispatch", "dispatch") }),
    ).toThrow(/pi-compat\.yml/);
    expect(() => applyFlip({ ...files, updateCheckTestTs: "" })).toThrow(/update-check\.test\.ts/);
  });

  it("writes nothing when one of the files is not recognised", () => {
    const original = read(tree, RELEASE_YML);
    const compat = read(tree, PI_COMPAT);
    cpSync(join(REPO, "package.json"), join(tree, UPDATE_CHECK));
    expect(() => flipTree(tree)).toThrow();
    expect(read(tree, RELEASE_YML)).toBe(original);
    expect(read(tree, PI_COMPAT)).toBe(compat);
  });
});

describe("the owner-only items", () => {
  it("names the FEED_REPO casing check and the repository setting", () => {
    expect(OWNER_ONLY_ITEMS.join("\n")).toContain("FEED_REPO");
    expect(OWNER_ONLY_ITEMS.join("\n")).toContain("create and approve pull requests");
    expect(OWNER_ONLY_ITEMS.join("\n")).toContain("gh workflow enable pi-compat.yml");
    expect(OWNER_ONLY_ITEMS).toHaveLength(3);
  });
});

describe("the prose checklist", () => {
  const runbook = readFileSync(join(REPO, "docs/agents/release.md"), "utf8");

  it("names every note by file and section, never by line number", () => {
    for (const item of PROSE_CHECKLIST) expect(item, item).not.toMatch(/\.(?:ts|md):\d+/);
    const text = PROSE_CHECKLIST.join("\n");
    for (const where of ["update-check.ts", "AGENTS.md", "update.md", "doctor.md", "install.md"])
      expect(text).toContain(where);
  });

  it("matches the places release.md step 4.2 lists", () => {
    for (const item of PROSE_CHECKLIST) {
      const file = item.split(",")[0] ?? "";
      expect(runbook, file).toContain(file.split("/").slice(-1)[0] ?? "");
      for (const [, section] of item.matchAll(/"([^"]+)"/g))
        expect(runbook, section).toContain(`"${section}"`);
    }
    expect(PROSE_CHECKLIST.join("\n")).toContain('"Daily check"');
  });
});
