import { silentLogger } from "../kernel/logger.ts";
import { createAuditModule } from "../modules/audit/index.ts";
import { createOwnerFromCli, hasOwner } from "../modules/auth/index.ts";
import { CliError, openHomeForCli } from "./open-home.ts";
import { readSecret } from "./read-secret.ts";
import type { Command } from "./run-cli.ts";
import { UsageError } from "./usage.ts";

/**
 * `pap user add <username>`: the owner of a headless install, without the setup URL. The home is opened (instance lock
 * taken) before the password is asked and stays locked until the owner exists, so no daemon starts in between.
 */
export const userAdd: Command = {
  options: { "password-stdin": { type: "boolean" } },
  async run({ values, positionals, io }) {
    const [username, ...extra] = positionals;
    if (username === undefined || extra.length > 0) throw new UsageError("user add takes one username");
    const fromLine = values["password-stdin"] === true || io.stdin.isTTY !== true;
    const opened = await openHomeForCli(io, { create: true });
    try {
      if (hasOwner(opened.db)) throw new CliError("an owner already exists: pap v1 has one owner");
      const password = await readSecret(io, "Password: ", { line: fromLine });
      if (!fromLine && password !== (await readSecret(io, "Again: ")))
        throw new CliError("the two passwords differ");
      const audit = createAuditModule({ db: opened.db, clock: io.clock, logger: silentLogger }).port;
      await createOwnerFromCli(opened.db, io.clock, audit, { username, password });
      io.stdout.write(`owner ${username} created\n`);
      return 0;
    } finally {
      opened.close();
    }
  },
};
