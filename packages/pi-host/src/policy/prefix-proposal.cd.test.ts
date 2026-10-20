import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { coverCommand } from "./command-cover.ts";
import { makeBed } from "./cover-bed.ts";
import { proposePrefix } from "./prefix-proposal.ts";

const bed = makeBed();
const outside = realpathSync(mkdtempSync(join(tmpdir(), "pap-outside-")));
mkdirSync(join(bed.cwd, "sub", "deep"), { recursive: true });
symlinkSync(outside, join(bed.cwd, "escape"));
afterAll(() => {
  rmSync(bed.base, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
const folder = { cwd: bed.cwd, cdPath: false };

/**
 * Mutants (decision 117, task A1), each run for real:
 * - M-PROPOSE-OUTSIDE: the proposal accepts a cd target outside the session folder: killed by `cd /tmp && go test`,
 *   `cd .. && go test` and `cd escape && go test` (symbolic link out).
 * - M-COVER-SKIPS-CD: prefix coverage skips a cd without judging its target: killed by "does not cover cd outside".
 */
describe("a prefix for cd <folder> && <command>", () => {
  it.each([
    ["cd sub && go test ./...", ["go", "test"]],
    ["cd sub/deep && pnpm exec vitest", ["pnpm", "exec", "vitest"]],
    ["cd ./sub && npm run build", ["npm", "run", "build"]],
    ["cd sub/.. && make test", ["make", "test"]],
    [`cd ${bed.cwd}/sub && go test`, ["go", "test"]],
    ["cd   sub  &&  go test", ["go", "test"]],
  ])("offers the prefix of %s", (command, prefix) => {
    expect(proposePrefix(command, folder)).toEqual(prefix);
  });

  it.each([
    "cd /tmp && go test",
    `cd ${outside} && go test`,
    "cd .. && go test",
    "cd escape && go test",
    "cd missing && go test",
    "cd sub; go test",
    "cd sub || go test",
    "cd sub | go test",
    "cd sub & go test",
    "cd sub\ngo test",
    "cd a && cd b && go test",
    "cd sub && go test && ls",
    "cd sub && go test; ls",
    "cd sub && cd sub && go test",
    "cd && go test",
    "cd - && go test",
    "cd -P sub && go test",
    "cd -- sub && go test",
    "cd sub extra && go test",
    "cd ~ && go test",
    "cd ~/sub && go test",
    "cd $HOME && go test",
    "cd 'sub' && go test",
    "cd sub* && go test",
    "cd sub && ls",
    "cd sub && sudo go test",
    "cd sub && go test > out",
    "cd sub && $(id) test",
    "ls && go test",
    "echo cd sub && go test",
    "(cd sub && go test)",
  ])("offers only the exact command for %j", (command) => {
    expect(proposePrefix(command, folder)).toBeNull();
  });

  it("offers nothing for cd without a folder to judge, or with CDPATH set", () => {
    expect(proposePrefix("cd sub && go test")).toBeNull();
    expect(proposePrefix("cd sub && go test", { ...folder, cdPath: true })).toBeNull();
    expect(proposePrefix("go test")).toEqual(["go", "test"]);
  });
});

describe("a prefix rule covers cd <inside> && <prefix>", () => {
  const prefixes = [["go", "test"]];
  const over = { readOnly: false, prefixes } as const;

  it.each([
    "cd sub && go test ./x",
    "cd sub/deep && go test",
    "cd sub && cd deep && go test",
    "cd src && go test",
  ])("covers %s", async (command) => {
    expect(await coverCommand(command, bed.ctx(over))).toEqual({ covered: true });
  });

  it.each([
    "cd /etc && go test",
    "cd .. && go test",
    "cd escape && go test",
    "cd ~ && go test",
    "cd && go test",
    "cd sub && cd /etc && go test",
    "go test && cd /etc",
  ])("does not cover cd outside: %s", async (command) => {
    expect(await coverCommand(command, bed.ctx(over))).toMatchObject({ covered: false });
  });

  it("does not cover another command after the cd", async () => {
    expect(await coverCommand("cd sub && go build", bed.ctx(over))).toEqual({
      covered: false,
      why: "not allowed",
    });
  });
});
