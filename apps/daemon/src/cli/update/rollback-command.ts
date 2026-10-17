import { CliError } from "../open-home.ts";
import { installRoot } from "../ops/paths.ts";
import type { Command } from "../run-cli.ts";
import { safePath } from "../service/unit.ts";
import { UsageError } from "../usage.ts";
import { rollback } from "./apply.ts";
import { ManualRollbackRefused, planManualRollback } from "./manual-rollback.ts";
import { DEFAULT_OP_SEAMS, inOperation, type OpSeams } from "./operation.ts";
import { reportRollback } from "./rollback-report.ts";

export const ROLLBACK_USAGE =
  "usage: pap update rollback [--to <id>] [--restore-database | --keep-database] [--app-root <abs>] [--unit <name>]";
/** The old release gets this long to write its `listening` line again. */
const DEADLINE_MS = 120_000;

export function makeRollbackCommand(overrides: Partial<OpSeams> = {}): Command {
  const seams: OpSeams = { ...DEFAULT_OP_SEAMS, ...overrides };
  return {
    options: {
      to: { type: "string" },
      "restore-database": { type: "boolean" },
      "keep-database": { type: "boolean" },
      "app-root": { type: "string" },
      unit: { type: "string" },
      help: { type: "boolean" },
    },
    async run({ values, positionals, io }) {
      if (values.help === true) {
        io.stdout.write(`${ROLLBACK_USAGE}\n`);
        return 0;
      }
      const str = (name: string): string | undefined =>
        typeof values[name] === "string" ? values[name] : undefined;
      if (positionals.length > 0) throw new UsageError("update rollback takes no argument");
      const restore = values["restore-database"] === true;
      const keep = values["keep-database"] === true;
      if (restore && keep) throw new UsageError("choose --restore-database or --keep-database, not both");
      const appFlag = str("app-root");
      let app: string;
      try {
        app = appFlag === undefined ? installRoot(io) : safePath("--app-root", appFlag);
      } catch {
        throw new CliError("--app-root must be an absolute path of letters, digits and . _ + @ / - only", 64);
      }
      const to = str("to");

      return inOperation(io, seams, str("unit"), async (target) => {
        let plan: ReturnType<typeof planManualRollback>;
        try {
          plan = planManualRollback({
            app,
            home: target.home,
            ...(to === undefined ? {} : { to }),
            keepDatabase: keep,
            now: new Date(io.clock.now()),
          });
        } catch (error) {
          if (error instanceof ManualRollbackRefused) throw new CliError(error.message);
          throw error;
        }
        const { pending } = plan;
        if (plan.needsDecision && !restore && !keep)
          throw new CliError(
            [
              `the database holds migrations the snapshot lacks (snapshot taken ${plan.lostSince ?? "at an unknown time"}): choose how to go back to ${plan.target}`,
              `  --restore-database   restore that snapshot: writes since then are discarded`,
              `  --keep-database      keep the database as it is: ${plan.target} opens the database read-only until you update again`,
            ].join("\n"),
          );
        if (restore && pending.snapshot === null)
          io.stdout.write(
            "--restore-database: there is no usable snapshot, so the database was NOT restored\n",
          );
        if (plan.unknownSchema)
          io.stdout.write("no snapshot: the older release may open the database read-only\n");
        const deps = await seams.makeDeps(io, target, { app, deadlineMs: DEADLINE_MS, settleMs: 0 });
        const outcome = await rollback(deps, pending, "manual rollback");
        return reportRollback(io, outcome, {
          unit: target.unit,
          done: `rolled back: ${pending.to} -> ${plan.target}`,
          restoredSince: plan.lostSince ?? pending.startedAt,
          kept:
            keep && plan.needsDecision
              ? `the database was kept: ${plan.target} opens it read-only until you update again`
              : null,
        });
      });
    },
  };
}

export const updateRollback: Command = makeRollbackCommand();
