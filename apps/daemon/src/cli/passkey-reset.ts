import { silentLogger } from "../kernel/logger.ts";
import { createAuditModule } from "../modules/audit/index.ts";
import { hasOwner, resetCredentials } from "../modules/auth/index.ts";
import { CliError, openHomeForCli } from "./open-home.ts";
import { readSecret } from "./read-secret.ts";
import type { Command } from "./run-cli.ts";
import { UsageError } from "./usage.ts";

/**
 * `pap passkey reset`: sign out everywhere (spec C §1.5). The home is locked before the new password is asked, and the
 * lock is held until the rows are gone.
 */
export const passkeyReset: Command = {
  options: {
    "revoke-tokens": { type: "boolean" },
    "keep-password": { type: "boolean" },
    "password-stdin": { type: "boolean" },
  },
  async run({ values, positionals, io }) {
    if (positionals.length > 0) throw new UsageError("passkey reset takes no argument");
    const keep = values["keep-password"] === true;
    const revokeTokens = values["revoke-tokens"] === true;
    if (keep && values["password-stdin"] === true)
      throw new UsageError("--keep-password and --password-stdin exclude each other");
    const fromLine = values["password-stdin"] === true || io.stdin.isTTY !== true;
    const opened = await openHomeForCli(io, { create: false });
    try {
      if (!hasOwner(opened.db)) throw new CliError("no owner yet: run pap user add first");
      let newPassword: string | undefined;
      if (!keep) {
        newPassword = await readSecret(io, "New password: ", { line: fromLine });
        if (!fromLine && newPassword !== (await readSecret(io, "Again: ")))
          throw new CliError("the two passwords differ");
      }
      const audit = createAuditModule({ db: opened.db, clock: io.clock, logger: silentLogger }).port;
      const done = await resetCredentials(opened.db, audit, opened.home, {
        revokeTokens,
        ...(newPassword === undefined ? {} : { newPassword }),
      });
      const tokens = revokeTokens ? `, ${done.tokens} tokens` : "";
      io.stdout.write(
        `removed ${done.passkeys} passkeys, ${done.sessions} browser sessions${tokens}; password ${keep ? "kept" : "changed"}\n`,
      );
      return 0;
    } finally {
      opened.close();
    }
  },
};
