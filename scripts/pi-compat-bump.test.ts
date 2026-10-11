import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bumpCatalog, catalogEntryCount } from "./pi-compat-bump.ts";

describe("bumpCatalog", () => {
  it("sets every @earendil-works catalog entry to latest and leaves the rest alone", () => {
    const input = [
      "packages:",
      "  - apps/*",
      "catalog:",
      '  "@earendil-works/pi-coding-agent": 1.1.0',
      '  "@earendil-works/pi-ai": 1.1.0',
      '  "zod": 4.1.0',
      "minimumReleaseAge: 4320",
    ].join("\n");
    expect(bumpCatalog(input)).toBe(
      [
        "packages:",
        "  - apps/*",
        "catalog:",
        '  "@earendil-works/pi-coding-agent": latest',
        '  "@earendil-works/pi-ai": latest',
        '  "zod": 4.1.0',
        "minimumReleaseAge: 4320",
      ].join("\n"),
    );
  });

  it("bumps an entry that carries a trailing comment and keeps the comment", () => {
    const input = [
      "catalog:",
      '  "@earendil-works/pi-ai": 1.1.0 # held back until the 1.2 review',
      "other: 1",
    ].join("\n");
    expect(bumpCatalog(input)).toBe(
      ["catalog:", '  "@earendil-works/pi-ai": latest # held back until the 1.2 review', "other: 1"].join(
        "\n",
      ),
    );
  });

  it("returns the input untouched when no @earendil-works entry matches", () => {
    const input = [
      "catalog:",
      '  "zod": 4.1.0',
      '  # "@earendil-works/pi-ai": 1.1.0',
      "minimumReleaseAge: 4320",
    ].join("\n");
    expect(bumpCatalog(input)).toBe(input);
  });
});

describe("catalogEntryCount", () => {
  it("counts the @earendil-works entries whatever their version, comment or current value", () => {
    const input = [
      "catalog:",
      '  "@earendil-works/pi-ai": 1.1.0',
      '  "@earendil-works/pi-coding-agent": latest',
      '  "@earendil-works/pi-tui": 1.1.0 # held back',
      '  "zod": 4.1.0',
      '  # "@earendil-works/pi-old": 1.0.0',
    ].join("\n");
    expect(catalogEntryCount(input)).toBe(3);
  });

  it("is zero when the file has no such entry, which means the script or the file shape is broken", () => {
    expect(catalogEntryCount('catalog:\n  "zod": 4.1.0\n')).toBe(0);
  });

  it("leaves an entry already at latest as it is, comment included", () => {
    const input = ['  "@earendil-works/pi-ai": latest', '  "@earendil-works/pi-tui": latest # fresh'].join(
      "\n",
    );
    expect(bumpCatalog(input)).toBe(input);
  });
});

describe("pi-compat-bump command line", () => {
  const script = resolve(import.meta.dirname, "pi-compat-bump.ts");
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pap-bump-"));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));
  const run = (yaml: string) => {
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), yaml);
    return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script], {
      cwd,
      encoding: "utf8",
    });
  };

  it("writes the bumped catalog and exits 0 when a line changed", () => {
    const result = run('catalog:\n  "@earendil-works/pi-ai": 1.1.0\n');
    expect(result.status).toBe(0);
    expect(readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8")).toBe(
      'catalog:\n  "@earendil-works/pi-ai": latest\n',
    );
  });

  it("exits 1 with a message when it finds no catalog line, so a broken script cannot pass vacuously", () => {
    const yaml = 'catalog:\n  "zod": 4.1.0\n';
    const result = run(yaml);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no @earendil-works catalog line found");
    expect(readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8")).toBe(yaml);
  });

  it("exits 0 and leaves the file alone when every entry is already at latest, so a quiet night stays green", () => {
    const yaml = 'catalog:\n  "@earendil-works/pi-ai": latest # pinned by the nightly run\n  "zod": 4.1.0\n';
    const result = run(yaml);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("already at latest");
    expect(result.stderr).toBe("");
    expect(readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8")).toBe(yaml);
  });
});
