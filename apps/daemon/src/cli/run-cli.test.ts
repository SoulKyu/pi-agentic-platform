import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS, runCli } from "./run-cli.ts";
import { cliIo } from "./testing/cli-io.ts";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-run-cli-"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("runCli", () => {
  it.each([
    [[]],
    [["nope"]],
    [["audit"]],
    [["audit", "prune", "--month", "2024-13"]],
    [["audit", "prune", "--month", "2024-5"]],
    [["audit", "prune", "--bogus"]],
    [["audit", "prune", "extra"]],
    [["user"]],
    [["user", "add"]],
    [["user", "add", "a", "b"]],
    [["user", "add", "owner", "--password", "x"]],
    [["passkey"]],
    [["passkey", "reset", "extra"]],
    [["passkey", "reset", "--bogus"]],
    [["trace"]],
    [["trace", "summary", "--since", "nope"]],
  ])("answers %j with exit 64 and the usage", async (argv) => {
    const { io, stderr, stdout } = cliIo({ env: { PAP_HOME: join(scratch, "home") } });
    expect(await runCli(argv, io)).toBe(64);
    expect(stderr()).toContain("usage: pap serve");
    expect(stderr()).toContain("pap audit prune");
    expect(stderr()).toContain("pap user add <username> [--password-stdin]");
    expect(stderr()).toContain("pap passkey reset [--revoke-tokens] [--keep-password] [--password-stdin]");
    expect(stderr()).toContain("pap trace summary [--since <15m|2h|1d>]");
    expect(stderr()).toContain("pap service install [--node <abs>]");
    expect(stderr()).toContain("pap service uninstall [--bin-dir <abs>]");
    expect(stderr()).toContain("pap service url");
    expect(stderr()).toContain("systemctl --user stop pap-preview");
    expect(stdout()).toBe("");
  });

  it("lists every command of the table in the usage text", async () => {
    const { io, stderr } = cliIo();
    await runCli([], io);
    for (const words of Object.keys(COMMANDS)) expect(stderr()).toContain(`pap ${words}`);
    expect(stderr()).toContain("pap serve");
    expect(Object.keys(COMMANDS).sort()).toEqual([
      "audit prune",
      "passkey reset",
      "service install",
      "service uninstall",
      "service url",
      "trace summary",
      "user add",
    ]);
  });

  it("never echoes a secret given on the command line", async () => {
    const { io, stderr } = cliIo();
    await runCli(["user", "add", "owner", "--password=hunter2hunter2"], io);
    await runCli(["user", "add", "owner", "--password", "hunter2hunter2"], io);
    expect(stderr()).not.toContain("hunter2");
  });

  it("parses a month with --dry-run and then refuses a home without data", async () => {
    const home = join(scratch, "home");
    const { io, stderr } = cliIo({ env: { PAP_HOME: home }, now: Date.UTC(2026, 9, 12) });
    expect(await runCli(["audit", "prune", "--month", "2024-05", "--dry-run"], io)).toBe(1);
    expect(stderr()).toBe(`pap: no pap data in ${home}\n`);
  });
});
