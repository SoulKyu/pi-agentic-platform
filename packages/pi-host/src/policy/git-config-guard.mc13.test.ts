import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GIT_RUNS_PROGRAM } from "./git-config-guard.ts";
import { CLEAN, checker, repo, tempRoot } from "./git-config-guard.fixtures.ts";

/** M7 ruling MC13: keys that make git run a transport or helper program on a read command. */

let root: string;
let home: string;
beforeEach(() => {
  ({ root, home } = tempRoot());
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const KEYS: ReadonlyArray<readonly [string, string]> = [
  ["extensions", "partialClone = origin"],
  ["extensions", "partialclone"],
  ["extensions", "PARTIALCLONE = origin"],
  ['remote "origin"', "promisor = true"],
  ['remote "origin"', "Promisor = false"],
  ['remote "origin"', "uploadpack = /tmp/x"],
  ['remote "origin"', "uploadPack = /tmp/x"],
  ['remote "origin"', "receivepack = /tmp/x"],
  ["remote.origin", "receivePack = /tmp/x"],
  ["protocol", "allow = always"],
  ['protocol "ext"', "allow = always"],
  ["protocol.ext", "ALLOW = always"],
  ["core", "gitProxy = /tmp/proxy"],
  ["core", "gitproxy = /tmp/proxy for example.com"],
  ["core", "alternateRefsCommand = /tmp/x"],
  ["Core", "ALTERNATEREFSCOMMAND = /tmp/x"],
  ["uploadpack", "packObjectsHook = /tmp/x"],
  ["uploadPack", "packobjectshook = /tmp/x"],
  ["log", "showSignature = true"],
  ["log", "showsignature = false"],
];

describe("MC13 keys ask", () => {
  it.each(KEYS)("[%s] %s asks", async (section, line) => {
    const top = repo(join(root, "r"), `${CLEAN}[${section}]\n\t${line}\n`);
    expect(await checker(home)(join(top, "src"))).toBe(GIT_RUNS_PROGRAM);
  });

  it.each(KEYS)("[%s] %s asks from an include file", async (section, line) => {
    const top = repo(join(root, "r"), `${CLEAN}[include]\n\tpath = ../extra.cfg\n`);
    writeFileSync(join(top, "extra.cfg"), `[${section}]\n\t${line}\n`);
    expect(await checker(home)(join(top, "src"))).toBe(GIT_RUNS_PROGRAM);
  });

  it("does not ask for the neighbours: remote.url, remote.fetch, log.date, core.bare", async () => {
    const config = `${CLEAN}[remote "origin"]\n\turl = https://example.com/r.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[log]\n\tdate = iso\n[uploadpack]\n\tallowFilter = true\n[protocol]\n\tversion = 2\n`;
    const top = repo(join(root, "r"), config);
    expect(await checker(home)(join(top, "src"))).toBeNull();
  });
});
