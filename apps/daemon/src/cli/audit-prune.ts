import { monthCutoff } from "../modules/audit/index.ts";
import { createAuditModule } from "../modules/audit/index.ts";
import { silentLogger } from "../kernel/logger.ts";
import { CliError, openHomeForCli } from "./open-home.ts";
import type { Command } from "./run-cli.ts";
import { UsageError } from "./usage.ts";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** `pap audit prune`: whole months older than 12 months (spec C §3.4), the daemon stopped. */
export const auditPrune: Command = {
  options: { month: { type: "string" }, "dry-run": { type: "boolean" } },
  async run({ values, positionals, io }) {
    const month = typeof values.month === "string" ? values.month : undefined;
    if (positionals.length > 0) throw new UsageError("audit prune takes no argument");
    if (month !== undefined && !MONTH.test(month)) throw new UsageError("--month must look like 2024-05");
    const cutoff = monthCutoff(io.clock.now());
    if (month !== undefined && month >= cutoff)
      throw new CliError(`${month} is within the 12-month retention`);
    const dry = values["dry-run"] === true;
    const opened = await openHomeForCli(io, { create: false });
    try {
      const audit = createAuditModule({ db: opened.db, clock: io.clock, logger: silentLogger }).cli;
      const months = (month === undefined ? audit.monthsBefore(cutoff) : [month]).filter(
        (m) => audit.count(m) > 0,
      );
      if (months.length === 0) io.stdout.write("nothing to prune\n");
      for (const m of months) {
        if (dry) io.stdout.write(`would prune ${m}: ${audit.count(m)} rows\n`);
        else io.stdout.write(`pruned ${m}: ${audit.prune(m)} rows\n`);
      }
      return 0;
    } finally {
      opened.close();
    }
  },
};
