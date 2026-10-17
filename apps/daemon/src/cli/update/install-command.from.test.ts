import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeRelease } from "../testing/apply-harness.ts";
import * as bed from "../testing/install-bed.ts";

let scratch: string;
let userHome: string;
let fakeBin: string;

const app = () => join(userHome, ".local", "share", "pap");

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-install-from-"));
  userHome = join(scratch, "user");
  fakeBin = join(scratch, "bin");
  mkdirSync(fakeBin, { recursive: true });
  makeRelease(app(), "r1");
  symlinkSync("releases/r1", join(app(), "current"));
  bed.setBash(fakeBin, 0);
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const bashCalls = () => bed.bashCalls(fakeBin);
const seen = (name: string) => bed.seen(fakeBin, name);
const command = bed.command;
const run = (cmd: ReturnType<typeof command>["cmd"], args: string[], env: NodeJS.ProcessEnv = {}) =>
  bed.run(fakeBin, userHome, cmd, args, env);

describe("--from <dir>", () => {
  const folder = (names: string[]) => {
    const dir = join(scratch, "built");
    mkdirSync(dir, { recursive: true });
    for (const name of names) writeFileSync(join(dir, name), "x");
    return dir;
  };

  it("one installer and its archive: runs it in place with no fetch", async () => {
    const dir = folder(["pap-install-abc123.sh", "pap-abc123-linux-x64.tar.gz"]);
    const { cmd, served } = command(null);
    const result = await run(cmd, ["--from", dir, "--yes"]);
    expect(result.code).toBe(0);
    expect(served.calls).toEqual([]);
    expect(seen("argv").trim()).toBe(join(dir, "pap-install-abc123.sh"));
    expect(seen("cwd").trim()).toBe(dir);
    expect(existsSync(join(dir, "pap-install-abc123.sh"))).toBe(true);
  });

  it("without --yes it prints the plan and runs nothing", async () => {
    const dir = folder(["pap-install-abc123.sh", "pap-abc123-linux-x64.tar.gz"]);
    const result = await run(command(null).cmd, ["--from", dir]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("abc123");
    expect(bashCalls()).toBe(0);
  });

  it("two installers, none, or an installer without its archive: refused", async () => {
    for (const names of [
      ["pap-install-a.sh", "pap-install-b.sh", "pap-a-linux-x64.tar.gz"],
      ["pap-a-linux-x64.tar.gz"],
      ["pap-install-a.sh"],
      ["pap-install-a.sh", "pap-b-linux-x64.tar.gz"],
    ]) {
      rmSync(join(scratch, "built"), { recursive: true, force: true });
      const dir = folder(names);
      const { cmd, served } = command(null);
      const result = await run(cmd, ["--from", dir, "--yes"]);
      expect(result.code, names.join()).toBe(1);
      expect(served.calls).toEqual([]);
    }
    expect(bashCalls()).toBe(0);
  });

  it("a relative folder is a usage error, a missing folder a refusal", async () => {
    expect((await run(command(null).cmd, ["--from", "built"])).code).toBe(64);
    expect((await run(command(null).cmd, ["--from", join(scratch, "nope"), "--yes"])).code).toBe(1);
  });

  it("an installer that is a symlink is refused", async () => {
    const dir = folder(["pap-a-linux-x64.tar.gz"]);
    symlinkSync("/bin/sh", join(dir, "pap-install-a.sh"));
    expect((await run(command(null).cmd, ["--from", dir, "--yes"])).code).toBe(1);
    expect(bashCalls()).toBe(0);
  });

  it("still needs an archive install", async () => {
    rmSync(join(app(), "current"));
    const dir = folder(["pap-install-a.sh", "pap-a-linux-x64.tar.gz"]);
    const result = await run(command(null, { kind: () => "npm" }).cmd, ["--from", dir, "--yes"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("npm install -g");
  });
});
