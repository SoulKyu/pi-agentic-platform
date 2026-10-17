import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeRelease } from "../testing/apply-harness.ts";
import * as bed from "../testing/install-bed.ts";
import { fakeFetch, fixture, routesFor } from "../testing/update-feed.ts";
import { installKind, makeInstallCommand } from "./install-command.ts";

let scratch: string;
let userHome: string;
let fakeBin: string;

const app = () => join(userHome, ".local", "share", "pap");
const downloads = () => join(app(), "downloads");

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-install-cmd-"));
  userHome = join(scratch, "user");
  fakeBin = join(scratch, "bin");
  mkdirSync(fakeBin, { recursive: true });
  makeRelease(app(), "r1");
  symlinkSync("releases/r1", join(app(), "current"));
  setBash(0);
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const setBash = (code: number, extra = ""): void => bed.setBash(fakeBin, code, extra);
const bashCalls = () => bed.bashCalls(fakeBin);
const seen = (name: string) => bed.seen(fakeBin, name);
const { NODE } = bed;
const command = bed.command;
const run = (cmd: ReturnType<typeof command>["cmd"], args: string[], env: NodeJS.ProcessEnv = {}) =>
  bed.run(fakeBin, userHome, cmd, args, env);

describe("not an archive install", () => {
  it.each([
    ["checkout", "git pull && scripts/install.sh"],
    ["npm", "npm install -g @soulkyu/pi-agentic-platform@latest"],
    ["container", "scripts/pap-container.sh build"],
  ] as const)("a %s prints its own command, exit 1, nothing fetched", async (kind, hint) => {
    rmSync(join(app(), "current"));
    const { cmd, served } = command(fixture(), { kind: () => kind });
    const result = await run(cmd, ["--yes"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain(hint);
    expect(served.calls).toEqual([]);
    expect(bashCalls()).toBe(0);
  });

  it("detects the kind from the entry path and the container marker", () => {
    expect(installKind("/home/u/src/pap/apps/daemon/dist/main.js", false)).toBe("checkout");
    expect(installKind("/usr/lib/node_modules/@soulkyu/pi-agentic-platform/dist/main.js", false)).toBe("npm");
    expect(installKind("/app/apps/daemon/dist/main.js", true)).toBe("container");
    expect(installKind(undefined, false)).toBe("checkout");
  });
});

describe("dry run", () => {
  it("prints versions, the interruption list and the rollback sentence, and writes nothing", async () => {
    const { cmd, served } = command(fixture());
    const result = await run(cmd, []);
    expect(result.code).toBe(0);
    expect(result.out).toContain("1.0.0 -> 1.1.0 (stable)");
    expect(result.out).toContain("running agent turns are interrupted");
    expect(result.out).toContain("rolled back");
    expect(result.out).toContain("--yes");
    expect(served.calls).toHaveLength(1);
    expect(existsSync(downloads())).toBe(false);
    expect(bashCalls()).toBe(0);
  });

  it("does not claim the release is signed", async () => {
    const result = await run(command(fixture()).cmd, []);
    expect(result.out).toContain("not signed");
  });
});

describe("refusals before a download", () => {
  it("pap is up to date when the feed is not newer", async () => {
    for (const current of ["1.1.0", "1.2.0"]) {
      const { cmd, served } = command(fixture(), { version: current });
      const result = await run(cmd, ["--yes"]);
      expect(result.code).toBe(1);
      expect(result.err).toContain("pap is up to date");
      expect(served.calls).toHaveLength(1);
    }
    expect(bashCalls()).toBe(0);
  });

  it("a release that needs a newer Node", async () => {
    const { cmd, served } = command(fixture({ minNode: "24.1" }), { nodeVersion: "22.14.0" });
    const result = await run(cmd, ["--yes"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("needs Node 24.1");
    expect(served.calls).toHaveLength(1);
    const ok = await run(command(fixture({ minNode: "22.14" })).cmd, []);
    expect(ok.code).toBe(0);
  });

  it("a feed that asks a host outside the allowlist is refused at the schema, no asset is fetched", async () => {
    const f = fixture();
    const bad = {
      ...f.feed,
      installer: { ...f.feed.installer, url: "https://evil.example/pap-install-v1.1.0.sh" },
    };
    const served = fakeFetch({ [f.feedUrl]: JSON.stringify(bad) });
    const cmd = makeInstallCommand({
      fetch: served.fetch,
      version: "1.0.0",
      nodeVersion: NODE,
      kind: () => "checkout",
    });
    const result = await run(cmd, ["--yes"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("(feed_invalid)");
    expect(served.calls).toEqual([f.feedUrl]);
    expect(bashCalls()).toBe(0);
  });

  it("a feed that cannot be read: exit 1 with the code word", async () => {
    const { cmd } = command(null);
    const result = await run(cmd, ["--yes"]);
    expect(result.code).toBe(1);
    expect(result.err).toBe("pap: cannot read the update feed (status)\n");
  });

  it("an installer announced above 1 MiB", async () => {
    const f = fixture();
    const big = { ...f.feed, installer: { ...f.feed.installer, size: 2_000_000 } };
    const served = fakeFetch({ [f.feedUrl]: JSON.stringify(big) });
    const cmd = makeInstallCommand({
      fetch: served.fetch,
      version: "1.0.0",
      nodeVersion: NODE,
      kind: () => "checkout",
    });
    const result = await run(cmd, ["--yes"]);
    expect(result.code).toBe(1);
    expect(served.calls).toEqual([f.feedUrl]);
  });
});

describe("--yes", () => {
  it("verifies, writes the installer 0700 in a 0700 folder under the app root, runs it, then removes the folder", async () => {
    const f = fixture();
    const { cmd, served } = command(f);
    const result = await run(cmd, ["--yes"], { PATH: `${fakeBin}:${process.env.PATH ?? ""}` });
    expect(result.code).toBe(0);
    expect(served.calls).toEqual([f.feedUrl, f.feed.installer.url, f.feed.archive.url]);
    expect(bashCalls()).toBe(1);
    const argv = seen("argv").trim();
    expect(argv.startsWith(`${downloads()}/dl.`)).toBe(true);
    expect(argv.endsWith(`/pap-install-v1.1.0.sh`)).toBe(true);
    expect(seen("cwd").trim()).toBe(argv.slice(0, argv.lastIndexOf("/")));
    expect(seen("installer-mode").trim()).toBe("700");
    expect(seen("dir-mode").trim()).toBe("700");
    expect(seen("dir-listing").split("\n").filter(Boolean).sort()).toEqual([
      "pap-install-v1.1.0.sh",
      "pap-v1.1.0-linux-x64.tar.gz",
    ]);
    expect(readdirSync(downloads())).toEqual([]);
    expect(statSync(downloads()).mode & 0o777).toBe(0o700);
  });

  it.each([0, 3, 4, 5])("returns the installer's exit code %i", async (code) => {
    setBash(code);
    const result = await run(command(fixture()).cmd, ["--yes"]);
    expect(result.code).toBe(code);
    expect(readdirSync(downloads())).toEqual([]);
  });

  it("another exit code passes through and the folder is still removed", async () => {
    setBash(1);
    const result = await run(command(fixture()).cmd, ["--yes"]);
    expect(result.code).toBe(1);
    expect(readdirSync(downloads())).toEqual([]);
  });

  it("an installer killed by a signal is exit 1 with a fixed sentence", async () => {
    setBash(0, "kill -9 $$");
    const result = await run(command(fixture()).cmd, ["--yes"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("did not finish");
    expect(readdirSync(downloads())).toEqual([]);
  });

  it("a flipped byte in the installer is refused, bash is never called, the archive is not fetched", async () => {
    const f = fixture();
    const flipped = Buffer.from(f.installer);
    flipped[3] = (flipped[3] ?? 0) ^ 0x01;
    const served = fakeFetch({ ...routesFor(f), [f.feed.installer.url]: flipped });
    const cmd = makeInstallCommand({
      fetch: served.fetch,
      version: "1.0.0",
      nodeVersion: NODE,
      kind: () => "checkout",
    });
    const result = await run(cmd, ["--yes"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("does not match the feed");
    expect(bashCalls()).toBe(0);
    expect(served.calls).toEqual([f.feedUrl, f.feed.installer.url]);
    expect(readdirSync(downloads())).toEqual([]);
  });

  it("an archive whose length differs from the feed is refused, bash is never called", async () => {
    const f = fixture();
    const served = fakeFetch({
      ...routesFor(f),
      [f.feed.archive.url]: f.archive.subarray(0, f.archive.length - 1),
    });
    const cmd = makeInstallCommand({
      fetch: served.fetch,
      version: "1.0.0",
      nodeVersion: NODE,
      kind: () => "checkout",
    });
    const result = await run(cmd, ["--yes"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("linux-x64.tar.gz is not the size the feed announces");
    expect(bashCalls()).toBe(0);
    expect(readdirSync(downloads())).toEqual([]);
  });

  it("an archive longer than the feed says is refused", async () => {
    const f = fixture();
    const served = fakeFetch({
      ...routesFor(f),
      [f.feed.archive.url]: Buffer.concat([f.archive, Buffer.from("x")]),
    });
    const cmd = makeInstallCommand({
      fetch: served.fetch,
      version: "1.0.0",
      nodeVersion: NODE,
      kind: () => "checkout",
    });
    expect((await run(cmd, ["--yes"])).code).toBe(1);
    expect(bashCalls()).toBe(0);
  });

  it("the child gets PATH, HOME, XDG_RUNTIME_DIR, XDG_CONFIG_HOME, DBUS_SESSION_BUS_ADDRESS and LANG, nothing else", async () => {
    const env = {
      XDG_RUNTIME_DIR: "/run/user/1000",
      XDG_CONFIG_HOME: "/home/x/.config",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      LANG: "C.UTF-8",
      PAP_UNIT: "pap-preview.service",
      PAP_HOME: "/elsewhere/pap",
      GITHUB_TOKEN: "ghp_not_for_the_installer",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      LD_PRELOAD: "/tmp/evil.so",
      BASH_ENV: "/tmp/evil.sh",
    };
    const result = await run(command(fixture()).cmd, ["--yes"], env);
    expect(result.code).toBe(0);
    const keys = seen("env")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(0, line.indexOf("=")))
      .filter((key) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(key));
    expect(keys.sort()).toEqual(
      ["DBUS_SESSION_BUS_ADDRESS", "HOME", "LANG", "PATH", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR"].sort(),
    );
    expect(seen("env")).toContain("XDG_RUNTIME_DIR=/run/user/1000");
    expect(seen("env")).toContain(`HOME=${userHome}`);
  });

  it("variables that are not set are not invented", async () => {
    await run(command(fixture()).cmd, ["--yes"]);
    const keys = seen("env")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(0, l.indexOf("=")));
    expect(keys).not.toContain("XDG_RUNTIME_DIR");
    expect(keys).not.toContain("LANG");
  });

  it("--channel next and PAP_UPDATE_CHANNEL fetch the next feed", async () => {
    const f = fixture({ channel: "next", version: "1.2.0-next.1" });
    const { cmd, served } = command(f);
    await run(cmd, ["--channel", "next"]);
    await run(cmd, [], { PAP_UPDATE_CHANNEL: "next" });
    expect(served.calls).toEqual([f.feedUrl, f.feedUrl]);
    expect((await run(cmd, ["--channel", "beta"])).code).toBe(64);
  });
});
