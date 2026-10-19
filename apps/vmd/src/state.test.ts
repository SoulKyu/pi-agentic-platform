import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Logger } from "./log.ts";
import { createState, TRASH_TTL_MS, type VmdState } from "./state.ts";
import { createFakeClock, type FakeClock } from "./testing/fake-clock.ts";

const agent = "helper-1a2b";
const other = "writer-3c4d";
const key = "e".repeat(32);
const key2 = "f".repeat(32);
const DAY = 24 * 3600 * 1000;

let work: string;
let root: string;
let clock: FakeClock;
let records: { event: string; fields: Record<string, unknown> }[];
let state: VmdState;
const log: Logger = {
  info(event, fields) {
    records.push({ event, fields });
  },
};

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "vmd-state-"));
  root = path.join(work, "state");
  clock = createFakeClock();
  records = [];
  state = createState({ root, clock, log, statfs: async () => ({ bavail: 2048, bsize: 1024 * 1024 }) });
  state.ensure();
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const mode = (file: string): number => lstatSync(file).mode & 0o777;

describe("state folder", () => {
  it("derives every path from checked ids under the root", () => {
    expect(state.diskPath(agent, null)).toBe(path.join(root, "agents", agent, "disk.img"));
    expect(state.diskPath(agent, key)).toBe(path.join(root, "agents", agent, "tasks", key, "disk.img"));
    expect(state.envFile("a".repeat(32))).toBe(path.join(root, "run", `${"a".repeat(32)}.env`));
    expect(state.buildDir("base")).toBe(path.join(root, "build", "base"));
    expect(state.stagingDir(agent)).toBe(path.join(root, "staging", agent));
    expect(state.dockerfileDir("agent")).toBe(path.join(root, "dockerfiles", "agent"));
  });

  it("refuses an id or a key that could leave the root", () => {
    expect(() => state.diskPath("../x", null)).toThrow();
    expect(() => state.diskPath(agent, "../..")).toThrow();
    expect(() => state.envFile("../../etc/passwd")).toThrow();
    expect(() => state.stagingDir("a/b-1a2b")).toThrow();
    expect(() => state.buildDir("../base" as "base")).toThrow();
  });

  it("creates its folders 0700 and refuses a folder that is a link", () => {
    for (const dir of ["", "agents", "trash", "run", "build", "staging", "dockerfiles"]) {
      expect(mode(path.join(root, dir))).toBe(0o700);
    }
    const planted = path.join(work, "planted");
    mkdirSync(planted);
    rmSync(path.join(root, "run"), { recursive: true });
    symlinkSync(planted, path.join(root, "run"));
    expect(() => state.ensure()).toThrow(/not a folder|link/);
  });

  it("writes an env file 0600 that cannot replace an existing one, and removes it", () => {
    const launch = "b".repeat(32);
    const file = state.writeEnvFile(launch, "PAP_GATEWAY_TOKEN=x\n");
    expect(mode(file)).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe("PAP_GATEWAY_TOKEN=x\n");
    expect(() => state.writeEnvFile(launch, "other")).toThrow();
    state.removeEnvFile(launch);
    expect(existsSync(file)).toBe(false);
    state.removeEnvFile(launch);
  });

  it("reports the free MiB of the file system under the root", async () => {
    expect(await state.freeMb()).toBe(2048);
  });
});

describe("start sweep (RT-33, R30)", () => {
  const taskDisk = (id: string, task: string): string => {
    const file = state.diskPath(id, task);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "disk");
    return file;
  };

  it("removes run/*.env and every task disk whose VM is not running, keeps the agent's disk and a running task's", () => {
    writeFileSync(path.join(root, "run", "x.env"), "TOKEN=1");
    writeFileSync(path.join(root, "run", "addresses.json"), "{}");
    mkdirSync(path.join(root, "agents", agent), { recursive: true });
    writeFileSync(state.diskPath(agent, null), "agent disk");
    const orphan = taskDisk(agent, key);
    const alive = taskDisk(other, key2);
    state.sweepAtStart([{ agentId: other, taskKey: key2 }]);
    expect(existsSync(path.join(root, "run", "x.env"))).toBe(false);
    expect(existsSync(path.join(root, "run", "addresses.json"))).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(path.dirname(orphan))).toBe(false);
    expect(existsSync(alive)).toBe(true);
    expect(readFileSync(state.diskPath(agent, null), "utf8")).toBe("agent disk");
    expect(records.filter((r) => r.event === "vmd_sweep")).toEqual([
      { event: "vmd_sweep", fields: { envFiles: 1, taskDisks: 1 } },
    ]);
  });

  it("without the list of running VMs it keeps every task disk (fails closed) and says so", () => {
    const disk = taskDisk(agent, key);
    writeFileSync(path.join(root, "run", "x.env"), "TOKEN=1");
    state.sweepAtStart(null);
    expect(existsSync(disk)).toBe(true);
    expect(existsSync(path.join(root, "run", "x.env"))).toBe(false);
    expect(records.map((r) => r.event)).toContain("vmd_sweep_skipped");
  });

  it("leaves a folder whose name is not an agent id or a task key alone", () => {
    mkdirSync(path.join(root, "agents", "weird name", "tasks", "zz"), { recursive: true });
    mkdirSync(path.join(root, "agents", agent, "tasks", "not-a-key"), { recursive: true });
    state.sweepAtStart([]);
    expect(existsSync(path.join(root, "agents", "weird name", "tasks", "zz"))).toBe(true);
    expect(existsSync(path.join(root, "agents", agent, "tasks", "not-a-key"))).toBe(true);
  });
});

describe("trash (RT-40)", () => {
  const entry = (id: string, ageMs: number, file = "disk.img"): string => {
    const dir = path.join(root, "trash", `${id}-${clock.now() - ageMs}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, file), "x");
    return dir;
  };

  it("purges entries older than 7 days only (exactly 7 days stays, a malformed name stays)", () => {
    const old = entry(agent, 8 * DAY);
    const justOver = entry(other, TRASH_TTL_MS + 1);
    const exact = entry(agent, TRASH_TTL_MS);
    const young = entry(agent, 6 * DAY);
    const future = entry(agent, -DAY);
    const odd = path.join(root, "trash", "not-a-stamp");
    mkdirSync(odd);
    expect(state.purgeTrash(null)).toBe(2);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(justOver)).toBe(false);
    for (const kept of [exact, young, future, odd]) expect(existsSync(kept)).toBe(true);
  });

  it("purges one agent's entries now, whatever their age, and no other agent's", () => {
    const mine = entry(agent, 1000);
    const mineOld = entry(agent, 9 * DAY);
    const theirs = entry(other, 9 * DAY);
    expect(state.purgeTrash(agent)).toBe(2);
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(mineOld)).toBe(false);
    expect(existsSync(theirs)).toBe(true);
  });

  it("purges at start and then once a day, and stops when asked", async () => {
    const first = entry(agent, 8 * DAY);
    const stop = state.startDailyPurge();
    expect(existsSync(first)).toBe(false);
    const aging = entry(other, 6 * DAY + 3600 * 1000);
    await clock.advance(DAY - 1);
    expect(existsSync(aging)).toBe(true);
    await clock.advance(1);
    expect(existsSync(aging)).toBe(false);
    stop();
    expect(clock.pending()).toBe(0);
    expect(readdirSync(path.join(root, "trash"))).toEqual([]);
  });
});
