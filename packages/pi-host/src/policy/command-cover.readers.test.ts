import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { coverCommand } from "./command-cover.ts";
import { makeBed } from "./cover-bed.ts";

const bed = makeBed();
afterAll(() => rmSync(bed.base, { recursive: true, force: true }));

const covers = async (command: string) =>
  (await coverCommand(command.replace("<agentDir>", bed.agentDir), bed.ctx())).covered;
const answer = (command: string) => coverCommand(command.replace("<agentDir>", bed.agentDir), bed.ctx());

/**
 * Mutants of the three readers (decision 117, task A1); each is run for real and killed by the named cases:
 * - M-SCRIPT: the sed script pattern loosened to end with `p` only (`/p$/`): killed by the `1p;2p`, `1!p`, `/x/p`, `' 1p'` and newline script cases (run for real: 8 failures).
 * - M-SED-OPTIONS: sed's option list ignores unknown options: killed by `-i`, `-s`, `-nE`, `-e`, `--in-place`.
 * - M-NEEDS-N: sed without `-n` allowed: killed by `sed 1p f`.
 * - M-FD-EXEC: fd's `--exec` / `-x` not refused: killed by the `fd -x`, `--exec`, `-X`, `--exec-batch=` cases.
 * - M-FD-LIST: fd's `-l` / `--list-details` (an alias of `--exec-batch ls -l`) not refused: killed by the `fd -l foo`,
 *   `--list-details`, `-Hl` cases.
 * - M-GLOB-FOLDER-ONLY: glob operands judged by their static folder only (the "glob operand" refusal removed): killed
 *   by the APR-5 "asks" cases.
 * - M-WILDCARD-AT-START: the wildcard flag set only at the start of a word (`!inWord`): killed by `''*`, `""*`, `-?`
 *   cases (null quote before the wildcard).
 * - M-OPTIONS-SKIPPED: option words not checked (only operands): killed by `-?`, `--p*`, `-H*`, `--pr[e]=sh`.
 * - M-DASHDASH-EXCEPTION: a `--` end-of-options exception kept: killed by `cat -- *`, `find -- *`, `rg foo -- *`.
 * - M-RAW-QUOTE-IGNORED: the glob decided on the unquoted word (a quoted `'*'` then asks): killed by the quoted and
 *   escaped covered cases (`rg -g '*.ts' foo`, `cat '*'`, `cat \\*`).
 * - M-LONG-OPTION-EQUALS: no `--name=value` exception: killed by `rg --glob=*.ts foo`.
 * - M-FD-PATTERN: fd's first operand not taken as the pattern (so `fd foo` counts a path and skips the folder): killed
 *   by "judges the session folder when no path is given".
 */
