import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bumpCatalog, catalogEntryCount, main, PACKAGES } from "./pi-compat-bump.ts";

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures", "pi-registry-time.json"), "utf8"),
) as Record<string, Record<string, string>>;

describe("bumpCatalog", () => {
  it("sets every @earendil-works catalog entry to the exact version and leaves the rest alone", () => {
    const input = [
      "packages:",
      "  - apps/*",
      "catalog:",
      '  "@earendil-works/pi-coding-agent": 1.1.0',
      '  "@earendil-works/pi-ai": 1.1.0',
      '  "zod": 4.1.0',
      "minimumReleaseAge: 4320",
    ].join("\n");
    expect(bumpCatalog(input, "1.2.0")).toBe(
      [
        "packages:",
        "  - apps/*",
        "catalog:",
        '  "@earendil-works/pi-coding-agent": 1.2.0',
        '  "@earendil-works/pi-ai": 1.2.0',
        '  "zod": 4.1.0',
        "minimumReleaseAge: 4320",
      ].join("\n"),
    );
  });

  it("writes the version on all three lines, never `latest`", () => {
    const input = PACKAGES.map((name) => `  "${name}": 1.1.0`).join("\n");
    const out = bumpCatalog(input, "1.2.0");
    expect(out.split("\n")).toEqual(PACKAGES.map((name) => `  "${name}": 1.2.0`));
    expect(out).not.toContain("latest");
  });

  it("bumps an entry that carries a trailing comment and keeps the comment", () => {
    const input = [
      "catalog:",
      '  "@earendil-works/pi-ai": 1.1.0 # held back until the 1.2 review',
      "other: 1",
    ].join("\n");
    expect(bumpCatalog(input, "1.2.0")).toBe(
      ["catalog:", '  "@earendil-works/pi-ai": 1.2.0 # held back until the 1.2 review', "other: 1"].join(
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
    expect(bumpCatalog(input, "1.2.0")).toBe(input);
  });

  it("returns the input untouched when the entries already hold that version, comment included", () => {
    const input = ['  "@earendil-works/pi-ai": 1.2.0', '  "@earendil-works/pi-tui": 1.2.0 # fresh'].join(
      "\n",
    );
    expect(bumpCatalog(input, "1.2.0")).toBe(input);
  });

  it("rejects a version that is not X.Y.Z, so a stray value cannot reach the catalog", () => {
    expect(() => bumpCatalog('  "@earendil-works/pi-ai": 1.1.0', "latest")).toThrow(/version/);
    expect(() => bumpCatalog('  "@earendil-works/pi-ai": 1.1.0', "1.4.0-beta.1")).toThrow(/version/);
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
});

describe("main", () => {
  const yaml = [
    "catalog:",
    ...PACKAGES.map((name) => `  "${name}": 1.1.0`),
    "minimumReleaseAge: 4320",
    "",
  ].join("\n");
  let dir: string;
  let path: string;
  let out: string[];
  let err: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pap-bump-"));
    path = join(dir, "pnpm-workspace.yaml");
    writeFileSync(path, yaml);
    out = [];
    err = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const run = (nowIso: string, times = fixture) =>
    main({
      path,
      nowMs: Date.parse(nowIso),
      fetchTimes: () => Promise.resolve(times),
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    });

  it("writes the picked exact version and says what it tests", async () => {
    expect(await run("2026-10-18T04:30:00Z")).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(yaml.replaceAll("1.1.0", "1.2.0"));
    expect(out).toEqual(["pi-compat: testing 1.2.0 (published 2026-10-12T23:03:25.459Z, 5 days old)"]);
  });

  it("exits 1 with a sentence and leaves the file alone when no release is old enough", async () => {
    expect(await run("2026-09-01T00:00:00Z")).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(yaml);
    expect(err.join("\n")).toMatch(/no release .* at least 4320 minutes old/);
  });

  it("exits 1 when the catalog has no @earendil-works line, before any fetch", async () => {
    writeFileSync(path, "catalog:\n  zod: 4.1.0\nminimumReleaseAge: 4320\n");
    let fetched = false;
    const code = await main({
      path,
      nowMs: Date.now(),
      fetchTimes: () => {
        fetched = true;
        return Promise.resolve(fixture);
      },
      log: () => undefined,
      error: (line) => err.push(line),
    });
    expect(code).toBe(1);
    expect(fetched).toBe(false);
    expect(err.join("\n")).toContain("no @earendil-works catalog line found");
  });

  it("exits 1 with a sentence when the registry cannot be reached", async () => {
    const code = await main({
      path,
      nowMs: Date.now(),
      fetchTimes: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")),
      log: () => undefined,
      error: (line) => err.push(line),
    });
    expect(code).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(yaml);
    expect(err.join("\n")).toContain("ENOTFOUND");
  });
});

describe("pi-compat-bump command line", () => {
  const script = resolve(import.meta.dirname, "pi-compat-bump.ts");
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pap-bump-cli-"));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  // Only the shape check runs here: it exits before any fetch, so the test never touches the network.
  it("exits 1 with a message when it finds no catalog line, so a broken script cannot pass vacuously", () => {
    const yaml = 'catalog:\n  "zod": 4.1.0\nminimumReleaseAge: 4320\n';
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), yaml);
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script], {
      cwd,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no @earendil-works catalog line found");
    expect(readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8")).toBe(yaml);
  });
});
