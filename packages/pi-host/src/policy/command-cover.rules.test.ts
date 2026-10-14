import { rmSync } from "node:fs";
import { afterAll, expect, it } from "vitest";
import { coverCommand } from "./command-cover.ts";
import { makeBed } from "./cover-bed.ts";
import { GIT_READ_ONLY, READ_ONLY_COMMANDS } from "./read-only-commands.ts";

const bed = makeBed();
afterAll(() => rmSync(bed.base, { recursive: true, force: true }));

/**
 * Commands whose operands are text, not paths (`operands: null`): an option value in a separate word is judged
 * nowhere, so such a command must not carry an option that reads a file (M7 ruling MC14). Each name lists the options of
 * the real tool that read the content of a file; a new null-operand command must be added here on purpose.
 * `df FILE` prints a filesystem, never the content, and is left out.
 */
const FILE_READING_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  tr: [],
  basename: [],
  dirname: [],
  echo: [],
  printf: [],
  true: [],
  false: [],
  pwd: [],
  whoami: [],
  id: [],
  uname: [],
  nproc: [],
  uptime: [],
  free: [],
  df: [],
  ps: [],
  which: [],
  date: ["-f", "--file", "-r", "--reference"],
};

it("every null-operand rule is listed, and none lets a file-reading option through", async () => {
  const unlisted: string[] = [];
  const leaks: string[] = [];
  for (const [name, rule] of READ_ONLY_COMMANDS) {
    if (rule.operands !== null) continue;
    const options = FILE_READING_OPTIONS[name];
    if (options === undefined) {
      unlisted.push(name);
      continue;
    }
    for (const option of options) {
      const command = `${name} ${option} ${bed.agentDir}/auth.json`;
      const result = await coverCommand(command, bed.ctx());
      if (result.covered) leaks.push(command);
    }
  }
  expect({ unlisted, leaks }).toEqual({ unlisted: [], leaks: [] });
});

/** The only tools whose option parser is getopt or clap, verified against the real binaries (M7 ruling MC15). */
const GETOPT_TOOLS: readonly string[] = ["date", "file", "sort"];

it("`valued` is set only for the verified getopt tools", () => {
  const offenders = [...READ_ONLY_COMMANDS]
    .filter(([name, rule]) => rule.refuse?.valued !== undefined && !GETOPT_TOOLS.includes(name))
    .map(([name]) => name);
  const gitOffenders = [...GIT_READ_ONLY]
    .filter(([, rule]) => rule.refuse?.valued !== undefined)
    .map(([name]) => `git ${name}`);
  expect({ offenders, gitOffenders }).toEqual({ offenders: [], gitOffenders: [] });
});

/**
 * Options of the table's tools that write a file, run a program, or read a list of files, a pattern file or a magic
 * file (the table header's rule). Every one must ask in each form: separate word, glued or `=`, and in a cluster.
 */
const DANGEROUS: ReadonlyArray<{
  readonly name: string;
  readonly short?: string;
  readonly long?: readonly string[];
}> = [
  { name: "wc", long: ["--files0-from"] },
  { name: "du", long: ["--files0-from"] },
  { name: "sort", short: "o", long: ["--output", "--compress-program", "--files0-from"] },
  { name: "file", short: "Cfm", long: ["--compile", "--files-from", "--magic-file"] },
  { name: "date", short: "sfr", long: ["--set", "--file", "--reference"] },
  { name: "tree", short: "oR", long: ["--fromfile"] },
  { name: "rg", long: ["--pre", "--hostname-bin"] },
];

it("every known file-list, magic-file, output and program option asks in every form", async () => {
  const leaks: string[] = [];
  const tried = async (command: string) => {
    if ((await coverCommand(command, bed.ctx())).covered) leaks.push(command);
  };
  for (const { name, short = "", long = [] } of DANGEROUS) {
    for (const letter of short) {
      await tried(`${name} -${letter} x a.txt`);
      await tried(`${name} -${letter}x a.txt`);
      await tried(`${name} -b${letter} x a.txt`);
    }
    for (const option of long) {
      await tried(`${name} ${option} x a.txt`);
      await tried(`${name} ${option}=x a.txt`);
    }
  }
  expect(leaks).toEqual([]);
});
