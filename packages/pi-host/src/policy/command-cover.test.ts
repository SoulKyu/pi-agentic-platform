import { rmSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { coverCommand } from "./command-cover.ts";
import { makeBed } from "./cover-bed.ts";

const bed = makeBed();
const { ctx } = bed;
afterAll(() => rmSync(bed.base, { recursive: true, force: true }));

const RUNS: readonly string[] = [
  "cat README.md",
  "head -n 20 src/a.ts",
  "tail -5 README.md",
  "ls",
  "ls -la src",
  "tree -L 2",
  "wc -l src/*.ts",
  "stat src",
  "du -sh src",
  "diff a.txt b.txt",
  "sort a.txt | uniq -c",
  "cat README.md | jq .scripts",
  "rg TODO",
  "rg -n foo 2>/dev/null | head -20",
  "grep -rn foo src",
  "find . -name '*.ts' -not -path './node_modules/*'",
  "pwd",
  "echo hello",
  "date",
  "date -Iseconds",
  "date -u +%s",
  "sort -T/opt/tmp a.txt",
  "sort -k2,2 -t, a.txt",
  "sort -nr a.txt",
  "cd src && ls",
  "(cat a.txt)",
  "cat a.txt &",
  "git status",
  "git status --short",
  "git diff --stat HEAD~3",
  "git diff -- src/a.ts",
  "git log --oneline -20",
  "git log -5 --stat",
  "git show HEAD~1 --stat",
  "git branch -a",
  "git blame src/a.ts",
  "git rev-parse HEAD",
  "git ls-files | wc -l",
  "git stash list",
  "git remote -v",
  "git --no-pager log -3",
  "git -C src status",
  "cat <<'EOF'\nhello\nEOF",
  "wc -l < a.txt",
];
describe("covered commands", () => {
  it.each(RUNS)("covers %s", async (command) => {
    expect(await coverCommand(command, ctx())).toEqual({ covered: true });
  });
});

const NOT = (why: string) => ({ covered: false, why });
describe("context refusals and bounds", () => {
  const cases: ReadonlyArray<readonly [string, string, Parameters<typeof ctx>[0], string]> = [
    [
      "a command prefix",
      "ls",
      { shell: { commandPrefix: "shopt -s expand_aliases" } },
      "shell command prefix",
    ],
    ["a shell path", "ls", { shell: { shellPath: "/bin/bash" } }, "custom shell"],
    ["a startup file", "ls", { shell: { startupFile: true } }, "shell startup file"],
    ["a relative PATH entry", "ls", { shell: { path: ".:/usr/bin" } }, "PATH entry not absolute"],
    ["an empty PATH entry", "ls", { shell: { path: "/usr/bin::/bin" } }, "PATH entry not absolute"],
    ["no PATH", "ls", { shell: { path: undefined } }, "PATH entry not absolute"],
    [
      "a PATH entry in the session folder",
      "ls",
      { shell: { path: `${bed.cwd}/bin:/usr/bin` } },
      "PATH entry inside the session folder",
    ],
    [
      "a PATH entry through a symlink",
      "ls",
      { shell: { path: `${bed.base}/linkbin:/usr/bin` } },
      "PATH entry inside the session folder",
    ],
    ["CDPATH", "cd src && ls", { shell: { cdPath: true } }, "CDPATH is set"],
    ["read-only off", "ls", { readOnly: false }, "not allowed"],
  ];
  it.each(cases)("refuses %s", async (_name, command, over, why) => {
    expect(await coverCommand(command, ctx(over))).toEqual(NOT(why));
  });
  it("refuses 33 segments", async () => {
    expect(await coverCommand("ls;".repeat(33), ctx())).toEqual(NOT("segment count"));
  });
  it("accepts 32 segments", async () => {
    expect(await coverCommand("ls;".repeat(32), ctx())).toEqual({ covered: true });
  });
  it("refuses 65 operands", async () => {
    const operands = Array.from({ length: 65 }, (_, i) => `f${i}`).join(" ");
    expect(await coverCommand(`cat ${operands}`, ctx())).toEqual(NOT("too many paths"));
  });
  it("refuses a 70 000 character command", async () => {
    expect(await coverCommand(`echo ${"a".repeat(70_000)}`, ctx())).toEqual(NOT("unreadable"));
  });
  it("refuses a PATH of 65 entries and accepts 64", async () => {
    const path = (count: number) => Array.from({ length: count }, () => "/usr/bin").join(":");
    expect(await coverCommand("ls", ctx({ shell: { path: path(65) } }))).toEqual(NOT("PATH too long"));
    expect(await coverCommand("ls", ctx({ shell: { path: path(64) } }))).toEqual({ covered: true });
  });
  it("refuses nine cd", async () => {
    const dirs = Array.from({ length: 9 }, (_, i) => `cd d${i}`).join(" && ");
    expect(await coverCommand(dirs, ctx())).toEqual(NOT("too many folders"));
  });
  it("never throws: a failure inside answers not covered", async () => {
    const broken = { ...ctx(), shell: undefined } as unknown as ReturnType<typeof ctx>;
    const written = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(await coverCommand("ls", broken)).toEqual(NOT("check failed"));
      expect(written).toHaveBeenCalledWith("pi-host: read-only check failed (TypeError)\n");
    } finally {
      written.mockRestore();
    }
  });
});

describe("prefixes", () => {
  const prefixes = [["pnpm", "test"]];
  it("covers a segment that starts with a prefix", async () => {
    expect(await coverCommand("pnpm test -- src/a.test.ts", ctx({ readOnly: false, prefixes }))).toEqual({
      covered: true,
    });
  });
  it("refuses the rest of a line", async () => {
    expect(await coverCommand("pnpm test && ls", ctx({ readOnly: false, prefixes }))).toEqual(
      NOT("not allowed"),
    );
  });
  it("refuses another subcommand", async () => {
    expect(await coverCommand("pnpm build", ctx({ readOnly: false, prefixes }))).toEqual(NOT("not allowed"));
  });
});

describe("judging the session folder", () => {
  it("judges the session folder for rg when the session runs from home", async () => {
    expect(await coverCommand("rg token", ctx({ cwd: bed.base }))).toEqual(
      NOT("searches pap's data directory"),
    );
  });
});
