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
import type { BoxRef } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Logger } from "./log.ts";
import { createState, TRASH_TTL_MS, type VmdState } from "./state.ts";
import { createFakeClock, type FakeClock } from "./testing/fake-clock.ts";

const agent = "helper-1a2b";
const other = "writer-3c4d";
const project = "0b1c2d3e-4f50-4162-8394-a5b6c7d8e9f0";
const box = (id: string): BoxRef => ({ kind: "agent", id });
const projectBox: BoxRef = { kind: "project", id: project };
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
    expect(state.diskPath(box(agent), null)).toBe(path.join(root, "agents", agent, "disk.img"));
    expect(state.diskPath(box(agent), key)).toBe(path.join(root, "agents", agent, "tasks", key, "disk.img"));
    expect(state.envFile("a".repeat(32))).toBe(path.join(root, "run", `${"a".repeat(32)}.env`));
    expect(state.buildDir("base")).toBe(path.join(root, "build", "base"));
    expect(state.dockerfileDir("agent")).toBe(path.join(root, "dockerfiles", "agent"));
  });

  it("puts a project disk under projects/<id>", () => {
    expect(state.diskPath(projectBox, null)).toBe(path.join(root, "projects", project, "disk.img"));
    expect(state.boxDir(projectBox)).toBe(path.join(root, "projects", project));
    expect(state.trashPath(projectBox, 1234567890123)).toBe(
      path.join(root, "trash", `project_${project.replaceAll("-", "")}-1234567890123`),
    );
    expect(state.trashPath(box(agent), 1234567890123)).toBe(
      path.join(root, "trash", `${agent}-1234567890123`),
    );
    expect(() => state.diskPath({ kind: "project", id: project.toUpperCase() }, null)).toThrow();
    expect(() => state.diskPath(projectBox, key)).toThrow();
  });

  it("refuses an id or a key that could leave the root", () => {
    expect(() => state.diskPath(box("../x"), null)).toThrow();
    expect(() => state.diskPath(box(agent), "../..")).toThrow();
    expect(() => state.envFile("../../etc/passwd")).toThrow();
    expect(() => state.buildDir("../base" as "base")).toThrow();
  });

  it("creates its folders 0700 and refuses a folder that is a link", () => {
    for (const dir of ["", "agents", "projects", "trash", "run", "build", "dockerfiles"]) {
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
    const file = state.diskPath(box(id), task);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "disk");
    return file;
  };

  it("removes run/*.env and every task disk whose VM is not running, keeps the agent's disk and a running task's", () => {
    writeFileSync(path.join(root, "run", "x.env"), "TOKEN=1");
    writeFileSync(path.join(root, "run", "addresses.json"), "{}");
    mkdirSync(path.join(root, "agents", agent), { recursive: true });
    writeFileSync(state.diskPath(box(agent), null), "agent disk");
    const orphan = taskDisk(agent, key);
    const alive = taskDisk(other, key2);
    state.sweepAtStart([{ box: box(other), taskKey: key2 }]);
    expect(existsSync(path.join(root, "run", "x.env"))).toBe(false);
    expect(existsSync(path.join(root, "run", "addresses.json"))).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(path.dirname(orphan))).toBe(false);
    expect(existsSync(alive)).toBe(true);
    expect(readFileSync(state.diskPath(box(agent), null), "utf8")).toBe("agent disk");
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

  // Mutant "sweep of build/ dropped": the leftover context stays. Mutant "sweep of dockerfiles/ dropped": the leftover
  // Dockerfile folder stays. Mutant "sweep after the null return": the case with an unknown list keeps them.
  it("clears the build contexts and Dockerfile folders a crash left, with or without the list of running VMs", () => {
    const left = ["build", "dockerfiles"].map((top) => path.join(root, top, "agent", `pap-agent-${top}`));
    for (const folder of left) {
      mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, "x"), "left over");
    }
    const outside = path.join(work, "outside");
    mkdirSync(outside);
    mkdirSync(path.join(root, "build", "base"));
    symlinkSync(outside, path.join(root, "build", "base", "pap-base-link"));
    state.sweepAtStart(null);
    for (const folder of left) expect(existsSync(folder)).toBe(false);
    expect(existsSync(path.join(root, "build", "base", "pap-base-link"))).toBe(false);
    expect(existsSync(outside)).toBe(true);
    expect(records.filter((r) => r.event === "vmd_build_sweep")).toEqual([
      { event: "vmd_build_sweep", fields: { folders: 3 } },
    ]);
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
    expect(state.purgeTrash(box(agent))).toBe(2);
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(mineOld)).toBe(false);
    expect(existsSync(theirs)).toBe(true);
  });

  it("purges a project's entries on their own, never an agent's and the other way round", () => {
    const hex = project.replaceAll("-", "");
    const projectEntry = entry(`project_${hex}`, 1000);
    const agentEntry = entry(agent, 1000);
    const otherProject = entry(`project_${"a".repeat(32)}`, 1000);
    expect(state.purgeTrash(projectBox)).toBe(1);
    expect(existsSync(projectEntry)).toBe(false);
    for (const kept of [agentEntry, otherProject]) expect(existsSync(kept)).toBe(true);
    expect(state.purgeTrash(box(agent))).toBe(1);
    expect(existsSync(otherProject)).toBe(true);
    expect(state.purgeTrash(null)).toBe(0);
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
