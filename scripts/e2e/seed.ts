// What the journeys plant in the daemon's folders and read back from outside the page: the script a worker
// reads when it starts and a read of the state file.
// No `@pap/*` import (Playwright's loader lacks the `development` condition).
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { expect, type Locator } from "@playwright/test";
import { runningUnder } from "../smoke-proc.ts";
import type { PapInstance, ScriptStep } from "./fixtures.ts";

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

/**
 * Performs `action` until `target` shows, and only acts again when the action had no visible effect (so a toggle is never
 * undone). For input that can be lost for a reason other than a Tooltip remount (C8 fixed that one; first clicks are plain):
 * a keyboard shortcut sent before the page attached its listener (j12).
 */
export const actUntilVisible = (action: () => Promise<void>, target: Locator): Promise<void> =>
  expect(async () => {
    if (!(await target.isVisible())) await action();
    await target.waitFor({ state: "visible", timeout: 3_000 });
  }).toPass({ timeout: 20_000 });

/** How many processes run under this daemon's HOME: the daemon, its workers and what they started. */
export const liveProcesses = (pap: PapInstance): number => runningUnder(pap.userHome).length;
