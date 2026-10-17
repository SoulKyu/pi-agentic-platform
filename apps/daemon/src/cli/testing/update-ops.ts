import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import type { Target } from "../ops/target.ts";
import type { Command } from "../run-cli.ts";
import { snapshotDatabase } from "../ops/snapshot.ts";
import type { OpSeams } from "../update/operation.ts";
import { switchCurrent } from "../update/releases.ts";
import type { Harness } from "./apply-harness.ts";
import { cliIo } from "./cli-io.ts";

export const OUTSIDE = "0::/user.slice/user-1000.slice/session-3.scope\n";
export const NOW = Date.parse("2026-10-17T10:00:00.000Z");
export const STAMP = "2026-10-17T10-00-00-000Z";

export const unitText = (h: Harness): string =>
  `[Service]\nExecStart=/opt/node --disable-warning=ExperimentalWarning /opt/main.js serve\nEnvironment=PAP_HOME=${h.home}\n`;

export interface Seen {
  target?: Target;
  units: string[];
}

/** Seams that use the harness' fake systemd and a unit text; `seen` records what the command resolved. */
export function seamsFor(
  h: Harness,
  overrides: Partial<OpSeams> = {},
  text: string | null = unitText(h),
): { seams: OpSeams; seen: Seen } {
  const seen: Seen = { units: [] };
  const seams: OpSeams = {
    makeDeps: async (_io, target) => {
      seen.target = target;
      return { ...h.deps, unit: target.unit };
    },
    unitText: async (_io, unit) => {
      seen.units.push(unit);
      return text;
    },
    readCgroup: () => OUTSIDE,
    ancestors: () => [],
    ...overrides,
  };
  return { seams, seen };
}

/** Runs a command object like `runCli` does; a thrown error becomes its exit code and a line on stderr. */
export async function runCommand(
  cmd: Command,
  args: string[],
  ioOptions: Parameters<typeof cliIo>[0] = { now: NOW },
) {
  const { io, stdout, stderr } = cliIo(ioOptions);
  const { values, positionals } = parseArgs({
    args,
    options: cmd.options,
    strict: true,
    allowPositionals: true,
  });
  let code: number;
  try {
    code = await cmd.run({ values, positionals, io });
  } catch (error) {
    const err = error as { name: string; exitCode?: number; message: string };
    code = err.exitCode ?? -1;
    io.stderr.write(`${err.name}: ${err.message}\n`);
  }
  return { code, out: stdout(), err: stderr() };
}

/** `current` names `new`, as after an update; the database as the old release left it is snapshotted next to the home. */
export function afterUpdate(h: Harness, stamp = STAMP, release = "new"): string {
  switchCurrent(h.app, release);
  const name = `pre-update-${release}-${stamp}.db`;
  if (existsSync(join(h.home, "state.db")))
    snapshotDatabase(join(h.home, "state.db"), join(h.home, "backups", name));
  return name;
}

/** What a migrated new release leaves behind: one more migration id and one more row. */
export function migrateDb(h: Harness): void {
  const db = new DatabaseSync(join(h.home, "state.db"));
  try {
    db.exec("INSERT INTO schema_migrations (id) VALUES ('002'); INSERT INTO note (body) VALUES ('m')");
  } finally {
    db.close();
  }
}

export function writeBuildInfo(h: Harness, id: string, builtAt: string): void {
  mkdirSync(join(h.app, "releases", id), { recursive: true });
  writeFileSync(join(h.app, "releases", id, "BUILD_INFO.json"), JSON.stringify({ builtAt }));
}

/** A row written after the snapshot, without a migration. */
export function addRow(h: Harness, body: string): void {
  const db = new DatabaseSync(join(h.home, "state.db"));
  try {
    db.prepare("INSERT INTO note (body) VALUES (?)").run(body);
  } finally {
    db.close();
  }
}
