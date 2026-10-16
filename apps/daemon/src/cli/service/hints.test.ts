import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliIo } from "../testing/cli-io.ts";
import { fakeSystemd } from "../testing/fake-systemd.ts";
import { JOURNAL_HINT } from "./common.ts";
import { serviceInstall } from "./install.ts";
import { serviceUrl } from "./url.ts";

const ID = "0123456789abcdef0123456789abcdef";
const SETUP = '{"msg":"setup_url","url":"http://localhost:7777/setup#token=t"}';
const LISTENING = '{"msg":"listening","url":"http://localhost:7777","port":7777}';

let scratch: string;
let fake: ReturnType<typeof fakeSystemd>;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-hints-"));
  fake = fakeSystemd(join(scratch, "fake"));
  fake.set("linger", "no\n");
  fake.set("node-version", "v24.14.0\n");
  fake.set("invocation-id", `${ID}\n`);
  fake.set("active-enter", "Thu 2026-10-15 18:20:11 UTC\n");
  fake.set("journal", `${SETUP}\n${LISTENING}\n`); // a URL answers on the first read; an owner claim needs two
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** A PATH holding the fake systemctl, journalctl and node and the shell tools they use, but no loginctl. */
function pathWithoutLoginctl(): string {
  const bin = join(scratch, "no-loginctl");
  mkdirSync(bin);
  for (const name of ["systemctl", "journalctl", "node"])
    symlinkSync(join(fake.binDir, name), join(bin, name));
  for (const tool of ["basename", "env", "cut", "cat", "cp", "sleep", "head"])
    symlinkSync(`/usr/bin/${tool}`, join(bin, tool));
  return bin;
}

describe("pap service install without loginctl", () => {
  it("warns with the enable-linger command and carries on", async () => {
    const main = join(scratch, "main.js");
    writeFileSync(main, "// main\n");
    const home = join(scratch, "home");
    mkdirSync(home);
    const { io, stdout, stderr } = cliIo({ env: { PATH: pathWithoutLoginctl(), HOME: home }, homedir: home });
    const code = await serviceInstall.run({
      values: { node: join(fake.binDir, "node"), main, "bin-dir": join(scratch, "launcher-bin") },
      positionals: [],
      io,
    });
    expect(code).toBe(0);
    expect(stderr()).toContain(`run: loginctl enable-linger ${userInfo().username}`);
    expect(stdout()).toContain("service installed");
  });
});

describe("pap service url", () => {
  it("adds the journal hint when the journal cannot be read", async () => {
    fake.set("fail-journal", "");
    const { io } = cliIo({ env: { PATH: `${fake.binDir}:/usr/bin:/bin` } });
    await expect(serviceUrl.run({ values: {}, positionals: [], io })).rejects.toThrow(
      `(exit 1); see: ${JOURNAL_HINT}`,
    );
  });
});