describe("sed as a line printer", () => {
  it.each([
    "sed -n 120,160p f.go.txt",
    "sed -n '5p' a.txt b.txt",
    "sed -n 1,20p",
    "sed -n -- 2p a.txt",
    "cd src && sed -n 1,20p a.ts && rg -n foo",
    "cat a.txt | sed -n 1p",
  ])("covers %s", async (command) => {
    expect(await covers(command)).toBe(true);
  });

  it.each([
    "sed -n '1p;w /tmp/x' a.txt",
    "sed -n 1w/tmp/x a.txt",
    "sed -n 1e a.txt",
    "sed -n 1r/etc/passwd a.txt",
    "sed -n 's/a/b/w x' a.txt",
    "sed -n 1,2w x a.txt",
    "sed -n 1pw a.txt",
    "sed -n '1p\n2p' a.txt",
    "sed -n '1p;2p' a.txt",
    "sed -n '1p ' a.txt",
    "sed -n ' 1p' a.txt",
    "sed -n 1!p a.txt",
    "sed -n '1{p}' a.txt",
    "sed -n /x/p a.txt",
    "sed -n p a.txt",
    "sed -n 1,2,3p a.txt",
    "sed -n 1234567890p a.txt",
    "sed -n 1p; rm a.txt",
    "sed -n 1y/a/b/ a.txt",
  ])("refuses the script of %j", async (command) => {
    expect(await covers(command)).toBe(false);
  });

  it.each([
    "sed -i -n 1p a.txt",
    "sed -n -i 1p a.txt",
    "sed -n 1p -i a.txt",
    "sed -ni 1p a.txt",
    "sed -n --in-place 1p a.txt",
    "sed -n --in-place=.bak 1p a.txt",
    "sed -n --in 1p a.txt",
    "sed -n -e 1p a.txt",
    "sed -ne 1p a.txt",
    "sed -n --expression=1p a.txt",
    "sed -n -f s.sed a.txt",
    "sed -n --file=s.sed a.txt",
    "sed -n -s 1p a.txt",
    "sed -n --separate 1p a.txt",
    "sed -n -z 1p a.txt",
    "sed -nE 1p a.txt",
    "sed -n -E 1p a.txt",
    "sed -n -r 1p a.txt",
    "sed -n -u 1p a.txt",
    "sed -n -l 5 1p a.txt",
    "sed -n --debug 1p a.txt",
    "sed -n --posix 1p a.txt",
    "sed -n --sandbox 1p a.txt",
    "sed -n --follow-symlinks 1p a.txt",
    "sed -n --quiet=x 1p a.txt",
    "sed -nn 1p a.txt",
    "sed -n --bogus 1p a.txt",
  ])("refuses the option of %j", async (command) => {
    expect(await answer(command)).toEqual({ covered: false, why: "refused option" });
  });

  it("stays refused without -n (it would print every line twice, and the brief allows only the -n forms)", async () => {
    expect(await answer("sed 1p a.txt")).toEqual({ covered: false, why: "option required" });
    expect(await answer("sed --posix -n 1p a.txt")).toEqual({ covered: false, why: "refused option" });
  });

  // The engine refuses any word with a `$` as an expansion (quoted or not), so the `$` forms of the script ask: safe.
  it.each(["sed --quiet '3,$p' a.txt", "sed --silent '$p' a.txt", "sed -n 7,$p a.txt"])(
    "asks for the end-of-file address of %s (a word with $ is an expansion to the engine)",
    async (command) => {
      expect(await answer(command)).toEqual({ covered: false, why: "expansion" });
    },
  );

  it("judges the files it reads like cat does", async () => {
    expect(await answer("sed -n 1p <agentDir>/auth.json")).toEqual({ covered: false, why: "protected path" });
    for (const path of ["/etc/shadow", "/", "..", "~/agent/auth.json", "~/pap/secrets/k"])
      expect(await covers(`sed -n '1p' ${path}`)).toBe(await covers(`cat ${path}`));
    expect(await answer("sed -n 1p a.txt <agentDir>/auth.json")).toEqual({
      covered: false,
      why: "protected path",
    });
    expect(await answer("sed -n 1p < <agentDir>/auth.json")).toEqual({
      covered: false,
      why: "protected path",
    });
  });

  it("does not treat the script as a path", async () => {
    expect(await covers("sed -n 1,2p ../../../etc/passwd")).toBe(await covers("cat ../../../etc/passwd"));
    expect(await covers("sed -n 1,2p")).toBe(true);
  });
});

describe("fd and fdfind", () => {
  it.each([
    "fd foo",
    "fd -e go handler src",
    "fdfind foo .",
    "fd",
    "fd -H -I foo src",
    "fd -t f -e ts src",
    "fd --type f foo",
    "fd -L foo src",
    "fd -- -x",
    "cd src && fd a",
  ])("covers %s", async (command) => {
    expect(await covers(command)).toBe(true);
  });

  it.each([
    "fd -x rm",
    "fd foo -x rm {}",
    "fd foo --exec rm {}",
    "fd foo --exec=rm",
    "fd -X cat",
    "fd foo -X cat",
    "fd --exec-batch=ls",
    "fd --exec-batch ls",
    "fd --exe rm",
    "fd -Hx rm",
    "fd -eX x",
    "fd foo --base-directory /",
    "fd foo --base-directory=/",
    "fd foo --base src",
    "fd foo --search-path /etc",
    "fd foo --search-path=src",
    "fd foo --ignore-file src/.gitignore",
    "fd foo --ignore-file=<agentDir>/auth.json",
    "fd foo --ignore-file <agentDir>/auth.json",
    "fd -l foo",
    "fd foo --list-details",
    "fd foo --list",
    "fd -Hl foo",
    "fd foo -l",
    "fdfind foo --exec rm",
    "fdfind -x rm",
  ])("refuses %s", async (command) => {
    expect(await covers(command)).toBe(false);
  });

  it("judges its paths like find does", async () => {
    for (const path of ["/etc", "/", "..", "<agentDir>", "~/agent/auth.json", "src"]) {
      expect(await covers(`fd foo ${path}`)).toBe(await covers(`find ${path}`));
    }
    expect(await answer("fd foo <agentDir>")).toMatchObject({ covered: false });
    expect(await answer("fd -e go <agentDir>/auth.json")).toMatchObject({ covered: false });
    expect(await answer("fd foo src <agentDir>")).toMatchObject({ covered: false });
  });

  it("judges the session folder when no path is given", async () => {
    const home = bed.ctx({ cwd: bed.base });
    expect(await coverCommand("fd foo", home)).toEqual(await coverCommand("find", home));
  });
});

