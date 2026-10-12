import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPipelineBed } from "../testing/pipeline-bed.ts";
import { checkReadTarget, PAP_SENSITIVE } from "./read-target.ts";

let bed: Awaited<ReturnType<typeof createPipelineBed>>;
beforeEach(async () => {
  bed = await createPipelineBed();
  vi.stubEnv("HOME", join(bed.base, "home"));
  await mkdir(join(bed.base, "home"), { recursive: true });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await bed.dispose();
});

const check = (tool: string, input: unknown, cwd = bed.cwd) =>
  checkReadTarget(tool, input, { cwd, papHome: bed.papHome, agentDir: bed.agentDir });
const protectedAt = (target: string) => ({ why: "protected path", target });
const searches = (target: string) => ({ why: "searches pap's data directory", target });

describe("checkReadTarget: pap's sensitive files (M5R29)", () => {
  it("lists what it protects", () => {
    expect(PAP_SENSITIVE).toEqual([
      "state.db",
      "state.db-wal",
      "state.db-shm",
      "pap.lock",
      "secrets",
      "backups",
      "exports",
      "fork-tmp",
    ]);
  });

  it.each([
    "state.db",
    "state.db-wal",
    "state.db-shm",
    "pap.lock",
    "secrets",
    "backups",
    "exports",
    "fork-tmp",
  ])("protects %s", async (name) => {
    const entry = join(bed.papHome, name);
    await writeFile(entry, "x");
    expect(await check("read", { path: entry })).toEqual(protectedAt(entry));
  });

  it.each(["secrets", "backups", "exports", "fork-tmp"])(
    "protects a file below the folder %s",
    async (name) => {
      await mkdir(join(bed.papHome, name), { recursive: true });
      await writeFile(join(bed.papHome, name, "device.key"), "x");
      const file = join(bed.papHome, name, "device.key");
      expect(await check("read", { path: file })).toEqual(protectedAt(file));
      expect(await check("grep", { pattern: "k", path: file })).toEqual(protectedAt(file));
      expect(await check("find", { pattern: "*", path: join(bed.papHome, name) })).toEqual(
        protectedAt(join(bed.papHome, name)),
      );
      expect(await check("ls", { path: join(bed.papHome, name) })).toEqual(
        protectedAt(join(bed.papHome, name)),
      );
    },
  );

  it("protects a sensitive file that does not exist yet", async () => {
    const entry = join(bed.papHome, "secrets", "later.key");
    expect(await check("read", { path: entry })).toEqual(protectedAt(entry));
  });

  it("leaves the rest of the data directory and other files alone", async () => {
    await writeFile(join(bed.papHome, "notes.txt"), "x");
    expect(await check("read", { path: join(bed.papHome, "notes.txt") })).toBeUndefined();
    expect(await check("read", { path: "src/a.ts" })).toBeUndefined();
    expect(await check("read", { path: join(bed.outside, "x") })).toBeUndefined();
  });

  it("protects the Pi credentials and other sessions' transcripts", async () => {
    await mkdir(join(bed.agentDir, "sessions"), { recursive: true });
    const auth = join(bed.agentDir, "auth.json");
    const transcript = join(bed.agentDir, "sessions", "x.jsonl");
    await writeFile(auth, "{}");
    await writeFile(transcript, "{}");
    expect(await check("read", { path: auth })).toEqual(protectedAt(auth));
    expect(await check("read", { path: transcript })).toEqual(protectedAt(transcript));
    expect(await check("read", { path: join(bed.agentDir, "settings.json") })).toBeUndefined();
  });

  it("lets a session read its own folder inside the sessions directory", async () => {
    const sessions = join(bed.agentDir, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, "x.jsonl"), "{}");
    expect(await check("read", { path: join(sessions, "x.jsonl") }, sessions)).toBeUndefined();
    // The auth file is never covered by that exception.
    expect(await check("read", { path: join(bed.agentDir, "auth.json") }, sessions)).toEqual(
      protectedAt(join(bed.agentDir, "auth.json")),
    );
  });

  it("asks for a search rooted at the agent directory, at pap's home or at an ancestor of either", async () => {
    expect(await check("grep", { pattern: "t", path: bed.agentDir })).toEqual(searches(bed.agentDir));
    expect(await check("find", { pattern: "*", path: bed.papHome })).toEqual(searches(bed.papHome));
    expect(await check("grep", { pattern: "t", path: bed.base })).toEqual(searches(bed.base));
    expect(await check("find", { pattern: "*", path: bed.base })).toEqual(searches(bed.base));
  });

  it("asks for a search without a path when the session folder is an ancestor of pap's home", async () => {
    expect(await check("grep", { pattern: "t" }, bed.base)).toEqual(searches(bed.base));
    expect(await check("find", { pattern: "*" }, bed.base)).toEqual(searches(bed.base));
    expect(await check("grep", { pattern: "t" })).toBeUndefined();
  });

  it("lets an ls of an ancestor through: it lists names only", async () => {
    expect(await check("ls", { path: bed.base })).toBeUndefined();
    expect(await check("ls", { path: bed.papHome })).toBeUndefined();
    expect(await check("ls", {})).toBeUndefined();
  });

  it("follows a symlink into secrets/", async () => {
    await mkdir(join(bed.papHome, "secrets"), { recursive: true });
    await writeFile(join(bed.papHome, "secrets", "device.key"), "x");
    await symlink(join(bed.papHome, "secrets"), join(bed.cwd, "link"), "dir");
    await symlink(join(bed.papHome, "secrets", "device.key"), join(bed.cwd, "key"));
    const real = join(bed.papHome, "secrets", "device.key");
    expect(await check("read", { path: "link/device.key" })).toEqual(protectedAt(real));
    expect(await check("read", { path: "key" })).toEqual(protectedAt(real));
    expect(await check("grep", { pattern: "x", path: "link" })).toEqual(
      protectedAt(join(bed.papHome, "secrets")),
    );
  });

  it("protects pap's home reached through a symlinked parent", async () => {
    await symlink(bed.base, join(bed.outside, "up"), "dir");
    const spelled = join(bed.outside, "up", "pap", "state.db");
    expect(await check("read", { path: spelled })).toEqual(protectedAt(join(bed.papHome, "state.db")));
  });

  it("protects a pap home that is itself spelled through a symlink", async () => {
    const link = join(bed.base, "pap-link");
    await symlink(bed.papHome, link, "dir");
    const viaLink = await checkReadTarget(
      "read",
      { path: join(bed.papHome, "state.db") },
      { cwd: bed.cwd, papHome: link, agentDir: bed.agentDir },
    );
    expect(viaLink).toEqual(protectedAt(join(bed.papHome, "state.db")));
  });

  it("reads the path as Pi does: ~, a leading @ and file: URLs", async () => {
    const home = join(bed.base, "home");
    await mkdir(join(home, "pap"), { recursive: true });
    const inHome = { cwd: bed.cwd, papHome: join(home, "pap"), agentDir: bed.agentDir };
    const real = join(home, "pap", "state.db");
    expect(await checkReadTarget("read", { path: "~/pap/state.db" }, inHome)).toEqual(protectedAt(real));
    expect(await checkReadTarget("read", { path: "@~/pap/state.db" }, inHome)).toEqual(protectedAt(real));
    expect(await checkReadTarget("read", { path: `@${real}` }, inHome)).toEqual(protectedAt(real));
    expect(await checkReadTarget("read", { path: `file://${real}` }, inHome)).toEqual(protectedAt(real));
  });

  it("fails closed on a path that is not a string, or that holds a NUL", async () => {
    for (const path of [42, null, {}, [], "", "a\0b"])
      expect(await check("read", { path })).toEqual({ why: "protected path" });
    expect(await check("read", undefined)).toEqual({ why: "protected path" });
    expect(await check("read", "text")).toEqual({ why: "protected path" });
    expect(await check("grep", { pattern: "x", path: 7 })).toEqual({ why: "protected path" });
  });

  it("does not judge a tool it does not know", async () => {
    expect(await check("bash", { path: join(bed.papHome, "state.db") })).toBeUndefined();
  });
});
