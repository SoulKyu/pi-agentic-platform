import { CliError } from "../open-home.ts";
import type { Command } from "../run-cli.ts";
import { UsageError } from "../usage.ts";
import { JOURNAL_HINT, UNIT, withHint } from "./common.ts";
import { createSystemd } from "./systemd.ts";
import { readJournal } from "./unit.ts";

/** The setup URL of the running service's current start, read from its user journal; else the reason there is none. */
export const serviceUrl: Command = {
  options: {},
  async run({ positionals, io }) {
    if (positionals.length > 0) throw new UsageError("service url takes no argument");
    const systemd = createSystemd(io.env);
    if (!(await systemd.userManagerUp()))
      throw new CliError("no systemd user manager: log in with a full session");
    // The journal is bounded by the current start, so a URL or `listening` from an earlier start never shows.
    const facts = await withHint(async () => {
      const id = await systemd.invocationId(UNIT);
      const since = id === null ? null : await systemd.activeSince(UNIT);
      return id === null || since === null ? null : readJournal(await systemd.journal(id, since, true));
    });
    if (facts?.setupUrl) io.stdout.write(`${facts.setupUrl}\n`);
    else if (facts?.listening)
      io.stdout.write(
        "no setup URL: an owner already exists, so open the address pap listens on and sign in\n",
      );
    else io.stdout.write(`pap is not listening yet; see: ${JOURNAL_HINT}\n`);
    return 0;
  },
};