describe("eza", () => {
  it.each(["eza", "eza -la", "eza src", "eza -l --git src", "eza --long -a ."])(
    "covers %s",
    async (command) => {
      expect(await covers(command)).toBe(true);
    },
  );

  it("judges a recursive walk like find does", async () => {
    for (const command of [
      "eza -R /",
      "eza --tree /",
      "eza -T /",
      "eza -laR /",
      "eza --recursive /",
      "eza -T <agentDir>",
    ]) {
      expect(await covers(command)).toBe(false);
      expect(await covers(command)).toBe(await covers(command.replace(/^eza\s+\S+/, "find")));
    }
    expect(await covers("eza -T src")).toBe(true);
    expect(await answer("eza --tree ~/agent")).toEqual({
      covered: false,
      why: "searches pap's data directory",
    });
  });

  it("judges its operands like ls", async () => {
    expect(await answer("eza <agentDir>/auth.json")).toEqual({ covered: false, why: "protected path" });
  });
});

describe("a wildcard that can expand to an option (APR-5)", () => {
  it.each([
    "sed -n 1,20p *.txt",
    "rg foo *",
    "cat *",
    "sort *",
    "fd foo *",
    "fd * src",
    "grep -n x ?.txt",
    "cat [a-z]*",
    "cat a.txt *",
    "rg -g *.ts foo",
    "fd -g *_test.go",
    "git grep foo *",
    "rg foo ''*",
    'cat ""*',
    "sed -n 1p ''*",
    "rg foo ''?",
    "rg foo ''[a-z]*",
    "git log ''*",
    "rg foo -*",
    "rg foo '-'*",
    "rg foo \\-*",
    "rg foo --p*",
    "rg foo --pr[e]=sh",
    "fd foo -?",
    "fd foo -H*",
    "fdfind a.txt -? sh",
    "find -- *",
    "find . -name x *",
    "cat -- *",
    "rg foo -- *",
    "git -C * status",
  ])("asks for %s", async (command) => {
    expect(await answer(command)).toEqual({ covered: false, why: "glob operand" });
  });

  // APR-6: a null quote the lexer reads as ANSI-C or locale quoting, and a line continuation between a null quote and the
  // wildcard, still leave the first unquoted wildcard of the word marked: none of these is covered.
  it.each(['rg foo $""*', "rg foo ''\\\n*", "rg foo $'-'*"])("does not cover %j", async (command) => {
    expect(await covers(command)).toBe(false);
  });

  it.each([
    "sed -n 1,20p ./*.txt",
    "rg foo src/*.ts",
    "rg -g '*.ts' foo",
    'rg -g "*.ts" foo',
    "rg --glob=*.ts foo",
    "cat src/*.ts",
    "cat ./*",
    "cat a*",
    "cat ./-*",
    "cat '*'",
    'cat "*"',
    "cat \\*",
    "cat a'*'",
    "wc -l src/*.ts",
    "find . -name '*.ts'",
    "fd -g '*_test.go'",
    "fd -e go -g '*_test.go'",
    "git log -- src/*",
    "tr '[:lower:]' '[:upper:]'",
  ])("covers %s", async (command) => {
    expect(await covers(command)).toBe(true);
  });
});
