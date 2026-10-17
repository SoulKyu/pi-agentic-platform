import type { CliIo } from "../open-home.ts";
import type { ApplyOutcome } from "./apply.ts";

export const EXIT_ROLLBACK_INCOMPLETE = 5;

export const recoverCommand = (unit: string, flags = ""): string =>
  `pap update recover${flags}${unit === "pap.service" ? "" : ` --unit ${unit}`}`;

/**
 * What a manual rollback or a recovery tells after `rollback()` returned, and its exit code (0 or 5).
 * `done` is the success headline; `restoredSince` is when the discarded writes began, `kept` the database sentence to use
 * when the database was deliberately not restored.
 */
export function reportRollback(
  io: CliIo,
  outcome: ApplyOutcome,
  report: { unit: string; done: string; restoredSince: string; kept: string | null },
): number {
  if (outcome.kind === "rolled_back") {
    io.stdout.write(`${report.done}\n`);
    io.stdout.write(
      outcome.restoredDatabase
        ? `the database was restored from its snapshot: writes made since ${report.restoredSince} were discarded\n${outcome.keptDatabase === undefined ? "no copy of the replaced database was kept (state.db was absent)" : `the database it replaced is kept as ${outcome.keptDatabase}: to get those writes back, stop pap and copy that file over state.db`}\n`
        : `${report.kept ?? "the database was not changed"}\n`,
    );
    io.stdout.write("any running turn was interrupted\n");
    return 0;
  }
  if (outcome.kind !== "rollback_failed") {
    io.stderr.write("pap: unexpected outcome of the rollback: check `pap doctor`\n"); // rollback() never returns the other kinds
    return EXIT_ROLLBACK_INCOMPLETE;
  }
  const lines = [
    `pap: the rollback failed at: ${outcome.step}${outcome.code === undefined ? "" : ` (${outcome.code})`}`,
  ];
  if (outcome.step === "database")
    lines.push(
      "the way out:",
      `  ${recoverCommand(report.unit, " --keep-database")}   (keeps the database; the older release opens it read-only until you update again)`,
      "  pap restore                    (restores a backup)",
      `then check: systemctl --user status ${report.unit}`,
    );
  else
    lines.push(
      "run, in this order:",
      `  ${recoverCommand(report.unit)}`,
      `  systemctl --user status ${report.unit}`,
    );
  io.stderr.write(`${lines.join("\n")}\n`);
  return EXIT_ROLLBACK_INCOMPLETE;
}
