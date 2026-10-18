// What J06 to J09 plant in the daemon's folders and read back from outside the page: the sandbox rule, the script a worker
// reads when it starts, pi-mem0's folder (staged facts, snapshots, the requests pap writes) and a read of the state file.
// No `@pap/*` import (Playwright's loader lacks the `development` condition).
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { runningUnder } from "../smoke-proc.ts";
import type { PapInstance, ScriptStep } from "./fixtures.ts";

interface Sandbox {
  usable: boolean;
  reason: string | null;
  checkedAt: number;
}

/**
 * The agents of J07 need bubblewrap. Locally a host without it skips the test with a warning; under `CI` it is a failure
 * (the rule of AGENTS.md: the int tests skip locally and throw under CI). Waits for the first probe to end.
 */
export async function bwrapUsable(pap: PapInstance): Promise<boolean> {
  let status: Sandbox = { usable: false, reason: null, checkedAt: 0 };
  await expect
    .poll(
      async () => {
        status = await pap.rpc<Sandbox>("agents.sandboxStatus");
        return status.checkedAt > 0;
      },
      { message: "the sandbox probe ends", timeout: 30_000 },
    )
    .toBe(true);
  if (status.usable) return true;
  const why = `bubblewrap is not usable here (${status.reason ?? "unknown"})`;
  if (process.env["CI"]) throw new Error(why);
  console.warn(`e2e: skipped, ${why}`);
  test.skip(true, why);
  return false;
}

/** The folder the script of the next worker to start is read from (`script.json` beside the daemon's folders). */
const scriptFile = (pap: PapInstance): string => join(dirname(pap.home), "script.json");

/**
 * Writes the script the NEXT worker reads from its first step (a worker reads it once, when it starts), with the price of a
 * token in dollars per million when a cost is wanted. A phase writes the script of the worker that starts after it.
 */
export function writeScript(
  pap: PapInstance,
  steps: ScriptStep[],
  prices?: { input: number; output: number },
): void {
  writeFileSync(scriptFile(pap), JSON.stringify({ steps, ...(prices ? { prices } : {}) }));
}

