import { CliError } from "../open-home.ts";
import { installRoot } from "../ops/paths.ts";
import type { Command } from "../run-cli.ts";
import { safePath } from "../service/unit.ts";
import { UsageError } from "../usage.ts";
import { rollback } from "./apply.ts";
import { DEFAULT_OP_SEAMS, inOperation, type OpSeams } from "./operation.ts";
import { pendingPath, readPending } from "./pending.ts";
import { reportRollback } from "./rollback-report.ts";

export const RECOVER_USAGE = "usage: pap update recover [--keep-database] [--app-root <abs>] [--unit <name>]";
const DEADLINE_MS = 120_000;

export function makeRecoverCommand(overrides: Partial<OpSeams> = {}): Command {
  const seams: OpSeams = { ...DEFAULT_OP_SEAMS, ...overrides };
  return {
    options: {
      "keep-database": { type: "boolean" },
      "app-root": { type: "string" },
      unit: { type: "string" },
      help: { type: "boolean" },
    },
    async run({ values, positionals, io }) {
      if (values.help === true) {
        io.stdout.write(`${RECOVER_USAGE}\n`);
        return 0;
      }
      const str = (name: string): string | undefined =>
        typeof values[name] === "string" ? values[name] : undefined;
      if (positionals.length > 0) throw new UsageError("update recover takes no argument");
      const keep = values["keep-database"] === true;
      const appFlag = str("app-root");
      let app: string;
      try {
        app = appFlag === undefined ? installRoot(io) : safePath("--app-root", appFlag);
      } catch {
        throw new CliError("--app-root must be an absolute path of letters, digits and . _ + @ / - only", 64);
      }

      return inOperation(io, seams, str("unit"), async (target) => {
        const found = readPending(target.home);
        if (found === null) {
          io.stdout.write("nothing to recover: no interrupted update\n");
          return 0;
        }
        if (found === "damaged")
          throw new CliError(
            `the update journal ${pendingPath(target.home)} is damaged: inspect it, and delete it only after \`systemctl --user status ${target.unit}\` and \`pap doctor\` look right`,
          );
        // --keep-database: no snapshot and no ids to compare, so the database is never replaced (M6b-RT-18a)
        const pending = keep ? { ...found, snapshot: null, schemaBefore: null } : found;
        const deps = await seams.makeDeps(io, target, { app, deadlineMs: DEADLINE_MS, settleMs: 0 });
        const outcome = await rollback(deps, pending, "recovering an interrupted update");
        return reportRollback(io, outcome, {
          unit: target.unit,
          done: `recovered: ${found.from} is current again (the interrupted update to ${found.to} was undone)`,
          restoredSince: found.startedAt,
          kept: keep
            ? `the database was kept as it is (if the interrupted update had migrated it, ${found.from} opens it read-only until you update again)`
            : null,
        });
      });
    },
  };
}

export const updateRecover: Command = makeRecoverCommand();
