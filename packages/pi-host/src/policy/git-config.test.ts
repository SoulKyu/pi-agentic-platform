import { describe, expect, it } from "vitest";
import {
  type GitConfigEntry,
  includeOf,
  MAX_GIT_CONFIG_ENTRIES,
  parseGitConfig,
  runsProgram,
} from "./git-config.ts";

const READS: ReadonlyArray<readonly [string, string[]]> = [
  ["[core]\n\tpager = less\n", ["core||pager|less"]],
  ["[Core]\n\tPAGER=less", ["core||pager|less"]],
  ['[diff "a b"]\n\ttextconv = x', ["diff|a b|textconv|x"]],
  ["[diff.Foo]\n\tcommand = x", ["diff|foo|command|x"]],
  ["[core] pager = x", ["core||pager|x"]],
  ["[core]pager=x", ["core||pager|x"]],
  ['[core]\n\tpager = "a;b" ; c', ["core||pager|a;b"]],
  ["[core]\n\tpager = a \\\n b", ["core||pager|a  b"]],
  ["[core]\n\tfsmonitor", ["core||fsmonitor|<bare>"]],
  ["\uFEFF[core]\n\tpager=x", ["core||pager|x"]],
  ["[core]\r\n\tpager = x\r\n", ["core||pager|x"]],
  ["# [core]\n; pager = x\n", []],
  ['[s "q\\"u"]\n\tk = v', ['s|q"u|k|v']],
  ["[a]\n\tk = 1 # c\n[b]\n\tk2 = \\t", ["a||k|1", "b||k2|\t"]],
  ["[core]\n\tpager = x\n\t\n[diff]\n\texternal = y", ["core||pager|x", "diff||external|y"]],
];
const REFUSES: readonly string[] = [
  "pager = x",
  "[core\n]",
  '[core "x]',
  '[core "x"\n]',
  "[]",
  '[ "x"]',
  '[core]\n\tpager = "unterminated',
  "[core]\n\tpager = a\\q",
  "[core]\n\tpager ; x",
  "[core]\n\t1pager = x",
  "[core]\n\t_pager = x",
  "[core]\n\tpa ger = x",
  "[co re]\n\tpager = x",
  "[core]\n\u0000",
  "[core]\n\tpager\r= x",
];

const flat = (entries: GitConfigEntry[]): string[] =>
  entries.map((e) => `${e.section}|${e.subsection ?? ""}|${e.key}|${e.value ?? "<bare>"}`);

const entry = (
  section: string,
  subsection: string | null,
  key: string,
  value: string | null,
): GitConfigEntry => ({
  section,
  subsection,
  key,
  value,
});

describe("parseGitConfig", () => {
  it.each(READS)("reads %j", (text, expected) => {
    const parsed = parseGitConfig(text);
    expect(parsed === null ? null : flat(parsed)).toEqual(expected);
  });

  it.each(REFUSES)("refuses %j", (text) => {
    expect(parseGitConfig(text)).toBeNull();
  });

  it("refuses more entries than the cap and reads exactly the cap", () => {
    const body = (n: number): string => `[a]\n${"k=1\n".repeat(n)}`;
    expect(parseGitConfig(body(MAX_GIT_CONFIG_ENTRIES))).toHaveLength(MAX_GIT_CONFIG_ENTRIES);
    expect(parseGitConfig(body(MAX_GIT_CONFIG_ENTRIES + 1))).toBeNull();
    expect(MAX_GIT_CONFIG_ENTRIES + 1).toBe(4097);
  });
});

describe("runsProgram", () => {
  it.each(
    [
      entry("core", null, "fsmonitor", "/usr/bin/hook"),
      entry("core", null, "fsmonitor", "watchman"),
      entry("core", null, "fsmonitor", ""),
      entry("core", null, "fsmonitor", "2"),
      entry("core", null, "fsmonitor", "true; touch x"),
      entry("diff", null, "external", "x"),
      entry("diff", "x", "command", "x"),
      entry("diff", "x", "textconv", "x"),
      entry("anything", "x", "textconv", "x"),
      entry("filter", "lfs", "clean", "x"),
      entry("filter", "lfs", "smudge", "x"),
      entry("filter", "lfs", "process", "x"),
      entry("filter", "lfs", "clean", "git-lfs clean -- %f; touch x"),
      entry("filter", "lfs", "clean", "git-lfs smudge -- %f"),
      entry("filter", "lfs", "smudge", "git-lfs clean -- %f"),
      entry("filter", "lfs", "process", "git-lfs filter-process --extra"),
      entry("filter", "lfs", "clean", null),
      entry("filter", "LFS", "clean", "git-lfs clean -- %f"),
      entry("filter", "other", "clean", "git-lfs clean -- %f"),
      entry("filter", null, "clean", "git-lfs clean -- %f"),
      entry("core", null, "pager", "less"),
      entry("core", null, "editor", "vi"),
      entry("core", null, "sshcommand", "ssh"),
      entry("core", null, "askpass", "x"),
      entry("core", null, "hookspath", ".husky"),
      entry("gpg", null, "program", "gpg"),
      entry("gpg", "ssh", "program", "x"),
      entry("credential", null, "helper", "store"),
      entry("credential", "https://example.com", "helper", ""),
      entry("sequence", null, "editor", "x"),
      entry("pager", null, "log", "sh -c x"),
      entry("core", "x", "pager", "less"),
    ].map((e) => [e] as const),
  )("runs a program: %j", (e) => {
    expect(runsProgram(e)).toBe(true);
  });

  it.each(
    [
      entry("core", null, "fsmonitor", null),
      ...["true", "false", "yes", "no", "on", "off", "1", "0", "TRUE", "Off", "YeS"].map((v) =>
        entry("core", null, "fsmonitor", v),
      ),
      entry("filter", "lfs", "clean", "git-lfs clean -- %f"),
      entry("filter", "lfs", "smudge", "git-lfs smudge -- %f"),
      entry("filter", "lfs", "process", "git-lfs filter-process"),
      entry("filter", "lfs", "required", "true"),
      entry("core", null, "bare", "false"),
      entry("core", null, "repositoryformatversion", "0"),
      entry("diff", null, "renames", "true"),
      entry("user", null, "name", "x"),
      entry("remote", "origin", "url", "https://example.com/x.git"),
      entry("pager", null, "log", "false"),
      entry("pager", null, "log", null),
      entry("pager", null, "log", "0"),
    ].map((e) => [e] as const),
  )("runs nothing: %j", (e) => {
    expect(runsProgram(e)).toBe(false);
  });

  it("matches pager.<command> by section, not by subsection", () => {
    expect(runsProgram(entry("pager", null, "log", "sh -c x"))).toBe(true);
    expect(runsProgram(entry("pager", null, "log", "false"))).toBe(false);
  });
});

describe("includeOf", () => {
  it("returns the path of include and includeIf, whatever the condition", () => {
    expect(includeOf(entry("include", null, "path", "../x.cfg"))).toBe("../x.cfg");
    expect(includeOf(entry("includeif", "gitdir:/a/", "path", "y.cfg"))).toBe("y.cfg");
    expect(includeOf(entry("includeif", "onbranch:main", "path", "z.cfg"))).toBe("z.cfg");
  });
  it("returns null for a bare path and undefined for anything else", () => {
    expect(includeOf(entry("include", null, "path", null))).toBeNull();
    expect(includeOf(entry("core", null, "path", "x"))).toBeUndefined();
    expect(includeOf(entry("include", null, "other", "x"))).toBeUndefined();
  });
});