/** One read of the daemon's state file (read-only); the daemon's own tables are the durable truth the journeys check. */
export function dbRows<T>(pap: PapInstance, sql: string, ...params: (string | number)[]): T[] {
  const db = new DatabaseSync(join(pap.home, "state.db"), { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

/** pi-mem0's folder as pap finds it without `PI_MEM0_DIR`: `<Pi agent dir>/mem0`. */
export const mem0Dir = (pap: PapInstance): string => join(pap.agentDir, "mem0");

function dir(pap: PapInstance, ...names: string[]): string {
  const path = join(mem0Dir(pap), ...names);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}
const write = (path: string, value: unknown): void =>
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
const read = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const jsonFiles = (path: string, suffix = ".json"): string[] =>
  readdirSync(path)
    .filter((name) => name.endsWith(suffix))
    .toSorted();

/**
 * A fact an untrusted run staged for review, in the layout of docs/agents/memory.md: `staging/<uuid>.json`
 * `{id, agent, text, sourceSession, createdAt}`, well under 16 KB. `agentId` is the id the daemon gave the agent (it has
 * pi-mem0's shape). Facts are listed oldest first by `createdAt`, so each seed is a second later than the one before.
 */
let seeded = 0;
export function seedStagedMemory(pap: PapInstance, agentId: string, text: string): string {
  const id = randomUUID();
  seeded += 1;
  write(join(dir(pap, "staging"), `${id}.json`), {
    id,
    agent: agentId,
    text,
    sourceSession: "e2e-untrusted-run",
    createdAt: new Date(Date.UTC(2026, 9, 18, 8, 0, seeded)).toISOString(),
  });
  return id;
}

interface Memory {
  id: string;
  text: string;
  createdAt: string;
  source: string;
}
interface Snapshot {
  agent: string;
  updatedAt: string;
  memories: Memory[];
  events: unknown[];
}
const snapshotPath = (pap: PapInstance, agentId: string): string =>
  join(dir(pap, "agents"), `${agentId}.json`);
const readSnapshot = (pap: PapInstance, agentId: string): Snapshot => {
  try {
    return read<Snapshot>(snapshotPath(pap, agentId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { agent: agentId, updatedAt: new Date(0).toISOString(), memories: [], events: [] };
  }
};
const writeSnapshot = (pap: PapInstance, agentId: string, memories: Memory[]): void =>
  write(snapshotPath(pap, agentId), {
    agent: agentId,
    updatedAt: new Date().toISOString(),
    memories,
    events: [],
  });

/** A memory pi-mem0 already holds for the agent (`agents/<agent id>.json`). */
export function seedMemory(pap: PapInstance, agentId: string, memory: Omit<Memory, "createdAt">): void {
  const snapshot = readSnapshot(pap, agentId);
  writeSnapshot(pap, agentId, [...snapshot.memories, { ...memory, createdAt: "2026-10-17T08:00:00.000Z" }]);
}

export const agentMemories = (pap: PapInstance, agentId: string): Memory[] =>
  readSnapshot(pap, agentId).memories;

/** What is left in `staging/`, file names. */
export const stagingFiles = (pap: PapInstance): string[] => readdirSync(dir(pap, "staging")).toSorted();

/** `staging/<fact id>.decision.json`: what the owner's answer wrote, or null when none. */
export function decisionOf(pap: PapInstance, factId: string): { approved: boolean } | null {
  try {
    return read<{ approved: boolean }>(join(dir(pap, "staging"), `${factId}.decision.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

/** The requests pap wrote for pi-mem0 under `forget/` (or `save/`). */
export const requestsOf = <T>(pap: PapInstance, folder: "forget" | "save"): T[] =>
  jsonFiles(dir(pap, folder)).map((name) => read<T>(join(dir(pap, folder), name)));

/**
 * pi-mem0 is not installed in the e2e daemon: this plays its watcher for the staged facts. An approved fact becomes a
 * memory of the agent with source `staged`; a rejected one is dropped; the fact and its decision leave `staging/`.
 */
export function applyDecisions(pap: PapInstance): void {
  const staging = dir(pap, "staging");
  for (const name of jsonFiles(staging).filter((each) => !each.endsWith(".decision.json"))) {
    const fact = read<{ id: string; agent: string; text: string; createdAt: string }>(join(staging, name));
    const decision = decisionOf(pap, fact.id);
    if (decision === null) continue;
    if (decision.approved) {
      const snapshot = readSnapshot(pap, fact.agent);
      writeSnapshot(pap, fact.agent, [
        ...snapshot.memories,
        {
          id: `mem-${fact.id.slice(0, 8)}`,
          text: fact.text,
          createdAt: new Date().toISOString(),
          source: "staged",
        },
      ]);
    }
    rmSync(join(staging, name));
    rmSync(join(staging, `${fact.id}.decision.json`));
  }
}

/** The same for `forget/<uuid>.json` `{memoryId, scope: "agent:<id>"}`: the memory leaves the snapshot, the request is claimed. */
export function applyForgets(pap: PapInstance): void {
  const folder = dir(pap, "forget");
  for (const name of jsonFiles(folder)) {
    const request = read<{ memoryId: string; scope: string }>(join(folder, name));
    const agentId = request.scope.replace(/^agent:/, "");
    const snapshot = readSnapshot(pap, agentId);
    writeSnapshot(
      pap,
      agentId,
      snapshot.memories.filter((memory) => memory.id !== request.memoryId),
    );
    renameSync(join(folder, name), join(folder, `${name}.done`));
  }
}

/**
 * Performs `action` (a click that opens something) until `target` shows, and only clicks again when the click had no visible
 * effect (so a toggle is never undone). A Tooltip-wrapped trigger is remounted when its lazy popup chunk loads (Tooltip.tsx),
 * dropping a click that spans it; fixed by C8, retries removed after the join.
 */
export const actUntilVisible = (action: () => Promise<void>, target: Locator): Promise<void> =>
  expect(async () => {
    if (!(await target.isVisible())) await action();
    await target.waitFor({ state: "visible", timeout: 3_000 });
  }).toPass({ timeout: 20_000 });

/** How many processes run under this daemon's HOME: the daemon, its workers and what they started. */
export const liveProcesses = (pap: PapInstance): number => runningUnder(pap.userHome).length;
