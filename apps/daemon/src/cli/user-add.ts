import { silentLogger } from "../kernel/logger.ts";
import { createAuditModule } from "../modules/audit/index.ts";
import { createUserFromCli, isValidUsername } from "../modules/auth/index.ts";
import { CliError, openHomeForCli } from "./open-home.ts";
import { readSecret } from "./read-secret.ts";
import type { Command } from "./run-cli.ts";
import { UsageError } from "./usage.ts";

/**
 * `pap user add <username> [--role owner|member]`: the owner of a headless install while there is none (without the
 * setup URL), a member after. The home is opened (instance lock taken) before the password is asked and stays locked
 * until the user exists, so no daemon starts in between.
 */
export const userAdd: Command = {
  options: { "password-stdin": { type: "boolean" }, role: { type: "string" } },
  async run({ values, positionals, io }) {
    const [username, ...extra] = positionals;
    if (username === undefined || extra.length > 0) throw new UsageError("user add takes one username");
    if (!isValidUsername(username))
      throw new CliError("the username may use letters, digits, . _ - and 64 characters at most");
    const role = values.role;
    if (role !== undefined && role !== "owner" && role !== "member")
      throw new UsageError("--role is owner or member");
    const fromLine = values["password-stdin"] === true || io.stdin.isTTY !== true;
    const opened = await openHomeForCli(io, { create: true });
    try {
      const password = await readSecret(io, "Password: ", { line: fromLine });
      if (!fromLine && password !== (await readSecret(io, "Again: ")))
        throw new CliError("the two passwords differ");
      const audit = createAuditModule({ db: opened.db, clock: io.clock, logger: silentLogger }).port;
      const made = await createUserFromCli(opened.db, io.clock, audit, {
        username,
        password,
        ...(role === undefined ? {} : { role }),
      });
      io.stdout.write(`${made} ${username} created\n`);
      return 0;
    } finally {
      opened.close();
    }
  },
};
