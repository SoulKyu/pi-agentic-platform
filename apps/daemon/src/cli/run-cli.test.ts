import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./run-cli.ts";
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
  ])("answers %j with exit 64 and the usage", async (argv) => {
    const { io, stderr, stdout } = cliIo({ env: { PAP_HOME: join(scratch, "home") } });
    expect(await runCli(argv, io)).toBe(64);
    expect(stderr()).toContain("usage: pap serve");
    expect(stderr()).toContain("pap audit prune");
    expect(stderr()).toContain("systemctl --user stop pap-preview");
    expect(stdout()).toBe("");
  });

  it("parses a month with --dry-run and then refuses a home without data", async () => {
    const home = join(scratch, "home");
    const { io, stderr } = cliIo({ env: { PAP_HOME: home }, now: Date.UTC(2026, 9, 12) });
    expect(await runCli(["audit", "prune", "--month", "2024-05", "--dry-run"], io)).toBe(1);
    expect(stderr()).toBe(`pap: no pap data in ${home}\n`);
  });
});
