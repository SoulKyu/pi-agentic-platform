import { describe, expect, it } from "vitest";
import { isCleanRelative, PROJECT_CONFIG_LIMITS, readProjectConfig, scriptHash } from "./project-config.ts";

const read = (text: string) => readProjectConfig(Buffer.from(text, "utf8"));
const refused = (text: string, error = "invalid_yaml") =>
  expect(read(text), text.slice(0, 60)).toEqual({ ok: false, error });

describe("readProjectConfig", () => {
  it("reads a full file, a block scalar script and ignores unknown keys", () => {
    const result = read(
      [
        "setup: |",
        "  pnpm install",
        "  pnpm build",
        "archive: ./scripts/archive.sh",
        "test: pnpm test",
        "copy: [.env, .env.local]",
        "link:",
        "  - node_modules",
        "branchPrefix: pi/",
        "waitForSetup: false",
        "forge: github",
        "somethingElse: [1, 2]",
      ].join("\n"),
    );
    expect(result).toEqual({
      ok: true,
      warnings: [],
      config: {
        setup: "pnpm install\npnpm build\n",
        archive: "./scripts/archive.sh",
        test: "pnpm test",
        copy: [".env", ".env.local"],
        link: ["node_modules"],
        branchPrefix: "pi/",
        waitForSetup: false,
        forge: "github",
      },
    });
  });

  it("refuses the whole file for YAML errors, duplicates, aliases and odd keys", () => {
    refused("setup: a\nsetup: b\n");
    refused("setup: [\n");
    refused("a: &x [1, 2]\nsetup: *x\n");
    refused("a: &x one\nsetup: *x\n");
    refused("? [a]\n: b\n");
    refused("1: a\n");
    refused("setup: !!python/object/apply:os.system [ls]\n");
    refused("a: &x {b: 1}\nsetup:\n  <<: *x\n");
  });

  it("refuses the nine-level alias bomb without expanding it", () => {
    const levels = ['a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]'];
    for (let level = 1; level < 9; level += 1) {
      const previous = String.fromCharCode(96 + level);
      levels.push(
        `${String.fromCharCode(97 + level)}: &${String.fromCharCode(97 + level)} [${Array(9).fill(`*${previous}`).join(",")}]`,
      );
    }
    levels.push("setup: *i");
    refused(`${levels.join("\n")}\n`);
  });

  it("survives a nesting bomb inside the size cap", () => {
    const flow = `setup: ${"[".repeat(30_000)}${"]".repeat(30_000)}`;
    expect(Buffer.byteLength(flow)).toBeLessThanOrEqual(PROJECT_CONFIG_LIMITS.fileBytes);
    const result = read(flow);
    expect(result.ok === false || result.warnings.includes("setup")).toBe(true);
  });

  it("allows 256 top-level keys and refuses 257", () => {
    const keys = (count: number) => Array.from({ length: count }, (_, at) => `k${at}: 1`).join("\n");
    expect(read(keys(256)).ok).toBe(true);
    refused(keys(257));
  });

  it("answers not_a_map for a list and an empty config for an empty or comment-only file", () => {
    refused("- a\n- b\n", "not_a_map");
    expect(read("")).toEqual({ ok: true, config: {}, warnings: [] });
    expect(read("# nothing here\n")).toEqual({ ok: true, config: {}, warnings: [] });
  });

  it("refuses a file over 64 KiB", () => {
    expect(readProjectConfig(Buffer.alloc(PROJECT_CONFIG_LIMITS.fileBytes + 1, 0x20))).toEqual({
      ok: false,
      error: "too_large",
    });
    expect(readProjectConfig(Buffer.alloc(PROJECT_CONFIG_LIMITS.fileBytes, 0x20)).ok).toBe(true);
  });

  it("drops one bad field and names it, in field order", () => {
    const result = read(
      [
        "forge: bitbucket",
        "waitForSetup: 'yes'",
        "branchPrefix: '-x/'",
        "copy: [../x, /etc/passwd, a/../b, .git/hooks, ok/path]",
        "setup: 12",
        "link: [ok]",
      ].join("\n"),
    );
    expect(result).toEqual({
      ok: true,
      config: { link: ["ok"] },
      warnings: ["setup", "copy", "branchPrefix", "waitForSetup", "forge"],
    });
  });

  it("warns, never refuses, for a nested duplicate", () => {
    expect(read("setup: {x: 1, x: 2}\ntest: pnpm test\n")).toEqual({
      ok: true,
      config: { test: "pnpm test" },
      warnings: ["setup"],
    });
  });

  it("reads yes as a string (core schema), a NUL as a bad script, and keeps __proto__ out", () => {
    expect(read("waitForSetup: yes\n")).toEqual({ ok: true, config: {}, warnings: ["waitForSetup"] });
    expect(read('setup: "a\\0b"\n')).toEqual({ ok: true, config: {}, warnings: ["setup"] });
    const proto = read("__proto__: {setup: x}\n");
    expect(proto).toMatchObject({ ok: true, config: {} });
    expect(Object.hasOwn((proto as { config: object }).config, "setup")).toBe(false);
  });

  it("refuses a script over 16 KiB and an empty one", () => {
    expect(read(`setup: ${"a".repeat(PROJECT_CONFIG_LIMITS.scriptChars + 1)}\n`)).toMatchObject({
      warnings: ["setup"],
    });
    expect(read('setup: ""\n')).toMatchObject({ warnings: ["setup"] });
  });

  it("caps the entries of copy and link at 100", () => {
    const list = (count: number) => `[${Array.from({ length: count }, (_, at) => `e${at}`).join(",")}]`;
    expect(read(`copy: ${list(100)}\n`)).toMatchObject({ warnings: [] });
    expect(read(`copy: ${list(101)}\n`)).toMatchObject({ warnings: ["copy"] });
  });
});

describe("isCleanRelative", () => {
  it("accepts plain relative paths", () => {
    for (const path of [".env", "a/b/c", "packages/x/node_modules"])
      expect(isCleanRelative(path), path).toBe(true);
  });
  it("refuses escapes, odd separators and .git in any case", () => {
    for (const path of [
      "..",
      "a/..",
      "./a",
      "/a",
      "a//b",
      "a\\b",
      ".git",
      "x/.GIT/y",
      "",
      "a\0b",
      "a/",
      "x".repeat(1025),
    ])
      expect(isCleanRelative(path), JSON.stringify(path)).toBe(false);
  });
});

describe("branchPrefix", () => {
  const prefixOf = (value: string) => read(`branchPrefix: ${JSON.stringify(value)}\n`);
  it("accepts the documented shapes", () => {
    for (const prefix of ["pi/", "", "feat-", "a/b/"])
      expect(prefixOf(prefix), prefix).toMatchObject({ config: { branchPrefix: prefix } });
  });
  it("refuses the others", () => {
    for (const prefix of ["-x/", "../", "a b/", "a//"])
      expect(prefixOf(prefix), prefix).toMatchObject({ warnings: ["branchPrefix"] });
  });
});

describe("scriptHash", () => {
  it("is the SHA-256 of the UTF-8 text", () => {
    expect(scriptHash("é")).not.toBe(scriptHash("e"));
    expect(scriptHash("a")).toBe("ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
  });
});
